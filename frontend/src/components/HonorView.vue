<script setup>
// 荣誉墙：三种呈现 —— ①「精选」Apple 极简编辑流（默认）②「流动展厅」奖状多行反向跑马灯
// ③「荣誉殿堂」证书网格。公开免登录，内容由管理员在后台维护。
//
// —— 默认是「精选」，不是跑马灯（2026-09-27 改的口径）。跑马灯的守护断言要先切到 flow 视图。 ——
//
// —— 跑马灯是无缝循环，靠一条数学恒等式：**轨道恰好是两份等宽的副本**，动画从 0 位移到 -50%。
// 两个必须守住的点（写错就是"看着在动但其实是坏的"）：
//   ① 卡片间距用**每张卡的 margin-right**，不能用容器的 flex gap。
//      gap 只在相邻项之间插入、不在两份副本的接缝处出现，轨道宽 = 2kh·W + G 而不是 2kh·W，
//      -50% 就差了半个间距 → 每滚一圈画面横跳一下。用 margin-right，半份宽精确等于 n·(w+gap)。
//   ② 半份必须**铺满视口**，否则滚到接缝处会露出一段空白。重复次数 k 由实测视口宽算出来。
//
// 卡片宽/间距/图盒高都由 JS 常量给出、以 CSS 变量喂给样式表（单一事实来源），
// 避免"CSS 里写 228px、JS 里算 232px"这种漂移 —— 那种漂移同样会破坏 -50% 的等式。
//
// 装饰元素（顶边色条 .haccent / 奖牌点）一律 position:absolute，不进 flex 流、不改变卡片外宽。
// 切换视图靠 v-if，各视图用独立类名（.editorial/.ecard、.marquee/.hcard、.hall-grid/.gcard）。
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api.js';
import auth from '../auth.js';
import { openImage } from '../utils/imageViewer.js';
import { LEVEL_OPTS, RANK_OPTS } from '../utils/honorMeta.js';
import { canAdmin } from '../utils/adminPerms.js';

const router = useRouter();

const list = ref([]);
const loading = ref(true);
const err = ref('');

// —— 几何常量（跑马灯用，整数 px）——
const GAP = 16;             // 卡片间距，做进卡片的 margin-right
const SPEED = 42;           // 基准像素速度 px/s（各行按 SPEED_MULT 微差，避免整墙同频）
const SPEED_MULT = [1, 0.82, 1.18];
const PER_ROW = 6;          // 每行条数的分档基数

const rowsRef = ref(null);
const vw = ref(1200);       // 行视口实测宽（ResizeObserver）
let ro = null;

// 桌面/窄屏两档卡片宽（用实测宽判定，不在 CSS 里再写一份 @media）
const narrow = computed(() => vw.value <= 768);
const cardW = computed(() => (narrow.value ? 150 : 228));
const boxH = computed(() => (narrow.value ? 96 : 132));
const W = computed(() => cardW.value + GAP); // 每张卡占的外宽

// 无障碍：系统开了"减弱动态效果"就彻底不滚，退化成可手动横滚的静态行（内容一张不少）
const reduced = ref(false);
let mq = null;
const onMq = (e) => { reduced.value = e.matches; };

// —— 四维筛选：级别 / 奖等 / 班级 / 赛项。每维单选、维间交集；状态本地留存不进 URL（同 TimelineView 口径）——
const fv = reactive({ level: '', rank: '', cls: '', event: '' });
// 从全量 list 聚合计数（chips 始终展示全集分布，不只展示当前筛选结果）
function tally(getter) {
  const m = new Map();
  for (const h of list.value) {
    for (const v of getter(h) || []) {
      const k = String(v || '').trim();
      if (k) m.set(k, (m.get(k) || 0) + 1);
    }
  }
  return m;
}
// 级别/奖等按固定枚举顺序排（库里出现才显示），枚举外的自建值按计数补在后面；班级/赛项纯按计数
function canonOpts(map, canon) {
  return [
    ...canon.filter((v) => map.has(v)).map((v) => ({ v, n: map.get(v) })),
    ...[...map.entries()].filter(([v]) => !canon.includes(v))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([v, n]) => ({ v, n })),
  ];
}
const countOpts = (map) => [...map.entries()]
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .map(([v, n]) => ({ v, n }));
const chipGroups = computed(() => [
  { key: 'level', label: '级别', options: canonOpts(tally((h) => [h.award_level]), LEVEL_OPTS) },
  { key: 'rank', label: '奖等', options: canonOpts(tally((h) => [h.prize_rank]), RANK_OPTS) },
  { key: 'cls', label: '班级', options: countOpts(tally((h) => h.class_tags)) },
  { key: 'event', label: '赛项', options: countOpts(tally((h) => [h.event_name])) },
]);
function pickChip(key, v) { fv[key] = fv[key] === v ? '' : v; }

