<script setup>
// 小组 AI 备赛计划：AI 按小组部门/角色拆分任务、多部门并行跟进
// 全员可见+可勾选进度；组长（或「小组设置」权限）可生成/编辑/删除；下方保留成员计划同步
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../../api.js';
import auth from '../../auth.js';
import { fmtDate } from '../../utils/noteStatus.js';
import TeamPlans from './TeamPlans.vue';
import PlanChat from '../PlanChat.vue';
import TaskPanel from '../task/TaskPanel.vue';

const props = defineProps({ teamId: Number, me: Object, roles: Array, perms: Object });

const canEdit = computed(() => props.me?.is_owner || props.perms?.team);
// 我的全部角色名（多角色：任一匹配本部门即可勾）
const myRoleNames = computed(() => (props.me?.roles || []).map((r) => r.name));
// 勾选权限（与后端同规则）：组长/小组设置权限可勾一切；通用任务全员；其余仅本部门成员
const canCheck = (t) => canEdit.value || !t.dept || t.dept === '通用' || myRoleNames.value.includes(t.dept);
const plans = ref([]);
const comps = ref([]);
const genCompId = ref(null);
const loading = ref(false);
const genLoading = ref(false);
// 任务面板展开映射：`${计划id}|${阶段pi}|${任务idx}`（拆分后索引位移，全量收起）
const open = ref({});

const deptOptions = computed(() => [...(props.roles || []).map((r) => r.name), '通用']);
const TAGS = ['success', 'warning', 'danger', 'primary'];
const tagType = (dept) => (dept === '通用' ? 'info' : TAGS[Math.abs([...(dept || '')].reduce((s, c) => s + c.charCodeAt(0), 0)) % TAGS.length]);

const tasksOf = (p) => p.tasks || [];
const pct = (done, total) => (total ? Math.round((done / total) * 100) : 0);
// 整份计划汇总
const planStats = (p) => {
  let done = 0, total = 0;
  for (const ph of p.plan?.phases || []) for (const t of ph.tasks || []) { total++; if (t.done) done++; }
  return { done, total };
};

// 部门汇总：{ 部门名: {done,total} }
function deptStats(plan) {
  const m = {};
  for (const ph of plan.phases || []) for (const t of ph.tasks || []) {
    const d = t.dept || '通用';
    m[d] = m[d] || { done: 0, total: 0 };
    m[d].total++; if (t.done) m[d].done++;
  }
  return m;
}
// 阶段内按部门分组（带任务索引，勾选用）
function deptGroups(ph) {
  const m = new Map();
  (ph.tasks || []).forEach((t, idx) => {
    const d = t.dept || '通用';
    if (!m.has(d)) m.set(d, []);
    m.get(d).push({ t, idx });
  });
  return [...m.entries()];
}

async function load() {
  loading.value = true;
  try { plans.value = await api.teamPlanList(props.teamId); } catch (e) { ElMessage.error(e.message); } finally { loading.value = false; }
}

async function loadComps() {
  try {
    comps.value = await api.competitions({ status: 'active' });
    if (comps.value.length) genCompId.value = comps.value[0].id;
  } catch { /* 竞赛列表失败不阻塞页面 */ }
}

// —— 生成（组长）——
async function generate() {
  if (!genCompId.value) return ElMessage.warning('请先选择竞赛');
  genLoading.value = true;
  try {
    const r = await api.teamPlanGenerate(props.teamId, genCompId.value);
    ElMessage.success(r.template ? '已生成小组计划（AI 服务不可用，已用子赛项模板兜底）' : '🎉 AI 小组计划已生成（按部门拆分）');
    await load();
  } catch (e) { ElMessage.error(e.message); } finally { genLoading.value = false; }
}

