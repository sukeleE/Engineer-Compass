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

// 移动端月份切换视图（≤768px 替代横向大网格）
const mobileMonth = ref(new Date().getMonth() + 1);
const mobilePending = ref(false); // true → 显示「时间待定」列表
const shiftMonth = (d) => { mobileMonth.value = ((mobileMonth.value + d - 1 + 12) % 12) + 1; };
const goToday = () => { mobileMonth.value = new Date().getMonth() + 1; mobilePending.value = false; };
const mobileList = computed(() => (mobilePending.value ? noMonth.value : byMonth(mobileMonth.value)));

const MONTHS = Array.from({ length: 12 }, (_, i) => `${i + 1}月`);
const TYPE_COLORS = {
  电子机器人: '#3b82f6', 机械: '#f59e0b', 综合: '#10b981', 数学基础: '#8b5cf6',
  设计艺术: '#ec4899', 经管商科: '#14b8a6', 医学技能: '#ef4444', 创新创业: '#0ea5e9', 外语: '#f472b6', 专业: '#64748b',
};
const colorOf = (t) => TYPE_COLORS[t] || '#64748b';

// 分类归一化：DB 的 type 有 37 种（AI 收录会不断新增碎片类型），映射到 10 个显示大类
const TYPE_GROUP = {
  // → 电子机器人
  '机器人电子': '电子机器人', '集成电路': '电子机器人', '嵌入式系统': '电子机器人',
  '光电工程': '电子机器人', '通信技术': '电子机器人', '网络安全': '电子机器人',
  '信息技术': '电子机器人', '物联网': '电子机器人', '人工智能': '电子机器人',
  // → 机械
  '化工设计/工程实践': '机械', '化工实验/实践': '机械',
  // → 数学基础
  '力学基础': '数学基础', '物理实验/创新': '数学基础', '统计/数据科学': '数学基础', '化学实验/创新': '数学基础',
  // → 医学技能
  '医学技能（临床医学/中医学/预防医学/护理学）': '医学技能',
  '基础医学创新研究（7个学科赛道×创新研究/实验设计两类）': '医学技能',
  '生命科学/科研创新': '医学技能',
  // → 外语
  '外语（语言文化/人文）': '外语',
  // → 综合（跨领域/口径杂的）
  '综合（土建）': '综合', '综合（风景园林）': '综合', '综合（水利）': '综合',
  '测绘/地信/遥感': '综合', '地质/地学': '综合',
  // → 专业（录入时带长描述的脏数据）
  '按专业大类设赛项（2023-2027执行规划：中职组ZZ编号、高职组GZ编号；2025年改革为42条赛道）': '专业',
  '六大领域60余个赛项（第48届共64项，2026年9月在上海举办，中国首次承办）': '综合',
  '与世赛赛项一一对应（60余项，覆盖制造与工程技术、信息与通信技术等六大领域）': '综合',
  '180余个赛项，覆盖大数据、人工智能、机器人、智能制造、数字孪生、云计算、区块链、轨道交通、虚拟仿真等；分国内赛与国际赛（技术创新赛、未来技能挑战赛）': '综合',
};
const groupOf = (t) => TYPE_GROUP[t] || t;

// 分类 chips：按大类聚合 + 竞赛数降序（「全部」固定首位）
const types = computed(() => {
  const counts = {};
  list.value.forEach((c) => { const g = groupOf(c.type); counts[g] = (counts[g] || 0) + 1; });
  return ['全部', ...Object.keys(counts).sort((a, b) => counts[b] - counts[a])];
});

// 移动端分类折叠：默认只显示前 4 个（全部+竞赛最多的 3 类），点「更多分类」展开
const mqNarrow = window.matchMedia('(max-width: 768px)');
const isNarrow = ref(mqNarrow.matches);
mqNarrow.addEventListener('change', (e) => { isNarrow.value = e.matches; });
const chipsExpanded = ref(false);
const visibleChips = computed(() => (isNarrow.value && !chipsExpanded.value ? types.value.slice(0, 4) : types.value));

