// 飞书文档互传正式接口（方案三：OpenAPI 实现网站 ↔ 飞书文档双向互传）
// 挂载 /api/feishu：所有飞书调用由本路由代理，App Secret / token 不出服务端
// 页面：/feishu.html（文档列表 / 查看 / 新建 / 追加 / 上传下载 / OAuth 绑定）
// 接口：oauth/status、oauth/auth、oauth/callback、oauth/unbind、doc/list、doc/content、
//       doc/create、doc/append、file/upload、file/download
import { Router } from 'express';
import multer from 'multer';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  FEISHU, configured, appId, parentFolder,
  feishu, feishuError, tenantToken, userToken, saveBind, unbind, bindStatus, getBind,
  openIdFromToken, meInfo, parseFeishuUrl, wikiNode,
} from '../lib/feishuClient.js';
import { blocksToMarkdown, mdToBlocks } from '../lib/feishuConvert.js';
import { htmlToMd, mdToHtml } from '../lib/mdHtml.js';
import { authRequired, optionalAuth } from './middleware.js';
import db from '../db/database.js';

// P1 业务映射白名单：biz_type → {表名, 标题生成, 内容列}
const BIZ = {
  daily_note: { table: 'daily_note', title: (row) => `日程笔记 ${row?.note_date || ''}`.trim() },
  progress_log: { table: 'progress_log', title: () => '进度汇报' },
  share_post: { table: 'share_post', title: (row) => row?.title || '分享帖' },
};

const r = Router();
const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }).single('file');

// 授权回调 redirect_uri：优先 .env 的 FEISHU_REDIRECT_URI，否则按请求 host 动态生成
const redirectUri = (req) => process.env.FEISHU_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/feishu/oauth/callback`;
// 授权 state（内存 Map：state → {userId, exp}，5 分钟过期；回调校验防跨站 + 定位绑定用户）
// 绑定的飞书账号可能同时发多个授权请求，Map 而非单值
const stateMap = new Map();
const STATE_TTL = 5 * 60 * 1000;
function takeState(st) {
  const ent = st && stateMap.get(st);
  if (!ent) return null;
  stateMap.delete(st);
  return (ent.exp > Date.now()) ? ent.userId : null;
}

// 取当前可用身份：登录用户的飞书身份优先（可读用户全部文档/知识库）；
// 未绑定或匿名请求回退应用身份（仅可读已「添加文档应用」授权的文档）
async function pickToken(userId) {
  if (userId !== undefined && userId !== null) {
    const u = await userToken(userId);
    if (u) return { token: u, mode: 'user' };
  }
  try {
    const t = await tenantToken();
    if (t) return { token: t, mode: 'tenant' };
  } catch { /* tenant 不可用则空身份 */ }
  return { token: null, mode: 'none' };
}

const needConfig = (res) => res.status(400).json({ error: '请先在 backend/.env 配置 FEISHU_APP_ID / FEISHU_APP_SECRET' });

// ---------- OAuth 绑定 ----------

// GET /api/feishu/oauth/status — 绑定状态（脱敏）；open_id 缺失时自动补一次（user_info 接口）
// optionalAuth：匿名返回未绑定（不暴露任何数据）；登录返回该用户绑定状态
r.get('/oauth/status', optionalAuth, async (req, res) => {
  const userId = req.user?.id;
  const st = userId === undefined ? { bound: false } : bindStatus(userId);
  if (userId !== undefined && st.bound && !st.open_id) {
    try {
      const u = await userToken(userId);
      if (u) {
        const me = await meInfo(u);
        if (me.open_id) {
          saveBind(userId, { open_id: me.open_id, user_name: me.user_name, avatar_url: me.avatar_url });
          Object.assign(st, { open_id: me.open_id, user_name: me.user_name, avatar_url: me.avatar_url });
        }
      }
    } catch { /* 补不了下次再补 */ }
  }
  res.json({ configured: configured(), app_id: configured() ? appId().slice(0, 6) + '…' + appId().slice(-4) : '', ...st });
});

// OAuth 授权 scope：必须在授权链接显式声明，否则用户只授权身份标识（后台权限 ≠ 用户授权）
// 官方规范：空格分隔（URL 编码）、含 offline_access 才能拿 refresh_token；可用 .env FEISHU_SCOPES 覆盖
const OAUTH_SCOPES = () => (process.env.FEISHU_SCOPES ||
  'contact:contact.base:readonly,docx:document,docx:document:readonly,drive:drive,drive:drive:readonly,wiki:wiki,wiki:wiki:readonly,offline_access');

// GET /api/feishu/oauth/auth — 构造授权链接（登录用户专属；state 绑定 userId 回传）
// 官方地址 accounts.feishu.cn/authen/v1/authorize，client_id+response_type=code，空格分隔 scope
r.get('/oauth/auth', authRequired, (req, res) => {
  if (!configured()) return needConfig(res);
  const st = randomBytes(12).toString('hex');
  stateMap.set(st, { userId: req.user.id, exp: Date.now() + STATE_TTL });
  const scopes = OAUTH_SCOPES().split(',').join(' '); // 空格分隔（官方要求）
  const url = `https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=${appId()}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri(req))}&scope=${encodeURIComponent(scopes)}&state=${st}`;
  res.json({ url, scope: scopes });
});

// GET /api/feishu/oauth/callback?code&state — OAuth 回调：两步授权换 user token，按 state 绑定到发起用户
r.get('/oauth/callback', async (req, res) => {
  // notify=true 时向 opener 发 postMessage（「我的」页绑定卡监听后自动刷新）
  const html = (msg, extra = '', notify = false) => `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>飞书授权回调</title>
