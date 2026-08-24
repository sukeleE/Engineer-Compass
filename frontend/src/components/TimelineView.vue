<script setup>
// 主页面：横向时间轴（12月网格）+ 筛选 + 搜索 + 详情弹窗
import { ref, computed, onMounted, nextTick } from 'vue';
import gsap from 'gsap';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api.js';
import { store } from '../store.js';
import CompDialog from './CompDialog.vue';
import AdminView from './AdminView.vue'; // AI 收录（集成在本页 tab 内）

// 页面 tab：timeline 竞赛时间轴 | ingest AI 收录
const viewTab = ref('timeline');

const list = ref([]);
const loading = ref(true);

// 筛选状态
const filterType = ref('全部');
const filterDiff = ref(0);
const searchQ = ref('');
const searchResults = ref(null);
const searching = ref(false);

// 弹窗状态
const dialogOpen = ref(false);
const currentId = ref(null);

const MONTHS = Array.from({ length: 12 }, (_, i) => `${i + 1}月`);
const TYPE_COLORS = {
  电子机器人: '#3b82f6', 机械: '#f59e0b', 综合: '#10b981', 数学基础: '#8b5cf6',
  设计艺术: '#ec4899', 经管商科: '#14b8a6', 医学技能: '#ef4444',
};
const colorOf = (t) => TYPE_COLORS[t] || '#64748b';

const types = computed(() => ['全部', ...new Set(list.value.map((c) => c.type))]);

const filtered = computed(() => {
  let arr = list.value.filter((c) => filterType.value === '全部' || c.type === filterType.value);
  if (filterDiff.value) arr = arr.filter((c) => c.difficulty === filterDiff.value);
  return arr;
});
const withMonth = computed(() => filtered.value.filter((c) => c.start_month));
const noMonth = computed(() => filtered.value.filter((c) => !c.start_month));
const byMonth = (m) => withMonth.value.filter((c) => c.start_month === m);

const isTwoYear = (c) => /两年|奇数|偶数/.test(c.cycle || '');

async function load() {
  loading.value = true;
  try {
    list.value = await api.competitions();
  } catch (e) {
    ElMessage.error(`加载失败：${e.message}`);
  } finally {
    loading.value = false;
    await nextTick();
    animateIn();
  }
}

// GSAP：卡片入场 + 悬停
function animateIn() {
  gsap.fromTo('.t-card', { opacity: 0, y: 26 }, { opacity: 1, y: 0, duration: 0.5, stagger: 0.012, ease: 'power2.out' });
}
function hoverIn(e) {
  gsap.to(e.currentTarget, { scale: 1.06, y: -4, boxShadow: '0 12px 26px rgba(0,0,0,.16)', duration: 0.25 });
}
function hoverOut(e) {
  gsap.to(e.currentTarget, { scale: 1, y: 0, boxShadow: '0 2px 8px rgba(0,0,0,.08)', duration: 0.25 });
}

function openComp(c) {
  store.currentCompId = c.id;
  store.currentCompName = c.name;
  currentId.value = c.id;
  dialogOpen.value = true;
}

async function doSearch() {
  const q = searchQ.value.trim();
  if (!q) return;
  searching.value = true;
  try {
    const res = await api.search(q);
    searchResults.value = res;
    if (!res.found) {
      // 未收录 → 引导用户现场用 AI 收录（本页 tab 内即可完成）
      ElMessageBox.confirm(res.hint || `「${q}」未收录，要不要试试 AI 收录？`, '未收录该竞赛', {
        confirmButtonText: '🧠 去 AI 收录', cancelButtonText: '取消', type: 'info',
      }).then(() => { viewTab.value = 'ingest'; }).catch(() => {});
    }
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    searching.value = false;
  }
}
function openSearchResult(c) {
  searchResults.value = null;
  searchQ.value = '';
  openComp(c);
}

onMounted(load);
</script>

