<script setup>
// 我的备赛日程页：小组任务 / 竞赛日程 / 学习日程 / 月历 四 tab（小组任务默认，月历组件独立自加载）
// 任务勾选完成时记录完成日期 done_at，月历按完成日聚合
import { ref, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api.js';
import ManualPlanDialog from './ManualPlanDialog.vue';
import ScheduleNotes from './ScheduleNotes.vue';
import CalendarView from './CalendarView.vue';
import StudyView from './StudyView.vue';
import MyTeamTasks from './team/MyTeamTasks.vue';
import auth from '../auth.js';
import { fmtDate } from '../utils/noteStatus.js';
import PlanChat from './PlanChat.vue';

// 页面 tab：team 小组任务（默认）| comp 竞赛日程 | study 学习日程 | calendar 月历（支持 ?tab=xx 深链）
const route = useRoute();
const router = useRouter();
const viewTab = ref(['team', 'comp', 'study', 'calendar'].includes(route.query.tab) ? route.query.tab : 'team');
watch(viewTab, (v) => {
  router.replace({ query: { ...route.query, tab: v } }).catch(() => {});
});

// 移动端 tab 标签换短文案（4 个 tab 全标签含 emoji 在窄屏放不下）
const mqNarrow = window.matchMedia('(max-width: 768px)');
const isNarrow = ref(mqNarrow.matches);
mqNarrow.addEventListener('change', (e) => { isNarrow.value = e.matches; });
function lab(full, short) { return isNarrow.value ? short : full; }

const schedules = ref([]);
const loading = ref(false);
const savingId = ref(null);
const manualDlg = ref(false);
const competitions = ref([]);

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
  // 完成日期（本地时区 YYYY-MM-DD）：月历按完成日聚合；取消勾选清空
  t.done_at = t.done ? fmtDate(new Date()) : null;
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

// 对话式 AI 修改（schedule-edit，后端已保存；已勾选任务自动保留）
const chatSid = ref(null);
const chatOpen = ref(false);
function openChat(s) {
  chatSid.value = s.id;
  chatOpen.value = true;
}
function onChatDone(r) {
  chatOpen.value = false;
  const s = schedules.value.find((x) => x.id === chatSid.value);
  if (s && r.plan?.phases) {
    s.phases = r.plan.phases;
    s.is_custom = 0;
  }
  ElMessage.success('✅ 备赛日程已按对话修改');
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

onMounted(load);
</script>

<template>
  <main class="schedule-page">
    <!-- 四 tab：小组任务默认；笔记浮窗四 tab 共用，挂在 tabs 外层 -->
    <el-tabs v-model="viewTab" class="page-tabs">
    <el-tab-pane :label="lab('🏗️ 小组任务', '小组')" name="team">
      <template v-if="auth.token">
        <MyTeamTasks />
      </template>
      <el-empty v-else description="登录后查看所在小组的备赛任务" :image-size="80" />
    </el-tab-pane>

    <el-tab-pane :label="lab('🏆 竞赛日程', '竞赛')" name="comp">
    <div class="page-head">
      <h2>📋 我的备赛日程</h2>
      <div class="head-right">
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

    <!-- ========== 任务清单 ========== -->
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
              <el-button size="small" type="success" plain @click="openChat(s)">💬 AI 修改</el-button>
              <el-button size="small" type="warning" plain @click="optimize(s)">⚡ AI 优化</el-button>
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
          <div v-if="!s.phases?.length" class="phase-empty">该日程暂无阶段数据，可点「💬 AI 修改」重新生成</div>

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
    </el-tab-pane>

    <el-tab-pane :label="lab('📚 学习日程', '学习')" name="study">
      <div class="study-wrap">
        <StudyView />
      </div>
    </el-tab-pane>

    <el-tab-pane :label="lab('🗓️ 月历', '月历')" name="calendar">
      <CalendarView />
    </el-tab-pane>
    </el-tabs>

    <!-- 日程笔记浮窗：四个 tab 共享，可拖动、可收起 -->
    <ScheduleNotes :schedules="schedules" />

    <!-- 对话式 AI 修改备赛日程（AI 先确认调整方向，已勾选任务自动保留） -->
    <PlanChat v-model="chatOpen" mode="schedule-edit" :schedule-id="chatSid" @done="onChatDone" />
  </main>
</template>

<style lang="scss" scoped>
.schedule-page { padding: 12px 20px 80px; }

// 合并页签：小组任务 / 竞赛日程 / 学习日程 / 月历
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

// 移动端：按钮组换行、日期输入铺满
@media (max-width: 768px) {
  .s-head { flex-direction: column; align-items: stretch; }
  .s-actions { flex-wrap: wrap; gap: 6px; }
  .ph-head { flex-direction: column; align-items: stretch; }
  .date-input { width: 100% !important; }
  .add-task .el-input { flex: 1; }
}
</style>
