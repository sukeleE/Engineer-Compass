# Engineer-Compass 微信小程序（uni-app + Vue3 + Vite）

这是与既有 H5（`../frontend`）和 Express 后端（`../backend`）**长期并存**的微信小程序端，不是 H5 改造版。三端共用同一套数据库、会话 token 和业务 API：

- H5：继续承载完整管理后台、复杂文件处理、OAuth/外部工具等桌面端能力。
- 小程序：聚焦移动端高频场景，覆盖竞赛、备赛、小组、考勤、社交、分享、运营协作和轻量审核。
- 后端：`Authorization: Bearer <token>` 会话机制天然适配小程序；微信 openid 只作为新增登录绑定，不替换原账号体系。

当前已注册 **45 个页面**：主包 6 页 + 7 个分包 39 页；`npm run build:mp-weixin` 通过，当前整包产物约 0.51 MB，低于微信主包 2 MB / 整包 20 MB 限制。

## 1. 技术栈与目录

```text
miniprogram/
├── package.json
├── vite.config.js
├── index.html
└── src/
    ├── App.vue
    ├── main.js
    ├── manifest.json          # mp-weixin.appid 上线前必填
    ├── pages.json             # 主包、tabBar、7 个分包路由
    ├── env.js                 # BASE_URL 唯一切换入口
    ├── uni.scss
    ├── components/            # 通用组件（EmptyState、TechTree 等）
    ├── utils/
    │   ├── api.js             # 全模块接口封装，命名与 H5 对齐
    │   ├── request.js         # uni.request、Bearer token、401/实名门禁/60s 超时
    │   ├── auth.js            # uni.storage 登录态
    │   ├── wechat.js          # wx.login/绑定流程
    │   ├── upload.js          # wx.uploadFile multipart 封装（采购票据/发票、资源库上传）
    │   ├── fileBase64.js      # 选图转 base64（头像/汇报/聊天图片契约）
    │   ├── preview.js         # 图片/文档/base64 附件预览
    │   ├── guard.js           # 登录门禁与 toast
    │   └── format.js          # 时间、金额、Markdown、技术栈等格式化
    ├── pages/                 # 主包页面
    ├── packageCompetition/    # 竞赛详情、AI 问答、未知竞赛收录
    ├── packagePlan/           # 备赛/学习计划、笔记、计划对话
    ├── packageTeam/           # 小组、任务、进度、文件、设备、考勤
    ├── packageSocial/         # 通知、好友、私信、反馈
    ├── packageShare/          # 资源分享、荣誉墙、公开用户主页
    ├── packageOps/            # 报销、采购、资源预约
    └── packageAdmin/          # 移动端轻量审核端
```

## 2. 页面地图

### 主包（6 页）

| 页面 | 路径 | 能力 |
| --- | --- | --- |
| 竞赛时间轴 | `pages/timeline/main` | 竞赛列表、筛选、搜索、收录入口 |
| 备赛日程 | `pages/schedule/main` | 我的备赛计划、自编计划入口、AI 优化、月历聚合、进度勾选 |
| 项目小组 | `pages/team/main` | 我的小组、创建/加入小组 |
| 资源中心 | `pages/resource/main` | 公告、分享、协作运营、消息反馈聚合入口 |
| 我的 | `pages/me/main` | 头像/昵称/手机号编辑、实名、微信绑定、个人资源库入口、设置 |
| 登录/绑定 | `pages/login/main` | 密码登录、注册、微信 mock/正式登录绑定 |

### packageCompetition（3 页）

- `pages/detail/main`：竞赛详情、备赛流程、技术栈、学习资源。
- `pages/chat/main`：单竞赛 AI 问答，60 秒超时保护。
- `pages/ingest/main`：提交未知竞赛，进入后台审核。

### packagePlan（7 页）

- 学习计划：`pages/study/list`、`pages/study/detail`、`pages/study/create`（AI 生成 / 自编双模式）。
- 自编备赛计划：`pages/schedule/edit`（多阶段多任务，可关联竞赛，走 `/schedule/manual`）。
- 学习笔记：`pages/notes/main`、`pages/notes/edit`。
- AI 计划对话：`pages/planchat/main`。

### packageTeam（10 页）

- 小组：`pages/create/main`、`pages/detail/main`、`pages/members/main`（角色权限/转让组长/自选角色）。
- 协作：`pages/tasks/main`（计划 CRUD、任务拆分、AI 智能拆解与智能分组）、`pages/progress/main`（汇报与评论）、`pages/chat/main`、`pages/files/main`、`pages/devices/main`。
- 考勤：`pages/attendance/main`，含今日打卡、签到码、近 14 天、请假/补签、签到码发布、请假审批、代签、月度统计和规则设置。
- 周期打卡：`pages/checkin/main`，待办/任务/看板/排行四 Tab，覆盖补交、自评、组长评分、精选与优秀墙。

### packageSocial（4 页）

- `pages/notifications/main`：系统通知、评论、点赞、收藏和未读状态。
- `pages/friends/main`：好友、申请、搜索。
- `pages/dm/main`：私信轮询、已读状态。
- `pages/feedback/main`：意见反馈。

