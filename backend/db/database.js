// SQLite 连接模块（Node 内置 node:sqlite，无需安装原生依赖）
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scryptSync, randomBytes } from 'node:crypto';
import { uniquePostSlug } from '../lib/slug.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, '..', 'data', 'compass.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');
db.exec(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));

// 轻量迁移：老库补新增列（新库 schema.sql 已含，ALTER 会失败，忽略即可）
const cols = db.prepare('PRAGMA table_info(competition)').all();
if (!cols.some((c) => c.name === 'official_url')) {
  db.exec('ALTER TABLE competition ADD COLUMN official_url TEXT');
}
const migCol = (table, col, ddl) => {
  const c = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!c.some((x) => x.name === col)) db.exec(ddl);
};
migCol('progress_log', 'attachments', "ALTER TABLE progress_log ADD COLUMN attachments TEXT DEFAULT '[]'");
// 周期打卡：progress_log 挂接任务/周期 + 自评 + 组长评分（新库 schema.sql 已含）
migCol('progress_log', 'schedule_id', 'ALTER TABLE progress_log ADD COLUMN schedule_id INTEGER');
migCol('progress_log', 'period_key', "ALTER TABLE progress_log ADD COLUMN period_key TEXT");
migCol('progress_log', 'self_progress', 'ALTER TABLE progress_log ADD COLUMN self_progress INTEGER');
migCol('progress_log', 'self_rating', 'ALTER TABLE progress_log ADD COLUMN self_rating INTEGER');
migCol('progress_log', 'score', 'ALTER TABLE progress_log ADD COLUMN score INTEGER');
migCol('progress_log', 'review', "ALTER TABLE progress_log ADD COLUMN review TEXT DEFAULT ''");
migCol('progress_log', 'reviewer_id', 'ALTER TABLE progress_log ADD COLUMN reviewer_id INTEGER');
migCol('progress_log', 'featured', 'ALTER TABLE progress_log ADD COLUMN featured INTEGER NOT NULL DEFAULT 0');
migCol('progress_log', 'is_late', 'ALTER TABLE progress_log ADD COLUMN is_late INTEGER NOT NULL DEFAULT 0');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_progress_log_checkin ON progress_log(schedule_id, user_id, period_key) WHERE schedule_id IS NOT NULL');
migCol('team_message', 'attachments', "ALTER TABLE team_message ADD COLUMN attachments TEXT DEFAULT '[]'");
migCol('user_study', 'user_id', 'ALTER TABLE user_study ADD COLUMN user_id INTEGER');
migCol('user', 'email', 'ALTER TABLE user ADD COLUMN email TEXT'); // SQLite 不支持 ADD COLUMN UNIQUE，唯一性用索引保证
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_user_email ON user(email)');
migCol('user', 'avatar', 'ALTER TABLE user ADD COLUMN avatar TEXT'); // 头像 dataURL（feedback 表靠 schema.sql IF NOT EXISTS，无需迁移）
migCol('user', 'status', 'ALTER TABLE user ADD COLUMN status INTEGER DEFAULT 0'); // 0=正常 1=封禁 2=禁言（后台管理）
migCol('user', 'is_ghost', 'ALTER TABLE user ADD COLUMN is_ghost INTEGER DEFAULT 0'); // 幽灵模式（秘密通道，仅幽灵可见内容）
migCol('user', 'admin_perms', "ALTER TABLE user ADD COLUMN admin_perms TEXT DEFAULT ''"); // 管理员模块权限 JSON（空=超管全权，非空=受限管理员）
migCol('share_post', 'is_ghost', 'ALTER TABLE share_post ADD COLUMN is_ghost INTEGER DEFAULT 0'); // 1=幽灵帖（仅幽灵用户可见）
migCol('expense_member', 'is_owner', 'ALTER TABLE expense_member ADD COLUMN is_owner INTEGER DEFAULT 0'); // 1=负责人本人的队员身份（登录占用、不可被队员认领）
migCol('user_resource', 'share_token', 'ALTER TABLE user_resource ADD COLUMN share_token TEXT'); // 公开分享 token（引用功能：可撤销下载链接）
migCol('user_resource', 'feishu_token', 'ALTER TABLE user_resource ADD COLUMN feishu_token TEXT'); // 飞书分享：云盘 file_token（撤销分享时删除飞书文件）
migCol('team_file', 'resource_ref', 'ALTER TABLE team_file ADD COLUMN resource_ref INTEGER'); // 引用型文件：指向 user_resource.id（data 为空）
migCol('share_post', 'gitee_repo', "ALTER TABLE share_post ADD COLUMN gitee_repo TEXT DEFAULT ''"); // Gitee 仓库 owner/repo（空=非仓库帖）
migCol('share_post', 'gitee_ref', "ALTER TABLE share_post ADD COLUMN gitee_ref TEXT DEFAULT ''");   // Gitee 分支/标签/sha
migCol('user', 'password_set', 'ALTER TABLE user ADD COLUMN password_set INTEGER NOT NULL DEFAULT 1'); // 0=初始密码待修改
migCol('user', 'phone', "ALTER TABLE user ADD COLUMN phone TEXT DEFAULT ''");                          // 手机号（部分唯一索引）
migCol('user', 'phone_verified', 'ALTER TABLE user ADD COLUMN phone_verified INTEGER NOT NULL DEFAULT 0'); // 预留：SMS 验证
migCol('share_post', 'slug', "ALTER TABLE share_post ADD COLUMN slug TEXT DEFAULT ''");                // GitHub 风路径名
migCol('share_post', 'is_public', 'ALTER TABLE share_post ADD COLUMN is_public INTEGER NOT NULL DEFAULT 1'); // 1=开源
migCol('user', 'real_name', "ALTER TABLE user ADD COLUMN real_name TEXT NOT NULL DEFAULT ''");         // 真实姓名（三模块实名门禁）
migCol('honor', 'prize_rank', "ALTER TABLE honor ADD COLUMN prize_rank TEXT DEFAULT ''");              // 荣誉墙：奖等（特等/一/二/三等奖…）
migCol('honor', 'comp_id', 'ALTER TABLE honor ADD COLUMN comp_id INTEGER');                            // 荣誉墙：赛项→competition.id（无外键，同 team_plan）
migCol('honor', 'event_name', "ALTER TABLE honor ADD COLUMN event_name TEXT DEFAULT ''");              // 荣誉墙：赛项名快照（库选/手填统一展示）
migCol('user', 'student_no', "ALTER TABLE user ADD COLUMN student_no TEXT NOT NULL DEFAULT ''");       // 学号（实验室借用登记）
migCol('booking_resource', 'image', "ALTER TABLE booking_resource ADD COLUMN image TEXT DEFAULT ''");   // 物品图片 dataURL
migCol('booking_resource', 'damaged_qty', 'ALTER TABLE booking_resource ADD COLUMN damaged_qty INTEGER NOT NULL DEFAULT 0'); // 物品损坏数
migCol('booking', 'booker_student_no', "ALTER TABLE booking ADD COLUMN booker_student_no TEXT NOT NULL DEFAULT ''"); // 学号快照
migCol('booking', 'item_name', "ALTER TABLE booking ADD COLUMN item_name TEXT DEFAULT ''");   // 借用登记：所借物品名称 / 教室编号
migCol('booking', 'item_image', "ALTER TABLE booking ADD COLUMN item_image TEXT DEFAULT ''"); // 借用登记：照片 dataURL
migCol('booking', 'item_thumb', "ALTER TABLE booking ADD COLUMN item_thumb TEXT DEFAULT ''"); // 借用登记：照片缩略图（列表用）
migCol('booking', 'item_kind', "ALTER TABLE booking ADD COLUMN item_kind TEXT DEFAULT ''");   // 借用登记类型：device / room
migCol('booking_resource', 'is_carrier', "ALTER TABLE booking_resource ADD COLUMN is_carrier INTEGER NOT NULL DEFAULT 0"); // 借用登记占位资源
db.exec("UPDATE booking_resource SET is_carrier = 1 WHERE name = '借用登记' AND is_carrier = 0"); // 老库按名占位资源一次性回填

