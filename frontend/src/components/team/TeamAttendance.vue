<script setup>
// 小组考勤：我的考勤/记录看板/请假/签到码/考勤设置（负责人=组长+考勤管理权限+显式指定）
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../../api.js';
import { displayName } from '../../utils/displayName.js';
import AttendanceCalendar from './AttendanceCalendar.vue';

const props = defineProps({
  teamId: Number,
  me: Object,
  perms: Object,
  members: { type: Array, default: () => [] },
  roles: { type: Array, default: () => [] },
});

const todayStr = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};

const active = ref('my');
const loading = ref(false);
const policy = ref(null);
const loaded = ref(false);        // 首次 loadAll 是否完成（用于设置 tab 自动回填）
const settingsLoaded = ref(false); // 考勤设置表单是否已回填过，避免切走再切回覆盖未保存编辑
const isManager = ref(false);
const my = ref(null);
const board = ref(null);
const stats = ref(null);
const leaves = ref([]);
const codes = ref([]);
const boardDate = ref(todayStr());
const statsMonth = ref(todayStr().slice(0, 7));
const myMonth = ref(todayStr().slice(0, 7));
const recordView = ref('daily');
const codeInput = ref('');
const leaveDlg = ref(false);
const proxyDlg = ref(false);
const codeDlg = ref(false);
const generatedCode = ref(null);
const saving = ref(false);
const selectedBoardMemberId = ref(null);
const boardMemberDlg = ref(false);
const calDlg = ref(false);
const calDetail = ref(null);

const leaveForm = reactive({ start_date: '', end_date: '', slot_id: '', leave_type: '事假', reason: '', makeup_at: '' });
const proxyForm = reactive({ user_id: null, date: boardDate.value, slot_id: '', time: '', note: '' });
const codeForm = reactive({ date: todayStr(), slot_id: '', max_uses: 0 });

const STATUS = {
  normal: { label: '正常', tag: 'success' },
  late: { label: '迟到', tag: 'warning' },
  leave: { label: '请假', tag: 'info' },
  leave_pending: { label: '请假待批', tag: 'warning' },
  absent: { label: '缺勤', tag: 'danger' },
  waiting: { label: '未开始', tag: 'info' },
  can_checkin: { label: '可打卡', tag: 'primary' },
};
const cellMeta = (s) => STATUS[s] || { label: s, tag: 'info' };

const memberName = (m) => displayName(m || {});
const slotOptions = computed(() => policy.value?.slots || []);
const leaveSlotOptions = computed(() => [
  { id: '', name: '全天' },
  ...(slotOptions.value.map((s) => ({ id: s.id, name: `${s.name}（${s.start}-${s.end}）` }))),
]);
const scopeLabel = computed(() => {
  const p = policy.value;
  if (!p) return '';
  if (p.scope_type === 'all') return '全部成员';
  if (p.scope_type === 'roles') {
    const names = (p.scope_json || []).map((id) => props.roles.find((r) => Number(r.id) === Number(id))?.name).filter(Boolean);
    return `角色：${names.join('、') || '未选择'}`;
  }
  const names = (p.scope_json || []).map((id) => props.members.find((m) => Number(m.user_id ?? m.id) === Number(id))).filter(Boolean).map(memberName);
  return `成员：${names.join('、') || '未选择'}`;
});
const workdayLabel = computed(() => {
  const names = ['一', '二', '三', '四', '五', '六', '日'];
  return (policy.value?.workdays || []).map((x) => `周${names[x - 1]}`).join('、');
});

async function loadAll() {
  loading.value = true;
  try {
    const [s, m] = await Promise.all([api.attendanceSettings(props.teamId), api.attendanceMy(props.teamId, myMonth.value)]);
    policy.value = s.settings;
    loaded.value = true;
    isManager.value = s.is_manager || !!props.perms?.attendance || !!props.me?.is_owner;
    my.value = m;
    if (isManager.value) await loadManager();
    else leaves.value = m.leaves || [];
  } catch (e) { ElMessage.error(e.message); }
  finally { loading.value = false; }
}
async function loadManager() {
  if (!isManager.value) return;
  try {
    const [b, st, ls, cs] = await Promise.all([
      api.attendanceBoard(props.teamId, boardDate.value),
      api.attendanceStats(props.teamId, statsMonth.value),
      api.attendanceLeaves(props.teamId),
      api.attendanceCodes(props.teamId),
    ]);
    board.value = b;
    stats.value = st;
    leaves.value = ls.leaves || [];
    codes.value = cs.codes || [];
  } catch (e) { ElMessage.error(e.message); }
}
async function loadBoard() {
  if (!isManager.value) return;
  try { board.value = await api.attendanceBoard(props.teamId, boardDate.value); }
  catch (e) { ElMessage.error(e.message); }
}
async function loadStats() {
  if (!isManager.value) return;
  try { stats.value = await api.attendanceStats(props.teamId, statsMonth.value); }
  catch (e) { ElMessage.error(e.message); }
}
watch(boardDate, loadBoard);
watch(statsMonth, loadStats);
async function loadMy() {
  try { my.value = await api.attendanceMy(props.teamId, myMonth.value); }
  catch (e) { ElMessage.error(e.message); }
}
watch(myMonth, () => { if (my.value) loadMy(); });

// —— 本人打卡 / 签到码 ——
async function selfCheckin(slot) {
  try {
    const r = await api.attendanceCheckin(props.teamId, { slot_id: slot.slot_id || slot.id });
    ElMessage.success(r.message);
    codeInput.value = '';
    await loadAll();
  } catch (e) { ElMessage.error(e.message); }
}
async function redeemCode() {
  const code = codeInput.value.trim();
  if (!code) return ElMessage.warning('请输入签到码');
  try {
    const r = await api.attendanceCodeRedeem(props.teamId, code);
    ElMessage.success(r.message);
    codeInput.value = '';
    await loadAll();
  } catch (e) { ElMessage.error(e.message); }
}