<style>body{font-family:system-ui;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#0f172a;color:#e2e8f0;margin:0}div{text-align:center;background:#1e293b;padding:40px 48px;border-radius:16px;max-width:560px}code{background:#0f172a;padding:2px 8px;border-radius:6px;word-break:break-all}h2{margin:0 0 12px}</style></head>
<body><div><h2>${msg}</h2><p>${extra}</p><a href="/feishu.html" style="color:#60a5fa">← 返回互传工作台</a></div>
${notify ? '<script>if (window.opener) window.opener.postMessage({ type: \'feishu-bound\' }, \'*\');</' + 'script>' : ''}
</body></html>`;
  const { code } = req.query;
  if (!code) return res.status(400).send(html('回调缺少 code'));
  const userId = takeState(req.query.state);
  if (userId === null) return res.status(400).send(html('state 校验失败或已过期（防跨站），请重试授权'));
  try {
    // 两步授权：先 app_access_token，再换 user_access_token（oidc v3 不接受 client_secret）
    const appTok = await tenantToken(); // tenant/app 同源，均可作 app_access_token 使用
    const { ok, data } = await feishu('/open-apis/authen/v1/oidc/access_token', {
      method: 'POST',
      body: { grant_type: 'authorization_code', code, app_access_token: appTok },
    });
    console.log(`[feishu] oidc user=${userId}: ok=${ok} code=${data?.code} msg=${data?.msg || ''} nested=${!!data?.data?.access_token}`);
    if (!ok) throw feishuError(data, '换取 token 失败');
    // oidc 系列返回 data.data 嵌套（区别于 tenant token 顶层字段）
    const d = data.data || {};
    const openId = d.open_id || openIdFromToken(d.access_token);
    const me = openId ? {} : await meInfo(d.access_token); // oidc 响应一般无 open_id，用 user_info 兜底
    saveBind(userId, {
      open_id: openId || me.open_id || null,
      user_name: me.user_name || null,
      avatar_url: me.avatar_url || null,
      access_token: d.access_token,
      refresh_token: d.refresh_token || null,
      access_exp: Date.now() + (d.expires_in || 6900) * 1000,
      refresh_exp: d.refresh_token_expires_in ? Date.now() + d.refresh_token_expires_in * 1000 : null,
    });
    res.send(html('✅ 飞书授权成功，已绑定', `open_id：<code>${openId || me.open_id || '-'}</code>，user token 有效 ${(d.expires_in || 6900) / 3600}h`, true));
  } catch (e) {
    res.status(400).send(html('❌ 授权失败', e.message));
  }
});

// POST /api/feishu/oauth/unbind — 解绑当前登录用户的飞书绑定
r.post('/oauth/unbind', authRequired, (req, res) => {
  unbind(req.user.id);
  res.json({ message: '已解绑飞书账号' });
});

// ---------- 文档读取 ----------

// GET /api/feishu/doc/spaces — 知识库空间列表（wiki 用户找 space_id）
r.get('/doc/spaces', optionalAuth, async (req, res) => {
  if (!configured()) return needConfig(res);
  let tok;
  try { ({ token: tok } = await pickToken(req.user?.id)); } catch (e) { return res.status(400).json({ error: e.message }); }
  try {
    const { ok, data } = await feishu('/open-apis/wiki/v2/spaces?page_size=50', { token: tok });
    if (!ok) throw feishuError(data, '知识库空间获取失败');
    res.json({ items: (data.data?.items || []).map((s) => ({ space_id: s.space_id, name: s.name || '', description: s.description || '' })) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// GET /api/feishu/doc/list?folder_token=&space_id= — 文档列表
// folder_token=云空间文件夹（空=我的空间根）；space_id=知识库空间（wiki）
r.get('/doc/list', optionalAuth, async (req, res) => {
  if (!configured()) return needConfig(res);
  const { folder_token = '', space_id = '', page_size = 20 } = req.query;
  let tok;
  try { ({ token: tok } = await pickToken(req.user?.id)); } catch (e) { return res.status(400).json({ error: e.message }); }
  try {
    if (space_id) {
      const { ok, data } = await feishu(`/open-apis/wiki/v2/spaces/${space_id}/nodes?page_size=${page_size}`, { token: tok });
      if (!ok) throw feishuError(data, '知识库节点列表获取失败');
      const items = (data.data?.items || []).map((n) => ({
        token: n.node_token, obj_token: n.obj_token || '', name: n.title || '',
        type: n.obj_type || 'wiki', has_child: !!n.has_child,
        url: n.url || `https://${new URL(redirectUri(req)).host}/wiki/${n.node_token}`,
      }));
      return res.json({ mode: 'wiki', items });
    }
    const q = folder_token ? `folder_token=${encodeURIComponent(folder_token)}&` : '';
    const { ok, data } = await feishu(`/open-apis/drive/v1/files?${q}page_size=${page_size}`, { token: tok });
    if (!ok) throw feishuError(data, '云空间文件列表获取失败');
    // url 兜底构造（部分对象无 url 字段）：飞书链接格式 {type}/{token}，便于前端直接引用
    const base = process.env.FEISHU_URL_BASE || 'https://feishu.cn';
    const items = (data.data?.files || []).map((f) => {
      const type = String(f.type || 'file');
      return {
        token: f.token, obj_token: f.token, name: f.name, type,
        url: f.url || (type === 'folder' ? '' : `${base}/${type}/${f.token}`),
        modified_time: f.modified_time || '',
      };
    });
    res.json({ mode: 'drive', items });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 解析目标文档：document_id 直取；url 自动识别 docx/wiki（用调用方传入的 token 身份，避免 user/tenant 优先级混乱）
