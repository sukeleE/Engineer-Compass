<!-- 个性化主题弹窗：9 套预设配色 + 自定义主色 + 壁纸上传/浓度调节。登录态存账号（多端同步），游客存本机 -->
<template>
  <el-dialog
    :model-value="modelValue"
    title="🎨 个性化主题"
    width="460px"
    destroy-on-close
    @update:model-value="(v) => !v && onClose()"
    @close="onClose"
  >
    <div class="theme-dialog">
      <!-- 预设配色 -->
      <div class="td-label">预设配色</div>
      <div class="swatch-grid">
        <button
          v-for="(meta, key) in presets"
          :key="key"
          type="button"
          class="swatch"
          :class="{ on: draft.preset === key, dark: !!meta.darkMode }"
          :style="{ background: meta.primary }"
          :title="meta.label"
          @click="pickPreset(key)"
        >
          <span v-if="draft.preset === key" class="swatch-check">✓</span>
          <span v-else class="swatch-name">{{ meta.label }}</span>
        </button>
      </div>

      <!-- 自定义主色 -->
      <div class="td-label custom-row">
        自定义主色
        <el-color-picker v-model="customColor" color-format="hex" @change="onCustomColor" />
        <span class="custom-hex">{{ draft.preset === 'custom' ? draft.primary : '选色即启用' }}</span>
      </div>

      <!-- 壁纸 -->
      <div class="td-label">壁纸背景</div>
      <div class="wall-row">
        <div class="wall-thumb" :style="thumbStyle">
          <span v-if="!draft.wallpaper" class="wall-empty">无壁纸</span>
        </div>
        <div class="wall-ops">
          <el-button size="small" type="primary" plain :loading="uploading" @click="pickWallpaper">
            {{ uploading ? '上传中…' : '上传图片' }}
          </el-button>
          <el-button size="small" plain :disabled="!draft.wallpaper" @click="removeWallpaper">移除壁纸</el-button>
          <p class="wall-hint">支持 jpg / png / webp，自动压缩到 6MB 内；建议浅色或留白多的图片</p>
        </div>
      </div>
      <input ref="fileInput" type="file" accept="image/jpeg,image/png,image/webp" class="hide-file" @change="onFile" />

      <!-- 壁纸浓度 -->
      <div class="td-label opacity-row">
        壁纸浓度
        <el-slider v-model="draft.opacity" :min="0.05" :max="0.6" :step="0.01" class="opacity-slider" />
        <span class="opacity-val">{{ Math.round(draft.opacity * 100) }}%</span>
      </div>

      <el-alert
        v-if="!loggedIn"
        type="info" :closable="false" show-icon
        title="游客模式：主题仅保存在本浏览器；登录后可云端同步，网页与小程序共用"
        class="guest-tip"
      />
    </div>

    <template #footer>
      <el-button @click="resetTheme">恢复默认</el-button>
      <el-button @click="onClose">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存主题</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api.js';
import auth, { patchUser } from '../auth.js';
import {
  THEME_PRESETS, DEFAULT_THEME, currentTheme, applyTheme, applyAndStore,
} from '../utils/theme.js';

const props = defineProps({ modelValue: { type: Boolean, default: false } });
const emit = defineEmits(['update:modelValue', 'saved']);

const presets = THEME_PRESETS;
const loggedIn = computed(() => !!auth.token);
const draft = ref({ ...DEFAULT_THEME });
const customColor = ref(DEFAULT_THEME.primary);
const saving = ref(false);
const uploading = ref(false);
const fileInput = ref(null);

function initDraft() {
  draft.value = { ...DEFAULT_THEME, ...currentTheme() };
  customColor.value = draft.value.primary;
}
watch(() => props.modelValue, (v) => { if (v) initDraft(); });
// 编辑中实时预览（未保存前不写任何存储）
watch(draft, (v) => { if (props.modelValue) applyTheme(v); }, { deep: true });

function pickPreset(key) {
  draft.value.preset = key;
  draft.value.primary = presets[key].primary;
  customColor.value = presets[key].primary;
}
function onCustomColor(hex) {
  if (!hex) return;
  draft.value.preset = 'custom';
  draft.value.primary = hex.toLowerCase();
}

const thumbStyle = computed(() => {
  if (!draft.value.wallpaper) return {};
  const url = /^(data:|https?:)/i.test(draft.value.wallpaper)
    ? draft.value.wallpaper
    : `/api/auth/wallpaper/${encodeURIComponent(draft.value.wallpaper)}${auth.token ? `?token=${encodeURIComponent(auth.token)}` : ''}`;
  return { backgroundImage: `url("${url}")` };
});

function pickWallpaper() { fileInput.value?.click(); }