// —— 代签 ——
function openProxy(user, slot) {
  proxyForm.user_id = Number(user.user_id ?? user.id);
  proxyForm.date = boardDate.value;
  proxyForm.slot_id = slot.slot_id || slot.id;
  proxyForm.time = '';
  proxyForm.note = '';
  proxyDlg.value = true;
}
async function saveProxy() {
  if (!proxyForm.user_id || !proxyForm.slot_id) return ElMessage.warning('请选择成员和时段');
  try {
    const r = await api.attendanceProxy(props.teamId, { ...proxyForm });
    ElMessage.success(r.message);
    proxyDlg.value = false;
    await Promise.all([loadAll(), loadBoard()]);
  } catch (e) { ElMessage.error(e.message); }
}

// —— 签到码 ——
function openCodeDlg() {
  codeForm.date = todayStr();
  codeForm.slot_id = slotOptions.value[0]?.id || '';
  codeForm.max_uses = 0;
  generatedCode.value = null;
  codeDlg.value = true;
}
async function createCode() {
  if (!codeForm.slot_id) return ElMessage.warning('请选择考勤时段');
  try {
    const c = await api.attendanceCodeCreate(props.teamId, { ...codeForm });
    generatedCode.value = c;
    await loadManager();
  } catch (e) { ElMessage.error(e.message); }
}
async function disableCode(c) {
  try {
    await api.attendanceCodeDisable(props.teamId, c.id);
    ElMessage.success('签到码已停用');
    await loadManager();
  } catch (e) { ElMessage.error(e.message); }
}
async function copyCode(code) {
  try { await navigator.clipboard.writeText(code); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = code;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
  ElMessage.success('签到码已复制');
}

// —— 请假 ——
function openLeave() {
  Object.assign(leaveForm, { start_date: todayStr(), end_date: todayStr(), slot_id: '', leave_type: '事假', reason: '', makeup_at: '' });
  leaveDlg.value = true;
}
async function submitLeave() {
  if (!leaveForm.start_date || !leaveForm.end_date || leaveForm.end_date < leaveForm.start_date) {
    return ElMessage.warning('请选择正确的请假日期');
  }
  if (!leaveForm.reason.trim()) return ElMessage.warning('请填写请假原因');
  try {
    const r = await api.attendanceLeaveCreate(props.teamId, {
      start_date: leaveForm.start_date, end_date: leaveForm.end_date,
      slot_id: leaveForm.slot_id || null, leave_type: leaveForm.leave_type, reason: leaveForm.reason.trim(),
      makeup_at: leaveForm.makeup_at || '',
    });
    ElMessage.success(r.message);
    leaveDlg.value = false;
    await loadAll();
  } catch (e) { ElMessage.error(e.message); }
}
async function reviewLeave(l, status) {
  try {
    const r = await api.attendanceLeaveStatus(props.teamId, l.id, { status });
    ElMessage.success(r.message);
    await loadAll();
  } catch (e) { ElMessage.error(e.message); }
}
async function removeLeave(l) {
  try { await ElMessageBox.confirm('删除这条请假单？', '确认', { type: 'warning' }); }
  catch { return; }
  try {
    await api.attendanceLeaveDelete(props.teamId, l.id);
    ElMessage.success('请假单已删除');
    await loadAll();
  } catch (e) { ElMessage.error(e.message); }
}

// —— 请假补签 ——
const nowTick = ref(Date.now());
let makeupTimer = null;
onMounted(() => { makeupTimer = setInterval(() => { nowTick.value = Date.now(); }, 30000); });
onUnmounted(() => { if (makeupTimer) clearInterval(makeupTimer); });
const cnNowStr = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23',
  }).formatToParts(new Date()).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
};
const MAKEUP_STATUS = {
  pending: { label: '待补签', tag: 'warning' },
  checkin: { label: '补签中', tag: 'primary' },
  completed: { label: '补签完成', tag: 'success' },
  missed: { label: '已错过', tag: 'danger' },
};
const makeupStatusLabel = (mk) => MAKEUP_STATUS[mk.status]?.label || mk.status || '-';
const makeupStatusTag = (mk) => MAKEUP_STATUS[mk.status]?.tag || 'info';
function makeupRemainMin(mk) {
  if (mk.status !== 'checkin' || !mk.checkin_time) return 0;
  const start = Date.parse(`${mk.checkin_time.replace(' ', 'T')}+08:00`);
  const need = (mk.minutes_required || 60) * 60000;
  return Math.max(0, Math.ceil((need - (nowTick.value - start)) / 60000));
}
function canMakeupCheckin(mk) {
  if (mk.status !== 'pending') return false;
  const now = cnNowStr();
  return mk.planned_at.slice(0, 10) === todayStr() && mk.planned_at <= now;
}
function canMakeupCheckout(mk) {
  if (mk.status !== 'checkin' || !mk.checkin_time) return false;
  const start = Date.parse(`${mk.checkin_time.replace(' ', 'T')}+08:00`);
  return nowTick.value - start >= (mk.minutes_required || 60) * 60000;
}
async function makeupCheckin(mk) {
  try {
    const r = await api.attendanceMakeupCheckin(props.teamId, mk.id);
    ElMessage.success(r.message);
    await loadAll();
  } catch (e) { ElMessage.error(e.message); }
}
async function makeupCheckout(mk) {
  try {
    const r = await api.attendanceMakeupCheckout(props.teamId, mk.id);
    ElMessage.success(r.message);
    await loadAll();
  } catch (e) { ElMessage.error(e.message); }
}

// —— 考勤设置 ——
const sf = reactive({
  name: '', active: true, workdays: [], slots: [],
  scope_type: 'all', scope_json: [], managers: [], leave_mode: 'approval',
  allow_makeup: false, makeup_minutes: 60, start_date: '', end_date: '', exceptions: [],
});
function openSettings() {
  const p = policy.value || {};
  Object.assign(sf, {
    name: p.name || '考勤规则', active: p.active !== 0,
    workdays: [...(p.workdays || [])],
    slots: (p.slots || []).map((s) => ({ ...s })),
    scope_type: p.scope_type || 'all', scope_json: [...(p.scope_json || [])],
    managers: [...(p.managers_json || [])], leave_mode: p.leave_mode || 'approval',
    allow_makeup: p.allow_makeup === 1 || p.allow_makeup === true,
    makeup_minutes: Number(p.makeup_minutes) || 60,
    start_date: p.start_date || '', end_date: p.end_date || '',
    exceptions: (p.exceptions || []).map((x) => ({ ...x })),
  });
  active.value = 'settings';
  settingsLoaded.value = true;
}
watch([active, loaded], () => {
  if (active.value === 'settings' && loaded.value && !settingsLoaded.value) openSettings();
});

