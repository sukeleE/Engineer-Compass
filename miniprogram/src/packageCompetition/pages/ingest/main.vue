<template>
  <view class="page-wrap">
    <view class="card">
      <view class="title">收录未知竞赛</view>
      <view class="desc text-muted">粘贴官方通知/官网正文（≥20 字），AI 自动提炼为标准竞赛卡片；提交后进入待审核，转正后全站可见。</view>
      <textarea v-model="material" class="textarea" placeholder="粘贴竞赛官方通知、章程或介绍正文…" maxlength="8000" />
      <view class="word-count">{{ material.length }}/8000</view>
      <button class="btn btn-primary btn-block" :disabled="extracting" @click="extract">
        {{ extracting ? 'AI 提炼中…' : 'AI 提炼结构化卡片' }}
      </button>
    </view>

    <view v-if="card" class="card form-card">
      <view class="field-label">竞赛名称 <text class="req">*</text></view>
      <input v-model="card.name" class="field" placeholder="必填" />
      <view class="field-label">来源链接 <text class="req">*</text></view>
      <input v-model="card.source_url" class="field" placeholder="https:// 官方通知地址（必填，防数据污染）" />
      <view class="grid2">
        <view>
          <view class="field-label">简称</view>
          <input v-model="card.short_name" class="field" />
        </view>
        <view>
          <view class="field-label">启动月份</view>
          <input v-model.number="card.start_month" class="field" type="number" placeholder="1-12" />
        </view>
      </view>
      <view class="field-label">赛道分类</view>
      <view class="chip-row">
        <view v-for="t in types" :key="t" class="chip" :class="{ active: card.type === t }" @click="card.type = t">{{ t }}</view>
      </view>
      <view class="grid2">
        <view>
          <view class="field-label">难度（1-5）</view>
          <input v-model.number="card.difficulty" class="field" type="number" />
        </view>
        <view>
          <view class="field-label">年份</view>
          <input v-model.number="card.data_year" class="field" type="number" />
        </view>
      </view>
      <view class="field-label">举办周期</view>
      <input v-model="card.cycle" class="field" placeholder="如：每年一届" />
      <view class="field-label">适合专业</view>
      <input v-model="card.suitable_major" class="field" />
      <view class="field-label">简介</view>
      <textarea v-model="card.intro" class="textarea small" />
      <view v-if="card.confidence != null" class="conf">AI 置信度：{{ Math.round(card.confidence * 100) }}%</view>
      <button class="btn btn-primary btn-block" :disabled="submitting" @click="submit">{{ submitting ? '提交中…' : '提交待审核' }}</button>
    </view>
  </view>
</template>

<script setup>
import { ref } from 'vue';
import { api } from '../../../utils/api.js';
import { ensureLogin, toast } from '../../../utils/guard.js';

const types = ['电子机器人', '机械', '综合', '数学基础', '设计艺术', '经管商科', '医学技能'];
const material = ref('');
const card = ref(null);
const extracting = ref(false);
const submitting = ref(false);

async function extract() {
  if (material.value.trim().length < 20) return toast('资料正文至少 20 字');
  extracting.value = true;
  try {
    card.value = await api.aiExtract(material.value);
    if (!card.value.type) card.value.type = '综合';
    toast('提炼完成，请核实补全', 'success');
  } finally {
    extracting.value = false;
  }
}

async function submit() {
  if (!ensureLogin()) return;
  if (!card.value.name?.trim()) return toast('竞赛名称必填');
  if (!card.value.source_url?.trim()) return toast('来源链接必填');
  submitting.value = true;
  try {
    await api.addCompetition(card.value);
    toast('已提交待审核', 'success');
    setTimeout(() => uni.navigateBack(), 700);
  } finally {
    submitting.value = false;
  }
}
</script>

<style lang="scss" scoped>
.title { font-size: 32rpx; font-weight: 800; color: #1e293b; }
.desc { margin: 12rpx 0 20rpx; font-size: 25rpx; line-height: 1.7; }
.textarea { width: 100%; box-sizing: border-box; min-height: 280rpx; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 14rpx; padding: 20rpx 24rpx; font-size: 27rpx; }
.textarea.small { min-height: 160rpx; }
.word-count { text-align: right; font-size: 22rpx; color: #94a3b8; margin: 8rpx 0 16rpx; }
.form-card { margin-top: 20rpx; }
.field-label { font-size: 26rpx; font-weight: 600; color: #334155; margin: 20rpx 0 10rpx; }
.req { color: #ef4444; }
.field { width: 100%; box-sizing: border-box; height: 84rpx; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 14rpx; padding: 0 22rpx; font-size: 26rpx; }
.grid2 { display: flex; gap: 18rpx; }
.grid2 > view { flex: 1; }
.chip-row { display: flex; gap: 12rpx; flex-wrap: wrap; }
.chip { padding: 10rpx 24rpx; border-radius: 28rpx; background: #f1f5f9; font-size: 24rpx; color: #475569; }
.chip.active { background: #2563eb; color: #fff; }
.conf { margin: 18rpx 0; font-size: 24rpx; color: #6d28d9; }
</style>