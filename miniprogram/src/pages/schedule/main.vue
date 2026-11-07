<template>
  <view class="page-wrap">
    <!-- 未登录 -->
    <EmptyState v-if="!loggedIn" icon="🔐" text="登录后查看和管理你的 AI 备赛计划" btn-text="去登录" @action="goLogin" />

    <block v-else>
      <view v-if="loading" class="empty"><view class="empty-text">加载中…</view></view>
      <block v-else>
        <view class="top-ops">
          <button class="btn btn-primary half" @click="goManual">＋ 自编计划</button>
          <button class="btn btn-ghost half" @click="openCalendar">📅 月历视图</button>
        </view>
        <EmptyState v-if="!list.length" icon="🗓️" text="还没有备赛计划，去竞赛页选择比赛加入日程" btn-text="去看竞赛" @action="goTimeline" />

        <view v-for="s in list" :key="s.id" class="card schedule-card">
          <view class="sched-head" @click="toggle(s.id)">
            <view class="sched-title-wrap">
              <text class="sched-name ellipsis">{{ s.comp_name || s.short_name || '自编计划' }}</text>
              <text class="sched-meta">{{ progressOf(s).done }}/{{ progressOf(s).total }} 任务 · {{ progressOf(s).percent }}%</text>
            </view>
            <text class="chevron">{{ expanded[s.id] ? '▾' : '▸' }}</text>
          </view>

          <view class="progress-track">
            <view class="progress-fill" :style="{ width: progressOf(s).percent + '%' }"></view>
          </view>

          <view v-if="expanded[s.id]" class="phases">
            <view v-for="(ph, pi) in s.plan.phases" :key="pi" class="phase">
              <view class="phase-title">
                <text class="phase-name">{{ ph.phase }}</text>
                <text v-if="ph.date" class="phase-date">{{ ph.date }}</text>
              </view>
              <view
                v-for="(t, ti) in ph.tasks"
                :key="ti"
                class="task"
                @click="toggleTask(s, pi, ti)"
              >
                <text class="checkbox" :class="{ checked: t.done }">{{ t.done ? '✓' : '' }}</text>
                <text class="task-text" :class="{ done: t.done }">{{ t.text }}</text>
              </view>
              <view v-if="ph.check_standard" class="check-std">达标：{{ ph.check_standard }}</view>
            </view>

            <view class="card-actions">
              <button class="btn btn-ghost mini" :disabled="optimizingId === s.id" @click.stop="optimize(s)">{{ optimizingId === s.id ? 'AI 优化中…' : 'AI 优化' }}</button>
              <button class="btn btn-danger mini" @click.stop="remove(s)">删除计划</button>
            </view>
          </view>
        </view>
      </block>
    </block>

    <!-- 月历视图 -->
    <view v-if="calOpen" class="modal-mask" @click="calOpen = false">
      <view class="modal modal-lg" @click.stop>
        <view class="modal-title">月历 · {{ calMonth }}</view>
        <view class="cal-nav">
          <text class="cal-nav-btn" @click="shiftMonth(-1)">‹ 上月</text>
          <picker mode="date" fields="month" :value="calMonth" @change="onCalPick">
            <text class="cal-nav-btn">选择月份</text>
          </picker>
          <text class="cal-nav-btn" @click="shiftMonth(1)">下月 ›</text>
        </view>
        <scroll-view scroll-y class="modal-scroll" v-if="calData">
          <view v-for="g in calGroups" :key="g.date" class="cal-day">
            <view class="cal-date">{{ String(g.date).slice(5).replace('-', '/') }}</view>
            <view v-for="(it, i) in g.items" :key="i" class="cal-item">
              <text class="cal-tag" :class="it.cls">{{ it.src }}</text>
              <text class="cal-text ellipsis">{{ it.task }}</text>
            </view>
          </view>
          <EmptyState v-if="!calGroups.length" icon="🗓" text="本月没有完成事项或笔记" />
        </scroll-view>
        <view v-else class="loading-text">加载中…</view>
        <button class="btn btn-primary modal-btn" @click="calOpen = false">关闭</button>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, reactive, computed } from 'vue';
import { onShow, onPullDownRefresh } from '@dcloudio/uni-app';
import { api } from '../../utils/api.js';
import { isLoggedIn, auth } from '../../utils/auth.js';
import { planProgress } from '../../utils/format.js';
import EmptyState from '../../components/EmptyState.vue';

