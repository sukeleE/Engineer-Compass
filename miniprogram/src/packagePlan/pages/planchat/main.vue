<template>
  <view class="chat-page">
    <scroll-view class="msg-list" scroll-y :scroll-into-view="anchor" :scroll-with-animation="true">
      <view id="top" class="welcome card">
        <view class="welcome-title">🧭 对话式 AI 计划</view>
        <view class="welcome-text">{{ hint }}</view>
      </view>
      <view v-for="(m, i) in messages" :key="i" :id="'m' + i" class="msg-row" :class="m.role">
        <view class="bubble">
          <Markdown v-if="m.role === 'assistant'" :content="m.content" />
          <text v-else>{{ m.content }}</text>
        </view>
      </view>
      <view v-if="finalPlan" class="card plan-card">
        <view class="plan-title">✅ 计划已生成并保存（{{ finalPlan.phases?.length || 0 }} 个阶段）</view>
        <view v-if="finalPlan.summary" class="plan-summary">{{ finalPlan.summary }}</view>
        <button class="btn btn-primary btn-block" @click="goList">前往查看</button>
      </view>
      <view v-if="sending" class="msg-row assistant"><view class="bubble typing">AI 思考中…</view></view>
      <view id="bottom" style="height:20rpx"></view>
    </scroll-view>

    <view class="input-bar">
      <input v-model="draft" class="msg-input" placeholder="描述你的需求…" :disabled="sending" confirm-type="send" @confirm="send" />
      <button class="btn btn-primary send-btn" :disabled="sending || !draft.trim()" @click="send">发送</button>
    </view>
  </view>
</template>

<script setup>
import { ref, nextTick } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import Markdown from '../../../components/Markdown.vue';

const mode = ref('study');
const cfg = ref({});
const draft = ref('');
const sending = ref(false);
const anchor = ref('');
const messages = ref([]);
const finalPlan = ref(null);

const hintMap = {
  study: '告诉我你想学的主题、当前水平、目标与每周可投入时间，AI 会先提问再产出完整学习计划并自动保存。',
  schedule: '告诉我你的基础水平、备赛周期与目标，AI 会先提问再生成该竞赛的个人备赛日程并自动保存。',
};
const hint = ref(hintMap.study);

async function scrollBottom() {
  await nextTick();
  anchor.value = 'bottom';
}

async function send() {
  const text = draft.value.trim();
  if (!text || sending.value) return;
  messages.value.push({ role: 'user', content: text });
  draft.value = '';
  sending.value = true;
  await scrollBottom();
  try {
    const res = await api.planChat(Object.assign({ mode: mode.value }, cfg.value), messages.value.map((m) => ({ role: m.role, content: m.content })));
    if (res.action === 'plan') {
      finalPlan.value = res.plan;
      messages.value.push({ role: 'assistant', content: res.reply || '计划已生成 ✅' });
    } else {
      messages.value.push({ role: 'assistant', content: res.reply || '请继续补充信息' });
    }
  } catch (e) {
    messages.value.push({ role: 'assistant', content: '⚠️ ' + (e.message || '请求失败') });
  } finally {
    sending.value = false;
    scrollBottom();
  }
}

function goList() {
  const url = mode.value === 'study' ? '/packagePlan/pages/study/list' : '/pages/schedule/main';
  if (mode.value === 'study') uni.redirectTo({ url });
  else uni.switchTab({ url });
}

onLoad((o) => {
  mode.value = o.mode || 'study';
  hint.value = hintMap[mode.value] || hintMap.study;
  const c = {};
  if (o.comp_id) c.comp_id = Number(o.comp_id);
  if (o.comp_name) c.comp_name = decodeURIComponent(o.comp_name);
  if (o.study_id) c.study_id = Number(o.study_id);
  if (o.schedule_id) c.schedule_id = Number(o.schedule_id);
  cfg.value = c;
  uni.setNavigationBarTitle({ title: mode.value === 'study' ? 'AI 学习计划对话' : 'AI 备赛计划对话' });
});
</script>

<style lang="scss" scoped>
.chat-page { display: flex; flex-direction: column; height: 100vh; background: #f8fafc; }
.msg-list { flex: 1; height: 0; padding: 24rpx; box-sizing: border-box; }
.welcome { margin-bottom: 24rpx; }
.welcome-title { font-size: 30rpx; font-weight: 700; }
.welcome-text { font-size: 25rpx; color: #64748b; margin-top: 10rpx; line-height: 1.7; }
.msg-row { display: flex; margin-bottom: 22rpx; }
.msg-row.user { justify-content: flex-end; }
.bubble { max-width: 80%; padding: 20rpx 24rpx; border-radius: 20rpx; font-size: 27rpx; line-height: 1.65; white-space: pre-wrap; word-break: break-word; }
.msg-row.assistant .bubble { background: #fff; border: 1rpx solid #e2e8f0; border-top-left-radius: 6rpx; }
.msg-row.user .bubble { background: #2563eb; color: #fff; border-top-right-radius: 6rpx; }
.typing { color: #94a3b8; }
.plan-card { background: #f0fdf4; border-color: #bbf7d0; }
.plan-title { font-size: 28rpx; font-weight: 700; color: #166534; margin-bottom: 10rpx; }
.plan-summary { font-size: 25rpx; color: #15803d; margin-bottom: 20rpx; line-height: 1.6; }
.input-bar { display: flex; align-items: center; gap: 16rpx; padding: 16rpx 24rpx calc(16rpx + env(safe-area-inset-bottom)); background: #fff; border-top: 1rpx solid #e2e8f0; }
.msg-input { flex: 1; height: 76rpx; background: #f1f5f9; border-radius: 38rpx; padding: 0 28rpx; font-size: 27rpx; }
.send-btn { width: 150rpx; height: 76rpx; font-size: 27rpx; padding: 0; }
</style>