async function resolveDoc(req, tok) {
  let docId = String(req.query.document_id || req.body?.document_id || '').trim();
  const url = String(req.query.url || req.body?.url || '').trim();
  if (!docId && url) {
    const p = parseFeishuUrl(url);
    if (!p) throw Object.assign(new Error('链接格式无法识别（需要 xxx.feishu.cn/docx/… 或 wiki/…）'), { bad: 1 });
    if (p.kind !== 'docx' && p.kind !== 'wiki') throw Object.assign(new Error(`暂不支持读取 ${p.kind} 类型，请用 docx 文档`), { bad: 1 });
    if (p.kind === 'wiki') {
      const node = await wikiNode(p.token, tok);
      if (!node || node.obj_type !== 'docx') throw Object.assign(new Error('wiki 节点解析失败或非 docx 文档'), { bad: 1 });
      docId = node.obj_token;
    } else docId = p.token;
  }
  if (!docId) throw Object.assign(new Error('需要 document_id 或文档链接'), { bad: 1 });
  return docId;
}

// GET /api/feishu/doc/content?document_id=&url=&format=markdown|block|text — 读取文档
// markdown=Block→md 渲染；block=原始 Block 列表；text=纯文本（raw_content，最快）
r.get('/doc/content', optionalAuth, async (req, res) => {
  if (!configured()) return needConfig(res);
  const format = String(req.query.format || 'markdown');
  let tok;
  try { ({ token: tok } = await pickToken(req.user?.id)); } catch (e) { return res.status(400).json({ error: e.message }); }
  try {
    const docId = await resolveDoc(req, tok);
    if (format === 'text') {
      const { ok, data } = await feishu(`/open-apis/docx/v1/documents/${docId}/raw_content`, { token: tok });
      if (!ok) throw feishuError(data, '文档读取失败');
      return res.json({ format: 'text', title: (await docTitle(docId, tok)) || '', chars: (data.data?.content || '').length, content: data.data?.content || '' });
    }
    const items = await fetchBlocks(docId, tok);
    // 标题取元数据接口（新版 page 块不含 elements；旧枚举 42 已失效）
    const title = await docTitle(docId, tok);
    if (format === 'block') return res.json({ format: 'block', title, count: items.length, blocks: items });
    // html：md → 服务端渲染 HTML（安全转义），供「计划说明 / 任务描述」等无 HTML 渲染端的导入直接 v-html
    if (format === 'html') return res.json({ format: 'html', title, count: items.length, content: mdToHtml(blocksToMarkdown(items)) });
    return res.json({ format: 'markdown', title, count: items.length, content: blocksToMarkdown(items) });
  } catch (e) {
    console.error(`[feishu] doc/content 失败: ${e.message}`); // 定位用户导入报错：看本行 + 上面的状态码
    res.status(e.bad ? 400 : 500).json({ error: e.message });
  }
});

