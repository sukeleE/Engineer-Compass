// SQLite 连接模块（Node 内置 node:sqlite，无需安装原生依赖）
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
migCol('team_message', 'attachments', "ALTER TABLE team_message ADD COLUMN attachments TEXT DEFAULT '[]'");
migCol('user_study', 'user_id', 'ALTER TABLE user_study ADD COLUMN user_id INTEGER');
migCol('user', 'email', 'ALTER TABLE user ADD COLUMN email TEXT'); // SQLite 不支持 ADD COLUMN UNIQUE，唯一性用索引保证
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_user_email ON user(email)');
migCol('user', 'avatar', 'ALTER TABLE user ADD COLUMN avatar TEXT'); // 头像 dataURL（feedback 表靠 schema.sql IF NOT EXISTS，无需迁移）
migCol('user', 'status', 'ALTER TABLE user ADD COLUMN status INTEGER DEFAULT 0'); // 0=正常 1=封禁 2=禁言（后台管理）
migCol('user', 'is_ghost', 'ALTER TABLE user ADD COLUMN is_ghost INTEGER DEFAULT 0'); // 幽灵模式（秘密通道，仅幽灵可见内容）
migCol('share_post', 'is_ghost', 'ALTER TABLE share_post ADD COLUMN is_ghost INTEGER DEFAULT 0'); // 1=幽灵帖（仅幽灵用户可见）
migCol('user_resource', 'share_token', 'ALTER TABLE user_resource ADD COLUMN share_token TEXT'); // 公开分享 token（引用功能：可撤销下载链接）
migCol('user_resource', 'feishu_token', 'ALTER TABLE user_resource ADD COLUMN feishu_token TEXT'); // 飞书分享：云盘 file_token（撤销分享时删除飞书文件）
migCol('team_file', 'resource_ref', 'ALTER TABLE team_file ADD COLUMN resource_ref INTEGER'); // 引用型文件：指向 user_resource.id（data 为空）

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
