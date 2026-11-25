<template>
  <view class="fd-root">
    <view class="fd-anchor" :style="anchorStyle">
      <!-- 展开的工具列表（仿网页版 ToolDock：默认向上纵向堆叠；靠近顶部自动向下，靠近左侧自动换到右边） -->
      <view v-if="open" class="fd-tools" :class="{ below: !spaceAbove, left: leftMode }">
        <view class="fd-tool" @click="pick('gallery')">
          <text class="fd-name">工具</text>
          <view class="fd-icon">🧰</view>
        </view>
        <view class="fd-tool" @click="pick('notes')">
          <text class="fd-name">学习笔记</text>
          <view class="fd-icon">📝</view>
        </view>
        <view class="fd-tool" @click="pick('msg')">
          <text class="fd-name">消息中心</text>
          <view class="fd-icon">🔔<text v-if="unread > 0" class="fd-unread">{{ unread > 99 ? '99+' : unread }}</text></view>
        </view>
      </view>

      <!-- 主浮标（可自由拖动，点击展开；拖动超过阈值不触发点击） -->
      <view class="fd-fab" :class="{ active: open, dragging }"
        @touchstart.stop="onTouchStart"
        @touchmove.stop.prevent="onTouchMove"
        @touchend.stop="onTouchEnd"
        @touchcancel.stop="onTouchCancel"
        @click="onFabClick">
        <text v-if="pomo.running && !open" class="fd-fab-time">{{ formatClock(pomo.remaining) }}</text>
        <text v-else class="fd-fab-icon">🧰</text>
        <text v-if="unread > 0 && !open && !pomo.running" class="fd-dot"></text>
      </view>
    </view>

    <!-- 工具面板 -->
    <view v-if="panel" class="fd-mask" @click="closePanel">
      <view class="fd-sheet" @click.stop>
        <template v-if="panel === 'gallery'">
          <view class="fd-sheet-head">
            <text class="fd-sheet-title">🧰 学习工具</text>
            <text class="fd-close" @click="closePanel">×</text>
          </view>
          <view class="tool-grid">
            <view class="tool-card" @click="openGalleryTool('pomodoro')">
              <text class="tool-card-icon">🍅</text>
              <text class="tool-card-name">番茄钟</text>
              <text class="tool-card-desc">{{ pomo.running ? formatClock(pomo.remaining) : '专注计时' }}</text>
            </view>
            <view class="tool-card" @click="openGalleryTool('countdown')">
              <text class="tool-card-icon">📅</text>
              <text class="tool-card-name">倒数日</text>
              <text class="tool-card-desc">{{ countdowns.list.length }} 个目标</text>
            </view>
            <view class="tool-card" @click="openGalleryTool('todo')">
              <text class="tool-card-icon">✅</text>
              <text class="tool-card-name">今日待办</text>
              <text class="tool-card-desc">{{ todos.list.filter((item) => !item.done).length }} 项未完成</text>
            </view>
            <view class="tool-card" @click="openGalleryTool('stats')">
              <text class="tool-card-icon">📊</text>
              <text class="tool-card-name">学习统计</text>
              <text class="tool-card-desc">今日 {{ stats.today }} 分钟</text>
            </view>
            <view class="tool-card tool-card-wide" @click="openGalleryTool('ai')">
              <text class="tool-card-icon">💬</text>
              <text class="tool-card-name">AI 对话</text>
              <text class="tool-card-desc">竞赛、备赛和学习问题都可以直接问</text>
            </view>
          </view>
        </template>

        <template v-else-if="panel === 'pomodoro'">
          <view class="fd-sheet-head">
            <text class="fd-sheet-title">🍅 番茄钟</text>
            <text class="fd-close" @click="closePanel">✕</text>
          </view>
          <view class="pomo-mode">{{ pomo.mode === 'focus' ? '专注时间' : '休息时间' }}</view>
          <view class="pomo-clock">{{ formatClock(pomo.remaining) }}</view>
          <view class="pomo-tip">今日完成 {{ pomo.completedToday }} 个番茄</view>
          <view class="pomo-actions">
            <button class="btn btn-primary pomo-btn" @click="pomodoroToggle">{{ pomo.running ? '暂停' : '开始' }}</button>
            <button class="btn btn-ghost pomo-btn" @click="pomodoroReset">重置</button>
          </view>
          <view class="preset-row">
            <text class="preset-label">专注</text>
            <text v-for="m in focusPresets" :key="'f' + m" class="preset-chip" :class="{ on: pomo.focusMin === m }" @click="chooseFocus(m)">{{ m }} 分钟</text>
          </view>
          <view class="preset-row">
            <text class="preset-label">休息</text>
            <text v-for="m in breakPresets" :key="'b' + m" class="preset-chip" :class="{ on: pomo.breakMin === m }" @click="chooseBreak(m)">{{ m }} 分钟</text>
          </view>
          <view class="pomo-foot">计时在切换页面后继续；离开小程序期间按结束时间自动校准。</view>
        </template>

        <template v-else-if="panel === 'countdown'">
          <view class="fd-sheet-head">
            <text class="fd-sheet-title">📅 倒数日</text>
            <text class="fd-close" @click="closePanel">✕</text>
          </view>
          <view class="cd-form">
            <input v-model="cdTitle" class="cd-input" placeholder="目标名称，如：省赛" maxlength="20" />
            <picker mode="date" :value="cdDate" @change="onCdDate">
              <view class="cd-date-btn">{{ cdDate || '选择日期' }}</view>
            </picker>
            <button class="btn btn-primary cd-add" @click="addCd">添加</button>
          </view>
          <scroll-view scroll-y class="cd-list">
            <EmptyState v-if="!cdItems.length" icon="📅" text="还没有倒数日，添加一个目标吧" />
            <view v-for="it in cdItems" :key="it.id" class="cd-item">
              <view class="cd-main">
                <text class="cd-title ellipsis">{{ it.title }}</text>
                <text class="cd-date">{{ it.date }}</text>
              </view>
              <text class="cd-days" :class="{ soon: it.days <= 7 && it.days >= 0, past: it.days < 0 }">{{ it.label }}</text>
              <text class="cd-del" @click="removeCd(it.id)">删除</text>
            </view>
          </scroll-view>
        </template>

        <template v-else-if="panel === 'todo'">
          <view class="fd-sheet-head">
            <text class="fd-sheet-title">✅ 今日待办</text>
            <text class="fd-close" @click="closePanel">×</text>
          </view>
          <view class="cd-form">
            <input v-model="todoText" class="cd-input" placeholder="添加一条今日待办" maxlength="60" @confirm="submitTodo" />
            <button class="btn btn-primary cd-add" @click="submitTodo">添加</button>
          </view>
          <scroll-view scroll-y class="cd-list">
            <EmptyState v-if="!todos.list.length" icon="✅" text="还没有待办，先添加一条吧" />
            <view v-for="item in todos.list" :key="item.id" class="todo-item">
              <text class="todo-check" :class="{ done: item.done }" @click="toggleTodo(item.id)">{{ item.done ? '✓' : '' }}</text>
              <text class="todo-text" :class="{ done: item.done }" @click="toggleTodo(item.id)">{{ item.text }}</text>
              <text class="todo-del" @click="removeTodo(item.id)">删除</text>
            </view>
          </scroll-view>
        </template>

        <template v-else>
          <view class="fd-sheet-head">
            <text class="fd-sheet-title">📊 学习统计</text>
            <text class="fd-close" @click="closePanel">×</text>
          </view>
          <view class="stats-grid">
            <view class="stats-card"><text class="stats-num">{{ stats.today }}</text><text class="stats-label">今日分钟</text></view>
            <view class="stats-card"><text class="stats-num">{{ stats.week }}</text><text class="stats-label">近 7 天分钟</text></view>
            <view class="stats-card"><text class="stats-num">{{ stats.streak }}</text><text class="stats-label">连续天数</text></view>
          </view>
          <view class="stats-chart">
            <view v-for="day in stats.days" :key="day.key" class="stats-bar-item">
              <view class="stats-bar-track">
                <view class="stats-bar" :style="{ height: Math.max(4, day.minutes / maxDayMinutes * 100) + '%' }"></view>
              </view>
              <text class="stats-day">{{ day.label }}</text>
            </view>
          </view>
        </template>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed, onBeforeUnmount } from 'vue';
