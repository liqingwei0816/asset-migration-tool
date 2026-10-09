/**
 * 端到端测试：模拟素材库 + 迁移工作台，全流程走 HTTP API。
 * 运行：npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMockArk, seedVendor } from './mock-ark.js';
import { createApp } from '../src/server.js';

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? '✓' : '✗'} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  // 1. 启动模拟素材库（0 = 随机端口）
  const mock = createMockArk({ processDelayMs: 150 });
  const mockServer = await new Promise(resolve => {
    const s = mock.app.listen(0, () => resolve(s));
  });
  const mockPort = mockServer.address().port;
  mock.baseUrl = `http://127.0.0.1:${mockPort}`;

  // 2. 造数：源通道 srcv 两个组 5 个素材；目标通道 dstv 预置同名组与同名素材
  const SRC = seedVendor(mock, 'srcv', 'p_src');
  const DST = seedVendor(mock, 'dstv', 'p_dst');
  mock.media.set('m-img1', Buffer.from('image-one-png-bytes'));
  mock.media.set('m-img2', Buffer.from('image-two-png-bytes'));
  mock.media.set('m-vid1', Buffer.from('video-one-mp4-bytes'));
  mock.media.set('m-aud1', Buffer.from('audio-one-wav-bytes'));

  SRC.addGroup('group-s1', 'figure_group_1', '角色A素材集合');
  SRC.addGroup('group-s2', 'voice_group', '音频素材');
  SRC.addAsset('asset-s1', 'group-s1', 'img_front', 'Image', 'Active', 'm-img1');
  SRC.addAsset('asset-s2', 'group-s1', 'img_side', 'Image', 'Active', 'm-img2');
  SRC.addAsset('asset-s3', 'group-s1', 'clip_main', 'Video', 'Active', 'm-vid1');
  SRC.addAsset('asset-s4', 'group-s2', 'voice_over', 'Audio', 'Active', 'm-aud1');
  SRC.addAsset('asset-s5', 'group-s1', 'bad_asset', 'Image', 'Failed', '');

  DST.addGroup('group-d-pre', 'figure_group_1');
  DST.addAsset('asset-d-pre', 'group-d-pre', 'img_front', 'Image', 'Active');

  // 3. 启动工作台（临时数据目录）
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-migration-e2e-'));
  const { app, engine } = createApp({ dataDir });
  const server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const j = (method, p, body) => fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

  // ── 配置（单通道 API：A 通道的校验错误不阻塞 B 通道）──
  let r = await j('GET', '/api/config');
  check('初始配置为空', r.status === 200 && r.body.channels.length === 0);

  r = await j('POST', '/api/channels', { name: '源通道', baseUrl: mock.baseUrl, vendor: 'srcv', projectName: 'p_src', token: 'sk-src-token' });
  check('创建通道（源）', r.status === 200 && r.body.channels.length === 1);
  const srcId = r.body.channels[0].id;

  r = await j('POST', '/api/channels', { name: '目标通道', baseUrl: mock.baseUrl, vendor: 'dstv', projectName: 'p_dst', token: 'sk-dst-token' });
  const dstId = r.body.channels.find(c => c.name === '目标通道')?.id;
  check('创建通道（目标）', r.status === 200 && r.body.channels.length === 2 && !!srcId && !!dstId);
  check('令牌掩码不回传明文', r.body.channels.every(c => c.token === '' && c.tokenHint.includes('••••')));

  r = await j('POST', '/api/channels', { name: '无令牌通道', baseUrl: mock.baseUrl, vendor: 'novendor', projectName: 'p_x', token: '' });
  check('缺少令牌返回 400 业务错误', r.status === 400 && (r.body?.error || '').includes('令牌'), `status=${r.status}`);

  r = await j('PUT', `/api/channels/${srcId}`, { name: '源通道', baseUrl: mock.baseUrl, vendor: 'srcv', projectName: 'p_src', token: '' });
  check('更新通道：令牌留空保持原值', r.status === 200 && r.body.channels.length === 2);

  r = await j('PUT', '/api/channels/ch-unknown-id', { name: 'X', baseUrl: mock.baseUrl, vendor: 'x', projectName: 'p', token: 'sk-1' });
  check('更新不存在的通道返回 404', r.status === 404 && (r.body?.error || '').includes('不存在'), `status=${r.status}`);

  r = await j('PUT', '/api/settings', { concurrency: 5 });
  check('更新全局设置', r.status === 200 && r.body.settings.concurrency === 5, `concurrency=${r.body.settings?.concurrency}`);

  // 注册有效令牌后，mock 开始严格校验
  mock.tokens.add('sk-src-token');
  mock.tokens.add('sk-dst-token');

  r = await j('POST', '/api/channels/test', { id: srcId });
  check('令牌保留后连通性测试通过', r.status === 200 && r.body.ok === true && r.body.totalGroups === 2, JSON.stringify(r.body));

  r = await j('POST', '/api/channels/test', { channel: { name: '错令牌', baseUrl: mock.baseUrl, vendor: 'srcv', projectName: 'p_src', token: 'sk-wrong' } });
  check('错误令牌返回 auth 错误', r.status === 200 && r.body.ok === false && r.body.kind === 'auth', JSON.stringify(r.body));

  // 用户场景回归：另一个通道令牌缺失时，编辑本通道不受影响
  r = await j('POST', '/api/channels', { name: '无令牌通道', baseUrl: mock.baseUrl, vendor: 'novendor', projectName: 'p_x', token: '' });
  r = await j('PUT', `/api/channels/${dstId}`, { name: '目标通道v2', baseUrl: mock.baseUrl, vendor: 'dstv', projectName: 'p_dst', token: '' });
  check('其他通道令牌缺失不阻塞本通道保存', r.status === 200 && r.body.channels.find(c => c.id === dstId)?.name === '目标通道v2', `status=${r.status}`);
  r = await j('PUT', `/api/channels/${dstId}`, { name: '目标通道', baseUrl: mock.baseUrl, vendor: 'dstv', projectName: 'p_dst', token: '' });
  check('改回通道名', r.status === 200);

  // 删除通道
  r = await j('POST', '/api/channels', { name: '临时通道', baseUrl: mock.baseUrl, vendor: 'tmpv', projectName: 'p_t', token: 'sk-t' });
  const tmpId = r.body.channels.find(c => c.name === '临时通道')?.id;
  r = await j('DELETE', `/api/channels/${tmpId}`);
  check('删除通道', r.status === 200 && r.body.channels.length === 2);
  r = await j('DELETE', `/api/channels/${tmpId}`);
  check('重复删除返回 404', r.status === 404, `status=${r.status}`);

  // ── 浏览 ──
  r = await j('GET', `/api/channels/${srcId}/groups?page=1&pageSize=20`);
  check('浏览源通道组', r.status === 200 && r.body.total === 2 && r.body.groups.length === 2);

  r = await j('GET', `/api/channels/${srcId}/groups/group-s1/assets?page=1&pageSize=20&status=Active`);
  check('按状态浏览素材', r.status === 200 && r.body.total === 3, `total=${r.body.total}`);

  r = await j('GET', `/api/channels/${srcId}/assets?page=1&pageSize=12`);
  check('通道级扁平素材列表（跨组）', r.status === 200 && r.body.total === 5 && r.body.assets.every(a => a.GroupId), `total=${r.body.total}`);

  r = await j('GET', `/api/channels/${srcId}/assets?page=1&pageSize=12&name=img`);
  check('扁平列表按名称过滤', r.status === 200 && r.body.total === 2, `total=${r.body.total}`);

  // ── 任务一：迁移全部 Active 素材 ──
  r = await j('POST', '/api/jobs', {
    name: '全量迁移',
    sourceChannelId: srcId,
    targetChannelId: dstId,
    groupIds: 'all',
    statuses: ['Active'],
    skipExisting: true,
    autoStart: true,
    settings: { pollIntervalMs: 150, pollTimeoutMs: 20000 },
  });
  const job1 = r.body;
  check('创建任务并自动启动', r.status === 200 && job1.id && job1.status === 'scanning');

  const done1 = await waitTerminal(j, job1.id);
  const c1 = done1.body.counters;
  check('任务一正常完成', done1.body.status === 'completed', `status=${done1.body.status} err=${done1.body.error}`);
  check('素材总数正确（Active 4 个）', c1.total === 4, `total=${c1.total}`);
  check('目标已存在同名素材被跳过', c1.skipped === 1, `skipped=${c1.skipped}`);
  check('其余素材全部迁移成功', c1.done === 3 && c1.failed === 0, JSON.stringify(c1));

  const dstV = mock.vstate('dstv');
  const dstGroups = [...dstV.groups.values()];
  check('目标通道组映射：复用同名组 + 新建 1 组', dstGroups.length === 2 && dstGroups.some(g => g.Id === 'group-d-pre') && dstGroups.some(g => g.Name === 'voice_group'));
  const dstAssets = [...dstV.assets.values()];
  check('目标通道素材数 = 预置 1 + 新迁 3', dstAssets.length === 4, `count=${dstAssets.length}`);
  const detail1 = await j('GET', `/api/jobs/${job1.id}`);
  check('组映射记录正确', detail1.body.groups.length === 2 && detail1.body.groups.every(g => g.targetGroupId), JSON.stringify(detail1.body.groups));

  // ── 任务二：源素材不可用的失败路径 ──
  r = await j('POST', '/api/jobs', {
    name: '失败素材迁移',
    sourceChannelId: srcId,
    targetChannelId: dstId,
    groupIds: 'all',
    statuses: ['Failed'],
    autoStart: true,
    settings: { pollIntervalMs: 150, pollTimeoutMs: 20000 },
  });
  const job2 = r.body;
  const done2 = await waitTerminal(j, job2.id);
  const c2 = done2.body.counters;
  check('源素材状态不可用时任务完成但素材失败', done2.body.status === 'completed' && c2.failed === 1 && c2.done === 0, JSON.stringify(c2));

  r = await j('POST', `/api/jobs/${job2.id}/retry-failed`);
  check('失败重试：重置为待迁移并转回暂停', r.status === 200 && r.body.job.counters.pending === 1 && r.body.job.status === 'paused');

  r = await j('POST', `/api/jobs/${job2.id}/start`);
  const done2b = await waitTerminal(j, job2.id);
  check('重试后仍失败（源素材本身不可用）', done2b.body.counters.failed === 1 && done2b.body.status === 'completed');

  // ── 报告 ──
  r = await fetch(`${base}/api/jobs/${job1.id}/report?format=md`);
  const md = await r.text();
  check('MD 报告导出', r.status === 200 && md.includes('迁移任务报告') && md.includes('全量迁移'), '');
  r = await fetch(`${base}/api/jobs/${job1.id}/report?format=csv`);
  const csv = await r.text();
  check('CSV 报告导出', r.status === 200 && csv.split('\n').length >= 5, `lines=${csv.split('\n').length}`);
  check('CSV 含目标组列且映射正确', r.status === 200 && csv.includes('目标组ID') && csv.includes('figure_group_1') && csv.includes('group-d-pre'), '缺少目标组列或映射');

  // ── 幂等：同样任务再跑一遍全部跳过 ──
  r = await j('POST', '/api/jobs', {
    name: '重复执行',
    sourceChannelId: srcId,
    targetChannelId: dstId,
    groupIds: 'all',
    statuses: ['Active'],
    skipExisting: true,
    autoStart: true,
    settings: { pollIntervalMs: 150, pollTimeoutMs: 20000 },
  });
  const done3 = await waitTerminal(j, r.body.id);
  check('重复执行全部跳过（幂等）', done3.body.status === 'completed' && done3.body.counters.skipped === 4 && done3.body.counters.done === 0, JSON.stringify(done3.body.counters));
  check('目标素材未重复增加', [...mock.vstate('dstv').assets.values()].length === 4);

  // ── 进程重启恢复 ──
  const job4 = (await j('POST', '/api/jobs', {
    name: '恢复测试',
    sourceChannelId: srcId,
    targetChannelId: dstId,
    groupIds: 'all',
    statuses: ['Active'],
    skipExisting: false,
    autoStart: false,
  })).body;
  check('任务创建立即落盘（不依赖防抖刷盘）', fs.existsSync(path.join(dataDir, 'jobs', `${job4.id}.json`)), job4.id);
  await sleep(600); // 等扫描完成并落盘
  // 模拟"运行中且有两个在途素材"的状态，显式刷盘后重新加载（等价于进程重启）
  const jobObj = engine.jobs.get(job4.id);
  jobObj.status = 'running';
  jobObj.items[0].state = 'uploading';
  jobObj.items[1].state = 'polling';
  jobObj.items[1].dst.id = 'asset-simulated';
  engine.markDirty(job4.id); // 标记脏后刷盘，等价于这些状态此前已持久化
  engine.flush();
  engine.jobs.clear();
  engine.loadAll();
  const recovered = engine.jobs.get(job4.id);
  check('进程重启恢复：在途素材回收、任务转暂停', recovered.status === 'paused'
    && recovered.items[0].state === 'pending'
    && recovered.items[1].state === 'pending'
    && recovered.items[1].dst.id === 'asset-simulated',
  `status=${recovered.status} i0=${recovered.items[0].state} i1=${recovered.items[1].state}`);

  // ── 同步抛出的业务错误应返回 4xx JSON（而非穿透成 500）──
  r = await j('GET', '/api/jobs/job-not-exist');
  check('任务不存在返回 404 JSON', r.status === 404 && (r.body?.error || '').includes('不存在'), `status=${r.status}`);

  r = await j('GET', '/api/channels/ch-not-exist/groups');
  check('通道不存在返回 404 JSON', r.status === 404 && (r.body?.error || '').includes('不存在'), `status=${r.status}`);

  // ── bootId：服务实例标识（页面据此检测重启并自动刷新）──
  {
    const rr = await fetch(`${base}/api/config`);
    const body = await rr.json();
    const headerId = rr.headers.get('x-boot-id');
    check('响应携带 X-Boot-Id 且与配置体一致', !!headerId && headerId === body.bootId, `${headerId} vs ${body.bootId}`);
  }

  // ── 清理 ──
  engine.flush();
  fs.rmSync(dataDir, { recursive: true, force: true });
  await new Promise(resolve => mockServer.close(resolve));
  await new Promise(resolve => server.close(resolve));

  const failed = results.filter(x => !x.ok);
  console.log(`\n===== e2e 结果：${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length) {
    for (const f of failed) console.error(`✗ ${f.name} — ${f.detail}`);
    process.exit(1);
  }
}

async function waitTerminal(j, id, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await j('GET', `/api/jobs/${id}`);
    if (['completed', 'failed', 'cancelled'].includes(r.body.status)) return r;
    if (Date.now() > deadline) throw new Error(`任务超时未结束：${r.body.status}`);
    await sleep(200);
  }
}

main().catch(err => {
  console.error('e2e 异常退出：', err);
  process.exit(1);
});