function addSlot() {
  if (sf.slots.length >= 8) return ElMessage.warning('最多 8 个考勤时段');
  sf.slots.push({ id: '', name: `时段${sf.slots.length + 1}`, start: '08:30', late: '09:00', end: '10:00' });
}
function addException() { sf.exceptions.push({ date: '', type: 'off', name: '' }); }
async function saveSettings() {
  if (!sf.workdays.length) return ElMessage.warning('请至少选择一个工作日');
  if (!sf.slots.length) return ElMessage.warning('请至少设置一个考勤时段');
  for (const s of sf.slots) {
    if (!s.name.trim() || !/^\d{2}:\d{2}$/.test(s.start) || !/^\d{2}:\d{2}$/.test(s.late) || !/^\d{2}:\d{2}$/.test(s.end)) {
      return ElMessage.warning('请完整填写时段名称和时间（HH:MM）');
    }
    if (s.start > s.late || s.late > s.end) return ElMessage.warning(`时段「${s.name}」时间顺序应为 开始 ≤ 迟到 ≤ 结束`);
  }
  try {
    await api.attendanceSaveSettings(props.teamId, {
      name: sf.name.trim(), active: sf.active ? 1 : 0, workdays: sf.workdays,
      slots: sf.slots, scope_type: sf.scope_type, scope_json: sf.scope_json,
      managers: sf.managers, leave_mode: sf.leave_mode,
      allow_makeup: sf.allow_makeup ? 1 : 0, makeup_minutes: sf.makeup_minutes,
      start_date: sf.start_date || '', end_date: sf.end_date || '', exceptions: sf.exceptions,
    });
    ElMessage.success('考勤规则已保存');
    await loadAll();
  } catch (e) { ElMessage.error(e.message); }
}

function cellOf(row, slotId) {
  return (row.cells || []).find((c) => String(c.slot_id) === String(slotId));
}
function statusTag(s) { const m = cellMeta(s); return m.tag; }
function statusLabel(s) { return cellMeta(s).label; }
function fmtTime(t) { return String(t || '').slice(11, 16); }

const boardMember = computed(() => board.value?.rows?.find((m) => Number(m.id) === Number(selectedBoardMemberId.value)) || null);
const boardMemberSlots = computed(() => {
  const m = boardMember.value;
  if (!m) return [];
  return (board.value?.slots || []).map((s) => {
    const c = cellOf(m, s.id) || {};
    return {
      slot_id: s.id,
      name: s.name,
      time: `${s.start}-${s.end}`,
      status: c.status || 'waiting',
      checkin_time: c.record?.checkin_time,
      leave_type: c.leave?.leave_type,
    };
  });
});
const boardCount = (m, state) => (m.cells || []).filter((c) => c.status === state).length;
const boardDoneCount = (m) => boardCount(m, 'normal') + boardCount(m, 'late');
const boardOverall = (m) => {
  const s = (m.cells || []).map((c) => c.status);
  if (s.includes('leave') || s.includes('leave_pending')) return s.includes('leave') ? 'leave' : 'leave_pending';
  if (s.includes('absent')) return 'absent';
  if (s.includes('late')) return 'late';
  if (s.includes('normal')) return 'normal';
  if (s.includes('can_checkin')) return 'can_checkin';
  return 'waiting';
};
const boardCanProxy = (s) => ['absent', 'late', 'can_checkin'].includes(s);
function dayOverall(cells) { return boardOverall({ cells: cells || [] }); }
function statsDayStatus(d) {
  if (!d.working) return 'off';
  return boardOverall({ cells: (d.rows || []).map((r) => ({ status: dayOverall(r.cells) })) });
}
function buildCalGrid(month, infoMap, statusFn) {
  const [Y, M] = month.split('-').map(Number);
  const firstDow = (new Date(Date.UTC(Y, M - 1, 1)).getUTCDay() + 6) % 7;
  const last = new Date(Date.UTC(Y, M, 0)).getUTCDate();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= last; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const info = infoMap[date] || { date, working: false };
    cells.push({ date, day: d, info: { ...info, status: statusFn(info) } });
  }
  while (cells.length % 7) cells.push(null);
  return cells;
}
const myCalCells = computed(() => {
  if (!my.value?.month_days) return [];
  const map = Object.fromEntries((my.value.month_days || []).map((d) => [d.date, d]));
  return buildCalGrid(myMonth.value, map, (info) => (info.working ? dayOverall(info.cells) : 'off'));
});
const statsCalCells = computed(() => {
  if (!stats.value?.days) return [];
  const map = Object.fromEntries((stats.value.days || []).map((d) => {
    const rows = d.rows || [];
    const actual = rows.filter((r) => (r.cells || []).some((c) => c.status === 'normal' || c.status === 'late')).length;
    return [d.date, { ...d, expected: rows.length, actual, rate: rows.length ? Math.round((actual / rows.length) * 100) : 0 }];
  }));
  return buildCalGrid(statsMonth.value, map, statsDayStatus);
});
function openMyDay(cell) {
  const d = cell.info;
  calDetail.value = {
    title: `${d.date} 我的考勤`,
    rows: [{
      user_id: props.me.user_id,
      name: displayName(props.me),
      avatar: props.me.avatar,
      cells: d.cells || [],
    }],
  };
  calDlg.value = true;
}
function openStatsDay(cell) {
  const d = cell.info;
  calDetail.value = {
    title: `${d.date} 成员考勤`,
    summary: {
      expected: d.expected ?? (d.rows || []).length,
      actual: d.actual ?? (d.rows || []).filter((r) => (r.cells || []).some((c) => c.status === 'normal' || c.status === 'late')).length,
      rate: d.rate ?? 0,
    },
    rows: (d.rows || []).map((r) => {
      const m = props.members.find((x) => Number(x.user_id ?? x.id) === Number(r.user_id));
      return { user_id: r.user_id, name: m ? memberName(m) : `成员 ${r.user_id}`, avatar: m?.avatar, cells: r.cells || [] };
    }),
  };
  calDlg.value = true;
}
const attendanceRate = (row) => {
  const done = (row.normal || 0) + (row.late || 0);
  const total = row.total || 0;
  return total ? Math.round((done / total) * 100) : 0;
};
async function exportStatsExcel() {
  if (!stats.value?.rows?.length) return ElMessage.warning('暂无考勤数据可导出');
  try {
    const XLSX = await import('@e965/xlsx');
    const aoa = [
      ['成员', '正常', '迟到', '请假', '待批', '缺勤', '应签', '出勤率'],
      ...stats.value.rows.map((r) => [
        memberName(r),
        r.normal || 0,
        r.late || 0,
        r.leave || 0,
        r.leave_pending || 0,
        r.absent || 0,
        r.total || 0,
        `${attendanceRate(r)}%`,
      ]),
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '成员月度考勤');
    XLSX.writeFile(wb, `考勤统计_${stats.value.month}.xlsx`);
  } catch (e) { ElMessage.error(e.message); }
}
function openBoardMember(m) { selectedBoardMemberId.value = m.id; boardMemberDlg.value = true; }
function closeBoardMember() { boardMemberDlg.value = false; selectedBoardMemberId.value = null; }
function proxyBoardMember(m, s) { openProxy(m, s); }