import { api } from '../utils/api.js';
import { isLoggedIn } from '../utils/auth.js';
import { ensureLogin, toast } from '../utils/guard.js';
import { countUnreadAnnouncements } from '../utils/announcements.js';
import EmptyState from './EmptyState.vue';
import {
  pomo, pomodoroToggle, pomodoroReset, setFocusMinutes, setBreakMinutes,
  formatClock, countdowns, addCountdown, removeCountdown, daysLeft, daysText,
  todos, addTodo, toggleTodo, removeTodo,
  todayFocusMinutes, weekFocusMinutes, streakDays, last7Days,
  dock, initDockPos, saveDockPos, dockBounds,
} from '../utils/studyTools.js';

initDockPos();

const open = ref(false);
const panel = ref(''); // gallery | pomodoro | countdown | todo | stats | ''
const unread = ref(0);
const dragging = ref(false);
const cdTitle = ref('');
const cdDate = ref('');
const todoText = ref('');
const focusPresets = [25, 45, 60];
const breakPresets = [5, 10, 15];

const anchorStyle = computed(() => ({ left: `${dock.x}px`, top: `${dock.y}px` }));
// 工具列表高度约 4×84rpx + 间距；上方空间不足时改到浮标下方
const spaceAbove = computed(() => dock.y > (dock.w / 7.5) * 4.6);
const leftMode = computed(() => dock.x < dock.w / 2);

