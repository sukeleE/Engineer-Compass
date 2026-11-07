<template>
  <rich-text class="md" :nodes="html"></rich-text>
</template>

<script setup>
import { computed } from 'vue';
const props = defineProps({ content: { type: String, default: '' } });

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// 轻量 Markdown → HTML（rich-text 支持子集）：标题/粗体/列表/链接/换行
function mdToHtml(md) {
  const lines = String(md || '').split(/\r?\n/);
  const out = [];
  let inList = false;
  const inline = (s) => escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    const oli = line.match(/^\s*\d+[.、]\s+(.*)$/);
    if (h) {
      if (inList) { out.push('</ul>'); inList = false; }
      const sz = Math.min(3, 1 + h[1].length);
      out.push(`<div style="font-weight:700;margin:12rpx 0 6rpx;font-size:${32 - sz * 2}rpx">${inline(h[2])}</div>`);
    } else if (li || oli) {
      if (!inList) { out.push('<ul style="margin:6rpx 0;padding-left:36rpx">'); inList = true; }
      out.push('<li style="margin:4rpx 0">' + inline((li || oli)[1]) + '</li>');
    } else if (!line) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push('<div style="height:10rpx"></div>');
    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push('<div style="margin:6rpx 0;line-height:1.7">' + inline(line) + '</div>');
    }
  }
  if (inList) out.push('</ul>');
  return out.join('');
}
const html = computed(() => mdToHtml(props.content));
</script>

<style lang="scss" scoped>
.md { font-size: 27rpx; color: #334155; word-break: break-word; }
</style>