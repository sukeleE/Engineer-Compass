<template>
  <view class="page-wrap">
    <view class="card cal-head">
      <text class="nav" @click="shift(-1)">‹</text>
      <text class="ym">{{ year }} 年 {{ month + 1 }} 月</text>
      <text class="nav" @click="shift(1)">›</text>
    </view>

    <view class="card cal">
      <view class="week-row">
        <text v-for="w in weeks" :key="w" class="week">{{ w }}</text>
      </view>
      <view class="grid">
        <view v-for="(cell, i) in cells" :key="i" class="cell" :class="{ muted: !cell.day, today: cell.isToday }" @click="cell.day && open(cell.day)">
          <text class="day">{{ cell.day || '' }}</text>
          <text v-if="cell.status" class="dot" :class="cell.status"></text>
        </view>
      </view>
    </view>

    <view class="legend">
      <text v-for="s in statusList" :key="s.key" class="legend-item"><text class="dot" :class="s.key"></text>{{ s.label }}</text>
    </view>

    <view class="section-title">本月笔记（{{ rows.length }}）</view>
    <view v-for="r in rows" :key="r.id" class="card note-row" @click="open(r.note_date)">
      <view class="note-top">
        <text class="note-date">{{ r.note_date }}</text>
        <text class="tag" :class="statusCls(r.status)">{{ statusLabel(r.status) }}</text>
      </view>
      <view class="note-content ellipsis-2">{{ strip(r.content) || '（无文字内容）' }}</view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue';
import { onShow, onLoad } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { ensureLogin } from '../../../utils/guard.js';

const weeks = ['日', '一', '二', '三', '四', '五', '六'];
const statusList = [
  { key: 'good', label: '顺利' }, { key: 'hard', label: '困难' }, { key: 'slow', label: '进度慢' }, { key: 'none', label: '未评价' },
];
const now = new Date();
const year = ref(now.getFullYear());
const month = ref(now.getMonth());
const rows = ref([]);
const noteMap = computed(() => {
  const m = {};
  for (const r of rows.value) m[r.note_date] = r;
  return m;
});

const cells = computed(() => {
  const first = new Date(year.value, month.value, 1).getDay();
  const days = new Date(year.value, month.value + 1, 0).getDate();
  const todayStr = fmt(new Date());
  const arr = [];
  for (let i = 0; i < first; i++) arr.push({ day: 0 });
  for (let d = 1; d <= days; d++) {
    const date = fmt(new Date(year.value, month.value, d));
    arr.push({ day: d, status: noteMap.value[date]?.status || '', isToday: date === todayStr });
  }
  return arr;
});

function fmt(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function shift(n) {
  let m = month.value + n;
  let y = year.value;
  if (m < 0) { m = 11; y -= 1; }
  if (m > 11) { m = 0; y += 1; }
  month.value = m;
  year.value = y;
  load();
}
function open(date) {
  uni.navigateTo({ url: '/packagePlan/pages/notes/edit?date=' + date });
}
function statusLabel(s) { return statusList.find((x) => x.key === s)?.label || '未评价'; }
function statusCls(s) {
  return { good: 'tag-green', hard: 'tag-red', slow: 'tag-amber', none: 'tag-gray' }[s] || 'tag-gray';
}
function strip(html) {
  return String(html || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
}

async function load() {
  if (!ensureLogin()) return;
  const mm = year.value + '-' + String(month.value + 1).padStart(2, '0');
  rows.value = await api.notesMonth(mm);
}
onLoad(load);
onShow(load);
</script>

<style lang="scss" scoped>
.cal-head { display: flex; align-items: center; justify-content: space-between; }
.ym { font-size: 31rpx; font-weight: 700; color: #1e293b; }
.nav { font-size: 44rpx; color: #2563eb; padding: 0 30rpx; }
.week-row, .grid { display: flex; flex-wrap: wrap; }
.week, .cell { width: calc(100% / 7); text-align: center; }
.week { font-size: 23rpx; color: #94a3b8; padding: 10rpx 0; }
.cell { height: 96rpx; position: relative; display: flex; align-items: center; justify-content: center; }
.cell.muted { opacity: 0; }
.day { font-size: 27rpx; color: #334155; }
.cell.today .day { color: #2563eb; font-weight: 800; }
.dot { position: absolute; bottom: 10rpx; width: 12rpx; height: 12rpx; border-radius: 50%; }
.dot.good { background: #16a34a; }
.dot.hard { background: #ef4444; }
.dot.slow { background: #f59e0b; }
.dot.none { background: #94a3b8; }
.legend { display: flex; gap: 24rpx; padding: 8rpx 10rpx 20rpx; }
.legend-item { font-size: 23rpx; color: #64748b; display: flex; align-items: center; gap: 8rpx; }
.legend-item .dot { position: static; }
.note-row { padding: 22rpx 28rpx; }
.note-top { display: flex; justify-content: space-between; align-items: center; }
.note-date { font-weight: 700; color: #1e293b; font-size: 27rpx; }
.note-content { margin-top: 10rpx; font-size: 25rpx; color: #64748b; }
</style>