// 好友与私聊：好友搜索/申请/接受/拒绝/删除、私信（轮询拉取，无 WebSocket）
// 好友关系存双向行（friend 表 A-B 与 B-A 各一行）；申请记录保留在 friend_request（status 流转）
import { Router } from 'express';
import db from '../db/database.js';
import { authRequired, logAudit, mutedGuard } from './middleware.js';

const r = Router();
const uid = (req) => Number(req.user.id);

// GET /api/friends — 好友列表（含未读私信数 + 最近一条消息预览，按最近消息排序）
r.get('/', authRequired, (req, res) => {
  const me = uid(req);
  const rows = db.prepare(
    `SELECT u.id, u.nickname, u.username, u.avatar, f.create_time AS friend_since,
            (SELECT COUNT(*) FROM dm_message m WHERE m.from_id = u.id AND m.to_id = ? AND m.is_read = 0) AS unread,
            (SELECT m.content FROM dm_message m
              WHERE (m.from_id = ? AND m.to_id = u.id) OR (m.from_id = u.id AND m.to_id = ?)
              ORDER BY m.id DESC LIMIT 1) AS last_msg,
            (SELECT m.create_time FROM dm_message m
              WHERE (m.from_id = ? AND m.to_id = u.id) OR (m.from_id = u.id AND m.to_id = ?)
              ORDER BY m.id DESC LIMIT 1) AS last_time
     FROM friend f JOIN user u ON u.id = f.friend_id
     WHERE f.user_id = ?
     ORDER BY last_time DESC, u.id`
  ).all(me, me, me, me, me, me);
  res.json(rows);
});

// GET /api/friends/requests — 收到的（待处理）与发出的（等待对方）申请
r.get('/requests', authRequired, (req, res) => {
  const me = uid(req);
  const incoming = db.prepare(
    `SELECT fr.id, fr.create_time, u.id AS user_id, u.nickname, u.username, u.avatar
     FROM friend_request fr JOIN user u ON u.id = fr.from_id
     WHERE fr.to_id = ? AND fr.status = 'pending' ORDER BY fr.id DESC`
  ).all(me);
  const outgoing = db.prepare(
    `SELECT fr.id, fr.create_time, u.id AS user_id, u.nickname, u.username, u.avatar
     FROM friend_request fr JOIN user u ON u.id = fr.to_id
     WHERE fr.from_id = ? AND fr.status = 'pending' ORDER BY fr.id DESC`
  ).all(me);
  res.json({ incoming, outgoing });
});

// GET /api/friends/search?q= — 用户搜索（用户名/昵称模糊，排除自己）
r.get('/search', authRequired, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  const like = `%${q}%`;
  const rows = db.prepare(
    `SELECT id, username, nickname, avatar FROM user
     WHERE id != ? AND (username LIKE ? OR nickname LIKE ?) ORDER BY id LIMIT 10`
  ).all(uid(req), like, like);
  res.json(rows);
});

// POST /api/friends/request — 发送好友申请（重复申请返回提示；对方已申请过则直接互为好友）
r.post('/request', authRequired, (req, res) => {
  const me = uid(req);
  const toId = Number(req.body?.to_id);
  if (!Number.isInteger(toId) || toId <= 0) return res.status(400).json({ error: '目标用户非法' });
  if (toId === me) return res.status(400).json({ error: '不能添加自己为好友' });
  const target = db.prepare('SELECT id FROM user WHERE id = ?').get(toId);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  if (db.prepare('SELECT 1 FROM friend WHERE user_id = ? AND friend_id = ?').get(me, toId)) {
    return res.status(400).json({ error: '已经是好友了' });
  }

  // 对方已向我发出过申请 → 直接接受，互为好友
  const reverse = db.prepare(`SELECT * FROM friend_request WHERE from_id = ? AND to_id = ? AND status = 'pending'`).get(toId, me);
  if (reverse) {
    db.prepare(`UPDATE friend_request SET status = 'accepted', update_time = CURRENT_TIMESTAMP WHERE id = ?`).run(reverse.id);
    db.prepare('INSERT OR IGNORE INTO friend (user_id, friend_id) VALUES (?, ?)').run(me, toId);
    db.prepare('INSERT OR IGNORE INTO friend (user_id, friend_id) VALUES (?, ?)').run(toId, me);
    logAudit(req, 'friend-accept', `user#${toId}`, { auto: true });
    return res.json({ id: reverse.id, message: '对方已申请过你，已自动成为好友' });
  }

  const exists = db.prepare('SELECT * FROM friend_request WHERE from_id = ? AND to_id = ?').get(me, toId);
  if (exists) {
    if (exists.status === 'accepted') return res.status(400).json({ error: '已经是好友了' });
    if (exists.status === 'pending') return res.status(400).json({ error: '已发送过申请，等待对方处理' });
    db.prepare(`UPDATE friend_request SET status = 'pending', update_time = CURRENT_TIMESTAMP WHERE id = ?`).run(exists.id); // 被拒后重发
    logAudit(req, 'friend-request', `user#${toId}`, { resent: true });
    return res.json({ id: exists.id, message: '申请已重新发送' });
  }
  const info = db.prepare('INSERT INTO friend_request (from_id, to_id, status) VALUES (?, ?, ?)').run(me, toId, 'pending');
  logAudit(req, 'friend-request', `user#${toId}`);
  res.json({ id: Number(info.lastInsertRowid), message: '好友申请已发送' });
});

