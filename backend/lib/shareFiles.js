// 资源分享·项目文件夹：落盘 + 元数据（一条帖子 = 一个项目）
//
// 磁盘布局：backend/uploads/share/{user_id}/{ts}_{12hex}{ext}
// DB 只存元数据（path/size/mime/store_name），**目录树由 path 前缀推导**，不存目录行。
//
// 为什么另立 share_file 表而不是复用 share_post.attachments：
// 附件是 base64 内联进 JSON，且列表查询会整列 SELECT 出来 —— 几百个文件的项目会让列表页直接爆掉；
// 文件夹必须走 multipart 落盘（express.json 的 30mb 上限也扛不住 200MB 的目录）。
//
// 安全边界：`path` 只进 DB 与 ZIP 条目名，**绝不参与磁盘路径**（磁盘名一律 {ts}_{12hex}{ext}），
// 所以穿越由两道兜：入库前 sanitizeRelPath 拒 `..`，出库后 basename 校验（同 resource.js 手法）。
import { existsSync, unlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../db/database.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SHARE_DIR = join(__dirname, '..', 'uploads', 'share');

// 额度：单帖文件夹 200MB / 单用户 2GB / 单文件 30MB / 单请求 10 个文件
// （客户端按目录递归、分批 multipart 上传；服务端每次请求都独立校验）
export const FOLDER_MAX = Number(process.env.SHARE_FOLDER_MAX) || 200 * 1024 * 1024;
export const USER_QUOTA = Number(process.env.SHARE_QUOTA) || 2 * 1024 * 1024 * 1024;
export const MAX_FILE = 30 * 1024 * 1024;
export const MAX_BATCH = 10;

export const userDir = (userId) => join(SHARE_DIR, String(userId));

// 相对路径消毒：统一分隔符、拒 `..`、逐段限长、总长限 400。
// 返回规范化的 'a/b/c.txt'，或 null（拒收该文件）。
export function sanitizeRelPath(raw) {
  let s = String(raw ?? '').replace(/\\/g, '/');
  if (!s || s.includes('\0')) return null;
  s = s.replace(/^\/+/, '');
  const parts = s.split('/').filter((x) => x !== '' && x !== '.');
  if (!parts.length || parts.length > 20) return null;
  for (const p of parts) {
    if (p === '..' || p.length > 100) return null; // 段内超过 100 字（含超长中文名）直接拒
  }
  const out = parts.join('/');
  return out.length > 400 ? null : out;
}

// 某行的绝对磁盘路径。store_name 一律经 basename 兜底：即使 DB 被写脏也出不了 SHARE_DIR
export function absPathOf(row) {
  if (!row?.store_name || row.source === 'gitee') return null;
  return join(userDir(row.user_id), basename(row.store_name));
}

export function unlinkQuiet(abs) {
  try { if (abs && existsSync(abs)) unlinkSync(abs); } catch { /* 删不掉不阻断（磁盘残留由 sweep 兜） */ }
}

// 配额校验失败时把 multer 已落盘的一批文件全丢掉（f.path 是 multer 给的真实磁盘路径）
export function discardUploads(files) {
  for (const f of files || []) unlinkQuiet(f?.path);
}

// 单文件落盘后插暂存行（post_id NULL）。文件已由 multer 写进 userDir，这里只校验 + 记账。
// files/paths 下标对齐；路径非法的文件直接从盘上删掉并计入 rejected，不插行。
export function saveUploads(userId, files, paths) {
  const rows = [];
  const rejected = [];
  const ins = db.prepare(
    `INSERT INTO share_file (post_id, user_id, path, name, size, mime, store_name, source)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, 'upload')`
  );
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const rawRel = paths[i] ?? f.originalname;
    const rel = sanitizeRelPath(rawRel);
    if (!rel) {
      unlinkQuiet(f.path);
      rejected.push({ path: String(rawRel ?? '').slice(0, 120), reason: '路径非法（含 .. 或超长）' });
      continue;
    }
    const size = Number(f.size) || 0;
    const mime = mimeOf(rel);
    const info = ins.run(userId, rel, basename(rel), size, mime, basename(f.path));
    rows.push(db.prepare('SELECT * FROM share_file WHERE id = ?').get(Number(info.lastInsertRowid)));
  }
  return { rows, rejected };
}

