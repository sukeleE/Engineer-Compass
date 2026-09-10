// 荣誉墙（前台只读挂在 /api/honor，后台管理挂在 /api/admin/honors）
//
// 口径：内容**只有管理员能维护**，前台**公开免登录**（荣誉墙是门面页；也正因如此出图不需要
// token —— 全站硬规矩是 session token 绝不进 URL，公开出图天然绕开 access_log 记录 originalUrl 的坑）。
//
// 元数据走 JSON、图片走独立的 multipart 端点（POST/DELETE /:id/image），**不混在一个请求里**：
//   ① multipart 里 `is_active` 这类字段一律是字符串（'true' → Number('true') = NaN），JSON 有真类型；
//   ② 「没选文件」与「传了个空的」在 multipart 里长得一模一样，拿 '' 兼职表示"删除图片"必然歧义；
//   ③ 混装会让"图传上去了但标题校验失败"变成一个说不清的中间态；拆开后第二步失败是显式可重试的。
// 于是图片三态落成三个动作：不动 = 不调 image 端点 / 删除 = DELETE / 新增替换 = POST。
import { Router } from 'express';
import multer from 'multer';
import { existsSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import db from '../db/database.js';
import { optionalAuth, authRequired, adminRequired, logAudit } from './middleware.js';
import { isInlineOk, discardUploads } from '../lib/shareFiles.js';
import {
  HONOR_DIR, MAX_IMAGE, BULK_MAX, HONOR_QUOTA, ALLOW_MIME,
  absPathOf, extOf, sniffImage, setImageOf, clearImageOf, purgeHonor,
} from '../lib/honorFiles.js';

const IMG_HINT = '仅支持 JPG/PNG/WebP/GIF/BMP 图片';

const up = multer({
  storage: multer.diskStorage({
    destination: (_q, _f, cb) => cb(null, HONOR_DIR),
    filename: (_q, f, cb) => cb(null, `${Date.now()}_${randomBytes(6).toString('hex')}${extOf(f.originalname)}`),
  }),
  // limits 用 MAX+1：busboy 在**等值**处就触发 limit，写等值会把正好 MAX 的文件误伤（resource.js/expense.js 同注释）
  limits: { fileSize: MAX_IMAGE + 1 },
  defParamCharset: 'utf8', // 不设则 multipart 里的中文文件名按 latin1 解 → originalname 乱码
});

// 路由级上传错误处理：全局 handler（server.js）把 LIMIT_FILE_SIZE 硬编码成「单文件 ≤128MB」，
// 那是资源分享的额度，对 8MB 的奖状图是错的提示。fileFilter 抛的普通 Error 也会落到这里。
function uploadErr(err, _req, res, next) {
  if (!err) return next();
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `图片过大（单张 ≤${MAX_IMAGE / 1024 / 1024}MB）` });
    if (err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error: `一次最多上传 ${BULK_MAX} 张图片` });
    return res.status(400).json({ error: `上传失败：${err.message}` });
  }
  res.status(400).json({ error: err.message || '上传失败' });
}

// 唯一的出参口：**绝不包含 store_name / image_name**（磁盘文件名不外泄）。
// image_url 里的 ?v= 是缓存键（image_ver）—— 换图后 URL 变，浏览器才会去取新图。
function publicHonor(h) {
  return {
    id: h.id,
    title: h.title,
    winner: h.winner || '',
    award_level: h.award_level || '',
    award_date: h.award_date || '',
    description: h.description || '',
    sort_order: h.sort_order || 0,
    has_image: !!h.store_name,
    image_size: h.image_size || 0,
    image_url: h.store_name ? `/api/honor/${h.id}/image?v=${h.image_ver || 0}` : '',
  };
}

const LIMITS = { winner: 40, award_level: 20, award_date: 20, description: 200 };
const strField = (v, max) => String(v ?? '').trim().slice(0, max);
const maxSort = () => db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM honor').get().m;

// ============ 前台只读（/api/honor） ============
const r = Router();
r.use(optionalAuth);

// GET /api/honor —— 上架列表（sort_order 大的在前，同值按 id 新的在前）
r.get('/', (_req, res) => {
  const list = db.prepare(
    'SELECT * FROM honor WHERE is_active = 1 ORDER BY sort_order DESC, id DESC'
  ).all().map(publicHonor);
  res.json({ list });
});

