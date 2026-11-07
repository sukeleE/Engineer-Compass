<template>
  <view class="page-wrap">
    <view class="card">
      <view class="field-label">小组名称 <text class="req">*</text></view>
      <input v-model="form.name" class="field" placeholder="如：电赛控制组" maxlength="30" />
      <view class="field-label">小组介绍</view>
      <textarea v-model="form.desc" class="textarea" placeholder="小组目标、分工方向等（选填）" maxlength="300" />
      <view class="field-label">关联竞赛（选填，AI 将据此生成部门与备赛计划）</view>
      <picker :range="compNames" @change="onPick">
        <view class="picker">{{ pickedName || '点击选择竞赛（可不选）' }}</view>
      </picker>
    </view>
    <button class="btn btn-primary btn-block" :disabled="submitting" @click="submit">
      {{ submitting ? '创建中…（AI 生成可能等待约 1 分钟）' : '创建小组' }}
    </button>
  </view>
</template>

<script setup>
import { reactive, ref } from 'vue';
import { api } from '../../../utils/api.js';

const form = reactive({ name: '', desc: '', comp_id: null });
const comps = ref([]);
const compNames = ref([]);
const pickedName = ref('');
const submitting = ref(false);

function onPick(e) {
  const idx = Number(e.detail.value);
  form.comp_id = comps.value[idx]?.id || null;
  pickedName.value = comps.value[idx]?.name || '';
}

async function submit() {
  if (!form.name.trim()) return uni.showToast({ title: '小组名称必填', icon: 'none' });
  submitting.value = true;
  uni.showLoading({ title: '创建中…', mask: true });
  try {
    const res = await api.teamCreate({ name: form.name.trim(), desc: form.desc, comp_id: form.comp_id });
    uni.hideLoading();
    uni.showToast({ title: '创建成功', icon: 'success' });
    uni.redirectTo({ url: '/packageTeam/pages/detail/main?id=' + res.id });
  } catch (e) {
    uni.hideLoading();
  } finally {
    submitting.value = false;
  }
}

api.competitions().then((rows) => {
  comps.value = rows;
  compNames.value = rows.map((r) => r.name);
}).catch(() => {});
</script>

<style lang="scss" scoped>
.field-label { font-size: 26rpx; font-weight: 600; color: #334155; margin: 22rpx 0 12rpx; }
.req { color: #ef4444; }
.field { width: 100%; box-sizing: border-box; height: 88rpx; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 14rpx; padding: 0 24rpx; font-size: 27rpx; }
.textarea { width: 100%; box-sizing: border-box; min-height: 180rpx; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 14rpx; padding: 20rpx 24rpx; font-size: 27rpx; }
.picker { height: 88rpx; line-height: 88rpx; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 14rpx; padding: 0 24rpx; font-size: 27rpx; color: #475569; }
</style>