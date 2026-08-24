<script setup>
// 富文本编辑器（wangEditor）：图片直接 base64 内嵌（customUpload 本地转码，无需服务器接口）
import { ref, shallowRef, onBeforeUnmount, watch } from 'vue';
import { Editor, Toolbar } from '@wangeditor/editor-for-vue';
import '@wangeditor/editor/dist/css/style.css';

const props = defineProps({ modelValue: String, placeholder: { type: String, default: '写点什么…' } });
const emit = defineEmits(['update:modelValue']);

const editorRef = shallowRef(null);
const html = ref(props.modelValue || '');

watch(() => props.modelValue, (v) => { if (v !== html.value) html.value = v || ''; });
watch(html, (v) => emit('update:modelValue', v));

const toolbarConfig = { excludeKeys: ['group-video', 'fullScreen'] };
const editorConfig = {
  placeholder: props.placeholder,
  MENU_CONF: {
    // 图片：本地 FileReader 转 base64 后插入（不经过服务器）
    uploadImage: {
      customUpload(file, insertFn) {
        if (file.size > 10 * 1024 * 1024) {
          window.$message?.warning?.('图片不能超过 10MB');
          return;
        }
        const reader = new FileReader();
        reader.onload = () => insertFn(reader.result, file.name, file.name);
        reader.readAsDataURL(file);
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
  :deep(.re-toolbar) { border-bottom: 1px solid var(--border); }
  :deep(.re-body) { height: 180px; overflow-y: hidden; }
  :deep(.w-e-text-container) { z-index: 1; }
}
</style>
