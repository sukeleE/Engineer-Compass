<script setup>
// 个人日程页「小组任务」tab：我所有小组的完整备赛计划（所有部门任务与进度，同小组页备赛计划一致）
// 勾选限权与小组页同规则：组长可勾一切；通用任务全员；部门任务仅本部门成员可勾（后端强制校验）
import { ref, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../../api.js';
import auth from '../../auth.js';
import { fmtDate } from '../../utils/noteStatus.js';

const teams = ref([]);
const loading = ref(false);
const activeTeamId = ref(null); // 当前查看的小组（横向标签页，默认第一个）

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
    await api.teamPlanTaskToggle(team.team_id, plan.id, ph.phase_idx, task.task_idx, task.done);
  } catch (e) {
    task.done = old.done;
    task.done_by = old.done_by;
    task.done_at = old.done_at;
    ElMessage.error(e.message);
  }
}

onMounted(load);
</script>

<template>
  <div class="mt-sec" v-loading="loading">
    <div class="mt-head">
      <h2>🏗️ 我的小组任务</h2>
      <span class="mt-tip">所在小组完整备赛计划（含各部门进度），勾选权限与小组页一致</span>
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
                <el-checkbox v-for="task in items" :key="task.task_idx" :model-value="task.done"
                  :disabled="!canCheck(t, task)" :title="canCheck(t, task) ? '' : `仅「${task.dept}」成员可勾选`"
                  @change="toggle(t, plan, ph, task)" class="mt-task">
                  <span class="mt-task-text" :class="{ done: task.done }">{{ task.text }}</span>
                  <span v-if="task.done_by" class="done-by">👤 {{ task.done_by }}</span>
                </el-checkbox>
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
  .dept-group { display: flex; flex-direction: column; gap: 2px; margin-bottom: 6px; }
  .mt-task { display: flex; align-items: flex-start; width: 100%; margin: 0;
    .mt-task-text { font-size: 13px; line-height: 1.6;
      &.done { color: #94a3b8; text-decoration: line-through; }
    }
    .done-by { font-size: 11.5px; color: #94a3b8; margin-left: 6px; }
  }
}
</style>