<template>
  <main class="timeline-page">
    <!-- 集成页签：竞赛时间轴 / AI 收录（搜索未命中可直接现场收录） -->
    <el-tabs v-model="viewTab" class="page-tabs">
    <el-tab-pane label="🗓️ 竞赛时间轴" name="timeline">

    <!-- 筛选栏 -->
    <div class="filters">
      <div class="chips">
        <button
          v-for="t in types"
          :key="t"
          class="chip"
          :class="{ active: filterType === t }"
          :style="filterType === t && t !== '全部' ? { borderColor: colorOf(t), color: colorOf(t) } : {}"
          @click="filterType = t"
        >
          <span v-if="t !== '全部'" class="dot" :style="{ background: colorOf(t) }"></span>{{ t }}
        </button>
      </div>
      <div class="right">
        <el-select v-model="filterDiff" size="small" style="width: 110px" placeholder="难度">
          <el-option label="全部难度" :value="0" />
          <el-option v-for="i in 5" :key="i" :label="'★'.repeat(i)" :value="i" />
        </el-select>
        <el-input
          v-model="searchQ" size="small" clearable style="width: 200px"
          placeholder="搜索竞赛名称…" @keyup.enter="doSearch"
        />
        <el-button size="small" type="primary" :loading="searching" @click="doSearch">搜索</el-button>
      </div>
    </div>

    <!-- 搜索结果 -->
    <div v-if="searchResults?.found" class="search-results">
      <div class="sr-item" v-for="c in searchResults.results" :key="c.id" @click="openSearchResult(c)">
        <b>{{ c.short_name || c.name }}</b>
        <span class="type-color" :class="c.type">{{ c.type }}</span>
        <span>{{ '★'.repeat(c.difficulty || 0) }}</span>
      </div>
    </div>

    <!-- 时间轴 -->
    <div v-loading="loading" class="timeline-scroll">
      <div class="timeline" :style="{ gridTemplateColumns: 'repeat(13, minmax(168px, 1fr))' }">
        <div v-for="m in MONTHS" :key="m" class="month-head">{{ m }}</div>
        <div class="month-head last">时间待定</div>

        <div v-for="m in 12" :key="m" class="month-col">
          <div
            v-for="c in byMonth(m)" :key="c.id" class="t-card"
            :style="{ borderLeftColor: colorOf(c.type) }"
            @click="openComp(c)" @mouseenter="hoverIn" @mouseleave="hoverOut"
          >
            <div class="t-name">{{ c.short_name || c.name }}</div>
            <div class="t-meta">
              <span v-if="isTwoYear(c)" class="t-badge">隔年</span>
              <span v-if="c.source_type !== 'official'" class="t-badge ai">AI</span>
              <span class="t-stars">{{ '★'.repeat(c.difficulty || 0) }}<i>{{ '☆'.repeat(5 - (c.difficulty || 0)) }}</i></span>
            </div>
          </div>
        </div>

        <div class="month-col last">
          <div
            v-for="c in noMonth" :key="c.id" class="t-card"
            :style="{ borderLeftColor: colorOf(c.type) }"
            @click="openComp(c)" @mouseenter="hoverIn" @mouseleave="hoverOut"
          >
            <div class="t-name">{{ c.short_name || c.name }}</div>
            <div class="t-meta">
              <span v-if="isTwoYear(c)" class="t-badge">隔年</span>
              <span class="t-stars">{{ '★'.repeat(c.difficulty || 0) }}</span>
            </div>
          </div>
          <div v-if="!noMonth.length" class="placeholder">—</div>
        </div>
      </div>
    </div>

    <CompDialog :open="dialogOpen" :comp-id="currentId" @close="dialogOpen = false" />
    </el-tab-pane>

    <el-tab-pane label="🧠 AI 收录" name="ingest">
      <AdminView />
    </el-tab-pane>
    </el-tabs>
  </main>
</template>

<style lang="scss" scoped>
.timeline-page { padding: 12px 20px 80px; }

// 页签：时间轴 / AI 收录
.page-tabs {
  :deep(.el-tabs__header) { margin-bottom: 12px; }
  :deep(.el-tabs__item) { font-size: 14.5px; }
}
// AI 收录（AdminView）嵌入后不再重复加页边距
:deep(.admin-page) { padding: 0 0 60px; max-width: none; }

.filters {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  flex-wrap: wrap; margin-bottom: 14px;
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip {
    display: inline-flex; align-items: center; gap: 5px;
    border: 1px solid var(--border); background: #fff; color: var(--text-2);
    border-radius: 999px; padding: 4px 12px; cursor: pointer; font-size: 13px;
    transition: all .2s;
    .dot { width: 8px; height: 8px; border-radius: 50%; }
    &:hover { border-color: #94a3b8; }
    &.active { background: #eff6ff; border-width: 2px; font-weight: 600; }
  }
  .right { display: flex; gap: 8px; align-items: center; }
}

.search-results {
  background: #fff; border: 1px solid var(--border); border-radius: 10px;
  padding: 6px; margin-bottom: 12px; max-height: 220px; overflow-y: auto;
  .sr-item {
    display: flex; gap: 10px; align-items: center; padding: 8px 10px; border-radius: 6px; cursor: pointer;
    &:hover { background: #f1f5f9; }
    b { flex: 1; }
  }
}

.timeline-scroll { overflow-x: auto; padding-bottom: 16px; }

.timeline {
  display: grid; gap: 10px; min-width: 2190px;
}
.month-head {
  font-weight: 600; color: var(--text-2); text-align: center;
  padding: 6px 0; border-bottom: 2px solid var(--border); position: sticky; top: 0; background: var(--bg);
}
.month-col {
  display: flex; flex-direction: column; gap: 8px; align-items: stretch;
  min-height: 90px;
  .placeholder { color: #cbd5e1; text-align: center; font-size: 18px; padding-top: 20px; }
}
.month-head.last, .month-col.last { background: #f1f5f9; border-radius: 8px; }

.t-card {
  background: var(--card-bg); border: 1px solid var(--border); border-left: 4px solid;
  border-radius: 8px; padding: 8px 10px; cursor: pointer; user-select: none;
  box-shadow: 0 2px 8px rgba(0,0,0,.08);
  transition: border-color .2s;
  &:hover { border-color: #94a3b8; }
  .t-name { font-weight: 600; font-size: 13px; line-height: 1.35; }
  .t-meta { display: flex; gap: 6px; align-items: center; margin-top: 5px; }
  .t-badge {
    font-size: 10px; color: #b45309; background: #fef3c7; border-radius: 4px; padding: 1px 5px;
    &.ai { color: #6d28d9; background: #ede9fe; }
  }
  .t-stars { color: #f59e0b; font-size: 11px; i { color: #e2e8f0; font-style: normal; } }
}
</style>