// 选中值已不在选项里（换数据/标签被删）→ 这一维视同「全部」，避免永久空筛选
const filteredList = computed(() => {
  const valid = {};
  for (const g of chipGroups.value) valid[g.key] = new Set(g.options.map((o) => o.v));
  return list.value.filter((h) =>
    (!fv.level || !valid.level.has(fv.level) || h.award_level === fv.level) &&
    (!fv.rank || !valid.rank.has(fv.rank) || h.prize_rank === fv.rank) &&
    (!fv.cls || !valid.cls.has(fv.cls) || (h.class_tags || []).includes(fv.cls)) &&
    (!fv.event || !valid.event.has(fv.event) || h.event_name === fv.event)
  );
});

const rowCount = computed(() => {
  const n = filteredList.value.length;
  if (!n) return 0;
  return Math.min(narrow.value ? 2 : 3, Math.max(1, Math.ceil(n / PER_ROW)));
});

// 分行用**轮转**（i % R）而不是切块：切块会让第一行独占全部最高优先项、最后一行吃剩饭；
// 轮转把排序权重均摊到各行，观感等重，条数差也天然 ≤1
const buckets = computed(() => {
  const R = rowCount.value;
  const out = Array.from({ length: R }, () => []);
  filteredList.value.forEach((h, i) => out[i % R].push(h));
  return out;
});

const lanes = computed(() => buckets.value.map((bucket, i) => {
  if (!bucket.length) return null;
  // 半份重复到"至少铺满视口 + 一张卡"的余量，保证滚到任意相位都不会露空
  const k = reduced.value ? 1 : Math.max(1, Math.ceil((vw.value + W.value) / (bucket.length * W.value)));
  const half = [];
  for (let r = 0; r < k; r++) half.push(...bucket);
  const halfW = half.length * W.value;
  const speed = SPEED * SPEED_MULT[i % SPEED_MULT.length];
  return {
    i, half, halfW, n: bucket.length,
    // 恒定**像素**速度：若所有行用同一个时长，条目多的行会明显跑得更快、像在互相追
    dur: +(halfW / speed).toFixed(2),
    rev: i % 2 === 1,
  };
}).filter(Boolean));

const copies = computed(() => (reduced.value ? 1 : 2)); // 降级时只渲染一份
const trackVars = computed(() => ({ '--hw': `${cardW.value}px`, '--hg': `${GAP}px`, '--bh': `${boxH.value}px` }));

// —— 荣誉等级（视觉分组，不替代原始 award_level 文案）——
// 按「授予范围」分三档：国家/国际 = 金，省部/区域 = 银，市校院/其他 = 铜。
// award_level 可能只写了"一等奖"，故连标题一起匹配；原始文案照常全显，分档只是配色。
const TIER_RE = [
  ['gold', /(国际|国家|全国|世界|全球|洲际)/],
  ['silver', /(省|部|大区|赛区|华东|华北|华南|华中|西南|西北|东北|中南)/],
  ['bronze', /(市|州|地区|校|院|区|县)/],
];
const tierOf = (h) => {
  const s = `${h.award_level || ''} ${h.title || ''}`;
  return TIER_RE.find(([, re]) => re.test(s))?.[0] || 'bronze';
};

// —— 视图模式：精选（默认）/ 流动展厅 / 荣誉殿堂。偏好记住 ——
// 默认 editorial 是 2026-09-27 新口径（Apple 极简编辑流为着陆体验）
const MODES = [
  { k: 'editorial', label: '精选' },
  { k: 'flow', label: '流动' },
  { k: 'hall', label: '殿堂' },
];
const mode = ref(MODES.some((m) => m.k === localStorage.getItem('honor_mode')) ? localStorage.getItem('honor_mode') : 'editorial');
watch(mode, (v) => localStorage.setItem('honor_mode', v));

const stat = computed(() => {
  const n = list.value.length;
  const top = list.value.filter((h) => /国家|国际/.test(h.award_level || '')).length;
  const years = new Set(
    list.value.map((h) => (h.award_date || '').slice(0, 4)).filter((y) => /^\d{4}$/.test(y))
  ).size;
  return { n, top, years };
});

// 图挂了（磁盘文件丢失/被清）不留红叉：换成占位符
const broken = ref(new Set());
const onImgErr = (id) => { broken.value = new Set(broken.value).add(id); };
const showImg = (h) => h.has_image && !broken.value.has(h.id);

const pad2 = (i) => String(i + 1).padStart(2, '0');

// —— 精选视图：滚动渐显（IntersectionObserver）——
// 内容安全优先：**默认就是可见的**。只有在「支持 IntersectionObserver 且未开减弱动态」时，
// 才给容器加 .js-reveal（此时未进视口的卡片才隐藏）。脚本不跑/被拦/降级 → 内容照样全显。
const editorialRef = ref(null);
let rvObs = null;
function bindReveal(el) {
  rvObs?.disconnect();
  rvObs = null;
  if (reduced.value || !('IntersectionObserver' in window)) return;
  el.classList.add('js-reveal');
  rvObs = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add('in'); rvObs.unobserve(e.target); }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
  el.querySelectorAll('.ecard').forEach((c) => rvObs.observe(c));
}

