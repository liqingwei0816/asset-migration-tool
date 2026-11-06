import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

// 原子写入：先写临时文件再改名，避免进程中断留下半截 JSON
// Windows 下改名目标可能被杀毒/同步软件（如 OneDrive 扫描 Desktop）短暂锁定，
// rename 报 EPERM/EACCES/EBUSY，短退避重试即可恢复；仍失败则抛给调用方兜底
const RETRYABLE_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRIES = 5;

export function writeJsonAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (!RETRYABLE_RENAME.has(err.code) || attempt >= RENAME_RETRIES) {
        try { fs.unlinkSync(tmp); } catch { /* 清理失败不掩盖原始错误 */ }
        throw err;
      }
      const deadline = Date.now() + 50 * 2 ** attempt; // 50→100→200→400→800ms，共约 1.5s
      while (Date.now() < deadline) { /* 同步退避：本模块为同步实现，且此路径极少触发 */ }
    }
  }
}
