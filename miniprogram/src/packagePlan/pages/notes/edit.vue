<template>
  <view class="page-wrap">
    <view class="card">
      <view class="date-title">{{ date }} 学习笔记</view>
      <view class="field-label">今日学习状态</view>
      <view class="chip-row">
        <view v-for="s in statusList" :key="s.key" class="chip" :class="{ active: status === s.key }" @click="status = s.key">{{ s.label }}</view>
      </view>
      <view class="field-label">笔记内容（支持简单换行）</view>
      <textarea v-model="content" class="textarea" placeholder="今天学了什么、遇到什么问题、如何解决…" maxlength="5000" />
      <view class="word-count">{{ content.length }}/5000</view>
    </view>
    <button class="btn btn-primary btn-block" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存笔记' }}</button>
    <button v-if="existingId" class="btn btn-danger btn-block" @click="remove">删除该笔记</button>
  </view>
</template>

<script setup>
import { ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { confirm, toast } from '../../../utils/guard.js';

const statusList = [
  { key: 'good', label: '顺利' }, { key: 'hard', label: '困难' }, { key: 'slow', label: '进度慢' }, { key: 'none', label: '未评价' },
];
const date = ref('');
const content = ref('');
const status = ref('');
const existingId = ref(null);
const saving = ref(false);

async function load() {
  const row = await api.noteByDate(date.value);
  if (row) {
    existingId.value = row.id;
    content.value = String(row.content || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
    status.value = row.status || '';
  }
}

async function save() {
  saving.value = true;
  try {
    const html = content.value.split(/\r?\n/).map((l) => l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') || '&nbsp;').join('<br/>');
    await api.noteSave({ note_date: date.value, content: html, status: status.value });
    toast('已保存', 'success');
    setTimeout(() => uni.navigateBack(), 500);
  } finally {
    saving.value = false;
  }
}

async function remove() {
  if (!(await confirm('确认删除该笔记？'))) return;
  await api.noteDelete(existingId.value);
  toast('已删除', 'success');
  uni.navigateBack();
}

onLoad((o) => { date.value = o.date; load(); });
</script>

<style lang="scss" scoped>
.date-title { font-size: 32rpx; font-weight: 800; color: #1e293b; }
.field-label { font-size: 26rpx; font-weight: 600; color: #334155; margin: 24rpx 0 12rpx; }
.chip-row { display: flex; gap: 14rpx; flex-wrap: wrap; }
.chip { padding: 12rpx 30rpx; border-radius: 30rpx; background: #f1f5f9; font-size: 25rpx; color: #475569; }
.chip.active { background: #2563eb; color: #fff; }
.textarea { width: 100%; box-sizing: border-box; min-height: 360rpx; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 14rpx; padding: 20rpx 24rpx; font-size: 27rpx; line-height: 1.7; }
.word-count { text-align: right; font-size: 22rpx; color: #94a3b8; margin-top: 8rpx; }
</style>