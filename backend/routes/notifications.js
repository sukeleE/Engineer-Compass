// 消息中心：评论/点赞/收藏通知（私信未读沿用 dm_message.is_read，见 friends.js）
// 三组列表 + 未读计数（含私信）+ 批量标已读
import { Router } from 'express';
import db from '../db/database.js';
import { authRequired } from './middleware.js';

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

// GET /api/notifications/unread-count — 红点数字（通知三组 + 私信未读）
r.get('/unread-count', authRequired, (req, res) => {
  const me = uid(req);
  const countOf = (type) =>
    Number(db.prepare('SELECT COUNT(*) AS n FROM notification WHERE user_id = ? AND type = ? AND is_read = 0').get(me, type).n);
  const comments = countOf('comment');
  const likes = countOf('like');
  const favs = countOf('fav');
  const dm = Number(db.prepare('SELECT COUNT(*) AS n FROM dm_message WHERE to_id = ? AND is_read = 0').get(me).n);
  res.json({ total: comments + likes + favs + dm, comments, likes, favs, dm });
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
  res.json({ message: '已标记已读' });
});

export default r;
