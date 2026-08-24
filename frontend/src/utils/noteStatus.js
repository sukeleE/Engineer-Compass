// 日程笔记学习状态定义（后端存 key，前端映射展示/着色）与通用格式化

export const NOTE_STATUS = [
  { key: 'good', label: '进展顺利', emoji: '✅', color: '#16a34a' },
  { key: 'hard', label: '遇到困难', emoji: '⚠️', color: '#d97706' },
  { key: 'slow', label: '进度缓慢', emoji: '🐢', color: '#f59e0b' },
  { key: 'none', label: '未学习', emoji: '💤', color: '#94a3b8' },
];

export const statusOf = (key) => NOTE_STATUS.find((s) => s.key === key) || null;

// 富文本 HTML → 纯文本摘要（回看列表用）
export const excerpt = (html, len = 36) => {
  if (!html) return '';
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent || '').trim().slice(0, len) || '（空白笔记）';
};

export const pad2 = (n) => String(n).padStart(2, '0');

// 本地时区 YYYY-MM-DD（toISOString 是 UTC，会差一天，必须手拼）
export const fmtDate = (d) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