// 分页拉取文档全部 blocks（复用：读取 / 同步）
async function fetchBlocks(docId, tok) {
  let items = [], pageToken = '', pageSize = 500;
  do {
    const { ok, data } = await feishu(`/open-apis/docx/v1/documents/${docId}/blocks?page_size=${pageSize}${pageToken ? `&page_token=${pageToken}` : ''}`, { token: tok });
    if (!ok) throw feishuError(data, '文档 Block 读取失败');
    items = items.concat(data.data?.items || []);
    pageToken = data.data?.has_more ? data.data?.page_token || '' : '';
  } while (pageToken);
  return items;
}

// P1：飞书文档内容同步回业务表（blocks → markdown → HTML → UPDATE content）
async function syncDocToDb(docId, bizType, bizId, userId) {
  const biz = BIZ[bizType];
  if (!biz) throw Object.assign(new Error(`不支持的业务类型：${bizType}`), { bad: 1 });
  const { token: tok } = await pickToken(userId);
  const items = await fetchBlocks(docId, tok);
  const md = blocksToMarkdown(items);
  const html = mdToHtml(md);
  db.prepare(`UPDATE ${biz.table} SET content = ? WHERE id = ?`).run(html, bizId);
  return { chars: md.length, updated: true };
}

// ---------- P1：业务记录 ↔ 飞书文档（飞书编辑页替代富文本编辑器） ----------

