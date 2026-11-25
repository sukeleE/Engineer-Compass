<script setup>
import { computed } from 'vue';
import ToolPanel from './ToolPanel.vue';
import {
  sessions, todayFocusMinutes, weekFocusMinutes, streakDays, last7Days, todayStr,
} from '../../utils/studyTools.js';

defineProps({ open: Boolean, panelStyle: { type: Object, default: () => ({}) } });
const emit = defineEmits(['close']);

const days = computed(() => last7Days());
const maxMinutes = computed(() => Math.max(30, ...days.value.map((d) => d.minutes)));
const recent = computed(() => [...sessions].sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt))).slice(0, 10));
const todayCount = computed(() => sessions.filter((s) => s.date === todayStr()).length);

function barHeight(minutes) {
  return Math.max(4, Math.round((minutes / maxMinutes.value) * 110)) + 'px';
}
function fmtSession(s) {
  if (!s.endedAt) return s.date || '';
  try {
    return new Date(s.endedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch { return s.date || ''; }
}
</script>

<template>
  <ToolPanel :open="open" :panel-style="panelStyle" icon="📊" title="学习统计" subtitle="番茄专注记录" @close="emit('close')">
    <div class="st-summary">
      <div class="st-card"><span>今日专注</span><b>{{ todayFocusMinutes() }}</b><i>分钟</i></div>
      <div class="st-card"><span>本周专注</span><b>{{ weekFocusMinutes() }}</b><i>分钟</i></div>
      <div class="st-card"><span>连续学习</span><b>{{ streakDays() }}</b><i>天</i></div>
      <div class="st-card"><span>今日番茄</span><b>{{ todayCount }}</b><i>个</i></div>
    </div>

    <div class="st-block">
      <div class="st-title">最近 7 天</div>
      <div class="st-chart">
        <div v-for="d in days" :key="d.key" class="st-bar-wrap" :title="`${d.label}：${d.minutes} 分钟`">
          <span class="st-bar-num">{{ d.minutes || '' }}</span>
          <div class="st-bar" :class="{ today: d.key === todayStr() }" :style="{ height: barHeight(d.minutes) }"></div>
          <span class="st-bar-label">{{ d.label }}</span>
        </div>
      </div>
    </div>

    <div class="st-block">
      <div class="st-title">最近专注记录</div>
      <div v-if="!recent.length" class="st-empty">完成一个番茄后，这里会记录你的专注时长。</div>
      <div v-for="s in recent" :key="s.id" class="st-row">
        <span class="st-time">{{ fmtSession(s) }}</span>
        <span class="st-task">{{ s.task || '未命名专注' }}</span>
        <span class="st-min">{{ s.minutes }} 分钟</span>
      </div>
    </div>
  </ToolPanel>
</template>

<style lang="scss" scoped>
.st-summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.st-card {
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px;
  display: flex; flex-direction: column; gap: 4px;
  span { font-size: 12px; color: var(--text-3); }
  b { font-size: 24px; color: var(--text); line-height: 1.1; }
  i { font-size: 11.5px; color: var(--text-3); font-style: normal; }
}
.st-block { margin-top: 16px; background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 14px; }
.st-title { font-size: 12.5px; font-weight: 600; color: var(--text-2); margin-bottom: 12px; }
.st-chart { display: flex; align-items: flex-end; gap: 8px; height: 150px; padding-top: 8px; }
.st-bar-wrap { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 4px; height: 100%; }
.st-bar-num { font-size: 10px; color: var(--text-3); height: 12px; }
.st-bar {
  width: 100%; max-width: 26px; border-radius: 5px 5px 2px 2px;
  background: color-mix(in srgb, var(--primary) 35%, transparent);
  &.today { background: var(--primary); }
}
.st-bar-label { font-size: 10.5px; color: var(--text-3); white-space: nowrap; }
.st-empty { font-size: 12.5px; color: var(--text-3); text-align: center; padding: 18px 0; }
.st-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px dashed var(--border); font-size: 12.5px; &:last-child { border-bottom: none; } }
.st-time { color: var(--text-3); white-space: nowrap; }
.st-task { flex: 1; min-width: 0; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-min { color: var(--primary); font-weight: 600; white-space: nowrap; }
</style>
