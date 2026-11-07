// 管理员分权判断（与后端 middleware.js hasAdminPerm 对齐；仅控制入口可见，最终以后端校验为准）
// user.is_admin + user.perms：perms 为空数组 = 超级管理员（老缓存无 perms 字段同样按超管 fail-open）
export function canAdmin(key, u) {
  const user = u || null;
  if (!user || !user.is_admin) return false;
  const perms = Array.isArray(user.perms) ? user.perms : [];
  if (perms.length === 0 || perms.indexOf(key) >= 0) return true;
  if (key.indexOf(':') >= 0 && perms.indexOf(key.split(':')[0]) >= 0) return true; // 持有父 key → 子 key 放行
  if (key.indexOf(':') < 0 && perms.some((k) => k.indexOf(key + ':') === 0)) return true; // 任一子 key → 父入口放行
  return false;
}