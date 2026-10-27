# Engineer-Compass 工科竞赛导航系统 — 项目记忆文档

> 本文件是 Claude Code 长期记忆的离线汇总版（2026-08-25 生成），自包含、可交接。
> 源记忆位于 `C:\Users\78505\.claude\projects\D--desktop-----\memory\`，本文件同步于此目录，两者并存。

---

## 1. 项目总览

**Engineer-Compass 工科竞赛导航系统**（目录 `D:\desktop\竞赛指导`，2026-08-23 启动）。B/S 网页端应用，帮工科生查全年 A 类竞赛 + AI 备赛规划。

- 技术栈：**Vue3 + Vite6 + Element Plus + GSAP + ECharts + SCSS** / **Node.js 24 + Express 4 + node:sqlite（内置，无编译依赖）** / **DeepSeek API**
- 部署：腾讯云 CVM **124.221.174.2**（Ubuntu，主机名 VM-0-10-ubuntu）`/opt/compass`（PM2 + Nginx 1.18）；SSH **仅密钥**：用户 `ubuntu`（免密 sudo），本机 Windows `C:\Users\78505\.ssh\id_rsa` 公钥已入 authorized_keys（**WSL 直挂 /mnt/c 私钥 0777 会被 ssh 拒，须先 cp 到 ~/.ssh 再 chmod 600**；root/ubuntu 默认密码登录均关）；前端 `/var/www/compass`，站点配置 `/etc/nginx/sites-available/compass`（非 conf.d），30m 上传上限。**2026-10-26 起 HTTPS：域名 gkjsdh.xyz（A 记录→该 IP），证书 /etc/nginx/ssl/gkjsdh.xyz_{bundle.crt,key}（TrustAsia DV，到期 2026-11-23），443 default_server，80 域名 301、IP 直连保留 HTTP**

**四大模块：**
1. 横向时间轴（按月排布竞赛，彩色标签、筛选、详情弹窗 5 Tab）
2. 全局 AI 对话（上下文感知当前查看的竞赛）
3. 参赛 & 智能日程规划（DeepSeek 生成备赛计划，竞赛日程 + 学习日程 + 小组计划）
4. **知识增长引擎**：用户问库外竞赛 → AI 检索提炼 → pending 入库 → 管理员审核转正

**移动端（2026-08-25 起）**：≤768px 响应式——汉堡导航、时间轴月份切换视图、弹窗全自适应（详见 §9）。

---

## 2. 目录结构

```
竞赛指导/
├── backend/
│   ├── server.js              # Express 入口（挂载全部路由）
│   ├── db/database.js         # node:sqlite 连接 + 迁移链（migCol/表创建）
│   ├── db/schema.sql          # 建表语句（与 database.js 同步维护）
│   ├── routes/
│   │   ├── competition.js     # 竞赛列表/详情/搜索/审核
│   │   ├── ai.js              # callDeepSeek 封装 + chat/extract
│   │   ├── schedule.js        # 备赛日程（normalizePlan 在此，共享）
│   │   ├── study.js           # 学习日程（第6表 user_study）
│   │   ├── platforms.js       # 平台搜索模板 SEARCH + PLATFORM_META
│   │   ├── team.js            # 小组/角色/计划（normTeamPlan）
│   │   ├── teamCollab.js      # 任务/日志/消息/文件/设备预约/成员计划同步
│   │   ├── planChat.js        # 对话式 AI 计划统一入口（7 模式）
│   │   ├── users.js           # GET /users/:id/public 公开主页
│   │   ├── auth.js            # 注册/登录/邮箱双通道/个人资料
│   │   ├── mailer.js          # 零依赖 SMTP 客户端（node:net/tls）
│   │   ├── middleware.js      # scrypt/authRequired/optionalAuth/teamCtx/hasPerm
│   │   ├── notes.js           # 日程笔记（daily_note）
│   │   └── feedback.js        # 用户反馈邮件
│   ├── scripts/               # 数据导入 + 冒烟测试（smoke_*.js 全绿）
│   └── data/compass.db        # SQLite（.gitignore 排除）
├── frontend/
│   └── src/
│       ├── styles/main.scss   # 全局样式 + 移动端响应式底座
│       ├── api.js / auth.js / store.js / router.js
│       └── components/        # 页面 + team/ 子组件（详见各节）
└── 竞赛数据/                  # 84 项竞赛、398 子赛项、2072 技术栈节点
```

---

## 3. 数据库（node:sqlite / Node 24 内置）

18+ 张表（schema.sql 与 database.js 迁移链同步，老库启动时 migCol 自动补列）：

| 表 | 用途 | 关键列/备注 |
|---|---|---|
| competition | 竞赛主表 | status pending/active、source_url 防幻觉、official_url 官网 |
| competition_process | 子赛项 | 赛制/技术栈树/达标建议 |
| tech_stack | 技术栈节点 | 2072 节点 |
| media_resource | 学习资源 | 4865 条（平台搜索模板 + 13 条 manual 核验） |
| user_schedule | 个人备赛日程 | **user_id INTEGER**（'local' 或账号 id 混存）、is_custom |
| user_study | 学习日程 | user_id TEXT、topic/level/goal/hours、plan_json |
| daily_note | 日程笔记 | **user_id TEXT** |
| team / team_member / team_member_role | 小组/成员/多角色 | 桥表复合主键 (team_id,user_id,role_id)，最多 3 角色 |
| team_role | 角色 | name/level/permissions JSON、组长恒全权限 |
| team_plan | 小组备赛计划 | plan_json 含 dept/role_id 部门分工 |
| progress_log / team_message / comment | 进度/讨论/评论 | attachments JSON、CommentThread 嵌套 |
| team_file / device | 资料/设备预约 | base64 ≤20MB、时间冲突检测+审批流 |
| user / email_code / feedback | 账号/验证码/反馈 | scrypt 哈希、邮箱验证码登录 |

**⚠️ node:sqlite TEXT 列绑定坑（必读）**：
`WHERE user_id = ?` 绑定 JS 数字 37 **不匹配** TEXT 列里的 `'37'`（实测实证）。写入统一 `String(uid)`，查询也用字符串绑定。参照 `routes/notes.js` 的 `owner = (req) => String(req.user.id)` 单一出口模式。注意：`user_schedule.user_id` 是 **INTEGER**（绑定数字、不 String()），与 daily_note 的 TEXT 相反！

---

## 4. 后端接口清单（/api 前缀）

| 路由 | 接口 |
|---|---|
| /competition | GET 列表(按状态/类型/月份) / 详情(含 media/process) / 搜索 / 审核转正 |
| /ai | POST chat（json:false 自由文本） / extract（json 模式提炼收录） |
| /schedule | GET list / POST add（AI 生成） / manual（自编） / edit / delete / export(md/excel) / optimize / **calendar?month=** / list |
| /study | POST plan（AI_TIMEOUT 90s） / list / :id 详情(实时 buildResources) / 勾选保存 / manual / delete |
| /auth | register / login / send-code(60s 冷却) / email-login(自动注册+**接管本机数据**) / me / profile / email 绑定 |
| /team | 建组(AI 智能建组 departments+plan 直建) / 加入(邀请码 8 位 A-Z2-9) / 角色 CRUD / 成员管理 / 转让 / 解散 / plan 生成编辑勾选 / my-tasks(个人同步) / plans(成员计划同步) / ai-grouping(建议) |
| /teamCollab | 任务看板 / logs(富文本 wangEditor5+附件) / messages / files / devices 预约 / comments |
| /plan-chat | **对话式 AI 计划统一入口**（见 §8） |
| /users/:id/public | 公开主页（任何登录用户可看，不暴露邮箱） |
| /notes | 日程笔记 CRUD |
| /feedback | 用户反馈 → FEEDBACK_TO 邮件 |
| /health | 健康检查（`ai:true` = 线上 AI 可用） |

**路由注册顺序坑**：`GET /team/my-tasks` 必须注册在 `GET /:id` **之前**（否则被 :id 吞掉）；`/schedule/calendar` 注册在 `/:id/export` 前。

---

## 5. 权限模型

- 登录：密码 scrypt 哈希零依赖；邮箱验证码双通道（SMTP 未配置自动降级 dev 模式带 `dev_code`）
- `authRequired` / `optionalAuth`（有 token 解析 req.user，无则放行——匿名用户 'local'/NULL）
- 小组：`teamCtx(teamId, userId)` → `ctx.isOwner`（组长）+ `ctx.member` + `ctx.roles[]`
- `hasPerm(ctx, key)`：`ctx.isOwner || ctx.roles.some(...)`；`requirePerm` 无权限**先发 403 响应（有副作用）**——判断放最后会误伤本人分支，优先用 `hasPerm` 短路
- 计划勾选限权：`dept==='通用'` 全员可勾；部门任务仅 `role.name===dept` 成员可勾；组长/team 权限可勾一切
- 组长也可拥有角色（≤3），transfer 保留双方角色；成员行角色 select 需 `perms.member`

### 全站管理员分权（2026-10-24，RBAC 轻量版）
- `user.is_admin=1` + `admin_perms`（TEXT，migCol 已加，老库自动 `''`）：**空串=超级管理员全权；非空=JSON 权限 key 数组=受限管理员**。注意落库口径：超管存 `''` 不存 `'[]'`（COUNT 超管 SQL 按空串计），前端拿到的 `perms:[]` 由 `parseAdminPerms` 计算
- 权限 key（middleware.js `ADMIN_PERMS`）：`user / content / competition / announce / honor / resource / feedback / log / server / lab`（lab=「借用记录」跨项目全局查看/导出，2026-10-24 加入，2026-10-25 随登记并入预约模块改名）
- **2026-10-26 细粒度子权限（P1，在 main 直接开发）**：5 个高频模块在父 key 之下拆子 key（`admin_perms` 扁平 JSON 数组混存父子；**父 key=整组全权，子 key=单项**）——user 组 `user:view`(列表/详情)、`user:moderate`(封禁/禁言/解封)、`user:notify`(群发改密/实名提醒)；content 组 `content:post`(帖子看/删/前台越权编辑)、`content:comment`(评论看/删)；resource 组 `resource:view`(列表+越权下载)、`resource:delete`；feedback 组 `feedback:view`/`feedback:delete`；log 组 `log:action`(操作日志)/`log:visit`(访问记录，含 IP 更敏感)；competition/announce/honor/server/lab 不拆。结构定义 `ADMIN_PERM_GROUPS`（children 带 label/desc/**danger**），工具 `isValidAdminPerm`(ADMIN_PERM_KEYSET 父子集合)/`adminPermLabel`；`parseAdminPerms` 过滤改 keyset（防任命时子 key 被静默丢弃）；`hasAdminPerm` **父子双向继承**（持父放行任意子；持任一子放行裸父入口检查）——安全约束：**高危守卫必须直接写子 key**（admin.js 全部 ap()、resource.js 下载 resource:view/删除 resource:delete、share.js canEdit=content:post、评论删除=content:comment、私密帖可见=二者任一）；GET `/admin/perms` 返回 `{flat,groups}`。任命管理员 PUT role 永远仅超管。**旧受限管理员持父 key 零迁移、不缩权**。前端 utils/adminPerms.js 出 PERM_GROUPS/PERM_FLAT/canAdminAny/继承版 canAdmin，权限弹窗分组勾选（组头 checkbox indeterminate 半选、danger 子项红字、父选中子项只读、勾组头存父 key），TAB_PERMS 改多 key 数组（tabCan/canAdminAny），按钮级 v-if，只读子权限看不到列表时显 info alert，loader 按子 key gate 防 403 toast。冒烟 scripts/smoke_admin_perms.mjs **56/56**（自起 :3111 临时库；不存在 id 用 403-vs-404 验证守卫先于处理器），npm 脚本 `smoke:admin-perms`。P2（预约/采购审批权下放给受限管理员）未做，仍仅超管
- 借用登记（2026-10-25 并入资源预约模块，分支 codex/lab-borrow-in-project）：拍照+名称+学号一次性登记**任意预约项目通用**——入口是项目页第 5 个 tab「📸 借用登记」（`BorrowRegisterPanel.vue`），端点 `POST /booking/projects/:id/borrow-registrations`；登记写 booking（item_kind=device/room、item_name/item_image/item_thumb、start=end=now、confirmed、零时长），由每项目一个占位资源 `booking_resource.is_carrier=1`（migCol+按名「借用登记」回填）承载，占位资源不进 resources 列表/项目计数/甘特/统计，禁建同名/改删/直接预约；timeline SQL 用 `COALESCE(b.item_kind,'')=''` 排除登记行；登记行只在审批表（新增「类型」列）与我的预约/详情弹窗里看，原图仅 `/bookings/:id` 返回（列表剥 item_image），本人可随时取消登记。`/lab-admin` 借用记录管理保留（lab 权限，可跨项目看详情原图），记录列表/导出新增所属项目列与 `?project_id` 筛选。旧 `/resources`、`/lab` 在前端 router 重定向到 `/booking`；旧端点 lab-project/lab-overview/borrow-registrations 已删（404）。冒烟 `scripts/smoke_borrow_reg.mjs` 36 项（自起临时后端 :3108）；相关列：`user.student_no`、booking 5 个 item_* 列；全站登录硬门禁仍由 router PUBLIC_ROUTES 白名单兜底
- 借用记录页并入资源预约大厅（2026-10-25，分支 codex/resource-unify-photo）：LabAdminView 删除，内容抽成 `BorrowRecordsPanel.vue` 嵌入 `BookingView` 第 4 个 tab「🗂️ 借用记录」（`v-if canAdmin('lab')`，tab 状态同步 `?tab=` query），面板内新增项目下拉筛选；`/lab-admin` 前端重定向到 `/booking?tab=records`（无权限自动落回全部项目，接口仍 requireLabAdmin）；导航唯一入口「资源预约」（桌面顶栏/底部 tab「资源」）。**资源照片**：录入资源（物品+空间都支持）时可选拍照/上传（ResourceFormDialog，compressImage 900/640 档，≤40 万字符，可移除），后端 normResourceBody/PUT 的 image 处理从 item 分支提到通用；新 `ResourceDetailDialog.vue` 看照片+台账，入口=资源卡片名/缩略图（所有人）+ 周视图桌面端资源名（emit select-resource；手机折叠面板名不绑点击，避免拦截展开）。smoke_booking 120→124（空间带图创建/物品补图/移除/空间移除）
- 守卫：`adminPermRequired('content')`（挂 authRequired 后；多 key=任一）、`superAdminRequired`（任命管理员）、`hasAdminPerm(u,key)`、`isSuperAdmin(u)`；`adminRequired` 语义变为"任意管理员"作兜底
- `/api/admin/*` 逐路由挂模块守卫；`PUT /admin/users/:id/role` 仅超管：协议 `{is_admin,perms:[]}`，禁操作自己、最后超管不可降级/取消、非法 key 过滤
- 业务散点收口：booking/purchase 的"管理员全权"只认真超管（`isSuperAdmin`）；share 删帖删评论/私密帖可见=`content`，幽灵帖巡检仍仅超管；resource 越权下载/删除=`resource`；honor 下架图=`honor`
- **修了既有越权**：`/api/competition/pending|verify|DELETE` 原本零鉴权，现挂 `competition` 守卫（POST / 公开不变）；前端 /admin 路由补守卫
- 前端：`utils/adminPerms.js`（canAdmin/isSuperAdmin/permSummary/PERM_OPTIONS），AdminConsole Tab 按权显隐+懒加载+权限分配弹窗（超管 radio/受限 checkbox），`/admin-console?tab=honors` 深链；冒烟 `scripts/smoke_admin_perms.js`（36 项，含 lab）

---

## 6. 关键设计决策

- **未知竞赛收录状态机**：pending（AI 收录，**必须带 source_url**，无 URL 拒绝入库）→ 人工审核 → active
- DeepSeek 不带联网搜索 → 搜索三档：博查/Tavily / 用户粘贴官方通知（MVP）/ 爬虫（不碰）
- **callDeepSeek json 模式限制**：DeepSeek 要求提示词含 "json" 才允许 json 模式 → 对话问答用 `{json:false}`，extract/计划生成保持 json
- 数据防幻觉：13 条 manual 真实链接经 WebSearch 核验；'official' 平台类型 = 官网入口
- 个人计划归一化统一入口：templatePlan / AI / 优化全过 `normalizePlan`（schedule.js 导出）；小组计划走 `normTeamPlan`（保留 dept/role_id/done_by/done_at）——**两函数行为曾不一致导致 bug（见 §7）**
- 数据库迁移：SQLite 不支持 ALTER 加 UNIQUE 列 → 索引兜底，且**索引创建必须放 database.js 迁移链之后**（否则老库启动崩）

---

## 7. 踩坑记录（全量）

1. **node:sqlite 数字/TEXT 绑定不匹配**（§3）——user_id 一律 String()（user_schedule 除外是 INTEGER）
2. **`/schedule/add` 挂 optionalAuth 后 list 仍查 'local'** → 登录用户计划"保存后消失"。修复：list 挂 optionalAuth，登录查 `自己 OR 'local'`，匿名查 'local'
3. **user_study 表原无 user_id 列** → schema.sql 补列 + migCol 迁移
4. **SMTP 配置快照问题**：mailer.js 模块加载时读 env → ESM 静态 import 先于 `.env` 加载 → 恒 false。修复：**全部改惰性读取（调用时读 process.env）**
5. **SMTP multiline 解析 bug**：makeReader 返回的 text 已裁分隔符 → 终行判断恒 true → EHLO 残留行。修复：先消费缓冲区残留行 + 返回 last 标记
6. **`[object Object]` 落库**：api.js 用 `JSON.stringify({content})` 再包装而调用方传整个对象 → `String(content)` 落库脏数据。修复：api.js 直接传完整对象 + 后端 typeof 校验 + 读时清洗
7. **user_schedule.user_id 返回 "156.0"**（REAL 类型）——既有行为，相同数字绑定可匹配
8. **AI 收录数据匹配陷阱**：`LIKE '%电赛%'` 误中"光电赛" → 匹配词用"电子设计"
9. **plan-chat AI 非确定性**：首轮直接出计划 → FIRST_KICKER 禁出；信息足仍反复问 → FORCE_KICKER（history≥4 强制出）；残缺 JSON → catch 转 question 而非 502
10. **normalizePlan 丢 dept/done_by** → 小组计划任务全变「通用」（2026-08-25 修复，§8）
11. **Vue scoped style 是纯 CSS**：App.vue 无 lang="scss"，`//` 注释构建直接失败 → 必须 `/* */`
12. **watch 源 TDZ**：TeamView 深链代码 watch(selTeam) 写在 ref 声明前 → ReferenceError 整页空白。script setup 里 watch 的源必须已声明在前
13. **v-for + v-if 同元素**：v-if 优先级高于 v-for → `calDlgItems[undefined]` TypeError。用 `<template v-for>` 包
14. **`detail.perms` 是对象不是数组**：`props.perms?.team`，不能 `.includes('team')`
15. **wangEditor 弹窗内重挂载**：destroy-on-close 解决
16. **冒烟断言陷阱**：`p.tasks.every(t => t.dept)` 抓不出「全通用」（'通用' 也是 truthy）→ 断言要写 `t.dept !== '通用'` 或直接单测归一化函数

---

## 8. 对话式 AI 计划（/api/plan-chat，2026-08-25）

**核心设计：所有计划建立/修改先经 AI 对话**——AI 先问清分组/时间周期，信息足够或 ≥4 条消息后输出计划。

**7 模式**：`team-create | team-generate | team-edit | schedule | schedule-edit | study | study-edit`
- team-create：只返回不保存（前端拿 departments+plan POST /team 直建，跳过 AI）
- team-generate/team-edit：组长权限（403 校验），新部门先落库再归一化（roles=现有∪新部门）
- schedule/study：INSERT user_schedule（is_custom=0，uid ?? 'local'）/ user_study（需 topic）

**协议**：AI 自由文本回复 → 检测 JSON（`{`+最后`}` fallback 切片）→ `{action:'question',reply}` 或 `{action:'plan',reply,plan,departments?,plan_id?}`
- FIRST_KICKER（空历史禁出计划）→ KICKER（不足提问/足够出计划）→ FORCE_KICKER（history≥4 强制出，默认值补缺）
- `mergeDone`：按 `阶段名|文本` 键从旧 plan 复制 done/done_by/done_at（保留勾选，纯函数单测）
- 前端 PlanChat.vue 通用弹窗，会话 key `[mode,teamId,planId,...].join('|')` 变化重置，watch modelValue 自动首问

**前端入口**：TeamView 建组「💬 AI 对话智能建组」、TeamPlanView 生成/修改、CompDialog 备赛日程、ScheduleView「💬 AI 修改」、StudyView 生成/修改。

---

## 9. 移动端适配（2026-08-25，≤768px 主断点）

- **全局底座**（main.scss）：`.el-dialog { width: calc(100vw-24px) !important }` 一处兜底全部固定宽度弹窗（弹窗 append-to-body 脱离 scoped 树，全局 class 是唯一可靠方式）；页面容器 padding 收紧；`.el-input/.el-select { max-width:100% !important }` 压住内联 width；`.nav` 隐藏 + `.menu-btn` 显示
- **汉堡菜单**（App.vue）：☰ + 下拉面板（4 链接+用户胶囊），`watch(route.path)` 自动收起
- **时间轴月份视图**（TimelineView）：双 DOM 纯 CSS 切换——`.timeline-mobile` 默认 display:none，≤768px 显示并隐藏桌面 13 列网格；`‹月份›` 切换 + 待定/今天；竖向卡片复用 .t-card
- **CalendarView**：格子 52px、emoji 11px、工具栏换行
- **组件微调**：ScheduleView/StudyView 控件铺满、TeamPlanView/TeamMembers/ManualPlanDialog 编辑行换行、MyView 头像遮罩恒显（触屏无 hover）、AIChatBox 面板全屏、CompDialog matchMedia 响应式 :column、TeamView 列表限高
- 桌面端全部原样保留（时间轴 13 列、两栏布局）

---

## 10. 部署运维

**GitHub**：https://github.com/sukeleE/Engineer-Compass.git（私有，main 分支）
- remote 为 HTTPS；`.env`/`.claude/`/`backend/data/` 已 .gitignore 排除
- 直连 GitHub 常被阻断 → **SSH 443 备用通道**：`~/.ssh/config` 映射 `github.com → ssh.github.com:443`（公钥 id_rsa 已注册）。推送失败时显式执行：`git push ssh://git@ssh.github.com:443/sukeleE/Engineer-Compass.git main`（走 `||` fallback 会因 tail 退出码 0 吞掉失败，必须显式重试）
- `deploy.sh`（根目录）：一键部署脚本（备份 DB → pull → install → pm2 restart → build → 发布）

