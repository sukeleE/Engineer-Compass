// 消息中心：评论/点赞/收藏通知（私信未读沿用 dm_message.is_read，见 friends.js）
// 三组列表 + 未读计数（含私信）+ 批量标已读
import { Router } from 'express';
import db from '../db/database.js';
import { authRequired } from './middleware.js';
import { unreadSnapshot } from '../lib/notificationCounts.js';
import { publishUnread } from '../lib/realtime.js';

const r = Router();
const TYPES = ['comment', 'like', 'fav'];

const uid = (req) => (req.user ? Number(req.user.id) : null);

// 单组通知列表（按时间倒序，最多 50 条；评论内容 LEFT JOIN——评论被删后 content 为 null）
function groupRows(type, me) {
  return db.prepare(
    `SELECT n.id, n.type, n.is_read, n.create_time,
            n.actor_id, u.nickname, u.avatar,
            n.post_id, p.title,
            c.content
     FROM notification n
     JOIN user u ON u.id = n.actor_id
     JOIN share_post p ON p.id = n.post_id
     LEFT JOIN share_comment c ON c.id = n.comment_id
     WHERE n.user_id = ? AND n.type = ?
     ORDER BY n.id DESC LIMIT 50`
  ).all(me, type).map((row) => ({
    id: Number(row.id),
    type: row.type,
    is_read: Number(row.is_read),
    create_time: row.create_time,
    actor: { id: Number(row.actor_id), nickname: row.nickname, avatar: row.avatar },
    post: { id: Number(row.post_id), title: row.title },
    content: row.content,
  }));
}

// GET /api/notifications — 三组通知列表
r.get('/', authRequired, (req, res) => {
  const me = uid(req);
  res.json({
    comments: groupRows('comment', me),
    likes: groupRows('like', me),
    favs: groupRows('fav', me),
  });
});

// GET /api/notifications/unread-count — 红点数字（通知三组 + 私信未读 + 个人公告）
r.get('/unread-count', authRequired, (req, res) => {
  const me = uid(req);
  res.set('Cache-Control', 'no-store');
  res.json(unreadSnapshot(db, me));
});

// GET /api/notifications/personal — 个人公告/系统通知（最新 30 条）
r.get('/personal', authRequired, (req, res) => {
  const rows = db.prepare(
    `SELECT id, type, title, content, link, is_read, create_time
     FROM personal_notice WHERE user_id = ? ORDER BY id DESC LIMIT 30`
  ).all(uid(req));
  res.json({ rows });
});

// POST /api/notifications/personal/:id/read — 单条已读（只能标自己的）
r.post('/personal/:id/read', authRequired, (req, res) => {
  const me = uid(req);
  db.prepare(
    `UPDATE personal_notice SET is_read = 1, read_time = datetime('now','localtime')
     WHERE id = ? AND user_id = ? AND is_read = 0`
  ).run(Number(req.params.id), me);
  publishUnread(me);
  res.json({ message: '已标记已读', unread: unreadSnapshot(db, me) });
});

// POST /api/notifications/personal/read-all — 全部已读
r.post('/personal/read-all', authRequired, (req, res) => {
  const me = uid(req);
  db.prepare(
    `UPDATE personal_notice SET is_read = 1, read_time = datetime('now','localtime')
     WHERE user_id = ? AND is_read = 0`
  ).run(me);
  publishUnread(me);
  res.json({ message: '已全部标记已读', unread: unreadSnapshot(db, me) });
});

// POST /api/notifications/read — 批量标已读 { types: ['comment','like','fav'] }
r.post('/read', authRequired, (req, res) => {
  const me = uid(req);
  const types = (Array.isArray(req.body?.types) ? req.body.types : [])
    .map(String)
    .filter((t) => TYPES.includes(t));
  if (types.length) {
    const q = db.prepare('UPDATE notification SET is_read = 1 WHERE user_id = ? AND type = ? AND is_read = 0');
    for (const t of types) q.run(me, t);
  }
  publishUnread(me);
  res.json({ message: '已标记已读', unread: unreadSnapshot(db, me) });
});

export default r;
