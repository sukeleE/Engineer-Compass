<script setup>
// 荣誉墙：奖状图片多行反向跑马灯（公开免登录，内容由管理员在后台维护）
//
// 跑马灯是无缝循环，靠一条数学恒等式：**轨道恰好是两份等宽的副本**，动画从 0 位移到 -50%。
// 两个必须守住的点（写错就是"看着在动但其实是坏的"）：
//   ① 卡片间距用**每张卡的 margin-right**，不能用容器的 flex gap。
//      gap 只在相邻项之间插入、不在两份副本的接缝处出现，轨道宽 = 2kh·W + G 而不是 2kh·W，
//      -50% 就差了半个间距 → 每滚一圈画面横跳一下。用 margin-right，半份宽精确等于 n·(w+gap)。
//   ② 半份必须**铺满视口**，否则滚到接缝处会露出一段空白。重复次数 k 由实测视口宽算出来。
//
// 卡片宽/间距/图盒高都由 JS 常量给出、以 CSS 变量喂给样式表（单一事实来源），
// 避免"CSS 里写 228px、JS 里算 232px"这种漂移 —— 那种漂移同样会破坏 -50% 的等式。
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api.js';
import auth from '../auth.js';
import { openImage } from '../utils/imageViewer.js';

const router = useRouter();

const list = ref([]);
const loading = ref(true);
const err = ref('');

// —— 几何常量（整数 px）——
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

const rowCount = computed(() => {
  const n = list.value.length;
  if (!n) return 0;
  return Math.min(narrow.value ? 2 : 3, Math.max(1, Math.ceil(n / PER_ROW)));
});

// 分行用**轮转**（i % R）而不是切块：切块会让第一行独占全部最高优先项、最后一行吃剩饭；
// 轮转把排序权重均摊到各行，观感等重，条数差也天然 ≤1
const buckets = computed(() => {
  const R = rowCount.value;
  const out = Array.from({ length: R }, () => []);
  list.value.forEach((h, i) => out[i % R].push(h));
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

const stat = computed(() => {
  const n = list.value.length;
  const top = list.value.filter((h) => /国家|国际/.test(h.award_level || '')).length;
  return { n, top };
});

// 图挂了（磁盘文件丢失/被清）不留红叉：换成占位符
const broken = ref(new Set());
const onImgErr = (id) => { broken.value = new Set(broken.value).add(id); };
const showImg = (h) => h.has_image && !broken.value.has(h.id);

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
  mq?.removeEventListener?.('change', onMq);
});

// 列表从空到有会挂出新的 .marquee，容器本身一直在，故只需在挂载后补一次观察
watch(rowsRef, (el) => {
  if (el && !ro) {
    ro = new ResizeObserver(([e]) => { vw.value = Math.round(e.contentRect.width) || vw.value; });
    ro.observe(el);
    vw.value = el.clientWidth || vw.value;
  }
});
</script>

<template>
  <div class="honor-page">
    <div class="honor-wrap">
      <header class="card hon-head">
        <div class="hh-l">
          <h2>🏅 荣誉墙</h2>
          <p class="hh-sub">每一块奖牌背后，都是一整个赛季的加班</p>
        </div>
        <div class="hh-r">
          <span class="chip">共 {{ stat.n }} 项</span>
          <span class="chip" v-if="stat.top">国家级 / 国际级 {{ stat.top }} 项</span>
          <button v-if="auth.user?.is_admin" class="adm" type="button" @click="router.push('/admin-console')">
            ⚙️ 去后台维护
          </button>
        </div>
      </header>

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
        <button v-if="auth.user?.is_admin" class="adm" type="button" @click="router.push('/admin-console')">
          🏅 去后台上传第一张奖状
        </button>
      </div>

      <!-- 跑马灯（reduced 时同一套 DOM 退化成可横滚的静态行） -->
      <div v-else class="honor-rows" ref="rowsRef" :class="{ 'is-reduced': reduced }" :style="trackVars">
        <div
          v-for="lane in lanes" :key="lane.i"
          class="marquee" :class="{ 'is-rev': lane.rev }"
        >
          <div class="track" :style="{ animationDuration: lane.dur + 's' }">
            <div class="half" v-for="c in copies" :key="c">
              <button
                v-for="(h, ci) in lane.half" :key="`${h.id}-${c}-${ci}`"
                class="hcard" type="button" draggable="false"
                :class="{ 'is-static': !showImg(h) }"
                :aria-hidden="(c > 1 || ci >= lane.n) ? 'true' : null"
                :tabindex="(c === 1 && ci < lane.n && showImg(h)) ? 0 : -1"
                @click="showImg(h) && openImage(h.image_url, h.title)"
              >
                <span class="hpic">
                  <img
                    v-if="showImg(h)" :src="h.image_url" :alt="h.title"
                    decoding="async" draggable="false" @error="onImgErr(h.id)"
                  />
                  <span v-else class="hph">🏅</span>
                </span>
                <b class="httl">{{ h.title }}</b>
                <span class="hmeta" v-if="h.winner || h.award_level || h.award_date">
                  {{ [h.award_level, h.award_date].filter(Boolean).join(' · ') }}
                </span>
                <span class="hwin" v-if="h.winner">{{ h.winner }}</span>
              </button>
            </div>
          </div>
        </div>
        <p class="honor-tip" v-if="!reduced">把鼠标停在某一行可以暂停滚动 · 点奖状看大图</p>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.honor-page { min-height: 100vh; padding: 18px 14px 40px; }