onMounted(() => loadAll().catch(() => {}));
</script>

<template>
  <div class="attendance" v-loading="loading">
    <div v-if="policy" class="att-head">
      <div>
        <b>{{ policy.name }}</b>
        <span class="att-sub">{{ workdayLabel }} · {{ scopeLabel }} · 请假{{ policy.leave_mode === 'register' ? '仅登记' : '需审批' }}</span>
      </div>
      <el-button v-if="isManager" size="small" plain @click="openSettings">考勤设置</el-button>
    </div>

    <el-tabs v-model="active">
      <el-tab-pane label="我的" name="my">
        <template v-if="my">
          <div class="att-tools">
            <el-button type="primary" plain @click="openLeave">请假</el-button>
            <div v-if="my.today_working && my.in_scope" class="code-line">
              <el-input v-model="codeInput" placeholder="输入负责人发布的签到码" style="width:200px" @keyup.enter="redeemCode" />
              <el-button @click="redeemCode">签到码打卡</el-button>
            </div>
          </div>

          <div v-if="!my.today_working" class="att-empty">今天不是考勤工作日</div>
          <div v-else-if="!my.in_scope" class="att-empty">你不在当前考勤范围内</div>
          <div v-else class="today-grid">
            <div v-for="c in my.today" :key="c.slot_id" class="today-card">
              <div class="tc-top">
                <b>{{ c.slot_name }}</b>
                <el-tag size="small" :type="statusTag(c.status)">{{ statusLabel(c.status) }}</el-tag>
              </div>
              <div v-if="c.record" class="tc-time">{{ fmtTime(c.record.checkin_time) }} 打卡<span v-if="c.record.source === 'proxy'">（代签）</span></div>
              <div v-else-if="c.leave" class="tc-time">{{ c.leave.leave_type }}</div>
              <el-button v-if="c.status === 'can_checkin'" size="small" type="primary" @click="selfCheckin(c)">打卡</el-button>
            </div>
          </div>

          <template v-if="my.makeups?.length">
            <div class="att-section-title">我的补签</div>
            <div v-for="mk in my.makeups" :key="mk.id" class="makeup-row" :class="mk.status">
              <div class="mk-main">
                <b>{{ mk.leave_type }}补签</b>
                <span>{{ mk.start_date }}{{ mk.end_date !== mk.start_date ? ' 至 ' + mk.end_date : '' }} · 计划 {{ mk.planned_at }} · 需 {{ mk.minutes_required }} 分钟</span>
                <span v-if="mk.status === 'checkin'" class="mk-tip">已签到，还差 {{ makeupRemainMin(mk) }} 分钟</span>
                <span v-else-if="mk.status === 'completed'" class="mk-tip">签到 {{ mk.checkin_time }} · 签退 {{ mk.checkout_time }}</span>
              </div>
              <div class="mk-actions">
                <el-tag size="small" :type="makeupStatusTag(mk)">{{ makeupStatusLabel(mk) }}</el-tag>
                <el-button v-if="mk.status === 'pending'" size="small" type="primary" :disabled="!canMakeupCheckin(mk)" @click="makeupCheckin(mk)">签到</el-button>
                <el-button v-if="mk.status === 'checkin'" size="small" type="success" :disabled="!canMakeupCheckout(mk)" @click="makeupCheckout(mk)">签退</el-button>
              </div>
            </div>
          </template>

          <div class="att-section-title">当月月历 {{ myMonth }}</div>
          <div class="cal-tools">
            <el-date-picker v-model="myMonth" type="month" value-format="YYYY-MM" style="width:140px" />
          </div>
          <AttendanceCalendar v-if="my && my.month_days" :cells="myCalCells" :today="todayStr()" @pick="openMyDay" />
        </template>
      </el-tab-pane>

      <el-tab-pane v-if="isManager" label="记录" name="board">
        <div class="att-tools">
          <el-segmented v-model="recordView" :options="[{ label: '当日统计', value: 'daily' }, { label: '月度统计', value: 'month' }, { label: '月度考勤表', value: 'table' }]" />
        </div>
        <template v-if="recordView === 'daily'">
          <div class="att-tools">
            <el-date-picker v-model="boardDate" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" />
            <span v-if="board && !board.working" class="att-sub">该日不是考勤工作日</span>
          </div>
          <div v-if="board && board.working" class="att-member-grid">
            <button v-for="m in board.rows" :key="m.id" type="button" class="att-member-card"
              :class="{ me: Number(m.id) === Number(props.me.user_id) }" @click="openBoardMember(m)">
              <span class="am-avatar">
                <img v-if="m.avatar" :src="m.avatar" alt="" />
                <template v-else>{{ (m.real_name || m.nickname || '?').charAt(0) }}</template>
              </span>
              <b class="am-name">{{ m.real_name || m.nickname }}</b>
              <span class="am-role">
                <template v-if="m.is_owner">👑 组长</template>
                <template v-else-if="m.role_names?.length">{{ m.role_names[0] }}<em v-if="m.role_names.length > 1"> +{{ m.role_names.length - 1 }}</em></template>
                <template v-else>无角色</template>
              </span>
              <span class="am-status" :class="boardOverall(m)">{{ statusLabel(boardOverall(m)) }}</span>
              <span class="am-dots" :title="m.cells.map((c) => `${c.slot_name} ${statusLabel(c.status)}`).join('；')">
                <i v-for="c in m.cells" :key="c.slot_id" :class="c.status" :title="`${c.slot_name} ${statusLabel(c.status)}`"></i>
              </span>
              <span class="am-count">已签 {{ boardDoneCount(m) }}/{{ board.slots.length }}</span>
              <span v-if="m.cells.some((c) => boardCanProxy(c.status))" class="am-proxy" @click.stop="proxyBoardMember(m, m.cells.find((c) => boardCanProxy(c.status)))">代签</span>
            </button>
          </div>
        </template>
        <template v-else-if="recordView === 'month'">
          <div class="att-tools">
            <el-date-picker v-model="statsMonth" type="month" value-format="YYYY-MM" style="width:140px" />
          </div>
          <AttendanceCalendar v-if="stats && stats.days" mode="count" :cells="statsCalCells" :today="todayStr()" @pick="openStatsDay" />
        </template>
        <template v-else>
          <div class="att-tools">
            <el-date-picker v-model="statsMonth" type="month" value-format="YYYY-MM" style="width:140px" />
            <el-button size="small" type="primary" plain @click="exportStatsExcel">导出 Excel</el-button>
          </div>
          <div v-if="stats" class="att-table-wrap">
            <el-table :data="stats.rows" size="small" border>
              <el-table-column label="成员" min-width="120">
                <template #default="{ row }"><b>{{ memberName(row) }}</b></template>
              </el-table-column>
              <el-table-column prop="normal" label="正常" width="70" align="center" />
              <el-table-column prop="late" label="迟到" width="70" align="center" />
              <el-table-column prop="leave" label="请假" width="70" align="center" />
              <el-table-column prop="leave_pending" label="待批" width="70" align="center" />
              <el-table-column prop="absent" label="缺勤" width="70" align="center" />
              <el-table-column prop="total" label="应签" width="70" align="center" />
              <el-table-column label="出勤率" width="80" align="center">
                <template #default="{ row }">{{ attendanceRate(row) }}%</template>
              </el-table-column>
            </el-table>
          </div>
        </template>
      </el-tab-pane>

      <el-tab-pane label="请假" name="leaves">
        <div class="att-tools">
          <el-button type="primary" plain @click="openLeave">申请请假</el-button>
          <span v-if="policy" class="att-sub">当前模式：{{ policy.leave_mode === 'register' ? '仅登记，无需审批' : '需负责人审批' }}</span>
        </div>
        <div v-if="!leaves.length" class="att-empty">暂无请假记录</div>
        <div v-for="l in leaves" :key="l.id" class="leave-row">
          <div class="lr-main">
            <b>{{ memberName(l) }}</b>
            <span>{{ l.start_date }}{{ l.end_date !== l.start_date ? ' 至 ' + l.end_date : '' }} · {{ l.leave_type }}</span>
            <span class="lr-reason">{{ l.reason }}</span>
            <span v-if="l.makeup_at" class="lr-makeup">补签 {{ l.makeup_at }} · {{ makeupStatusLabel({ status: l.makeup_status }) }}</span>
            <el-tag size="small" :type="l.status === 'approved' ? 'success' : l.status === 'rejected' ? 'danger' : 'warning'">
              {{ l.status === 'approved' ? '已批准' : l.status === 'rejected' ? '已驳回' : '待审批' }}
            </el-tag>
          </div>
          <div class="lr-actions">
            <template v-if="isManager && l.status === 'pending'">
              <el-button size="small" type="success" plain @click="reviewLeave(l, 'approved')">批准</el-button>
              <el-button size="small" type="danger" plain @click="reviewLeave(l, 'rejected')">驳回</el-button>
            </template>
            <el-button v-if="l.status !== 'approved' && (l.user_id === props.me.user_id || isManager)" size="small" text type="danger" @click="removeLeave(l)">删除</el-button>
          </div>
        </div>
      </el-tab-pane>

      <el-tab-pane v-if="isManager" label="签到码" name="codes">
        <div class="att-tools">
          <el-button type="primary" plain @click="openCodeDlg">发布签到码</el-button>
        </div>
        <div v-if="generatedCode" class="code-issued">
          <div class="ci-label">今日签到码（{{ generatedCode.slot_name }}，至 {{ generatedCode.expires_at.slice(11, 16) }} 有效）</div>
          <div class="ci-code">{{ generatedCode.code }}</div>
          <el-button size="small" @click="copyCode(generatedCode.code)">复制</el-button>
        </div>
        <div v-if="!codes.length" class="att-empty">暂无签到码</div>
        <div v-for="c in codes" :key="c.id" class="code-row">
          <b class="cr-code">{{ c.code }}</b>
          <span>{{ c.date }} · {{ c.slot_name }} · {{ c.expires_at.slice(11, 16) }} 截止 · {{ c.use_count }}{{ c.max_uses ? '/' + c.max_uses : '' }} 次</span>
          <el-tag size="small" :type="c.status === 'active' ? 'success' : 'info'">{{ c.status === 'active' ? '有效' : '已停用' }}</el-tag>
          <el-button v-if="c.status === 'active'" size="small" text type="danger" @click="disableCode(c)">停用</el-button>
        </div>
      </el-tab-pane>

      <el-tab-pane v-if="isManager" label="设置" name="settings">
        <el-form label-position="top" class="att-form">
          <el-form-item label="规则名称">
            <el-input v-model="sf.name" maxlength="30" />
          </el-form-item>
          <el-form-item label="启用">
            <el-switch v-model="sf.active" />
          </el-form-item>
          <el-form-item label="工作日">
            <el-select v-model="sf.workdays" multiple placeholder="选择工作日" style="width:100%">
              <el-option v-for="(n, i) in ['周一','周二','周三','周四','周五','周六','周日']" :key="i + 1" :value="i + 1" :label="n" />
            </el-select>
          </el-form-item>
          <el-form-item label="考勤时段">
            <div class="slot-list">
              <div v-for="(s, i) in sf.slots" :key="i" class="slot-row">
                <el-input v-model="s.name" placeholder="时段名" style="width:110px" />
                <el-time-picker v-model="s.start" format="HH:mm" value-format="HH:mm" placeholder="开始" style="width:110px" />
                <el-time-picker v-model="s.late" format="HH:mm" value-format="HH:mm" placeholder="迟到线" style="width:110px" />
                <el-time-picker v-model="s.end" format="HH:mm" value-format="HH:mm" placeholder="截止" style="width:110px" />
                <el-button size="small" text type="danger" @click="sf.slots.splice(i, 1)">删</el-button>
              </div>
              <el-button size="small" plain @click="addSlot">添加时段</el-button>
            </div>
          </el-form-item>
          <el-form-item label="考勤范围">
            <el-radio-group v-model="sf.scope_type">
              <el-radio value="all">全部成员</el-radio>
              <el-radio value="roles">按角色</el-radio>
              <el-radio value="members">按成员</el-radio>
            </el-radio-group>
            <el-select v-if="sf.scope_type === 'roles'" v-model="sf.scope_json" multiple placeholder="选择角色" style="width:100%; margin-top:6px">
              <el-option v-for="r in roles" :key="r.id" :value="r.id" :label="r.name" />
            </el-select>
            <el-select v-if="sf.scope_type === 'members'" v-model="sf.scope_json" multiple placeholder="选择成员" style="width:100%; margin-top:6px">
              <el-option v-for="m in members" :key="m.user_id ?? m.id" :value="m.user_id ?? m.id" :label="memberName(m)" />
            </el-select>
          </el-form-item>
          <el-form-item label="考勤负责人">
            <el-select v-model="sf.managers" multiple placeholder="可多选，组长与有「考勤管理」权限者恒为负责人" style="width:100%">
              <el-option v-for="m in members" :key="m.user_id ?? m.id" :value="m.user_id ?? m.id" :label="memberName(m)" />
            </el-select>
          </el-form-item>
          <el-form-item label="请假模式">
            <el-radio-group v-model="sf.leave_mode">
              <el-radio value="approval">需负责人审批</el-radio>
              <el-radio value="register">仅登记</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="请假补签">
            <el-switch v-model="sf.allow_makeup" />
            <template v-if="sf.allow_makeup">
              <span class="mk-setting">补签时长</span>
              <el-input-number v-model="sf.makeup_minutes" :min="1" :max="480" style="width:140px; margin-left:6px" />
              <span class="mk-setting">分钟</span>
            </template>
          </el-form-item>
          <el-form-item label="生效日期（留空不限）">
            <div class="date-pair">
              <el-date-picker v-model="sf.start_date" type="date" value-format="YYYY-MM-DD" placeholder="开始" style="flex:1" />
              <span>至</span>
              <el-date-picker v-model="sf.end_date" type="date" value-format="YYYY-MM-DD" placeholder="结束" style="flex:1" />
            </div>
          </el-form-item>
          <el-form-item label="特殊日期（休息/补班）">
            <div class="slot-list">
              <div v-for="(x, i) in sf.exceptions" :key="i" class="slot-row">
                <el-date-picker v-model="x.date" type="date" value-format="YYYY-MM-DD" placeholder="日期" style="width:130px" />
                <el-select v-model="x.type" style="width:100px">
                  <el-option value="off" label="休息" />
                  <el-option value="work" label="补班" />
                </el-select>
                <el-input v-model="x.name" placeholder="备注（可选）" style="width:150px" />
                <el-button size="small" text type="danger" @click="sf.exceptions.splice(i, 1)">删</el-button>
              </div>
              <el-button size="small" plain @click="addException">添加特殊日期</el-button>
            </div>
          </el-form-item>
          <el-button type="primary" :loading="saving" @click="saveSettings">保存考勤规则</el-button>
        </el-form>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="leaveDlg" title="申请请假" width="440px">
      <el-form label-position="top">
        <div class="date-pair">
          <el-form-item label="开始日期" style="flex:1">
            <el-date-picker v-model="leaveForm.start_date" type="date" value-format="YYYY-MM-DD" style="width:100%" />
          </el-form-item>
          <el-form-item label="结束日期" style="flex:1">
            <el-date-picker v-model="leaveForm.end_date" type="date" value-format="YYYY-MM-DD" style="width:100%" />
          </el-form-item>
        </div>
        <el-form-item label="请假时段">
          <el-select v-model="leaveForm.slot_id" style="width:100%">
            <el-option v-for="s in leaveSlotOptions" :key="s.id" :value="s.id" :label="s.name" />
          </el-select>
        </el-form-item>
        <el-form-item label="类型">
          <el-select v-model="leaveForm.leave_type" style="width:100%">
            <el-option value="事假" label="事假" />
            <el-option value="病假" label="病假" />
            <el-option value="其他" label="其他" />
          </el-select>
        </el-form-item>
        <el-form-item label="原因">
          <el-input v-model="leaveForm.reason" type="textarea" :rows="3" maxlength="200" show-word-limit />
        </el-form-item>
        <el-form-item v-if="policy && (policy.allow_makeup === 1 || policy.allow_makeup === true)" label="补签时间（可选）">
          <el-date-picker v-model="leaveForm.makeup_at" type="datetime" value-format="YYYY-MM-DD HH:mm" placeholder="选择补签签到时间" style="width:100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="leaveDlg = false">取消</el-button>
        <el-button type="primary" @click="submitLeave">提交</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="proxyDlg" title="替人打卡" width="440px">
      <el-form label-position="top">
        <el-form-item label="成员">
          <el-select v-model="proxyForm.user_id" style="width:100%">
            <el-option v-for="m in members" :key="m.user_id ?? m.id" :value="m.user_id ?? m.id" :label="memberName(m)" />
          </el-select>
        </el-form-item>
        <el-form-item label="日期">
          <el-date-picker v-model="proxyForm.date" type="date" value-format="YYYY-MM-DD" style="width:100%" :disabled-date="(d) => d.getTime() > Date.now()" />
        </el-form-item>
        <el-form-item label="时段">
          <el-select v-model="proxyForm.slot_id" style="width:100%">
            <el-option v-for="s in slotOptions" :key="s.id" :value="s.id" :label="`${s.name}（${s.start}-${s.end}）`" />
          </el-select>
        </el-form-item>
        <el-form-item label="打卡时间（留空=当前时间；补签昨天留空记为正常）">
          <el-time-picker v-model="proxyForm.time" format="HH:mm" value-format="HH:mm" style="width:100%" />
        </el-form-item>
        <el-form-item label="备注（可选）">
          <el-input v-model="proxyForm.note" maxlength="100" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="proxyDlg = false">取消</el-button>
        <el-button type="primary" @click="saveProxy">确认代签</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="boardMemberDlg" title="考勤详情" width="560px" top="9vh" append-to-body
  @closed="closeBoardMember">
  <div v-if="boardMember" class="am-detail">
    <div class="amd-head">
      <span class="am-avatar large">
        <img v-if="boardMember.avatar" :src="boardMember.avatar" alt="" />
        <template v-else>{{ (boardMember.real_name || boardMember.nickname || '?').charAt(0) }}</template>
      </span>
      <div class="amd-title">
        <div class="amd-name-line">
          <b>{{ boardMember.real_name || boardMember.nickname }}</b>
          <el-tag size="small" :type="statusTag(boardOverall(boardMember))">{{ statusLabel(boardOverall(boardMember)) }}</el-tag>
        </div>
        <div class="amd-roles">{{ boardMember.is_owner ? '👑 组长' : (boardMember.role_names || []).join('、') || '无角色' }}</div>
      </div>
      <span class="amd-count">已签 {{ boardDoneCount(boardMember) }}/{{ board.slots.length }}</span>
    </div>
    <div class="amd-slots">
      <div v-for="s in boardMemberSlots" :key="s.slot_id" class="amd-slot" :class="s.status">
        <div class="ams-main">
          <b>{{ s.name }}</b>
          <span>{{ s.time }}</span>
          <el-tag size="small" :type="statusTag(s.status)">{{ statusLabel(s.status) }}</el-tag>
        </div>
        <div class="ams-meta">
          <span v-if="s.checkin_time">打卡 {{ fmtTime(s.checkin_time) }}<i v-if="s.source === 'proxy'">（代签）</i></span>
          <span v-else-if="s.leave_type">请假 · {{ s.leave_type }}</span>
          <span v-else>未打卡</span>
        </div>
        <el-button v-if="boardCanProxy(s.status)" size="small" text type="primary" @click="proxyBoardMember(boardMember, s)">代签</el-button>
      </div>
    </div>
  </div>
