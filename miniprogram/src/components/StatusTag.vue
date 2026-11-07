<template>
  <text class="tag" :class="cls">{{ label || status }}</text>
</template>

<script setup>
import { computed } from 'vue';
const props = defineProps({ status: { type: [String, Number], default: '' }, label: { type: String, default: '' }, map: { type: Object, default: () => ({}) } });

const DEFAULT_MAP = {
  pending: ['待处理', 'tag-amber'], approved: ['已通过', 'tag-green'], rejected: ['已驳回', 'tag-red'],
  active: ['正式', 'tag-green'], done: ['已完成', 'tag-green'], canceled: ['已取消', 'tag-gray'],
  processing: ['进行中', 'tag-blue'], reviewing: ['审核中', 'tag-amber'], closed: ['已关闭', 'tag-gray'],
};
const cls = computed(() => {
  const m = Object.assign({}, DEFAULT_MAP, props.map);
  const hit = m[String(props.status)];
  return hit ? hit[1] : 'tag-gray';
});
</script>