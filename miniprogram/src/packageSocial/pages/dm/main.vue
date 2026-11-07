<template>
  <view class="dm-page">
    <scroll-view scroll-y class="msg-scroll" :scroll-into-view="anchor" :scroll-with-animation="true">
      <EmptyState v-if="!messages.length" icon="💬" text="还没有消息，发个招呼吧" />
      <view v-for="m in messages" :key="m.id" :id="'m' + m.id" class="msg-row" :class="{ mine: m.from_id === myId }">
        <view class="bubble-wrap">
          <view class="bubble" :class="m.from_id === myId ? 'bubble-mine' : 'bubble-other'">
            <text class="bubble-text">{{ m.content }}</text>
          </view>
          <view class="msg-time">{{ fmt(m.create_time) }}{{ m.from_id === myId ? (m.is_read ? ' · 已读' : ' · 未读') : '' }}</view>
        </view>
      </view>
      <view id="msg-bottom" class="msg-bottom"></view>
    </scroll-view>

    <view class="composer">
      <input v-model="draft" class="composer-input" placeholder="输入私信内容（1-2000 字）" confirm-type="send" @confirm="send" />
      <button class="btn btn-primary composer-btn" :disabled="sending" @click="send">发送</button>
    </view>
  </view>
</template>

<script setup>
import { ref } from 'vue';
import { onLoad, onShow, onUnload } from '@dcloudio/uni-app';
import { nextTick } from 'vue';
import { api } from '../../../utils/api.js';
import { toast } from '../../../utils/guard.js';
import auth from '../../../utils/auth.js';
import EmptyState from '../../../components/EmptyState.vue';

const uid = ref(null);
const messages = ref([]);
const draft = ref('');
const sending = ref(false);
const anchor = ref('');
const myId = auth.user ? auth.user.id : null;
let timer = null;

function fmt(t) { return t ? String(t).slice(5, 16) : ''; }
function scrollBottom() {
  nextTick(() => { anchor.value = 'msg-bottom'; });
}
async function load() {
  if (!uid.value) return;
  messages.value = await api.dmHistory(uid.value);
  scrollBottom();
  if (messages.value.some((m) => m.from_id !== myId && !m.is_read)) {
    try { await api.dmRead(uid.value); } catch (e) { /* 已读上报失败静默 */ }
  }
}
async function send() {
  const content = draft.value.trim();
  if (!content) return toast('请输入内容');
  if (sending.value) return;
  sending.value = true;
  try {
    await api.dmSend(uid.value, content);
    draft.value = '';
    await load();
  } finally {
    sending.value = false;
  }
}

onLoad((o) => {
  uid.value = Number(o.uid);
  if (o.name) uni.setNavigationBarTitle({ title: decodeURIComponent(o.name) });
  load();
  timer = setInterval(load, 5000);
});
onShow(() => { if (uid.value) load(); });
onUnload(() => { if (timer) clearInterval(timer); });
</script>

<style lang="scss" scoped>
.dm-page { display: flex; flex-direction: column; height: 100vh; background: #f8fafc; }
.msg-scroll { flex: 1; padding: 24rpx 24rpx 24rpx; box-sizing: border-box; }
.msg-bottom { height: 4rpx; }
.msg-row { display: flex; margin-bottom: 26rpx; }
.msg-row.mine { justify-content: flex-end; }
.bubble-wrap { max-width: 76%; display: flex; flex-direction: column; }
.msg-row.mine .bubble-wrap { align-items: flex-end; }
.bubble { border-radius: 20rpx; padding: 20rpx 24rpx; display: inline-block; }
.bubble-other { background: #fff; border: 1rpx solid #e2e8f0; border-top-left-radius: 6rpx; }
.bubble-mine { background: #2563eb; border-top-right-radius: 6rpx; }
.bubble-mine .bubble-text { color: #fff; }
.bubble-text { font-size: 28rpx; line-height: 1.55; word-break: break-all; white-space: pre-wrap; }
.msg-time { font-size: 20rpx; color: #94a3b8; margin-top: 8rpx; }
.composer { display: flex; gap: 14rpx; padding: 14rpx 24rpx calc(14rpx + env(safe-area-inset-bottom)); background: #fff; border-top: 1rpx solid #e2e8f0; }
.composer-input { flex: 1; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 36rpx; padding: 0 26rpx; height: 76rpx; font-size: 27rpx; }
.composer-btn { width: 140rpx; height: 76rpx; font-size: 27rpx; padding: 0; flex-shrink: 0; }
</style>
