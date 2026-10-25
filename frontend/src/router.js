// 路由：/ 竞赛时间轴、/schedule 我的备赛日程、/study 学习日程、/team 项目小组、
//       /share 资源分享列表、/share/:id 单条资源详情、/me 我的、/login 登录、/admin AI收录管理端、/admin-console 后台管理
import { createRouter, createWebHistory } from 'vue-router';
import TimelineView from './components/TimelineView.vue';
import ScheduleView from './components/ScheduleView.vue';
import StudyView from './components/StudyView.vue';
import TeamView from './components/TeamView.vue';
import ShareView from './components/ShareView.vue';
import SharePostView from './components/SharePostView.vue';
import HtmlFrameView from './components/share/HtmlFrameView.vue';
// GitHub 风资源路由：/:username 用户项目页、/:username/:slug(/tree|/blob) 项目页、
// /share/:id 数字旧链中转盘（见各组件头注释；动态路由必须注册在所有静态路由之后）
import UserProjectsView from './components/repo/UserProjectsView.vue';
import ProjectView from './components/repo/ProjectView.vue';
import ShareRedirectView from './components/repo/ShareRedirectView.vue';
import ExpenseView from './components/ExpenseView.vue';
import ExpenseGuide from './components/ExpenseGuide.vue';
import PurchaseView from './components/purchase/PurchaseView.vue';
import BookingView from './components/booking/BookingView.vue';
import BookingProjectView from './components/booking/BookingProjectView.vue';
import HonorView from './components/HonorView.vue';
import MyView from './components/MyView.vue';
import AccountSecurityView from './components/account/AccountSecurityView.vue';
import ProfileView from './components/ProfileView.vue';
import AuthView from './components/AuthView.vue';
import AdminView from './components/AdminView.vue';
import AdminConsole from './components/AdminConsole.vue';
import auth, { patchUser } from './auth.js';
import { api } from './api.js';
import { openGate } from './realNameGate.js';
import { canAdmin } from './utils/adminPerms.js';

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

// 后台模块守卫：任意管理员可进 /admin-console；/admin（AI 收录审核）需「竞赛审核」权限。
// 进入前统一 me() 刷新——权限刚被超管调整后，本地缓存可能过期（后端各接口仍有硬校验兜底）。
async function consoleGuard(_to, _from, next) {
  if (!auth.token) return next('/login');
  try { const { user } = await api.me(); patchUser(user); } catch { /* 网络失败按缓存判断 */ }
  if (!auth.user?.is_admin) return next('/me');
  next();
}

