import { defineConfig } from 'vite';
import uni from '@dcloudio/vite-plugin-uni';

// uni-app 工程：编译目标微信小程序（npm run dev:mp-weixin），产物在 dist/dev/mp-weixin
// 用微信开发者工具导入 dist/dev/mp-weixin（开发）或 dist/build/mp-weixin（发布）
export default defineConfig({
  plugins: [uni()],
});