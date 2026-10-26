// 资源分享（贴吧式）：楼主开楼（富文本 + 多媒介附件 + 索引标签子板块）
// 三种排序视图：hot 最热门（点赞+评论权重）/ new 最新 / fav 收藏最高；标签过滤
// 点赞/收藏 toggle；评论（纯文本）增删；发帖/编辑/删帖限本人或管理员
import { Router } from 'express';
import multer from 'multer';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { extname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import db from '../db/database.js';
import { authRequired, optionalAuth, logAudit, mutedGuard, isSuperAdmin, hasAdminPerm } from './middleware.js';
import { buildZip } from '../lib/zipStore.js';
import { Readable } from 'node:stream';
import { GiteeError, parseRepo, parseRefFromUrl, fetchTree, giteeRawBase } from '../lib/gitee.js';
import { sanitizeName } from '../lib/expenseMeta.js';
import {
  MAX_FILE, MAX_BATCH, FOLDER_MAX, USER_QUOTA,
  userDir, absPathOf, saveUploads, usedOf, purgePostFiles, purgeUploads, isInlineOk, discardUploads, removeFileRow, mimeOf,
} from '../lib/shareFiles.js';
import { uniquePostSlug } from '../lib/slug.js';

const r = Router();

const uid = (req) => (req.user ? Number(req.user.id) : null);
const SORTS = { hot: 'hot', new: 'new', fav: 'fav' };
const MAX_ATT_TOTAL = 25 * 1024 * 1024; // base64 总量上限（与小组汇报一致）

// 规范化附件：校验结构 + 总量上限；返回 [att...] 或 null（错误信息）
// 条目两种形态：base64 {name,size,mime,data} / 引用型 {name,size,mime,url}（我的资源分享链接，无 data 不计总量）
function normAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  let total = 0;
  const out = [];
  for (const a of raw) {
    const name = String(a?.name || '').slice(0, 120);
    const mime = String(a?.mime || 'application/octet-stream').slice(0, 100);
    if (!name) continue;
    // 引用型：url 必须是本站分享白名单格式（防任意外链注入），或飞书域链接（docx/file/sheet/wiki，飞书云盘引用）
    const url = String(a?.url || '');
    if (/^\/api\/resource\/share\/[0-9a-f]{32}$/.test(url) || /^https?:\/\/[^/]*(feishu\.cn|larksuite\.com)\//.test(url)) {
      out.push({ name, size: Number(a?.size) || 0, mime, url });
      continue;
    }
    const data = String(a?.data || '');
    if (!data) continue;
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

// 幽灵帖隔离条件（服务端强制）：scope 查看自己数据时全量；否则——
// 管理员：ghost=1 只看幽灵帖，否则全看；幽灵用户：ghost=1 只看幽灵帖，否则只普通帖；普通用户：永远只普通帖
// alias：帖子表在该查询里的别名（列表主查询 'p'，stats 聚合里 'sp'）—— 原实现硬编码 p.，聚合查询复用不了
function ghostClause(req, scope, ghostOnly, alias = 'p') {
  if (scope) return '';
  // 普通大厅（/share）对所有人同口径：只见非幽灵帖——管理员巡检走后台 /admin/posts，
  // 在这里放行会让管理员在「开源大厅」看到幽灵帖（与私密豁免同一类泄露观感）。
  // /ghost-share（ghostOnly）才是幽灵帖的专属入口。
  if (isSuperAdmin(req.user)) return ghostOnly ? `AND ${alias}.is_ghost = 1` : `AND ${alias}.is_ghost = 0`;
  if (req.user?.is_ghost) return ghostOnly ? `AND ${alias}.is_ghost = 1` : `AND ${alias}.is_ghost = 0`;
  return `AND ${alias}.is_ghost = 0`;
}

// 幽灵帖可见性：普通用户对幽灵帖一律 404（防 ID 探测，与"帖子不存在"同语义）
function ghostVisible(req, p) {
  return !p?.is_ghost || req.user?.is_ghost || isSuperAdmin(req.user);
}

// 写权限：作者本人或管理员（PUT/DELETE 行、附件、Gitee 同步共用一套，避免各处漂移）
// 受限管理员需「帖子管理」子权限；幽灵帖巡检/豁免仍仅限超级管理员
const canEdit = (p, req) => Number(p?.user_id) === uid(req) || hasAdminPerm(req.user, 'content:post');

// 开源/私密 + 幽灵统一可见性：私密帖仅作者本人/管理员；私密与幽灵双隔离并行。
// 对不可见者统一 404（不区分"不存在"与"没权限"，防探测）。
function postVisible(req, p) {
  if (!p) return false;
  if (!ghostVisible(req, p)) return false;
  // 详情查询把作者列别名成 author_id（SELECT * 的行才是 user_id），两处都认
  const ownerId = p.user_id ?? p.author_id;
  const isOwner = Number(ownerId) === uid(req);
  // 帖子/评论管理任一子权限都可查看私密帖（评论审核需要看到所属帖子）
  const canModerate = hasAdminPerm(req.user, 'content:post') || hasAdminPerm(req.user, 'content:comment');
  if (Number(p.is_public) === 0 && !isOwner && !canModerate) return false;
  return true;
}

// 开源隔离条件：非「我的」视图只出开源帖，**管理员也不例外**
// （大厅语义就是「开源大厅」；管理员巡检全量帖走后台 /admin/posts，否则管理员视角
//  会在大厅看到他人 🔒 私密项目——私密帖只应出现在作者本人的「我的项目」里）
function openClause(req, scope, alias = 'p') {
  if (scope === 'mine') return ''; // 本人看自己：公开私密全量
  return `AND ${alias}.is_public = 1`;
}

// 帖子的标签 + 作者信息 + 计数（列表/详情共用拼装）
function decorate(row) {
  const tags = db.prepare(
    `SELECT t.name FROM share_post_tag pt JOIN share_tag t ON t.id = pt.tag_id WHERE pt.post_id = ? ORDER BY t.id`
  ).all(row.id).map((x) => x.name);
  return { ...row, tags };
}

// 帖子的文件夹清单（详情页渲染目录树用）。不返回 user_id/store_name —— 磁盘名不该出后端，
// 取文件走 /files/:fid（那里自己重查归属 + 幽灵可见性）。
function filesOf(postId) {
  return db.prepare(
    `SELECT id, path, name, size, mime, source FROM share_file WHERE post_id = ? ORDER BY path`
  ).all(postId);
}

// 把本人在弹窗里传好的暂存行绑到帖子上。只认「本人的、还没绑过的」行 —— 传别人的 id 绑不上，
// 传已绑过别帖的也绑不上（防止把 A 帖的文件挪到 B 帖）。返回绑定条数。
function bindStagedFiles(userId, postId, list) {
  if (!Array.isArray(list)) return 0;
  const upd = db.prepare('UPDATE share_file SET post_id = ? WHERE id = ? AND user_id = ? AND post_id IS NULL');
  let n = 0;
  for (const it of list) {
    const fid = Number(typeof it === 'object' ? it?.id : it);
    if (!fid) continue;
    n += upd.run(postId, fid, userId).changes;
  }
  return n;
}

// GET /api/share/posts — 列表：?sort=hot|new|fav&tag=名称&scope=mine|favs&page=&size=
// scope=mine 只看我发的；scope=favs 看我收藏的（需登录）
r.get('/posts', optionalAuth, (req, res) => {
  // 大厅默认按收藏数从高到低（无参直取 API 同口径）
  const sort = SORTS[String(req.query.sort || 'fav')] || 'fav';
  const tag = String(req.query.tag || '').trim();
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(50, Math.max(1, Number(req.query.size) || 10));
  const me = uid(req);
  const scope = String(req.query.scope || '');
  if (scope && !req.user) return res.status(401).json({ error: '请先登录' });

  const ghostOnly = req.query.ghost === '1';
  const ghostCond = ghostClause(req, scope, ghostOnly, 'p');
  const where = [
    tag ? 'AND p.id IN (SELECT pt.post_id FROM share_post_tag pt JOIN share_tag t ON t.id = pt.tag_id WHERE t.name = ?)' : '',
    scope === 'mine' ? 'AND p.user_id = ?' : '',
    // 收藏夹只显示仍开源的项目（帖主转私密后自动从他人收藏视图消失）
    scope === 'favs' ? 'AND p.id IN (SELECT post_id FROM share_fav WHERE user_id = ?) AND p.is_public = 1' : '',
    openClause(req, scope, 'p'),
    ghostCond,
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
    `SELECT p.id, p.title, p.content, p.attachments, p.gitee_repo, p.slug, p.is_public, p.create_time, p.update_time,
            u.id AS author_id, u.username, u.nickname, u.avatar,
            (SELECT COUNT(*) FROM share_like l WHERE l.post_id = p.id) AS like_count,
            (SELECT COUNT(*) FROM share_fav f WHERE f.post_id = p.id) AS fav_count,
            (SELECT COUNT(*) FROM share_comment c WHERE c.post_id = p.id) AS comment_count,
            (SELECT COUNT(*) FROM share_file f WHERE f.post_id = p.id) AS file_count,
            EXISTS(SELECT 1 FROM share_like l WHERE l.post_id = p.id AND l.user_id = ?) AS is_liked,
            EXISTS(SELECT 1 FROM share_fav f WHERE f.post_id = p.id AND f.user_id = ?) AS is_faved
     FROM share_post p JOIN user u ON u.id = p.user_id
     WHERE 1=1 ${where}
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`
  ).all(me, me, ...params, size, (page - 1) * size);

  // 仓库页顶部徽标：全站聚合。跟随幽灵身份（普通用户不计幽灵帖、幽灵页只算幽灵帖），
  // 但**不跟随 scope/tag** —— 徽标表示"这个板块有多大"，不该因切到「我的收藏」而缩水。
  // 四张表都很小，一条聚合可忽略。
  const gcS = `${ghostClause(req, '', ghostOnly, 'sp')} ${openClause(req, '', 'sp')}`;
  const stats = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM share_post sp WHERE 1=1 ${gcS}) AS posts,
       (SELECT COUNT(*) FROM share_like l JOIN share_post sp ON sp.id = l.post_id WHERE 1=1 ${gcS}) AS likes,
       (SELECT COUNT(*) FROM share_fav f JOIN share_post sp ON sp.id = f.post_id WHERE 1=1 ${gcS}) AS favs,
       (SELECT COUNT(*) FROM share_comment c JOIN share_post sp ON sp.id = c.post_id WHERE 1=1 ${gcS}) AS comments`
  ).get();

  res.json({ rows: rows.map(decorate), total, page, size, sort, tag, scope, stats });
});

// 项目详情主查询（数字 id 路由与 /p/:username/:slug 共用，保证两份 payload 不漂移）
function detailPost(me, where, ...params) {
  return db.prepare(
    `SELECT p.id, p.title, p.content, p.attachments, p.is_ghost, p.gitee_repo, p.gitee_ref,
            p.slug, p.is_public, p.create_time, p.update_time,
            u.id AS author_id, u.username, u.nickname, u.avatar,
            (SELECT COUNT(*) FROM share_like l WHERE l.post_id = p.id) AS like_count,
            (SELECT COUNT(*) FROM share_fav f WHERE f.post_id = p.id) AS fav_count,
            (SELECT COUNT(*) FROM share_comment c WHERE c.post_id = p.id) AS comment_count,
            EXISTS(SELECT 1 FROM share_like l WHERE l.post_id = p.id AND l.user_id = ?) AS is_liked,
            EXISTS(SELECT 1 FROM share_fav f WHERE f.post_id = p.id AND f.user_id = ?) AS is_faved
     FROM share_post p JOIN user u ON u.id = p.user_id WHERE ${where}`
  ).get(me, me, ...params);
}
function detailPayload(p) {
  const comments = db.prepare(
    `SELECT c.id, c.content, c.create_time, u.id AS user_id, u.nickname, u.avatar
     FROM share_comment c JOIN user u ON u.id = c.user_id
     WHERE c.post_id = ? ORDER BY c.create_time ASC, c.id ASC`
  ).all(p.id);
  return { ...decorate(p), comments, files: filesOf(p.id) };
}

// GET /api/share/posts/:id — 详情（数字 id 旧路由保留：前端拿到后自行 replace 到 /:username/:slug）
r.get('/posts/:id', optionalAuth, (req, res) => {
  const me = uid(req);
  const p = detailPost(me, 'p.id = ?', Number(req.params.id));
  if (!postVisible(req, p)) return res.status(404).json({ error: '帖子不存在' });
  res.json(detailPayload(p));
});

// GET /api/share/u/:username — 用户开源项目页（GitHub 风 /:username）
// 他人只见 is_public=1 的普通帖；作者本人含私密；幽灵账号对非授权访问者整体 404。
r.get('/u/:username', optionalAuth, (req, res) => {
  const me = uid(req);
  const u = db.prepare('SELECT id, username, nickname, avatar, is_ghost FROM user WHERE username = ?')
    .get(String(req.params.username));
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const isOwner = me === Number(u.id);
  if (u.is_ghost && !isOwner && !isSuperAdmin(req.user)) {
    return res.status(404).json({ error: '用户不存在' });
  }
  const conds = ['p.user_id = ?'];
  const params = [u.id];
  if (!isOwner && !isSuperAdmin(req.user)) conds.push('p.is_public = 1', 'p.is_ghost = 0');
  const projects = db.prepare(
    `SELECT p.id, p.title, p.content, p.slug, p.is_public, p.gitee_repo, p.create_time, p.update_time,
            (SELECT COUNT(*) FROM share_like l WHERE l.post_id = p.id) AS like_count,
            (SELECT COUNT(*) FROM share_fav f WHERE f.post_id = p.id) AS fav_count,
            (SELECT COUNT(*) FROM share_comment c WHERE c.post_id = p.id) AS comment_count,
            (SELECT COUNT(*) FROM share_file f WHERE f.post_id = p.id) AS file_count
     FROM share_post p WHERE ${conds.join(' AND ')}
     ORDER BY p.update_time DESC, p.id DESC`
  ).all(...params).map(decorate);
  res.json({
    user: { id: Number(u.id), username: u.username, nickname: u.nickname, avatar: u.avatar || null },
    projects, total: projects.length,
  });
});

// GET /api/share/p/:username/:slug — GitHub 风 /:username/:slug 单项目（payload 与数字路由完全一致）
r.get('/p/:username/:slug', optionalAuth, (req, res) => {
  const me = uid(req);
  const u = db.prepare('SELECT id FROM user WHERE username = ?').get(String(req.params.username));
  if (!u) return res.status(404).json({ error: '项目不存在' });
  const p = detailPost(me, 'p.user_id = ? AND p.slug = ?', u.id, String(req.params.slug));
  if (!postVisible(req, p)) return res.status(404).json({ error: '项目不存在' });
  res.json(detailPayload(p));
});

// GET /api/share/tags — 子板块标签（按帖子数降序）
// 幽灵帖隔离：普通用户只统计普通帖（COUNT(sp.id) 排除幽灵帖），幽灵专属标签整体隐藏（HAVING）
r.get('/tags', optionalAuth, (req, res) => {
  const all = req.user?.is_ghost || isSuperAdmin(req.user);
  const rows = db.prepare(
    `SELECT t.name, ${all ? 'COUNT(pt.post_id)' : 'COUNT(sp.id)'} AS count
     FROM share_tag t LEFT JOIN share_post_tag pt ON pt.tag_id = t.id
     ${all ? '' : 'LEFT JOIN share_post sp ON sp.id = pt.post_id AND sp.is_ghost = 0 AND sp.is_public = 1'}
     GROUP BY t.id ${all ? '' : 'HAVING COUNT(sp.id) > 0'} ORDER BY count DESC, t.id`
  ).all();
  res.json(rows);
});

// POST /api/share/posts — 发帖（开楼）
r.post('/posts', authRequired, mutedGuard, async (req, res) => {
  const title = String(req.body?.title || '').trim();
  const content = String(req.body?.content || '').trim();
  if (!title || title.length > 60) return res.status(400).json({ error: '标题必填（≤60 字）' });
  const atts = normAttachments(req.body?.attachments);
  if (atts === null) return res.status(400).json({ error: '附件总量超限（≤25MB）' });
  const tags = normTags(req.body?.tags);
  if (tags === null) return res.status(400).json({ error: '标签最多 5 个，每个 ≤12 字' });
  // 「有内容」的判定收进了一个函数：正文 / 散装附件 / 项目文件夹 / Gitee 仓库，四选一即可
  const hasProject = Array.isArray(req.body?.files) && req.body.files.length > 0;
  const hasGitee = !!String(req.body?.gitee_repo || '').trim();
  if (!content && !atts.length && !hasProject && !hasGitee) return res.status(400).json({ error: '写点内容或附上资源' });

  // 幽灵帖归属：幽灵用户默认发「仅怪奇可见」（显式传 0 才发普通帖）；普通用户强制普通帖
  const isGhost = req.user?.is_ghost ? (req.body?.is_ghost === 0 ? 0 : 1) : 0;
  // 开源/私密：默认开源（存量行为不突变）；只认 0/1，其余一律按开源
  const isPublic = Number(req.body?.is_public) === 0 ? 0 : 1;
  const authorId = uid(req);
  const slug = uniquePostSlug(db, authorId, title);
  const info = db.prepare(
    'INSERT INTO share_post (user_id, title, content, attachments, is_ghost, slug, is_public) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(authorId, title, content, JSON.stringify(atts), isGhost, slug, isPublic);
  const postId = Number(info.lastInsertRowid);
  bindStagedFiles(uid(req), postId, req.body?.files); // 弹窗里传好的文件夹暂存行 → 绑到新帖
  if (tags.length) {
    const insTag = db.prepare('INSERT OR IGNORE INTO share_tag (name) VALUES (?)');
    const link = db.prepare('INSERT OR IGNORE INTO share_post_tag (post_id, tag_id) VALUES (?, ?)');
    for (const name of tags) {
      insTag.run(name);
      const t = db.prepare('SELECT id FROM share_tag WHERE name = ?').get(name);
      link.run(postId, t.id);
    }
  }
  const gitee = await applyGitee(postId, req); // 服务端自己拉，绝不采信客户端传来的树
  res.json({ id: postId, slug, is_public: isPublic, message: '发布成功', ...withGitee(gitee) });
});

// PUT /api/share/posts/:id — 编辑（本人或管理员）
r.put('/posts/:id', authRequired, async (req, res) => {
  const me = uid(req);
  const p = db.prepare('SELECT * FROM share_post WHERE id = ?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: '帖子不存在' });
  if (!canEdit(p, req)) return res.status(403).json({ error: '只能编辑自己的帖子' });

  const title = String(req.body?.title ?? p.title).trim();
  if (!title || title.length > 60) return res.status(400).json({ error: '标题必填（≤60 字）' });
  const content = String(req.body?.content ?? p.content).trim();
  const atts = req.body?.attachments !== undefined ? normAttachments(req.body.attachments) : JSON.parse(p.attachments || '[]');
  if (atts === null) return res.status(400).json({ error: '附件总量超限（≤25MB）' });
  // 三态：undefined = 缺省不动 / [] = 清空 / 非空数组 = 整组替换。
  // 这里曾经把「缺省」和「非法」都记成 null，于是**不带 tags 的 PUT 一律 400**
  // （只改标题也过不去）—— normTags 的 null 只能表示非法，缺省要用 undefined 单独区分。
  const tags = req.body?.tags === undefined ? undefined : normTags(req.body.tags);
  if (tags === null) return res.status(400).json({ error: '标签最多 5 个，每个 ≤12 字' });

  // is_public 三态同 attachments：缺省不动；slug 一经生成不可改（URL 身份稳定）
  const sets = ['title = ?', 'content = ?', 'attachments = ?'];
  const vals = [title, content, JSON.stringify(atts)];
  if (req.body?.is_public !== undefined) {
    const v = Number(req.body.is_public);
    if (![0, 1].includes(v)) return res.status(400).json({ error: 'is_public 仅支持 0 私密 / 1 开源' });
    sets.push('is_public = ?');
    vals.push(v);
  }
  sets.push("update_time = CURRENT_TIMESTAMP");
  vals.push(p.id);
  db.prepare(`UPDATE share_post SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  // 文件夹：整树替换语义（旧的上传文件连盘带行清掉，再绑本次的暂存行）。
  // 字段缺省 = 不动文件夹 —— 否则老客户端一次改标题就会把整个项目删空。
  // 用 purgeUploads 而非 purgePostFiles：Gitee 树由下面的 gitee_repo 单独管，不跟着一起清。
  if (req.body?.files !== undefined) {
    purgeUploads(p.id);
    bindStagedFiles(me, p.id, req.body.files);
  }
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
  const gitee = await applyGitee(p.id, req);
  res.json({ message: '已更新', ...withGitee(gitee) });
});

// POST /api/share/posts/:id/visibility — 开源/私密切换（「我的」子页开关；仅作者或管理员）
r.post('/posts/:id/visibility', authRequired, (req, res) => {
  const p = db.prepare('SELECT * FROM share_post WHERE id = ?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: '帖子不存在' });
  if (!canEdit(p, req)) return res.status(403).json({ error: '只能修改自己项目的开源状态' });
  const v = Number(req.body?.is_public);
  if (![0, 1].includes(v)) return res.status(400).json({ error: 'is_public 仅支持 0 私密 / 1 开源' });
  db.prepare('UPDATE share_post SET is_public = ? WHERE id = ?').run(v, p.id);
  logAudit(req, 'share-visibility', `${p.slug || p.id} → ${v ? '开源' : '私密'}`, { post_id: p.id, is_public: v });
  res.json({ is_public: v, message: v ? '已设为开源（任何人凭链接可见）' : '已设为私密（仅你自己可见）' });
});

// DELETE /api/share/posts/:id — 删帖（本人或管理员；评论/点赞/收藏/标签随外键级联删除）
r.delete('/posts/:id', authRequired, (req, res) => {
  const me = uid(req);
  const p = db.prepare('SELECT * FROM share_post WHERE id = ?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: '帖子不存在' });
  if (!canEdit(p, req)) return res.status(403).json({ error: '只能删除自己的帖子' });
  purgePostFiles(p.id); // 磁盘文件不会随外键级联，必须先清盘再删帖
  db.prepare('DELETE FROM share_post WHERE id = ?').run(p.id);
  res.json({ message: '已删除' });
});

// ---- 项目文件夹上传（文件夹落盘、DB 只存元数据；身份预检在 multer 之前，未登录不落盘） ----
const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      cb(null, req.upDir); // 已由 gateUpload 校验并建目录
    },
    filename(req, file, cb) {
      const ext = extname(basename(String(file.originalname || ''))).slice(0, 16).toLowerCase();
      cb(null, `${Date.now()}_${randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: MAX_FILE, files: MAX_BATCH },
  defParamCharset: 'utf8', // 中文文件名防 latin1 乱码
});
function gateUpload(req, res, next) {
  const me = uid(req);
  if (!me) return res.status(401).json({ error: '请先登录' });
  const used = usedOf(me, true);
  if (used >= FOLDER_MAX) return res.status(413).json({ error: '本次待发布的项目文件夹已满 200MB，请先发布或清空重传' });
  req.upDir = userDir(me);
  mkdirSync(req.upDir, { recursive: true });
  next();
}
// 本路由的 multer 错误文案（覆盖 server.js 全局那条"≤128MB"）
function uploadErr(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `单个文件过大（≤${Math.round(MAX_FILE / 1024 / 1024)}MB）` });
    if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: `一次最多上传 ${MAX_BATCH} 个文件` });
    return res.status(400).json({ error: `上传失败：${err.message}` });
  }
  next(err);
}

// POST /api/share/uploads — multipart：files[] 文件 + paths[] 与之等长的相对路径 JSON 数组
// 返回 { rows, rejected }：rows 是暂存行（提交发帖时把 id 放进 body.files 即可绑定）
r.post('/uploads', authRequired, mutedGuard, gateUpload, upload.array('files', MAX_BATCH), uploadErr, (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: '未收到文件（字段名 files，multipart/form-data）' });
  let paths = [];
  try { paths = JSON.parse(String(req.body?.paths || '[]')); } catch { paths = []; }
  if (!Array.isArray(paths)) paths = [];

  // 配额：暂存总量（= 这一个待发项目）不得超 FOLDER_MAX，账号总量不得超 USER_QUOTA
  const batch = files.reduce((s, f) => s + (Number(f.size) || 0), 0);
  const staged = usedOf(uid(req), true);
  const total = usedOf(uid(req), false);
  if (staged + batch > FOLDER_MAX) {
    discardUploads(files);
    return res.status(413).json({ error: `项目文件夹上限 ${Math.round(FOLDER_MAX / 1024 / 1024)}MB，本次将超出` });
  }
  if (total + batch > USER_QUOTA) {
    discardUploads(files);
    return res.status(413).json({ error: `你的分享空间已满（${Math.round(USER_QUOTA / 1024 / 1024 / 1024)}GB），请删除旧项目的文件夹后重试` });
  }

  const { rows, rejected } = saveUploads(uid(req), files, paths);
  res.json({ rows, rejected });
});

// GET /api/share/files/:fid — 单文件读取（?dl=1 强制下载，否则图片/PDF/音视频/纯文本内联预览）
// 归属校验走帖子的幽灵可见性：幽灵帖的文件对普通用户一律 404（与帖子同语义，防 ID 探测）
r.get('/files/:fid', optionalAuth, (req, res) => {
  const f = readableFile(req, req.params.fid);
  if (!f) return res.status(404).json({ error: '文件不存在' });
  const abs = absPathOf(f);
  if (!abs || !existsSync(abs)) return res.status(404).json({ error: '文件已丢失' });
  if (isInlineOk(f.mime) && req.query.dl !== '1') return res.sendFile(abs);
  res.download(abs, f.name);
});

// GET /api/share/posts/:id/zip — 整包下载（文件夹原样成目录；store-only 零依赖）
r.get('/posts/:id/zip', optionalAuth, (req, res) => {
  const p = db.prepare('SELECT * FROM share_post WHERE id = ?').get(Number(req.params.id));
  if (!postVisible(req, p)) return res.status(404).json({ error: '帖子不存在' });
  const rows = db.prepare(`SELECT * FROM share_file WHERE post_id = ? AND source != 'gitee' ORDER BY path`).all(p.id);
  if (!rows.length) return res.status(404).json({ error: '这个项目还没有文件' });
  const entries = [];
  let total = 0;
  const used = new Set();
  for (const f of rows) {
    const abs = absPathOf(f);
    if (!abs || !existsSync(abs)) continue; // 磁盘缺失的跳过，不让一张坏行毁掉整包
    const buf = readFileSync(abs);
    total += buf.length;
    if (total > 400 * 1024 * 1024) return res.status(413).json({ error: '项目文件总量过大，请逐个下载' });
    // ZIP 条目名去重：同名路径（理论上不该有，DB 无唯一约束）加序号后缀，避免解压覆盖
    let name = f.path;
    if (used.has(name)) { let n = 2; while (used.has(`${name} (${n})`)) n++; name = `${name} (${n})`; }
    used.add(name);
    entries.push({ name, data: buf });
  }
  if (!entries.length) return res.status(404).json({ error: '项目文件均已丢失' });
  const zip = buildZip(entries);
  // 文件名用帖子标题（去非法字符），中文名走 RFC 5987 编码
  const fn = sanitizeName(p.title || `share-${p.id}`, 60) || `share-${p.id}`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="share-${p.id}.zip"; filename*=UTF-8''${encodeURIComponent(fn)}.zip`);
  res.send(zip);
});

// ---- Gitee 仓库文件树（公开仓库免 token 直连；SSRF 闸门见 lib/gitee.js）----
const GITEE_MAX_FILES = 500; // 单帖最多收录的文件数（大仓库只收前 500 条，如实提示）

// 重新拉取仓库树并整树替换 source='gitee' 的行。**服务端自己拉**，绝不采信客户端传来的树
// （否则任何人都能伪造任意路径塞进别人的帖子）。失败抛 GiteeError，由路由层转 400/502。
async function syncGitee(postId, repoInput, refInput) {
  const parsed = parseRepo(repoInput);
  if (!parsed) throw new GiteeError('仓库地址不合法', '支持 owner/repo 或 https://gitee.com/owner/repo');
  const ref = String(refInput || parseRefFromUrl(repoInput) || '').trim();
  const tree = await fetchTree(parsed.owner, parsed.repo, ref);
  const rows = tree.slice(0, GITEE_MAX_FILES);
  const ownerRepo = `${parsed.owner}/${parsed.repo}`;

  db.prepare(`DELETE FROM share_file WHERE post_id = ? AND source = 'gitee'`).run(postId);
  const ins = db.prepare(
    `INSERT INTO share_file (post_id, user_id, path, name, size, mime, store_name, source)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 'gitee')`
  );
  const uidOfPost = db.prepare('SELECT user_id FROM share_post WHERE id = ?').get(postId)?.user_id;
  for (const e of rows) ins.run(postId, uidOfPost, e.path, basename(e.path), e.size, mimeOf(e.path));
  return { count: rows.length, truncated: tree.length > rows.length, ownerRepo, ref };
}

// 保存帖子时的 Gitee 绑定，三态（与 files 字段同一口径，缺省一律「不动」）：
//   undefined    不动 —— 老客户端/只改标题不能把仓库连文件一起抹掉
//   ''           解绑 —— 清字段 + 删本帖 source='gitee' 的行
//   'owner/repo' 服务端自己拉一次（走 10 分钟缓存）后整树替换
// 拉取失败**不推翻这次保存**：正文已经写进去了，带 gitee_error 回去让前端提示，
// 用户可在详情页点「同步」重试（限流/断网这类瞬时故障不该让人重打一遍正文）。
async function applyGitee(postId, req) {
  if (req.body?.gitee_repo === undefined) return null;
  const repo = String(req.body.gitee_repo || '').trim();
  if (!repo) {
    db.prepare(`DELETE FROM share_file WHERE post_id = ? AND source = 'gitee'`).run(postId);
    db.prepare("UPDATE share_post SET gitee_repo = '', gitee_ref = '' WHERE id = ?").run(postId);
    return { count: 0 };
  }
  try {
    const r = await syncGitee(postId, repo, req.body?.gitee_ref);
    db.prepare('UPDATE share_post SET gitee_repo = ?, gitee_ref = ? WHERE id = ?').run(r.ownerRepo, r.ref, postId);
    return r;
  } catch (e) {
    if (!(e instanceof GiteeError)) throw e; // 非 Gitee 的意外错误照常冒泡，不吞
    return { error: e.message, hint: e.hint };
  }
}
// 把 applyGitee 的结果摊进响应体（有错就带 gitee_error，前端据此弹黄色警告）
const withGitee = (g) => (g?.error ? { gitee_error: g.error, gitee_hint: g.hint } : {});

// POST /api/share/gitee/tree — 只预览（不落库），供发帖弹窗即时显示「已拉取 N 个文件」
r.post('/gitee/tree', authRequired, async (req, res) => {
  try {
    const parsed = parseRepo(req.body?.repo);
    if (!parsed) return res.status(400).json({ error: '仓库地址不合法', hint: '支持 owner/repo 或 https://gitee.com/owner/repo' });
    const ref = String(req.body?.ref || parseRefFromUrl(req.body?.repo) || '').trim();
    const tree = await fetchTree(parsed.owner, parsed.repo, ref);
    res.json({
      repo: `${parsed.owner}/${parsed.repo}`, ref,
      count: tree.length, files: tree.slice(0, GITEE_MAX_FILES),
      truncated: tree.length > GITEE_MAX_FILES,
    });
  } catch (e) {
    if (e instanceof GiteeError) return res.status(502).json({ error: e.message, hint: e.hint });
    throw e;
  }
});

// POST /api/share/posts/:id/gitee-sync — 作者/管理员：重新拉取覆盖 source='gitee' 的行
r.post('/posts/:id/gitee-sync', authRequired, async (req, res) => {
  const p = db.prepare('SELECT * FROM share_post WHERE id = ?').get(Number(req.params.id));
  if (!postVisible(req, p)) return res.status(404).json({ error: '帖子不存在' });
  if (!canEdit(p, req)) return res.status(403).json({ error: '只有作者本人或管理员可以同步仓库' });
  const repo = String(req.body?.repo || p.gitee_repo || '').trim();
  const ref = String(req.body?.ref || p.gitee_ref || '').trim();
  if (!repo) return res.status(400).json({ error: '这个帖子还没绑定 Gitee 仓库' });
  try {
    const r = await syncGitee(p.id, repo, ref);
    db.prepare('UPDATE share_post SET gitee_repo = ?, gitee_ref = ? WHERE id = ?').run(r.ownerRepo, r.ref, p.id);
    logAudit(req, 'share-gitee-sync', r.ownerRepo, { post_id: p.id, count: r.count });
    res.json({ message: `已同步 ${r.count} 个文件`, ...r });
  } catch (e) {
    if (e instanceof GiteeError) return res.status(502).json({ error: e.message, hint: e.hint });
    throw e;
  }
});

// GET /api/share/files/:fid/raw — Gitee 条目的内容代理（浏览器不直连 gitee.com：
// 一来免却 CORS，二来**路径必须命中该帖已存的 share_file 行**，本站才不会被当成任意 Gitee 代理）
r.get('/files/:fid/raw', optionalAuth, async (req, res) => {
  const f = readableFile(req, req.params.fid);
  if (!f) return res.status(404).json({ error: '文件不存在' });
  if (f.source !== 'gitee') return res.status(400).json({ error: '这个文件不是 Gitee 条目' });
  const url = giteeUrlOf(f);
  if (!url) return res.status(404).json({ error: '该帖未绑定 Gitee 仓库' });
  try {
    const up = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'follow' });
    if (!up.ok) return res.status(502).json({ error: `Gitee 返回 ${up.status}`, hint: '仓库可能已改名/删除，或分支不存在' });
    res.setHeader('Content-Type', up.headers.get('content-type') || f.mime || 'application/octet-stream');
    const len = up.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);
    Readable.fromWeb(up.body).pipe(res);
  } catch (e) {
    res.status(502).json({ error: `读取 Gitee 文件失败：${e.message}`, hint: '稍后重试，或点「在 Gitee 打开」' });
  }
});

