<script setup>
// 小组考勤：我的考勤/记录看板/请假/签到码/考勤设置（负责人=组长+考勤管理权限+显式指定）
import { ref, reactive, computed, watch, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../../api.js';
import { displayName } from '../../utils/displayName.js';

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
const isManager = ref(false);
const my = ref(null);
const board = ref(null);
const stats = ref(null);
const leaves = ref([]);
const codes = ref([]);
const boardDate = ref(todayStr());
const statsMonth = ref(todayStr().slice(0, 7));
const codeInput = ref('');
const leaveDlg = ref(false);
const proxyDlg = ref(false);
const codeDlg = ref(false);
const generatedCode = ref(null);
const saving = ref(false);

const leaveForm = reactive({ start_date: '', end_date: '', slot_id: '', leave_type: '事假', reason: '' });
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
    const [s, m] = await Promise.all([api.attendanceSettings(props.teamId), api.attendanceMy(props.teamId)]);
    policy.value = s.settings;
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
  Object.assign(leaveForm, { start_date: todayStr(), end_date: todayStr(), slot_id: '', leave_type: '事假', reason: '' });
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

// —— 考勤设置 ——
const sf = reactive({
  name: '', active: true, workdays: [], slots: [],
  scope_type: 'all', scope_json: [], managers: [], leave_mode: 'approval',
  start_date: '', end_date: '', exceptions: [],
});
function openSettings() {
  const p = policy.value || {};
  Object.assign(sf, {
    name: p.name || '考勤规则', active: p.active !== 0,
    workdays: [...(p.workdays || [])],
    slots: (p.slots || []).map((s) => ({ ...s })),
    scope_type: p.scope_type || 'all', scope_json: [...(p.scope_json || [])],
    managers: [...(p.managers_json || [])], leave_mode: p.leave_mode || 'approval',
    start_date: p.start_date || '', end_date: p.end_date || '',
    exceptions: (p.exceptions || []).map((x) => ({ ...x })),
  });
  active.value = 'settings';
}
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

          <div class="att-section-title">最近 14 天</div>
          <div v-for="d in my.recent" :key="d.date" class="recent-row">
            <span class="rr-date">{{ d.date }}</span>
            <template v-if="d.working">
              <el-tag v-for="c in d.cells" :key="c.slot_id" size="small" :type="statusTag(c.status)" effect="plain">
                {{ c.slot_name }} {{ statusLabel(c.status) }}
              </el-tag>
            </template>
            <el-tag v-else size="small" type="info" effect="plain">休息</el-tag>
          </div>
        </template>
      </el-tab-pane>

      <el-tab-pane v-if="isManager" label="记录" name="board">
        <div class="att-tools">
          <el-date-picker v-model="boardDate" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" />
          <span v-if="board && !board.working" class="att-sub">该日不是考勤工作日</span>
        </div>
        <div v-if="board && board.working" class="att-table-wrap">
          <el-table :data="board.rows" size="small" border>
            <el-table-column label="成员" min-width="120" fixed>
              <template #default="{ row }">
                <b>{{ memberName(row) }}</b>
                <div class="cell-roles">{{ row.is_owner ? '组长' : (row.role_names || []).join('、') || '无角色' }}</div>
              </template>
            </el-table-column>
            <el-table-column v-for="s in board.slots" :key="s.id" :label="`${s.name} ${s.start}-${s.end}`" min-width="120">
              <template #default="{ row }">
                <div class="board-cell">
                  <el-tag size="small" :type="statusTag(cellOf(row, s.id)?.status)">{{ statusLabel(cellOf(row, s.id)?.status) }}</el-tag>
                  <el-button v-if="['absent', 'late', 'can_checkin'].includes(cellOf(row, s.id)?.status)" size="small" text type="primary" @click="openProxy(row, s)">代签</el-button>
                </div>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <div class="att-section-title">月度统计 {{ statsMonth }}</div>
        <el-date-picker v-model="statsMonth" type="month" value-format="YYYY-MM" style="width:140px; margin-bottom:8px" />
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
          </el-table>
        </div>
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
.recent-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 0; border-bottom: 1px dashed var(--border); }
.rr-date { min-width: 92px; font-size: 13px; color: var(--text-1); }
.att-table-wrap { overflow-x: auto; }
.cell-roles { color: var(--text-2); font-size: 12px; }
.board-cell { display: flex; align-items: center; gap: 4px; }
.leave-row { display: flex; justify-content: space-between; gap: 10px; border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; flex-wrap: wrap; }
.lr-main { display: flex; flex-direction: column; gap: 3px; font-size: 13px; }
.lr-reason { color: var(--text-2); }
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
</style>
