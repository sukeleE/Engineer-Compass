// 认证与权限：scrypt 密码 / Bearer token 会话 / 小组上下文与角色权限校验
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import db from '../db/database.js';

// ---- 密码（crypto.scrypt 内置，零依赖） ----
export function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(pw), salt, 64).toString('hex');
  return `${salt}$${hash}`;
}
export function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  return timingSafeEqual(Buffer.from(hash, 'hex'), scryptSync(String(pw), salt, 64));
}

// ---- Bearer token 会话 ----
// 支持 query 的 ?token=（供 <img src> / <a href> 直连预览与下载，浏览器不会带 Authorization 头）
// 封禁（status=1）用户拒绝一切认证请求
const USER_COLS = 's.user_id, u.username, u.nickname, u.is_admin, u.admin_perms, u.is_ghost, u.email, u.avatar, u.status, u.real_name, u.student_no';
export function authRequired(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.token || '';
  if (!token) return res.status(401).json({ error: '未登录' });
  const s = db.prepare(
    `SELECT ${USER_COLS} FROM session s JOIN user u ON u.id = s.user_id WHERE s.token = ?`
  ).get(token);
  if (!s) return res.status(401).json({ error: '登录已失效，请重新登录' });
  if (s.status === 1) return res.status(403).json({ error: '账号已被封禁，无法继续使用' });
  req.user = { id: s.user_id, username: s.username, nickname: s.nickname, is_admin: !!s.is_admin, admin_perms: s.admin_perms || '', is_ghost: !!s.is_ghost, email: s.email || '', avatar: s.avatar || null, status: s.status || 0, real_name: s.real_name || '', student_no: s.student_no || '', token };
  next();
}

// 可选认证：有 token 就解析 req.user，无 token 放行（匿名功能保留）
export function optionalAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return next();
  const s = db.prepare(
    `SELECT ${USER_COLS} FROM session s JOIN user u ON u.id = s.user_id WHERE s.token = ?`
  ).get(token);
  if (s && s.status !== 1) req.user = { id: s.user_id, username: s.username, nickname: s.nickname, is_admin: !!s.is_admin, admin_perms: s.admin_perms || '', is_ghost: !!s.is_ghost, email: s.email || '', avatar: s.avatar || null, status: s.status || 0, real_name: s.real_name || '', student_no: s.student_no || '', token };
  next();
}

// ---- 后台管理 / 封禁禁言 ----

// 全站管理员模块权限：is_admin=1 的用户按授权模块访问后台；admin_perms 为空数组=超级管理员（全权）。
// 散落在业务模块（预约/采购审批、幽灵帖巡检等）的"管理员全权"仅超管拥有，用 isSuperAdmin 判断。
export const ADMIN_PERMS = {
  user: '用户管理',        // 封禁/禁言/用户列表详情/改密与实名提醒
  content: '内容管理',     // 删帖/删评论（含前台越权编辑）
  competition: '竞赛审核', // AI 收录待审核列表/采纳/拒绝
  announce: '公告管理',    // 公告 CRUD/群发提醒
  honor: '荣誉墙',         // 荣誉条目与奖状图管理
  resource: '资源管理',    // 全站用户资源列表/删除/越权下载
  feedback: '用户反馈',    // 反馈列表/删除
  log: '日志审计',         // 操作日志 + 访问记录
  server: '服务器状态',    // 服务器状态面板
  lab: '借用记录',         // 跨项目借用登记记录全局查看/导出（借设备/借教室管理端）
};

// 解析 user.admin_perms（TEXT JSON）；非法值/未知 key 一律忽略，空数组=超管口径
export function parseAdminPerms(v) {
  if (v == null) return [];
  try {
    const a = typeof v === 'string' ? JSON.parse(v || '[]') : v;
    if (!Array.isArray(a)) return [];
    return [...new Set(a.map(String))].filter((k) => k in ADMIN_PERMS);
  } catch { return []; }
}

// 超级管理员：is_admin=1 且未限定模块（现有 is_admin 老用户自动成为超管，完全向后兼容）
export const isSuperAdmin = (u) => !!u?.is_admin && parseAdminPerms(u.admin_perms).length === 0;

// 模块权限判断：非管理员 false；超管全权；受限管理员需显式授权
export const hasAdminPerm = (u, key) => {
  if (!u?.is_admin) return false;
  const perms = parseAdminPerms(u.admin_perms);
  return perms.length === 0 || perms.includes(key);
};

// 仅管理员可访问（需先经过 authRequired）：任意管理员（含受限）即可通过，细粒度用 adminPermRequired
export function adminRequired(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: '需要管理员权限' });
  next();
}

// 仅超级管理员（分配管理员权限、最后超管保护类操作专用；需先经过 authRequired）
export function superAdminRequired(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: '需要管理员权限' });
  if (!isSuperAdmin(req.user)) return res.status(403).json({ error: '需要超级管理员权限' });
  next();
}

// 模块权限守卫工厂：router.get(path, authRequired, adminPermRequired('content'), handler)
// 多个 key 为"任一满足"；超管恒通过。必须挂在 authRequired 之后。
export function adminPermRequired(...keys) {
  const need = keys.flat().filter(Boolean);
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '未登录' });
    if (!req.user.is_admin) return res.status(403).json({ error: '需要管理员权限' });
    if (need.length && !need.some((k) => hasAdminPerm(req.user, k))) {
      return res.status(403).json({ error: `需要「${ADMIN_PERMS[need[0]] || need[0]}」管理权限` });
    }
    next();
  };
}

