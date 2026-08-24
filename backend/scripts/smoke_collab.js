// 小组协作全链路冒烟测试：计划同步 / 富文本进度汇报+附件 / 讨论附图
// 运行：node scripts/smoke_collab.js （需后端已启动）
const BASE = 'http://localhost:3000/api';
const N = (Date.now() % 100000).toString(36); // 用户唯一后缀
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

async function req(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { data = await res.text(); }
  return { status: res.status, data };
}
const json = (r) => typeof r.data === 'string' ? JSON.parse(r.data) : r.data;

// 小附件（1x1 PNG base64 片段 + 文本/音频/视频模拟）
const IMG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const AUD = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
const VID = 'AAAAHGZ0eXBtcDQyAAAAAG1wNDJpc29tcDJhaXYxAAAAHGZ0eXBtcDQyAAAAAG1wNDJpc29tcDJhaXYx';

(async () => {
  // ========== 1. 计划同步 ==========
  console.log('▶ 1 计划同步');
  const ra = await req('POST', '/auth/register', { username: `p_${N}a`, password: 'pass1234', email: `p_${N}a@test.dev`, nickname: '组长阿明' });
  const rb = await req('POST', '/auth/register', { username: `p_${N}b`, password: 'pass1234', email: `p_${N}b@test.dev`, nickname: '组员小丽' });
  const ta = json(ra).token, tb = json(rb).token;
  ok(!!ta && !!tb, '注册两位用户');
  const rc = await req('POST', '/team', { name: `同步组_${N}` }, ta);
  const team = json(rc);
  ok(rc.status === 201 && team.id, '组长创建小组');
  // 成员用邀请码加入
  const rd = await req('POST', '/team/join', { invite_code: team.invite_code }, tb);
  ok(rd.status === 201, '成员加入小组');
  // 成员生成备赛计划 + 学习日程（带 token → 绑定 user_id）
  const rs1 = await req('POST', '/schedule/add', { comp_id: 1 }, tb);
  ok(rs1.status === 201, '成员生成备赛计划');
  const rs2 = await req('POST', '/study/plan', { topic: 'PCB 设计入门', level: '零基础' }, tb);
  ok(rs2.status === 201, '成员生成学习日程');
  // 组长也生成一个学习日程
  const rs3 = await req('POST', '/study/plan', { topic: 'ROS 机器人', level: '入门' }, ta);
  ok(rs3.status === 201, '组长生成学习日程');
  // 计划同步接口
  const rp = await req('GET', `/team/${team.id}/plans`, null, ta);
  const plans = json(rp);
  ok(rp.status === 200, 'GET /team/:id/plans 200');
  const my = plans.find((m) => m.user_id === json(ra).user.id);
  const mb = plans.find((m) => m.user_id === json(rb).user.id);
  ok(!!my && !!mb, '返回两位成员', JSON.stringify(plans.map((m) => ({ u: m.user_id, s: m.schedules.length, st: m.studies.length }))));
  ok(mb && mb.schedules.length >= 1 && mb.studies.length >= 1, '成员备赛计划+学习日程均可见');
  ok(my && my.is_owner && my.studies.length >= 1, '组长学习日程可见且标记 is_owner');
  // 匿名用户（无 token）不能访问
  const rp2 = await req('GET', `/team/${team.id}/plans`);
  ok(rp2.status === 401, '未登录访问 plans 返回 401');

  // ========== 2. 富文本进度汇报 + 附件 ==========
  console.log('▶ 2 进度汇报（富文本+附件）');
  const rl1 = await req('POST', `/team/${team.id}/log`, {
    content: '<h3>本周完成</h3><p>完成了<strong>电源模块</strong>调试，附原理图：</p><img src="data:image/png;base64,' + IMG + '">',
    attachments: [
      { name: '原理图.png', size: 89, mime: 'image/png', data: IMG },
      { name: '测试录音.m4a', size: 60, mime: 'audio/mp4', data: AUD },
      { name: '演示视频.mp4', size: 60, mime: 'video/mp4', data: VID },
      { name: '报告.docx', size: 60, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: VID },
    ],
  }, tb);
  ok(rl1.status === 201, '提交富文本+4种附件', `status=${rl1.status} ${JSON.stringify(rl1.data)}`);
  const rl2 = await req('GET', `/team/${team.id}/logs`, null, ta);
  const logs = json(rl2);
  const l = logs.find((x) => x.user_id === json(rb).user.id);
  ok(!!l && l.attachments.length === 4 && l.attachments[0].name === '原理图.png', '日志附件解析完整');
  // 空内容+空附件 → 400
  const rl3 = await req('POST', `/team/${team.id}/log`, { content: '<p><br></p>', attachments: [] }, tb);
  ok(rl3.status === 400, '空内容拒绝');
  // 附件超限（26MB base64）→ 拒绝
  const big = 'A'.repeat(26 * 1024 * 1024);
  const rl4 = await req('POST', `/team/${team.id}/log`, { content: '超限测试', attachments: [{ name: 'big.bin', size: 100, mime: 'application/octet-stream', data: big }] }, tb);
  ok(rl4.status === 413, '附件>25MB 拒绝(413)', `status=${rl4.status}`);
  // 无 progress 权限角色 → 403（复用上一轮验证思路：新建只读角色）
  // 注册第三人加入，组长将其改为「只读观察员」角色（仅 message 权限，无 progress）
  const rc3 = await req('POST', '/auth/register', { username: `p_${N}c`, password: 'pass1234', email: `p_${N}c@test.dev`, nickname: '路人丙' });
  const tc3 = json(rc3).token;
  const rj = await req('POST', '/team/join', { invite_code: team.invite_code }, tc3);
  ok(rj.status === 201, '第三人加入（默认组员角色）');
  const rr = await req('POST', `/team/${team.id}/role`, { name: '只读观察员', level: 1, permissions: ['message'] }, ta);
  ok(rr.status === 201, '创建只读角色');
  const rm2 = await req('POST', `/team/${team.id}/member`, { user_id: json(rc3).user.id, role_id: json(rr).id }, ta);
  ok(rm2.status === 200, '组长调整第三人角色为只读');
  const rl5 = await req('POST', `/team/${team.id}/log`, { content: '尝试汇报', attachments: [] }, tc3);
  ok(rl5.status === 403, '无 progress 权限者提交汇报 403');

  // ========== 3. 讨论附图 ==========
  console.log('▶ 3 讨论附图');
  const rm1 = await req('POST', `/team/${team.id}/message`, {
    content: '机械结构改版，看下图',
    attachments: [
      { name: '结构图.png', size: 89, mime: 'image/png', data: IMG },
      { name: '渲染图.png', size: 89, mime: 'image/png', data: IMG },
    ],
  }, tb);
  ok(rm1.status === 201, '消息附带2张图片', `status=${rm1.status} ${JSON.stringify(rm1.data)}`);
  const rm2x = await req('GET', `/team/${team.id}/messages`, null, ta);
  const msgs = json(rm2x);
  const msg = msgs.find((x) => x.attachments.length === 2);
  ok(!!msg && msg.attachments.every((a) => a.mime.startsWith('image/')), '消息图片附件解析');
  const rm3 = await req('POST', `/team/${team.id}/message`, { content: '', attachments: [] }, tb);
  ok(rm3.status === 400, '空消息拒绝');

  // ========== 4. 评论回复（日志 + 消息） ==========
  console.log('▶ 4 评论回复');
  const lid = l.id; // 成员小丽的汇报
  const mid = msg.id; // 成员小丽的消息
  const cm1 = await req('POST', `/team/${team.id}/comment/log/${lid}`, { content: '电源波形我看到了，纹波还要再压一压' }, ta);
  ok(cm1.status === 201, '组长评论成员汇报', `status=${cm1.status}`);
  const cm2 = await req('POST', `/team/${team.id}/comment/message/${mid}`, { content: '结构图上齿轮位置 OK' }, ta);
  ok(cm2.status === 201, '组长评论讨论消息');
  const cm3 = await req('POST', `/team/${team.id}/comment/log/${lid}`, { content: '只读观察员也能评论' }, tc3);
  ok(cm3.status === 201, '任意成员可评论（只读角色）');
  const cm4 = await req('POST', `/team/${team.id}/comment/log/${lid}`, { content: '   ' }, tb);
  ok(cm4.status === 400, '空评论拒绝');
  const cm5 = await req('POST', `/team/${team.id}/comment/log/99999`, { content: '不存在的日志' }, tb);
  ok(cm5.status === 404, '评论目标不存在 404');
  // 列表带评论
  const rl6 = await req('GET', `/team/${team.id}/logs`, null, ta);
  const l2 = json(rl6).find((x) => x.id === lid);
  ok(l2 && l2.comments.length === 2 && l2.comments[0].nickname === '组长阿明', '日志评论随列表返回');
  const rm4 = await req('GET', `/team/${team.id}/messages`, null, ta);
  const m2 = json(rm4).find((x) => x.id === mid);
  ok(m2 && m2.comments.length === 1, '消息评论随列表返回');
  // 删除：本人可删，他人不可
  const own = l2.comments.find((c) => c.user_id === json(ra).user.id); // 组长自己的
  const cm6 = await req('DELETE', `/team/${team.id}/comment/${own.id}`, null, tc3);
  ok(cm6.status === 403, '他人评论不可删 403');
  const cm7 = await req('DELETE', `/team/${team.id}/comment/${own.id}`, null, ta);
  ok(cm7.status === 200, '本人评论可删');
  const cm8 = await req('GET', `/team/${team.id}/logs`, null, ta);
  ok(json(cm8).find((x) => x.id === lid).comments.length === 1, '删除后评论数正确');

  // ========== 清理 ==========
  console.log('▶ 清理');
  const rd1 = await req('DELETE', `/team/${team.id}`, null, ta);
  ok(rd1.status === 200, '解散测试小组');

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('脚本异常:', e); process.exit(2); });
