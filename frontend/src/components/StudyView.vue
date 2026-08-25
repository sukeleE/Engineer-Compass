<script setup>
// AI 学习日程：告诉 AI 想学的技能/知识点 → 生成分阶段学习计划 + 推荐各平台学习资料
// 支持 AI 生成 / 自编计划 / 已有计划内容编辑（任务/阶段名/达标/增删阶段）
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api.js';
import { fmtDate } from '../utils/noteStatus.js';
import ManualPlanDialog from './ManualPlanDialog.vue';
import PlanChat from './PlanChat.vue';

const form = ref({ topic: '', level: '零基础', goal: '', hours: 10 });
const generating = ref(false);
const list = ref([]);
const detail = ref(null);
const saving = ref(false);
const loadingDetail = ref(false);
const manualDlg = ref(false);
const chatCreate = ref(false); // AI 对话生成学习日程
const chatEdit = ref(false); // AI 对话修改学习日程
const genOpen = ref(false); // AI 生成区默认收起（移动端占屏），点击标题展开

// 平台元数据（与 CompDialog 学习资源一致）
const PLATFORM_META = {
  bilibili: { name: 'B站', icon: '📺', color: '#00a1d6' },
  zhihu: { name: '知乎', icon: '🧠', color: '#0084ff' },
  csdn: { name: 'CSDN', icon: '💻', color: '#cf0000' },
  wechat: { name: '微信公众号', icon: '📱', color: '#07c160' },
  douyin: { name: '抖音', icon: '🎵', color: '#3b3b3b' },
  cnki: { name: '知网', icon: '📚', color: '#0b4da2' },
  github: { name: 'GitHub', icon: '🐙', color: '#181717' },
  tencent: { name: '腾讯视频', icon: '🎬', color: '#ff7218' },
};
const metaOf = (p) => PLATFORM_META[p] || { name: p, icon: '🔗', color: '#64748b' };

const LEVEL_OPTIONS = [
  { label: '零基础', value: '零基础' },
  { label: '入门（了解基础概念）', value: '入门' },
  { label: '进阶（有项目经验）', value: '进阶' },
];

const progress = computed(() => {
  const tasks = (detail.value?.plan?.phases || []).flatMap((p) => p.tasks || []);
  const done = tasks.filter((t) => t.done).length;
  return { done, total: tasks.length, pct: tasks.length ? Math.round((done / tasks.length) * 100) : 0 };
});

const detailResources = (kind) => (detail.value?.resources || []).filter((r) => r.kind === kind);

async function loadList() {
  list.value = await api.studyList();
  if (list.value.length && !list.value.some((s) => s.id === detail.value?.id)) select(list.value[0]);
}

async function select(s) {
  loadingDetail.value = true;
  try {
    detail.value = await api.studyDetail(s.id);
  } catch (e) {
    ElMessage.error(`加载失败：${e.message}`);
  } finally {
    loadingDetail.value = false;
  }
}

async function generate() {
  const topic = form.value.topic.trim();
  if (!topic) return ElMessage.warning('先告诉我你想学什么（如：STM32、强化学习、数据结构）');
  generating.value = true;
  try {
    const res = await api.studyPlan({
      topic,
      level: form.value.level,
      goal: form.value.goal.trim() || undefined,
      hours: form.value.hours,
    });
    ElMessage.success('✅ 学习日程已生成');
    form.value.topic = '';
    form.value.goal = '';
    await loadList();
    const item = list.value.find((s) => s.id === res.id);
    if (item) select(item);
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    generating.value = false;
  }
}

// 保存计划（勾选/编辑文本/阶段变更都走这里）
async function savePlan() {
  saving.value = true;
  try {
    await api.studyUpdate(detail.value.id, detail.value.plan);
  } catch (e) {
    ElMessage.error(`保存失败：${e.message}`);
  } finally {
    saving.value = false;
  }
}

// 勾选任务 → 即时保存（写完成日期 done_at，月历按完成日聚合；失败回滚 done/done_at）
async function toggleTask(t) {
  const old = { done: t.done, done_at: t.done_at };
  t.done = !t.done;
  t.done_at = t.done ? fmtDate(new Date()) : null;
  try {
    await savePlan();
  } catch (e) {
    t.done = old.done;
    t.done_at = old.done_at;
    ElMessage.error(`保存失败：${e.message}`);
  }
}

