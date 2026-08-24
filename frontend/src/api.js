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
  teamPlanTaskToggle: (id, pid, phaseIdx, taskIdx, done) =>
    req(`/team/${id}/plan/${pid}/task`, { method: 'POST', body: JSON.stringify({ phase_idx: phaseIdx, task_idx: taskIdx, done }) }),
  // 我的小组任务（个人日程页聚合：所有小组中「我的部门 + 通用」任务，服务端已过滤并带原始下标）
  teamMyTasks: () => req('/team/my-tasks'),
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
};
