<template>
  <view class="page-wrap">
    <view v-if="loggedIn" class="card quota-card">
      <view class="q-head">
        <text class="q-title">个人资源库</text>
        <button class="btn btn-primary btn-sm upload-btn" :disabled="uploading" @click="chooseAndUpload">{{ uploading ? '上传中…' : '＋ 上传文件' }}</button>
      </view>
      <view class="bar"><view class="bar-in" :style="{ width: quotaPercent + '%' }"></view></view>
      <view class="q-meta">已用 {{ sizeText(used) }} / {{ sizeText(quota) }}（{{ quotaPercent }}%）· 共 {{ total }} 个文件</view>
    </view>

    <EmptyState v-if="!loggedIn" icon="🔐" text="登录后可查看个人资源库" btn-text="去登录" @action="goLogin" />
    <EmptyState v-else-if="!loading && !list.length" icon="🗄" text="资源库还是空的，上传文件可生成分享链接或在发布帖子时引用" />

    <view v-for="f in list" :key="f.id" class="card file-row" @click="openFile(f)">
      <text class="file-icon">{{ iconOf(f) }}</text>
      <view class="file-main">
        <text class="file-name ellipsis">{{ f.file_name }}</text>
        <text class="file-size">{{ sizeText(f.file_size) }} · {{ String(f.create_time).slice(5, 16) }}<text v-if="f.shared" class="shared-tag">已分享</text></text>
      </view>
      <text class="file-open" @click.stop="fileActions(f)">管理</text>
    </view>

    <LoadMore v-if="list.length" :loading="loading" :finished="finished" @more="loadMore" />
  </view>
</template>

<script setup>
import { ref, computed } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { toast, confirm, ensureLogin } from '../../../utils/guard.js';
import { isLoggedIn } from '../../../utils/auth.js';
import { uploadFile, chooseImage } from '../../../utils/upload.js';
import { previewFile, absoluteUrl } from '../../../utils/preview.js';
import EmptyState from '../../../components/EmptyState.vue';
import LoadMore from '../../../components/LoadMore.vue';

const list = ref([]);
const loading = ref(false);
const uploading = ref(false);
const page = ref(1);
const size = 20;
const total = ref(0);
const used = ref(0);
const quota = ref(1073741824);
const finished = computed(() => list.value.length >= total.value);
const loggedIn = computed(() => isLoggedIn());
function goLogin() { uni.navigateTo({ url: '/pages/login/main' }); }
const quotaPercent = computed(() => (quota.value ? Math.min(100, Math.round((used.value / quota.value) * 100)) : 0));

function sizeText(n) {
  const v = Number(n) || 0;
  if (v >= 1073741824) return (v / 1073741824).toFixed(2) + ' GB';
  if (v >= 1048576) return (v / 1048576).toFixed(1) + ' MB';
  if (v >= 1024) return Math.round(v / 1024) + ' KB';
  return v + ' B';
}
function iconOf(f) {
  const name = String(f.file_name || '').toLowerCase();
  const mime = String(f.file_type || '');
  if (mime.indexOf('image/') === 0 || /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(name)) return '🖼';
  if (/\.pdf$/.test(name)) return '📕';
  if (/\.(docx?|wps)$/.test(name)) return '📘';
  if (/\.(xlsx?|csv|et)$/.test(name)) return '📗';
  if (/\.(pptx?|dps)$/.test(name)) return '📙';
  if (/\.(zip|rar|7z|tar|gz)$/.test(name)) return '🗜';
  if (/\.(mp4|mov|avi|mkv|mp3|wav|flac)$/.test(name)) return '🎬';
  return '📄';
}

async function load(reset) {
  if (reset) { page.value = 1; list.value = []; }
  loading.value = true;
  try {
    const r = await api.resourceList({ page: page.value, size });
    total.value = r.total || 0;
    used.value = r.used || 0;
    quota.value = r.quota || 1073741824;
    list.value = list.value.concat(r.list || []);
  } finally {
    loading.value = false;
  }
}
function loadMore() {
  if (finished.value || loading.value) return;
  page.value += 1;
  load(false);
}

