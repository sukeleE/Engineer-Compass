import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    // 监听所有网卡：手机与电脑同一 Wi-Fi 时，用电脑局域网 IP（如 http://192.168.3.45:5173）直接打开
    host: true,
    proxy: {
      // 开发环境：前端 /api 请求转发到后端 Express (3000)
      // VITE_API_TARGET 可覆盖：探针起一个临时后端（如 :3100 配全新 DB）时对着它跑，
      // 不必动正在使用的 :3000 —— 后端改了 routes 必须重启才是新代码，见 PROJECT_MEMORY。
      '/api': { target: process.env.VITE_API_TARGET || 'http://localhost:3000', changeOrigin: true },
    },
  },
});
