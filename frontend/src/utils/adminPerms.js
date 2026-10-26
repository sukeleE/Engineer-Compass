// 全站管理员分权工具（与后端 middleware.js ADMIN_PERMS / ADMIN_PERM_GROUPS 对应）
// user.perms=[] 且 is_admin → 超级管理员（全权）；非空数组 → 仅授权项；
// 父子继承：父 key=整组全权，子 key=单项权限（如 user:view）；老缓存无 perms 按超管 fail-open，
// 路由守卫会 me() 刷新，最终以后端为准
import auth from '../auth.js';

// 可拆分模块：组名勾选取父 key（整组），子项勾选取子 key（单项）
export const PERM_GROUPS = [
  {
    key: 'user', label: '👤 用户管理', plain: '用户管理',
    children: [
      { key: 'user:view', label: '查看用户', desc: '用户列表、详情与内容统计' },
      { key: 'user:moderate', label: '封禁/禁言', desc: '封禁、禁言、解封用户账号', danger: true },
      { key: 'user:notify', label: '发送提醒', desc: '一键群发改密 / 实名提醒公告' },
    ],
  },
  {
    key: 'content', label: '📄 内容管理', plain: '内容管理',
    children: [
      { key: 'content:post', label: '帖子管理', desc: '查看 / 删除资源分享区帖子（含前台越权编辑）', danger: true },
      { key: 'content:comment', label: '评论管理', desc: '查看 / 删除任意评论', danger: true },
    ],
  },
  {
    key: 'resource', label: '📁 资源管理', plain: '资源管理',
    children: [
      { key: 'resource:view', label: '查看/下载', desc: '全站资源列表、详情与越权下载' },
      { key: 'resource:delete', label: '删除资源', desc: '删除任意用户上传的资源', danger: true },
    ],
  },
  {
    key: 'feedback', label: '📮 用户反馈', plain: '用户反馈',
    children: [
      { key: 'feedback:view', label: '查看反馈', desc: '反馈列表与全文查看' },
      { key: 'feedback:delete', label: '删除反馈', desc: '删除用户反馈记录', danger: true },
    ],
  },
  {
    key: 'log', label: '🧾 日志审计', plain: '日志审计',
    children: [
      { key: 'log:action', label: '操作日志', desc: '全站操作审计日志' },
      { key: 'log:visit', label: '访问记录', desc: '含 IP 的全站访问记录（更敏感）' },
    ],
  },
];

// 不拆分子权限的单权限模块
export const PERM_FLAT = [
  { key: 'competition', label: '🧠 竞赛审核', plain: '竞赛审核', desc: 'AI 收录竞赛的采纳/拒绝（AI 收录管理端）' },
  { key: 'announce', label: '📢 公告管理', plain: '公告管理', desc: '全站公告的发布与编辑' },
  { key: 'honor', label: '🏅 荣誉墙', plain: '荣誉墙', desc: '荣誉条目与奖状图片维护' },
  { key: 'server', label: '🖥️ 服务器状态', plain: '服务器状态', desc: '服务器运行状态面板' },
  { key: 'lab', label: '🗂️ 借用记录', plain: '借用记录', desc: '查看/导出全部项目的借设备、借教室登记记录' },
];

// 全部 key → 中文名（含父子，表格标签 / 旧过滤逻辑复用）
export const PERM_LABELS = {};
for (const g of PERM_GROUPS) {
  PERM_LABELS[g.key] = g.plain;
  for (const c of g.children) PERM_LABELS[c.key] = c.label;
}
for (const f of PERM_FLAT) PERM_LABELS[f.key] = f.plain;

export function adminPerms(u = auth.user) {
  if (!u?.is_admin) return [];
  return Array.isArray(u.perms) ? u.perms.filter((k) => k in PERM_LABELS) : [];
}

export function isSuperAdmin(u = auth.user) {
  return !!u?.is_admin && adminPerms(u).length === 0;
}

// 模块权限判断：超管全权；精确命中；父 key 放行子 key；任一子 key 放行父 key 入口
export function canAdmin(key, u = auth.user) {
  if (!u?.is_admin) return false;
  const perms = adminPerms(u);
  if (perms.length === 0 || perms.includes(key)) return true;
  if (key.includes(':') && perms.includes(key.split(':')[0])) return true;
  if (!key.includes(':') && perms.some((k) => k.startsWith(`${key}:`))) return true;
  return false;
}

// 多 key 任一满足（Tab 可见性用）
export const canAdminAny = (keys, u = auth.user) => keys.some((k) => canAdmin(k, u));

// 权限概要文案（表格标签/详情用）：整组只写组名，部分子权限写「组名（子项、…）」
export function permSummary(u = auth.user) {
  if (!u?.is_admin) return '';
  const perms = adminPerms(u);
  if (perms.length === 0) return '超级管理员';
  const parts = [];
  for (const g of PERM_GROUPS) {
    if (perms.includes(g.key)) {
      parts.push(g.plain);
    } else {
      const cs = g.children.filter((c) => perms.includes(c.key));
      if (cs.length) parts.push(`${g.plain}（${cs.map((c) => c.label).join('、')}）`);
    }
  }
  for (const f of PERM_FLAT) if (perms.includes(f.key)) parts.push(f.plain);
  return parts.join('、');
}