// 定位/创建业务记录并校验归属（biz/open 与 biz/import 共用）：
//   无 biz_id 时自动创建 —— daily_note 按 note_date 幂等查/建；progress_log 需 team_id（校验小组成员）；share_post 需 title
//   有 biz_id 时校验归属（防越权打开/导入他人记录）
// 返回 {id, row}；失败 throw Object.assign(err, { bad: 状态码 })
async function ensureBizRecord(bizType, body, userId) {
  const biz = BIZ[bizType];
  if (!biz) throw Object.assign(new Error('不支持的业务类型（daily_note / progress_log / share_post）'), { bad: 400 });
  // node:sqlite 将 JS number 一律按 double 绑定 → TEXT 列会存成 "323.0" 而非 "323"；
  // user_id 等 TEXT 列一律 String() 统一（与存量数据格式一致，幂等/归属查询才匹配得上）
  const uid = String(userId);
  let id = Number(body.biz_id);
  if (!id) {
    if (bizType === 'daily_note') {
      if (!body.note_date) throw Object.assign(new Error('缺少 note_date'), { bad: 400 });
      // 「写笔记」= 每次新建一篇（同天可多篇，已无唯一索引）；
      // 双击/重复提交竞态窗口（30s 内同日期）复用刚建的记录，防同一次操作双建双文档
      const recent = db.prepare(
        "SELECT id FROM daily_note WHERE user_id = ? AND note_date = ? AND create_time >= datetime('now', '-30 seconds') ORDER BY id DESC LIMIT 1"
      ).get(uid, body.note_date);
      id = recent ? recent.id : Number(db.prepare(
        'INSERT INTO daily_note (user_id, note_date, content) VALUES (?,?,?)').run(uid, body.note_date, '').lastInsertRowid);
    } else if (bizType === 'progress_log') {
      if (!body.team_id) throw Object.assign(new Error('缺少 team_id'), { bad: 400 });
      const member = db.prepare('SELECT id FROM team_member WHERE team_id = ? AND user_id = ?').get(String(body.team_id), uid);
      if (!member) throw Object.assign(new Error('不是小组成员，无法汇报进度'), { bad: 403 });
      id = Number(db.prepare(
        'INSERT INTO progress_log (team_id, user_id, content, attachments) VALUES (?,?,?,?)')
        .run(String(body.team_id), uid, '', '[]').lastInsertRowid);
    } else if (bizType === 'share_post') {
      const t = String(body.title || '').trim().slice(0, 60);
      if (!t) throw Object.assign(new Error('缺少 title'), { bad: 400 });
      id = Number(db.prepare(
        'INSERT INTO share_post (user_id, title, content, attachments) VALUES (?,?,?,?)')
        .run(uid, t, '', '[]').lastInsertRowid);
    } else throw Object.assign(new Error('缺少 biz_id'), { bad: 400 });
  }
  const row = db.prepare(`SELECT * FROM ${biz.table} WHERE id = ?`).get(id);
  if (!row) throw Object.assign(new Error('业务记录不存在'), { bad: 404 });
  if (bizType === 'daily_note' || bizType === 'share_post') {
    if (Number(row.user_id) !== Number(uid)) throw Object.assign(new Error('只能操作自己的记录'), { bad: 403 });
  } else {
    const member = db.prepare('SELECT id FROM team_member WHERE team_id = ? AND user_id = ?').get(String(row.team_id), uid);
    if (!member) throw Object.assign(new Error('不是小组成员，无权操作该汇报'), { bad: 403 });
  }
  return { id, row };
}

// 统一错误状态码：e.bad 可为 1（→400）或显式状态码（403/404）
const errStatus = (e) => (e?.bad ? (Number.isInteger(e.bad) && e.bad > 1 ? e.bad : 400) : 500);

// 同一业务记录并发互斥（防双击/多标签并发把同一记录创建成多个飞书文档）：
// 无映射分支先查映射再创建，两个并发请求会同时命中「无映射」→ 双创建。
// 单进程部署下用内存链式队列，同 key 串行执行即可消除竞态
const bizLocks = new Map();
function withBizLock(key, fn) {
  const prev = bizLocks.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  bizLocks.set(key, next.catch(() => {}));
  return next;
}

