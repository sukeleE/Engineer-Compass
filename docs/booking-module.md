# 资源预约模块（/booking）技术文档

2026-10-15 落地。导航项「🏢 资源预约」，路由 `/booking`（大厅）与 `/booking/:id`（项目页）。后端挂 `/api/booking`（避开已占用的 `/api/resource`），表前缀 `booking_`，新表编号 **53–59**（schema.sql 末尾 `IF NOT EXISTS` 追加，冷启动自动建表）。同日简化：资源五分类收敛为两类，`backend/db/database.js` 用 `PRAGMA user_version=2` 闸门做一次性存量回填（lab/classroom→space、prop/equipment/instrument→item，先探测表存在，老库零影响）。2026-11-11 增强：表格导入上限由 10MB/200 行放宽到 **100MB/2000 行**；一个 Excel 的多个工作表（Sheet）按表名分组导入（`booking_resource.group_name`，取 Sheet 名），Web/小程序均按组折叠展示、结构与原表一致，组可整组重命名；资源唯一约束随之由 `UNIQUE(project_id,name)` 放宽为 `UNIQUE(project_id,group_name,name)`（不同房间允许同名设备，组内仍唯一），老库启动时走守卫式表重建迁移（见 §3）。

## 1. 领域与口径

- **实名认证硬门禁（2026-10-16）**：资源预约、经费报销、物料采购三个模块的全部端点要求账号已在账号安全页填写真实姓名（`user.real_name`，2–20 字中英文），未实名一律 403 `{code:'need_real_name'}`，**管理员不豁免**；唯一白名单是预约模块 `POST /projects/:id/conflicts`（弹窗内实时冲突预检，不泄密）。报销的匿名邀请面 `/api/expense/o/*`（凭邀请码只读/认领/下载/导出）不挂门禁。前端 `/booking`、`/purchase` 路由 `meta.requiresRealName` 守卫先于页面挂载拦截，弹不可关闭的实名弹窗；未实名用户每人一条 `personal_notice(type=realname_required, link=/account-security)`，实名后自动已读。三模块内人员署名统一为「真名（昵称）」，由 `displayNameOf()`（后端 middleware.js，前端 utils/displayName.js 同口径）在**写库瞬间生成快照**（booker_name/owner_name/applicant_name/actor_name 等），读取端原样渲染快照，不再 JOIN 实时真名二次组合；昵称本身已含真名时（如「张玉磊（284806020）」）直接用昵称，避免叠成「张玉磊（张玉磊（284806020））」。历史快照不回溯。实时 user 对象（选人下拉、审批人、登录本人）仍按当前真名/昵称即时组合。
- **项目（booking_project）**：登录用户可建；建档者即负责人（`created_by`），管理员管全部（同物料采购口径）。项目只关不删（无 DELETE 端点）。
- **两类资源**：📦 **物品资源** `kind=item`（is_space=0，按数量库存池共享）；🏢 **空间资源** `kind=space`（is_space=1，同一时段独占、按容量限人数）。`is_space` 是冲突/容量/库存逻辑的唯一依据，kind 仅用于展示/分组/过滤且与 is_space 一一对应（资源创建后二者均不可变）。资源被预约引用后只能归档不能硬删（DELETE 409）。
- **审批模式在资源级**：每个资源 `approve_mode = approval | first_come`。`first_come` 不冲突即 confirmed；`approval` 落 pending 待负责人/管理员审批。项目上的 `default_approve_mode` 只作新资源表单预填；切换不追溯历史单。
- **pending 即占位**：冲突检测的 BLOCKING 集合 = pending+confirmed。甘特实时显示申请中琥珀斜纹块；驳回/取消立即释放槽位。取舍：宁可让后申请者看到占用改时间，也不要"先批先得、后批者被拒"。v1 不做 pending 超时自动释放。
- **固定组队模块内自建**（booking_team / booking_team_member），与现有项目小组（team/team_member）完全不耦合；下单瞬间成员快照固化进 booking_participant，之后改队/删队不影响历史预约。
- **可见性**：登录用户可见所有开放项目与占用；关闭项目仅负责人、管理员、在该项目有预约者可见（无权统一 404 防探测）。
- **临时选人全站可搜**（不依赖好友关系）。
- 与小组域简版设备预约（表16 `device` / 表17 `device_booking`、teamCollab.js、TeamDevices.vue）**完全独立，互不读写**。