// 取一行文件 + 可见性校验（单文件读取/raw/text 共用；不可见一律 404 不泄露存在性）
// 私密帖的文件即使枚举到 fid 也取不出（fid 枚举防护与帖子详情同口径）。
function readableFile(req, fid) {
  const f = db.prepare(
    `SELECT f.*, p.is_ghost, p.is_public, p.user_id AS post_user_id
     FROM share_file f LEFT JOIN share_post p ON p.id = f.post_id WHERE f.id = ?`
  ).get(Number(fid));
  if (!f) return null;
  if (f.post_id && !postVisible(req, { is_ghost: f.is_ghost, is_public: f.is_public, user_id: f.post_user_id })) {
    return null;
  }
  if (!f.post_id && Number(f.user_id) !== uid(req)) return null; // 暂存文件只有本人能取
  return f;
}

// Gitee 条目的出站地址（raw 代理与文本预览共用）。路径逐段 encodeURIComponent ——
// path 虽然来自本库（同步时已消毒），但也没必要给它拼进 URL 原始形态的机会。
// 解析不出 repo 返回 null（调用方转 404）。
function giteeUrlOf(f) {
  const p = db.prepare('SELECT gitee_repo, gitee_ref FROM share_post WHERE id = ?').get(f.post_id);
  const parsed = parseRepo(p?.gitee_repo);
  if (!parsed) return null;
  const segs = String(f.path).split('/').map(encodeURIComponent).join('/');
  const ref = p.gitee_ref || 'master';
  return `${giteeRawBase()}/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/raw/${encodeURIComponent(ref)}/${segs}`;
}

