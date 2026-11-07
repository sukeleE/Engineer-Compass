// 个性化主题（H5）：预设色板 / 自定义主色 / 壁纸背景。登录后跟随账号（user.theme），未登录用 localStorage。
// 与后端 lib/themes.js 的预设 key、派生规则保持一致。
// 换肤机制：命名预设走 main.scss 的 html[data-theme="x"] 变量块；custom 走 documentElement 内联变量；
// dark 预设走独立 data-theme="dark" 暗色块（不复用 ghost-mode——幽灵模式由 App.vue 独占，互不覆盖）。
import auth from '../auth.js';

const LOCAL_KEY = 'ec_theme_local';

export const THEME_PRESETS = {
  ocean:   { label: '海洋蓝', primary: '#2563eb' },
  forest:  { label: '森林绿', primary: '#059669' },
  teal:    { label: '青瓷青', primary: '#0d9488' },
  indigo:  { label: '靛青蓝', primary: '#4f46e5' },
  violet:  { label: '葡萄紫', primary: '#7c3aed' },
  sunset:  { label: '活力橙', primary: '#ea580c' },
  rose:    { label: '樱花粉', primary: '#e11d48' },
  crimson: { label: '酒红色', primary: '#b91c1c' },
  dark:    { label: '暗夜黑', primary: '#60a5fa', darkMode: true },
};

export const DEFAULT_THEME = { preset: 'ocean', primary: '#2563eb', wallpaper: '', opacity: 0.18 };
const INLINE_VARS = ['--primary', '--primary-dark', '--primary-tint', '--primary-soft'];

const HEX_RE = /^#([0-9a-fA-F]{6})$/;
function hexToRgb(hex) {
  const m = HEX_RE.exec(String(hex || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbToHex(r, g, b) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}
function mix(hex, target, ratio) {
  const c = hexToRgb(hex);
  const t = hexToRgb(target);
  if (!c || !t) return hex;
  return rgbToHex(c.r + (t.r - c.r) * ratio, c.g + (t.g - c.g) * ratio, c.b + (t.b - c.b) * ratio);
}
export function derivePalette(primary) {
  const base = HEX_RE.test(primary) ? primary : DEFAULT_THEME.primary;
  return {
    primary: base,
    primaryDark: mix(base, '#000000', 0.18),
    primaryTint: mix(base, '#ffffff', 0.92),
    primarySoft: mix(base, '#ffffff', 0.58),
  };
}

export function loadLocalTheme() {
  try { return { ...DEFAULT_THEME, ...JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}') }; }
  catch (e) { return { ...DEFAULT_THEME }; }
}
function saveLocalTheme(theme) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(theme)); } catch (e) { /* 隐私模式忽略 */ }
}

// 当前生效主题：已登录用账号主题，否则本地
export function currentTheme() {
  if (auth.user && auth.user.theme) return { ...DEFAULT_THEME, ...auth.user.theme };
  return loadLocalTheme();
}

function wallpaperUrl(storeName) {
  if (!storeName) return '';
  // 游客本地壁纸（压缩后 data URL）/ 外链直接可用；服务端文件名走带 token 的鉴权直连
  if (/^(data:|https?:)/i.test(storeName)) return storeName;
  const token = auth.token ? `?token=${encodeURIComponent(auth.token)}` : '';
  return `/api/auth/wallpaper/${encodeURIComponent(storeName)}${token}`;
}

let wpEl = null;
function ensureWallpaperEl() {
  if (wpEl && document.body.contains(wpEl)) return wpEl;
  wpEl = document.getElementById('theme-wallpaper');
  if (!wpEl) {
    wpEl = document.createElement('div');
    wpEl.id = 'theme-wallpaper';
    document.body.prepend(wpEl);
  }
  return wpEl;
}

// 应用主题到 documentElement：data-theme 驱动 SCSS 预设块；仅 custom 用内联变量；幽灵模式激活时让位
export function applyTheme(theme) {
  const t = { ...DEFAULT_THEME, ...(theme || {}) };
  const root = document.documentElement;
  const ghostOn = !!(auth.user && auth.user.is_ghost);

  // data-theme：ocean 即 :root 默认值，无需挂属性；custom 清空
  if (t.preset && t.preset !== 'custom' && t.preset !== 'ocean') root.setAttribute('data-theme', t.preset);
  else root.removeAttribute('data-theme');

  // 内联变量只服务 custom 且非幽灵态；命名预设/幽灵态全部移除，避免覆盖 SCSS 块
  const useInline = t.preset === 'custom' && !ghostOn;
  if (useInline) {
    const palette = derivePalette(t.primary);
    root.style.setProperty('--primary', palette.primary);
    root.style.setProperty('--primary-dark', palette.primaryDark);
    root.style.setProperty('--primary-tint', palette.primaryTint);
    root.style.setProperty('--primary-soft', palette.primarySoft);
  } else {
    INLINE_VARS.forEach((v) => root.style.removeProperty(v));
  }

  // 壁纸层（has-wallpaper 类同时让 body 底色让位，露出壁纸）
  const el = ensureWallpaperEl();
  const url = wallpaperUrl(t.wallpaper);
  if (url) {
    el.style.backgroundImage = `url("${url}")`;
    el.style.opacity = String(t.opacity || 0.18);
    el.classList.add('on');
    root.classList.add('has-wallpaper');
  } else {
    el.style.backgroundImage = '';
    el.classList.remove('on');
    root.classList.remove('has-wallpaper');
  }
}

// 保存并应用（游客本地态；登录态的服务端持久化由调用方通过 api 完成）
export function applyAndStore(theme) {
  saveLocalTheme(theme);
  applyTheme(theme);
}

// 登录/刷新账号/幽灵态切换后调用：以服务端主题为准
export function syncThemeFromUser() {
  applyTheme(currentTheme());
}