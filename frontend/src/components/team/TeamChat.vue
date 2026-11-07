<script setup>
// 小组讨论入口：桌面双栏（群列表 + 聊天窗），移动端堆叠切换
import { ref } from 'vue';
import ChatGroupList from './ChatGroupList.vue';
import ChatRoom from './ChatRoom.vue';

const props = defineProps({ teamId: Number, me: Object, perms: Object, members: Array });
const current = ref(null);
const mobileRoom = ref(false);

function openGroup(g) {
  current.value = g;
  mobileRoom.value = true;
}
function back() {
  mobileRoom.value = false;
  current.value = null;
}
</script>

<template>
  <div class="chat-shell" :class="{ 'room-on': mobileRoom }">
    <section class="pane pane-list">
      <ChatGroupList :team-id="teamId" :members="members" :me="me" @open="openGroup" />
    </section>
    <section class="pane pane-room">
      <ChatRoom
        v-if="current"
        :key="current.id"
        :group="current"
        :team-id="teamId"
        :members="members"
        :me="me"
        @back="back"
        @changed="() => {}"
      />
      <div v-else class="room-placeholder">
        <div class="ph-icon">💬</div>
        <div>选择左侧群聊开始对话</div>
      </div>
    </section>
  </div>
</template>

<style lang="scss" scoped>
.chat-shell { display: flex; gap: 14px; align-items: stretch; min-height: 560px; }
.pane-list { width: 300px; flex: none; }
.pane-room { flex: 1; min-width: 0; display: flex; }
.pane-room > * { flex: 1; min-width: 0; }
.room-placeholder {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; color: #94a3b8; font-size: 13.5px;
  border: 1px dashed var(--border); border-radius: 12px; background: var(--surface-2);
  .ph-icon { font-size: 40px; }
}
@media (max-width: 768px) {
  .chat-shell { flex-direction: column; min-height: 0; }
  .pane-list { width: 100%; }
  .pane-room { display: none; }
  .chat-shell.room-on .pane-list { display: none; }
  .chat-shell.room-on .pane-room { display: flex; }
}
</style>