<template>
  <view class="chat-page">
    <scroll-view class="msg-list" scroll-y :scroll-into-view="anchor" :scroll-with-animation="true">
      <view id="msg-top" class="welcome card">
        <view class="welcome-title">🤖 AI 竞赛助手</view>
        <view class="welcome-text">
          当前可结合【{{ compName || '工科竞赛' }}】的赛制、时间与技术栈回答问题。
          可问：比赛难度、需要什么硬件、组队建议、备赛资料、时间冲突怎么安排。
        </view>
      </view>

      <view v-for="(m, i) in messages" :key="i" :id="`msg-${i}`" class="msg-row" :class="m.role">
        <view class="bubble">{{ m.content }}</view>
      </view>

      <view v-if="sending" class="msg-row assistant">
        <view class="bubble typing">正在思考中…（若问题复杂可能需要等待约 1 分钟）</view>
      </view>
      <view id="msg-bottom" style="height: 20rpx"></view>
    </scroll-view>

    <view class="input-bar">
      <input
        v-model="draft"
        class="msg-input"
        placeholder="输入你的问题…"
        confirm-type="send"
        :disabled="sending"
        @confirm="send"
      />
      <button class="btn btn-primary send-btn" :disabled="sending || !draft.trim()" @click="send">发送</button>
    </view>
  </view>
</template>

<script setup>
import { ref, nextTick } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';

const compId = ref(null);
const compName = ref('');
const draft = ref('');
const sending = ref(false);
const anchor = ref('');
const messages = ref([]);

async function send() {
  const question = draft.value.trim();
  if (!question || sending.value) return;
  messages.value.push({ role: 'user', content: question });
  draft.value = '';
  sending.value = true;
  await scrollBottom();
  try {
    const res = await api.aiChat(question, compId.value, compName.value);
    messages.value.push({ role: 'assistant', content: res.answer || '（未返回有效内容）' });
  } catch (e) {
    messages.value.push({ role: 'assistant', content: `⚠️ ${e.message || '回答失败，请稍后重试'}` });
  } finally {
    sending.value = false;
    await scrollBottom();
  }
}

async function scrollBottom() {
  await nextTick();
  anchor.value = `msg-${messages.value.length - 1}`;
  await nextTick();
  anchor.value = 'msg-bottom';
}

onLoad((options) => {
  compId.value = options.id ? Number(options.id) : null;
  compName.value = options.name ? decodeURIComponent(options.name) : '';
});
</script>

<style lang="scss" scoped>
.chat-page { display: flex; flex-direction: column; height: 100vh; background: #f8fafc; }
.msg-list { flex: 1; height: 0; padding: 24rpx; box-sizing: border-box; }
.welcome { margin-bottom: 24rpx; }
.welcome-title { font-size: 30rpx; font-weight: 700; color: #1e293b; margin-bottom: 10rpx; }
.welcome-text { font-size: 25rpx; color: #64748b; line-height: 1.7; }

.msg-row { display: flex; margin-bottom: 22rpx; }
.msg-row.user { justify-content: flex-end; }
.bubble {
  max-width: 78%;
  padding: 20rpx 24rpx;
  border-radius: 20rpx;
  font-size: 27rpx;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}
.msg-row.assistant .bubble { background: #fff; border: 1rpx solid #e2e8f0; color: #1e293b; border-top-left-radius: 6rpx; }
.msg-row.user .bubble { background: #2563eb; color: #fff; border-top-right-radius: 6rpx; }
.typing { color: #94a3b8; }

.input-bar {
  display: flex;
  align-items: center;
  gap: 16rpx;
  padding: 16rpx 24rpx calc(16rpx + env(safe-area-inset-bottom));
  background: #fff;
  border-top: 1rpx solid #e2e8f0;
}
.msg-input {
  flex: 1;
  height: 76rpx;
  background: #f1f5f9;
  border-radius: 38rpx;
  padding: 0 28rpx;
  font-size: 27rpx;
}
.send-btn { width: 150rpx; height: 76rpx; font-size: 27rpx; padding: 0; }
</style>