let drag = null;
let touchHandled = false;
let touchTimer = null;

function onTouchStart(e) {
  const t = e.touches && e.touches[0];
  if (!t) return;
  drag = { sx: t.clientX, sy: t.clientY, ox: dock.x, oy: dock.y, moved: false };
}

function onTouchMove(e) {
  if (!drag) return;
  const t = e.touches && e.touches[0];
  if (!t) return;
  const dx = t.clientX - drag.sx;
  const dy = t.clientY - drag.sy;
  if (!drag.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
    drag.moved = true;
    dragging.value = true;
    open.value = false;
  }
  if (!drag.moved) return;
  const b = dockBounds();
  dock.x = Math.max(b.minX, Math.min(b.maxX, drag.ox + dx));
  dock.y = Math.max(b.minY, Math.min(b.maxY, drag.oy + dy));
}

function onTouchEnd() {
  if (!drag) return;
  const moved = drag.moved;
  const x = dock.x;
  const y = dock.y;
  drag = null;
  dragging.value = false;
  if (moved) saveDockPos(x, y);
  touchHandled = moved;
  clearTimeout(touchTimer);
  touchTimer = setTimeout(() => { touchHandled = false; }, 400);
}

function onFabClick() {
  if (touchHandled) {
    touchHandled = false;
    return;
  }
  toggle();
}

function onTouchCancel() {
  drag = null;
  dragging.value = false;
  touchHandled = true;
  clearTimeout(touchTimer);
  touchTimer = setTimeout(() => { touchHandled = false; }, 400);
}

onBeforeUnmount(() => clearTimeout(touchTimer));

const cdItems = computed(() => countdowns.list.map((it) => ({
  ...it,
  days: daysLeft(it.date),
  label: daysText(it.date),
})));
const stats = computed(() => ({
  today: todayFocusMinutes(),
  week: weekFocusMinutes(),
  streak: streakDays(),
  days: last7Days(),
}));
const maxDayMinutes = computed(() => Math.max(1, ...stats.value.days.map((item) => item.minutes)));

async function refreshUnread() {
  if (!isLoggedIn()) { unread.value = 0; return; }
  try {
    const [cnt, anns] = await Promise.all([
      api.unreadCount(),
      api.announcementList().catch(() => []),
    ]);
    unread.value = (cnt.total || 0) + countUnreadAnnouncements(anns);
  } catch { /* 静默 */ }
}

function toggle() {
  open.value = !open.value;
  if (open.value) refreshUnread();
}

function pick(key) {
  open.value = false;
  if (key === 'notes') {
    if (!ensureLogin('登录后查看学习笔记')) return;
    uni.navigateTo({ url: '/packagePlan/pages/notes/main' });
    return;
  }
  if (key === 'msg') {
    if (!ensureLogin('登录后查看消息')) return;
    uni.navigateTo({ url: '/packageSocial/pages/notifications/main' });
    return;
  }
  panel.value = key;
}

function closePanel() { panel.value = ''; }

function openGalleryTool(key) {
  if (key === 'ai') {
    panel.value = '';
    uni.navigateTo({ url: '/packageCompetition/pages/chat/main' });
    return;
  }
  panel.value = key;
}

function submitTodo() {
  if (!addTodo(todoText.value)) return toast('请填写待办内容');
  todoText.value = '';
  toast('待办已添加', 'success');
}

