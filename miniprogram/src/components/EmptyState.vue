<template>
  <view class="empty">
    <view class="empty-icon">{{ icon }}</view>
    <view class="empty-text">{{ text }}</view>
    <button v-if="btnText" class="btn btn-primary" style="width: 360rpx; margin: 0 auto" @click="$emit('action')">{{ btnText }}</button>
  </view>
</template>

<script setup>
defineProps({
  icon: { type: String, default: '📭' },
  text: { type: String, default: '暂无数据' },
  btnText: { type: String, default: '' },
});
defineEmits(['action']);
</script>