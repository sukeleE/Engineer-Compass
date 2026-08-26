// 后端 API 封装（开发环境经 Vite 代理到 :3000）
const BASE = '/api';

async function req(path, opts = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const token = localStorage.getItem('ec_token');
  try {
    const res = await fetch(BASE + path, {
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: ctrl.signal,
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`请求超时（${timeoutMs / 1000}s），请重试`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function qs(params = {}) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, v);
  const str = s.toString();
  return str ? `?${str}` : '';
}

const AI_TIMEOUT = 90000; // AI 生成/提炼可能较慢

export const api = {
  // 竞赛
  competitions: (params) => req(`/competition${qs(params)}`),
  competition: (id) => req(`/competition/${id}`),
  search: (q) => req(`/competition/search?q=${encodeURIComponent(q)}`),
  pending: () => req('/competition/pending'),
  addCompetition: (card) => req('/competition', { method: 'POST', body: JSON.stringify(card) }),
  verifyCompetition: (id) => req(`/competition/${id}/verify`, { method: 'POST' }),
  deleteCompetition: (id) => req(`/competition/${id}`, { method: 'DELETE' }),
  // AI
  chat: (question, compId) =>
    req('/ai/chat', { method: 'POST', body: JSON.stringify({ question, comp_id: compId || undefined }) }, AI_TIMEOUT),
  extract: (material) => req('/ai/extract', { method: 'POST', body: JSON.stringify({ material }) }, AI_TIMEOUT),
  // 日程
  scheduleAdd: (compId) => req('/schedule/add', { method: 'POST', body: JSON.stringify({ comp_id: compId }) }, AI_TIMEOUT),
  scheduleManual: (card) => req('/schedule/manual', { method: 'POST', body: JSON.stringify(card) }),
  scheduleList: (userId = 'local') => req(`/schedule/list?user_id=${encodeURIComponent(userId)}`),
  scheduleEdit: (id, planJson) =>
    req(`/schedule/${id}/edit`, { method: 'POST', body: JSON.stringify({ plan_json: planJson }) }),
  scheduleDelete: (id) => req(`/schedule/${id}`, { method: 'DELETE' }),
  scheduleOptimize: (id) => req(`/schedule/${id}/optimize`, { method: 'POST' }, AI_TIMEOUT),
  scheduleExportUrl: (id, format = 'md') => `/api/schedule/${id}/export?format=${format}`,
  // 月历聚合：当月完成事项（竞赛/学习/小组，按完成日期 done_at）+ 当月笔记
  calendarMonth: (month) => req(`/schedule/calendar?month=${month}`),
  // 学习日程（AI 学习规划，与竞赛无关）
  studyPlan: (input) => req('/study/plan', { method: 'POST', body: JSON.stringify(input) }, AI_TIMEOUT),
  studyManual: (card) => req('/study/manual', { method: 'POST', body: JSON.stringify(card) }),
  studyList: () => req('/study/list'),
  studyDetail: (id) => req(`/study/${id}`),
  studyUpdate: (id, planJson) => req(`/study/${id}`, { method: 'POST', body: JSON.stringify({ plan_json: planJson }) }),
  studyDelete: (id) => req(`/study/${id}`, { method: 'DELETE' }),
  // 对话式 AI 计划：统一「先对话、后成稿」（team-create/team-generate/team-edit/schedule/schedule-edit/study/study-edit）
  planChat: (cfg, messages) => req('/plan-chat', { method: 'POST', body: JSON.stringify({ ...cfg, messages }) }, AI_TIMEOUT),
  // 日程笔记（每日学习笔记 + 学习状态）
  notesMonth: (month) => req(`/notes?month=${month}`),
  noteByDate: (date) => req(`/notes/${date}`),
  noteSave: (card) => req('/notes', { method: 'POST', body: JSON.stringify(card) }),
  noteDelete: (id) => req(`/notes/${id}`, { method: 'DELETE' }),
  // 认证
  register: (card) => req('/auth/register', { method: 'POST', body: JSON.stringify(card) }),
  login: (card) => req('/auth/login', { method: 'POST', body: JSON.stringify(card) }),
  sendCode: (email, purpose = 'login') => req('/auth/send-code', { method: 'POST', body: JSON.stringify({ email, purpose }) }),
  emailLogin: (email, code) => req('/auth/email-login', { method: 'POST', body: JSON.stringify({ email, code }) }),
  me: () => req('/auth/me'),
  updateProfile: (card) => req('/auth/profile', { method: 'PUT', body: JSON.stringify(card) }),
  bindEmail: (card) => req('/auth/email', { method: 'PUT', body: JSON.stringify(card) }),
  feedback: (card) => req('/feedback', { method: 'POST', body: JSON.stringify(card) }),
  // 公开主页（只读）：基本资料 + 竞赛计划 + 学习日程 + 参加的小组
  userPublic: (id) => req(`/users/${id}/public`),
  // 项目小组
  teamCreate: (card) => req('/team', { method: 'POST', body: JSON.stringify(card) }),
  teamJoin: (inviteCode) => req('/team/join', { method: 'POST', body: JSON.stringify({ invite_code: inviteCode }) }),
  teamDetail: (id) => req(`/team/${id}`),
  teamUpdate: (id, card) => req(`/team/${id}`, { method: 'PUT', body: JSON.stringify(card) }),
  teamInvite: (id) => req(`/team/${id}/invite`),
  teamRoleSave: (id, card) => req(`/team/${id}/role`, { method: 'POST', body: JSON.stringify(card) }),
  teamRoleDelete: (id, rid) => req(`/team/${id}/role/${rid}`, { method: 'DELETE' }),
  teamMemberRole: (id, card) => req(`/team/${id}/member`, { method: 'POST', body: JSON.stringify(card) }),
  teamSelfRole: (id, card) => req(`/team/${id}/member/self-role`, { method: 'POST', body: JSON.stringify(card) }),
  teamMemberRemove: (id, uid) => req(`/team/${id}/member/${uid}`, { method: 'DELETE' }),
  teamTransfer: (id, userId) => req(`/team/${id}/transfer`, { method: 'POST', body: JSON.stringify({ user_id: userId }) }),
  teamDelete: (id) => req(`/team/${id}`, { method: 'DELETE' }),
  // 进度对齐
  teamTaskCreate: (id, card) => req(`/team/${id}/task`, { method: 'POST', body: JSON.stringify(card) }),
  teamTaskUpdate: (id, tid, card) => req(`/team/${id}/task/${tid}`, { method: 'PUT', body: JSON.stringify(card) }),
  teamTaskDelete: (id, tid) => req(`/team/${id}/task/${tid}`, { method: 'DELETE' }),
  teamPlans: (id) => req(`/team/${id}/plans`),
  // 小组 AI 备赛计划（部门拆分 / 任务分配 / 组长修改 / 全员跟进）
  teamPlanList: (id) => req(`/team/${id}/plan`),
  teamPlanGenerate: (id, compId) => req(`/team/${id}/plan/generate`, { method: 'POST', body: JSON.stringify({ comp_id: compId }) }, AI_TIMEOUT),
  teamPlanSave: (id, card) => req(`/team/${id}/plan`, { method: 'POST', body: JSON.stringify(card) }),
  teamPlanDelete: (id, pid) => req(`/team/${id}/plan/${pid}`, { method: 'DELETE' }),
  // body: { done } 勾选 / { stars } 评星 / { links } 暂存链接（只传一项，后端按 undefined 守卫区分）
  teamPlanTaskToggle: (id, pid, phaseIdx, taskIdx, body) =>
    req(`/team/${id}/plan/${pid}/task`, { method: 'POST', body: JSON.stringify({ phase_idx: phaseIdx, task_idx: taskIdx, ...body }) }),
  teamPlanTaskSplit: (id, pid, phaseIdx, taskIdx, subtasks) =>
    req(`/team/${id}/plan/${pid}/task/split`, { method: 'POST', body: JSON.stringify({ phase_idx: phaseIdx, task_idx: taskIdx, subtasks }) }),
  // 多次任务：body { mode, target } 设定 / { complete: true } 完成一次 / { undo: index } 撤销记录
  teamPlanTaskComplete: (id, pid, phaseIdx, taskIdx, body) =>
    req(`/team/${id}/plan/${pid}/task/complete`, { method: 'POST', body: JSON.stringify({ phase_idx: phaseIdx, task_idx: taskIdx, ...body }) }),
  // 我的小组任务（个人日程页聚合：所有小组中「我的部门 + 通用」任务，服务端已过滤并带原始下标）
  teamMyTasks: () => req('/team/my-tasks'),
  // 任务 AI 拆解：subtasks（拆分子任务）+ keywords → resources（平台搜索链接，无幻觉）
  taskAssist: (taskText) => req('/ai/task-assist', { method: 'POST', body: JSON.stringify({ task_text: taskText }) }, AI_TIMEOUT),
  // AI 智能分组：按成员信息+部门+竞赛建议分组（仅建议，应用复用 teamMemberRole）
  teamAiGrouping: (id) => req(`/team/${id}/ai-grouping`, { method: 'POST' }),
  teamLog: (id, card) => req(`/team/${id}/log`, { method: 'POST', body: JSON.stringify(card) }),
  teamLogs: (id) => req(`/team/${id}/logs`),
  teamLogUpdate: (id, lid, card) => req(`/team/${id}/log/${lid}`, { method: 'PUT', body: JSON.stringify(card) }),
  teamLogDelete: (id, lid) => req(`/team/${id}/log/${lid}`, { method: 'DELETE' }),
  // 讨论
  teamMessages: (id) => req(`/team/${id}/messages`),
  teamMessage: (id, card) => req(`/team/${id}/message`, { method: 'POST', body: JSON.stringify(card) }),
  teamMessageUpdate: (id, mid, card) => req(`/team/${id}/message/${mid}`, { method: 'PUT', body: JSON.stringify(card) }),
  teamMessageDelete: (id, mid) => req(`/team/${id}/message/${mid}`, { method: 'DELETE' }),
  teamLogComment: (id, lid, content) => req(`/team/${id}/comment/log/${lid}`, { method: 'POST', body: JSON.stringify({ content }) }),
  teamMessageComment: (id, mid, content) => req(`/team/${id}/comment/message/${mid}`, { method: 'POST', body: JSON.stringify({ content }) }),
  teamCommentDelete: (id, cid) => req(`/team/${id}/comment/${cid}`, { method: 'DELETE' }),
  // 资料
  teamFiles: (id) => req(`/team/${id}/files`),
  teamFileUpload: (id, card) => req(`/team/${id}/file`, { method: 'POST', body: JSON.stringify(card) }),
  teamFileDownload: (fid) => `/api/team/file/${fid}/download`,
  teamFileDelete: (id, fid) => req(`/team/${id}/file/${fid}`, { method: 'DELETE' }),
  // 设备预约
  teamDeviceAdd: (id, card) => req(`/team/${id}/device`, { method: 'POST', body: JSON.stringify(card) }),
  teamDeviceDelete: (id, did) => req(`/team/${id}/device/${did}`, { method: 'DELETE' }),
  teamBookings: (id) => req(`/team/${id}/bookings`),
  teamBooking: (id, card) => req(`/team/${id}/booking`, { method: 'POST', body: JSON.stringify(card) }),
  teamBookingApprove: (id, bid, status) => req(`/team/${id}/booking/${bid}`, { method: 'PUT', body: JSON.stringify({ status }) }),
  // 资源分享（贴吧式板块）
  sharePosts: (params) => req(`/share/posts${qs(params)}`),
  sharePost: (id) => req(`/share/posts/${id}`),
  shareCreate: (card) => req('/share/posts', { method: 'POST', body: JSON.stringify(card) }),
  shareUpdate: (id, card) => req(`/share/posts/${id}`, { method: 'PUT', body: JSON.stringify(card) }),
  shareDelete: (id) => req(`/share/posts/${id}`, { method: 'DELETE' }),
  shareLike: (id) => req(`/share/posts/${id}/like`, { method: 'POST' }),
  shareFav: (id) => req(`/share/posts/${id}/fav`, { method: 'POST' }),
  shareComment: (id, content) => req(`/share/posts/${id}/comments`, { method: 'POST', body: JSON.stringify({ content }) }),
  shareCommentDelete: (cid) => req(`/share/comments/${cid}`, { method: 'DELETE' }),
  shareTags: () => req('/share/tags'),
  // 好友与私聊
  friendList: () => req('/friends'),
  friendRequests: () => req('/friends/requests'),
  friendSearch: (q) => req(`/friends/search?q=${encodeURIComponent(q)}`),
  friendRequest: (toId) => req('/friends/request', { method: 'POST', body: JSON.stringify({ to_id: toId }) }),
  friendAccept: (id) => req(`/friends/request/${id}/accept`, { method: 'POST' }),
  friendReject: (id) => req(`/friends/request/${id}/reject`, { method: 'POST' }),
  friendRemove: (fid) => req(`/friends/${fid}`, { method: 'DELETE' }),
  dmList: (uid) => req(`/friends/dm/${uid}`),
  dmSend: (uid, content) => req(`/friends/dm/${uid}`, { method: 'POST', body: JSON.stringify({ content }) }),
  dmRead: (uid) => req(`/friends/dm/${uid}/read`, { method: 'POST' }),
  // 个人资源库（≤128MB multipart；下载走 ?token= 直连）
  resourceList: (params) => req(`/resource${qs(params)}`),
  // ⚠️ req() 的 opts spread 会整体覆盖 headers（连 Authorization 一起丢），必须显式带 token；不设 Content-Type 由浏览器补 boundary
  resourceUpload: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    const token = localStorage.getItem('ec_token');
    return req('/resource/upload', { method: 'POST', body: fd, headers: token ? { Authorization: `Bearer ${token}` } : {} }, 300000);
  },
  resourceDownload: (id) => `/api/resource/${id}/download`,
  resourceDelete: (id) => req(`/resource/${id}`, { method: 'DELETE' }),
  // 消息中心（评论/点赞/收藏通知）
  notifications: () => req('/notifications'),
  notificationsUnread: () => req('/notifications/unread-count'),
  notificationsRead: (types) => req('/notifications/read', { method: 'POST', body: JSON.stringify({ types }) }),
  // 认证：登出（删除服务端会话 + 审计）
  logout: () => req('/auth/logout', { method: 'POST' }),
  // 后台管理（仅管理员，路由守卫 + 后端 adminRequired 双重校验）
  adminUsers: (params) => req(`/admin/users${qs(params)}`),
  adminSetStatus: (id, status) => req(`/admin/users/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) }),
  adminLogs: (params) => req(`/admin/logs${qs(params)}`),
  adminAnnouncements: () => req('/admin/announcements'),
  adminAnnouncementCreate: (card) => req('/admin/announcements', { method: 'POST', body: JSON.stringify(card) }),
  adminAnnouncementUpdate: (id, card) => req(`/admin/announcements/${id}`, { method: 'PUT', body: JSON.stringify(card) }),
  adminAnnouncementDelete: (id) => req(`/admin/announcements/${id}`, { method: 'DELETE' }),
  // 内容管理：帖子 / 评论
  adminPosts: (params) => req(`/admin/posts${qs(params)}`),
  adminPostDelete: (id) => req(`/admin/posts/${id}`, { method: 'DELETE' }),
  adminComments: (params) => req(`/admin/comments${qs(params)}`),
  adminCommentDelete: (id) => req(`/admin/comments/${id}`, { method: 'DELETE' }),
  // 用户详情 + 角色管理
  adminUserDetail: (id) => req(`/admin/users/${id}/detail`),
  adminSetRole: (id, is_admin) => req(`/admin/users/${id}/role`, { method: 'PUT', body: JSON.stringify({ is_admin: is_admin ? 1 : 0 }) }),
  // 后台：资源管理（全部用户上传）
  adminResources: (params) => req(`/admin/resources${qs(params)}`),
  adminResourceDelete: (id) => req(`/admin/resources/${id}`, { method: 'DELETE' }),
  serverStatus: () => req('/admin/server-status'),
  // 公告（公开）：全局顶部横幅
  announcementLatest: () => req('/announcements/latest'),
};
