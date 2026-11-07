<template>
  <view class="comp-row">
    <view class="row-1">
      <text class="name ellipsis">{{ c.name }}</text>
      <text class="month-badge">{{ c.start_month ? c.start_month + '月' : '待定' }}</text>
    </view>
    <view class="row-2">
      <text v-if="c.short_name" class="short ellipsis">{{ c.short_name }}</text>
      <text class="tag" :style="{ background: typeColor(c.type) + '1a', color: typeColor(c.type) }">{{ c.type || '未分类' }}</text>
      <text v-if="c.source_type && c.source_type !== 'official'" class="tag tag-purple">AI 收录</text>
    </view>
    <view class="row-3">
      <text class="stars">{{ difficultyStars(c.difficulty) }}</text>
      <text v-if="c.cycle" class="cycle ellipsis">{{ c.cycle }}</text>
    </view>
  </view>
</template>

<script setup>
import { typeColor, difficultyStars } from '../../utils/format.js';
defineProps({ c: { type: Object, required: true } });
</script>

<style lang="scss" scoped>
.comp-row { width: 100%; }
.row-1 { display: flex; align-items: center; justify-content: space-between; gap: 16rpx; }
.name { font-size: 31rpx; font-weight: 700; color: #1e293b; flex: 1; }
.month-badge {
  flex-shrink: 0;
  background: #eff6ff;
  color: #2563eb;
  font-size: 23rpx;
  font-weight: 600;
  border-radius: 10rpx;
  padding: 4rpx 14rpx;
}
.row-2 { display: flex; align-items: center; gap: 8rpx; margin-top: 12rpx; flex-wrap: wrap; }
.short { font-size: 25rpx; color: #64748b; max-width: 260rpx; }
.tag {
  display: inline-flex;
  padding: 4rpx 14rpx;
  border-radius: 8rpx;
  font-size: 22rpx;
  line-height: 1.5;
}
.row-3 { display: flex; align-items: center; justify-content: space-between; margin-top: 12rpx; gap: 16rpx; }
.stars { color: #f59e0b; font-size: 24rpx; letter-spacing: 2rpx; }
.cycle { font-size: 23rpx; color: #94a3b8; flex: 1; text-align: right; }
</style>