const list = ref([]);
const loading = ref(true);
const expanded = reactive({});
const saveTimers = {};
const rollbackSnap = {};

const loggedIn = computed(() => isLoggedIn() && !!auth.user);

function progressOf(s) {
  return planProgress(s.plan);
}

function toggle(id) {
  expanded[id] = !expanded[id];
}

async function load() {
  if (!isLoggedIn()) { loading.value = false; return; }
  loading.value = true;
  try {
    const rows = await api.scheduleList();
    list.value = rows.map((r) => ({ ...r, plan: r.plan || { phases: [] } }));
  } finally {
    loading.value = false;
  }
}

function toggleTask(s, pi, ti) {
  const task = s.plan.phases[pi].tasks[ti];
  if (!rollbackSnap[s.id]) rollbackSnap[s.id] = JSON.stringify(s.plan);
  task.done = !task.done;
  // 防抖整包保存（对齐 H5：plan_json 全量覆盖）
  if (saveTimers[s.id]) clearTimeout(saveTimers[s.id]);
  saveTimers[s.id] = setTimeout(async () => {
    try {
      await api.scheduleEdit(s.id, s.plan);
      delete rollbackSnap[s.id];
    } catch (e) {
      const snap = rollbackSnap[s.id];
      if (snap) s.plan = JSON.parse(snap);
      delete rollbackSnap[s.id];
      uni.showToast({ title: '进度保存失败，已回滚', icon: 'none' });
    }
  }, 800);
}

function remove(s) {
  uni.showModal({
    title: '删除计划',
    content: `确认删除「${s.comp_name || '该计划'}」的备赛日程？`,
    confirmColor: '#ef4444',
    success: async (m) => {
      if (!m.confirm) return;
      await api.scheduleDelete(s.id);
      uni.showToast({ title: '已删除', icon: 'success' });
      load();
    },
  });
}

// ============ 自编计划 / AI 优化 ============
const optimizingId = ref(null);
function goManual() {
  uni.navigateTo({ url: '/packagePlan/pages/schedule/edit' });
}
async function optimize(s) {
  uni.showModal({
    title: 'AI 优化计划',
    content: 'AI 将依据当前完成进度重排「' + (s.comp_name || '该计划') + '」，已勾选的任务会保留，确认继续？',
    success: async (m) => {
      if (!m.confirm) return;
      optimizingId.value = s.id;
      uni.showLoading({ title: 'AI 优化中…', mask: true });
      try {
        const r = await api.scheduleOptimize(s.id);
        s.plan = r.plan || { phases: [] };
        uni.hideLoading();
        uni.showToast({ title: '优化版已生成', icon: 'success' });
      } catch (e) {
        uni.hideLoading();
      } finally {
        optimizingId.value = null;
      }
    },
  });
}

// ============ 月历 ============
const calOpen = ref(false);
const calMonth = ref('');
const calData = ref(null);
function currentMonth() {
  const n = new Date();
  return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0');
}
const calGroups = computed(() => {
  if (!calData.value) return [];
  const tag = (src, cls, arr, taskField) => arr.map((x) => ({ date: x.date, src, cls, task: x[taskField] || x.content || '' }));
  const all = []
    .concat(tag('竞赛', 'tag-blue', calData.value.comp || [], 'task'))
    .concat(tag('学习', 'tag-green', calData.value.study || [], 'task'))
    .concat(tag('小组', 'tag-amber', calData.value.team || [], 'task'))
    .concat((calData.value.notes || []).map((x) => ({ date: x.note_date, src: '笔记', cls: 'tag-gray', task: x.content })));
  const map = new Map();
  for (const it of all) {
    const key = String(it.date).slice(0, 10);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(it);
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([date, items]) => ({ date, items }));
});
async function loadCalendar() {
  calData.value = null;
  calData.value = await api.scheduleCalendar(calMonth.value);
}
function openCalendar() {
  calMonth.value = currentMonth();
  calOpen.value = true;
  loadCalendar();
}
function shiftMonth(delta) {
  const parts = calMonth.value.split('-');
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1 + delta, 1);
  calMonth.value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  loadCalendar();
}
function onCalPick(e) {
  calMonth.value = e.detail.value;
  loadCalendar();
}

function goLogin() {
  uni.navigateTo({ url: '/pages/login/main' });
}
function goTimeline() {
  uni.switchTab({ url: '/pages/timeline/main' });
}

