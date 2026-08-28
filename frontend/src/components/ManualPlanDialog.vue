<script setup>
// 自编计划弹窗（备赛/学习通用）：不依赖 AI，用户手写标题 + 阶段（名称/日期/任务/达标要求）
import { ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api.js';

const props = defineProps({
  modelValue: Boolean,
  mode: { type: String, default: 'schedule' }, // schedule 备赛 / study 学习
  competitions: { type: Array, default: () => [] },
});
const emit = defineEmits(['update:modelValue', 'created']);

// schedule 模式：选竞赛 或 自定义标题；study 模式：主题
const compId = ref(null);
const customTitle = ref('');
const studyTopic = ref('');
const goal = ref('');
const phases = ref([]);
const submitting = ref(false);

const emptyPhase = () => ({ phase: '', date: '', tasks: '', check_standard: '' });
const newPhase = () => phases.value.push(emptyPhase());
const removePhase = (i) => phases.value.splice(i, 1);

watch(
  () => props.modelValue,
  (v) => {
    if (v) {
      compId.value = null;
      customTitle.value = '';
      studyTopic.value = '';
      goal.value = '';
      phases.value = [emptyPhase()];
    }
  }
);

// tasks 为每行一条的文本，提交时拆分为数组
function build() {
  return phases.value
    .map((p) => ({
      phase: p.phase.trim(),
      date: p.date.trim(),
      tasks: p.tasks.split('\n').map((s) => s.trim()).filter(Boolean),
      check_standard: p.check_standard.trim(),
    }))
    .filter((p) => p.phase || p.tasks.length);
}

async function submit() {
  const list = build();
  if (props.mode === 'schedule') {
    if (!compId.value && !customTitle.value.trim()) return ElMessage.warning('选择竞赛或填写计划名称');
    if (!list.length) return ElMessage.warning('至少写一个阶段和任务');
    submitting.value = true;
    try {
      const res = await api.scheduleManual({
        comp_id: compId.value || undefined,
        title: customTitle.value.trim() || undefined,
        phases: list,
      });
      ElMessage.success('✅ 自编备赛计划已保存');
      emit('created', res);
      emit('update:modelValue', false);
    } catch (e) { ElMessage.error(e.message); } finally { submitting.value = false; }
  } else {
    if (!studyTopic.value.trim()) return ElMessage.warning('填写学习主题');
    if (!list.length) return ElMessage.warning('至少写一个阶段和任务');
    submitting.value = true;
    try {
      const res = await api.studyManual({
        topic: studyTopic.value.trim(),
        goal: goal.value.trim() || undefined,
        phases: list,
      });
      ElMessage.success('✅ 自编学习计划已保存');
      emit('created', res);
      emit('update:modelValue', false);
    } catch (e) { ElMessage.error(e.message); } finally { submitting.value = false; }
  }
}
</script>

<template>
  <el-dialog :model-value="modelValue" :title="mode === 'schedule' ? '✍️ 自编备赛计划' : '✍️ 自编学习计划'"
    width="720px" :close-on-click-modal="false" append-to-body @update:model-value="(v) => emit('update:modelValue', v)">
    <p class="mp-tip">不依赖 AI：填标题 + 分阶段任务，随时可改</p>

    <!-- 标题区 -->
    <div v-if="mode === 'schedule'" class="mp-title">
      <el-select v-model="compId" placeholder="关联竞赛（选填）" filterable clearable style="flex:1.4">
        <el-option v-for="c in competitions" :key="c.id" :value="c.id" :label="c.name" />
      </el-select>
      <span class="mp-or">或</span>
      <el-input v-model="customTitle" placeholder="自定义计划名称（选填）" style="flex:1" />
    </div>
    <div v-else class="mp-title">
      <el-input v-model="studyTopic" placeholder="学习主题，如：数据结构与算法" style="flex:2" />
      <el-input v-model="goal" placeholder="学习目标（选填）" style="flex:1.5" />
    </div>

    <!-- 阶段编辑器 -->
    <div v-for="(p, i) in phases" :key="i" class="mp-phase">
      <div class="mp-ph-head">
        <span class="mp-idx">阶段{{ i + 1 }}</span>
        <el-input v-model="p.phase" placeholder="阶段名称（如：基础入门）" size="small" style="flex:1.4" />
        <el-input v-model="p.date" placeholder="起止日期（如 3月-4月，选填）" size="small" style="flex:1" />
        <el-button size="small" text type="danger" @click="removePhase(i)" :disabled="phases.length <= 1">🗑</el-button>
      </div>
      <el-input v-model="p.tasks" type="textarea" :rows="3" resize="none"
        placeholder="任务清单，每行一条，如：&#10;搭建开发环境&#10;跑通第一个示例&#10;整理核心概念笔记" />
      <el-input v-model="p.check_standard" size="small" placeholder="本阶段达标要求（选填）" style="margin-top:6px" />
    </div>

    <el-button size="small" plain @click="newPhase" style="margin-top:8px">＋ 添加阶段</el-button>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="submit">保存计划</el-button>
    </template>
  </el-dialog>
</template>

<style lang="scss" scoped>
.mp-tip { color: #94a3b8; font-size: 12.5px; margin: 0 0 12px; }
.mp-title { display: flex; align-items: center; gap: 8px; margin-bottom: 12px;
  .mp-or { color: #94a3b8; font-size: 12px; }
}
.mp-phase {
  border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; background: var(--surface-3);
  .mp-ph-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px;
    .mp-idx { font-size: 12.5px; font-weight: 600; color: var(--text-2); white-space: nowrap; }
  }
  // 移动端：阶段头控件换行堆叠
  @media (max-width: 768px) {
    .mp-ph-head { flex-wrap: wrap; }
    .mp-ph-head .el-input { flex: 1 1 100%; }
  }
}
</style>