</el-dialog>
<el-dialog v-model="calDlg" :title="calDetail?.title" width="560px" top="9vh" append-to-body>
  <div v-if="calDetail" class="cal-detail">
    <div v-if="calDetail.summary" class="cal-summary">
      <span>应到 {{ calDetail.summary.expected }}</span>
      <span>实到 {{ calDetail.summary.actual }}</span>
      <span>出勤率 {{ calDetail.summary.rate }}%</span>
    </div>
    <div v-for="row in calDetail.rows" :key="row.user_id" class="cal-member">
      <div class="amd-head">
        <span class="am-avatar large">
          <img v-if="row.avatar" :src="row.avatar" alt="" />
          <template v-else>{{ (row.name || '?').charAt(0) }}</template>
        </span>
        <div class="amd-title">
          <div class="amd-name-line">
            <b>{{ row.name }}</b>
            <el-tag size="small" :type="statusTag(dayOverall(row.cells))">{{ statusLabel(dayOverall(row.cells)) }}</el-tag>
          </div>
          <div class="amd-roles">{{ row.role_text || '考勤范围内' }}</div>
        </div>
        <span class="amd-count">已签 {{ boardDoneCount(row) }}/{{ row.cells.length }}</span>
      </div>
      <div class="amd-slots">
        <div v-for="s in row.cells" :key="s.slot_id" class="amd-slot" :class="s.status">
          <div class="ams-main">
            <b>{{ s.slot_name }}</b>
            <el-tag size="small" :type="statusTag(s.status)">{{ statusLabel(s.status) }}</el-tag>
          </div>
          <div class="ams-meta">
            <span v-if="s.record">打卡 {{ fmtTime(s.record.checkin_time) }}<i v-if="s.record.source === 'proxy'">（代签）</i></span>
            <span v-else-if="s.leave">请假 · {{ s.leave.leave_type }}<i v-if="s.leave.status === 'pending'">（待批）</i></span>
            <span v-else>未打卡</span>
          </div>
        </div>
      </div>
    </div>
    <div v-if="!calDetail.rows.length" class="att-empty">暂无考勤记录</div>
  </div>
