# Engineer-Compass 工科竞赛导航系统 — 项目记忆文档

> 本文件是 Claude Code 长期记忆的离线汇总版（2026-08-25 生成），自包含、可交接。
> 源记忆位于 `C:\Users\78505\.claude\projects\D--desktop-----\memory\`，本文件同步于此目录，两者并存。

---

## 1. 项目总览

**Engineer-Compass 工科竞赛导航系统**（目录 `D:\desktop\竞赛指导`，2026-08-23 启动）。B/S 网页端应用，帮工科生查全年 A 类竞赛 + AI 备赛规划。

- 技术栈：**Vue3 + Vite6 + Element Plus + GSAP + ECharts + SCSS** / **Node.js 24 + Express 4 + node:sqlite（内置，无编译依赖）** / **DeepSeek API**
- 部署：腾讯云 124.221.174.2 `/opt/compass`（PM2 + Nginx），用户手动部署，无 SSH 通道

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

- **入口**：顶部导航第 4 项「📤 资源分享」/share；移动端汉堡菜单同步
- **能力**：楼主开楼（标题≤60 + 富文本 + 附件图片/视频/音频/文件 base64 ≤25MB）、索引标签子板块（≤5 个/帖，自建即成为子板块）、点赞/收藏/评论（纯文本，删评限本人/楼主/管理员）、三种排序（最热门=点赞+评论权重 / 最新 / 收藏最高）、标签过滤、分页
- **表**：share_post / share_tag / share_post_tag / share_like / share_fav / share_comment（schema.sql 表 23~28，外键级联删除）
- **接口**：/api/share/*（routes/share.js；读写需登录，浏览匿名可看）；收藏/点赞 toggle 返回最新计数
- **前端**：ShareView.vue（排序 radio + 标签 chips 子板块 + 帖子卡片 + 发帖/详情弹窗，复用 RichEditor / AttachmentList / openImage）；api.js 新增 share* 方法

## 2026-08-25 用户管理页增强：我的帖子/收藏 + 好友私聊

- **入口**：/me 用户管理页改为四个标签：📊 概览（原有内容）/ 📝 我的帖子 / ⭐ 我的收藏 / 👥 好友私聊
- **我的帖子/收藏**：复用 share 列表接口加 `scope=mine|favs`（需登录，未登录 401）；点卡片 → `/share?post=ID` 深链自动打开详情弹窗（ShareView onMounted deepLink）
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
- **跳转**：通知 → `/share?post=ID`（ShareView 深链打开详情弹窗评论区回复）；私信 → `/me?tab=friends&dm=ID`（MyView deepLink 自动切好友 tab + 打开私聊弹窗 + router.replace 清 query）
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
