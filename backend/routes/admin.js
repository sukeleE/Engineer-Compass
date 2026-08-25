// 后台管理接口（挂载 /api/admin）：用户管理 / 操作日志 / 公告 / 服务器状态
// 全部接口先 authRequired 再 adminRequired（仅管理员可访问）
import { Router } from 'express';
import os from 'node:os';
import { statfsSync, statSync } from 'node:fs';
import db, { DB_PATH } from '../db/database.js';
import { authRequired, adminRequired, logAudit } from './middleware.js';

const r = Router();
r.use(authRequired);
r.use(adminRequired);

const safeUser = (u) => u && ({
  id: u.id, username: u.username, nickname: u.nickname, is_admin: !!u.is_admin,
  email: u.email || '', avatar: u.avatar || null, status: u.status || 0, create_time: u.create_time || null,
});

// GET /api/admin/users?page&size&q — 用户列表（q 模糊搜昵称/邮箱/用户名）
r.get('/users', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(100, Math.max(1, Number(req.query.size) || 20));
  const q = String(req.query.q || '').trim();
  const where = q ? 'WHERE nickname LIKE ? OR email LIKE ? OR username LIKE ?' : '';
  const like = `%${q}%`;
  const params = q ? [like, like, like] : [];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM user ${where}`).get(...params).n;
  const list = db.prepare(
    `SELECT id, username, nickname, is_admin, email, avatar, status, create_time
     FROM user ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...params, size, (page - 1) * size).map(safeUser);
  res.json({ total, page, size, list });
});

