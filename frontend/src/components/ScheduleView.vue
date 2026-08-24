<script setup>
// 我的备赛日程页：日程列表（分阶段任务勾选/编辑/新增/自编）+ 月历视图 + 导出 + AI优化
import { ref, computed, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api.js';
import ManualPlanDialog from './ManualPlanDialog.vue';
import ScheduleNotes from './ScheduleNotes.vue';
import StudyView from './StudyView.vue';
import MyTeamTasks from './team/MyTeamTasks.vue';
import auth from '../auth.js';
import RichEditor from './team/RichEditor.vue';
import { NOTE_STATUS, statusOf, fmtDate, pad2 } from '../utils/noteStatus.js';

// 页面 tab：comp 竞赛日程 | study 学习日程 | team 小组任务（支持 ?tab=xx 深链，如 /study 重定向）
const route = useRoute();
const router = useRouter();
const viewTab = ref(['comp', 'study', 'team'].includes(route.query.tab) ? route.query.tab : 'comp');
watch(viewTab, (v) => {
  router.replace({ query: { ...route.query, tab: v } }).catch(() => {});
});

const schedules = ref([]);
const loading = ref(false);
const savingId = ref(null);
const viewMode = ref('list'); // list | calendar
const manualDlg = ref(false);
const competitions = ref([]);

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// 后端 list 返回 { ...row, plan: {phases:[...]} }，这里拍平为顶层 phases 供模板/保存使用
async function load() {
  loading.value = true;
  try {
    schedules.value = (await api.scheduleList()).map((s) => ({
      ...s,
      plan: undefined,
      phases: s.plan?.phases || [],
    }));
  } catch (e) {
    ElMessage.error(`加载日程失败：${e.message}`);
  } finally {
    loading.value = false;
  }
}

// 即时保存（勾选/新增/删除/改日期/改文本都触发）
async function save(s) {
  savingId.value = s.id;
  try {
    await api.scheduleEdit(s.id, { phases: s.phases });
    s.is_custom = 1;
  } catch (e) {
    ElMessage.error(`保存失败：${e.message}`);
  } finally {
    savingId.value = null;
  }
}

function toggleTask(s, t) {
  t.done = !t.done;
  save(s);
}
function addTask(s, ph) {
  const txt = (ph.newTask || '').trim();
  if (!txt) return;
  ph.tasks.push({ text: txt, done: false });
  ph.newTask = '';
  save(s);
}
function removeTask(s, ph, i) {
  ph.tasks.splice(i, 1);
  save(s);
}

// ---- 内容编辑：任务文本 / 阶段名 / 达标要求 / 增删阶段 ----
function commitTaskEdit(s, ph, t) {
  t._editing = false;
  t.text = String(t.text || '').trim();
  if (!t.text) {
    const i = ph.tasks.indexOf(t);
    if (i >= 0) ph.tasks.splice(i, 1);
  }
  save(s);
}
function commitPhaseEdit(s, ph) {
  ph._editingName = false;
  ph.phase = String(ph.phase || '').trim() || '未命名阶段';
  save(s);
}
function commitCheckEdit(s, ph) {
  ph._editCheck = false;
  ph.check_standard = String(ph.check_standard || '').trim();
  save(s);
}
function addPhase(s, i) {
  s.phases.splice(i + 1, 0, { phase: '新阶段', date: '', tasks: [], check_standard: '', week_hours: 0 });
  save(s);
}
async function removePhase(s, i) {
  if (s.phases.length <= 1) return ElMessage.warning('至少保留一个阶段');
  try {
    await ElMessageBox.confirm(`删除「${s.phases[i].phase || `阶段${i + 1}`}」？该阶段任务会一并删除`, '删除阶段', { type: 'warning' });
  } catch { return; }
  s.phases.splice(i, 1);
  save(s);
}

// 自编计划：加载竞赛列表供选择
async function openManual() {
  if (!competitions.value.length) {
    try { competitions.value = await api.competitions(); } catch (e) { ElMessage.error(e.message); }
  }
  manualDlg.value = true;
}

async function optimize(s) {
  try {
    const res = await api.scheduleOptimize(s.id);
    s.phases = res.plan.phases || [];
    s.is_custom = 0;
    ElMessage.success('🤖 AI 已生成优化版计划（已完成任务自动保留勾选）');
  } catch (e) {
    ElMessage.error(`${e.message}${e.message.includes('KEY') ? '（在 backend/.env 配置 DEEPSEEK_API_KEY 后可用）' : ''}`);
  }
}

async function remove(s) {
  try {
    await ElMessageBox.confirm(`删除「${s.comp_name}」的备赛日程？`, '删除确认', { type: 'warning' });
  } catch {
    return; // 取消
  }
  try {
    await api.scheduleDelete(s.id);
    schedules.value = schedules.value.filter((x) => x.id !== s.id);
    ElMessage.success('已删除');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

const progress = (s) => {
  const tasks = (s.phases || []).flatMap((p) => p.tasks || []);
  return { done: tasks.filter((t) => t.done).length, total: tasks.length };
};

// ---- 月历视图（真实日历）：日期格 = 阶段标签 + 笔记状态点，点击回看/记录当天笔记 ----
const calY = ref(new Date().getFullYear());
const calM = ref(new Date().getMonth()); // 0-11
const calNotes = ref([]);
const calLoading = ref(false);
const todayStr = fmtDate(new Date());

// 阶段起止日期解析：兼容 "2026-03-01 ~ 2026-04-30" / "3月-5月" / "3.15" / "4月"（跨年不做推断，收尾到同年）
function parsePhaseRange(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const y = calY.value;
  const mk = (p) => `${p[0]}-${pad2(+p[1])}-${pad2(+p[2])}`;
  const pair = s.match(/(\d{4})[年./-](\d{1,2})[月./-](\d{1,2})(?:[~至—到-]+(\d{4})[年./-](\d{1,2})[月./-](\d{1,2}))?/);
  if (pair) {
    const start = mk([pair[1], pair[2], pair[3]]);
    const end = pair[4] ? mk([pair[4], pair[5], pair[6]]) : start;
    return { start, end: end < start ? start : end };
  }
  const md = s.match(/(\d{1,2})[月./-](\d{1,2})(?:[~至—到-]+(\d{1,2})[月./-](\d{1,2}))?/);
  if (md) {
    const start = mk([y, md[1], md[2]]);
    const end = md[3] ? mk([y, md[3], md[4]]) : start;
    return { start, end: end < start ? start : end };
  }
  const mo = s.match(/(\d{1,2})月(?:[~至—到-]+(\d{1,2})月)?/);
  if (mo) {
    const m1 = Math.min(12, Math.max(1, +mo[1]));
    const m2 = mo[2] ? Math.min(12, Math.max(1, +mo[2])) : m1;
    return { start: mk([y, m1, 1]), end: mk([y, m2, new Date(y, m2, 0).getDate()]) };
  }
  return null;
}

const phaseRanges = computed(() => {
  const out = [];
  for (const s of schedules.value) {
    for (const ph of s.phases || []) {
      const rg = parsePhaseRange(ph.date);
      if (rg) out.push({ comp: s.comp_name, phase: ph.phase, ...rg });
    }
  }
  return out;
});

const calCells = computed(() => {
  const days = new Date(calY.value, calM.value + 1, 0).getDate();
  const firstDow = new Date(calY.value, calM.value, 1).getDay(); // 0=周日（周日开头）
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= days; d++) {
    const ds = `${calY.value}-${pad2(calM.value + 1)}-${pad2(d)}`;
    cells.push({
      date: ds, day: d, isToday: ds === todayStr,
      note: calNotes.value.find((n) => n.note_date === ds) || null,
      phases: phaseRanges.value.filter((p) => ds >= p.start && ds <= p.end),
    });
  }
  return cells;
});

async function loadCalNotes() {
  calLoading.value = true;
  try {
    calNotes.value = await api.notesMonth(`${calY.value}-${pad2(calM.value + 1)}`);
  } catch (e) {
    ElMessage.error(`加载笔记失败：${e.message}`);
  } finally {
    calLoading.value = false;
  }
}
function calShift(dm) {
  calM.value += dm;
  if (calM.value > 11) { calM.value = 0; calY.value++; }
  if (calM.value < 0) { calM.value = 11; calY.value--; }
  loadCalNotes();
}
function calGoToday() {
  calY.value = new Date().getFullYear();
  calM.value = new Date().getMonth();
  loadCalNotes();
}

// ---- 点击日期 → 弹窗回看 / 记录当天笔记 ----
const calDlg = ref(false);
const calDlgDate = ref('');
const calDlgMode = ref('view'); // view 回看 | edit 记录/编辑
const calDlgNote = ref(null);
const dlgStatus = ref('');
const dlgContent = ref('');
const dlgSaving = ref(false);
const dlgDeleting = ref(false);

function openCalDay(c) {
  calDlgDate.value = c.date;
  calDlgNote.value = c.note;
  dlgStatus.value = c.note?.status || '';
  dlgContent.value = c.note?.content || '';
  calDlgMode.value = c.note ? 'view' : 'edit';
  calDlg.value = true;
}
async function calDlgSave() {
  if (!dlgContent.value.trim() && !dlgStatus.value) return ElMessage.warning('写点内容或选个状态再保存');
  dlgSaving.value = true;
  try {
    const res = await api.noteSave({
      note_date: calDlgDate.value, content: dlgContent.value, status: dlgStatus.value,
    });
    await loadCalNotes();
    calDlgNote.value = { id: res.id, note_date: calDlgDate.value, status: dlgStatus.value, content: dlgContent.value };
    calDlgMode.value = 'view';
    ElMessage.success('📝 笔记已保存');
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    dlgSaving.value = false;
  }
}
async function calDlgDelete() {
  if (!calDlgNote.value) return;
  dlgDeleting.value = true;
  try {
    await api.noteDelete(calDlgNote.value.id);
    calDlgNote.value = null;
    dlgContent.value = '';
    dlgStatus.value = '';
    calDlgMode.value = 'edit';
    await loadCalNotes();
    ElMessage.success('已删除');
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    dlgDeleting.value = false;
  }
}

// 切入月历视图时拉当月笔记（右侧面板里保存的新笔记也能同步看到）
watch(viewMode, (v) => { if (v === 'calendar') loadCalNotes(); });

onMounted(load);
</script>

<template>
  <main class="schedule-page">
    <!-- 合并页签：竞赛日程 / 学习日程 / 小组任务（笔记浮窗三 tab 共用，挂在 tabs 外层） -->
    <el-tabs v-model="viewTab" class="page-tabs">
    <el-tab-pane label="🏆 竞赛日程" name="comp">
    <div class="page-head">
      <h2>📋 我的备赛日程</h2>
      <div class="head-right">
        <el-radio-group v-model="viewMode" size="small">
          <el-radio-button value="list">📑 任务清单</el-radio-button>
          <el-radio-button value="calendar">🗓️ 月历视图</el-radio-button>
        </el-radio-group>
        <el-button size="small" type="primary" plain @click="openManual">✍️ 自编计划</el-button>
        <el-button size="small" :loading="loading" @click="load">刷新</el-button>
      </div>
    </div>

    <!-- 自编计划弹窗（手动编写，不经 AI） -->
    <ManualPlanDialog v-model="manualDlg" mode="schedule" :competitions="competitions" @created="load" />

    <!-- 空状态 -->
    <el-empty v-if="!loading && !schedules.length" description="还没有备赛日程">
      <router-link to="/">
        <el-button type="primary">去时间轴选一个竞赛 →</el-button>
      </router-link>
    </el-empty>

    <!-- ========== 任务清单视图 ========== -->
    <template v-if="viewMode === 'list'">
      <div class="s-wrap">
      <div v-loading="loading" class="s-list">
        <div v-for="s in schedules" :key="s.id" class="s-card">
          <!-- 卡头 -->
          <div class="s-head">
            <div class="s-title">
              <b>{{ s.comp_name }}</b>
              <el-tag v-if="s.is_custom" size="small" type="warning" style="margin-left:8px">手动修改过</el-tag>
              <span class="s-time">生成于 {{ s.create_time }}</span>
            </div>
            <div class="s-actions">
              <el-button size="small" :loading="savingId === s.id" @click="save(s)">💾 保存</el-button>
              <el-button size="small" type="warning" plain @click="optimize(s)">🤖 AI 优化</el-button>
              <el-dropdown trigger="click" style="margin: 0 4px">
                <el-button size="small" plain>⬇️ 导出</el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item>
                      <a :href="api.scheduleExportUrl(s.id)" target="_blank" style="text-decoration:none;color:inherit">Markdown</a>
                    </el-dropdown-item>
                    <el-dropdown-item>
                      <a :href="api.scheduleExportUrl(s.id, 'excel')" target="_blank" style="text-decoration:none;color:inherit">Excel（CSV）</a>
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
              <el-button size="small" type="danger" plain @click="remove(s)">删除</el-button>
            </div>
          </div>

          <!-- 进度条 -->
          <div class="s-progress">
            <span class="p-label">总体进度</span>
            <el-progress
              :percentage="progress(s).total ? Math.round((progress(s).done / progress(s).total) * 100) : 0"
              :stroke-width="8" style="flex:1"
            />
            <span class="p-num">{{ progress(s).done }}/{{ progress(s).total }}</span>
          </div>

          <!-- 无阶段数据兜底 -->
          <div v-if="!s.phases?.length" class="phase-empty">该日程暂无阶段数据，可点「🤖 AI 优化」重新生成</div>

          <!-- 分阶段任务 -->
          <div v-for="(ph, i) in s.phases" :key="i" class="phase-block">
            <div class="ph-head">
              <span class="ph-name">阶段{{ i + 1 }}：
                <template v-if="ph._editingName">
                  <el-input v-model="ph.phase" size="small" class="name-edit" autofocus
                    @blur="commitPhaseEdit(s, ph)" @keyup.enter="commitPhaseEdit(s, ph)" />
                </template>
                <template v-else>
                  {{ ph.phase }}
                  <el-button text size="small" class="name-edit-btn" title="重命名阶段"
                    @click="ph._editingName = true">✏️</el-button>
                </template>
              </span>
              <span class="ph-right">
                <span class="ph-date">🗓️
                  <el-input
                    v-model="ph.date" size="small" class="date-input" clearable
                    placeholder="起止日期（如 3月-5月）" @change="save(s)"
                  />
                </span>
                <el-button size="small" text type="primary" title="在此阶段后添加新阶段"
                  @click="addPhase(s, i)">＋ 阶段</el-button>
                <el-button size="small" text type="danger" title="删除该阶段"
                  @click="removePhase(s, i)">🗑</el-button>
              </span>
            </div>

            <div class="task-list">
              <div
                v-for="(t, j) in ph.tasks" :key="j"
                class="task" :class="{ done: t.done }"
              >
                <span class="cb" :class="{ on: t.done }" title="勾选完成"
                  @click="toggleTask(s, t)">{{ t.done ? '✓' : '' }}</span>
                <el-input v-if="t._editing" v-model="t.text" size="small" class="t-edit" autofocus
                  @mousedown.stop
                  @blur="commitTaskEdit(s, ph, t)" @keyup.enter="commitTaskEdit(s, ph, t)" />
                <span v-else class="t-text" title="点击编辑任务" @click="t._editing = true">{{ t.text }}</span>
                <span class="t-del" title="删除任务" @click.stop="removeTask(s, ph, j)">✕</span>
              </div>

              <!-- 新增自定义任务 -->
              <div class="add-task">
                <el-input
                  v-model="ph.newTask" size="small" placeholder="新增自定义任务，Enter 添加"
                  @keyup.enter="addTask(s, ph)"
                />
                <el-button size="small" @click="addTask(s, ph)">添加</el-button>
              </div>
            </div>

            <div class="ph-meta">
              <span v-if="ph.check_standard || ph._editCheck" class="check">✅ 达标：
                <template v-if="ph._editCheck">
                  <el-input v-model="ph.check_standard" size="small" class="check-edit" autofocus
                    @mousedown.stop
                    @blur="commitCheckEdit(s, ph)" @keyup.enter="commitCheckEdit(s, ph)" />
                </template>
                <template v-else>
                  {{ ph.check_standard }}
                  <el-button text size="small" class="meta-edit-btn" title="编辑达标要求"
                    @click="ph._editCheck = true">✏️</el-button>
                </template>
              </span>
              <el-button v-else-if="!ph._editCheck" text size="small" class="meta-add-btn"
                @click="ph._editCheck = true">＋ 达标要求</el-button>
              <span v-if="ph.week_hours" class="week">🕐 {{ ph.week_hours }}h/周</span>
            </div>
          </div>
        </div>
      </div>
      </div>
    </template>

    <!-- ========== 月历视图（真实日历：点击日期回看/记录笔记） ========== -->
    <div v-else class="cal-wrap">
      <div class="cal-toolbar">
        <el-button size="small" @click="calShift(-1)">‹ 上月</el-button>
        <b class="cal-ym">{{ calY }} 年 {{ calM + 1 }} 月</b>
        <el-button size="small" @click="calShift(1)">下月 ›</el-button>
        <el-button size="small" text @click="calGoToday">回到本月</el-button>
        <span class="cal-hint">💡 点击日期可回看 / 记录当天笔记</span>
      </div>
      <div v-loading="calLoading" class="cal-box">
        <div class="cal-week">
          <span v-for="w in ['日', '一', '二', '三', '四', '五', '六']" :key="w">{{ w }}</span>
        </div>
        <div class="cal-grid">
          <div v-for="(c, i) in calCells" :key="i" class="cal-cell"
            :class="{ blank: !c, today: c?.isToday, hasnote: c?.note }" @click="c && openCalDay(c)">
            <template v-if="c">
              <div class="cal-day">{{ c.day }}</div>
              <div v-if="c.note" class="cal-note" title="当天有笔记，点击回看">
                <span class="cal-dot" :style="statusOf(c.note.status) ? { background: statusOf(c.note.status).color } : {}" />
                <span class="cal-note-txt">📝 笔记</span>
              </div>
              <div v-for="(p, j) in c.phases.slice(0, 2)" :key="j" class="cal-phase"
                :title="p.comp + ' · ' + p.phase">{{ p.phase }}</div>
              <div v-if="c.phases.length > 2" class="cal-more">+{{ c.phases.length - 2 }}</div>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- 点击日期 → 回看 / 记录当天笔记 -->
    <el-dialog v-model="calDlg" :title="`${calDlgDate} ${WEEK_CN[new Date(calDlgDate + 'T00:00:00').getDay()]}`" width="780px" top="6vh" destroy-on-close>
      <div v-if="calDlgMode === 'view' && calDlgNote" class="dlg-note-view">
        <div v-if="statusOf(calDlgNote.status)" class="dlg-status"
          :style="{ color: statusOf(calDlgNote.status).color, background: statusOf(calDlgNote.status).color + '1a' }">
          {{ statusOf(calDlgNote.status).emoji }} 今日状态：{{ statusOf(calDlgNote.status).label }}
        </div>
        <div v-if="calDlgNote.content" class="dlg-body" v-html="calDlgNote.content"></div>
        <div v-else class="dlg-empty">这天只记录了状态，没有文字内容</div>
      </div>
      <div v-else>
        <el-select v-model="dlgStatus" size="small" placeholder="今日学习状态" clearable class="dlg-status-sel">
          <el-option v-for="st in NOTE_STATUS" :key="st.key" :value="st.key" :label="`${st.emoji} ${st.label}`" />
        </el-select>
        <RichEditor v-model="dlgContent" placeholder="记录今天学了什么、卡在哪、明天做什么…" />
      </div>
      <template #footer>
        <el-button v-if="calDlgMode === 'view' && calDlgNote" size="small" type="danger" plain
          :loading="dlgDeleting" @click="calDlgDelete">删除</el-button>
        <el-button v-if="calDlgMode === 'view' && calDlgNote" size="small" type="primary" plain
          @click="calDlgMode = 'edit'">✏️ 编辑</el-button>
        <el-button v-if="calDlgMode === 'edit'" size="small" @click="calDlg = false">取消</el-button>
        <el-button v-if="calDlgMode === 'edit'" size="small" type="primary" :loading="dlgSaving"
          @click="calDlgSave">💾 保存</el-button>
      </template>
    </el-dialog>
    </el-tab-pane>

    <el-tab-pane label="📚 学习日程" name="study">
      <div class="study-wrap">
        <StudyView />
      </div>
    </el-tab-pane>

    <el-tab-pane label="🏗️ 小组任务" name="team">
      <template v-if="auth.token">
        <MyTeamTasks />
      </template>
      <el-empty v-else description="登录后查看所在小组的备赛任务" :image-size="80" />
    </el-tab-pane>
    </el-tabs>

    <!-- 日程笔记浮窗：三个 tab 共享，可拖动、可收起 -->
    <ScheduleNotes :schedules="schedules" />
  </main>
</template>

<style lang="scss" scoped>
.schedule-page { padding: 12px 20px 80px; }

// 合并页签：竞赛日程 / 学习日程
.page-tabs {
  :deep(.el-tabs__header) { margin-bottom: 12px; }
  :deep(.el-tabs__item) { font-size: 14.5px; }
}
// 学习日程 tab：StudyView 独立占满
:deep(.study-page) { padding: 0; max-width: none; }

.page-head {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px;
  h2 { margin: 0; font-size: 20px; }
  .head-right { display: flex; gap: 10px; align-items: center; }
}

// 任务清单：卡片流（笔记已独立为浮窗，不再占右侧栏位）
.s-list { display: flex; flex-direction: column; gap: 16px; }

.s-card {
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px;
  padding: 14px 16px; box-shadow: 0 2px 10px rgba(0, 0, 0, .05);

  .s-head {
    display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;
    .s-title { display: flex; align-items: center; b { font-size: 16px; } }
    .s-time { color: var(--text-2); font-size: 12px; margin-left: 10px; }
    .s-actions { display: flex; align-items: center; }
  }

  .s-progress {
    display: flex; align-items: center; gap: 12px; margin: 10px 0 4px;
    .p-label { font-size: 13px; color: var(--text-2); white-space: nowrap; }
    .p-num { font-size: 13px; color: var(--text-2); white-space: nowrap; }
  }

  .phase-block {
    margin-top: 12px; border: 1px solid var(--border); border-radius: 8px;
    background: #f8fafc; padding: 10px 12px;

    .ph-head {
      display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;
      .ph-name { font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 4px;
        .name-edit { width: 160px; }
        .name-edit-btn { padding: 0 4px; }
      }
      .ph-right { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
      .ph-date { display: flex; align-items: center; gap: 6px; color: var(--text-2); font-size: 13px; }
      .date-input { width: 170px; }
    }

    .task-list { margin-top: 8px; }

    .task {
      display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px;
      cursor: pointer; user-select: none; font-size: 13px;
      &:hover { background: #eef2f7; }
      &.done .t-text { color: #94a3b8; text-decoration: line-through; }

      .cb {
        width: 17px; height: 17px; border: 2px solid #cbd5e1; border-radius: 4px;
        display: inline-flex; align-items: center; justify-content: center;
        font-size: 12px; color: #fff; flex-shrink: 0; cursor: pointer;
        &.on { background: #16a34a; border-color: #16a34a; }
      }
      .t-text { flex: 1; cursor: text;
        &:hover { color: #2563eb; }
      }
      .t-edit { flex: 1; }
      .t-del {
        color: #cbd5e1; font-size: 12px; padding: 0 4px; border-radius: 4px;
        &:hover { color: #ef4444; background: #fee2e2; }
      }
    }

    .add-task { display: flex; gap: 8px; margin-top: 6px; }
  }

  .ph-meta {
    margin-top: 8px; display: flex; gap: 16px; flex-wrap: wrap; font-size: 12.5px;
    .check { color: #047857; display: flex; align-items: center; gap: 4px;
      .check-edit { width: 220px; }
      .meta-edit-btn { padding: 0 4px; }
    }
    .meta-add-btn { color: #94a3b8; padding: 0 4px; }
    .week { color: #1d4ed8; }
  }

  .phase-empty {
    margin-top: 12px; padding: 18px; text-align: center; color: var(--text-2);
    border: 1px dashed var(--border); border-radius: 8px; font-size: 13px;
  }
}

// 月历（真实日历）
.cal-wrap { max-width: 1080px; }
.cal-toolbar {
  display: flex; align-items: center; gap: 8px; margin-bottom: 10px;
  .cal-ym { font-size: 15px; min-width: 110px; text-align: center; }
  .cal-hint { margin-left: auto; color: var(--text-2); font-size: 12px; }
}
.cal-box {
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 10px;
}
.cal-week {
  display: grid; grid-template-columns: repeat(7, 1fr); text-align: center;
  font-size: 12px; color: var(--text-2); font-weight: 600; padding: 4px 0 8px;
}
.cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; }
.cal-cell {
  min-height: 80px; border: 1px solid var(--border); border-radius: 8px; padding: 4px 6px;
  cursor: pointer; transition: all .15s; background: #fff; overflow: hidden;
  &:hover { border-color: #2563eb; box-shadow: 0 1px 6px rgba(37, 99, 235, .18); }
  &.blank { visibility: hidden; }
  &.today { border-color: #2563eb; background: #eff6ff; }
  &.hasnote { border-color: #f59e0b; }
  &.today.hasnote { border-color: #2563eb; background: #eff6ff; }

  .cal-day { font-size: 12.5px; font-weight: 700; color: #475569; }
  .today & .cal-day { color: #2563eb; }
  .cal-note {
    display: flex; align-items: center; gap: 4px; margin-top: 3px;
    font-size: 10.5px; color: #b45309; font-weight: 600;
    .cal-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; background: #e2e8f0; flex-shrink: 0; }
  }
  .cal-phase {
    font-size: 10px; background: #eff6ff; color: #1d4ed8; border-radius: 4px;
    padding: 1px 4px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .cal-more { font-size: 10px; color: #94a3b8; margin-top: 1px; }
}

// 日历弹窗：回看富文本笔记
.dlg-note-view {
  .dlg-status {
    display: inline-block; padding: 3px 12px; border-radius: 999px;
    font-size: 13px; font-weight: 600; margin-bottom: 10px;
  }
  .dlg-body {
    line-height: 1.8; font-size: 14px; color: #1e293b; overflow-y: auto; max-height: 55vh;
    :deep(img) { max-width: 100%; border-radius: 6px; }
    :deep(video) { max-width: 100%; border-radius: 6px; }
    :deep(iframe) { width: 100%; max-width: 640px; height: 360px; border-radius: 6px; border: none; }
    :deep(a) { color: #2563eb; }
  }
  .dlg-empty { color: #94a3b8; font-size: 13px; padding: 10px 0; }
}
.dlg-status-sel { width: 100%; margin-bottom: 8px; }
</style>