// ---- 内容编辑：任务文本 / 阶段名 / 达标要求 / 增删阶段 ----
function commitTaskEdit(ph, t) {
  t._editing = false;
  t.text = String(t.text || '').trim();
  if (!t.text) {
    const i = ph.tasks.indexOf(t);
    if (i >= 0) ph.tasks.splice(i, 1);
  }
  savePlan();
}
function removeTaskItem(ph, j) {
  ph.tasks.splice(j, 1);
  savePlan();
}
function commitPhaseEdit(ph) {
  ph._editingName = false;
  ph.phase = String(ph.phase || '').trim() || '未命名阶段';
  savePlan();
}
function commitCheckEdit(ph) {
  ph._editCheck = false;
  ph.check_standard = String(ph.check_standard || '').trim();
  savePlan();
}
function addPhase(i) {
  detail.value.plan.phases.splice(i + 1, 0, { phase: '新阶段', date: '', tasks: [], check_standard: '', week_hours: 0 });
  savePlan();
}
async function removePhase(i) {
  const phases = detail.value.plan.phases;
  if (phases.length <= 1) return ElMessage.warning('至少保留一个阶段');
  try {
    await ElMessageBox.confirm(`删除「${phases[i].phase || `阶段${i + 1}`}」？该阶段任务会一并删除`, '删除阶段', { type: 'warning' });
  } catch { return; }
  phases.splice(i, 1);
  savePlan();
}

// 自编计划创建成功 → 刷新列表并选中新计划
// 对话式生成/修改完成（后端已保存）→ 刷新列表与详情
async function onChatDone(r, isEdit) {
  if (isEdit) {
    chatEdit.value = false;
    detail.value = await api.studyDetail(r.plan_id);
    await loadList();
    ElMessage.success('✅ 学习日程已按对话修改');
    return;
  }
  chatCreate.value = false;
  await loadList();
  const item = list.value.find((s) => s.id === r.plan_id);
  if (item) select(item);
  ElMessage.success('✅ 学习日程已生成');
}

async function onManualCreated(res) {
  await loadList();
  const item = list.value.find((s) => s.id === res.id);
  if (item) select(item);
}

