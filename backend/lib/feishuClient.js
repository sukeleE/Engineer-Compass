// 飞书 OpenAPI 客户端（方案三：OpenAPI 实现网站 ↔ 飞书文档双向互传）
// 安全约束：App Secret / 各类 access_token 只存服务端（.env / SQLite），绝不返回前端、不硬编码
// token 管理：tenant_access_token 内存缓存（2h）；user_access_token 落 feishu_bind 表（重启不丢），过期自动 refresh
import db from '../db/database.js';

export const FEISHU = 'https://open.feishu.cn';
export const appId = () => process.env.FEISHU_APP_ID || '';
export const appSecret = () => process.env.FEISHU_APP_SECRET || '';
export const configured = () => !!(appId() && appSecret());
export const parentFolder = () => process.env.FEISHU_PARENT_FOLDER_TOKEN || '';

// ---------- 统一请求封装 ----------
// 返回 { status, ok: http 成功且 code===0, data: 完整响应 JSON }；raw=true 返回原始 Response（下载流）
export async function feishu(path, { method = 'GET', token, body, headers = {}, raw = false } = {}) {
  const res = await fetch(FEISHU + path, {
    method,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  if (raw) return res;
  let json = {};
  try { json = await res.json(); } catch { /* 非 JSON 响应 */ }
  return { status: res.status, ok: res.ok && json.code === 0, data: json };
}

// 飞书错误 → Error（带 code），供统一抛出
export function feishuError(data, fallback = '飞书接口调用失败') {
  return Object.assign(new Error(`${data.msg || data.error || fallback}（code=${data.code ?? ''}）`), { code: data.code });
}

// ---------- tenant_access_token（应用身份，2h 缓存，并发去重） ----------
let tenant = null, tenantExp = 0, tenantFetch = null;
export async function tenantToken() {
  if (tenant && tenantExp > Date.now()) return tenant;
  if (!tenantFetch) {
    tenantFetch = (async () => {
      const { ok, data } = await feishu('/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST', body: { app_id: appId(), app_secret: appSecret() },
      });
      if (!ok) throw feishuError(data, 'tenant_access_token 获取失败');
      tenant = data.tenant_access_token;
      tenantExp = Date.now() + (data.expire || 7200) * 1000;
      return tenant;
    })().finally(() => { tenantFetch = null; });
  }
  return tenantFetch;
}

// ---------- user_access_token（OAuth 用户身份，按 user_id 落库持久化） ----------
// feishu_bind 主键 = user_id：每个网页账号独立绑定飞书；同一 open_id 可对应多行（一飞书账号绑多账号）
// token 只存服务端库，绝不返回前端；重启不丢，过期自动 refresh（并发只刷一次）

export function getBind(userId) {
  if (userId === undefined || userId === null) return null;
  return db.prepare('SELECT * FROM feishu_bind WHERE user_id = ?').get(String(userId)) || null;
}

// 过期自动 refresh；refresh_token 也失效 → 只清该用户绑定
let refreshInflight = new Map();
export async function userToken(userId) {
  const b = getBind(userId);
  if (!b || !b.access_token) return null;
  if (b.access_exp > Date.now()) return b.access_token;
  if (!b.refresh_token) return null;
  const key = String(userId);
  if (!refreshInflight.has(key)) {
    refreshInflight.set(key, (async () => {
      try {
        const appTok = await tenantToken(); // app_access_token 同源可用；刷新接口要求 app_access_token
        const { ok, data } = await feishu('/open-apis/authen/v1/oidc/refresh_access_token', {
          method: 'POST',
          body: { grant_type: 'refresh_token', refresh_token: b.refresh_token, app_access_token: appTok },
        });
        if (!ok) throw feishuError(data, 'token 刷新失败');
        const d = data.data || {};
        saveBind(userId, {
          access_token: d.access_token, refresh_token: d.refresh_token || b.refresh_token,
          access_exp: Date.now() + (d.expires_in || 6900) * 1000,
          refresh_exp: d.refresh_token_expires_in ? Date.now() + d.refresh_token_expires_in * 1000 : b.refresh_exp,
        });
        return d.access_token;
      } catch (e) {
        // refresh_token 也已失效 → 清该用户绑定，要求重新授权
        unbind(userId);
        console.log(`[feishu] user ${key} token 刷新失败，已清除绑定：`, e.message);
        return null;
      } finally { refreshInflight.delete(key); }
    })());
  }
  return refreshInflight.get(key);
}

// 写入绑定（不覆盖的字段保留原值）；TEXT 列一律 String()（node:sqlite 数字绑定不匹配 TEXT 列）
export function saveBind(userId, row) {
  if (userId === undefined || userId === null) return;
  const uid = String(userId);
  const old = getBind(userId) || {};
  db.prepare(`INSERT INTO feishu_bind (user_id, open_id, user_name, avatar_url, access_token, refresh_token, access_exp, refresh_exp, update_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
    ON CONFLICT(user_id) DO UPDATE SET
      open_id = COALESCE(excluded.open_id, feishu_bind.open_id),
      user_name = COALESCE(excluded.user_name, feishu_bind.user_name),
      avatar_url = COALESCE(excluded.avatar_url, feishu_bind.avatar_url),
      access_token = COALESCE(excluded.access_token, feishu_bind.access_token),
      refresh_token = COALESCE(excluded.refresh_token, feishu_bind.refresh_token),
      access_exp = COALESCE(excluded.access_exp, feishu_bind.access_exp),
      refresh_exp = COALESCE(excluded.refresh_exp, feishu_bind.refresh_exp),
      update_time = datetime('now','localtime')`)
    .run(
      uid,
      String(row.open_id ?? old.open_id ?? ''), String(row.user_name ?? old.user_name ?? ''),
      String(row.avatar_url ?? old.avatar_url ?? ''), String(row.access_token ?? old.access_token ?? ''),
      String(row.refresh_token ?? old.refresh_token ?? ''), Number(row.access_exp ?? old.access_exp ?? 0),
      Number(row.refresh_exp ?? old.refresh_exp ?? 0)
    );
}

export function unbind(userId) {
  if (userId === undefined || userId === null) return;
  db.prepare('DELETE FROM feishu_bind WHERE user_id = ?').run(String(userId));
}

// 绑定状态（脱敏给前端：不回显任何 token）
export function bindStatus(userId) {
  const b = getBind(userId);
  if (!b || !b.access_token) return { bound: false };
  return {
    bound: true,
    open_id: b.open_id || null,
    user_name: b.user_name || null,
    avatar_url: b.avatar_url || null,
    expires_in: Math.max(0, Math.round((b.access_exp - Date.now()) / 1000)),
  };
}

// ---------- open_id ----------
// user_access_token 是 JWT（eyJ…）：oidc 响应不含 open_id，从 token payload 解
export function openIdFromToken(tok) {
  try {
    const p = String(tok).split('.')[1];
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf-8'));
    return claims.open_id || claims.openid || claims.sub || null;
  } catch { return null; }
}

// 兜底：users/me 拿当前授权用户 open_id（需 contact:user.base:readonly 权限）
export async function fetchOpenId(tok) {
  const { ok, data } = await feishu('/open-apis/contact/v3/users/me?user_id_type=open_id', { token: tok });
  return ok ? data.data?.user?.open_id || null : null;
}

// ---------- 工具 ----------
// 解析飞书链接 → { kind, token }；不支持返回 null
export function parseFeishuUrl(url) {
  const m = String(url || '').match(/feishu\.cn\/(docx|docs|sheet|wiki|file|wikis)\/([A-Za-z0-9]+)/);
  return m ? { kind: m[1] === 'wikis' ? 'wiki' : m[1], token: m[2] } : null;
}

// wiki 节点解析：node_token → { obj_token, obj_type, title }（wiki 链接转真实文档）
export async function wikiNode(token, userTok) {
  const { ok, data } = await feishu(`/open-apis/wiki/v2/spaces/get_node?obj_type=wiki&token=${token}`, { token: userTok });
  if (!ok) throw feishuError(data, 'wiki 节点解析失败');
  return data.data?.node || null;
}

// 当前授权用户信息（绑定回调展示 / 补 open_id）
// 新版 user_access_token 是不透明串（非 JWT），解码失效 → 优先 authen/v1/user_info（仅需授权本身，无需 contact 权限）
export async function meInfo(tok) {
  const r = await feishu('/open-apis/authen/v1/user_info', { token: tok });
  if (r.ok) {
    const u = r.data.data || {};
    return { open_id: u.open_id || '', user_name: u.name || u.en_name || '', avatar_url: u.avatar_url || u.avatar_middle || '' };
  }
  // 兜底：users/me（需 contact:user.base:readonly 权限）
  const { ok, data } = await feishu('/open-apis/contact/v3/users/me?user_id_type=open_id', { token: tok });
  const u2 = ok ? data.data?.user : null;
  return { open_id: u2?.open_id || '', user_name: u2?.name || '', avatar_url: u2?.avatar?.avatar_url || '' };
}