async function competitionGuard(to, _from, next) {
  if (!auth.token) return next(`/login?redirect=${encodeURIComponent(to.fullPath)}`);
  try { const { user } = await api.me(); patchUser(user); } catch { /* 网络失败按缓存判断 */ }
  if (!canAdmin('competition')) return next('/me');
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
    // HTML 文件新标签全屏沙箱预览（bare：无站点导航；鉴权与隔离同内嵌预览）
    { path: '/share/html/:fid', name: 'share-html-frame', component: HtmlFrameView, meta: { bare: true } },
    // 旧数字详情链：取到项目后 replace 到 /:username/:slug（消息通知/收藏/书签无感迁移）
    { path: '/share/:id', name: 'share-post', component: ShareRedirectView },
    // 报销整理：队长/负责人建项目发邀请码，队员免登录认领填报（可带 ?code=xxx 直达项目）
    { path: '/expense', name: 'expense', component: ExpenseView },
    // 报销整理使用教程（静态文档页，任何人可看）
    { path: '/expense/guide', name: 'expense-guide', component: ExpenseGuide },
    // 物料采购：学生申请/负责人·老师按档案审批/发票上传（登录制；实名硬门禁）
    { path: '/purchase', name: 'purchase', component: PurchaseView, meta: { requiresRealName: true } },
    // 资源预约：大厅 + 项目页（周视图甘特/资源台账/固定组队/预约审批）；必须在 /:username 兜底之前；实名硬门禁
    { path: '/booking', name: 'booking', component: BookingView, meta: { requiresRealName: true } },
    { path: '/booking/:id', name: 'booking-project', component: BookingProjectView, meta: { requiresRealName: true } },
    // 旧入口兼容：借用登记已并入资源预约模块（项目页「借用登记」tab），/resources 与 /lab 统一收口到 /booking
    { path: '/resources', redirect: '/booking' },
    { path: '/lab', redirect: '/booking' },
    // 借用记录管理已并入资源预约大厅（仅 lab 权限可见的「借用记录」tab）；旧链接收口到 ?tab=records，
    // 无权限用户进入时 BookingView 自动落回全部项目，接口本身仍有 requireLabAdmin 硬校验。
    { path: '/lab-admin', redirect: '/booking?tab=records' },
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
    // 账号安全（密码/邮箱/手机号/飞书/GitHub）：未登录跳登录后回来（组件内也有登录兜底）
    {
      path: '/account-security', name: 'account-security', component: AccountSecurityView,
      beforeEnter: (to, _from, next) => {
        if (!localStorage.getItem('ec_token')) return next(`/login?redirect=${encodeURIComponent(to.fullPath)}`);
        next();
      },
    },
    // 用户公开主页（只读）：小组内点击成员头像/昵称进入
    { path: '/user/:id', name: 'user-profile', component: ProfileView },
    { path: '/login', name: 'login', component: AuthView },
    // AI 收录管理端：需「竞赛审核」权限（前端守卫 + 后端 adminPermRequired 双重校验）
    { path: '/admin', name: 'admin', component: AdminView, beforeEnter: competitionGuard },
    // 后台管理：任意管理员可进入，页内按模块权限显隐 Tab（前端守卫 + 后端逐路由分权）
    {
      path: '/admin-console', name: 'admin-console', component: AdminConsole,
      beforeEnter: consoleGuard,
    },

    // ===== GitHub 风动态路由：必须放最后，所有静态路径（/me /share /admin …）优先匹配 =====
    // 不存在的用户名 → UserProjectsView 渲染 404 态（保留用户名注册时保留名拦截，见后端 RESERVED_USERNAMES）
    { path: '/:username', name: 'user-projects', component: UserProjectsView },
    { path: '/:username/:slug', name: 'project', component: ProjectView },
    // 目录浏览 / 文件预览：pathMatch 让任意深度的项目内路径都落在同一个 ProjectView，由路由参数驱动
    { path: '/:username/:slug/tree/:pathMatch(.*)*', name: 'project-tree', component: ProjectView },
    { path: '/:username/:slug/blob/:pathMatch(.*)*', name: 'project-blob', component: ProjectView },
  ],
});

// 未登录可看的页面：登录页、公开项目/分享页（GitHub 风分享链接）、报销教程与邀请认领、
// 荣誉墙。其余路由（含首页 / 与 /lab）一律先登录，不再出现「逛到一半被拦」。
const PUBLIC_ROUTES = new Set([
  'login', 'expense-guide', 'honor', 'share-post', 'share-html-frame',
  'user-projects', 'project', 'project-tree', 'project-blob',
]);

// 离开每条路由前记下滚动位置（beforeEach 时 DOM 还没换，scrollY 仍是上一页的）；
// Map 有界：满了就丢最早的，防长会话无界增长。
// 登录硬门禁（全站口径）：未登录且目标不是公开页 → 去登录页并带上目标，登录后原路返回。
// 实名硬门禁（全站口径）：只要登录且 real_name 为空，任何页面（含首页）都弹不可关弹窗，
// 弹窗遮罩本身阻断页内一切操作。
// booking/purchase 额外 return false 取消导航：页内组件不挂载、不发必然 403 的请求，
// pendingTo 记目标，填名成功后 App.vue 自动跳转；其他路由放行，弹窗压在页面上。
// 老缓存没有 real_name 键时强制 me() 补刷；网络失败按 fail-open（后端三模块 403 兜底）。
router.beforeEach(async (to, from) => {
  scrollMemo.set(from.fullPath, window.scrollY);
  if (scrollMemo.size > 100) scrollMemo.delete(scrollMemo.keys().next().value);

  if (!auth.token && !PUBLIC_ROUTES.has(to.name) && !(to.name === 'expense' && to.query.code)) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }

  if (auth.token && to.name !== 'login') {
    let user = auth.user;
    if (!user || !('real_name' in user)) {
      try {
        const r = await api.me();
        patchUser(r.user);
        user = r.user;
      } catch { user = auth.user; }
    }
    if (user && !user.real_name) {
      if (to.meta.requiresRealName) {
        openGate(to.fullPath);
        return false;
      }
      openGate();
    }
  }
  return true;
});

export default router;