async function removeStudy(s) {
  try {
    await ElMessageBox.confirm(`删除学习日程「${s.topic}」？`, '确认删除', { type: 'warning' });
  } catch { return; }
  try {
    await api.studyDelete(s.id);
    detail.value = null;
    await loadList();
    ElMessage.success('已删除');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

onMounted(() => loadList().catch((e) => ElMessage.error(`加载学习日程失败：${e.message}`)));
</script>

<template>
  <div class="study-page">
    <!-- AI 生成区（默认收起，点击标题展开——移动端不占屏） -->
    <div class="gen-card">
      <div class="gen-head" :class="{ open: genOpen }" @click="genOpen = !genOpen">
        <div>
          <h2>🤖 AI 学习日程 <span class="gen-fold-arrow">▾</span></h2>
          <p class="gen-tip">告诉 AI 你想学的技能或知识点（不限于竞赛）——自动生成分阶段学习计划，并推荐 B站 / 知乎 / CSDN / 微信 / GitHub 等各平台的学习资料。</p>
        </div>
        <el-button type="primary" plain @click.stop="manualDlg = true">✍️ 自编计划</el-button>
      </div>
      <template v-if="genOpen">
        <div class="gen-form">
          <el-input
            v-model="form.topic" size="large" placeholder="学习主题，如：STM32 单片机 / 强化学习 / 数据结构与算法"
            @keyup.enter="generate"
          />
          <el-select v-model="form.level" size="large" style="width: 160px">
            <el-option v-for="o in LEVEL_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
          <el-input v-model="form.goal" size="large" placeholder="学习目标（选填），如：做出平衡小车" />
          <el-input-number v-model="form.hours" :min="2" :max="80" size="large" style="width: 130px">
            <template #prefix>周</template>
          </el-input-number>
          <el-button type="primary" size="large" @click="chatCreate = true">💬 AI 对话生成</el-button>
          <el-button size="large" :loading="generating" @click="generate">⚡ 快速生成</el-button>
        </div>
        <div v-if="generating" class="gen-loading">
          <span class="spinner"></span> AI 正在规划学习路径与资料检索关键词…
        </div>
        <div class="gen-chat-tip">💬 AI 对话生成：AI 会先确认你的学习主题、水平、目标与时间投入，再产出计划</div>
      </template>
    </div>

    <!-- 自编计划弹窗（手动编写，不经 AI） -->
    <ManualPlanDialog v-model="manualDlg" mode="study"
      @created="onManualCreated" />

    <!-- 对话式 AI：生成 / 修改学习日程（AI 先确认主题与投入，已勾选任务自动保留） -->
    <PlanChat v-model="chatCreate" mode="study" @done="(r) => onChatDone(r, false)" />
    <PlanChat v-model="chatEdit" mode="study-edit" :study-id="detail?.id" @done="(r) => onChatDone(r, true)" />

    <!-- 列表 + 详情 -->
    <div class="study-body">
      <!-- 左：日程列表 -->
      <aside class="study-list">
        <div class="list-title">📚 我的学习日程（{{ list.length }}）</div>
        <div v-if="!list.length" class="list-empty">还没有学习日程<br>输入主题点「✨ AI 生成」即可创建</div>
        <div
          v-for="s in list" :key="s.id"
          class="list-item" :class="{ active: s.id === detail?.id }"
          @click="select(s)"
        >
          <div class="li-top">
            <b class="li-topic">{{ s.topic }}</b>
            <el-tag size="small" type="info" effect="plain">{{ s.phaseCount }} 阶段</el-tag>
          </div>
          <div class="li-meta">{{ s.create_time?.slice(0, 10) }}<template v-if="s.level"> · {{ s.level }}</template></div>
          <div class="li-progress">
            <el-progress :percentage="s.total ? Math.round((s.done / s.total) * 100) : 0" :stroke-width="6" :show-text="false" />
            <span>{{ s.done }}/{{ s.total }}</span>
          </div>
        </div>
      </aside>

      <!-- 右：详情 -->
      <section class="study-detail" v-loading="loadingDetail">
        <div v-if="!detail" class="detail-empty">
          <div class="de-icon">📖</div>
          <p>选择左侧学习日程查看详情</p>
          <p class="de-sub">或输入主题生成你的第一份学习日程</p>
        </div>
        <template v-else>
          <div class="detail-head">
            <div>
              <h3>{{ detail.topic }}</h3>
              <div class="dh-tags">
                <el-tag v-if="detail.level" size="small">{{ detail.level }}</el-tag>
                <el-tag v-if="detail.goal" size="small" type="warning" effect="plain">🎯 {{ detail.goal }}</el-tag>
                <el-tag v-if="detail.hours" size="small" type="success" effect="plain">⏱ 每周 {{ detail.hours }}h</el-tag>
              </div>
              <p v-if="detail.plan?.summary" class="dh-summary">{{ detail.plan.summary }}</p>
            </div>
            <div class="dh-ops">
              <el-button size="small" type="success" plain @click="chatEdit = true">💬 AI 修改</el-button>
              <el-button size="small" type="danger" plain @click="removeStudy(detail)">删除</el-button>
            </div>
          </div>

          <div class="detail-progress">
            <el-progress :percentage="progress.pct" :stroke-width="10" :format="() => `${progress.done}/${progress.total} 已完成`" />
          </div>

          <!-- 分阶段任务（可编辑） -->
          <div v-for="(ph, i) in (detail.plan?.phases || [])" :key="i" class="phase">
            <div class="phase-head">
              <span class="phase-name">阶段{{ i + 1 }}：
                <template v-if="ph._editingName">
                  <el-input v-model="ph.phase" size="small" class="name-edit" autofocus
                    @blur="commitPhaseEdit(ph)" @keyup.enter="commitPhaseEdit(ph)" />
                </template>
                <template v-else>
                  {{ ph.phase }}
                  <el-button text size="small" class="name-edit-btn" title="重命名阶段"
                    @click="ph._editingName = true">✏️</el-button>
                </template>
              </span>
              <span class="phase-ops">
                <el-button size="small" text type="primary" title="在此阶段后添加新阶段"
                  @click="addPhase(i)">＋ 阶段</el-button>
                <el-button size="small" text type="danger" title="删除该阶段"
                  @click="removePhase(i)">🗑</el-button>
              </span>
            </div>
            <div v-if="ph.date" class="phase-date">🗓️ {{ ph.date }}</div>
            <ul class="task-list">
              <li v-for="(t, j) in (ph.tasks || [])" :key="j">
                <div class="task-row" :class="{ done: t.done }">
                  <el-checkbox
                    :model-value="!!t.done" :disabled="saving"
                    @change="toggleTask(t)"
                  />
                  <el-input v-if="t._editing" v-model="t.text" size="small" class="t-edit" autofocus
                    @mousedown.stop
                    @blur="commitTaskEdit(ph, t)" @keyup.enter="commitTaskEdit(ph, t)" />
                  <span v-else class="t-text" title="点击编辑任务" @click="t._editing = true">{{ t.text }}</span>
                  <span class="t-del" title="删除任务" @click.stop="removeTaskItem(ph, j)">✕</span>
                </div>
              </li>
            </ul>
            <div class="phase-check" v-if="ph.check_standard || ph._editCheck">✅ 达标要求：
              <template v-if="ph._editCheck">
                <el-input v-model="ph.check_standard" size="small" class="check-edit" autofocus
                  @mousedown.stop
                  @blur="commitCheckEdit(ph)" @keyup.enter="commitCheckEdit(ph)" />
              </template>
              <template v-else>
                {{ ph.check_standard }}
                <el-button text size="small" class="meta-edit-btn" title="编辑达标要求"
                  @click="ph._editCheck = true">✏️</el-button>
              </template>
            </div>
            <el-button v-else text size="small" class="meta-add-btn" @click="ph._editCheck = true">＋ 达标要求</el-button>
            <div v-if="ph.week_hours" class="phase-week">🕐 每周投入：{{ ph.week_hours }} 小时</div>
          </div>

          <!-- 推荐学习资料 -->
          <div class="res-block">
            <h4 class="res-title">🎯 主题学习资料 <span class="res-sub">（全平台检索入口）</span></h4>
            <div class="plat-grid">
              <a
                v-for="(m, i) in detailResources('topic')" :key="i"
                class="plat-card" :href="m.url" target="_blank"
                :style="{ borderTopColor: metaOf(m.platform).color }"
              >
                <span class="p-icon">{{ metaOf(m.platform).icon }}</span>
                <div class="p-info">
                  <b>{{ metaOf(m.platform).name }}</b>
                  <span class="p-kw">{{ m.title }}</span>
                </div>
                <span class="p-go">↗</span>
              </a>
            </div>

            <h4 v-if="detailResources('detail').length" class="res-title">📌 AI 推荐细分方向 <span class="res-sub">（围绕你的主题拆出的具体关键词）</span></h4>
            <div v-if="detailResources('detail').length" class="plat-grid">
              <a
                v-for="(m, i) in detailResources('detail')" :key="i"
                class="plat-card" :href="m.url" target="_blank"
                :style="{ borderTopColor: metaOf(m.platform).color }"
              >
                <span class="p-icon">{{ metaOf(m.platform).icon }}</span>
                <div class="p-info">
                  <b>{{ metaOf(m.platform).name }}</b>
                  <span class="p-kw">{{ m.title }}</span>
                </div>
                <span class="p-go">↗</span>
              </a>
            </div>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.study-page { padding: 20px 24px; max-width: 1280px; margin: 0 auto; }

// 生成区
.gen-card {
  background: linear-gradient(135deg, #eff6ff, #f8fafc);
  border: 1px solid var(--border); border-radius: 14px; padding: 18px 20px; margin-bottom: 18px;
  .gen-head {
    display: flex; justify-content: space-between; align-items: flex-start; gap: 12px;
    cursor: pointer; user-select: none;
    h2 { margin: 0 0 6px; font-size: 18px; display: flex; align-items: center; gap: 6px; }
    .gen-fold-arrow {
      display: inline-block; font-size: 14px; color: #2563eb; transition: transform .2s;
    }
    &.open .gen-fold-arrow { transform: rotate(180deg); }
    &:hover h2 { color: #2563eb; }
  }
  .gen-tip { margin: 0 0 14px; color: var(--text-2); font-size: 13px; }
  .gen-head:not(.open) .gen-tip { margin-bottom: 0; } // 收起态去掉底部空隙
  .gen-form { display: flex; gap: 10px; flex-wrap: wrap;
    .el-input { flex: 1; min-width: 220px; }
  }
  .gen-chat-tip { margin-top: 10px; color: #64748b; font-size: 12.5px; }
  .gen-loading { margin-top: 12px; color: #2563eb; font-size: 13px; display: flex; align-items: center; gap: 8px;
    .spinner { width: 14px; height: 14px; border: 2px solid #bfdbfe; border-top-color: #2563eb; border-radius: 50%; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  }
}

// 主体两栏
.study-body { display: grid; grid-template-columns: 290px 1fr; gap: 16px; align-items: start;
  @media (max-width: 900px) { grid-template-columns: 1fr; }
}

// 移动端：生成表单控件铺满
@media (max-width: 768px) {
  .gen-form {
    flex-direction: column;
    .el-input, .el-select, .el-input-number { width: 100% !important; min-width: 0; }
  }
  .study-list { max-height: 300px; overflow-y: auto; }
}

// 左：列表
.study-list {
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 12px;
  .list-title { font-size: 13px; font-weight: 600; color: var(--text-2); margin-bottom: 10px; }
  .list-empty { color: #94a3b8; font-size: 13px; text-align: center; padding: 24px 0; line-height: 1.8; }
  .list-item {
    border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin-bottom: 8px;
    cursor: pointer; transition: all .2s;
    &:hover { border-color: #93c5fd; background: #f8fafc; }
    &.active { border-color: #2563eb; background: #eff6ff; box-shadow: 0 2px 8px rgba(37, 99, 235, .12); }
    .li-top { display: flex; justify-content: space-between; align-items: center; gap: 6px;
      .li-topic { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    }
    .li-meta { color: var(--text-2); font-size: 12px; margin: 3px 0 6px; }
    .li-progress { display: flex; align-items: center; gap: 8px;
      .el-progress { flex: 1; }
      span { font-size: 11px; color: var(--text-2); }
    }
  }
}

// 右：详情
.study-detail {
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px;
  min-height: 420px;
  .detail-empty { text-align: center; color: #94a3b8; padding: 90px 0;
    .de-icon { font-size: 40px; }
    p { margin: 8px 0 0; } .de-sub { font-size: 12.5px; color: #cbd5e1; }
  }
  .detail-head { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 12px;
    h3 { margin: 0 0 8px; font-size: 18px; }
    .dh-tags { display: flex; gap: 6px; flex-wrap: wrap; }
    .dh-summary { margin: 8px 0 0; color: var(--text-2); font-size: 13px; line-height: 1.7; }
    .dh-ops { display: flex; gap: 8px; flex-shrink: 0; }
  }
  .detail-progress { margin-bottom: 16px; }
}

.phase {
  background: #f8fafc; border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-bottom: 10px;
  .phase-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .phase-name { font-weight: 600; margin-bottom: 4px; display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
    .name-edit { width: 180px; }
    .name-edit-btn { padding: 0 4px; }
  }
  .phase-ops { display: flex; align-items: center; gap: 2px; }
  .phase-date { margin-top: 2px; color: var(--text-2); font-size: 13px; }
  .task-list { list-style: none; margin: 8px 0; padding: 0;
    li { line-height: 1.9;
      .task-row { display: flex; align-items: center; gap: 6px;
        &.done .t-text { color: #94a3b8; text-decoration: line-through; }
        .t-text { font-size: 13.5px; cursor: text;
          &:hover { color: #2563eb; }
        }
        .t-edit { flex: 1; }
        .t-del {
          color: #cbd5e1; font-size: 12px; padding: 0 4px; border-radius: 4px; cursor: pointer;
          &:hover { color: #ef4444; background: #fee2e2; }
        }
      }
    }
  }
  .phase-check { margin-top: 6px; color: #047857; font-size: 13px; display: flex; align-items: center; gap: 4px;
    .check-edit { width: 240px; }
    .meta-edit-btn { padding: 0 4px; }
  }
  .meta-add-btn { color: #94a3b8; padding: 0 4px; }
  .phase-week { margin-top: 4px; color: #1d4ed8; font-size: 13px; }
}

// 推荐资料（与 CompDialog 学习资源同款卡片）
.res-block { margin-top: 8px;
  .res-title { margin: 16px 0 10px; font-size: 14px;
    .res-sub { font-size: 12px; color: var(--text-2); font-weight: 400; }
  }
}
.plat-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(185px, 1fr)); gap: 8px;
  .plat-card {
    display: flex; align-items: center; gap: 8px; text-decoration: none; color: var(--text);
    background: #f8fafc; border: 1px solid var(--border); border-top: 3px solid #64748b;
    border-radius: 8px; padding: 8px 10px; transition: all .2s;
    &:hover { background: #f1f5f9; transform: translateY(-2px); box-shadow: 0 4px 10px rgba(0,0,0,.08); }
    .p-icon { font-size: 18px; }
    .p-info { flex: 1; min-width: 0; b { display: block; font-size: 13px; }
      .p-kw { font-size: 11.5px; color: var(--text-2); display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    }
    .p-go { color: #94a3b8; font-size: 13px; }
  }
}
</style>
