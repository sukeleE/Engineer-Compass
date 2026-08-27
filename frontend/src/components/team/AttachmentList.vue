<script setup>
// 附件渲染：图片→可点击缩略图（点开全屏预览+下载）、视频/音频内联播放、其他文件下载链接
import { openImage } from '../../utils/imageViewer.js';

defineProps({ attachments: { type: Array, default: () => [] } });

// 条目两种形态：base64 内嵌（data）/ 引用型公开分享链接（url，我的资源引用）
const src = (a) => (a.data ? `data:${a.mime || 'application/octet-stream'};base64,${a.data}` : a.url || '');
const is = (a, prefix) => (a.mime || '').startsWith(prefix);
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : (n || 0) + ' B');
</script>

<template>
  <div class="att-list">
    <!-- 图片：缩略图网格，点击全屏预览 -->
    <div v-if="attachments.some((a) => is(a, 'image/'))" class="att-imgs">
      <div v-for="(a, i) in attachments.filter((x) => is(x, 'image/'))" :key="i" class="att-thumb"
        @click="openImage(src(a), a.name)" title="点击预览 / 下载">
        <img :src="src(a)" :alt="a.name" loading="lazy" />
        <span class="att-zoom">🔍</span>
      </div>
    </div>
    <!-- 视频 / 音频 / 文件 -->
    <template v-for="(a, i) in attachments" :key="i">
      <video v-if="is(a, 'video/')" class="att-media" :src="src(a)" controls preload="metadata" />
      <audio v-else-if="is(a, 'audio/')" class="att-audio" :src="src(a)" controls preload="metadata" />
      <a v-else-if="!is(a, 'image/')" class="att-file" :href="src(a)" :download="a.name" :title="a.name">
        📄 {{ a.name }} <span class="att-size">{{ fmtSize(a.size) }}</span> ⬇
      </a>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.att-list { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; align-items: flex-start;
  .att-imgs { display: flex; flex-wrap: wrap; gap: 8px;
    .att-thumb {
      position: relative; width: 160px; height: 110px; border-radius: 8px; overflow: hidden;
      border: 1px solid var(--border); cursor: zoom-in; background: #f1f5f9;
      img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform 0.2s ease; }
      &:hover img { transform: scale(1.08); }
      .att-zoom {
        position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
        background: rgba(15, 23, 42, 0.35); color: #fff; font-size: 18px; opacity: 0;
        transition: opacity 0.2s ease;
      }
      &:hover .att-zoom { opacity: 1; }
    }
  }
  .att-media { max-width: 100%; max-height: 320px; border-radius: 8px; }
  .att-audio { width: 100%; max-width: 320px; }
  .att-file {
    display: inline-block; max-width: 100%; vertical-align: middle;
    font-size: 13px; color: #2563eb; text-decoration: none; background: #eff6ff;
    border: 1px solid #bfdbfe; border-radius: 8px; padding: 5px 10px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; /* 文件名不换行：过长省略 + title 全名 */
    &:hover { background: #dbeafe; }
    .att-size { color: #94a3b8; font-size: 11.5px; margin-left: 4px; }
  }
}
</style>
