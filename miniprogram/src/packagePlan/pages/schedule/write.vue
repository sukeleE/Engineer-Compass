<template>
  <view class="writer-page">
    <view class="writer-head">
      <text class="writer-title">编写备赛计划</text>
      <text class="writer-sub">选择适合你的方式，后续都可以继续修改</text>
    </view>

    <view v-if="!importPlan" class="mode-list">
      <view class="mode-item" @click="startAi('dialog')">
        <view class="mode-icon ai">💬</view>
        <view class="mode-main">
          <text class="mode-title">AI 对话编写</text>
          <text class="mode-desc">AI 先确认目标、周期和可投入时间，再逐步生成计划</text>
        </view>
        <text class="mode-arrow">›</text>
      </view>
      <view class="mode-item" @click="startAi('one')">
        <view class="mode-icon ai">⚡</view>
        <view class="mode-main">
          <text class="mode-title">AI 一键编写</text>
          <text class="mode-desc">选择竞赛后直接生成完整阶段任务，生成后仍可调整</text>
        </view>
        <text class="mode-arrow">›</text>
      </view>
      <view class="mode-item" @click="openManual">
        <view class="mode-icon manual">✍️</view>
        <view class="mode-main">
          <text class="mode-title">手动编写</text>
          <text class="mode-desc">自己设置阶段、日期、任务清单和达标要求</text>
        </view>
        <text class="mode-arrow">›</text>
      </view>
      <view class="mode-item" @click="chooseImportFile">
        <view class="mode-icon import">📄</view>
        <view class="mode-main">
          <text class="mode-title">导入计划文档</text>
          <text class="mode-desc">从 Word、PDF、Excel、Markdown 或文本中提取计划</text>
        </view>
        <text class="mode-arrow">›</text>
      </view>
    </view>

    <view v-if="converting" class="convert-state">
      <view class="loading-ring"></view>
      <text class="convert-title">正在读取计划文档</text>
      <text class="convert-desc">AI 会保留原文并整理为阶段任务，预计 10–60 秒</text>
    </view>

    <view v-if="importPlan" class="import-preview">
      <view class="preview-head">
        <text class="preview-title">导入预览</text>
        <text class="preview-reset" @click="resetImport">重新导入</text>
      </view>
      <text class="field-label">计划标题</text>
      <input v-model="importPlan.title" class="title-input" maxlength="30" />
      <scroll-view scroll-y class="phase-scroll">
        <view v-for="(phase, pi) in importPlan.phases" :key="pi" class="phase-block">
          <view class="phase-head">
            <text class="phase-no">阶段 {{ pi + 1 }}</text>
            <text class="phase-name">{{ phase.phase }}</text>
            <text v-if="phase.date" class="phase-date">{{ phase.date }}</text>
          </view>
          <view v-for="(task, ti) in phase.tasks || []" :key="ti" class="task-row">
            <text class="task-dot"></text>
            <text class="task-text">{{ task.text || task }}</text>
          </view>
          <text v-if="phase.check_standard" class="check-standard">达标要求：{{ phase.check_standard }}</text>
        </view>
      </scroll-view>
      <button class="btn btn-primary save-import" :disabled="savingImport" @click="saveImport">
        {{ savingImport ? '保存中…' : '确认并保存计划' }}
      </button>
    </view>
  </view>
</template>

<script setup>
import { ref } from 'vue';
import { api } from '../../../utils/api.js';
import { toast } from '../../../utils/guard.js';
import { uploadFile } from '../../../utils/upload.js';

const converting = ref(false);
const importPlan = ref(null);
const savingImport = ref(false);

function pickCompetition(onPick) {
  return api.competitions().then((comps) => {
    if (!comps?.length) return toast('暂无可生成计划的竞赛');
    uni.showActionSheet({
      itemList: comps.map((c) => c.name).slice(0, 30),
      success: (res) => onPick(comps[res.tapIndex]),
    });
  });
}
function startAi(kind) {
  pickCompetition((comp) => {
    if (kind === 'dialog') {
      uni.navigateTo({
        url: `/packagePlan/pages/planchat/main?mode=schedule&comp_id=${comp.id}`
          + `&comp_name=${encodeURIComponent(comp.name)}`,
      });
      return;
    }
    generateOneClick(comp);
  });
}
async function generateOneClick(comp) {
  uni.showLoading({ title: 'AI 编写中…', mask: true });
  try {
    await api.scheduleAdd(comp.id);
    uni.hideLoading();
    toast('计划已生成', 'success');
    setTimeout(() => uni.navigateBack(), 350);
  } catch (e) {
    uni.hideLoading();
  }
}
function openManual() {
  uni.navigateTo({ url: '/packagePlan/pages/schedule/edit' });
}
function chooseImportFile() {
  uni.chooseMessageFile({
    count: 1,
    type: 'file',
    extension: ['docx', 'pdf', 'xls', 'xlsx', 'md', 'txt'],
    success: async (res) => {
      const file = res.tempFiles?.[0];
      if (!file) return;
      converting.value = true;
      uni.showLoading({ title: 'AI 读取文档…', mask: true });
      try {
        const out = await uploadFile('/import/plan', file.path || file.tempFilePath, {
          formData: { mode: 'schedule', filename: file.name || '导入计划.docx' },
          timeout: 300000,
        });
        if (!out?.plan?.phases?.length) throw new Error('文档中未识别到有效计划');
        importPlan.value = out.plan;
      } catch (e) {
        toast(e.message || '计划导入失败');
      } finally {
        converting.value = false;
        uni.hideLoading();
      }
    },
  });
}
function resetImport() {
  importPlan.value = null;
}
async function saveImport() {
  const p = importPlan.value;
  if (!p) return;
  if (!String(p.title || '').trim()) return toast('请填写计划标题');
  if (!p.phases?.length) return toast('计划没有有效阶段');
  savingImport.value = true;
  try {
    await api.scheduleManual({
      title: String(p.title).trim(),
      comp_id: null,
      phases: p.phases,
    });
    toast('计划已保存', 'success');
    setTimeout(() => uni.navigateBack(), 350);
  } finally {
    savingImport.value = false;
  }
}
</script>

