<script setup>
import { ElMessage } from 'element-plus';
import ToolPanel from './ToolPanel.vue';
import {
  pomo, formatClock, pomodoroToggle, pomodoroReset,
  setFocusMinutes, setBreakMinutes, savePomodoro, todayFocusMinutes,
} from '../../utils/studyTools.js';

defineProps({ open: Boolean, panelStyle: { type: Object, default: () => ({}) } });
const emit = defineEmits(['close']);
const focusPresets = [25, 45, 60];
const breakPresets = [5, 10, 15];

function pickFocus(min) {
  if (!setFocusMinutes(min)) ElMessage.info('请先暂停再切换专注时长');
}
function pickBreak(min) {
  if (!setBreakMinutes(min)) ElMessage.info('请先暂停再切换休息时长');
}
</script>

<template>
  <ToolPanel :open="open" :panel-style="panelStyle" icon="🍅" title="番茄钟" :subtitle="pomo.mode === 'focus' ? '专注时间' : '休息时间'" @close="emit('close')">
    <div class="pomo-card">
      <div class="pomo-clock">{{ formatClock(pomo.remaining) }}</div>
      <el-input
        v-model="pomo.task" placeholder="这次专注要做什么？（选填）"
        maxlength="40" class="pomo-task" @change="savePomodoro" @blur="savePomodoro"
      />
      <div class="pomo-actions">
        <el-button type="primary" size="large" class="pomo-main" @click="pomodoroToggle">
          {{ pomo.running ? '暂停' : (pomo.mode === 'focus' ? '开始专注' : '开始休息') }}
        </el-button>
        <el-button size="large" @click="pomodoroReset">重置</el-button>
      </div>
      <div class="pomo-meta">今日完成 {{ pomo.completedToday }} 个番茄 · 累计专注 {{ todayFocusMinutes() }} 分钟</div>
    </div>

    <div class="preset-block">
      <div class="preset-label">专注时长</div>
      <div class="preset-row">
        <button v-for="m in focusPresets" :key="'f' + m" type="button" class="preset-chip" :class="{ on: pomo.focusMin === m }" @click="pickFocus(m)">{{ m }} 分钟</button>
      </div>
      <div class="preset-label">休息时长</div>
      <div class="preset-row">
        <button v-for="m in breakPresets" :key="'b' + m" type="button" class="preset-chip" :class="{ on: pomo.breakMin === m }" @click="pickBreak(m)">{{ m }} 分钟</button>
      </div>
    </div>

    <div class="pomo-tip">计时在关闭面板/切换页面后继续；刷新后按结束时间自动校准。</div>
  </ToolPanel>
</template>

<style lang="scss" scoped>
.pomo-card {
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px;
  padding: 22px 16px 18px; text-align: center;
}
.pomo-clock {
  font-size: 56px; font-weight: 800; line-height: 1.1; color: var(--text);
  font-variant-numeric: tabular-nums; letter-spacing: 0;
}
.pomo-task { margin: 14px 0 16px; }
.pomo-actions { display: flex; gap: 10px; justify-content: center; }
.pomo-main { min-width: 150px; }
.pomo-meta { margin-top: 14px; font-size: 12.5px; color: var(--text-3); }
.preset-block { margin-top: 14px; background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; }
.preset-label { font-size: 12.5px; color: var(--text-2); margin: 4px 0 8px; font-weight: 600; }
.preset-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.preset-chip {
  border: 1px solid var(--border); background: var(--bg-2); color: var(--text-2);
  border-radius: 999px; padding: 6px 14px; font-size: 12.5px; cursor: pointer;
  &:hover { border-color: var(--primary); color: var(--primary); }
  &.on { background: var(--primary-tint); border-color: var(--primary); color: var(--primary); font-weight: 600; }
}
.pomo-tip { margin-top: 12px; font-size: 12px; color: var(--text-3); line-height: 1.7; }
</style>