### packageShare（6 页）

- `pages/posts/main`：资源分享列表、排序、标签、分页。
- `pages/post/detail`：帖子详情、Markdown、附件、点赞、收藏、评论、编辑、开源/私密切换、项目文件删除、删帖。
- `pages/post/publish`：发布/编辑图文附件分享，图片以 base64 契约提交。
- `pages/library/main`：个人资源库，multipart 上传、配额条、站内/飞书分享链接生成与撤销、删除、鉴权下载预览。
- `pages/honor/main`：公开荣誉墙，免登录可读。
- `pages/user/main`：公开用户主页、小组/备赛/学习进度、加好友。

### packageOps（8 页）

- 报销：`pages/expense/list`、`pages/expense/detail`。小程序移植负责人视角（建项目、队伍、成员、重置认领、分组合计、附件查看与项目删除）；成员匿名认领仍建议走 H5。
- 采购：`pages/purchase/list`、`pages/purchase/detail`、`pages/purchase/create`。支持档案 CRUD 与关闭重开、审批人管理（用户搜索/负责人/老师）、申请、审批/驳回、购买截图与发票 multipart 上传及删除、个人/全档案统计。
- 资源预约：`pages/booking/projects`、`pages/booking/detail`、`pages/booking/mine`。支持项目设置、资源 CRUD/归档/恢复、30 分钟整点预约、提交前实时冲突预检、先到先得/审批制、审批、取消、时段总览（甘特数据降级列表）和预约详情轨迹。

### packageAdmin（1 页，4 个 Tab）

- `pages/review/main`：待审竞赛采纳/删除；用户搜索、封禁/禁言/解除限制；反馈查看与删除；公告增删改和置顶。无对应权限的 Tab 按后端 403 静默置空。

## 3. 本地开发

```bash
cd miniprogram
npm install
npm run dev:mp-weixin      # watch，产物：dist/dev/mp-weixin
npm run build:mp-weixin    # 生产构建，产物：dist/build/mp-weixin
```

1. 打开微信开发者工具，选择「导入项目」。
2. 开发阶段可导入 `dist/dev/mp-weixin`；发布验收导入 `dist/build/mp-weixin`。
3. 没有正式 AppID 时可使用测试号；正式 AppID 填入 `src/manifest.json` 的 `mp-weixin.appid`。
4. 后端地址在 `src/env.js` 唯一配置：模拟器单机可用 `http://localhost:3000`；**真机调试必须改成电脑局域网 IP**（如 `http://192.168.1.121:3000`，`ipconfig` 查看，换网络后同步修改），手机与电脑连同一 Wi-Fi。开发者工具勾选「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」（manifest 已设 `urlCheck:false`，真机调试模式生效；预览/体验版需 HTTPS 合法域名）。Windows 防火墙需放通 Node.js 入站（首次弹窗点允许，或在高级防火墙中确认 Private/Public 入站规则）。
5. 启动后端：

```bash
cd ../backend
npm install
npm start
```

## 4. 后端联调与微信登录

唯一 API 地址入口：`src/env.js`。

```js
// 三档环境，切换 src/env.js 后重新构建（dev/build 两个产物目录都要编译）
// 线上（当前默认）：https://gkjsdh.xyz —— 已部署微信路由，HTTPS+备案，提审/体验/真机调试均用它
// 局域网真机：http://192.168.1.121:3000（电脑 npm start，手机同 Wi-Fi）
// 模拟器单机：http://localhost:3000
export const BASE_URL = 'https://gkjsdh.xyz';
export const API_BASE = `${BASE_URL}/api`;
```

服务器部署要点（2026-11-06 已上线微信路由）：后端由 root 的 PM2 进程 `compass` 托管（`sudo pm2 restart compass`）；`routes/wechat.js` 上线后 `user` 表经 `database.js` 迁移链自动加 `wechat_openid` 列与部分唯一索引；服务器未设 `NODE_ENV`，故 mock 联调可用，配好 `WECHAT_APPID/WECHAT_SECRET` 后自动切真实 `jscode2session`；预览/体验版需在微信公众平台把 `https://gkjsdh.xyz` 加入 request/uploadFile/downloadFile 合法域名。


> Windows 开发机注意：pdfjs 5 的 legacy 构建在模块加载期需要 `DOMMatrix/ImageData/Path2D`，缺少 `@napi-rs/canvas` 的 win32 原生绑定时会让整个后端启动即崩。`backend/lib/pdf-dom-shim.js` 已在 `pdfDoc.js`/`importPlan.js` 引入 pdf-parse 前注入最小垫片（有真绑定时不覆盖），仅 PDF 光栅化降级，文字层解析与全部非 PDF 路由不受影响；Linux 服务器行为不变。


微信相关路由：

- `GET /api/auth/wechat-status`：查询后端是否配置微信凭证、mock 登录是否可用。
- `POST /api/auth/wechat-login`：`{ code }`；已绑定直接返回 token，未绑定返回 `need_bind` 和一次性 `bind_ticket`。
- `POST /api/auth/wechat-bind`：支持密码绑定、邮箱验证码绑定、注册新账号后绑定。