**手动部署命令**（用户服务器执行）：
```bash
cd /opt/compass && sudo git pull && cd backend && pm2 restart compass --update-env && cd ../frontend && sudo npm run build && sudo rm -rf /var/www/compass/assets && sudo cp -r dist/* /var/www/compass/
```
部署后验证：`curl /api/health` 返回 `ai:true` = 线上 AI 可用（key 在服务器 backend/.env）

**测试**：`backend/scripts/smoke_*.js`（node 内联 fetch 依赖本地后端已启动）——当前全绿：plan_chat 27、team_plan 35、calendar 20、profile 16、multi_role 48、team_ai 14、auth_email 17、auth_ext 34、notes、collab 33、auth_email 17。前端 `npm run build`（vite 6，~15s，仅 chunk >500kB 告警待代码分割）。

---

## 11. 会话演进史（按时间）

- **2026-07-24（魔力元宝 YOLOv8）**：标注策略重构（颜色检测废弃 → COCO+YOLO-World 混合）、CLIP ZIP 安装、虾/猪肉人工标注。772 图 / 816 框，下一步训练
- **2026-08-23**：项目启动，方案文档 `工科竞赛助手.txt` 重写；A 类竞赛数据整理（84 项/398 子赛项）
- **2026-08-24 阶段一**：Express + node:sqlite 建库导入（84 竞赛/398 子赛项/2072 节点），competition/ai/schedule 接口
- **阶段二**：前端时间轴 + 详情弹窗（GSAP/ECharts/4Tab）+ AI 悬浮对话
- **阶段三**：备赛日程页（任务勾选即时保存/月历/导出/优化）
- **阶段四**：AI 收录管理端 + DeepSeek 上线（json 模式限制修复）
- **学习资源模块**：media_resource 表 4865 条 + Tab5
- **竞赛官网字段**：official_url + 横幅
- **AI 学习日程**：user_study + /study 页 + buildResources
- **项目小组模块**：17 张表 + /team 页（角色权限/进度/讨论/资料/设备）
- **小组计划同步 + 富文本汇报**：plans 聚合、wangEditor5、附件、ImageViewer、评论回复
- **计划自编/内容编辑**：ManualPlanDialog、原地编辑
- **邮箱验证码注册/登录**：零依赖 SMTP + 匿名数据接管
- **个人中心**：/me + 全站登录入口
- **请求 I-L**：小组 AI 备赛计划（team_plan 单表 JSON + 部门拆分）、AI 智能建组/分组、部门勾选限权+完成人+个人页同步、SMTP 线上故障排查、[object Object] 修复、笔记弹窗化+原地编辑
- **请求 M-P**：文本编写体验（RichEditor/评论）、日程笔记浮窗化、登录邮箱双通道+个人中心+反馈邮件、多角色系统（≤3 角色桥接表）
- **请求 Q**：日程月历重构（emoji 格 + done_at 完成日聚合 + 已完成计划列表）
- **请求 R**：成员计划同步过滤 + 小组切换残留修复（:key 重建子树 + ?team= 深链）+ 用户公开主页（/user/:id）
- **请求 S**：组长多角色（transfer 保留双方角色）
- **请求 T**：对话式 AI 计划（plan-chat 7 模式，§8）
- **请求 U（2026-08-25）**：移动端适配（§9）
- **2026-10-24 管理员分权**：全站管理员从 is_admin 布尔升级为「超管 + 9 模块 perms」（§5），修竞赛审核接口越权，冒烟 smoke_admin_perms 29 项

---

## 12. 待办 / 下一步

- ⏳ 阶段五：动画/3D/Docker 打磨
- ⏳ 代码分割减小 bundle（当前 3MB+，chunk >500kB 告警）
- ⏳ 34 项观察目录竞赛（数学竞赛等）补充作 pending 数据
- ⏳ 手机端部署后实机走查（375px：首页月份切换/日历/小组/AI 对话弹窗）

---

## 附录：魔力元宝项目（另一个比赛项目，独立目录）

YOLOv8 训练识别 16 类物品：青椒、白菜、黄瓜、豆腐、茄子、番茄、虾、土豆、猪肉、鱼肉、苹果、香蕉、牛奶、手机、书包、水瓶。

- 工具链：download_dataset.py（icrawler）→ clean → auto_label（COCO+YOLO-World 混合标注）→ split（80/10/10）→ generate_yaml
- **标注策略**：COCO (yolov8n.pt) 管苹果/香蕉/手机/书包/水瓶；YOLO-World (yolov8s-worldv2.pt) 管其余 11 类；虾/猪肉 makesense.ai 人工标注
- **环境**：CPU only（PyTorch 2.11.0+cpu）；CLIP 通过 ZIP 下载安装（git clone GitHub 不通）；open_clip 与 OpenAI CLIP 嵌入空间不兼容不可替换
- 数据集：772 图 / 816 框；弱类：茄子(1) 鱼肉(1) 书包(1)
- 训练：`yolo detect train data=data.yaml model=yolov8n.pt epochs=50 imgsz=320 batch=16`
- 下一步：训练基线 → mAP 评估 → 补弱类标注 → 调参

---

*文档维护：每次大功能完成更新本文件；源记忆由 Claude 会话自动维护，两者内容对齐。*

## 2026-08-25 资源分享模块（贴吧式）

> ⚠️ 本节的**界面形态已被 2026-09-10 重构取代**（卡片流+详情弹窗 → GitHub 仓库页；表/接口/权限均未变），现行口径见文末「2026-09-10 资源分享页重构」。

- **入口**：顶部导航第 4 项「📤 资源分享」/share；移动端汉堡菜单同步
- **能力**：楼主开楼（标题≤60 + 富文本 + 附件图片/视频/音频/文件 base64 ≤25MB）、索引标签子板块（≤5 个/帖，自建即成为子板块）、点赞/收藏/评论（纯文本，删评限本人/楼主/管理员）、三种排序（最热门=点赞+评论权重 / 最新 / 收藏最高）、标签过滤、分页
- **表**：share_post / share_tag / share_post_tag / share_like / share_fav / share_comment（schema.sql 表 23~28，外键级联删除）
- **接口**：/api/share/*（routes/share.js；读写需登录，浏览匿名可看）；收藏/点赞 toggle 返回最新计数
- **前端**：ShareView.vue（排序 radio + 标签 chips 子板块 + 帖子卡片 + 发帖/详情弹窗，复用 RichEditor / AttachmentList / openImage）；api.js 新增 share* 方法

## 2026-08-25 用户管理页增强：我的帖子/收藏 + 好友私聊

- **入口**：/me 用户管理页改为四个标签：📊 概览（原有内容）/ 📝 我的帖子 / ⭐ 我的收藏 / 👥 好友私聊
- **我的帖子/收藏**：复用 share 列表接口加 `scope=mine|favs`（需登录，未登录 401）；点卡片 → `/share?post=ID` 深链（2026-09-10 二次重构后正式形态是 `/share/:id` 独立详情子路由，`?post=` 只剩兼容层）
- **好友**：搜索用户（用户名/昵称 LIKE，排除自己）→ 发申请；对方已申请过自己时再发直接互为好友（双向自动接受）；申请接受写 friend 表双向行（A-B 与 B-A 各一行）；删除好友双向清；重复申请被拦截、被拒后重发
- **私聊**：dm_message 表，GET /friends/dm/:uid 拉最近 100 条升序并顺带把对方发来的标已读（轮询一次往返）；前端弹窗 3s 轮询、关闭即停；好友列表带未读红点 + 最近消息预览（关联子查询）
- **表**：friend_request（status pending/accepted/rejected）/ friend（双向行 PK user_id+friend_id）/ dm_message（is_read，idx_dm_pair + idx_dm_unread）——schema.sql 表 29~31
- **接口**：/api/friends/*（routes/friends.js，全部 authRequired）：GET /（列表含 unread+last_msg）、GET /requests（incoming/outgoing）、GET /search、POST /request、POST /request/:id/accept|reject、DELETE /:friendId、GET|POST /dm/:uid、POST /dm/:uid/read
- **前端**：MyView.vue 重构（el-tabs 四标签，切标签懒加载）；utils/share.js 抽取 cnt/excerpt/atts/firstImage/attDataURL（ShareView 同步改用）；api.js 新增 friend*/dm* 方法
- **冒烟**：scripts/smoke_friends.mjs 25 项断言全绿（注册→搜索→申请→同意→私聊→已读→scope 过滤→删好友→清理）

## 2026-08-25 消息中心（右下角浮窗 + 红点 + 三组通知）

- **入口**：全局右下角 🔔 悬浮按钮（AI 浮窗正上方，bottom:86px），未读>0 右上角红点数字（99+ 封顶）；与 AI 浮窗互斥（close-fab-panel 自定义事件，展开一方收起另一方）
- **分组**：面板内三 tab：私信评论（好友私信列表 + 评论通知）/ 点赞 / 收藏；未读条目浅蓝底 + 左侧蓝条（小红书风格）
- **通知来源**：他人对分享帖的点赞/收藏/评论（自己操作自己的帖子不通知）；私信未读沿用 dm_message.is_read
- **表**：notification（user_id 接收者 / actor_id 触发者 / type like|fav|comment / post_id / comment_id / is_read）——schema.sql 表 32；帖删级联清通知
- **接口**：/api/notifications/*（routes/notifications.js 新建）：GET /（comments/likes/favs 三组各 ≤50 条，JOIN actor 与帖子，LEFT JOIN 评论内容）、GET /unread-count（含 dm 聚合）、POST /read {types} 批量标已读
- **跳转**：通知 → `/share?post=ID`（2026-09-10 二次重构后通知直接 push `/share/:id` 详情子路由，`?post=` 由兼容层兜底）；私信 → `/me?tab=friends&dm=ID`（MyView deepLink 自动切好友 tab + 打开私聊弹窗 + router.replace 清 query）
- **轮询**：红点 15s 全局常驻；面板打开时 3s 快轮询计数（列表只在打开时拉取，避免阅读中列表跳动）
- **前端**：MessageCenter.vue（仿 AIChatBox 样式：fab 52px 圆形 / 面板 420×640 / 移动端铺满视口）；App.vue 挂载；api.js 新增 notifications*/notificationsUnread/notificationsRead
- **冒烟**：scripts/smoke_notifications.mjs 10 项断言全绿（注册→发帖→赞/藏/评→计数/分组/标已读→私信未读→自操作不通知→删帖级联清空）

## 2026-08-25 工具 Dock：主浮标聚合三个工具（苹果悬浮窗式）

- **入口**：右下角单个 🧰 主浮标（56px 深色半透明球，苹果悬浮球风，right:22px bottom:22px）；点击展开三个工具按钮（📝 日程笔记 / 💬 AI 对话 / 🔔 消息中心，48px 白圆钮 + 左侧黑底名称标签，主浮标上方纵向堆叠），再点主浮标收起并关闭面板
- **红点转移**：消息中心未读（15s 轮询 `api.notificationsUnread`）在 dock 收起时显示于主浮标右上角，展开后转移到 🔔 工具按钮右上角（同一数据两处渲染，99+ 封顶）
- **组件改造**：AIChatBox / MessageCenter / ScheduleNotes 全部改为纯面板（`props.open` 控制 + `emit('close')` 关闭，删除各自 fab 按钮）；互斥由 ToolDock 的 `activeTool` 单值天然保证，`close-fab-panel` 事件机制删除
- **ScheduleNotes 提升全局**：原仅 /schedule 页内挂载（ScheduleView 传入 schedules），现挂 ToolDock 内所有页面可用；「关联备赛」数据改由 ToolDock 自拉 `api.scheduleList()`；可拖拽手柄保留
- **轮询划分**：ToolDock 15s 常驻红点轮询 + 展开时刷新；MessageCenter 面板内打开时 3s 快轮询计数 + loadAll；未登录点消息工具提示登录
- **文件**：ToolDock.vue 新建；App.vue（挂 ToolDock 替换两个独立浮窗）；ScheduleView.vue（删页内挂载）

## 2026-09-03 报销整理（竞赛发票收集 /expense）

