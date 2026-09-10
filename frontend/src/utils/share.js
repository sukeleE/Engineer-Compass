// 资源分享帖子工具：计数 / HTML 摘要 / 附件解析 / 首图提取
// 分享页与「我的/收藏」列表共用，避免两处重复实现

export const cnt = (n) => n ?? 0;

export const excerpt = (html, n = 90) => {
  const text = String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > n ? text.slice(0, n) + '…' : text;
};

// 解析 attachments 字段（字符串 JSON 或已解析数组），解析失败返回 []
export const atts = (p) => {
  try {
    const a = typeof p.attachments === 'string' ? JSON.parse(p.attachments) : p.attachments;
    return Array.isArray(a) ? a : [];
  } catch { return []; }
};

// 帖子的第一张图片附件（列表缩略图用），无图返回 null
export const firstImage = (p) => atts(p).find((a) => String(a.mime || '').startsWith('image/')) || null;

// 附件展示 URL：base64 内嵌（data）或引用型公开分享链接（url，我的资源引用）
export const attDataURL = (a) => (a?.data ? `data:${a.mime};base64,${a.data}` : a?.url || '');

// 帖子「类型」→ 决定文件表格首列选哪个图标（GitHub 文件列表风）。看首个附件：
// 图片/视频/音频/压缩包/外链各归一档，其余（含纯文字帖、文档类附件）都是 file。
// 依据优先级：mime > 引用型 url（我的资源引用 / 飞书云盘）> 扩展名兜底（历史数据 mime 可能为空）。
const ARCHIVE_EXT = /\.(zip|rar|7z|tar|gz|bz2|xz)$/i;
export const postKind = (p) => {
  const a = atts(p)[0];
  if (!a) return 'file';
  const mime = String(a.mime || '');
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (a.url) return 'link'; // 引用型附件（我的资源分享链接 / 飞书文档）——点开是页面不是文件
  const name = String(a.name || '');
  if (/\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(name)) return 'image';
  if (/\.(mp4|mov|webm|avi|mkv)$/i.test(name)) return 'video';
  if (/\.(mp3|wav|flac|aac|m4a|ogg)$/i.test(name)) return 'audio';
  if (ARCHIVE_EXT.test(name)) return 'archive';
  return 'file';
};

// postKind → GhIcon 的图标名
export const KIND_ICON = {
  image: 'file-media', video: 'video', audio: 'audio',
  archive: 'file-zip', link: 'link', file: 'file',
};
