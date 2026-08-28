<script setup>
// 计划紧凑标签：只显示计划名 + 短进度条（宽度随计划名，不宜过长），多个并排；
// 点击展开该计划的详细阶段进度（阶段标签 + 完成数）
import { ref } from 'vue';

defineProps({
  items: { type: Array, default: () => [] }, // [{ id, name, done, total, phases?, level? }]
});
const open = ref({}); // id → 是否展开
const toggle = (id) => { open.value[id] = !open.value[id]; };
const pct = (d, t) => (t ? Math.round((d / t) * 100) : 0);
</script>

<template>
  <div class="pt-grid">
    <div
      v-for="it in items" :key="it.id" class="pt-tile" :class="{ expanded: open[it.id] }"
      :title="open[it.id] ? '收起详细进度' : '展开详细进度'" @click="toggle(it.id)"
    >
      <div class="pt-name">
        <b>{{ it.name }}</b>
        <span class="pt-caret">{{ open[it.id] ? '▴' : '▾' }}</span>
      </div>
      <el-progress :percentage="pct(it.done, it.total)" :stroke-width="5" :show-text="false" class="pt-bar" />
      <!-- 展开：详细阶段进度 -->
      <div v-if="open[it.id]" class="pt-detail">
        <div class="pt-stat">📊 已完成 {{ it.done }}/{{ it.total }}<span v-if="it.level" class="pt-level">{{ it.level }}</span></div>
        <div class="pt-phases">
          <el-tag v-for="(p, i) in it.phases" :key="i" size="small" effect="plain"
            :type="p.done === p.total && p.total ? 'success' : p.done ? 'warning' : 'info'">
            阶段{{ i + 1 }} {{ p.phase }}（{{ p.done }}/{{ p.total }}）
          </el-tag>
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.pt-grid {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-start;
}
.pt-tile {
  // 宽度随计划名收缩（fit-content），进度条 100% 即与计划名同长，不宜过长
  width: fit-content; max-width: 100%;
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px;
  padding: 8px 12px; cursor: pointer; transition: all .15s;
  &:hover { border-color: #93c5fd; box-shadow: 0 2px 8px color-mix(in srgb, var(--primary) 8%, transparent); }
  &.expanded { border-color: var(--primary); }
  .pt-name { display: flex; align-items: center; gap: 6px; font-size: 13px;
    b { font-weight: 600; min-width: 0; }
    .pt-caret { color: var(--text-2); font-size: 10px; }
  }
  .pt-level { font-size: 11px; color: var(--primary-dark); background: var(--primary-tint); border-radius: 4px; padding: 0 6px; margin-left: 6px; }
  .pt-bar { width: 100%; margin-top: 6px; }
  .pt-detail { margin-top: 8px; border-top: 1px dashed var(--border); padding-top: 8px;
    .pt-stat { font-size: 12px; color: var(--text-2); margin-bottom: 6px; }
    .pt-phases { display: flex; gap: 4px; flex-wrap: wrap; overflow-wrap: anywhere; }
  }
}
</style>