</el-dialog>
<el-dialog v-model="codeDlg" title="发布签到码" width="420px">
      <el-form label-position="top">
        <el-form-item label="考勤时段">
          <el-select v-model="codeForm.slot_id" style="width:100%">
            <el-option v-for="s in slotOptions" :key="s.id" :value="s.id" :label="`${s.name}（${s.start}-${s.end}）`" />
          </el-select>
        </el-form-item>
        <el-form-item label="使用次数上限（0=不限）">
          <el-input-number v-model="codeForm.max_uses" :min="0" :max="999" style="width:100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="codeDlg = false">取消</el-button>
        <el-button type="primary" @click="createCode">生成签到码</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style lang="scss" scoped>
.attendance { min-height: 360px; }
.att-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin: 2px 0 8px; flex-wrap: wrap; }
.att-sub { color: var(--text-2); font-size: 12px; margin-left: 8px; }
.att-tools { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
.code-line { display: flex; gap: 6px; }
.att-empty { color: var(--text-2); padding: 18px 0; }
.att-section-title { font-weight: 600; margin: 14px 0 8px; }
.today-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; }
.today-card { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
.tc-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 6px; }
.tc-time { color: var(--text-2); font-size: 12px; margin-bottom: 8px; }
.cal-tools { margin-bottom: 8px; }
.cal-detail { max-height: 62vh; overflow: auto; padding-right: 2px; }
.cal-summary { display: flex; gap: 14px; flex-wrap: wrap; background: var(--primary-tint); border: 1px solid var(--border); border-radius: 8px; padding: 9px 12px; margin-bottom: 12px; font-size: 13px; }
.cal-member + .cal-member { margin-top: 14px; padding-top: 12px; border-top: 1px dashed var(--border); }
.cal-member .amd-slots { max-height: none; margin-top: 10px; }
.att-table-wrap { overflow-x: auto; }
.cell-roles { color: var(--text-2); font-size: 12px; }
.board-cell { display: flex; align-items: center; gap: 4px; }
.leave-row { display: flex; justify-content: space-between; gap: 10px; border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; flex-wrap: wrap; }
.lr-main { display: flex; flex-direction: column; gap: 3px; font-size: 13px; }
.lr-reason { color: var(--text-2); }
.lr-makeup { color: var(--primary); font-size: 12px; }
.makeup-row { display: flex; justify-content: space-between; gap: 10px; align-items: center; border: 1px solid var(--border); border-left-width: 4px; border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; flex-wrap: wrap;
  &.pending { border-left-color: #f59e0b; }
  &.checkin { border-left-color: #38bdf8; }
  &.completed { border-left-color: #22c55e; }
  &.missed { border-left-color: #ef4444; }
}
.mk-main { display: flex; flex-direction: column; gap: 3px; font-size: 13px; min-width: 200px; }
.mk-tip { color: var(--text-2); font-size: 12px; }
.mk-actions { display: flex; align-items: center; gap: 8px; }
.mk-setting { color: var(--text-2); font-size: 13px; margin-left: 12px; }
.lr-actions { display: flex; align-items: center; gap: 6px; }
.code-issued { border: 1px dashed var(--primary); border-radius: 8px; padding: 12px; margin-bottom: 12px; text-align: center; }
.ci-label { color: var(--text-2); font-size: 13px; margin-bottom: 6px; }
.ci-code { font-size: 26px; font-weight: 700; letter-spacing: 6px; margin-bottom: 8px; }
.code-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 0; border-bottom: 1px dashed var(--border); font-size: 13px; }
.cr-code { font-size: 16px; letter-spacing: 2px; }
.att-form { max-width: 720px; }
.slot-list { display: flex; flex-direction: column; gap: 8px; width: 100%; }
.slot-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.date-pair { display: flex; gap: 8px; align-items: center; width: 100%; }
.att-member-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(158px, 1fr)); gap: 10px; }
.att-member-card {
  position: relative; text-align: left; border: 1px solid var(--border); background: var(--card-bg);
  border-radius: 12px; padding: 12px; min-height: 158px; cursor: pointer; transition: all .15s;
  display: flex; flex-direction: column; align-items: flex-start; gap: 6px;
  &:hover { transform: translateY(-1px); border-color: color-mix(in srgb, var(--primary) 45%, white); box-shadow: 0 4px 14px color-mix(in srgb, var(--primary) 10%, transparent); }
  &.me { background: var(--primary-tint); border-color: color-mix(in srgb, var(--primary) 30%, white); }
}
.am-avatar {
  width: 36px; height: 36px; border-radius: 50%; flex-shrink: 0; display: inline-flex;
  align-items: center; justify-content: center; overflow: hidden; font-size: 15px; font-weight: 600;
  background: var(--primary); color: #fff;
  &.large { width: 48px; height: 48px; font-size: 19px; }
  img { width: 100%; height: 100%; object-fit: cover; }
}
.am-name { max-width: 100%; font-size: 13.5px; line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.am-role { color: var(--text-2); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; padding-right: 42px;
  em { font-style: normal; color: #94a3b8; }
}
.am-status {
  display: inline-flex; align-items: center; font-size: 11.5px; border-radius: 999px; padding: 3px 7px; white-space: nowrap;
  &.normal { color: #15803d; background: #dcfce7; }
  &.late, &.leave_pending { color: #b45309; background: #fef3c7; }
  &.absent { color: #b91c1c; background: #fee2e2; }
  &.leave, &.waiting, &.can_checkin { color: var(--text-2); background: rgba(148,163,184,.14); }
}
.am-dots { display: flex; gap: 4px; flex-wrap: wrap;
  i { width: 9px; height: 9px; border-radius: 50%; background: #cbd5e1; }
  i.normal { background: #22c55e; }
  i.late { background: #f59e0b; }
  i.absent { background: #ef4444; }
  i.leave_pending { background: #f59e0b; }
}
.am-count { font-size: 11.5px; color: #94a3b8; }
.am-proxy { position: absolute; right: 10px; bottom: 10px; font-size: 12px; color: var(--primary); cursor: pointer;
  &:hover { text-decoration: underline; }
}
.amd-head { display: flex; align-items: center; gap: 12px; }
.amd-title { flex: 1; min-width: 0; }
.amd-name-line { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; b { font-size: 16px; } }
.amd-roles { color: var(--text-2); font-size: 12px; margin-top: 5px; }
.amd-count { font-size: 12.5px; color: #94a3b8; }
.amd-slots { display: flex; flex-direction: column; gap: 8px; max-height: 48vh; overflow: auto; margin-top: 14px; padding-right: 2px; }
.amd-slot { border: 1px solid var(--border); border-left-width: 4px; border-radius: 10px; padding: 9px 11px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  &.normal { border-left-color: #22c55e; }
  &.late { border-left-color: #f59e0b; }
  &.absent { border-left-color: #ef4444; }
  &.leave, &.leave_pending { border-left-color: #f59e0b; }
  .ams-main { display: flex; align-items: center; gap: 8px; min-width: 0; b { font-size: 13.5px; } span { color: var(--text-2); font-size: 12px; } }
  .ams-meta { flex: 1; min-width: 100px; color: var(--text-2); font-size: 12px; i { font-style: normal; } }
}
</style>
