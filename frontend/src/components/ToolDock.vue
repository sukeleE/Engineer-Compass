<script setup>
// 工具 Dock（苹果悬浮窗式）：🧰 → 一级菜单 → 工具库（分类）→ 具体工具面板
// 一级菜单保留现有 日程笔记 / AI 对话 / 消息中心；「工具」进入学习工具库
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api.js';
import auth from '../auth.js';
import { pomo, formatClock, setPomodoroCompleteHandler } from '../utils/studyTools.js';
import { notificationState, refreshUnread, startNotificationRealtime, stopNotificationRealtime } from '../utils/notificationStore.js';
import ScheduleNotes from './ScheduleNotes.vue';
import AIChatBox from './AIChatBox.vue';
import MessageCenter from './MessageCenter.vue';
import GhostUsers from './GhostUsers.vue'; // 怪奇小队（仅幽灵用户可见）
import ToolGallery from './tools/ToolGallery.vue';
import PomodoroPanel from './tools/PomodoroPanel.vue';
import CountdownPanel from './tools/CountdownPanel.vue';
import TodoPanel from './tools/TodoPanel.vue';
import StatsPanel from './tools/StatsPanel.vue';

const dockOpen = ref(false);   // 工具列表展开/收起
const activeTool = ref(null);  // gallery | pomodoro | countdown | todo | stats | notes | ai | msg | ghost
const unread = computed(() => notificationState.counts.total); // 消息中心未读总数（全局共享）
const schedules = ref([]);     // 日程笔记「关联备赛」选择数据源

const DOCK_SIZE = 56;
const DOCK_MARGIN = 10;
const DOCK_STORAGE = 'ec_web_dock_pos';
const PANEL_W = 420;
const PANEL_H = 640;
const PANEL_GAP = 12;

const viewport = reactive({
  w: typeof window !== 'undefined' ? window.innerWidth : 1280,
  h: typeof window !== 'undefined' ? window.innerHeight : 900,
});
const dockPos = reactive({ x: 0, y: 0 });
const isMobile = computed(() => viewport.w <= 768);
const anchorStyle = computed(() => ({ left: `${dockPos.x}px`, top: `${dockPos.y}px` }));
const dockLeftMode = computed(() => dockPos.x + DOCK_SIZE / 2 < viewport.w / 2);
const dockToolsBelow = computed(() => dockPos.y < 330);
// 工具面板贴着悬浮球：右半屏向左展开，左半屏向右展开；垂直方向尽量与球底对齐
const panelStyle = computed(() => {
  if (isMobile.value) return {};
  let left = dockPos.x + DOCK_SIZE + PANEL_GAP;
  if (!dockLeftMode.value) left = dockPos.x - PANEL_W - PANEL_GAP;
  left = Math.max(12, Math.min(left, viewport.w - PANEL_W - 12));
  let top = dockPos.y + DOCK_SIZE - PANEL_H;
  const maxTop = Math.max(12, viewport.h - PANEL_H - 12);
  top = Math.max(12, Math.min(top, maxTop));
  return { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' };
});

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function initDockPos() {
  viewport.w = window.innerWidth;
  viewport.h = window.innerHeight;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(DOCK_STORAGE) || 'null'); } catch { saved = null; }
  const defaultY = viewport.h - DOCK_SIZE - (viewport.w <= 768 ? 84 : 22);
  dockPos.x = clamp(Number(saved?.x ?? viewport.w - DOCK_SIZE - 24), DOCK_MARGIN, viewport.w - DOCK_SIZE - DOCK_MARGIN);
  dockPos.y = clamp(Number(saved?.y ?? defaultY), DOCK_MARGIN, viewport.h - DOCK_SIZE - DOCK_MARGIN);
}

function saveDockPos() {
  try { localStorage.setItem(DOCK_STORAGE, JSON.stringify({ x: dockPos.x, y: dockPos.y })); } catch { /* 忽略 */ }
}

function onResize() {
  viewport.w = window.innerWidth;
  viewport.h = window.innerHeight;
  dockPos.x = clamp(dockPos.x, DOCK_MARGIN, viewport.w - DOCK_SIZE - DOCK_MARGIN);
  dockPos.y = clamp(dockPos.y, DOCK_MARGIN, viewport.h - DOCK_SIZE - DOCK_MARGIN);
}

let drag = null;
let suppressClick = false;
let suppressTimer = null;