后端未配置 `WECHAT_APPID` / `WECHAT_SECRET` 且非生产环境时，小程序会自动生成并持久化 `mock:dev_*` code 做端到端联调；同设备重复登录会映射到同一个 mock openid，生产环境会拒绝 mock code。密钥只能保存在后端 `.env`，不能写进小程序。

## 5. 关键实现约束

- `uni.*` 调用参数保持普通对象，避免在注入参数中使用可选链或对象展开。
- 弹窗使用遮罩 `@click` 关闭、内部 `@click.stop` 阻止冒泡。
- 递归组件显式 `import` 自身。
- `wx.request` 单次请求最长 60 秒，AI 接口统一设置 60 秒超时。
- base64 附件契约为 `{ name, size, mime, data }`，`data` 不带 data URL 前缀；图片 data URL 可直接交给 `image` 组件渲染。
- multipart 上传（采购截图/发票、个人资源库）统一走 `utils/upload.js` 的 `wx.uploadFile`，字段名 `file`；发票支持拍照/相册与聊天记录 PDF 两个来源。
- 主包页面引用工具/组件使用 `../../`，分包页面使用 `../../../`。
- 后端实名门禁返回 403 且 `code === 'need_real_name'` 时，由 `request.js` 统一弹窗引导实名认证。
- 预约、报销、采购三个模块均以后端真实姓名门禁为准。

## 6. 隔离 smoke 验收

本地已用数据库副本和临时 PDF loader 做过零污染 smoke：不触碰 `backend/data/compass.db`。主冒烟 `smoke-miniprogram.mjs` 覆盖 117 个断言，补充冒烟 `smoke-new-features.mjs` 覆盖 69 个断言（共 186 个），包括：

- 注册、实名、会话、微信 mock 登录与绑定。
- 备赛日程、学习计划、每日笔记。
- 小组、考勤规则、签到码、请假审批、补签任务。
- 好友、私信、通知、反馈。
- 发帖、点赞、收藏、评论、公开用户主页、荣誉墙。
- 公告和待审竞赛管理入口。
- 预约项目/资源/审批制/先到先得/冲突预检/资源编辑归档/时段总览/我的预约。
- 采购档案/审批人/申请/审批/驳回/统计/截图与发票 multipart 上传删除。
- 报销项目/队伍/成员/认领重置。
- 资料（昵称/头像/手机号）、用户封禁禁言、反馈处理、个人资源库、AI 任务拆解。

Windows 本地若遇到 `DOMMatrix is not defined`，来自 `pdfjs-dist` 的可选原生画布依赖 `@napi-rs/canvas` 缺失；Linux 生产环境安装完整依赖后不受影响。本地 smoke 可临时桩掉 `lib/pdfDoc.js` 与 `pdf-parse`，只验证非 PDF 解析业务链。

## 7. 刻意不移植的 H5 能力（保留在网页版）

小程序以移动端高频场景为边界，下列后端能力已封装但刻意不接线（审计 `audit-api-usage.mjs` 的 unused 白名单）：

- 邮箱密码注册/登录/改密/重置/换绑：小程序以微信一键登录为主，账号体系仍与 H5 互通。
- Ghost 幽灵帖巡检、Gitee 仓库树与一键同步、飞书深度绑定：桌面管理/外部集成场景。
- 公开 slug 主页（`/share/u/:username`、`/share/p/:username/:slug`）：面向搜索引擎的外部门户，小程序内用 id 制 `userPublic`/`sharePost` 等价页面替代。
- `teamInvite`：邀请码已随小组详情内联返回，无需单独拉取；`attendanceRedeem` 与签到码打卡（`checkin` 带 `code`）同逻辑，保留单入口；`teamMyTasks` 的聚合能力已被 `/schedule/calendar` 月历覆盖；`shareComments` 是帖子详情接口的别名，评论随详情返回。
- `collabMessageUpdate`：H5 同样未启用消息编辑，组内聊天保留长按删除。

## 8. 上线 checklist

- [ ] `src/manifest.json` 填入真实 `mp-weixin.appid`。
- [ ] `src/env.js` 的 `BASE_URL` 改为 `https://gkjsdh.xyz`。
- [ ] 微信小程序后台配置 request、uploadFile、downloadFile 合法域名。
- [ ] 后端 `.env` 配置 `WECHAT_APPID`、`WECHAT_SECRET`，并确认 HTTPS 证书有效。
- [ ] 完成小程序主体注册、备案、服务类目、隐私保护指引和用户授权说明。
- [ ] UGC 场景接入微信内容安全检测（文本/图片）并保留举报入口。
- [ ] 用微信开发者工具重新检查主包/整包体积、弱网、超时、登录失效和实名门禁。
- [ ] 真机验证拍照/选图、文件预览、下载、下拉刷新、分页和 60 秒 AI 超时提示。
- [ ] 发布前再次执行 `npm run build:mp-weixin`，导入 `dist/build/mp-weixin` 上传体验版。