## 2. 时间语义（最容易踩坑的部分）

- 存北京时间**朴素字符串** `'YYYY-MM-DD HH:MM'`（start_time/end_time），定宽字符串直接做半开区间字典序比较：`start_time < :end AND end_time > :start`。**首尾相接不冲突**。
- 前端用本地 `new Date(y, m-1, d, H, M)` 解析，**禁止补 Z / toISOString / toLocal**；后端用 `new Date(str.replace(' ','T')+'Z')` 仅做墙上时钟算术。前提：部署机 TZ=Asia/Shanghai（与 device_booking 同）。
- 30 分钟一格；每天开放 **07:00–22:00**（30 格）；支持**跨天连续预约**，最长 7 天。跨天规则：首日 start ∈ [07:00, 21:30]、末日 end ∈ [07:00, 22:00]、中间完整自然日不限；start 不得早于当前格。
- 甘特把夜段（22:00→次日 07:00）**折叠**在日界线两侧：`col = dayDiff*30 + (分钟-420)/30`，跨天块天然跨列连续渲染；从一天末尾反向拖到次日开头即跨天单。
- 审计时间用 `datetime('now','localtime')`。

## 3. 数据表（53–59）与级联

| # | 表 | 要点 |
|---|---|---|
| 53 | booking_project | name UNIQUE、description、default_approve_mode（仅预填）、status open/closed、created_by→user **SET NULL**、close_time |
| 54 | booking_resource | project_id **RESTRICT**、kind（item/space）、is_space（0/1，业务真值）、name、spec、location、**group_name（表格导入分组=工作表名，''=未分组/手动建）**、capacity（空间）、quantity（物品）、unit、params JSON（空间存 `{"equipment":[...]}`）、image、damaged_qty、approve_mode、status active/archived、is_carrier、created_by SET NULL、**UNIQUE(project_id,group_name,name)**；索引 idx_bk_resource_pgroup(project_id,group_name) |
| 55 | booking_team | project_id **CASCADE**、name、owner_id SET NULL、owner_name、UNIQUE(project_id,name) |
| 56 | booking_team_member | team_id CASCADE、user_id CASCADE、user_name 快照、ord；PK(team_id,user_id) |
| 57 | booking | project_id/resource_id **RESTRICT**；start_time/end_time、qty（空间恒1）、headcount、purpose、status、source(solo/team/custom)、team_id **SET NULL**、booker_id CASCADE + booker_name 快照、审批三字段、取消三字段 |
| 58 | booking_participant | booking_id **CASCADE**、user_id CASCADE、user_name 快照、is_booker、ord、UNIQUE(booking_id,user_id) |
| 59 | booking_log | booking_id **CASCADE**、action(created/approved/rejected/canceled)、actor_id/name、comment |

项目/资源 RESTRICT（项目只关不删、资源只归档）；组队/成员/参与人/日志 CASCADE；删用户：其预约 CASCADE、名下项目保留（created_by SET NULL）。

- **2026-11-11 分组迁移（老库冷启动自动执行，新库守卫跳过）**：`migCol` 先补 `group_name TEXT NOT NULL DEFAULT ''`；随后读 `sqlite_master` 中的建表 DDL，仅当正则命中旧约束 `UNIQUE (project_id, name)` 才做一次性表重建——先 `PRAGMA foreign_keys=OFF`（连接级 PRAGMA 不能在事务内切），事务内建 `booking_resource_new`（新约束）、**显式带 id 逐列搬运**保证 booking 外键不断、DROP+RENAME、重建 pstatus/pkind/pgroup 三个索引，COMMIT 后恢复 foreign_keys 并跑 `PRAGMA foreign_key_check`，有残留即抛错阻止启动；异常路径 ROLLBACK 并恢复 PRAGMA。

## 4. 状态机与并发

```
first_come 资源：POST /bookings ──不冲突──▶ confirmed（冲突 409，不建单）
approval 资源：POST /bookings ──▶ pending ──通过──▶ confirmed
                                   ├──驳回(理由必填)──▶ rejected
                                   └──取消──▶ canceled
confirmed：预约者开始前可取消（已开始→400 提示联系负责人）；负责人/管理员可随时强取消
```

