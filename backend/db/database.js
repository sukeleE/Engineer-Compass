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

export default db;
export { DB_PATH };
