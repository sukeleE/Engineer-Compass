<script setup>
// 公共私聊弹窗（从 MyView 抽取，MyView 好友私聊 / GhostUsers 怪奇小队共用）
// 打开时 3s 轮询拉新消息（GET 顺带把对方发来的标已读），关闭即停；@refresh 通知父组件刷新未读徽标
import { ref, computed, watch, nextTick, onUnmounted } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api.js';
import auth from '../auth.js';

const props = defineProps({
  open: { type: Boolean, default: false },
  user: { type: Object, default: null }, // { id, nickname, avatar }
});
const emit = defineEmits(['close', 'refresh']);

// el-dialog 关闭（X/遮罩）→ emit close；外部 v-model 由父组件控制
const show = computed({
  get: () => props.open,
  set: (v) => { if (!v) emit('close'); },
});

const dmMsgs = ref([]);
const dmText = ref('');
const dmSending = ref(false);
const dmListEl = ref(null);
let dmTimer = null;

async function loadDm() {
  if (!props.user) return;
  try {
    dmMsgs.value = await api.dmList(props.user.id);
    emit('refresh'); // 顺带刷新父组件未读徽标（原 MyView loadFriends）
    nextTick(scrollDm);
  } catch (e) { ElMessage.error(e.message); }
}
function scrollDm() {
  const el = dmListEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}
async function sendDm() {
  const content = dmText.value.trim();
  if (!content) return ElMessage.warning('输入私信内容');
  if (!props.user) return;
  dmSending.value = true;
  try {
    await api.dmSend(props.user.id, content);
    dmText.value = '';
    await loadDm();
  } catch (e) { ElMessage.error(e.message); }
  finally { dmSending.value = false; }
}

// 弹窗开关 → 轮询启停
watch(() => props.open, (open) => {
  if (dmTimer) { clearInterval(dmTimer); dmTimer = null; }
  if (open) { loadDm(); dmTimer = setInterval(loadDm, 3000); }
});
onUnmounted(() => { if (dmTimer) clearInterval(dmTimer); });
</script>

<template>
  <!-- 私聊弹窗（轮询拉新，关闭即停；destroy-on-close 保证每次打开全新状态） -->
  <el-dialog v-model="show" :title="props.user ? `💬 私聊 · ${props.user.nickname}` : '私聊'" width="480px" top="6vh"
    destroy-on-close append-to-body>
    <div ref="dmListEl" class="dm-list">
      <div v-for="m in dmMsgs" :key="m.id" :class="['dm-bubble', Number(m.from_id) === Number(auth.user?.id) ? 'mine' : 'other']">
        <div class="dm-text">{{ m.content }}</div>
        <div class="dm-time">{{ m.create_time?.slice(5, 16) }}</div>
      </div>
      <el-empty v-if="!dmMsgs.length" description="还没有消息，说点什么吧" :image-size="50" />
    </div>
    <div class="dm-input">
      <el-input v-model="dmText" maxlength="2000" show-word-limit placeholder="输入私信，Enter 发送" @keyup.enter="sendDm" />
      <el-button type="primary" :loading="dmSending" @click="sendDm">发送</el-button>
    </div>
  </el-dialog>
</template>

<style lang="scss" scoped>
// —— 私聊弹窗 ——
.dm-list {
  height: 380px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px;
  padding: 6px 2px; margin-bottom: 12px;
}
.dm-bubble {
  max-width: 74%; padding: 8px 12px; border-radius: 12px; font-size: 13.5px; line-height: 1.7;
  overflow-wrap: anywhere; position: relative;
  .dm-time { font-size: 10.5px; opacity: .7; margin-top: 3px; }
  &.mine { align-self: flex-end; background: var(--primary); color: #fff; border-bottom-right-radius: 4px; }
  &.other { align-self: flex-start; background: var(--surface-2); border: 1px solid var(--border); border-bottom-left-radius: 4px; }
}
.dm-input { display: flex; gap: 8px; .el-input { flex: 1; } }
</style>
