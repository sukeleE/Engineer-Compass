// 荣誉墙·奖状图片落盘（纯 fs/db，不 import routes —— 同 lib/shareFiles.js 范式）
//
// 磁盘布局：backend/uploads/honor/{ts}_{12hex}{ext}（管理员维护、量级几十张，扁平不分子目录）
// DB 只存元数据；store_name 是**仅 basename 的磁盘名，任何接口都不返回**。
//
// 为什么把「删盘 + 改库」封成函数（setImageOf / clearImageOf / purgeHonor）：
// 磁盘文件不随 DB 外键级联消失（shareFiles.js 有同样的注释与教训）。换图/删图/删行三个清盘点
// 若散在路由里，迟早漏一个 → 永久占盘。封好之后路由侧只有一条路可走。
//
// 类型校验的权威是**文件头魔数**（sniffImage），不是扩展名、更不是客户端声明的 mimetype：
// file.mimetype 是 multipart 里客户端自己写的字符串；扩展名可以随便改。SVG 是 XML 文本、
// 没有魔数，天然被 sniffImage 拒掉 —— 它能在本站源下执行脚本，是全站硬拒的一类。
import { existsSync, mkdirSync, openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../db/database.js';
import { unlinkQuiet } from './shareFiles.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const HONOR_DIR = join(__dirname, '..', 'uploads', 'honor');
// 启动即建：uploads/ 被 gitignore，生产首次部署目录不存在，不建则第一张图 ENOENT
mkdirSync(HONOR_DIR, { recursive: true });

export const MAX_IMAGE = 8 * 1024 * 1024;                                    // 单张兜底（前端已压到 ~300KB）
export const BULK_MAX = 20;                                                  // 批量一次最多 20 张
export const HONOR_QUOTA = Number(process.env.HONOR_QUOTA) || 500 * 1024 * 1024;

// 允许的图片 mime —— 全部由 sniffImage 按魔数判定，扩展名不参与决策
export const ALLOW_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp']);

// 磁盘名：{ts}_{12hex}{ext}（与 resource.js / expense.js 完全一致）。
// 扩展名只做"看着像图"的装饰 + 下载时兜底，随便改都不影响安全（出图走 res.type(嗅探值)）
export function extOf(name) {
  const e = extname(basename(String(name || ''))).slice(0, 16).toLowerCase();
  return /^\.[a-z0-9]+$/.test(e) ? e : '.jpg';
}

// 磁盘绝对路径：basename 二次防穿越（store_name 只可能来自我们自己生成的文件名）
export function absPathOf(row) {
  if (!row?.store_name) return null;
  return join(HONOR_DIR, basename(row.store_name));
}

// 文件头魔数嗅探：只读前 16 字节（别 readFileSync 整个 8MB）。
// 返回规范 mime，或 null（不是我们认识的图片 —— 含 SVG/HTML/文本改名的假图）
export function sniffImage(abs) {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let fd;
  try {
    fd = openSync(abs, 'r');
    const buf = Buffer.alloc(16);
    const n = readSync(fd, buf, 0, 16, 0);
    if (n < 4) return null;
    const b = buf.subarray(0, n);
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 8 && b.subarray(0, 8).equals(PNG)) return 'image/png';
    const six = b.subarray(0, 6).toString('latin1');
    if (six === 'GIF87a' || six === 'GIF89a') return 'image/gif';
    if (b.length >= 12
      && b.subarray(0, 4).toString('latin1') === 'RIFF'
      && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// 写入图片四元组（store_name/mime/size/ver）。返回新的 image_ver；调用方负责已嗅探通过。
// **必须先写库、再删旧图** —— 顺序反了的话，更新失败就新旧两张都没了。
export function setImageOf(id, file, mime) {
  const old = db.prepare('SELECT store_name FROM honor WHERE id = ?').get(Number(id));
  const ver = randomBytes(4).toString('hex');
  db.prepare(
    `UPDATE honor SET image_name = ?, store_name = ?, image_size = ?, image_mime = ?,
       image_ver = ?, update_time = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(String(file.originalname || ''), basename(file.filename), Number(file.size) || 0, mime, ver, Number(id));
  if (old?.store_name && old.store_name !== file.filename) unlinkQuiet(absPathOf(old));
  return ver;
}

// 去掉某一行的图（删盘 + 清空元数据）；不影响行本身（纯文字荣誉是合法状态）
export function clearImageOf(id) {
  const old = db.prepare('SELECT store_name FROM honor WHERE id = ?').get(Number(id));
  if (!old) return false;
  db.prepare(
    `UPDATE honor SET image_name = NULL, store_name = NULL, image_size = 0, image_mime = '',
       image_ver = NULL, update_time = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(Number(id));
  unlinkQuiet(absPathOf(old));
  return true;
}

// 删行前调（磁盘文件不随 DB 级联）：只删盘
export function purgeHonor(row) {
  unlinkQuiet(absPathOf(row));
}

// 兜「已落盘但写库失败」的孤儿文件（配额校验不过、进程被杀在中间）。
// 判据：文件不在 DB 的 store_name 集合里 + mtime 超过宽限期 —— 只靠前者会误删正在上传的临时文件。
export function sweepOrphanHonorFiles(hours = 24) {
  let names;
  try { names = readdirSync(HONOR_DIR); } catch { return 0; }
  const known = new Set(
    db.prepare('SELECT store_name FROM honor WHERE store_name IS NOT NULL').all().map((r) => r.store_name)
  );
  const cut = Date.now() - hours * 3600 * 1000;
  let n = 0;
  for (const name of names) {
    if (known.has(name)) continue;
    const abs = join(HONOR_DIR, name);
    try {
      const st = statSync(abs);
      if (!st.isFile() || st.mtimeMs > cut) continue;
    } catch { continue; }
    unlinkQuiet(abs);
    n += 1;
  }
  return n;
}

export { unlinkQuiet };