async function load() {
  loading.value = true;
  try {
    const d = await api.honorList();
    list.value = d.list || [];
    err.value = '';
  } catch (e) {
    err.value = e.message || '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  reduced.value = mq.matches;
  mq.addEventListener?.('change', onMq);
  load();
  // 观察行容器实测宽（不要用 innerWidth 减 padding 去猜）：转屏/缩放后必须重算 k
  if (rowsRef.value) {
    ro = new ResizeObserver(([e]) => { vw.value = Math.round(e.contentRect.width) || vw.value; });
    ro.observe(rowsRef.value);
    vw.value = rowsRef.value.clientWidth || vw.value;
  }
});

onBeforeUnmount(() => {
  ro?.disconnect();
  rvObs?.disconnect();
  mq?.removeEventListener?.('change', onMq);
});

// 列表空→有、以及视图切换都会让各容器卸载重挂，元素变了就重新绑定
watch(rowsRef, (el) => {
  if (el) {
    ro?.disconnect();
    ro = new ResizeObserver(([e]) => { vw.value = Math.round(e.contentRect.width) || vw.value; });
    ro.observe(el);
    vw.value = el.clientWidth || vw.value;
  }
});
watch(editorialRef, (el) => { if (el) bindReveal(el); else rvObs?.disconnect(); });
// 筛选后 .ecard 节点整批重建（v-for key 是 honor id），新节点必须重新进观察器，
// 否则筛选后滚出来的卡片永远停在隐藏态。bindReveal 内先 disconnect，已 .in 的卡片类名不受影响
watch(filteredList, () => {
  if (mode.value === 'editorial' && editorialRef.value) nextTick(() => bindReveal(editorialRef.value));
});
</script>

