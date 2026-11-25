// 轻量 stale-while-revalidate 缓存：按账号/页面隔离，过期数据仍可先渲染。
const PREFIX = 'ec_swr_v1:';
const DEFAULT_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

export function readCache(key, maxAge = DEFAULT_MAX_AGE) {
  try {
    const row = JSON.parse(localStorage.getItem(PREFIX + key) || 'null');
    if (!row || row.version !== 1 || !row.at) return null;
    const age = Date.now() - Number(row.at);
    if (!Number.isFinite(age) || age < 0 || age > maxAge) return null;
    return { value: row.value, at: row.at, age };
  } catch {
    return null;
  }
}

export function writeCache(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ version: 1, at: Date.now(), value }));
    return true;
  } catch {
    return false;
  }
}

export function removeCache(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* 隐私模式或存储不可用时忽略 */
  }
}