// ---- user_version 闸门：只对「升级前的老库」执行一次的存量数据回填 ----
// 新库（schema 直接建成新结构、零行）同样过一遍但 0 行受影响，随即落版本号。
const INITIAL_PASSWORD = process.env.INITIAL_PASSWORD || 'gkjsdh123';
let userVer = Number(db.prepare('PRAGMA user_version').get().user_version || 0);
if (userVer < 1) {
  // ① 全部存量用户：无法从 scrypt 哈希区分「随机密码/真实密码」（已与用户确认口径），
  //    统一重置为初始密码并标记待修改；逐人独立 salt（与 middleware.hashPassword 同格式 salt$hash）。
  const users = db.prepare('SELECT id FROM user').all();
  const updPw = db.prepare('UPDATE user SET password_hash = ?, password_set = 0 WHERE id = ?');
  const insNotice = db.prepare(
    `INSERT INTO personal_notice (user_id, type, title, content, link)
     VALUES (?, 'password_init', ?, ?, ?)`
  );
  for (const u of users) {
    const salt = randomBytes(16).toString('hex');
    updPw.run(`${salt}$${scryptSync(INITIAL_PASSWORD, salt, 64).toString('hex')}`, u.id);
    insNotice.run(
      u.id,
      '【重要】请尽快修改初始密码',
      `系统已为您的账号设置统一初始密码 ${INITIAL_PASSWORD}，为保障账号安全，请通过「邮箱验证码」修改为本人的密码。`,
      '/account-security'
    );
  }
  // ② 存量帖子 slug 回填（同用户内由标题去重；新发帖由路由保证非空）
  for (const p of db.prepare('SELECT id, user_id, title FROM share_post ORDER BY user_id, id').all()) {
    if (p.slug) continue;
    db.prepare('UPDATE share_post SET slug = ? WHERE id = ?')
      .run(uniquePostSlug(db, p.user_id, p.title, p.id), p.id);
  }
  db.exec('PRAGMA user_version = 1;');
  userVer = 1;
  if (users.length) console.log(`🔐 存量账号初始密码回填完成：${users.length} 位用户已置为初始密码并收到个人公告`);
}