.honor-wrap { max-width: 1200px; margin: 0 auto; }
.card {
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px 20px;
  margin-bottom: 14px;
}

.hon-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
.hh-l h2 { margin: 0 0 6px; font-size: 22px; color: var(--text); }
.hh-sub { margin: 0; font-size: 13px; color: var(--text-2); }
.hh-r { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.chip {
  font-size: 12px; padding: 4px 10px; border-radius: 999px;
  color: var(--primary); background: var(--primary-tint); border: 1px solid transparent;
}
.adm {
  font-size: 12px; padding: 5px 12px; border-radius: 8px; cursor: pointer;
  color: var(--primary); background: var(--primary-tint);
  border: 1px solid color-mix(in srgb, var(--primary) 33%, transparent);
  transition: all .2s ease;
  &:hover { background: color-mix(in srgb, var(--primary) 18%, transparent); }
}

.honor-skel { display: flex; flex-direction: column; gap: 14px; }
.sk-bar {
  height: 196px; border-radius: 10px; background: var(--surface-2);
  animation: sk-pulse 1.2s ease-in-out infinite;
}
@keyframes sk-pulse { 50% { opacity: .55; } }
.honor-rstate { text-align: center; }
.honor-rstate p { color: var(--text-2); }

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
  flex: none;
  width: var(--hw);
  margin-right: var(--hg);     /* ★ 间距做进卡片自身，不能用容器 gap（见文件头注释①） */
  /* 固定卡高 = 图盒 + 文本区最坏情况（padding 20 + 3×gap 6 + 标题 2 行 36.4 + 级别行 13.2 + 获奖者行 13.2）。
     不固定的话：同一行内 flex 拉伸还看不出问题，但**行与行**之间会参差 ——
     某行恰好有一条两行标题，整行就比邻行高出一截，一面墙的基线全散了。
     用 min-height 而不是 height：字体度量与预估有偏差时卡片长高，而不是把文字挤出边框。 */
  min-height: calc(var(--bh) + 101px);
  display: flex; flex-direction: column; gap: 6px;
  padding: 10px; text-align: left; cursor: pointer;
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  font: inherit; color: inherit;
  transition: border-color .2s ease, transform .2s ease;
  &:hover { border-color: color-mix(in srgb, var(--primary) 33%, transparent); transform: translateY(-2px); }
  &.is-static { cursor: default; &:hover { transform: none; } }
}

.hpic {
  display: flex; align-items: center; justify-content: center;
  height: var(--bh); border-radius: 8px; overflow: hidden;
  background: var(--surface-2);
  img { width: 100%; height: 100%; object-fit: contain; }  /* contain 不裁奖状，细节交给全屏查看器 */
}
.hph { font-size: 34px; opacity: .5; }

.httl {
  font-size: 13px; line-height: 1.4; color: var(--text);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.hmeta, .hwin {
  font-size: 11px; color: var(--text-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.hwin { color: var(--text-3); }

.honor-tip { margin: 2px 0 0; text-align: center; font-size: 12px; color: var(--text-3); }

/* 降级：不滚，但内容一张不少、可手动横滚（内容不可达才是最坏的降级） */
.honor-rows.is-reduced {
  .marquee { overflow-x: auto; scrollbar-width: thin; }
  .track { animation: none; }
}
@media (prefers-reduced-motion: reduce) {
  .track { animation: none !important; }
  .sk-bar { animation: none; }
}

@media (max-width: 768px) {
  .hon-head { padding: 14px 16px; }
  .hh-l h2 { font-size: 19px; }
  .honor-tip { display: none; }
}
</style>
