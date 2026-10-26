<script setup>
// 计划同步：成员以极简小方块呈现（头像+人名+未完成数角标），点击方块弹出该成员的详细个人计划
// 详情内已 100% 完成的计划折叠为「已全部完成」提示（聚焦未完成任务）
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

// 已完成（total>0 且 done===total）的计划在详情里过滤；保留原始计数用于空态文案
const keepPlan = (x) => !(x.total > 0 && x.done === x.total);
const pendingOf = (m) => m.schedules.filter(keepPlan).length + m.studies.filter(keepPlan).length;
const detailOf = (m) => ({
  ...m,
  schedTotal: m.schedules.length,
  studyTotal: m.studies.length,
  schedules: m.schedules.filter(keepPlan),
  studies: m.studies.filter(keepPlan),
});

// 转成 PlanTiles 的紧凑标签数据（只取展示所需字段）
const schedTiles = (arr) => arr.map((s) => ({ id: s.id, name: s.comp_name, done: s.done, total: s.total, phases: s.phases || [] }));
const studyTiles = (arr) => arr.map((s) => ({ id: s.id, name: s.topic, done: s.done, total: s.total, phases: s.phases || [], level: s.level }));

// 选中成员 → 弹出详细个人计划
const memberDlg = ref(false);
const selId = ref(null);
const selected = computed(() => {
  const m = rows.value.find((x) => x.user_id === selId.value);
  return m ? detailOf(m) : null;
});
function openMember(m) { selId.value = m.user_id; memberDlg.value = true; }

onMounted(() => load());
</script>

<template>
  <div class="tp2" v-loading="loading">
    <div class="tp2-tip">📡 组内共享的备赛计划与学习日程（来自「备赛日程」「学习日程」页），点击成员方块查看详情</div>

    <div v-if="!rows.length" class="tp2-empty">暂无成员计划数据</div>

    <!-- 极简成员方块流：头像 + 人名（+组长标记/未完成角标），全部完成显示绿勾 -->
    <div v-else class="mp-chips">
      <div v-for="m in rows" :key="m.user_id" class="mp-chip" :class="{ owner: m.is_owner, done: pendingOf(m) === 0 }"
        @click="openMember(m)">
        <span class="mp-avatar">
          <img v-if="m.avatar" :src="m.avatar" alt="" />
          <template v-else>{{ (m.nickname || '?').slice(0, 1) }}</template>
        </span>
        <b class="mp-cname">{{ m.nickname }}</b>
        <span v-if="m.is_owner" class="mp-crown" title="组长">👑</span>
        <span v-if="pendingOf(m)" class="mp-badge">{{ pendingOf(m) }}</span>
        <span v-else class="mp-done" title="计划已全部完成">✓</span>
      </div>
    </div>

    <!-- 成员详细个人计划弹窗 -->
    <el-dialog v-model="memberDlg" :title="selected ? `${selected.nickname} 的个人计划` : '个人计划'"
      width="720px" top="6vh" append-to-body>
      <div v-if="selected" class="mp-detail">
        <div class="md-head">
          <el-tag v-if="selected.is_owner" size="small" type="warning">👑 组长</el-tag>
          <el-tag v-for="rn in selected.role_names || []" :key="rn" size="small" effect="plain">{{ rn }}</el-tag>
          <el-tag v-if="!(selected.role_names || []).length && !selected.is_owner" size="small" effect="plain">组员</el-tag>
          <el-button size="small" text type="primary" @click="toProfile(selected)">查看主页 →</el-button>
        </div>

        <!-- 备赛计划（已完成的不显示；紧凑标签，点击展开详细进度） -->
        <div class="md-sec">
          <div class="md-sec-title">🏁 竞赛备赛计划（未完成 {{ selected.schedules.length }} / {{ selected.schedTotal }}）</div>
          <PlanTiles v-if="selected.schedules.length" :items="schedTiles(selected.schedules)" />
          <div v-else-if="selected.schedTotal" class="md-none md-done">🎉 备赛计划已全部完成</div>
          <div v-else class="md-none">暂无备赛计划（成员可在「备赛日程」生成）</div>
        </div>

        <!-- 学习日程（已完成的不显示；紧凑标签，点击展开详细进度） -->
        <div class="md-sec">
          <div class="md-sec-title">📚 AI 学习日程（未完成 {{ selected.studies.length }} / {{ selected.studyTotal }}）</div>
          <PlanTiles v-if="selected.studies.length" :items="studyTiles(selected.studies)" />
          <div v-else-if="selected.studyTotal" class="md-none md-done">🎉 学习日程已全部完成</div>
          <div v-else class="md-none">暂无学习日程（成员可在「学习日程」生成）</div>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<style lang="scss" scoped>
.tp2-tip { color: #94a3b8; font-size: 12.5px; margin-bottom: 12px; }
.tp2-empty { color: #94a3b8; text-align: center; padding: 40px 0; font-size: 13px; }

// 极简成员方块
.mp-chips { display: flex; flex-wrap: wrap; gap: 10px; }
.mp-chip {
  display: flex; align-items: center; gap: 7px;
  border: 1px solid var(--border); border-radius: 12px; background: var(--card-bg);
  padding: 7px 14px 7px 7px; cursor: pointer; user-select: none; transition: all .15s;
  &:hover { border-color: #93c5fd; box-shadow: 0 2px 10px color-mix(in srgb, var(--primary) 10%, transparent); transform: translateY(-1px); }
  &.owner { border-color: #fde68a; background: #fffbeb; }
  &.done .mp-cname { color: #16a34a; }
  .mp-avatar {
    width: 30px; height: 30px; border-radius: 50%; overflow: hidden; flex-shrink: 0;
    display: inline-flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600;
    background: color-mix(in srgb, var(--primary) 12%, white); color: var(--primary);
    img { width: 100%; height: 100%; object-fit: cover; }
  }
  .mp-cname { font-size: 13.5px; }
  .mp-crown { font-size: 12px; }
  .mp-badge {
    min-width: 18px; height: 18px; line-height: 18px; padding: 0 5px; border-radius: 9px;
    background: var(--primary); color: #fff; font-size: 11px; text-align: center; font-weight: 600;
  }
  .mp-done { color: #16a34a; font-weight: 700; font-size: 13px; padding: 0 2px; }
}

// 详情弹窗
.mp-detail { display: flex; flex-direction: column; gap: 14px;
  .md-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    .el-button { margin-left: auto; }
  }
  .md-sec-title { font-size: 13px; font-weight: 600; margin-bottom: 8px; color: var(--text-2); }
  .md-none { color: #cbd5e1; font-size: 12.5px;
    &.md-done { color: #16a34a; } }
}

// 移动端：方块一行两个，避免长名字撑爆
@media (max-width: 768px) {
  .mp-chip { flex: 1 1 calc(50% - 10px); min-width: 0; }
  .mp-cname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
}
</style>