<template>
  <div class="honor-page">
    <div class="honor-wrap">
      <!-- 加载态保持高度：整块塌缩会让浏览器把 scrollY 钳回顶部（本仓 3753f7a 的教训） -->
      <div v-if="loading" class="card honor-skel" aria-busy="true">
        <span class="sk-bar" v-for="i in 3" :key="i"></span>
      </div>

      <div v-else-if="err" class="card honor-rstate err">
        <p>😵 {{ err }}</p>
        <button class="adm" type="button" @click="load">重试</button>
      </div>

      <div v-else-if="!list.length" class="card honor-rstate">
        <el-empty description="荣誉墙正在建设中" />
        <button v-if="canAdmin('honor')" class="adm" type="button" @click="router.push('/admin-console?tab=honors')">
          🏅 去上传第一张奖状
        </button>
      </div>

      <template v-else>
        <!-- ===== ① 精选 hero（满屏着陆；与卡片列表拆成兄弟节点，好让筛选栏夹在中间） ===== -->
        <header v-if="mode === 'editorial'" class="e-hero">
          <p class="e-eyebrow">HALL&nbsp;&nbsp;OF&nbsp;&nbsp;HONOR</p>
          <h1 class="e-title">荣誉墙</h1>
          <p class="e-sub">每一块奖牌背后，都是一整个赛季的加班</p>
          <p class="e-statline">
            {{ stat.n }} 项荣誉<i>·</i>国家级 / 国际级 {{ stat.top }} 项
            <template v-if="stat.years"><i>·</i>跨越 {{ stat.years }} 个获奖年份</template>
          </p>
          <button v-if="canAdmin('honor')" class="e-adm" type="button" @click="router.push('/admin-console?tab=honors')">
            ⚙️ 后台维护
          </button>
          <span class="e-cue" aria-hidden="true">
            <span class="e-cue-txt">向下滚动</span>
            <span class="e-cue-line"></span>
          </span>
        </header>

        <!-- ===== 四维筛选（三视图共用；选中态本地留存，不进 URL） ===== -->
        <div class="honor-filters card" role="group" aria-label="按标签筛选荣誉">
          <div class="hf-row" v-for="g in chipGroups" :key="g.key">
            <span class="hf-label">{{ g.label }}</span>
            <div class="hf-chips">
              <button class="hchip" type="button" :class="{ on: !fv[g.key] }" @click="fv[g.key] = ''">
                全部
              </button>
              <button
                v-for="o in g.options" :key="o.v" type="button"
                class="hchip" :class="{ on: fv[g.key] === o.v }"
                @click="pickChip(g.key, o.v)"
              >{{ o.v }}<i>{{ o.n }}</i></button>
            </div>
          </div>
        </div>

        <!-- 筛选无结果（三视图共用的空态） -->
        <div v-if="!filteredList.length" class="card honor-rstate">
          <el-empty description="该筛选条件下暂无奖状" />
        </div>

        <!-- ===== ① 精选：Apple 极简编辑流（默认） ===== -->
        <div v-if="mode === 'editorial'" class="editorial" ref="editorialRef">
          <template v-if="filteredList.length">
          <section
            v-for="(h, i) in filteredList" :key="h.id"
            class="ecard" :class="[`t-${tierOf(h)}`, { 'is-feature': i === 0 }]"
          >
            <p class="e-kicker">
              <span class="e-num">{{ pad2(i) }}</span>
              <span class="e-kicker-sep" v-if="h.award_level">·</span>
              <span class="e-lvl" v-if="h.award_level">
                <i class="tdot" aria-hidden="true"></i>{{ h.award_level }}
              </span>
              <span class="e-kicker-sep" v-if="h.prize_rank">·</span>
              <span class="e-lvl" v-if="h.prize_rank">{{ h.prize_rank }}</span>
            </p>
            <h2 class="e-name">{{ h.title }}</h2>

            <button
              class="e-pic" type="button" draggable="false"
              :class="{ 'is-static': !showImg(h) }"
              @click="showImg(h) && openImage(h.image_url, h.title)"
            >
              <img
                v-if="showImg(h)" :src="h.image_url" :alt="h.title"
                decoding="async" draggable="false" @error="onImgErr(h.id)"
              />
              <span v-else class="e-ph">🏅</span>
            </button>
            <span class="e-zoomhint" v-if="showImg(h)">点击图片查看大图</span>

            <p class="e-tags" v-if="h.event_name || (h.class_tags && h.class_tags.length)">
              <i class="etag etag-event" v-if="h.event_name">🎯 {{ h.event_name }}</i>
              <i class="etag" v-for="c in (h.class_tags || [])" :key="c">🏫 {{ c }}</i>
            </p>

            <p class="e-meta">
              <span v-if="h.award_date">🗓 {{ h.award_date }}</span>
              <span v-if="h.winner">👤 {{ h.winner }}</span>
            </p>
            <p class="e-desc" v-if="h.description">{{ h.description }}</p>
          </section>

          <footer class="e-foot">
            <i></i><span>已展示全部 {{ filteredList.length }} 项荣誉</span><i></i>
          </footer>
          </template>
        </div>

        <!-- ===== ② 流动展厅：跑马灯（reduced 时同一套 DOM 退化成可横滚的静态行） ===== -->
        <div v-if="mode === 'flow'" class="honor-rows" ref="rowsRef" :class="{ 'is-reduced': reduced }" :style="trackVars">
          <div
            v-for="lane in lanes" :key="lane.i"
            class="marquee" :class="{ 'is-rev': lane.rev }"
          >
            <div class="track" :style="{ animationDuration: lane.dur + 's' }">
              <div class="half" v-for="c in copies" :key="c">
                <button
                  v-for="(h, ci) in lane.half" :key="`${h.id}-${c}-${ci}`"
                  class="hcard" type="button" draggable="false"
                  :class="[`t-${tierOf(h)}`, { 'is-static': !showImg(h) }]"
                  :aria-hidden="(c > 1 || ci >= lane.n) ? 'true' : null"
                  :tabindex="(c === 1 && ci < lane.n && showImg(h)) ? 0 : -1"
                  @click="showImg(h) && openImage(h.image_url, h.title)"
                >
                  <span class="haccent" aria-hidden="true"></span>
                  <span class="hpic">
                    <img
                      v-if="showImg(h)" :src="h.image_url" :alt="h.title"
                      decoding="async" draggable="false" @error="onImgErr(h.id)"
                    />
                    <span v-else class="hph">🏅</span>
                  </span>
                  <b class="httl">{{ h.title }}</b>
                  <span class="htiers" v-if="h.award_level || h.prize_rank">
                    <span class="htier" v-if="h.award_level">
                      <i class="tdot" aria-hidden="true"></i>{{ h.award_level }}
                    </span>
                    <span class="htier htier-rank" v-if="h.prize_rank">{{ h.prize_rank }}</span>
                  </span>
                  <span class="hevent" v-if="h.event_name">🎯 {{ h.event_name }}</span>
                  <span class="hclass" v-if="h.class_tags && h.class_tags.length">
                    🏫 {{ h.class_tags.join('、') }}
                  </span>
                  <span class="hmeta" v-if="h.award_date">🗓 {{ h.award_date }}</span>
                  <span class="hwin" v-if="h.winner">👤 {{ h.winner }}</span>
                </button>
              </div>
            </div>
          </div>
          <p class="honor-tip" v-if="!reduced && filteredList.length">把鼠标停在某一行可以暂停滚动 · 点奖状看大图</p>
        </div>

        <!-- ===== ③ 荣誉殿堂：证书网格（更大、带描述） ===== -->
        <div v-if="mode === 'hall'" class="hall-grid">
          <button
            v-for="h in filteredList" :key="h.id"
            class="gcard" type="button" draggable="false"
            :class="[`t-${tierOf(h)}`, { 'is-static': !showImg(h) }]"
            @click="showImg(h) && openImage(h.image_url, h.title)"
          >
            <span class="haccent" aria-hidden="true"></span>
            <span class="gpic">
              <img
                v-if="showImg(h)" :src="h.image_url" :alt="h.title"
                loading="lazy" decoding="async" draggable="false" @error="onImgErr(h.id)"
              />
              <span v-else class="gph">🏅</span>
            </span>
            <b class="gttl">{{ h.title }}</b>
            <span class="htiers" v-if="h.award_level || h.prize_rank">
              <span class="htier" v-if="h.award_level">
                <i class="tdot" aria-hidden="true"></i>{{ h.award_level }}
              </span>
              <span class="htier htier-rank" v-if="h.prize_rank">{{ h.prize_rank }}</span>
            </span>
            <span class="hevent" v-if="h.event_name">🎯 {{ h.event_name }}</span>
            <span class="hclass" v-if="h.class_tags && h.class_tags.length">
              🏫 {{ h.class_tags.join('、') }}
            </span>
            <span class="gdesc" v-if="h.description">{{ h.description }}</span>
            <span class="gfoot">
              <span v-if="h.award_date">🗓 {{ h.award_date }}</span>
              <span v-if="h.winner">👤 {{ h.winner }}</span>
            </span>
          </button>
        </div>

        <!-- 视图切换：固定悬浮、玻璃拟态，不抢内容（查看器 z-index:3000 在它之上） -->
        <div class="mode-dock" role="tablist">
          <button
            v-for="m in MODES" :key="m.k" type="button" role="tab"
            :aria-selected="mode === m.k" :class="{ on: mode === m.k }"
            @click="mode = m.k"
          >{{ m.label }}</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped lang="scss">