- **入口**：顶部导航「🧾 报销整理」/expense；本机/公网启动后负责人登录建「报销项目」（8 位邀请码），把带 `?code=xxx` 的链接发群，成员**免登录**点开即填
- **模式**：负责人按队伍预录名单 → 成员点自己姓名「认领」得本地 token（X-Claim-Token 头携带，**绝不进 URL**——access_log 记 originalUrl）；认领 token 仅存 localStorage（expense_claim_{code}），409 重名提示找负责人、403 认领失效自动清
- **费用类别（2026-09-03 下午起六类）**：①报名费 ②车票 ③住宿 ④邮寄费 ⑤耗材道具 + **⑥零散票据**（新；仅「全项目统一支付」区可录，队伍行 misc 400；=一张可能含多人/跨队成员的票据文件——票据名称 text≤60 / 金额选填 / 备注 / 涵盖的人勾选，附件槽 ticket「票据/凭证(图或PDF)」——票件原件 2026-09-04 起每行可多份，见「附件」bullet）；每类字段/附件槽位由 expenseMeta 双端镜像驱动（金额=JSON number、prop 是否日常家用=是→提示补项目使用图）；队伍卡类别块只循环前五类（teamCats 过滤）
- **起止日期（2026-09-03）**：车票 出发/到达日期、住宿 入住/退房日期 = FIELDS type:'date' → RowFormDialog 用 el-date-picker（type=date value-format/format YYYY-MM-DD，全量 ElementPlus+zh-cn 已含日历）；存 JSON 字符串、后端走 text 归一；键沿用旧"出发时间/到达时间"名 → 存量自由文本行在卡片/Excel 原样展示，编辑回填时非 YYYY-MM-DD 规整为空需重选（normDate）；表单空值用 null（save 转 ''），date 空 → 卡片 '—'；Excel 列自动为 label（出发日期/入住日期…）值原样落格
- **统一支付（2026-09-03）**：一人垫付多人/全队/整个项目的一笔费用。每类 FIELDS 尾部加 type:'multi' 键「统一支付范围」（双端白名单；普通行=空）；RowFormDialog create 可切「单人记录/统一支付」radio（edit 按行数据锁定），统一支付只渲染 金额/非帮付 yn/备注（payFields），下方三态范围（payMode）：**本队全部（存'全部成员'）/ 整个项目全部（存'全体成员'）/ 自定义勾选**——候选=payPool 全项目成员按队分组带队名（自绘 el-checkbox + hasName/toggleName 读写 payNames，规避多 checkbox-group 共绑一数组的丢选坑），跨队垫付由此表达；行归属=出钱人（member 强制本人）统计口径不变（行仍挂在进入/出钱人的队伍卡与明细 sheet），出钱人 pickList 排除"队伍"；存储三态值 ≤200；**服务端仅建行校验**：两关键词免校验，名单拆分后 ⊆ **全项目**名单（400「不是本项目名单成员（跨队也须先在各队名单预录）」——2026-09-03 下午放宽，此前只验本队），update 视为文本快照不追溯（成员改名/移出后旧名仍保留）；Excel 队明细仅在类别内存在统一行时带出「统一支付范围」列（metaCols filter multi），值原样落格（全体成员跨队行也落在所属队 sheet）；RowCard 行头黄 tag「统一支付」，title 释义 全部成员=本队/全体成员=整个项目（scopeTitle，数据原样不改）；范围回填 initForm：全体成员→proj、全部成员→team、其余→custom+split；smoke：全部成员/整个项目(全体成员)/跨队名单(赵大强、王小明→201)/非名单400/Excel 范围列三值 6 断言
- **全项目统一支付（2026-09-03 下午，项目级区块）**：整个项目统一缴纳、不属任何队伍的费用（全员报名费、全团住宿等）。**用户方向（重要）**：必须放在**所有队伍卡片之外**独立成块——team-card 弹窗里的"整个项目全部"范围档保留（用户确认），但项目级区块承担真正录入。模型=**项目级行**：expense_row.team_id 放开可空（NULL=项目级行）；SQLite 不能原地去 NOT NULL → database.js 幂等 `PRAGMA table_info` 检测 + 关 FK → BEGIN 建 v2 拷数据 → drop → rename → 重建索引 → 开 FK（新库 schema.sql 已含新定义，老库重启自动迁移，冒烟库实测）。权限：**仅负责人**可建/改/删/传附件（member 一律 403 即使行挂自己名下；guest 403）；出钱人须=全项目名单任意队伍成员**或**负责人 username/nickname 同名（`project_pay:true` POST 分支）。**范围放开（2026-09-03 下午，用户：仍可选择包含的人、不必一定全含）**：不再强制'全体成员'——create：'全体成员'关键词免验 / 顿号名单 ⊆ 全项目名单（跨队可）原样回显 / 空=留空可存（票据归档）；'全部成员'（本队语义）对项目行 400「项目级记录没有本队概念」；PUT=文本快照随客户端保存（子集原样、清空可存，不再强制改写）。级联：删成员按 owner_name 连项目行一起删（接受）、删队伍 WHERE team_id 不碰项目行、zip?team_id=0=项目级附件包（无附件 404「全项目统一支付暂无附件」）。**Excel**（lib/expenseExcel.js 重写）：汇总表队伍块之后、总计行之前插「全项目统一支付」块（入 blocks 共享个人合计/小计/总计公式循环；总计行文案=「总计（各队伍小计＋全项目统一支付小计）」）+ 独立「全项目统一支付」sheet（与队 sheet 共用 detailArrays，块小计/页底总计 =SUM）+ 附件清单以「全项目统一支付」作 team-label。**前端**：ExpenseView 身份条之后、队伍卡之前插「💰 全项目统一支付」独立卡（v-if isOwner||有项目行；＋添加统一支付/各类＋/📦 附件 ZIP(expenseZipUrl(code,0)) 均仅 owner；canEditRow 加 `row.team_id != null` 前置=项目行对 member 一律只读，防误点后吃 403）；RowFormDialog isProjPay（create teamId===0 哨兵 / edit row.team_id==null）：锁定 统一支付 模式；**涵盖的人三选**（范围不再固定整个项目）：整个项目全部=存'全体成员'（五类 create 默认）/ 自定义勾选=名单（跨队可；⑥零散票据 create 默认，payPool 复选框区）/ 暂不选=存空仅存档（edit 空范围回填 none）；出钱人 pickList=全项目成员带队名+负责人本人（edit 原值兜底），create 默认出钱人=负责人本人，save 走新增 api.expenseRowProjCreate（POST body 含 project_pay:true）
- **帮付三字段删除（2026-09-03 下午，用户：单人记录无需这些项）**：是否帮付 / 帮付人 / 车票是否已付款 从**全部场景**删除（双端 FIELDS 与常量 YN_SLAVE、后端 normData 软校验段一并移除；历史数据键仍留 DB 不展示，客户端携旧键提交被白名单丢弃）——帮谁付改由「统一支付范围」列表达（涵盖的人）；行归属=出钱人（垫付人）口径与金额统计（垫付合计记出钱人名下）保留
- **写入权限（服务端强制）**：member 只能建/改/删自己名下（owner_name 由服务端注入，伪冒无效）；prop 购买人必须=本人（「队伍」公用耗材行仅负责人可建）；跨队建行 403；closed 项目成员写 403 读/下载照常（owner 保留纠错通道）
- **附件**：单人行每槽单文件、重传=替换（先删旧盘）；**统一支付行每槽可多份**（2026-09-04，用户：统一支付支持上传多件所需附件）——判定=项目级行（team_id 空=全项目统一支付区/⑥零散票据）**或** 统一支付范围非空（一人垫付多人）；该行附件只增不替、同槽多份独立管理（份数不限、配额兜底）。实现：schema.sql 去掉 UNIQUE(row_id,slot) + database.js **v3 迁移**（老库 PRAGMA index_list 检测 attach autoindex origin='u' → 关 FK 重建拷数据，同 v2 手法；新库无 autoindex 跳过）；"替换"改由上传路由按行判定（multiOk 才跳过删旧，单人行照旧 404/替换语义不变）。uploads/expense/{code}/{rowId}/{slot}/ 落盘，DB 只存元数据；单文件 ≤25MB（multer 路由级 4 参错误 mw 覆盖全局 128MB 文案）、项目软配额 3GB（env EXPENSE_PROJECT_QUOTA）；下载白名单内联（pdf+image 按扩展名 remap mime，不信任客户端 mimetype），.html 等一律 attachment；删除（附件/行/成员/队伍/项目）均先清盘再级联 DB；zip/附件清单本就逐条列附件 → 多份自动跟随零改动
- **导出**：GET /o/:code/export/zip?team_id=（store-only 零依赖 zipStore，条目 `{catMeta(cat).folder 目录：01报名费…06零散票据}/{行id}-{槽}-{姓名}-{原名}`——2026-09-03 下午起目录改由 folder 驱动，勿再硬编码五分支，否则⑥行附件会掉进05耗材道具；team_id=0 项目级包见「全项目统一支付」bullet）；export/xlsx 传入 members，Sheet1 汇总=**队伍→成员两级**（表头 队伍|成员|①..⑥**六类金额列 C..H**|个人合计 **I**；成员行个人合计 =SUM(C:H 本行)、块小计列纵向 =SUM、小计行个人合计=SUM(C:H) 横向、总计列 =SUM(各块小计格)——列号/公式/merge 全部随 CATEGORIES.length 动态（勿硬编码）；⑥列对队伍块恒 0（队行不可能有⑥）；名单成员 0 记录也照列查漏；公用耗材行 owner='队伍' 单列"队伍（公用耗材）"不计成员；注脚=成员金额记出钱人名下 + 涵盖的人见明细「统一支付范围」列）+ 每队 sheet 全字段明细（类别行按名单顺序排序，公用行置末）+ 附件清单；文本 `=+-@` 开头加 `'` 防注入；sheet 名清洗去重）
- **导出断言坑（2026-09-03）**：SheetJS CE aoa 字符串单元格 XML 是 `<c t="str"><v>文本</v></c>`（非 inlineStr），断言写 `<v>文本</v>` 别写 `<t>`；公式仍 `<f>=SUM(C3:H3)</f>`（带 =、无缓存值；六列后首成员行个人合计在 **I3**）
- **表**：expense_project/team/member/row/attach（schema.sql 表 39~43；member UNIQUE(project_id,name)、attach 无 UNIQUE（v3 迁移已去约束：统一支付行同槽多份，见「附件」bullet）、全部 FK 级联）；expense_row.team_id 可空=NULL=全项目统一支付项目级行（v2 迁移在 database.js，schema.sql 注释见 expense_row 定义）
- **接口**：/api/expense/o/:code…（开放组：payload/claim/行 CRUD/附件/下载/zip/xlsx）→ 后注册 owner 组 /:id…（authRequired + 数值守卫：项目 CRUD/队伍/成员/重置认领/改名同步 owner_name+prop 购买人）
- **前端**：ExpenseView.vue（落地页+填报页双态、owner 管理条/成员 chips 重置认领、成员 chips 显示条数+该成员垫付合计 memberMoney、类别头**常驻「＋ 添加xxx」**按 c.key 直达类别——同类别可多条（多张车票各一行），入口条件抽 canAddIn(t) 复用队级按钮；openCreate(t.id, catKey)）+ expense/RowCard.vue（卡片+槽位附件 chips：图片 openImage/PDF 新开/其余下载；**统一支付行每槽可多份**：rowMulti=team_id 空或范围非空 → 逐份 chip + 常驻「＋槽位名」再传入口（空槽时即上传入口，title 提示"可存多份"），单人行保持原每槽一份展示）+ expense/RowFormDialog.vue（meta 生成表单、类别第一步选择（initialCat prop 预选则跳过）、锁定字段规则与后端一致）
- **冒烟**：scripts/smoke_expense.mjs **115 项断言全绿**（建项目→认领矩阵→越权矩阵→附件替换/内联/强附件→改名/重置认领→统一支付（范围三态/非名单400/Excel范围列四值）→全项目统一支付（team_id 空/**范围放开**：勾选子集原样+留空可存+本队'全部成员'400+PUT 不再强制回写/成员访客建改403/项目级附件+zip?team_id=0）→⑥零散票据（队行 400/票据名称+金额选填/空金额空范围纯存档/ticket 槽附件/zip 含06目录）→**统一支付行附件每槽多份（§11.8 放在 xlsx 断言后：⑥槽同槽两份独立下载+目录并存+删一份另一份不受影响；队内统一支付行发票槽连传三份全保留）**→xlsx（汇总六列 I3=SUM(C3:H3)/注脚新口径/项目级 sheet 范围子集+⑥块）→四级删除级联清盘（删王小明级联 8 行）→自清理）；坑：sqlite datetime() 参数必须单引号；multer 前置 gate 要 req.p/req.ctx 一并挂载；§11.8 别放在 xlsx 断言前（删掉 misc1 首份附件会让附件清单 sheet 失去 ⑥零散票据 行 → §12 includes 断言挂）
- **前端坑（必读）**：模板内联事件里顶层 ref 已自动解包 → 写 `load(code.value)` 等于 `'码'.value`=undefined → load 首行 `if (!c) return` 静默吞掉 → 上传/删除后页面永不刷新（无报错无 toast 异常）！表现为"上传成功（库里有）但 chip 不出现、还能继续传"。模板内联一律用 `code` 不带 .value；或把逻辑收进 `<script setup>` 命名函数（如 @changed/@claim-lost → onRowChanged/onClaimLost 再调 code.value）。2026-09-03 用 CDP 无头 Edge 实测复现并修复（ui 上传交互回归：真实 change 事件→上传 201→自动 load→chip 即时出现）

## 2026-09-04~09-05 报销整理演进（09-06 收紧的铺垫史，chronological per commit）

- **负责人可兼队员身份（09-04 08:10）**：is_owner 落地页/认领引导 —— owner 登录态即项目负责人，同时可认领队员名（成员身份与负责人身份并存）
- **报销单一身份 + 本队互编（09-04 08:36 cb965f9）**：一账户一项目只占一个名字（认领/改名唯一，消除一人多名的多重身份）；**成员可操作本队全部行**（本队互编/代录）——此为该日放宽点，09-06 已收紧废除（见下章）
- **成员可录自己名下项目级行 + 队伍横向标签条（09-04 10:50 f172a56）**：项目级行（team_id 空=全项目统一支付/⑥零散票据）放开给已认领成员 **仅自己名下**（出钱人服务端强制=本人：空默认自己、填他人 403 点名、prop 购买人须=自己；他人名下/访客/closed 后成员 403；owner 全权代录纠错不变）——项目级行从"仅负责人可建"（09-03 章）改为成员自理；自绘 chip 标签条（不用 el-tabs）：『💰 全项目统一支付』首标签 + 每队一个（队名+名单/已认领小字），≥2 显示标签条 / ==1 直排单卡 / ==0 引导卡，activeTab 钳制 watch 防单队断链；单队项目布局不变
- **标签条滚动修复 + 使用教程页（09-04 11:20 51c141a）**：webkit 滚动条曾被 display:none 隐藏致桌面端到不了溢出队伍 → 可见 6px 细条 + @wheel 横滚（溢出时滚轮/双指横滚、Shift 1.6 倍速，未溢出放行页面滚动）、chip flex:none+nowrap；落地页 hero「📖 使用教程」→ /expense/guide（ExpenseGuide.vue 静态页，CSS 变量双主题）：11 节（一分钟流程/三身份权限三色卡/负责人起步/队员认领占名换名重置/六类费用逐卡/单人 vs 统一支付对照/项目级区与标签/附件规则/统计与 Excel·ZIP 对照/截止锁账纠错/FAQ 12 条）+ 返回按钮
- **填报态返回按钮 + 最近进入记忆（09-04 13:12 9cbec40）**：code 视图头部「← 返回报销整理」（清 ?code 顺带清 errMsg）；404 空态命中最近记录时可「从最近进入中移除」；localStorage expense_recent ≤8 条 {code,name,ts} 成功打开才记、幂等置顶，落地页 enter 卡与登录区间卡片列出（项目名+邀请码，点进入 router 推 ?code 复用加载链路，逐条删+右上清空），整页刷新/换浏览器持久
- **soft 刷新滚动保持（09-05 3753f7a）**：load() 加 soft 模式——上传附件/编辑保存后 onRowChanged/onClaimLost 页内刷新不再整页 v-if 卸载（旧模板 loading=true 卸载换 spinner → 高度塌缩浏览器把滚动钳回顶部）；soft=内容保留挂载 + busy 半透明禁点 + 顶部浮动「🔄 更新中…」chip（.exp-wrap.busy::after），失败原地 ElMessage 不整页清空；全新进入/切换项目才整页 spinner（切 code 先清旧 pld 防串台），失败走整页错误页；回归修复「返回落地页后重进已删项目被旧内容顶包」——soft 与硬加载按调用源区分

## 2026-09-06 报销写入权限收紧（第三波，现行口径）：成员仅自理自己名下，他人已填一律不可删改

- **需求**：用户「报销整理页面：对于其他成员已填的费用信息，非负责人无法删改」→ AskUserQuestion 确认方案 A「全面自理」：成员**新增/改/删/传附件全部限自己名下**；同队队友行、公用「队伍」行、跨队行、他人名下项目级行一律仅负责人可动——**废除 09-04 本队互编/代录**（对称：无创建者追踪字段，放开创建=无法精确鉴权删除）
- **判定根基**：行归属=owner_name（出钱人），姓名项目内唯一（新增/改名 409）→ 比较精确无重名歧义；**队行与项目级行（team_id 空）同一套 rowWriteError 一视同仁**（项目级行 09-04 起本就限自己名下，本次把队行的"同队放行"也收成自己名下，两口径合一）
- **服务端（expense.js rowWriteError 重写）**：403 优先级：owner 放行 → guest「请先认领你的身份」 → closed「该项目已截止填报，如需修改请联系负责人」 → 非本人名下 `只能操作自己名下的记录 —— 他人已填的费用信息仅负责人可删改（代垫付/公用开销/纠错请联系负责人）`；四个调用点（PUT/DELETE 行、上传、删附件）零改动继承
- **POST team-row 成员分支**：填他人名 403 `队内记录只能记自己名下 —— 出钱人须是「{ctx.member.name}」本人；替队友垫付或公用开销请找负责人录入`；空名默认自己；prop `耗材道具的购买人须是你本人（公用物品请找负责人录入）`；「队伍」公用行仅 owner 可建
- **前端（ExpenseView.vue / RowFormDialog.vue / api.js / ExpenseGuide.vue）**：canEditRow 成员分支 `String(row.owner_name)===String(myName())`（移除同队比较，新增 myName computed；队行与项目级行共用同一判断）；RowFormDialog 成员态无出钱人下拉=固定姓名 + 「本人」tag + create「只能记自己名下（他人开销/公用请找负责人代录）」/ edit「归属不可改」；身份条/引导卡/toast/FAQ 文案同步（"代录"字样清除）
- **冒烟**：scripts/smoke_expense.mjs **160 项断言全绿**（沿革 115→156→160）：翻转 §7/§8/§12.6/§12.7a 为 403——成员建本队队友名行、改/删本队队友行、给队友行补传附件、改/删负责人名下同队个人行、删队友名下 prop 行、代录本队队友建行；§14 行数不变（owner 事后删除自己的行净零）；前端 build 通过
- **注意**：上一会话（09-05）工作区遗留未提交变更（backend/routes/planChat.js、schedule.js、study.js + frontend CompDialog/ScheduleView/ToolDock + scripts/smoke_privacy.mjs）——与报销无关，勿混入本批提交

## 2026-09-10 资源分享页重构：GitHub 仓库页形态（取代 08-25 贴吧式）

> ⚠️ 本节的**「点行→下方展开 README」与 `?post=` 选中链路已被同日第二轮重构取代**（详情改独立子路由 `/share/:id`、`?post=` 降级为兼容层），现行口径见文末「2026-09-10 资源分享：项目文件夹 + Gitee 仓库树 + 详情子路由」。仓库页形态、表/接口/权限、主题变量、工具函数仍以本节为准。

- **需求**：用户「把资源分享页做成类似 GitHub 页面」→ 先调研现成方案（结论：**没有能直接用的**——文件管理器组件库是网盘外观且要接 driver 协议捆 Uppy/CodeMirror；GitHub 克隆项目全是 React 只能当参考；真正可复用的只有 github-markdown-css / @primer/octicons 两个零件。**GitHub 仓库页本质是三块布局 + 一套灰阶，不是组件**，手写反而白吃本项目已有的 CSS 变量双主题）→ 用户确认五项：整页重排成仓库页 / 一条帖子=一行文件 / 零新增依赖手写 / tabs=资源·我的帖子·我的收藏 / 配色跟随 var(--primary)
- **形态**：面包屑仓库头（owner/板块名 + 公开·仅怪奇可见 pill + 描述 + 4 个统计徽标 + 开楼按钮）→ 标签页条（tabs 左、排序 el-dropdown 右，压在底边线上）→ 两栏主体 `minmax(0,1fr) 288px`（左＝筛选框+文件表+分页+README 框；右＝About+Topics）。**详情弹窗整体删除**（`detailDlg` → `selId`/`cur`），点行改为在下方 README 框展开正文/附件/讨论，README 里的评论按 GitHub issue 风排版（左头像 + 右「昵称 commented 相对时间」头栏）
- **后端（`routes/share.js`，四处改动全是增量）**：把原来硬编码别名 `p.` 的 `ghostCond` 抽成 `ghostClause(req, scope, ghostOnly, alias = 'p')`（聚合查询要用 `sp`，复用不了原实现）；列表处理器在 rows 之后追加一条四张表聚合 SQL，随响应新增**顶层 `stats`** `{posts,likes,favs,comments}`。**口径**：stats 跟随幽灵身份（普通用户不计幽灵帖、幽灵页只算幽灵帖），但**不跟随 scope/tag**——徽标表示「这个板块有多大」，不该因切到「我的收藏」而缩水。查询参数（sort/tag/page/size/scope/ghost）一个没动，`stats` 是纯增量 → ghost/friends/notifications 三个冒烟零改动通过
- **主题变量（`styles/main.scss`，新增 4 个）**：`:root` 与 `html.ghost-mode` **两处都必须声明**——`html.ghost-mode` 只覆盖 `:root` 里已有的同名变量，组件里写死 hex 会在暗色下出白块。取值从本项目自己的 slate 色阶往两端推，**不抄 GitHub 的 hex**（GitHub 的 `#d0d7de`/`#161b22` 偏蓝，与本项目冷灰蓝、幽灵主题中性紫调都不是一路）：`--surface-1`（表头底/行悬停）、`--border-2`（比 `--border` 深/亮一档 → 文件框外框）、`--text-3`（三级文字）、`--font-mono`（README 正文 pre 用）
- **工具函数**：`utils/time.js` 新增 `fmtRelative`（刚刚/N 分钟前/N 小时前/N 天前/N 个月前，超一年回落 `fmtDateOnly`）——**必须经 `toLocal()`**，后端存的是无时区标记的 UTC 串，裸 `new Date('2026-09-10 08:00:00')` 会被浏览器当本地时间差 8 小时；`utils/share.js` 新增 `postKind(p)`（image/video/audio/link/archive/file，看首个附件的 mime > 引用型 url > 扩展名兜底）+ `KIND_ICON` 映射
- **新组件 `components/share/`**：`GhIcon.vue`（内联 Octicons 19.11.0，21 个图标以字符串字面量存 `<script setup>`，`fill="currentColor"` → 颜色由父级 CSS 决定，双主题自动跟随；**Octicons 没有 audio/music，实测 404**——音频键映射到 `unmute` 喇叭图标）；`ShareFileTable.vue`（表头 名称/作者/互动/更新时间，行图标随 `postKind` 变，≤768px 用 `display:none` 藏作者与互动列）；`ShareReadme.vue`（三态：加载/错误就地渲染/内容；错误态不弹 toast 不整页清空，深链指向已删帖时用得上）
- **选中链路（`ShareView.vue`）**：`?post=ID` 是选中态的持久化载体，`selId`/`cur` 为唯一来源；**`watch(() => route.query.post, …, { immediate: true })`** 统一深链/站内二次跳转/前进后退（旧 `deepLink()` 只在 `onMounted` 读一次 → 第二次点行不生效，本次顺手修掉）；点行时若目标 URL 与当前完全相同，vue-router 会去重、watch 不触发 → 必须**先本地 `selectPost(id)` 再 replace**（`pickRow`，否则表现为「点了没反应」）；选中帖一律按 id 直拉详情（`api.sharePost`），**不能改成从列表行取**——帖子可能不在当前页/当前 tab 里，且评论只有详情接口返回。**（同日第二轮已废：`selId`/`cur`/`selectPost` 全删，选中态改由 `/share/:id` 的路径参数承载，见文末新节）**
- **两个数据持有者**：`rows`（列表）与 `cur`（README）是同一份数据的两个副本，任何计数/标志变更**必须经 `applyActs(id, patch)` 同时写**，否则列表行与 README 的数字会对不上（点赞是典型）——`normAtts` 对数组入参返回**同一引用**，详情对象是「活」的，同步才有意义
- **`openEdit` 必须浅拷贝附件**：`.map(a => ({...a}))`——`normAtts` 对数组入参返回同一引用，直接赋值会让编辑器的附件数组与 README/列表里那份是同一个，删个 chip 就当场改掉了背后的帖子，取消也回滚不了
- **幽灵页 `/ghost-share` 只留一个静态标签**：`scope` 非空会绕过幽灵隔离（后端有意为之：查看自己数据时全量），摆到秘密分享页上会混进普通帖 → 幽灵页不渲染「我的帖子/我的收藏」两个 tab，tabs 条渲染成单静态标签；发帖恒为幽灵帖
- **探针 `scripts/probe_share.mjs`（46 项，`npm run probe:share`；同日第二轮扩到 56 项）**：DOM 级守护重做后的核心链路——徽标=API `stats`、行数=min(total,每页10)、行图标随附件类型变、点行→README 出标题正文、点赞三处同步（README 按钮/表格行=帖子级 like_count，头部徽标=全站 stats.likes，**两者口径不同不能混用同一基准数**）、发评论、我的收藏 tab 只剩收藏帖、深链 `?post=ID` 直达（现改为断言它 302 式改写成 `/share/:id`）、深链指向不存在帖就地报错、连续点两行、标签过滤、幽灵页单标签+反向过滤+暗色类、375px 折叠、普通用户看不到幽灵帖。`PROBE_API`/`PROBE_WEB` 可覆盖（对着临时实例跑不必动用户的 :3000）；截图落 `os.tmpdir()`（不进仓库、不脏 git status）
- **坑（本次踩到）**：
  - **后端进程不热重载**——改了 `routes/*.js` 必须重启 `:3000`，否则探针/冒烟测的是**旧代码**。症状：`stats` 全 `undefined`、徽标恒 0、而 API 直连另一端口一切正常。改后端后先重启再跑测试
  - **`fullPage: true` 截图前必须等页面重排结束**（`waitForTimeout(800)`）：文档高度在拼接过程中变化会拼出**白色空带**，看着像暗色主题漏白块，实为截图假告警（本次据此误判过一次，用 `getComputedStyle` 实测各层背景色才排除）
  - **断言「列被藏掉」要看可见性，不能数节点**：窄屏是 `display:none`，DOM 里 4 列仍在 → `locator.count()` 恒为 4
  - 幽灵页 Topics 侧的标签计数**不做幽灵过滤**（`shareTags` 既有行为，混合计数），本次未改
- **验证**：`probe_share.mjs` **46/46**；回归 `smoke_ghost` 30/30、`smoke_friends` 25/25、`smoke_notifications` 10/10、`smoke_privacy` 36/36、`smoke_expense` 170/170（1 跳过=上游限流）；前端 build 通过；浅色+暗色(`html.ghost-mode`)+375px 三张截图人工过目

## 2026-09-10 资源分享：项目文件夹 + Gitee 仓库树 + 详情子路由（现行口径，取代同节上一条的「点行展开 README」）

- **需求**：用户三件事——①上传一整个文件夹并能看内部结构 ②把 Gitee 仓库的文件树拉进来展示 ③点一行跳独立详情页（不再在列表下方展开）。产品口径四选一确认：**一条帖子 = 一个项目 / 文件落盘、单帖上限 200MB / Gitee 拉文件树页内渲染 / 文件能在线预览**
- **详情子路由（阶段一）**：新增 `/share/:id` 与 `/ghost-share/:id`（`SharePostView.vue`，照 `ProfileView` 的「computed 取参 + watch + onMounted」范式；**函数式 `props: () => ({ghost:true})` 是全站首例**——对象式 props 读不到 route.params）。`?post=ID` **降级为兼容层**：列表页 `watch(route.query.post, …, {immediate:true})` 直接 `router.replace` 成子路由，不在这里拉详情（详情页有自己的加载链路，重定向过去是唯一入口）；MyView/MessageCenter 已改为直接 push 新形状
- **滚动行为必须自己记**（`router.js`）：**不能吃 vue-router 交来的 `saved`**——4.6.4 的 `saved` 就是 history entry 的 `state.scroll`，pop 时实测是 `{left:0,top:0}` 这类残值（entry 建好时页面还在顶上），采信它等于亲手把用户弹回顶部，比不写 `scrollBehavior` 还糟。现改为：`beforeEach` 里把 `from.fullPath → window.scrollY` 记进有界 Map（100 条），用 `history.state.position` 判方向，**后退才还原**。另：`to.path === from.path` 一律 `return false`——保护 `/schedule?tab=`、`/team?team=`、`/expense?code=`、`/share?post=` 这些同页 query 导航不被弹回顶部
- **列表状态缓存搬进真模块**：`utils/shareKeep.js`（`shareKeep(ghost)`）。写在 `ShareView.vue` 顶层是 **per-instance** 的（`<script setup>` 顶层代码编译进 `setup()`，见「script-setup 无模块作用域」），后退回列表时 rows 为空 → 文档高度塌陷 → 滚动还原被钳回顶部
- **阶段二 数据模型**：新表 `share_file`（schema.sql **表29**，非唯一索引与 `idx_share_post_user` 同处即可——「索引必须在迁移链之后」那条坑只针对给老表加列的索引）；`share_post` 走 `migCol` 加 `gitee_repo`/`gitee_ref`。**树用扁平 `path` 存、前端按前缀推导目录，不存空目录行**（`webkitdirectory` 本就产不出空目录，如实接受）。磁盘名一律 `{ts}_{12hex}{ext}`，`path` 只进 DB 与 ZIP 条目名 → 穿越风险被 basename 二次兜住，但 `sanitizeRelPath` 仍拒 `..`/反斜杠/前导斜杠/NUL/超长段
- **`lib/shareFiles.js`**（纯 fs/db，不 import routes）两个清盘入口别用混：**`purgePostFiles(postId)` = 删帖时全清（含 Gitee 行）**——`share_file` 行会随外键级联消失但磁盘文件不会，`routes/admin.js` 的 `DELETE /posts/:id` 必须显式先调它；**`purgeUploads(postId)` = 改上传树时只清 `source != 'gitee'`**，让「上传文件夹」与「Gitee 仓库」各管各的。另有 `sweepStaging(hours=24)`（清超期未绑定的暂存行 + 文件，`server.js` 启动调一次）与 `usedOf(userId, stagedOnly)`（配额计量）
- **阶段三 预览**：文本走 `api.shareFileText(fid)` → `<pre>{{ text }}</pre>`，**Vue 插值天然转义，绝不用 `v-html`**（本页最大的 XSS 面，探针里有 `<script>alert(1)</script>` 必须当文本显示的断言）；图片/PDF/音视频一律 **blob objectURL**，**不用 `?token=` 直链**——会话 token 进 URL 会被记进 `access_log.originalUrl`。`/files/:fid` 必须 **join `share_post` 走 `ghostVisible()`**，否则幽灵帖的附件能被匿名直取（探针断言普通用户/匿名取幽灵帖文件都 404）。ZIP 条目名用完整 `path`（不是 basename）才保留目录结构
- **阶段四 Gitee（`lib/gitee.js`）**：三个要点——①**SSRF 闸门**：只接受 `owner`/`repo`/`ref` 三段，正则校验后 `encodeURIComponent` 拼进固定 gitee.com 路径，**永不接受客户端给的完整 URL**（`lib/vision.js` 同款风格，env 键**惰性读**：ESM 静态 import 早于 `process.loadEnvFile`）②**10 分钟内存缓存**（`Map`，键 `owner/repo@ref`，上限 50）——匿名配额只有 ~60 次/小时/IP，缓存 + 只在「预览/保存/同步」时拉，把浏览流量完全挡在 Gitee 之外 ③**保存时服务端自己重拉一遍**（走缓存），**绝不采信客户端传来的树数据**——否则任何人可伪造任意路径入库。大仓库只收前 `GITEE_MAX_FILES`（500）条并在响应里带 `truncated`，不静默截断
- **`gitee_repo` 是三态字段**（与 `files` 同一口径）：`undefined` = 不动（老客户端/只改标题不能把仓库连文件一起抹掉）/ `''` = 解绑（清字段 + 删本帖 `source='gitee'` 行）/ 值 = 重拉整树替换。**拉取失败不推翻这次保存**：正文已经写进去了，带 `gitee_error`/`gitee_hint` 回去让前端提示，用户可在详情页点「↻ 同步仓库」重试（限流/断网这类瞬时故障不该让人重打一遍正文）
- **Gitee 条目与上传文件正交**：`share_file.source` 区分 `'upload'`/`'gitee'`，上传树整组替换不会抹掉仓库绑定，反之亦然。ZIP 只打磁盘文件（Gitee 条目走仓库代理、不进包）；`/files/:fid/raw` 与 `/files/:fid/text` 按 `source` 分支，前者把 `gitee.com/{o}/{r}/raw/{ref}/{path}` 流式代理回来（不设上限；文本预览仍 512KB 截断）。两者共用 `readableFile()`：**`post_id` 为空（暂存态）只有本人能取**，否则走 `ghostVisible()`，不可见一律 404 不泄露存在性
- **探针用 `GITEE_BASE_URL`/`GITEE_RAW_BASE` 指向本地假 Gitee**（`scripts/lib/fakeGitee.mjs`，离线确定性，`missing`→404 / `flood`→403 / `big`→truncated 三档错误映射）。`/api/health` 加 `gitee: !!GITEE_ACCESS_TOKEN` 布尔（可选增强而非功能开关——公开仓库不配 token 也能拉）
- **坑（本轮踩到）**：
  - **PUT 不带 `tags` 一律 400**（既有 bug，本次才暴露）：`normTags` 的 `null` 同时被当成「缺省」与「非法」，缺省必须用 `undefined` 单独区分。发现方式是 Gitee 测试里做了一次「只改标题」的 PUT。**三态字段（undefined/''/值）是本模块的通用口径，别再用 null 兼职表示缺省**
  - **假 Gitee 的仓库名每轮必须换**（`demo${stamp}`）：固定仓库名会让第二次跑探针吃上后端 10 分钟缓存，测不到「真的去拉了」，还会把缓存断言测成假绿；同时补一条**「同一仓库重复拉不再打 Gitee」**的真断言
  - **断言 toast 要按文案等**（`.el-message` + `hasText:'已同步'`）：直接读 `.el-message` 会抢到上一条还没消失的「🚀 开楼成功」
  - 弹窗里的文件清单**默认收起**，探针要先点 `.fol-sum` 展开再断言行数
- **探针**：`probe:share` 46→**56**（新增子路由/滚动还原/幽灵详情页暗色）；**新增 `probe:share-folder` 39 项**（树层次/缩进分档/展开收起/文本与图片预览/XSS/恶意 `../` 被拒/幽灵文件 404/ZIP 结构/暗色面板不发白/375px 不横向溢出）；**新增 `probe:share-gitee` 34 项**（假 Gitee 全程离线：路径集合逐一相等、SSRF、错误映射、缓存命中、代理预览、blob 图片、浏览器零直连 gitee.com、三态字段、非作者同步 403）
- **验证**：`probe_share` 56/56、`probe_share_folder` 39/39、`probe_share_gitee` 34/34（连跑两次证明幂等）；回归 `smoke_ghost` 30/30、`smoke_friends` 25/25、`smoke_notifications` 10/10、`smoke_privacy` 36/36、`smoke_expense` 170/170（1 跳过=上游限流）、`probe_claimlost` 15/15；前端 build 通过；浅色 + 幽灵暗色 + 375px 截图人工过目（新面板无白块、无横向溢出）

## 2026-09-10 荣誉墙 /honor：奖状多行反向跑马灯（公开免登录，后台维护）

- **需求**：用户「再做一个荣誉墙页，让各种奖状图片不断滚动」。产品口径五项确认：**管理员后台维护**（普通用户只读）/ 一条 = **图片 + 奖项信息**（不是纯图瀑布流）/ **多行反向**跑马灯 / **公开免登录** / **逐个录入 + 批量多选**
- **「公开免登录」是贯穿全局的那条口径**，不是一句 UI 文案：它决定了图片能走普通 `<img src>`、能吃浏览器缓存、**天然绕开「session token 绝不进 URL」的全站硬规矩**（token 进 URL 会落进 `access_log.originalUrl`）。若将来要改成登录可见，唯一要动的是 `routes/honor.js` 里那一行 `if (!h.is_active && !req.user?.is_admin) return 404`（注释已就地写明），前端需同步改成 blob 取图
- **数据模型（schema.sql 表44 `honor`）**：`store_name`（磁盘 basename）/ `image_name`（原始文件名）**任何接口都不返回**；`admin_id` **故意不加外键**（同 `announcement.admin_id`：挂 ON DELETE CASCADE 的话删个测试账号就把荣誉墙清空）；`image_*` 可空 → **允许纯文字荣誉**（口头表彰/图还没拍），卡片渲染 🏅 占位符；列表口径 `sort_order DESC, id DESC`（大的在前），新建缺省 `maxSort()+10`（排最前），批量按选中顺序 +10 递增
- **`image_ver` 是缓存键，不能用 `update_time` 兼职**：`CURRENT_TIMESTAMP` 只有**秒级**精度，同一秒内连换两次会算出同一个版本号 → 浏览器一直吃旧图。改为每次写图 `randomBytes(4).toString('hex')` 重新随机，列表拼成 `/api/honor/{id}/image?v={ver}`，出图侧配 `res.sendFile(abs, { maxAge:'365d', immutable:true })`
- **`lib/honorFiles.js` 把「删盘 + 改库」封成函数**（`setImageOf`/`clearImageOf`/`purgeHonor`）——磁盘文件不随 DB 级联消失，三个清盘点散在路由里迟早漏一个 → 永久占盘（`shareFiles.js` 同教训）。替换图是**先写库成功再 unlink 旧文件**，顺序反了会在更新失败时同时丢掉旧图。另：`HONOR_DIR` **启动即 `mkdirSync`**——`uploads/` 被 gitignore，生产首次部署目录不存在，不建则第一张图 ENOENT
- **图片类型校验的权威是文件头魔数**（`sniffImage`，只读前 16 字节，别 readFileSync 整个 8MB）：`file.mimetype` 是客户端自己写的、扩展名可以随便改。**SVG 是 XML 文本、没有魔数，天然死在这一关**——它能在本站源下执行脚本，是全站硬拒的一类。`isInlineOk` 是第二道闸门（将来有人放宽 `ALLOW_MIME` 时它还在）。出图用嗅探时定下的 mime `res.type(...)`，不按扩展名猜
- **元数据走 JSON、图片走独立 multipart 端点（`POST`/`DELETE /:id/image`），绝不混在一个请求里**：① multipart 里字段全是字符串（`'true'` → `Number('true')` = NaN）；②「没选文件」与「传了个空的」长得一模一样，拿 `''` 兼职表示"删图"必然歧义；③ 混装会让"图传上去了但标题校验失败"变成说不清的中间态。拆开后图片三态就是三个动作：**不动 = 不调 image 端点 / 删除 = DELETE / 新增替换 = POST**
- **`is_active`/`sort_order` 必须显式判 `!== undefined`**（写成 `b.is_active || h.is_active` 会让「下架」永远失败，`0` 是 falsy）——与 `share.js` 的 `tags`/`gitee_repo` 是同一类「一个值兼职表示缺省与非法」的病
- **批量上传是全批校验后再落库**（有任何一个非图片就整体 400 + 清盘），不留「传 10 张成功 7 张」的半成功态；标题取文件名去扩展名（截 60），排序按选中顺序递增
- **上传错误要在路由级兜**：全局 handler（`server.js`）把 `LIMIT_FILE_SIZE` 硬编码成「单文件 ≤128MB」，那是资源分享的额度，对 8MB 的奖状图是错的提示 → `uploadErr` 本地转成「图片过大（单张 ≤8MB）」。`limits` 用 `MAX_IMAGE + 1`（busboy 在**等值**处就触发）
- **前端 `utils/imageCompress.js`**（普通 .js 模块，不是 `<script setup>` 顶层——那没有模块作用域，且后台多个上传点要复用）：`createImageBitmap(file, { imageOrientation:'from-image' })` 解码（按 EXIF 摆正，手机竖拍不躺倒，**顺带剥掉含 GPS 的 EXIF**）→ 长边 ≤1600 → `toBlob('image/jpeg', 0.85)`。**GIF 不压**（压了丢动画）、失败一律回落原图不阻断上传（HEIC 这类浏览器解不了的交给服务端魔数去拒）。后端无任何图像处理库（依赖只有 cors/express/mammoth/multer/pdf-parse/xlsx），**这是唯一一道缩图防线，不是优化**
- **跑马灯的无缝数学（`HonorView.vue`，本功能最大风险点）**：轨道**恰好两份等宽副本**，`@keyframes` 从 0 位移到 -50%。两条必须守住的线——
  - **★ 卡片间距做在每张卡的 `margin-right`，绝不能用容器的 flex `gap`**：gap 只在相邻项之间插入、**不在两份副本的接缝处出现**，轨道宽会变成 `2kh·W + G` 而不是 `2kh·W`，`-50%` 就差了半个间距 → **每滚一圈画面横跳一下**（典型症状：看着在动，其实是坏的）。用 `margin-right` 后半份宽精确等于 `n·(w+gap)`
  - **★ 半份必须铺满视口**，否则滚到接缝处露出一段空白。重复次数由**实测视口宽**算（`ResizeObserver` 观察行容器，不要用 `innerWidth` 减 padding 去猜）：`k = max(1, ceil((vw + W) / (b·W)))`
  - 各行用**恒定像素速度**（`dur = halfW / speed`，各行 ±10% 微扰），**不能给所有行同一个 duration**——条目多的行会明显跑得更快、像在互相追
  - 反向 = 第二条 `@keyframes`（`honor-ltr` 从 -50% 回到 0）；`hover` 与 `:focus-within` 都暂停（卡片是按钮，Tab 过去时不停根本点不到）；两份副本同 `src`（浏览器按 URL 去重，只 1 次请求），故**不加 `loading="lazy"`**（跑马灯里图始终在视口带内，lazy 只会在边缘闪白）；`:key` 必须带副本序号，只用 `h.id` 会撞 key
  - **`prefers-reduced-motion: reduce` 必须降级**：JS `matchMedia` 判定 → **只渲染单份 + 无动画 + 行改 `overflow-x:auto` 可手动横滚**，内容一张不少（**内容不可达才是最坏的降级**）
  - 卡片高固定为 `min-height: calc(var(--bh) + 101px)`：不固定的话同一行内被 flex 拉伸看不出来，但**行与行**会参差（某行恰好有条两行标题，整行比邻行高一截，一面墙的基线全散）
- **探针 `scripts/probe_honor.mjs` 81 项（`npm run probe:honor`）**：自带零依赖 PNG 编码器（每张卡一张颜色不同的真图）+ 一段真 JPEG；断言分五段——① 后端契约 31 项（前台匿名 200；后台写接口匿名 401、普通用户 403、中文文件名、图片字节与原文件逐一相等、`immutable` + 长 `max-age`、路径穿越、**SVG 改名 .jpg → 400**、文本改名 .png → 400、>8MB → 413 且不留残文件、失败替换不毁旧图、下架对匿名 404 对管理员 200）② 页面与跑马灯 29 项 ③ 客户端压缩 ④ 后台 tab ⑤ 清理
  - **判别力是验证过的**：往 `.track` 里**加回 `gap:16px`**（保留 `margin-right`，即最像"好心写错"的那种形状）→ 81 项掉到 **77**（②⑪ 轨道宽 ≠ 2×半份宽、②⑫、②⑭ 位移比半份宽少 7.8px、②⑮ 空隙带宽 16~32px 不齐），撤掉mutant 后 81/81 → **那四条断言真的在守着接缝**
  - ②⑭ 的写法是「把动画推到 0.9999 个周期，量 `translateX` 是否恰好等于 `.half` 的宽」——**不要用"相位 0 与相位 0.5 画面相同"**（那种写法只在 `k·n` 为偶数时成立，会假红）
  - **不要用 WAAPI `pause()`/`play()` 去控自己正在测 CSS hover 暂停的那一行**：`pause()` 会让该 CSSAnimation 与 CSS `animation-play-state` 脱钩（computed style 报 `paused` 而元素继续动）。命令式操作只碰第 1 行，hover/点击在第 2、3 行上验
  - **点卡片要先让它进视口**：跑马灯会把首张卡平移出屏（`element is outside of the viewport` 超时），正确姿势是先 hover 某行（CSS 暂停）再算一个在视口内的下标
  - 探针截图里就 **`.iv-overlay`**（`ImageViewer.vue` 的类名）；断言"查看器打开了"要 `locator.waitFor({state:'visible'})`——Vue DOM 更新是异步的，`click()` 后立刻 `isVisible()` 是竞态
- **坑（本轮踩到）**：
  - **`probe:share-gitee` 必须对着「带假 Gitee 环境变量启动的后端」跑**：`GITEE_BASE_URL=http://127.0.0.1:3199/api/v5 GITEE_RAW_BASE=http://127.0.0.1:3199`。忘了就会打真 gitee.com → 第 2 项就 `502 仓库或分支不存在`，**看着像回归、其实是测试台架搭错**。`/api/health` 的 `gitee` 布尔是 **`GITEE_ACCESS_TOKEN` 是否存在**（配额高低），与假 Gitee 无关，别拿它判断台架对不对
  - `smoke_expense` 那批冒烟同样认 `PROBE_API`，对隔离栈跑时 `PROBE_DB` 必须一起给（`openProbeDb` 的强制闸门）
- **验证**：`probe_honor` **81/81**；回归 `probe_share` 56/56、`probe_share_folder` 39/39、`probe_share_gitee` 34/34（这三条必跑——`App.vue`/`main.scss` 是被共享的文件）、`smoke_ghost` 30/30、`smoke_friends` 25/25、`smoke_notifications` 10/10、`smoke_privacy` 36/36；前端 build 通过；浅色 + `html.ghost-mode` 暗色 + 375px 三张截图人工过目（暗色无白块、375px 无横向溢出、两行仍在跑）
- **上线注意**：`uploads/` 被 gitignore 且 `deploy.sh` 只备份 `compass.db` → **线上图片要管理员在服务器后台重传一次**（不随 git 走）

## 2026-09-26 荣誉墙呈现升级：盛典 Hero + 双视图（流动展厅 / 荣誉殿堂）+ 金银铜分级

- **需求**：用户「荣誉墙页呈现方式更加丰富和具有设计感」。在**不动 81 项探针口径、不改后端/数据模型**的前提下做纯前端增强（`HonorView.vue` 单文件）
- **三块新内容**：
  - **盛典 Hero**：深色底（浅主题海军蓝、幽灵模式近黑红）+ 网格纹 + 金色奖杯奖牌（SVG，conic-gradient 金圈 + 旋转光环）+ 闪烁星芒 + 金色渐变标题 + 玻璃质感统计块（荣誉总数 / 国家级·国际级 / 获奖年份，年份从 `award_date` 前 4 位去重统计）。背景/星芒/光环全部 `aria-hidden` 且 `prefers-reduced-motion` 下停掉
  - **双视图切换**（分段控件，偏好存 `localStorage.honor_mode`，但**默认永远是 flow**——探针不切视图）：①「流动展厅」= 原有多行反向跑马灯；②「荣誉殿堂」= 证书**网格**（`auto-fill minmax(236px,1fr)`），图更大（168px）、带 `description`、底部日期+获奖者
  - **荣誉分级 t-gold/silver/bronze**：按授予范围正则匹配（`国际|国家|全国|世界…` = 金，`省|部|大区|赛区|华东…` = 银，`市|校|院…` = 铜）。原始 `award_level` 文案照常全显，分级只决定**顶边色条 `.haccent` + 等级胶囊 `.htier` + 奖牌点 `.tdot` + hover 阴影/描边**的配色
- **★ 装饰绝不能碰跑马灯宽度等式**：`.haccent/.tdot` 一律 `position:absolute`（不进 flex 流、不改卡片外宽）；网格用**独立类名** `.hall-grid/.gcard/.gpic`，与 `.marquee/.hcard/.hpic` 完全分开，v-if 切换、跑马灯卸载时 `.marquee/.hcard` 整体不在场 → 81 项里所有 marquee 选择器断言不受影响。跑马灯卡 `min-height` 因多了一行等级胶囊从 `+101px` 调到 `+126px`（最坏情况重算：图盒 + padding + 4×gap + 标题2行 + 胶囊 + 日期 + 获奖者）
- **★★ 本轮最大坑：scoped 块里 `:global(html.ghost-mode) { .hero {…} }` 会被 Sass 吞掉后代选择器** —— 编译产物变成裸 `html.ghost-mode { --hero-a… }`，自定义属性落在 `<html>` 上，而 `.hero` 自身在类选择器（特异性 0-1-0）上也声明了同名变量 → 就近且更特异，`<html>` 上的覆盖**永远赢不了**。症状：幽灵模式 Hero 中央始终泛海军蓝。**修法：另起一个非 scoped 的 `<style lang="scss">` 块**，写完整选择器 `html.ghost-mode .honor-page .hero { … }`（特异性 0-2-1，稳赢；`.honor-page` 前缀收窄不外泄）。判别手段：`document.elementsFromPoint` + `getComputedStyle` 读 `--hero-*` 实际值，别只看截图猜
- **验证**：`probe_honor` **81/81**（重构样式块前后各跑一次）；`vite build` 通过；另写一次性脚本种 9 条金/银/铜真实感数据，对 流动/殿堂 × 浅色/暗色 四态截图人工过目（分级配色分明、暗色 Hero 红黑无蓝、375px 无溢出）。临时诊断脚本与截图、临时后端/库、临时端口 3106/5198 均已清理

## 2026-09-27 荣誉墙新增「精选」Apple 极简编辑流并设为默认（三视图：精选/流动/殿堂）

- **需求**：用户「能不能参考其他网页设计」→「我来搜索优秀案例」（环境拦了 WebSearch/Awwwards/Dribbble，靠我熟悉的流派给方向）→ 用户挑 **极简编辑风（Apple）**，参考 Apple 产品页 / Linear / Stripe。打断过一次（「先暂停」），09-27 继续
- **★ 口径变化：默认着陆视图从跑马灯改成「精选」编辑流**（`mode` 默认 `editorial`，09-26 那条「默认永远是 flow」作废）。现在共三视图：`editorial`（精选）/ `flow`（流动跑马灯）/ `hall`（殿堂网格），靠底部**固定悬浮玻璃 dock**（`.mode-dock`，z-index:1000；查看器 z-index:3000 在它之上，Esc/点击不冲突）切换，偏好仍存 `localStorage.honor_mode`
- **精选流的 Apple 语法**：① Hero 占近一屏（`min-height: calc(100vh - 120px)`），居中 eyebrow「HALL OF HONOR」+ `clamp(52px,9vw,96px)` 大标题 + 一行统计 + 滚动提示（纵向滑线）；② **一屏一项** `.ecard`：mono 序号 `01` + `·` + 等级 kicker（顶部）→ 超大标题（`clamp(26px,3.4vw,40px)`，首项 feature 更大）→ 软阴影卡纸相框 `.e-pic`（大圆角22 + 柔和环境阴影，像 Apple 产品图；hover 上浮）→「点击图片查看大图」→ 日期·获奖者 → 描述；③ 结尾「已展示全部 N 项荣誉」
- **滚动渐显的内容安全口径（★★）**：**默认全可见**，只有在 JS 确认 `IntersectionObserver` 可用且未降级时才给容器加 `.js-reveal`（此时未进视口的 .ecard 才隐藏）。脚本不跑/被拦/开了「减弱动态」→ 内容照样全显（**最坏的降级是内容不可达**，同跑马灯那条）。进视口加 `.in` 并 `unobserve`；同级内 kicker→标题→图→提示→meta→desc 微错峰（.07/.14/.2/.24/.3 delay）
- **★ dock 只在有数据时渲染**（在 `v-else` 的 `<template>` 内），空态/加载/出错时不出现；滚动提示 `.e-cue` 因与 dock 相挤从 `bottom:18` 上移到 `bottom:84`（在 dock 上方）
- **探针同步（`probe_honor.mjs`，81→84）**：主页面先断言 3 条精选口径（②⓪ `.ecard` 数=nPub / ②⓪② 图解码 / ②⓪③ dock 默认高亮「精选」），再 **click「流动」waitFor .marquee visible** 才跑原来整套跑马灯断言；窄屏(②㉒前)、降级(②㉕前)两处同样先切 flow。新增3条+原81=**84/84**；判别力靠那3条守着「默认是 editorial」
- **验证**：`probe_honor` **84/84**；`vite build` 通过；9 条金/银/铜真实感数据对 桌面浅色/暗色/375px 截图人工过目（大留白居中、软阴影相框、近黑暗色红按钮、375px dock 不溢出）；临时脚本/截图/端口3106·5198/临时库均已清理

## 2026-10-14 🛒 物料采购模块（/purchase）：申请-审批-发票闭环 + BOM 识别 + 四维导出

- **需求 7 条**（学生填明细/截图、按日期或比赛导出、BOM 识别自动填表、负责人+老师均可审批、通过后必须传发票、个人申请与金额统计、整体/个人/项目三维金额统计）。决策（AskUserQuestion 全确认）：**审批人按比赛/项目分别指定**（桥表 `purchase_event_approver`，不动 user 表）；**BOM 四格式全支持**（Excel/CSV/PDF/图片）；驳回后**可修改重提、轨迹保留**；发票**通过后必传、可多张、删光退回「待传发票」**；**任何登录用户可建档、建档者自动 leader**；登录制（不学报销那套免登录认领）；**任一审批人通过即生效、不能审自己**（admin 可）；档案**只关闭不删除**（FK RESTRICT）
- **数据模型 6 张新表（45~50，全部 IF NOT EXISTS 零迁移）**：`purchase_event`（UNIQUE name、kind 比赛/项目、open/closed）、`purchase_event_approver`（PK(event,user)、role leader/teacher）、`purchase_request`（status **pending/approved/invoiced/rejected**、金额服务端重算、invoice_count）、`purchase_item`、`purchase_file`（kind shot/invoice 统一表）、`purchase_approval_log`
- **后端** `routes/purchase.js`（整路由 authRequired，736 行）+ `lib/purchaseFiles.js`（落盘 `uploads/purchase/{rid}/shots|invoices/`，撤回/删行集中清盘）+ `lib/bomVision.js`（xlsx/csv 表头启发式 + GBK 回落 + 合计行跳过；PDF 走 pdf-text→GLM-OCR→视觉三级管线，图片 GLM-4.6V，看不清宁空不编）+ `lib/purchaseExcel.js`（**4 sheet**：物料明细/按比赛项目汇总/个人汇总/审批轨迹，末行 `=SUM` 公式、cellSafe 防注入、RFC5987 filename*）。GET 单条返 `{detail}`（列表是 `{requests}`、stats 直接返对象）——前端解包别搞混
- **★ SheetJS 公式坑（复用前必看）**：公式单元格必须写 **`f: '=SUM(I2:I6)'` 带前导等号**（漏了会生成 `<f>SUM(...)</f>` Excel 报损坏）；防注入前缀的单引号在 xlsx 里被 XML 转义成 `&apos;=cmd`，断言要找转义后的串
- **前端三件** `components/purchase/`：PurchaseView（5 张顶部统计卡 + chip 四 tab：我的申请/审批工作台/金额统计(ECharts 柱)/比赛·项目管理；导出条；≤768 表格降卡片）、RequestFormDialog（手填行 + **BOM 结果只追加不清空** + 每行一截图；带 id 的旧行 PUT 时保留截图，提交后按序补传 pending 截图）、RequestDetailDialog（明细/el-timeline 轨迹/发票区/审批 prompt 必填驳回原因）
- **★ 前端两个本轮坑**：① **异步拉 blob 后要驱动重渲染，缓存 Map 必须 `reactive(new Map())`**（普通 Map 里 set 不触发更新，旧截图缩略图静默不显示）；② `@element-plus/icons-vue` 只是 element-plus 的**间接依赖**（package.json 没声明），新组件不要 import 它，加载态用 CSS 自画 spinner
- **测试**：`scripts/smoke_purchase.mjs`（API 全链 **102/102**；xlsx 走 createRequire 够 backend/node_modules，GBK fixture 用 iconv-lite；「最后一个 leader」状态靠直连临时库 DELETE 造）；`scripts/probe_purchase_ui.mjs`（**自起临时后端(3108)+vite(5199, VITE_API_TARGET) 的 Playwright 全链 29/29**：闸门→手填+BOM+截图→老师驳回→改价重提（旧截图 blob 回填）→负责人通过→两张发票删一张→统计表/图表/导出 xlsx/审批人管理/390px；只清 uploads/purchase 本次新增目录）
- **探针经验**：Playwright 里 **MessageBox.prompt 的输入框是 `.el-message-box textarea`，没有 `.el-message-box__textarea` 这个类**；`innerText` 读不到 input.value（断言回填要 `evaluateAll(e=>e.value)`）；AuthView 默认 tab 是邮箱验证码（密码框在隐藏 tab 里，别拿它当登录闸门探针）；弹窗作用域用 `.el-dialog:visible`（全局 ImageViewer 也产 .el-overlay，拿 `.el-overlay` last 会选错）
- **验证**：smoke 102/102 + UI 探针 29/29 + `vite build` 通过 + 390px 截图人工过目；npm 脚本 `smoke:purchase` / `probe:purchase-ui`

## 2026-10-14 定期清理 + 失安全护栏（用户口径：**15 天一轮**）

- **需求**：「定期自动清理后台缓存」→ 间隔定为 **15 天**（`CLEANUP_INTERVAL_HOURS` 默认 `15*24=360`，env 可调）；启动时三段清理照跑，setInterval 只补「长期不重启」空窗；非重入（cleanupRunning）、单项 try/catch、`timer.unref()`
- **三类清理**：`sweepStaging`（分享暂存，**只删 DB 有暂存行的盘文件，天然防错配**）、`sweepOrphanHonorFiles`、`sweepOrphanPurchaseFiles`（后两者是磁盘↔DB 对账型孤儿清理，24h 宽限）
- **★★ 失安全三护栏（用户「确保关键数据不会丢失」后加固，原则：不确定归属一律保留）**：① 清理根 = 文件系统根（`PURCHASE_UPLOAD_DIR='D:\'` 错配）直接 return；② **DB 里 0 条申请/honor 0 配图行，但盘上有目录/文件 → 疑似 DB_PATH 指到空库·临时库，整轮跳过并 console.error 告警**（这是真实风险：跑临时冒烟只给 DB_PATH 不给 PURCHASE_UPLOAD_DIR 就会对账真实附件；本机因 uploads/purchase 为空才没出事）；DB 查询抛错同样跳过；③ 采购按申请目录逐个 try/catch，单目录失败只跳过
- **新增 env**：`PURCHASE_UPLOAD_DIR` / `HONOR_UPLOAD_DIR`（上传根可覆盖，部署/隔离测试）；模块加载的 mkdirSync 要 try/catch——Windows 对盘符根 recursive mkdir 直接 EPERM，会让整个服务启动崩
- **回归** `scripts/sweep_safety_check.mjs`（npm `smoke:sweep-safety`，自起 mkdtemp 沙盒 + 多子进程换 env，**15/15**）：关键断言是「空库 + 含 3 天前有主文件的目录 → 删除 0、清单逐一不变」（有主文件故意做成旧的，否则 24h 宽限会替护栏兜底，证明不了护栏）；`smoke_purchase.mjs` 加 `SMK_PURCHASE_DIR` 对齐服务端重定向（102/102 回归通过）

## 2026-10-14 账号安全中心 + 资源分享 GitHub 风真路由（现行口径，取代 09-10 的伪面包屑/单页展开树）

- **需求两条**：①历史邮箱验证码登录用户写的是随机哈希、实际「无密码」→ **存量用户全部重置为初始密码 `gkjsdh123`**（env `INITIAL_PASSWORD` 可覆写；scrypt 无法反推区分，AskUserQuestion 确认全员重置），引导邮箱验证码改密，未改密走**软提示**（首页横幅 + 个人公告，不阻断）；密码/邮箱/手机/飞书/GitHub 五块绑定收进「账号安全」页，入口在「我的」页与**退出登录按钮同级**。②资源分享从伪面包屑改成 GitHub 风真路由 `/:用户名/:项目名(/tree|/blob)/路径`，`/share` 即开源资料大厅，含「我的」子页可开关开源。**手机号=只存号 + CN 正则、标未验证**（预留 SMS）；**GitHub 做完整 OAuth**（env 缺时置灰）
- **数据模型**：user 加 `password_set`(默认1)/`phone`/`phone_verified`（phone 部分唯一索引，空串互不冲突）；新表 **51 `personal_notice`**（type/title/content/link/is_read，未读计入铃铛 total）、**52 `github_bind`**；share_post 加 `slug`（同用户唯一索引）+ `is_public`（默认 1）。迁移在 database.js 迁移链：启动时**全员置初始密码哈希+password_set=0+每人一条 password_init 公告（同 type 不重复发）**；slug 由 title 回填（slugify 保留中文/字母数字/_-，空白转-，去 URL 危险字符，截 60，冲突加 -2；空则 project-{id}）。genUsername 加保留名拦截（share/me/admin/api/honor/purchase/ghost-share/account-security 等）
- **后端**：auth.js 加 `POST /auth/change-password`（验证码或旧密码二选一；新密码≥6；初始态禁止新密码==gkjsdh123；成功后 password_set=1 + 公告自动标已读）、公开 `POST /auth/reset-password`（忘密；**邮箱不存在也回成功文案不发码，防枚举**，send-code purpose 加 `reset`）、`PUT /auth/phone`；邮箱验证码自动注册分支改为初始密码+password_set=0+发公告；userCard 带 password_set/phone。`routes/github.js`（新，/api/github/oauth/status|auth|callback|unbind，照飞书 postMessage 回调范式；token 不刷新，失效解绑重绑）。share.js 加 `GET /share/u/:username`、`GET /share/p/:username/:slug`、`POST /posts/:id/visibility`；**私密/幽灵对非作者非 admin 全部统一 404「项目不存在」**（p/fid/raw/text/zip 五处一致，防枚举）；列表非 mine scope 强制 is_public=1（**管理员也不例外**——2026-10-15 修复：openClause/ghostClause 曾对 admin 豁免导致管理员账号在开源大厅看到他人/自己的私密项目；巡检全量走 `/admin/posts`）。admin.js 加 `POST /admin/notices/password-remind`（只给未改密且无未读同文案者补发）
- **前端路由（router.js，动态四条必须注册在最后）**：`/:username` UserProjectsView、`/:username/:slug` + `/tree/:pathMatch*` + `/blob/:pathMatch*` ProjectView（同组件 watch username+slug 重新取数一项目一次 fetch，目录由 buildTree 前缀推导；文件行/作者名点击都是真跳转，**F5/外发链接/前进后退全成立**）；`/share/:id` 改成 **ShareRedirectView 静默 replace 层**（消息/收藏旧链无感迁移）；`/ghost-share/:id` 暗色旧详情页保留。大厅 `/share` tabs：全部开源（默认）/📝我的（行内 el-switch 开源开关）/我的收藏；发帖弹窗默认开源可改私密，**slug 创建后不可改、title 可改**。组件：`components/repo/` 三视图 + `components/account/`（AccountSecurityView 五卡：Password/Email/Phone/BindOauth×2，飞书与 GitHub 共用 BindOauthCard）；App.vue 未改密横幅；MyView 原邮箱/飞书弹窗已迁出；AuthView 加「忘记密码？」
- **★ 路由复用两个坑**：① 同组件不同参数复用靠 watch $route（onMounted 不重跑）；② 大厅 `.gh-row` 网格行**中间点会落在 `.c-author` 列触发作者跳转**，探针点标题必须用 `.gh-fname`
- **★ 认证字节流口径不变**：私密文件下载仍是 fetch+blob 带 Authorization 头转 objectURL，**token 永远不进 URL/query**
- **部署**：history 动态路由要求 Nginx `try_files $uri $uri/ /index.html;`，否则项目页 F5 404 → 新增 `docs/nginx-compass.conf.example`（含 /api 反代、缓存、100m 上传），deploy.sh 结尾自动 grep 检测并提醒
- **大厅页二次调整（用户口径）**：大厅头不展示仿路由面包屑（改大标题「📚 开源资料大厅」）；列表**默认按收藏数倒序**（前端 shareKeep + 后端无参默认都改 `fav`，SORTS 收藏/最热/最新）；「我的」从 tab 移出，改为头部「项目上传」旁的 **📝 我的项目** 按钮（再点返回大厅，进 scope=mine 时显示提示条）；tab 只剩 全部开源/我的收藏；主按钮与发帖弹窗改名 **📤 项目上传**（弹窗标题/标题占位/Toast 同步去「帖子/开楼」措辞）；表格行 54px 更宽松
- **测试（全绿）**：`smoke:account` 52/52（迁移/改密/重置/手机/未配置 GitHub/提醒补发）、`smoke:repo` 46/46（slug/可见性/枚举 404）、`probe:repo-ui` **44/44**（自起 3108+5199：路由下钻+面包屑回跳+F5+旧链 replace+开关开源+改密全链+管理员提醒+系统通知+390px；response 监听需放行 favicon 与**有意的 /api/share/p/ 404**）、`probe:share` 56/56、`probe:share-folder` 35/35（冷启动改断言 /share/:id→规范路由、根仅 proj、/tree 逐级、/blob 预览、幽灵走 .sr-err 中转层、暗色 /ghost-share 旧链不变）、`smoke:purchase` 102/102 回归、`vite build` 通过

## 2026-10-15 🏢 资源预约模块（/booking）：项目-五类资源-甘特预约-资源级审批

- **需求**：资源预约页，项目内导入/手录五类资源做预约，区分空间/物品，资源可附参数（教室设备、容量），预约可单人/多人（固定组队或临时选人），时长人员尽量可视化。**AskUserQuestion ×2 共 7 项口径**：① 审批模式**每个资源单独设**（first_come 冲突即拒立即确认 / approval 负责人或管理员审批），项目只存 default_approve_mode 作新资源表单预填；② 固定组队**模块内自建**，不耦合现有项目小组；③ 登录用户可建项目、建档者=负责人、admin 管全部（采购同口径）；④ 30 分一格、开放 **07:00–22:00**、支持跨天连续时段（后端最长 7 天）；⑤ **空间独占+容量校验、物品按库存数量池**（多组可同时借，Σqty 借完即冲突）；⑥ 临时选人**全站可搜**（不依赖好友）；⑦ 登录用户可见所有开放项目与占用，关闭项目仅负责人/admin/有预约者可见（无权统一 404 防探测）
- **数据模型 7 张新表（53~59，全部 IF NOT EXISTS 零迁移，冷启动自动建表）**：`booking_project`（只关不删，created_by SET NULL）、`booking_resource`（kind prop/equipment/instrument=物品、lab/classroom=空间；is_space；capacity/quantity/params JSON 存 equipment[]；approve_mode 资源级；active/archived；UNIQUE(project_id,name)）、`booking_team`/`booking_team_member`（模块内独立组队）、`booking`（start_time/end_time **北京时间朴素串**、qty、headcount、status、source solo/team/custom、审批/取消快照字段）、`booking_participant`（下单瞬间成员快照）、`booking_log`。项目/资源 RESTRICT，组队/成员/参与人/log CASCADE，team_id SET NULL
- **★★ 时间口径（最易踩）**：`'YYYY-MM-DD HH:MM'` 朴素串定宽字典序做半开区间比较（`start<:end AND end>:start`，首尾相接不冲突）；前端本地 `new Date(y,m-1,d,H,M)` 解析**绝不补 Z/toISOString**，后端 `new Date(str.replace(' ','T')+'Z')` 仅做墙上时钟算术（前提 TZ=Asia/Shanghai）；夜段 22:00→次日07:00 折叠在日界两侧，`col=dayDiff*30+(分钟-420)/30`，跨天块天然连续
- **后端** `routes/booking.js`（挂 /api/booking，避开已占的 /api/resource）：**pending 即占位**（BLOCKING=pending+confirmed，琥珀斜纹块实时可见，驳回/取消释放；宁让后申请者改时间也不要先批先得后批被拒；v1 无 pending 超时）；所有写操作手写 **`BEGIN IMMEDIATE` 事务**（node:sqlite 无 db.transaction）把检测+插入串行化堵 TOCTOU，审批通过事务内复检冲突；物品按 30 分格 SUM(qty) 与 quantity 比较（prepared 复用 ≤7×48 格），回传首个冲突格；资源下调 capacity/quantity 对现存占用复检 409；负责人不能审自己（admin 豁免）；无编辑端点（改约=取消重约）。bulk 类型表单批量导入（≤200 行整体事务、坏行 400「第 N 行」）。**`GET /bookings/mine` 必须声明在 `/bookings/:id` 之前**。通知复用 personal_notice：type=`bk_<action>_<bid>` 同单同动作未读去重，link=`/booking/<pid>?bid=<bid>&date=<YYYY-MM-DD>`，COMMIT 后 try/catch fan-out，铃铛自动计入
- **前端 10 组件** `components/booking/`：BookingView（大厅+3 统计卡+建项）、BookingProjectView（4 tab：周视图/资源/组队/预约审批，pending 角标，`?bid=&date=` 深链自动弹详情定位周）、WeekGantt（**自研无 fullcalendar**：7天×30格 CSS grid 150px+repeat(210,minmax(20px,1fr))，sticky 角/表头/名列；贪心泳道打包重叠块（半开区间首尾相接可同泳道）；物品库存热度底色（半占 amber/约满 red 相邻合并）；confirmed 蓝/pending 琥珀斜纹/终态灰虚线（历史开关 all=1）/我的块 inset 描边/当前红线 60s 刷新；pointer 拖选吸附 30 格可跨天可反向，单击=1 格；≤768px 降日期 select+el-collapse+chip 列表）、ResourcePanel/ResourceFormDialog/ResourceImportDialog、TeamPanel/TeamFormDialog（remote 全站搜人）、BookingDialog（空间/物品分组 option、👥headcount/capacity 或 ×qty、单人/多人两级 radio 固定组队或临时选人、**400ms 防抖 POST /conflicts 实时校验**绿/红 alert、拖选初值 bd-slot 与表单模式 manual:true 切换）、BookingDetailDialog（el-timeline 日志+perm 位驱动通过/驳回/取消）
- **★ Playwright 探针本轮坑**：① `boundingBox()` 是 `{x,y,width,height}` **没有 left 键**（误用得 NaN）；② multiple el-select 的 placeholder 不在内部 input 上——按 `.el-form-item` 标题文本定位 .el-select，keyboard.type 后点可见下拉项，allow-create 设备标签 type+Enter 等 .el-tag；③ 拖选终点坐标落在 slotB 刻度线上被 floor 进下一格（拖 5 格得 6 格）→ **xEnd=刻度-5px**；④ 明天列在 4350px 宽 grid 视口外，拖前先设 `.wg-scroll` scrollLeft；⑤ el-select 弹层可能残留多个，取 `.el-select-dropdown:visible` 的 `.last()`；⑥ 临时选人表单项要先点「多人」再点二级 radio「临时选人」；⑦ 异步列表断言一律 waitFor 不用即时 count()（24/6 抖动→32/0 连绿两次）；⑧ 未登录 onMounted 必须 auth.token 闸门（否则 3 个 401 + pageerror）
- **边界**：不动小组域简版设备预约（表16 team_device/表17 device_booking、teamCollab.js、TeamDevices.vue），新旧完全独立互不读写
- **测试（全绿）**：`smoke:booking` **86/86**（自起沙盒 3107、mkdtemp、env 白名单、cwd 临时目录避 .env；五类资源/bulk/组队/时间窗/空间独占/物品池/资源级双模式/取消/多人/timeline/通知去重/外键级联）、`probe:booking-ui` **32/32 连跑两次稳定**（3108+vite 5199、三账号 A/B/C 多 context：建项建场→拖格 pending 块定位断言→重叠实时红 alert 禁提交→临时搜非好友 C→建固定队队约→先到先得蓝块+热度+超量拦截→审批变蓝→C 收 bk_approve 通知点 link 自动弹已确认详情→390px 手动手输时段建约无横溢；放行 favicon 与有意 /conflicts 4xx）；回归 smoke:repo 49/49、smoke:account 52/52、`vite build` 通过；npm 脚本 `smoke:booking`/`probe:booking-ui`。文档 `docs/booking-module.md`
- **呈现巡检修复（同日）**：① 新组件复用采购/报销 scoped 类名拿不到样式 → 抽全局 `styles/blocks.scss`（.card/.pv-wrap/.stat-cards/.tabchip/.rq-table/.filter-bar 等）在 main.js 引入；旧组件 scoped 同名规则特异性更高，旧页零回归；② **CSS grid + sticky 坑**：`.wg-grid` 写 `min-width:100%` 会顶替 auto min-content，网格盒被压成视口宽、210 条轨道（4200px）溢出盒外，sticky 左列在滚动 ~300px 后被钉在（过窄的）网格盒右缘而裁切文字——必须 `min-width: calc(176px + 210*20px)` 显式撑满，sticky 约束矩形才覆盖整个滚动范围；③ 资源名列 meta（容量/库存）必须是 flex 兄弟不能嵌在 ellipsis 文本 span 内，否则长名字整行被裁；＋按钮 hover 显现（@media hover:none 常显）+ title 全名提示；④ scrollToToday 用 DOM 实测列宽、今天贴轨道左缘 16px（sticky 名柱占 176px 不随滚，轨道区一屏仅 1.4 天）；⑤ `openDetail(v)` 兼容甘特 emit 的预约对象与表格/深链传的数字 id（此前点块请求 `/bookings/[object Object]` 404）；⑥ 快捷建约默认时段取下一个半点（manualSlotFor），不能固定今天 09:00（下午即触发"不能早于当前"）；⑦ 窄屏 mobileDay 初始化要传 props.from 给 todayIdx；⑧ **环境**：C 盘满（剩 19MB）会让探针 vite 间歇性白屏、失败点漂移；跑探针用 `TEMP=<D盘目录> TMP=<D盘目录> npm run probe:booking-ui` 重定向 os.tmpdir()，禁止擅自删他司应用 Temp 安装包（分类器会拒）
- **资源五分类简化为两类（同日）**：kind 值域从 prop/equipment/instrument/lab/classroom 收敛为 **`item`（📦 物品资源, is_space=0）/ `space`（🏢 空间资源, is_space=1）** 一一对应；`is_space` 仍是冲突/容量/库存逻辑唯一真值，kind 仅展示分组过滤。前端枚举唯一源 `utils/booking.js` KINDS（ResourcePanel 分组/甘特筛选/表单 radio/导入 tab 全部 v-for 派生）；ResourceFormDialog/ResourceImportDialog 默认 kind 仍预选 space。**首个 booking 模块数据迁移**：database.js `PRAGMA user_version=2` 闸门（先 sqlite_master 探测 booking_resource 表再 UPDATE，lab/classroom→space、prop/equipment/instrument→item，幂等；老库无表直接跳）。模块外零引用——报销 category=prop（耗材道具）等无关字段切勿误改。smoke 86 / probe 32 断言数不变

## 2026-10-15 资源表格导入（xlsx/csv）+ GitHub 绑定打磨与一键登录（现行口径）

- **需求**：「允许表格导入资源；完善一下 github 绑定」，AskUserQuestion 拍板「绑定打磨 + 一键登录」。飞书行为不动。
- **功能一·资源表格导入**：沿用采购 BOM「上传只解析预览 → 用户核对 → 走现有 bulk 事务入库」模式，bulk 零改动。`backend/lib/csvText.js` 从 bomVision.js **原样抽出** `parseCsvText`/`decodeCsvBuffer`（utf8 fatal→GBK→utf8 兜底剥 BOM；bomVision 改 import，smoke:purchase 兜底回归）；新 `backend/lib/bookingImport.js`：`recognizeBookingXlsx/Csv(kind,buf)`、`buildBookingTemplate(kind)`、`BookingImportError`、上限 200 行/10MB；表头启发（前 5 行打分，名称列必须命中，别名：空间名称/房间号/可容纳人数/室内设备/预约方式 等；序号列识别丢弃）；空名/合计总计小计共计/纯序号残留行跳过并入 warnings；设备按 `[,，、;；/／换行]` 切分；审批词 需审批/先到先得归一、空串留给 bulk 回落项目默认。**坏数字（'abc'、空 capacity/quantity）原样透传绝不兜底**——预览行号 == bulk「第 N 行」契约；≥200 截断 + warning；有表头零数据 → 200 items=[]。两端点挂 booking.js（bulk 之后）：`POST /projects/:id/resources/parse-import`（multer memoryStorage 单文件，字段 file+kind；404→403→坏 kind→无 file→扩展名白名单 .xlsx/.xls/.csv；错误中间件扩 BookingImportError 400 / MulterError 413）与 `GET .../import-template?kind=`（模板**只有表头无示例行**，filename*=UTF-8''）。前端 api.js `bookingResourceParseImport`（FormData 不显式给 Content-Type，60s）/`bookingResourceTemplateBlob`（解析 content-disposition 文件名）；ResourceImportDialog 加下载模板/选表格按钮+隐藏 input（change 后清 value 可重选）+ warnings el-alert，解析后整体替换行、不足 3 行补空行，footer「导入 N 条」=名称非空行数。文档 docs/booking-module.md §5.1
- **功能二·GitHub 一键登录口径**：已绑定直接登录；未绑定按 GitHub **已验证主邮箱**（非 @users.noreply）小写匹配本站账号 → 自动绑定（该账号已绑别的 github_id 则拒绝，防夺号）；匹配不上自动建新号（username=uniqueUsername(gh.login)、昵称/头像取自 GitHub、email 真实邮箱或 **NULL**、randomBytes(18) base64url 随机不可登录密码、password_set=1、**不发初始密码公告**，日后走忘记密码）；封禁账号拒绝且不建会话。
- **后端改动**：githubClient.js 重写——APP_ORIGIN/API_ORIGIN 支持 `GITHUB_API_ORIGIN` mock 口（假服务器须**同端口伺候三路径**）、两 fetch 加 `AbortSignal.timeout(15000)`、新增 `fetchGithubEmails`、导出 configured/clientId/webOrigin。auth.js 抽出 **export `uniqueUsername(baseRaw)`**（@前缀、非\w替_、截16、空回落 user、撞 RESERVED_USERNAMES（含 github/share）加数字后缀截20）。routes/github.js 整体重写（**表结构零改动**）：state 内存 Map（randomBytes16、5 分钟、一次性、size>200 懒清扫）存 `{intent:'bind'|'login',userId?,origin,exp}`，**origin 只从服务端 redirect_uri 推导，绝不读请求 Origin/Referer**；redirectUri=GITHUB_REDIRECT_URI || GITHUB_FRONTEND_ORIGIN+/api/github/oauth/callback（dev 走 Vite 代理同源）|| host 推导。回调全 try/catch 回 HTML：成功 post `github-bound`/`github-login{token,user:userCard}`，失败（含无 code/state 失效）统一 post `github-oauth-error{message}`；targetOrigin=state.origin（state 失效页允许 '*'，无秘密）；成功 1.2s 自动关窗。动态文本 escapeHtml 五字符；payload JSON 用 embedJson 把 `<>` 与 U+2028/2029 转成 `\uXXXX`（**必须字符串拼接造反斜杠 u，模板字面量里写 `\u${x}` 是 SyntaxError；源码里 LS/PS 一律写转义别贴裸字符**）；friendlyError 把 SQLITE_CONSTRAINT/网络/401/403 全转中文（修旧链路冲突时渲 SQL 原文）。路由：公开 `GET /oauth/configured`、公开 **`GET /oauth/login`**（新增）、status/auth 不变、**unbind 先取 login 再 DELETE 并 logAudit('github-unbind',login)**（修旧解绑无审计）；登录建 randomBytes(32) session，logAudit('github-login', login, {via,github_id})，via=bound/email-autobind/register。server.js health 加 `github`；.env.example 加完整 GitHub 段（生产同源零配置；dev 回调 http://localhost:5173/api/github/oauth/callback + GITHUB_FRONTEND_ORIGIN）
- **前端**：api.js 加 githubConfigured（公开）/githubLogin；AuthView onMounted 探 configured（失败默认不显示），tabs 下「🐙 使用 GitHub 登录」深色按钮 window.open 720×640，message 监听**仅 e.origin===location.origin**，成功 setAuth+afterLogin，失败红字复位，弹窗 closed 轮询复位（修旧绑定回调失败按钮永久转圈），卸载清理监听/定时器。BindOauthCard.vue 四缺陷修复（**飞书 checkOrigin:false 行为不动**，github checkOrigin:true + errorType:'github-oauth-error'；listener 处理错误消息并复位 loading；load 失败设 loadFailed 显示「↻ 重试」不再伪装 configured:false；unbind 的 confirm 取消单独 catch、接口失败弹错；开窗关闭轮询；github tip 改一键登录新文案）
- **测试（全绿）**：新 `scripts/lib/fakeGithub.mjs`（node:http 3199，夹具 bound/mail/taken/new/noreply/banned/xss；同端口 /login/oauth/access_token、/user、/user/emails；xss 回 `<script>alert(1)</script>` 验转义）；新 `smoke:github` **33/33**（沙盒后端 3109+临时库+cwd 避 .env+env GITHUB_*；矩阵：health/configured、绑定落库 token_prefix 8 位+审计、第二人绑同号 400 友好文案无 SQL 字样、四分支登录、taken 拒无会话、新号 username=gh_new/password_set=1/无 password_init 公告、noreply email IS NULL、封禁拒、state 未知/复用 400、XSS 实体化且 payload.message 保留原文、解绑审计、401）。**坑：自写 req helper 忘带 Content-Type: application/json 会被 express.json 留空 body → 注册 400「邮箱格式不正确」**。`smoke:account` 52→**53/53**（env 一行不动，仅加匿名 configured=false）；回归 smoke:booking **113/113**（含表格导入 27 断言：xlsx 别名表头/垃圾行/设备多分隔符/坏值透传单 400「第 N 行」/UTF-8+GBK CSV/205 截断/无表头 400/空表 200/.txt 400/11MB 413/两 kind 模板 PK 魔数+精确表头/重复 409 行号）、probe:booking-ui **36/36**（模板下载 suggestedFilename + setInputFiles CSV + el-input 须用 inputValue() 断言非 innerText）、smoke:repo 49/49、`vite build` 通过。npm 脚本 smoke:github。真实 github.com UI 需配 env 人工走查，探针不接外网

## 2026-10-16 🪪 强制实名认证（user.real_name + 三模块硬门禁 + 「真名（昵称）」署名）

- **需求（用户原话）**：「现在我需要每个人写入自己的真实姓名，同样加入到账户管理页，没有实名给个人发出公告，必须实名」。两轮 AskUserQuestion 拍板：①**硬门禁**，未实名不能用、弹不可关闭弹窗、后端守卫是真边界、管理员不豁免；②门禁范围**仅资源预约/经费报销/物料采购**三模块，其他模块零影响；③三模块内署名「真名（昵称）」，真名缺失回退昵称，历史快照不回溯；④姓名 trim 后 **2–20 字符按码点计**，汉字/字母/空格/间隔号·•/点，拒绝纯数字/纯符号/单字/emoji。
- **DB/迁移**：schema.sql user 加 `real_name TEXT NOT NULL DEFAULT ''`（同 phone 范式）+ database.js migCol 补列 + **PRAGMA user_version 2→3**：给所有 real_name='' 用户每人 1 条 `personal_notice(type='realname_required', link='/account-security')`，启动日志「🪪 实名提醒公告补发完成」。
- **后端**：middleware.js 新增 `realNameRequired`（403 `{code:'need_real_name'}`）与 `displayNameOf(u)`（真名（昵称），空真名回退昵称）；userCard/USER_COLS/safeUser 贯通 real_name。auth.js：`PUT /auth/real-name`（**本接口自身不挂守卫否则死锁**；正则 `/^[一-龥A-Za-z][一-龥A-Za-z·•.\s]{0,18}[一-龥A-Za-z.]$/` + 码点长度 + 至少 2 个中英文字；空白折叠；审计 realname-set/realname-change；成功即 clearRealNameNotice）；realNameRequiredNotice **export**（github.js createGithubUser 复用；gh.name 不自动当真名）；email-login 自动注册、register、GitHub 建号三入口建号即发公告。admin.js 加 `POST /admin/notices/realname-remind`（未实名且无同类型未读公告才补发，审计 realname-remind，管理员自身也在目标集）。**挂载**：purchase 全挂；booking 条件守卫（唯一白名单 `POST /projects/:id/conflicts` 实时冲突预检）；expense 利用「/o 先挂、authRequired 后挂」顺序只护负责人侧，**匿名邀请面 /o/*（凭邀请码只读/认领/下载/导出）完整豁免**；expense 花名册是自由文本模型，只扩负责人本人 isMe 别名字段（real_name/nickname/username/组合名任一命中），不改成员认领归属。署名：写库瞬间 `displayNameOf()` 生成「真名（昵称）」快照（booker_name/applicant_name/owner_name/actor_name 等），读取端**原样渲染快照**。
- **前端**：新 utils/displayName.js（displayName）、realNameGate.js（reactive 全局 gate）；api.js 拦 403 need_real_name → openGate + setRealName/adminRealnameRemind；RealNameDialog.vue（closable=false 三不属性：无 X/点遮罩/ESC 不关、无取消，只能填完）；RealNameCard.vue 账号安全卡列首位；router /booking、/booking/:id、/purchase 加 meta.requiresRealName（**/expense 故意不加**，?code= 匿名邀请链路），beforeEach 改 async：`'real_name' in user` 判键、缺键 await api.me() 补刷（兼容老 localStorage）、仍空 openGate(to.fullPath)+return false；App.vue 挂全局弹窗，done 后跳 pendingTo；AdminConsole 加实名列 + 「🪪 提醒未实名用户」+ 审计 action 中文标签。
- **测试（全绿）**：smoke:account 53→**79**（v3 迁移断言 + 第 18 段实名：401/8 种 400 矩阵/200 空白折叠/公告自动已读/realname-set+change 审计/补发去重 sent·total 全精确/管理员不豁免 403）；smoke:booking **119**（夹具注册即实名、丁专供门禁：GET+写 403、conflicts 白名单 200、实名后 200、快照署名/搜索 real_name 断言）；smoke:purchase **105**（第 6 人未实名门禁、applicant_name 组合快照、by_user real_name）；smoke:expense **183**（负责人侧 403、/o 匿名面一行不动；**顺带修历史遗留**：UP 上传目录硬编码旧仓库路径 `D:\desktop\竞赛指导\...` 失效，改 __dirname 相对定位+SMK_EXPENSE_DIR 覆盖）；smoke:notifications **12**（建号公告断言+先实名）；smoke:github **35**（新号 real_name='' + realname_required 公告）；probe:booking-ui **36**、probe:purchase-ui **34**（mk 注册后 PUT 实名并**用实名响应更新注入浏览器的 user 卡**——旧卡 real_name='' 会让路由守卫误开 gate；组合署名 UI 断言）、probe:repo-ui **55**：加 §8.5 实名卡流（纯数字前端拦截→保存→已实名+公告清零，账号页弹窗可关）与 §11.5 硬门禁（未实名 B **站内点导航**进 /booking：return false 取消导航 URL 停留——注意硬加载 /booking 时取消的是「初始导航」，地址栏不回退是 vue-router 正常行为，探针须用 router-link 点击才测得到该契约；无 X/无取消/ESC 不关、填名后自动跳转；弹窗离场有 ~300ms 过渡，断言消失须 waitFor hidden 不能立即数）。**probe:claimlost 2026-10-16 起沙盒化**：原打真实 :3000+openProbeDb 直连删用户，命中「不得直接 DELETE 开发库」边界被分类器拦截；改为自起 :3111 临时库 + vite :5201（同 repo 探针范式，403 在 rowWriteError 认领校验层先于 AI 视觉调用，无密钥可测），EXPENSE_ROOT 无 env 覆盖仍指真实 uploads 目录，靠项目 DELETE 级联清盘 + finally 按本次邀请码兜底。**同日双层署名 bug 修复（上线前）**：初版设计「写库快照 + 实时 JOIN 输出 *_real_name 辅助字段，前端 displayName 再组合」是错的——快照本身已是「真名（昵称）」组合文本，前端拿它当昵称再套一层，凡昵称含真名的用户（如学号风昵称「张玉磊（284806020）」）显示成「张玉磊（张玉磊（284806020））」。最终口径：**快照怎么写就怎么显**——booking.js（bookingOut/participantRows/teamOut/日志）、purchase.js（detail/list/logs/stats by_user）全部删掉 *_real_name JOIN 与字段，前端快照点直接渲染；displayName() 只用于实时 user 对象（选人下拉/审批人/auth.user），且加防护：昵称已 includes 真名时直接返回昵称（信息更全），不包裹。回归断言在 smoke_booking：昵称「张玉磊（284806020）」+真名「张玉磊」的用户下单 booker_name 必须恰为昵称（120/0）。**教训：组合函数只能作用于「真名+原始昵称」两个原子字段，绝不能作用于自己的输出。****坑：Windows 下 TaskStop npm start 只杀 npm 不杀子 node，:3000 EADDRINUSE 须 netstat 找 PID taskkill。****遗留已清：失败跑残留测试用户 539/540（exp_a/exp_b_06805748@test.dev）经用户明确授权后直连 DELETE（foreign_keys=ON 级联），2026-10-16 已删除。**


