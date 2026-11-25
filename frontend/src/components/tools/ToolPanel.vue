<script setup>
defineProps({
  open: Boolean,
  icon: { type: String, default: '🧰' },
  title: { type: String, default: '学习工具' },
  subtitle: { type: String, default: '' },
  panelStyle: { type: Object, default: () => ({}) },
});
defineEmits(['close']);
</script>

<template>
  <div v-if="open" class="tool-panel" :style="panelStyle">
    <div class="tool-head">
      <b>{{ icon }} {{ title }}</b>
      <div v-if="subtitle" class="tool-sub">{{ subtitle }}</div>
      <div class="tool-actions">
        <el-button link size="small" @click="$emit('close')">收起</el-button>
      </div>
    </div>
    <div class="tool-body">
      <slot />
    </div>
  </div>
</template>

<style lang="scss" scoped>
.tool-panel {
  position: fixed; right: 22px; bottom: 86px; z-index: 1000;
  width: 420px; height: 640px; max-height: calc(100vh - 120px);
  background: var(--card-bg); border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, .2); border: 1px solid var(--border);
  display: flex; flex-direction: column; overflow: hidden;
  @media (max-width: 768px) {
    right: 0; bottom: 0; width: 100vw; height: 100vh; max-height: 100vh; border-radius: 0;
  }
}
.tool-head {
  padding: 12px 64px 12px 16px; background: var(--primary); color: #fff; position: relative; flex-shrink: 0;
  b { font-size: 15px; }
  .tool-sub { font-size: 12.5px; opacity: .85; margin-top: 3px; }
  .tool-actions { position: absolute; top: 8px; right: 8px; :deep(.el-button) { color: #dbeafe; } }
}
.tool-body { flex: 1; overflow-y: auto; padding: 14px; background: var(--surface-3); }
</style>
