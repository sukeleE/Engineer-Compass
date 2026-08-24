<script setup>
import AIChatBox from './components/AIChatBox.vue';
import ImageViewer from './components/ImageViewer.vue';
import auth from './auth.js';
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
    </header>
    <router-view />
    <AIChatBox />
    <ImageViewer />
  </div>
</template>

<style scoped>
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
