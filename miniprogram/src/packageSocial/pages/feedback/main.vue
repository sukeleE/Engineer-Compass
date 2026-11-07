<template>
  <view class="page-wrap">
    <view class="card">
      <view class="section-title" style="margin-left: 0">意见反馈</view>
      <textarea v-model="content" class="fb-area" maxlength="5000" placeholder="遇到的问题、功能建议或使用体验，都可以告诉我们（1-5000 字）" />
      <view class="fb-count">{{ content.length }}/5000</view>
      <view class="fb-tip">提交后将同步发送给运营团队，也可通过邮箱 3209646785@qq.com 联系我们</view>
      <button class="btn btn-primary btn-block" :disabled="submitting" @click="submit">{{ submitting ? '提交中…' : '提交反馈' }}</button>
    </view>
  </view>
</template>

<script setup>
import { ref } from 'vue';
import { api } from '../../../utils/api.js';
import { toast } from '../../../utils/guard.js';
import { ensureLogin } from '../../../utils/guard.js';

const content = ref('');
const submitting = ref(false);

async function submit() {
  if (!ensureLogin('登录后才能提交反馈')) return;
  const text = content.value.trim();
  if (!text) return toast('反馈内容不能为空');
  submitting.value = true;
  try {
    await api.feedback({ content: text });
    toast('反馈已提交，感谢你的建议！', 'success');
    content.value = '';
    setTimeout(() => uni.navigateBack(), 800);
  } finally {
    submitting.value = false;
  }
}
</script>

<style lang="scss" scoped>
.fb-area { width: 100%; box-sizing: border-box; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 16rpx; padding: 22rpx; font-size: 27rpx; min-height: 320rpx; line-height: 1.6; }
.fb-count { text-align: right; font-size: 22rpx; color: #94a3b8; margin: 8rpx 4rpx 14rpx; }
.fb-tip { font-size: 23rpx; color: #94a3b8; line-height: 1.6; margin-bottom: 24rpx; }
</style>