function chooseFocus(m) {
  if (pomo.running) return toast('请先暂停再切换时长');
  setFocusMinutes(m);
}
function chooseBreak(m) {
  if (pomo.running) return toast('请先暂停再切换时长');
  setBreakMinutes(m);
}

function onCdDate(e) { cdDate.value = e.detail.value; }
function addCd() {
  if (!cdTitle.value.trim()) return toast('请填写目标名称');
  if (!cdDate.value) return toast('请选择目标日期');
  addCountdown(cdTitle.value, cdDate.value);
  cdTitle.value = '';
  cdDate.value = '';
  toast('已添加倒数日', 'success');
}
function removeCd(id) { removeCountdown(id); }
</script>

<style lang="scss" scoped>
.fd-anchor {
  position: fixed;
  z-index: 900;
  width: 100rpx;
  height: 100rpx;
}
.fd-fab {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  background: rgba(15, 23, 42, 0.92);
  color: #fff;
  border: 1rpx solid rgba(255, 255, 255, 0.28);
  box-shadow: 0 10rpx 30rpx rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.2s;
}
.fd-fab.active { transform: rotate(45deg); }
.fd-fab.dragging { transform: scale(1.06); }
.fd-fab.active.dragging { transform: rotate(45deg) scale(1.06); }
.fd-fab-icon { font-size: 44rpx; }
.fd-fab-time { font-size: 22rpx; font-weight: 700; }
.fd-dot {
  position: absolute;
  top: 8rpx;
  right: 8rpx;
  width: 16rpx;
  height: 16rpx;
  border-radius: 50%;
  background: #ef4444;
  border: 2rpx solid #fff;
}

.fd-tools {
  position: absolute;
  right: 0;
  bottom: calc(100% + 16rpx);
  z-index: 901;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 18rpx;
}
.fd-tools.below { top: calc(100% + 16rpx); bottom: auto; }
.fd-tools.left { right: auto; left: 0; align-items: flex-start; }
.fd-tool { display: flex; align-items: center; gap: 14rpx; }
.fd-tools.left .fd-tool { flex-direction: row-reverse; }
.fd-name {
  background: rgba(15, 23, 42, 0.85);
  color: #fff;
  font-size: 22rpx;
  padding: 8rpx 20rpx;
  border-radius: 999rpx;
  white-space: nowrap;
}
.fd-icon {
  position: relative;
  width: 84rpx;
  height: 84rpx;
  border-radius: 50%;
  background: #fff;
  border: 1rpx solid #e2e8f0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 40rpx;
  box-shadow: 0 8rpx 24rpx rgba(15, 23, 42, 0.15);
}
.fd-unread {
  position: absolute;
  top: -4rpx;
  right: -4rpx;
  min-width: 28rpx;
  height: 28rpx;
  line-height: 28rpx;
  padding: 0 6rpx;
  border-radius: 999rpx;
  background: #ef4444;
  color: #fff;
  font-size: 16rpx;
  text-align: center;
  border: 2rpx solid #fff;
  box-sizing: border-box;
}

