<template>
  <view class="page-wrap">
    <view class="seg">
      <view class="seg-item" :class="{ on: mode === 'ai' }" @click="mode = 'ai'">AI 生成</view>
      <view class="seg-item" :class="{ on: mode === 'manual' }" @click="mode = 'manual'">自编计划</view>
    </view>

    <view class="card">
      <view class="field-label">学习主题 <text class="req">*</text></view>
      <input v-model="form.topic" class="field" placeholder="如：STM32 嵌入式开发、Python 数据分析" maxlength="40" />

      <block v-if="mode === 'ai'">
        <view class="field-label">当前水平</view>
        <view class="chip-row">
          <view v-for="lv in levels" :key="lv" class="chip" :class="{ active: form.level === lv }" @click="form.level = lv">{{ lv }}</view>
        </view>
      </block>

      <view class="field-label">学习目标（选填）</view>
      <textarea v-model="form.goal" class="textarea" placeholder="如：能独立做一个智能小车/拿到实习 offer" maxlength="200" />

      <view class="field-label">每周可投入：{{ form.hours }} 小时</view>
      <slider :min="2" :max="30" :step="1" :value="form.hours" activeColor="#2563eb" @change="onHours" />
    </view>

    <block v-if="mode === 'manual'">
      <view v-for="(ph, pi) in phases" :key="pi" class="card phase-card">
        <view class="ph-head">
          <text class="ph-no">阶段 {{ pi + 1 }}</text>
          <text v-if="phases.length > 1" class="ph-del" @click="removePhase(pi)">删除阶段</text>
        </view>
        <view class="field-label">阶段名称 <text class="req">*</text></view>
        <input v-model="ph.phase" class="field" maxlength="30" placeholder="如：入门阶段" />
        <view class="field-label">日期（选填）</view>
        <picker mode="date" :value="ph.date" @change="onPhaseDate(pi, $event)">
          <view class="field picker-like">{{ ph.date || '选择日期' }}</view>
        </picker>
        <view class="field-label">任务清单 <text class="req">*</text>（每行一条）</view>
        <textarea v-model="ph.tasksText" class="textarea" maxlength="2000" :placeholder="tasksPlaceholder" />
        <view class="field-label">达标要求（选填）</view>
        <input v-model="ph.check_standard" class="field" maxlength="100" placeholder="如：独立完成点灯与按键中断" />
      </view>
      <button class="btn btn-ghost btn-block" @click="addPhase">＋ 添加阶段</button>
    </block>

    <button class="btn btn-primary btn-block" :disabled="submitting" @click="submit">
      {{ submitting ? '提交中…' : (mode === 'ai' ? '生成学习计划（可能等待约 1 分钟）' : '保存自编学习计划') }}
    </button>
    <view class="tip text-muted">AI 不可用时系统自动降级为通用学习路径模板，不影响使用。</view>
  </view>
</template>

<script setup>
import { reactive, ref } from 'vue';
import { api } from '../../../utils/api.js';
import { toast } from '../../../utils/guard.js';

const levels = ['零基础', '入门', '进阶'];
const mode = ref('ai');
const form = reactive({ topic: '', level: '零基础', goal: '', hours: 10 });
const phases = reactive([{ phase: '', date: '', tasksText: '', check_standard: '' }]);
const submitting = ref(false);
const tasksPlaceholder = '完成开发环境搭建\n跑通第一个 GPIO 点灯程序';
function onHours(e) { form.hours = e.detail.value; }
function onPhaseDate(pi, e) { phases[pi].date = e.detail.value; }
function addPhase() {
  if (phases.length >= 12) return toast('最多 12 个阶段');
  phases.push({ phase: '', date: '', tasksText: '', check_standard: '' });
}
function removePhase(pi) { phases.splice(pi, 1); }

async function submit() {
  if (!form.topic.trim()) return toast('请输入学习主题');
  submitting.value = true;
  try {
    let res;
    if (mode.value === 'ai') {
      uni.showLoading({ title: 'AI 规划中…', mask: true });
      try {
        res = await api.studyPlan({ topic: form.topic.trim(), level: form.level, goal: form.goal, hours: form.hours });
      } finally {
        uni.hideLoading();
      }
    } else {
      const normPhases = [];
      for (let i = 0; i < phases.length; i++) {
        const ph = phases[i];
        const tasks = String(ph.tasksText || '').split('\n').map((t) => t.trim()).filter(Boolean);
        if (!ph.phase.trim() && !tasks.length) continue;
        if (!ph.phase.trim()) return toast('第 ' + (i + 1) + ' 个阶段缺少名称');
        if (!tasks.length) return toast('第 ' + (i + 1) + ' 个阶段至少一条任务');
        normPhases.push({ phase: ph.phase.trim(), date: ph.date || '', tasks, check_standard: ph.check_standard.trim() });
      }
      if (!normPhases.length) return toast('至少填写一个阶段和任务');
      res = await api.studyManual({
        topic: form.topic.trim(),
        goal: form.goal.trim(),
        hours: form.hours,
        phases: normPhases,
      });
    }
    uni.showToast({ title: '计划已生成', icon: 'success' });
    uni.redirectTo({ url: '/packagePlan/pages/study/detail?id=' + res.id });
  } catch (e) {
    /* request 层已 toast */
  } finally {
    submitting.value = false;
  }
}
</script>

<style lang="scss" scoped>
.seg { display: flex; background: #fff; border-radius: 16rpx; padding: 8rpx; border: 1rpx solid #e2e8f0; margin-bottom: 18rpx; }
.seg-item { flex: 1; text-align: center; font-size: 26rpx; color: #64748b; padding: 16rpx 0; border-radius: 12rpx; }
.seg-item.on { background: #2563eb; color: #fff; font-weight: 700; }
.field-label { font-size: 26rpx; font-weight: 600; color: #334155; margin: 22rpx 0 12rpx; }
.req { color: #ef4444; }
.field { width: 100%; box-sizing: border-box; height: 88rpx; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 14rpx; padding: 0 24rpx; font-size: 27rpx; }
.textarea { width: 100%; box-sizing: border-box; min-height: 150rpx; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 14rpx; padding: 20rpx 24rpx; font-size: 27rpx; }
.chip-row { display: flex; gap: 14rpx; flex-wrap: wrap; }
.chip { padding: 12rpx 30rpx; border-radius: 30rpx; background: #f1f5f9; font-size: 25rpx; color: #475569; }
.chip.active { background: #2563eb; color: #fff; }
.tip { font-size: 23rpx; padding: 20rpx 10rpx; line-height: 1.6; }
.phase-card { padding: 22rpx 26rpx; }
.ph-head { display: flex; justify-content: space-between; align-items: center; }
.ph-no { font-size: 27rpx; font-weight: 800; color: #2563eb; }
.ph-del { font-size: 23rpx; color: #ef4444; }
.picker-like { color: #334155; line-height: 88rpx; }
</style>
