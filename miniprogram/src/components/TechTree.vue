<template>
  <view class="tech-tree">
    <view v-for="node in nodes" :key="node.id" class="tree-node">
      <view class="node-row" :style="{ paddingLeft: level * 28 + 'rpx' }" @click="toggle(node)">
        <text v-if="canToggle(node)" class="arrow">{{ openMap[node.id] ? '▾' : '▸' }}</text>
        <text v-else class="arrow placeholder">·</text>
        <text class="node-name" :class="{ root: level === 0 }">{{ node.node_name }}</text>
        <text v-if="nodeResources(node).length" class="resource-count">{{ nodeResources(node).length }} 资源</text>
        <text v-else class="resource-count empty">待补</text>
      </view>
      <view v-if="openMap[node.id] && nodeResources(node).length" class="node-resources">
        <view v-for="resource in nodeResources(node)" :key="resource.id" class="resource-row" @click="copyLink(resource)">
          <text class="resource-type">{{ resourceTypeLabel(resource.resource_type) }}</text>
          <text class="resource-title">{{ resource.title }}</text>
          <text class="resource-provider">{{ resource.provider || platformName(resource.platform) }}</text>
        </view>
      </view>
      <TechTree
        v-if="node.children && node.children.length && openMap[node.id]"
        :nodes="node.children"
        :level="level + 1"
        :default-expand-level="defaultExpandLevel"
        :resources-by-node="resourcesByNode"
      />
    </view>
  </view>
</template>

<script setup>
import { reactive } from 'vue';
import TechTree from './TechTree.vue';

defineOptions({ name: 'TechTree' });

const props = defineProps({
  nodes: { type: Array, default: () => [] },
  level: { type: Number, default: 0 },
  defaultExpandLevel: { type: Number, default: 1 },
  resourcesByNode: { type: Object, default: () => ({}) },
});

const openMap = reactive({});
for (const node of props.nodes) {
  openMap[node.id] = props.level < props.defaultExpandLevel;
}

function nodeResources(node) {
  return props.resourcesByNode?.[String(node.id)] || [];
}

function canToggle(node) {
  return !!(node.children && node.children.length) || nodeResources(node).length > 0;
}

function toggle(node) {
  if (!canToggle(node)) return;
  openMap[node.id] = !openMap[node.id];
}

function resourceTypeLabel(type) {
  return {
    docs: '文档',
    course: '课程',
    video: '视频',
    project: '项目',
    tool: '工具',
    article: '文章',
  }[type] || '资源';
}

function platformName(platform) {
  return {
    bilibili: 'B站',
    zhihu: '知乎',
    csdn: 'CSDN',
    github: 'GitHub',
    docs: '官方文档',
    mooc: '公开课',
    video: '视频',
    article: '文章',
    official: '官网',
  }[platform] || platform || '网页';
}

function copyLink(resource) {
  if (!resource?.url) return;
  uni.setClipboardData({
    data: resource.url,
    success: () => uni.showToast({ title: '链接已复制，到浏览器打开', icon: 'none' }),
  });
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
.resource-count { flex-shrink: 0; color: #047857; font-size: 21rpx; }
.resource-count.empty { color: #b45309; }
.node-resources { padding: 4rpx 18rpx 12rpx 64rpx; background: #f8fafc; }
.resource-row {
  display: flex;
  align-items: center;
  gap: 10rpx;
  padding: 12rpx 0;
  border-bottom: 1rpx solid #eef2f7;
}
.resource-row:last-child { border-bottom: 0; }
.resource-type { flex-shrink: 0; color: #fff; background: #2563eb; border-radius: 6rpx; padding: 2rpx 8rpx; font-size: 19rpx; }
.resource-title { flex: 1; min-width: 0; color: #334155; font-size: 23rpx; }
.resource-provider { flex-shrink: 0; color: #94a3b8; font-size: 20rpx; }
</style>
