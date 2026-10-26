<script setup>
// 进度对齐：任务列表（组长建任务/分配负责人/进度跟踪）+ 成员进度汇报时间线（富文本 + 附件 + 评论）
// 编写汇报独立成弹窗，与时间线浏览区区分
import { ref, reactive, computed } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../../api.js';
import auth from '../../auth.js';
import { openImage } from '../../utils/imageViewer.js';
import { fmtDateOnly, fmtShort } from '../../utils/time.js';
import AttachmentList, { normAtts } from './AttachmentList.vue';
import CommentThread from './CommentThread.vue';
import ResourcePicker from '../ResourcePicker.vue';
import DocPicker from './DocPicker.vue';
import LiteEditor from './LiteEditor.vue';
import { selfName } from '../../utils/displayName.js';

const router = useRouter();
// 点击作者头像/昵称 → 进入其公开主页（只读）；自己 → 我的管理界面
const toProfile = (x) => router.push(x.user_id === auth.user?.id ? '/me' : `/user/${x.user_id}`);

const props = defineProps({ teamId: Number, me: Object, perms: Object, members: Array, tasks: Array });

const tasks = ref(props.tasks || []);
const logs = ref([]);
const showNew = ref(false);
const newTask = ref({ title: '', desc: '', deadline: '', assignee_id: null });

// —— 汇报编写/编辑弹窗 ——
const reportDlg = ref(false);
const reportHtml = ref('');
const reportAtts = ref([]); // [{name,size,mime,data}]
const editingLogId = ref(null); // null=新汇报；有值=编辑该条
const impDlg = ref(false);   // 从飞书导入文档选择器
const fileInput = ref(null);
const ciFileInput = ref(null); // 打卡弹窗独立的附件 input（避免与自由汇报弹窗的同名 ref 冲突）
const MAX_ATT_TOTAL = 25 * 1024 * 1024;

const STATUS = { todo: { label: '待开始', tag: 'info' }, doing: { label: '进行中', tag: 'warning' }, done: { label: '已完成', tag: 'success' } };

async function reload() {
  tasks.value = (await api.teamDetail(props.teamId)).tasks;
  logs.value = await api.teamLogs(props.teamId);
  await loadCheckin();
}

// ==================== 周期打卡 / 定时汇报 ====================
const schedules = ref([]);
const myDues = ref([]);
const featured = ref([]);

async function loadCheckin() {
  try {
    const [sc, mine, ft] = await Promise.all([
      api.teamCheckinSchedules(props.teamId),
      api.teamCheckinMine(props.teamId),
      api.teamCheckinFeatured(props.teamId, ''),
    ]);
    schedules.value = sc.schedules || [];
    myDues.value = mine.dues || [];
    featured.value = ft.reports || [];
  } catch (e) { /* 打卡为增量功能，加载失败不阻断任务看板与时间线 */ }
}

function schedFreqText(s) {
  if (s.kind === 'once') return `定时 · ${(s.once_at || '').replace('T', ' ')}`;
  if (s.freq === 'daily') return `每日 ${s.due_time} 截止`;
  const names = ['一', '二', '三', '四', '五', '六', '日'];
  const wd = (s.weekdays || []).slice().sort().map((x) => '周' + names[x - 1]).join('、');
  return `每周 ${wd} · ${s.due_time} 截止`;

}

// ---- 打卡任务建/改/删 ----
const schedDlg = ref(false);
const schedEditing = ref(null);
const schedSaving = ref(false);
const todayStr = () => fmtDateOnly(new Date());
const sf = reactive({
  title: '', kind: 'recurring', freq: 'daily', weekdays: [], due_time: '21:00',
  start_date: '', end_date: '', once_at: '',
  allow_late: true, need_self_progress: false, need_self_rating: false, auto_feature: 0,
});
function resetSf() {
  Object.assign(sf, {
    title: '', kind: 'recurring', freq: 'daily', weekdays: [], due_time: '21:00',
    start_date: todayStr(), end_date: '', once_at: '',
    allow_late: true, need_self_progress: false, need_self_rating: false, auto_feature: 0,
  });
}
function openSchedCreate() { resetSf(); schedEditing.value = null; schedDlg.value = true; }
function openSchedEdit(s) {
  schedEditing.value = s;
  Object.assign(sf, {
    title: s.title, kind: s.kind, freq: s.freq, weekdays: [...(s.weekdays || [])], due_time: s.due_time,
    start_date: s.start_date, end_date: s.end_date || '', once_at: s.once_at || '',
    allow_late: !!s.allow_late, need_self_progress: !!s.need_self_progress,
    need_self_rating: !!s.need_self_rating, auto_feature: s.auto_feature || 0,
  });
  schedDlg.value = true;
}
function toggleWeekday(n) {
  const i = sf.weekdays.indexOf(n);
  if (i >= 0) sf.weekdays.splice(i, 1); else sf.weekdays.push(n);
}
async function saveSched() {
  if (!sf.title.trim()) return ElMessage.warning('请填写任务名称');
  if (sf.kind === 'recurring' && sf.freq === 'weekly' && !sf.weekdays.length) {
    return ElMessage.warning('每周打卡至少选择一个星期');
  }
  const body = {
    title: sf.title.trim(), kind: sf.kind,
    ...(sf.kind === 'once'
      ? { once_at: sf.once_at }
      : { freq: sf.freq, weekdays: sf.weekdays, due_time: sf.due_time,
          start_date: sf.start_date, end_date: sf.end_date }),
    allow_late: sf.allow_late ? 1 : 0,
    need_self_progress: sf.need_self_progress ? 1 : 0,
    need_self_rating: sf.need_self_rating ? 1 : 0,
    auto_feature: sf.auto_feature,
  };
  schedSaving.value = true;
  try {
    if (schedEditing.value) await api.teamCheckinScheduleUpdate(props.teamId, schedEditing.value.id, body);
    else await api.teamCheckinScheduleCreate(props.teamId, body);
    ElMessage.success('已保存');
    schedDlg.value = false;
    await loadCheckin();
  } catch (e) { ElMessage.error(e.message); }
  finally { schedSaving.value = false; }
}
async function removeSched(s) {
  try {
    await ElMessageBox.confirm(`删除打卡任务「${s.title}」？历史汇报保留在时间线，但不再继续打卡。`, '删除打卡任务', { type: 'warning' });
  } catch { return; }
  try {
    await api.teamCheckinScheduleDelete(props.teamId, s.id);
    ElMessage.success('已删除');
    await reload();
  } catch (e) { ElMessage.error(e.message); }
}

// ---- 打卡提交弹窗（本地富文本 + 附件 + 自评） ----
const ciDlg = ref(false);
const ciBusy = ref(false);
const ciSched = ref(null);
const ciPeriod = ref('');
const ciDueAt = ref('');
const ciLate = ref(false);
const ciHtml = ref('');
const ciProgress = ref(0);
const ciRating = ref(0);

