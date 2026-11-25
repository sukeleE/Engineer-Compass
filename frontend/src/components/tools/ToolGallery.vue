<script setup>
import ToolPanel from './ToolPanel.vue';
import { pomo, formatClock } from '../../utils/studyTools.js';

defineProps({
  open: Boolean,
  unread: { type: Number, default: 0 },
  panelStyle: { type: Object, default: () => ({}) },
});
const emit = defineEmits(['close', 'pick']);

const groups = [
  {
    label: '专注时间',
    tools: [
      { key: 'pomodoro', icon: '🍅', name: '番茄钟', desc: '25/5 专注循环', badge: () => (pomo.running ? formatClock(pomo.remaining) : '') },
      { key: 'stats', icon: '📊', name: '学习统计', desc: '专注时长 / 连续天数' },
    ],
  },
  {
    label: '目标提醒',
    tools: [
      { key: 'countdown', icon: '📅', name: '倒数日', desc: '竞赛 / 考试倒计时' },
      { key: 'todo', icon: '✅', name: '今日待办', desc: '列出今天最重要的事' },
    ],
  },
  {
    label: '学习记录',
    tools: [
      { key: 'notes', icon: '📝', name: '日程笔记', desc: '记录学习状态与复盘' },
    ],
  },
  {
    label: '学习助手',
    tools: [
      { key: 'ai', icon: '💬', name: 'AI 对话', desc: '竞赛 / 备赛问题' },
      { key: 'msg', icon: '🔔', name: '消息中心', desc: '评论 / 点赞 / 系统通知', badge: 'unread' },
    ],
  },
];
</script>

<template>
  <ToolPanel :open="open" :panel-style="panelStyle" icon="🧰" title="学习工具" subtitle="选一个工具开始今天的学习" @close="emit('close')">
    <div v-for="g in groups" :key="g.label" class="tg-group">
      <div class="tg-label">{{ g.label }}</div>
      <div class="tg-grid">
        <button
          v-for="t in g.tools" :key="t.key" type="button" class="tg-card"
          @click="emit('pick', t.key)"
        >
          <span class="tg-icon">{{ t.icon }}</span>
          <span class="tg-main">
            <b>{{ t.name }}</b>
            <i>{{ t.desc }}</i>
          </span>
          <span v-if="t.badge === 'unread' && unread > 0" class="tg-badge">{{ unread > 99 ? '99+' : unread }}</span>
          <span v-else-if="typeof t.badge === 'function' && t.badge()" class="tg-badge run">{{ t.badge() }}</span>
        </button>
      </div>
    </div>
  </ToolPanel>
</template>

<style lang="scss" scoped>
.tg-group { margin-bottom: 16px; &:last-child { margin-bottom: 0; } }
.tg-label { font-size: 12.5px; font-weight: 600; color: var(--text-2); margin: 0 2px 8px; }
.tg-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.tg-card {
  position: relative; display: flex; align-items: center; gap: 10px; text-align: left;
  border: 1px solid var(--border); background: var(--card-bg); border-radius: 10px;
  padding: 12px; cursor: pointer; transition: border-color .15s, transform .15s;
  &:hover { border-color: var(--primary); transform: translateY(-1px); }
  &:focus { outline: none; }
  &:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
}
.tg-icon { font-size: 26px; flex: none; }
.tg-main { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.tg-main b { font-size: 13.5px; color: var(--text); }
.tg-main i { font-size: 11px; color: var(--text-3); font-style: normal; line-height: 1.4; }
.tg-badge {
  position: absolute; top: 6px; right: 6px; min-width: 18px; height: 18px; line-height: 18px;
  padding: 0 5px; border-radius: 999px; background: #ef4444; color: #fff;
  font-size: 10px; text-align: center; box-sizing: border-box;
  &.run { background: var(--primary); }
}
@media (max-width: 768px) {
  .tg-grid { grid-template-columns: 1fr; }
}
</style>