// GET /api/honor/:id/image —— 公开出图
// 「公开 / 需登录」的全部差别就是下面这一行闸门：想改成登录可见，
// 把 `!h.is_active && !req.user?.is_admin` 换成 `!req.user` 即可（前端需同步改成 blob 取图）。
r.get('/:id/image', (req, res) => {
  const h = db.prepare('SELECT id, title, store_name, image_mime, is_active FROM honor WHERE id = ?').get(Number(req.params.id));
  if (!h?.store_name) return res.status(404).json({ error: '图片不存在' });
  if (!h.is_active && !req.user?.is_admin) return res.status(404).json({ error: '图片不存在' });
  const abs = absPathOf(h);
  if (!abs || !existsSync(abs)) return res.status(404).json({ error: '图片文件已丢失，请在后台重新上传' });
  // 用嗅探时定下的 mime，不按扩展名猜；image_ver 变了 URL 才变，故可以放心 immutable
  res.type(ALLOW_MIME.has(h.image_mime) ? h.image_mime : 'image/jpeg');
  res.sendFile(abs, { maxAge: '365d', immutable: true });
});

// ============ 后台管理（/api/admin/honors） ============
// 鉴权自包含：两行写在文件内，将来谁挂这个 router 都不会漏
export const adminR = Router();
adminR.use(authRequired);
adminR.use(adminRequired);

// GET /api/admin/honors —— 全量（含下架）
adminR.get('/', (_req, res) => {
  const list = db.prepare(
    `SELECT h.*, u.username AS admin_name FROM honor h
     LEFT JOIN user u ON u.id = h.admin_id ORDER BY h.sort_order DESC, h.id DESC`
  ).all().map((h) => ({
    ...publicHonor(h),
    is_active: !!h.is_active,
    image_name: h.image_name || '', // 原始文件名，只给后台看（不是磁盘名）
    admin_name: h.admin_name || '',
    create_time: h.create_time,
  }));
  res.json({ list });
});

// POST /api/admin/honors —— 新建（只建元数据，图片另行 POST /:id/image）
adminR.post('/', (req, res) => {
  const b = req.body || {};
  const title = strField(b.title, 60);
  if (!title) return res.status(400).json({ error: '奖项名称必填（≤60 字）' });
  let sort_order;
  if (b.sort_order === undefined || b.sort_order === null || b.sort_order === '') {
    sort_order = maxSort() + 10; // 缺省排最前（DESC 口径）
  } else {
    sort_order = Number(b.sort_order);
    if (!Number.isInteger(sort_order)) return res.status(400).json({ error: '排序值必须是整数' });
  }
  const is_active = b.is_active !== undefined ? (b.is_active ? 1 : 0) : 1;
  const info = db.prepare(
    `INSERT INTO honor (title, winner, award_level, award_date, description, sort_order, is_active, admin_id)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(title, strField(b.winner, LIMITS.winner), strField(b.award_level, LIMITS.award_level),
    strField(b.award_date, LIMITS.award_date), strField(b.description, LIMITS.description),
    sort_order, is_active, req.user.id);
  const id = Number(info.lastInsertRowid);
  logAudit(req, 'honor-create', title, { id, sort_order, is_active });
  res.status(201).json({ id, message: '荣誉已添加' });
});

// PUT /api/admin/honors/:id —— 部分更新（`!== undefined` 口径：没传的字段一律不动）
adminR.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const h = db.prepare('SELECT * FROM honor WHERE id = ?').get(id);
  if (!h) return res.status(404).json({ error: '荣誉不存在' });
  const b = req.body || {};
  const title = b.title !== undefined ? strField(b.title, 60) : h.title;
  if (!title) return res.status(400).json({ error: '奖项名称必填（≤60 字）' });
  const pick = (k) => (b[k] !== undefined ? strField(b[k], LIMITS[k]) : (h[k] || ''));
  // ★ is_active / sort_order 必须显式判 undefined：写成 `b.is_active || h.is_active` 会让"下架"永远失败
  //  （0 是 falsy），与 share.js 的 tags / gitee_repo 是同一类「一个值兼职表示缺省与非法」的病
  const is_active = b.is_active !== undefined ? (b.is_active ? 1 : 0) : h.is_active;
  let sort_order = h.sort_order;
  if (b.sort_order !== undefined && b.sort_order !== null && b.sort_order !== '') {
    sort_order = Number(b.sort_order);
    if (!Number.isInteger(sort_order)) return res.status(400).json({ error: '排序值必须是整数' });
  }
  db.prepare(
    `UPDATE honor SET title = ?, winner = ?, award_level = ?, award_date = ?, description = ?,
       sort_order = ?, is_active = ?, update_time = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(title, pick('winner'), pick('award_level'), pick('award_date'), pick('description'), sort_order, is_active, id);
  logAudit(req, 'honor-update', title, { id, is_active, sort_order });
  res.json({ message: '荣誉已更新' });
});

// POST /api/admin/honors/bulk —— 批量建条（每张图一条，标题取文件名，之后再逐条补信息）
adminR.post('/bulk', up.array('images', BULK_MAX), uploadErr, (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: '请选择要上传的图片' });
  const used = db.prepare('SELECT COALESCE(SUM(image_size),0) AS n FROM honor').get().n;
  if (used + files.reduce((s, f) => s + (f.size || 0), 0) > HONOR_QUOTA) {
    discardUploads(files);
    return res.status(413).json({ error: '荣誉墙图片总量已达上限，请先删除一些旧图' });
  }
  // 先全部验完再落库：有任何一个不是图片就整体拒（避免"传 10 张成功 7 张"的半成功态）
  const mimes = files.map((f) => sniffImage(f.path));
  const bad = mimes.filter((m) => !m || !ALLOW_MIME.has(m) || !isInlineOk(m)).length;
  if (bad) {
    discardUploads(files);
    return res.status(400).json({ error: `有 ${bad} 个文件不是有效的图片（${IMG_HINT}）` });
  }
  let base = maxSort();
  files.forEach((f, i) => {
    base += 10;
    const raw = String(f.originalname || '');
    const title = basename(raw, extname(raw)).trim().slice(0, 60) || `荣誉 ${base}`;
    const info = db.prepare(
      'INSERT INTO honor (title, sort_order, is_active, admin_id) VALUES (?,?,1,?)'
    ).run(title, base, req.user.id);
    setImageOf(Number(info.lastInsertRowid), f, mimes[i]);
  });
  logAudit(req, 'honor-bulk', `${files.length} 张奖状`, { count: files.length });
  res.status(201).json({ count: files.length, message: `已创建 ${files.length} 条荣誉，请逐条补充奖项信息` });
});

