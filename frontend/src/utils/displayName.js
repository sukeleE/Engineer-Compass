// 三模块（资源预约/经费报销/物料采购）统一署名：真名（昵称）；无真名回退昵称/用户名/快照名。
// 与后端 middleware.js displayNameOf 同口径。对象上的名字段可能叫 nickname / user_name（快照）。
// 昵称已包含真名时（如昵称本身是「张玉磊（284806020）」，信息更全）直接显示昵称，避免双层嵌套。
import auth from '../auth.js';

export const displayName = (u) => {
  if (!u) return '';
  const rn = String(u.real_name || '').trim();
  const nick = String(u.nickname ?? u.user_name ?? u.username ?? '').trim();
  if (!rn) return nick;
  if (!nick || rn === nick || nick.includes(rn)) return nick || rn;
  return `${rn}（${nick}）`;
};

// 项目小组内展示名：命中「当前登录用户自己」时按统一口径补显实名「真名（昵称）」；
// 他人保持原昵称/快照名不变（小组接口不回传他人 real_name，也不扩大暴露面）。
// fallbackKey 用于 uploader/user_name/assignee_name 等非 nickname 快照字段。
export const selfName = (obj, meId, fallbackKey = 'nickname') => {
  const base = obj?.[fallbackKey] ?? obj?.nickname ?? obj?.user_name ?? obj?.username ?? '';
  const id = obj?.id ?? obj?.user_id ?? null;
  if (meId == null || !obj || id == null || Number(id) !== Number(meId) || !auth.user?.real_name) return base;
  return displayName({
    real_name: auth.user.real_name,
    nickname: obj.nickname ?? auth.user.nickname,
    username: obj.username ?? auth.user.username,
  });
};
