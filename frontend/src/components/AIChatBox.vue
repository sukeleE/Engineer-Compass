<script setup>
// 全局 AI 对话悬浮框（右下角）：上下文感知当前查看的竞赛
import { ref, watch, nextTick } from 'vue';
import { store } from '../store.js';
import { api } from '../api.js';

const open = ref(false);
const messages = ref(JSON.parse(localStorage.getItem('ec_chat_history') || '[]'));
const input = ref('');
const sending = ref(false);
const listRef = ref(null);

watch(messages, (v) => {
  localStorage.setItem('ec_chat_history', JSON.stringify(v.slice(-50)));
}, { deep: true });

watch(open, async () => { await nextTick(); scrollBottom(); });

function scrollBottom() {
  listRef.value?.scrollTo({ top: listRef.value.scrollHeight, behavior: 'smooth' });
}

async function send() {
  const q = input.value.trim();
  if (!q || sending.value) return;
  messages.value.push({ role: 'user', text: q });
  input.value = '';
  sending.value = true;
  try {
    const res = await api.chat(q, store.currentCompId || undefined);
    messages.value.push({ role: 'assistant', text: res.answer });
  } catch (e) {
    messages.value.push({
      role: 'assistant',
      text: `⚠️ ${e.message}\n（后端 .env 配置 DEEPSEEK_API_KEY 后即可使用 AI 问答）`,
    });
  } finally {
    sending.value = false;
    await nextTick();
    scrollBottom();
  }
}

function clearHistory() {
  messages.value = [];
  localStorage.removeItem('ec_chat_history');
}
</script>

<template>
  <!-- 悬浮按钮 -->
  <button class="fab" :class="{ active: open }" @click="open = !open">💬</button>

  <!-- 聊天面板 -->
  <transition name="chat">
    <div v-if="open" class="chat-panel">
      <div class="chat-head">
        <b>🤖 竞赛助手</b>
        <div class="chat-ctx">
          {{ store.currentCompName ? `当前查看：${store.currentCompName}` : '未打开竞赛（可问通用问题）' }}
        </div>
        <div class="chat-actions">
          <el-button link size="small" @click="clearHistory">清空</el-button>
          <el-button link size="small" @click="open = false">收起</el-button>
        </div>
      </div>
      <div ref="listRef" class="chat-list">
        <div v-if="!messages.length" class="chat-empty">
          可以问我：<br />
          · 电赛需要学哪些模块？<br />
          · 智能车和数模同时报会冲突吗？<br />
          · 帮我写一份 3 个月备赛计划
        </div>
        <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
          <div class="bubble">{{ m.text }}</div>
        </div>
        <div v-if="sending" class="msg assistant"><div class="bubble typing">思考中…</div></div>
      </div>
      <div class="chat-input">
        <el-input
          v-model="input" placeholder="输入问题，Enter 发送"
          @keyup.enter="send" :disabled="sending"
        />
        <el-button type="primary" :loading="sending" @click="send">发送</el-button>
      </div>
    </div>
  </transition>
</template>

<style lang="scss" scoped>
.fab {
  position: fixed; right: 22px; bottom: 22px; z-index: 1000;
  width: 52px; height: 52px; border-radius: 50%; border: none; cursor: pointer;
  font-size: 24px; background: #2563eb; color: #fff;
  box-shadow: 0 6px 18px rgba(37, 99, 235, .45);
  transition: transform .2s;
  &:hover { transform: scale(1.08); }
  &.active { transform: rotate(45deg); }
}

.chat-panel {
  position: fixed; right: 22px; bottom: 86px; z-index: 1000;
  width: 420px; height: 640px; max-height: calc(100vh - 120px); background: #fff; border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, .2); border: 1px solid var(--border);
  display: flex; flex-direction: column; overflow: hidden;
  // 移动端：面板铺满视口（去掉边距防止键盘弹起遮挡）
  @media (max-width: 768px) {
    right: 0; bottom: 0; width: 100vw; height: 100vh; max-height: 100vh; border-radius: 0;
  }
}

.chat-head {
  padding: 12px 16px; background: #2563eb; color: #fff;
  b { font-size: 15px; }
  .chat-ctx { font-size: 12.5px; opacity: .85; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chat-actions { position: absolute; top: 8px; right: 8px; :deep(.el-button) { color: #dbeafe; } }
}

.chat-list { flex: 1; overflow-y: auto; padding: 14px; background: #f8fafc; }
.chat-empty { color: #94a3b8; font-size: 13px; line-height: 1.9; padding: 24px 10px; text-align: center; }

.msg { display: flex; margin-bottom: 12px;
  &.user { justify-content: flex-end; }
  .bubble {
    max-width: 84%; padding: 10px 14px; border-radius: 10px; font-size: 14px; line-height: 1.7;
    white-space: pre-wrap; word-break: break-word;
  }
  &.user .bubble { background: #2563eb; color: #fff; border-bottom-right-radius: 2px; }
  &.assistant .bubble { background: #fff; border: 1px solid var(--border); border-bottom-left-radius: 2px; }
  &.assistant .typing { color: #94a3b8; }
}

.chat-input { display: flex; gap: 10px; padding: 12px 14px; border-top: 1px solid var(--border); }

.chat-enter-active, .chat-leave-active { transition: all .25s ease; }
.chat-enter-from, .chat-leave-to { opacity: 0; transform: translateY(16px) scale(.96); }
</style>
