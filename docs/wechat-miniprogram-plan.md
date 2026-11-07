# Engineer-Compass 微信小程序化 —— 迁移规划（v1）

> 生成日期：2026-11-03
> 现状基线：Vue3 H5（70 个组件 / 前端源码约 1.29 MB）+ Express REST 后端（31 个路由文件 / 约 309 个接口 / SQLite），线上 https://gkjsdh.xyz

---

## 1. 现状盘点

### 1.1 技术栈

| 层 | 现状 | 小程序兼容性 |
|---|---|---|
| 前端框架 | Vue3 + Vite6 + vue-router | ✅ Vue3 语法可复用（选 uni-app 方案）；router 必须废弃，改 pages.json |
| UI 库 | Element Plus（弹窗/表格/日期选择/上传…） | ❌ 完全不可用，需用 uni-ui / uView 重写 |
| 动画 | GSAP | ❌ 无 DOM，不可用，改 CSS/WXS/原生交互 |
| 图表 | ECharts（技术栈树等） | ⚠️ 需换 ec-canvas（echarts-for-weixin）或自绘；2072 节点必须降载 |
| 文档预览 | docx-preview、xlsx、iframe（HtmlFrameView） | ❌ 不可用；Office 走 wx.openDocument，HTML 走 web-view 或 rich-text |
| 存储 | localStorage（ec_token 等） | ⚠️ 换 wx.setStorageSync（语义一致，可封装） |
| 网络 | fetch + Bearer Token（30s/90s/120s 超时） | ⚠️ 换 wx.request；**硬限制：单次请求超时上限 60s** |
| 上传 | base64 JSON（30MB 上限）+ 部分 multer multipart（8 个路由已用） | ⚠️ wx.request body ≤10MB；统一改 wx.uploadFile 走已有的 multer 接口 |
| 后端 | Express 4 + node:sqlite + Bearer Token 会话（session 表，随机 token） | ✅ 基本零改动复用；token 机制天然适配小程序 |
| 登录 | 账号密码 / 邮箱验证码 / GitHub OAuth / 飞书 / 手机号 | ⚠️ 新增微信登录；GitHub/飞书 OAuth 需 web-view 兜底或暂不做 |
| 实时 | 无 WebSocket/SSE（聊天为普通请求） | ✅ 无历史负担 |
| 部署 | Nginx + PM2，HTTPS 已就绪 | ⚠️ 证书 2026-11-23 到期，启动前先续期 |

### 1.2 功能模块清单（按迁移难度）

| # | 模块 | 关键页面/组件 | 接口量 | 难度 | 说明 |
|---|---|---|---|---|---|
| 1 | 竞赛时间轴 | TimelineView、CompDialog（5 Tab）、TechTreeChart | ~10 | ★★★ | 核心首页；横向时间轴/GSAP 动画重做；技术栈树降载 |
| 2 | AI 问答 | AIChatBox | 3 | ★★ | 注意 60s 超时上限 |
| 3 | 备赛日程 | ScheduleView、Manual/ImportPlanDialog、ScheduleNotes、CalendarView | 18 | ★★★ | 日历组件需重写 |
| 4 | 学习日程 + AI 计划对话 | StudyView、PlanChat | 16 | ★★★ | 对话式生成同上超时问题 |
| 5 | 项目小组（最重） | TeamView/Detail + team/ 下 18 个子组件（Progress 69KB、Attendance 48KB、Members 33KB…） | ~130（team/collab/checkin/attendance/friends） | ★★★★ | 任务/日志/聊天/文件/设备/考勤打卡/成员角色，工作量最大 |
| 6 | 资源分享（GitHub 风） | ShareView/PostView + share/、repo/ 下 12 个组件 | 51 | ★★★★ | 文件树/表格/Office 预览/HTML 框架全要替代方案 |
| 7 | 报销整理（含票据 OCR） | ExpenseView、ExpenseGuide、RowFormDialog | 58 | ★★★★ | 拍照 wx.chooseMedia 是加分项；图片链路改 multipart；OCR 耗时长 |
| 8 | 物料采购 | PurchaseView 等 3 组件 | 41 | ★★★ | 重表单 + 审批流 |
| 9 | 资源预约（台账+甘特） | booking/ 下 11 组件，WeekGantt 24.5KB | 56 | ★★★★ | 甘特图需 canvas 重绘 |
| 10 | 荣誉墙 | HonorView | 22 | ★★ | 以图片展示为主，较简单 |
| 11 | 消息/通知/好友 | MessageCenter、DmDialog、friends、notifications | 28 | ★★ | 可接微信订阅消息提升触达 |
| 12 | 我的/账号安全 | MyView、ProfileView、account/ 6 组件 | 散见 auth 36 | ★★★ | OAuth 绑定卡需取舍 |
| 13 | 管理端 | AdminConsole(69KB)、AdminView、GhostUsers | admin 44 | ★★★★（建议暂缓） | 小程序里做密集后台体验差，建议保留 H5，小程序只做轻量审核 |