function fillCiFromLog(l) {
  ciHtml.value = l.content || '';
  reportAtts.value = normAtts(l.attachments).map((a) => ({ ...a }));
  ciProgress.value = l.self_progress || 0;
  ciRating.value = l.self_rating || 0;
  ciLate.value = !!l.is_late;
}
function openCiFromDue(d) {
  ciSched.value = d.schedule;
  ciPeriod.value = d.period_key;
  ciDueAt.value = d.due_at;
  ciHtml.value = ''; reportAtts.value = []; ciProgress.value = 0; ciRating.value = 0;
  ciLate.value = d.status === 'late_window';
  if (d.status === 'submitted') {
    const old = logs.value.find((x) => Number(x.schedule_id) === Number(d.schedule.id) && x.period_key === d.period_key);
    if (old) fillCiFromLog(old);
  }
  ciDlg.value = true;
}
function openCiFromLog(l) {
  const s = schedules.value.find((x) => Number(x.id) === Number(l.schedule_id));
  if (!s) return;
  ciSched.value = s; ciPeriod.value = l.period_key; ciDueAt.value = '';
  fillCiFromLog(l);
  ciDlg.value = true;
}
async function submitCi() {
  const text = ciHtml.value.replace(/<[^>]*>/g, '').trim();
  if (!text && !reportAtts.value.length) return ElMessage.warning('写点本期进展，或附上文件');
  ciBusy.value = true;
  try {
    const r = await api.teamCheckinSubmit(props.teamId, {
      schedule_id: ciSched.value.id, period_key: ciPeriod.value,
      content: ciHtml.value, attachments: reportAtts.value,
      self_progress: ciSched.value.need_self_progress ? ciProgress.value : undefined,
      self_rating: ciSched.value.need_self_rating ? ciRating.value : undefined,
    });
    ElMessage.success(r.message || '打卡成功');
    ciDlg.value = false;
    await reload();
  } catch (e) { ElMessage.error(e.message); }
  finally { ciBusy.value = false; }
}

// ---- 组长评分 / 评语 / 优秀 ----
async function reviewScore(l, v) {
  try {
    const r = await api.teamCheckinReview(props.teamId, l.id, { score: v || null });
    l.score = r.score; l.featured = r.featured;
    ElMessage.success('已评分');
    const ft = await api.teamCheckinFeatured(props.teamId, '');
    featured.value = ft.reports || [];
  } catch (e) { ElMessage.error(e.message); }
}
async function reviewToggleFeatured(l) {
  try {
    const r = await api.teamCheckinReview(props.teamId, l.id, { featured: l.featured ? 0 : 1 });
    l.featured = r.featured;
    ElMessage.success(r.featured ? '已选为优秀汇报' : '已取消优秀');
    const ft = await api.teamCheckinFeatured(props.teamId, '');
    featured.value = ft.reports || [];
  } catch (e) { ElMessage.error(e.message); }
}
async function reviewComment(l) {
  try {
    const { value } = await ElMessageBox.prompt('给这条汇报写句评语（组员可见）', '组长评语', {
      confirmButtonText: '保存', cancelButtonText: '取消', inputType: 'textarea',
      inputValue: l.review || '', inputPlaceholder: '例如：进度扎实，继续保持',
      inputValidator: (v) => (v || '').length <= 500 || '评语不超过 500 字',
    });
    await api.teamCheckinReview(props.teamId, l.id, { review: value || '' });
    l.review = value || '';
    ElMessage.success('评语已保存');
  } catch (e) {
    if (e !== 'cancel' && e?.message) ElMessage.error(e.message);
  }
}

// ---- 提交看板 ----
const boardDlg = ref(false);
const board = ref(null);
const boardSched = ref(null);
const boardRole = ref('');
async function loadBoard(role) {
  boardRole.value = role;
  try {
    board.value = await api.teamCheckinBoard(props.teamId, boardSched.value.id, role);
  } catch (e) { ElMessage.error(e.message); }
}
async function openBoard(s) {
  boardSched.value = s;
  await loadBoard('');
  boardDlg.value = true;
}
const boardCellType = { on: 'success', late: 'warning', miss: 'danger', wait: 'info' };
const boardCellText = { on: '✓', late: '迟', miss: '缺', wait: '待' };

// 优秀汇报卡片展开
const expandedFt = ref(new Set());
function toggleFt(id) {
  const s = new Set(expandedFt.value);
  s.has(id) ? s.delete(id) : s.add(id);
  expandedFt.value = s;
}

function canEditTask(t) {
  return t.assignee_id === props.me.user_id || props.perms.task;
}

async function createTask() {
  if (!newTask.value.title.trim()) return ElMessage.warning('任务标题必填');
  try {
    await api.teamTaskCreate(props.teamId, newTask.value);
    ElMessage.success('任务已创建');
    newTask.value = { title: '', desc: '', deadline: '', assignee_id: null };
    showNew.value = false;
    await reload();
  } catch (e) { ElMessage.error(e.message); }
}

async function updateTask(t, patch) {
  try {
    await api.teamTaskUpdate(props.teamId, t.id, patch);
    Object.assign(t, patch);
  } catch (e) { ElMessage.error(e.message); }
}

async function removeTask(t) {
  try {
    await api.teamTaskDelete(props.teamId, t.id);
    tasks.value = tasks.value.filter((x) => x.id !== t.id);
    ElMessage.success('任务已删除');
  } catch (e) { ElMessage.error(e.message); }
}

// —— 任务说明编辑：卡片 desc 行「✏️」→ 小弹窗（纯文本；可从飞书文档导入，HTML 转纯文本）——
const descDlg = ref(false);
const descTask = ref(null);
const descText = ref('');
const descImpDlg = ref(false);
function openDesc(t) {
  descTask.value = t;
  descText.value = t.desc || '';
  descDlg.value = true;
}
// HTML 片段 → 纯文本（team_task.desc 是纯文本列，插值展示会转义，不能存标签）
function htmlToText(h) {
  return String(h || '').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
}
async function onDescPicked({ document_id }) {
  try {
    const r = await api.feishuDocContent(document_id, 'html');
    descText.value = htmlToText(r.content);
    ElMessage.success(r.title ? `已读取「${r.title}」` : '✅ 已读取文档内容');
  } catch (e) { ElMessage.error(e.message); }
}
async function saveDesc() {
  const t = descTask.value;
  if (!t) return;
  await updateTask(t, { desc: descText.value.trim() });
  descDlg.value = false;
}

