<script setup>
// 工具 Dock（苹果悬浮窗式）：单个 🧰 主浮标，点击展开 日程笔记 / AI 对话 / 消息中心 三个工具
// 消息中心未读红点：dock 收起时在主浮标右上角，展开后转移到消息中心工具按钮右上角
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api.js';
import auth from '../auth.js';
import ScheduleNotes from './ScheduleNotes.vue';
import AIChatBox from './AIChatBox.vue';
import MessageCenter from './MessageCenter.vue';

const dockOpen = ref(false);   // 工具列表展开/收起
const activeTool = ref(null);  // 当前打开的面板：'notes' | 'ai' | 'msg' | null（单值天然互斥）
const unread = ref(0);         // 消息中心未读总数
const schedules = ref([]);     // 日程笔记「关联备赛」选择数据源

let unreadTimer = null;

async function refreshUnread() {
  if (!auth.user?.id) return;
  try {
    unread.value = (await api.notificationsUnread()).total || 0;
  } catch { /* 静默 */ }
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

// 日程笔记「关联备赛」数据（原 ScheduleView 传入，提升全局后自拉）
async function loadSchedules() {
  try { schedules.value = await api.scheduleList(); } catch { /* 未登录/失败 → 空 */ }
}

onMounted(() => {
  refreshUnread();
  unreadTimer = setInterval(refreshUnread, 15000); // 后台常驻轮询红点
  loadSchedules();
});
onBeforeUnmount(() => clearInterval(unreadTimer));
</script>

<template>
  <!-- 主浮标：未展开时红点在此 -->
  <button class="dock-fab" :class="{ active: dockOpen }" :title="dockOpen ? '收起工具' : '展开工具'" @click="toggleDock">🧰
    <span v-if="!dockOpen && unread > 0" class="dock-badge">{{ unread > 99 ? '99+' : unread }}</span>
  </button>

  <!-- 展开的工具列表：红点转移到消息中心按钮 -->
  <transition name="dock">
    <div v-if="dockOpen" class="dock-tools">
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
    </div>
  </transition>

  <!-- 三个工具面板（activeTool 唯一值控制，天然互斥） -->
  <ScheduleNotes :open="activeTool === 'notes'" :schedules="schedules" @close="onClosePanel" />
  <AIChatBox :open="activeTool === 'ai'" @close="onClosePanel" />
  <MessageCenter :open="activeTool === 'msg'" @close="onClosePanel" />
</template>

<style lang="scss" scoped>
// 主浮标：苹果悬浮球风——深色半透明 + 白边 + 阴影
.dock-fab {
  position: fixed; right: 22px; bottom: 22px; z-index: 1000;
  width: 56px; height: 56px; border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, .28); cursor: pointer; font-size: 26px;
  background: rgba(15, 23, 42, .92); color: #fff;
  box-shadow: 0 6px 20px rgba(0, 0, 0, .35);
  transition: transform .2s;
  &:hover { transform: scale(1.06); }
  &.active { transform: rotate(45deg); }
}

.dock-badge {
  position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px;
  padding: 0 4px; border-radius: 999px; background: #ef4444; color: #fff;
  font-size: 11px; line-height: 18px; text-align: center;
  border: 2px solid #fff; box-sizing: border-box;
}

// 工具列表：主浮标正上方纵向堆叠，按钮左侧带名称标签
.dock-tools {
  position: fixed; right: 22px; bottom: 86px; z-index: 1000;
  display: flex; flex-direction: column; gap: 10px; align-items: flex-end;
}
.dock-tool {
  position: relative; width: 48px; height: 48px; border-radius: 50%;
  border: 1px solid var(--border); cursor: pointer; font-size: 22px;
  background: #fff; color: #333;
  box-shadow: 0 4px 14px rgba(0, 0, 0, .18);
  transition: transform .15s;
  &:hover { transform: scale(1.1); }
  &.on { background: #eff6ff; border-color: #2563eb; }
  .tool-name {
    position: absolute; right: 56px; top: 50%; transform: translateY(-50%);
    background: rgba(15, 23, 42, .85); color: #fff;
    font-size: 12px; padding: 4px 10px; border-radius: 999px; white-space: nowrap;
    pointer-events: none;
  }
}

.dock-enter-active, .dock-leave-active { transition: all .2s ease; }
.dock-enter-from, .dock-leave-to { opacity: 0; transform: translateY(10px) scale(.9); }
</style>
