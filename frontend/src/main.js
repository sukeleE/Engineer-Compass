import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import App from './App.vue';
import router from './router.js';
import './styles/main.scss';
import './styles/blocks.scss';
import { applyTheme, currentTheme } from './utils/theme.js';

// mount 前先落一次主题（CSS 变量/壁纸层），避免登录用户刷新时先闪默认蓝
applyTheme(currentTheme());

createApp(App).use(ElementPlus, { locale: zhCn }).use(router).mount('#app');