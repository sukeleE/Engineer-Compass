<template>
  <view class="page-wrap" v-if="detail">
    <button v-if="detail.perms.file_upload" class="btn btn-primary btn-block" @click="choose">＋ 上传文件（≤20MB）</button>
    <view v-if="loading" class="empty"><view class="empty-text">加载中…</view></view>
    <EmptyState v-else-if="!files.length" icon="📁" text="暂无小组文件" />
    <view v-for="f in files" :key="f.id" class="card file-row">
      <view class="file-main" @click="open(f)">
        <text class="file-icon">{{ iconOf(f.file_name) }}</text>
        <view class="file-info">
          <text class="file-name ellipsis">{{ f.file_name }}</text>
          <text class="file-meta">{{ uploaderName(f) }} · {{ sizeOf(f.file_size) }} · {{ f.create_time }}</text>
        </view>
      </view>
      <view class="file-ops">
        <view class="mini-btn" @click="open(f)">预览</view>
        <view v-if="detail.perms.file_delete && !f.external_url" class="mini-btn danger" @click="remove(f)">删除</view>
      </view>
    </view>
  </view>
  <view v-else class="empty"><view class="empty-text">加载中…</view></view>

  <view v-if="textOpen" class="modal-mask" @click="textOpen = false">
    <view class="modal modal-lg" @click.stop>
      <view class="modal-title ellipsis">{{ textTitle }}</view>
      <scroll-view scroll-y class="text-scroll">
        <text class="text-content">{{ textContent }}</text>
      </scroll-view>
      <button class="btn btn-ghost btn-block" @click="textOpen = false">关闭</button>
    </view>
  </view>
</template>

<script setup>
import { ref } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { confirm, toast } from '../../../utils/guard.js';
import { previewFile, openExternal } from '../../../utils/preview.js';
import EmptyState from '../../../components/EmptyState.vue';
import { teamDisplayName } from '../../../utils/displayName.js';

const id = ref(null);
const detail = ref(null);
const files = ref([]);
const loading = ref(true);

function uploaderName(f) { return teamDisplayName(f, detail.value?.members || [], 'uploader') || f.uploader || '成员'; }
async function load() {
  detail.value = await api.teamDetail(id.value);
  files.value = await api.collabFiles(id.value);
  loading.value = false;
}

function choose() {
  uni.chooseMessageFile({
    count: 1,
    type: 'file',
    success: (res) => {
      const f = res.tempFiles[0];
      if (f.size > 20 * 1024 * 1024) return toast('文件超过 20MB 限制');
      upload(f);
    },
    fail: () => toast('仅支持从微信聊天记录选择文件，可先把文件发到微信'),
  });
}

function upload(f) {
  uni.showLoading({ title: '读取文件…', mask: true });
  uni.getFileSystemManager().readFile({
    filePath: f.path,
    encoding: 'base64',
    success: async (r) => {
      uni.showLoading({ title: '上传中…', mask: true });
      try {
        await api.collabFileCreate(id.value, { file_name: f.name, file_type: '', data: r.data });
        uni.hideLoading();
        toast('上传成功', 'success');
        load();
      } catch (e) {
        uni.hideLoading();
      }
    },
    fail: () => { uni.hideLoading(); toast('文件读取失败'); },
  });
}

const TEXT_EXTS = ['txt', 'md', 'markdown', 'html', 'htm', 'json', 'log', 'js', 'ts', 'vue', 'css', 'scss', 'yml', 'yaml', 'xml'];
const textOpen = ref(false);
const textTitle = ref('');
const textContent = ref('');
function isTextFile(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  return TEXT_EXTS.indexOf(ext) >= 0;
}
async function open(f) {
  if (f.external_url) return openExternal(f.external_url);
  if (isTextFile(f.file_name) && !f.share_url) {
    try {
      const r = await api.collabFileText(f.id);
      textTitle.value = r.file_name;
      textContent.value = r.content || '（空文件）';
      textOpen.value = true;
      return;
    } catch (e) { /* 415 等情况回退到下载预览 */ }
  }
  if (f.share_url) return previewFile(f.share_url, f.file_name);
  previewFile('/api/team/file/' + f.id + '/download', f.file_name);
}

async function remove(f) {
  if (!(await confirm('删除该文件？'))) return;
  await api.collabFileDelete(id.value, f.id);
  load();
}

function iconOf(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return '🖼️';
  if (['pdf'].includes(ext)) return '📕';
  if (['doc', 'docx'].includes(ext)) return '📘';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📗';
  if (['ppt', 'pptx'].includes(ext)) return '📙';
  if (['zip', 'rar', '7z'].includes(ext)) return '🗜️';
  return '📄';
}
function sizeOf(n) {
  if (!n) return '0B';
  if (n < 1024) return n + 'B';
  if (n < 1048576) return (n / 1024).toFixed(1) + 'KB';
  return (n / 1048576).toFixed(1) + 'MB';
}

onLoad((o) => { id.value = Number(o.id); });
onShow(() => { if (id.value) load(); });
</script>

<style lang="scss" scoped>
.file-row { display: flex; align-items: center; justify-content: space-between; gap: 14rpx; padding: 22rpx 28rpx; }
.file-main { display: flex; align-items: center; gap: 16rpx; flex: 1; min-width: 0; }
.file-icon { font-size: 48rpx; }
.file-info { flex: 1; min-width: 0; }
.file-name { font-size: 27rpx; font-weight: 600; color: #1e293b; display: block; }
.file-meta { font-size: 22rpx; color: #94a3b8; display: block; margin-top: 6rpx; }
.file-ops { display: flex; gap: 10rpx; flex-shrink: 0; }
.mini-btn { background: #eff6ff; color: #2563eb; font-size: 23rpx; border-radius: 24rpx; padding: 8rpx 22rpx; }
.mini-btn.danger { background: #fee2e2; color: #ef4444; }
.modal-mask { position: fixed; inset: 0; background: rgba(15,23,42,.45); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { width: 660rpx; background: #fff; border-radius: 24rpx; padding: 32rpx; }
.modal-lg { max-height: 82vh; display: flex; flex-direction: column; }
.modal-title { font-size: 30rpx; font-weight: 700; margin-bottom: 16rpx; }
.text-scroll { max-height: 60vh; background: #f8fafc; border-radius: 12rpx; padding: 20rpx; margin-bottom: 18rpx; }
.text-content { font-size: 25rpx; color: #334155; line-height: 1.7; white-space: pre-wrap; word-break: break-all; }
</style>