// PUT /api/admin/users/:id/status — 封禁(1)/禁言(2)/解封(0)；不可操作自己，管理员不可被封
r.put('/users/:id/status', (req, res) => {
  const id = Number(req.params.id);
  const status = Number(req.body?.status);
  if (![0, 1, 2].includes(status)) return res.status(400).json({ error: 'status 仅支持 0 正常 / 1 封禁 / 2 禁言' });
  if (id === req.user.id) return res.status(400).json({ error: '不能操作自己的账号' });
  const u = db.prepare('SELECT id, username, nickname, is_admin, status FROM user WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (u.is_admin && status !== 0) return res.status(400).json({ error: '管理员账号不可封禁/禁言' });
  db.prepare('UPDATE user SET status = ? WHERE id = ?').run(status, id);
  const label = { 0: '解除限制', 1: '封禁', 2: '禁言' }[status];
  logAudit(req, 'user-status', u.nickname || u.username, { target_id: id, status, from: u.status || 0, label });
  res.json({ message: `已将 ${u.nickname || u.username} ${label}` });
});

// GET /api/admin/logs?page&size&userId&action&q — 操作日志（q 模糊搜 target/username）
r.get('/logs', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(200, Math.max(1, Number(req.query.size) || 20));
  const conds = [], params = [];
  if (Number(req.query.userId)) { conds.push('a.user_id = ?'); params.push(Number(req.query.userId)); }
  if (req.query.action) { conds.push('a.action = ?'); params.push(String(req.query.action)); }
  const q = String(req.query.q || '').trim();
  if (q) { conds.push('(a.target LIKE ? OR a.username LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log a ${where}`).get(...params).n;
  const list = db.prepare(
    `SELECT a.*, u.nickname AS user_nickname
     FROM audit_log a LEFT JOIN user u ON u.id = a.user_id
     ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`
  ).all(...params, size, (page - 1) * size).map((row) => {
    let detail = null;
    try { detail = row.detail ? JSON.parse(row.detail) : null; } catch { detail = row.detail; }
    return { ...row, detail };
  });
  res.json({ total, page, size, list });
});

// ---- 公告管理 ----
r.get('/announcements', (req, res) => {
  res.json(db.prepare(
    `SELECT a.*, u.username AS admin_name FROM announcement a
     LEFT JOIN user u ON u.id = a.admin_id ORDER BY a.pinned DESC, a.id DESC`
  ).all());
});

r.post('/announcements', (req, res) => {
  const title = String(req.body?.title || '').trim();
  const content = String(req.body?.content || '').trim();
  if (!title || title.length > 60) return res.status(400).json({ error: '公告标题必填（≤60 字）' });
  if (!content) return res.status(400).json({ error: '公告内容必填' });
  const pinned = req.body?.pinned ? 1 : 0;
  const info = db.prepare('INSERT INTO announcement (title, content, pinned, admin_id) VALUES (?,?,?,?)')
    .run(title, content, pinned, req.user.id);
  logAudit(req, 'announce-create', title, { id: Number(info.lastInsertRowid), pinned });
  res.status(201).json({ id: Number(info.lastInsertRowid), message: '公告已发布' });
});

r.put('/announcements/:id', (req, res) => {
  const id = Number(req.params.id);
  const a = db.prepare('SELECT * FROM announcement WHERE id = ?').get(id);
  if (!a) return res.status(404).json({ error: '公告不存在' });
  const title = req.body?.title !== undefined ? String(req.body.title).trim() : a.title;
  const content = req.body?.content !== undefined ? String(req.body.content).trim() : a.content;
  const pinned = req.body?.pinned !== undefined ? (req.body.pinned ? 1 : 0) : a.pinned;
  if (!title) return res.status(400).json({ error: '公告标题不能为空' });
  db.prepare('UPDATE announcement SET title = ?, content = ?, pinned = ? WHERE id = ?')
    .run(title, content, pinned, id);
  logAudit(req, 'announce-update', title, { id, pinned });
  res.json({ message: '公告已更新' });
});

r.delete('/announcements/:id', (req, res) => {
  const id = Number(req.params.id);
  const a = db.prepare('SELECT * FROM announcement WHERE id = ?').get(id);
  if (!a) return res.status(404).json({ error: '公告不存在' });
  db.prepare('DELETE FROM announcement WHERE id = ?').run(id);
  logAudit(req, 'announce-delete', a.title, { id });
  res.json({ message: '公告已删除' });
});

// GET /api/admin/server-status — 服务器状态 + 基础统计
r.get('/server-status', (req, res) => {
  let disk = null;
  try {
    const s = statfsSync(DB_PATH);
    disk = { total: s.blocks * s.bsize, free: s.bfree * s.bsize };
  } catch { /* Windows 部分环境不支持 statfs，跳过磁盘 */ }
  let dbSize = 0;
  try { dbSize = statSync(DB_PATH).size; } catch { /* 无文件时不显示 */ }
  const count = (sql, ...p) => db.prepare(sql).get(...p).n;
  res.json({
    time: new Date().toISOString(),
    platform: `${os.type()} ${os.release()}`, arch: os.arch(), node: process.version,
    uptime: os.uptime(), cpus: os.cpus().length, loadavg: os.loadavg(),
    totalmem: os.totalmem(), freemem: os.freemem(), memRss: process.memoryUsage().rss,
    disk, dbSize,
    counts: {
      users: count('SELECT COUNT(*) AS n FROM user'),
      posts: count('SELECT COUNT(*) AS n FROM share_post'),
      teams: count('SELECT COUNT(*) AS n FROM team'),
      todayLogins: count(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'login' AND date(create_time) = date('now','localtime')`),
    },
  });
});

// ---- 内容管理：帖子（评论/点赞/收藏/通知随 share_post 外键 ON DELETE CASCADE 级联清理）----
// GET /api/admin/posts?page&size&q&userId — 帖子列表（标题/作者模糊搜，附评论点赞计数）
r.get('/posts', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(100, Math.max(1, Number(req.query.size) || 20));
  const conds = [], params = [];
  const q = String(req.query.q || '').trim();
  if (q) { conds.push('(p.title LIKE ? OR u.nickname LIKE ? OR u.username LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (Number(req.query.userId)) { conds.push('p.user_id = ?'); params.push(Number(req.query.userId)); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM share_post p LEFT JOIN user u ON u.id = p.user_id ${where}`).get(...params).n;
  const list = db.prepare(
    `SELECT p.id, p.title, p.user_id, p.create_time,
            u.nickname, u.username, u.status AS user_status,
            (SELECT COUNT(*) FROM share_comment c WHERE c.post_id = p.id) AS comment_count,
            (SELECT COUNT(*) FROM share_like l WHERE l.post_id = p.id) AS like_count
     FROM share_post p LEFT JOIN user u ON u.id = p.user_id
     ${where} ORDER BY p.id DESC LIMIT ? OFFSET ?`
  ).all(...params, size, (page - 1) * size);
  res.json({ total, page, size, list });
});

// DELETE /api/admin/posts/:id — 删帖（评论/点赞/收藏/通知全部级联清理）
r.delete('/posts/:id', (req, res) => {
  const id = Number(req.params.id);
  const p = db.prepare('SELECT id, title FROM share_post WHERE id = ?').get(id);
  if (!p) return res.status(404).json({ error: '帖子不存在' });
  db.prepare('DELETE FROM share_post WHERE id = ?').run(id);
  logAudit(req, 'post-delete', p.title, { post_id: id });
  res.json({ message: `帖子「${p.title}」已删除（评论/点赞/收藏/通知已级联清理）` });
});

// GET /api/admin/comments?page&size&postId&q — 评论列表（可按帖子/内容搜）
r.get('/comments', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(200, Math.max(1, Number(req.query.size) || 20));
  const conds = [], params = [];
  if (Number(req.query.postId)) { conds.push('c.post_id = ?'); params.push(Number(req.query.postId)); }
  const q = String(req.query.q || '').trim();
  if (q) { conds.push('(c.content LIKE ? OR u.nickname LIKE ? OR u.username LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM share_comment c ${where}`).get(...params).n;
  const list = db.prepare(
    `SELECT c.id, c.post_id, c.content, c.create_time, c.user_id,
            u.nickname, u.username, p.title AS post_title
     FROM share_comment c
     LEFT JOIN user u ON u.id = c.user_id
     LEFT JOIN share_post p ON p.id = c.post_id
     ${where} ORDER BY c.id DESC LIMIT ? OFFSET ?`
  ).all(...params, size, (page - 1) * size);
  res.json({ total, page, size, list });
});

// DELETE /api/admin/comments/:id — 删评论（同时清 notification 表关联项）
r.delete('/comments/:id', (req, res) => {
  const id = Number(req.params.id);
  const c = db.prepare('SELECT id, content, post_id FROM share_comment WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ error: '评论不存在' });
  db.prepare('DELETE FROM share_comment WHERE id = ?').run(id);
  db.prepare('DELETE FROM notification WHERE comment_id = ?').run(id);
  logAudit(req, 'comment-delete', String(c.content || '').slice(0, 30), { comment_id: id, post_id: c.post_id });
  res.json({ message: '评论已删除' });
});

// GET /api/admin/users/:id/detail — 用户详情：基本信息 + 内容统计 + 最近 20 条操作日志
r.get('/users/:id/detail', (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM user WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const count = (sql, ...p) => db.prepare(sql).get(...p).n;
  const stats = {
    posts: count('SELECT COUNT(*) AS n FROM share_post WHERE user_id = ?', id),
    comments: count('SELECT COUNT(*) AS n FROM share_comment WHERE user_id = ?', id),
    teams: count('SELECT COUNT(*) AS n FROM team_member WHERE user_id = ?', id),
  };
  const logs = db.prepare(
    `SELECT id, action, target, detail, ip, create_time FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT 20`
  ).all(id).map((row) => {
    try { row.detail = row.detail ? JSON.parse(row.detail) : null; } catch { row.detail = null; }
    return row;
  });
  res.json({ user: safeUser(u), stats, logs });
});

// PUT /api/admin/users/:id/role {is_admin} — 设为/取消管理员；禁止操作自己
r.put('/users/:id/role', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: '不能修改自己的管理员身份' });
  const is_admin = req.body?.is_admin ? 1 : 0;
  const u = db.prepare('SELECT id, username, nickname, is_admin, status FROM user WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (is_admin === 1 && u.status !== 0) return res.status(400).json({ error: '请先解除封禁/禁言再设为管理员' });
  db.prepare('UPDATE user SET is_admin = ? WHERE id = ?').run(is_admin, id);
  logAudit(req, 'user-role', u.nickname || u.username, { target_id: id, is_admin: !!is_admin, from: !!u.is_admin });
  res.json({ message: is_admin ? `已将 ${u.nickname || u.username} 设为管理员` : `已取消 ${u.nickname || u.username} 的管理员身份` });
});

export default r;

// ---- 前台公告（public，挂 /api/announcements）：App.vue 全局顶部横幅用 ----
export const publicAnnounce = Router();
publicAnnounce.get('/latest', (req, res) => {
  res.json(db.prepare('SELECT * FROM announcement ORDER BY pinned DESC, id DESC LIMIT 1').get() || null);
});
