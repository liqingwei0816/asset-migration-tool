import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import express from 'express';
import { ArkClient, ArkError, troubleshootHint } from './ark.js';
import { ConfigStore } from './config.js';
import { JobEngine } from './migrator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function httpError(status, message) {
  const err = new Error(message);
  err.httpStatus = status;
  return err;
}

export function createApp({ dataDir } = {}) {
  const dir = dataDir || process.env.ASSET_MIGRATION_DATA_DIR || path.join(ROOT, 'data');
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // 服务实例标识：每次进程启动生成一次。页面据此检测服务重启并自动刷新数据，
  // 避免持有过期的通道/任务 id。
  const bootId = crypto.randomBytes(8).toString('hex');
  app.use((req, res, next) => {
    res.set('X-Boot-Id', bootId);
    next();
  });

  // API 响应禁止缓存（轮询/任务状态必须实时）——必须注册在所有路由之前
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  const config = new ConfigStore(dir);
  const engine = new JobEngine({ dataDir: dir, configStore: config });

  // 路由错误统一转 JSON：async 包装确保同步抛出（如配置校验）也被接住，而不是穿透成裸 500
  const ARK_ERROR_STATUS = { bad: 400, auth: 401, transient: 502 };
  const ah = fn => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      const status = err.httpStatus || (err instanceof ArkError ? ARK_ERROR_STATUS[err.kind] : 0) || 500;
      if (status >= 500) console.error(`[api] ${req.method} ${req.path}`, err);
      if (!res.headersSent) res.status(status).json({ error: err.message || String(err) });
    }
  };

  const findChannel = id => {
    const c = config.data.channels.find(ch => ch.id === id);
    if (!c) throw httpError(404, `通道不存在或已删除：${id}`);
    return c;
  };

  const clientOf = channelId => {
    const c = findChannel(channelId);
    return new ArkClient({ baseUrl: c.baseUrl, vendor: c.vendor, token: c.token, projectName: c.projectName, settings: config.data.settings });
  };

  // ── 配置（单通道增删改，避免整表提交被其他通道的校验错误阻塞）──

  app.get('/api/config', ah((req, res) => res.json({ bootId, ...config.get() })));

  app.put('/api/settings', ah((req, res) => {
    config.updateSettings(req.body || {});
    res.json(config.get());
  }));

  app.post('/api/channels', ah((req, res) => {
    config.addChannel(req.body || {});
    res.json(config.get());
  }));

  app.put('/api/channels/:id', ah((req, res) => {
    config.updateChannel(req.params.id, req.body || {});
    res.json(config.get());
  }));

  app.delete('/api/channels/:id', ah((req, res) => {
    config.removeChannel(req.params.id);
    res.json(config.get());
  }));

  // 连通性测试：支持 {id} 或内联 {channel:{...}}（令牌留空则取已保存值）
  app.post('/api/channels/test', ah(async (req, res) => {
    const { id, channel } = req.body || {};
    let ch;
    try {
      ch = channel && channel.baseUrl ? { ...channel } : { ...findChannel(id) };
    } catch (err) {
      return res.json({ ok: false, kind: 'bad', error: err.message });
    }
    if (!ch.token && ch.id) {
      const old = config.data.channels.find(c => c.id === ch.id);
      if (old) ch.token = old.token;
    }
    try {
      const client = new ArkClient({ baseUrl: ch.baseUrl, vendor: ch.vendor, token: ch.token, projectName: ch.projectName, settings: config.data.settings });
      const t0 = Date.now();
      const r = await client.test();
      res.json({ ok: true, latencyMs: Date.now() - t0, totalGroups: r.totalGroups, projectName: ch.projectName });
    } catch (err) {
      res.json({
        ok: false,
        kind: err.kind || 'error',
        error: err.message,
        // 请求链路详情：页面据此展示具体请求与响应
        detail: err instanceof ArkError ? {
          method: 'POST',
          url: err.url,
          action: err.action,
          status: err.status,
          responseBody: err.responseBody,
          attempts: err.attempts,
          hint: troubleshootHint(err),
        } : null,
      });
    }
  }));

  // ── 浏览 ─────────────────────────────────────────────────

  app.get('/api/channels/:id/groups', ah(async (req, res) => {
    const client = clientOf(req.params.id);
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 20));
    const r = await client.listAssetGroupsPage({ page, pageSize, name: String(req.query.name || '') });
    res.json({ total: r?.TotalCount ?? 0, pageNumber: r?.PageNumber ?? page, pageSize, groups: r?.Groups ?? [] });
  }));

  app.get('/api/channels/:id/groups/:gid/assets', ah(async (req, res) => {
    const client = clientOf(req.params.id);
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 20));
    const statuses = String(req.query.status || '').split(',').map(s => s.trim()).filter(Boolean);
    const r = await client.listAssetsPage({ page, pageSize, groupId: req.params.gid, statuses, name: String(req.query.name || '') });
    res.json({ total: r?.TotalCount ?? 0, pageNumber: r?.PageNumber ?? page, pageSize, assets: r?.Assets ?? [] });
  }));

  // 素材详情：列表项可能不带 URL（接入文档 §2.5），媒体预览用它取最新签名地址
  app.get('/api/channels/:id/assets/:aid', ah(async (req, res) => {
    const client = clientOf(req.params.id);
    res.json(await client.getAsset(req.params.aid));
  }));

  // 通道级扁平素材列表（跨组，Filter.GroupIds 不传 = 全项目）
  app.get('/api/channels/:id/assets', ah(async (req, res) => {
    const client = clientOf(req.params.id);
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 20));
    const statuses = String(req.query.status || '').split(',').map(s => s.trim()).filter(Boolean);
    const r = await client.listAssetsPage({ page, pageSize, statuses, name: String(req.query.name || '') });
    res.json({ total: r?.TotalCount ?? 0, pageNumber: r?.PageNumber ?? page, pageSize, assets: r?.Assets ?? [] });
  }));

  // ── 迁移任务 ─────────────────────────────────────────────

  app.post('/api/jobs', ah((req, res) => {
    const b = req.body || {};
    if (!b.sourceChannelId || !b.targetChannelId) throw httpError(400, '必须选择源通道与目标通道');
    if (b.sourceChannelId === b.targetChannelId) throw httpError(400, '源通道与目标通道不能相同');
    findChannel(b.sourceChannelId);
    findChannel(b.targetChannelId);
    res.json(engine.createJob(b));
  }));

  app.get('/api/jobs', ah((req, res) => res.json(engine.listMeta())));

  app.get('/api/jobs/:id', ah((req, res) => res.json(engine.getDetail(req.params.id))));

  app.get('/api/jobs/:id/items', ah((req, res) => res.json(engine.listItems(req.params.id, req.query))));

  app.post('/api/jobs/:id/:action(start|pause|cancel|retry-failed)', ah((req, res) => {
    res.json(engine.control(req.params.id, req.params.action));
  }));

  app.get('/api/jobs/:id/report', ah((req, res) => {
    const format = req.query.format === 'csv' ? 'csv' : 'md';
    const { filename, contentType, body } = engine.buildReport(req.params.id, format);
    res.setHeader('Content-Type', `${contentType}; charset=utf-8`);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(body);
  }));

  // ── 静态页面 ─────────────────────────────────────────────

  // no-cache：浏览器每次重新验证（ETag 未变则 304），工具更新后页面刷新即拿到新资源，
  // 避免启发式缓存导致的"旧 CSS 渲染新 HTML、样式丢失"问题
  app.use(express.static(path.join(ROOT, 'public'), {
    etag: true,
    lastModified: true,
    setHeaders: res => res.set('Cache-Control', 'no-cache'),
  }));
  app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

  return { app, config, engine };
}

// ── 入口 ──────────────────────────────────────────────────

// 启动脚本设置 OPEN_BROWSER=1 后，服务就绪即用系统默认浏览器打开页面
function openBrowser(url) {
  try {
    const cmd = process.platform === "win32"
      ? { file: "cmd", args: ["/c", "start", "", url] }
      : process.platform === "darwin"
        ? { file: "open", args: [url] }
        : { file: "xdg-open", args: [url] };
    spawn(cmd.file, cmd.args, { detached: true, stdio: "ignore" }).unref();
    console.log(`[信息] 正在打开浏览器: ${url}`);
  } catch {
    console.log(`[信息] 请手动访问: ${url}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { app, engine } = createApp();
  const port = Number(process.env.PORT || 8787);
  const url = `http://localhost:${port}`;
  const server = app.listen(port, () => {
    console.log(`[素材库跨通道迁移工作台] 已启动: ${url}`);
    if (process.env.OPEN_BROWSER === "1" || process.env.OPEN_BROWSER === "true") openBrowser(url);
  });
  const shutdown = signal => {
    console.log(`\n收到 ${signal}，保存任务状态并退出…`);
    engine.flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('exit', () => engine.flush());
}
