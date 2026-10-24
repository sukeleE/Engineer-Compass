// 全站管理员分权工具（与后端 middleware.js ADMIN_PERMS 对应）
// user.perms=[] 且 is_admin → 超级管理员（全权）；非空数组 → 仅授权模块；
// 老缓存没有 perms 字段时按超管口径 fail-open（路由守卫会 me() 刷新，最终以后端为准）
import auth from '../auth.js';

export const PERM_LABELS = {
  user: '用户管理',
  content: '内容管理',
  competition: '竞赛审核',
  announce: '公告管理',
  honor: '荣誉墙',
  resource: '资源管理',
  feedback: '用户反馈',
  log: '日志审计',
  server: '服务器状态',
};

// 权限分配弹窗的展示顺序
export const PERM_OPTIONS = [
  { key: 'user', label: '👤 用户管理', desc: '封禁/禁言、用户列表与详情、改密与实名提醒' },
  { key: 'content', label: '📄 内容管理', desc: '删除资源分享区的帖子与评论' },
  { key: 'competition', label: '🧠 竞赛审核', desc: 'AI 收录竞赛的采纳/拒绝（AI 收录管理端）' },
  { key: 'announce', label: '📢 公告管理', desc: '全站公告的发布与编辑' },
  { key: 'honor', label: '🏅 荣誉墙', desc: '荣誉条目与奖状图片维护' },
  { key: 'resource', label: '📁 资源管理', desc: '查看/删除任意用户上传的资源' },
  { key: 'feedback', label: '📮 用户反馈', desc: '查看与删除用户反馈' },
  { key: 'log', label: '🧾 日志审计', desc: '操作日志与访问记录' },
  { key: 'server', label: '🖥️ 服务器状态', desc: '服务器运行状态面板' },
];

export function adminPerms(u = auth.user) {
  if (!u?.is_admin) return [];
  return Array.isArray(u.perms) ? u.perms.filter((k) => k in PERM_LABELS) : [];
}

export function isSuperAdmin(u = auth.user) {
  return !!u?.is_admin && adminPerms(u).length === 0;
}

// 模块权限判断：超管全权；受限管理员需显授权；非管理员 false
export function canAdmin(key, u = auth.user) {
  if (!u?.is_admin) return false;
  const perms = adminPerms(u);
  return perms.length === 0 || perms.includes(key);
}

// 权限概要文案（表格标签/详情用）
export function permSummary(u = auth.user) {
  if (!u?.is_admin) return '';
  const perms = adminPerms(u);
  return perms.length === 0 ? '超级管理员' : perms.map((k) => PERM_LABELS[k] || k).join('、');
}