## 2026-10-17 后台新增「📮 用户反馈」tab（feedback 表的管理端只读+删除）

- **背景**：意见反馈（MyView 概览底部 → POST /api/feedback）提交时**存 feedback 表 + 发邮件 FEEDBACK_TO**（线上 health `mail:true` 真发），但 AdminConsole 一直没有读表入口，邮件是唯一触达方式。新增管理端列表兜底，邮件漏收/垃圾箱也能从库里翻出。
- **后端（admin.js）**：`GET /api/admin/feedback?page&size&q`（分页同其他后台列表：size≤100；q 模糊 正文/contact_email/username/nickname/real_name；LEFT JOIN user 带 username/nickname/real_name/user_status，正常 FK CASCADE 不会有无主行；ORDER BY f.id DESC）；`DELETE /api/admin/feedback/:id`（404 + logAudit `feedback-delete`，target=正文前 40 字）。只读+删除，无已读/处理状态（feedback 表不加迁移）。
- **前端（AdminConsole.vue 第 9 个 tab，位于访问记录与公告之间）**：表格列 时间(fmtT)/用户(displayName 真名（昵称）+@username，已注销兜底)/联系邮箱(未绑定兜底)/正文(show-overflow-tooltip)/操作（查看全文·删除）；空态「暂无用户反馈」；「查看全文」弹窗 fbView 对象驱动（`:model-value="!!fbView"` + @update:model-value 关闭置 null，无需布尔 ref），Vue 插值渲染正文（white-space:pre-wrap，天然转义不 v-html）；ACTION_LABELS 加 feedback-delete 中文；onMounted 随其他 tab 一起预载。
- **验证（全绿）**：临时沙盒脚本 16 断言（401/403 权限矩阵/JOIN 字段/特殊字符原样/正文+昵称搜索命中/无命中/分页 size=1 page=2/删除 200+404+审计），跑完即删未入库；`vite build` 通过。
- **同日追加**：AdminConsole 用户管理 tab 与用户反馈 tab 的用户名改为 `<router-link :to="/user/:id" target="_blank">`（新标签打开公开主页 ProfileView；`/api/users/:id/public` 对所有登录用户同口径、无 admin 分支，管理员点过去天然是访客视角，不泄露邮箱）；.user-link 继承文字色、hover 显主色下划线。