// —— 勾选任务（本部门成员；乐观更新，done/done_by 成对回滚）——
async function toggle(prow, phIdx, task) {
  const old = { done: task.t.done, done_by: task.t.done_by, done_at: task.t.done_at };
  task.t.done = !task.t.done;
  task.t.done_by = task.t.done ? (auth.user?.nickname || auth.user?.username || '') : null;
  task.t.done_at = task.t.done ? fmtDate(new Date()) : null; // 完成日期（月历按完成日聚合；取消清空）
  try { await api.teamPlanTaskToggle(props.teamId, prow.id, phIdx, task.idx, { done: task.t.done }); }
  catch (e) { task.t.done = old.done; task.t.done_by = old.done_by; task.t.done_at = old.done_at; ElMessage.error(e.message); }
}

// —— 任务面板：行点击展开/收起 ——
function toggleOpen(key) { open.value[key] = !open.value[key]; }
// —— 评星/链接：乐观更新 → 单项接口（只带 stars/links，后端 undefined 守卫不碰 done/done_by），失败回滚 ——
async function updateTaskMeta(prow, phIdx, task, patch) {
  const old = { stars: task.t.stars, links: task.t.links };
  Object.assign(task.t, patch);
  try {
    await api.teamPlanTaskToggle(props.teamId, prow.id, phIdx, task.idx, patch);
  } catch (e) {
    task.t.stars = old.stars;
    task.t.links = old.links;
    ElMessage.error(e.message);
  }
}
// —— AI 拆分（仅组长）：原子 split 端点原位替换 → 收起面板 → 重拉列表 ——
async function applyTeamSplit(prow, phIdx, task, subtasks) {
  try {
    await api.teamPlanTaskSplit(props.teamId, prow.id, phIdx, task.idx, subtasks);
    open.value = {};
    await load();
  } catch (e) { ElMessage.error(e.message); }
}

// —— 多次任务：本地乐观派生（与后端同规则）——
function deriveTeamDone(t) {
  const recs = t.completions || [];
  const target = t.target || 3;
  t.done = recs.length >= target;
  t.done_at = recs[target - 1]?.at || null;
  t.done_by = recs[target - 1]?.by || null;
}
// complete 端点响应（服务端重算派生）覆盖任务字段
function applyCompleteResp(t, r) {
  t.mode = r.mode; t.target = r.target ?? null;
  t.done = !!r.done; t.done_by = r.done_by || null; t.done_at = r.done_at || null;
  t.completions = r.completions || [];
  t.stars = r.stars ?? null; t.links = r.links || [];
}
// —— 完成一次：乐观追加记录 → complete 端点 → 响应覆盖 / 失败回滚 ——
async function completeTask(prow, phIdx, task) {
  const t = task.t;
  const snap = JSON.parse(JSON.stringify({ completions: t.completions || [], done: t.done, done_by: t.done_by, done_at: t.done_at }));
  t.completions = snap.completions;
  t.completions.push({ by: auth.user?.nickname || auth.user?.username || '', at: fmtDate(new Date()), uid: auth.user?.id ?? null });
  deriveTeamDone(t);
  try {
    applyCompleteResp(t, await api.teamPlanTaskComplete(props.teamId, prow.id, phIdx, task.idx, { complete: true }));
  } catch (e) {
    Object.assign(t, snap);
    ElMessage.error(e.message);
  }
}
// —— 撤销第 i 条完成记录（面板已按本人/组长过滤按钮）——
async function undoComplete(prow, phIdx, task, i) {
  const t = task.t;
  if (!Number.isInteger(i) || i < 0 || i >= (t.completions || []).length) return;
  const snap = JSON.parse(JSON.stringify({ completions: t.completions || [], done: t.done, done_by: t.done_by, done_at: t.done_at }));
  t.completions = snap.completions;
  t.completions.splice(i, 1);
  deriveTeamDone(t);
  try {
    applyCompleteResp(t, await api.teamPlanTaskComplete(props.teamId, prow.id, phIdx, task.idx, { undo: i }));
  } catch (e) {
    Object.assign(t, snap);
    ElMessage.error(e.message);
  }
}
// —— 切换任务类型（仅组长，服务端为准：once→multi 迁移历史完成 / multi→once 清空）——
async function setTaskMode(prow, phIdx, task, mode) {
  const t = task.t;
  const snap = JSON.parse(JSON.stringify({ mode: t.mode, target: t.target, completions: t.completions || [], done: t.done, done_by: t.done_by, done_at: t.done_at }));
  try {
    applyCompleteResp(t, await api.teamPlanTaskComplete(props.teamId, prow.id, phIdx, task.idx, { mode }));
  } catch (e) {
    Object.assign(t, snap);
    ElMessage.error(e.message);
  }
}
// —— 改目标次数（仅组长，面板已限 1-100；非法输入不请求）——
async function setTarget(prow, phIdx, task, n) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 1 || v > 100) return;
  const t = task.t;
  const snap = { target: t.target, done: t.done, done_by: t.done_by, done_at: t.done_at };
  try {
    applyCompleteResp(t, await api.teamPlanTaskComplete(props.teamId, prow.id, phIdx, task.idx, { target: v }));
  } catch (e) {
    t.target = snap.target; t.done = snap.done; t.done_by = snap.done_by; t.done_at = snap.done_at;
    ElMessage.error(e.message);
  }
}

