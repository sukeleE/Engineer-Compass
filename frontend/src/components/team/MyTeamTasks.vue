<script setup>
// 个人日程页「小组任务」tab：我所有小组的完整备赛计划（所有部门任务与进度，同小组页备赛计划一致）
// 勾选限权与小组页同规则：组长可勾一切；通用任务全员；部门任务仅本部门成员可勾（后端强制校验）
import { ref, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../../api.js';
import auth from '../../auth.js';
import { fmtDate } from '../../utils/noteStatus.js';
import TaskPanel from '../task/TaskPanel.vue';

const teams = ref([]);
const loading = ref(false);
const activeTeamId = ref(null); // 当前查看的小组（横向标签页，默认第一个）
// 任务面板展开映射：`${计划id}|${阶段phase_idx}|${任务task_idx}`（必须用服务端原始下标；拆分后索引位移，全量收起）
const open = ref({});

const TAGS = ['success', 'warning', 'danger', 'primary'];
const tagType = (dept) => (dept === '通用' ? 'info' : TAGS[Math.abs([...(dept || '')].reduce((s, c) => s + c.charCodeAt(0), 0)) % TAGS.length]);

async function load() {
  loading.value = true;
  try {
    teams.value = await api.teamMyTasks();
    // 默认选中第一个小组；当前选中小组被移除（退出等）则重置
    if (!teams.value.some((t) => t.team_id === activeTeamId.value)) {
      activeTeamId.value = teams.value[0]?.team_id ?? null;
    }
  } catch {
    teams.value = []; // 未登录/接口异常静默置空，不打断日程页
    activeTeamId.value = null;
  } finally {
    loading.value = false;
  }
}

// 勾选限权（与小组页 TeamPlanView 同规则；多角色任一匹配即可勾）
const canCheck = (team, t) => team.is_owner || !t.dept || t.dept === '通用' || (team.role_names || []).includes(t.dept);

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
const pct = (done, total) => (total ? Math.round((done / total) * 100) : 0);
const planStats = (plan) => {
  let done = 0, total = 0;
  for (const ph of plan.phases || []) for (const t of ph.tasks || []) { total++; if (t.done) done++; }
  return { done, total };
};
// 阶段内按部门分组（带任务下标，勾选用原始 task_idx）
function deptGroups(ph) {
  const m = new Map();
  (ph.tasks || []).forEach((t) => {
    const d = t.dept || '通用';
    if (!m.has(d)) m.set(d, []);
    m.get(d).push(t);
  });
  return [...m.entries()];
}

// 勾选（乐观更新，done/done_by/done_at 成对回滚；下标用服务端返回的原始 phase_idx/task_idx，勿用过滤后位置）
async function toggle(team, plan, ph, task) {
  const old = { done: task.done, done_by: task.done_by, done_at: task.done_at };
  task.done = !task.done;
  task.done_by = task.done ? (auth.user?.nickname || auth.user?.username || '') : null;
  task.done_at = task.done ? fmtDate(new Date()) : null; // 完成日期（月历按完成日聚合；取消清空）
  try {
    await api.teamPlanTaskToggle(team.team_id, plan.id, ph.phase_idx, task.task_idx, { done: task.done });
  } catch (e) {
    task.done = old.done;
    task.done_by = old.done_by;
    task.done_at = old.done_at;
    ElMessage.error(e.message);
  }
}

// 任务面板：行点击展开/收起
function toggleOpen(key) { open.value[key] = !open.value[key]; }
// 评星/链接：乐观更新 → 单项接口（只带 stars/links，后端 undefined 守卫不碰 done/done_by），失败回滚
async function updateTaskMeta(team, plan, ph, task, patch) {
  const old = { stars: task.stars, links: task.links };
  Object.assign(task, patch);
  try {
    await api.teamPlanTaskToggle(team.team_id, plan.id, ph.phase_idx, task.task_idx, patch);
  } catch (e) {
    task.stars = old.stars;
    task.links = old.links;
    ElMessage.error(e.message);
  }
}
// AI 拆分（仅组长；my-tasks 响应无 perms，非组长带「小组设置」权限者请去小组页操作）
async function applyTeamSplit(team, plan, ph, task, subtasks) {
  try {
    await api.teamPlanTaskSplit(team.team_id, plan.id, ph.phase_idx, task.task_idx, subtasks);
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
async function completeTask(team, plan, ph, task) {
  const snap = JSON.parse(JSON.stringify({ completions: task.completions || [], done: task.done, done_by: task.done_by, done_at: task.done_at }));
  task.completions = snap.completions;
  task.completions.push({ by: auth.user?.nickname || auth.user?.username || '', at: fmtDate(new Date()), uid: auth.user?.id ?? null });
  deriveTeamDone(task);
  try {
    applyCompleteResp(task, await api.teamPlanTaskComplete(team.team_id, plan.id, ph.phase_idx, task.task_idx, { complete: true }));
  } catch (e) {
    Object.assign(task, snap);
    ElMessage.error(e.message);
  }
}
// —— 撤销第 i 条完成记录（面板已按本人/组长过滤按钮）——
async function undoComplete(team, plan, ph, task, i) {
  if (!Number.isInteger(i) || i < 0 || i >= (task.completions || []).length) return;
  const snap = JSON.parse(JSON.stringify({ completions: task.completions || [], done: task.done, done_by: task.done_by, done_at: task.done_at }));
  task.completions = snap.completions;
  task.completions.splice(i, 1);
  deriveTeamDone(task);
  try {
    applyCompleteResp(task, await api.teamPlanTaskComplete(team.team_id, plan.id, ph.phase_idx, task.task_idx, { undo: i }));
  } catch (e) {
    Object.assign(task, snap);
    ElMessage.error(e.message);
  }
}
// —— 切换任务类型（仅组长，服务端为准：once→multi 迁移历史完成 / multi→once 清空）——
async function setTaskMode(team, plan, ph, task, mode) {
  const snap = JSON.parse(JSON.stringify({ mode: task.mode, target: task.target, completions: task.completions || [], done: task.done, done_by: task.done_by, done_at: task.done_at }));
  try {
    applyCompleteResp(task, await api.teamPlanTaskComplete(team.team_id, plan.id, ph.phase_idx, task.task_idx, { mode }));
  } catch (e) {
    Object.assign(task, snap);
    ElMessage.error(e.message);
  }
}
// —— 改目标次数（仅组长，面板已限 1-100；非法输入不请求）——
async function setTarget(team, plan, ph, task, n) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 1 || v > 100) return;
  const snap = { target: task.target, done: task.done, done_by: task.done_by, done_at: task.done_at };
  try {
    applyCompleteResp(task, await api.teamPlanTaskComplete(team.team_id, plan.id, ph.phase_idx, task.task_idx, { target: v }));
  } catch (e) {
    task.target = snap.target; task.done = snap.done; task.done_by = snap.done_by; task.done_at = snap.done_at;
    ElMessage.error(e.message);
  }
}

onMounted(load);
</script>

<template>
  <div class="mt-sec" v-loading="loading">
    <div class="mt-head">
      <h2>🏗️ 我的小组任务</h2>
      <span class="mt-tip">小组完整备赛计划（含各部门进度）</span>
    </div>

    <div v-if="!teams.length" class="mt-empty">
      暂无小组任务 —— 加入小组后，组长生成备赛计划即可在这里跟进
    </div>

    <!-- 横向小组标签页：只展示当前小组的任务，小组多时横向滚动 -->
    <el-tabs v-else v-model="activeTeamId" class="mt-tabs">
      <el-tab-pane v-for="t in teams" :key="t.team_id" :name="t.team_id">
        <template #label>
          <span class="mt-tab-label">
            <span class="mt-tab-name">{{ t.team_name }}</span>
            <el-tag v-if="t.is_owner" size="small" type="warning" class="mt-tab-tag">组长</el-tag>
          </span>
        </template>

        <div v-for="plan in t.plans" :key="plan.id" class="mt-plan">
          <div class="mt-plan-title">
            <b>{{ plan.title }}</b>
            <el-tag v-if="plan.comp_name" size="small" effect="plain" type="primary">{{ plan.comp_name }}</el-tag>
          </div>

          <!-- 总进度 + 部门看板 -->
          <el-progress :percentage="pct(planStats(plan).done, planStats(plan).total)" :stroke-width="8" class="mt-bar" />
          <div class="dept-row">
            <el-tag v-for="(st, d) in deptStats(plan)" :key="d" size="small" effect="light" :type="tagType(d)" class="dept-tag">
              {{ d }} · {{ st.done }}/{{ st.total }}
            </el-tag>
          </div>

          <el-collapse>
            <el-collapse-item v-for="(ph, pi) in plan.phases" :key="pi" :name="pi">
              <template #title>
                <span class="ph-name">阶段{{ pi + 1 }} {{ ph.phase }}</span>
                <span v-if="ph.date" class="ph-date">📅 {{ ph.date }}</span>
              </template>
              <div v-for="[dept, items] in deptGroups(ph)" :key="dept" class="dept-group">
                <el-tag size="small" :type="tagType(dept)" effect="dark">{{ dept }}</el-tag>
                <div v-for="task in items" :key="task.task_idx" class="task-row"
                  @click="toggleOpen(`${plan.id}|${ph.phase_idx}|${task.task_idx}`)">
                  <!-- 待选框只管勾选（@click.stop 防误触展开）；文本/badge 区域冒泡到行根展开面板 -->
                  <el-checkbox :model-value="task.done"
                    :disabled="!canCheck(t, task)" :title="canCheck(t, task) ? '' : `仅「${task.dept}」成员可勾选`"
                    @click.stop @change="toggle(t, plan, ph, task)" class="mt-cb" />
                  <span class="mt-task-text" :class="{ done: task.done }"
                    :title="canCheck(t, task) ? '' : `仅「${task.dept}」成员可勾选`">{{ task.text }}</span>
                  <span v-if="task.mode === 'multi'" class="multi-badge" :class="{ ok: task.done }"
                    title="多次任务完成进度">×{{ (task.completions || []).length }}/{{ task.target || 3 }}</span>
                  <span v-if="task.stars" class="star-badge" title="完成评星">★{{ task.stars }}</span>
                  <span v-if="task.done_by" class="done-by">👤 {{ task.done_by }}</span>
                  <!-- 任务详情面板：完成评星 / 暂存链接 / AI 拆解（点击任务行展开；勾选限权同 checkbox，拆分/类型设定仅组长） -->
                  <TaskPanel
                    v-if="open[`${plan.id}|${ph.phase_idx}|${task.task_idx}`]"
                    :task="task" :can-check="canCheck(t, task)" :can-split="t.is_owner" :can-edit-mode="t.is_owner" class="task-panel"
                    @toggle-done="toggle(t, plan, ph, task)"
                    @update:stars="updateTaskMeta(t, plan, ph, task, { stars: $event })"
                    @update:links="updateTaskMeta(t, plan, ph, task, { links: $event })"
                    @split="applyTeamSplit(t, plan, ph, task, $event)"
                    @complete="completeTask(t, plan, ph, task)"
                    @undo="undoComplete(t, plan, ph, task, $event)"
                    @update:mode="setTaskMode(t, plan, ph, task, $event)"
                    @update:target="setTarget(t, plan, ph, task, $event)"
                  />
                </div>
              </div>
            </el-collapse-item>
          </el-collapse>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style lang="scss" scoped>
.mt-sec { margin-bottom: 20px; }
.mt-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
  h2 { margin: 0; font-size: 18px; }
  .mt-tip { color: #94a3b8; font-size: 12.5px; }
}
.mt-empty { color: #94a3b8; font-size: 13px; padding: 18px 0; text-align: center;
  background: var(--card-bg); border: 1px dashed var(--border); border-radius: 12px; }
// 横向小组标签页：白底卡包裹，标签间留隙；小组多时 el-tabs 内部横向滚动
.mt-tabs {
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 4px 10px 0;
  margin-top: 12px;
  :deep(.el-tabs__header) { margin-bottom: 0; }
  :deep(.el-tabs__nav-wrap) { overflow-x: auto; overflow-y: hidden; }
  :deep(.el-tabs__nav-wrap::-webkit-scrollbar) { display: none; }
  :deep(.el-tabs__item) { font-size: 13.5px; padding: 0 14px; }
  .mt-tab-label { display: inline-flex; align-items: center; gap: 6px;
    .mt-tab-name { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mt-tab-tag { flex-shrink: 0; }
  }
}
.mt-plan {
  padding: 12px 2px 4px;
  .mt-plan-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; b { font-size: 13.5px; } }
  .mt-bar { margin-bottom: 4px; }
  .dept-row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px;
    .dept-tag { font-weight: 500; }
  }
  .ph-name { font-weight: 600; font-size: 13px; }
  .ph-date { color: #94a3b8; font-size: 12px; margin-left: 8px; }
  .dept-group { display: flex; flex-direction: column; gap: 2px; margin-bottom: 6px;
    // 行：方框勾选 + 文本区域点击展开面板；面板占满整行换行显示
    .task-row { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 6px;
      border-radius: 8px; padding: 2px 6px; cursor: pointer;
      &:hover { background: #f1f5f9; }
    }
    .mt-cb { margin: 0; margin-top: 2px; flex-shrink: 0; }
    .mt-task-text { flex: 1; min-width: 0; font-size: 13px; line-height: 1.6; overflow-wrap: anywhere;
      &.done { color: #94a3b8; text-decoration: line-through; }
    }
    .star-badge { color: #f59e0b; font-size: 12px; font-weight: 600; flex-shrink: 0; }
    .multi-badge { color: #f59e0b; font-size: 12px; font-weight: 600; flex-shrink: 0;
      &.ok { color: #16a34a; }
    }
    .done-by { font-size: 11.5px; color: #94a3b8; flex-shrink: 0; }
    .task-panel { flex: 0 0 100%; }
  }
}
</style>
