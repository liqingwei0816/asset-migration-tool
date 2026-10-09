import crypto from 'node:crypto';
import path from 'node:path';
import { ensureDir, readJson, writeJsonAtomic } from './store.js';

export const DEFAULT_SETTINGS = {
  concurrency: 3,         // 迁移并发数
  pollIntervalMs: 3000,   // GetAsset 轮询间隔
  pollTimeoutMs: 300000,  // 单素材轮询上限（5 分钟）
  requestRetries: 3,      // 502/网络错误退避重试次数（1s→2s→4s…）
  requestTimeoutMs: 15000,
  listPageSize: 100,
  skipExisting: true,     // 目标已存在同名素材时跳过
  scanStallTimeoutMs: 600000, // 扫描阶段停滞看门狗（无进展超时判失败，默认 10 分钟）
};

const SETTINGS_LIMITS = {
  concurrency: [1, 20],
  pollIntervalMs: [250, 60000],
  pollTimeoutMs: [5000, 3600000],
  requestRetries: [0, 10],
  requestTimeoutMs: [1000, 120000],
  listPageSize: [1, 200],
  scanStallTimeoutMs: [60000, 3600000],
};

function nowIso() {
  return new Date().toISOString();
}

function str(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function clampNum(v, [min, max], fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function sanitizeSettings(input, prev) {
  const out = { ...DEFAULT_SETTINGS, ...(prev || {}) };
  for (const key of Object.keys(SETTINGS_LIMITS)) {
    if (input[key] !== undefined) out[key] = clampNum(input[key], SETTINGS_LIMITS[key], out[key]);
  }
  out.skipExisting = input.skipExisting === undefined ? !!out.skipExisting : !!input.skipExisting;
  return out;
}

export class ConfigError extends Error {
  constructor(message, httpStatus = 400) {
    super(message);
    this.httpStatus = httpStatus;
  }
}

function newChannelId() {
  return `ch-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * 配置存储：单通道读写，避免"整表提交被其他通道的校验错误阻塞"。
 * 令牌不回传明文：get() 返回掩码；更新时令牌留空 = 保持原值。
 */
export class ConfigStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'config.json');
    ensureDir(dataDir);
    const loaded = readJson(this.file, null);
    this.data = loaded && typeof loaded === 'object' ? loaded : {};
    this.data.channels = Array.isArray(this.data.channels) ? this.data.channels : [];
    this.data.settings = sanitizeSettings(this.data.settings || {}, null);
  }

  get() {
    return {
      settings: { ...this.data.settings },
      channels: this.data.channels.map(c => ({
        ...c,
        token: '',
        tokenHint: c.token ? `sk-••••${c.token.slice(-4)}` : '（未设置）',
      })),
    };
  }

  /** 校验并归一化单个通道字段；token 缺省时回退 old.token（保持原值） */
  normalizeChannel(raw, old = null) {
    const name = str(raw.name).trim();
    if (!name) throw new ConfigError('通道名称不能为空');
    const label = `通道「${name}」`;
    const baseUrl = str(raw.baseUrl).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(baseUrl)) throw new ConfigError(`${label}的服务地址必须以 http:// 或 https:// 开头`);
    const vendor = str(raw.vendor).trim();
    if (!vendor || /[/?#]/.test(vendor)) throw new ConfigError(`${label}的服务商标识不能为空，且不能包含 / ? #`);
    const projectName = str(raw.projectName).trim();
    if (!projectName) throw new ConfigError(`${label}缺少 ProjectName`);
    const token = str(raw.token).trim() || (old && old.token) || '';
    return { name, baseUrl, vendor, projectName, token };
  }

  addChannel(raw) {
    const v = this.normalizeChannel(raw);
    if (!v.token) throw new ConfigError(`通道「${v.name}」缺少访问令牌（以 sk- 开头，由平台签发）`);
    const ch = { id: newChannelId(), ...v, createdAt: nowIso(), updatedAt: nowIso() };
    this.data.channels.push(ch);
    this.persist();
    return ch;
  }

  updateChannel(id, raw) {
    const idx = this.data.channels.findIndex(c => c.id === id);
    if (idx < 0) throw new ConfigError(`通道不存在或已被删除（${id}），请刷新页面获取最新列表`, 404);
    const old = this.data.channels[idx];
    const v = this.normalizeChannel(raw, old);
    if (!v.token) throw new ConfigError(`通道「${v.name}」缺少访问令牌（以 sk- 开头，由平台签发）`);
    this.data.channels[idx] = { ...old, ...v, id, updatedAt: nowIso() };
    this.persist();
    return this.data.channels[idx];
  }

  removeChannel(id) {
    const idx = this.data.channels.findIndex(c => c.id === id);
    if (idx < 0) throw new ConfigError(`通道不存在或已被删除（${id}）`, 404);
    this.data.channels.splice(idx, 1);
    this.persist();
  }

  updateSettings(input) {
    this.data.settings = sanitizeSettings(input || {}, this.data.settings);
    this.persist();
  }

  persist() {
    writeJsonAtomic(this.file, this.data);
  }
}
