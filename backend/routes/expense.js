// 报销整理模块路由（挂载 /api/expense）：
// 身份三层 —— owner（登录且是项目负责人）/ member（X-Claim-Token 认领，token 仅走请求头，
//   永不进 URL/query —— access_log 会记录 originalUrl）/ guest（code 即钥匙，只读）
// 负责人可能同时是队员（expense_member.is_owner=1 条目）：登录即占用该队员身份 ——
//   identity owner 分支带 member=自己条目、他人 claim 该名 403（防伪冒）、录入自己费用归属此名
// 路由顺序：开放组 /o/:code… 全部先声明；owner 组 /:id… 后声明（数值守卫 + authRequired）
// 文件落盘 backend/uploads/expense/{code}/{rowId}/{slot}/，DB 只存元数据
import { Router } from 'express';
import multer from 'multer';
import { mkdirSync, existsSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import db from '../db/database.js';
import { authRequired, optionalAuth, logAudit, genInviteCode } from './middleware.js';
import {
  CAT_KEYS, SLOTS, normData, safeParseData, sanitizeName, mimeByExt, isInlineMime, catMeta,
} from '../lib/expenseMeta.js';
import { buildZip } from '../lib/zipStore.js';
import { buildExpenseWorkbook } from '../lib/expenseExcel.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const EXPENSE_ROOT = join(__dirname, '..', 'uploads', 'expense');
const MAX_FILE = 25 * 1024 * 1024;                                       // 单附件 ≤25MB（发票 PDF/截图够用）
const QUOTA = Number(process.env.EXPENSE_PROJECT_QUOTA) || 3 * 1024 * 1024 * 1024; // 每项目附件软配额 3GB（env 可调）
mkdirSync(EXPENSE_ROOT, { recursive: true });

const r = Router();
const intParam = (v) => { const n = Number(v); return Number.isInteger(n) ? n : null; };
const dirs = {
  row: (code, rid) => join(EXPENSE_ROOT, String(code), String(rid)),
  slot: (code, rid, slot) => join(EXPENSE_ROOT, String(code), String(rid), String(slot)),
};
const rmDir = (p) => { try { rmSync(p, { recursive: true, force: true }); } catch {} };
const unlinkQuiet = (p) => { try { if (existsSync(p)) unlinkSync(p); } catch {} };

const safeInt = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : 0);

// ==================== 开放组：/o/:code（code 即邀请码，可匿名只读） ====================
const o = Router();
o.use(optionalAuth);

// 项目 + 请求身份
function loadProject(code) {
  const p = db.prepare('SELECT * FROM expense_project WHERE code = ?').get(String(code || ''));
  return p || null;
}
// 负责人本人的队员身份（is_owner 条目：负责人可能同时是队员——登录即占用，无 claim token）
function selfMember(p) {
  return db.prepare('SELECT * FROM expense_member WHERE project_id = ? AND is_owner = 1').get(p.id) || null;
}
function identity(req, p) {
  // 登录的负责人：owner 态同时带上自己的队员身份（member=自己 is_owner 条目或 null），
  // 便于前端显示「我/本人合计」；owner 分支的写权限不依赖 member，故无副作用
  if (req.user && String(req.user.id) === String(p.owner)) return { role: 'owner', member: selfMember(p) };
  const tok = String(req.headers['x-claim-token'] || '');
  if (tok && tok.length <= 128) {
    const m = db.prepare(
      `SELECT m.*, t.name AS team_name FROM expense_member m
       JOIN expense_team t ON t.id = m.team_id
       WHERE m.claim_token = ? AND t.project_id = ?`
    ).get(tok, p.id);
    if (m) return { role: 'member', member: m };
  }
  return { role: 'guest', member: null };
}
// member 可写行校验：返回 null=放行，否则 {status,error}
// 2026-09-04 放开：成员可操作「自己队伍」的全部行 —— 代录/编辑/删附件不限行归属（行记在谁名下均可，
//   创建时归属白名单=本队名单兜底）；跨队行与项目级行（team_id 空=全项目统一支付）仍仅负责人
function rowWriteError(ctx, p, row) {
  if (ctx.role === 'owner') return null;
  if (ctx.role === 'guest') return { status: 403, error: '请先认领你的身份（打开链接后选自己姓名）' };
  if (String(p.status) !== 'open') return { status: 403, error: '该项目已截止填报，如需修改请联系负责人' };
  if (row && row.team_id == null) return { status: 403, error: '全项目统一支付仅负责人可操作（成员请找负责人代录）' };
  if (row && Number(row.team_id) !== Number(ctx.member.team_id)) return { status: 403, error: '只能操作自己队伍里的记录（跨队记录请找该队成员或负责人）' };
  return null;
}
// 审计（匿名成员动作 user 字段为空照记，detail 带 code 便于排查）
const audit = (req, action, target, detail) => logAudit(req, action, target, { code: req.params.code, ...(detail || {}) });

function rowOut(row, atts = []) {
  return { id: row.id, team_id: row.team_id, category: row.category, owner_name: row.owner_name,
           data: safeParseData(row.data), update_time: row.update_time, atts };
}
function attsOf(rowId) {
  return db.prepare('SELECT id, row_id, slot, orig_name, mime, size, create_time FROM expense_attach WHERE row_id = ? ORDER BY id').all(rowId);
}

