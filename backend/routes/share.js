// 资源分享（贴吧式）：楼主开楼（富文本 + 多媒介附件 + 索引标签子板块）
// 三种排序视图：hot 最热门（点赞+评论权重）/ new 最新 / fav 收藏最高；标签过滤
// 点赞/收藏 toggle；评论（纯文本）增删；发帖/编辑/删帖限本人或管理员
import { Router } from 'express';
import db from '../db/database.js';
import { authRequired, optionalAuth, logAudit, mutedGuard } from './middleware.js';

const r = Router();

const uid = (req) => (req.user ? Number(req.user.id) : null);
const SORTS = { hot: 'hot', new: 'new', fav: 'fav' };
const MAX_ATT_TOTAL = 25 * 1024 * 1024; // base64 总量上限（与小组汇报一致）

// 规范化附件：校验结构 + 总量上限；返回 [att...] 或 null（错误信息）
function normAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  let total = 0;
  const out = [];
  for (const a of raw) {
    const name = String(a?.name || '').slice(0, 120);
    const mime = String(a?.mime || 'application/octet-stream').slice(0, 100);
    const data = String(a?.data || '');
    if (!name || !data) continue;
    total += data.length;
    if (total > MAX_ATT_TOTAL) return null;
    out.push({ name, size: Number(a?.size) || Math.round(data.length * 0.75), mime, data });
  }
  return out;
}

// 消息中心通知：他人对自己帖子的评论/点赞/收藏（自己操作自己的帖子不通知）
function notify(me, type, postId, commentId = null) {
  const owner = db.prepare('SELECT user_id FROM share_post WHERE id = ?').get(postId);
  if (owner && Number(owner.user_id) !== Number(me)) {
    db.prepare('INSERT INTO notification (user_id, actor_id, type, post_id, comment_id) VALUES (?, ?, ?, ?, ?)')
      .run(owner.user_id, me, type, postId, commentId);
  }
}

// 规范化标签：去重/去空/限长；返回 [] 或 null（超限）
function normTags(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    const name = String(t || '').trim().slice(0, 12);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  if (out.length > 5) return null;
  return out;
}

// 帖子的标签 + 作者信息 + 计数（列表/详情共用拼装）
function decorate(row) {
  const tags = db.prepare(
    `SELECT t.name FROM share_post_tag pt JOIN share_tag t ON t.id = pt.tag_id WHERE pt.post_id = ? ORDER BY t.id`
  ).all(row.id).map((x) => x.name);
  return { ...row, tags };
}