// —— 编辑（组长）——
// —— 对话式 AI（生成 / 修改）——
const genChat = ref(false); // 对话生成弹窗
const editChat = ref(false); // 对话修改弹窗
const editChatPlanId = ref(null);
function openGenChat() {
  if (!genCompId.value) return ElMessage.warning('请先选择竞赛');
  genChat.value = true;
}
function openEditChat(p) {
  editChatPlanId.value = p.id;
  editChat.value = true;
}

const editDlg = ref(false);
const editPlan = ref(null); // { id, title, phases[] }
function openEdit(prow) {
  editPlan.value = { id: prow.id, title: prow.title, phases: JSON.parse(JSON.stringify(prow.plan.phases || [])) };
  editDlg.value = true;
}
const addTask = (ph) => { ph.tasks = ph.tasks || []; ph.tasks.push({ text: '', dept: '通用', done: false }); };
const delTask = (ph, i) => ph.tasks.splice(i, 1);
const addPhase = () => editPlan.value.phases.push({ phase: '新阶段', date: '', check_standard: '', week_hours: 10, tasks: [] });
const delPhase = (i) => editPlan.value.phases.splice(i, 1);

async function saveEdit() {
  const ep = editPlan.value;
  const valid = ep.phases.some((p) => (p.tasks || []).some((t) => t.text && String(t.text).trim()));
  if (!valid) return ElMessage.warning('计划需至少包含一个带任务名称的阶段');
  try {
    await api.teamPlanSave(props.teamId, { id: ep.id, title: ep.title, plan_json: { phases: ep.phases } });
    ElMessage.success('已保存');
    editDlg.value = false;
    await load();
  } catch (e) { ElMessage.error(e.message); }
}

async function removePlan(prow) {
  try { await ElMessageBox.confirm(`确定删除「${prow.title}」？成员的勾选进度将一并删除`, '删除小组计划', { type: 'warning' }); }
  catch { return; }
  try { await api.teamPlanDelete(props.teamId, prow.id); ElMessage.success('已删除'); await load(); }
  catch (e) { ElMessage.error(e.message); }
}

onMounted(() => { load(); loadComps(); });
</script>

