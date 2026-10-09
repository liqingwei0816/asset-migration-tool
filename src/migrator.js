import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ArkClient, ArkError, sleep } from './ark.js';
import { ensureDir, readJson, writeJsonAtomic } from './store.js';

const ACTIVE_STATES = ['running', 'paused', 'ready', 'scanning'];
const IN_FLIGHT = ['uploading', 'polling'];
const LOG_CAP = 1000;

function nowIso() {
  return new Date().toISOString();
}

function newJobId() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `job-${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

/** 素材名称上限 64 字符（接入文档 §5.1），按码点截断 */
function truncateName(name, max = 64) {
  const s = String(name ?? '');
  return [...s].slice(0, max).join('');
}

class JobError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.httpStatus = status;
  }
}

/**
 * 任务引擎：扫描 → 组映射 → 并发直传 → 轮询校验 → 报告。
 * 任务对象为纯数据（可 JSON 序列化落盘），所有方法挂在引擎上。
 */
export class JobEngine {
  constructor({ dataDir, configStore }) {
    this.jobsDir = path.join(dataDir, 'jobs');
    ensureDir(this.jobsDir);
    this.config = configStore;
    this.jobs = new Map();
    this.dirty = new Set();
    this.flushTimer = null;
    this.loadAll();
  }

  // ── 持久化 ────────────────────────────────────────────────

  loadAll() {
    let files = [];
    try { files = fs.readdirSync(this.jobsDir); } catch { /* 目录不可读则视为空 */ }
    for (const f of files) {
      if (!f.endsWith('.json') || f.startsWith('.')) continue;
      try {
        const job = readJson(path.join(this.jobsDir, f));
        if (job && job.id) this.jobs.set(job.id, job);
      } catch (err) {
        console.error(`[jobs] 跳过损坏的任务文件 ${f}: ${err.message}`);
      }
    }
    for (const job of this.jobs.values()) this.recover(job);
    this.flush();
  }

  /** 进程重启后的恢复：回收在途素材，任务转入手动恢复 */
  recover(job) {
    if (job.status === 'running') {
      let reclaimed = 0;
      for (const it of job.items) {
        if (IN_FLIGHT.includes(it.state)) {
          // 保留 dst.id：恢复后先轮询已创建的目标素材，避免重复上传
          it.state = 'pending';
          reclaimed++;
        }
      }
      job.status = 'paused';
      this.log(job, 'warn', `检测到进程重启，回收 ${reclaimed} 个在途素材，任务已暂停，请手动「启动」继续`);
    } else if (job.status === 'scanning') {
      job.status = 'failed';
      job.error = '进程重启导致扫描中断，请重新创建任务';
    }
    this.recount(job);
  }

  markDirty(id) {
    this.dirty.add(id);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, 500);
    }
  }

  flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const id of this.dirty) {
      const job = this.jobs.get(id);
      if (job) {
        const { _stop, _workersAlive, _runtimeDup, ...data } = job; // 运行时字段不落盘
        writeJsonAtomic(path.join(this.jobsDir, `${id}.json`), data);
      }
    }
    this.dirty.clear();
  }

  // ── 读取 ──────────────────────────────────────────────────

  must(id) {
    const job = this.jobs.get(id);
    if (!job) throw new JobError(`任务不存在：${id}`, 404);
    return job;
  }

  meta(job) {
    const { items, log, ...rest } = job;
    const out = {};
    for (const [k, v] of Object.entries(rest)) {
      if (!k.startsWith('_')) out[k] = v; // 剥离 _stop/_workersAlive/_runtimeDup 等运行时字段
    }
    return out;
  }

  listMeta() {
    return [...this.jobs.values()]
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .map(j => this.meta(j));
  }

  getDetail(id) {
    const job = this.must(id);
    return { ...this.meta(job), log: job.log.slice(-200) };
  }

  listItems(id, query = {}) {
    const job = this.must(id);
    let items = job.items;
    if (query.state) items = items.filter(it => it.state === query.state);
    if (query.q) {
      const q = String(query.q).toLowerCase();
      items = items.filter(it => (it.src.name || '').toLowerCase().includes(q) || (it.src.id || '').toLowerCase().includes(q));
    }
    const pageSize = Math.min(200, Math.max(1, parseInt(query.pageSize) || 50));
    const pageNumber = Math.max(1, parseInt(query.page) || 1);
    return {
      total: items.length,
      pageNumber,
      pageSize,
      items: items.slice((pageNumber - 1) * pageSize, pageNumber * pageSize),
    };
  }

  // ── 任务创建与扫描 ────────────────────────────────────────

  createJob(input) {
    const src = this.channel(input.sourceChannelId);
    const dst = this.channel(input.targetChannelId);
    const statuses = Array.isArray(input.statuses) && input.statuses.length
      ? input.statuses.filter(s => ['Active', 'Processing', 'Failed'].includes(s))
      : ['Active'];
    const groupIds = input.groupIds === 'all' || input.groupIds == null
      ? 'all'
      : (Array.isArray(input.groupIds) && input.groupIds.length ? input.groupIds.map(String) : 'all');
    const job = {
      id: newJobId(),
      name: String(input.name || '').trim() || `${src.name} → ${dst.name}`,
      status: 'scanning',
      error: null,
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      source: { channelId: src.id, name: src.name },
      target: { channelId: dst.id, name: dst.name },
      filter: { groupIds, statuses },
      skipExisting: input.skipExisting === undefined ? !!this.config.data.settings.skipExisting : !!input.skipExisting,
      autoStart: !!input.autoStart,
      settings: { ...this.config.data.settings, ...(input.settings && typeof input.settings === 'object' ? input.settings : {}) },
      scan: { groupsTotal: 0, groupsDone: 0, assetsFound: 0 },
      counters: { total: 0, pending: 0, uploading: 0, polling: 0, done: 0, failed: 0, skipped: 0 },
      groups: [],
      items: [],
      log: [],
    };
    this.log(job, 'info', `任务已创建：源「${src.name}」→ 目标「${dst.name}」，状态过滤 [${statuses.join(', ')}]，跳过已存在=${job.skipExisting}`);
    this.jobs.set(job.id, job);
    this.markDirty(job.id);
    this.flush(); // 任务骨架立即落盘：进程意外退出也不丢任务记录
    this.runScan(job).catch(err => this.scanFailed(job, err));
    return this.meta(job);
  }

  channel(id) {
    const c = this.config.data.channels.find(ch => ch.id === id);
    if (!c) throw new JobError(`通道不存在或已删除：${id}`, 400);
    return c;
  }

  client(job, which) {
    const side = which === 'source' ? job.source : job.target;
    const c = this.channel(side.channelId);
    return new ArkClient({ baseUrl: c.baseUrl, vendor: c.vendor, token: c.token, projectName: c.projectName, settings: job.settings });
  }

  log(job, level, msg) {
    job.log.push({ t: nowIso(), level, msg });
    if (job.log.length > LOG_CAP) job.log.splice(0, job.log.length - LOG_CAP);
  }

  scanFailed(job, err) {
    if (job._scanWatchdog) {
      clearInterval(job._scanWatchdog);
      job._scanWatchdog = null;
    }
    job.status = job._stop ? 'cancelled' : 'failed';
    job.error = err instanceof ArkError ? err.message : (err?.message || String(err));
    if (!job._stop) this.log(job, 'error', `扫描失败：${job.error}`);
    job.finishedAt = nowIso();
    this.markDirty(job.id);
    this.flush();
  }

  /** 扫描停滞看门狗：长时间无进展则判失败，避免任务永远停在「扫描中」 */
  startScanWatchdog(job) {
    job._lastScanProgress = Date.now();
    const timer = setInterval(() => {
      if (job.status !== 'scanning') {
        clearInterval(job._scanWatchdog);
        job._scanWatchdog = null;
        return;
      }
      const stallMs = job.settings.scanStallTimeoutMs || 600000;
      if (Date.now() - job._lastScanProgress > stallMs) {
        this.log(job, 'error', `扫描超过 ${Math.round(stallMs / 60000)} 分钟无进展，判定失败（上游接口不可达或严重限流？可重试或调大 scanStallTimeoutMs）`);
        this.scanFailed(job, new Error(`扫描停滞超时（>${Math.round(stallMs / 60000)} 分钟无进展）`));
      }
    }, 30000);
    timer.unref?.();
    job._scanWatchdog = timer;
  }

  async runScan(job) {
    try {
      const src = this.client(job, 'source');
      const dst = this.client(job, 'target');
      this.startScanWatchdog(job);

      this.log(job, 'info', '开始扫描源通道素材组…');
      const allSrcGroups = await src.listAllGroups();
      job._lastScanProgress = Date.now();
      const srcGroups = job.filter.groupIds === 'all'
        ? allSrcGroups
        : allSrcGroups.filter(g => job.filter.groupIds.includes(g.Id));
      if (job._stop) throw new Error('已取消');
      job.scan.groupsTotal = srcGroups.length;
      this.log(job, 'info', `源通道共 ${srcGroups.length} 个 AIGC 素材组待处理`);

      const dstGroups = await dst.listAllGroups();
      job._lastScanProgress = Date.now();
      const dstByName = new Map(dstGroups.map(g => [g.Name, g]));

      for (const g of srcGroups) {
        if (job._stop || job.status !== 'scanning') throw new Error('已取消');
        let target = dstByName.get(g.Name);
        let created = false;
        if (!target) {
          target = await dst.createAssetGroup({
            name: g.Name,
            description: `由素材库迁移工具创建，迁移自「${job.source.name}」/${g.Name}${g.Description ? `。原描述：${g.Description}` : ''}`,
          });
          created = true;
          dstByName.set(g.Name, target);
          this.log(job, 'info', `创建目标素材组「${g.Name}」→ ${target.Id}`);
        }
        job.groups.push({ sourceGroupId: g.Id, sourceGroupName: g.Name, targetGroupId: target.Id, created });

        let existingNames = null;
        if (job.skipExisting) {
          const dstAssets = await dst.listAllAssets({ groupId: target.Id });
          existingNames = new Set(dstAssets.filter(a => a.Status === 'Active').map(a => a.Name));
        }
        const assets = await src.listAllAssets({ groupId: g.Id, statuses: job.filter.statuses });
        const dupCount = existingNames ? assets.filter(a => existingNames.has(a.Name)).length : 0;
        for (const a of assets) {
          job.items.push({
            key: `${g.Id}/${a.Id}`,
            src: { id: a.Id, name: a.Name, assetType: a.AssetType, status: a.Status, groupId: g.Id },
            dst: { id: null, status: null },
            state: 'pending',
            existing: !!(existingNames && existingNames.has(a.Name)),
            attempts: 0,
            error: null,
            uploadedAt: null,
            finishedAt: null,
          });
        }
        job.scan.groupsDone += 1;
        job.scan.assetsFound = job.items.length;
        job._lastScanProgress = Date.now();
        this.log(job, 'info', `扫描组 ${job.scan.groupsDone}/${srcGroups.length}「${g.Name}」：${assets.length} 个素材${dupCount ? `（${dupCount} 个目标已存在将跳过）` : ''}`);
        this.markDirty(job.id);
      }

      this.recount(job);
      job.status = 'ready';
      if (job._scanWatchdog) {
        clearInterval(job._scanWatchdog);
        job._scanWatchdog = null;
      }
      this.log(job, 'info', `扫描完成：${job.groups.length} 个组 / ${job.items.length} 个素材（其中 ${job.items.filter(i => i.existing).length} 个目标已存在将跳过）`);
      this.markDirty(job.id);
      this.flush();
      if (job.autoStart && !job._stop) this.start(job);
    } catch (err) {
      this.scanFailed(job, err);
    }
  }

  // ── 任务控制 ──────────────────────────────────────────────

  control(id, action) {
    const job = this.must(id);
    switch (action) {
      case 'start': {
        if (!['ready', 'paused'].includes(job.status)) throw new JobError(`当前状态「${job.status}」不能启动`);
        this.start(job);
        break;
      }
      case 'pause': {
        if (job.status !== 'running') throw new JobError(`当前状态「${job.status}」不能暂停`);
        job._stop = true;
        job.status = 'paused';
        this.log(job, 'info', '任务已暂停：在途素材会处理完毕，不再领取新素材');
        break;
      }
      case 'cancel': {
        if (!ACTIVE_STATES.includes(job.status)) throw new JobError(`当前状态「${job.status}」不能取消`);
        job._stop = true;
        if (job.status === 'scanning') {
          // runScan 在组间检查 _stop，转由 scanFailed 收尾为 cancelled
          this.log(job, 'info', '已请求取消，等待扫描循环退出…');
        } else {
          job.status = 'cancelled';
          job.finishedAt = nowIso();
          this.log(job, 'info', '任务已取消：在途素材会处理完毕，不再领取新素材');
        }
        break;
      }
      case 'retry-failed': {
        const failed = job.items.filter(it => it.state === 'failed');
        if (!failed.length) throw new JobError('没有可重试的失败素材');
        for (const it of failed) {
          it.state = 'pending';
          it.error = null;
          // 保留 it.dst.id：重试先轮询既有目标素材，避免重复上传
        }
        this.recount(job);
        this.log(job, 'info', `已将 ${failed.length} 个失败素材重置为待迁移`);
        if (['completed', 'cancelled', 'failed'].includes(job.status)) {
          job.status = 'paused';
          job.finishedAt = null;
          this.log(job, 'info', '任务转回「已暂停」，请点击「启动」执行重试');
        }
        break;
      }
      default:
        throw new JobError(`未知操作：${action}`, 400);
    }
    this.markDirty(job.id);
    this.flush();
    return { ok: true, job: this.meta(job) };
  }

  recount(job) {
    const c = { total: job.items.length, pending: 0, uploading: 0, polling: 0, done: 0, failed: 0, skipped: 0 };
    for (const it of job.items) c[it.state] = (c[it.state] || 0) + 1;
    job.counters = c;
  }

  bump(job, from, to) {
    if (job.counters[from] > 0) job.counters[from]--;
    job.counters[to] = (job.counters[to] || 0) + 1;
  }

  start(job) {
    job._stop = false;
    job.status = 'running';
    job.startedAt = job.startedAt || nowIso();
    job.finishedAt = null;
    // 运行时防重集合：预跳过项 + 本次运行已完成项（同组同名只迁一次）
    const groupIdMap = new Map(job.groups.map(g => [g.sourceGroupId, g.targetGroupId]));
    job._runtimeDup = new Set(
      job.items.filter(it => it.existing).map(it => `${groupIdMap.get(it.src.groupId)}/${it.src.name}`),
    );
    job._workersAlive = Math.max(1, job.settings.concurrency | 0);
    this.log(job, 'info', `任务启动：并发 ${job._workersAlive}`);
    this.markDirty(job.id);
    for (let i = 0; i < job._workersAlive; i++) {
      this.workerLoop(job).then(() => this.maybeFinalize(job)).catch(err => {
        this.log(job, 'error', `worker 异常退出：${err?.message || err}`);
        job._workersAlive--;
        this.maybeFinalize(job);
      });
    }
  }

  maybeFinalize(job) {
    if (job._workersAlive > 0) return;
    if (job.status !== 'running') return;
    const busy = job.items.some(it => IN_FLIGHT.includes(it.state) || it.state === 'pending');
    if (!busy) {
      job.status = 'completed';
      job.finishedAt = nowIso();
      const c = job.counters;
      this.log(job, 'info', `任务完成：成功 ${c.done} / 跳过 ${c.skipped} / 失败 ${c.failed}，共 ${c.total}`);
      this.markDirty(job.id);
      this.flush();
    }
  }

  async workerLoop(job) {
    while (job.status === 'running' && !job._stop) {
      const item = job.items.find(it => it.state === 'pending');
      if (!item) {
        if (!job.items.some(it => IN_FLIGHT.includes(it.state))) break;
        await sleep(300);
        continue;
      }
      await this.processItem(job, item);
    }
    job._workersAlive--;
  }

  async processItem(job, item) {
    const groupIdMap = new Map(job.groups.map(g => [g.sourceGroupId, g.targetGroupId]));
    const targetGroupId = groupIdMap.get(item.src.groupId);
    this.bump(job, item.state === 'pending' ? 'pending' : item.state, 'uploading');
    item.state = 'uploading';
    this.markDirty(job.id);
    try {
      if (!targetGroupId) throw new Error('目标组映射缺失（通道配置可能已变更）');
      const dupKey = `${targetGroupId}/${item.src.name}`;
      if (!item.dst.id) {
        if (item.existing || job._runtimeDup?.has(dupKey)) {
          item.state = 'skipped';
          item.error = item.existing ? '目标组已存在同名素材' : '本次任务已迁移过同名素材';
          this.bump(job, 'uploading', 'skipped');
          this.log(job, 'info', `跳过「${item.src.name}」（${item.error}）`);
          return;
        }
        const srcClient = this.client(job, 'source');
        const dstClient = this.client(job, 'target');

        const s = await srcClient.getAsset(item.src.id);
        if (s.Status && s.Status !== 'Active') throw new Error(`源素材状态为 ${s.Status}，不可迁移`);
        if (!s.URL) throw new Error('源素材未返回可用下载 URL');

        const created = await dstClient.createAsset({
          groupId: targetGroupId,
          name: truncateName(item.src.name),
          url: s.URL,
          assetType: s.AssetType || item.src.assetType,
        });
        item.dst.id = created?.Id || null;
        item.dst.status = created?.Status || 'Processing';
        item.uploadedAt = nowIso();
        if (!item.dst.id) throw new Error('目标通道未返回素材 ID');
        job._runtimeDup?.add(dupKey);
        this.log(job, 'info', `已提交上传「${item.src.name}」→ ${item.dst.id}，开始轮询处理状态`);
      }

      this.bump(job, 'uploading', 'polling');
      item.state = 'polling';
      this.markDirty(job.id);
      await this.pollTarget(job, item);
    } catch (err) {
      const prevState = item.state;
      item.error = err?.message || String(err);
      item.state = 'failed';
      this.bump(job, IN_FLIGHT.includes(prevState) ? prevState : 'uploading', 'failed');
      this.log(job, 'warn', `迁移失败「${item.src.name}」：${item.error}`);
    } finally {
      item.finishedAt = nowIso();
      item.attempts++;
      this.markDirty(job.id);
      this.maybeFinalize(job);
    }
  }

  async pollTarget(job, item) {
    const dstClient = this.client(job, 'target');
    const deadline = Date.now() + (job.settings.pollTimeoutMs || 300000);
    let consecutiveErrors = 0;
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(`目标素材处理轮询超时（>${Math.round((job.settings.pollTimeoutMs || 300000) / 1000)}s），目标素材 ID：${item.dst.id}`);
      }
      await sleep(job.settings.pollIntervalMs || 3000);
      let a;
      try {
        a = await dstClient.getAsset(item.dst.id);
        consecutiveErrors = 0;
      } catch (err) {
        if (err instanceof ArkError && err.kind === 'transient' && ++consecutiveErrors <= 6) continue;
        throw err;
      }
      item.dst.status = a?.Status || null;
      if (a?.Status === 'Active') {
        if (a.AssetType && item.src.assetType && a.AssetType !== item.src.assetType) {
          throw new Error(`目标素材类型不一致（${item.src.assetType} → ${a.AssetType}），目标素材 ID：${item.dst.id}`);
        }
        item.state = 'done';
        this.bump(job, 'polling', 'done');
        this.log(job, 'info', `迁移成功「${item.src.name}」→ ${item.dst.id}`);
        return;
      }
      if (a?.Status === 'Failed') {
        throw new Error(`目标通道处理失败（Status=Failed），目标素材 ID：${item.dst.id}`);
      }
      // Processing 或未知状态：继续轮询
    }
  }

  // ── 报告 ──────────────────────────────────────────────────

  buildReport(id, format) {
    const job = this.must(id);
    const c = job.counters;
    if (format === 'csv') {
      const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      // 组映射按名称对齐：目标组名 = 源组名（见方案 §4 组映射规则）
      const groupBySrc = new Map(job.groups.map(g => [g.sourceGroupId, g]));
      const rows = [
        ['状态', '源组ID', '组名', '目标组ID', '源素材ID', '名称', '类型', '源状态', '目标素材ID', '目标状态', '尝试次数', '错误'].map(esc).join(','),
        ...job.items.map(it => {
          const g = groupBySrc.get(it.src.groupId);
          return [
            it.state, it.src.groupId, g?.sourceGroupName || '', g?.targetGroupId || '',
            it.src.id, it.src.name, it.src.assetType, it.src.status,
            it.dst.id, it.dst.status, it.attempts, it.error,
          ].map(esc).join(',');
        }),
      ];
      return { filename: `迁移报告-${job.id}.csv`, contentType: 'text/csv', body: '\ufeff' + rows.join('\r\n') };
    }
    const L = [];
    L.push(`# 迁移任务报告 — ${job.name}`);
    L.push('');
    L.push(`- 任务 ID：${job.id}`);
    L.push(`- 状态：${job.status}${job.error ? `（${job.error}）` : ''}`);
    L.push(`- 方向：${job.source.name} → ${job.target.name}`);
    L.push(`- 创建：${job.createdAt}；完成：${job.finishedAt || '—'}`);
    L.push(`- 过滤：组范围=${job.filter.groupIds === 'all' ? '全部' : job.filter.groupIds.join('、')}；状态=[${job.filter.statuses.join(', ')}]；跳过已存在=${job.skipExisting}`);
    L.push(`- 参数：并发=${job.settings.concurrency}，轮询=${job.settings.pollIntervalMs}ms（上限 ${job.settings.pollTimeoutMs}ms），请求重试=${job.settings.requestRetries}`);
    L.push('');
    L.push('## 汇总');
    L.push('');
    L.push(`| 总数 | 成功 | 跳过 | 失败 | 待迁移 | 处理中 |`);
    L.push(`| --- | --- | --- | --- | --- | --- |`);
    L.push(`| ${c.total} | ${c.done} | ${c.skipped} | ${c.failed} | ${c.pending} | ${c.uploading + c.polling} |`);
    L.push('');
    if (job.groups.length) {
      L.push('## 素材组映射');
      L.push('');
      L.push('| 源组 | 目标组 | 新建 |');
      L.push('| --- | --- | --- |');
      for (const g of job.groups) L.push(`| ${g.sourceGroupName} | ${g.targetGroupId} | ${g.created ? '是' : '否'} |`);
      L.push('');
    }
    const failedItems = job.items.filter(it => it.state === 'failed');
    L.push(`## 失败明细（${failedItems.length}）`);
    L.push('');
    if (failedItems.length) {
      L.push('| 名称 | 类型 | 错误 | 目标素材ID |');
      L.push('| --- | --- | --- | --- |');
      for (const it of failedItems) {
        L.push(`| ${it.src.name} | ${it.src.assetType} | ${it.error || ''} | ${it.dst.id || '—'} |`);
      }
    } else {
      L.push('无');
    }
    L.push('');
    L.push('## 校验语义');
    L.push('');
    L.push('本报告中的「成功」= 目标素材存在且 Status=Active、类型与源一致（L1 级校验）。素材库不暴露内容指纹且上游会做审核处理，无法做字节级比对。');
    return { filename: `迁移报告-${job.id}.md`, contentType: 'text/markdown', body: L.join('\n') };
  }
}
