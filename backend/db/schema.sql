-- Engineer-Compass 工科竞赛导航系统 数据库结构（SQLite）
-- 版本 0.1 · 2026-08-23

-- 表1 competition 竞赛总表
CREATE TABLE IF NOT EXISTS competition (
  id             INTEGER PRIMARY KEY,          -- 竞赛唯一编号（沿用排行榜序号 1-84）
  name           TEXT NOT NULL,                -- 竞赛全称
  short_name     TEXT,                         -- 简称（电赛、智能车…）
  type           TEXT,                         -- 赛道分类：电子机器人/机械/综合/数学基础/设计艺术/经管商科/医学技能
  start_month    INTEGER,                      -- 启动月份(1-12)，时间轴排布用
  sign_start     TEXT,                         -- 报名开始（"约5-6月"等原文）
  sign_end       TEXT,                         -- 报名截止
  province_time  TEXT,                         -- 省赛时间
  national_time  TEXT,                         -- 国赛/总决赛时间
  timeline_raw   TEXT,                         -- 时间线原始文本（含"（时间可能逐年变动）"标注）
  cycle          TEXT,                         -- 举办周期（每年一届/两年一届…）
  difficulty     INTEGER,                      -- 难度星级 1-5
  intro          TEXT,                         -- 竞赛简介
  suitable_major TEXT,                         -- 适合专业
  team           TEXT,                         -- 组队人数
  source_type    TEXT DEFAULT 'official',      -- 数据来源：official / user_added / ai_search
  source_url     TEXT,                         -- 信息来源链接（AI收录必须带，否则拒绝入库）
  official_url   TEXT,                         -- 竞赛官网（人工核验，弹窗基础信息页展示）
  status         TEXT DEFAULT 'active',        -- active正式数据 / pending待审核草稿
  data_year      INTEGER,                      -- 信息对应年份（隔年提示可能过时）
  confidence     REAL,                         -- AI自评置信度(0-1)
  create_time    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 表2 competition_process 备赛流程/子赛项表（每个子赛项=一个阶段条目）
CREATE TABLE IF NOT EXISTS competition_process (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  comp_id         INTEGER NOT NULL REFERENCES competition(id) ON DELETE CASCADE,
  phase_name      TEXT,                        -- 子赛项/阶段名称（本科组-电源类…）
  phase_desc      TEXT,                        -- 赛制与规则
  suggest_month   INTEGER,                     -- 建议开始月份
  check_standard  TEXT,                        -- 本阶段达标要求
  sub_event_order INTEGER                      -- 子赛项展示序号
);

-- 表3 tech_stack 技术栈树状表（递归结构，支持无限层级）
CREATE TABLE IF NOT EXISTS tech_stack (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  comp_id    INTEGER NOT NULL REFERENCES competition(id) ON DELETE CASCADE,
  process_id INTEGER REFERENCES competition_process(id) ON DELETE CASCADE,  -- 所属子赛项（根节点=子赛项名）
  parent_id  INTEGER DEFAULT 0,               -- 父节点id，根节点=0
  node_name  TEXT,                            -- 技术名称（STM32、PCB设计…）
  node_desc  TEXT,                            -- 说明/推荐学习工具
  level      INTEGER                          -- 层级（1=根）
);

-- 表4 user_schedule 用户日程表
CREATE TABLE IF NOT EXISTS user_schedule (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  comp_id     INTEGER REFERENCES competition(id) ON DELETE CASCADE,
  user_id     TEXT DEFAULT 'local',           -- 简易版无登录，前端 LocalStorage 同步的标识
  is_custom   INTEGER DEFAULT 0,              -- 是否手动修改过日程（1=是）
  plan_json   TEXT,                           -- 完整备赛计划 JSON
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 表5 media_resource 学习资源表（视频/文章链接，弹窗展示）
-- category: intro 竞赛介绍 / process 备赛流程 / knowledge 知识点（关联技术栈）
-- platform: bilibili/zhihu/csdn/wechat/douyin/cnki/github/tencent/robomaster
CREATE TABLE IF NOT EXISTS media_resource (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  comp_id      INTEGER NOT NULL REFERENCES competition(id) ON DELETE CASCADE,
  category     TEXT NOT NULL,                 -- intro / process / knowledge
  platform     TEXT NOT NULL,                 -- 平台标识
  title        TEXT,                          -- 展示标题（关键词）
  keyword      TEXT,                          -- 搜索关键词
  url          TEXT NOT NULL,                 -- 完整链接（平台搜索模板或人工核实链接）
  tech_node_id INTEGER,                       -- 关联技术栈节点（knowledge 类）
  source_type  TEXT DEFAULT 'search',         -- search=平台搜索模板 / manual=人工核实
  create_time  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 表6 user_study 学习日程表（AI 学习日程：与竞赛无关的技能/知识点学习计划）
CREATE TABLE IF NOT EXISTS user_study (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES user(id) ON DELETE SET NULL,  -- 登录用户绑定（小组计划同步用；匿名创建为 NULL）
  topic       TEXT NOT NULL,                -- 学习主题（用户输入）
  level       TEXT,                         -- 当前水平（零基础/入门/进阶）
  goal        TEXT,                         -- 学习目标（选填）
  hours       INTEGER,                      -- 每周可投入小时数
  plan_json   TEXT,                         -- AI 生成计划（summary/phases[]/resource_keywords[]）
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ========== 项目小组模块（用户/权限/进度/讨论/资料/设备） ==========

-- 表7 user 用户表（登录）
CREATE TABLE IF NOT EXISTS user (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,          -- 登录名（唯一；注册时由邮箱前缀自动生成）
  password_hash TEXT NOT NULL,                 -- scrypt: salt$hash(hex)
  nickname      TEXT,                          -- 昵称
  email         TEXT,                          -- 邮箱（登录/绑定；唯一索引允许多 NULL）
  avatar        TEXT,                          -- 头像（128px JPEG 压缩 dataURL，~10-20KB）
  is_admin      INTEGER DEFAULT 0,             -- 系统管理员（可进管理端）
  is_ghost      INTEGER DEFAULT 0,             -- 幽灵模式（秘密通道「水手冰淇淋」激活，仅幽灵可见内容）
  password_set  INTEGER NOT NULL DEFAULT 1,    -- 1=已设自有密码 0=初始密码 gkjsdh123 待修改（邮箱验证码注册为 0）
  phone         TEXT DEFAULT '',               -- 手机号（本期仅号段校验、未接 SMS，phone_verified 恒 0 预留）
  phone_verified INTEGER NOT NULL DEFAULT 0,
  real_name     TEXT NOT NULL DEFAULT '',      -- 真实姓名（预约/报销/采购三模块硬门禁；空=未实名）
  create_time   DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- idx_user_phone 部分唯一索引在 database.js 迁移链创建（老库 phone 列后补，建索引须在 migCol 后）

-- 表19 email_code 邮箱验证码（登录/注册/绑定邮箱用，一次性、10分钟过期）
-- （user.email 唯一索引在 database.js 迁移链后创建，兼容老库先 ALTER 再加列的启动顺序）
CREATE TABLE IF NOT EXISTS email_code (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL,                   -- 收件邮箱
  code          TEXT NOT NULL,                   -- 6 位数字验证码
  purpose       TEXT NOT NULL,                   -- login / register / bind（bind=绑定/更换邮箱）
  expire_at     INTEGER NOT NULL,                -- 过期时间戳（epoch ms）
  created_at_ms INTEGER NOT NULL,                -- 发送时间戳（epoch ms，冷却判断用）
  create_time   DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_email_code ON email_code(email);

-- 表8 session 登录会话（Bearer token）
CREATE TABLE IF NOT EXISTS session (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 表9 team 项目小组
CREATE TABLE IF NOT EXISTS team (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  desc        TEXT,
  invite_code TEXT UNIQUE,                     -- 邀请码（加入小组）
  owner_id    INTEGER NOT NULL REFERENCES user(id),  -- 组长（拥有全部权限）
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 表10 team_role 自定义角色（高自由度：组长可自建任意角色 + 勾选权限）
-- permissions 为 JSON 数组，可用键：
--   task 任务管理 / progress 进度汇报 / message 发消息 / file_upload 上传资料
--   file_delete 删除资料 / device 设备管理 / device_approve 预约审批
--   member 成员管理 / role 角色管理 / team 小组设置
CREATE TABLE IF NOT EXISTS team_role (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id     INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,                   -- 角色名（组员/机械组组长/资料管理员…）
  level       INTEGER DEFAULT 0,               -- 等级数值（越高越大，展示用）
  permissions TEXT NOT NULL DEFAULT '[]',      -- JSON 数组
  UNIQUE(team_id, name)
);

-- 表11 team_member 小组成员
CREATE TABLE IF NOT EXISTS team_member (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id   INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  role_id   INTEGER REFERENCES team_role(id) ON DELETE SET NULL,  -- 旧单角色字段（已由 team_member_role 取代，保留兼容）
  join_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(team_id, user_id)
);
-- 成员多角色桥表（每人最多 3 个角色；自选/组长分配共用）
CREATE TABLE IF NOT EXISTS team_member_role (
  team_id INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES team_role(id) ON DELETE CASCADE,
  PRIMARY KEY(team_id, user_id, role_id)
);

-- 表12 team_task 进度任务（里程碑对齐）
CREATE TABLE IF NOT EXISTS team_task (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id     INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  desc        TEXT,
  deadline    TEXT,                            -- 截止日期（YYYY-MM-DD）
  assignee_id INTEGER REFERENCES user(id),     -- 负责人
  status      TEXT DEFAULT 'todo',             -- todo / doing / done
  progress    INTEGER DEFAULT 0,               -- 0-100
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 表13 progress_log 成员进度汇报（对齐用，类似日报/周报）
-- content 为富文本 HTML（wangEditor，图片可 base64 内嵌）；attachments 为附件 JSON [{name,size,mime,data(base64)}]
CREATE TABLE IF NOT EXISTS progress_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id     INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  attachments TEXT DEFAULT '[]',             -- JSON 附件数组（图片/音频/视频/文件）
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 表14 team_message 小组讨论（attachments 图片 JSON 数组）
CREATE TABLE IF NOT EXISTS team_message (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id     INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  attachments TEXT DEFAULT '[]',             -- JSON [{name,mime,data}]
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 表15 team_file 资料共享（base64 JSON 上传，零额外依赖）
CREATE TABLE IF NOT EXISTS team_file (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id     INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  file_name   TEXT NOT NULL,
  file_size   INTEGER,                         -- 字节
  file_type   TEXT,                            -- mime
  data        TEXT,                            -- base64 内容
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 表16 team_device 设备（组内硬件，预约制）
CREATE TABLE IF NOT EXISTS team_device (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id     INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,                   -- 设备名（STM32开发板/万用表…）
  spec        TEXT,                            -- 规格/数量
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 表17 device_booking 设备预约
CREATE TABLE IF NOT EXISTS device_booking (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id     INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  device_id   INTEGER NOT NULL REFERENCES team_device(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  start_time  TEXT NOT NULL,                   -- 开始（YYYY-MM-DD HH:MM）
  end_time    TEXT NOT NULL,
  purpose     TEXT,                            -- 用途
  status      TEXT DEFAULT 'pending',          -- pending / approved / rejected
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 表18 comment 评论（进度汇报/讨论消息均可回复；纯文本）
CREATE TABLE IF NOT EXISTS comment (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id     INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,                   -- log 进度汇报 / message 讨论消息
  target_id   INTEGER NOT NULL,                -- 对应表主键（随 team 级联删除）
  user_id     INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_comment_target ON comment(team_id, target_type, target_id);

-- 表20 daily_note 日程笔记（学习笔记，富文本 + 学习状态；月历回看）
-- 归属策略与 user_schedule 一致：'local' 匿名 / 登录用户 id；同用户同日期允许多篇（「写笔记」每次新建）
-- 双击竞态由后端 30s 窗口复用兜底（routes/feishu.js ensureBizRecord），故无唯一索引
CREATE TABLE IF NOT EXISTS daily_note (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT DEFAULT 'local',          -- 'local' 或账号 id
  note_date   TEXT NOT NULL,                 -- YYYY-MM-DD
  schedule_id INTEGER,                       -- 关联备赛日程（可选，展示竞赛名用）
  status      TEXT DEFAULT '',               -- 学习状态：good/hard/slow/none
  content     TEXT DEFAULT '',               -- 富文本 HTML（wangEditor）
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  update_time DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_daily_note_ud ON daily_note(user_id, note_date);

-- 表21 team_plan 小组 AI 备赛计划（按部门/角色拆分任务，多部门并行跟进）
-- plan_json: { comp_id, comp_name, roles:[角色名], phases:[{phase,date,check_standard,week_hours,tasks:[{text,done,dept,role_id}]}] }
CREATE TABLE IF NOT EXISTS team_plan (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id     INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  comp_id     INTEGER,
  title       TEXT,                            -- 计划名（竞赛名）
  plan_json   TEXT,
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  update_time DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_team_plan_team ON team_plan(team_id);

-- 表22 feedback 用户反馈（提交后邮件转发给管理员 FEEDBACK_TO，库内留档）
CREATE TABLE IF NOT EXISTS feedback (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  content       TEXT NOT NULL,                   -- 反馈内容（1-5000 字）
  contact_email TEXT,                            -- 反馈时用户邮箱快照
  create_time   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_process_comp  ON competition_process(comp_id);
CREATE INDEX IF NOT EXISTS idx_stack_comp    ON tech_stack(comp_id);
CREATE INDEX IF NOT EXISTS idx_stack_process ON tech_stack(process_id);
CREATE INDEX IF NOT EXISTS idx_schedule_user ON user_schedule(user_id);
CREATE INDEX IF NOT EXISTS idx_media_comp    ON media_resource(comp_id, category);

-- 表23~28 资源分享（贴吧式）：帖子 + 附件 + 标签子板块 + 点赞 + 收藏 + 评论
CREATE TABLE IF NOT EXISTS share_post (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,                 -- 标题（1-60 字）
  content     TEXT DEFAULT '',               -- 富文本 HTML
  attachments TEXT DEFAULT '[]',             -- [{name,size,mime,data}] base64
  is_ghost    INTEGER DEFAULT 0,             -- 1=幽灵帖（仅幽灵用户可见，普通用户完全隔离）
  slug        TEXT DEFAULT '',               -- GitHub 风项目路径名（同用户唯一，发帖时由标题生成，不可改）
  is_public   INTEGER NOT NULL DEFAULT 1,    -- 1=开源（任何人凭链接可见） 0=私密（仅作者；管理员后台可见）
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  update_time DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_share_post_user ON share_post(user_id);
-- (user_id,slug) 唯一索引在 database.js 迁移链创建（slug 列对老库是后补的）

CREATE TABLE IF NOT EXISTS share_tag (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE           -- 索引标签（楼主自建，构成子板块）
);

CREATE TABLE IF NOT EXISTS share_post_tag (
  post_id     INTEGER NOT NULL REFERENCES share_post(id) ON DELETE CASCADE,
  tag_id      INTEGER NOT NULL REFERENCES share_tag(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, tag_id)
);

CREATE TABLE IF NOT EXISTS share_like (
  post_id     INTEGER NOT NULL REFERENCES share_post(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS share_fav (
  post_id     INTEGER NOT NULL REFERENCES share_post(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS share_comment (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id     INTEGER NOT NULL REFERENCES share_post(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,                 -- 评论（1-1000 字，纯文本）
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_share_comment_post ON share_comment(post_id);

-- 表29 share_file 项目文件夹（一条帖子 = 一个项目；文件落盘 backend/uploads/share/{user_id}/，DB 只存元数据）
-- path 是 '/' 分隔的相对路径，**目录由 path 前缀推导，不单独存目录行**（webkitdirectory 本就产不出空目录）
-- post_id 为 NULL = 暂存态（发帖弹窗里先传、提交时才绑帖）；store_name 为 NULL = Gitee 条目（不落盘，按需代理）
CREATE TABLE IF NOT EXISTS share_file (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id     INTEGER REFERENCES share_post(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,                 -- 'docs/a.md'（已消毒：无 .. / 无反斜杠 / 无前导斜杠）
  name        TEXT NOT NULL,                 -- 末段
  size        INTEGER DEFAULT 0,
  mime        TEXT DEFAULT '',               -- 按扩展名推导，不信客户端
  store_name  TEXT,                          -- 磁盘 basename（{ts}_{12hex}{ext}）
  source      TEXT DEFAULT 'upload',         -- 'upload' | 'gitee'
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_share_file_post ON share_file(post_id);
CREATE INDEX IF NOT EXISTS idx_share_file_staging ON share_file(user_id, post_id);

-- 表29~31 好友与私聊：好友申请 + 好友关系（双向行，A-B 与 B-A 各一行）+ 私聊消息
CREATE TABLE IF NOT EXISTS friend_request (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id     INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  to_id       INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  status      TEXT DEFAULT 'pending',          -- pending / accepted / rejected
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(from_id, to_id)
);

CREATE TABLE IF NOT EXISTS friend (
  user_id     INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  friend_id   INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, friend_id)
);
CREATE INDEX IF NOT EXISTS idx_friend_user ON friend(user_id);

CREATE TABLE IF NOT EXISTS dm_message (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id     INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  to_id       INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,                   -- 私信内容（1-2000 字）
  is_read     INTEGER DEFAULT 0,               -- 对方是否已读
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_dm_pair ON dm_message(from_id, to_id);
CREATE INDEX IF NOT EXISTS idx_dm_unread ON dm_message(to_id, is_read);

-- 表32 消息中心通知：评论 / 点赞 / 收藏（私信沿用 dm_message.is_read）
CREATE TABLE IF NOT EXISTS notification (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,     -- 接收者（帖子作者）
  actor_id    INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,     -- 触发者
  type        TEXT NOT NULL,               -- like | fav | comment
  post_id     INTEGER NOT NULL REFERENCES share_post(id) ON DELETE CASCADE,
  comment_id  INTEGER,                     -- comment 类型关联的评论
  is_read     INTEGER DEFAULT 0,
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notification(user_id, is_read);

-- 表33 操作审计日志（后台管理）：登录登出 / 计划制定 / 小组 / 好友 / 私聊 / 评论等
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER,                          -- 操作者（可能已被删除 → 无外键）
  username    TEXT,
  action      TEXT NOT NULL,                    -- login/logout/register/plan-create/plan-manual/plan-chat/team-plan/team-join/team-invite/friend-request/friend-accept/friend-reject/dm-send/comment-share/comment-team/user-status/user-role/post-delete/comment-delete/announce-create/announce-update/announce-delete
  target      TEXT,                             -- 目标对象：竞赛名/小组名/对方昵称/帖子标题
  detail      TEXT,                             -- 补充说明（JSON）
  ip          TEXT,
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, create_time);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, create_time);

-- 表34 公告（后台管理发布，前台全局顶部横幅展示）
CREATE TABLE IF NOT EXISTS announcement (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  content     TEXT DEFAULT '',
  pinned      INTEGER DEFAULT 0,                -- 置顶优先展示
  admin_id    INTEGER,                          -- 发布管理员
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_announce ON announcement(pinned, id);

-- 表35 user_resource 个人资源库（文件落盘 backend/uploads/resource/{userId}/，DB 只存元数据）
-- 单文件 ≤128MB（multer 限制），每用户配额 1GB（RESOURCE_QUOTA 环境变量可覆盖，便于测试）
CREATE TABLE IF NOT EXISTS user_resource (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  file_name   TEXT NOT NULL,             -- 原始文件名（下载 Content-Disposition 用）
  file_size   INTEGER NOT NULL,          -- 字节
  file_type   TEXT,                      -- mime
  store_path  TEXT NOT NULL,             -- 磁盘文件名（仅 basename，防路径穿越）
  feishu_token TEXT,                     -- 飞书云盘 file_token（分享到飞书时记录；撤销分享时删除飞书文件）
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_user_resource_user ON user_resource(user_id);

-- 表36 访问记录（后台管理）：所有 /api 请求（含游客，user_id 为空即未登录）
CREATE TABLE IF NOT EXISTS access_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER,                          -- 登录用户 id；游客为 NULL
  username    TEXT,                             -- 用户名快照（游客为空）
  ip          TEXT,                             -- 客户端 IP（x-forwarded-for 优先）
  method      TEXT,                             -- GET/POST/PUT/DELETE
  path        TEXT,                             -- 请求路径（不含 query）
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_access_time ON access_log(create_time);

-- 表37 飞书 OAuth 绑定（方案三：网站 ↔ 飞书文档互传）：每用户绑定
-- user_id 主键；open_id 可重复 → 一个飞书账号（open_id）可绑定多个网页账号
-- access_token / refresh_token 只存服务端库，绝不返回前端；重启不丢，过期自动 refresh
CREATE TABLE IF NOT EXISTS feishu_bind (
  user_id       INTEGER PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  open_id       TEXT NOT NULL,                          -- 飞书 open_id（同一飞书账号可对应多行）
  user_name     TEXT DEFAULT '',                        -- 飞书用户姓名（展示用）
  avatar_url    TEXT DEFAULT '',                        -- 飞书头像（展示用）
  access_token  TEXT NOT NULL,                          -- user_access_token（约 2h）
  refresh_token TEXT NOT NULL,                          -- 刷新凭证（30 天）
  access_exp    INTEGER NOT NULL,                       -- access 过期时间戳（ms）
  refresh_exp   INTEGER NOT NULL DEFAULT 0,             -- refresh 过期时间戳（ms）
  create_time   TEXT DEFAULT (datetime('now','localtime')),
  update_time   TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_feishu_bind_open ON feishu_bind(open_id);

-- 表38 业务记录 ↔ 飞书文档映射（P1：飞书编辑页替代富文本编辑器）
-- biz_type: daily_note | progress_log | share_post；同一条业务记录只映射一个飞书文档
CREATE TABLE IF NOT EXISTS feishu_doc_map (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  biz_type    TEXT NOT NULL,                 -- 业务表名（白名单校验）
  biz_id      INTEGER NOT NULL,              -- 业务记录 id
  doc_id      TEXT NOT NULL,                 -- 飞书 document_id
  doc_url     TEXT NOT NULL,                 -- 飞书文档链接（编辑跳转用）
  create_time TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(biz_type, biz_id)
);

-- 表39 报销整理·报销项目（费用报销整理模块）：负责人=本站登录用户
-- owner 存 TEXT（与 daily_note.user_id 同坑：写入/比较必须 String(req.user.id)）；
-- code 邀请码 8 位 A-Z2-9：匿名访客凭链接+邀请码只读全量，成员凭 claim token 录入
CREATE TABLE IF NOT EXISTS expense_project (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner       TEXT NOT NULL,                -- 负责人 user_id（TEXT）
  name        TEXT NOT NULL,                -- 项目名称（如：电赛报销整理）
  event       TEXT DEFAULT '',              -- 竞赛/活动名称（选填）
  code        TEXT NOT NULL,                -- 邀请码（genInviteCode 唯一循环）
  status      TEXT DEFAULT 'open',          -- open 填报中 / closed 已截止（成员写操作 403）
  create_time TEXT DEFAULT (datetime('now','localtime')),
  update_time TEXT DEFAULT (datetime('now','localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_code ON expense_project(code);
CREATE INDEX IF NOT EXISTS idx_expense_owner ON expense_project(owner);

-- 表40 报销整理·参赛队伍（一项目多队，队员名单按队管理）
CREATE TABLE IF NOT EXISTS expense_team (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES expense_project(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,                -- 队伍名（≤30 字）
  ord         INTEGER DEFAULT 0             -- 展示序号
);
CREATE INDEX IF NOT EXISTS idx_expense_team_p ON expense_team(project_id);

-- 表41 报销整理·队员名单（负责人预录；claim_token 首认领即得 32 位 hex，负责人可重置=清空，旧 token 立即失效）
-- 姓名项目内唯一（UNIQUE(project_id, name)），重名队员需在名单中区分
-- is_owner=1：该条目是负责人本人的队员身份（负责人可能同时是队员，如自己垫付个人开销也要报）。
--   登录即占用：claimed 恒真、不可被队员认领/代领（防伪冒），录入自己费用即归属此名；
--   建成员时姓名=本人昵称/用户名自动标记，管理界面可手动标记/取消（标记时收回被抢先认领的 token）
CREATE TABLE IF NOT EXISTS expense_member (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES expense_project(id) ON DELETE CASCADE,
  team_id     INTEGER NOT NULL REFERENCES expense_team(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,                -- 姓名（≤20 字）
  claim_token TEXT,                         -- 认领 token；NULL=未认领
  claim_at    TEXT,                         -- 认领时间
  is_owner    INTEGER DEFAULT 0,            -- 1=负责人本人的队员身份（登录占用，不可被队员认领）
  ord         INTEGER DEFAULT 0,
  UNIQUE(project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_expense_member_p ON expense_member(project_id);
CREATE INDEX IF NOT EXISTS idx_expense_member_t ON expense_member(team_id);

-- 表42 报销整理·费用行（data JSON 存分类字段，键见 lib/expenseMeta.js，与前端 utils/expenseMeta.js 同步）
-- owner_name=归属成员姓名：成员写入强制=本人认领名（创建即注入，payload 无法伪装）；owner 自由填
-- team_id 可空：NULL = 全项目统一支付行（项目级区块录入，不属任何队伍，仅负责人；见 routes/expense.js project_pay）
CREATE TABLE IF NOT EXISTS expense_row (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES expense_project(id) ON DELETE CASCADE,
  team_id     INTEGER REFERENCES expense_team(id) ON DELETE CASCADE,
  category    TEXT NOT NULL,                -- reg/train/hotel/mail/prop（白名单，创建后不可改）
  owner_name  TEXT NOT NULL,                -- 归属成员姓名（导出/权限都读它）
  data        TEXT NOT NULL,                -- 字段 JSON（白名单归一后落库）
  create_time TEXT DEFAULT (datetime('now','localtime')),
  update_time TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_expense_row_p ON expense_row(project_id);
CREATE INDEX IF NOT EXISTS idx_expense_row_team ON expense_row(team_id);

-- 表43 报销整理·附件（文件落盘 backend/uploads/expense/{code}/{rowId}/{slot}/，DB 只存元数据）
-- 单人常规记录每槽一份（重传=替换，路由层约束）；统一支付行（team_id 空=全项目统一支付区/⑥零散票据，
-- 或 统一支付范围非空）每槽可多份：同槽多份独立管理、只增不替（故无 UNIQUE(row_id, slot)）
CREATE TABLE IF NOT EXISTS expense_attach (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES expense_project(id) ON DELETE CASCADE,
  row_id      INTEGER NOT NULL REFERENCES expense_row(id) ON DELETE CASCADE,
  slot        TEXT NOT NULL,                -- 槽位 ASCII 键（invoice/invoiceCheck/…见 lib/expenseMeta.js）
  orig_name   TEXT NOT NULL,                -- 原始文件名（下载 Content-Disposition 用）
  store_name  TEXT NOT NULL,                -- 磁盘文件名（仅 basename，防路径穿越）
  mime        TEXT DEFAULT '',              -- 按扩展名映射后的规范 mime（不信任客户端）
  size        INTEGER NOT NULL,             -- 字节
  create_time TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_expense_attach_p ON expense_attach(project_id);
CREATE INDEX IF NOT EXISTS idx_expense_attach_r ON expense_attach(row_id);

-- 表44 荣誉墙（后台管理员维护；奖状图片落盘 backend/uploads/honor/，DB 只存元数据）
-- 前台 /honor 多行反向跑马灯；一行 = 一张奖状，image_* 可空 —— 允许纯文字荣誉（口头表彰/图还没拍）
-- store_name/image_name 只进 DB，**任何接口都不返回**（磁盘文件名不外泄）
-- image_ver：缓存键（每次换图重新随机）。**不能用 update_time 兼职** —— CURRENT_TIMESTAMP 只有秒级
--   精度，同一秒内连换两次会算出同一个版本号，浏览器就一直吃旧图
-- admin_id 故意不加外键（同 announcement.admin_id）：挂 ON DELETE CASCADE 的话，
--   删个测试账号就会把荣誉墙一起清空
-- sort_order DESC, id DESC（大的在前）
CREATE TABLE IF NOT EXISTS honor (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,              -- 奖项名称（必填）
  winner      TEXT DEFAULT '',            -- 获奖者/团队
  award_level TEXT DEFAULT '',            -- 授予级别：国际级/国家级/省级/市级/校级（受控选项+允许自建，前台据此着色）
  prize_rank  TEXT DEFAULT '',            -- 奖等：特等奖/一等奖/二等奖/三等奖/优胜奖（受控选项+允许自建）
  comp_id     INTEGER,                    -- 赛项→competition.id；裸列**故意不加外键**（import 会重建 competition 表，同 team_plan.comp_id）
  event_name  TEXT DEFAULT '',            -- 赛项名快照：comp_id 命中由服务端回填 short_name/name；手填时 comp_id=NULL
  award_date  TEXT DEFAULT '',            -- 获奖年月 'YYYY-MM'（纯文本，不做时区换算）
  description TEXT DEFAULT '',            -- 一句话说明
  image_name  TEXT,                       -- 原始文件名（下载/alt 用）
  store_name  TEXT,                       -- 磁盘文件名（仅 basename）；NULL = 无图
  image_size  INTEGER DEFAULT 0,
  image_mime  TEXT DEFAULT '',            -- 服务端按**文件头魔数**判定的规范 mime（不信客户端）
  image_ver   TEXT,                       -- 缓存键 8 位 hex；NULL = 无图
  is_active   INTEGER DEFAULT 1,          -- 1=上架 0=下架（下架不进前台，后台仍可见）
  sort_order  INTEGER DEFAULT 0,
  admin_id    INTEGER,
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  update_time DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_honor_show ON honor(is_active, sort_order, id);

-- 荣誉墙标签字典 + 关联桥表（2026-10-21，目前 kind 只有 'class' 班级；输入即沉淀，仿 share_tag）
-- 授予级别/奖等是单列单选直接存 honor 行；赛项存 comp_id+event_name 快照 —— 只有班级是多值走此表
CREATE TABLE IF NOT EXISTS honor_tag (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  kind  TEXT NOT NULL DEFAULT 'class',    -- 标签维度：目前仅 'class'
  name  TEXT NOT NULL,                    -- 班级名（≤20 字）
  UNIQUE(kind, name)
);
CREATE TABLE IF NOT EXISTS honor_tag_link (
  honor_id INTEGER NOT NULL REFERENCES honor(id) ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES honor_tag(id) ON DELETE CASCADE,
  PRIMARY KEY (honor_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_honor_tag_link_t ON honor_tag_link(tag_id);

-- ========== 物料采购申请模块（2026-10-14，/purchase） ==========

-- 表45 物料采购·比赛/项目档案（审批按档案分别指定负责人/老师；建档者自动成为 leader）
-- 档案只能关闭（status=closed）不能删除：有申请挂着时 ON DELETE RESTRICT 兜底
CREATE TABLE IF NOT EXISTS purchase_event (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,             -- 比赛或项目名称（全局唯一，防重复建档）
  kind        TEXT NOT NULL DEFAULT '比赛',      -- 比赛 / 项目
  description TEXT DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open',     -- open 接受申请 / closed 已关闭（学生不可新建申请）
  created_by  INTEGER REFERENCES user(id) ON DELETE SET NULL,
  create_time TEXT DEFAULT (datetime('now','localtime')),
  close_time  TEXT
);
CREATE INDEX IF NOT EXISTS idx_purchase_event_status ON purchase_event(status);

-- 表46 档案审批人（负责人 leader / 老师 teacher；任一审批人通过即生效，不做会签）
CREATE TABLE IF NOT EXISTS purchase_event_approver (
  event_id    INTEGER NOT NULL REFERENCES purchase_event(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'leader',   -- leader / teacher
  add_by      INTEGER,
  create_time TEXT DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_purchase_approver_user ON purchase_event_approver(user_id);

-- 表47 物料采购·申请单（状态机 pending 待审批 → approved 已通过·待传发票 → invoiced 已传发票；
--   pending → rejected 已驳回；rejected 申请人改后重新提交回 pending；发票删光 invoiced 退回 approved）
CREATE TABLE IF NOT EXISTS purchase_request (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id       INTEGER NOT NULL REFERENCES purchase_event(id) ON DELETE RESTRICT,
  user_id        INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  applicant_name TEXT NOT NULL,                  -- 申请人昵称快照（防改名后历史失真）
  remark         TEXT DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'pending',
  amount         REAL NOT NULL DEFAULT 0,        -- 明细总额（服务端重算：Σ qty*unit_price，四舍五入到分）
  approver_id    INTEGER,                        -- 当前裁决审批人
  approver_name  TEXT DEFAULT '',
  approver_role  TEXT DEFAULT '',                -- leader / teacher
  approve_time   TEXT,
  reject_reason  TEXT DEFAULT '',
  invoice_count  INTEGER NOT NULL DEFAULT 0,
  submit_time    TEXT DEFAULT (datetime('now','localtime')),
  create_time    TEXT DEFAULT (datetime('now','localtime')),
  update_time    TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_purchase_request_event ON purchase_request(event_id);
CREATE INDEX IF NOT EXISTS idx_purchase_request_user ON purchase_request(user_id);
CREATE INDEX IF NOT EXISTS idx_purchase_request_status ON purchase_request(status);

-- 表48 物料采购·明细行（申请单编辑走全量替换；amount 服务端算）
CREATE TABLE IF NOT EXISTS purchase_item (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  INTEGER NOT NULL REFERENCES purchase_request(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,                     -- 物料/道具详细名称
  spec        TEXT DEFAULT '',                   -- 规格型号
  qty         REAL NOT NULL DEFAULT 1,
  unit_price  REAL NOT NULL DEFAULT 0,
  amount      REAL NOT NULL DEFAULT 0,
  link        TEXT DEFAULT '',                   -- 购买链接（可选）
  ord         INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_purchase_item_request ON purchase_item(request_id);

-- 表49 物料采购·附件（kind=shot 购买截图挂 item_id；kind=invoice 发票挂申请单 item_id NULL）
-- 文件落盘 backend/uploads/purchase/{requestId}/{shots|invoices}/，DB 只存元数据
CREATE TABLE IF NOT EXISTS purchase_file (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  INTEGER NOT NULL REFERENCES purchase_request(id) ON DELETE CASCADE,
  item_id     INTEGER REFERENCES purchase_item(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                     -- shot / invoice
  orig_name   TEXT NOT NULL,
  store_name  TEXT NOT NULL,                     -- 仅 basename，防穿越
  mime        TEXT DEFAULT '',                   -- 按扩展名映射的规范 mime（不信客户端）
  size        INTEGER NOT NULL,
  uploader_id INTEGER,
  create_time TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_purchase_file_request ON purchase_file(request_id);
CREATE INDEX IF NOT EXISTS idx_purchase_file_item ON purchase_file(item_id);

-- 表50 物料采购·审批轨迹（每次通过/驳回一条；驳回后重新提交再审批，历史全保留）
CREATE TABLE IF NOT EXISTS purchase_approval_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id    INTEGER NOT NULL REFERENCES purchase_request(id) ON DELETE CASCADE,
  user_id       INTEGER,
  approver_name TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'leader',  -- leader / teacher
  result        TEXT NOT NULL,                   -- approved / rejected
  comment       TEXT DEFAULT '',
  create_time   TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_purchase_log_request ON purchase_approval_log(request_id);

-- 表51 personal_notice 个人公告/系统通知（定向推送；type=password_init 初始密码提醒，link 可点跳账号安全页）
CREATE TABLE IF NOT EXISTS personal_notice (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,                  -- password_init | realname_required | system（预留）
  title       TEXT NOT NULL,
  content     TEXT DEFAULT '',
  link        TEXT DEFAULT '',               -- 点击跳转的站内路径，如 /account-security
  is_read     INTEGER NOT NULL DEFAULT 0,
  create_time TEXT DEFAULT (datetime('now','localtime')),
  read_time   TEXT
);
CREATE INDEX IF NOT EXISTS idx_personal_notice_user ON personal_notice(user_id, is_read);

-- 表52 github_bind GitHub 账号 OAuth 绑定（仿 feishu_bind；token 仅展示身份用，失效解绑重绑即可）
CREATE TABLE IF NOT EXISTS github_bind (
  user_id     INTEGER PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  github_id   INTEGER NOT NULL UNIQUE,        -- GitHub 数字 id（同一 GitHub 账号不能绑多个本站账号）
  login       TEXT NOT NULL,                  -- GitHub 用户名（路由展示）
  avatar_url  TEXT DEFAULT '',
  profile_url TEXT DEFAULT '',
  token_prefix TEXT DEFAULT '',              -- access_token 前 8 位（排障用，只存这点）
  create_time TEXT DEFAULT (datetime('now','localtime')),
  update_time TEXT DEFAULT (datetime('now','localtime'))
);

-- ==================== 资源预约模块（/booking，挂载 /api/booking；与小组域 team_device 设备预约互不相关） ====================

-- 表53 预约项目档案（只关不删；default_approve_mode 仅作新增资源表单的预填，审批以资源级开关为准）
CREATE TABLE IF NOT EXISTS booking_project (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                 TEXT NOT NULL UNIQUE,
  description          TEXT DEFAULT '',
  default_approve_mode TEXT NOT NULL DEFAULT 'approval', -- approval 需审批 / first_come 先到先得
  status               TEXT NOT NULL DEFAULT 'open',     -- open / closed
  created_by           INTEGER REFERENCES user(id) ON DELETE SET NULL,
  create_time          TEXT DEFAULT (datetime('now','localtime')),
  close_time           TEXT,
  update_time          TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_bk_project_status ON booking_project(status);

-- 表54 项目内可用资源（空间 space：独占+容量；物品 item：数量库存池）
CREATE TABLE IF NOT EXISTS booking_resource (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES booking_project(id) ON DELETE RESTRICT,
  kind         TEXT NOT NULL,                  -- item 物品资源 / space 空间资源（老库五分类值由 user_version=2 迁移）
  is_space     INTEGER NOT NULL DEFAULT 0,     -- 1=空间(space) 0=物品(item)
  name         TEXT NOT NULL,
  spec         TEXT DEFAULT '',                -- 规格型号（物品）
  location     TEXT DEFAULT '',                -- 楼栋/房间号/存放位置
  capacity     INTEGER,                        -- 空间：可容纳人数；物品恒 NULL
  quantity     INTEGER NOT NULL DEFAULT 1,     -- 物品：库存总数；空间恒 1
  unit         TEXT DEFAULT '',                -- 物品单位：件/台/套…
  params       TEXT NOT NULL DEFAULT '{}',     -- JSON：空间 {"equipment":["投影仪",…]}，物品自由扩展
  approve_mode TEXT NOT NULL DEFAULT 'approval', -- 资源级审批开关：approval / first_come
  status       TEXT NOT NULL DEFAULT 'active', -- active / archived（被预约引用后只能归档）
  created_by   INTEGER REFERENCES user(id) ON DELETE SET NULL,
  create_time  TEXT DEFAULT (datetime('now','localtime')),
  update_time  TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE (project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_bk_resource_pstatus ON booking_resource(project_id, status);
CREATE INDEX IF NOT EXISTS idx_bk_resource_pkind ON booking_resource(project_id, kind);

-- 表55 固定组队（预约模块内自建，独立于项目小组）
CREATE TABLE IF NOT EXISTS booking_team (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES booking_project(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  owner_id    INTEGER REFERENCES user(id) ON DELETE SET NULL,
  owner_name  TEXT NOT NULL DEFAULT '',
  create_time TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE (project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_bk_team_project ON booking_team(project_id);

-- 表56 固定组队成员（组队后增删改名不影响已下预约的参与人快照）
CREATE TABLE IF NOT EXISTS booking_team_member (
  team_id   INTEGER NOT NULL REFERENCES booking_team(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  user_name TEXT NOT NULL,
  ord       INTEGER DEFAULT 0,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_bk_team_member_user ON booking_team_member(user_id);

-- 表57 预约主表（时间为北京时间朴素串 'YYYY-MM-DD HH:MM'，定宽可直接半开区间比较；勿走 toLocal 补 Z）
-- 状态机：first_come 资源创建即 confirmed（冲突 409 不建单）；approval 资源 pending→confirmed/rejected；
--   pending 即占位（与 confirmed 一起参与冲突检测），驳回/取消释放；不提供编辑，改约=取消重约。
CREATE TABLE IF NOT EXISTS booking (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     INTEGER NOT NULL REFERENCES booking_project(id) ON DELETE RESTRICT,
  resource_id    INTEGER NOT NULL REFERENCES booking_resource(id) ON DELETE RESTRICT,
  start_time     TEXT NOT NULL,
  end_time       TEXT NOT NULL,
  qty            INTEGER NOT NULL DEFAULT 1,   -- 物品本次借用数量；空间恒 1
  headcount      INTEGER NOT NULL DEFAULT 1,   -- 参与总人数（含预约者；空间须 ≤ capacity）
  purpose        TEXT DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'pending', -- pending / confirmed / rejected / canceled
  source         TEXT NOT NULL DEFAULT 'solo',    -- solo / team / custom
  team_id        INTEGER REFERENCES booking_team(id) ON DELETE SET NULL,
  booker_id      INTEGER REFERENCES user(id) ON DELETE CASCADE,
  booker_name    TEXT NOT NULL,
  approver_id    INTEGER,
  approver_name  TEXT DEFAULT '',
  approve_time   TEXT,
  reject_reason  TEXT DEFAULT '',
  cancel_by_id   INTEGER,
  cancel_by_name TEXT DEFAULT '',
  cancel_time    TEXT,
  create_time    TEXT DEFAULT (datetime('now','localtime')),
  update_time    TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_bk_booking_resource ON booking(resource_id, status, start_time);
CREATE INDEX IF NOT EXISTS idx_bk_booking_project ON booking(project_id, status);
CREATE INDEX IF NOT EXISTS idx_bk_booking_booker ON booking(booker_id);

-- 表58 预约参与人快照（下单瞬间固化；甘特头像组与通知 fan-out 用）
CREATE TABLE IF NOT EXISTS booking_participant (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES booking(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  user_name  TEXT NOT NULL,
  is_booker  INTEGER NOT NULL DEFAULT 0,
  ord        INTEGER DEFAULT 0,
  UNIQUE (booking_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_bk_participant_user ON booking_participant(user_id);

-- 表59 预约轨迹（created/approved/rejected/canceled 各一条；详情弹窗时间线渲染）
CREATE TABLE IF NOT EXISTS booking_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id  INTEGER NOT NULL REFERENCES booking(id) ON DELETE CASCADE,
  action      TEXT NOT NULL,              -- created / approved / rejected / canceled
  actor_id    INTEGER,
  actor_name  TEXT NOT NULL,
  comment     TEXT DEFAULT '',
  create_time TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_bk_log_booking ON booking_log(booking_id);