<template>
  <div class="tpv">
    <el-alert type="info" :closable="false" class="tpv-tip" show-icon
      title="小组备赛计划：AI 按小组部门拆分任务 → 组长分配 → 各部门并行跟进勾选；「计划同步」为成员个人计划汇总" />

    <!-- 生成区（组长） -->
    <div v-if="canEdit" class="gen-row">
      <el-select v-model="genCompId" filterable placeholder="选择竞赛" style="width: 300px">
        <el-option v-for="c in comps" :key="c.id" :label="c.name" :value="c.id" />
      </el-select>
      <el-button type="success" plain @click="openGenChat">💬 AI 对话生成</el-button>
      <el-button :loading="genLoading" @click="generate">⚡ 一键生成</el-button>
      <span class="gen-tip">💬 对话生成：AI 先确认分组方式与计划周期再出计划；一键生成：直接按现有部门拆分（AI 将结合部门 {{ deptOptions.join('、') }}）</span>
    </div>

    <div v-loading="loading" style="min-height: 60px">
      <div v-if="!plans.length" class="tpv-empty">
        {{ canEdit ? '还没有小组计划，选择竞赛点击「AI 生成小组计划」开始' : '组长尚未生成小组计划，稍后再来' }}
      </div>

      <!-- 计划卡片 -->
      <div v-for="p in plans" :key="p.id" class="plan-box">
        <div class="pb-head">
          <div class="pb-title">
            <b>{{ p.title }}</b>
            <el-tag v-if="p.plan?.comp_name" size="small" effect="plain" type="primary">{{ p.plan.comp_name }}</el-tag>
            <span class="pb-time">{{ String(p.update_time || p.create_time || '').slice(0, 16) }} 更新</span>
          </div>
          <div class="pb-ops">
            <el-button v-if="canEdit" size="small" type="success" plain @click="openEditChat(p)">💬 AI 修改</el-button>
            <el-button v-if="canEdit" size="small" @click="openEdit(p)">✏️ 手动编辑</el-button>
            <el-button v-if="canEdit" size="small" type="danger" plain @click="removePlan(p)">删除</el-button>
          </div>
        </div>

        <!-- 总进度 + 部门看板 -->
        <div class="pb-stats">
          <el-progress :percentage="pct(planStats(p).done, planStats(p).total)" :stroke-width="8" class="pb-bar" />
          <div class="dept-row">
            <el-tag v-for="(st, d) in deptStats(p.plan)" :key="d" size="small" effect="light" :type="tagType(d)" class="dept-tag">
              {{ d }} · {{ st.done }}/{{ st.total }}
            </el-tag>
          </div>
        </div>

        <!-- 阶段折叠 -->
        <el-collapse>
          <el-collapse-item v-for="(ph, pi) in p.plan.phases || []" :key="pi" :name="pi">
            <template #title>
              <!-- 阶段标题与个人日程页「我的小组任务」同款：阶段名 + 日期小字（总进度条/部门看板已覆盖阶段进度） -->
              <span class="ph-name">阶段{{ pi + 1 }} {{ ph.phase }}</span>
              <span v-if="ph.date" class="ph-date">📅 {{ ph.date }}</span>
            </template>

            <div v-if="ph.check_standard || ph.week_hours" class="ph-check">
              <template v-if="ph.check_standard">✅ 达标要求：{{ ph.check_standard }}</template>
              <template v-if="ph.week_hours"> · ⏱ {{ ph.week_hours }}h/周</template>
            </div>
            <div v-for="[dept, items] in deptGroups(ph)" :key="dept" class="dept-group">
              <div class="dg-head"><el-tag size="small" :type="tagType(dept)" effect="dark">{{ dept }}</el-tag></div>
              <div v-for="task in items" :key="task.idx" class="task-row" @click="toggleOpen(`${p.id}|${pi}|${task.idx}`)">
                <!-- 待选框只管勾选（@click.stop 防误触展开）；文本/badge 区域冒泡到行根展开面板 -->
                <el-checkbox :model-value="task.t.done"
                  :disabled="!canCheck(task.t)" :title="canCheck(task.t) ? '' : `仅「${task.t.dept}」成员可勾选`"
                  @click.stop @change="toggle(p, pi, task)" class="task-cb" />
                <span class="task-text" :class="{ done: task.t.done }"
                  :title="canCheck(task.t) ? '' : `仅「${task.t.dept}」成员可勾选`">{{ task.t.text }}</span>
                <span v-if="task.t.mode === 'multi'" class="multi-badge" :class="{ ok: task.t.done }"
                  title="多次任务完成进度">×{{ (task.t.completions || []).length }}/{{ task.t.target || 3 }}</span>
                <span v-if="task.t.stars" class="star-badge" title="完成评星">★{{ task.t.stars }}</span>
                <span v-if="task.t.done_by" class="done-by">👤 {{ task.t.done_by }}</span>
                <!-- 任务详情面板：完成评星 / 暂存链接 / AI 拆解（点击任务行展开；勾选限权同 checkbox，拆分/类型设定仅组长） -->
                <TaskPanel
                  v-if="open[`${p.id}|${pi}|${task.idx}`]"
                  :task="task.t" :can-check="canCheck(task.t)" :can-split="canEdit" :can-edit-mode="canEdit" class="task-panel"
                  @toggle-done="toggle(p, pi, task)"
                  @update:stars="updateTaskMeta(p, pi, task, { stars: $event })"
                  @update:links="updateTaskMeta(p, pi, task, { links: $event })"
                  @split="applyTeamSplit(p, pi, task, $event)"
                  @complete="completeTask(p, pi, task)"
                  @undo="undoComplete(p, pi, task, $event)"
                  @update:mode="setTaskMode(p, pi, task, $event)"
                  @update:target="setTarget(p, pi, task, $event)"
                />
              </div>
            </div>
            <div v-if="!ph.tasks?.length" class="ph-none">（本阶段暂无任务）</div>
          </el-collapse-item>
        </el-collapse>
      </div>
    </div>

    <!-- 成员计划同步（沿用原「计划同步」） -->
    <div class="sync-sec">
      <div class="sync-title">📡 成员计划同步（个人备赛 / 学习日程）</div>
      <TeamPlans :team-id="teamId" />
    </div>

    <!-- 编辑弹窗（组长） -->
    <el-dialog v-model="editDlg" title="✏️ 编辑小组计划" width="760px" top="4vh">
      <template v-if="editPlan">
        <div class="ed-title">
          <el-input v-model="editPlan.title" placeholder="计划名称" style="max-width: 340px" />
        </div>
        <div class="ed-scroll">
          <div v-for="(ph, pi) in editPlan.phases" :key="pi" class="ed-phase">
            <div class="ed-phase-head">
              <b>阶段{{ pi + 1 }}</b>
              <el-button size="small" type="danger" plain @click="delPhase(pi)">删除阶段</el-button>
            </div>
            <div class="ed-grid">
              <el-input v-model="ph.phase" placeholder="阶段名称" />
              <el-input v-model="ph.date" placeholder="日期（如 2026-09-01 ~ 09-30）" />
            </div>
            <el-input v-model="ph.check_standard" placeholder="本阶段达标要求" class="ed-mt" />
            <div class="ed-grid ed-mt">
              <el-input-number v-model="ph.week_hours" :min="0" :max="80" controls-position="right" />
              <span class="ed-week">小时/周</span>
            </div>
            <div class="ed-tasks">
              <div v-for="(t, ti) in ph.tasks" :key="ti" class="ed-task">
                <el-checkbox v-model="t.done" />
                <el-input v-model="t.text" placeholder="任务描述" size="small" />
                <el-select v-model="t.dept" size="small" style="width: 130px">
                  <el-option v-for="d in deptOptions" :key="d" :label="d" :value="d" />
                </el-select>
                <el-button size="small" text type="danger" @click="delTask(ph, ti)">✕</el-button>
              </div>
              <el-button size="small" @click="addTask(ph)">＋ 加任务</el-button>
            </div>
          </div>
        </div>
        <el-button class="ed-add-phase" @click="addPhase">＋ 加阶段</el-button>
      </template>
      <template #footer>
        <el-button @click="editDlg = false">取消</el-button>
        <el-button type="primary" @click="saveEdit">保存计划</el-button>
      </template>
    </el-dialog>

    <!-- 对话式 AI：生成 / 修改小组计划（AI 先提问分组与周期，确认后落地；已勾选任务自动保留） -->
    <PlanChat v-model="genChat" mode="team-generate" :team-id="teamId" :comp-id="genCompId"
      @done="() => { genChat = false; ElMessage.success('🎉 小组计划已生成'); load(); }" />
    <PlanChat v-model="editChat" mode="team-edit" :team-id="teamId" :plan-id="editChatPlanId"
      @done="() => { editChat = false; ElMessage.success('✅ 计划已按对话修改'); load(); }" />
  </div>
