<template>
  <view class="page-wrap" v-if="data">
    <view class="card head">
      <view class="topic">{{ data.topic }}</view>
      <view class="sub">
        <text v-if="data.level" class="tag tag-blue">{{ data.level }}</text>
        <text v-if="data.hours" class="text-small text-muted">每周 {{ data.hours }} 小时</text>
      </view>
      <view v-if="plan.summary" class="summary">{{ plan.summary }}</view>
      <view v-if="data.note" class="note-tip">⚠️ {{ data.note }}</view>
      <view class="progress-row">
        <view class="progress-track"><view class="progress-fill" :style="{ width: percent + '%' }"></view></view>
        <text class="pct">{{ percent }}%</text>
      </view>
    </view>

    <view class="section-title">阶段任务（{{ doneCount }}/{{ totalCount }}）</view>
    <view v-for="(ph, pi) in plan.phases" :key="pi" class="card phase">
      <view class="phase-head">
        <text class="phase-name">{{ ph.phase }}</text>
        <text v-if="ph.date" class="phase-date">{{ ph.date }}</text>
      </view>
      <view v-for="(t, ti) in ph.tasks" :key="ti" class="task" @click="toggle(pi, ti)">
        <text class="checkbox" :class="{ checked: t.done }">{{ t.done ? '✓' : '' }}</text>
        <text class="task-text" :class="{ done: t.done }">{{ t.text }}</text>
      </view>
      <view v-if="ph.check_standard" class="std">达标：{{ ph.check_standard }}</view>
    </view>

    <view class="section-title">推荐学习资源（平台搜索）</view>
    <view class="card res-card">
      <view v-for="(r, i) in data.resources || []" :key="i" class="res-item" @click="openLink(r.url)">
        <text class="res-platform tag tag-blue">{{ r.platform }}</text>
        <text class="res-title ellipsis">{{ r.title }}</text>
        <text class="res-kind">{{ r.kind === 'topic' ? '主题' : '关键词' }}</text>
      </view>
    </view>

    <button class="btn btn-danger btn-block" @click="remove">删除学习计划</button>
  </view>
  <view v-else class="empty"><view class="empty-text">加载中…</view></view>
</template>

<script setup>
import { ref, computed } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { confirm, toast } from '../../../utils/guard.js';
import { openExternal } from '../../../utils/preview.js';

const id = ref(null);
const data = ref(null);
const saveTimer = ref(null);
let rollback = null;

const plan = computed(() => data.value?.plan || { phases: [] });
const allTasks = computed(() => plan.value.phases.flatMap((p) => p.tasks || []));
const doneCount = computed(() => allTasks.value.filter((t) => t.done).length);
const totalCount = computed(() => allTasks.value.length);
const percent = computed(() => (totalCount.value ? Math.round((doneCount.value / totalCount.value) * 100) : 0));

async function load() {
  data.value = await api.studyDetail(id.value);
}

function toggle(pi, ti) {
  const task = plan.value.phases[pi].tasks[ti];
  if (!rollback) rollback = JSON.stringify(plan.value);
  task.done = !task.done;
  if (saveTimer.value) clearTimeout(saveTimer.value);
  saveTimer.value = setTimeout(async () => {
    try {
      await api.studyUpdate(id.value, plan.value);
      rollback = null;
    } catch (e) {
      if (rollback) data.value.plan = JSON.parse(rollback);
      rollback = null;
      toast('保存失败，已回滚');
    }
  }, 700);
}

function openLink(url) { openExternal(url); }

async function remove() {
  if (!(await confirm('确认删除该学习计划？'))) return;
  await api.studyDelete(id.value);
  toast('已删除', 'success');
  uni.navigateBack();
}

onLoad((o) => { id.value = Number(o.id); load(); });
</script>

<style lang="scss" scoped>
.head .topic { font-size: 34rpx; font-weight: 800; color: #1e293b; }
.sub { display: flex; align-items: center; gap: 14rpx; margin-top: 12rpx; }
.summary { margin-top: 16rpx; color: #475569; font-size: 26rpx; line-height: 1.7; }
.note-tip { margin-top: 14rpx; background: #fef3c7; color: #b45309; font-size: 23rpx; border-radius: 10rpx; padding: 12rpx 16rpx; }
.progress-row { display: flex; align-items: center; gap: 16rpx; margin-top: 20rpx; }
.progress-track { flex: 1; height: 12rpx; background: #f1f5f9; border-radius: 6rpx; overflow: hidden; }
.progress-fill { height: 100%; background: linear-gradient(90deg, #2563eb, #60a5fa); }
.pct { font-size: 24rpx; color: #2563eb; font-weight: 700; }
.phase { padding: 24rpx 28rpx; }
.phase-head { display: flex; justify-content: space-between; align-items: baseline; gap: 16rpx; }
.phase-name { font-size: 28rpx; font-weight: 700; color: #334155; }
.phase-date { font-size: 23rpx; color: #94a3b8; }
.task { display: flex; align-items: flex-start; gap: 14rpx; padding: 12rpx 0; }
.checkbox { width: 38rpx; height: 38rpx; border: 2rpx solid #cbd5e1; border-radius: 10rpx; flex-shrink: 0; text-align: center; line-height: 36rpx; color: #fff; font-size: 26rpx; }
.checkbox.checked { background: #16a34a; border-color: #16a34a; }
.task-text { font-size: 26rpx; color: #334155; flex: 1; }
.task-text.done { color: #94a3b8; text-decoration: line-through; }
.std { font-size: 23rpx; color: #15803d; background: #f0fdf4; border-radius: 10rpx; padding: 10rpx 16rpx; margin-top: 8rpx; }
.res-card { padding: 8rpx 28rpx; }
.res-item { display: flex; align-items: center; gap: 14rpx; padding: 20rpx 0; border-bottom: 1rpx solid #f8fafc; }
.res-item:last-child { border-bottom: none; }
.res-platform { flex-shrink: 0; }
.res-title { flex: 1; font-size: 26rpx; color: #334155; }
.res-kind { font-size: 21rpx; color: #94a3b8; flex-shrink: 0; }
</style>