// 完整只读 payload（owner 工具列表页复用）；ctx = identity() 返回值 {role, member}
function projectPayload(code, ctx = null) {
  const p = loadProject(code);
  if (!p) return null;
  const teams = db.prepare('SELECT id, name, ord FROM expense_team WHERE project_id = ? ORDER BY ord, id').all(p.id);
  const members = db.prepare('SELECT * FROM expense_member WHERE project_id = ? ORDER BY ord, id').all(p.id);
  const rows = db.prepare('SELECT * FROM expense_row WHERE project_id = ? ORDER BY id').all(p.id);
  const atts = db.prepare('SELECT * FROM expense_attach WHERE project_id = ? ORDER BY id').all(p.id);
  const attsByRow = new Map();
  for (const a of atts) {
    if (!attsByRow.has(a.row_id)) attsByRow.set(a.row_id, []);
    attsByRow.get(a.row_id).push({ id: a.id, slot: a.slot, orig_name: a.orig_name, mime: a.mime, size: a.size, create_time: a.create_time });
  }
  const perMember = new Map();
  for (const x of rows) perMember.set(x.owner_name, (perMember.get(x.owner_name) || 0) + 1);
  return {
    project: { id: p.id, name: p.name, event: p.event, code: p.code, status: p.status, create_time: p.create_time },
    me: { role: ctx?.role || 'guest', member: ctx?.member || null },
    teams,
    members: members.map((m) => ({
      id: m.id, team_id: m.team_id, name: m.name,
      isOwner: !!m.is_owner,           // 负责人本人的队员身份（登录占用、不可认领）
      claimed: !!(m.claim_token || m.is_owner), // is_owner 条目恒为已认领（占用权=负责人登录态）
      rowCount: perMember.get(m.name) || 0,
      me: !!(ctx && ((ctx.role === 'member' && m.id === ctx.member.id)
        || (ctx.role === 'owner' && m.is_owner))), // owner 态下自己的队员条目也打「我」
    })),
    rows: rows.map((x) => rowOut(x, attsByRow.get(x.id) || [])),
  };
}

// GET /o/:code —— 完整只读快照（含认领态与文件元数据）
o.get('/:code', (req, res) => {
  const p = loadProject(req.params.code);
  if (!p) return res.status(404).json({ error: '邀请码不存在，请核对链接或联系负责人' });
  const ctx = identity(req, p);
  res.json(projectPayload(p.code, ctx));
});

