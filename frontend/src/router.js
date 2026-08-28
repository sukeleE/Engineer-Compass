// 路由：/ 竞赛时间轴、/schedule 我的备赛日程、/study 学习日程、/team 项目小组、/share 资源分享、/me 我的、/login 登录、/admin AI收录管理端、/admin-console 后台管理
import { createRouter, createWebHistory } from 'vue-router';
import TimelineView from './components/TimelineView.vue';
import ScheduleView from './components/ScheduleView.vue';
import StudyView from './components/StudyView.vue';
import TeamView from './components/TeamView.vue';
import ShareView from './components/ShareView.vue';
import MyView from './components/MyView.vue';
import ProfileView from './components/ProfileView.vue';
import AuthView from './components/AuthView.vue';
import AdminView from './components/AdminView.vue';
import AdminConsole from './components/AdminConsole.vue';
import auth, { patchUser } from './auth.js';
import { api } from './api.js';

export default createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'timeline', component: TimelineView },
    { path: '/schedule', name: 'schedule', component: ScheduleView },
    // 学习日程已合并进 /schedule 页（tab），旧深链重定向到学习 tab
    { path: '/study', redirect: '/schedule?tab=study' },
    { path: '/team', name: 'team', component: TeamView },
    { path: '/share', name: 'share', component: ShareView },
    // 秘密分享（幽灵模式专属，仅 is_ghost 可进；前端守卫 + 后端 share 过滤双重校验）
    {
      path: '/ghost-share', name: 'ghost-share', component: ShareView, props: { ghost: true },
      beforeEnter: async (_to, _from, next) => {
        if (!auth.token) return next('/login?redirect=/ghost-share');
        if (!auth.user?.is_ghost) {
          // 缓存可能过期（幽灵权限刚被授予/撤销），拉取最新状态再判断
          try {
            const { user } = await api.me();
            patchUser(user);
            if (user.is_ghost) return next();
          } catch { /* 网络失败按原缓存判断 */ }
          return next('/');
        }
        next();
      },
    },
    { path: '/me', name: 'me', component: MyView },
    // 用户公开主页（只读）：小组内点击成员头像/昵称进入
    { path: '/user/:id', name: 'user-profile', component: ProfileView },
    { path: '/login', name: 'login', component: AuthView },
    { path: '/admin', name: 'admin', component: AdminView },
    // 后台管理：仅管理员（前端守卫 + 后端 adminRequired 双重校验）
    {
      path: '/admin-console', name: 'admin-console', component: AdminConsole,
      beforeEnter: async (_to, _from, next) => {
        if (!auth.token) return next('/login');
        if (!auth.user?.is_admin) {
          // 缓存可能过期（管理员权限刚被授予/撤销），拉取最新状态再判断
          try {
            const { user } = await api.me();
            patchUser(user);
            if (user.is_admin) return next();
          } catch { /* 网络失败按原缓存判断 */ }
          return next('/me');
        }
        next();
      },
    },
  ],
});
