export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 素材库错误分类：
 * - transient：502/5xx/网络异常/超时 → 自动退避重试
 * - auth：401 → 不重试
 * - bad：400/404 等参数/路径错误 → 不重试
 *
 * 除 message 外携带请求链路字段（url / status / responseBody / attempts），
 * 供页面展示具体请求与响应。
 */
export class ArkError extends Error {
  constructor(kind, message, meta = {}) {
    super(message);
    this.name = 'ArkError';
    this.kind = kind; // 'transient' | 'auth' | 'bad'
    this.status = meta.status ?? null;
    this.action = meta.action ?? null;
    this.url = meta.url ?? null;
    this.responseBody = meta.responseBody ?? null;
    this.attempts = meta.attempts ?? 0;
  }
}

/** 按错误类型给出排查建议 */
export function troubleshootHint(err) {
  if (!(err instanceof ArkError)) return '';
  if (err.status === 404) {
    return '路径不存在（HTTP 404）：请核对「服务地址」与「服务商标识」。正确入口形如 {服务地址}/{服务商标识}/asset/v1/ark，服务商标识必须是平台分配的原文（不能多斜杠、不能带 /asset 前缀）。';
  }
  if (err.status === 401) return '访问令牌缺失、无效或已过期：请确认令牌以 sk- 开头且属于该通道，保存时留空表示沿用旧值。';
  if (err.status === 400) return '请求参数或资源 ID 被拒绝：错误信息中通常指出了具体字段（如 ProjectName、GroupId）。';
  if (err.kind === 'transient') return '服务端暂时性错误（502/限流/超时/网络异常）：已自动退避重试仍失败，请稍后重试或降低并发与轮询频率。';
  return '';
}

