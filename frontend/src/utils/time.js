// 时间工具：SQLite CURRENT_TIMESTAMP 存 UTC（'YYYY-MM-DD HH:MM:SS'，无时区标记），
// 前端若直接显示原始串会差 8 小时（UTC vs 北京时间）。解析时必须补 'Z' 转本地时区。
const pad2 = (n) => String(n).padStart(2, '0');

// UTC 字符串/ISO → 本地 Date（无时区标记的 'YYYY-MM-DD HH:MM:SS' 补 Z，避免被当本地时间解析）
export const toLocal = (t) => {
  if (t === null || t === undefined || t === '') return null;
  const s = String(t);
  const d = new Date(s.endsWith('Z') || s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return isNaN(d) ? null : d;
};

// 本地 'YYYY-MM-DD HH:MM'
export const fmtDateTime = (t) => {
  const d = toLocal(t);
  if (!d) return t || '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

// 本地 'YYYY-MM-DD HH:MM:SS'（服务器状态等需精确到秒）
export const fmtDateTimeS = (t) => {
  const d = toLocal(t);
  if (!d) return t || '';
  return `${fmtDateTime(t)}:${pad2(d.getSeconds())}`;
};

// 本地 'YYYY-MM-DD'（纯日期）
export const fmtDateOnly = (t) => {
  const d = toLocal(t);
  if (!d) return t || '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

// 本地 'MM-DD HH:MM'（消息气泡等短格式）
export const fmtShort = (t) => fmtDateTime(t).slice(5);
