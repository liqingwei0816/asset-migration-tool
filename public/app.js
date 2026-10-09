/* 素材库跨通道迁移工作台 · 前端（原生 JS，零构建） */
'use strict';

// ── 工具 ────────────────────────────────────────────────────

const $ = sel => document.querySelector(sel);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const bid = res.headers.get('X-Boot-Id');
  if (bid) noteBootId(bid);
  let data = null;
  try { data = await res.json(); } catch { /* 空响应 */ }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

/** 检测服务重启（bootId 变化）：自动刷新页面数据，避免持有过期 id */
function noteBootId(bid) {
  if (state.bootId === bid) return;
  const prev = state.bootId;
  state.bootId = bid;
  if (prev !== null && !state.restarting) handleServerRestart();
}

async function handleServerRestart() {
  state.restarting = true;
  try {
    toast('检测到服务重启，已自动刷新页面数据');
    state.detail = null;
    const detailCard = $('#job-detail-card');
    if (detailCard) detailCard.style.display = 'none';
    state.create = { groupScope: 'all', sourceGroups: [], selectedGroups: [] };
    await loadConfig();
    if (state.tab === 'channels') renderChannels();
    else if (state.tab === 'browse') renderBrowse();
    else { renderJobCreate(); refreshJobs(); }
  } catch { /* 刷新失败交给下一次轮询 */ } finally {
    state.restarting = false;
  }
}

function toast(msg, isErr = false) {
  const el = document.createElement('div');
  el.className = `toast${isErr ? ' err' : ''}`;
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), isErr ? 6000 : 3000);
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const JOB_STATUS = {
  scanning: ['扫描中', 'amber'],
  ready: ['待启动', 'blue'],
  running: ['运行中', 'green'],
  paused: ['已暂停', 'gray'],
  completed: ['已完成', 'green'],
  cancelled: ['已取消', 'gray'],
  failed: ['失败', 'red'],
};

const ITEM_STATE = {
  pending: ['待迁移', 'gray'],
  uploading: ['上传中', 'amber'],
  polling: ['轮询中', 'amber'],
  done: ['成功', 'green'],
  failed: ['失败', 'red'],
  skipped: ['跳过', 'teal'],
};

const ASSET_STATUS = { Active: ['可用', 'green'], Processing: ['处理中', 'amber'], Failed: ['失败', 'red'] };

const badge = (map, key) => {
  const [label, color] = map[key] || [key || '—', 'gray'];
  return `<span class="badge ${color}">${esc(label)}</span>`;
};

// ── 全局状态 ────────────────────────────────────────────────

const state = {
  tab: 'channels',
  bootId: null,          // 服务实例标识，变化 = 服务已重启
  restarting: false,
  connLost: false,       // 轮询连续失败 = 服务不可达
  connLostBootId: null,
  config: { channels: [], settings: {} },
  browse: { channelId: '', groupPage: 1, groupId: null, currentGroupName: '', assetPage: 1, assetStatus: '', assetName: '' },
  create: { groupScope: 'all', sourceGroups: [] },
  jobs: [],
  detail: null,          // 打开详情的任务 id
  detailFilter: '',
  detailPage: 1,
  detailFp: null,       // 详情内容指纹：无变化时跳过重绘（保持日志滚动位置）
};

// ── Tab 切换 ───────────────────────────────────────────────