- 不提供编辑，改约＝取消重约。
- **TOCTOU 防护**：所有写操作用手写 `BEGIN IMMEDIATE` 事务（node:sqlite 无 db.transaction），冲突检测与 INSERT 在同一事务回调内；审批通过在事务内**复检冲突**（pending 期间可能已有 confirmed 单），复检失败 409。
- **冲突算法**：
  - 空间：存在 BLOCKING 重叠行即 409；`headcount ≤ capacity` 否则 400。
  - 物品：按 30 分格循环（≤7×48 格，prepared 复用）`SUM(qty)`，任一格 `used+qty > quantity` 即 409，回传首个冲突格 `{start_time,end_time,used,capacity}`；qty 越界 400。
- 资源编辑**下调 capacity/quantity 时对现存 BLOCKING 占用复检**，否则 409，杜绝甘特出现负容量。
- 自审批禁令：负责人不能审自己的单（403），admin 豁免；无权对象一律 404。

## 5. 端点表（/api/booking，全部需登录且已实名；`POST /projects/:id/conflicts` 只需登录）

| 方法/路径 | 说明 |
|---|---|
| GET /projects?scope=all\|mine\|managed | 列表项带 myRole/canManage/resource_count/pending_count/my_booking_count；closed 按可见性过滤 |
| POST /projects | 201，重名 409 |
| GET /projects/:id / PUT /projects/:id | 详情 / 改名说明默认模式状态 |
| GET /projects/:id/resources?status=&kind= | 资源列表（kind=item\|space） |
| POST /projects/:id/resources | 白名单归一：space 强制 capacity、quantity=1；item 强制 quantity、capacity=NULL |
| POST /projects/:id/resources/bulk | 类型表单批量（≤2000 行），整体事务，坏行 400「第 N 行」回滚，组内（project_id+group_name+name）重名 409 |
| POST /projects/:id/resources/parse-import | multipart（字段 file+kind），表格只解析不落库，返回 `{items,warnings,source}` 供预览核对（见 5.1） |
| GET /projects/:id/resources/import-template?kind= | 下载 xlsx 导入模板（仅表头无示例行），filename* 为 UTF-8 中文名 |
| PUT/DELETE /resources/:rid | 编辑（kind/is_space 不可变，下调容量库存复检）；无引用才允许 DELETE |
| POST /resources/:rid/archive \| /restore | 归档/恢复 |
| POST /projects/:id/resource-groups/rename | 分组重命名（body `{from,to}`，to 非空≤30 字），整组批量改 group_name；目标组内同名资源 409，审计 booking-group-rename |
| GET/POST /projects/:id/teams，PUT/DELETE /teams/:tid | 组队（可查看项目即可建队；只有队长/负责人可改删，历史快照不回改） |
| GET /users/search?q= | 全站用户模糊（排自己、排封禁，LIMIT 10） |
| POST /projects/:id/conflicts | **只检不写**，同 /bookings 入参；弹窗 400ms 防抖实时校验 |
| POST /projects/:id/bookings | 下单，按资源模式落 confirmed/pending |
| GET /projects/:id/bookings?from&to&resource_id&status&mine=1 | 预约列表（LIMIT 500，bookingOut 带 perm 位） |
| GET /projects/:id/timeline?from&days=7&all=1 | 甘特契约（见下） |
| GET /bookings/mine | **必须声明在 /bookings/:id 之前**；booker 或 participant，倒序 200 |
| GET /bookings/:id | {booking, logs}，聚合资源/项目名/参与人当前头像/perm |
| POST /bookings/:id/approve \| /reject \| /cancel | approve 事务内复检；reject reason 必填≤200；cancel 按身份与开始时间分流 |

错误处理：路由末尾 HttpError → JSON，409 透出 `conflicts[]`；表格解析的 BookingImportError → 400 中文文案；multer LIMIT_FILE_SIZE → 413「文件过大（表格文件 ≤100MB）」。

### 5.1 表格导入（xlsx/xls/csv）

沿用采购 BOM 的「**上传只解析预览 → 用户核对 → 走现有 bulk 事务入库**」模式，parse-import 不做任何校验、不写库：

