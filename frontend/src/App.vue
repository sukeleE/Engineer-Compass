<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import ToolDock from './components/ToolDock.vue';
import ImageViewer from './components/ImageViewer.vue';
import RealNameDialog from './components/account/RealNameDialog.vue';
import auth from './auth.js';
import { api } from './api.js';
import { realNameGate, closeGate } from './realNameGate.js';
import { canAdmin } from './utils/adminPerms.js';

const router = useRouter();
const route = useRoute();
// bare 路由（如 /share/html/:fid 新标签全屏预览）：不挂站点导航与工具栏，页面自身铺满视口
const bare = computed(() => !!route.meta.bare);
// 登录页只留品牌头：底部 Tab / 工具栏 / 导航都不出现（这些入口本身也要求登录）
const isLogin = computed(() => route.name === 'login');

// 移动端「更多」面板：底部主导航之外的次级入口
const moreOpen = ref(false);
const moreLinks = computed(() => {
  const list = [
    { to: '/team', ic: '🏗️', txt: '项目小组' },
    { to: '/share', ic: '📤', txt: '资源分享' },
    { to: '/expense', ic: '🧾', txt: '报销整理' },
    { to: '/purchase', ic: '🛒', txt: '物料采购' },
    { to: '/honor', ic: '🏅', txt: '荣誉墙' },
    { to: '/me', ic: '👤', txt: '我的主页' },
  ];
  if (auth.user?.is_ghost) list.push({ to: '/ghost-share', ic: '👻', txt: '秘密分享' });
  // 借用记录的全局查看与导出需「实验室借用」权限（后端 requireLabAdmin 二次校验）
  if (canAdmin('lab')) list.push({ to: '/lab-admin', ic: '🗂️', txt: '借用记录管理' });
  return list;
});
// 路由切换后收起面板（否则从面板进入新页面会残留遮罩）
watch(() => route.fullPath, () => { moreOpen.value = false; });

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
  <div class="app" :class="{ 'is-login': isLogin }">
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
      <nav v-if="!isLogin" class="nav">
        <router-link to="/"><span class="ic">🗓️</span><span class="txt">竞赛时间轴</span></router-link>
        <router-link to="/schedule"><span class="ic">📅</span><span class="txt">日程规划</span></router-link>
        <router-link to="/team"><span class="ic">🏗️</span><span class="txt">项目小组</span></router-link>
        <router-link to="/share"><span class="ic">📤</span><span class="txt">资源分享</span></router-link>
        <router-link to="/expense"><span class="ic">🧾</span><span class="txt">报销整理</span></router-link>
        <router-link to="/purchase"><span class="ic">🛒</span><span class="txt">物料采购</span></router-link>
        <router-link to="/booking"><span class="ic">🏢</span><span class="txt">预约排期</span></router-link>
        <router-link v-if="canAdmin('lab')" to="/lab-admin"><span class="ic">🗂️</span><span class="txt">借用记录</span></router-link>
        <!-- 🏅 而非 🏆：🏆 在本站已被"竞赛"语义占满（时间轴图例、日程 tab、备赛计划），再用会与"竞赛时间轴"撞义 -->
        <router-link to="/honor"><span class="ic">🏅</span><span class="txt">荣誉墙</span></router-link>
        <router-link v-if="auth.user?.is_ghost" to="/ghost-share"><span class="ic">👻</span><span class="txt">秘密分享</span></router-link>
      </nav>
      <!-- 用户区：屏幕右上角，与标题同排同高（头像+昵称=我的主页） -->
      <div v-if="!isLogin" class="header-user">
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
    <!-- 移动端底部主导航（≤768px 显示；桌面端沿用顶部胶囊导航） -->
    <nav v-if="!bare && !isLogin" class="tabbar">
      <router-link to="/"><span class="ic">🗓️</span><span>竞赛</span></router-link>
      <router-link to="/schedule"><span class="ic">📅</span><span>日程</span></router-link>
      <router-link to="/booking"><span class="ic">🏢</span><span>预约</span></router-link>
      <button class="tb-more" :class="{ on: moreOpen }" @click="moreOpen = true"><span class="ic">☰</span><span>更多</span></button>
    </nav>
    <!-- 「更多」面板：底部主导航只放 5 个高频入口，其余功能收在这里 -->
    <div v-if="moreOpen" class="more-mask" @click.self="moreOpen = false">
      <div class="more-panel">
        <div class="mp-head">
          <b>全部功能</b>
          <button class="mp-close" aria-label="关闭" @click="moreOpen = false">✕</button>
        </div>
        <router-link v-for="it in moreLinks" :key="it.to" :to="it.to" class="mp-item" @click="moreOpen = false">
          <span class="ic">{{ it.ic }}</span><span>{{ it.txt }}</span>
        </router-link>
      </div>
    </div>
    <ToolDock v-if="!bare && !isLogin" />
    <ImageViewer />
    <!-- 实名硬门禁全局弹窗（不可关闭；账号安全页另有自己的可关闭实例） -->
    <RealNameDialog :model-value="realNameGate.open" @done="onRealNameDone" />
  </div>
