<template>
  <view class="tech-tree">
    <view v-for="node in nodes" :key="node.id" class="tree-node">
      <view class="node-row" :style="{ paddingLeft: level * 28 + 'rpx' }" @click="toggle(node)">
        <text v-if="node.children && node.children.length" class="arrow">{{ openMap[node.id] ? '▾' : '▸' }}</text>
        <text v-else class="arrow placeholder">•</text>
        <text class="node-name" :class="{ root: level === 0 }">{{ node.node_name }}</text>
      </view>
      <TechTree
        v-if="node.children && node.children.length && openMap[node.id]"
        :nodes="node.children"
        :level="level + 1"
        :default-expand-level="defaultExpandLevel"
      />
    </view>
  </view>
</template>

<script setup>
import { reactive } from 'vue';
// 小程序自定义组件递归需显式自引用（uni-app 不会仅凭 name 自动注入 usingComponents）
import TechTree from './TechTree.vue';

defineOptions({ name: 'TechTree' });

const props = defineProps({
  nodes: { type: Array, default: () => [] },
  level: { type: Number, default: 0 },
  // 默认展开前几层（控制 2072 节点大树的首屏开销）
  defaultExpandLevel: { type: Number, default: 1 },
});

// 各节点按层级默认展开，点击后就地翻转
const openMap = reactive({});
for (const n of props.nodes) openMap[n.id] = props.level < props.defaultExpandLevel;
function toggle(node) {
  if (!node.children || !node.children.length) return;
  openMap[node.id] = !openMap[node.id];
}
</script>

<style lang="scss" scoped>
.tree-node { width: 100%; }
.node-row {
  display: flex;
  align-items: center;
  min-height: 72rpx;
  padding-right: 16rpx;
  border-bottom: 1rpx solid #f1f5f9;
}
.arrow {
  width: 36rpx;
  color: #2563eb;
  font-size: 28rpx;
  flex-shrink: 0;
}
.arrow.placeholder { color: #cbd5e1; }
.node-name {
  font-size: 27rpx;
  color: #334155;
  flex: 1;
}
.node-name.root { font-weight: 700; color: #1e293b; font-size: 29rpx; }
</style>