function onPointerDown(e) {
  if (e.button !== undefined && e.button !== 0) return;
  drag = { sx: e.clientX, sy: e.clientY, ox: dockPos.x, oy: dockPos.y, moved: false, id: e.pointerId };
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
}

function onPointerMove(e) {
  if (!drag) return;
  const dx = e.clientX - drag.sx;
  const dy = e.clientY - drag.sy;
  if (!drag.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
    drag.moved = true;
    dockOpen.value = false;
    activeTool.value = null;
    document.body.style.userSelect = 'none';
  }
  if (!drag.moved) return;
  dockPos.x = clamp(drag.ox + dx, DOCK_MARGIN, viewport.w - DOCK_SIZE - DOCK_MARGIN);
  dockPos.y = clamp(drag.oy + dy, DOCK_MARGIN, viewport.h - DOCK_SIZE - DOCK_MARGIN);
}

function onPointerUp(e) {
  if (!drag) return;
  const moved = drag.moved;
  drag = null;
  document.body.style.userSelect = '';
  try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch { /* 忽略 */ }
  if (moved) {
    saveDockPos();
    suppressClick = true;
    clearTimeout(suppressTimer);
    suppressTimer = setTimeout(() => { suppressClick = false; }, 350);
  }
}

function onPointerCancel() {
  drag = null;
  document.body.style.userSelect = '';
}

function onFabClick() {
  if (suppressClick) return;
  toggleDock();
}

function toggleDock() {
  dockOpen.value = !dockOpen.value;
  if (dockOpen.value) { activeTool.value = null; refreshUnread(); } // 展开工具时收起面板
}

function pick(t) {
  if (t === 'msg' && !auth.user?.id) { ElMessage.info('请先登录后再查看消息'); return; }
  activeTool.value = activeTool.value === t ? null : t; // 再点同一工具 = 关闭面板
  dockOpen.value = false;
}

function onClosePanel() { activeTool.value = null; }

function onPomodoroComplete({ wasFocus } = {}) {
  ElMessage.success(wasFocus ? '🍅 专注完成，休息一下' : '☕ 休息结束，继续专注');
}

function onKeydown(e) {
  if (e.key !== 'Escape') return;
  if (activeTool.value) activeTool.value = null;
  else if (dockOpen.value) dockOpen.value = false;
}

// 日程笔记「关联备赛」数据（原 ScheduleView 传入，提升全局后自拉）
// 2026-09-05 收紧：备赛日程登录私有（后端 authRequired），未登录不再请求
async function loadSchedules() {
  if (!auth.token) return;
  try { schedules.value = await api.scheduleList(); } catch { /* 失败 → 空 */ }
}

onMounted(() => {
  initDockPos();
  setPomodoroCompleteHandler(onPomodoroComplete);
  startNotificationRealtime();
  loadSchedules();
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', onResize);
});
onBeforeUnmount(() => {
  stopNotificationRealtime();
  clearTimeout(suppressTimer);
  setPomodoroCompleteHandler(null);
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('resize', onResize);
});
</script>

