<script>
// 普通 script 块：具名导出工具（<script setup> 不允许 export）
// attachments 库存储为 JSON 字符串（如 "[]"）——统一归一为数组，调用方也能 import 复用
export const normAtts = (a) => {
  if (Array.isArray(a)) return a;
  if (typeof a === 'string') { try { const p = JSON.parse(a); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
};
</script>

<script setup>
// 附件渲染：图片全屏预览、音视频内联播放、Word/Excel 弹窗预览、其他文件下载
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { openImage } from '../../utils/imageViewer.js';
import OfficePreview, { officePreviewType } from '../common/OfficePreview.vue';
import { api } from '../../api.js';

const props = defineProps({
  attachments: { type: [Array, String], default: () => [] },
  teamId: { type: Number, default: 0 },
  logId: { type: Number, default: 0 },
});
const remoteAtts = ref(null);
const fetching = ref(false);
const atts = computed(() => remoteAtts.value || normAtts(props.attachments));
const imageEntries = computed(() =>
  atts.value.map((att, index) => ({ att, index })).filter((x) => is(x.att, 'image/')));
watch(() => [props.logId, props.attachments], () => { remoteAtts.value = null; });

// 条目两种形态：base64 内嵌（data）/ 引用型公开分享链接（url，我的资源引用）
const src = (a) => (a.data ? `data:${a.mime || 'application/octet-stream'};base64,${a.data}` : a.url || '');
const is = (a, prefix) => (a.mime || '').startsWith(prefix);
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : (n || 0) + ' B');
const hasPayload = (a) => !!src(a);
async function ensureFullAttachments() {
  if (remoteAtts.value) return remoteAtts.value;
  if (!props.teamId || !props.logId) return atts.value;
  if (fetching.value) return atts.value;
  fetching.value = true;
  try {
    const rows = await api.teamCheckinLogsByIds(props.teamId, [props.logId]);
    remoteAtts.value = normAtts(rows?.[0]?.attachments);
    return remoteAtts.value;
  } catch (e) {
    ElMessage.error(`附件加载失败：${e.message}`);
    return atts.value;
  } finally {
    fetching.value = false;
  }
}
function fullAtt(list, index, att) {
  return list?.[index] || list?.find((x) => x.name === att.name) || att;
}
async function openImageAtt(entry) {
  let att = entry.att;
  if (!hasPayload(att)) att = fullAtt(await ensureFullAttachments(), entry.index, att);
  if (!hasPayload(att)) return ElMessage.warning('图片附件内容加载失败');
  openImage(src(att), att.name);
}
async function openFileAtt(att, index) {
  let full = att;
  if (!hasPayload(full)) full = fullAtt(await ensureFullAttachments(), index, full);
  if (!hasPayload(full)) return ElMessage.warning('附件内容加载失败');
  if (canPreviewOfficeAtt(full)) return openOfficeAtt(full);
  if (full.url && !full.data) {
    window.open(full.url, '_blank', 'noopener');
    return;
  }
  const a = document.createElement('a');
  a.href = src(full);
  a.download = full.name || '附件';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const officeDlg = ref(false);
const officeAtt = ref(null);
const officeBlob = ref(null);
const officeLoading = ref(false);
const officeError = ref('');
function isSameOriginUrl(u) {
  try { return new URL(u, window.location.origin).origin === window.location.origin; }
  catch { return false; }
}
function canPreviewOfficeAtt(a) {
  return !!officePreviewType(a.name, a.mime) && (!!a.data || isSameOriginUrl(a.url || ''));
}
async function openOfficeAtt(a) {
  officeAtt.value = a;
  officeBlob.value = null;
  officeError.value = '';
  officeLoading.value = true;
  officeDlg.value = true;
  try {
    const res = await fetch(src(a));
    if (!res.ok) throw new Error(`读取失败（${res.status}）`);
    const b = await res.blob();
    officeBlob.value = a.mime ? new Blob([b], { type: a.mime }) : b;
  } catch (e) {
    officeError.value = e.message;
    ElMessage.error(e.message);
  } finally {
    officeLoading.value = false;
  }
}
function resetOfficeAtt() {
  officeAtt.value = null;
  officeBlob.value = null;
  officeError.value = '';
  officeLoading.value = false;
}
</script>

<template>
  <div class="att-list">
    <!-- 图片：缩略图网格，点击全屏预览 -->
    <div v-if="imageEntries.length" class="att-imgs">
      <div v-for="entry in imageEntries" :key="entry.index" class="att-thumb"
        :class="{ 'is-lazy': !hasPayload(entry.att) }"
        @click="openImageAtt(entry)" title="点击预览 / 下载">
        <img v-if="hasPayload(entry.att)" :src="src(entry.att)" :alt="entry.att.name" loading="lazy" />
        <span v-else class="att-lazy"><b>图片附件</b><em>{{ entry.att.name }}</em></span>
        <span class="att-zoom">🔍</span>
      </div>
    </div>
    <!-- 视频 / 音频 / 文件 -->
    <template v-for="(a, i) in atts" :key="i">
      <video v-if="is(a, 'video/') && hasPayload(a)" class="att-media" :src="src(a)" controls preload="metadata" />
      <audio v-else-if="is(a, 'audio/') && hasPayload(a)" class="att-audio" :src="src(a)" controls preload="metadata" />
      <a v-else-if="canPreviewOfficeAtt(a)" class="att-file" href="#" :title="`预览 ${a.name}`"
        @click.prevent="openOfficeAtt(a)">
        📄 {{ a.name }} <span class="att-size">{{ fmtSize(a.size) }}</span> 👁
      </a>
      <a v-else-if="!is(a, 'image/')" class="att-file" :href="src(a) || '#'" :title="a.name"
        @click.prevent="openFileAtt(a, i)">
        📄 {{ a.name }} <span class="att-size">{{ fmtSize(a.size) }}</span> ⬇
      </a>
    </template>

    <el-dialog
      v-model="officeDlg"
      :title="officeAtt?.name || 'Office 预览'"
      width="92vw"
      top="3vh"
      append-to-body
      destroy-on-close
      class="att-office-dlg"
      :close-on-click-modal="false"
      @closed="resetOfficeAtt"
    >
      <OfficePreview
        v-if="officeAtt"
        :name="officeAtt.name"
        :blob="officeBlob"
        :loading="officeLoading"
        :error="officeError"
        height="72vh"
      />
    </el-dialog>
  </div>
</template>

<style lang="scss" scoped>
.att-list { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; align-items: flex-start;
  .att-imgs { display: flex; flex-wrap: wrap; gap: 8px;
    .att-thumb {
      position: relative; width: 160px; height: 110px; border-radius: 8px; overflow: hidden;
      border: 1px solid var(--border); cursor: zoom-in; background: var(--surface-2);
      img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform 0.2s ease; }
      &.is-lazy { cursor: pointer; }
      .att-lazy {
        position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 6px; padding: 12px; color: var(--text-2); text-align: center;
        b { color: var(--text); font-size: 13px; }
        em { max-width: 100%; font-size: 11px; font-style: normal; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      }
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
    font-size: 13px; color: var(--primary); text-decoration: none; background: var(--primary-tint);
    border: 1px solid color-mix(in srgb, var(--primary) 30%, white); border-radius: 8px; padding: 5px 10px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; /* 文件名不换行：过长省略 + title 全名 */
    &:hover { background: var(--primary-tint); }
    .att-size { color: #94a3b8; font-size: 11.5px; margin-left: 4px; }
  }
}
</style>
