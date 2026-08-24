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
export function authRequired(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.token || '';
  if (!token) return res.status(401).json({ error: '未登录' });
  const s = db.prepare(
    'SELECT s.user_id, u.username, u.nickname, u.is_admin FROM session s JOIN user u ON u.id = s.user_id WHERE s.token = ?'
  ).get(token);
  if (!s) return res.status(401).json({ error: '登录已失效，请重新登录' });
  req.user = { id: s.user_id, username: s.username, nickname: s.nickname, is_admin: !!s.is_admin, token };
  next();
}

// 可选认证：有 token 就解析 req.user，无 token 放行（匿名功能保留）
export function optionalAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return next();
  const s = db.prepare(
    'SELECT s.user_id, u.username, u.nickname, u.is_admin FROM session s JOIN user u ON u.id = s.user_id WHERE s.token = ?'
  ).get(token);
  if (s) req.user = { id: s.user_id, username: s.username, nickname: s.nickname, is_admin: !!s.is_admin, token };
  next();
}

// ---- 小组上下文：成员行 + 角色 + 权限 ----
export const PERM_KEYS = {
  task: '任务管理', progress: '进度汇报', message: '发消息',
  file_upload: '上传资料', file_delete: '删除资料',
  device: '设备管理', device_approve: '预约审批',
  member: '成员管理', role: '角色管理', team: '小组设置',
};

// 返回 { team, member, role }；member=null 表示非成员；owner 恒全权限
export function teamCtx(teamId, userId) {
  const team = db.prepare('SELECT * FROM team WHERE id = ?').get(Number(teamId));
  if (!team) return null;
  const member = db.prepare('SELECT * FROM team_member WHERE team_id = ? AND user_id = ?').get(team.id, userId);
  const role = member?.role_id
    ? db.prepare('SELECT * FROM team_role WHERE id = ?').get(member.role_id)
    : null;
  return { team, member: member || null, role: role || null, isOwner: team.owner_id === userId };
}

// 权限判断：组长恒有；否则看角色 permissions JSON
export function hasPerm(ctx, key) {
  if (!ctx) return false;
  if (ctx.isOwner) return true;
  if (!ctx.member || !ctx.role) return false;
  try {
    return (JSON.parse(ctx.role.permissions || '[]') || []).includes(key);
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