<template>
  <div class="dock-anchor" :style="anchorStyle">
    <!-- 展开的工具列表：贴着浮标方向展开 -->
    <transition name="dock">
      <div v-if="dockOpen" class="dock-tools" :class="{ left: dockLeftMode, below: dockToolsBelow }">
        <button class="dock-tool tool-home" :class="{ on: activeTool === 'gallery' }" title="学习工具" @click="pick('gallery')">
          🧰<span class="tool-name">工具</span>
        </button>
        <button class="dock-tool" :class="{ on: activeTool === 'notes' }" title="日程笔记" @click="pick('notes')">
          📝<span class="tool-name">日程笔记</span>
        </button>
        <button class="dock-tool" :class="{ on: activeTool === 'ai' }" title="AI 对话" @click="pick('ai')">
          💬<span class="tool-name">AI 对话</span>
        </button>
        <button class="dock-tool" :class="{ on: activeTool === 'msg' }" title="消息中心" @click="pick('msg')">
          🔔<span class="tool-name">消息中心</span>
          <span v-if="unread > 0" class="dock-badge">{{ unread > 99 ? '99+' : unread }}</span>
        </button>
        <button v-if="auth.user?.is_ghost" class="dock-tool" :class="{ on: activeTool === 'ghost' }" title="怪奇小队" @click="pick('ghost')">
          👻<span class="tool-name">怪奇小队</span>
        </button>
      </div>
    </transition>

    <!-- 主浮标：可拖动；番茄钟运行时直接显示剩余时间 -->
    <button class="dock-fab" :class="{ active: dockOpen, timer: pomo.running && !dockOpen }"
      :title="dockOpen ? '收起工具' : '展开工具（可拖动）'" :aria-expanded="dockOpen"
      @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp"
      @pointercancel="onPointerCancel" @click="onFabClick">
      <span v-if="pomo.running && !dockOpen" class="fab-time">{{ formatClock(pomo.remaining) }}</span>
      <span v-else>🧰</span>
      <span v-if="!dockOpen && unread > 0" class="dock-badge">{{ unread > 99 ? '99+' : unread }}</span>
    </button>
  </div>

  <!-- 工具面板（activeTool 唯一值控制，天然互斥） -->
  <ToolGallery :open="activeTool === 'gallery'" :unread="unread" :panel-style="panelStyle" @close="onClosePanel" @pick="pick" />
  <PomodoroPanel :open="activeTool === 'pomodoro'" :panel-style="panelStyle" @close="onClosePanel" />
  <CountdownPanel :open="activeTool === 'countdown'" :panel-style="panelStyle" @close="onClosePanel" />
  <TodoPanel :open="activeTool === 'todo'" :panel-style="panelStyle" @close="onClosePanel" />
  <StatsPanel :open="activeTool === 'stats'" :panel-style="panelStyle" @close="onClosePanel" />
  <ScheduleNotes :open="activeTool === 'notes'" :schedules="schedules" :panel-style="panelStyle" @close="onClosePanel" />
  <AIChatBox :open="activeTool === 'ai'" :panel-style="panelStyle" @close="onClosePanel" />
  <MessageCenter :open="activeTool === 'msg'" :panel-style="panelStyle" @close="onClosePanel" />
  <GhostUsers :open="activeTool === 'ghost'" :panel-style="panelStyle" @close="onClosePanel" />
</template>

<style lang="scss" scoped>
.dock-anchor {
  position: fixed; z-index: 1000; width: 56px; height: 56px;
}
// 主浮标：苹果悬浮球风——深色半透明 + 白边 + 阴影
.dock-fab {
  position: absolute; inset: 0; z-index: 1;
  width: 56px; height: 56px; border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, .28); cursor: pointer; font-size: 26px;
  background: rgba(15, 23, 42, .92); color: #fff;
  box-shadow: 0 6px 20px rgba(0, 0, 0, .35);
  transition: transform .2s;
  touch-action: none; user-select: none;
  &:hover { transform: scale(1.06); }
  &.active { transform: rotate(45deg); }
  &.timer { font-size: 11px; font-weight: 700; }
}
.fab-time { font-size: 11px; font-weight: 700; letter-spacing: 0; }

.dock-badge {
  position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px;
  padding: 0 4px; border-radius: 999px; background: #ef4444; color: #fff;
  font-size: 11px; line-height: 18px; text-align: center;
  border: 2px solid #fff; box-sizing: border-box;
}

// 工具列表：主浮标正上方纵向堆叠，按钮左侧带名称标签
.dock-tools {
  position: absolute; right: 0; bottom: calc(100% + 10px); z-index: 2;
  display: flex; flex-direction: column; gap: 10px; align-items: flex-end;
}
.dock-tools.below { top: calc(100% + 10px); bottom: auto; }
.dock-tools.left { right: auto; left: 0; align-items: flex-start; }

.dock-tool {
  position: relative; width: 48px; height: 48px; border-radius: 50%;
  border: 1px solid var(--border); cursor: pointer; font-size: 22px;
  background: var(--card-bg); color: var(--text);
  box-shadow: 0 4px 14px rgba(0, 0, 0, .18);
  transition: transform .15s;
  &:hover { transform: scale(1.1); }
  &.on { background: var(--primary-tint); border-color: var(--primary); }
  &.tool-home { background: var(--primary-tint); border-color: color-mix(in srgb, var(--primary) 45%, transparent); }
  .tool-name {
    position: absolute; right: 56px; top: 50%; transform: translateY(-50%);
    background: rgba(15, 23, 42, .85); color: #fff;
    font-size: 12px; padding: 4px 10px; border-radius: 999px; white-space: nowrap;
    pointer-events: none;
  }
}
.dock-tools.left .dock-tool .tool-name { right: auto; left: 56px; }

.dock-enter-active, .dock-leave-active { transition: all .2s ease; }
.dock-enter-from, .dock-leave-to { opacity: 0; transform: translateY(10px) scale(.9); }
</style>