## 2026-10-18 🪪 实名门禁改全站口径（登录即弹，不再等进三模块）+ BookingDialog 校验竞态修复

- **需求（用户原话）**：「未实名强制实名，不仅是使用特定网页的时候提醒，而是首页就应该跳出弹窗强制实名」。原实现只在 /booking、/purchase 路由守卫拦，用户在时间轴/项目小组等页可正常逛。
- **前端（唯一改动面，后端三模块 403 守卫原样保留作真边界）**：router.js beforeEach 由 `to.meta.requiresRealName && token` 改为 **`token && to.name!=='login'` 全站判定**——real_name 缺失（老缓存缺键仍先 await api.me() 补刷；me() 失败 fail-open，后端兜底）即 openGate；booking/purchase 仍额外 `return false` 取消导航（组件不挂载、不发必 403 的请求、pendingTo 记目标，填名后 App.vue 自动跳转），**其他路由放行，不可关弹窗压在页面上，遮罩天然阻断一切操作，原地填名原地关（pendingTo=null 不跳走）**。未登录（含 /expense?code= 匿名邀请面）一行不受影响。文案改全站口径：RealNameDialog「所有账号必须先完成实名认证才能使用本站…仅用于三模块署名」、RealNameCard「未完成实名认证将无法使用本站功能」。
- **顺带修产品竞态（BookingDialog.vue runCheck）**：实时冲突校验 400ms 防抖无请求序号，快速连改开始/结束时间时，先发出的「结束早于开始」400（后端 validateSlotWindow 短路、比查冲突的 200 更快返回）会**晚到反盖成功态**，弹窗卡在红错。加 `let checkSeq` 自增序号，响应回来 `seq===checkSeq` 才写 checkOk/checkError。
- **探针（probe_repo_ui 60/0、probe_booking_ui 36/0 三连、probe_purchase_ui 34/0；vite build 过）**：①repo 探针 §7 起新增「A 未实名登录落首页即弹硬门禁」全断言（无 X/无取消/ESC 不关/纯数字拦截/首页填名后停留 '/' 不跳/公告清零/me() 更新注入卡），§8.5 改为已实名态的「修改」弹窗流，C 在 §11 前 API 实名，§11.5 B 改为首页即弹 + 弹窗压顶时硬加载 /booking 取消初始导航 + 填名后跳 /booking；②**booking 探针周日（今天 2026-10-18 周日）连环坑**：a) 明天周一首列在**下一自然周**，甘特默认开本周，拖过去=过去时段静默不响应——所有项目页入口改 `?date=明天`（建项后 goto 补一次、B/C login URL、窄屏 goto；组件 onMounted 本就支持 ?date 定位周），删掉 dragOn 里点「下一周」的尝试（v-loading 遮罩+timeline 重渲染吞 pointerdown）；b) **dragOn 必须先 `.wg-scroll .el-loading-mask` waitFor hidden**——建资源后 timeline 刷新未回时遮罩盖网格，pointerdown 落在 `DIV.el-loading-spinner`（document 捕获监听实锤：只收 move/up 无 down），结构元素先渲染故只等 .wg-track 不保险；c) 拖拽坐标从「格线 +4/-5px」改**格子中心**（(slot±0.5)/30），列宽仅 ~10px 时旧坐标越界落进相邻 wg-block 被 @pointerdown.stop 吞；d) 重叠圈选两端都必须是空格（路径穿块即可，pointer capture 保证 move 穿块无碍），改 08:00→12:00、物品 08:30→10:30；③checkSeq 修复后移动端表单改时（09-10→16:30-17:00，间隔 >400ms 防抖窗口必发一次中间态 400）不再被反盖。**教训：合成鼠标拖不动，先挂 document 捕获监听看事件到底落在谁身上，别猜坐标。**


