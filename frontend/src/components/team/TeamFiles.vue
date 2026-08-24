<script setup>
// 资料共享：上传（base64）/ 图片直接预览（点击放大）/ 下载 / 删除
import { ref, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../../api.js';
import auth from '../../auth.js';
import { openImage } from '../../utils/imageViewer.js';

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
// 图片直连 URL（下载接口支持 ?token=，<img> 不带 Authorization 头也能加载）
const dlUrl = (f) => `${api.teamFileDownload(f.id)}?token=${auth.token}`;
const preview = (f) => openImage(dlUrl(f), f.file_name);

async function load() {
  files.value = await api.teamFiles(props.teamId);
}

// 上传者角色（members 由 TeamDetail 传入，含 role_names 数组）
const roleNamesOf = (uid) => props.members?.find((x) => Number(x.id) === Number(uid))?.role_names || [];

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
        <span class="tf-tip">支持文档/图片/压缩包（≤20MB），组内共享</span>
      </div>
      <div>
        <input ref="inputEl" type="file" hidden @change="pickFile" />
        <el-button type="primary" :disabled="!perms.file_upload" :loading="uploading" @click="inputEl.click()">
          ⬆️ 上传资料
        </el-button>
      </div>
    </div>
    <div v-if="!perms.file_upload" class="tf-noperm">你的角色没有「上传资料」权限（可让组长调整）</div>

    <div v-if="!files.length" class="tf-empty">暂无资料 — 上传第一份共享文件</div>
    <div v-for="f in files" :key="f.id" class="file-row" :class="{ isimg: isImg(f) }">
      <!-- 图片：直接显示预览图，点击全屏放大 / 下载 -->
      <img v-if="isImg(f)" class="f-preview" :src="dlUrl(f)" :alt="f.file_name" loading="lazy" @click="preview(f)" />
      <span v-else class="f-icon">{{ fmtType(f.file_type) }}</span>
      <div class="f-info">
        <b>{{ f.file_name }}</b>
        <span class="f-meta">
          {{ fmtSize(f.file_size) }} · {{ f.uploader }}
          <el-tag v-for="rn in roleNamesOf(f.user_id)" :key="rn" size="small" effect="plain" style="margin-left:4px">{{ rn }}</el-tag>
          · {{ f.create_time?.slice(0, 10) }}
        </span>
      </div>
      <a class="f-dl" :href="dlUrl(f)" target="_blank">下载 ⬇</a>
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
  &:hover { background: #f8fafc; }
  &.isimg { align-items: flex-start; }
  .f-icon { font-size: 20px; }
  .f-preview {
    width: 180px; height: 135px; object-fit: cover; border-radius: 8px; cursor: zoom-in;
    border: 1px solid var(--border); background: #f1f5f9; flex-shrink: 0;
    transition: transform .2s;
    &:hover { transform: scale(1.03); }
  }
  .f-info { flex: 1; min-width: 0; b { display: block; font-size: 13.5px; word-break: break-all; }
    .f-meta { color: var(--text-2); font-size: 12px; }
  }
  .f-dl { color: #2563eb; font-size: 13px; text-decoration: none; &:hover { text-decoration: underline; } }
}
</style>