if (userVer < 2) {
  // 资源预约：资源五分类（道具/器材/器械/实验室/教室）简化为两类 item/space。
  // 老库可能早于预约模块，先探测表存在；is_space 已独立保存，直接按老 kind 映射。
  const hasBookingResource = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'booking_resource'")
    .get();
  if (hasBookingResource) {
    const r1 = db.prepare("UPDATE booking_resource SET kind = 'space' WHERE kind IN ('lab', 'classroom')").run();
    const r2 = db.prepare("UPDATE booking_resource SET kind = 'item' WHERE kind IN ('prop', 'equipment', 'instrument')").run();
    if (r1.changes + r2.changes) {
      console.log(`🏢 资源分类迁移完成：${r1.changes} 条空间资源、${r2.changes} 条物品资源已归入新两类`);
    }
  }
  db.exec('PRAGMA user_version = 2;');
  userVer = 2;
}

if (userVer < 3) {
  // 强制实名：给所有未实名（real_name=''）用户补发一条 personal_notice（铃铛自动计入）。
  // user_version 闸门保证整段只执行一次；NOT EXISTS 仅作防御性幂等。
  const missing = db.prepare("SELECT id FROM user WHERE COALESCE(real_name, '') = ''").all();
  const insRealNameNotice = db.prepare(
    `INSERT INTO personal_notice (user_id, type, title, content, link)
       SELECT ?, 'realname_required', ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM personal_notice WHERE user_id = ? AND type = 'realname_required' AND is_read = 0
       )`
  );
  for (const u of missing) {
    insRealNameNotice.run(
      u.id,
      '【重要】请完成实名认证',
      '资源预约、经费报销、物料采购需填写真实姓名后才能使用，请在账号安全页完成实名认证。',
      '/account-security',
      u.id
    );
  }
  db.exec('PRAGMA user_version = 3;');
  userVer = 3;
  if (missing.length) console.log(`🪪 实名提醒公告补发完成：${missing.length} 位未实名用户已收到个人公告`);
}

// 兜底：任何漏网的空 slug（正常不会有——发帖即生成；迁移后从备份恢复等边缘情况自愈）
for (const p of db.prepare("SELECT id, user_id, title FROM share_post WHERE slug = '' ORDER BY id").all()) {
  db.prepare('UPDATE share_post SET slug = ? WHERE id = ?')
    .run(uniquePostSlug(db, p.user_id, p.title, p.id), p.id);
}

// 唯一索引必须在 slug 回填之后建：老库所有行初始 slug='' 会直接撞唯一约束
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_user_phone ON user(phone) WHERE phone != ''");
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_share_post_owner_slug ON share_post(user_id, slug)');