- 解析器 `backend/lib/bookingImport.js`（中性 CSV 工具 `lib/csvText.js` 与 BOM 识别共用，支持引号内逗号/换行、utf8 致命失败回落 GBK、剥 BOM）；multer memoryStorage 不落盘，单文件 ≤100MB（`BOOKING_IMPORT_LIMIT_BYTES`，超限 413），扩展名白名单 .xlsx/.xls/.csv；规则/标准解析单文件最多 2000 行（`BOOKING_IMPORT_MAX`，超出截断+warning），AI 通道单独 500 行预算（`AI_PAYLOAD_MAX_ROWS`，超限提示删表分批）。
- **表头启发式**：在前 5 行打分定位（名称列命中=10 分必须，其余每列 +1，同分取靠上）。别名：名称/资源名称/物品名称/空间名称…；空间认 位置/房间号/教室、容量/可容纳人数、室内设备/设备清单；物品认 规格型号、库存数量/库存、单位、存放位置；审批方式/预约方式 两类通用。表头前允许有标题行等垃圾行。
- **跳过规则**：空名行、合计/总计/小计/共计行、名称列纯数字的序号残留行均跳过并汇总 warning；设备文本按 `[,，、;；/／换行]` 多分隔符切分。
- **坏值不兜底**：capacity/quantity 原样字符串透传（''/'abc' 不默认 30/1），核对后提交时由 bulk 报「第 N 行」——预览行号与 bulk 行号严格一致（表头是第 0 行，不计行号）。
- 审批词归一（需审批/先到先得/免审），无法辨认置空并 warning，落库时回落项目默认；一次最多 2000 条，超出截断 + warning；只有表头没有数据行时返回 200 + 空 items + 提示（不是错误）。
- 前端 `ResourceImportDialog`（Web）/ `ResourceImport.vue`（小程序）：下载模板（blob，token 只走头）、隐藏 file input 选表、el-alert 列 warnings；按工作表用**顶部分组标签页**预览（横向滚动，标签带条数/异常红点/排除置灰，点击切换，一次只渲染当前组表格避免大表堆叠），支持整组勾选排除、组名就地编辑、空 Sheet 标签空态提示，解析行可继续手改且切组不丢输入；**整组排除后该组不参与校验与提交**（重名/字段红标随排除清除、标签红点隐藏，适合排除「总表/汇总」类工作表），footer 按**有效行（名称非空）**计数，提交带 group_name；切类型/重开弹窗清空。资源面板 `ResourcePanel.vue` / 小程序详情页按「分组→物品/空间→卡片」三级渲染，负责人可整组重命名。
- **多工作表分组（2026-11-11）**：`recognizeBookingXlsx` 遍历工作簿全部 Sheet，每行附 `_sheet/_sheet_index`；入库时 group_name 取工作表名（手动传入优先），资源列表按 `group_name` 分组、组内再按 item/space 展示，空 Sheet 保留为 0 条分组（解析器 `buildRuleGroups` 覆盖全部工作表；路由层 `enrichBookingImportItems` 合并 `out.groups`，保证无 item 也无 skipped 的纯空表不丢标签，AI 通道无 groups 时回落按 items/skipped 重建）。单个 Sheet 损坏/无表头只告警跳过，不拖垮整文件。标准台账（如实验室设备出入登记表）走 `detectStandardBookingSheets` 规则解析不调 AI：「资产编号」台件明细块整块跳过（与汇总行重复）、「家具类」分段标题跳过、有数量无容量强制 item；AI 通道 `ruleParseMixedSheets` 同口径并输出 `groups` 摘要（每组条数/跳过数）。前端默认走 `POST .../auto-parse`（AI 失败自动回落规则解析，300s 超时）。
- 模板仅表头无示例行（示例行会被原样导成垃圾资源）。

## 6. timeline 契约与甘特算法

`GET /timeline?from=YYYY-MM-DD&days=7`（from 默认本周一，days≤14）：

```json
{ "from": "...", "days": 7, "win_start": "... 07:00", "win_end": "... 22:00",
  "slot_minutes": 30, "open": "07:00", "close": "22:00", "slots_per_day": 30,
  "resources": [ /* resourceOut，含 is_space/params/approve_mode，默认仅 active */ ],
  "bookings": [ /* 与窗口半开相交；默认仅 pending/confirmed，all=1 含终态；
                   mine 标记，participants 带当前 avatar */ ] }
```

前端 WeekGantt（自研，无 fullcalendar）：

