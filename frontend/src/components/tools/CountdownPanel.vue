<script setup>
import { ref, computed } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import ToolPanel from './ToolPanel.vue';
import {
  countdowns, addCountdown, removeCountdown, daysLeft, daysText, todayStr,
} from '../../utils/studyTools.js';

defineProps({ open: Boolean, panelStyle: { type: Object, default: () => ({}) } });
const emit = defineEmits(['close']);

const title = ref('');
const date = ref(todayStr());
const items = computed(() => countdowns.map((x) => ({ ...x, days: daysLeft(x.date), label: daysText(x.date) })));

function add() {
  if (!title.value.trim()) return ElMessage.warning('请填写目标名称');
  if (!date.value) return ElMessage.warning('请选择目标日期');
  addCountdown(title.value, date.value);
  title.value = '';
  ElMessage.success('已添加倒数日');
}

async function remove(item) {
  try {
    await ElMessageBox.confirm(`删除倒数日「${item.title}」？`, '删除倒数日', { type: 'warning' });
  } catch { return; }
  removeCountdown(item.id);
}
</script>

<template>
  <ToolPanel :open="open" :panel-style="panelStyle" icon="📅" title="倒数日" subtitle="竞赛 / 考试 / 截止日期" @close="emit('close')">
    <div class="cd-form">
      <el-input v-model="title" placeholder="目标名称，如：省赛" maxlength="20" @keyup.enter="add" />
      <el-date-picker v-model="date" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" class="cd-date" />
      <el-button type="primary" @click="add">添加</el-button>
    </div>

    <div v-if="!items.length" class="cd-empty">还没有倒数日，先添加一个目标吧</div>
    <div v-else class="cd-list">
      <div v-for="it in items" :key="it.id" class="cd-item">
        <div class="cd-main">
          <b class="cd-title">{{ it.title }}</b>
          <span class="cd-date">{{ it.date }}</span>
        </div>
        <span class="cd-days" :class="{ soon: it.days <= 7 && it.days >= 0, past: it.days < 0 }">{{ it.label }}</span>
        <el-button link type="danger" size="small" @click="remove(it)">删除</el-button>
      </div>
    </div>
  </ToolPanel>
</template>

<style lang="scss" scoped>
.cd-form { display: flex; gap: 8px; margin-bottom: 14px; }
.cd-date { flex: 0 0 170px; width: 170px !important; }
.cd-empty { text-align: center; color: var(--text-3); font-size: 13px; padding: 50px 10px; }
.cd-list { display: flex; flex-direction: column; gap: 8px; }
.cd-item {
  display: flex; align-items: center; gap: 12px;
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px;
}
.cd-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.cd-title { font-size: 14px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cd-date { font-size: 11.5px; color: var(--text-3); }
.cd-days { font-size: 15px; font-weight: 800; color: var(--primary); white-space: nowrap; }
.cd-days.soon { color: #b45309; }
.cd-days.past { color: var(--text-3); font-weight: 600; }
</style>