// GET /api/share/files/:fid/text — 文本预览。512KB 截断（前端 <pre> 渲染，插值天然转义，绝不用 v-html）
// Gitee 条目也走这里：后端去代理，前端只认一个 URL 形状（否则预览面板要分两套取数逻辑）
r.get('/files/:fid/text', optionalAuth, async (req, res) => {
  const CAP = 512 * 1024;
  const f = readableFile(req, req.params.fid);
  if (!f) return res.status(404).json({ error: '文件不存在' });
  if (f.source === 'gitee') {
    const url = giteeUrlOf(f);
    if (!url) return res.status(404).json({ error: '该帖未绑定 Gitee 仓库' });
    try {
      const up = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'follow' });
      if (!up.ok) return res.status(502).json({ error: `Gitee 返回 ${up.status}`, hint: '仓库可能已改名/删除，或分支不存在' });
      const buf = Buffer.from(await up.arrayBuffer());
      return res.json({ text: buf.subarray(0, CAP).toString('utf8'), truncated: buf.length > CAP, size: buf.length });
    } catch (e) {
      return res.status(502).json({ error: `读取 Gitee 文件失败：${e.message}`, hint: '稍后重试，或点「在 Gitee 打开」' });
    }
  }
  const abs = absPathOf(f);
  if (!abs || !existsSync(abs)) return res.status(404).json({ error: '文件已丢失' });
  try {
    const buf = readFileSync(abs);
    const truncated = buf.length > CAP;
    res.json({ text: buf.subarray(0, CAP).toString('utf8'), truncated, size: buf.length });
  } catch (e) {
    res.status(500).json({ error: `读取失败：${e.message}` });
  }
});