// 飞书绑定表 v2：站级单绑定(id=1) → 每用户绑定(user_id 主键，一飞书账号可绑多个网页账号)
// 老库旧表作废重建（旧数据仅一个测试绑定，需重新授权一次）；新库 schema.sql 已建新表，此处跳过
const bindCols = db.prepare('PRAGMA table_info(feishu_bind)').all();
if (bindCols.length && !bindCols.some((c) => c.name === 'user_id')) {
  db.exec('DROP TABLE feishu_bind');
  db.exec(`CREATE TABLE feishu_bind (
    user_id INTEGER PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
    open_id TEXT NOT NULL,
    user_name TEXT DEFAULT '',
    avatar_url TEXT DEFAULT '',
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    access_exp INTEGER NOT NULL,
    refresh_exp INTEGER NOT NULL DEFAULT 0,
    create_time TEXT DEFAULT (datetime('now','localtime')),
    update_time TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX idx_feishu_bind_open ON feishu_bind(open_id);`);
}

// 成员多角色桥表：新库 schema.sql 已建；老库手动建表 + 从 team_member.role_id 搬迁存量角色
const hasTMR = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='team_member_role'").get();
if (!hasTMR) {
  db.exec(`CREATE TABLE IF NOT EXISTS team_member_role (
    team_id INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES team_role(id) ON DELETE CASCADE,
    PRIMARY KEY(team_id, user_id, role_id))`);
}
db.prepare(
  'INSERT OR IGNORE INTO team_member_role (team_id, user_id, role_id) SELECT team_id, user_id, role_id FROM team_member WHERE role_id IS NOT NULL'
).run();

// 报销行表 v2：team_id 放开可空（NULL = 全项目统一支付行，不属任何队伍）。SQLite 不能原地去 NOT NULL
// → 关 FK 后建 v2 拷数据 → drop 旧表 → rename；索引随 DROP 消失，这里重建（新库 schema.sql 已含新定义，跳过）
const erCols = db.prepare('PRAGMA table_info(expense_row)').all();
if (erCols.length && erCols.some((c) => c.name === 'team_id' && c.notnull === 1)) {
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(`BEGIN;
    CREATE TABLE expense_row_v2 (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  INTEGER NOT NULL REFERENCES expense_project(id) ON DELETE CASCADE,
      team_id     INTEGER REFERENCES expense_team(id) ON DELETE CASCADE,
      category    TEXT NOT NULL, owner_name TEXT NOT NULL, data TEXT NOT NULL,
      create_time TEXT DEFAULT (datetime('now','localtime')),
      update_time TEXT DEFAULT (datetime('now','localtime'))
    );
    INSERT INTO expense_row_v2 (id, project_id, team_id, category, owner_name, data, create_time, update_time)
      SELECT id, project_id, team_id, category, owner_name, data, create_time, update_time FROM expense_row;
    DROP TABLE expense_row;
    ALTER TABLE expense_row_v2 RENAME TO expense_row;
    COMMIT;`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_expense_row_p ON expense_row(project_id);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_expense_row_team ON expense_row(team_id);');
  db.exec('PRAGMA foreign_keys = ON;');
}

// 报销附件表 v3：去掉 UNIQUE(row_id, slot) —— 统一支付行（team_id 空=全项目统一支付区/⑥零散票据，或
// 统一支付范围非空）每槽可存多份附件（同槽多份独立管理、只增不替，配额兜底）；"单人行每槽一份、重传=替换"
// 改为路由层约束。SQLite 不能原地去约束 → 关 FK 重建（同 v2 手法）；新库 schema.sql 已无该约束（无 autoindex）则跳过
const attAuto = db.prepare("PRAGMA index_list('expense_attach')").all();
if (attAuto.some((x) => x.origin === 'u')) {
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(`BEGIN;
    CREATE TABLE expense_attach_v3 (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  INTEGER NOT NULL REFERENCES expense_project(id) ON DELETE CASCADE,
      row_id      INTEGER NOT NULL REFERENCES expense_row(id) ON DELETE CASCADE,
      slot        TEXT NOT NULL,
      orig_name   TEXT NOT NULL, store_name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
      create_time TEXT DEFAULT (datetime('now','localtime'))
    );
    INSERT INTO expense_attach_v3 (id, project_id, row_id, slot, orig_name, store_name, mime, size, create_time)
      SELECT id, project_id, row_id, slot, orig_name, store_name, mime, size, create_time FROM expense_attach;
    DROP TABLE expense_attach;
    ALTER TABLE expense_attach_v3 RENAME TO expense_attach;
    COMMIT;`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_expense_attach_p ON expense_attach(project_id);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_expense_attach_r ON expense_attach(row_id);');
  db.exec('PRAGMA foreign_keys = ON;');
}

export default db;
export { DB_PATH };