// 扩展名 → mime。刻意不走 expenseMeta.mimeByExt（那张表只认图片/PDF，其余一律 octet-stream），
// 这里是「在线预览」的判据，需要覆盖文本/代码/音视频。
// 注意：预览的最终分流在前端 utils/share.js（按扩展名判文本），此处只给浏览器一个像样的 Content-Type。
const EXT_MIME = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', log: 'text/plain', ini: 'text/plain', cfg: 'text/plain',
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  json: 'application/json', xml: 'application/xml', yml: 'text/yaml', yaml: 'text/yaml',
  py: 'text/x-python', java: 'text/x-java', c: 'text/x-c', h: 'text/x-c', cpp: 'text/x-c++', cs: 'text/plain',
  ts: 'text/plain', tsx: 'text/plain', jsx: 'text/plain', go: 'text/plain', rs: 'text/plain', sql: 'text/plain',
  sh: 'text/x-sh', bat: 'text/plain', ps1: 'text/plain', m: 'text/plain', r: 'text/plain',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar', gz: 'application/gzip',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
export function mimeOf(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  return EXT_MIME[ext] || 'application/octet-stream';
}

// 安全内联白名单：图片/PDF/音视频/纯文本可以直接在 <img>/<iframe>/<audio>/<video> 里渲染。
// **html/svg 不在其内** —— 它们能在本站源下执行脚本/带 cookie 请求，一律走附件下载。
const INLINE_OK = /^(image\/(?!svg)|application\/pdf|audio\/|video\/|text\/plain|text\/markdown|text\/csv)/;
export function isInlineOk(mime) {
  return INLINE_OK.test(String(mime || ''));
}

// 单行删除（附件替换/单文件移除用）
export function removeFileRow(row) {
  unlinkQuiet(absPathOf(row));
  db.prepare('DELETE FROM share_file WHERE id = ?').run(row.id);
}

// 删某帖的全部磁盘文件 + 行。**删帖（含 admin.js 里的那条）必须先调它** ——
// share_file 行会随外键级联消失，但磁盘文件不会，漏调就是永久占盘。
export function purgePostFiles(postId) {
  const rows = db.prepare('SELECT id, user_id, store_name, source FROM share_file WHERE post_id = ?').all(postId);
  for (const row of rows) unlinkQuiet(absPathOf(row));
  db.prepare('DELETE FROM share_file WHERE post_id = ?').run(postId);
  return rows.length;
}

// 只清「上传」来的文件，保留 source='gitee' 的行。
// PUT /posts 的 files 字段是「上传文件夹整树替换」语义，但 Gitee 树由 gitee_repo 字段单独管
// ——两者各管各的，改上传不会顺手把仓库文件清空（反之亦然）。
export function purgeUploads(postId) {
  const rows = db.prepare("SELECT id, user_id, store_name FROM share_file WHERE post_id = ? AND source != 'gitee'").all(postId);
  for (const row of rows) unlinkQuiet(absPathOf(row));
  db.prepare("DELETE FROM share_file WHERE post_id = ? AND source != 'gitee'").run(postId);
  return rows.length;
}

// 清理超期的未绑定暂存行（用户传完文件夹又关掉弹窗，行永远绑不上帖）。
// 24h 宽限：正常填写/预览都在一次会话内完成。server.js 启动时调一次。
export function sweepStaging(hours = 24) {
  const cut = `-${hours} hours`;
  const rows = db.prepare(
    `SELECT id, user_id, store_name, source FROM share_file
     WHERE post_id IS NULL AND source = 'upload' AND create_time < datetime('now', 'localtime', ?)`
  ).all(cut);
  for (const row of rows) unlinkQuiet(absPathOf(row));
  if (rows.length) db.prepare('DELETE FROM share_file WHERE id IN (' + rows.map(() => '?').join(',') + ')').run(...rows.map((r) => r.id));
  return rows.length;
}

// 某用户占用：stagedOnly=true 只算未绑帖的暂存行（= 一次待发项目的体积，用于 FOLDER_MAX），
// 否则算全部文件（用于 USER_QUOTA）
export function usedOf(userId, stagedOnly = false) {
  const sql = stagedOnly
    ? 'SELECT COALESCE(SUM(size),0) AS n FROM share_file WHERE user_id = ? AND post_id IS NULL'
    : 'SELECT COALESCE(SUM(size),0) AS n FROM share_file WHERE user_id = ?';
  return db.prepare(sql).get(userId).n;
}
