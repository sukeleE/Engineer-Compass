<template>
  <view class="load-more">
    <text v-if="loading">加载中…</text>
    <text v-else-if="finished">— 没有更多了 —</text>
    <text v-else @click="$emit('more')">点击加载更多</text>
  </view>
</template>

<script setup>
defineProps({ loading: Boolean, finished: Boolean });
defineEmits(['more']);
</script>

<style lang="scss" scoped>
.load-more { text-align: center; color: #94a3b8; font-size: 24rpx; padding: 30rpx 0; }
</style>