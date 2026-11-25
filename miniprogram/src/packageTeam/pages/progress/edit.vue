<template>
  <view class="editor-page">
    <view v-if="loading" class="loading-state">
      <view class="loading-dot"></view>
      <text>加载汇报内容…</text>
    </view>

    <template v-else>
      <view class="editor-head">
        <view>
          <text class="editor-title">{{ logId ? '修改进度汇报' : '提交进度汇报' }}</text>
          <text class="editor-team">{{ teamName || '小组进度' }}</text>
        </view>
        <text class="editor-mode">自由汇报</text>
      </view>

      <view class="field-section">
        <view class="field-head">
          <text class="field-label">本期进展</text>
          <text class="field-count">{{ content.length }} / 3000</text>
        </view>
        <textarea
          v-model="content"
          class="editor-textarea"
          maxlength="3000"
          auto-height
          placeholder="记录本期完成内容、遇到的问题与下一步计划"
        />
      </view>

      <view class="field-section">
        <view class="field-head">
          <text class="field-label">附件</text>
          <text class="field-count">{{ attachments.length }} 个</text>
        </view>
        <view v-if="imageEntries.length" class="image-grid">
          <view v-for="e in imageEntries" :key="'img' + e.idx" class="image-item">
            <image :src="e.src" mode="aspectFill" @click="previewImage(e.src)" />
            <text class="remove-badge" @click.stop="removeAttachment(e.idx)">×</text>
          </view>
        </view>
        <view v-for="e in fileEntries" :key="'file' + e.idx" class="file-item">
          <text class="file-icon">{{ fileIcon(e.att) }}</text>
          <view class="file-main" @click="previewFile(e.att)">
            <text class="file-name">{{ e.att.name || '附件' }}</text>
            <text class="file-size">{{ fmtSize(e.att.size) }}</text>
          </view>
          <text class="file-remove" @click="removeAttachment(e.idx)">移除</text>
        </view>
        <view class="attach-actions">
          <button class="attach-btn" @click="addImages">＋ 图片</button>
          <button class="attach-btn" @click="addFile">＋ Word / PDF 等文件</button>
        </view>
      </view>
    </template>

    <view class="bottom-space"></view>
    <view class="editor-actions">
      <button class="cancel-btn" @click="goBack">取消</button>
      <button class="submit-btn" :disabled="saving || loading || !canSubmit" @click="submit">
        {{ saving ? '提交中…' : (logId ? '保存修改' : '提交汇报') }}
      </button>
    </view>
  </view>
</template>

<script setup>
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { onLoad, onUnload } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { toast } from '../../../utils/guard.js';
import { chooseImageAsBase64, chooseFileAsBase64, isImage } from '../../../utils/fileBase64.js';
import { previewAttachment, inlineImageUrl, authedUrl } from '../../../utils/preview.js';

const teamId = ref(0);
const logId = ref(0);
const detail = ref(null);
const content = ref('');
const attachments = ref([]);
const loading = ref(true);
const saving = ref(false);
let draftTimer = null;
let submitted = false;

const teamName = computed(() => detail.value?.team?.name || '');
const canSubmit = computed(() => {
  const me = detail.value?.me;
  const perms = detail.value?.perms;
  return !me || me.is_owner || perms?.progress;
});
const imageEntries = computed(() => attachments.value
  .map((att, idx) => ({ att, idx, src: inlineImageUrl(att) || authedUrl(att.url || '') }))
  .filter((e) => isImage(e.att) && e.src));
const fileEntries = computed(() => attachments.value
  .map((att, idx) => ({ att, idx }))
  .filter((e) => !isImage(e.att) || !(inlineImageUrl(e.att) || authedUrl(e.att.url || ''))));

function draftKey() {
  return `ec_progress_draft_${teamId.value}`;
}
function clearDraftTimer() {
  clearTimeout(draftTimer);
  draftTimer = null;
}
function saveDraft() {
  if (submitted || logId.value || !teamId.value) return;
  try { uni.setStorageSync(draftKey(), { content: content.value, at: Date.now() }); } catch { /* 存储不可用 */ }
}
function restoreDraft() {
  try {
    const saved = uni.getStorageSync(draftKey());
    if (saved?.content) content.value = String(saved.content);
  } catch { /* 忽略 */ }
}
function clearDraft() {
  try { uni.removeStorageSync(draftKey()); } catch { /* 忽略 */ }
}
watch(content, () => {
  if (logId.value) return;
  clearDraftTimer();
  draftTimer = setTimeout(saveDraft, 300);
});

