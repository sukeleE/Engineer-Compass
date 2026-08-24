<script setup>
// ECharts 树状技术栈图：可拖拽/缩放，支持展开全部/收起/重置
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import * as echarts from 'echarts';

const props = defineProps({
  process: { type: Object, default: null }, // 子赛项对象 { phase_name, tech_stack: [{id,parent_id,node_name,node_desc}] }
});

const chartRef = ref(null);
const collapseState = ref('default'); // 'default' 默认3层 | 'all' 全部展开 | 'none' 全部收起
let chart = null;

// tech_stack（多根分支）→ ECharts 单根树；collapseState 控制整体展开/收起
function buildTree(proc, state) {
  if (!proc) return { name: '无技术栈数据', children: [] };
  const nodes = proc.tech_stack || [];
  const byId = new Map(nodes.map((n) => [n.id, { name: n.node_name, tooltip_desc: n.node_desc, children: [] }]));
  const roots = [];
  for (const n of nodes) {
    const node = byId.get(n.id);
    if (n.parent_id && byId.has(n.parent_id)) byId.get(n.parent_id).children.push(node);
    else roots.push(node);
  }
  const tree = { name: proc.phase_name, children: roots };
  const mark = (node) => {
    if (state === 'all') node.collapsed = false;
    if (state === 'none') node.collapsed = true;
    node.children.forEach(mark);
  };
  tree.children.forEach(mark);
  return tree;
}

function countLeaves(node) {
  if (!node.children || !node.children.length) return 1;
  return node.children.reduce((s, c) => s + countLeaves(c), 0);
}

function render() {
  if (!chart) return;
  const tree = buildTree(props.process, collapseState.value);
  // 容器高度随叶子数自适应（纵向不裁切），上限 720
  chartRef.value.style.height = `${Math.min(Math.max(countLeaves(tree) * 22 + 130, 400), 720)}px`;
  chart.setOption({
    tooltip: {
      trigger: 'item',
      triggerOn: 'mousemove',
      formatter: (p) => p.data.name + (p.data.tooltip_desc ? `<br/><span style="color:#94a3b8">${p.data.tooltip_desc}</span>` : ''),
    },
    series: [
      {
        type: 'tree',
        data: [tree],
        top: 12, bottom: 12, left: 24, right: 24,
        symbolSize: 8,
        initialTreeDepth: 3,
        expandAndCollapse: true,
        roam: true, // 拖拽平移 + 滚轮缩放
        label: {
          position: 'right', verticalAlign: 'middle', align: 'left',
          fontSize: 13, color: '#1e293b',
          width: 200, overflow: 'truncate', // 长节点名截断（完整名见 tooltip）
        },
        leaves: { label: { position: 'right' } },
        emphasis: { focus: 'descendant' },
        lineStyle: { color: '#cbd5e1', width: 1.5 },
        itemStyle: { color: '#3b82f6', borderColor: '#fff', borderWidth: 1 },
      },
    ],
  });
  chart.resize(); // 容器高度已动态调整，同步图表内部尺寸
  fitTree(); // 把树 fit 进容器，避免挤在左上角
}

// roam 模式下树按自然尺寸布局（不会自动填满容器）→ 渲染后把树 fit 进视图
function fitTree() {
  try {
    const series = chart.getModel().getSeriesByIndex(0);
    const data = series?.getData();
    const tree = data?.getTree?.() || data?.tree;
    if (!tree || !tree.eachNode) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    tree.eachNode((node) => {
      const p = node.getLayout();
      const x = p[0], y = p[1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    });
    if (!isFinite(minX)) return;
    // 右侧留出节点标签空间（label 截断宽 200）
    chart.dispatchAction({
      type: 'zoomToRect',
      rect: { x: minX, y: minY - 24, width: maxX - minX + 210, height: maxY - minY + 48 },
      animationDuration: 0,
    });
  } catch {
    // 内部 API 变化时降级：保持左上角，用户仍可拖拽/缩放
  }
}

function onResize() { chart?.resize(); }

function setState(s) {
  collapseState.value = s;
  render();
}

watch(() => props.process, async () => { await nextTick(); render(); });

onMounted(async () => {
  chart = echarts.init(chartRef.value);
  window.addEventListener('resize', onResize);
  await nextTick();
  render();
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <div class="tree-wrap">
    <div class="tree-toolbar">
      <span class="hint">🖱️ 拖拽平移 · 滚轮缩放 · 点击节点展开/收起</span>
      <div class="tree-btns">
        <el-button size="small" @click="setState('default')">默认视图</el-button>
        <el-button size="small" type="primary" plain @click="setState('all')">全部展开</el-button>
        <el-button size="small" plain @click="setState('none')">全部收起</el-button>
      </div>
    </div>
    <div ref="chartRef" class="tech-tree"></div>
  </div>
</template>

<style lang="scss" scoped>
.tree-wrap { display: flex; flex-direction: column; }
.tree-toolbar {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin-bottom: 6px; flex-wrap: wrap;
  .hint { color: var(--text-2); font-size: 12px; }
  .tree-btns { display: flex; gap: 6px; }
}
.tech-tree { width: 100%; height: 400px; }
</style>