.fd-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: flex-end;
}
.fd-sheet {
  width: 100%;
  background: #fff;
  border-radius: 30rpx 30rpx 0 0;
  padding: 30rpx 30rpx calc(40rpx + env(safe-area-inset-bottom));
  max-height: 82vh;
  display: flex;
  flex-direction: column;
}
.fd-sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16rpx;
}
.fd-sheet-title { font-size: 32rpx; font-weight: 800; color: #1e293b; }
.fd-close { font-size: 30rpx; color: #94a3b8; padding: 8rpx 12rpx; }

.pomo-mode { text-align: center; font-size: 25rpx; color: #64748b; margin-top: 10rpx; }
.pomo-clock {
  text-align: center;
  font-size: 96rpx;
  font-weight: 800;
  color: #1e293b;
  letter-spacing: 0;
  line-height: 1.2;
  margin: 8rpx 0;
}
.pomo-tip { text-align: center; font-size: 23rpx; color: #94a3b8; margin-bottom: 24rpx; }
.pomo-actions { display: flex; gap: 18rpx; }
.pomo-btn { flex: 1; height: 82rpx; font-size: 28rpx; }
.preset-row { display: flex; align-items: center; gap: 14rpx; margin-top: 20rpx; }
.preset-label { font-size: 24rpx; color: #64748b; width: 60rpx; }
.preset-chip {
  background: #f1f5f9;
  color: #475569;
  font-size: 23rpx;
  padding: 10rpx 20rpx;
  border-radius: 999rpx;
}
.preset-chip.on { background: #eff6ff; color: #2563eb; font-weight: 700; }
.pomo-foot { font-size: 21rpx; color: #94a3b8; margin-top: 24rpx; line-height: 1.6; }

.tool-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16rpx;
}
.tool-card {
  min-height: 170rpx;
  padding: 22rpx;
  border: 1rpx solid #e2e8f0;
  border-radius: 18rpx;
  background: #f8fafc;
  display: flex;
  flex-direction: column;
  gap: 8rpx;
}
.tool-card-icon { font-size: 42rpx; }
.tool-card-name { color: #1e293b; font-size: 28rpx; font-weight: 800; }
.tool-card-desc { color: #64748b; font-size: 22rpx; }
.tool-card-wide { grid-column: 1 / -1; min-height: 120rpx; }

.cd-form { display: flex; align-items: center; gap: 12rpx; margin-bottom: 18rpx; }
.cd-input {
  flex: 1;
  min-width: 0;
  height: 76rpx;
  background: #f8fafc;
  border: 1rpx solid #e2e8f0;
  border-radius: 12rpx;
  padding: 0 18rpx;
  font-size: 25rpx;
}
.cd-date-btn {
  height: 76rpx;
  line-height: 76rpx;
  padding: 0 18rpx;
  background: #f8fafc;
  border: 1rpx solid #e2e8f0;
  border-radius: 12rpx;
  font-size: 24rpx;
  color: #2563eb;
  white-space: nowrap;
}
.cd-add { height: 76rpx; padding: 0 24rpx; font-size: 25rpx; flex: none; }
.cd-list { max-height: 46vh; }
.cd-item {
  display: flex;
  align-items: center;
  gap: 16rpx;
  padding: 20rpx 0;
  border-bottom: 1rpx solid #f1f5f9;
}
.cd-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4rpx; }
.cd-title { font-size: 27rpx; font-weight: 700; color: #1e293b; }
.cd-date { font-size: 21rpx; color: #94a3b8; }
.cd-days { font-size: 26rpx; font-weight: 800; color: #2563eb; white-space: nowrap; }
.cd-days.soon { color: #b45309; }
.cd-days.past { color: #94a3b8; font-weight: 600; }
.cd-del { font-size: 22rpx; color: #ef4444; padding: 8rpx 4rpx; white-space: nowrap; }

.todo-item {
  display: flex;
  align-items: center;
  gap: 14rpx;
  padding: 20rpx 0;
  border-bottom: 1rpx solid #f1f5f9;
}
.todo-check {
  width: 38rpx;
  height: 38rpx;
  flex-shrink: 0;
  border: 2rpx solid #cbd5e1;
  border-radius: 10rpx;
  color: #fff;
  font-size: 25rpx;
  line-height: 36rpx;
  text-align: center;
}
.todo-check.done { background: #16a34a; border-color: #16a34a; }
.todo-text { flex: 1; min-width: 0; color: #334155; font-size: 26rpx; }
.todo-text.done { color: #94a3b8; text-decoration: line-through; }
.todo-del { color: #ef4444; font-size: 22rpx; padding: 8rpx 4rpx; }

.stats-grid { display: flex; gap: 12rpx; margin-bottom: 24rpx; }
.stats-card {
  flex: 1;
  padding: 18rpx 10rpx;
  border-radius: 16rpx;
  background: #eff6ff;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6rpx;
}
.stats-num { color: #2563eb; font-size: 38rpx; font-weight: 800; }
.stats-label { color: #64748b; font-size: 20rpx; }
.stats-chart { height: 270rpx; display: flex; align-items: flex-end; gap: 12rpx; padding: 10rpx 4rpx 0; }
.stats-bar-item { flex: 1; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 8rpx; }
.stats-bar-track { width: 100%; height: 210rpx; border-radius: 10rpx; background: #f1f5f9; display: flex; align-items: flex-end; overflow: hidden; }
.stats-bar { width: 100%; min-height: 4rpx; border-radius: 10rpx; background: linear-gradient(180deg, #60a5fa, #2563eb); }
.stats-day { color: #94a3b8; font-size: 18rpx; }
</style>
