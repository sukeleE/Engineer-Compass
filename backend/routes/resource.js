// 个人资源库（挂载 /api/resource）：用户上传 ≤128MB 文件到个人资源
// 文件落盘 backend/uploads/resource/{userId}/，DB（user_resource）只存元数据；
// 下载走带鉴权路由 res.download（支持 ?token= 直连，与小组文件同机制）
import { Router } from 'express';
import multer from 'multer';
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import db from '../db/database.js';
import { authRequired, mutedGuard, logAudit } from './middleware.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const RESOURCE_DIR = join(__dirname, '..', 'uploads', 'resource');
export const MAX_FILE = 128 * 1024 * 1024;                       // 单文件 128MB
export const QUOTA = Number(process.env.RESOURCE_QUOTA) || 1024 * 1024 * 1024; // 每用户 1GB（环境变量可覆盖，便于测试）

mkdirSync(RESOURCE_DIR, { recursive: true }); // 启动即建根目录

const storage = multer.diskStorage({
  // 按用户 id 分子目录（随用随建）
  destination(req, file, cb) {
    mkdirSync(join(RESOURCE_DIR, String(req.user.id)), { recursive: true });
    cb(null, join(RESOURCE_DIR, String(req.user.id)));
  },
  // 磁盘名与原始文件名解耦（时间戳+随机串），防重名/路径注入；仅保留安全扩展名
  filename(req, file, cb) {
    const ext = extname(basename(String(file.originalname || ''))).slice(0, 16).toLowerCase();
    cb(null, `${Date.now()}_${randomBytes(6).toString('hex')}${ext}`);
  },
});
// busboy 在 fileSize === limit 时即触发 limit（恰好等于 limit 的文件被拒），故 limit 放宽 1 字节
// 实现语义：≤128MB 接受（业务上 MAX_FILE 仍为 128MB，配额/前端提示不变），>128MB 拒绝
const upload = multer({ storage, limits: { fileSize: MAX_FILE + 1 } });

const r = Router();
r.use(authRequired);

// 上传（mutedGuard 在 multer 之前：被禁言者不落盘；响应 413 由 server.js 全局错误处理转中文）
r.post('/upload', mutedGuard, upload.single('file'), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: '未收到文件，请以 multipart/form-data 上传（字段名 file）' });
  const clean = () => { try { unlinkSync(file.path); } catch {} };
  if (file.size === 0) { clean(); return res.status(400).json({ error: '文件为空' }); }
  const used = db.prepare('SELECT COALESCE(SUM(file_size),0) AS n FROM user_resource WHERE user_id = ?').get(req.user.id).n;
  if (used + file.size > QUOTA) {
    clean();
    return res.status(413).json({ error: `个人资源配额不足（上限 ${QUOTA / 1024 / 1024 / 1024}GB，已用 ${(used / 1024 / 1024).toFixed(1)}MB）` });
  }
  const name = basename(String(file.originalname || '')).slice(0, 255) || '未命名文件';
  try {
    const info = db.prepare('INSERT INTO user_resource (user_id, file_name, file_size, file_type, store_path) VALUES (?,?,?,?,?)')
      .run(req.user.id, name, file.size, file.mimetype || null, basename(file.filename));
    logAudit(req, 'resource-upload', name, { rid: info.lastInsertRowid, size: file.size });
    res.status(201).json({ id: info.lastInsertRowid, file_name: name, file_size: file.size, message: '上传成功' });
  } catch (e) {
    clean();
    throw e;
  }
});

// 我的资源列表（含已用配额，前端画配额条）
r.get('/', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(100, Math.max(1, Number(req.query.size) || 20));
  const uid = req.user.id;
  const total = db.prepare('SELECT COUNT(*) AS n FROM user_resource WHERE user_id = ?').get(uid).n;
  const used = db.prepare('SELECT COALESCE(SUM(file_size),0) AS n FROM user_resource WHERE user_id = ?').get(uid).n;
  const list = db.prepare(
    `SELECT id, file_name, file_size, file_type, create_time FROM user_resource
     WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(uid, size, (page - 1) * size);
  res.json({ total, page, size, used, quota: QUOTA, list });
});

// 下载（?token= 直连复用 middleware 的 query token 机制；res.download 自动处理 Content-Type/UTF-8 文件名）
r.get('/:id/download', (req, res) => {
  const f = db.prepare('SELECT * FROM user_resource WHERE id = ?').get(Number(req.params.id));
  if (!f) return res.status(404).json({ error: '资源不存在' });
  if (f.user_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: '无权下载该资源' });
  if (basename(f.store_path) !== f.store_path) return res.status(404).json({ error: '资源不存在' }); // 防路径穿越
  const abs = join(RESOURCE_DIR, String(f.user_id), f.store_path);
  if (!existsSync(abs)) return res.status(404).json({ error: '文件已丢失，请联系管理员' });
  res.download(abs, f.file_name);
});

// 删除（本人或管理员；admin.js 复用同逻辑，审计按身份记不同 action）
export function deleteResource(req, res, id) {
  const f = db.prepare('SELECT * FROM user_resource WHERE id = ?').get(id);
  if (!f) return res.status(404).json({ error: '资源不存在' });
  if (f.user_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: '仅资源所有者或管理员可删除' });
  const abs = join(RESOURCE_DIR, String(f.user_id), f.store_path);
  try { if (existsSync(abs)) unlinkSync(abs); } catch { return res.status(500).json({ error: '文件删除失败' }); }
  db.prepare('DELETE FROM user_resource WHERE id = ?').run(id);
  logAudit(req, req.user.is_admin ? 'resource-admin-delete' : 'resource-delete', f.file_name, { rid: id, size: f.file_size });
  res.json({ message: '资源已删除' });
}
r.delete('/:id', (req, res) => deleteResource(req, res, Number(req.params.id)));

export default r;
