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

// 报销整理请求头：登录态带 Authorization；已认领（传 code）追加 X-Claim-Token
// ⚠️ claim token 只进请求头、绝不进 URL/query（后端 access_log 记录 originalUrl）
const expenseAuth = (code = null) => {
  const h = {};
  const t = localStorage.getItem('ec_token');
  if (t) h.Authorization = `Bearer ${t}`;
  const ct = code ? localStorage.getItem(`expense_claim_${code}`) : null;
  if (ct) h['X-Claim-Token'] = ct;
  return h;
};
const expenseJsonHeaders = (code = null) => ({ 'Content-Type': 'application/json', ...expenseAuth(code) });

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
  // 幽灵模式（秘密通道「水手冰淇淋」）：激活/退出/怪奇小队名单
  ghostEnter: () => req('/ghost/enter', { method: 'POST' }),
  ghostExit: () => req('/ghost/exit', { method: 'POST' }),
  ghostUsers: () => req('/ghost/users'),
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
  // 资源分享（引用功能）：POST 幂等生成/查询公开下载链接，DELETE 撤销（token 清空后所有引用失效）
  resourceShare: (id) => req(`/resource/${id}/share`, { method: 'POST' }),
  resourceUnshare: (id) => req(`/resource/${id}/share`, { method: 'DELETE' }),
  // 小组资料：从「我的资源」引用（不复制文件，生成分享 token 后建引用行）
  teamFileRef: (teamId, rid) => req(`/team/${teamId}/file/ref`, { method: 'POST', body: JSON.stringify({ resource_id: rid }) }),
  // 计划导入：上传 .docx/.pdf/.xlsx/.md → AI 转成固定格式计划（不落库，前端确认后走 scheduleManual/studyManual）
  planImport: (file, mode) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('mode', mode);
    const token = localStorage.getItem('ec_token');
    return req('/import/plan', { method: 'POST', body: fd, headers: token ? { Authorization: `Bearer ${token}` } : {} }, 300000);
  },
  // 计划导入（文本入口）：飞书文档等已取到文本的场景，同样 AI 转固定格式计划
  planImportText: (body) => req('/import/plan-text', { method: 'POST', body: JSON.stringify(body) }, 300000),
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
  // 后台：访问记录（含游客）
  adminVisits: (params) => req(`/admin/visits${qs(params)}`),
  serverStatus: () => req('/admin/server-status'),
  // 公告（公开）：全局顶部横幅
  announcementLatest: () => req('/announcements/latest'),
  // 飞书（每用户绑定，P0）：状态 / 授权链接（登录专属）/ 解绑
  feishuStatus: () => req('/feishu/oauth/status'),
  feishuAuth: () => req('/feishu/oauth/auth'),
  feishuUnbind: () => req('/feishu/oauth/unbind', { method: 'POST' }),
  // 飞书编辑页（P1）：业务记录 ↔ 飞书文档（daily_note / progress_log / share_post）
  // bizId 为空时后端自动创建业务记录（extra 传 note_date / team_id / title）
  feishuBizOpen: (bizType, bizId, extra) => req('/feishu/biz/open', { method: 'POST', body: JSON.stringify({ biz_type: bizType, biz_id: bizId ?? null, ...(extra || {}) }) }),
  feishuBizSync: (bizType, bizId) => req('/feishu/biz/sync', { method: 'POST', body: JSON.stringify({ biz_type: bizType, biz_id: bizId }) }),
  // 从飞书文档导入内容到业务记录（不创建映射；bizId 为空时后端自动创建记录，extra 传 note_date/team_id/title）
  feishuBizImport: (bizType, bizId, documentId, extra) => req('/feishu/biz/import', { method: 'POST', body: JSON.stringify({ biz_type: bizType, biz_id: bizId ?? null, document_id: documentId, ...(extra || {}) }) }),
  feishuBizStatus: (bizType, bizId) => req(`/feishu/biz/status?biz_type=${bizType}&biz_id=${bizId}`),
  // 飞书云盘（P2）：文件列表（folder_token 可进子文件夹，返回可引用链接）
  feishuDocList: (params) => req(`/feishu/doc/list${qs(params)}`),
  feishuDocCreate: (body) => req('/feishu/doc/create', { method: 'POST', body: JSON.stringify(body) }),
  // 文档读取：blocks 分页 + 转换可能较慢，120s 超时（与 AI 接口一致，默认 30s 会误杀大文档）
  feishuDocContent: (documentId, format = 'markdown') => req(`/feishu/doc/content?document_id=${documentId}&format=${format}`, {}, 120000),
  // ==================== 报销整理（/expense）====================
  // 成员免登录：邀请码 code 即钥匙，打开 /expense?code=xxx 只读；认领后写操作带 X-Claim-Token
  // claim token 存 localStorage（expense_claim_{code}），冲突 409 需负责人重置（expenseMemberReset）
  expenseClaimTok: (code) => localStorage.getItem(`expense_claim_${code}`),
  expenseSaveClaim: (code, token) => localStorage.setItem(`expense_claim_${code}`, token),
  expenseClearClaim: (code) => localStorage.removeItem(`expense_claim_${code}`),
  expenseOpen: (code) => req(`/expense/o/${encodeURIComponent(code)}`),
  expenseClaim: (code, name) => req(`/expense/o/${encodeURIComponent(code)}/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }),
  expenseRowCreate: (code, team_id, category, data, owner_name) => req(`/expense/o/${encodeURIComponent(code)}/row`, { method: 'POST', headers: expenseJsonHeaders(code), body: JSON.stringify({ team_id, category, data, owner_name }) }),
  // 全项目统一支付行（项目级区块，不属任何队伍）：project_pay 标记走服务端专属分支（仅负责人，范围强制=全体成员）
  expenseRowProjCreate: (code, category, data, owner_name) => req(`/expense/o/${encodeURIComponent(code)}/row`, { method: 'POST', headers: expenseJsonHeaders(code), body: JSON.stringify({ project_pay: true, category, data, owner_name }) }),
  expenseRowUpdate: (code, rid, body) => req(`/expense/o/${encodeURIComponent(code)}/row/${rid}`, { method: 'PUT', headers: expenseJsonHeaders(code), body: JSON.stringify(body) }),
  expenseRowDelete: (code, rid) => req(`/expense/o/${encodeURIComponent(code)}/row/${rid}`, { method: 'DELETE', headers: expenseJsonHeaders(code) }),
  // 附件上传：FormData 不设 Content-Type（浏览器补 boundary），手动带认领头（同 resourceUpload 注释）
  expenseAttUpload: (code, rid, slot, file) => {
    const fd = new FormData();
    fd.append('file', file);
    return req(`/expense/o/${encodeURIComponent(code)}/row/${rid}/file?slot=${encodeURIComponent(slot)}`, { method: 'POST', body: fd, headers: expenseAuth(code) }, 300000);
  },
  expenseAttDelete: (code, rid, fid) => req(`/expense/o/${encodeURIComponent(code)}/row/${rid}/file/${fid}`, { method: 'DELETE', headers: expenseJsonHeaders(code) }),
  // 下载/导出：GET 开放（code 即钥匙），返回裸 URL 供 <a href>/window.open 直连
  expenseFileUrl: (code, fid, dl = false) => `/api/expense/o/${encodeURIComponent(code)}/file/${fid}/download${dl ? '?dl=1' : ''}`,
  expenseZipUrl: (code, teamId) => `/api/expense/o/${encodeURIComponent(code)}/export/zip?team_id=${teamId}`,
  expenseXlsxUrl: (code) => `/api/expense/o/${encodeURIComponent(code)}/export/xlsx`,
  // 负责人管理（登录态；队伍/成员用各自 id 路由）
  expenseCreate: (name, event) => req('/expense', { method: 'POST', body: JSON.stringify({ name, event }) }),
  expenseList: () => req('/expense'),
  expensePatch: (id, body) => req(`/expense/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  expenseDelete: (id) => req(`/expense/${id}`, { method: 'DELETE' }),
  expenseTeamCreate: (id, name) => req(`/expense/${id}/team`, { method: 'POST', body: JSON.stringify({ name }) }),
  expenseTeamRename: (tid, name) => req(`/expense/team/${tid}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  expenseTeamDelete: (tid) => req(`/expense/team/${tid}`, { method: 'DELETE' }),
  expenseMemberCreate: (id, tid, name) => req(`/expense/${id}/team/${tid}/member`, { method: 'POST', body: JSON.stringify({ name }) }),
  expenseMemberPatch: (mid, body) => req(`/expense/member/${mid}`, { method: 'PATCH', body: JSON.stringify(body) }),
  expenseMemberDelete: (mid) => req(`/expense/member/${mid}`, { method: 'DELETE' }),
  expenseMemberReset: (mid) => req(`/expense/member/${mid}/reset-claim`, { method: 'POST' }),
};