---

## 2. 技术选型

### 推荐：uni-app（Vue3 + Vite）+ 微信小程序平台

理由：

1. **现有代码是 Vue3**，Options/Composition 写法、api.js、store.js、业务常量、normalization 逻辑可大量平移；只编译到微信小程序，不为多平台付出兼容代价。
2. 团队已有的 Vue 经验零浪费，而原生 WXML 需要全部重写且无法共享代码。
3. 生态成熟：uni-ui、uView Plus 提供表单/弹窗/日历/上传等组件；支持 npm、分包、ec-canvas。

对比：

| 方案 | 工作量 | 体验/过审 | 结论 |
|---|---|---|---|
| **uni-app 重写 UI 层**（推荐） | 中：业务逻辑复用，视图重写 | 原生体验，过审无障碍 | ✅ 采用 |
| 原生 WXML/WXSS | 最大：101 个文件全重写 | 最好 | 不推荐，性价比低 |
| web-view 套现有 H5 | 极小（1–2 天） | **个人主体不支持 web-view**；需业务域名校验；页面内无原生能力，审核风险高，体验割裂 | 仅作临时演示，不作正式方案 |

> 定位：H5 与小程序**长期并存、共用同一套后端**。H5 继续承载管理后台、复杂文件预览、OAuth 绑定等场景。

---

## 3. 目标架构

```
微信小程序（uni-app，新目录 miniprogram/）
   │  HTTPS  wx.request / wx.uploadFile / wx.downloadFile
   ▼
Nginx（gkjsdh.xyz，现有）
   │  /api/*
   ▼
Express 后端（现有 + 少量新增接口/中间件）
   │
   ▼
SQLite（现有 compass.db，session 表直接给小程序发 token）
```

- 新代码放在仓库根目录 **`miniprogram/`**（uni-app 工程），与 frontend/、backend/ 平级，独立构建，不污染现有部署。
- 后端**不加新服务、不换库**：新增一个 `routes/wechat.js`（微信登录/绑定）+ UGC 内容安全中间件 + 少量异步化接口。
- 复用线上已验证的接口契约；前端 api.js 的封装思路（超时、错误 hint、need_real_name 弹窗）平移成 `utils/request.js`。

---

## 4. 微信侧前置条件（需要运营/资质，最先启动）

1. **注册小程序账号、确定主体**：
   - 个人主体：可微信登录，但**不支持 web-view、getPhoneNumber**，类目受限；
   - 企业/组织主体（推荐，学校/实验室名义）：支持 web-view、手机号快速验证、更多类目。
2. **小程序备案（MIIT）**：2024 年起所有小程序上架前必须完成，周期约 1–3 周，与开发并行。
3. **域名要求**：
   - request/uploadFile/downloadFile 合法域名只能是 **HTTPS 且域名已 ICP 备案**——需确认 gkjsdh.xyz 已有 ICP 备案；若没有，备案需提前数周。
   - 在小程序后台配置：`https://gkjsdh.xyz`（request、upload、download 三类都要加）。
4. **续期 HTTPS 证书**：现有 TrustAsia 证书 **2026-11-23 到期**，先续期，避免开发期掉证书。
5. 准备 AppID + AppSecret（后端环境变量 `WECHAT_APPID` / `WECHAT_SECRET`）。
6. 选择服务类目（教育/工具类），补「用户隐私保护指引」（收集了头像昵称、手机号、定位、相册素材，必须逐项声明用途）。
7. UGC 合规：小程序内用户发帖/评论/图片/聊天均须接微信内容安全 API（见 5.3），并提供举报与处理入口——**这是过审硬要求**。

---

## 5. 后端改造点（约 1–1.5 周）

### 5.1 微信登录与账号绑定（新增 routes/wechat.js）