function withTemp(att) {
  return { ...att, temp: inlineImageUrl(att) || authedUrl(att.url || '') };
}
function fmtSize(n) {
  const v = Number(n) || 0;
  if (v >= 1048576) return (v / 1048576).toFixed(1) + ' MB';
  if (v >= 1024) return Math.round(v / 1024) + ' KB';
  return v + ' B';
}
function fileIcon(att) {
  const name = String(att?.name || '').toLowerCase();
  const mime = String(att?.mime || '').toLowerCase();
  if (/\.(doc|docx)$/.test(name) || mime.includes('word')) return '📝';
  if (/\.(xls|xlsx|csv)$/.test(name) || mime.includes('sheet') || mime.includes('excel')) return '📊';
  if (/\.(ppt|pptx)$/.test(name) || mime.includes('presentation')) return '📽️';
  if (/\.pdf$/.test(name) || mime === 'application/pdf') return '📕';
  return '📎';
}

function totalBase64Size() {
  return attachments.value.reduce((sum, a) => sum + String(a.data || '').length, 0);
}
function ensureCapacity(nextLen) {
  if (totalBase64Size() + nextLen > 25 * 1024 * 1024) {
    toast('附件总量不能超过 25MB');
    return false;
  }
  return true;
}
async function addImages() {
  try {
    const att = await chooseImageAsBase64(7);
    if (!ensureCapacity(String(att.data || '').length)) return;
    attachments.value.push(withTemp(att));
  } catch { /* 用户取消 */ }
}
async function addFile() {
  try {
    const att = await chooseFileAsBase64(10);
    if (!ensureCapacity(String(att.data || '').length)) return;
    attachments.value.push(withTemp(att));
  } catch { /* 用户取消 */ }
}
function removeAttachment(idx) {
  attachments.value.splice(idx, 1);
}
function previewImage(src) {
  if (src) uni.previewImage({ urls: [src] });
}
function previewFile(att) {
  previewAttachment(att);
}