</template>

<style lang="scss" scoped>
.tpv-tip { margin-bottom: 12px; border-radius: 10px; }
.gen-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px;
  .gen-tip { color: #94a3b8; font-size: 12.5px; }
}
.tpv-empty { color: #94a3b8; text-align: center; padding: 40px 0; font-size: 13px; }

.plan-box { border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; margin-bottom: 14px;
  background: var(--card-bg);
  .pb-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 8px;
    .pb-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0;
      b { font-size: 15px; }
      .pb-time { color: #94a3b8; font-size: 12px; }
    }
    .pb-ops { flex-shrink: 0; }
  }
  .pb-stats { margin-bottom: 10px;
    .pb-bar { margin-bottom: 6px; }
    .dept-row { display: flex; gap: 6px; flex-wrap: wrap;
      .dept-tag { font-weight: 500; }
    }
  }
  // 阶段标题（与个人日程页「我的小组任务」同款样式：阶段名 + 灰色小字日期）
  .ph-name { font-weight: 600; font-size: 13px; overflow-wrap: anywhere; }
  .ph-date { color: #94a3b8; font-size: 12px; margin-left: 8px; }
  .ph-check { background: #f8fafc; border: 1px dashed var(--border); border-radius: 8px;
    padding: 6px 10px; font-size: 12.5px; color: var(--text-2); margin-bottom: 8px; }
  .dept-group { margin-bottom: 8px;
    .dg-head { margin-bottom: 4px; }
    // 行：方框勾选 + 文本区域点击展开面板；面板占满整行换行显示
    .task-row { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 6px;
      border-radius: 8px; padding: 2px 6px; cursor: pointer; margin-bottom: 2px;
      &:hover { background: #f1f5f9; }
    }
    .task-cb { margin: 0; margin-top: 2px; flex-shrink: 0; }
    .task-text { flex: 1; min-width: 0; font-size: 13px; line-height: 1.6; overflow-wrap: anywhere;
      &.done { color: #94a3b8; text-decoration: line-through; }
    }
    .star-badge { color: #f59e0b; font-size: 12px; font-weight: 600; flex-shrink: 0; }
    .multi-badge { color: #f59e0b; font-size: 12px; font-weight: 600; flex-shrink: 0;
      &.ok { color: #16a34a; }
    }
    .done-by { font-size: 11.5px; color: #94a3b8; flex-shrink: 0; }
    .task-panel { flex: 0 0 100%; }
  }
  .ph-none { color: #cbd5e1; font-size: 12.5px; }
}

.sync-sec { margin-top: 18px; border-top: 1px dashed var(--border); padding-top: 14px;
  .sync-title { font-size: 14px; font-weight: 600; margin-bottom: 10px; }
}

.ed-scroll { max-height: 56vh; overflow-y: auto; padding-right: 6px; }
.ed-title { margin-bottom: 10px; }
.ed-phase { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin-bottom: 10px;
  .ed-phase-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .ed-grid { display: flex; gap: 8px; align-items: center;
    .el-input { flex: 1; }
  }
  .ed-mt { margin-top: 8px; }
  .ed-week { color: var(--text-2); font-size: 12.5px; }
  .ed-tasks { margin-top: 10px; display: flex; flex-direction: column; gap: 6px;
    .ed-task { display: flex; gap: 6px; align-items: center; }
  }
  // 移动端：编辑行内控件换行堆叠
  @media (max-width: 768px) {
    .ed-grid { flex-wrap: wrap; .el-input { flex: 1 1 100%; } }
    .ed-task { flex-wrap: wrap; }
  }
}
.ed-add-phase { margin-top: 2px; }
</style>
