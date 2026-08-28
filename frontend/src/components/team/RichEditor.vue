<script setup>
// 本地文本编辑器（P3 起替代 wangEditor 富文本）：纯文本/HTML 源码兜底输入
// 富文本能力移交飞书文档：已有记录用「📄 飞书编辑」→ 在飞书里写长文 → 「🔄 从飞书同步」回库
// 组件接口保持不变（modelValue + update:modelValue），4 处引用（日程/进度/分享）零改动
const props = defineProps({ modelValue: String, placeholder: { type: String, default: '写点什么…' } });
const emit = defineEmits(['update:modelValue']);
const onInput = (e) => emit('update:modelValue', e.target.value);
</script>

<template>
  <div class="rich-editor">
    <div class="re-hint">✍️ 本地为纯文本输入；富文本请点「📄 飞书编辑」（需先绑定飞书账号）</div>
    <textarea
      :value="props.modelValue || ''"
      :placeholder="props.placeholder"
      class="re-body"
      @input="onInput"
    />
  </div>
</template>

<style lang="scss" scoped>
.rich-editor {
  border: 1px solid var(--border, #e2e8f0); border-radius: 8px; overflow: hidden; background: var(--card-bg);
  display: flex; flex-direction: column;
  .re-hint {
    padding: 6px 12px; font-size: 12px; color: var(--text-2); background: var(--surface-3);
    border-bottom: 1px solid var(--border, #e2e8f0);
  }
  .re-body {
    width: 100%; min-height: 320px; flex: 1; resize: vertical;
    border: none; outline: none; background: transparent;
    padding: 12px 14px; font-size: 14px; line-height: 1.9;
    color: var(--text-1, #1e293b); font-family: inherit;
    &::placeholder { color: #94a3b8; }
  }
}
</style>