<style lang="scss" scoped>
.writer-page {
  min-height: 100vh;
  box-sizing: border-box;
  padding: 28rpx 24rpx calc(40rpx + env(safe-area-inset-bottom));
  background: #f6f8fb;
}
.writer-head { padding: 4rpx 6rpx 28rpx; }
.writer-title { display: block; color: #0f172a; font-size: 38rpx; font-weight: 800; }
.writer-sub { display: block; margin-top: 10rpx; color: #64748b; font-size: 24rpx; }
.mode-list {
  overflow: hidden;
  border: 1rpx solid #e5eaf1;
  border-radius: 18rpx;
  background: #fff;
}
.mode-item {
  display: flex;
  align-items: center;
  gap: 20rpx;
  padding: 26rpx 24rpx;
  border-bottom: 1rpx solid #edf1f6;
}
.mode-item:last-child { border-bottom: 0; }
.mode-icon {
  width: 72rpx;
  height: 72rpx;
  flex-shrink: 0;
  border-radius: 16rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 34rpx;
}
.mode-icon.ai { background: #ecfdf5; }
.mode-icon.manual { background: #eff6ff; }
.mode-icon.import { background: #fff7ed; }
.mode-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 7rpx; }
.mode-title { color: #1e293b; font-size: 28rpx; font-weight: 700; }
.mode-desc { color: #64748b; font-size: 22rpx; line-height: 1.5; }
.mode-arrow { color: #cbd5e1; font-size: 38rpx; flex-shrink: 0; }
.convert-state {
  margin-top: 24rpx;
  min-height: 420rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18rpx;
  color: #64748b;
}
.loading-ring {
  width: 44rpx;
  height: 44rpx;
  border: 5rpx solid #dbe4ef;
  border-top-color: #2563eb;
  border-radius: 50%;
  animation: spin .8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.convert-title { color: #334155; font-size: 28rpx; font-weight: 700; }
.convert-desc { font-size: 23rpx; color: #94a3b8; }
.import-preview {
  padding: 26rpx;
  border: 1rpx solid #e5eaf1;
  border-radius: 18rpx;
  background: #fff;
}
.preview-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 22rpx; }
.preview-title { color: #1e293b; font-size: 30rpx; font-weight: 800; }
.preview-reset { color: #2563eb; font-size: 23rpx; }
.field-label { display: block; margin-bottom: 10rpx; color: #64748b; font-size: 23rpx; }
.title-input {
  height: 76rpx;
  box-sizing: border-box;
  padding: 0 18rpx;
  margin-bottom: 20rpx;
  border: 1rpx solid #e2e8f0;
  border-radius: 12rpx;
  background: #f8fafc;
  color: #1e293b;
  font-size: 26rpx;
}
.phase-scroll { max-height: 54vh; }
.phase-block { padding: 18rpx 0; border-top: 1rpx solid #f1f5f9; }
.phase-head { display: flex; align-items: center; gap: 10rpx; flex-wrap: wrap; margin-bottom: 10rpx; }
.phase-no { color: #2563eb; font-size: 21rpx; font-weight: 700; }
.phase-name { color: #334155; font-size: 26rpx; font-weight: 700; }
.phase-date { margin-left: auto; color: #94a3b8; font-size: 21rpx; }
.task-row { display: flex; align-items: flex-start; gap: 12rpx; padding: 7rpx 0; }
.task-dot { width: 8rpx; height: 8rpx; margin-top: 15rpx; flex-shrink: 0; border-radius: 50%; background: #93c5fd; }
.task-text { flex: 1; color: #475569; font-size: 24rpx; line-height: 1.6; }
.check-standard { display: block; margin-top: 10rpx; color: #b45309; font-size: 22rpx; line-height: 1.5; }
.save-import { height: 84rpx; margin-top: 22rpx; font-size: 28rpx; border-radius: 14rpx; }
</style>