// POST /api/friends/request/:id/accept — 接受申请（写双向好友行）
r.post('/request/:id/accept', authRequired, (req, res) => {
  const me = uid(req);
  const fr = db.prepare('SELECT * FROM friend_request WHERE id = ? AND to_id = ?').get(Number(req.params.id), me);
  if (!fr) return res.status(404).json({ error: '申请不存在' });
  if (fr.status === 'accepted') return res.json({ message: '已是好友' });
  if (fr.status === 'rejected') return res.status(400).json({ error: '申请已拒绝' });
  db.prepare(`UPDATE friend_request SET status = 'accepted', update_time = CURRENT_TIMESTAMP WHERE id = ?`).run(fr.id);
  db.prepare('INSERT OR IGNORE INTO friend (user_id, friend_id) VALUES (?, ?)').run(fr.from_id, fr.to_id);
  db.prepare('INSERT OR IGNORE INTO friend (user_id, friend_id) VALUES (?, ?)').run(fr.to_id, fr.from_id);
  logAudit(req, 'friend-accept', `user#${fr.from_id}`);
  res.json({ message: '已添加好友' });
});

// POST /api/friends/request/:id/reject — 拒绝申请
r.post('/request/:id/reject', authRequired, (req, res) => {
  const me = uid(req);
  const fr = db.prepare('SELECT * FROM friend_request WHERE id = ? AND to_id = ?').get(Number(req.params.id), me);
  if (!fr) return res.status(404).json({ error: '申请不存在' });
  db.prepare(`UPDATE friend_request SET status = 'rejected', update_time = CURRENT_TIMESTAMP WHERE id = ?`).run(fr.id);
  logAudit(req, 'friend-reject', `user#${fr.from_id}`);
  res.json({ message: '已拒绝' });
});

// DELETE /api/friends/:friendId — 删除好友（双向行一起删）
r.delete('/:friendId', authRequired, (req, res) => {
  const me = uid(req);
  const fid = Number(req.params.friendId);
  if (!db.prepare('SELECT 1 FROM friend WHERE user_id = ? AND friend_id = ?').get(me, fid)) {
    return res.status(404).json({ error: '不是好友' });
  }
  db.prepare('DELETE FROM friend WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)').run(me, fid, fid, me);
  res.json({ message: '已删除好友' });
});

// GET /api/friends/dm/:uid — 与某用户的私信（升序最多 100 条）；对方发来的顺带标记已读（轮询一次往返）
r.get('/dm/:uid', authRequired, (req, res) => {
  const me = uid(req);
  const other = Number(req.params.uid);
  const rows = db.prepare(
    `SELECT id, from_id, to_id, content, is_read, create_time FROM dm_message
     WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)
     ORDER BY id DESC LIMIT 100`
  ).all(me, other, other, me).reverse();
  db.prepare('UPDATE dm_message SET is_read = 1 WHERE from_id = ? AND to_id = ? AND is_read = 0').run(other, me);
  res.json(rows);
});

// POST /api/friends/dm/:uid — 发送私信（1-2000 字）
r.post('/dm/:uid', authRequired, mutedGuard, (req, res) => {
  const content = String(req.body?.content || '').trim();
  if (!content || content.length > 2000) return res.status(400).json({ error: '私信 1-2000 字' });
  const me = uid(req);
  const other = Number(req.params.uid);
  if (!db.prepare('SELECT id FROM user WHERE id = ?').get(other)) return res.status(404).json({ error: '用户不存在' });
  const info = db.prepare('INSERT INTO dm_message (from_id, to_id, content) VALUES (?, ?, ?)').run(me, other, content);
  const m = db.prepare('SELECT id, from_id, to_id, content, is_read, create_time FROM dm_message WHERE id = ?')
    .get(Number(info.lastInsertRowid));
  logAudit(req, 'dm-send', `user#${other}`);
  res.json(m);
});

// POST /api/friends/dm/:uid/read — 标记对方发来的私信已读（弹窗打开时调用）
r.post('/dm/:uid/read', authRequired, (req, res) => {
  const me = uid(req);
  const other = Number(req.params.uid);
  db.prepare('UPDATE dm_message SET is_read = 1 WHERE from_id = ? AND to_id = ? AND is_read = 0').run(other, me);
  res.json({ message: 'ok' });
});

export default r;
