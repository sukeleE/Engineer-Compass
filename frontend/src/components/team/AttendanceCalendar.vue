<script setup>
const props = defineProps({
  cells: { type: Array, default: () => [] },
  today: String,
  mode: { type: String, default: 'status' },
});
const emit = defineEmits(['pick']);
const WEEK = ['一', '二', '三', '四', '五', '六', '日'];
const STATUS_LABEL = {
  normal: '正常',
  late: '迟到',
  leave: '请假',
  leave_pending: '待批',
  absent: '缺勤',
  can_checkin: '可打卡',
  waiting: '未开始',
};
function open(cell) {
  if (cell && cell.info?.working) emit('pick', cell);
}
function ratePct(info) {
  if (!info || !info.expected) return '-';
  return `${Math.round((info.actual / info.expected) * 100)}%`;
}
function rateBg(info) {
  if (!info || !info.expected) return '';
  const rate = Math.min(1, Math.max(0, info.actual / info.expected));
  return `background: hsl(${35 + 105 * rate} 72% 44%)`;
}
</script>

<template>
  <div class="att-calendar">
    <div class="ac-head">
      <span v-for="w in WEEK" :key="w">{{ w }}</span>
    </div>
    <div class="ac-grid">
      <div v-for="(cell, i) in cells" :key="i" class="ac-slot">
        <button v-if="cell" type="button" class="ac-cell"
          :class="[cell.info.status !== 'off' ? `st-${cell.info.status}` : 'off', { today: cell.date === today }]"
          :style="cell.info.working && mode === 'count' ? rateBg(cell.info) : {}"
          :disabled="!cell.info.working" @click="open(cell)">
          <span class="ac-day">{{ cell.day }}</span>
          <template v-if="cell.info.working">
            <template v-if="mode === 'count'">
              <span class="ac-count">{{ cell.info.actual ?? '-' }}/{{ cell.info.expected ?? '-' }}</span>
              <span class="ac-rate">{{ ratePct(cell.info) }}</span>
            </template>
            <template v-else>
              <span class="ac-dots">
                <i v-for="c in cell.info.cells" :key="c.slot_id" :class="c.status"></i>
              </span>
              <span class="ac-status">{{ STATUS_LABEL[cell.info.status] || cell.info.status }}</span>
            </template>
          </template>
          <span v-else class="ac-off">休</span>
        </button>
        <div v-else class="ac-cell empty"></div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.att-calendar { max-width: 920px; }
.ac-head { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; margin-bottom: 6px; }
.ac-head span { text-align: center; font-size: 12px; color: var(--text-2); }
.ac-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; }
.ac-slot { min-width: 0; }
.ac-cell {
  position: relative; width: 100%; min-height: 78px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--card-bg); padding: 8px 8px 6px; display: flex; flex-direction: column;
  align-items: flex-start; gap: 5px; cursor: pointer; transition: all .15s;
  &:hover:not(:disabled) { border-color: color-mix(in srgb, var(--primary) 45%, white); transform: translateY(-1px); }
  &.today { box-shadow: 0 0 0 2px var(--primary); }
  &.empty { visibility: hidden; }
  &.off { background: rgba(148,163,184,.10); color: #94a3b8; cursor: default; }
  &.st-normal { background: #ecfdf5; border-color: #a7f3d0; }
  &.st-late { background: #fff7ed; border-color: #fed7aa; }
  &.st-leave, &.st-leave_pending { background: #eff6ff; border-color: #bcd4f3; }
  &.st-absent { background: #fff1f2; border-color: #f4b7bb; }
  &.st-can_checkin { background: #f0f9ff; border-color: #b6d8f4; }
  &.st-waiting { background: rgba(148,163,184,.10); border-color: var(--border); }
}
.ac-day { font-size: 14px; font-weight: 600; line-height: 1; }
.ac-dots { display: flex; gap: 3px; flex-wrap: wrap;
  i { width: 7px; height: 7px; border-radius: 50%; background: #cbd5e1; }
  i.normal { background: #22c55e; }
  i.late, i.leave_pending { background: #f59e0b; }
  i.absent { background: #ef4444; }
  i.leave { background: #3b82f6; }
  i.can_checkin { background: #38bdf8; }
}
.ac-status { font-size: 11.5px; color: var(--text-2); line-height: 1.2; margin-top: auto; }
.ac-off { font-size: 11.5px; color: #94a3b8; margin-top: auto; }
.ac-count { font-size: 19px; font-weight: 700; line-height: 1.1; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,.18); }
.ac-rate { font-size: 11px; color: rgba(255,255,255,.92); margin-top: auto; }
</style>