// POST /api/feishu/biz/open {biz_type, biz_id?, note_date?, team_id?, title?} — 打开飞书编辑
// biz_id 缺失时自动创建业务记录（「写笔记 / 编写汇报」直跳飞书的入口）
// 无映射：存量 HTML → md → 创建飞书文档（自动加当前用户为协作者）→ 存映射
// 有映射：先同步飞书最新内容回库，返回已有文档
r.post('/biz/open', authRequired, async (req, res) => {
  if (!configured()) return needConfig(res);
  const { biz_type } = req.body || {};
  const bizId = Number(req.body?.biz_id);
  // 无 id（写笔记/汇报直跳新建）：按「用户+意图」串行 —— 30s 窗口复用 + 锁保证同一次操作只建一个记录/文档；
  // 有 id：按记录串行（「查映射→创建文档→写映射」竞态窗口）
  const lockKey = bizId
    ? `open:${biz_type}:${bizId}`
    : `open:${biz_type}:user:${req.user.id}${biz_type === 'daily_note' ? ':' + (req.body?.note_date || '') : ''}`;
  try {
    return await withBizLock(lockKey, async () => {
      const { id, row } = await ensureBizRecord(biz_type, req.body || {}, req.user.id);
      const map = db.prepare('SELECT * FROM feishu_doc_map WHERE biz_type = ? AND biz_id = ?').get(biz_type, id);
      if (map) {
        await syncDocToDb(map.doc_id, biz_type, id, req.user.id); // 打开即同步：先拉飞书最新回库
        return res.json({ id, document_id: map.doc_id, url: map.doc_url, synced: true });
      }
      // 无映射：需用户飞书身份创建文档（未绑定 403 提示）
      const { token: tok, mode } = await pickToken(req.user.id);
      if (mode !== 'user' || !tok) {
        return res.status(403).json({ error: '请先在「我的」页绑定飞书账号，才能创建飞书文档' });
      }
      const md = htmlToMd(row?.content || '');
      const out = await createWithContent({ title: BIZ[biz_type].title(row), content: md }, tok, req.user.id);
      db.prepare('INSERT INTO feishu_doc_map (biz_type, biz_id, doc_id, doc_url) VALUES (?,?,?,?)')
        .run(biz_type, id, out.document_id, out.url);
      res.json({ id, document_id: out.document_id, url: out.url, created: true });
    });
  } catch (e) { res.status(errStatus(e)).json({ error: e.message }); }
});

// POST /api/feishu/biz/import {biz_type, biz_id?, document_id, note_date?, team_id?, title?} — 从飞书文档导入内容
// 与「飞书编辑」的区别：导入不建立映射，之后点「飞书编辑」仍会新建本站自己的文档
// biz_id 缺失时先自动创建业务记录（同 biz/open 规则）——「没有记录直接导入」的入口
r.post('/biz/import', authRequired, async (req, res) => {
  if (!configured()) return needConfig(res);
  const { biz_type } = req.body || {};
  const docId = String(req.body?.document_id || '').trim();
  if (!docId) return res.status(400).json({ error: '需要 document_id' });
  try {
    const { id } = await ensureBizRecord(biz_type, req.body || {}, req.user.id);
    const { token: tok, mode } = await pickToken(req.user.id);
    if (mode !== 'user' || !tok) return res.status(403).json({ error: '请先绑定飞书账号，才能读取飞书文档' });
    const items = await fetchBlocks(docId, tok);
    const md = blocksToMarkdown(items);
    const html = mdToHtml(md);
    db.prepare(`UPDATE ${BIZ[biz_type].table} SET content = ? WHERE id = ?`).run(html, id);
    res.json({ message: '✅ 已从飞书文档导入', chars: md.length, content: html, id });
  } catch (e) { res.status(errStatus(e)).json({ error: e.message }); }
});