</template>

<style scoped>
/* 底部主导航 / 更多面板：桌面端不占位，仅窄屏启用 */
.tabbar { display: none; }
.more-mask { display: none; }

/* 移动端：标题缩小 + 隐藏英文副标（「🎯 工科竞赛导航 Engineer-Compass」一行放不下会换行） */
@media (max-width: 768px) {
  .brand h1 { font-size: 19px; letter-spacing: 0; white-space: nowrap; span { display: none; } }
}

@media (max-width: 768px) {
  /* 顶部胶囊导航让位给底部主导航（次级入口收进「更多」）；选择器带上 .app-header 才压得住 main.scss 的 .app-header .nav */
  .app-header .nav { display: none; }
  /* 内容不被固定底栏遮挡 */
  .app { padding-bottom: calc(64px + env(safe-area-inset-bottom, 0px)); }
  /* 登录页没有底栏，别留 64px 空白 */
  .app.is-login { padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px)); }

  .tabbar {
    display: flex;
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 900;
    background: color-mix(in srgb, var(--card-bg) 94%, transparent);
    backdrop-filter: blur(12px);
    border-top: 1px solid var(--border);
    padding: 6px 4px calc(6px + env(safe-area-inset-bottom, 0px));
    a, .tb-more {
      flex: 1; min-width: 0;
      display: flex; flex-direction: column; align-items: center; gap: 2px;
      padding: 2px 0 3px; background: none; border: none; cursor: pointer;
      font-family: inherit; font-size: 11px; line-height: 1.2;
      color: var(--text-2); text-decoration: none;
      .ic { font-size: 19px; line-height: 1.1; filter: grayscale(1); opacity: .72; transition: all .15s; }
      &.router-link-active, &.on {
        color: var(--primary-dark); font-weight: 600;
        .ic { filter: none; opacity: 1; transform: translateY(-1px); }
      }
    }
  }

  /* 「更多」底部面板 */
  .more-mask {
    display: flex; align-items: flex-end;
    position: fixed; inset: 0; z-index: 1100;
    background: rgba(15, 23, 42, .42);
  }
  .more-panel {
    width: 100%; max-height: 76vh; overflow-y: auto;
    background: var(--card-bg); border-radius: 16px 16px 0 0;
    padding: 14px 16px calc(18px + env(safe-area-inset-bottom, 0px));
  }
  .mp-head {
    display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;
    b { font-size: 15px; }
  }
  .mp-close {
    width: 28px; height: 28px; border-radius: 50%; border: none; cursor: pointer;
    background: var(--surface-2); color: var(--text-2); font-size: 13px;
  }
  .mp-item {
    display: flex; align-items: center; gap: 10px;
    padding: 13px 4px; border-bottom: 1px solid var(--border);
    color: var(--text); text-decoration: none; font-size: 14px;
    &:last-child { border-bottom: none; }
    &:active { background: var(--surface-2); }
    .ic { width: 22px; text-align: center; font-size: 18px; }
  }
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