## 2026-10-18 🌐 资源分享 HTML 文件预览：默认沙箱渲染网页 + 可切源码

- **需求（用户原话）**：「资源分享页加入 html 解析器，如果读到用户上传 html，点击后不是呈现代码，而是直接呈现网页，可选呈现代码」。
- **实现（只改 ShareFilePreview.vue，ProjectView/SharePostView 共用该组件零改动；后端不动）**：新增 `isHtmlFile(f)`（mime===text/html 或 /\.html?$/i 双判据，兼容 octet-stream 旧数据）；kind 加 `'html'`，**在 isTextLike 之前拦截**（isTextLike 本就含 text/html，不抢先就会落源码态）。默认 `htmlMode='view'`：取 blob 后**强制 `new Blob([b],{type:'text/html'})`** 再 createObjectURL（后端对 html 走 res.download attachment，但 Content-Type 仍是 text/html；Gitee raw 代理可能给 octet-stream，不强制 iframe 会退化成下载），iframe 高 480 白底。头部加「🌐 网页 / </> 代码」分段开关（.fp-seg 两钮 margin-left:-1px 拼组，.on 主色边+tint 底）。代码态**懒拉** `/files/:fid/text`（默认渲染态不多拉一份），512KB 截断提示与普通文本一致；`<pre>{{text}}</pre>` 插值转义口径不变。切文件 cleanup 复位 htmlMode/codeLoaded/text。
- **安全口径（探针实锤）**：`sandbox="allow-scripts allow-popups allow-forms"` **绝不加 allow-same-origin**——blob: 虽挂本站源创建，缺该标志的 iframe 是 opaque origin，脚本可运行（网页常带 JS）但 `parent.document` 抛 SecurityError、读不到本站 Cookie/localStorage、不能以受害者身份调本站 API；外链/表单只能出网。下载按钮仍走 ?dl=1 attachment，SVG 仍只下载不预览。**v-html 禁令不变，全站唯一渲染用户 HTML 的位置就是这个沙箱 iframe。**
- **探针（probe_repo_ui 60→68/0，两连绿；vite build 过）**：夹具加 page.html（`<h1 id=t>` + 脚本改写 #t=JS_RUN_OK、try 写 parent.document.body data-xss、catch 建 #iso=ISOLATED），§2 根目录断言改 docs|page.html|readme.md 三项；新增 §4.5（**匿名**看公开帖）：iframe.fp-html 可见 + sandbox 属性精确等值（防手滑加 allow-same-origin）+ src 是 blob:、frameLocator 跨源定位 #t=JS_RUN_OK（脚本能跑）、#iso=ISOLATED + 父页 data-xss 空（隔离生效）、渲染态无 .fp-pre 且开关「网页」高亮、点代码等 `/text` 响应+轮询 .fp-pre 含 `<h1`/`<script>`/parent.document 源码且 iframe 卸载（**坑：代码态 v-else-if 立即渲染空 .fp-pre，waitFor 会抢在懒拉完成前通过，必须等响应+内容轮询**）、切回网页 iframe 重挂 #t 仍在。README.md 内 `<script>` 文本断言（probe_share_folder ③）不受影响——md 仍走 text kind。

