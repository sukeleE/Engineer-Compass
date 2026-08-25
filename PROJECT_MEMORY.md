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