- `POST /api/auth/wechat-login`：入参 `{ code }` → 后端用 code 调 `jscode2session` 换 openid/session_key：
  - 已绑定 → 直接 INSERT session 表，返回现有格式的 token + user；
  - 未绑定 → 返回临时登录态（短 token，仅可调绑定接口）。
- `POST /api/auth/wechat-bind`：用账号密码或邮箱验证码核验老账号后绑定 openid；也支持注册新账号。
- user 表加列：`wechat_openid TEXT`（migCol 迁移链加唯一索引，沿用项目既有迁移方式）。
- 头像昵称：按微信新规范，使用 `open-type="chooseAvatar"` + 昵称填写能力，不再静默获取。

### 5.2 长耗时接口异步化（绕过 wx.request 60s 上限）

现状 AI 接口超时设置 90s/120s，必须改：

- 方案：**异步任务 + 轮询**（小程序不支持 EventSource/SSE）。
  - `POST /api/ai/plan-jobs` 立即返回 job_id；后端继续跑 DeepSeek；
  - `GET /api/ai/plan-jobs/:id` 轮询状态（pending/done/failed）+ loading 文案；
  - 普通问答 `/ai/chat` 保留，但提示词收敛、目标 30s 内返回。
- 票据 OCR 同样改「先上传拿图片 URL → 提交识别任务 → 轮询」。

### 5.3 内容安全中间件（UGC 过审必备）

- 文本：发帖/评论/聊天/反馈入库前调 `security.msgSecCheck v2`（需 openid）；
- 图片：头像、帖子图、票据、资源照片、荣誉图上传后调 `security.imgSecCheck`（或异步审核）；
- 结果为 risky 时拦截并返回统一错误码；管理端保留人工处置。
- 建议带 24h 本地缓存（按内容 hash）减少 API 调用。

### 5.4 上传/下载链路收敛

- 统一走 multer multipart（8 个路由已有先例），把仍走 base64 的接口（帖子图、头像等）补 multipart 入口，配合 wx.uploadFile；
- 下载/预览接口确认支持 `?token=` 鉴权（现有 middleware 已支持 query token），wx.downloadFile 可直接带；
- 单文件控制在 10MB 内（小程序选择/上传限制），超限在前端压缩（现有 compressImage 900/640 逻辑可平移）。

### 5.5 其他

- **订阅消息**：审批结果、队伍消息、打卡提醒等场景申请模板，后端在现有通知点补发 subscribeMessage；不改通知表结构。
- CORS 保持现状（小程序不受 CORS 限制，但不影响 H5）。
- GitHub/飞书 OAuth：小程序内不做网页跳转登录；「账号绑定」放 web-view 的 H5 账号安全页（需企业主体），首版可直接不做。
- 日志/限流：新增 `/api/auth/wechat-*` 纳入现有 access_log 与频控。

---

## 6. 小程序工程规划（uni-app）

### 6.1 目录与分包（主包 ≤2MB，整包 ≤20MB）

```
miniprogram/
├── pages/                    # 主包：仅放 tabBar 高频页
│   ├── timeline/             # 竞赛时间轴（首页）
│   ├── schedule/             # 备赛日程
│   ├── team/                 # 小组
│   └── me/                   # 我的
├── packageCompetition/       # 竞赛详情/技术栈/AI问答（分包）
├── packagePlan/              # 学习日程/计划对话/笔记
├── packageTeam/              # 小组任务/打卡考勤/聊天/文件/成员
├── packageShare/             # 分享/项目文件/预览
├── packageOps/               # 报销/采购/预约（重模块独立分包）
├── packageAdmin/             # 轻量审核端（竞赛收录审核/公告，可选）
└── utils/  request.js(=api.js) / auth.js(=storage) / upload.js / wechat.js
```

tabBar 5 栏：**竞赛 | 日程 | 小组 | 资源 | 我的**（「资源」聚合预约/分享/采购/报销入口，或按上线阶段调整）。

### 6.2 视图层重写要点