const filtered = computed(() => {
  let arr = list.value.filter((c) => filterType.value === '全部' || groupOf(c.type) === filterType.value);
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
          v-for="t in visibleChips"
          :key="t"
          class="chip"
          :class="{ active: filterType === t }"
          :style="filterType === t && t !== '全部' ? { borderColor: colorOf(t), color: colorOf(t) } : {}"
          @click="filterType = t"
        >
          <span v-if="t !== '全部'" class="dot" :style="{ background: colorOf(t) }"></span>{{ t }}
        </button>
        <!-- 移动端：折叠多余分类，点开再展示全部 -->
        <button v-if="isNarrow && types.length > 4" class="chip chip-more" @click="chipsExpanded = !chipsExpanded">
          {{ chipsExpanded ? '收起 ▴' : '更多分类 ▾' }}
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
        <span class="type-color" :class="groupOf(c.type)">{{ groupOf(c.type) }}</span>
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

    <!-- 移动端月份视图（≤768px 显示，桌面隐藏）：‹ 月份 › 切换 + 时间待定 -->
    <div v-loading="loading" class="timeline-mobile">
      <div class="tm-ctrl">
        <button class="tm-arrow" aria-label="上一月" @click="shiftMonth(-1)">‹</button>
        <div class="tm-title" @click="goToday">
          {{ mobilePending ? '⏳ 时间待定' : `${new Date().getFullYear()}年${mobileMonth}月` }}
          <span class="tm-count">{{ mobileList.length }} 项</span>
        </div>
        <button class="tm-arrow" aria-label="下一月" @click="shiftMonth(1)">›</button>
        <button class="tm-pending" :class="{ active: mobilePending }" @click="mobilePending = !mobilePending">
          待定
        </button>
        <button class="tm-today" @click="goToday">今天</button>
      </div>
      <div v-if="!mobileList.length" class="tm-empty">
        {{ mobilePending ? '暂无时间待定的竞赛' : `本月暂无竞赛，试试「今天」或筛选其他类别` }}
      </div>
      <div
        v-for="c in mobileList" :key="c.id" class="t-card"
        :style="{ borderLeftColor: colorOf(c.type) }"
        @click="openComp(c)"
      >
        <div class="t-name">{{ c.short_name || c.name }}</div>
        <div class="t-meta">
          <span v-if="isTwoYear(c)" class="t-badge">隔年</span>
          <span v-if="c.source_type !== 'official'" class="t-badge ai">AI</span>
          <span class="t-stars">{{ '★'.repeat(c.difficulty || 0) }}<i>{{ '☆'.repeat(5 - (c.difficulty || 0)) }}</i></span>
          <span class="t-type" :class="groupOf(c.type)">{{ groupOf(c.type) }}</span>
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
    &.chip-more { border-style: dashed; color: #2563eb; font-weight: 500; }
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

// ===== 移动端月份视图（默认隐藏，≤768px 显示并隐藏桌面网格）=====
.timeline-mobile { display: none; }

@media (max-width: 768px) {
  .timeline-scroll { display: none; }
  // 筛选栏：难度(110px)+搜索(200px)+按钮单行放不下（≈382px>360px 屏），换行堆叠
  .filters .right { flex-wrap: wrap; }
  .filters .right .el-select { flex: 1; min-width: 0; }
  .filters .right .el-input { flex: 1 1 100%; }
  .timeline-mobile {
    display: flex; flex-direction: column; gap: 10px;
    .tm-ctrl {
      display: flex; align-items: center; gap: 8px;
      .tm-arrow {
        border: 1px solid var(--border); background: #fff; border-radius: 10px;
        font-size: 18px; line-height: 1; padding: 8px 14px; cursor: pointer;
      }
      .tm-title {
        flex: 1; text-align: center; font-weight: 700; font-size: 16px; cursor: pointer;
        .tm-count { color: var(--text-2); font-size: 12px; font-weight: 400; margin-left: 6px; }
      }
      .tm-pending {
        border: 1px solid var(--border); background: #fff; border-radius: 999px;
        font-size: 13px; padding: 7px 14px; cursor: pointer; color: var(--text-2);
        &.active { background: #2563eb; border-color: #2563eb; color: #fff; font-weight: 600; }
      }
      .tm-today {
        border: none; background: #eff6ff; color: #2563eb; border-radius: 999px;
        font-size: 13px; padding: 7px 14px; cursor: pointer;
      }
    }
    .tm-empty {
      text-align: center; color: var(--text-2); font-size: 13px;
      padding: 30px 0; border: 1px dashed var(--border); border-radius: 10px;
    }
    .t-card { padding: 12px 14px; }
    .t-type { margin-left: auto; color: var(--text-2); font-size: 12px; }
  }
}
</style>
