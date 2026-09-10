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

// 相对时间（GitHub 文件表「3 天前」风）：刚刚 / N 分钟前 / N 小时前 / N 天前 / N 个月前，
// 超过一年回落成绝对日期。**必须经 toLocal()** —— 后端存的是无时区标记的 UTC 串，
// 裸 new Date('2026-09-10 08:00:00') 会被浏览器当本地时间，结果整整差 8 小时（见本文件 L1-2）。
export const fmtRelative = (t) => {
  const d = toLocal(t);
  if (!d) return t || '';
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return '刚刚';                       // 含轻微时钟偏差导致的负数
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
  if (sec < 86400 * 30) return `${Math.floor(sec / 86400)} 天前`;
  if (sec < 86400 * 365) return `${Math.floor(sec / 86400 / 30)} 个月前`;
  return fmtDateOnly(t);
};
