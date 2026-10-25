// 借用登记并入预约模块后的后端冒烟（沙盒自起后端：临时库 + 临时上传目录，端口 3108）
// 覆盖：按项目登记（设备/教室）· 校验 · 关闭项目 · 占位资源隐藏与防护 · 甘特排除登记行 ·
//   列表原图剥离/详情原图 · 我的预约 · 登记随时取消 · 借用记录权限/跨项目/筛选/导出 ·
//   借用记录管理员跨项目看原图 · 旧实验室端点已下线。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BACKEND = join(ROOT, 'backend');
const PORT = 3108;
const BASE = `http://localhost:${PORT}/api`;
const backendRequire = createRequire(join(BACKEND, 'server.js'));
const XLSX = backendRequire('xlsx');

const work = mkdtempSync(join(tmpdir(), 'smk-borrow-'));
const serverEnv = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  PORT: String(PORT),
  DB_PATH: join(work, 'compass.db'),
  SHARE_UPLOAD_DIR: join(work, 'share'),
  HONOR_UPLOAD_DIR: join(work, 'honor'),
  PURCHASE_UPLOAD_DIR: join(work, 'purchase'),
};

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { cond ? (pass++, console.log(`✅ ${name}`)) : (fail++, console.log(`❌ ${name}${extra ? ` → ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : ''}`)); };

const req = async (path, opts = {}) => {
  const headers = { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) };
  const res = await fetch(BASE + path, {
    headers, method: opts.method || 'GET',
    body: (opts.method === 'GET' || opts.method === 'HEAD' || opts.body === undefined)
      ? undefined : JSON.stringify(opts.body),
  });
  const data = await res.json().catch(() => ({}));
  return { res, status: res.status, data };
};
const api = async (path, opts = {}) => {
  const r = await req(path, opts);
  if (!r.res.ok) throw new Error(`${opts.method || 'GET'} ${path} → ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const serverLog = [];
let server;
try {
  server = spawn(process.execPath, [join(BACKEND, 'server.js')], {
    cwd: work, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  });
  server.stdout.on('data', (b) => String(b).split('\n').filter(Boolean).forEach((l) => serverLog.push(l)));
  server.stderr.on('data', (b) => String(b).split('\n').filter(Boolean).forEach((l) => serverLog.push(l)));

  const ready = await (async () => {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) return true; } catch { /* 等 */ }
      await new Promise((s) => setTimeout(s, 250));
    }
    return false;
  })();
  if (!ready) throw new Error('临时后端 15s 内未就绪');

  const db = new DatabaseSync(serverEnv.DB_PATH);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON');

  const stamp = Date.now().toString(36);
  const mk = async (who, name) => {
    const r = await api('/auth/register', { method: 'POST', body: { email: `${who}_${stamp}@x.dev`, password: 'pass123456', nickname: name } });
    await api('/auth/real-name', { method: 'PUT', token: r.token, body: { real_name: name } });
    return [r.user, r.token];
  };
  const [A, tA] = await mk('rega', '负责人甲');
  const [B, tB] = await mk('regb', '登记人乙');
  const [L, tL] = await mk('regl', '记录管理员');

  await api('/auth/student-no', { method: 'PUT', token: tB, body: { student_no: '2023123456' } });

  const p1 = (await api('/booking/projects', { method: 'POST', token: tA, body: { name: `登记项目-${stamp}` } })).project;
  const p2 = (await api('/booking/projects', { method: 'POST', token: tA, body: { name: `关闭项目-${stamp}` } })).project;

  // ---------- 1. 按项目登记 ----------
  let r = await req(`/booking/projects/${p1.id}/borrow-registrations`, {
    method: 'POST', token: tB,
    body: { kind: 'device', item_name: '冒烟万用表', item_image: PNG, item_thumb: PNG, purpose: '端到端' },
  });
  ok('设备登记 → 201', r.status === 201, r.status);
  const b1 = r.data.booking;
  ok('登记行：confirmed/零时长/学号快照/类型', b1
    && b1.status === 'confirmed' && b1.start_time === b1.end_time && b1.item_kind === 'device'
    && b1.booker_student_no === '2023123456' && b1.item_name === '冒烟万用表', b1);
  ok('登记响应列表口径不带原图但带缩略图', b1.item_image === '' && !!b1.item_thumb);

  r = await req(`/booking/projects/${p1.id}/borrow-registrations`, {
    method: 'POST', token: tB, body: { kind: 'room', item_name: 'N2-201' },
  });
  ok('教室登记缺照片 → 400', r.status === 400, r.status);
  r = await req(`/booking/projects/${p1.id}/borrow-registrations`, {
    method: 'POST', token: tB, body: { kind: 'device', item_name: '', item_image: PNG },
  });
  ok('设备登记缺名称 → 400', r.status === 400, r.status);

  // ---------- 2. 关闭项目禁登（关闭后已有登记的成员也不能再登） ----------
  const b3 = (await req(`/booking/projects/${p2.id}/borrow-registrations`, {
    method: 'POST', token: tB, body: { kind: 'device', item_name: '关闭前登记', item_image: PNG },
  })).data.booking;
  await api(`/booking/projects/${p2.id}`, { method: 'PUT', token: tA, body: { status: 'closed' } });
  r = await req(`/booking/projects/${p2.id}/borrow-registrations`, {
    method: 'POST', token: tB, body: { kind: 'device', item_name: '关闭项目设备', item_image: PNG },
  });
  ok('已关闭项目登记 → 403', r.status === 403, r.status);

  // ---------- 3. 占位资源：隐藏 + 防护 ----------
  const carrier = db.prepare("SELECT * FROM booking_resource WHERE project_id = ? AND is_carrier = 1").get(p1.id);
  ok('首条登记幂等创建占位资源', !!carrier && carrier.name === '借用登记' && carrier.quantity === 999999, carrier);
  const res1 = await api(`/booking/projects/${p1.id}/resources`, { token: tB });
  ok('资源列表不含占位资源', res1.resources.every((x) => x.name !== '借用登记' && !x.is_carrier));
  const p1fresh = (await api(`/booking/projects/${p1.id}`, { token: tB })).project;
  ok('项目资源计数不含占位资源', p1fresh.resource_count === 0, p1fresh.resource_count);

  r = await req(`/booking/projects/${p1.id}/resources`, {
    method: 'POST', token: tA, body: { kind: 'item', name: '借用登记', quantity: 1, unit: '件' },
  });
  ok('占位名禁止建资源 → 400', r.status === 400, r.status);
  r = await req(`/booking/projects/${p1.id}/bookings`, {
    method: 'POST', token: tB,
    body: { resource_id: carrier.id, start_time: b1.start_time, end_time: b1.start_time, source: 'solo' },
  });
  ok('占位资源禁止直接预约 → 400', r.status === 400, r.status);
  r = await req(`/booking/resources/${carrier.id}`, { method: 'PUT', token: tA, body: { name: 'x' } });
  ok('占位资源禁止修改 → 400', r.status === 400, r.status);
  r = await req(`/booking/resources/${carrier.id}/archive`, { method: 'POST', token: tA });
  ok('占位资源禁止归档 → 400', r.status === 400, r.status);

  // ---------- 4. 甘特排除登记行与占位资源 ----------
  const tl = await api(`/booking/projects/${p1.id}/timeline`, { token: tB });
  ok('甘特资源无占位资源', tl.resources.every((x) => x.id !== carrier.id));
  ok('甘特预约无登记行', tl.bookings.every((x) => x.id !== b1.id) && tl.bookings.length === 0, tl.bookings.length);

  // ---------- 5. 项目预约表 / 我的预约 / 详情 ----------
  const listRows = (await req(`/booking/projects/${p1.id}/bookings?status=confirmed`, { token: tB })).data.bookings;
  ok('项目确认列表含登记行（带缩略图不带原图）', listRows.some((x) => x.id === b1.id && x.item_kind === 'device' && x.item_image === '' && !!x.item_thumb));
  const mine = await api('/booking/bookings/mine', { token: tB });
  ok('我的预约含登记行', mine.bookings.some((x) => x.id === b1.id && x.item_name === '冒烟万用表'), mine.bookings.length);
  const detail = await api(`/booking/bookings/${b1.id}`, { token: tB });
  ok('详情回原图', detail.booking.item_image === PNG);

  // ---------- 6. 登记可随时由本人取消（零时长，开始后也允许） ----------
  r = await req(`/booking/bookings/${b1.id}/cancel`, { method: 'POST', token: tB, body: {} });
  ok('本人取消登记 → 200', r.status === 200, r.status);

  // 再登一条教室，留给管理端断言
  const b2 = (await req(`/booking/projects/${p1.id}/borrow-registrations`, {
    method: 'POST', token: tB, body: { kind: 'room', item_name: 'N2-201', item_image: PNG },
  })).data.booking;

  // ---------- 7. 借用记录管理端 ----------
  r = await req('/booking/borrow-records', { token: tB });
  ok('普通学生看全局记录 → 403', r.status === 403, r.status);
  r = await req('/booking/borrow-records', { token: tL });
  ok('未授权管理员 → 403', r.status === 403, r.status);

  db.prepare("UPDATE user SET is_admin = 1, admin_perms = ? WHERE id = ?").run('["lab"]', L.id);

  r = await req('/booking/borrow-records', { token: tL });
  ok('借用记录管理员 → 200', r.status === 200, r.status);
  const recs = r.data.records;
  ok('全局记录跨项目聚合（本库 3 条：取消设备 + 教室 + 关闭项目设备）', recs.length === 3, recs.length);
  ok('记录带类型/缩略图/无原图', recs.every((x) => !x.item_image && (x.kind === 'device' || x.kind === 'room')));
  ok('记录含两个项目名', new Set(recs.map((x) => x.project_name)).size === 2);
  ok('统计：device=2 room=1 people=1', r.data.stats.device === 2 && r.data.stats.room === 1 && r.data.stats.people === 1, r.data.stats);
  r = await req(`/booking/borrow-records?project_id=${p2.id}`, { token: tL });
  ok('按项目筛选（关闭项目保留 1 条历史登记）', r.data.records.length === 1 && r.data.records[0].id === b3.id, r.data.records.length);
  r = await req('/booking/borrow-records?kind=room', { token: tL });
  ok('按类型筛选 room=1', r.data.records.length === 1 && r.data.records[0].id === b2.id);

  // 管理员跨项目打开登记原图
  r = await req(`/booking/bookings/${b2.id}`, { token: tL });
  ok('借用记录管理员跨项目看详情原图 → 200', r.status === 200 && r.data.booking.item_image === PNG, r.status);

  // 导出 xlsx：表头含「所属项目」，数据含项目名
  const xres = await fetch(`${BASE}/booking/borrow-records/export`, { headers: { Authorization: `Bearer ${tL}` } });
  ok('导出 → 200', xres.ok, xres.status);
  const xb = Buffer.from(await xres.arrayBuffer());
  const wb = XLSX.read(xb, { type: 'buffer' });
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  ok('导出表头含所属项目', aoa[0][1] === '所属项目', aoa[0]);
  ok('导出行含项目名与教室编号', aoa.slice(1).some((row) => row[1] === p1.name && row[3] === 'N2-201'), aoa.slice(1));

  // ---------- 8. 旧实验室端点已下线 ----------
  for (const [method, path, body] of [
    ['POST', '/booking/lab-project', {}],
    ['POST', '/booking/borrow-registrations', {}],
    ['GET', '/booking/lab-overview', undefined],
  ]) {
    const g = await req(path, { method, token: tA, body });
    ok(`旧端点 ${method} ${path} → 404`, g.status === 404, g.status);
  }

  // ---------- 9. 大厅不再隐藏任何项目 ----------
  const hall = await api('/booking/projects', { token: tB });
  ok('预约大厅可见两个开放/关闭口径项目（不再有实验室过滤）', hall.projects.some((x) => x.id === p1.id));

  server.kill();
  rmSync(work, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error(e);
  console.log('---- server log ----\n' + serverLog.join('\n'));
  try { server.kill(); } catch { /* 已退出 */ }
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}