- 一张 CSS grid：`176px repeat(210,minmax(20px,1fr))`，并显式 `min-width: calc(176px + 210*20px)`（不能写 100%：会顶替 min-content 把网格盒压成视口宽，横向滚动后 sticky 左列被钉在过窄容器盒右缘而裁切）；sticky 角/日表头/资源名列；时刻线走背景 repeating-linear-gradient（日界深、小时线浅）。
- 物品资源在背景格层按格 Σqty 渲染**库存热度**（半占 amber / 约满 red），空间不渲染热度。
- 块层 absolute 定位（left/width 按列百分比），重叠块做**贪心泳道**（半开区间，首尾相接可同泳道），行高随泳道数。
- 块内容：预约人 + `👥headcount/容量` 或 `×qty`，宽 ≥5 格显示时长中文标签（90分钟/2.5小时/3天2小时）；title 属性含完整信息与用途。
- 配色：confirmed 蓝、pending 琥珀斜纹、rejected/canceled 灰虚线（「历史」开关拉 all=1）、我的块主色 inset 描边、过去块降透明度；当前时刻红线每分钟刷新。
- pointerdown→move→up 吸附 30 格拖选（可跨天、可反向），单击=1 格；点块开详情。
- ≤768px 降级：日期 select + 资源 el-collapse，当日预约 chip 列表，建约走 BookingDialog 表单模式（initial.manual）。

## 7. 通知矩阵（personal_notice，COMMIT 后 try/catch 插入）

`type = bk_<action>_<bid>` 做同单同动作未读去重；link 统一 `/booking/<pid>?bid=<bid>&date=<YYYY-MM-DD>`（项目页自动弹详情并定位周）。

| 时机 | 接收人 | type |
|---|---|---|
| approval 资源提交 | 项目负责人（本人申请则跳过，不骚扰管理员） | bk_submit |
| 通过/驳回（驳回带理由） | 预约者+全部参与人（操作者除外） | bk_approve / bk_reject |
| 预约者取消 | 其余参与人 | bk_cancel |
| 负责人/管理员强取消 | 预约者+全部参与人 | bk_force_cancel |
| first_come 即确认 | 其余参与人 | bk_confirm |

铃铛 unread-count 自动含 personal_notice，消息中心无需改动。

## 8. 测试

- `npm run smoke:booking` —— 自起沙盒后端（3107、mkdtemp、env 白名单、cwd 临时目录避 .env、taskkill 收尾），**134 项**：建档/资源两类（item/space）/bulk/表格导入（xlsx 垃圾行+别名表头（含「品名」）+设备多分隔符、坏容量透传、UTF-8/GBK CSV、**2005 行截断为 2000**、无表头/空表、.txt/无 file/坏 kind/403/401/404/**101MB 413**、两 kind 模板 PK 魔数与表头精确断言、重名 409 行号）/**多 Sheet 分组 10 项**（standard_item 命中不调 AI、分组摘要含空表 0 条、**纯空 Sheet 经路由合并保留 0 条分组**、资产明细块/分段标题跳过且跨组同名保留、跨组同名 bulk 201、同组同名 409、分组重命名 200 与回显、重命名撞名 409、非负责人 403）/归档/组队/时间窗/空间独占/物品池/资源级双模式/取消/多人/timeline/通知去重/外键级联。
- `npm run probe:booking-ui` —— Playwright（3108+5199、PROBE 临时库、双 context 演 A/B/C），**47 项**：建项→建空间/物品资源→甘特拖格 pending 块定位→重叠实时 409 禁用提交→临时搜非好友 C→固定组队下单→C 的 mine→先到先得蓝块+库存热度+超量拦截→审批变蓝→C 收通知点 link 自动弹详情→390px 手风琴建约无横溢→表格导入（分裂下拉入口、模板 download 事件、CSV 标签预览回填断言、多 Sheet xlsx 三标签（含空表空态）/逐标签行数与跨组同名/切组编辑值保留/排除标签置灰/整组排除恢复、分组落库新卡、**7d 含重名红行的总表：排除前拦截→整组排除后红点红标消失并仅落其余组**）→无 pageerror/无意外 4xx5xx（有意的 `/conflicts` 4xx 放行）。注意：C 盘空间不足时须把 TEMP/TMP 重定向到其他盘再跑，否则 vite 临时文件写满会间歇白屏。
- 回归：smoke:repo / smoke:account / vite build 全绿；依赖 :3000 dev server 的既有冒烟（purchase 等）未在沙盒跑，booking 挂载不改动其代码路径。