## 2026-10-18 🗗 HTML 预览「新窗口」：bare 全屏路由 /share/html/:fid

- **需求（用户原话）**：「网页窗口太小了，点击后可以新开一个网页呈现」。内嵌 iframe 固定高 480px，复杂网页展不开。
- **实现（3 个前端文件，后端零改动）**：①新 `components/share/HtmlFrameView.vue`：`/share/html/:fid?n=文件名[&source=gitee]` 落地页，`.hf-page{position:fixed;inset:0;z-index:100}` flex 纵向——薄顶栏（file 图标+文件名+「沙箱隔离预览·页面脚本无法访问本站账号」+下载钮）+ iframe `.hf-frame{flex:1}` 铺满剩余视口；字节仍走带 Authorization 头的 api.shareFileBlob（**token 不进 URL**），强制 text/html blob objectURL，sandbox 白名单与内嵌逐字相同（allow-scripts allow-popups allow-forms，无 allow-same-origin）；onMounted 设 document.title，onBeforeUnmount revoke。②router.js 在 `/share/:id` 数字兜底**之前**注册静态路由 `meta:{bare:true}`。③App.vue useRoute 算 `bare=computed(()=>!!route.meta.bare)`，`v-if="!bare"` 摘掉 .app-header 与 ToolDock（router-view/RealNameDialog/ImageViewer 保留；公告/密码条在 fixed z-index:100 遮罩之下自然不可见）。ShareFilePreview.vue 头部在网页/代码分段开关旁加「↗ 新窗口」`<a target="_blank" rel="noopener noreferrer">`，frameUrl computed 拼 fid+encodeURIComponent(name)+Gitee source。
- **安全红线（头注释写明）**：**绝不能图省事改成 window.open(blobUrl)**——父页上下文创建的 blob: 以本站源导航 = 以本站源执行任意脚本；必须走独立 SPA 路由，由落地页自己在沙箱 iframe 里挂 blob。noopener 也防新窗脚本经 window.opener 回灌。
- **探针（probe_repo_ui 68→75/0，两连绿；vite build 过）**：新增 §4.6——「新窗口」href 正则 `/^\/share\/html\/\d+\?n=page\.html$/`；探针直接 goto 该地址（等价 target=_blank 落地，省弹窗权限）；断言 .app-header/.dock-fab 均 0 个（bare 生效）、iframe.hf-frame 沙箱属性精确等值且 boundingBox.height>600（真全屏，内嵌只有 480）、frameLocator 跨源 #t=JS_RUN_OK、#iso=ISOLATED+父页 data-xss 空（全屏口径隔离不降级）、.hf-name=page.html + 下载钮在；结尾必须 goto 回 `/blob/page.html` 等 fp-html 重挂，否则 §5 的面包屑点击落在 bare 页失败。

## 2026-10-18 ➕ 项目小组组长（成员管理权限者）可直接拉人进组

- **需求（用户原话）**：「项目小组允许小组组长拉人」。AskUserQuestion 拍板：①**直接加入+通知**（不搞邀请待接受表，与资源预约固定组队同口径）；②权限给**有「成员管理(member)」权限者**——组长恒可，被授予 member 的自定义角色也可，不移除「仅组长」语义到转让/解散。
- **后端（routes/team.js，两处新增，无表迁移）**：
  - `GET /api/team/users/search?q=&team_id=`：全站搜人（username/nickname/real_name LIKE，排除自己/status=1 封禁，LIMIT 10，返回含 real_name，与 booking users/search 同 SQL 范式）；带 team_id 时额外 `id NOT IN (SELECT user_id FROM team_member …)` 排除已在组，且**必须是该组成员**（teamCtx+member 校验，防借搜索枚举某组成员）；不带 team_id 任意登录用户可搜。⚠️ 必须注册在 `GET /:id` 之前（与 /my-tasks 同坑，'users' 否则被当 :id）。SQL 参数用 `...(teamId ? [me, teamId] : [me])` 拼可选占位。
  - `POST /api/team/:id/member/add`：body `{user_ids:number[]}`（兼容单值 user_id），requirePerm(ctx,res,'member')；空名单 400、>50 400；目标用一条 `IN(?)` 查全，**含不存在/封禁 → 整单 400**（不做部分成功，原子回滚，d 未入组有断言）；已在组的从目标集剔出，全员已在组 → 409 带 skipped 名字，部分跳过 → 201 响应 `{message,added_count,skipped:[displayName]}`。插入与邀请码加入**逐字同口径**：team_member.role_id 恒 NULL（角色只认桥表），桥表挂默认「组员」角色（name='组员' ORDER BY level LIMIT 1）。
  - 通知：COMMIT 后写 personal_notice，type=`team_add`，title「你被加入小组」，content「{actor displayNameOf} 将你加入了小组「{team}」」，**link=`/team?team=<id>`**（TeamView 本就支持 ?team= 深链）；去重键 `(user_id,type,link,is_read=0)`——比 booking notify 的 type-only 更细，同组反复拉人只留一条未读，跨组不合并。logAudit `team-member-add`，target 组名、meta {added}。
- **前端**：api.js 加 teamUserSearch(q,teamId)/teamMemberAdd(id,ids)；TeamMembers.vue 成员区头加「＋ 拉人进组」（v-if perms.member，与 AI 分组并排，.tm-head-btns inline-flex gap），弹窗照抄 booking/TeamFormDialog.vue 的 el-select multiple filterable remote（头像+displayName（@username）选项、:reserve-keyword="false"），打开时清空 ids/options；成功 ElMessage 显示后端 message（含跳过数）并 reload()。邀请码区保留（自助加入渠道不撤）。
- **测试**：smoke_collab 33→**48/48**（新增 §5 共 15 断言：组外人/无 member 权限组员 POST add 双 403、非成员带 team_id 搜索 403、搜索排除自己与在组成员、空名单 400、含不存在 id 整单 400+原子回滚、批量 [新人+在组] → 201 added_count=1 skipped=1、新人默认「组员」角色、全员重复 409、单值 user_id 兼容、personal_notice team_add 带组名+link、**删除后重拉不产生第二条未读通知**；notifications/personal 返回体是 `{rows}` 不是数组，踩了一次）；回归 smoke_multi_role 48、smoke_team_plan 35、smoke_team_ai 14 全绿；vite build 过。无 team 模块 UI probe（该模块历史上只有 smoke 覆盖，沿用）。**老坑复现：Windows TaskStop npm start 只杀 npm，:3000 子 node 须 netstat+taskkill。**

## 2026-10-26 🗓️ 项目小组「进度对齐」周期打卡 / 定时汇报 + 自评 + 评分 + 排行榜 + 优秀墙（直接 main）

- **需求（用户原话）**：组长/负责人可选周期性打卡或定时任务汇报；组员富文本提交，可选自评进度与完成效果；组长/负责人评分评价；排行榜（打卡次数多的）与优秀汇报展示（可被其他组员看到）。AskUser 拍板 **ACC**：本地轻量富文本（不依赖飞书）、优秀手动+自动都支持、页面待办提示+定时主动通知都做；用户要求**直接在 main 开发**。
- **核心设计：规则一条行、提交复用 progress_log、不预生成每日实例**。新建 `checkin_schedule`（kind=recurring/once、freq=daily/weekly、weekdays JSON[1..7 周一=1]、due_time HH:MM、start/end_date、once_at、allow_late、need_self_progress、need_self_rating、auto_feature 0/4/5、active、creator_id）；`progress_log` migCol 加 9 列（schedule_id/period_key/self_progress/self_rating/score/review/reviewer_id/featured/is_late）+ **部分唯一索引** `(schedule_id,user_id,period_key) WHERE schedule_id IS NOT NULL`（同期重复提交=UPDATE）。谁该交/迟交/缺卡全部打开看板时按规则**惰性计算**（成员×周期 LEFT JOIN），零时钟漂移、零垃圾行。
- **周期引擎 `backend/lib/checkin.js`（257 行零依赖）**：东八区口径（Intl DateTimeFormat 取当日日期/星期，ISO 周 `isoWeek` 周一为首日 key=`YYYY-Www`）；`currentDue`（每日回看 7 天/每周 13 天找最近应交期）、`checkOccurrence`（扫窗口校验 period_key 真实存在、未来拒、过期看 allow_late 返回 late=1）、`boardPeriods`（每日近 14 天/每周近 6 期/once 自身）、`streakOf`（按东八区日期去重数连续）、`sanitizeHtml`（**标签/属性双白名单**重建标签，抹 script/事件属性，URL 只放行 http(s)/mailto/相对路径/data:image；v-html 前的真边界）、`runCheckinReminders(db,now)`（截止前 60 分钟「即将截止」、过期 15 分钟「未交」，按 progress 权限筛成员，personal_notice 同 type+link+未读自然去重，link=`/team?team=X&ci=Y&p=key&ph=phase`）。server.js 每 10 分钟扫一次（unref），启动 20 秒补跑。
- **后端 `backend/routes/checkin.js`（挂 /api/team，与 teamCollab 同前缀）**：schedules CRUD（task 权限=组长/负责人；删除任务**只解挂不删历史**，汇报保留在时间线）、submit（progress 权限；sanitizeHtml+复用 teamCollab 导出的 sanitizeAttachments；必填自评服务端强校验）、my（今日待办 submitted/waiting/late_window/missed）、schedules/:sid/board（成员×周期单元格 on/late/miss/wait）、logs/:lid/review（task 权限；score 1-5、评语 ≤500、featured 手动优先否则 auto_feature 自动）、leaderboard（range=month/all，COUNT/准时率/AVG(score)/🏅数/连续天数，按次数排序）、featured（优秀墙 30 条）。teamCollab 的 GET logs 扩出 schedule_id/period_key/自评/评分/featured/schedule_title/reviewer_name，**sanitizeAttachments 改为 export 供 checkin 复用**。
- **前端**：新 `components/team/LiteEditor.vue`（contenteditable 本地富文本：加粗/斜体/下划线/删除线/标题/引用/列表/链接/图片；**图片选图或粘贴→compressImage(900,0.72)→base64 内嵌**；粘贴强制纯文本+图片，不带外部样式；watch modelValue 才回写避免输入跳光标）。旧 RichEditor（已退化成纯文本）保留给日程/分享等旧调用。TeamProgress.vue 由「任务看板+时间线」扩为：**今日打卡待办条**（去打卡/已交/可补交/不可补四态）→ 任务看板（原样）→ 打卡任务管理（新建弹窗：类型/频率/星期/截止/生效区间/补交·自评·自动优秀开关）→ 排行榜（本月/全部，🥇🥈🥉+🔥连续+⭐均分+🏅）→ 优秀墙（卡片流 4 行截断展开）→ 时间线（打卡条目带任务标签/迟交/🏅、自评进度条与星级、task 权限者 el-rate 评分+评语+选优秀）→ 看板弹窗（成员×周期矩阵 ✓迟缺待）。头部保留飞书入口并新增「✍️ 自由汇报」本地按钮；编辑打卡条目走打卡弹窗、自由汇报走原弹窗。api.js 加 9 个 teamCheckin* 方法。
- **测试**：新 `scripts/smoke_checkin.mjs`（自起临时后端 :3111 + mktemp 库，**38/38**）覆盖：组员建任务 403/每周空星期 400/坏时间 400、my 四态、必填自评 400/未来周期 400、同期重复=更新、不可补交 400 vs 补交 late=1、非成员 403、看板单元格、评分越界 400/组员评分 403/评 5 星 auto_feature=5 自动优秀/手动取消再选、优秀墙、排行榜 A 2 次🏅1 且排序在前、删任务后汇报解挂仍在且排行榜剔除、**XSS（script/onerror 被抹、b 保留）**、提醒扫描发通知/重复去重/补交后不新增；`npm run smoke:checkin`。vite build 过（2349 模块）。**坑：node:sqlite 的 DatabaseSync 没有 better-sqlite3 的 `db.transaction()`，用 db.exec('BEGIN'/'COMMIT'/'ROLLBACK')**。

## 2026-10-26 🎴 计划同步极简方块化 + 排行榜移成员页 + 周报看板角色筛选（直接 main）