// GET /api/feishu/biz/status?biz_type=&biz_id= — 查询业务记录是否已关联飞书文档（嵌入式查看：显示飞书链接）
r.get('/biz/status', authRequired, (req, res) => {
  const { biz_type, biz_id } = req.query;
  if (!BIZ[biz_type] || !biz_id) return res.status(400).json({ error: '需要 biz_type 与 biz_id' });
  const map = db.prepare('SELECT * FROM feishu_doc_map WHERE biz_type = ? AND biz_id = ?').get(biz_type, biz_id);
  res.json({ mapped: !!map, doc_url: map?.doc_url || '', document_id: map?.doc_id || '' });
});

// POST /api/feishu/biz/sync {biz_type, biz_id} — 手动同步：飞书文档最新内容 → 回业务表
r.post('/biz/sync', authRequired, async (req, res) => {
  if (!configured()) return needConfig(res);
  const { biz_type, biz_id } = req.body || {};
  const biz = BIZ[biz_type];
  if (!biz || !biz_id) return res.status(400).json({ error: '需要 biz_type 与 biz_id' });
  try {
    const map = db.prepare('SELECT * FROM feishu_doc_map WHERE biz_type = ? AND biz_id = ?').get(biz_type, biz_id);
    if (!map) return res.status(404).json({ error: '该内容尚未创建飞书文档，请先点「飞书编辑」' });
    const r = await syncDocToDb(map.doc_id, biz_type, biz_id, req.user.id);
    res.json({ message: '✅ 已从飞书同步', ...r });
  } catch (e) { res.status(e.bad ? 400 : 500).json({ error: e.message }); }
});

async function docTitle(docId, tok) {
  try {
    const { ok, data } = await feishu(`/open-apis/docx/v1/documents/${docId}`, { token: tok });
    return ok ? data.data?.document?.title || '' : '';
  } catch { return ''; }
}

// 飞书 children 接口单次最多 50 块：超出报 99992402 field validation failed → 分批追加（同一根块）
async function writeChildren(docId, tok, blocks) {
  for (let i = 0; i < blocks.length; i += 50) {
    const w = await feishu(`/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children?document_revision_id=-1`, {
      method: 'POST', token: tok, body: { children: blocks.slice(i, i + 50) },
    });
    console.log(`[feishu] write children batch ${Math.floor(i / 50) + 1}/${Math.ceil(blocks.length / 50)}: ok=${w.ok} code=${w.data?.code} msg=${w.data?.msg}`);
    if (!w.ok) throw feishuError(w.data, '初始内容写入失败');
  }
}

// 新建文档：创建 docx + 根块写入初始内容（Markdown → Blocks，超 50 块自动分批）
// 自动把 userId 的绑定飞书账号加为可编辑协作者（应用身份建的文档在应用空间，用户需协作者身份才能在飞书看到）
async function createWithContent(body, tok, userId) {
  const title = String(body.title || '').trim() || '未命名文档';
  const folder = String(body.folder_token ?? parentFolder()).trim() || undefined;
  const { ok, data } = await feishu('/open-apis/docx/v1/documents', {
    method: 'POST', token: tok, body: { title, ...(folder ? { folder_token: folder } : {}) },
  });
  if (!ok) throw feishuError(data, '创建文档失败');
  const docId = data.data?.document?.document_id; // 创建接口返回 data.document.document_id（嵌套 document）
  // 新版 docx：根块（page）的 block_id 即 document_id 本身，父块直接传它
  const md = String(body.content || body.initial_content || '').trim();
  const blocks = md ? mdToBlocks(md) : [];
  if (blocks.length) await writeChildren(docId, tok, blocks);
  const url = `${process.env.FEISHU_URL_BASE || 'https://feishu.cn'}/docx/${docId}`;
  const bind = getBind(userId);
  if (bind?.open_id) {
    try {
      await feishu(`/open-apis/drive/v1/permissions/${docId}/members?type=docx&need_notification=false`, {
        method: 'POST', token: tok, body: { member_type: 'openid', member_id: bind.open_id, perm: 'edit' },
      });
    } catch { /* 协作者添加失败不阻塞创建（用户可在飞书里手动加） */ }
  }
  return { document_id: docId, url, title, blocks: blocks.length };
}

