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
    <Toolbar :editor="editorRef" :default-config="toolbarConfig" mode="simple" class="re-toolbar" />
    <Editor
      v-model="html" :default-config="editorConfig" mode="simple" class="re-body"
      @on-created="handleCreated"
    />
  </div>
</template>

<style lang="scss" scoped>
.rich-editor { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: #fff;
  :deep(.re-toolbar) {
    border-bottom: 1px solid var(--border);
    // 工具栏紧凑化：压小内边距/按钮，腾出空间给正文
    .w-e-toolbar { padding: 3px 8px; }
    .w-e-bar-item { padding: 2px 3px; }
  }
  :deep(.re-body) { height: 640px; max-height: calc(100vh - 260px); overflow-y: hidden; }
  :deep(.w-e-text-container) { z-index: 1; }
}
</style>
