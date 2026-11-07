// 个性化主题：预设色板 + 颜色派生工具（后端校验用；H5/小程序各有等价前端副本，保持 key 一致）
// 主题对象 user.theme（JSON 字符串）：
//   { preset: 'ocean'|'custom'|'dark', primary: '#2563eb', wallpaper: '文件名', opacity: 0.18 }

// 预设主题：primary 主强调色；dark/tint 由派生函数统一生成，特殊主题 dark 走整套深色变量
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
// 与黑/白混合：ratio=0 原色，ratio=1 全目标色
function mix(hex, target, ratio) {
  const c = hexToRgb(hex);
  const t = hexToRgb(target);
  if (!c || !t) return hex;
  return rgbToHex(c.r + (t.r - c.r) * ratio, c.g + (t.g - c.g) * ratio, c.b + (t.b - c.b) * ratio);
}

export function isValidHex(hex) {
  return HEX_RE.test(String(hex || ''));
}

// 由主色派生整套强调色：dark 深端（hover/渐变）、tint 浅底（高亮块）、soft 禁用态
export function derivePalette(primary) {
  const base = isValidHex(primary) ? primary : DEFAULT_THEME.primary;
  return {
    primary: base,
    primaryDark: mix(base, '#000000', 0.18),
    primaryTint: mix(base, '#ffffff', 0.92),
    primarySoft: mix(base, '#ffffff', 0.58),
  };
}

// 解析并校验 user.theme 存储串，非法值回退默认（绝不让坏配置阻塞登录）
export function parseTheme(raw) {
  if (!raw || typeof raw !== 'string') return { ...DEFAULT_THEME };
  try {
    const o = JSON.parse(raw);
    // custom 是合法预设值（normalizeThemeInput 写入），不在 THEME_PRESETS 表内，需单独放行；
    // 其余无法识别的值才回退 ocean
    const preset = THEME_PRESETS[o.preset] || o.preset === 'custom' ? o.preset : 'ocean';
    const fallbackPrimary = THEME_PRESETS[preset] ? THEME_PRESETS[preset].primary : DEFAULT_THEME.primary;
    const primary = isValidHex(o.primary) ? o.primary : fallbackPrimary;
    let opacity = Number(o.opacity);
    if (!Number.isFinite(opacity) || opacity < 0.05 || opacity > 0.6) opacity = DEFAULT_THEME.opacity;
    const wallpaper = typeof o.wallpaper === 'string' ? o.wallpaper.slice(0, 120) : '';
    return { preset, primary, wallpaper, opacity };
  } catch (e) {
    return { ...DEFAULT_THEME };
  }
}

// 归一化前端提交的主题（PUT /theme 入参）；抛错带中文提示
export function normalizeThemeInput(body) {
  const o = body || {};
  const preset = THEME_PRESETS[o.preset] ? o.preset : 'custom';
  let primary = DEFAULT_THEME.primary;
  if (preset === 'custom') {
    if (!isValidHex(o.primary)) throw new Error('自定义主色格式不正确（需 #RRGGBB）');
    primary = String(o.primary).toLowerCase();
  } else {
    primary = THEME_PRESETS[preset].primary;
  }
  let opacity = Number(o.opacity);
  if (!Number.isFinite(opacity)) opacity = DEFAULT_THEME.opacity;
  opacity = Math.max(0.05, Math.min(0.6, opacity));
  const wallpaper = typeof o.wallpaper === 'string' ? o.wallpaper.slice(0, 120) : '';
  return { preset, primary, wallpaper, opacity: Number(opacity.toFixed(2)) };
}