.honor-page { position: relative; min-height: 100vh; padding: 18px 14px 110px; }
.honor-wrap { position: relative; z-index: 1; max-width: 1200px; margin: 0 auto; }

.card {
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px 20px;
  margin-bottom: 14px;
}

// ==================== 骨架 / 状态 ====================
.honor-skel { display: flex; flex-direction: column; gap: 14px; }
.sk-bar {
  height: 196px; border-radius: 10px; background: var(--surface-2);
  animation: sk-pulse 1.2s ease-in-out infinite;
}
@keyframes sk-pulse { 50% { opacity: .55; } }
.honor-rstate { text-align: center; }
.honor-rstate p { color: var(--text-2); }
.adm {
  font-size: 12px; padding: 5px 12px; border-radius: 8px; cursor: pointer;
  color: var(--primary); background: var(--primary-tint);
  border: 1px solid color-mix(in srgb, var(--primary) 33%, transparent);
  transition: all .2s ease;
  &:hover { background: color-mix(in srgb, var(--primary) 18%, transparent); }
}

// ==================== 荣誉等级配色（金/银/铜） ====================
.t-gold   { --t: #b8860b; --t2: #ecc94b; }
.t-silver { --t: #64748b; --t2: #aab4c2; }
.t-bronze { --t: #a2602a; --t2: #cf8f5b; }

// 共用：奖牌点（跑马灯/殿堂胶囊与精选 kicker 都用它）
.tdot {
  display: inline-block; flex: none; width: 7px; height: 7px; border-radius: 50%;
  background: radial-gradient(circle at 30% 30%, var(--t2), var(--t));
}
// 跑马灯/殿堂的顶边色条与等级胶囊
.haccent {
  position: absolute; top: 0; left: 12px; right: 12px; height: 3px; border-radius: 0 0 3px 3px;
  background: linear-gradient(90deg, var(--t), var(--t2), var(--t));
  opacity: .85;
}
.htier {
  display: inline-flex; align-items: center; gap: 5px;
  align-self: flex-start; max-width: 100%;
  font-size: 11px; line-height: 1; padding: 4px 8px; border-radius: 6px;
  color: var(--t);
  background: color-mix(in srgb, var(--t) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--t) 26%, transparent);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

// ==================== 四维筛选栏（级别/奖等/班级/赛项，三视图共用） ====================
.honor-filters {
  position: sticky; top: 8px; z-index: 20;
  display: flex; flex-direction: column; gap: 8px;
  padding: 12px 16px; margin-bottom: 16px;
  background: color-mix(in srgb, var(--card-bg) 90%, transparent);
  -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
}
.hf-row { display: flex; align-items: flex-start; gap: 10px; }
.hf-label {
  flex: none; width: 34px; padding-top: 4px;
  font-size: 12px; letter-spacing: 1px; color: var(--text-3);
}
.hf-chips { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
.hchip {
  font: inherit; font-size: 12px; line-height: 1; white-space: nowrap; cursor: pointer;
  padding: 5px 12px; border-radius: 999px;
  color: var(--text-2); background: var(--card-bg);
  border: 1px solid var(--border);
  transition: color .18s ease, border-color .18s ease, background .18s ease;
  i { margin-left: 5px; font-style: normal; font-size: 10px; color: var(--text-3); }
  &:hover { color: var(--text); border-color: color-mix(in srgb, var(--primary) 45%, var(--border)); }
  &.on {
    color: var(--primary); font-weight: 600;
    background: var(--primary-tint);
    border-color: color-mix(in srgb, var(--primary) 45%, transparent);
    i { color: var(--primary); }
  }
}

// ==================== 悬浮视图切换 ====================
.mode-dock {
  position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); z-index: 1000;
  display: flex; gap: 2px; padding: 4px;
  background: color-mix(in srgb, var(--card-bg) 82%, transparent);
  -webkit-backdrop-filter: blur(18px) saturate(1.4); backdrop-filter: blur(18px) saturate(1.4);
  border: 1px solid var(--border); border-radius: 999px;
  box-shadow: 0 14px 34px -14px rgba(2, 10, 25, .28);
  button {
    font: inherit; font-size: 12px; letter-spacing: 1px; white-space: nowrap; cursor: pointer;
    padding: 7px 18px; border: 0; border-radius: 999px;
    color: var(--text-2); background: transparent; transition: all .2s ease;
    &:hover { color: var(--text); background: var(--surface-2); }
    &.on { color: #fff; background: var(--primary); font-weight: 600; }
  }
}

// ==================== ① 精选：Apple 极简编辑流 ====================
.editorial { -webkit-font-smoothing: antialiased; }

.e-hero {
  position: relative;
  min-height: calc(100vh - 120px);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  text-align: center;
  padding: 80px 0 60px;
  animation: hero-rise .8s cubic-bezier(.22, .61, .36, 1) both;
}
@keyframes hero-rise { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: none; } }

.e-eyebrow { margin: 0; font-size: 12px; letter-spacing: .42em; text-indent: .42em; color: var(--text-2); }
.e-title {
  margin: 22px 0 0; font-size: clamp(52px, 9vw, 96px); font-weight: 700;
  letter-spacing: 4px; line-height: 1.05; color: var(--text);
}
.e-sub { margin: 22px 0 0; font-size: clamp(15px, 2vw, 18px); color: var(--text-2); }
.e-statline {
  margin: 26px 0 0; font-size: 13px; color: var(--text-3);
  i { margin: 0 10px; font-style: normal; color: var(--border-2); }
}
.e-adm {
  margin-top: 26px; cursor: pointer; font-size: 13px; padding: 9px 22px; border-radius: 999px;
  color: var(--primary); background: var(--primary-tint);
  border: 1px solid color-mix(in srgb, var(--primary) 30%, transparent);
  transition: all .2s ease;
  &:hover { background: color-mix(in srgb, var(--primary) 18%, transparent); }
}

// 滚动提示：细线纵向滑下
.e-cue { position: absolute; bottom: 84px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 10px; }
.e-cue-txt { font-size: 11px; letter-spacing: 2px; color: var(--text-3); }
.e-cue-line { width: 1px; height: 42px; background: linear-gradient(180deg, var(--border-2), transparent); position: relative; overflow: hidden; }
.e-cue-line::after {
  content: ''; position: absolute; left: 0; top: -40%; width: 100%; height: 40%;
  background: var(--text); animation: cue-drop 1.9s cubic-bezier(.5, 0, .6, 1) infinite;
}
@keyframes cue-drop { 0% { top: -40%; opacity: 0; } 25% { opacity: 1; } 100% { top: 110%; opacity: 0; } }

// —— 每项一屏 ——
.ecard {
  display: flex; flex-direction: column; align-items: center; text-align: center;
  padding: 56px 0;
  margin-bottom: 24px;
}
.ecard.is-feature { padding-top: 40px; }

.e-kicker {
  display: flex; align-items: center; gap: 9px; margin: 0;
  font-size: 12px; letter-spacing: 2px; color: var(--text-3);
}
.e-num { font-family: var(--font-mono); }
.e-kicker-sep { color: var(--border-2); }
.e-lvl { display: inline-flex; align-items: center; gap: 6px; color: var(--text-2); }

.e-name {
  margin: 18px 0 0; max-width: 820px;
  color: var(--text); font-weight: 600; line-height: 1.25; letter-spacing: .5px;
  font-size: clamp(26px, 3.4vw, 40px);
}
.ecard.is-feature .e-name { font-size: clamp(30px, 4.4vw, 50px); }

// 奖状：软阴影卡纸相框（Apple 产品图的处理：大圆角、柔和环境阴影）
.e-pic {
  margin-top: 40px; padding: 20px; cursor: zoom-in;
  width: 100%; max-width: 640px;
  display: flex; align-items: center; justify-content: center;
  background: var(--card-bg);
  border: 1px solid var(--border); border-radius: 22px;
  box-shadow: 0 40px 70px -38px rgba(2, 10, 25, .22), 0 10px 24px -16px rgba(2, 10, 25, .14);
  transition: transform .35s cubic-bezier(.22, .61, .36, 1), box-shadow .35s ease;
  img { width: 100%; height: 100%; max-height: 360px; object-fit: contain; }
  &:hover {
    transform: translateY(-4px);
    box-shadow: 0 52px 90px -42px rgba(2, 10, 25, .3), 0 14px 30px -18px rgba(2, 10, 25, .18);
  }
  &.is-static { cursor: default; &:hover { transform: none; } }
}
.ecard.is-feature .e-pic { max-width: 760px; }
.ecard.is-feature .e-pic img { max-height: 440px; }
.e-ph { font-size: 56px; opacity: .4; padding: 60px 0; }

.e-zoomhint { margin-top: 14px; font-size: 11px; letter-spacing: 1px; color: var(--text-3); }

// 赛项/班级胶囊行（精选视图，居中）
.e-tags {
  margin: 20px auto 0; max-width: 640px;
  display: flex; justify-content: center; flex-wrap: wrap; gap: 8px;
}
.etag {
  font-style: normal; font-size: 12px; line-height: 1;
  padding: 5px 13px; border-radius: 999px;
  color: var(--text-2); background: var(--surface-2);
  border: 1px solid var(--border);
}
.etag-event {
  color: var(--primary); background: var(--primary-tint);
  border-color: color-mix(in srgb, var(--primary) 30%, transparent);
}

.e-meta {
  margin: 26px 0 0; display: flex; justify-content: center; gap: 22px; flex-wrap: wrap;
  font-size: 13px; color: var(--text-2);
}
.e-desc { margin: 18px auto 0; max-width: 580px; font-size: 14px; line-height: 1.9; color: var(--text-2); }

.e-foot {
  display: flex; align-items: center; gap: 16px;
  padding: 60px 0 100px;
  i { flex: 1; height: 1px; background: linear-gradient(90deg, transparent, var(--border)); }
  i:last-child { background: linear-gradient(90deg, var(--border), transparent); }
  span { font-size: 12px; letter-spacing: 2px; color: var(--text-3); white-space: nowrap; }
}

// —— 滚动渐显：默认可见，仅 .js-reveal（JS 确认可用才加）下做动画 ——
.editorial .ecard > * {
  transition: opacity .85s cubic-bezier(.22, .61, .36, 1), transform .85s cubic-bezier(.22, .61, .36, 1);
}
.editorial.js-reveal .ecard:not(.in) > * { opacity: 0; transform: translateY(28px); }
.editorial.js-reveal .ecard.in > * { opacity: 1; transform: none; }
// 同级内的微错峰：序号/等级 → 标题 → 图 → 提示 → 元信息 → 描述
.editorial.js-reveal .ecard.in .e-kicker { transition-delay: 0s; }
.editorial.js-reveal .ecard.in .e-name { transition-delay: .07s; }
.editorial.js-reveal .ecard.in .e-pic { transition-delay: .14s; }
.editorial.js-reveal .ecard.in .e-zoomhint { transition-delay: .2s; }
.editorial.js-reveal .ecard.in .e-meta { transition-delay: .24s; }
.editorial.js-reveal .ecard.in .e-desc { transition-delay: .3s; }

// ==================== ② 流动展厅：跑马灯 ====================
.honor-rows { display: flex; flex-direction: column; gap: 14px; }

/* 行视口：必须 overflow:hidden，否则轨道会把整页撑出横向滚动 */
.marquee {
  overflow: hidden;
  padding: 2px 0;
  /* 两侧渐隐：把硬切边变成有意的观感（mask 不是颜色，双主题通吃） */
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 4%, #000 96%, transparent);
  mask-image: linear-gradient(90deg, transparent, #000 4%, #000 96%, transparent);
  /* hover 与键盘聚焦都要能停下来（卡片是按钮，Tab 过去时不停根本点不到） */
  &:hover .track, &:focus-within .track { animation-play-state: paused; }
}

.track {
  display: flex;
  width: max-content;          /* 必须：否则轨道塌成视口宽，-50% 就没有意义了 */
  will-change: transform;
  animation-name: honor-rtl;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
}
.marquee.is-rev .track { animation-name: honor-ltr; }

/* 两份等宽副本：位移 -50% 恰好等于一份的宽度，回绕点不可见 */
@keyframes honor-rtl { from { transform: translate3d(0, 0, 0); } to { transform: translate3d(-50%, 0, 0); } }
@keyframes honor-ltr { from { transform: translate3d(-50%, 0, 0); } to { transform: translate3d(0, 0, 0); } }

.half { display: flex; }

.hcard {
  position: relative;
  flex: none;
  width: var(--hw);
  margin-right: var(--hg);     /* ★ 间距做进卡片自身，不能用容器 gap（见文件头注释①） */
  /* 固定卡高 = 图盒 + 文本区最坏情况（padding 20 + 6×gap 36 + 标题 2 行 36.4
     + 级别/奖等胶囊最坏换行 2 行 42 + 赛项 13.2 + 班级 13.2 + 日期 13.2 + 获奖者 13.2 ≈ 188）。
     用 min-height 不用 height：字体度量有偏差时卡片长高；卡高不齐会破坏 -50% 无缝循环 */
  min-height: calc(var(--bh) + 188px);
  display: flex; flex-direction: column; gap: 6px;
  padding: 10px; text-align: left; cursor: pointer;
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  font: inherit; color: inherit;
  transition: border-color .2s ease, transform .2s ease, box-shadow .2s ease;
  &:hover {
    border-color: color-mix(in srgb, var(--t) 45%, var(--border));
    transform: translateY(-3px);
    box-shadow: 0 14px 28px -14px color-mix(in srgb, var(--t) 60%, transparent);
    .hpic img { transform: scale(1.06); }
  }
  &.is-static { cursor: default; &:hover { transform: none; box-shadow: none; .hpic img { transform: none; } } }
}

.hpic {
  display: flex; align-items: center; justify-content: center;
  height: var(--bh); border-radius: 8px; overflow: hidden;
  background: var(--surface-2);
  box-shadow: inset 0 0 0 1px var(--border), inset 0 -10px 18px -14px rgba(0, 0, 0, .35);
  img {
    width: 100%; height: 100%; object-fit: contain;  /* contain 不裁奖状，细节交给全屏查看器 */
    transition: transform .25s ease;
  }
}
.hph { font-size: 34px; opacity: .5; }

.httl {
  font-size: 13px; line-height: 1.4; color: var(--text);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
// 级别 + 奖等两个胶囊一行排，太窄允许换行（换行最坏高度已做进卡高常数）
.htiers { display: flex; flex-wrap: wrap; gap: 4px; }
.htier-rank { color: var(--text-2); background: var(--surface-2); border-color: var(--border); }
.hclass, .hevent, .hmeta, .hwin {
  font-size: 11px; color: var(--text-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.hevent { color: var(--primary); }
.hwin { color: var(--text-3); }

.honor-tip { margin: 2px 0 0; text-align: center; font-size: 12px; color: var(--text-3); }

// ==================== ③ 荣誉殿堂网格 ====================
.hall-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(236px, 1fr));
  gap: 18px;
}
.gcard {
  position: relative;
  display: flex; flex-direction: column; gap: 9px;
  padding: 14px 14px 12px; text-align: left; cursor: pointer;
  background: var(--card-bg);
  border: 1px solid var(--border); border-radius: 14px;
  font: inherit; color: inherit;
  transition: border-color .2s ease, transform .25s ease, box-shadow .25s ease;
  &:hover {
    border-color: color-mix(in srgb, var(--t) 45%, var(--border));
    transform: translateY(-4px);
    box-shadow: 0 20px 38px -18px color-mix(in srgb, var(--t) 65%, transparent);
    .gpic img { transform: scale(1.05); }
  }
  &.is-static { cursor: default; &:hover { transform: none; box-shadow: none; .gpic img { transform: none; } } }
}
.gpic {
  display: flex; align-items: center; justify-content: center;
  height: 168px; border-radius: 10px; overflow: hidden;
  background: var(--surface-2);
  box-shadow: inset 0 0 0 1px var(--border), inset 0 -12px 22px -16px rgba(0, 0, 0, .35);
  img { width: 100%; height: 100%; object-fit: contain; transition: transform .3s ease; }
}
.gph { font-size: 46px; opacity: .5; }
.gttl {
  font-size: 15px; line-height: 1.45; color: var(--text);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.gdesc {
  font-size: 12px; line-height: 1.55; color: var(--text-2);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.gfoot {
  margin-top: auto; padding-top: 4px;
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  font-size: 11px; color: var(--text-3);
  span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
}

/* 降级：不滚，但内容一张不少、可手动横滚（内容不可达才是最坏的降级） */
.honor-rows.is-reduced {
  .marquee { overflow-x: auto; scrollbar-width: thin; }
  .track { animation: none; }
}
@media (prefers-reduced-motion: reduce) {
  .track { animation: none !important; }
  .sk-bar { animation: none; }
  .e-hero { animation: none; }
  .e-cue-line::after { animation: none; }
  .editorial .ecard > * { transition: none; }
}

@media (max-width: 768px) {
  .honor-page { padding-top: 8px; }
  .honor-filters { top: 6px; padding: 10px 12px; gap: 6px; }
  .hf-label { width: 28px; font-size: 11px; }
  .e-hero { min-height: calc(100vh - 140px); padding-top: 40px; }
  .e-title { font-size: 56px; }
  .ecard { padding: 36px 0; }
  .e-pic { padding: 12px; border-radius: 16px; margin-top: 28px; }
  .e-pic img { max-height: 260px; }
  .mode-dock { bottom: 16px; }
  .mode-dock button { padding: 7px 14px; }
  .honor-tip { display: none; }
  .hall-grid { grid-template-columns: repeat(auto-fill, minmax(158px, 1fr)); gap: 12px; }
  .gpic { height: 132px; }
}
</style>

<!-- 非 scoped：幽灵模式下的等级配色覆盖。
     不能在 scoped 块里用 :global(html.ghost-mode) 嵌套 —— Sass 会把后代选择器吞掉（2026-09-26 教训）。
     全部用 .honor-page 前缀收窄，不外泄到别的页面。 -->
<style lang="scss">
html.ghost-mode .honor-page .t-gold   { --t: #e6b93e; --t2: #f7dd8a; }
html.ghost-mode .honor-page .t-silver { --t: #9aa7b8; --t2: #c3ccda; }
html.ghost-mode .honor-page .t-bronze { --t: #d99a66; --t2: #efbd8f; }
</style>
