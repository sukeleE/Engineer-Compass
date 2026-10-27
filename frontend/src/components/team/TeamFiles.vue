<script setup>
// 资料共享：上传（base64）/ 图片直接预览（点击放大）/ 下载 / 删除
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api } from '../../api.js';
import auth from '../../auth.js';
import { openImage } from '../../utils/imageViewer.js';
import ResourcePicker from '../ResourcePicker.vue';
import { fmtDateOnly } from '../../utils/time.js';
import { teamDisplayName } from '../../utils/displayName.js';

const router = useRouter();
// 点击上传者昵称 → 进入其公开主页（只读）；自己 → 我的管理界面
const toProfile = (f) => router.push(f.user_id === auth.user?.id ? '/me' : `/user/${f.user_id}`);

const props = defineProps({ teamId: Number, me: Object, perms: Object, members: Array });

const files = ref([]);
const uploading = ref(false);
const inputEl = ref(null);

const MAX = 20 * 1024 * 1024;
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');
const fmtType = (t) => {
  if (!t) return '📄';
  if (t.startsWith('image')) return '🖼️';
  if (t.includes('pdf')) return '📕';
  if (t.includes('zip') || t.includes('rar') || t.includes('7z')) return '🗜️';
  if (t.includes('word') || t.includes('doc')) return '📘';
  if (t.includes('excel') || t.includes('sheet')) return '📗';
  return '📄';
};
const isImg = (f) => (f.file_type || '').startsWith('image/');
const feishuKind = (f) => {
  const m = String(f.external_url || '').match(/(?:feishu\.cn|larksuite\.com)\/(docx|docs?|sheets?|slides|wiki|wikis|base|bitable|mindnotes|file|drive)/);
  return m?.[1] || '';
};
const feishuIcon = (f) => ({ docx: '📄', docs: '📄', doc: '📄', sheet: '📊', sheets: '📊', slides: '📽️', wiki: '📚', wikis: '📚', base: '🧮', bitable: '🧮', mindnotes: '🧠', drive: '📁' }[feishuKind(f)] || '🪶');
// 图片直连 URL：引用型（我的资源）直接走公开分享链接；本地上传走下载接口 ?token= 直连
const dlUrl = (f) => (f.share_url || `${api.teamFileDownload(f.id)}?token=${auth.token}`);
const preview = (f) => openImage(dlUrl(f), f.file_name);

// 从「我的资源」引用：不复制文件，生成分享链接后建引用行（撤销分享后组内即失效）
const resPickDlg = ref(false);
const refPicking = ref(false);
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
function ensureExt(name, ext) {
  const base = String(name || '未命名').trim();
  return new RegExp(`\\.${ext}$`, 'i').test(base) ? base : `${base}.${ext}`;
}
async function uploadFeishuBlob(blob, name, mime) {
  if (blob.size > MAX) throw new Error('文件超过小组资料 20MB 上限');
  await api.teamFileUpload(props.teamId, {
    file_name: name,
    file_type: mime || blob.type || '',
    data: await blobToBase64(blob),
  });
}
async function addFeishuLink(r) {
  await api.teamFileFeishuRef(props.teamId, {
    file_name: r.name,
    url: r.url,
    file_type: r.mime || '',
    file_size: r.size || 0,
  });
}
async function importFeishuPick(r) {
  if (r.feishu_type === 'docx' && r.token) {
    const d = await api.feishuDocContent(r.token, 'markdown');
    const blob = new Blob([d.content || ''], { type: 'text/markdown;charset=utf-8' });
    await uploadFeishuBlob(blob, ensureExt(r.name, 'md'), blob.type);
    return { mode: 'copy', label: '已导入为 Markdown 文档' };
  }
  if (r.feishu_type === 'file' && r.token) {
    const d = await api.feishuFileDownloadBlob(r.token);
    if (d.blob.size > MAX) {
      await addFeishuLink(r);
      return { mode: 'link-large', label: '原文件超过 20MB，已改为引用飞书链接' };
    }
    await uploadFeishuBlob(d.blob, r.name, d.blob.type);
    return { mode: 'copy', label: '已复制到小组资料' };
  }
  await addFeishuLink(r);
  return { mode: 'link', label: '该类型暂不支持复制，已引用飞书链接' };
}
async function onResourcePick(r) {
  refPicking.value = true;
  try {
    if (r.source === 'feishu' || r.url?.includes('feishu.cn') || r.url?.includes('larksuite.com')) {
      let result;
      try {
        result = await importFeishuPick(r);
      } catch (copyErr) {
        await addFeishuLink(r);
        result = { mode: 'link-fallback', label: `无法复制原文件（${copyErr.message}），已改为引用飞书链接` };
      }
      ElMessage.success(`「${r.name}」${result.label}`);
    } else {
      await api.teamFileRef(props.teamId, r.id);
      ElMessage.success(`已引用「${r.name}」`);
    }
    await load();
  } catch (e) { ElMessage.error(e.message); }
  finally { refPicking.value = false; }
}

async function load() {
  files.value = await api.teamFiles(props.teamId);
}

// 上传者角色（members 由 TeamDetail 传入，含 role_names 数组）
const roleNamesOf = (uid) => props.members?.find((x) => Number(x.id) === Number(uid))?.role_names || [];
const uploaderName = (f) => teamDisplayName(f, props.members, 'uploader');