// POST /api/admin/honors/:id/image —— 上传/替换奖状图（新增与替换同一个动作）
adminR.post('/:id/image', up.single('image'), uploadErr, (req, res) => {
  const id = Number(req.params.id);
  const h = db.prepare('SELECT id, title, store_name FROM honor WHERE id = ?').get(id);
  if (!h) { discardUploads([req.file]); return res.status(404).json({ error: '荣誉不存在' }); }
  if (!req.file) return res.status(400).json({ error: '请选择要上传的图片' });
  const mime = sniffImage(req.file.path);
  // 魔数不认就拒：SVG 是 XML 文本、没有魔数，天然死在这（它能在本站源下执行脚本）；
  // isInlineOk 是第二道 —— 将来有人放宽 ALLOW_MIME 时它还在
  if (!mime || !ALLOW_MIME.has(mime) || !isInlineOk(mime)) {
    discardUploads([req.file]);
    return res.status(400).json({ error: `这不是有效的图片文件（${IMG_HINT}；改了扩展名的文本/SVG 会被拒）` });
  }
  const used = db.prepare('SELECT COALESCE(SUM(image_size),0) AS n FROM honor').get().n;
  if (used + req.file.size > HONOR_QUOTA) {
    discardUploads([req.file]);
    return res.status(413).json({ error: '荣誉墙图片总量已达上限，请先删除一些旧图' });
  }
  const image_ver = setImageOf(id, req.file, mime);
  logAudit(req, 'honor-image-set', h.title, { id, mime, size: req.file.size });
  res.json({ message: '奖状图片已更新', image_ver });
});

// DELETE /api/admin/honors/:id/image —— 删除奖状图（行本身保留，退化成纯文字荣誉）
adminR.delete('/:id/image', (req, res) => {
  const id = Number(req.params.id);
  const h = db.prepare('SELECT id, title, store_name FROM honor WHERE id = ?').get(id);
  if (!h) return res.status(404).json({ error: '荣誉不存在' });
  if (!h.store_name) return res.status(400).json({ error: '这条荣誉本来就没有图片' });
  clearImageOf(id);
  logAudit(req, 'honor-image-clear', h.title, { id });
  res.json({ message: '奖状图片已删除' });
});

// DELETE /api/admin/honors/:id —— 删行 + 删盘（磁盘文件不随 DB 级联）
adminR.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const h = db.prepare('SELECT * FROM honor WHERE id = ?').get(id);
  if (!h) return res.status(404).json({ error: '荣誉不存在' });
  purgeHonor(h);
  db.prepare('DELETE FROM honor WHERE id = ?').run(id);
  logAudit(req, 'honor-delete', h.title, { id });
  res.json({ message: '荣誉已删除' });
});

export default r;