// 画布压缩：最长边 ≤1600，循环降质直到 ≤5.5MB（后端硬限 6MB）
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const maxEdge = 1600;
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        const isPng = file.type === 'image/png';
        if (!isPng) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
        ctx.drawImage(img, 0, 0, w, h);
        const mime = isPng ? 'image/png' : 'image/jpeg';
        let quality = 0.85;
        const tryEncode = () => {
          canvas.toBlob((blob) => {
            if (!blob) return reject(new Error('图片压缩失败'));
            if (blob.size > 5.5 * 1024 * 1024 && quality > 0.4 && mime === 'image/jpeg') {
              quality -= 0.12;
              return tryEncode();
            }
            if (blob.size > 6 * 1024 * 1024) return reject(new Error('图片过大，请换一张或先裁剪'));
            const ext = mime === 'image/png' ? 'png' : 'jpg';
            resolve({ blob, name: `wallpaper_${Date.now()}.${ext}`, mime, dataUrl: '' });
          }, mime, quality);
        };
        tryEncode();
      };
      img.onerror = () => reject(new Error('图片读取失败'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

async function onFile(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return ElMessage.warning('仅支持 jpg / png / webp 图片');
  uploading.value = true;
  try {
    const compressed = await compressImage(file);
    if (loggedIn.value) {
      const up = new File([compressed.blob], compressed.name, { type: compressed.mime });
      const r = await api.wallpaperUpload(up);
      patchUser(r.user);
      draft.value.wallpaper = r.user.theme?.wallpaper || '';
      ElMessage.success('壁纸已上传');
    } else {
      // 游客：转 dataURL 存 localStorage（限制 1.8MB，给其他存储留额度）
      const dataUrl = await blobToDataUrl(compressed.blob);
      if (dataUrl.length > 1.8 * 1024 * 1024) {
        ElMessage.warning('图片仍偏大，游客本地模式请换一张更小的图片；登录后可存更大壁纸');
      } else {
        draft.value.wallpaper = dataUrl;
      }
    }
  } catch (err) {
    ElMessage.error(err.message || '壁纸上传失败');
  } finally {
    uploading.value = false;
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('图片读取失败'));
    fr.readAsDataURL(blob);
  });
}

async function removeWallpaper() {
  try {
    if (loggedIn.value && draft.value.wallpaper && !/^(data:|https?:)/i.test(draft.value.wallpaper)) {
      const r = await api.wallpaperRemove();
      patchUser(r.user);
    }
    draft.value.wallpaper = '';
  } catch (err) {
    ElMessage.error(err.message);
  }
}

function resetTheme() {
  draft.value = { ...DEFAULT_THEME };
  customColor.value = DEFAULT_THEME.primary;
}

async function save() {
  saving.value = true;
  try {
    if (loggedIn.value) {
      const r = await api.themeSave({
        preset: draft.value.preset,
        primary: draft.value.primary,
        opacity: draft.value.opacity,
        wallpaper: draft.value.wallpaper,
      });
      patchUser(r.user);
      applyTheme(currentTheme());
    } else {
      applyAndStore({ ...draft.value });
    }
    ElMessage.success('主题已保存');
    emit('saved');
    emit('update:modelValue', false);
  } catch (err) {
    ElMessage.error(err.message || '保存失败');
  } finally {
    saving.value = false;
  }
}

function onClose() {
  // 放弃预览改动，恢复当前已生效主题
  applyTheme(currentTheme());
  emit('update:modelValue', false);
}
</script>

<style scoped>
.theme-dialog { display: flex; flex-direction: column; gap: 14px; }
.td-label { font-size: 13px; font-weight: 600; color: var(--text-2); display: flex; align-items: center; gap: 10px; }
.swatch-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; }
.swatch {
  position: relative; height: 52px; border-radius: 12px; border: 2px solid var(--border);
  cursor: pointer; padding: 0; overflow: hidden; transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.swatch:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(15, 23, 42, 0.18); }
.swatch.on { border-color: var(--text); box-shadow: 0 0 0 2px var(--card-bg), 0 0 0 4px var(--primary); }
.swatch-check { color: #fff; font-size: 20px; font-weight: 700; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.45); }
.swatch-name {
  position: absolute; inset: auto 0 4px; font-size: 11px; color: #fff;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.55);
}
.swatch.dark .swatch-name { color: #bfdbfe; }
.custom-hex { font-family: var(--font-mono); font-size: 12px; color: var(--text-3); font-weight: 400; }
.wall-row { display: flex; gap: 14px; align-items: flex-start; }
.wall-thumb {
  width: 112px; height: 76px; border-radius: 10px; border: 1px solid var(--border-2);
  background: var(--surface-2); background-size: cover; background-position: center;
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.wall-empty { font-size: 12px; color: var(--text-3); }
.wall-ops { flex: 1; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.wall-hint { flex-basis: 100%; margin: 2px 0 0; font-size: 12px; color: var(--text-3); line-height: 1.5; }
.hide-file { display: none; }
.opacity-slider { flex: 1; margin: 0; }
.opacity-val { width: 42px; text-align: right; font-variant-numeric: tabular-nums; color: var(--text-2); }
.guest-tip { margin-top: 2px; }
</style>