async function pickFile(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > MAX) return ElMessage.warning(`文件超过 20MB 上限`);
  uploading.value = true;
  try {
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]); // 去 dataURL 前缀
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    await api.teamFileUpload(props.teamId, { file_name: file.name, file_type: file.type, data });
    ElMessage.success(`「${file.name}」已上传`);
    await load();
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    uploading.value = false;
  }
}

async function remove(f) {
  const canDel = f.user_id === props.me.user_id || props.perms.file_delete;
  if (!canDel) return ElMessage.warning('仅上传者或「删除资料」权限可删除');
  try {
    await api.teamFileDelete(props.teamId, f.id);
    files.value = files.value.filter((x) => x.id !== f.id);
    ElMessage.success('已删除');
  } catch (e) { ElMessage.error(e.message); }
}

onMounted(() => load().catch((e) => ElMessage.error(e.message)));
</script>

<template>
  <div class="tf">
    <div class="tf-tools">
      <div class="tf-info">
        <b>📁 小组资料（{{ files.length }}）</b>
        <span class="tf-tip">支持本地文档/图片/压缩包（≤20MB），飞书文档/普通文件会复制到组内；表格等类型保存为飞书链接</span>
      </div>
      <div>
        <input ref="inputEl" type="file" hidden @change="pickFile" />
        <el-button type="primary" :disabled="!perms.file_upload" :loading="uploading" @click="inputEl.click()">
          ⬆️ 上传资料
        </el-button>
        <el-button plain :disabled="!perms.file_upload" :loading="refPicking" @click="resPickDlg = true">
          📁 资源库 / 飞书
        </el-button>
        <ResourcePicker v-model="resPickDlg" feishu-confirm-text="📥 导入所选" @pick="onResourcePick" />
      </div>
    </div>
    <div v-if="!perms.file_upload" class="tf-noperm">你的角色没有「上传资料」权限（可让组长调整）</div>

    <div v-if="!files.length" class="tf-empty">暂无资料 — 上传第一份共享文件</div>
    <div v-for="f in files" :key="f.id" class="file-row" :class="{ isimg: isImg(f) }">
      <!-- 图片：直接显示预览图，点击全屏放大 / 下载（引用型分享被撤销时链接失效显示占位） -->
      <img v-if="isImg(f) && dlUrl(f)" class="f-preview" :src="dlUrl(f)" :alt="f.file_name" loading="lazy" @click="preview(f)" />
      <span v-else class="f-icon">{{ f.external_url ? feishuIcon(f) : fmtType(f.file_type) }}</span>
      <div class="f-info">
        <b :title="f.file_name">{{ f.file_name }}</b>
        <span class="f-meta">
          {{ f.external_url ? "飞书链接" : fmtSize(f.file_size) }} · <span class="u-link" @click="toProfile(f)">{{ uploaderName(f) }}</span>
          <el-tag v-for="rn in roleNamesOf(f.user_id)" :key="rn" size="small" effect="plain" style="margin-left:4px">{{ rn }}</el-tag>
          · {{ fmtDateOnly(f.create_time) }}
          <el-tag v-if="f.resource_ref" size="small" type="info" effect="plain" style="margin-left:4px">📁 站内引用</el-tag>
          <el-tag v-else-if="f.external_url" size="small" type="primary" effect="plain" style="margin-left:4px">🪶 飞书链接</el-tag>
        </span>
      </div>
      <span v-if="f.resource_ref && !dlUrl(f)" class="f-dead">已失效</span>
      <a v-else class="f-dl" :href="dlUrl(f)" target="_blank" rel="noopener">{{ f.external_url ? "打开飞书 ↗" : "下载 ⬇" }}</a>
      <el-button v-if="f.user_id === me.user_id || perms.file_delete" size="small" text type="danger" @click="remove(f)">删除</el-button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.tf-tools { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 12px;
  .tf-info { b { font-size: 14px; } .tf-tip { margin-left: 10px; color: #94a3b8; font-size: 12px; } }
}
.tf-noperm, .tf-empty { color: #94a3b8; font-size: 13px; padding: 14px 0; }
.file-row {
  display: flex; align-items: center; gap: 12px; border: 1px solid var(--border); border-radius: 10px;
  padding: 9px 12px; margin-bottom: 8px; transition: all .2s;
  &:hover { background: var(--surface-3); }
  &.isimg { align-items: flex-start; }
  .f-icon { font-size: 20px; }
  .f-preview {
    width: 180px; height: 135px; object-fit: cover; border-radius: 8px; cursor: zoom-in;
    border: 1px solid var(--border); background: var(--surface-2); flex-shrink: 0;
    transition: transform .2s;
    &:hover { transform: scale(1.03); }
  }
  .f-info { flex: 1; min-width: 0; b { display: block; font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } /* 文件名不换行：过长省略 + title 全名 */
    .f-meta { color: var(--text-2); font-size: 12px;
      .u-link { cursor: pointer; &:hover { color: var(--primary); } }
    }
  }
  .f-dl { color: var(--primary); font-size: 13px; text-decoration: none; &:hover { text-decoration: underline; } }
  .f-dead { color: #f43f5e; font-size: 12.5px; }
}
</style>
