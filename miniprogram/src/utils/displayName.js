// 小组内展示名工具，与 H5 版 frontend/src/utils/displayName.js 同口径
// displayName：真名（昵称）；无真名回退昵称/用户名；昵称已含真名时不重复嵌套
// teamDisplayName：按作者 user_id 在当前小组成员名单中解析，同组互见「真名（昵称）」；
// 已退组成员的历史记录匹配不到名单时回退快照名（自己仍可补显实名）
import auth from './auth.js';

export function displayName(u) {
  if (!u) return '';
  const rn = String(u.real_name || '').trim();
  const nick = String(u.nickname ?? u.user_name ?? u.username ?? '').trim();
  if (!rn) return nick;
  if (!nick || rn === nick || nick.indexOf(rn) !== -1) return nick || rn;
  return rn + '（' + nick + '）';
}

export function teamDisplayName(obj, members, fallbackKey = 'nickname') {
  if (!obj) return '';
  const uid = obj.user_id ?? obj.assignee_id ?? obj.uploader_id ?? obj.uid ?? obj.id ?? null;
  if (uid != null && Array.isArray(members)) {
    const member = members.find((m) => Number(m.user_id ?? m.id) === Number(uid));
    if (member) return displayName(member);
  }
  const base = obj[fallbackKey] ?? obj.nickname ?? obj.user_name ?? obj.uploader ?? obj.assignee_name ?? obj.username ?? '';
  if (uid == null || !auth.user || Number(uid) !== Number(auth.user.id) || !auth.user.real_name) return base;
  return displayName({
    real_name: auth.user.real_name,
    nickname: obj.nickname ?? auth.user.nickname,
    username: obj.username ?? auth.user.username,
  });
}