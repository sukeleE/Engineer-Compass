<template>
  <!-- 本地轻量富文本：加粗/斜体/标题/列表/引用/链接/图片（可粘贴图片，自动压缩 base64 内嵌）。
       内容安全由后端白名单净化兜底；v-model 传 HTML。 -->
  <div class="lite-editor">
    <div class="le-bar" @mousedown.prevent>
      <button type="button" title="加粗" @click="cmd('bold')"><b>B</b></button>
      <button type="button" title="斜体" @click="cmd('italic')"><i>I</i></button>
      <button type="button" title="下划线" @click="cmd('underline')"><u>U</u></button>
      <button type="button" title="删除线" @click="cmd('strikeThrough')"><s>S</s></button>
      <span class="le-sep"></span>
      <button type="button" title="小标题" @click="block('h3')">H</button>
      <button type="button" title="引用" @click="block('blockquote')">❝</button>
      <button type="button" title="无序列表" @click="cmd('insertUnorderedList')">•≡</button>
      <button type="button" title="有序列表" @click="cmd('insertOrderedList')">1≡</button>
      <span class="le-sep"></span>
      <button type="button" title="插入链接" @click="addLink">🔗</button>
      <button type="button" title="插入图片（可直接粘贴/选择）" @click="filePick.click()">🖼️</button>
      <input ref="filePick" type="file" accept="image/*" multiple hidden @change="onFiles" />
      <span class="le-hint">支持直接粘贴图片</span>
    </div>
    <div
      ref="body"
      class="le-body"
      contenteditable="true"
      :data-placeholder="placeholder"
      @input="onInput"
      @paste="onPaste"
      @blur="onInput"
    ></div>
  </div>
</template>

<script setup>
import { ref, onMounted, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { compressImage } from '../../utils/imageCompress.js';

const props = defineProps({
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: '写点什么…' },
});
const emit = defineEmits(['update:modelValue']);
const body = ref(null);
let lastEmitted = '';

onMounted(() => {
  if (props.modelValue) body.value.innerHTML = props.modelValue;
  lastEmitted = body.value.innerHTML;
});

// 外部值变化（编辑预填/切换条目）才回写，避免输入时 innerHTML 重置导致光标跳动
watch(() => props.modelValue, (v) => {
  if (!body.value) return;
  const next = v || '';
  if (next !== lastEmitted && next !== body.value.innerHTML) {
    body.value.innerHTML = next;
    lastEmitted = body.value.innerHTML;
  }
});

function onInput() {
  lastEmitted = body.value.innerHTML;
  emit('update:modelValue', lastEmitted);
}
function focusBody() { body.value?.focus(); }
function cmd(name) { document.execCommand(name, false, null); focusBody(); onInput(); }
function block(tag) { document.execCommand('formatBlock', false, tag); focusBody(); onInput(); }
function addLink() {
  const url = window.prompt('输入链接地址（http(s)://…）');
  if (!url) return;
  const u = /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
  document.execCommand('createLink', false, u);
  focusBody(); onInput();
}

async function insertImage(file) {
  try {
    const f = await compressImage(file, { maxEdge: 900, quality: 0.72 });
    const dataUrl = await new Promise((resolve, reject) => {
      const rd = new FileReader();
      rd.onload = () => resolve(String(rd.result));
      rd.onerror = reject;
      rd.readAsDataURL(f);
    });
    focusBody();
    document.execCommand('insertImage', false, dataUrl);
    onInput();
  } catch (e) { ElMessage.error('图片插入失败'); }
}
async function onFiles(e) {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  for (const f of files) await insertImage(f);
}

// 粘贴：纯文本走文本（不带外部样式）；剪贴板里的图片走压缩插入
async function onPaste(e) {
  const items = [...(e.clipboardData?.items || [])];
  const imgs = items.filter((it) => String(it.type || '').startsWith('image/'));
  if (imgs.length) {
    e.preventDefault();
    for (const it of imgs) {
      const f = it.getAsFile();
      if (f) await insertImage(f);
    }
    return;
  }
  e.preventDefault();
  const text = e.clipboardData?.getData('text/plain') || '';
  document.execCommand('insertText', false, text);
  onInput();
}
</script>

<style lang="scss" scoped>
.lite-editor {
  border: 1px solid var(--border, #e2e8f0); border-radius: 10px; overflow: hidden;
  background: var(--card-bg, #fff);
  .le-bar {
    display: flex; align-items: center; gap: 2px; flex-wrap: wrap;
    padding: 6px 8px; background: var(--surface-3, #f8fafc);
    border-bottom: 1px solid var(--border, #e2e8f0);
    button {
      min-width: 30px; height: 28px; padding: 0 7px; border: none; border-radius: 6px;
      background: transparent; cursor: pointer; font-size: 14px; color: var(--text-1, #1e293b);
      &:hover { background: color-mix(in srgb, var(--primary, #2563eb) 14%, white); }
    }
    .le-sep { width: 1px; height: 18px; background: var(--border, #e2e8f0); margin: 0 4px; }
    .le-hint { margin-left: auto; font-size: 12px; color: #94a3b8; padding-right: 4px; }
  }
  .le-body {
    min-height: 260px; max-height: 520px; overflow-y: auto;
    padding: 12px 14px; font-size: 14px; line-height: 1.9; outline: none;
    color: var(--text-1, #1e293b);
    &:empty::before { content: attr(data-placeholder); color: #94a3b8; pointer-events: none; }
    :deep(img) { max-width: 100%; max-height: 360px; border-radius: 8px; cursor: zoom-in; }
    :deep(a) { color: var(--primary, #2563eb); }
    :deep(blockquote) {
      margin: 6px 0; padding: 4px 12px; border-left: 3px solid var(--primary, #2563eb);
      background: var(--surface-3, #f8fafc); color: var(--text-2, #475569); border-radius: 0 6px 6px 0;
    }
    :deep(h3) { font-size: 16px; margin: 10px 0 4px; }
    :deep(ul), :deep(ol) { padding-left: 22px; margin: 6px 0; }
  }
}
</style>