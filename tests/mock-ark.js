/**
 * 模拟素材库：实现《素材库对外接入文档 v1.2》的素材接口语义，
 * 用于端到端测试（无需真实平台与令牌）。
 *
 * - 鉴权：Authorization: Bearer sk-…（其他一律 401）
 * - CreateAsset：校验 URL 可访问（真实 fetch 一次），先返回 Processing，
 *   约 processDelayMs 后转 Active / Failed
 * - 每个 vendor 路径段是一个独立通道，数据相互隔离
 */
import crypto from 'node:crypto';
import express from 'express';

const rid = prefix => `${prefix}-${crypto.randomBytes(3).toString('hex')}`;
const need = (cond, msg) => { if (!cond) { const e = new Error(msg); e.statusCode = 400; throw e; } };

export function createMockArk({ processDelayMs = 200 } = {}) {
  const vendors = new Map(); // vendor → { groups: Map, assets: Map }
  const media = new Map();   // 文件名 → Buffer（模拟公网可访问的素材 URL）
  const tokens = new Set();  // 有效令牌；为空时放行任意 Bearer sk-*
  const vstate = v => {
    if (!vendors.has(v)) vendors.set(v, { groups: new Map(), assets: new Map() });
    return vendors.get(v);
  };

  const app = express();
  app.use(express.json());

  app.get('/files/:name', (req, res) => {
    const v = media.get(req.params.name);
    if (!v) return res.status(404).end('not found');
    // 字符串值 = SVG 图片（演示用真实可渲染媒体）；Buffer = 二进制占位
    if (typeof v === 'string') {
      res.set('Content-Type', 'image/svg+xml; charset=utf-8');
      return res.send(v);
    }
    res.set('Content-Type', 'application/octet-stream');
    res.send(v);
  });

  app.post('/:vendor/asset/v1/ark', async (req, res) => {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const tokenOk = token.startsWith('sk-') && (tokens.size === 0 || tokens.has(token));
    if (!tokenOk) return res.status(401).json({ error: '访问令牌缺失、无效或已过期' });
    const v = vstate(req.params.vendor);
    const Action = req.query.Action;
    const b = req.body || {};
    try {
      switch (Action) {
        case 'CreateAssetGroup': {
          need(b.Name && b.ProjectName, 'parameter Name/ProjectName is required');
          const g = { Id: rid('group'), Name: b.Name, Description: b.Description || '', ProjectName: b.ProjectName, GroupType: 'AIGC' };
          v.groups.set(g.Id, g);
          res.json(g);
          break;
        }
        case 'ListAssetGroups': {
          need(b.Filter && b.Filter.GroupType, 'Filter.GroupType is required');
          let gs = [...v.groups.values()].filter(g => g.ProjectName === b.ProjectName && g.GroupType === b.Filter.GroupType);
          if (b.Filter.GroupIds?.length) gs = gs.filter(g => b.Filter.GroupIds.includes(g.Id));
          if (b.Filter.Name) gs = gs.filter(g => g.Name.includes(b.Filter.Name));
          const pn = b.PageNumber || 1;
          const ps = b.PageSize || 10;
          res.json({ TotalCount: gs.length, PageNumber: pn, PageSize: ps, Groups: gs.slice((pn - 1) * ps, pn * ps) });
          break;
        }
        case 'GetAssetGroup': {
          const g = v.groups.get(b.Id);
          need(g, 'group not found');
          res.json(g);
          break;
        }
        case 'ListAssets': {
          let list = [...v.assets.values()].filter(a => a.ProjectName === b.ProjectName);
          const f = b.Filter || {};
          if (f.GroupIds?.length) list = list.filter(a => f.GroupIds.includes(a.GroupId));
          if (f.Statuses?.length) list = list.filter(a => f.Statuses.includes(a.Status));
          if (f.Name) list = list.filter(a => a.Name.includes(f.Name));
          const pn = b.PageNumber || 1;
          const ps = b.PageSize || 10;
          res.json({ TotalCount: list.length, PageNumber: pn, PageSize: ps, Assets: list.slice((pn - 1) * ps, pn * ps).map(a => ({ ...a, mediaKey: undefined })) });
          break;
        }
        case 'GetAsset': {
          const a = v.assets.get(b.Id);
          need(a, 'asset not found');
          res.json({ ...a, mediaKey: undefined });
          break;
        }
        case 'CreateAsset': {
          need(b.GroupId && b.Name && b.URL && b.AssetType && b.ProjectName, 'parameter GroupId/Name/URL/AssetType/ProjectName is required');
          need(/^https?:\/\//.test(b.URL), 'URL must start with http:// or https://');
          need(b.Name.length <= 64, 'Name too long (max 64)');
          const g = v.groups.get(b.GroupId);
          need(g && g.ProjectName === b.ProjectName, 'GroupId not found in project');
          const a = {
            Id: rid('asset'),
            GroupId: b.GroupId,
            Name: b.Name,
            AssetType: b.AssetType,
            Status: 'Processing',
            URL: b.URL,
            ProjectName: b.ProjectName,
          };
          v.assets.set(a.Id, a);
          // 模拟平台异步处理：真实拉取一次源 URL，成功则 Active，否则 Failed
          setTimeout(async () => {
            try {
              const r = await fetch(b.URL, { headers: { Range: 'bytes=0-0' } });
              a.Status = r.ok ? 'Active' : 'Failed';
            } catch {
              a.Status = 'Failed';
            }
          }, processDelayMs);
          res.json({ Id: a.Id, GroupId: a.GroupId, Name: a.Name, AssetType: a.AssetType, Status: 'Processing', ProjectName: a.ProjectName });
          break;
        }
        case 'UpdateAsset': {
          const a = v.assets.get(b.Id);
          need(a, 'asset not found');
          if (b.Name) a.Name = b.Name;
          res.json({ Id: a.Id, Name: a.Name, Status: a.Status });
          break;
        }
        case 'DeleteAsset': {
          v.assets.delete(b.Id);
          res.json({ Id: b.Id, Success: true });
          break;
        }
        default:
          res.status(400).json({ error: `${Action}: invalid or missing Action` });
      }
    } catch (err) {
      res.status(err.statusCode || 400).json({ error: `${Action}: ${err.message}` });
    }
  });

  return { app, vendors, media, vstate, tokens };
}

/** 便捷造数：注册一个带组的通道 */
export function seedVendor(mock, vendor, projectName) {
  const v = mock.vstate(vendor);
  const addGroup = (id, name, description = '') => {
    const g = { Id: id, Name: name, Description: description, ProjectName: projectName, GroupType: 'AIGC' };
    v.groups.set(id, g);
    return g;
  };
  const addAsset = (id, groupId, name, assetType, status, mediaName) => {
    const a = {
      Id: id,
      GroupId: groupId,
      Name: name,
      AssetType: assetType,
      Status: status,
      URL: mediaName ? `${mock.baseUrl}/files/${mediaName}` : '',
      ProjectName: projectName,
    };
    v.assets.set(id, a);
    return a;
  };
  return { addGroup, addAsset };
}
