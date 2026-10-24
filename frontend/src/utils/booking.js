// 资源预约模块共享工具：两类资源元数据（item 物品 / space 空间）、朴素北京时间串解析（绝不补 Z）、甘特列定位
export const KINDS = [
  { key: 'item', label: '物品资源', icon: '📦', space: false },
  { key: 'space', label: '空间资源', icon: '🏢', space: true },
];
export const KIND_MAP = Object.fromEntries(KINDS.map((k) => [k.key, k]));
export const SPACE_KINDS = new Set(KINDS.filter((k) => k.space).map((k) => k.key));

export const MODE_ZH = { approval: '需审批', first_come: '先到先得' };
export const STATUS_META = {
  pending: { label: '待审批', type: 'warning' },
  confirmed: { label: '已确认', type: 'success' },
  rejected: { label: '已驳回', type: 'info' },
  canceled: { label: '已取消', type: 'info' },
};

// 拍照快速借用登记（写在预约模块里的零时长记录，不进甘特）：item_kind=device / room
export const REG_KIND_META = {
  device: { label: '设备登记', icon: '📦' },
  room: { label: '教室登记', icon: '🏫' },
};
export const isRegBooking = (b) => !!b && (b.item_kind === 'device' || b.item_kind === 'room');
export const regTitle = (b) => (b && (b.item_name || b.resource_name)) || '借用登记';

export const OPEN_HH = 7;
export const CLOSE_HH = 22;
export const SLOT_MIN = 30;
export const SLOTS_PER_DAY = (CLOSE_HH - OPEN_HH) * 2; // 30 格

const p2 = (n) => String(n).padStart(2, '0');
// 本地墙上时钟 → 'YYYY-MM-DD HH:MM'（与后端约定的朴素串，禁止 toLocal/ISO 补时区）
export function fmtSlot(d) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
export function fmtDate(d) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
export function parseLocal(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(String(s || ''));
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
}
export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
export function mondayOf(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
// 一天的 30 分刻度选项：起 07:00..21:30 / 止 07:30..22:00
export function timeOptions(which) {
  const out = [];
  const lastStart = which === 'start' ? 21 * 60 + 30 : 22 * 60;
  for (let m = OPEN_HH * 60; m <= lastStart; m += SLOT_MIN) {
    out.push(`${p2(Math.floor(m / 60))}:${p2(m % 60)}`);
  }
  return out;
}
// 时长中文标签（90分钟/2.5小时/3天2小时）
export function durationLabel(startStr, endStr) {
  const s = parseLocal(startStr);
  const e = parseLocal(endStr);
  if (!s || !e || e <= s) return '';
  const mins = Math.round((e - s) / 60000);
  if (mins < 60) return `${mins}分钟`;
  const days = Math.floor(mins / 1440);
  const hours = (mins % 1440) / 60;
  if (days && hours) return `${days}天${Number.isInteger(hours) ? hours : hours.toFixed(1)}小时`;
  if (days) return `${days}天`;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}小时`;
}

// 甘特列号：col = 天序*30 + (分钟-420)/30；跨天夜段（22:00→次日07:00）折叠在日界线两侧连续渲染
export function colOf(slotStr, fromDate, days) {
  const d = parseLocal(slotStr);
  if (!d) return 0;
  const day0 = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
  const dayDiff = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - day0) / 86400000);
  const col = dayDiff * SLOTS_PER_DAY + (d.getHours() * 60 + d.getMinutes() - OPEN_HH * 60) / SLOT_MIN;
  return Math.max(0, Math.min(days * SLOTS_PER_DAY, col));
}
