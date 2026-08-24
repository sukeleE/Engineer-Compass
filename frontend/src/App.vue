<script setup>
import { ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import AIChatBox from './components/AIChatBox.vue';
import ImageViewer from './components/ImageViewer.vue';
import auth from './auth.js';

// 移动端汉堡菜单：≤768px 收起顶部导航，☰ 展开下拉面板
const route = useRoute();
const menuOpen = ref(false);
const closeMenu = () => { menuOpen.value = false; };
watch(() => route.path, closeMenu);
</script>

<template>
  <div class="app">
    <header class="app-header">
      <div class="brand">
        <h1>🎯 工科竞赛导航 <span>Engineer-Compass</span></h1>
        <p class="sub">84 项 A 类竞赛 · 按月排布 · AI 备赛助手</p>
      </div>
      <nav class="nav">
        <router-link to="/">🗓️ 竞赛时间轴</router-link>
        <router-link to="/schedule">📅 日程规划</router-link>
        <router-link to="/team">🏗️ 项目小组</router-link>
        <router-link to="/me" class="nav-me" :class="{ logged: !!auth.token }">
          <span class="me-avatar">
            <img v-if="auth.user?.avatar" :src="auth.user.avatar" alt="" />
            <template v-else>{{ auth.user?.nickname?.charAt(0) || '🔓' }}</template>
          </span>
          <span class="me-name">{{ auth.user?.nickname || '登录' }}</span>
        </router-link>
      </nav>
      <!-- 移动端：汉堡按钮 + 下拉面板（点击链接自动收起） -->
      <button class="menu-btn" :class="{ open: menuOpen }" @click="menuOpen = !menuOpen" aria-label="菜单">☰</button>
      <div v-show="menuOpen" class="menu-panel" @click="closeMenu">
        <router-link to="/">🗓️ 竞赛时间轴</router-link>
        <router-link to="/schedule">📅 日程规划</router-link>
        <router-link to="/team">🏗️ 项目小组</router-link>
        <router-link to="/me" class="menu-me">
          <span class="me-avatar">
            <img v-if="auth.user?.avatar" :src="auth.user.avatar" alt="" />
            <template v-else>{{ auth.user?.nickname?.charAt(0) || '🔓' }}</template>
          </span>
          {{ auth.user?.nickname || '登录 / 注册' }}
        </router-link>
      </div>
    </header>
    <router-view />
    <AIChatBox />
    <ImageViewer />
  </div>
</template>

<style scoped>
.menu-btn {
  display: none; /* 桌面端隐藏，≤768px 由 main.scss 显示 */
  border: 1px solid var(--border); background: #fff; color: var(--text);
  font-size: 20px; line-height: 1; padding: 8px 13px; border-radius: 10px;
  cursor: pointer; user-select: none;
  &.open { background: #2563eb; border-color: #2563eb; color: #fff; }
}

/* 移动端下拉菜单：绝对定位在 header 下方 */
.menu-panel {
  position: absolute; top: calc(100% + 6px); right: 12px; z-index: 1200;
  background: #fff; border: 1px solid var(--border); border-radius: 12px;
  box-shadow: 0 12px 30px rgba(0, 0, 0, .14);
  padding: 8px; min-width: 200px; display: flex; flex-direction: column; gap: 2px;
  a {
    display: flex; align-items: center; gap: 10px;
    text-decoration: none; color: var(--text); font-size: 15px;
    padding: 12px 16px; border-radius: 8px;
    &:hover, &.router-link-active { background: #eff6ff; color: #2563eb; font-weight: 600; }
  }
  .menu-me {
    border-top: 1px solid var(--border); border-radius: 0 0 8px 8px; margin-top: 4px;
    color: var(--text-2);
  }
}
.app-header { position: relative; }

.nav-me {
  display: flex; align-items: center; gap: 6px;
  border: 1px solid var(--border); border-radius: 999px; padding: 3px 12px 3px 3px;
  &.logged { border-color: #2563eb55; background: #2563eb0d; }
  .me-avatar {
    width: 22px; height: 22px; border-radius: 50%; display: inline-flex;
    align-items: center; justify-content: center; overflow: hidden;
    background: #2563eb; color: #fff; font-size: 12px; flex-shrink: 0;
    img { width: 100%; height: 100%; object-fit: cover; }
  }
  .me-name { max-width: 72px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
}
</style>

<!-- 全局弹窗样式（append-to-body 的弹窗脱离组件树，scoped 样式够不到） -->
<style>
.editor-dlg.el-dialog {
  height: 640px; max-height: calc(100vh - 40px);
  display: flex; flex-direction: column;
}
.editor-dlg .el-dialog__header { flex-shrink: 0; }
.editor-dlg .el-dialog__body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: auto; }
.editor-dlg .el-dialog__body > .dn-tools,
.editor-dlg .el-dialog__body > .dlg-status-sel,
.editor-dlg .el-dialog__body > .el-select { flex-shrink: 0; }
.editor-dlg .rich-editor { flex: 1; min-height: 0; }
.editor-dlg .el-dialog__footer { flex-shrink: 0; }
</style>