// 附件选择（图片/音频/视频/任意文件 → base64）
async function pickAtts(e) {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  for (const f of files) {
    if (f.size > 10 * 1024 * 1024) { ElMessage.warning(`「${f.name}」超过 10MB 上限`); continue; }
    const data = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.readAsDataURL(f);
    });
    const total = reportAtts.value.reduce((s, a) => s + a.data.length, 0) + data.length;
    if (total > MAX_ATT_TOTAL) { ElMessage.warning('附件总量超限（≤25MB）'); break; }
    reportAtts.value.push({ name: f.name, size: f.size, mime: f.type || 'application/octet-stream', data });
  }
}

// 从「我的资源」引用：生成/复用分享链接，push 引用型附件（无 data 有 url，撤销后时间线处失效）
const resPickDlg = ref(false);
const onResourcePick = (r) => {
  reportAtts.value.push({ name: r.name, size: r.size, mime: r.mime, url: r.url });
  ElMessage.success(`已引用「${r.name}」`);
};

// 编辑已有汇报：预填内容与附件（附件浅拷贝，避免改坏时间线原数据）
function editLog(l) {
  if (l.schedule_id) { openCiFromLog(l); return; }
  reportHtml.value = l.content || '';
  reportAtts.value = normAtts(l.attachments).map((a) => ({ ...a }));
  editingLogId.value = l.id;
  reportDlg.value = true;
  // 嵌入式查看：查询该汇报是否已关联飞书文档（有则显示「在飞书打开」徽标）
  feishuDoc.value = l.feishu_url || '';
  feishuOpened.value = false;
}

// 自由汇报（不挂打卡任务）：与「飞书编写」并列的本地入口
function openFreeReport() {
  reportHtml.value = ''; reportAtts.value = []; editingLogId.value = null;
  feishuDoc.value = ''; feishuOpened.value = false;
  reportDlg.value = true;
}

async function submitReport() {
  const text = reportHtml.value.replace(/<[^>]*>/g, '').trim();
  if (!text && !reportAtts.value.length) return ElMessage.warning('写点今天的进展，或附上文件');
  try {
    if (editingLogId.value) {
      await api.teamLogUpdate(props.teamId, editingLogId.value, { content: reportHtml.value, attachments: reportAtts.value });
      ElMessage.success('汇报已更新');
    } else {
      await api.teamLog(props.teamId, { content: reportHtml.value, attachments: reportAtts.value });
      ElMessage.success('进度已汇报');
    }
    reportDlg.value = false;
    await reload();
  } catch (e) { ElMessage.error(e.message); }
}

// ---- 飞书编辑（P1）：进度汇报 ↔ 飞书文档（未提交过时先自动创建汇报记录，再在飞书里完善）
// 交互：查看 = 时间线嵌入式渲染 + 飞书徽标；编写 = 飞书新标签打开 + 时间线顶部横幅（同步/导入/打开）
const feishuBusy = ref(false);
const feishuDoc = ref('');      // 已关联飞书文档链接（显示「在飞书打开」）
const feishuOpened = ref(false); // 本次编辑已打开飞书（显示「飞书编辑中」状态条）
const lastLog = ref(null);      // 最近一次直跳创建的飞书汇报 {id, url} —— 横幅的同步/导入入口（弹窗只在点「✏️ 修改」后才有）

// 「📝 编写汇报」主按钮：直接跳飞书编辑页（后端自动创建汇报记录，写完后回站横幅「从飞书同步」/「从飞书导入」）
async function feishuNewLog() {
  feishuBusy.value = true;
  try {
    const r = await api.feishuBizOpen('progress_log', null, { team_id: props.teamId });
    lastLog.value = { id: r.id, url: r.url };
    window.open(r.url, '_blank');
    ElMessage.success(r.created ? '已创建飞书汇报文档并打开 — 写完后点上方横幅「🔄 从飞书同步」更新到这里' : '已同步最新内容，飞书文档已打开');
    await reload();
  } catch (e) { ElMessage.error(e.message); }
  finally { feishuBusy.value = false; }
}

// 从飞书导入：内容回填编辑器；无记录时后端自动创建（id 绑定编辑态，提交走更新而非新建）
function onImported(html, id) {
  reportHtml.value = html;
  if (id) editingLogId.value = id;
  reload();
}

async function feishuEditLog() {
  // 尚未提交过：先创建汇报记录拿 id（飞书文档需要业务记录 id）
  if (!editingLogId.value) {
    const text = reportHtml.value.replace(/<[^>]*>/g, '').trim();
    if (!text && !reportAtts.value.length) return ElMessage.warning('写点今天的进展，再转飞书编辑');
    try {
      const r = await api.teamLog(props.teamId, { content: reportHtml.value, attachments: reportAtts.value });
      editingLogId.value = r.id;
      await reload();
    } catch (e) { ElMessage.error(e.message); return; }
  }
  feishuBusy.value = true;
  try {
    const r = await api.feishuBizOpen('progress_log', editingLogId.value);
    feishuDoc.value = r.url || '';
    feishuOpened.value = true;
    window.open(r.url, '_blank');
    ElMessage.success(r.created ? '已创建飞书文档并打开，本站窗口保持可同步' : '已同步最新内容，飞书文档已打开');
    await reload();
  } catch (e) { ElMessage.error(e.message); }
  finally { feishuBusy.value = false; }
}
async function feishuSyncLog() {
  const pid = editingLogId.value || lastLog.value?.id;
  if (!pid) return ElMessage.warning('先点「飞书编辑」或「编写汇报」创建文档，再从飞书同步');
  feishuBusy.value = true;
  try {
    const r = await api.feishuBizSync('progress_log', pid);
    ElMessage.success(r.message || '✅ 已从飞书同步');
    await reload();
  } catch (e) { ElMessage.error(e.message); }
  finally { feishuBusy.value = false; }
}

async function removeLog(l) {
  try { await ElMessageBox.confirm('确定撤回这条进度汇报？评论与附件将一并删除', '撤回汇报', { type: 'warning' }); }
  catch { return; }
  try {
    await api.teamLogDelete(props.teamId, l.id);
    logs.value = logs.value.filter((x) => x.id !== l.id);
    ElMessage.success('汇报已撤回');
  } catch (e) { ElMessage.error(e.message); }
}

// 可编辑/撤回：本人或组长（Number 兜底，防类型不一致导致按钮不显示）
const canEditLog = (l) => Number(l.user_id) === Number(props.me.user_id) || props.me.is_owner;

// 作者角色（members 由 TeamDetail 传入，含 role_names 数组）
const roleNamesOf = (uid) => props.members?.find((x) => Number(x.id) === Number(uid))?.role_names || [];

// 富文本内容里的图片：点击 → 全屏预览
function onRichClick(e, l) {
  if (e.target.tagName === 'IMG') {
    openImage(e.target.currentSrc || e.target.src, `汇报图片-${l.id}`);
  }
}

const overall = computed(() => {
  const all = tasks.value;
  if (!all.length) return 0;
  return Math.round(all.reduce((s, t) => s + (t.progress || 0), 0) / all.length);
});

