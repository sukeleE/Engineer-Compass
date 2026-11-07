<template>
  <scroll-view scroll-x class="tabs" :show-scrollbar="false">
    <view
      v-for="t in tabs"
      :key="t.key"
      class="tab"
      :class="{ active: modelValue === t.key }"
      @click="$emit('update:modelValue', t.key)"
    >
      <text>{{ t.label }}</text>
      <text v-if="t.badge" class="tab-badge">{{ t.badge }}</text>
    </view>
  </scroll-view>
</template>

<script setup>
defineProps({
  tabs: { type: Array, required: true },
  modelValue: { type: [String, Number], default: '' },
});
defineEmits(['update:modelValue']);
</script>

<style lang="scss" scoped>
.tabs { white-space: nowrap; background: #fff; border-bottom: 1rpx solid #e2e8f0; position: sticky; top: 0; z-index: 10; }
.tab {
  display: inline-flex;
  align-items: center;
  gap: 8rpx;
  padding: 0 30rpx;
  height: 88rpx;
  font-size: 27rpx;
  color: #64748b;
  position: relative;
}
.tab.active { color: #2563eb; font-weight: 700; }
.tab.active::after {
  content: '';
  position: absolute;
  left: 30rpx;
  right: 30rpx;
  bottom: 0;
  height: 6rpx;
  border-radius: 3rpx;
  background: #2563eb;
}
.tab-badge {
  background: #ef4444;
  color: #fff;
  font-size: 20rpx;
  border-radius: 16rpx;
  padding: 0 10rpx;
  line-height: 1.6;
}
</style>