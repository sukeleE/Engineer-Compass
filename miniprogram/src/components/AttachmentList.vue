<template>
  <view v-if="atts.length" class="al-wrap">
    <!-- 图片：缩略图网格，点击全屏预览 -->
    <view v-if="imageEntries.length" class="al-imgs">
      <image
        v-for="e in imageEntries"
        :key="e.idx"
        :src="e.src"
        class="al-img"
        mode="aspectFill"
        @click="previewImageAt(e.idx)"
      />
    </view>
    <!-- 非图片附件（Word/Excel/PDF/压缩包等）：文件行，点击下载或打开 -->
    <view v-for="e in fileEntries" :key="'f' + e.idx" class="al-file" @click="openFile(e.att)">
      <text class="al-icon">{{ iconOf(e.att) }}</text>
      <view class="al-meta">
        <text class="al-name">{{ e.att.name || '附件' }}</text>
        <text v-if="e.att.size" class="al-size">{{ fmtSize(e.att.size) }}</text>
      </view>
      <text class="al-open">打开</text>
    </view>
  </view>
</template>

<script setup>
import { computed } from 'vue';
import { isImage } from '../utils/fileBase64.js';
import { previewAttachment, authedUrl, inlineImageUrl } from '../utils/preview.js';

const props = defineProps({
  attachments: { type: Array, default: () => [] },
  hideImages: { type: Boolean, default: false },
});

const atts = computed(() => (Array.isArray(props.attachments) ? props.attachments : []));
const imageEntries = computed(() => {
  if (props.hideImages) return [];
  const out = [];
  atts.value.forEach((a, idx) => {
    if (isImage(a)) out.push({ idx, src: inlineImageUrl(a) || authedUrl(a.url || '') });
  });
  return out;
});
const fileEntries = computed(() => {
  const out = [];
  atts.value.forEach((a, idx) => {
    if (!isImage(a)) out.push({ idx, att: a });
  });
  return out;
});
function previewImageAt(idx) {
  const urls = imageEntries.value.map((e) => e.src);
  const cur = imageEntries.value.find((e) => e.idx === idx);
  uni.previewImage({ urls, current: cur ? cur.src : urls[0] });
}
function openFile(a) {
  previewAttachment(a);
}
function fmtSize(n) {
  const v = Number(n) || 0;
  if (v >= 1048576) return (v / 1048576).toFixed(1) + 'MB';
  if (v >= 1024) return Math.round(v / 1024) + 'KB';
  return v + 'B';
}
function iconOf(a) {
  const name = String(a.name || '').toLowerCase();
  const mime = String(a.mime || '').toLowerCase();
  if (/\.(doc|docx)$/.test(name) || mime.indexOf('word') !== -1) return '📝';
  if (/\.(xls|xlsx|csv)$/.test(name) || mime.indexOf('sheet') !== -1) return '📊';
  if (/\.(ppt|pptx)$/.test(name) || mime.indexOf('presentation') !== -1) return '📽️';
  if (/\.pdf$/.test(name) || mime === 'application/pdf') return '📕';
  if (/\.(zip|rar|7z|tar|gz)$/.test(name) || mime.indexOf('zip') !== -1 || mime.indexOf('compressed') !== -1) return '📦';
  if (/^audio\//.test(mime) || /\.(mp3|wav|m4a|aac|ogg)$/.test(name)) return '🎵';
  if (/^video\//.test(mime) || /\.(mp4|mov|avi|mkv)$/.test(name)) return '🎬';
  if (/\.(txt|md)$/.test(name) || mime.indexOf('text/') === 0) return '📃';
  return '📎';
}
</script>

<style lang="scss" scoped>
.al-wrap { margin-top: 14rpx; display: flex; flex-direction: column; gap: 12rpx; }
.al-imgs { display: flex; gap: 14rpx; flex-wrap: wrap; }
.al-img { width: 200rpx; height: 200rpx; border-radius: 12rpx; background: #f1f5f9; }
.al-file { display: flex; align-items: center; gap: 14rpx; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 14rpx; padding: 16rpx 20rpx; }
.al-icon { font-size: 40rpx; flex-shrink: 0; }
.al-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4rpx; }
.al-name { font-size: 26rpx; color: #1e293b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.al-size { font-size: 22rpx; color: #94a3b8; }
.al-open { font-size: 24rpx; color: #2563eb; background: #eff6ff; border-radius: 24rpx; padding: 8rpx 22rpx; flex-shrink: 0; }
</style>