- 所有 Element Plus 弹窗 → 全屏页面或 uni-popup；el-table → 卡片列表（现有 ≤768px 移动端响应式样式直接当视觉稿）。
- 时间轴：横向 GSAP 滚动 → 月份切换 + 纵向卡片（H5 移动版已有月切换视图，照交互搬）。
- 技术栈树：ec-canvas 渲染精简树（默认展开 1–2 层，2072 节点做折叠/懒加载）。
- 日历（CalendarView 22KB）：用 uView/uni 日历重写，逻辑层复用数据处理。
- 甘特图（WeekGantt 24.5KB）：canvas 自绘周视图，或降级为「时段列表 + 冲突提示」。
- 文件预览：图片用 image/previewImage；PDF/Office 用 wx.downloadFile + wx.openDocument；HTML/Markdown 用 rich-text 或 web-view（ShareReadme 的 md 渲染改小程序 markdown 组件）。
- 匿名 'local' 日程：继续落本地存储（wx.storage），登录后沿用现有合并逻辑。
- 分享：微信 onShareAppMessage 分享小程序卡片（竞赛/帖子/项目页），替代现有 URL 分享；H5 的 GitHub 风公开链接在小程序内用页面路由参数承接。

---

## 7. 分期排期与里程碑（建议 1 人全职；2 人可并行约 ×0.6 周期）

| 阶段 | 内容 | 周期 | 产出 |
|---|---|---|---|
| **P0 地基**（第 1–2 周） | 资质/备案/域名/证书（并行）；uni-app 脚手架、request/auth/upload 封装、微信登录+绑定、实名门禁、tabBar 骨架 | 2 周 | 可登录的空壳小程序跑通线上接口 |
| **P1 核心 MVP**（第 3–5 周） | 竞赛时间轴、竞赛详情 5 Tab、AI 问答（含异步任务改造）、备赛日程、我的 | 3 周 | **可提审的 1.0：查竞赛 + AI + 备赛日程** |
| **P2 计划与小组**（第 6–8 周） | 学习日程/计划对话、小组与成员、任务、打卡考勤、聊天、消息通知（订阅消息） | 3 周 | 组队备赛闭环 |
| **P3 资源与荣誉**（第 9–10 周） | 资源分享/项目文件/预览、荣誉墙 | 2 周 | 内容社区闭环 |
| **P4 运营模块**（第 11–13 周） | 报销（拍照 OCR）、采购审批、资源预约/甘特 | 2.5 周 | 完整功能对齐 |
| **P5 收尾**（第 14 周） | 轻量审核端（竞赛收录+公告，可选）、内容安全复核、性能/分包体检、提审上线 | 1 周 | 正式版 |

- **全量对齐约 13–14 周**；**MVP（P0+P1）约 5 周可提审**，建议尽早提审验证资质与类目，后续版本迭代。
- 管理后台（AdminConsole 全部 Tab、甘特全功能等）继续用 H5，不进小程序范围。

---

## 8. 主要风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 域名无 ICP 备案 / 小程序备案慢 | 无法联网、无法上架 | 第 1 天启动资质办理，开发期用开发者工具「不校验域名」 |
| AI 接口 >60s | wx.request 直接失败 | 5.2 异步任务化，MVP 前必须完成 |
| base64 大文件/10MB 限制 | 上传失败 | 统一 multipart + 前端压缩；沿用既有 compressImage |
| UGC 未接内容安全 | 审核被拒甚至封禁 | 5.3 中间件随首个带 UGC 的版本（P3）一起上 |
| 个人主体能力受限（web-view/手机号） | 绑定、HTML 预览受阻 | 优先用学校/组织主体注册 |
| 证书 11-23 到期 | 开发期接口全挂 | 立即续期并加到期监控 |
| 小组模块体量巨大（~130 接口/18 组件） | 拖垮整体进度 | P2 只做成员/任务/打卡/聊天，文件与设备预约可顺延 P4 |
| 技术栈树 2072 节点性能 | 卡顿 | 折叠懒加载 + ec-canvas 按需 setOption |
| 双端逻辑漂移 | 维护成本 | 纯逻辑（归一化、常量、校验）抽 utils 共享；接口契约以 backend 为准单一来源 |

---

## 9. 需要你拍板的 3 件事

1. **小程序主体**：能否用学校/实验室/公司等组织主体注册？（决定 web-view、手机号能力与类目）
2. **首期范围**：是否同意先做 **MVP（竞赛时间轴 + AI 问答 + 备赛日程 + 我的）** 提审，其余分批？还是要求首版全量对齐？
3. **技术路线**：确认采用 **uni-app（Vue3）**，新工程放 `miniprogram/`，H5 与后台保留并存？

> 拍板后即可进入 P0：先做后端微信登录接口 + uni-app 脚手架连通线上 API。