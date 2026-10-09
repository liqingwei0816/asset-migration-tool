/**
 * 演示模式：模拟素材库 + 工作台 + 预置数据，用于页面验收。
 * 数据持久化在 data-demo/（DEMO_RESET=1 可清空重来），重启后通道/任务 id 保持稳定。
 * 启动后访问 http://localhost:7899（Ctrl+C 退出）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockArk, seedVendor } from './mock-ark.js';
import { createApp } from '../src/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DEMO_DATA_DIR || path.join(ROOT, 'data-demo');
if (process.env.DEMO_RESET === '1') fs.rmSync(dataDir, { recursive: true, force: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = 'http://127.0.0.1:7899';

const mock = createMockArk({ processDelayMs: 300 });
const mockServer = await new Promise(resolve => {
  const s = mock.app.listen(0, () => resolve(s));
});
mock.baseUrl = `http://127.0.0.1:${mockServer.address().port}`;

const SRC = seedVendor(mock, 'srcv', 'p_src');
const DST = seedVendor(mock, 'dstv', 'p_dst');
// 演示媒体：图片用 SVG（页面卡片可直接渲染），视频/音频用二进制占位（卡片显示类型图标）
const svg = (label, sub, c1, c2) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">` +
  `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>` +
  `<rect width="480" height="360" fill="url(#g)"/>` +
  `<circle cx="240" cy="150" r="62" fill="rgba(255,255,255,.16)"/>` +
  `<text x="240" y="160" font-family="sans-serif" font-size="34" fill="rgba(255,255,255,.85)" text-anchor="middle">👤</text>` +
  `<text x="240" y="270" font-family="sans-serif" font-size="24" fill="rgba(255,255,255,.92)" text-anchor="middle">${label}</text>` +
  `<text x="240" y="304" font-family="sans-serif" font-size="15" fill="rgba(255,255,255,.6)" text-anchor="middle">${sub}</text>` +
  `</svg>`;
mock.media.set('m1', svg('正面全身照', 'figure · front view', '#0f766e', '#0b3b36'));
mock.media.set('m2', svg('侧面半身照', 'figure · side view', '#c2570f', '#5c2a08'));
mock.media.set('m3', svg('背面全身照', 'figure · back view', '#1d5c96', '#0c2d4a'));
mock.media.set('m4', Buffer.from('opening-shot-mp4-bytes-0004'));
mock.media.set('m5', Buffer.from('voiceover-take1-wav-bytes-0005'));
mock.media.set('m6', Buffer.from('voiceover-take2-wav-bytes-0006'));

SRC.addGroup('group-a1', '主角形象_夏季', '角色A夏季服装素材集合');
SRC.addGroup('group-a2', '主角形象_冬季', '角色A冬季服装素材集合');
SRC.addGroup('group-a3', '配音素材', '旁白与配音音频');
SRC.addGroup('group-a4', '空素材组', '回归用：组内无素材');
SRC.addAsset('asset-01', 'group-a1', '正面全身照', 'Image', 'Active', 'm1');
SRC.addAsset('asset-02', 'group-a1', '侧面半身照', 'Image', 'Active', 'm2');
SRC.addAsset('asset-03', 'group-a1', '背面全身照', 'Image', 'Active', 'm3');
SRC.addAsset('asset-04', 'group-a2', '冬季开场镜头', 'Video', 'Active', 'm4');
SRC.addAsset('asset-05', 'group-a3', '旁白第一版', 'Audio', 'Active', 'm5');
SRC.addAsset('asset-06', 'group-a3', '旁白第二版', 'Audio', 'Active', 'm6');

DST.addGroup('group-b1', '主角形象_夏季');
DST.addAsset('asset-b1', 'group-b1', '正面全身照', 'Image', 'Active', 'm1');

const { app } = createApp({ dataDir });
const server = await new Promise(resolve => {
  const s = app.listen(7899, () => resolve(s));
});

// 幂等播种：已有配置/任务则不重复创建，保证重启后 id 稳定
const seedChannels = [
  ['火山通道', 'srcv', 'p_src', 'sk-src-token'],
  ['移动云通道', 'dstv', 'p_dst', 'sk-dst-token'],
];
let cfg = await (await fetch(`${BASE}/api/config`)).json();
if (cfg.channels.length === 0) {
  for (const [name, vendor, project, token] of seedChannels) {
    await fetch(`${BASE}/api/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, baseUrl: mock.baseUrl, vendor, projectName: project, token }),
    });
  }
} else {
  // mock 每次启动端口随机：把演示通道的服务地址刷新到当前 mock 端口（通道 id 不变）
  for (const c of cfg.channels) {
    const seed = seedChannels.find(([, v]) => v === c.vendor);
    if (seed && c.baseUrl !== mock.baseUrl) {
      await fetch(`${BASE}/api/channels/${c.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: c.name, baseUrl: mock.baseUrl, vendor: c.vendor, projectName: c.projectName, token: '' }),
      });
    }
  }
}
cfg = await (await fetch(`${BASE}/api/config`)).json();
const [srcId, dstId] = cfg.channels.map(c => c.id);

const jobs = await (await fetch(`${BASE}/api/jobs`)).json();
if (jobs.length === 0) {
  // 任务一：全量迁移（等待完成）
  await fetch(`${BASE}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '存量素材全量迁移',
      sourceChannelId: srcId, targetChannelId: dstId,
      groupIds: 'all', statuses: ['Active'], skipExisting: true, autoStart: true,
      settings: { pollIntervalMs: 150 },
    }),
  });
  await sleep(2500);
  // 任务二：配音素材补迁
  await fetch(`${BASE}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '配音素材补迁（不跳过已存在）',
      sourceChannelId: srcId, targetChannelId: dstId,
      groupIds: ['group-a3'], statuses: ['Active'], skipExisting: false, autoStart: true,
      settings: { pollIntervalMs: 400 },
    }),
  });
}

console.log(`演示已启动：${BASE}（数据目录 ${dataDir}；DEMO_RESET=1 清空重来）`);
setInterval(() => {}, 1 << 30); // keep alive
