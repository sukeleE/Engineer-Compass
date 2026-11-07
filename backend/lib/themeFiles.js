// 个性化壁纸落盘（同 purchaseFiles/honorFiles 范式：DB 只存文件名，实体在磁盘）
// 布局：uploads/wallpapers/<userId>_<ts>_<6hex>.jpg；用户重新上传/清除时删旧文件，防占盘
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, basename, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const WALLPAPER_ROOT = process.env.WALLPAPER_DIR
  ? join(process.env.WALLPAPER_DIR)
  : join(__dirname, '..', 'uploads', 'wallpapers');

try { mkdirSync(WALLPAPER_ROOT, { recursive: true }); }
catch (e) { console.error(`⚠️ 壁纸目录不可用（${WALLPAPER_ROOT}）：${e.message}`); }

export const WALLPAPER_MAX = 6 * 1024 * 1024; // 单图 ≤6MB（前端已先压缩）
const ALLOW_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

export function storeWallpaperName(userId, origName) {
  const ext = extname(basename(String(origName || ''))).toLowerCase();
  const safeExt = ALLOW_EXT.has(ext) ? ext : '.jpg';
  return `${userId}_${Date.now()}_${randomBytes(6).toString('hex')}${safeExt}`;
}

export function wallpaperPath(storeName) {
  // basename 防目录穿越
  return join(WALLPAPER_ROOT, basename(String(storeName || '')));
}

export function wallpaperExists(storeName) {
  const name = basename(String(storeName || ''));
  return !!name && existsSync(join(WALLPAPER_ROOT, name));
}

export function unlinkWallpaperQuiet(storeName) {
  if (!storeName) return;
  const name = basename(String(storeName));
  try { if (existsSync(join(WALLPAPER_ROOT, name))) unlinkSync(join(WALLPAPER_ROOT, name)); }
  catch (e) { /* 占盘清理尽力而为 */ }
}

// 文件名归属校验：前缀 <userId>_ ，用户只能读自己的壁纸
export function belongsToUser(storeName, userId) {
  const name = basename(String(storeName || ''));
  return new RegExp(`^${Number(userId)}_`).test(name);
}

export function wallpaperMime(storeName) {
  const ext = extname(String(storeName || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}