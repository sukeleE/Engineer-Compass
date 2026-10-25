<template>
  <div class="wg-wrap">
    <!-- 工具条 -->
    <div class="wg-bar">
      <el-button-group size="small">
        <el-button @click="nav(-1)">‹ 上一{{ weekLabel }}</el-button>
        <el-button @click="goToday">今天</el-button>
        <el-button @click="nav(1)">下一{{ weekLabel }} ›</el-button>
      </el-button-group>
      <b class="wg-range">{{ rangeText }}</b>
      <el-radio-group v-model="weekStartMonday" size="small" @change="goToday" style="margin-left: 4px">
        <el-radio-button :value="true">周一起</el-radio-button>
        <el-radio-button :value="false">周日起</el-radio-button>
      </el-radio-group>

      <el-checkbox-group v-model="kindFilter" size="small" class="wg-kinds">
        <el-checkbox-button v-for="k in KINDS" :key="k.key" :value="k.key">{{ k.icon }} {{ k.label }}</el-checkbox-button>
      </el-checkbox-group>

      <el-switch v-model="showHistory" size="small" inline-prompt active-text="历史" inactive-text="占用"
        style="margin-left: auto" @change="(v) => emit('toggle-history', v)" />
    </div>

    <!-- 桌面：7×30 大网格甘特 -->
    <div v-if="!isMobile" ref="scrollEl" v-loading="loading" class="wg-scroll">
      <div v-if="rows.length" class="wg-grid" :class="{ nocreate: project.status !== 'open' }">
        <!-- 角 + 日表头（占两行高度：日期 + 时刻尺） -->
        <div class="wg-corner">资源 / 时间</div>
        <div v-for="(d, i) in days" :key="i" class="wg-dayhead" :class="{ today: isSameDay(d, nowD), weekend: d.getDay() === 0 || d.getDay() === 6 }">
          <div class="wg-dh-top">
            {{ WD_CN[d.getDay()] }} {{ d.getMonth() + 1 }}/{{ d.getDate() }}
            <span v-if="isSameDay(d, nowD)" class="wg-today-tag">今天</span>
          </div>
          <div class="wg-ruler">
            <span v-for="hh in rulerHrs" :key="hh" class="wg-rtick" :class="{ first: hh === OPEN_HH }"
              :style="{ left: ((hh * 60 - 420) / 30 / 30) * 100 + '%' }">{{ hh }}</span>
          </div>
        </div>

        <template v-for="row in rows" :key="row.resource.id">
          <div class="wg-name">
            <span class="wg-ntext" @click.stop="emit('select-resource', row.resource)"
              :title="`${metaOf(row.resource).icon} ${row.resource.name}（${
              row.resource.is_space ? '容量' + row.resource.capacity : '库存' + row.resource.quantity
            }）`">{{ metaOf(row.resource).icon }} {{ row.resource.name }}</span>
            <i class="wg-nmeta">{{ row.resource.is_space ? `容量${row.resource.capacity}` : `库存${row.resource.quantity}` }}</i>
            <el-button v-if="project.status === 'open'" link type="primary" size="small" class="wg-nadd"
              @click="quickBook(row.resource)">＋</el-button>
          </div>
          <div class="wg-track" :style="{ height: rowHeight(row.lanes) + 'px' }"
            @pointerdown="(e) => onDown(e, row.resource)">
            <!-- 背景刻度层（日界/时刻线） -->
            <div class="wg-lines"></div>
            <!-- 物品库存热度 -->
            <template v-if="!row.resource.is_space">
              <div v-for="(s, si) in heat(row.resource)" :key="si" class="wg-heat"
                :class="s.cls" :style="segStyle(s)"></div>
            </template>
            <!-- 预约块 -->
            <div v-for="b in row.items" :key="b.booking.id" class="wg-block"
              :class="blockCls(b.booking)" :style="blockStyle(b)"
              :title="blockTitle(b.booking, row.resource)"
              @pointerdown.stop @click.stop="emit('select-booking', b.booking)">
              <span class="wg-bk-name">{{ b.booking.booker_name }}</span>
              <span class="wg-bk-meta">{{ row.resource.is_space ? `👥${b.booking.headcount}` : `×${b.booking.qty}` }}</span>
              <span v-if="b.span >= 5" class="wg-bk-dur">{{ durationLabel(b.booking.start_time, b.booking.end_time) }}</span>
            </div>
            <!-- 当前时刻红线 -->
            <div v-if="nowLineCol(row.resource) !== null" class="wg-now"
              :style="{ left: (nowLineCol(row.resource) / TOTAL) * 100 + '%' }"></div>
            <!-- 拖选层 -->
            <div v-if="drag && drag.resourceId === row.resource.id" class="wg-select"
              :style="segStyle(drag.seg)"></div>
          </div>
        </template>
      </div>
      <el-empty v-else :description="kindFilter.length === 0 ? '当前筛选下没有资源' : '项目内还没有可用资源'" :image-size="90" />
    </div>

    <!-- 窄屏：日期选择 + 资源手风琴 -->
    <div v-else class="wg-m" v-loading="loading">
      <el-select v-model="mobileDay" size="default" style="width: 100%; margin-bottom: 10px">
        <el-option v-for="(d, i) in days" :key="i" :value="i"
          :label="`${WD_CN[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}${isSameDay(d, nowD) ? '（今天）' : ''}`" />
      </el-select>
      <el-collapse v-if="rows.length" v-model="mobileOpen">
        <el-collapse-item v-for="row in rows" :key="row.resource.id" :name="row.resource.id">
          <template #title>
            <span class="wg-m-name">{{ metaOf(row.resource).icon }} {{ row.resource.name }}
              <i class="wg-nmeta">{{ row.resource.is_space ? `容量${row.resource.capacity}` : `库存${row.resource.quantity}` }}</i>
            </span>
          </template>
          <div v-if="dayItems(row.resource).length" class="wg-m-list">
            <div v-for="b in dayItems(row.resource)" :key="b.id" class="wg-m-item"
              :class="['st-' + b.status, { mine: b.mine }]" @click="emit('select-booking', b)">
              <span class="wg-m-time">{{ mobileRange(b) }}</span>
              <span class="wg-m-who">{{ b.booker_name }} · {{ row.resource.is_space ? `👥${b.headcount}人` : `×${b.qty}${row.resource.unit || '件'}` }}</span>
              <el-tag size="small" :type="STATUS_META[b.status].type" effect="plain">{{ STATUS_META[b.status].label }}</el-tag>
            </div>
          </div>
          <p v-else class="dim wg-m-empty">当日无占用</p>
          <el-button v-if="project.status === 'open'" size="small" type="primary" plain style="margin-top: 8px"
            @click="mobileBook(row.resource)">＋ 预约该资源</el-button>
        </el-collapse-item>
      </el-collapse>
      <el-empty v-else description="项目内还没有可用资源" :image-size="90" />
    </div>

    <!-- 图例 -->
    <div class="wg-legend">
      <span><i class="lg-confirm"></i>已确认</span>
      <span><i class="lg-pending"></i>待审批（已占位）</span>
      <span><i class="lg-dead"></i>已取消/驳回</span>
      <span v-if="hasItems"><i class="lg-heat-a"></i>半占</span>
      <span v-if="hasItems"><i class="lg-heat-r"></i>约满</span>
      <span><i class="lg-now"></i>当前时刻</span>
      <span v-if="!isMobile" class="dim wg-tip">{{ project.status === 'open' ? '在资源行空白处按住拖动可跨天圈选时段（30 分钟/格）' : '项目已关闭，不再接受新预约' }}</span>
      <span v-else class="dim wg-tip">点开资源可查看当日占用并新建预约</span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import { ElMessage } from 'element-plus';
import {
  KINDS, KIND_MAP, STATUS_META, SLOTS_PER_DAY, OPEN_HH,
  fmtSlot, fmtDate, parseLocal, addDays, mondayOf, durationLabel,
} from '../../utils/booking.js';

const props = defineProps({
  project: { type: Object, required: true },
  data: { type: Object, default: null }, // timeline 响应
  from: { type: Date, required: true }, // 周起点（本地 Date）
  loading: Boolean,
});
const emit = defineEmits(['navigate', 'select-slot', 'select-booking', 'select-resource', 'toggle-history']);

const TOTAL = 7 * SLOTS_PER_DAY; // 210
const WD_CN = ['日', '一', '二', '三', '四', '五', '六'];
const rulerHrs = [7, 9, 11, 13, 15, 17, 19, 21];

const kindFilter = ref(KINDS.map((k) => k.key));
const weekStartMonday = ref(true);
const showHistory = ref(false);
const todayIdx = (from) => {
  const n = new Date();
  for (let i = 0; i < 7; i++) {
    const d = addDays(new Date(from.getFullYear(), from.getMonth(), from.getDate()), i);
    if (d.toDateString() === n.toDateString()) return i;
  }
  return -1;
};
// 周窗口内含今天则默认选中今天，否则取首日；注意传周起点而不是 new Date()
const mobileDay = ref(Math.max(0, todayIdx(props.from)));
const mobileOpen = ref([]);
const drag = ref(null);
const nowD = ref(new Date());
const nowTick = ref(Date.now());
const isMobile = ref(false);
const scrollEl = ref(null);
const mq = window.matchMedia('(max-width: 768px)');
const syncMq = () => { isMobile.value = mq.matches; };

// 打开/翻周后把今天列滚进视口（今天不在本周窗口则回到首日）
function scrollToToday() {
  if (isMobile.value) return;
  const el = scrollEl.value;
  if (!el) return;
  const idx = days.value.findIndex((d) => isSameDay(d, nowD.value));
  if (idx < 0) { el.scrollLeft = 0; return; }
  // 直接量 DOM 列宽，避免从 scrollWidth 反推受边框/滚动条影响
  const cornerW = el.querySelector('.wg-corner')?.offsetWidth || 176;
  const firstDay = el.querySelector('.wg-dayhead');
  const dayW = firstDay ? firstDay.getBoundingClientRect().width : (el.scrollWidth - cornerW) / 7;
  const max = Math.max(0, el.scrollWidth - el.clientWidth);
  // 今天列贴轨道左缘（留 16px 缝隙）：sticky 资源名列固定不参与滚动，
  // 贴左能让未来可见天数最大化（轨道区一屏约 1.4 天）
  el.scrollTo({ left: Math.min(max, Math.max(0, idx * dayW - 16)) });
}

const days = computed(() => {
  const d0 = new Date(props.from.getFullYear(), props.from.getMonth(), props.from.getDate());
  return Array.from({ length: 7 }, (_, i) => addDays(d0, i));
});
const rangeText = computed(() => {
  const a = days.value[0], b = days.value[6];
  return `${a.getMonth() + 1}/${a.getDate()} – ${b.getMonth() + 1}/${b.getDate()}`;
});
const weekLabel = computed(() => (weekStartMonday.value ? '周' : '周（日起）'));

function metaOf(r) { return KIND_MAP[r.kind]; }
function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// ---- 行模型：资源 + 预约块贪心泳道 ----
const rows = computed(() => {
  if (!props.data) return [];
  return props.data.resources
    .filter((r) => kindFilter.value.includes(r.kind))
    .map((resource) => {
      const items = (props.data.bookings || [])
        .filter((b) => b.resource_id === resource.id)
        .map((b) => {
          const cs = clampCol(colOfLocal(b.start_time));
          const ce = Math.max(cs + 1, clampCol(colOfLocal(b.end_time)));
          return { booking: b, cs: Math.floor(cs), ce: Math.min(TOTAL, Math.ceil(ce)), span: 0, lane: 0 };
        })
        .filter((x) => x.ce > 0 && x.cs < TOTAL)
        .map((x) => ({ ...x, span: x.ce - x.cs }))
        .sort((a, b) => a.cs - b.cs || b.ce - a.ce);
      // 贪心泳道（仅块间重叠时换行；半开区间首尾相接可同泳道）
      const laneEnds = [];
      for (const it of items) {
        let lane = laneEnds.findIndex((end) => end <= it.cs);
        if (lane < 0) { lane = laneEnds.length; laneEnds.push(0); }
        it.lane = lane;
        laneEnds[lane] = it.ce;
      }
      return { resource, items, lanes: Math.max(1, laneEnds.length) };
    });
});
const hasItems = computed(() => rows.value.some((r) => !r.resource.is_space));
function rowHeight(lanes) { return 6 + lanes * 26; }

function colOfLocal(slotStr) {
  const d = parseLocal(slotStr);
  if (!d) return 0;
  const day0 = days.value[0];
  const dayDiff = Math.floor(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(day0.getFullYear(), day0.getMonth(), day0.getDate())) / 86400000,
  );
  return dayDiff * SLOTS_PER_DAY + (d.getHours() * 60 + d.getMinutes() - OPEN_HH * 60) / 30;
}
function clampCol(c) { return Math.max(0, Math.min(TOTAL, c)); }
function slotToDate(col) {
  const day = Math.floor(col / SLOTS_PER_DAY);
  const mins = OPEN_HH * 60 + (col % SLOTS_PER_DAY) * 30;
  const d = addDays(days.value[0], day);
  d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
  return d;
}

function blockStyle(b) {
  return {
    left: (b.cs / TOTAL) * 100 + '%',
    width: (b.span / TOTAL) * 100 + '%',
    top: 3 + b.lane * 26 + 'px',
  };
}
function segStyle(s) {
  return {
    left: (s.cs / TOTAL) * 100 + '%',
    width: ((s.ce - s.cs) / TOTAL) * 100 + '%',
  };
}
function blockCls(b) {
  const past = parseLocal(b.end_time) <= nowTick.value;
  return {
    [`st-${b.status}`]: true,
    mine: b.mine,
    past,
  };
}
function blockTitle(b, resource) {
  const who = resource.is_space ? `👥 ${b.headcount} 人` : `借用 ${b.qty} 件`;
  return `${b.booker_name}｜${b.start_time} ~ ${b.end_time}（${durationLabel(b.start_time, b.end_time)}）｜${who}｜${STATUS_META[b.status].label}${b.purpose ? '｜' + b.purpose : ''}`;
}

// ---- 物品库存热度：BLOCKING(pending+confirmed) 按格 Σqty ----
function heat(resource) {
  const used = new Array(TOTAL).fill(0);
  for (const b of (props.data?.bookings || [])) {
    if (b.resource_id !== resource.id || !['pending', 'confirmed'].includes(b.status)) continue;
    const cs = Math.max(0, Math.floor(colOfLocal(b.start_time)));
    const ce = Math.min(TOTAL, Math.ceil(colOfLocal(b.end_time)));
    for (let c = cs; c < ce; c++) used[c] += b.qty;
  }
  const segs = [];
  for (let c = 0; c < TOTAL; c++) {
    if (!used[c]) continue;
    const cls = used[c] >= resource.quantity ? 'heat-r' : 'heat-a';
    const last = segs[segs.length - 1];
    if (last && last.cls === cls && last.ce === c) last.ce = c + 1;
    else segs.push({ cs: c, ce: c + 1, cls });
  }
  return segs;
}

// ---- 当前时刻红线（仅当日 07:00–22:00） ----
function nowLineCol() {
  const n = nowD.value;
  if (!days.value.some((d) => isSameDay(d, n))) return null;
  const mins = n.getHours() * 60 + n.getMinutes();
  if (mins < OPEN_HH * 60 || mins > 22 * 60) return null;
  const dayDiff = days.value.findIndex((d) => isSameDay(d, n));
  return dayDiff * SLOTS_PER_DAY + (mins - OPEN_HH * 60) / 30;
}
let nowTimer = setInterval(() => { nowTick.value = Date.now(); nowD.value = new Date(); }, 60000);

// ---- 拖选：pointerdown/move/up 吸附 30 格（可跨天，夜段折叠） ----
function colFromEvent(e, trackEl) {
  const r = trackEl.getBoundingClientRect();
  const c = Math.floor(((e.clientX - r.left) / r.width) * TOTAL);
  return Math.max(0, Math.min(TOTAL - 1, c));
}
function onDown(e, resource) {
  if (props.project.status !== 'open') return;
  if (e.button !== 0 || e.target.closest('.wg-block')) return;
  const track = e.currentTarget;
  track.setPointerCapture?.(e.pointerId);
  const c0 = colFromEvent(e, track);
  drag.value = { resourceId: resource.id, track, c0, seg: { cs: c0, ce: c0 + 1 } };
  track.addEventListener('pointermove', onMove);
  track.addEventListener('pointerup', onUp, { once: true });
  track.addEventListener('pointercancel', onCancel, { once: true });
}
function onMove(e) {
  if (!drag.value) return;
  const c = colFromEvent(e, drag.value.track);
  drag.value.seg = { cs: Math.min(drag.value.c0, c), ce: Math.max(drag.value.c0, c) + 1 };
}
function onUp() {
  const d = drag.value;
  cleanupDrag();
  if (!d) return;
  const start = slotToDate(d.seg.cs);
  if (start.getTime() <= Date.now()) {
    ElMessage.warning('过去的时段不可预约');
    return;
  }
  emit('select-slot', {
    resource_id: d.resourceId,
    start_time: fmtSlot(start),
    end_time: fmtSlot(slotToDate(d.seg.ce)),
  });
}
function onCancel() { cleanupDrag(); }
function cleanupDrag() {
  if (drag.value?.track) {
    drag.value.track.removeEventListener('pointermove', onMove);
    drag.value.track.removeEventListener('pointerup', onUp);
    drag.value.track.removeEventListener('pointercancel', onCancel);
  }
  drag.value = null;
}

// ---- 导航 ----
function nav(delta) {
  emit('navigate', addDays(props.from, delta * 7));
}
function goToday() {
  const n = new Date();
  if (weekStartMonday.value) {
    emit('navigate', mondayOf(n));
  } else {
    const d = new Date(n); d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - d.getDay());
    emit('navigate', d);
  }
}
// 表单选时默认值：指定日 09:00–10:00；若就是今天且已过点，取下一个半点（收档后顺延次日 09:00）
function manualSlotFor(day) {
  const n = nowD.value;
  const d = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  let startM = 9 * 60;
  if (isSameDay(d, n)) {
    startM = Math.ceil((n.getHours() * 60 + n.getMinutes() + 1) / 30) * 30;
    if (startM < OPEN_HH * 60) startM = 9 * 60;
    if (startM + 60 > 22 * 60) { d.setDate(d.getDate() + 1); startM = 9 * 60; }
  }
  const s = new Date(d); s.setMinutes(startM);
  const e = new Date(d); e.setMinutes(startM + 60);
  return { start_time: fmtSlot(s), end_time: fmtSlot(e) };
}
function quickBook(resource) {
  emit('select-slot', { resource_id: resource.id, ...manualSlotFor(nowD.value), manual: true });
}

// ---- 窄屏 ----
function dayItems(resource) {
  const d = days.value[mobileDay.value];
  const ds = fmtDate(d);
  return (props.data?.bookings || [])
    .filter((b) => b.resource_id === resource.id && b.start_time < `${ds} 22:00` && b.end_time > `${ds} 07:00`)
    .sort((a, b2) => a.start_time.localeCompare(b2.start_time));
}
function mobileRange(b) {
  const d = fmtDate(days.value[mobileDay.value]);
  const s = b.start_time.slice(0, 10) === d ? b.start_time.slice(11) : b.start_time.slice(5);
  const e = b.end_time.slice(0, 10) === d ? b.end_time.slice(11) : b.end_time.slice(5);
  return `${s} ~ ${e}`;
}
function mobileBook(resource) {
  emit('select-slot', { resource_id: resource.id, ...manualSlotFor(days.value[mobileDay.value]), manual: true });
}

onMounted(() => {
  syncMq();
  mq.addEventListener?.('change', syncMq);
  nextTick(scrollToToday);
});
// timeline 数据到达/翻周/历史切换后重新定位（不监听用户纯滚动）
watch(() => props.data, () => nextTick(scrollToToday));
onBeforeUnmount(() => { clearInterval(nowTimer); mq.removeEventListener?.('change', syncMq); cleanupDrag(); });
</script>

<style lang="scss" scoped>
.wg-wrap { display: flex; flex-direction: column; gap: 10px; }
.wg-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.wg-range { font-size: 14px; color: var(--text-2); white-space: nowrap; }
.wg-kinds { margin-left: 8px; }

.wg-scroll { overflow: auto; border: 1px solid var(--border-2); border-radius: 10px; background: var(--card-bg); max-height: 70vh; }
// 列数必须与脚本里 TOTAL = 7 * SLOTS_PER_DAY 一致；首列 = 资源名列宽
$wg-cols: 210;
$wg-name-w: 176px;
.wg-grid {
  display: grid; grid-template-columns: $wg-name-w repeat($wg-cols, minmax(20px, 1fr));
  // 不能写 min-width:100%——会顶替 auto 的 min-content，把网格盒压成视口宽、
  // 210 条轨道溢出盒外，sticky 左列会被钉在（过窄的）网格盒右缘而提前失效。
  min-width: calc(#{$wg-name-w} + #{$wg-cols} * 20px);
  position: relative; user-select: none;
}
.wg-corner {
  position: sticky; left: 0; top: 0; z-index: 30; width: $wg-name-w; height: 46px;
  background: var(--bg-2, #f6f8fa); border-right: 1px solid var(--border-2); border-bottom: 1px solid var(--border-2);
  display: flex; align-items: center; padding: 0 10px; font-size: 12.5px; color: var(--text-3); font-weight: 600;
  white-space: nowrap;
}
.wg-dayhead {
  grid-column: span 30; position: sticky; top: 0; z-index: 20; height: 46px;
  background: var(--bg-2, #f6f8fa); border-bottom: 1px solid var(--border-2);
  border-left: 1px solid var(--border-2); display: flex; flex-direction: column;
  &.weekend { background: var(--bg-3, #eef1f4); }
  &.today .wg-dh-top { color: var(--primary, #2563eb); }
}
.wg-dh-top { font-size: 12.5px; font-weight: 600; padding: 3px 8px 0; display: flex; gap: 6px; align-items: center; }
.wg-today-tag { font-size: 10px; background: var(--primary, #2563eb); color: #fff; border-radius: 4px; padding: 0 4px; font-weight: 400; }
.wg-ruler { position: relative; flex: 1; }
.wg-rtick { position: absolute; top: 3px; font-size: 10px; color: var(--text-3); transform: translateX(-50%); }
.wg-rtick.first { transform: translateX(2px); } // 07:00 落在日界线上，右偏避免与日期/竖线挤在一起

.wg-name {
  grid-column: 1; position: sticky; left: 0; z-index: 10; width: $wg-name-w;
  background: var(--card-bg); border-right: 1px solid var(--border-2); border-top: 1px solid var(--border-2);
  display: flex; align-items: center; justify-content: space-between; gap: 4px; padding: 0 8px;
  &:hover .wg-nadd { opacity: 1; }
}
.wg-ntext { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; cursor: pointer; }
.wg-nmeta { flex: none; font-style: normal; color: var(--text-3); font-size: 11px; white-space: nowrap; }
.wg-nadd { padding: 0 4px; flex: none; opacity: 0; transition: opacity .12s; }
// 触屏没有 hover，＋保持常显
@media (hover: none) { .wg-nadd { opacity: 1; } }
.wg-track {
  grid-column: 2 / -1; position: relative; border-top: 1px solid var(--border-2); cursor: crosshair;
  &:hover .wg-lines { opacity: 1; }
}
.nocreate .wg-track { cursor: default; }
.wg-lines {
  position: absolute; inset: 0; pointer-events: none;
  background:
    repeating-linear-gradient(90deg, var(--border-3, #eef1f4) 0 1px, transparent 1px calc(100% / 30)) 0 0 / calc(100% / 7) 100% repeat-x,
    repeating-linear-gradient(90deg, var(--border-2, #d9dee3) 0 1px, transparent 1px calc(100% / 7));
}

// 库存热度
.wg-heat { position: absolute; top: 0; bottom: 0; pointer-events: none; }
.heat-a { background: rgba(245, 158, 11, .13); }
.heat-r { background: rgba(239, 68, 68, .15); }

// 预约块
.wg-block {
  position: absolute; height: 22px; border-radius: 5px; z-index: 5;
  display: flex; align-items: center; gap: 5px; padding: 0 6px; overflow: hidden;
  font-size: 11.5px; cursor: pointer; white-space: nowrap; border: 1px solid transparent;
  transition: transform .08s;
  &:hover { transform: translateY(-1px); box-shadow: 0 2px 8px rgba(0, 0, 0, .18); z-index: 8; }
  .wg-bk-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
  .wg-bk-meta { flex: none; opacity: .9; }
  .wg-bk-dur { flex: none; opacity: .8; font-size: 10.5px; }
}
.st-confirmed { background: #2563eb; color: #fff; border-color: #1d4ed8; }
.st-pending {
  background: repeating-linear-gradient(45deg, #fef3c7, #fef3c7 5px, #fde68a 5px, #fde68a 10px);
  color: #92400e; border-color: #f59e0b;
}
.st-rejected, .st-canceled { background: transparent; color: var(--text-3); border: 1px dashed var(--border-2, #c0c6cc); }
.wg-block.mine { box-shadow: 0 0 0 2px var(--primary, #7c3aed) inset; }
.wg-block.past { opacity: .5; }

.wg-now { position: absolute; top: 0; bottom: 0; width: 2px; background: #ef4444; z-index: 9; pointer-events: none;
  &::after { content: ''; position: absolute; top: -3px; left: -3px; width: 8px; height: 8px; border-radius: 50%; background: #ef4444; }
}
.wg-select {
  position: absolute; top: 2px; bottom: 2px; z-index: 7; pointer-events: none;
  background: rgba(37, 99, 235, .22); border: 1.5px solid #2563eb; border-radius: 4px;
}

// 窄屏
.wg-m-name { font-size: 13.5px; }
.wg-m-list { display: flex; flex-direction: column; gap: 6px; }
.wg-m-item {
  display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 8px;
  border: 1px solid var(--border-2); font-size: 12.5px; cursor: pointer; background: var(--card-bg);
  &.mine { border-color: var(--primary, #2563eb); }
  &.st-confirmed { border-left: 3px solid #2563eb; }
  &.st-pending { border-left: 3px solid #f59e0b; }
  &.st-rejected, &.st-canceled { opacity: .6; border-left: 3px solid var(--text-3); }
}
.wg-m-time { font-weight: 600; white-space: nowrap; }
.wg-m-who { flex: 1; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wg-m-empty { margin: 4px 0; font-size: 12.5px; }

.wg-legend { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--text-2);
  i { display: inline-block; width: 14px; height: 10px; border-radius: 3px; margin-right: 4px; vertical-align: -1px; }
  .lg-confirm { background: #2563eb; }
  .lg-pending { background: repeating-linear-gradient(45deg, #fef3c7, #fef3c7 3px, #fde68a 3px, #fde68a 6px); border: 1px solid #f59e0b; }
  .lg-dead { border: 1px dashed var(--border-2, #999); }
  .lg-heat-a { background: rgba(245, 158, 11, .4); }
  .lg-heat-r { background: rgba(239, 68, 68, .4); }
  .lg-now { width: 2px; background: #ef4444; }
}
.wg-tip { margin-left: auto; }
.dim { color: var(--text-3); }

@media (max-width: 768px) {
  .wg-kinds { margin-left: 0; }
  .wg-tip { margin-left: 0; width: 100%; }
}
</style>
