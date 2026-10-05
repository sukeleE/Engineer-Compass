// 深色模式（全站换肤）：html.dark-mode 驱动 main.scss 覆盖 CSS 变量整套换肤
// —— 与幽灵模式同一范式（组件色已全部变量化，覆盖变量即换肤）。
// 口径：**未手动选择时跟随系统** prefers-color-scheme；点过切换按钮后以 localStorage(ec_theme) 为准。
// 防白闪：index.html 里有同口径的内联脚本在应用挂载前把类挂上，这里的 apply() 只是幂等兜底。
// 与幽灵模式共存：两者同时激活时由 main.scss 中更靠后的 ghost 块优先（彩蛋主题压过常规深色）。
import { reactive } from 'vue';

const KEY = 'ec_theme'; // 'light' | 'dark' | null（null = 跟随系统）
const media = window.matchMedia('(prefers-color-scheme: dark)');

const saved = () => localStorage.getItem(KEY);

const theme = reactive({
  dark: saved() ? saved() === 'dark' : media.matches,
});

function apply() {
  document.documentElement.classList.toggle('dark-mode', theme.dark);
}

// 手动切换（显式偏好落盘）
export function toggleTheme() {
  theme.dark = !theme.dark;
  localStorage.setItem(KEY, theme.dark ? 'dark' : 'light');
  apply();
}

// 未显式选择时跟随系统亮暗变化（用户点过按钮后不再跟随）
media.addEventListener('change', (e) => {
  if (saved()) return;
  theme.dark = e.matches;
  apply();
});

apply();

export default theme;
