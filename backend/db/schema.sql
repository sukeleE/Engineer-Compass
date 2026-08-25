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
  create_time   DATETIME DEFAULT CURRENT_TIMESTAMP
);

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

-- 表20 daily_note 日程笔记（每日学习笔记，富文本 + 学习状态；月历回看）
-- 归属策略与 user_schedule 一致：'local' 匿名 / 登录用户 id；同用户同日期仅一条
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_note_ud ON daily_note(user_id, note_date);

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
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  update_time DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_share_post_user ON share_post(user_id);

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
