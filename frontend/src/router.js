// 路由：/ 竞赛时间轴、/schedule 我的备赛日程、/study 学习日程、/team 项目小组、
//       /share 资源分享列表、/share/:id 单条资源详情、/me 我的、/login 登录、/admin AI收录管理端、/admin-console 后台管理
import { createRouter, createWebHistory } from 'vue-router';
import TimelineView from './components/TimelineView.vue';
import ScheduleView from './components/ScheduleView.vue';
import StudyView from './components/StudyView.vue';
import TeamView from './components/TeamView.vue';
import ShareView from './components/ShareView.vue';
import SharePostView from './components/SharePostView.vue';
import ExpenseView from './components/ExpenseView.vue';
import ExpenseGuide from './components/ExpenseGuide.vue';
import HonorView from './components/HonorView.vue';
import MyView from './components/MyView.vue';
import ProfileView from './components/ProfileView.vue';
import AuthView from './components/AuthView.vue';
import AdminView from './components/AdminView.vue';
import AdminConsole from './components/AdminConsole.vue';
import auth, { patchUser } from './auth.js';
import { api } from './api.js';

// 幽灵页守卫（/ghost-share 与 /ghost-share/:id 共用）：仅 is_ghost 可进，前端守卫 + 后端 share 过滤双重校验
async function ghostGuard(to, _from, next) {
  if (!auth.token) return next(`/login?redirect=${encodeURIComponent(to.fullPath)}`);
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
}

// —— 滚动行为 ——
// 详情改子路由后必须管滚动：不加的话 /share → /share/123 会停在上一页的滚动位置。
// 但**不能无脑回顶** —— /schedule?tab=、/team?team=、/expense?code=、/share?post= 这些
// 都是「同页 query 变化」，弹回顶部是明显回归，故同 path 一律不动。
//
// 后退还原为什么自己记、**完全不吃** vue-router 的 saved：
// 4.6.4 交来的 saved 就是 history entry 的 state.scroll，而它在 pop 时实测是 {left:0,top:0}
// 这类残值（entry 建好时页面还在顶上，位置是后补的）—— 采信它等于亲手把用户弹回顶部，
// 比不写 scrollBehavior 还糟（原生 scrollRestoration 本来是能还原的）。
// 故改为自己留位置：用 history.state.position 判方向（push 出一格 → position 递增，
// 后退 → 递减），beforeEach 里记下离开时的 scrollY，后退时只认这份记录。
const scrollMemo = new Map(); // fullPath → 离开时的 scrollY
let lastPos = -1;

const router = createRouter({
  history: createWebHistory(),
  scrollBehavior(to, from, saved) {
    const pos = window.history.state?.position ?? 0;
    const delta = pos - lastPos;
    lastPos = pos;
    if (delta < 0) { // 后退（含 router.back()）
      const y = scrollMemo.get(to.fullPath);
      return y == null ? false : { top: y, left: 0 }; // 没记录过就别乱动
    }
    if (saved && delta > 0) return saved;    // 真的往前走一格且库给了位置 → 用它
    if (to.path === from.path) return false; // 同页只换 query/参数（含 replace）→ 保持当前滚动
    return { top: 0 };                       // 真正的换页才回顶
  },
  routes: [
    { path: '/', name: 'timeline', component: TimelineView },
    { path: '/schedule', name: 'schedule', component: ScheduleView },
    // 学习日程已合并进 /schedule 页（tab），旧深链重定向到学习 tab
    { path: '/study', redirect: '/schedule?tab=study' },
    { path: '/team', name: 'team', component: TeamView },
    { path: '/share', name: 'share', component: ShareView },
    // 单条资源详情（独立子路由，不再在列表页下方展开 README）。
    // 与 /share 是两个不同组件而不是同一个——同组件复用实例时 onMounted 不重跑，
    // 从列表点进另一条帖会拿不到新数据。
    { path: '/share/:id', name: 'share-post', component: SharePostView },
    // 报销整理：队长/负责人建项目发邀请码，队员免登录认领填报（可带 ?code=xxx 直达项目）
    { path: '/expense', name: 'expense', component: ExpenseView },
    // 报销整理使用教程（静态文档页，任何人可看）
    { path: '/expense/guide', name: 'expense-guide', component: ExpenseGuide },
    // 荣誉墙（公开免登录；内容由管理员在后台维护。复数路径只做重定向，全站单数口径）
    { path: '/honor', name: 'honor', component: HonorView },
    { path: '/honors', redirect: '/honor' },
    // 秘密分享（幽灵模式专属，仅 is_ghost 可进；前端守卫 + 后端 share 过滤双重校验）
    {
      path: '/ghost-share', name: 'ghost-share', component: ShareView, props: { ghost: true },
      beforeEnter: ghostGuard,
    },
    // 幽灵详情页：函数式 props 是全站首例 —— 只有 ghost 需要传，
    // 帖子 id 仍由组件自己读 route.params（与 /share/:id 同一套读法，不搞两种入口）
    {
      path: '/ghost-share/:id', name: 'ghost-share-post', component: SharePostView,
      props: () => ({ ghost: true }), beforeEnter: ghostGuard,
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

// 离开每条路由前记下滚动位置（beforeEach 时 DOM 还没换，scrollY 仍是上一页的）；
// Map 有界：满了就丢最早的，防长会话无界增长
router.beforeEach((_to, from) => {
  scrollMemo.set(from.fullPath, window.scrollY);
  if (scrollMemo.size > 100) scrollMemo.delete(scrollMemo.keys().next().value);
});

export default router;
