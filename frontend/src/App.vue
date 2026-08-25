<script setup>
import { ref, onMounted } from 'vue';
import ToolDock from './components/ToolDock.vue';
import ImageViewer from './components/ImageViewer.vue';
import auth from './auth.js';
import { api } from './api.js';

// 全局公告横幅：最新置顶公告（公开接口，无需登录；关闭仅本次会话记忆）
const announce = ref(null);
const announceHidden = ref(false);
onMounted(async () => {
  try { announce.value = await api.announcementLatest(); } catch { /* 横幅拉取失败不影响页面 */ }
});
</script>

<template>
  <div class="app">
    <!-- 全局顶部公告横幅（后台管理发布；内容过长省略，悬停 title 看全文） -->
    <div v-if="announce && !announceHidden" class="announce-bar" :title="announce.content">
      <span class="ann-icon">📢</span>
      <b class="ann-title">{{ announce.title }}</b>
      <span class="ann-content">{{ announce.content }}</span>
      <button class="ann-close" aria-label="关闭公告" @click="announceHidden = true">✕</button>
    </div>
    <header class="app-header">
      <div class="brand">
        <h1>🎯 工科竞赛导航 <span>Engineer-Compass</span></h1>
        <p class="sub">84 项 A 类竞赛 · 按月排布 · AI 备赛助手</p>
      </div>
      <nav class="nav">
        <router-link to="/"><span class="ic">🗓️</span><span class="txt">竞赛时间轴</span></router-link>
        <router-link to="/schedule"><span class="ic">📅</span><span class="txt">日程规划</span></router-link>
        <router-link to="/team"><span class="ic">🏗️</span><span class="txt">项目小组</span></router-link>
        <router-link to="/share"><span class="ic">📤</span><span class="txt">资源分享</span></router-link>
      </nav>
      <!-- 用户区：屏幕右上角，与标题同排同高（头像+昵称=我的主页；管理员附后台管理入口） -->
      <div class="header-user">
        <router-link to="/me" class="nav-me" :class="{ logged: !!auth.token }">
          <span class="me-avatar">
            <img v-if="auth.user?.avatar" :src="auth.user.avatar" alt="" />
            <template v-else>{{ auth.user?.nickname?.charAt(0) || '🔓' }}</template>
          </span>
          <span class="me-name">{{ auth.user?.nickname || '登录' }}</span>
        </router-link>
        <!-- 管理员专属入口；普通用户/未登录不渲染 -->
        <router-link v-if="auth.user?.is_admin" to="/admin-console" class="nav-admin">
          <span class="ic">⚙️</span><span class="txt">后台管理</span>
        </router-link>
      </div>
    </header>
    <router-view />
    <ToolDock />
    <ImageViewer />
  </div>
</template>

<style scoped>
/* 移动端：标题缩小 + 隐藏英文副标（「🎯 工科竞赛导航 Engineer-Compass」一行放不下会换行） */
@media (max-width: 768px) {
  .brand h1 { font-size: 19px; letter-spacing: 0; white-space: nowrap; span { display: none; } }
}

/* 公告横幅：蓝底白字，非吸顶（与 header 一起随页面滚动） */
.announce-bar {
  display: flex; align-items: center; gap: 8px;
  background: linear-gradient(90deg, #1d4ed8, #2563eb);
  color: #fff; font-size: 13px;
  padding: 7px 16px 7px 20px;
  .ann-icon { font-size: 15px; flex-shrink: 0; }
  .ann-title { flex-shrink: 0; }
  .ann-content {
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    opacity: .92;
  }
  .ann-close {
    border: none; background: transparent; color: #dbeafe; cursor: pointer;
    font-size: 14px; padding: 2px 6px; border-radius: 6px; flex-shrink: 0;
    &:hover { background: #ffffff22; color: #fff; }
  }
}

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

/* 用户区：右上角独立块（与标题同排同高），内含「我的主页」+ 管理员入口 */
.header-user {
  display: flex; align-items: center; gap: 8px;
  margin-left: auto; /* 紧贴 header 最右（与 brand 两端对齐） */
}

/* 管理员专属入口：同款胶囊，浅蓝底描边区别于普通链接 */
.nav-admin {
  background: #eff6ff; color: #2563eb; border: 1px solid #bfdbfe;
  &:hover { background: #dbeafe; color: #1d4ed8; }
}

/* 窄屏隐藏导航/用户区的 emoji 图标腾空间（scoped 特异性高于 main.scss 全局同名规则） */
@media (max-width: 1024px) {
  .nav a .ic, .nav-admin .ic { display: none; }
  .nav-me .me-name { max-width: 56px; } /* 右上角昵称略收窄 */
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
