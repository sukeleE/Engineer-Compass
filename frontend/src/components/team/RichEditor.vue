<script setup>
// 富文本编辑器（wangEditor）：图片直接 base64 内嵌（customUpload 本地转码，无需服务器接口）；视频支持粘贴/输入外链 URL
import { ref, shallowRef, onBeforeUnmount, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Editor, Toolbar } from '@wangeditor/editor-for-vue';
import '@wangeditor/editor/dist/css/style.css';

const props = defineProps({ modelValue: String, placeholder: { type: String, default: '写点什么…' } });
const emit = defineEmits(['update:modelValue']);

const editorRef = shallowRef(null);
const html = ref(props.modelValue || '');
// 工具栏默认收起（避免占用编辑区 / 遮挡输入框），点击「展开工具栏」再显示
const toolbarOpen = ref(false);

watch(() => props.modelValue, (v) => { if (v !== html.value) html.value = v || ''; });
watch(html, (v) => emit('update:modelValue', v));

const toolbarConfig = { excludeKeys: ['uploadVideo', 'fullScreen'] }; // 保留 insertVideo（粘贴视频链接）
const editorConfig = {
  placeholder: props.placeholder,
  MENU_CONF: {
    // 图片：本地 FileReader 转 base64 后插入（不经过服务器）
    uploadImage: {
      imageMaxSize: 10 * 1024 * 1024,
      customUpload(file, insertFn) {
        if (file.size > 10 * 1024 * 1024) {
          ElMessage.warning('图片不能超过 10MB');
          return;
        }
        const reader = new FileReader();
        reader.onload = () => insertFn(reader.result, file.name, file.name);
        reader.readAsDataURL(file);
      },
    },
    // 视频：输入外链 URL（mp4 直接播放；B站/腾讯等平台地址自动转 iframe）
    insertVideo: {
      onInsertedVideo() {
        ElMessage.success('🎬 视频链接已插入');
      },
    },
  },
};

function handleCreated(editor) {
  editorRef.value = editor;
}

onBeforeUnmount(() => {
  editorRef.value?.destroy();
  editorRef.value = null;
});
</script>

<template>
  <div class="rich-editor">
    <!-- 工具栏开关：默认收起，点击展开 -->
    <div class="re-toggle-row">
      <button type="button" class="re-toggle" :class="{ open: toolbarOpen }" @click="toolbarOpen = !toolbarOpen">
        <span class="re-arrow">▾</span>
        {{ toolbarOpen ? '收起工具栏' : '展开工具栏' }}
      </button>
    </div>
    <Toolbar v-show="toolbarOpen" :editor="editorRef" :default-config="toolbarConfig" mode="simple" class="re-toolbar" />
    <Editor
      v-model="html" :default-config="editorConfig" mode="simple" class="re-body"
      @on-created="handleCreated"
    />
  </div>
</template>

<style lang="scss" scoped>
.rich-editor { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: #fff;
  display: flex; flex-direction: column;
  // 工具栏开关条：细链接样式，默认收起
  .re-toggle-row { display: flex; align-items: center; gap: 12px; }
  .re-toggle {
    display: flex; align-items: center; gap: 4px;
    border: none; background: none; cursor: pointer;
    padding: 6px 10px 0; font-size: 12px; color: #2563eb; user-select: none;
    .re-arrow { display: inline-block; transition: transform .2s; }
    &.open .re-arrow { transform: rotate(180deg); }
    &:hover { color: #1d4ed8; }
  }
  :deep(.re-toolbar) {
    border-bottom: 1px solid var(--border); flex-shrink: 0;
    // 图层关系：wangEditor 自带 .w-e-toolbar 是 position:sticky + z-index:1，
    // 而 .w-e-text-container 也是 z-index:1 且 DOM 中 Editor 在 Toolbar 之后（代码先后）
    // → 同层级时编辑区会盖住工具栏。这里把工具栏提到 z-index:10，确保始终在上层。
    position: relative; z-index: 10;
    // 工具栏紧凑化：压小内边距/按钮，腾出空间给正文；窄屏允许换行（不换行时右侧按钮被 overflow:hidden 裁掉）
    .w-e-toolbar { padding: 3px 8px; flex-wrap: wrap; }
    .w-e-bar-item { padding: 2px 3px; }
  }
  :deep(.re-body) { flex: 1; min-height: 320px; overflow-y: hidden; }
  :deep(.w-e-text-container) { z-index: 1; }
}
</style>