- **需求（用户原话）**：①备赛计划页成员计划同步「以小方块形式极简显示成员计划，甚至可以只显示人名，点击小方块标签后展开（或弹出）成员详细个人计划」；②打卡排行榜放成员与角色页「先简略，点击后查看详细」；③周报提交看板「显示成员角色，可选查看特定角色的提交情况」。
- **需求1 TeamPlans.vue 整页重写**：删掉每成员大卡片，改为 `.mp-chips` 方块流——每成员一个 chip（头像+人名，组长👑，未完成计划总数数字角标；备赛+学习全完成为绿✓且名字变绿，组长 chip 金色底）。点击 chip → `el-dialog` 详情：头部角色 tag（组长/role_names/组员兜底）+「查看主页」，内部**原样复用 PlanTiles**（备赛/学习两块，完成数口径「未完成 x / 总数 y」+ 全部完成🎉/暂无文案）。过滤逻辑同旧版（keepPlan：total>0 且 done===total 不进详情），但**成员不过滤**（全员都出方块）。selected 用 selId+computed 从 rows 现算，切人不残留展开态（PlanTiles 按计划 id 存展开，跨成员 id 全局不撞）。PlanTiles.vue/TeamPlanView.vue 零改动。
- **需求2 排行榜迁移**：TeamProgress.vue 删除排行榜 ci-sec 区块、leaderboard/lbRange/loadLeaderboard 及 loadCheckin 里的 lb 并发项、`.lb-list/.lb-row` 样式（**`.lb-avatar` 保留**，优秀墙 ft-head 在用）。TeamMembers.vue 顶部新增简略区：仅当有人打卡才整块出现，前 3 名小方块（🥇🥈🥉+头像+名+次数，冠军金底），点方块或「完整排行榜→」开 el-dialog（本月/全部切换 + 完整行：次数/🔥连续/准时率/⭐均分/🏅数）。**坑：排行榜接口成员项只有 `id` 没有 user_id**（MEMBER_SQL u.id 展开），旧 TeamProgress 的 toProfile 按 x.user_id 跳转其实会生成 /user/undefined——成员页 toProfile 本就用 m.id，迁移时直接复用修掉。scoped 样式注意：TeamMembers 的 `.u-link` 嵌在 `.member-row` 内、`.tm-empty` 嵌在 `.tm-sec` 内，弹窗里用不到，新写 `.lb-cname/.lb-name` hover 与 `.lb-empty`。
- **需求3 看板角色（后端 checkin.js board 路由）**：board 响应新增 `roles`（team_role 列表）、每成员 `is_owner/role_ids/role_names`（复用 team.js roleMapOf 同口径：team_member_role JOIN team_role，level DESC）；支持 `?role_id=`：`owner` 仅组长、纯数字按角色 id 筛、空全员；返回 `role_filter` 与筛选后口径的 `submitted_total`。前端 api.teamCheckinBoard 第三参拼 query；看板弹窗加角色下拉（全部/👑组长/各角色）、已交格数统计、成员名第二行角色 tag（无角色灰字）、空结果行。
- **测试**：smoke_checkin 38→**42/42**（§4 看板新增 4 断言：roles/role_names 字段+role_filter=''、owner 筛选只剩组长、POST /team/:id/role 建角色+POST /team/:id/member 给 A 配角色后按 id 筛选只剩 A 且带角色名、role_filter 回显+submitted_total≥1；给 A 的角色只含 progress 不影响后续 task 403/提交等断言）。vite build 过（34.97s，2349 模块）。

## 2026-10-25 🛒 物料采购：档案删除 + 超管强删采购申请（分支 codex/purchase-delete）

- **需求**：物料采购页允许删除比赛/项目档案与采购申请。财务口径（凭证不能随档案静默消失）：① `DELETE /purchase/events/:id` 仅**建档者或超管**（`canManageSettings`；非建档 leader 不可），其下仍有申请 → **409 且消息带申请条数**；空档案直删，审批人桥表随 FK CASCADE；库层 purchase_request→event **RESTRICT** 兜底保留。② `DELETE /purchase/requests/:id` 由「本人 pending/rejected 撤回」扩为**超管可强删任意状态**（含 approved/invoiced）；非本人非超管 403、本人已审批 400；两种口径都先 `purgeRequestFiles` 再删库（明细/文件/轨迹随 CASCADE）；审计 `purchase-request-delete` meta 加 `by:'self'|'admin'` 与 `status`，返回消息分别为「申请已撤回/申请已删除」；`detailOf` perm 加 `isSuperAdmin`——**前端管理员按钮只认 `perm.isSuperAdmin`，不能用 auth.user.is_admin**（分权后后者包含受限管理员，采购模块历史上只认超管）。
- **前端**：PurchaseView「我管理的档案」ev-head 在设置/开关旁加红色「删除」link（v-if ev.canSettings），`removeEvent` 二次确认（提示审批人配置同删、不可恢复、有申请会被拦），失败直接弹后端 409 消息；副文案改为「没有采购申请的档案可以删除，已有申请需先删除全部申请」。RequestDetailDialog footer 保留本人「撤回申请」(`perm.canDelete`)，**超管在本人不可撤回的场景**（他人申请/自己已通过的申请）另显「删除申请」危险按钮（`isSuperAdmin && !canDelete`，避免与撤回重复），确认文案列明明细/截图/发票/审批记录全删且不可恢复；成功 emit changed + 关窗，经 refreshAfterChange 自动刷列表。api.js 加 `purchaseEventDelete`。
- **测试**：smoke_purchase 102→**116/116**（§14.5 新增：路人删档案 403、非建档 leader 403、建档者删有申请档案 409 且消息含「2 条」、删空档案 200+重复 404、审批人配置级联清零、DB 直改 `is_admin=1,admin_perms=NULL` 提权（session 每请求重查用户行，旧 token 即时生效）后超管强删他人 invoiced 申请 200+整目录清盘+申请/明细/文件/轨迹四类行归零、超管删空档案 200；清理断言剩余冒烟档案 ≥2）。**临时栈跑法（WSL）**：sh 脚本 export PORT=3109/DB_PATH/PURCHASE_UPLOAD_DIR 到 mktemp 目录起 `node backend/server.js`，冒烟侧给 `PROBE_API=http://127.0.0.1:3109/api PROBE_DB=<同库> SMK_PURCHASE_DIR=<同上传目录>`（openProbeDb 同源闸门）；**必须先 unset 全部 *_proxy 并 NO_PROXY=127.0.0.1**，否则 WSL NAT 模式下 localhost 代理让 health 轮询永远失败。vite build 过（30.85s）。

## 2026-10-26 📱 GitHub OAuth 回调页手机端卡死修复（直接 main，待推送部署）

- **故障**：手机端 GitHub 登录后停在 `/api/github/oauth/callback` 回调页不返回。根因：callbackHtml 只做 `window.opener.postMessage` + `window.close()`——桌面弹窗有效；手机浏览器全屏授权时 **opener 常为 null**（postMessage 无人接），且 **window.close() 只能关 window.open 弹出的窗，关不掉系统接管的标签页**，于是死页。
- **修法（只改 backend/routes/github.js 的 callbackHtml）**：脚本先探测 hasOpener。①无 opener 且 payload.type=github-login → 直接写同源 **localStorage `ec_token`/`ec_user`（与前端 auth.js 同键，回调页同源可写）**，回站整页加载即登录态；②页面加绿色大按钮（login→`/`「🚀 立即进入网站」、bound→`/account-security`、error→`/login`），倒计时 **无 opener 3s（错误 5s）location.replace 回站**；③有 opener 保留旧行为（postMessage+1.2s close），另设 8s 兜底倒计时（close 被拒的手机新标签场景；桌面弹窗被关后定时器随窗销毁，无副作用），桌面错误弹窗 delay=0 仅按钮不自动跳。按钮是硬编码常量相对路径，无注入面；message 仍 escapeHtml。飞书回调页本就有「← 返回互传工作台」链接，不在本次范围。
- **测试**：smoke_github 35→**38/38**（绑定回调含 href=/account-security、错误回调 href=/login 且有倒计时文案、登录回调含 localStorage ec_token 写入+href=/+location.replace）。纯后端渲染改动，无需前端构建；上线只需 pm2 restart（不必发前端）。

## 2026-10-26 🔗 项目小组邀请链接：点击直接加入（直接 main，已推送 c11fea5 并部署上线）

- **需求**：「点击分享链接，可直接加入项目小组」——原来只能手抄 8 位邀请码再去「邀请码加入」粘贴。
- **后端 routes/team.js**：新增 `GET /api/team/peek?code=`（登录即可，**注册在 GET /:id 之前**，仿 /users/search），返回 `{id,name,desc,member_count,owner_name,is_member}`，只暴露组名/人数不泄露成员名单（邀请码即钥匙，与报销同口径）；`POST /join` 的「已在组」409 响应补 `id/name`，供前端直接跳工作台。
- **前端**：链接格式 **`/team?join=CODE`**（未登录时复用全局 beforeEach：带 redirect 去登录，回来自动继续，无需新路由/新守卫）。TeamView.vue 新增 `normCode()`（8 位裸码 / 整条 `?join=` 链接 / 兼容 `?code=` / 前后杂字符 → 大写码），onMounted 改 async：await load() 后若有 `route.query.join` → teamPeek → **ElMessageBox 确认弹「组长 X 邀请你加入『组名』，现有 N 名成员」** → join → 成功 load+选中+`replace({team:id})` 清掉 join 参数；已在组→info 直跳；坏码→error 清参；取消/失败保留当前组选择（cleanQuery）。邀请码弹窗输入框也支持粘贴整条链接。TeamMembers.vue 邀请区加「🔗 复制邀请链接 / 复制邀请码」（clipboard API + HTTP 下 textarea+execCommand 兜底，IP 直连场景）；TeamDetail.vue 头部邀请码 tag 改可点复制链接（.invite-tag hover）。
- **测试**：smoke_checkin 42→**48/48**（§4.5 利用已注册但未入组的第三人 rC：peek 未入组人数 2、凭码 201、peek 转 true 人数 3、重复 409 带 id、坏码 peek/join 双 404；C 在 §4 看板断言之后才入组，不破坏 members===2 与后续提醒断言）。vite build 过（35.56s）。
- **部署坑（重要）**：服务器 `sudo bash deploy.sh` 在 **git pull 处 fatal：GnuTLS recv error (-110)**（腾讯云直连 github.com TLS 被中断，国内服务器常态；set -e 直接终止，后半段不执行、线上不变）。**离线 bundle 法已验证可行**：本地 `git bundle create .tmp/upd.bundle <服务器HEAD>..main`（基线必须正好等于服务器当前 HEAD，先 ssh 查 `git -C /opt/compass log --oneline -1`）→ scp 到 /tmp → 服务器 `cd /opt/compass && sudo git fetch /tmp/upd.bundle main && sudo git merge --ff-only FETCH_HEAD`（纯本地操作不碰网络）→ 手动跑 deploy.sh 第 3-4 步（cd backend && npm install --omit=dev && pm2 restart compass --update-env；cd frontend && npm install && npm run build && cp -r dist/* /var/www/compass/）。后台 nohup 跑约 50s，服务器 vite build 16s。验收：git HEAD=c11fea5、`curl localhost:3000/api/team/peek?code=x` 返回 **401**（路由已挂载；旧版 404）、公网首页资源 hash 与新构建一致。以后部署若再遇 pull TLS 失败，复用此法（或给服务器配 GitHub 代理/镜像）。

## 2026-10-26 🔒 生产 HTTPS 上线（gkjsdh.xyz SSL 证书部署，直接运维无代码改动）

- **结果**：`https://gkjsdh.xyz` 全绿——证书链 TrustAsia DV（notAfter **2026-11-23**，约 28 天后续签）、首页 200、`/api/health` 200（ai/vision/mail/github=true，gitee=false 是无 token 常态）、`http://域名` 301→https、history 深链 `/team/123` 200（F5 不再 404，上一轮 health 警告解决）。
- **操作流水（腾讯云文档 product/400/35244 = Nginx Linux 安装）**：SSL 控制台下 Nginx 包 → `gkjsdh.xyz_bundle.crt`+`.key` 经 scp 传 `/tmp` 再 sudo mv `/etc/nginx/ssl/`（crt 644 / key 600 root）；改 **sites-available/compass**（旧文件备份 `.bak.20261026`）为三块：80 域名 301、80 default_server `server_name _` 保留 IP 直连 HTTP（健康检查兼容）、443 ssl default_server 内含完整 SPA try_files + `/api` 反代（补 `X-Forwarded-For/X-Forwarded-Proto`）+ assets 长缓存 + 30m；`nginx -t` 后 `systemctl reload nginx`。
- **两个坑**：① WSL 用 `/mnt/c/.../id_rsa` 直连报 `UNPROTECTED PRIVATE KEY FILE 0777`（drvfs 改不动权限），必须 `cp` 进 WSL home 再 `chmod 600`；② nginx 本机 443 200 但公网全超时——**腾讯云控制台防火墙没放行 443**（CVM 安全组/轻量防火墙加 TCP 443 0.0.0.0/0），放行后立即通；服务器 ufw 本身 inactive。
- **服务端回调已改（同日）**：`/opt/compass/backend/.env`（root pm2 进程 compass，改后须 `sudo pm2 restart compass --update-env && sudo pm2 save`）：`GITHUB_REDIRECT_URI` http→**https**（原显式 http），新增 `FEISHU_REDIRECT_URI=https://gkjsdh.xyz/api/feishu/oauth/callback`（原本未配、走 req.protocol 动态生成，**Express 未开 trust proxy，反代后 protocol 恒 http**，故必须显式 env）；改前自动备份 .env.bak.时间戳，/oauth/login 实测 redirect_uri 已 https。**待用户在开放平台控制台同步**：GitHub OAuth App（client_id Ov23lipg4SnVvH1Uh6ru）回调 URL、飞书开发者后台应用 cli_aa051ae2f4f95cd5 安全设置重定向 URL（可多条并存，加 https 即可）。证书 2026-11-23 到期前重申替换两文件 reload。

## 2026-10-26 🔑 管理员权限细化 P1：5 模块拆子权限（直接在 main 开发）

- **需求**：不同管理员给不同权限，粒度从「10 个模块」细化到「只读 vs 高危操作」。仅做 P1 后台模块拆分；P2（预约/采购审批权下放）未做，仍仅超管。
- **模型**：`user.admin_perms` 存储不变（TEXT JSON 扁平 key 数组，空串=超管），新增 11 个子 key（详见 §全站管理员分权 2026-10-26 条目）。父子双向继承：父 key（如 `user`）=整组；子 key（如 `user:view`）=单项；旧管理员持父 key 零迁移不缩权。**任命管理员永远仅超管**。
- **后端**：middleware.js 加 `ADMIN_PERM_GROUPS`/`isValidAdminPerm`/`adminPermLabel`，parseAdminPerms 按父子 keyset 过滤，hasAdminPerm 双向继承，守卫错误文案支持子 key 中文名。admin.js 14 个路由守卫换子 key（users 列表/详情=user:view、封禁=user:moderate、两个 remind=user:notify；posts=content:post、comments=content:comment；resources 列表=resource:view/删除=resource:delete；feedback 同型；logs=log:action、visits=log:visit）；role PUT 保存过滤接受子 key、成功消息中文子项名；GET /perms 返回 `{flat,groups}`。散点收口：resource.js 越权下载=resource:view、删除=resource:delete（父聚合不经过子校验，堵只读提权）；share.js 帖子编辑/删除/开源态/Gitee 同步=content:post，评论删除=content:comment，私密帖可见=二者任一。
- **前端**：adminPerms.js 重写为 PERM_GROUPS（5 组带 children danger 标记）+ PERM_FLAT（5 个不拆模块），PERM_LABELS 含全部父子 key，canAdmin 双向继承 + 新增 canAdminAny，permSummary 输出「组名（子项、…）」。AdminConsole.vue：TAB_PERMS 改 key 数组、tabCan 控可见；内容子页 radio 按权显隐（仅评论权限默认落评论子页）；封禁/删帖/删评论/删资源/删反馈/下载/提醒按钮逐项 v-if；无查看权限的 tab 显 info 告警且 loader 直接 return（不刷 403 toast）。权限分配弹窗改分组面板：组头全选=父 key（半选态显示子项已选）、子项单独勾选、danger 项红字、父选中时子项只读。SharePostView 前台越权编辑判定改 content:post。
- **测试**：新建 scripts/smoke_admin_perms.mjs（自起后端 :3111 临时库，仿 smoke_github），**56/56 通过**：普通用户/未登录 403/401、/perms 结构与仅超管、五组子权限只读 200/高危 403、旧父 key 整组继承、不存在 id 时守卫 403 先于处理器 404、超管任命子 key（非法过滤+去重+中文消息+会话即时生效+列表回传）、受限管理员任命 403、超管操作自己 400。package.json 加 `smoke:admin-perms`。WSL vite build 过（37.07s，Windows node_modules 缺 @rollup/rollup-win32-x64-msvc，前端构建一律走 WSL）。

## 2026-10-26 🪪 项目小组内自己显示实名（纯前端）

- **需求**：项目小组页面里当前用户自己要显示真实姓名；他人仍显示昵称（小组接口刻意不回传他人 real_name，不扩大暴露面，故只改自己）。
- **实现**：`utils/displayName.js` 新增 `selfName(obj, meId, fallbackKey='nickname')`——对象 id/user_id 命中 meId 且 `auth.user.real_name` 存在时按全站统一口径渲染「真名（昵称）」（复用 displayName：昵称已含真名则只显示昵称），否则原样返回 nickname/user_name/uploader 等快照名；auth.user.real_name 由 /auth/me 提供（USER_COLS 含 real_name），无需改后端。
- **接入点**：TeamMembers 成员行/头像 title/AI 分组建议、TeamPlans 成员小方块与个人计划弹窗标题（props 无 me，直接用 auth.user?.id；mp-cname 有 ellipsis 兜底）、TeamChat 消息作者、CommentThread 评论作者、TeamFiles 上传者（fallback 'uploader'）、TeamDevices 预约人（'user_name'）、TeamProgress 优秀汇报/时间线/任务负责人下拉/任务 assignee_name（构造 {id,nickname} 传入）/提交看板成员列（m.name 构造 {id:m.id,nickname:m.name}）。历史快照（done_by/completions/审批快照）不改。WSL vite build 过（34.34s）。

## 2026-10-27 👥 小组成员互见实名 + 成员/角色方块化

- **需求**：同一小组成员互相可见真实姓名（自己也显示实名）；「成员与角色」页的成员列表与自定义角色列表都改为紧凑小方块，点击后在页内展开详情，减少纵向占用；可按角色标签筛选成员。
- **后端隐私口径**：仅对已登录且属于该组的成员返回同组 real_name。team.js 的 `GET /team/:id` 成员 SQL 补 `u.real_name`（AI 分组提示词与建议不回传/发送 real_name，前端按建议里的 user_id 从当前成员名单解析展示）；checkin.js 的 MEMBER_SQL 补 `u.real_name`（提交看板/排行榜）；teamCollab.js 的 `GET /team/:id/plans` 补 real_name，文件列表补 `f.user_id`。邀请预览 `/team/peek` 仍只返回组名/人数/组长昵称，不返回成员 real_name；非成员 GET 小组详情仍 403。
- **前端姓名口径**：`utils/displayName.js` 新增 `teamDisplayName(obj, members, fallbackKey)`——优先按 id/user_id/assignee_id/uploader_id 在当前小组成员名单中解析 displayName；已退组成员的历史消息/评论/文件/汇报/预约匹配不到名单时，继续显示历史昵称快照，避免退组后继续暴露实名。TeamChat/CommentThread/TeamFiles/TeamDevices/TeamProgress/TeamPlans 全部接入；TeamView 顶部显示 `displayName(auth.user)` 且 load() 中用 /auth/me 的 user patchUser，避免旧缓存缺实名。
- **成员与角色 UI**：TeamMembers 重写为「角色筛选 chips + 成员卡片网格 + 成员详情面板」和「角色卡片网格 + 角色详情面板 + 新建/编辑角色 dialog」。成员卡显示头像/真名（昵称）/首角色/组长或我；详情内嵌角色多选（≤3）、转让、移除、自选角色；角色卡显示等级/人数/权限数，详情可查看权限和成员、一键筛选成员。拉人、AI 分组、邀请、排行榜、解散等原功能保留。
- **验证**：WSL Linux Node 直跑 `node node_modules/vite/bin/vite.js build` 通过（Windows npm 会误用 Windows npm/缺 rollup win32 optional dep；WSL 里也要避开 /mnt/c 的 npm shim）。临时 DB 在 :31323 自起后端，自定义实名接口冒烟 15/15 通过：A/B 互见双方 real_name、非成员 C 403、/team/peek 不含 real_name、/plans 含同组实名。

## 2026-10-27 📋 资源预约：AI 混合台账批量导入

- **需求**：资源批量导入支持 AI 识别 Excel/CSV 表格内容；物品资源和空间资源可能混在同一张表、上下分段或不同 Sheet 中。第一期仅做 xlsx/xls/csv，PDF/图片 OCR 留到后续。
- **实现**：新增 `backend/lib/bookingAiImport.js`：多 Sheet 读取并保留原始行号；DeepSeek JSON 模式只做字段理解、类型判断、审批方式归一化和行筛选，输出必须带 `sheet_index/row`，无原始来源行一律丢弃。AI 异常/无 Key/非法 JSON 时自动回退本地规则解析；标准「资源类型/名称/规格/库存/位置/容量/室内设备/审批方式」模板无需 AI 也能识别。
- **安全与校验**：AI 解析不落库，新增 `POST /api/booking/projects/:id/resources/ai-parse-import` 只返回预览；路由层用既有 `normResourceBody` 逐行标注 issues/valid、表格内重名和项目内同名，最终仍走原 `/resources/bulk` 事务。`bookingImport.js` 增加 `kind=mixed` 模板；无数据库迁移。
- **前端**：`ResourceImportDialog.vue` 改为「AI 混合识别 / 仅物品 / 仅空间」三模式；混合模式统一展示类型、名称、规格、库存、单位、位置、容量、室内设备、审批方式、来源 Sheet#行，支持行内切换 item/space、低置信度/异常高亮、手工修正和混合批量提交；`ResourcePanel.vue` 传入 existingNames 做前端重名预校验；`api.js` 增加 120s AI 解析接口。
- **验证**：WSL Node `--check` 三个后端文件通过；Vite build 通过；临时 DB 起后端实测 DeepSeek 解析同一 Sheet 的物品+空间返回 200、stats `{total:2,item:1,space:1,invalid:0,skipped:1}`，审批方式补回「需审批/先到先得」，随后 mixed bulk 成功创建 2 条资源；AI 无 Key 时自动规则回退测试通过；mixed 模板下载 200。
