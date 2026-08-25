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

// 附件 dataURL（base64 预览）
export const attDataURL = (a) => (a?.data ? `data:${a.mime};base64,${a.data}` : '');
