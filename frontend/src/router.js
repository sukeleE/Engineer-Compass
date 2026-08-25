// 路由：/ 竞赛时间轴、/schedule 我的备赛日程、/study 学习日程、/team 项目小组、/share 资源分享、/me 我的、/login 登录、/admin AI收录管理端
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

export default createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'timeline', component: TimelineView },
    { path: '/schedule', name: 'schedule', component: ScheduleView },
    // 学习日程已合并进 /schedule 页（tab），旧深链重定向到学习 tab
    { path: '/study', redirect: '/schedule?tab=study' },
    { path: '/team', name: 'team', component: TeamView },
    { path: '/share', name: 'share', component: ShareView },
    { path: '/me', name: 'me', component: MyView },
    // 用户公开主页（只读）：小组内点击成员头像/昵称进入
    { path: '/user/:id', name: 'user-profile', component: ProfileView },
    { path: '/login', name: 'login', component: AuthView },
    { path: '/admin', name: 'admin', component: AdminView },
  ],
});