reload().catch((e) => ElMessage.error(e.message));
</script>

<template>
  <div class="tp">
    <!-- 总进度 + 编写入口 -->
    <div class="tp-head">
      <div class="tp-overall">
        <div class="tp-label">小组整体进度</div>
        <el-progress :percentage="overall" :stroke-width="12" :format="() => `${overall}%`" style="flex:1" />
        <el-button plain type="success" @click="openFreeReport">✍️ 自由汇报</el-button>
        <el-button type="primary" :loading="feishuBusy" @click="feishuNewLog">📝 编写汇报（飞书）</el-button>
        <el-button plain :loading="feishuBusy" @click="impDlg = true">📥 从飞书导入</el-button>
      </div>
    </div>

    <!-- 今日打卡待办：应交未交/可补交醒目提示，已交显示自评与评分入口 -->
    <div v-if="myDues.length" class="ci-due">
      <div v-for="d in myDues" :key="d.schedule.id" class="due-card" :class="d.status">
        <div class="due-main">
          <span class="due-icon">{{ d.status === 'submitted' ? '✅' : (d.status === 'missed' ? '⛔' : (d.status === 'late_window' ? '⏰' : '📌')) }}</span>
          <div class="due-text">
            <b>{{ d.schedule.title }}</b>
            <span class="due-sub">
              截止 {{ d.due_at }}
              <template v-if="d.status === 'waiting'"> · 待提交</template>
              <template v-else-if="d.status === 'late_window'"> · 已超时，可补交（标迟交）</template>
              <template v-else-if="d.status === 'missed'"> · 已截止，不能补交</template>
              <template v-else-if="d.late"> · 已补交（迟交）</template>
              <template v-else> · 已提交</template>
            </span>
          </div>
        </div>
        <div class="due-actions">
          <el-tag v-if="d.status === 'submitted' && d.log?.score" size="small" type="warning">⭐ {{ d.log.score }} 分</el-tag>
          <el-button v-if="d.status !== 'missed'" size="small" :type="d.status === 'submitted' ? 'default' : 'primary'"
            @click="openCiFromDue(d)">{{ d.status === 'submitted' ? '查看/修改' : '去打卡' }}</el-button>
        </div>
      </div>
    </div>

    <!-- 汇报编写弹窗（富文本 + 附件，与浏览区分开） -->
    <el-dialog v-model="reportDlg" :title="editingLogId ? '✏️ 编辑进度汇报' : '📝 编写进度汇报'" width="640px" top="4vh" class="editor-dlg" :close-on-click-modal="false"
      destroy-on-close append-to-body>
      <!-- 可切到飞书文档写长文（P1）；未提交过时点按钮自动创建汇报再编辑；打开后本站留窗显示状态条 -->
      <div class="rp-feishu">
        <el-button size="small" type="primary" plain :loading="feishuBusy" @click="feishuEditLog">📄 飞书编辑</el-button>
        <el-button size="small" plain :loading="feishuBusy" @click="feishuSyncLog">🔄 从飞书同步</el-button>
        <el-button size="small" plain @click="impDlg = true">📥 从飞书导入</el-button>
      </div>
      <div v-if="feishuOpened" class="rp-feishu-open">
        ✅ 已在飞书打开该文档 — 在飞书写完后点「🔄 从飞书同步」更新到这里
      </div>
      <LiteEditor v-model="reportHtml" placeholder="今天做了什么？卡在哪？下一步？（可直接粘贴图片）" />
      <div class="rp-tools">
        <input ref="fileInput" type="file" multiple hidden @change="pickAtts" />
        <el-button size="small" @click="fileInput.click()">📎 附件（图片/音频/视频/文件）</el-button>
        <el-button size="small" plain @click="resPickDlg = true">📁 我的资源</el-button>
        <ResourcePicker v-model="resPickDlg" @pick="onResourcePick" />
        <span v-if="reportAtts.length" class="att-chips">
          <el-tag v-for="(a, i) in reportAtts" :key="i" closable size="small" class="att-tag" :title="a.name"
            @close="reportAtts.splice(i, 1)">
            {{ a.name }}
          </el-tag>
        </span>
        <span class="rp-tip">图片会以缩略图展示，点击可放大下载</span>
      </div>
      <template #footer>
        <el-button @click="reportDlg = false">取消</el-button>
        <el-button type="primary" @click="submitReport">提交汇报</el-button>
      </template>
    </el-dialog>

    <!-- ============ 打卡任务建/改弹窗 ============ -->
    <el-dialog v-model="schedDlg" :title="schedEditing ? '设置打卡任务' : '新建打卡任务'" width="560px" top="6vh"
      append-to-body :close-on-click-modal="false">
      <el-form label-position="top" class="ci-form">
        <el-form-item label="任务名称" required>
          <el-input v-model="sf.title" maxlength="40" show-word-limit placeholder="如：每日训练打卡 / 周报" />
        </el-form-item>
        <el-form-item label="任务类型">
          <el-radio-group v-model="sf.kind">
            <el-radio-button label="recurring">周期性打卡</el-radio-button>
            <el-radio-button label="once">定时任务汇报</el-radio-button>
          </el-radio-group>
        </el-form-item>

        <template v-if="sf.kind === 'recurring'">
          <el-form-item label="频率">
            <el-radio-group v-model="sf.freq">
              <el-radio label="daily">每日</el-radio>
              <el-radio label="weekly">每周指定星期</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item v-if="sf.freq === 'weekly'" label="打卡日">
            <div class="wd-row">
              <el-button v-for="(n, i) in [1,2,3,4,5,6,7]" :key="n" size="small"
                :type="sf.weekdays.includes(n) ? 'primary' : 'default'"
                @click="toggleWeekday(n)">{{ ['周一','周二','周三','周四','周五','周六','周日'][i] }}</el-button>
            </div>
          </el-form-item>
          <el-form-item label="每期截止时间">
            <el-time-picker v-model="sf.due_time" format="HH:mm" value-format="HH:mm" placeholder="如 21:00" />
          </el-form-item>
          <el-form-item label="生效区间（不填结束=长期）">
            <el-date-picker v-model="sf.start_date" type="date" value-format="YYYY-MM-DD" placeholder="开始" />
            <span class="ci-dash">至</span>
            <el-date-picker v-model="sf.end_date" type="date" value-format="YYYY-MM-DD" placeholder="结束（可空）" />
          </el-form-item>
        </template>
        <el-form-item v-else label="汇报截止时间">
          <el-date-picker v-model="sf.once_at" type="datetime" format="YYYY-MM-DD HH:mm"
            value-format="YYYY-MM-DDTHH:mm" placeholder="选择截止日期与时间" />
        </el-form-item>

        <el-form-item label="规则">
          <div class="ci-opts">
            <el-switch v-model="sf.allow_late" active-text="允许补交（标记迟交）" />
            <el-switch v-model="sf.need_self_progress" active-text="提交时自评进度(%)" />
            <el-switch v-model="sf.need_self_rating" active-text="提交时自评完成效果(1-5)" />
            <div class="ci-auto">
              自动优秀：
              <el-select v-model="sf.auto_feature" size="small" style="width:150px">
                <el-option :value="0" label="仅手动评定" />
                <el-option :value="5" label="评 5 星自动入选" />
                <el-option :value="4" label="评 4 星及以上自动入选" />
              </el-select>
            </div>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="schedDlg = false">取消</el-button>
        <el-button type="primary" :loading="schedSaving" @click="saveSched">保存</el-button>
      </template>
    </el-dialog>

    <!-- ============ 打卡提交弹窗（本地富文本 + 附件 + 自评） ============ -->
    <el-dialog v-model="ciDlg" :title="ciSched ? `打卡 · ${ciSched.title}` : '打卡'" width="720px" top="4vh"
      append-to-body :close-on-click-modal="false" class="editor-dlg">
      <div class="ci-dlg-meta">
        <el-tag size="small" effect="plain">本期：{{ ciPeriod }}</el-tag>
        <el-tag v-if="ciLate" size="small" type="warning">迟交</el-tag>
        <span v-if="ciDueAt">截止 {{ ciDueAt }}</span>
      </div>
      <LiteEditor v-model="ciHtml" placeholder="本期做了什么？卡在哪？下一步？（可直接粘贴图片）" />
      <div class="rp-tools">
        <input ref="ciFileInput" type="file" multiple hidden @change="pickAtts" />
        <el-button size="small" @click="ciFileInput.click()">📎 附件（图片/音频/视频/文件）</el-button>
        <el-button size="small" plain @click="resPickDlg = true">📁 我的资源</el-button>
        <ResourcePicker v-model="resPickDlg" @pick="onResourcePick" />
        <span v-if="reportAtts.length" class="att-chips">
          <el-tag v-for="(a, i) in reportAtts" :key="i" closable size="small" class="att-tag" :title="a.name"
            @close="reportAtts.splice(i, 1)">{{ a.name }}</el-tag>
        </span>
      </div>
      <div v-if="ciSched?.need_self_progress || ciSched?.need_self_rating" class="ci-self-form">
        <div v-if="ciSched?.need_self_progress" class="ci-self-item">
          <span>本期完成进度：<b>{{ ciProgress }}%</b></span>
          <el-slider v-model="ciProgress" style="max-width:320px" />
        </div>
        <div v-if="ciSched?.need_self_rating" class="ci-self-item">
          <span>完成效果自评：</span>
          <el-rate v-model="ciRating" />
        </div>
      </div>
      <template #footer>
        <el-button @click="ciDlg = false">取消</el-button>
        <el-button type="primary" :loading="ciBusy" @click="submitCi">提交打卡</el-button>
      </template>
    </el-dialog>

    <!-- ============ 提交看板弹窗（成员 × 周期） ============ -->
    <el-dialog v-model="boardDlg" :title="board ? `提交看板 · ${board.schedule.title}` : '提交看板'" width="780px"
      top="8vh" append-to-body>
      <div v-if="board" class="board-wrap">
        <div class="board-filter">
          <span class="bf-label">查看角色：</span>
          <el-select :model-value="boardRole" size="small" style="width:170px" @change="loadBoard">
            <el-option label="全部成员" value="" />
            <el-option label="👑 组长" value="owner" />
            <el-option v-for="r in board.roles" :key="r.id" :value="r.id" :label="r.name" />
          </el-select>
          <span class="bf-count">已交 {{ board.submitted_total }} 格 / 共 {{ board.members.length * board.periods.length }} 格</span>
        </div>
        <table class="board-table">
          <thead>
            <tr>
              <th class="b-name">成员</th>
              <th v-for="p in board.periods" :key="p.key">{{ p.label }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in board.members" :key="m.id">
              <td class="b-name">
                <div class="b-name-line">{{ selfName({ id: m.id, nickname: m.name }, me.user_id) }}<span v-if="m.is_owner"> 👑</span></div>
                <div class="b-roles">
                  <el-tag v-for="rn in m.role_names" :key="rn" size="small" effect="plain">{{ rn }}</el-tag>
                  <span v-if="!m.role_names.length && !m.is_owner" class="b-norole">无角色</span>
                </div>
              </td>
              <td v-for="c in m.cells" :key="c.key" class="b-cell">
                <el-tag size="small" :type="boardCellType[c.state]" effect="c.state === 'wait' ? 'plain' : 'dark'">
                  {{ boardCellText[c.state] }}
                </el-tag>
                <span v-if="c.featured" title="优秀">🏅</span>
              </td>
            </tr>
            <tr v-if="!board.members.length"><td :colspan="board.periods.length + 1" class="b-empty">该角色下暂无成员</td></tr>
          </tbody>
        </table>
        <div class="board-legend">
          <el-tag size="small" type="success" effect="dark">✓ 准时</el-tag>
          <el-tag size="small" type="warning" effect="dark">迟 迟交</el-tag>
          <el-tag size="small" type="danger" effect="dark">缺 未交</el-tag>
          <el-tag size="small" type="info" effect="plain">待 未到期</el-tag>
        </div>
      </div>
    </el-dialog>

    <!-- 任务说明编辑弹窗（纯文本；可从飞书文档导入，HTML 转纯文本） -->
    <el-dialog v-model="descDlg" title="✏️ 编辑任务说明" width="480px" top="18vh" append-to-body :close-on-click-modal="false">
      <div class="rp-feishu">
        <el-button size="small" plain @click="descImpDlg = true">📥 从飞书导入</el-button>
      </div>
      <el-input v-model="descText" type="textarea" :rows="4" placeholder="任务说明（纯文本，导入的飞书文档会自动转为文本）" />
      <template #footer>
        <el-button @click="descDlg = false">取消</el-button>
        <el-button type="primary" @click="saveDesc">保存</el-button>
      </template>
    </el-dialog>
    <!-- 从飞书导入文档选择器（弹窗与横幅共用；必须挂弹窗外面——弹窗 destroy-on-close 会销毁内部组件，横幅导入将无反应） -->
    <DocPicker v-model="impDlg" biz-type="progress_log" :biz-id="editingLogId ?? lastLog?.id ?? null"
      :extra="{ team_id: props.teamId }" @imported="onImported" />
    <DocPicker v-model="descImpDlg" raw @picked="onDescPicked" />

    <!-- 任务列表 -->
    <div class="tp-tasks">
      <div class="tp-tools">
        <h4>📌 任务看板（{{ tasks.length }}）</h4>
        <el-button v-if="perms.task" size="small" type="primary" plain @click="showNew = !showNew">
          {{ showNew ? '收起' : '＋ 新建任务' }}
        </el-button>
      </div>

      <div v-if="showNew" class="task-new">
        <el-input v-model="newTask.title" placeholder="任务标题（如：机械结构装配）" style="flex:2" />
        <el-select v-model="newTask.assignee_id" placeholder="负责人" clearable style="flex:1">
          <el-option v-for="m in members.filter(x => !x.is_owner || x.is_me)" :key="m.id" :value="m.id"
            :label="`${selfName(m, me.user_id)}${m.is_owner ? '（组长）' : ''}`" />
        </el-select>
        <el-date-picker v-model="newTask.deadline" type="date" placeholder="截止日期" value-format="YYYY-MM-DD" style="flex:1" />
        <el-button type="primary" @click="createTask">创建</el-button>
        <el-input v-model="newTask.desc" placeholder="任务说明（选填）" style="flex:2" />
      </div>

      <div v-if="!tasks.length" class="tp-empty">暂无任务 — 有「任务管理」权限的成员可创建</div>
      <div v-for="t in tasks" :key="t.id" class="task-card" :class="t.status">
        <div class="tc-top">
          <b>{{ t.title }}</b>
          <el-tag size="small" :type="STATUS[t.status].tag">{{ STATUS[t.status].label }}</el-tag>
        </div>
        <div v-if="t.desc" class="tc-desc">
          {{ t.desc }}
          <el-button v-if="canEditTask(t)" size="small" text type="primary" class="desc-edit" @click="openDesc(t)">✏️</el-button>
        </div>
        <div v-else-if="canEditTask(t)" class="tc-desc"><el-button size="small" text type="primary" @click="openDesc(t)">✏️ 添加说明</el-button></div>
        <div class="tc-meta">
          <span v-if="t.assignee_name">👤 {{ selfName({ id: t.assignee_id, nickname: t.assignee_name }, me.user_id) }}</span>
          <span v-if="t.deadline">⏰ {{ t.deadline }}</span>
          <span class="tc-date">创建 {{ fmtDateOnly(t.create_time) }}</span>
        </div>
        <div class="tc-progress">
          <el-progress :percentage="t.progress || 0" :stroke-width="8" :status="t.status === 'done' ? 'success' : undefined" style="flex:1" />
          <template v-if="canEditTask(t)">
            <el-select v-model="t.status" size="small" style="width: 100px" @change="(v) => updateTask(t, { status: v })">
              <el-option v-for="(s, k) in STATUS" :key="k" :value="k" :label="s.label" />
            </el-select>
            <el-input-number v-model="t.progress" :min="0" :max="100" size="small" style="width: 110px"
              @change="(v) => updateTask(t, { progress: v })" />
            <el-button v-if="perms.task" size="small" text type="danger" @click="removeTask(t)">删除</el-button>
          </template>
        </div>
      </div>
    </div>

    <!-- ============ 周期打卡 / 定时汇报 ============ -->
    <div class="ci-sec">
      <div class="tp-tools">
        <h4>🗓️ 打卡任务（{{ schedules.length }}）</h4>
        <el-button v-if="perms.task" size="small" type="primary" plain @click="openSchedCreate">＋ 新建打卡任务</el-button>
      </div>
      <div v-if="!schedules.length" class="tp-empty">还没有打卡任务 — 有「任务管理」权限的成员可建每日/每周打卡或定时汇报</div>
      <div v-for="s in schedules" :key="s.id" class="ci-card">
        <div class="ci-head">
          <b>{{ s.title }}</b>
          <el-tag size="small" :type="s.kind === 'once' ? 'danger' : 'primary'" effect="plain">
            {{ s.kind === 'once' ? '定时' : (s.freq === 'daily' ? '每日' : '每周') }}
          </el-tag>
          <el-tag v-if="!s.allow_late" size="small" type="info" effect="plain">不可补交</el-tag>
          <el-tag v-if="s.need_self_progress || s.need_self_rating" size="small" type="success" effect="plain">
            需自评{{ s.need_self_progress ? '进度' : '' }}{{ s.need_self_progress && s.need_self_rating ? '+' : '' }}{{ s.need_self_rating ? '效果' : '' }}
          </el-tag>
          <span class="ci-freq">{{ schedFreqText(s) }}</span>
          <span class="spacer" style="margin-left:auto"></span>
          <el-button size="small" text @click="openBoard(s)">📊 看板</el-button>
          <el-button v-if="perms.task" size="small" text type="primary" @click="openSchedEdit(s)">设置</el-button>
          <el-button v-if="perms.task" size="small" text type="danger" @click="removeSched(s)">删除</el-button>
        </div>
      </div>
    </div>

    <!-- ============ 优秀汇报墙 ============ -->
    <div class="ci-sec" v-if="featured.length">
      <div class="tp-tools"><h4>🏅 优秀汇报（{{ featured.length }}）</h4></div>
      <div class="ft-grid">
        <div v-for="f in featured" :key="f.id" class="ft-card">
          <div class="ft-head">
            <span class="lb-avatar" v-if="f.avatar"><img :src="f.avatar" alt="" /></span>
            <span class="lb-avatar no-img" v-else>{{ (f.nickname || '?').slice(0, 1) }}</span>
            <b class="u-link" @click="toProfile(f)">{{ selfName(f, me.user_id) }}</b>
            <el-tag size="small" type="warning" effect="dark">⭐ {{ f.score || '—' }}</el-tag>
            <el-tag size="small" effect="plain" v-if="f.schedule_title">{{ f.schedule_title }}</el-tag>
            <span class="ft-date">{{ fmtShort(f.create_time) }}</span>
          </div>
          <div class="ft-body log-rich" :class="{ clamp: !expandedFt.has(f.id) }" v-html="f.content"
            @click="(e) => onRichClick(e, f)"></div>
          <AttachmentList v-if="f.attachments?.length" :attachments="f.attachments" />
          <div v-if="f.review" class="ft-review">组长评语：{{ f.review }}</div>
          <el-button v-if="(f.content || '').replace(/<[^>]*>/g, '').length > 120" link size="small"
            @click="toggleFt(f.id)">{{ expandedFt.has(f.id) ? '收起' : '展开全文' }}</el-button>
        </div>
      </div>
    </div>

    <!-- 进度汇报时间线 -->
    <div class="tp-logs">
      <h4>🗣️ 成员进度汇报</h4>
      <!-- 直跳横幅：主按钮「编写汇报」进飞书后，本站唯一的同步/导入入口（弹窗需点「✏️ 修改」才有） -->
      <div v-if="lastLog" class="rp-banner">
        <span>🪶 最近从飞书编写：</span>
        <a :href="lastLog.url" target="_blank" rel="noopener">📄 在飞书打开 →</a>
        <el-button size="small" :loading="feishuBusy" @click="feishuSyncLog">🔄 从飞书同步</el-button>
        <el-button size="small" @click="impDlg = true">📥 从飞书导入</el-button>
        <el-button size="small" text class="banner-close" @click="lastLog = null">✕</el-button>
      </div>
      <el-timeline v-if="logs.length">
        <el-timeline-item v-for="l in logs" :key="l.id" :timestamp="fmtShort(l.create_time)">
          <!-- 作者行：汇报者 + 修改/撤回（本人或组长） -->
          <div class="log-head">
            <span class="log-avatar u-link" v-if="l.avatar" @click="toProfile(l)"><img :src="l.avatar" alt="" /></span>
            <span class="log-author u-link" @click="toProfile(l)">{{ selfName(l, me.user_id) || '未知成员' }}</span>
            <el-tag v-for="rn in roleNamesOf(l.user_id)" :key="rn" size="small" effect="plain">{{ rn }}</el-tag>
            <el-tag v-if="Number(l.user_id) === Number(me.user_id)" size="small" type="info">我</el-tag>
            <span class="log-actions">
              <el-button v-if="canEditLog(l)" size="small" text type="primary" @click="editLog(l)">✏️ 修改</el-button>
              <el-button v-if="canEditLog(l)" size="small" text type="danger" @click="removeLog(l)">↩️ 撤回</el-button>
            </span>
          </div>
          <!-- 嵌入式查看：该汇报已关联飞书文档 → 徽标 + 在飞书打开 -->
          <div v-if="l.feishu_url" class="rp-feishu-link">
            🪶 已关联飞书文档 <a :href="l.feishu_url" target="_blank" rel="noopener">📄 在飞书打开 →</a>
          </div>
          <!-- 周期打卡条目：任务标签 + 状态 + 优秀徽标 -->
          <div v-if="l.schedule_id" class="ci-log-tags">
            <el-tag size="small" type="primary" effect="plain">🗓️ {{ l.schedule_title || '打卡' }} · {{ l.period_key }}</el-tag>
            <el-tag v-if="l.is_late" size="small" type="warning" effect="plain">迟交</el-tag>
            <el-tag v-if="l.featured" size="small" type="danger" effect="dark">🏅 优秀</el-tag>
          </div>
          <div v-if="l.schedule_id && (l.self_progress != null || l.self_rating != null)" class="ci-self">
            <span v-if="l.self_progress != null">自评进度 <b>{{ l.self_progress }}%</b></span>
            <el-progress v-if="l.self_progress != null" :percentage="l.self_progress" :stroke-width="6"
              :show-text="false" style="width:120px" />
            <span v-if="l.self_rating != null">自评效果 <b>{{ '★'.repeat(l.self_rating) }}</b></span>
          </div>
          <div v-if="l.content" class="log-rich" v-html="l.content" @click="(e) => onRichClick(e, l)"></div>
          <AttachmentList v-if="l.attachments?.length" :attachments="l.attachments" />
          <!-- 组长评价区：评分 / 评语 / 优秀（task 权限者可操作） -->
          <div v-if="l.schedule_id" class="ci-review">
            <template v-if="perms.task">
              <el-rate :model-value="l.score || 0" :max="5" size="small" @change="(v) => reviewScore(l, v)" />
              <el-button size="small" text @click="reviewComment(l)">💬 评语</el-button>
              <el-button size="small" text :type="l.featured ? 'danger' : 'default'"
                @click="reviewToggleFeatured(l)">{{ l.featured ? '取消优秀' : '选为优秀' }}</el-button>
            </template>
            <span v-if="l.score" class="ci-review-show">组长评分 <b>{{ '★'.repeat(l.score) }}</b></span>
            <span v-if="l.review" class="ci-review-show">“{{ l.review }}”</span>
          </div>
          <CommentThread :team-id="teamId" type="log" :target="l" />
        </el-timeline-item>
      </el-timeline>
      <div v-else class="tp-empty">还没有汇报 — 点右上「📝 编写汇报」记录进展</div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.tp-head { margin-bottom: 16px;
  .tp-overall { display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    .tp-label { font-size: 13px; color: var(--text-2); white-space: nowrap; }
  }
}
.rp-feishu { display: flex; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; }
// 嵌入式查看：飞书文档徽标（时间线条目顶部）
.rp-feishu-link {
  display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
  font-size: 12.5px; color: var(--text-2); background: var(--primary-tint); border: 1px solid color-mix(in srgb, var(--primary) 30%, white);
  border-radius: 8px; padding: 6px 12px; margin: 4px 0 8px;
  a { color: var(--primary); font-weight: 600; text-decoration: none; &:hover { text-decoration: underline; } }
}
// 编写留窗状态条：飞书打开后提示回站同步
.rp-feishu-open {
  font-size: 12.5px; color: var(--success-fg); background: var(--success-tint); border: 1px solid var(--success-border);
  border-radius: 8px; padding: 6px 12px; margin-bottom: 6px;
}
// 直跳横幅：时间线顶部（最近一次飞书编写的同步/导入入口）
.rp-banner {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  font-size: 12.5px; color: var(--primary-dark); background: var(--primary-tint); border: 1px solid color-mix(in srgb, var(--primary) 30%, white);
  border-radius: 8px; padding: 6px 12px; margin-bottom: 10px;
  a { color: var(--primary); font-weight: 600; text-decoration: none; &:hover { text-decoration: underline; } }
  .banner-close { margin-left: auto; }
}
.rp-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px;
  .att-chips { display: flex; gap: 4px; flex-wrap: wrap; }
  // 附件名不换行：过长省略号 + title 悬浮全名（断行会竖排挤压排版）
  .att-tag {
    max-width: 240px; vertical-align: middle;
    :deep(.el-tag__content) {
      display: inline-block; max-width: 200px; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; vertical-align: middle;
    }
  }
  .rp-tip { margin-left: auto; color: #94a3b8; font-size: 12px; }
}
.log-rich { line-height: 1.8; font-size: 13.5px;
  :deep(img) { max-width: 100%; max-height: 320px; border-radius: 8px; cursor: zoom-in; }
  :deep(video) { max-width: 100%; max-height: 320px; border-radius: 8px; }
  :deep(a) { color: var(--primary); }
}
.tp-tasks {
  .tp-tools { display: flex; justify-content: space-between; align-items: center; h4 { margin: 0 0 10px; } }
  .task-new { display: flex; gap: 8px; flex-wrap: wrap; background: var(--surface-3); border: 1px dashed var(--border); border-radius: 10px; padding: 10px; margin-bottom: 10px; }
  .tp-empty { color: #94a3b8; font-size: 13px; padding: 14px 0; }
  .task-card {
    border: 1px solid var(--border); border-left: 3px solid #94a3b8; border-radius: 10px; padding: 10px 12px; margin-bottom: 10px;
    &.done { border-left-color: #16a34a; background: var(--success-tint); }
    &.doing { border-left-color: #f59e0b; }
    .tc-top { display: flex; justify-content: space-between; align-items: center; b { font-size: 14px; } }
    .tc-desc { color: var(--text-2); font-size: 13px; margin: 4px 0;
      .desc-edit { margin-left: 2px; padding: 0 4px; }
    }
    .tc-meta { display: flex; gap: 12px; color: var(--text-2); font-size: 12px; margin-bottom: 6px; flex-wrap: wrap;
      .tc-date { margin-left: auto; }
    }
    .tc-progress { display: flex; align-items: center; gap: 8px; }
  }
  // 移动端：进度条独占一行，状态/进度/删除控件换到下一行（窄屏单行放不下）
  @media (max-width: 768px) {
    .tc-progress { flex-wrap: wrap; }
    .tc-progress .el-progress { flex: 1 1 100% !important; } /* 压过内联 style="flex:1" */
  }
}
.tp-logs { margin-top: 18px; h4 { margin: 0 0 10px; } .tp-empty { color: #94a3b8; font-size: 13px; padding: 14px 0; } }
.log-head {
  display: flex; align-items: center; gap: 8px; margin-bottom: 8px;
  .log-avatar {
    width: 26px; height: 26px; border-radius: 50%; overflow: hidden; flex-shrink: 0;
    display: inline-flex; align-items: center; justify-content: center;
    background: var(--primary)1a; border: 1px solid var(--primary)33;
    img { width: 100%; height: 100%; object-fit: cover; }
  }
  .log-author { font-size: 13.5px; font-weight: 600; }
  .u-link { cursor: pointer; &:hover { color: var(--primary); } }
  .log-actions { margin-left: auto; display: flex; gap: 2px; }
}
.log-rich {
  :deep(video) { max-width: 100%; max-height: 320px; border-radius: 8px; }
  :deep(iframe) { width: 100%; max-width: 640px; height: 360px; border-radius: 8px; border: none; }
}

// ==================== 周期打卡 ====================
.ci-due { margin: 12px 0 4px; display: flex; flex-direction: column; gap: 8px; }
.due-card {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px;
  background: color-mix(in srgb, var(--primary) 6%, white);
  &.submitted { background: var(--success-tint, #f0fdf4); border-color: var(--success-border, #bbf7d0); }
  &.late_window { background: #fffbeb; border-color: #fcd34d; }
  &.missed { background: #f8fafc; opacity: .85; }
  .due-main { display: flex; align-items: center; gap: 10px; }
  .due-icon { font-size: 20px; }
  .due-text { display: flex; flex-direction: column; b { font-size: 14px; } }
  .due-sub { font-size: 12px; color: var(--text-2); }
  .due-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
}
.ci-sec { margin-top: 20px;
  .tp-tools { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 10px; h4 { margin: 0; } }
}
.tp-empty { color: #94a3b8; font-size: 13px; padding: 12px 0; }
.ci-card { border: 1px solid var(--border); border-radius: 10px; padding: 8px 12px; margin-bottom: 8px; }
.ci-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  b { font-size: 13.5px; } .ci-freq { font-size: 12px; color: var(--text-2); }
  .el-button { margin-left: 2px; }
}
.ci-form {
  .wd-row { display: flex; gap: 6px; flex-wrap: wrap; }
  .ci-dash { margin: 0 8px; color: var(--text-2); }
  .ci-opts { display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
  .ci-auto { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-2); }
}
.ci-dlg-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 12.5px; color: var(--text-2); }
.ci-self-form { margin-top: 12px; border-top: 1px dashed var(--border); padding-top: 10px;
  .ci-self-item { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; flex-wrap: wrap; }
}

// 时间线内的打卡标签 / 自评 / 评分区
.ci-log-tags { display: flex; gap: 6px; flex-wrap: wrap; margin: 4px 0 6px; }
.ci-self { display: flex; align-items: center; gap: 10px; font-size: 12.5px; color: var(--text-2); margin-bottom: 6px; flex-wrap: wrap;
  b { color: var(--primary); }
}
.ci-review { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 8px;
  padding-top: 6px; border-top: 1px dashed var(--border);
  .ci-review-show { font-size: 12.5px; color: var(--text-2); b { color: #f59e0b; letter-spacing: 1px; } }
}

// 头像小圆圈（排行榜移至成员页后，优秀墙仍复用）
.lb-avatar { width: 28px; height: 28px; border-radius: 50%; overflow: hidden; flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center; font-size: 12px;
  background: color-mix(in srgb, var(--primary) 12%, white); color: var(--primary);
  img { width: 100%; height: 100%; object-fit: cover; }
  &.no-img { font-weight: 600; }
}

// 优秀墙
.ft-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.ft-card { border: 1px solid var(--border); border-radius: 12px; padding: 12px; background: var(--card-bg);
  box-shadow: 0 1px 3px rgba(0,0,0,.05); display: flex; flex-direction: column; gap: 8px;
  .ft-head { display: flex; align-items: center; gap: 8px; font-size: 13px; flex-wrap: wrap; }
  .ft-date { margin-left: auto; font-size: 11.5px; color: #94a3b8; }
  .ft-body { font-size: 13px; line-height: 1.7; overflow: hidden;
    &.clamp { display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; }
  }
  .ft-review { font-size: 12.5px; color: var(--text-2); background: var(--surface-3, #f8fafc);
    border-radius: 8px; padding: 6px 10px; }
}

// 看板
.board-wrap { overflow-x: auto; }
.board-filter { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap;
  .bf-label { font-size: 13px; color: var(--text-2); }
  .bf-count { font-size: 12.5px; color: var(--text-2); }
}
.board-table { border-collapse: separate; border-spacing: 0; width: 100%; min-width: 480px;
  th, td { border-bottom: 1px solid var(--border); padding: 8px 10px; text-align: center; white-space: nowrap; font-size: 13px; }
  th { background: var(--surface-3, #f8fafc); position: sticky; top: 0; }
  .b-name { text-align: left; font-weight: 600; position: sticky; left: 0; background: var(--card-bg); z-index: 1; }
  .b-name-line { font-weight: 600; }
  .b-roles { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 2px; font-weight: 400; }
  .b-norole { font-size: 11px; color: #cbd5e1; }
  .b-cell { display: table-cell; }
  .b-cell :deep(.el-tag) { margin-right: 2px; }
  .b-empty { text-align: center; color: #94a3b8; padding: 20px 0; }
}
.board-legend { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }

@media (max-width: 768px) {
  .ci-head { .ci-freq { width: 100%; } }
  .ft-grid { grid-template-columns: 1fr; }
}
</style>