async function init() {
  loading.value = true;
  try {
    const jobs = [api.teamDetail(teamId.value)];
    if (logId.value) jobs.push(api.checkinLogsByIds(teamId.value, [logId.value]));
    const results = await Promise.allSettled(jobs);
    if (results[0].status === 'fulfilled') detail.value = results[0].value;
    if (results[0].status === 'rejected') throw results[0].reason;
    if (logId.value) {
      const row = results[1]?.status === 'fulfilled' ? results[1].value?.[0] : null;
      if (!row) throw new Error('汇报不存在或已删除');
      content.value = String(row.content || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .trim();
      attachments.value = (row.attachments || []).map(withTemp);
    } else {
      restoreDraft();
    }
    uni.setNavigationBarTitle({ title: logId.value ? '修改进度汇报' : '提交进度汇报' });
  } catch (e) {
    toast(e.message || '汇报加载失败');
    setTimeout(goBack, 800);
  } finally {
    loading.value = false;
  }
}

async function submit() {
  if (saving.value) return;
  if (!content.value.trim() && !attachments.value.length) return toast('请填写汇报内容或添加附件');
  if (!canSubmit.value) return toast('当前账号没有提交进度汇报的权限');
  saving.value = true;
  try {
    const card = {
      content: content.value.trim(),
      attachments: attachments.value.map(({ temp, ...rest }) => rest),
    };
    if (logId.value) await api.collabLogUpdate(teamId.value, logId.value, card);
    else await api.collabLogCreate(teamId.value, card);
    if (!logId.value) {
      submitted = true;
      clearDraft();
    }
    uni.$emit('team:progress:refresh', { teamId: teamId.value });
    toast(logId.value ? '汇报已更新' : '汇报已提交', 'success');
    setTimeout(goBack, 350);
  } catch (e) {
    toast(e.message || '提交失败');
  } finally {
    saving.value = false;
  }
}

function goBack() {
  uni.navigateBack({
    fail: () => uni.redirectTo({ url: '/packageTeam/pages/progress/main?id=' + teamId.value }),
  });
}

onLoad((options) => {
  teamId.value = Number(options.teamId || options.id);
  logId.value = Number(options.logId || 0);
  if (!teamId.value) {
    toast('缺少小组信息');
    setTimeout(goBack, 500);
    return;
  }
  init();
});
onUnload(() => {
  clearDraftTimer();
  if (!submitted) saveDraft();
});
onBeforeUnmount(clearDraftTimer);
</script>

<style lang="scss" scoped>
.editor-page {
  min-height: 100vh;
  box-sizing: border-box;
  padding: 24rpx 24rpx 0;
  background: #f6f8fb;
}
.loading-state {
  min-height: 60vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18rpx;
  color: #64748b;
  font-size: 25rpx;
}
.loading-dot {
  width: 34rpx;
  height: 34rpx;
  border: 4rpx solid #dbe4ef;
  border-top-color: #2563eb;
  border-radius: 50%;
  animation: spin .8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.editor-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20rpx;
  padding: 8rpx 4rpx 26rpx;
}
.editor-title {
  display: block;
  color: #0f172a;
  font-size: 38rpx;
  font-weight: 800;
}
.editor-team {
  display: block;
  margin-top: 8rpx;
  color: #64748b;
  font-size: 24rpx;
}
.editor-mode {
  flex-shrink: 0;
  padding: 8rpx 18rpx;
  border-radius: 999rpx;
  background: #e8f0ff;
  color: #2563eb;
  font-size: 22rpx;
}
.field-section {
  margin-bottom: 18rpx;
  padding: 26rpx 28rpx;
  border: 1rpx solid #e5eaf1;
  border-radius: 18rpx;
  background: #fff;
}
.field-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 18rpx;
}
.field-label {
  color: #1e293b;
  font-size: 27rpx;
  font-weight: 700;
}
.field-count {
  color: #94a3b8;
  font-size: 21rpx;
}
.editor-textarea {
  width: 100%;
  min-height: 300rpx;
  box-sizing: border-box;
  color: #1e293b;
  font-size: 27rpx;
  line-height: 1.75;
}
.image-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14rpx;
}
.image-item {
  position: relative;
  height: 190rpx;
  overflow: hidden;
  border-radius: 14rpx;
  background: #f1f5f9;
}
.image-item image {
  width: 100%;
  height: 100%;
}
.remove-badge {
  position: absolute;
  top: 8rpx;
  right: 8rpx;
  width: 38rpx;
  height: 38rpx;
  border-radius: 50%;
  background: rgba(15, 23, 42, .72);
  color: #fff;
  font-size: 26rpx;
  line-height: 36rpx;
  text-align: center;
}
.file-item {
  display: flex;
  align-items: center;
  gap: 16rpx;
  margin-top: 14rpx;
  padding: 18rpx;
  border-radius: 14rpx;
  background: #f8fafc;
}
.file-icon { font-size: 36rpx; }
.file-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4rpx;
}
.file-name {
  color: #1e293b;
  font-size: 25rpx;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-size { color: #94a3b8; font-size: 21rpx; }
.file-remove { color: #dc2626; font-size: 23rpx; }
.attach-actions {
  display: flex;
  gap: 14rpx;
  margin-top: 22rpx;
  flex-wrap: wrap;
}
.attach-btn {
  margin: 0;
  padding: 0 24rpx;
  height: 66rpx;
  line-height: 66rpx;
  border-radius: 12rpx;
  background: #eff6ff;
  color: #2563eb;
  font-size: 24rpx;
  font-weight: 600;
}
.attach-btn::after { border: none; }
.bottom-space { height: calc(150rpx + env(safe-area-inset-bottom)); }
.editor-actions {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 20;
  display: flex;
  gap: 18rpx;
  padding: 18rpx 24rpx calc(18rpx + env(safe-area-inset-bottom));
  border-top: 1rpx solid #e5eaf1;
  background: rgba(255, 255, 255, .97);
}
.cancel-btn,
.submit-btn {
  height: 84rpx;
  line-height: 84rpx;
  border-radius: 14rpx;
  font-size: 28rpx;
  font-weight: 700;
}
.cancel-btn {
  width: 190rpx;
  background: #f1f5f9;
  color: #475569;
}
.submit-btn {
  flex: 1;
  background: #2563eb;
  color: #fff;
}
.submit-btn[disabled] { opacity: .55; }
</style>