function chooseAndUpload() {
  if (!ensureLogin('登录后才能上传个人资源')) return;
  uni.showActionSheet({
    itemList: ['图片（拍照 / 相册）', '聊天文件（任意类型，≤128MB）'],
    success: (m) => {
      if (m.tapIndex === 0) {
        chooseImage(false).then((filePath) => doUpload(filePath)).catch(() => {});
      } else {
        uni.chooseMessageFile({
          count: 1,
          type: 'file',
          success: (r) => doUpload(r.tempFiles[0].path),
        });
      }
    },
  });
}
async function doUpload(filePath) {
  uploading.value = true;
  uni.showLoading({ title: '上传中…', mask: true });
  try {
    await uploadFile('/resource/upload', filePath, { name: 'file' });
    uni.hideLoading();
    toast('上传成功', 'success');
    load(true);
  } catch (e) {
    uni.hideLoading();
  } finally {
    uploading.value = false;
  }
}

function openFile(f) {
  previewFile('/api/resource/' + f.id + '/download', f.file_name);
}
function fileActions(f) {
  const items = f.shared ? ['打开 / 预览', '复制分享链接', '撤销分享', '删除文件'] : ['打开 / 预览', '生成分享链接', '删除文件'];
  uni.showActionSheet({
    itemList: items,
    success: async (m) => {
      const idx = m.tapIndex;
      if (idx === 0) return openFile(f);
      if (items[idx].indexOf('分享链接') >= 0) return makeShare(f);
      if (items[idx] === '撤销分享') return unshare(f);
      if (items[idx] === '删除文件') return remove(f);
    },
  });
}
async function makeShare(f) {
  const r = await api.resourceShare(f.id, {});
  const full = /^https?:/i.test(r.url) ? r.url : absoluteUrl(r.url);
  uni.setClipboardData({
    data: full,
    success: () => toast((r.mode === 'feishu' ? '飞书链接已复制' : '站内分享链接已复制'), 'success'),
  });
  load(true);
}
async function unshare(f) {
  if (!(await confirm('撤销「' + f.file_name + '」的分享链接？旧链接将立即失效。'))) return;
  await api.resourceUnshare(f.id);
  toast('分享已撤销', 'success');
  load(true);
}
async function remove(f) {
  if (!(await confirm('删除文件「' + f.file_name + '」？此操作不可恢复。', '高危操作'))) return;
  await api.resourceDelete(f.id);
  toast('已删除', 'success');
  load(true);
}

onShow(() => { if (isLoggedIn()) load(true); });
</script>

<style lang="scss" scoped>
.quota-card { padding: 24rpx 28rpx; }
.q-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16rpx; }
.q-title { font-size: 30rpx; font-weight: 800; color: #1e293b; }
.upload-btn { width: 200rpx; height: 68rpx; font-size: 25rpx; }
.bar { height: 14rpx; background: #f1f5f9; border-radius: 8rpx; overflow: hidden; }
.bar-in { height: 100%; background: linear-gradient(90deg, #2563eb, #60a5fa); border-radius: 8rpx; transition: width .3s; }
.q-meta { font-size: 22rpx; color: #94a3b8; margin-top: 12rpx; }
.file-row { display: flex; align-items: center; gap: 16rpx; }
.file-icon { font-size: 42rpx; }
.file-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6rpx; }
.file-name { font-size: 27rpx; color: #1e293b; font-weight: 600; }
.file-size { font-size: 22rpx; color: #94a3b8; }
.shared-tag { display: inline-block; background: #ecfdf5; color: #059669; font-size: 20rpx; border-radius: 8rpx; padding: 2rpx 12rpx; margin-left: 10rpx; }
.file-open { flex: none; font-size: 24rpx; color: #2563eb; background: #eff6ff; border-radius: 24rpx; padding: 8rpx 22rpx; }
</style>