export class ArkClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl    服务地址，如 https://llm.future.jetsentv.com
   * @param {string} opts.vendor     服务商标识（URL 路径段）
   * @param {string} opts.token      访问令牌 sk-xxx
   * @param {string} opts.projectName 项目名
   * @param {object} opts.settings   全局参数（requestRetries/requestTimeoutMs/listPageSize 等）
   */
  constructor({ baseUrl, vendor, token, projectName, settings }) {
    this.baseUrl = String(baseUrl || '').trim().replace(/\/+$/, '');
    this.vendor = String(vendor || '').trim().replace(/^\/+|\/+$/g, '');
    this.token = String(token || '');
    this.projectName = String(projectName || '');
    this.settings = settings;
    if (!/^https?:\/\//.test(this.baseUrl)) throw new ArkError('bad', '服务地址必须以 http:// 或 https:// 开头');
    if (!this.vendor) throw new ArkError('bad', '缺少服务商标识');
    if (!this.token) throw new ArkError('bad', '缺少访问令牌');
  }

  actionUrl(action) {
    return `${this.baseUrl}/${encodeURIComponent(this.vendor)}/asset/v1/ark?Action=${encodeURIComponent(action)}`;
  }

  /** 带退避重试的调用：1s → 2s → 4s … */
  async call(action, body = {}, { retries } = {}) {
    const max = retries ?? this.settings.requestRetries;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.callOnce(action, body);
      } catch (err) {
        const transient = err instanceof ArkError && err.kind === 'transient';
        if (!transient || attempt >= max) {
          if (err instanceof ArkError) {
            err.attempts = attempt + 1;
            if (transient && attempt >= max && attempt > 0) {
              err.message = `${err.message}（已自动重试 ${err.attempts} 次）`;
            }
          }
          throw err;
        }
        await sleep(1000 * 2 ** attempt);
      }
    }
  }

  async callOnce(action, body) {
    const url = this.actionUrl(action);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.settings.requestTimeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body ?? {}),
        signal: ac.signal,
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应按文本处理 */ }
      if (res.ok) return json;
      const msg = extractMessage(json, text, res.status);
      const meta = { status: res.status, action, url, responseBody: text.slice(0, 500) };
      if (res.status === 401) throw new ArkError('auth', `HTTP 401 未授权：${msg}（POST ${url}）`, meta);
      if (res.status === 502 || res.status === 429 || res.status >= 500) {
        throw new ArkError('transient', `HTTP ${res.status}：${msg}（POST ${url}）`, meta);
      }
      throw new ArkError('bad', `HTTP ${res.status}：${msg}（POST ${url}）`, meta);
    } catch (err) {
      if (err instanceof ArkError) throw err;
      const detail = err.name === 'AbortError'
        ? `请求超时（>${this.settings.requestTimeoutMs}ms）`
        : `网络异常：${err.message}`;
      throw new ArkError('transient', `${detail}（POST ${url}）`, { action, url });
    } finally {
      clearTimeout(timer);
    }
  }

  // ── 高层接口（统一注入 ProjectName） ──────────────────────────

  /** 连通性测试：最小代价列一次组 */
  async test() {
    const r = await this.listAssetGroupsPage({ page: 1, pageSize: 1 });
    return { totalGroups: r?.TotalCount ?? null };
  }

  async createAssetGroup({ name, description }) {
    return this.call('CreateAssetGroup', { Name: name, Description: description || '', ProjectName: this.projectName });
  }

  async getAssetGroup(id) {
    return this.call('GetAssetGroup', { Id: id, ProjectName: this.projectName });
  }

  async listAssetGroupsPage({ page = 1, pageSize, name = '', groupIds } = {}) {
    const Filter = { GroupType: 'AIGC' };
    if (name) Filter.Name = name;
    if (groupIds && groupIds.length) Filter.GroupIds = groupIds;
    return this.call('ListAssetGroups', { ProjectName: this.projectName, PageNumber: page, PageSize: pageSize, Filter });
  }

  async listAssetsPage({ page = 1, pageSize, groupId, statuses = [], name = '' } = {}) {
    const Filter = { GroupType: 'AIGC' };
    if (groupId) Filter.GroupIds = [groupId];
    if (statuses.length) Filter.Statuses = statuses;
    if (name) Filter.Name = name;
    return this.call('ListAssets', { ProjectName: this.projectName, PageNumber: page, PageSize: pageSize, Filter });
  }

  /** 全量分页拉取（扫描用） */
  async listAllGroups() {
    return this.listAll(page => this.listAssetGroupsPage({ page, pageSize: this.settings.listPageSize }), r => r?.Groups, r => r?.TotalCount);
  }

  async listAllAssets({ groupId, statuses = [], name = '' } = {}) {
    return this.listAll(page => this.listAssetsPage({ page, pageSize: this.settings.listPageSize, groupId, statuses, name }), r => r?.Assets, r => r?.TotalCount);
  }

  async listAll(fetchPage, pick, totalOf) {
    const out = [];
    for (let page = 1; page <= 500; page++) {
      const res = await fetchPage(page);
      const items = pick(res) || [];
      out.push(...items);
      const total = totalOf(res);
      if (!items.length || (typeof total === 'number' && out.length >= total)) return out;
    }
    throw new ArkError('bad', '列表分页超过 500 页上限，已中止', {});
  }

  async getAsset(id) {
    return this.call('GetAsset', { Id: id, ProjectName: this.projectName });
  }

  async createAsset({ groupId, name, url, assetType }) {
    return this.call('CreateAsset', { GroupId: groupId, Name: name, URL: url, AssetType: assetType, ProjectName: this.projectName });
  }
}

function extractMessage(json, text, status) {
  if (json && json.error !== undefined) {
    if (typeof json.error === 'string') return json.error;
    if (json.error && typeof json.error.message === 'string') return json.error.message;
    return JSON.stringify(json.error);
  }
  if (json && typeof json.message === 'string') return json.message;
  if (json && typeof json.detail === 'string') return json.detail; // FastAPI 风格错误（如 404 {"detail":"Not Found"}）
  return (text || `HTTP ${status}`).slice(0, 300);
}