// DELETE /api/share/files/:fid — 移除一个**尚未绑帖**的暂存文件（发帖弹窗里删掉刚传的文件）
// 只允许本人、只允许暂存态：已绑帖的文件要走 PUT /posts/:id 整树替换或删帖，避免绕过归属校验
r.delete('/files/:fid', authRequired, (req, res) => {
  const f = db.prepare('SELECT * FROM share_file WHERE id = ?').get(Number(req.params.fid));
  if (!f || Number(f.user_id) !== uid(req)) return res.status(404).json({ error: '文件不存在' });
  if (f.post_id) return res.status(400).json({ error: '该文件已随帖子发布，请在编辑帖子时整树替换' });
  removeFileRow(f);
  res.json({ message: '已移除' });
});

// POST /api/share/posts/:id/like — 点赞 / 取消点赞（toggle）
r.post('/posts/:id/like', authRequired, (req, res) => {
  const postId = Number(req.params.id);
  const me = uid(req);
  const exists = db.prepare('SELECT is_ghost, is_public, user_id FROM share_post WHERE id = ?').get(postId);
  if (!postVisible(req, exists)) return res.status(404).json({ error: '帖子不存在' });
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
  const exists = db.prepare('SELECT is_ghost, is_public, user_id FROM share_post WHERE id = ?').get(postId);
  if (!postVisible(req, exists)) return res.status(404).json({ error: '帖子不存在' });
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
  const exists = db.prepare('SELECT is_ghost, is_public, user_id FROM share_post WHERE id = ?').get(postId);
  if (!postVisible(req, exists)) return res.status(404).json({ error: '帖子不存在' });
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
  if (c.user_id !== me && c.post_owner !== me && !hasAdminPerm(req.user, 'content:comment')) {
    return res.status(403).json({ error: '只能删除自己的评论' });
  }
  db.prepare('DELETE FROM share_comment WHERE id = ?').run(c.id);
  res.json({ message: '已删除' });
});

export default r;
