<script setup>
// 个人日程页的「我的小组任务」区块：我所有小组备赛计划中「本部门 + 通用」任务（服务端已过滤）
// 勾选复用小组的 teamPlanTaskToggle → 与小组页同一份 plan_json，天然双向同步
import { ref, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../../api.js';
import auth from '../../auth.js';

const teams = ref([]);
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    teams.value = await api.teamMyTasks();
  } catch {
    teams.value = []; // 未登录/接口异常静默置空，不打断日程页
  } finally {
    loading.value = false;
  }
}

// 勾选（乐观更新，done/done_by 成对回滚；下标用服务端返回的原始 phase_idx/task_idx，勿用过滤后位置）
async function toggle(team, plan, ph, task) {
  const old = { done: task.done, done_by: task.done_by };
  task.done = !task.done;
  task.done_by = task.done ? (auth.user?.nickname || auth.user?.username || '') : null;
  try {
    await api.teamPlanTaskToggle(team.team_id, plan.id, ph.phase_idx, task.task_idx, task.done);
  } catch (e) {
    task.done = old.done;
    task.done_by = old.done_by;
    ElMessage.error(e.message);
  }
}

onMounted(load);
</script>

<template>
  <div class="mt-sec" v-loading="loading">
    <div class="mt-head">
      <h2>🏗️ 我的小组任务</h2>
      <span class="mt-tip">所在小组备赛计划中「本部门 + 通用」任务，勾选后与小组页同步</span>
    </div>

    <div v-if="!teams.length" class="mt-empty">
      暂无小组任务 —— 加入小组后，组长生成备赛计划即可在这里跟进
    </div>

    <div v-for="t in teams" :key="t.team_id" class="mt-team">
      <div class="mt-team-head">
        <b>{{ t.team_name }}</b>
        <el-tag v-if="t.is_owner" size="small" type="warning">👑 组长</el-tag>
        <el-tag v-else-if="t.role_name" size="small" type="info" effect="plain">{{ t.role_name }}</el-tag>
      </div>

      <div v-for="plan in t.plans" :key="plan.id" class="mt-plan">
        <div class="mt-plan-title">
          <b>{{ plan.title }}</b>
          <el-tag v-if="plan.comp_name" size="small" effect="plain" type="primary">{{ plan.comp_name }}</el-tag>
        </div>
        <el-collapse>
          <el-collapse-item v-for="(ph, pi) in plan.phases" :key="pi" :name="pi">
            <template #title>
              <span class="ph-name">阶段{{ pi + 1 }} {{ ph.phase }}</span>
              <span v-if="ph.date" class="ph-date">📅 {{ ph.date }}</span>
            </template>
            <el-checkbox v-for="task in ph.tasks" :key="task.task_idx" :model-value="task.done"
              @change="toggle(t, plan, ph, task)" class="mt-task">
              <span class="mt-task-text" :class="{ done: task.done }">{{ task.text }}</span>
              <span v-if="task.done_by" class="done-by">👤 {{ task.done_by }}</span>
            </el-checkbox>
          </el-collapse-item>
        </el-collapse>
      </div>
    </div>
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
.mt-team { border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; margin-top: 12px; background: var(--card-bg);
  .mt-team-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; b { font-size: 14.5px; } }
  .mt-plan { border-top: 1px dashed var(--border); padding-top: 8px; margin-top: 8px;
    .mt-plan-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; b { font-size: 13.5px; } }
    .ph-name { font-weight: 600; font-size: 13px; }
    .ph-date { color: #94a3b8; font-size: 12px; margin-left: 8px; }
    .mt-task { display: flex; align-items: flex-start; width: 100%; margin: 0;
      .mt-task-text { font-size: 13px; line-height: 1.6;
        &.done { color: #94a3b8; text-decoration: line-through; }
      }
      .done-by { font-size: 11.5px; color: #94a3b8; margin-left: 6px; }
    }
  }
}
</style>
