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
const USER_COLS = 's.user_id, u.username, u.nickname, u.is_admin, u.email, u.avatar, u.status';
export function authRequired(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.token || '';
  if (!token) return res.status(401).json({ error: '未登录' });
  const s = db.prepare(
    `SELECT ${USER_COLS} FROM session s JOIN user u ON u.id = s.user_id WHERE s.token = ?`
  ).get(token);
  if (!s) return res.status(401).json({ error: '登录已失效，请重新登录' });
  if (s.status === 1) return res.status(403).json({ error: '账号已被封禁，无法继续使用' });
  req.user = { id: s.user_id, username: s.username, nickname: s.nickname, is_admin: !!s.is_admin, email: s.email || '', avatar: s.avatar || null, status: s.status || 0, token };
  next();
}

// 可选认证：有 token 就解析 req.user，无 token 放行（匿名功能保留）
export function optionalAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return next();
  const s = db.prepare(
    `SELECT ${USER_COLS} FROM session s JOIN user u ON u.id = s.user_id WHERE s.token = ?`
  ).get(token);
  if (s && s.status !== 1) req.user = { id: s.user_id, username: s.username, nickname: s.nickname, is_admin: !!s.is_admin, email: s.email || '', avatar: s.avatar || null, status: s.status || 0, token };
  next();
}

// ---- 后台管理 / 封禁禁言 ----

// 仅管理员可访问（需先经过 authRequired）
export function adminRequired(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: '需要管理员权限' });
  next();
}

// 禁言守卫：禁言（status=2）用户禁止发言类写操作
export function mutedGuard(req, res, next) {
  if (req.user?.status === 2) return res.status(403).json({ error: '账号已被禁言，暂时无法发言' });
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
      String(req.ip || '').replace('::ffff:', '')
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
