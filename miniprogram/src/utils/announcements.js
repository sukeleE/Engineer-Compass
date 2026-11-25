// 公告已读状态（本地 storage）：横幅、消息中心「公告」归档、悬浮窗未读共用
const READ_KEY = 'ec_announcement_reads';
const LEGACY_PREFIX = 'ec_announcement_dismissed_';
const MAX_ENTRIES = 300;

function readMap() {
  try {
    const v = uni.getStorageSync(READ_KEY);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function saveMap(map) {
  const entries = Object.entries(map)
    .filter(([, at]) => Number.isFinite(Number(at)))
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, MAX_ENTRIES);
  try { uni.setStorageSync(READ_KEY, Object.fromEntries(entries)); } catch { /* 忽略 */ }
}

export function isAnnouncementRead(id) {
  if (!id) return false;
  const map = readMap();
  if (map[id]) return true;
  // 兼容旧版：之前关闭横幅/弹窗时写入的是按 id 拆分的 key
  try { return !!uni.getStorageSync(LEGACY_PREFIX + id); } catch { return false; }
}

export function markAnnouncementRead(id) {
  if (!id) return;
  const map = readMap();
  map[id] = Date.now();
  saveMap(map);
  // 通知所有已挂载的公告横幅立即撤掉（各 tab 常驻组件）
  try { uni.$emit('announcement:read', Number(id)); } catch { /* 忽略 */ }
}

export function countUnreadAnnouncements(list) {
  return (Array.isArray(list) ? list : []).filter((a) => a && !isAnnouncementRead(a.id)).length;
}