// 幽灵守卫：仅幽灵模式用户可访问（需先经过 authRequired；怪奇小队名单等幽灵专属接口用）
export function ghostRequired(req, res, next) {
  if (!req.user?.is_ghost) return res.status(403).json({ error: '需要幽灵权限' });
  next();
}

// 禁言守卫：禁言（status=2）用户禁止发言类写操作
export function mutedGuard(req, res, next) {
  if (req.user?.status === 2) return res.status(403).json({ error: '账号已被禁言，暂时无法发言' });
  next();
}

// 实名守卫：未填真实姓名禁止使用预约/报销/采购（管理员也不豁免；必须挂在 authRequired 之后）
export function realNameRequired(req, res, next) {
  if (!req.user?.real_name) {
    return res.status(403).json({ code: 'need_real_name', error: '请先完成实名认证（在账号安全页填写真实姓名）后再使用该功能' });
  }
  next();
}

// 署名组合：有真名且与昵称不同 →「真名（昵称）」；昵称里已包含真名（如昵称本身是「张玉磊（284806020）」）
// 时直接用昵称，避免叠成「张玉磊（张玉磊（284806020））」；否则回退真名/昵称/用户名（快照落库与三模块展示共用）
export const displayNameOf = (u) => {
  const rn = String(u?.real_name || '').trim();
  const nick = String(u?.nickname || u?.username || '').trim();
  if (!rn) return nick;
  // 昵称已包含真名（如「张玉磊（284806020）」）时昵称信息更全，原样用昵称，不再包裹
  if (!nick || rn === nick || nick.includes(rn)) return nick || rn;
  return `${rn}（${nick}）`;
};

// 客户端 IP：反代部署取 x-forwarded-for 第一个（最接近客户端），直连取 req.ip
export function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || String(req.ip || '').replace('::ffff:', '');
}

// 访问日志中间件：记录所有 /api 请求（含游客、认证失败的），health 探活不算噪音
// 挂载在认证中间件之前 → 自己解析 token 取 user_id（游客/无效 token 记 null）
export function accessLog(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.token || '';
    let uid = null, uname = '';
    if (token) {
      const s = db.prepare('SELECT s.user_id, u.username FROM session s JOIN user u ON u.id = s.user_id WHERE s.token = ?').get(token);
      if (s) { uid = s.user_id; uname = s.username; }
    }
    db.prepare('INSERT INTO access_log (user_id, username, ip, method, path) VALUES (?,?,?,?,?)').run(
      uid, uname, clientIp(req), req.method, req.originalUrl || req.url || ''
    );
  } catch { /* 记录失败不影响主流程 */ }
  next();
}

// 审计日志埋点：action 见 audit_log 注释；target 为业务对象名；detail 为可选对象
export function logAudit(req, action, target = '', detail = null) {
  try {
    db.prepare(
      'INSERT INTO audit_log (user_id, username, action, target, detail, ip) VALUES (?,?,?,?,?,?)'
    ).run(
      req.user?.id ?? null,
      req.user?.username || '',
      action,
      String(target || ''),
      detail ? JSON.stringify(detail) : null,
      clientIp(req)
    );
  } catch { /* 审计失败不影响主流程 */ }
}

// ---- 小组上下文：成员行 + 角色 + 权限 ----
export const PERM_KEYS = {
  task: '任务管理', progress: '进度汇报', message: '发消息',
  file_upload: '上传资料', file_delete: '删除资料',
  device: '设备管理', device_approve: '预约审批',
  member: '成员管理', role: '角色管理', team: '小组设置',
};

// 返回 { team, member, roles, role }；member=null 表示非成员；owner 恒全权限
// roles=多角色数组（team_member_role 桥表，最多 3 个）；role=level 最高的角色（兼容旧单角色调用）
export function teamCtx(teamId, userId) {
  const team = db.prepare('SELECT * FROM team WHERE id = ?').get(Number(teamId));
  if (!team) return null;
  const member = db.prepare('SELECT * FROM team_member WHERE team_id = ? AND user_id = ?').get(team.id, userId);
  const roles = db.prepare(
    `SELECT tr.* FROM team_member_role tmr JOIN team_role tr ON tr.id = tmr.role_id
     WHERE tmr.team_id = ? AND tmr.user_id = ? ORDER BY tr.level DESC, tr.id`
  ).all(team.id, userId);
  return { team, member: member || null, roles, role: roles[0] || null, isOwner: team.owner_id === userId };
}

// 权限判断：组长恒有；否则看任意角色 permissions 并集
export function hasPerm(ctx, key) {
  if (!ctx) return false;
  if (ctx.isOwner) return true;
  if (!ctx.member || !ctx.roles?.length) return false;
  try {
    return ctx.roles.some((r) => (JSON.parse(r.permissions || '[]') || []).includes(key));
  } catch { return false; }
}

// 组合校验：非成员 403；无权限 403（带权限名提示）
export function requirePerm(ctx, res, key) {
  if (!ctx) return res.status(404).json({ error: '小组不存在' });
  if (!ctx.member) return res.status(403).json({ error: '不是小组成员' });
  if (!hasPerm(ctx, key)) return res.status(403).json({ error: `无权限：需要「${PERM_KEYS[key] || key}」权限` });
  return null;
}

// 生成小组邀请码
export function genInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[randomBytes(1)[0] % chars.length];
  return code;
}