$('#tabs').addEventListener('click', e => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  state.tab = btn.dataset.tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === btn));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${state.tab}`));
  if (state.tab === 'channels') loadConfig().then(renderChannels);
  if (state.tab === 'browse') { loadConfig().then(renderBrowse); }
  if (state.tab === 'jobs') { loadConfig().then(renderJobCreate); refreshJobs(); }
});

// ── 通道配置 ───────────────────────────────────────────────

async function loadConfig() {
  state.config = await api('/api/config');
  return state.config;
}

function renderChannels() {
  const box = $('#channel-table');
  const chs = state.config.channels;
  if (!chs.length) {
    box.innerHTML = '<div class="empty">还没有通道，点击右上角「新增通道」开始配置。</div>';
    return;
  }
  box.innerHTML = `
    <table>
      <thead><tr><th>名称</th><th>服务地址</th><th>服务商标识</th><th>ProjectName</th><th>访问令牌</th><th style="width:230px">操作</th></tr></thead>
      <tbody>
        ${chs.map(c => `
          <tr data-id="${esc(c.id)}">
            <td><b>${esc(c.name)}</b></td>
            <td class="mono">${esc(c.baseUrl)}</td>
            <td class="mono">${esc(c.vendor)}</td>
            <td class="mono">${esc(c.projectName)}</td>
            <td class="mono">${esc(c.tokenHint)}</td>
            <td><div class="btn-row">
              <button class="btn sm" data-act="assets">素材</button>
              <button class="btn sm" data-act="test">测试</button>
              <button class="btn sm" data-act="edit">编辑</button>
              <button class="btn sm danger" data-act="del">删除</button>
            </div></td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

$('#channel-table').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('tr').dataset.id;
  const ch = state.config.channels.find(c => c.id === id);
  if (!ch) return;
  if (btn.dataset.act === 'assets') {
    openChannelAssetsModal(ch);
  } else if (btn.dataset.act === 'test') {
    btn.disabled = true;
    btn.textContent = '测试中…';
    try {
      const r = await api('/api/channels/test', { method: 'POST', body: { id } });
      if (r.ok) toast(`「${ch.name}」连通正常：${r.latencyMs}ms，AIGC 组 ${r.totalGroups ?? '?'} 个（项目 ${r.projectName}）`);
      else if (r.detail && r.detail.url) toast(renderTestFailure(r), true);
      else toast(`「${ch.name}」连通失败：${r.error}`, true);
    } catch (err) { toast(err.message, true); }
    btn.disabled = false;
    btn.textContent = '测试';
  } else if (btn.dataset.act === 'edit') {
    openChannelModal(ch);
  } else if (btn.dataset.act === 'del') {
    if (!confirm(`确认删除通道「${ch.name}」？正在运行的任务会因通道缺失而失败。`)) return;
    try {
      state.config = await api(`/api/channels/${encodeURIComponent(id)}`, { method: 'DELETE' });
      renderChannels();
      toast('通道已删除');
    } catch (err) {
      toast(`删除失败：${err.message}`, true);
      loadConfig().then(renderChannels);
    }
  }
});

$('#btn-add-channel').addEventListener('click', () => openChannelModal(null));

/** 把连通性测试的失败响应渲染为「错误 + 请求链路 + 响应 + 排查建议」多行文本 */
function renderTestFailure(r) {
  const lines = [`✗ ${r.error}`];
  const d = r.detail;
  if (d) {
    if (d.url) lines.push(`请求：${d.method || 'POST'} ${d.url}`);
    if (d.status) lines.push(`状态：HTTP ${d.status}${d.attempts > 1 ? `（已自动重试 ${d.attempts} 次）` : ''}`);
    if (d.responseBody) lines.push(`响应：${d.responseBody.slice(0, 300)}`);
    if (d.hint) lines.push(`排查：${d.hint}`);
  }
  return lines.join('\n');
}

function openChannelModal(ch) {
  const isEdit = !!ch;
  openModal(`
    <h3>${isEdit ? '编辑通道' : '新增通道'}</h3>
    <div class="form-grid">
      <div class="field"><label>通道名称</label><input id="f-name" placeholder="如：火山通道" value="${esc(ch?.name || '')}"></div>
      <div class="field"><label>服务地址</label><input id="f-baseurl" placeholder="https://llm.future.jetsentv.com" value="${esc(ch?.baseUrl || '')}"></div>
      <div class="field"><label>服务商标识</label><input id="f-vendor" placeholder="平台分配的通道标识（URL 路径段）" value="${esc(ch?.vendor || '')}"></div>
      <div class="field"><label>ProjectName</label><input id="f-project" placeholder="如：yd_test" value="${esc(ch?.projectName || '')}"></div>
      <div class="field" style="grid-column:1/-1"><label>访问令牌（Authorization: Bearer sk-…）${isEdit ? '；留空保持原值' : ''}</label>
        <input id="f-token" type="password" placeholder="${isEdit ? `已保存：${ch.tokenHint}，留空不修改` : 'sk-xxxx'}" autocomplete="new-password"></div>
    </div>
    <div class="test-result" id="test-result"></div>
    <div class="actions">
      <button class="btn" id="btn-test-channel">测试连通</button>
      <span style="flex:1"></span>
      <button class="btn" id="btn-cancel-modal">取消</button>
      <button class="btn primary" id="btn-save-channel">保存</button>
    </div>
  `);
  $('#btn-cancel-modal').addEventListener('click', closeModal);
  $('#btn-save-channel').addEventListener('click', async () => {
    const item = {
      name: $('#f-name').value.trim(),
      baseUrl: $('#f-baseurl').value.trim(),
      vendor: $('#f-vendor').value.trim(),
      projectName: $('#f-project').value.trim(),
      token: $('#f-token').value.trim(),
    };
    try {
      // 单通道提交：只保存当前编辑的通道，其他通道的校验状态不影响本次保存
      state.config = isEdit
        ? await api(`/api/channels/${encodeURIComponent(ch.id)}`, { method: 'PUT', body: item })
        : await api('/api/channels', { method: 'POST', body: item });
      closeModal();
      renderChannels();
      toast('通道配置已保存（data/config.json）');
    } catch (err) {
      toast(`保存失败：${err.message}`, true);
      if (/不存在或已被删除/.test(err.message)) {
        // 页面持有的通道在服务端已不存在（服务重启、他处删除等）：刷新列表后重新添加
        closeModal();
        loadConfig().then(renderChannels);
      }
    }
  });
  $('#btn-test-channel').addEventListener('click', async () => {
    const box = $('#test-result');
    box.className = 'test-result';
    box.textContent = '测试中…';
    box.style.display = 'block';
    try {
      const r = await api('/api/channels/test', {
        method: 'POST',
        body: {
          channel: {
            id: ch?.id || '',
            name: $('#f-name').value.trim(),
            baseUrl: $('#f-baseurl').value.trim(),
            vendor: $('#f-vendor').value.trim(),
            projectName: $('#f-project').value.trim(),
            token: $('#f-token').value.trim(),
          },
        },
      });
      box.className = `test-result ${r.ok ? 'ok' : 'err'}`;
      box.textContent = r.ok
        ? `✓ 连通正常：${r.latencyMs}ms，AIGC 组 ${r.totalGroups ?? '?'} 个（项目 ${r.projectName}）`
        : renderTestFailure(r);
    } catch (err) {
      box.className = 'test-result err';
      box.textContent = `✗ ${err.message}`;
    }
  });
}

// ── 素材浏览 ───────────────────────────────────────────────

function renderBrowse() {
  const box = $('#browse-panel');
  const chs = state.config.channels;
  if (!chs.length) {
    box.innerHTML = '<div class="empty">请先在「通道配置」中添加通道。</div>';
    return;
  }
  if (!chs.find(c => c.id === state.browse.channelId)) {
    state.browse = { ...state.browse, channelId: chs[0].id, groupId: null, groupPage: 1, assetPage: 1 };
  }
  box.innerHTML = `
    <div class="toolbar">
      <b>通道</b>
      <select id="browse-channel">${chs.map(c => `<option value="${esc(c.id)}"${c.id === state.browse.channelId ? ' selected' : ''}>${esc(c.name)}（${esc(c.vendor)} / ${esc(c.projectName)}）</option>`).join('')}</select>
      <span class="hint-inline">仅列出 AIGC 素材组；真人素材组（LivenessFace）须经活体认证产生，不在列表且不可迁移</span>
    </div>
    <div id="browse-groups"></div>`;
  $('#browse-channel').addEventListener('change', e => {
    state.browse = { ...state.browse, channelId: e.target.value, groupId: null, groupPage: 1, assetPage: 1 };
    loadGroups();
  });
  loadGroups();
}

async function loadGroups() {
  const b = state.browse;
  const box = $('#browse-groups');
  box.innerHTML = '<div class="empty">加载中…</div>';
  try {
    const r = await api(`/api/channels/${encodeURIComponent(b.channelId)}/groups?page=${b.groupPage}&pageSize=20`);
    const pages = Math.max(1, Math.ceil(r.total / r.pageSize));
    if (b.groupPage > pages) { b.groupPage = pages; return loadGroups(); }
    box.innerHTML = `
      ${b.groupId ? `<div class="crumb">正在查看组：<b>${esc(b.currentGroupName || b.groupId)}</b> <button class="btn sm" id="btn-back-groups">← 返回组列表</button></div>` : ''}
      <div id="groups-box">${r.total === 0
        ? '<div class="empty">该通道项目下没有 AIGC 素材组。</div>'
        : `<table>
            <thead><tr><th>素材组 ID</th><th>名称</th><th>描述</th><th style="width:110px">操作</th></tr></thead>
            <tbody>${r.groups.map(g => `
              <tr>
                <td class="mono">${esc(g.Id)}</td>
                <td><b>${esc(g.Name)}</b></td>
                <td>${esc(g.Description || '')}</td>
                <td><button class="btn sm" data-gid="${esc(g.Id)}" data-gname="${esc(g.Name)}">查看素材</button></td>
              </tr>`).join('')}</tbody>
          </table>`}
      </div>
      ${b.groupId ? '' : `
      <div class="pager">
        <button class="btn sm" id="g-prev" ${b.groupPage <= 1 ? 'disabled' : ''}>上一页</button>
        <span>第 ${b.groupPage} / ${pages} 页 · 共 ${r.total} 组</span>
        <button class="btn sm" id="g-next" ${b.groupPage >= pages ? 'disabled' : ''}>下一页</button>
      </div>`}`;
    const back = $('#btn-back-groups');
    if (back) back.addEventListener('click', () => { b.groupId = null; loadGroups(); });
    box.querySelectorAll('button[data-gid]').forEach(btn => btn.addEventListener('click', () => {
      b.groupId = btn.dataset.gid;
      b.currentGroupName = btn.dataset.gname;
      b.assetPage = 1;
      loadGroups();
    }));
    const prev = $('#g-prev');
    const next = $('#g-next');
    if (prev) prev.addEventListener('click', () => { b.groupPage--; loadGroups(); });
    if (next) next.addEventListener('click', () => { b.groupPage++; loadGroups(); });
    if (b.groupId) await loadAssets();
  } catch (err) {
    box.innerHTML = `<div class="empty">加载失败：${esc(err.message)}</div>`;
  }
}

// 媒体 URL 缓存：签名地址约 12 小时有效，会话内复用；加载失败时清缓存重取
const mediaUrlCache = new Map();

const TYPE_META = {
  Image: { label: '图片', icon: '🖼️' },
  Video: { label: '视频', icon: '🎬' },
  Audio: { label: '音频', icon: '🎵' },
};

async function fetchAssetUrl(channelId, assetId) {
  const key = `${channelId}/${assetId}`;
  const a = await api(`/api/channels/${encodeURIComponent(channelId)}/assets/${encodeURIComponent(assetId)}`);
  if (a?.URL) mediaUrlCache.set(key, a.URL);
  return a?.URL || null;
}

function assetCardHtml(a, opts = {}) {
  const t = TYPE_META[a.AssetType] || { label: a.AssetType || '未知', icon: '📄' };
  const sub = opts.showGroup && a.GroupId ? `${esc(a.Id)} · 组 ${esc(a.GroupId)}` : esc(a.Id);
  return `
    <div class="asset-card" data-id="${esc(a.Id)}">
      <div class="asset-thumb">
        <div class="asset-placeholder"><span>${t.icon}</span><em>${esc(t.label)}</em></div>
      </div>
      <div class="asset-meta">
        <div class="asset-name" title="${esc(a.Name)}">${esc(a.Name)}</div>
        <div class="asset-sub mono" title="${esc(a.Id)}${opts.showGroup && a.GroupId ? ` · ${esc(a.GroupId)}` : ''}">${sub}</div>
        <div class="asset-state">${badge(ASSET_STATUS, a.Status)}</div>
      </div>
    </div>`;
}

/** 给卡片挂载真实媒体（图片/视频/音频）；列表项无 URL 时按需取详情 */
async function hydrateAssetMedia(gridEl, channelId, assets) {
  await Promise.all(assets.map(async a => {
    const card = gridEl.querySelector(`.asset-card[data-id="${CSS.escape(a.Id)}"]`);
    if (!card || card.dataset.hydrated) return;
    try {
      const url = a.URL || mediaUrlCache.get(`${channelId}/${a.Id}`) || await fetchAssetUrl(channelId, a.Id);
      if (!url || !gridEl.isConnected) return;
      card.dataset.hydrated = '1';
      mountAssetMedia(card, channelId, a, url);
    } catch { /* 详情获取失败：保留类型图标占位 */ }
  }));
}

function mountAssetMedia(card, channelId, a, url) {
  const thumb = card.querySelector('.asset-thumb');
  const refetchOnce = async () => {
    mediaUrlCache.delete(`${channelId}/${a.Id}`);
    return fetchAssetUrl(channelId, a.Id).catch(() => null);
  };
  if (a.AssetType === 'Image') {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = a.Name;
    img.src = url;
    img.onerror = async () => {
      const fresh = await refetchOnce();
      if (fresh && fresh !== url) { img.src = fresh; return; }
      thumb.innerHTML = `<div class="asset-placeholder"><span>🖼️</span><em>预览不可用</em></div>`;
    };
    thumb.innerHTML = '';
    thumb.appendChild(img);
    thumb.classList.add('clickable');
    thumb.title = '点击查看大图';
    thumb.addEventListener('click', () => openMediaViewer(a.Name, 'Image', img.currentSrc || url));
  } else if (a.AssetType === 'Video') {
    const v = document.createElement('video');
    v.controls = true;
    v.preload = 'metadata';
    v.playsInline = true;
    v.src = url;
    v.onerror = () => {
      v.remove();
      thumb.innerHTML = `<div class="asset-placeholder"><span>🎬</span><em>视频预览不可用</em></div>`;
    };
    thumb.innerHTML = '';
    thumb.appendChild(v);
  } else if (a.AssetType === 'Audio') {
    const au = document.createElement('audio');
    au.controls = true;
    au.preload = 'none';
    au.src = url;
    thumb.innerHTML = `<div class="asset-placeholder"><span>🎵</span><em>${esc(a.Name)}</em></div>`;
    const bar = document.createElement('div');
    bar.className = 'audio-bar';
    bar.appendChild(au);
    thumb.appendChild(bar);
  }
}

function openMediaViewer(name, type, src) {
  const media = type === 'Image'
    ? `<img src="${esc(src)}" alt="${esc(name)}">`
    : type === 'Video'
      ? `<video src="${esc(src)}" controls autoplay></video>`
      : `<audio src="${esc(src)}" controls autoplay></audio>`;
  // full：全尺寸展示层，弹窗随媒体原始尺寸自适应，仅超出视口时缩放
  openModal(`
    <h3 class="viewer-title">${esc(name)}</h3>
    <div class="viewer">${media}</div>
    <div class="actions"><button class="btn" id="btn-viewer-close">关闭</button></div>`, { full: true });
  $('#btn-viewer-close').addEventListener('click', closeModal);
}

async function loadAssets() {
  const b = state.browse;
  const box = $('#groups-box');
  box.innerHTML = '<div class="empty">加载素材中…</div>';
  try {
    const r = await api(`/api/channels/${encodeURIComponent(b.channelId)}/groups/${encodeURIComponent(b.groupId)}/assets?page=${b.assetPage}&pageSize=20&status=${encodeURIComponent(b.assetStatus)}&name=${encodeURIComponent(b.assetName)}`);
    const pages = Math.max(1, Math.ceil(r.total / r.pageSize));
    if (b.assetPage > pages) { b.assetPage = pages; return loadAssets(); }
    box.innerHTML = `
      <div class="items-filter">
        <select id="asset-status">
          <option value="">全部状态</option>
          ${['Active', 'Processing', 'Failed'].map(s => `<option value="${s}"${b.assetStatus === s ? ' selected' : ''}>${ASSET_STATUS[s][0]}</option>`).join('')}
        </select>
        <input id="asset-name" placeholder="按名称搜索" value="${esc(b.assetName)}">
        <button class="btn sm" id="asset-filter-btn">筛选</button>
      </div>
      ${r.total === 0 ? `<div class="empty">该组没有符合条件的素材${(b.assetStatus || b.assetName) ? '（当前有状态/名称过滤，可清空后重试）' : ''}。</div>` : `
      <div class="asset-grid" id="asset-grid">${r.assets.map(assetCardHtml).join('')}</div>
      <div class="pager">
        <button class="btn sm" id="a-prev" ${b.assetPage <= 1 ? 'disabled' : ''}>上一页</button>
        <span>第 ${b.assetPage} / ${pages} 页 · 共 ${r.total} 个素材</span>
        <button class="btn sm" id="a-next" ${b.assetPage >= pages ? 'disabled' : ''}>下一页</button>
      </div>`}`;
    $('#asset-filter-btn').addEventListener('click', () => {
      b.assetStatus = $('#asset-status').value;
      b.assetName = $('#asset-name').value.trim();
      b.assetPage = 1;
      loadAssets();
    });
    $('#asset-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('#asset-filter-btn').click(); });
    // 空结果时不渲染分页按钮，需判空
    const prev = $('#a-prev');
    const next = $('#a-next');
    if (prev) prev.addEventListener('click', () => { b.assetPage--; loadAssets(); });
    if (next) next.addEventListener('click', () => { b.assetPage++; loadAssets(); });
    const grid = $('#asset-grid');
    if (grid) hydrateAssetMedia(grid, b.channelId, r.assets);
  } catch (err) {
    box.innerHTML = `<div class="empty">加载失败：${esc(err.message)}</div>`;
  }
}

// ── 迁移任务 ───────────────────────────────────────────────

$('#btn-toggle-create').addEventListener('click', () => {
  const box = $('#job-create');
  const hidden = box.style.display === 'none';
  box.style.display = hidden ? '' : 'none';
  $('#btn-toggle-create').textContent = hidden ? '收起' : '展开';
});

function renderJobCreate() {
  const chs = state.config.channels;
  const s = state.config.settings;
  const box = $('#job-create');
  if (chs.length < 1) {
    box.innerHTML = '<div class="empty">请先在「通道配置」中添加至少一个通道。</div>';
    return;
  }
  if (chs.length < 2) {
    box.innerHTML = '<div class="empty">迁移需要至少两个通道，请继续添加目标通道。</div>';
    return;
  }
  const opt = (sel) => chs.map(c => `<option value="${esc(c.id)}"${c.id === sel ? ' selected' : ''}>${esc(c.name)}（${esc(c.vendor)}）</option>`).join('');
  // 持有的选择可能已失效（通道被删/服务重启）：回退到有效通道
  const valid = id => chs.some(c => c.id === id);
  if (!valid(state.create.srcId)) state.create.srcId = chs[0].id;
  if (!valid(state.create.dstId) || state.create.dstId === state.create.srcId) {
    state.create.dstId = (chs.find(c => c.id !== state.create.srcId) || chs[0]).id;
  }
  box.innerHTML = `
    <div class="form-grid">
      <div class="field"><label>源通道（迁出）</label><select id="j-src">${opt(state.create.srcId)}</select></div>
      <div class="field"><label>目标通道（迁入）</label><select id="j-dst">${opt(state.create.dstId || chs[1].id)}</select></div>
      <div class="field"><label>任务名称（可选）</label><input id="j-name" placeholder="默认自动生成「源 → 目标」"></div>
    </div>
    <fieldset>
      <legend>迁移范围</legend>
      <div class="checks">
        <label><input type="radio" name="j-scope" value="all" ${state.create.groupScope === 'all' ? 'checked' : ''}> 全部 AIGC 素材组</label>
        <label><input type="radio" name="j-scope" value="manual" ${state.create.groupScope === 'manual' ? 'checked' : ''}> 手动选择组</label>
        <label style="color:var(--muted)">状态过滤：</label>
        ${['Active', 'Processing', 'Failed'].map(st => `<label><input type="checkbox" name="j-status" value="${st}"${st === 'Active' ? ' checked' : ''}> ${ASSET_STATUS[st][0]}</label>`).join('')}
      </div>
      <div class="group-picker" id="j-group-picker" style="display:${state.create.groupScope === 'manual' ? 'block' : 'none'}">选择源通道后加载组列表…</div>
    </fieldset>
    <fieldset>
      <legend>执行参数（默认继承全局设置）</legend>
      <div class="form-grid">
        <div class="field"><label>跳过目标已存在同名素材</label>
          <select id="j-skip"><option value="1" ${s.skipExisting ? 'selected' : ''}>跳过（推荐，任务可重复执行）</option><option value="0" ${!s.skipExisting ? 'selected' : ''}>不跳过</option></select></div>
        <div class="field"><label>并发数</label><input id="j-conc" type="number" min="1" max="20" value="${s.concurrency}"></div>
        <div class="field"><label>轮询间隔（ms）</label><input id="j-poll" type="number" min="250" max="60000" value="${s.pollIntervalMs}"></div>
        <div class="field"><label>单素材轮询上限（ms）</label><input id="j-timeout" type="number" min="5000" max="3600000" value="${s.pollTimeoutMs}"></div>
        <div class="field"><label>请求重试次数</label><input id="j-retry" type="number" min="0" max="10" value="${s.requestRetries}"></div>
      </div>
      <p class="hint" style="margin:4px 0 0">传输采用 URL 直传：源通道签名 URL 直接交给目标通道 CreateAsset，工具不落盘素材内容。</p>
    </fieldset>
    <div class="btn-row">
      <button class="btn primary" id="j-create-start">创建并启动</button>
      <button class="btn" id="j-create-only">仅创建</button>
    </div>
  `;
  const srcSel = $('#j-src');
  const dstSel = $('#j-dst');
  state.create.srcId = srcSel.value;
  state.create.dstId = dstSel.value;
  srcSel.addEventListener('change', () => {
    state.create.srcId = srcSel.value;
    if (dstSel.value === srcSel.value) {
      const other = chs.find(c => c.id !== srcSel.value);
      if (other) { dstSel.value = other.id; state.create.dstId = other.id; }
    }
    if (state.create.groupScope === 'manual') loadSourceGroups();
  });
  dstSel.addEventListener('change', () => { state.create.dstId = dstSel.value; });
  box.querySelectorAll('input[name=j-scope]').forEach(r => r.addEventListener('change', () => {
    state.create.groupScope = r.value;
    $('#j-group-picker').style.display = r.value === 'manual' ? 'block' : 'none';
    if (r.value === 'manual') loadSourceGroups();
  }));
  $('#j-create-start').addEventListener('click', () => submitJob(true));
  $('#j-create-only').addEventListener('click', () => submitJob(false));
}

async function loadSourceGroups() {
  const picker = $('#j-group-picker');
  picker.innerHTML = '<span class="hint-inline">加载源通道组列表…</span>';
  try {
    const r = await api(`/api/channels/${encodeURIComponent(state.create.srcId)}/groups?page=1&pageSize=100`);
    state.create.sourceGroups = r.groups;
    if (!r.groups.length) { picker.innerHTML = '<span class="hint-inline">源通道项目下没有 AIGC 组。</span>'; return; }
    picker.innerHTML = `<div class="checks">${r.groups.map(g => `
      <label><input type="checkbox" value="${esc(g.Id)}"${state.create.selectedGroups?.includes(g.Id) ? ' checked' : ''}> ${esc(g.Name)} <span class="mono" style="color:var(--muted)">${esc(g.Id)}</span></label>`).join('')}</div>
      ${r.total > r.groups.length ? '<p class="hint" style="margin:6px 0 0">组较多，仅显示前 100 个，建议使用「全部」。</p>' : ''}`;
    picker.querySelectorAll('input[type=checkbox]').forEach(cb => cb.addEventListener('change', () => {
      state.create.selectedGroups = [...picker.querySelectorAll('input:checked')].map(x => x.value);
    }));
  } catch (err) {
    picker.innerHTML = `<span class="hint-inline" style="color:var(--danger)">${esc(err.message)}</span>`;
  }
}

async function submitJob(autoStart) {
  const statuses = [...document.querySelectorAll('input[name=j-status]:checked')].map(x => x.value);
  if (!statuses.length) return toast('至少选择一个状态过滤', true);
  const groupScope = state.create.groupScope;
  const groupIds = groupScope === 'all' ? 'all' : state.create.selectedGroups || [];
  if (groupScope === 'manual' && !groupIds.length) return toast('手动模式下请至少选择一个素材组', true);
  if (state.create.srcId === state.create.dstId) return toast('源通道与目标通道不能相同', true);
  const body = {
    name: $('#j-name').value.trim(),
    sourceChannelId: state.create.srcId,
    targetChannelId: state.create.dstId,
    groupIds,
    statuses,
    skipExisting: $('#j-skip').value === '1',
    autoStart,
    settings: {
      concurrency: Number($('#j-conc').value) || undefined,
      pollIntervalMs: Number($('#j-poll').value) || undefined,
      pollTimeoutMs: Number($('#j-timeout').value) || undefined,
      requestRetries: Number($('#j-retry').value) || undefined,
    },
  };
  try {
    const job = await api('/api/jobs', { method: 'POST', body });
    toast(`任务已创建：${job.name}（${job.id}）`);
    $('#job-create').style.display = 'none';
    $('#btn-toggle-create').textContent = '展开';
    refreshJobs();
  } catch (err) { toast(err.message, true); }
}

// 任务列表与详情 ------------------------------------------------

async function refreshJobs() {
  if (state.tab !== 'jobs') return;
  try {
    state.jobs = await api('/api/jobs');
    if (state.connLost) {
      state.connLost = false;
      // 服务重启场景由 bootId 处理提示，这里只提示纯连接恢复
      if (state.connLostBootId === state.bootId) toast('与服务端的连接已恢复');
    }
    renderJobTable();
    if (state.detail) await refreshDetail();
  } catch (err) {
    // 轮询失败多为服务不可达：提示一次并保持当前展示，恢复后自动刷新
    if (!state.connLost) {
      state.connLost = true;
      state.connLostBootId = state.bootId;
      toast('与服务端连接中断，页面保持当前显示，恢复后将自动刷新', true);
    }
  }
}

function renderJobTable() {
  const box = $('#job-table');
  if (!state.jobs.length) {
    box.innerHTML = '<div class="empty">还没有迁移任务。</div>';
    return;
  }
  box.innerHTML = `
    <table>
      <thead><tr><th>任务</th><th>方向</th><th>状态</th><th>进度</th><th>创建时间</th><th style="width:300px">操作</th></tr></thead>
      <tbody>
        ${state.jobs.map(j => {
          const c = j.counters;
          const pct = c.total ? Math.round(((c.done + c.skipped + c.failed) / c.total) * 100) : (j.status === 'scanning' ? 0 : 100);
          return `
          <tr data-id="${esc(j.id)}">
            <td><b>${esc(j.name)}</b><span class="sub mono">${esc(j.id)}</span></td>
            <td>${esc(j.source.name)} → ${esc(j.target.name)}</td>
            <td>${badge(JOB_STATUS, j.status)}${j.error ? `<span class="sub" style="color:var(--danger)">${esc(j.error)}</span>` : ''}</td>
            <td>
              <div class="progress"><div style="width:${pct}%"></div></div>
              <span class="sub">成功 ${c.done} · 跳过 ${c.skipped} · 失败 ${c.failed} / ${c.total}${j.status === 'scanning' ? ` · 已扫描 ${j.scan?.groupsDone || 0}/${j.scan?.groupsTotal || '?'} 组` : ''}</span>
            </td>
            <td>${fmtTime(j.createdAt)}</td>
            <td><div class="btn-row">
              ${['ready', 'paused'].includes(j.status) ? '<button class="btn sm primary" data-act="start">启动</button>' : ''}
              ${j.status === 'running' ? '<button class="btn sm" data-act="pause">暂停</button>' : ''}
              ${['running', 'paused', 'ready', 'scanning'].includes(j.status) ? '<button class="btn sm danger" data-act="cancel">取消</button>' : ''}
              ${c.failed > 0 ? '<button class="btn sm" data-act="retry-failed">失败重试</button>' : ''}
              <button class="btn sm" data-act="detail">详情</button>
              <button class="btn sm" data-act="report-md">报告</button>
              <button class="btn sm" data-act="report-csv">CSV</button>
            </div></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

$('#job-table').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('tr').dataset.id;
  const act = btn.dataset.act;
  if (act === 'detail') { openDetail(id); return; }
  if (act.startsWith('report')) {
    const fmt = act === 'report-csv' ? 'csv' : 'md';
    window.open(`/api/jobs/${encodeURIComponent(id)}/report?format=${fmt}`, '_blank');
    return;
  }
  btn.disabled = true;
  try {
    await api(`/api/jobs/${encodeURIComponent(id)}/${act}`, { method: 'POST' });
    toast({ start: '任务已启动', pause: '任务已暂停', cancel: '任务已取消', 'retry-failed': '失败素材已重置，请启动任务执行重试' }[act] || '操作成功');
    await refreshJobs();
  } catch (err) { toast(err.message, true); btn.disabled = false; }
});

async function openDetail(id) {
  state.detail = id;
  state.detailPage = 1;
  state.detailFp = null; // 强制重绘
  $('#job-detail-card').style.display = '';
  await refreshDetail();
}

$('#btn-close-detail').addEventListener('click', () => {
  state.detail = null;
  $('#job-detail-card').style.display = 'none';
});

async function refreshDetail() {
  const id = state.detail;
  if (!id) return;
  let job;
  try {
    job = await api(`/api/jobs/${encodeURIComponent(id)}`);
  } catch {
    // 任务已不存在（服务重启数据清空/任务文件被删）：关闭详情面板
    state.detail = null;
    $('#job-detail-card').style.display = 'none';
    return;
  }
  // 内容指纹：任务已停止（无变化）时跳过重绘，避免周期刷新重置日志滚动位置
  const fp = JSON.stringify({
    s: job.status,
    c: job.counters,
    scan: job.scan,
    logLen: job.log.length,
    lastLogAt: job.log.length ? job.log[job.log.length - 1].t : null,
    f: state.detailFilter,
    p: state.detailPage,
  });
  if (fp === state.detailFp) return;
  state.detailFp = fp;

  // 重绘前记录日志区滚动位置，重绘后按"距底部距离"恢复（配合最新在前，阅读位置不跳动）
  const prevLog = $('#detail-log');
  const keepScroll = prevLog ? { bottomDist: prevLog.scrollHeight - prevLog.scrollTop } : null;
  $('#job-detail-title').textContent = `任务详情 — ${job.name}`;
  const c = job.counters;
  const grp = await api(`/api/jobs/${encodeURIComponent(id)}/items?state=${encodeURIComponent(state.detailFilter)}&page=${state.detailPage}&pageSize=20`);
  const pages = Math.max(1, Math.ceil(grp.total / grp.pageSize));
  if (state.detailPage > pages) state.detailPage = pages;
  $('#job-detail').innerHTML = `
    <div class="chips">
      ${badge(JOB_STATUS, job.status)}
      <span class="chip">方向：<b>${esc(job.source.name)} → ${esc(job.target.name)}</b></span>
      <span class="chip">总数 <b>${c.total}</b></span>
      <span class="chip">成功 <b>${c.done}</b></span>
      <span class="chip">跳过 <b>${c.skipped}</b></span>
      <span class="chip">失败 <b>${c.failed}</b></span>
      <span class="chip">待迁移 <b>${c.pending}</b></span>
      <span class="chip">处理中 <b>${c.uploading + c.polling}</b></span>
      <span class="chip">创建 ${fmtTime(job.createdAt)}</span>
      <span class="chip">完成 ${fmtTime(job.finishedAt)}</span>
    </div>
    <div class="items-filter">
      <b>素材明细</b>
      <select id="d-filter">
        <option value="">全部状态</option>
        ${Object.entries(ITEM_STATE).map(([k, v]) => `<option value="${k}"${state.detailFilter === k ? ' selected' : ''}>${v[0]}</option>`).join('')}
      </select>
      <span class="hint-inline">共 ${grp.total} 条</span>
    </div>
    ${grp.total === 0 ? '<div class="empty">没有符合条件的素材。</div>' : `
    <table>
      <thead><tr><th>源素材 ID</th><th>名称</th><th>类型</th><th>状态</th><th>目标素材 ID</th><th>尝试</th><th>错误</th></tr></thead>
      <tbody>${grp.items.map(it => `
        <tr>
          <td class="mono">${esc(it.src.id)}</td>
          <td>${esc(it.src.name)}</td>
          <td>${esc({ Image: '图片', Video: '视频', Audio: '音频' }[it.src.assetType] || it.src.assetType || '—')}</td>
          <td>${badge(ITEM_STATE, it.state)}${it.state === 'failed' && it.error ? `<span class="sub" style="color:var(--danger)">${esc(it.error)}</span>` : ''}</td>
          <td class="mono">${esc(it.dst.id || '—')}</td>
          <td>${it.attempts}</td>
          <td class="sub">${esc(it.error || '')}</td>
        </tr>`).join('')}</tbody>
    </table>
    <div class="pager">
      <button class="btn sm" id="d-prev" ${state.detailPage <= 1 ? 'disabled' : ''}>上一页</button>
      <span>第 ${state.detailPage} / ${pages} 页</span>
      <button class="btn sm" id="d-next" ${state.detailPage >= pages ? 'disabled' : ''}>下一页</button>
    </div>`}
    <div><b>运行日志</b>（最新在前，最近 ${job.log.length} 条）</div>
    <div class="log" id="detail-log">${[...job.log].reverse().map(l => `<div class="lv-${l.level}">[${fmtTime(l.t)}] ${esc(l.msg)}</div>`).join('')}</div>
  `;
  // 恢复日志阅读位置（按距底部距离锚定）
  const logEl = $('#detail-log');
  if (logEl && keepScroll) logEl.scrollTop = Math.max(0, logEl.scrollHeight - keepScroll.bottomDist);
  $('#d-filter').addEventListener('change', e => { state.detailFilter = e.target.value; state.detailPage = 1; refreshDetail(); });
  const prev = $('#d-prev');
  const next = $('#d-next');
  if (prev) prev.addEventListener('click', () => { state.detailPage--; refreshDetail(); });
  if (next) next.addEventListener('click', () => { state.detailPage++; refreshDetail(); });
}

// ── 弹窗 / 轮询 / 初始化 ───────────────────────────────────

/** 层叠弹窗：openModal 压入一层，closeModal 只弹出最上层（如图片查看器叠在素材列表之上） */
function openModal(html, opts = {}) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const cls = opts.wide ? ' wide' : opts.full ? ' full' : '';
  mask.innerHTML = `<div class="modal${cls}">${html}</div>`;
  mask.addEventListener('click', e => { if (e.target === mask) closeModal(); });
  $('#modal-root').appendChild(mask);
  return mask;
}

function closeModal() {
  const masks = $('#modal-root').querySelectorAll('.modal-mask');
  if (masks.length) masks[masks.length - 1].remove();
}

/**
 * 通道素材弹窗：左侧组列表（全部 / 按组）+ 右侧素材媒体卡片（过滤 + 分页）。
 * 图片点击放大为层叠弹窗，关闭后素材列表仍在。
 */
function openChannelAssetsModal(ch) {
  const m = { mode: 'all', groupId: null, page: 1, status: '', name: '' };
  openModal(`
    <h3>素材列表 — ${esc(ch.name)}<span class="hint-inline" style="margin-left:8px">${esc(ch.vendor)} / ${esc(ch.projectName)}</span></h3>
    <div class="items-filter">
      <select id="m-status">
        <option value="">全部状态</option>
        ${['Active', 'Processing', 'Failed'].map(s => `<option value="${s}">${ASSET_STATUS[s][0]}</option>`).join('')}
      </select>
      <input id="m-name" placeholder="按名称搜索" style="flex:1;min-width:140px">
      <button class="btn sm" id="m-filter">筛选</button>
    </div>
    <div class="assets-layout">
      <div class="group-side" id="m-groups"><div class="empty" style="padding:12px 0">组加载中…</div></div>
      <div class="assets-main"><div id="m-asset-body"><div class="empty">加载中…</div></div></div>
    </div>
    <div class="actions">
      <span class="hint-inline" style="flex:1" id="m-pager-note"></span>
      <button class="btn sm" id="m-prev">上一页</button>
      <button class="btn sm" id="m-next">下一页</button>
      <button class="btn" id="m-close">关闭</button>
    </div>
  `, { wide: true });

  const body = $('#m-asset-body');

  async function loadGroups() {
    const box = $('#m-groups');
    try {
      const r = await api(`/api/channels/${encodeURIComponent(ch.id)}/groups?page=1&pageSize=100`);
      const groups = r.groups || [];
      if (!groups.length) {
        box.innerHTML = '<div class="empty" style="padding:12px 0">无素材组</div>';
        return;
      }
      box.innerHTML = `
        <button class="gs-item active" data-gid="">全部素材</button>
        ${groups.map(g => `<button class="gs-item" data-gid="${esc(g.Id)}" title="${esc(g.Name)} · ${esc(g.Id)}">${esc(g.Name)}</button>`).join('')}
        ${r.total > groups.length ? '<p class="hint" style="margin:8px 0 0">组较多，仅显示前 100 个</p>' : ''}`;
      box.querySelectorAll('.gs-item').forEach(btn => btn.addEventListener('click', () => {
        m.mode = btn.dataset.gid ? 'group' : 'all';
        m.groupId = btn.dataset.gid || null;
        m.page = 1;
        box.querySelectorAll('.gs-item').forEach(b => b.classList.toggle('active', b === btn));
        load();
      }));
    } catch (err) {
      box.innerHTML = `<div class="empty" style="padding:12px 0">${esc(err.message)}</div>`;
    }
  }

  async function load() {
    body.innerHTML = '<div class="empty">加载中…</div>';
    try {
      const listUrl = m.mode === 'group'
        ? `/api/channels/${encodeURIComponent(ch.id)}/groups/${encodeURIComponent(m.groupId)}/assets`
        : `/api/channels/${encodeURIComponent(ch.id)}/assets`;
      const r = await api(`${listUrl}?page=${m.page}&pageSize=12&status=${encodeURIComponent(m.status)}&name=${encodeURIComponent(m.name)}`);
      const pages = Math.max(1, Math.ceil(r.total / r.pageSize));
      if (m.page > pages) { m.page = pages; return load(); }
      if (r.total === 0) {
        body.innerHTML = `<div class="empty">没有符合条件的素材${(m.status || m.name) ? '（当前有状态/名称过滤，可清空后重试）' : ''}。</div>`;
      } else {
        body.innerHTML = `<div class="asset-grid" id="m-grid">${r.assets.map(a => assetCardHtml(a, { showGroup: m.mode === 'all' })).join('')}</div>`;
        hydrateAssetMedia($('#m-grid'), ch.id, r.assets);
      }
      $('#m-pager-note').textContent = `共 ${r.total} 个素材 · 第 ${m.page} / ${pages} 页`;
      $('#m-prev').disabled = m.page <= 1;
      $('#m-next').disabled = m.page >= pages;
    } catch (err) {
      body.innerHTML = `<div class="empty">加载失败：${esc(err.message)}</div>`;
    }
  }

  $('#m-filter').addEventListener('click', () => {
    m.status = $('#m-status').value;
    m.name = $('#m-name').value.trim();
    m.page = 1;
    load();
  });
  $('#m-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('#m-filter').click(); });
  $('#m-prev').addEventListener('click', () => { m.page--; load(); });
  $('#m-next').addEventListener('click', () => { m.page++; load(); });
  $('#m-close').addEventListener('click', closeModal);
  loadGroups();
  load();
}

setInterval(() => {
  if (document.hidden) return;
  if (state.tab === 'jobs') refreshJobs();
}, 2500);

loadConfig()
  .then(() => { renderChannels(); })
  .catch(err => toast(`初始化失败：${err.message}`, true));
