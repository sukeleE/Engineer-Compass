<script setup>
// 计划同步：小组成员各自的竞赛备赛计划 + AI 学习日程（组长统筹对齐用，全员可见）
// 已 100% 完成的计划不显示（聚焦未完成任务），空态区分「全部完成」与「暂无」
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api } from '../../api.js';
import auth from '../../auth.js';
import PlanTiles from './PlanTiles.vue';

const router = useRouter();
// 点击成员昵称 → 进入其公开主页（只读）；自己 → 我的管理界面
const toProfile = (m) => router.push(m.user_id === auth.user?.id ? '/me' : `/user/${m.user_id}`);

const props = defineProps({ teamId: Number });
const rows = ref([]);
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    rows.value = await api.teamPlans(props.teamId);
  } catch (e) { ElMessage.error(e.message); } finally { loading.value = false; }
}

// 已完成（total>0 且 done===total）的计划过滤掉；total=0 空计划保留
const keepPlan = (x) => !(x.total > 0 && x.done === x.total);
const visibleRows = computed(() =>
  rows.value.map((m) => ({
    ...m,
    schedTotal: m.schedules.length, // 过滤前总数（空态区分用）
    studyTotal: m.studies.length,
    schedules: m.schedules.filter(keepPlan),
    studies: m.studies.filter(keepPlan),
  }))
);

// 转成 PlanTiles 的紧凑标签数据（只取展示所需字段）
const schedTiles = (arr) => arr.map((s) => ({ id: s.id, name: s.comp_name, done: s.done, total: s.total, phases: s.phases || [] }));
const studyTiles = (arr) => arr.map((s) => ({ id: s.id, name: s.topic, done: s.done, total: s.total, phases: s.phases || [], level: s.level }));

onMounted(() => load());
</script>

<template>
  <div class="tp2" v-loading="loading">
    <div class="tp2-tip">📡 组内共享的备赛计划与学习日程（来自「备赛日程」「学习日程」页）</div>

    <div v-if="!rows.length" class="tp2-empty">暂无成员计划数据</div>

    <div v-for="m in visibleRows" :key="m.user_id" class="member-plan" :class="{ owner: m.is_owner }">
      <div class="mp-head">
        <b class="u-link" @click="toProfile(m)">{{ m.nickname }}</b>
        <el-tag v-if="m.is_owner" size="small" type="warning">👑 组长</el-tag>
        <el-tag v-for="rn in m.role_names || []" :key="rn" size="small" style="margin-right:4px">{{ rn }}</el-tag>
        <el-tag v-if="!(m.role_names || []).length && !m.is_owner" size="small">组员</el-tag>
        <span class="mp-count">
          备赛 {{ m.schedules.length }} · 学习 {{ m.studies.length }}
        </span>
      </div>

      <!-- 备赛计划（已完成的不显示；紧凑标签，点击展开详细进度） -->
      <div v-if="m.schedules.length" class="mp-sec">
        <div class="mp-sec-title">🏁 竞赛备赛计划</div>
        <PlanTiles :items="schedTiles(m.schedules)" />
      </div>
      <div v-else-if="m.schedTotal" class="mp-none mp-done">🎉 该成员备赛计划已全部完成</div>
      <div v-else class="mp-none">暂无备赛计划（成员可在「备赛日程」生成）</div>

      <!-- 学习日程（已完成的不显示；紧凑标签，点击展开详细进度） -->
      <div v-if="m.studies.length" class="mp-sec">
        <div class="mp-sec-title">📚 AI 学习日程</div>
        <PlanTiles :items="studyTiles(m.studies)" />
      </div>
      <div v-else-if="m.studyTotal" class="mp-none mp-done">🎉 该成员学习日程已全部完成</div>
      <div v-else class="mp-none">暂无学习日程（成员可在「学习日程」生成）</div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.tp2-tip { color: #94a3b8; font-size: 12.5px; margin-bottom: 12px; }
.tp2-empty { color: #94a3b8; text-align: center; padding: 40px 0; font-size: 13px; }
.member-plan {
  border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; margin-bottom: 12px;
  &.owner { border-color: var(--badge-border); background: var(--badge-tint); }
  .mp-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px;
    b { font-size: 14.5px; }
    .u-link { cursor: pointer; &:hover { color: var(--primary); } }
    .mp-count { margin-left: auto; color: var(--text-2); font-size: 12px; }
  }
  .mp-sec { margin-top: 8px;
    .mp-sec-title { font-size: 13px; font-weight: 600; margin-bottom: 6px; color: var(--text-2); }
  }
  .mp-none { color: #cbd5e1; font-size: 12.5px; margin-top: 4px;
    &.mp-done { color: #16a34a; font-size: 12.5px; } }
}
</style>
