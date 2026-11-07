<template>
  <view class="page-wrap">
    <view class="card">
      <view class="f-label">计划标题 <text class="req">*</text></view>
      <input v-model="form.title" class="line-input" maxlength="40" placeholder="如：智能车竞赛备赛计划" />

      <view class="f-label">关联竞赛（选填，仅可选择已转正竞赛）</view>
      <picker :range="comps" range-key="name" :value="compIndex" @change="onComp">
        <view class="line-input picker-like">{{ currentComp ? currentComp.name : '不关联竞赛（自编计划）' }}</view>
      </picker>
    </view>

    <view v-for="(ph, pi) in form.phases" :key="pi" class="card phase-card">
      <view class="ph-head">
        <text class="ph-no">阶段 {{ pi + 1 }}</text>
        <text v-if="form.phases.length > 1" class="ph-del" @click="removePhase(pi)">删除阶段</text>
      </view>
      <view class="f-label">阶段名称 <text class="req">*</text></view>
      <input v-model="ph.phase" class="line-input" maxlength="30" placeholder="如：基础学习阶段" />
      <view class="f-label">起止日期（选填）</view>
      <picker mode="date" :value="ph.date" @change="onPhaseDate(pi, $event)">
        <view class="line-input picker-like">{{ ph.date || '选择日期' }}</view>
      </picker>
      <view class="f-label">任务清单 <text class="req">*</text>（每行一条）</view>
      <textarea v-model="ph.tasksText" class="line-textarea" maxlength="2000" :placeholder="tasksPlaceholder" />
      <view class="f-label">达标要求（选填）</view>
      <input v-model="ph.check_standard" class="line-input" maxlength="100" placeholder="如：独立完成循迹小车 Demo" />
    </view>

    <button class="btn btn-ghost btn-block" @click="addPhase">＋ 添加阶段</button>
    <button class="btn btn-primary btn-block" :disabled="submitting" @click="submit">{{ submitting ? '保存中…' : '保存自编计划' }}</button>
  </view>
</template>

<script setup>
import { reactive, ref, computed } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { toast } from '../../../utils/guard.js';

const comps = ref([]);
const compIndex = ref(0);
const submitting = ref(false);
const form = reactive({
  title: '',
  comp_id: null,
  phases: [{ phase: '', date: '', tasksText: '', check_standard: '' }],
});
const currentComp = computed(() => comps.value[compIndex.value] || null);
const tasksPlaceholder = '夯实 C 语言基础\n掌握 STM32 GPIO 配置\n完成电机驱动实验';

function onComp(e) {
  compIndex.value = Number(e.detail.value);
  const c = comps.value[compIndex.value];
  form.comp_id = c ? c.id : null;
}
function onPhaseDate(pi, e) { form.phases[pi].date = e.detail.value; }
function addPhase() {
  if (form.phases.length >= 12) return toast('最多 12 个阶段');
  form.phases.push({ phase: '', date: '', tasksText: '', check_standard: '' });
}
function removePhase(pi) { form.phases.splice(pi, 1); }

async function submit() {
  if (!form.title.trim()) return toast('请填写计划标题');
  const phases = [];
  for (let i = 0; i < form.phases.length; i++) {
    const ph = form.phases[i];
    const tasks = String(ph.tasksText || '').split('\n').map((t) => t.trim()).filter(Boolean).map((t) => ({ text: t, done: false }));
    if (!ph.phase.trim() && !tasks.length) continue;
    if (!ph.phase.trim()) return toast('第 ' + (i + 1) + ' 个阶段缺少名称');
    if (!tasks.length) return toast('第 ' + (i + 1) + ' 个阶段至少写一条任务（每行一条）');
    phases.push({ phase: ph.phase.trim(), date: ph.date || '', tasks, check_standard: ph.check_standard.trim() });
  }
  if (!phases.length) return toast('至少填写一个阶段和任务');
  submitting.value = true;
  try {
    await api.scheduleManual({ title: form.title.trim(), comp_id: form.comp_id, phases });
    toast('自编计划已保存', 'success');
    setTimeout(() => uni.switchTab({ url: '/pages/schedule/main' }), 600);
  } finally {
    submitting.value = false;
  }
}

onLoad(async () => {
  try {
    const rows = await api.competitions();
    comps.value = [{ id: null, name: '不关联竞赛（自编计划）' }].concat(Array.isArray(rows) ? rows : []);
  } catch (e) {
    comps.value = [{ id: null, name: '不关联竞赛（自编计划）' }];
  }
});
</script>

<style lang="scss" scoped>
.f-label { font-size: 24rpx; color: #64748b; margin: 16rpx 4rpx 10rpx; }
.req { color: #ef4444; }
.line-input { background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 12rpx; padding: 18rpx 20rpx; font-size: 26rpx; margin-bottom: 12rpx; }
.picker-like { color: #334155; }
.line-textarea { width: 100%; box-sizing: border-box; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 12rpx; padding: 18rpx 20rpx; font-size: 26rpx; min-height: 200rpx; margin-bottom: 12rpx; }
.phase-card { padding: 22rpx 26rpx; }
.ph-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8rpx; }
.ph-no { font-size: 27rpx; font-weight: 800; color: #2563eb; }
.ph-del { font-size: 23rpx; color: #ef4444; }
</style>
