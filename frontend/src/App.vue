<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import ToolDock from './components/ToolDock.vue';
import ImageViewer from './components/ImageViewer.vue';
import RealNameDialog from './components/account/RealNameDialog.vue';
import auth from './auth.js';
import { api } from './api.js';
import { realNameGate, closeGate } from './realNameGate.js';

const router = useRouter();
const route = useRoute();
// bare 路由（如 /share/html/:fid 新标签全屏预览）：不挂站点导航与工具栏，页面自身铺满视口
const bare = computed(() => !!route.meta.bare);

// 实名门禁：填名成功后放行到被拦时想去的路由（无目标则仅关弹窗）
function onRealNameDone() {
  const to = realNameGate.pendingTo;
  closeGate();
  if (to && router.currentRoute.value.fullPath !== to) router.push(to);
}

// 全局公告横幅：最新置顶公告（公开接口，无需登录；关闭仅本次会话记忆）
const announce = ref(null);
const announceHidden = ref(false);
onMounted(async () => {
  try { announce.value = await api.announcementLatest(); } catch { /* 横幅拉取失败不影响页面 */ }
});

// 初始密码个人提醒：password_set===0 时显示（软提示口径，不阻断使用）；✕ 仅本会话关闭
const pwHidden = ref(false);
function goAccountSecurity() { router.push('/account-security'); }

// 幽灵模式（秘密通道「水手冰淇淋」）：is_ghost → html class，全站反色由 main.scss 驱动
// is_ghost 持久化在 localStorage（ec_user），刷新后挂载即恢复；激活/退出经 patchUser 触发 watch
const applyGhostClass = (v) => document.documentElement.classList.toggle('ghost-mode', !!v);
watch(() => auth.user?.is_ghost, applyGhostClass);
onMounted(() => applyGhostClass(auth.user?.is_ghost));
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
    <!-- 初始密码个人提醒（仅本账号可见；改密后 password_set 翻 1 自动消失） -->
    <div v-if="auth.token && auth.user?.password_set === false && !pwHidden" class="pw-bar">
      <span class="ann-icon">⚠️</span>
      <b class="ann-title">你的账号仍在使用初始密码</b>
      <span class="ann-content">为了账号安全，请尽快通过邮箱验证码修改密码。</span>
      <button class="pw-go" @click="goAccountSecurity">去设置</button>
      <button class="ann-close" aria-label="关闭提醒" @click="pwHidden = true">✕</button>
    </div>
    <header v-if="!bare" class="app-header">
      <div class="brand">
        <h1>🎯 工科竞赛导航 <span>Engineer-Compass</span></h1>
        <p class="sub">84 项 A 类竞赛 · 按月排布 · AI 备赛助手</p>
      </div>
      <nav class="nav">
        <router-link to="/"><span class="ic">🗓️</span><span class="txt">竞赛时间轴</span></router-link>
        <router-link to="/schedule"><span class="ic">📅</span><span class="txt">日程规划</span></router-link>
        <router-link to="/team"><span class="ic">🏗️</span><span class="txt">项目小组</span></router-link>
        <router-link to="/share"><span class="ic">📤</span><span class="txt">资源分享</span></router-link>
        <router-link to="/expense"><span class="ic">🧾</span><span class="txt">报销整理</span></router-link>
        <router-link to="/purchase"><span class="ic">🛒</span><span class="txt">物料采购</span></router-link>
        <router-link to="/booking"><span class="ic">🏢</span><span class="txt">资源预约</span></router-link>
        <!-- 🏅 而非 🏆：🏆 在本站已被"竞赛"语义占满（时间轴图例、日程 tab、备赛计划），再用会与"竞赛时间轴"撞义 -->
        <router-link to="/honor"><span class="ic">🏅</span><span class="txt">荣誉墙</span></router-link>
        <router-link v-if="auth.user?.is_ghost" to="/ghost-share"><span class="ic">👻</span><span class="txt">秘密分享</span></router-link>
      </nav>
      <!-- 用户区：屏幕右上角，与标题同排同高（头像+昵称=我的主页） -->
      <div class="header-user">
        <router-link to="/me" class="nav-me" :class="{ logged: !!auth.token }">
          <span class="me-avatar">
            <img v-if="auth.user?.avatar" :src="auth.user.avatar" alt="" />
            <template v-else>{{ auth.user?.nickname?.charAt(0) || '🔓' }}</template>
          </span>
          <span class="me-name">{{ auth.user?.nickname || '登录' }}</span>
        </router-link>
      </div>
    </header>
    <router-view />
    <ToolDock v-if="!bare" />
    <ImageViewer />
    <!-- 实名硬门禁全局弹窗（不可关闭；账号安全页另有自己的可关闭实例） -->
    <RealNameDialog :model-value="realNameGate.open" @done="onRealNameDone" />
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
  background: linear-gradient(90deg, var(--primary-dark), var(--primary));
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
    &:hover { background: var(--card-bg)22; color: #fff; }
  }
}

/* 初始密码提醒条：琥珀底深字（区别于蓝色全局公告），非吸顶 */
.pw-bar {
  display: flex; align-items: center; gap: 8px;
  background: #fef3c7; color: #92400e; font-size: 13px;
  padding: 7px 16px 7px 20px;
  border-bottom: 1px solid #fde68a;
  .ann-title { flex-shrink: 0; }
  .ann-content { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pw-go {
    flex-shrink: 0; border: none; cursor: pointer; border-radius: 8px;
    background: #d97706; color: #fff; font-size: 12px; padding: 4px 14px;
    &:hover { background: #b45309; }
  }
  .ann-close {
    border: none; background: transparent; color: #92400e; cursor: pointer;
    font-size: 14px; padding: 2px 6px; border-radius: 6px; flex-shrink: 0;
    &:hover { background: rgba(146, 64, 14, .12); }
  }
}
html.ghost-mode .pw-bar {
  background: #422006; color: #fcd34d; border-bottom-color: #78350f;
  .ann-close { color: #fcd34d; }
}

.nav-me {
  display: flex; align-items: center; gap: 6px;
  border: 1px solid var(--border); border-radius: 999px; padding: 3px 12px 3px 3px;
  &.logged { border-color: color-mix(in srgb, var(--primary) 33%, transparent); background: color-mix(in srgb, var(--primary) 5%, transparent); }
  .me-avatar {
    width: 22px; height: 22px; border-radius: 50%; display: inline-flex;
    align-items: center; justify-content: center; overflow: hidden;
    background: var(--primary); color: #fff; font-size: 12px; flex-shrink: 0;
    img { width: 100%; height: 100%; object-fit: cover; }
  }
  .me-name { max-width: 72px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
}

/* 用户区：右上角独立块（与标题同排同高）；窄屏用 order 留在第一行（导航排第二行，见 main.scss） */
.header-user {
  display: flex; align-items: center; gap: 8px;
  margin-left: auto; /* 紧贴 header 最右（与 brand 两端对齐） */
}

/* 窄屏隐藏导航的 emoji 图标腾空间（scoped 特异性高于 main.scss 全局同名规则） */
@media (max-width: 1024px) {
  .nav a .ic { display: none; }
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