// GET /api/share/posts — 列表：?sort=hot|new|fav&tag=名称&scope=mine|favs&page=&size=
// scope=mine 只看我发的；scope=favs 看我收藏的（需登录）
r.get('/posts', optionalAuth, (req, res) => {
  const sort = SORTS[String(req.query.sort || 'hot')] || 'hot';
  const tag = String(req.query.tag || '').trim();
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(50, Math.max(1, Number(req.query.size) || 10));
  const me = uid(req);
  const scope = String(req.query.scope || '');
  if (scope && !req.user) return res.status(401).json({ error: '请先登录' });

  const where = [
    tag ? 'AND p.id IN (SELECT pt.post_id FROM share_post_tag pt JOIN share_tag t ON t.id = pt.tag_id WHERE t.name = ?)' : '',
    scope === 'mine' ? 'AND p.user_id = ?' : '',
    scope === 'favs' ? 'AND p.id IN (SELECT post_id FROM share_fav WHERE user_id = ?)' : '',
  ].filter(Boolean).join(' ');
  const orderBy = {
    hot: `(SELECT COUNT(*) FROM share_like l WHERE l.post_id = p.id) DESC,
          (SELECT COUNT(*) FROM share_comment c WHERE c.post_id = p.id) DESC, p.id DESC`,
    new: 'p.create_time DESC, p.id DESC',
    fav: `(SELECT COUNT(*) FROM share_fav f WHERE f.post_id = p.id) DESC, p.id DESC`,
  }[sort];

  const params = [...(tag ? [tag] : []), ...(scope ? [me] : [])];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM share_post p WHERE 1=1 ${where}`).get(...params).n;
  const rows = db.prepare(
    `SELECT p.id, p.title, p.content, p.attachments, p.create_time, p.update_time,
            u.id AS author_id, u.nickname, u.avatar,
            (SELECT COUNT(*) FROM share_like l WHERE l.post_id = p.id) AS like_count,
            (SELECT COUNT(*) FROM share_fav f WHERE f.post_id = p.id) AS fav_count,
            (SELECT COUNT(*) FROM share_comment c WHERE c.post_id = p.id) AS comment_count,
            EXISTS(SELECT 1 FROM share_like l WHERE l.post_id = p.id AND l.user_id = ?) AS is_liked,
            EXISTS(SELECT 1 FROM share_fav f WHERE f.post_id = p.id AND f.user_id = ?) AS is_faved
     FROM share_post p JOIN user u ON u.id = p.user_id
     WHERE 1=1 ${where}
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`
  ).all(me, me, ...params, size, (page - 1) * size);

  res.json({ rows: rows.map(decorate), total, page, size, sort, tag, scope });
});

// GET /api/share/posts/:id — 详情（含评论）
r.get('/posts/:id', optionalAuth, (req, res) => {
  const me = uid(req);
  const p = db.prepare(
    `SELECT p.id, p.title, p.content, p.attachments, p.create_time, p.update_time,
            u.id AS author_id, u.nickname, u.avatar,
            (SELECT COUNT(*) FROM share_like l WHERE l.post_id = p.id) AS like_count,
            (SELECT COUNT(*) FROM share_fav f WHERE f.post_id = p.id) AS fav_count,
            (SELECT COUNT(*) FROM share_comment c WHERE c.post_id = p.id) AS comment_count,
            EXISTS(SELECT 1 FROM share_like l WHERE l.post_id = p.id AND l.user_id = ?) AS is_liked,
            EXISTS(SELECT 1 FROM share_fav f WHERE f.post_id = p.id AND f.user_id = ?) AS is_faved
     FROM share_post p JOIN user u ON u.id = p.user_id WHERE p.id = ?`
  ).get(me, me, Number(req.params.id));
  if (!p) return res.status(404).json({ error: '帖子不存在' });
  const comments = db.prepare(
    `SELECT c.id, c.content, c.create_time, u.id AS user_id, u.nickname, u.avatar
     FROM share_comment c JOIN user u ON u.id = c.user_id
     WHERE c.post_id = ? ORDER BY c.create_time ASC, c.id ASC`
  ).all(p.id);
  res.json({ ...decorate(p), comments });
});

// GET /api/share/tags — 子板块标签（按帖子数降序）
r.get('/tags', (req, res) => {
  const rows = db.prepare(
    `SELECT t.name, COUNT(pt.post_id) AS count
     FROM share_tag t LEFT JOIN share_post_tag pt ON pt.tag_id = t.id
     GROUP BY t.id ORDER BY count DESC, t.id`
  ).all();
  res.json(rows);
});

// POST /api/share/posts — 发帖（开楼）
r.post('/posts', authRequired, mutedGuard, (req, res) => {
  const title = String(req.body?.title || '').trim();
  const content = String(req.body?.content || '').trim();
  if (!title || title.length > 60) return res.status(400).json({ error: '标题必填（≤60 字）' });
  const atts = normAttachments(req.body?.attachments);
  if (atts === null) return res.status(400).json({ error: '附件总量超限（≤25MB）' });
  const tags = normTags(req.body?.tags);
  if (tags === null) return res.status(400).json({ error: '标签最多 5 个，每个 ≤12 字' });
  if (!content && !atts.length) return res.status(400).json({ error: '写点内容或附上资源' });

  const info = db.prepare('INSERT INTO share_post (user_id, title, content, attachments) VALUES (?, ?, ?, ?)')
    .run(uid(req), title, content, JSON.stringify(atts));
  const postId = Number(info.lastInsertRowid);
  if (tags.length) {
    const insTag = db.prepare('INSERT OR IGNORE INTO share_tag (name) VALUES (?)');
    const link = db.prepare('INSERT OR IGNORE INTO share_post_tag (post_id, tag_id) VALUES (?, ?)');
    for (const name of tags) {
      insTag.run(name);
      const t = db.prepare('SELECT id FROM share_tag WHERE name = ?').get(name);
      link.run(postId, t.id);
    }
  }
  res.json({ id: postId, message: '发布成功' });
});

// PUT /api/share/posts/:id — 编辑（本人或管理员）
r.put('/posts/:id', authRequired, (req, res) => {
  const me = uid(req);
  const p = db.prepare('SELECT * FROM share_post WHERE id = ?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: '帖子不存在' });
  if (p.user_id !== me && !req.user.is_admin) return res.status(403).json({ error: '只能编辑自己的帖子' });

  const title = String(req.body?.title ?? p.title).trim();
  if (!title || title.length > 60) return res.status(400).json({ error: '标题必填（≤60 字）' });
  const content = String(req.body?.content ?? p.content).trim();
  const atts = req.body?.attachments !== undefined ? normAttachments(req.body.attachments) : JSON.parse(p.attachments || '[]');
  if (atts === null) return res.status(400).json({ error: '附件总量超限（≤25MB）' });
  const tags = req.body?.tags !== undefined ? normTags(req.body.tags) : null;
  if (tags === null) return res.status(400).json({ error: '标签最多 5 个，每个 ≤12 字' });

  db.prepare('UPDATE share_post SET title = ?, content = ?, attachments = ?, update_time = CURRENT_TIMESTAMP WHERE id = ?')
    .run(title, content, JSON.stringify(atts), p.id);
  if (tags) {
    db.prepare('DELETE FROM share_post_tag WHERE post_id = ?').run(p.id);
    const insTag = db.prepare('INSERT OR IGNORE INTO share_tag (name) VALUES (?)');
    const link = db.prepare('INSERT OR IGNORE INTO share_post_tag (post_id, tag_id) VALUES (?, ?)');
    for (const name of tags) {
      insTag.run(name);
      const t = db.prepare('SELECT id FROM share_tag WHERE name = ?').get(name);
      link.run(p.id, t.id);
    }
  }
  res.json({ message: '已更新' });
});

// DELETE /api/share/posts/:id — 删帖（本人或管理员；评论/点赞/收藏/标签随外键级联删除）
r.delete('/posts/:id', authRequired, (req, res) => {
  const me = uid(req);
  const p = db.prepare('SELECT * FROM share_post WHERE id = ?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: '帖子不存在' });
  if (p.user_id !== me && !req.user.is_admin) return res.status(403).json({ error: '只能删除自己的帖子' });
  db.prepare('DELETE FROM share_post WHERE id = ?').run(p.id);
  res.json({ message: '已删除' });
});

// POST /api/share/posts/:id/like — 点赞 / 取消点赞（toggle）
r.post('/posts/:id/like', authRequired, (req, res) => {
  const postId = Number(req.params.id);
  const me = uid(req);
  const exists = db.prepare('SELECT 1 FROM share_post WHERE id = ?').get(postId);
  if (!exists) return res.status(404).json({ error: '帖子不存在' });
  const had = db.prepare('SELECT 1 FROM share_like WHERE post_id = ? AND user_id = ?').get(postId, me);
  if (had) {
    db.prepare('DELETE FROM share_like WHERE post_id = ? AND user_id = ?').run(postId, me);
    const n = db.prepare('SELECT COUNT(*) AS n FROM share_like WHERE post_id = ?').get(postId).n;
    return res.json({ liked: false, count: n });
  }
  db.prepare('INSERT INTO share_like (post_id, user_id) VALUES (?, ?)').run(postId, me);
  notify(me, 'like', postId);
  const n = db.prepare('SELECT COUNT(*) AS n FROM share_like WHERE post_id = ?').get(postId).n;
  res.json({ liked: true, count: n });
});

// POST /api/share/posts/:id/fav — 收藏 / 取消收藏（toggle）
r.post('/posts/:id/fav', authRequired, (req, res) => {
  const postId = Number(req.params.id);
  const me = uid(req);
  const exists = db.prepare('SELECT 1 FROM share_post WHERE id = ?').get(postId);
  if (!exists) return res.status(404).json({ error: '帖子不存在' });
  const had = db.prepare('SELECT 1 FROM share_fav WHERE post_id = ? AND user_id = ?').get(postId, me);
  if (had) {
    db.prepare('DELETE FROM share_fav WHERE post_id = ? AND user_id = ?').run(postId, me);
    const n = db.prepare('SELECT COUNT(*) AS n FROM share_fav WHERE post_id = ?').get(postId).n;
    return res.json({ faved: false, count: n });
  }
  db.prepare('INSERT INTO share_fav (post_id, user_id) VALUES (?, ?)').run(postId, me);
  notify(me, 'fav', postId);
  const n = db.prepare('SELECT COUNT(*) AS n FROM share_fav WHERE post_id = ?').get(postId).n;
  res.json({ faved: true, count: n });
});

// POST /api/share/posts/:id/comments — 评论
r.post('/posts/:id/comments', authRequired, mutedGuard, (req, res) => {
  const content = String(req.body?.content || '').trim();
  if (!content || content.length > 1000) return res.status(400).json({ error: '评论 1-1000 字' });
  const postId = Number(req.params.id);
  const exists = db.prepare('SELECT 1 FROM share_post WHERE id = ?').get(postId);
  if (!exists) return res.status(404).json({ error: '帖子不存在' });
  const me = uid(req);
  const info = db.prepare('INSERT INTO share_comment (post_id, user_id, content) VALUES (?, ?, ?)')
    .run(postId, me, content);
  notify(me, 'comment', postId, Number(info.lastInsertRowid));
  const c = db.prepare(
    `SELECT c.id, c.content, c.create_time, u.id AS user_id, u.nickname, u.avatar
     FROM share_comment c JOIN user u ON u.id = c.user_id WHERE c.id = ?`
  ).get(Number(info.lastInsertRowid));
  logAudit(req, 'comment-share', `post#${postId}`);
  res.json(c);
});

// DELETE /api/share/comments/:id — 删评论（本人 / 管理员 / 楼主）
r.delete('/comments/:id', authRequired, (req, res) => {
  const me = uid(req);
  const c = db.prepare(
    `SELECT c.*, p.user_id AS post_owner FROM share_comment c JOIN share_post p ON p.id = c.post_id WHERE c.id = ?`
  ).get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: '评论不存在' });
  if (c.user_id !== me && c.post_owner !== me && !req.user.is_admin) {
    return res.status(403).json({ error: '只能删除自己的评论' });
  }
  db.prepare('DELETE FROM share_comment WHERE id = ?').run(c.id);
  res.json({ message: '已删除' });
});

export default r;
