// 对话式 AI 计划冒烟测试（node 内联 fetch，依赖本地后端已启动）
// 覆盖：mode 校验、首轮必提问、两轮后出计划并入库（study/schedule/team-generate/team-edit/schedule-edit/study-edit）、
//      未登录 401、非组长 403、POST /team 带对话结果（departments+plan）建组、mergeDone 保留勾选（确定性单测）
import db from '../db/database.js';
import { mergeDone } from '../routes/planChat.js';
import { normalizePlan } from '../routes/schedule.js';

const BASE = 'http://localhost:3000/api';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

async function req(path, opts = {}, timeoutMs = 0) {
  const ctrl = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
  const res = await fetch(BASE + path, {
    signal: ctrl,
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const chat = (mode, messages, extra = {}, token) =>
  req('/plan-chat', { method: 'POST', token, body: JSON.stringify({ mode, messages, ...extra }) }, 120000);
const Q2 = [ // 两轮问答（≥4 条消息触发强制出计划）
  { role: 'assistant', content: '请问关键信息1？' },
  { role: 'user', content: '回答1：零基础，每周10小时，8周内，目标能独立完成项目' },
  { role: 'assistant', content: '关键信息2？' },
  { role: 'user', content: '回答2：从9月到11月，3人小组，会C语言' },
];

const Y = 'pch_' + Date.now().toString().slice(-6);
const leftover = []; // 清理清单

// 0) mergeDone 单测（不依赖 AI，确定性）
console.log('— mergeDone 保留勾选（单测）');
const norm = { phases: [{ phase: '基础', tasks: [{ text: '任务A', done: false }, { text: '任务B', done: false }] }] };
const old = { phases: [{ phase: '基础', tasks: [{ text: '任务A', done: true, done_by: '小明', done_at: '2026-08-01' }, { text: '任务C', done: true }] }] };
mergeDone(norm, old);
ok('同文本任务保留 done/done_by/done_at', norm.phases[0].tasks[0].done === true && norm.phases[0].tasks[0].done_by === '小明' && norm.phases[0].tasks[0].done_at === '2026-08-01');
ok('新任务不受影响', norm.phases[0].tasks[1].done === false);
// normalizePlan 必须保留 dept/done_by（曾丢弃导致小组计划任务全变「通用」）
const np = normalizePlan({ phases: [{ phase: 'p', tasks: [{ text: 't', dept: '视觉组', done: true, done_by: '小明' }] }] });
ok('normalizePlan 保留 dept/done_by', np.phases[0].tasks[0].dept === '视觉组' && np.phases[0].tasks[0].done_by === '小明', JSON.stringify(np.phases[0].tasks[0]));
// stars/links 元数据保留：mergeDone 拷回 + normalizePlan 清洗非法值
const mdOld = { phases: [{ phase: '基础', tasks: [{ text: '任务A', done: true, stars: 4, links: [{ title: '教程', url: 'https://a.com' }] }] }] };
const mdNorm = { phases: [{ phase: '基础', tasks: [{ text: '任务A', done: false, stars: null, links: [] }] }] };
mergeDone(mdNorm, mdOld);
ok('mergeDone 保留 stars/links', mdNorm.phases[0].tasks[0].stars === 4 && mdNorm.phases[0].tasks[0].links[0]?.url === 'https://a.com', JSON.stringify(mdNorm.phases[0].tasks[0]));
const np2 = normalizePlan({ phases: [{ phase: 'p', tasks: [{ text: 't', stars: 9, links: [{ url: 'javascript:alert(1)' }, { url: 'https://ok.com', title: '好' }] }] }] });
ok('normalizePlan 清洗非法 stars/links', np2.phases[0].tasks[0].stars === null && np2.phases[0].tasks[0].links.length === 1 && np2.phases[0].tasks[0].links[0].url === 'https://ok.com', JSON.stringify(np2.phases[0].tasks[0]));
// 多次任务元数据：mergeDone 拷回 mode/target/completions + normalizePlan 派生校正/清洗
const mdMulti = { phases: [{ phase: '基础', tasks: [{ text: '任务A', done: true, mode: 'multi', target: 3, completions: [{ by: '小明', at: '2026-08-01', uid: 1 }] }] }] };
const mdNorm2 = { phases: [{ phase: '基础', tasks: [{ text: '任务A', done: false, mode: 'once', target: null, completions: [] }] }] };
mergeDone(mdNorm2, mdMulti);
ok('mergeDone 保留 mode/target/completions', mdNorm2.phases[0].tasks[0].mode === 'multi' && mdNorm2.phases[0].tasks[0].target === 3 && mdNorm2.phases[0].tasks[0].completions[0]?.at === '2026-08-01', JSON.stringify(mdNorm2.phases[0].tasks[0]));
const np3 = normalizePlan({ phases: [{ phase: 'p', tasks: [{ text: 't', mode: 'multi', target: 2, completions: [{ by: '甲', at: '2026-08-01', uid: 1 }, { by: '乙', at: '2026-08-02' }, { by: '', at: '2026-08-03' }, { by: '丙', at: '08-03' }] }] }] });
const np3t = np3.phases[0].tasks[0];
ok('normalizePlan 清洗 completions（空 by/坏日期过滤）+ 达标派生 done', np3t.mode === 'multi' && np3t.target === 2 && np3t.completions.length === 2 && np3t.done === true, JSON.stringify(np3t));
const np3b = normalizePlan({ phases: [{ phase: 'p', tasks: [{ text: 't', mode: 'multi', target: 99, completions: [{ by: '甲', at: '2026-08-01', uid: 1 }] }] }] });
ok('normalizePlan 未达标 → done false', np3b.phases[0].tasks[0].done === false, '');
const np3c = normalizePlan({ phases: [{ phase: 'p', tasks: [{ text: 't', mode: 'multi', target: 500 }] }] });
ok('normalizePlan 非法 target 清洗为 null（读入口兜底 3）', np3c.phases[0].tasks[0].target === null && np3c.phases[0].tasks[0].mode === 'multi', JSON.stringify(np3c.phases[0].tasks[0]));

// 1) mode 校验 + 首轮必提问
console.log('— 协议校验');
let r = await req('/plan-chat', { method: 'POST', body: JSON.stringify({ mode: 'hack', messages: [] }) });
ok('mode 非法 → 400', r.status === 400, `got ${r.status}`);
r = await chat('study', []);
ok('study 首轮（空历史）→ question', r.status === 200 && r.data.action === 'question' && !!r.data.reply, `got ${r.status} ${r.data.action}`);
r = await req('/plan-chat', { method: 'POST', body: JSON.stringify({ mode: 'team-generate', team_id: 1, comp_id: 1, messages: [] }) });
ok('team 模式未登录 → 401', r.status === 401, `got ${r.status}`);

// 2) study 对话生成（匿名 → user_id null）
console.log('— study 对话生成');
r = await chat('study', Q2);
ok('study 两轮后 → plan 入库', r.status === 200 && r.data.action === 'plan' && r.data.plan_id, `got ${r.status} ${r.data.action}`);
const studyId = r.data.plan_id;
const stRow = db.prepare('SELECT user_id, topic, plan_json FROM user_study WHERE id = ?').get(studyId);
ok('匿名 study user_id=null 且含 topic', stRow && stRow.user_id === null && stRow.topic, JSON.stringify(stRow?.user_id));
ok('study phases 归一化（任务对象）', JSON.parse(stRow.plan_json).phases.every((p) => p.tasks.every((t) => typeof t === 'object' && 'text' in t)));
leftover.push(`study:${studyId}`);

// 3) 注册组长 A / 组员 B
console.log('— 准备');
r = await req('/auth/register', { method: 'POST', body: JSON.stringify({ username: Y + '_a', password: 'test123456', email: Y + '_a@test.dev' }) });
ok('注册组长', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const tokA = r.data.token;
r = await req('/auth/register', { method: 'POST', body: JSON.stringify({ username: Y + '_b', password: 'test123456', email: Y + '_b@test.dev' }) });
ok('注册组员B', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const tokB = r.data.token;

// 4) 对话式建组：POST /team 带 departments+plan（不选竞赛）
r = await chat('team-create', Q2, {}, tokA);
ok('team-create 对话 → plan+departments（不保存）', r.status === 200 && r.data.action === 'plan' && r.data.departments?.length >= 2 && r.data.plan?.phases?.length >= 1, `got ${r.status} ${r.data.action} ${r.data.error || ''}`);
ok('departments 不含「通用」', !(r.data.departments || []).some((d) => d.name === '通用'), JSON.stringify(r.data.departments?.map((d) => d.name)));
r = await req('/team', { method: 'POST', token: tokA, body: JSON.stringify({ name: Y + '_组', departments: r.data.departments, plan: r.data.plan }) });
ok('POST /team 带对话结果 → 201 + plan_id', r.status === 201 && r.data.plan_id, `got ${r.status} ${r.data.error || ''}`);
const teamId = r.data.id;
ok('建组部门角色齐全', r.data.ai_depts?.length === r.data.ai_depts?.length && r.data.ai_depts.length >= 2, JSON.stringify(r.data.ai_depts));
const tpRow = db.prepare('SELECT plan_json FROM team_plan WHERE id = ?').get(r.data.plan_id);
ok('小组计划已入库（含 dept/role_id）', tpRow && JSON.parse(tpRow.plan_json).phases.every((p) => p.tasks.every((t) => t.dept)), '');

// 5) team-generate：B 403 / A 成功
console.log('— team-generate 权限与生成');
const comp = (await req('/competition?status=active')).data[0];
r = await chat('team-generate', Q2, { team_id: teamId, comp_id: comp.id }, tokB);
ok('非组长 B → 403', r.status === 403, `got ${r.status}`);
r = await chat('team-generate', Q2, { team_id: teamId, comp_id: comp.id }, tokA);
ok('组长 A 两轮后 → plan + plan_id', r.status === 200 && r.data.action === 'plan' && r.data.plan_id, `got ${r.status} ${r.data.action}`);
const genPid = r.data.plan_id;
const tp2 = db.prepare('SELECT plan_json, title FROM team_plan WHERE id = ?').get(genPid);
ok('team-generate 入库（title=竞赛名）', tp2 && tp2.title === comp.name, `got ${tp2?.title}`);
ok('新建部门角色存在', !r.data.departments.length || db.prepare('SELECT COUNT(*) c FROM team_role WHERE team_id = ?').get(teamId).c >= 3, '');

// 6) team-edit：同一计划原地更新
r = await chat('team-edit', Q2, { team_id: teamId, plan_id: genPid }, tokA);
ok('team-edit → 同 plan_id 更新', r.status === 200 && r.data.action === 'plan' && r.data.plan_id === genPid && r.data.plan.phases?.length >= 1, `got ${r.status} ${r.data.action}`);
r = await chat('team-edit', Q2, { team_id: teamId, plan_id: genPid }, tokB);
ok('非组长 B 修改 → 403', r.status === 403, `got ${r.status}`);

// 7) schedule 对话生成（登录）→ is_custom=0
console.log('— schedule 对话');
r = await chat('schedule', Q2, { comp_id: comp.id }, tokA);
ok('schedule → plan 入库', r.status === 200 && r.data.action === 'plan' && r.data.plan_id, `got ${r.status} ${r.data.action}`);
const sid = r.data.plan_id;
const sRow = db.prepare('SELECT user_id, is_custom, plan_json FROM user_schedule WHERE id = ?').get(sid);
ok('schedule is_custom=0 且绑定登录用户', sRow && sRow.is_custom === 0 && Number(sRow.user_id) > 0, JSON.stringify(sRow));
leftover.push(`schedule:${sid}`);

// 8) schedule-edit：同 id 更新
r = await chat('schedule-edit', Q2, { schedule_id: sid }, tokA);
ok('schedule-edit → 同 id 更新', r.status === 200 && r.data.action === 'plan' && r.data.plan_id === sid, `got ${r.status} ${r.data.action}`);

// 9) study-edit：同 id 更新
r = await chat('study-edit', Q2, { study_id: studyId });
ok('study-edit → 同 id 更新', r.status === 200 && r.data.action === 'plan' && r.data.plan_id === studyId, `got ${r.status} ${r.data.action}`);

// 10) 清理
console.log('— 清理');
r = await req(`/team/${teamId}`, { method: 'DELETE', token: tokA });
ok('解散小组', r.status === 200, `got ${r.status}`);
for (const l of leftover) {
  const [t, id] = l.split(':');
  db.prepare(`DELETE FROM ${t === 'study' ? 'user_study' : 'user_schedule'} WHERE id = ?`).run(Number(id));
}
db.prepare('DELETE FROM user WHERE username IN (?, ?)').run(Y + '_a', Y + '_b');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