// POST /api/feishu/doc/create {title, folder_token?, content} — 新建文档（含初始内容）
r.post('/doc/create', optionalAuth, async (req, res) => {
  if (!configured()) return needConfig(res);
  let tok;
  try { ({ token: tok } = await pickToken(req.user?.id)); } catch (e) { return res.status(400).json({ error: e.message }); }
  try {
    const out = await createWithContent(req.body || {}, tok, req.user?.id);
    res.json({ message: '✅ 文档创建成功', ...out });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /api/feishu/doc/append {document_id, content} — 追加内容（Markdown → Blocks 追加到文末）
r.post('/doc/append', optionalAuth, async (req, res) => {
  if (!configured()) return needConfig(res);
  const docId = String(req.body?.document_id || '').trim();
  const md = String(req.body?.content || '').trim();
  if (!docId) return res.status(400).json({ error: '需要 document_id' });
  if (!md) return res.status(400).json({ error: '追加内容为空' });
  let tok;
  try { ({ token: tok } = await pickToken(req.user?.id)); } catch (e) { return res.status(400).json({ error: e.message }); }
  try {
    // 根块（page）block_id 即 document_id，父块直接传它（超 50 块自动分批）
    const blocks = mdToBlocks(md);
    await writeChildren(docId, tok, blocks);
    res.json({ message: '✅ 追加成功', document_id: docId, blocks: blocks.length });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- 文件（附件双向传输） ----------

// POST /api/feishu/file/upload — 上传文件到云盘（multipart field=file；≤20MB）
r.post('/file/upload', optionalAuth, uploadMem, async (req, res) => {
  if (!configured()) return needConfig(res);
  if (!req.file) return res.status(400).json({ error: '缺少文件（form-data 字段名 file）' });
  let tok;
  try { ({ token: tok } = await pickToken(req.user?.id)); } catch (e) { return res.status(400).json({ error: e.message }); }
  try {
    const buf = req.file.buffer;
    const fd = new FormData();
    fd.append('file_name', req.file.originalname || 'file');
    fd.append('parent_type', 'explorer');
    fd.append('parent_node', parentFolder());
    fd.append('size', String(buf.length));
    fd.append('file', new Blob([buf], { type: req.file.mimetype || 'application/octet-stream' }), req.file.originalname || 'file');
    const up = await fetch(`${FEISHU}/open-apis/drive/v1/files/upload_all`, {
      method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: fd,
    });
    const upJson = await up.json();
    if (!up.ok || upJson.code !== 0) throw feishuError(upJson, '上传失败');
    res.json({ message: '✅ 上传成功', file_token: upJson.data?.file_token, file_name: req.file.originalname, size: buf.length });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// GET /api/feishu/file/download?file_token= — 代理下载云盘文件（流式透传）
r.get('/file/download', optionalAuth, async (req, res) => {
  if (!configured()) return needConfig(res);
  const fileToken = String(req.query.file_token || '').trim();
  if (!fileToken) return res.status(400).json({ error: '需要 file_token' });
  let tok;
  try { ({ token: tok } = await pickToken(req.user?.id)); } catch (e) { return res.status(400).json({ error: e.message }); }
  try {
    const up = await feishu(`/open-apis/drive/v1/files/${fileToken}/download`, { token: tok, raw: true });
    const ct = up.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const j = await up.json();
      return res.status(400).json({ error: `${j.msg || '下载失败'}（code=${j.code ?? ''}）` });
    }
    const cd = up.headers.get('content-disposition') || '';
    const name = (cd.match(/filename="?([^";]+)"?/) || [])[1] || `${fileToken}.file`;
    res.setHeader('Content-Type', ct || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
    res.setHeader('Content-Length', up.headers.get('content-length') || '');
    Readable.fromWeb(up.body).pipe(res);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

export default r;