// POST /o/:code/claim —— 认领身份：一个账户（X-Claim-Token，浏览器存 expense_claim_{code}）在同一项目内只占一个名字。
// 已认领者再 claim 他人 = 换名：事务内释放旧行、目标行复用同一 token（前端存储无需变）；全新设备首认领发新 token。
// 跨项目互不影响（token 按项目行查询，属别的项目的 token 在此视为无身份）。
o.post('/:code/claim', (req, res) => {
  const p = loadProject(req.params.code);
  if (!p) return res.status(404).json({ error: '邀请码不存在' });
  const name = String((req.body || {}).name || '').trim().slice(0, 20);
  if (!name) return res.status(400).json({ error: '请填写姓名' });
  const m = db.prepare('SELECT * FROM expense_member WHERE project_id = ? AND name = ?').get(p.id, name);
  if (!m) return res.status(404).json({ error: '名单里没有这个名字，请检查姓名或联系负责人添加' });
  // 负责人本人的队员身份：登录即占用（identity owner 分支），无需也绝不能由队员认领/代领 —— 防伪冒其名下记录
  if (m.is_owner) {
    return res.status(403).json({ error: `「${name}」是负责人本人的队员身份（负责人登录即可填报自己费用），队员不能认领或代领；你的开销请认领自己的姓名` });
  }
  if (m.claim_token) {
    const mine = String(req.headers['x-claim-token'] || '') === String(m.claim_token);
    return res.status(409).json({ error: mine ? `你已经认领「${name}」了` : `「${name}」已被他人认领（若认领错了或重复姓名，找负责人重置或区分）` });
  }
  const curTok = String(req.headers['x-claim-token'] || '');
  const old = curTok ? db.prepare('SELECT * FROM expense_member WHERE project_id = ? AND claim_token = ?').get(p.id, curTok) : null;
  if (old) {
    // 换名：释放旧名字 → 认领新名字（同一 token 复用，原设备身份不间断）
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE expense_member SET claim_token = NULL, claim_at = NULL WHERE id = ?').run(old.id);
      db.prepare("UPDATE expense_member SET claim_token = ?, claim_at = datetime('now','localtime') WHERE id = ?").run(curTok, m.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    audit(req, 'expense-claim-switch', m.name, { mid: m.id, fromMid: old.id, fromName: old.name });
    res.status(201).json({ token: curTok, member: { id: m.id, team_id: m.team_id, name: m.name }, switchedFrom: old.name });
    return;
  }
  const token = randomBytes(16).toString('hex');
  db.prepare("UPDATE expense_member SET claim_token = ?, claim_at = datetime('now','localtime') WHERE id = ?").run(token, m.id);
  audit(req, 'expense-claim', m.name, { mid: m.id });
  res.status(201).json({ token, member: { id: m.id, team_id: m.team_id, name: m.name } });
});

// POST /o/:code/release —— 放弃认领（换身份入口：先放弃才能认领别的名字；负责人本人的身份不可放弃）
o.post('/:code/release', (req, res) => {
  const p = loadProject(req.params.code);
  if (!p) return res.status(404).json({ error: '邀请码不存在' });
  const tok = String(req.headers['x-claim-token'] || '');
  if (!tok) return res.status(400).json({ error: '未认领任何身份' });
  const m = db.prepare('SELECT * FROM expense_member WHERE project_id = ? AND claim_token = ?').get(p.id, tok);
  if (!m) return res.status(404).json({ error: '身份已失效（可能已被负责人重置），刷新页面重新认领即可' });
  if (m.is_owner) return res.status(403).json({ error: '负责人本人的身份由登录占用，无需也不可放弃' });
  db.prepare('UPDATE expense_member SET claim_token = NULL, claim_at = NULL WHERE id = ?').run(m.id);
  audit(req, 'expense-claim-release', m.name, { mid: m.id });
  res.json({ message: `已放弃「${m.name}」，可重新认领其他名字` });
});

// 行写操作通用装配：查项目/行/身份 → 校验 → 返回 ctx,row 或已响应
function loadRowForWrite(req, res, needRow = true) {
  const p = loadProject(req.params.code);
  if (!p) { res.status(404).json({ error: '邀请码不存在' }); return null; }
  const ctx = identity(req, p);
  let row = null;
  if (needRow) {
    const rid = intParam(req.params.rid);
    row = rid ? db.prepare('SELECT * FROM expense_row WHERE id = ? AND project_id = ?').get(rid, p.id) : null;
    if (!row) { res.status(404).json({ error: '记录不存在' }); return null; }
  }
  return { p, ctx, row };
}
function touch(p) {
  db.prepare("UPDATE expense_project SET update_time = datetime('now','localtime') WHERE id = ?").run(p.id);
}

// POST /o/:code/row —— 新增费用行
// 队伍行：member 可给本队名单任意成员代录（归属=所选本队成员，默认自己）；prop 公共行（归属"队伍"）仅负责人
// project_pay 项目级行：全项目统一支付（不属任何队伍，显示在全部小队之外的区块）——仅负责人可建
o.post('/:code/row', (req, res) => {
  const got = loadRowForWrite(req, res, false);
  if (!got) return;
  const { p, ctx } = got;
  const body = req.body || {};
  const category = String(body.category || '');
  if (!CAT_KEYS.includes(category)) return res.status(400).json({ error: '费用类别不正确' });
  const norm = normData(category, body.data);
  if (!norm.ok) return res.status(400).json({ error: norm.error });
  const data = norm.data;

  // ---- 全项目统一支付/零散票据（team_id = NULL；仅负责人；范围=勾选名单或'全体成员'，不必全含） ----
  if (body.project_pay) {
    if (ctx.role !== 'owner') {
      return res.status(403).json({ error: '全项目统一支付仅负责人可录入（成员请找负责人代录）' });
    }
    const owner_name = String(body.owner_name || '').trim().slice(0, 20);
    const inRoster = db.prepare('SELECT id FROM expense_member WHERE project_id = ? AND name = ?').get(p.id, owner_name);
    const isMe = owner_name && (owner_name === String(req.user?.username || '')
      || (req.user?.nickname && owner_name === String(req.user.nickname)));
    if (!owner_name || owner_name === '队伍' || (!inRoster && !isMe)) {
      return res.status(400).json({ error: '出钱人需是项目名单成员或负责人本人（跨队成员也可）' });
    }
    // 涵盖范围（2026-09-03 下午放开）：'全体成员' 关键词或勾选名单（⊆ 全项目名单，可跨队）；misc/其他可留空
    // 项目级行没有"本队"概念，'全部成员' 在此无意义 → 明确拒绝
    const payScope = String(data['统一支付范围'] || '').trim();
    if (payScope === '全部成员') {
      return res.status(400).json({ error: '项目级记录没有"本队"概念 —— 选「整个项目全体成员」，或直接勾选包含的成员' });
    }
    if (payScope && payScope !== '全体成员') {
      const want = payScope.split(/[、,，\s]+/).map((s) => s.trim()).filter(Boolean);
      const have = new Set(db.prepare('SELECT name FROM expense_member WHERE project_id = ?').all(p.id).map((r) => r.name));
      const bad = want.find((n) => !have.has(n));
      if (bad) return res.status(400).json({ error: `包含的「${bad}」不是本项目名单成员（跨队也须先在各队名单预录）` });
    }
    const ins = db.prepare('INSERT INTO expense_row (project_id, team_id, category, owner_name, data) VALUES (?,?,?,?,?)')
      .run(p.id, null, category, owner_name, JSON.stringify(data));
    touch(p);
    audit(req, 'expense-row-create', owner_name, { cat: category, rid: Number(ins.lastInsertRowid), projPay: 1 });
    const row = db.prepare('SELECT * FROM expense_row WHERE id = ?').get(Number(ins.lastInsertRowid));
    return res.status(201).json({ row: rowOut(row, attsOf(row.id)), warnings: norm.warnings });
  }

  // ---- 队伍行 ----
  if (category === 'misc') {
    return res.status(400).json({ error: '零散票据（⑥）仅可在「全项目统一支付」区添加 —— 它不属任何队伍，含多人/跨队票据放那里' });
  }
  const team_id = safeInt(body.team_id);
  const team = db.prepare('SELECT id FROM expense_team WHERE id = ? AND project_id = ?').get(team_id, p.id);
  if (!team) return res.status(400).json({ error: '请选择正确的队伍' });
  if (ctx.role === 'guest') return res.status(403).json({ error: '请先认领你的身份' });
  if (ctx.role === 'member' && String(p.status) !== 'open') return res.status(403).json({ error: '该项目已截止填报' });
  if (ctx.role === 'member' && Number(team_id) !== Number(ctx.member.team_id)) {
    return res.status(403).json({ error: '只能给本队录入' });
  }
  // 服务端注入归属，payload 无法伪装 —— member 可代录本队名单任意成员（2026-09-04 放开），跨队名单 403
  let owner_name;
  if (ctx.role === 'member') {
    owner_name = String(body.owner_name || '').trim().slice(0, 20) || String(ctx.member.name);
    const inRoster = db.prepare('SELECT id FROM expense_member WHERE project_id = ? AND name = ? AND team_id = ?').get(p.id, owner_name, team_id);
    if (!inRoster) {
      return res.status(403).json({ error: '只能给本队名单成员录入（出钱人需是本队成员或你本人；代录他人选其名字即可）' });
    }
    if (category === 'prop' && String(data.购买人 || '') !== String(owner_name)) {
      return res.status(403).json({ error: '耗材道具的购买人需与归属成员一致（公用物品请找负责人录入）' });
    }
  } else {
    owner_name = String(body.owner_name || '').trim().slice(0, 20);
    const inRoster = db.prepare('SELECT id FROM expense_member WHERE project_id = ? AND name = ? AND team_id = ?').get(p.id, owner_name, team_id);
    const isTeamProp = category === 'prop' && owner_name === '队伍' && String(data.购买人 || '') === '队伍';
    if (!inRoster && !isTeamProp) {
      return res.status(400).json({ error: '归属成员需是该队名单中的一员（公用耗材购买人填“队伍”）' });
    }
  }
  // 统一支付范围（仅创建校验；更新时属文本快照不再追溯）：
  // '全部成员'=本队全体 / '全体成员'=整个项目全体（关键词免校验）；分隔名单可跨队（垫付他队成员），都须在本项目名单内
  const payScope = String(data['统一支付范围'] || '').trim();
  if (payScope && payScope !== '全部成员' && payScope !== '全体成员') {
    const want = payScope.split(/[、,，\s]+/).map((s) => s.trim()).filter(Boolean);
    const have = new Set(db.prepare('SELECT name FROM expense_member WHERE project_id = ?').all(p.id).map((r) => r.name));
    const bad = want.find((n) => !have.has(n));
    if (bad) return res.status(400).json({ error: `统一支付包含的「${bad}」不是本项目名单成员（跨队也须先在各队名单预录）` });
  }
  const ins = db.prepare('INSERT INTO expense_row (project_id, team_id, category, owner_name, data) VALUES (?,?,?,?,?)')
    .run(p.id, team_id, category, owner_name, JSON.stringify(data));
  touch(p);
  audit(req, 'expense-row-create', owner_name, { cat: category, rid: Number(ins.lastInsertRowid) });
  const row = db.prepare('SELECT * FROM expense_row WHERE id = ?').get(Number(ins.lastInsertRowid));
  res.status(201).json({ row: rowOut(row, attsOf(row.id)), warnings: norm.warnings });
});

// PUT /o/:code/row/:rid —— 改行（类别与归属不可改；member 仅本队行、仅 data；负责人可移队）
o.put('/:code/row/:rid', (req, res) => {
  const got = loadRowForWrite(req, res);
  if (!got) return;
  const { p, ctx, row } = got;
  const err = rowWriteError(ctx, p, row);
  if (err) return res.status(err.status).json({ error: err.error });
  const norm = normData(row.category, (req.body || {}).data);
  if (!norm.ok) return res.status(400).json({ error: norm.error });
  const data = norm.data;
  if (row.category === 'prop') {
    // member 可代录本队行，但购买人不可改归属：须与该行归属成员一致（公用行=“队伍”）
    if (ctx.role === 'member' && String(data.购买人 || '') !== String(row.owner_name)) {
      return res.status(403).json({ error: `耗材道具的购买人须与该行归属成员一致（归属：${row.owner_name}；公用物品请找负责人）` });
    }
    if (ctx.role === 'owner' && String(row.owner_name) === '队伍' && String(data.购买人 || '') !== '队伍') {
      return res.status(403).json({ error: '公用物品行的购买人应为“队伍”' });
    }
  }
  let team_id = row.team_id;
  if (row.team_id == null) {
    // 项目级行（全项目统一支付/零散票据）：固定不属任何队伍、不可移入队伍；
    // 涵盖范围=文本快照随客户端保存（2026-09-03 下午起允许勾选子集/留空，不再强制'全体成员'）
  } else if (ctx.role === 'owner') {
    const t2 = safeInt((req.body || {}).team_id);
    if (t2 && db.prepare('SELECT id FROM expense_team WHERE id = ? AND project_id = ?').get(t2, p.id)) team_id = t2;
  }
  db.prepare("UPDATE expense_row SET data = ?, team_id = ?, update_time = datetime('now','localtime') WHERE id = ?")
    .run(JSON.stringify(data), team_id, row.id);
  touch(p);
  audit(req, 'expense-row-update', row.owner_name, { cat: row.category, rid: row.id });
  const fresh = db.prepare('SELECT * FROM expense_row WHERE id = ?').get(row.id);
  res.json({ row: rowOut(fresh, attsOf(fresh.id)), warnings: norm.warnings });
});

// DELETE /o/:code/row/:rid —— 删行（先清磁盘附件目录再删 DB，级联清元数据）
o.delete('/:code/row/:rid', (req, res) => {
  const got = loadRowForWrite(req, res);
  if (!got) return;
  const { p, ctx, row } = got;
  const err = rowWriteError(ctx, p, row);
  if (err) return res.status(err.status).json({ error: err.error });
  rmDir(dirs.row(p.code, row.id));
  db.prepare('DELETE FROM expense_row WHERE id = ?').run(row.id);
  touch(p);
  audit(req, 'expense-row-delete', row.owner_name, { cat: row.category, rid: row.id });
  res.json({ message: '记录已删除' });
});

// ---- 附件上传（身份预检在 multer 之前：guest 不落盘） ----
const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      cb(null, req.attDir); // 已由 gate 校验并建目录
    },
    filename(req, file, cb) {
      const ext = extname(basename(String(file.originalname || ''))).slice(0, 16).toLowerCase();
      cb(null, `${Date.now()}_${randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: MAX_FILE + 1 }, // busboy 等值即触发 limit → +1（同 resource.js 注释）
  defParamCharset: 'utf8',             // 中文文件名防 latin1 乱码
});
const slotsOfCat = (cat) => (SLOTS[cat] || []).map((s) => s.key);
// 身份 + 行归属 + 槽位合法性预检（乘数层 error mw 负责 multer 错误文案）
function gateUpload(req, res, next) {
  const got = loadRowForWrite(req, res);
  if (!got) return;
  const { p, ctx, row } = got;
  const err = rowWriteError(ctx, p, row);
  if (err) return res.status(err.status).json({ error: err.error });
  const slot = String(req.query.slot || '');
  if (!slotsOfCat(row.category).includes(slot)) return res.status(400).json({ error: '附件槽位不正确' });
  req.p = p; // 上传 handler 解构 {p, ctx, row, attSlot, attDir}
  req.ctx = ctx;
  req.row = row;
  req.attSlot = slot;
  req.attDir = dirs.slot(p.code, row.id, slot);
  mkdirSync(req.attDir, { recursive: true });
  next();
}
// 本路由的 multer 错误处理（覆盖 server.js 全局"≤128MB"文案；其余透传）
function uploadErr(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '附件过大（单文件 ≤25MB）' });
    return res.status(400).json({ error: `上传失败：${err.message}` });
  }
  next(err);
}

// POST /o/:code/row/:rid/file?slot= — 统一支付行每槽可多份：追加（同槽多份独立管理，份数不限、配额兜底）；
// 单人常规记录（队员个人行且无统一支付范围）仍每槽一份：重传=替换（先删旧盘再插新元数据）
o.post('/:code/row/:rid/file', gateUpload, upload.single('file'), (req, res, next) => {
  try {
    const { p, ctx, row, attSlot, attDir } = req;
    const file = req.file;
    if (!file) return res.status(400).json({ error: '未收到文件（字段名 file，multipart/form-data）' });
    const abs = file.path;
    if (file.size === 0) { unlinkQuiet(abs); return res.status(400).json({ error: '文件为空' }); }
    const used = db.prepare('SELECT COALESCE(SUM(size),0) AS n FROM expense_attach WHERE project_id = ?').get(p.id).n;
    if (used + file.size > QUOTA) {
      unlinkQuiet(abs); rmDir(attDir);
      return res.status(413).json({ error: '该项目附件空间不足，请联系负责人扩容或删除旧附件' });
    }
    // 统一支付行 = 项目级行（team_id 空 = 全项目统一支付区/⑥零散票据）或 统一支付范围 非空（一人垫付多人，
    // 一张票据盖多人/多张原件）→ 该行附件只增不替、每槽可多份（同槽多份独立管理，配额兜底）
    // 单人常规记录（个人行且无范围）→ 维持每槽一份：重传=替换（先删旧盘再插新元数据）
    const payScope = String(safeParseData(row.data)['统一支付范围'] || '').trim();
    const multiOk = row.team_id === null || !!payScope;
    if (!multiOk) {
      const old = db.prepare('SELECT * FROM expense_attach WHERE row_id = ? AND slot = ?').get(row.id, attSlot);
      if (old) {
        unlinkQuiet(join(attDir, old.store_name));
        db.prepare('DELETE FROM expense_attach WHERE id = ?').run(old.id);
      }
    }
    const orig = sanitizeName(file.originalname, 120);
    const mime = mimeByExt(orig);
    const ins = db.prepare('INSERT INTO expense_attach (project_id, row_id, slot, orig_name, store_name, mime, size) VALUES (?,?,?,?,?,?,?)')
      .run(p.id, row.id, attSlot, orig, basename(file.filename), mime, file.size);
    touch(p);
    audit(req, 'expense-att-upload', row.owner_name, { cat: row.category, rid: row.id, slot: attSlot, fid: Number(ins.lastInsertRowid), size: file.size });
    const att = db.prepare('SELECT id, row_id, slot, orig_name, mime, size FROM expense_attach WHERE id = ?').get(Number(ins.lastInsertRowid));
    res.status(201).json({ att, message: '上传成功' });
  } catch (e) {
    if (req.file) unlinkQuiet(req.file.path);
    next(e);
  }
}, uploadErr);

// DELETE /o/:code/row/:rid/file/:fid —— 删除某附件
o.delete('/:code/row/:rid/file/:fid', (req, res) => {
  const got = loadRowForWrite(req, res);
  if (!got) return;
  const { p, ctx, row } = got;
  const err = rowWriteError(ctx, p, row);
  if (err) return res.status(err.status).json({ error: err.error });
  const fid = intParam(req.params.fid);
  const att = fid ? db.prepare('SELECT * FROM expense_attach WHERE id = ? AND row_id = ?').get(fid, row.id) : null;
  if (!att) return res.status(404).json({ error: '附件不存在' });
  unlinkQuiet(join(dirs.slot(p.code, row.id, att.slot), att.store_name));
  db.prepare('DELETE FROM expense_attach WHERE id = ?').run(att.id);
  touch(p);
  audit(req, 'expense-att-delete', row.owner_name, { rid: row.id, slot: att.slot, fid: att.id });
  res.json({ message: '附件已删除' });
});

// GET /o/:code/file/:fid/download —— 开放下载（code 即钥匙）：图片/PDF 默认内联预览，?dl=1 强转附件
o.get('/:code/file/:fid/download', (req, res) => {
  const p = loadProject(req.params.code);
  if (!p) return res.status(404).json({ error: '邀请码不存在' });
  const fid = intParam(req.params.fid);
  const att = fid ? db.prepare('SELECT * FROM expense_attach WHERE id = ? AND project_id = ?').get(fid, p.id) : null;
  if (!att) return res.status(404).json({ error: '附件不存在' });
  const abs = join(dirs.slot(p.code, att.row_id, att.slot), att.store_name);
  if (!existsSync(abs)) return res.status(404).json({ error: '文件已丢失' });
  if (isInlineMime(att.mime) && req.query.dl !== '1') {
    // 内联预览：sendFile 自动带 Content-Type（store_name 保留安全扩展名），不暴露 store 名
    return res.sendFile(abs);
  }
  res.download(abs, att.orig_name);
});

// GET /o/:code/export/zip?team_id= —— 按队伍打包全部附件；team_id=0 = 全项目统一支付行（store-only 零依赖）
o.get('/:code/export/zip', (req, res) => {
  const p = loadProject(req.params.code);
  if (!p) return res.status(404).json({ error: '邀请码不存在' });
  const tid = intParam(req.query.team_id);
  let scopeName = ''; // zip 命名与文案用：队伍名 / 「全项目统一支付」
  let atts;
  if (tid === 0) {
    scopeName = '全项目统一支付';
    atts = db.prepare(
      `SELECT a.*, rr.category, rr.owner_name FROM expense_attach a
       JOIN expense_row rr ON rr.id = a.row_id
       WHERE a.project_id = ? AND rr.team_id IS NULL ORDER BY a.row_id, a.id`
    ).all(p.id);
  } else {
    const team = db.prepare('SELECT * FROM expense_team WHERE id = ? AND project_id = ?').get(tid, p.id);
    if (!team) return res.status(400).json({ error: '队伍不存在' });
    scopeName = team.name;
    atts = db.prepare(
      `SELECT a.*, rr.category, rr.owner_name FROM expense_attach a
       JOIN expense_row rr ON rr.id = a.row_id
       WHERE a.project_id = ? AND rr.team_id = ? ORDER BY a.row_id, a.id`
    ).all(p.id, team.id);
  }
  if (!atts.length) return res.status(404).json({ error: tid === 0 ? '全项目统一支付暂无附件' : '该队暂无附件' });
  const entries = [];
  let total = 0;
  for (const a of atts) {
    const abs = join(dirs.slot(p.code, a.row_id, a.slot), a.store_name);
    if (!existsSync(abs)) continue; // 磁盘缺失的跳过（附件清单页可核对）
    const buf = readFileSync(abs);
    total += buf.length;
    if (total > 400 * 1024 * 1024) {
      return res.status(413).json({ error: '附件总量过大，请逐个下载' });
    }
    const cat = SLOTS[a.category].find((s) => s.key === a.slot)?.label || a.slot;
    // ZIP 目录按分类文件夹（CATEGORIES.folder 驱动：01报名费…06零散票据 —— ⑥仅项目级行会出现）
    const folder = catMeta(a.category)?.folder || '其他';
    entries.push({
      name: `${sanitizeName(folder, 30)}/${a.row_id}-${sanitizeName(cat, 40)}-${sanitizeName(a.owner_name, 20)}-${sanitizeName(a.orig_name, 90)}`,
      data: buf,
    });
  }
  if (!entries.length) return res.status(404).json({ error: '附件文件均已丢失' });
  const zip = buildZip(entries);
  const fname = sanitizeName(`${p.name}-${scopeName}-报销附件`, 80) + '.zip';
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="download.zip"; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.send(zip);
});

// GET /o/:code/export/xlsx —— 汇总 + 每队 sheet + 附件清单
o.get('/:code/export/xlsx', (req, res) => {
  const p = loadProject(req.params.code);
  if (!p) return res.status(404).json({ error: '邀请码不存在' });
  const teams = db.prepare('SELECT id, name FROM expense_team WHERE project_id = ? ORDER BY ord, id').all(p.id);
  const members = db.prepare('SELECT id, team_id, name FROM expense_member WHERE project_id = ? ORDER BY ord, id').all(p.id);
  const rows = db.prepare('SELECT id, team_id, category, owner_name, data FROM expense_row WHERE project_id = ? ORDER BY team_id, id').all(p.id);
  const atts = db.prepare('SELECT row_id, slot, orig_name, size FROM expense_attach WHERE project_id = ?').all(p.id);
  const buf = buildExpenseWorkbook({ project: p, teams, members, rows, atts });
  const fname = sanitizeName(`${p.name}-报销汇总`, 80) + '.xlsx';
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="download.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.send(buf);
});

r.use('/o', o);

// ==================== 负责人组：/:id…（需登录） ====================
r.use(authRequired);

// 找本人负责的项目；不属于自己 → 403（不泄漏他人项目存在性）
function ownProject(req, res) {
  const id = intParam(req.params.id);
  const p = id ? db.prepare('SELECT * FROM expense_project WHERE id = ?').get(id) : null;
  if (!p) return res.status(404).json({ error: '项目不存在' });
  if (String(p.owner) !== String(req.user.id)) return res.status(403).json({ error: '仅项目负责人可操作' });
  return p;
}
const ownerAudit = (req, action, target, detail) => logAudit(req, action, target, detail);

// POST /api/expense —— 建项目（8 位邀请码唯一循环重试）
r.post('/', (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: '请填写项目名称' });
  const event = String((req.body || {}).event || '').trim().slice(0, 60);
  for (let i = 0; i < 20; i++) {
    const code = genInviteCode();
    try {
      const ins = db.prepare('INSERT INTO expense_project (owner, name, event, code) VALUES (?,?,?,?)')
        .run(String(req.user.id), name, event, code);
      ownerAudit(req, 'expense-create', name, { pid: Number(ins.lastInsertRowid), code });
      return res.status(201).json({ id: Number(ins.lastInsertRowid), code, name, event, status: 'open', teams: [] });
    } catch (e) {
      if (!String(e.message || '').includes('UNIQUE')) throw e; // 撞码重试；真错误上抛
    }
  }
  res.status(500).json({ error: '邀请码生成失败，请重试' });
});

// GET /api/expense —— 我的项目列表（含队伍数/条数概览）
r.get('/', (req, res) => {
  const list = db.prepare(
    `SELECT ep.*,
            (SELECT COUNT(*) FROM expense_team et WHERE et.project_id = ep.id) AS team_count,
            (SELECT COUNT(*) FROM expense_member em WHERE em.project_id = ep.id) AS member_count,
            (SELECT COUNT(*) FROM expense_member em2 WHERE em2.project_id = ep.id AND em2.claim_token IS NOT NULL) AS claimed_count,
            (SELECT COUNT(*) FROM expense_row er WHERE er.project_id = ep.id) AS row_count
     FROM expense_project ep WHERE ep.owner = ? ORDER BY ep.id DESC`
  ).all(String(req.user.id));
  res.json(list);
});

// GET /api/expense/:id —— 完整 payload（与 /o/:code 同构，负责人视角 member=自己 is_owner 条目或 null）
r.get('/:id', (req, res) => {
  const p = ownProject(req, res);
  if (!p) return;
  res.json(projectPayload(p.code, { role: 'owner', member: selfMember(p), id: p.id }));
});

// PATCH /api/expense/:id —— 改名/竞赛名/截止与重开
r.patch('/:id', (req, res) => {
  const p = ownProject(req, res);
  if (!p) return;
  const body = req.body || {};
  let name = p.name, event = p.event, status = p.status;
  if (body.name !== undefined) {
    name = String(body.name).trim().slice(0, 40);
    if (!name) return res.status(400).json({ error: '项目名称不能为空' });
  }
  if (body.event !== undefined) event = String(body.event).trim().slice(0, 60);
  if (body.status !== undefined) {
    if (!['open', 'closed'].includes(body.status)) return res.status(400).json({ error: '状态只能为 open / closed' });
    status = body.status;
  }
  db.prepare("UPDATE expense_project SET name = ?, event = ?, status = ?, update_time = datetime('now','localtime') WHERE id = ?")
    .run(name, event, status, p.id);
  ownerAudit(req, 'expense-update', name, { pid: p.id, status });
  res.json({ id: p.id, name, event, status });
});

// DELETE /api/expense/:id —— 删项目（清整目录 + DB 级联）
r.delete('/:id', (req, res) => {
  const p = ownProject(req, res);
  if (!p) return;
  rmDir(join(EXPENSE_ROOT, p.code));
  db.prepare('DELETE FROM expense_project WHERE id = ?').run(p.id);
  ownerAudit(req, 'expense-delete', p.name, { pid: p.id, code: p.code });
  res.json({ message: '项目已删除' });
});

// POST /api/expense/:id/team —— 加队伍（同名 409）
r.post('/:id/team', (req, res) => {
  const p = ownProject(req, res);
  if (!p) return;
  const name = String((req.body || {}).name || '').trim().slice(0, 30);
  if (!name) return res.status(400).json({ error: '请填写队伍名称' });
  if (db.prepare('SELECT id FROM expense_team WHERE project_id = ? AND name = ?').get(p.id, name)) {
    return res.status(409).json({ error: '已有同名队伍' });
  }
  const mx = db.prepare('SELECT COALESCE(MAX(ord),0) AS n FROM expense_team WHERE project_id = ?').get(p.id).n;
  const ins = db.prepare('INSERT INTO expense_team (project_id, name, ord) VALUES (?,?,?)').run(p.id, name, mx + 1);
  ownerAudit(req, 'expense-team-create', name, { pid: p.id, tid: Number(ins.lastInsertRowid) });
  res.status(201).json({ id: Number(ins.lastInsertRowid), name });
});

// 通用：查本人项目下的队伍/成员
function ownTeam(req, res, tid) {
  const t = db.prepare(
    `SELECT t.*, p.code, p.owner FROM expense_team t JOIN expense_project p ON p.id = t.project_id WHERE t.id = ?`
  ).get(tid);
  if (!t) return res.status(404).json({ error: '队伍不存在' });
  if (String(t.owner) !== String(req.user.id)) return res.status(403).json({ error: '仅项目负责人可操作' });
  return t;
}
function ownMember(req, res, mid) {
  const m = db.prepare(
    `SELECT m.*, p.code, p.owner, p.name AS project_name FROM expense_member m
     JOIN expense_project p ON p.id = m.project_id WHERE m.id = ?`
  ).get(mid);
  if (!m) return res.status(404).json({ error: '成员不存在' });
  if (String(m.owner) !== String(req.user.id)) return res.status(403).json({ error: '仅项目负责人可操作' });
  return m;
}

// PATCH /api/expense/team/:tid — 改名（同名 409）
r.patch('/team/:tid', (req, res) => {
  const t = ownTeam(req, res, intParam(req.params.tid));
  if (!t) return;
  const name = String((req.body || {}).name || '').trim().slice(0, 30);
  if (!name) return res.status(400).json({ error: '请填写队伍名称' });
  if (db.prepare('SELECT id FROM expense_team WHERE project_id = ? AND name = ? AND id != ?').get(t.project_id, name, t.id)) {
    return res.status(409).json({ error: '已有同名队伍' });
  }
  db.prepare('UPDATE expense_team SET name = ? WHERE id = ?').run(name, t.id);
  ownerAudit(req, 'expense-team-rename', name, { pid: t.project_id, tid: t.id });
  res.json({ id: t.id, name });
});

// DELETE /api/expense/team/:tid — 删队伍（级联删名单/记录，先清附件磁盘）
r.delete('/team/:tid', (req, res) => {
  const t = ownTeam(req, res, intParam(req.params.tid));
  if (!t) return;
  const rows = db.prepare('SELECT id FROM expense_row WHERE project_id = ? AND team_id = ?').all(t.project_id, t.id);
  for (const x of rows) rmDir(dirs.row(t.code, x.id));
  db.prepare('DELETE FROM expense_team WHERE id = ?').run(t.id);
  ownerAudit(req, 'expense-team-delete', t.name, { pid: t.project_id, tid: t.id, rows: rows.length });
  res.json({ message: '队伍已删除', rows: rows.length });
});

// POST /api/expense/:id/team/:tid/member — 预录名单成员（项目内重名 409）
// 负责人可能同时是队员：姓名=本人昵称/用户名时自动标 is_owner（登录占用，队员不可认领该名，防止伪冒）
r.post('/:id/team/:tid/member', (req, res) => {
  const p = ownProject(req, res);
  if (!p) return;
  const tid = intParam(req.params.tid);
  if (!db.prepare('SELECT id FROM expense_team WHERE id = ? AND project_id = ?').get(tid, p.id)) {
    return res.status(404).json({ error: '队伍不存在' });
  }
  const name = String((req.body || {}).name || '').trim().slice(0, 20);
  if (!name) return res.status(400).json({ error: '请填写姓名' });
  if (db.prepare('SELECT id FROM expense_member WHERE project_id = ? AND name = ?').get(p.id, name)) {
    return res.status(409).json({ error: '项目内已有同名成员（重名者请加队名后缀区分）' });
  }
  const mx = db.prepare('SELECT COALESCE(MAX(ord),0) AS n FROM expense_member WHERE project_id = ?').get(p.id).n;
  const ins = db.prepare('INSERT INTO expense_member (project_id, team_id, name, ord) VALUES (?,?,?,?)')
    .run(p.id, tid, name, mx + 1);
  // 本人快捷标记：姓名与负责人登录账号昵称/用户名一致 → 互斥置 is_owner（项目内仅一个负责人条目）
  const isMe = name === String(req.user?.nickname || '').trim() || name === String(req.user?.username || '').trim();
  if (isMe) {
    db.prepare('UPDATE expense_member SET is_owner = 0 WHERE project_id = ? AND id != ?').run(p.id, Number(ins.lastInsertRowid));
    db.prepare('UPDATE expense_member SET is_owner = 1 WHERE id = ?').run(Number(ins.lastInsertRowid));
  }
  ownerAudit(req, 'expense-member-create', name, { pid: p.id, tid, mid: Number(ins.lastInsertRowid), isOwner: isMe ? 1 : 0 });
  res.status(201).json({ id: Number(ins.lastInsertRowid), team_id: tid, name, is_owner: isMe ? 1 : 0 });
});

// PATCH /api/expense/member/:mid — 改名（同步其记录 owner_name 与 prop 购买人）/ 转队 / 标记负责人本人
r.patch('/member/:mid', (req, res) => {
  const m = ownMember(req, res, intParam(req.params.mid));
  if (!m) return;
  const body = req.body || {};
  const out = { name: m.name, team_id: m.team_id };
  if (body.is_owner !== undefined) {
    const v = body.is_owner === true ? 1 : body.is_owner === false ? 0 : null; // 严格布尔，防字符串脏值
    if (v === null) return res.status(400).json({ error: 'is_owner 需为布尔值' });
    if (v) {
      // 置为负责人本人的队员身份：项目内互斥（仅一个负责人条目）+ 收回被抢先认领的 token（该名登录即占用）
      db.prepare('UPDATE expense_member SET is_owner = 0 WHERE project_id = ? AND id != ?').run(m.project_id, m.id);
      db.prepare('UPDATE expense_member SET claim_token = NULL, claim_at = NULL WHERE id = ?').run(m.id);
      out.claim_token = null;
    }
    db.prepare('UPDATE expense_member SET is_owner = ? WHERE id = ?').run(v, m.id);
    out.is_owner = v;
    ownerAudit(req, v ? 'expense-member-mark-owner' : 'expense-member-unmark-owner', m.name, { pid: m.project_id, mid: m.id });
  }
  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, 20);
    if (!name) return res.status(400).json({ error: '姓名不能为空' });
    if (db.prepare('SELECT id FROM expense_member WHERE project_id = ? AND name = ? AND id != ?').get(m.project_id, name, m.id)) {
      return res.status(409).json({ error: '项目内已有同名成员' });
    }
    db.prepare('UPDATE expense_member SET name = ? WHERE id = ?').run(name, m.id);
    db.prepare('UPDATE expense_row SET owner_name = ? WHERE project_id = ? AND owner_name = ?')
      .run(name, m.project_id, m.name);
    // prop 行 data JSON 里的 购买人 字段同步改名
    const props = db.prepare("SELECT id, data FROM expense_row WHERE project_id = ? AND category = 'prop' AND owner_name = ?")
      .all(m.project_id, name);
    for (const x of props) {
      const d = safeParseData(x.data);
      if (d.购买人 === m.name) {
        d.购买人 = name;
        db.prepare("UPDATE expense_row SET data = ? WHERE id = ?").run(JSON.stringify(d), x.id);
      }
    }
    out.name = name;
    ownerAudit(req, 'expense-member-rename', name, { pid: m.project_id, mid: m.id, from: m.name });
  }
  if (body.team_id !== undefined) {
    const tid = intParam(body.team_id);
    if (!db.prepare('SELECT id FROM expense_team WHERE id = ? AND project_id = ?').get(tid, m.project_id)) {
      return res.status(404).json({ error: '目标队伍不存在' });
    }
    db.prepare('UPDATE expense_member SET team_id = ? WHERE id = ?').run(tid, m.id);
    out.team_id = tid;
    ownerAudit(req, 'expense-member-move', out.name, { pid: m.project_id, mid: m.id, to: tid });
  }
  res.json(out);
});

// DELETE /api/expense/member/:mid — 移出名单（确认文案含将删的记录数；先清其附件磁盘）
r.delete('/member/:mid', (req, res) => {
  const m = ownMember(req, res, intParam(req.params.mid));
  if (!m) return;
  const rows = db.prepare('SELECT id FROM expense_row WHERE project_id = ? AND owner_name = ?').all(m.project_id, m.name);
  for (const x of rows) rmDir(dirs.row(m.code, x.id));
  db.prepare('DELETE FROM expense_row WHERE project_id = ? AND owner_name = ?').run(m.project_id, m.name);
  db.prepare('DELETE FROM expense_member WHERE id = ?').run(m.id);
  ownerAudit(req, 'expense-member-delete', m.name, { pid: m.project_id, mid: m.id, rows: rows.length });
  res.json({ message: '成员已移出', rows: rows.length });
});

// POST /api/expense/member/:mid/reset-claim — 重置认领（旧 token 立即失效，本人可重新认领）
// is_owner 条目（负责人本人）不依赖认领 token：登录即占用，无可重置 —— 改由「标记/取消标记」控制
r.post('/member/:mid/reset-claim', (req, res) => {
  const m = ownMember(req, res, intParam(req.params.mid));
  if (!m) return;
  if (m.is_owner) {
    return res.status(400).json({ error: '「' + m.name + '」是负责人本人的队员身份（登录即占用，无认领 token 可重置）' });
  }
  db.prepare('UPDATE expense_member SET claim_token = NULL, claim_at = NULL WHERE id = ?').run(m.id);
  ownerAudit(req, 'expense-member-reset', m.name, { pid: m.project_id, mid: m.id });
  res.json({ message: '认领已重置，该成员可重新认领' });
});

export default r;
