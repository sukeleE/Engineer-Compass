import { createSSRApp } from 'vue';
import App from './App.vue';

// uni-app Vue3 入口（小程序与 H5 共用）
export function createApp() {
  const app = createSSRApp(App);
  return { app };
}