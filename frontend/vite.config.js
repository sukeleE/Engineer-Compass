import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      // 开发环境：前端 /api 请求转发到后端 Express (3000)
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});