onShow(load);
onPullDownRefresh(async () => {
  await load();
  uni.stopPullDownRefresh();
});
</script>

<style lang="scss" scoped>
.schedule-card { padding: 24rpx 28rpx; }
.sched-head { display: flex; align-items: center; justify-content: space-between; gap: 16rpx; }
.sched-title-wrap { flex: 1; min-width: 0; }
.sched-name { font-size: 30rpx; font-weight: 700; color: #1e293b; display: block; }
.sched-meta { font-size: 24rpx; color: #64748b; margin-top: 6rpx; display: block; }
.chevron { color: #94a3b8; font-size: 32rpx; }
.progress-track {
  height: 12rpx;
  background: #f1f5f9;
  border-radius: 6rpx;
  margin-top: 16rpx;
  overflow: hidden;
}
.progress-fill { height: 100%; background: linear-gradient(90deg, #2563eb, #60a5fa); border-radius: 6rpx; transition: width .3s; }
.phases { margin-top: 20rpx; }
.phase { padding: 16rpx 0; border-bottom: 1rpx solid #f8fafc; }
.phase-title { display: flex; align-items: baseline; justify-content: space-between; gap: 16rpx; margin-bottom: 10rpx; }
.phase-name { font-size: 27rpx; font-weight: 700; color: #334155; }
.phase-date { font-size: 23rpx; color: #94a3b8; }
.task { display: flex; align-items: flex-start; gap: 14rpx; padding: 12rpx 0; }
.checkbox {
  width: 38rpx;
  height: 38rpx;
  border: 2rpx solid #cbd5e1;
  border-radius: 10rpx;
  flex-shrink: 0;
  text-align: center;
  line-height: 36rpx;
  color: #fff;
  font-size: 26rpx;
}
.checkbox.checked { background: #16a34a; border-color: #16a34a; }
.task-text { font-size: 26rpx; color: #334155; line-height: 1.5; flex: 1; }
.task-text.done { color: #94a3b8; text-decoration: line-through; }
.check-std { font-size: 23rpx; color: #15803d; background: #f0fdf4; border-radius: 10rpx; padding: 10rpx 16rpx; margin-top: 8rpx; }
.card-actions { display: flex; justify-content: flex-end; margin-top: 18rpx; }
.btn.mini { width: 180rpx; height: 64rpx; font-size: 25rpx; }
.top-ops { display: flex; gap: 16rpx; margin-bottom: 18rpx; }
.half { flex: 1; height: 80rpx; font-size: 27rpx; }
.modal-mask { position: fixed; inset: 0; background: rgba(15,23,42,0.45); z-index: 100; display: flex; align-items: center; justify-content: center; padding: 48rpx; }
.modal { width: 100%; background: #fff; border-radius: 24rpx; padding: 32rpx; }
.modal-lg { max-height: 82vh; display: flex; flex-direction: column; }
.modal-scroll { max-height: 58vh; }
.modal-title { font-size: 32rpx; font-weight: 800; text-align: center; margin-bottom: 18rpx; }
.modal-btn { height: 80rpx; font-size: 28rpx; margin-top: 18rpx; }
.loading-text { text-align: center; color: #94a3b8; padding: 60rpx 0; font-size: 26rpx; }
.cal-nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16rpx; }
.cal-nav-btn { font-size: 25rpx; color: #2563eb; background: #eff6ff; border-radius: 24rpx; padding: 10rpx 26rpx; }
.cal-day { padding: 14rpx 0; border-bottom: 1rpx solid #f1f5f9; }
.cal-date { font-size: 25rpx; font-weight: 800; color: #1e293b; margin-bottom: 8rpx; }
.cal-item { display: flex; align-items: center; gap: 12rpx; padding: 8rpx 0; }
.cal-tag { flex: none; font-size: 20rpx; border-radius: 8rpx; padding: 2rpx 12rpx; background: #f1f5f9; color: #475569; }
.cal-tag.tag-blue { background: #eff6ff; color: #2563eb; }
.cal-tag.tag-green { background: #f0fdf4; color: #16a34a; }
.cal-tag.tag-amber { background: #fef3c7; color: #b45309; }
.cal-tag.tag-gray { background: #f1f5f9; color: #64748b; }
.cal-text { flex: 1; min-width: 0; font-size: 24rpx; color: #334155; }
</style>