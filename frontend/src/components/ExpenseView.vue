<script setup>
// 报销整理主视图（/expense）：三态 ——
// 1) 无 code：落地页（说明 + 邀请码直达 + 登录用户的"我的报销项目"管理）
// 2) 有 code：填报页（负责人登录=管理态 / 成员认领=可写本队含代录 / 访客=只读）
// 2026-09-04：一个账户一项目只占一个名字（认领=占名，可放弃换名）；成员可操作本队所有行（不限行归属），
//   并可新增/编辑/删除自己名下的项目级行（全项目统一支付区 = 横向标签第一个）；主体按「横向标签」切换查看
import { ref, computed, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api.js';
import auth from '../auth.js';
import { CATEGORIES, FIELDS, rowMoney } from '../utils/expenseMeta.js';
import RowCard from './expense/RowCard.vue';
import RowFormDialog from './expense/RowFormDialog.vue';

const route = useRoute();
const router = useRouter();

const code = ref(''); // 当前生效项目的邀请码（仅由 ?code= 路由驱动，见 watch/onMounted）
const draft = ref(''); // 落地页输入框草稿 —— 独立于 code：敲字/粘贴绝不触发页面切换（否则页面会空）
const pld = ref(null); // GET /o/:code 完整 payload
const loading = ref(false);
const errMsg = ref('');

// —— 最近进入的项目（本机记忆 localStorage，匿名可用）：进入成功即记，落地页「🕘 最近进入的项目」一键重进，
//   免去每次翻聊天记录找邀请码；最多留 8 条，可单条移除/清空 ——
const RECENT_KEY = 'expense_recent';
const recent = ref([]);
function rememberProject(c, name) {
  try {
    const list = (JSON.parse(localStorage.getItem(RECENT_KEY)) || []).filter((x) => x && x.code && String(x.code) !== String(c));
    list.unshift({ code: String(c), name: String(name || c).slice(0, 40), ts: Date.now() });
    recent.value = list.slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent.value));
  } catch { /* localStorage 不可用（隐私模式）则静默不记 */ }
}
function loadRecent() {
  try { recent.value = (JSON.parse(localStorage.getItem(RECENT_KEY)) || []).filter((x) => x && x.code).slice(0, 8); }
  catch { recent.value = []; }
}
function dropRecent(c) {
  recent.value = recent.value.filter((x) => String(x.code) !== String(c));
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent.value)); } catch { /* 同上 */ }
}
function clearRecent() { recent.value = []; try { localStorage.removeItem(RECENT_KEY); } catch { /* 同上 */ } }

const isOwner = computed(() => pld.value?.me?.role === 'owner');
const myMember = computed(() => pld.value?.me?.member || null); // 成员=认领条目；负责人=自己的 is_owner 条目（可能同时是队员）
const status = computed(() => pld.value?.project?.status || 'open');
const myRole = computed(() => pld.value?.me?.role || 'guest');
const teamNameOf = (id) => pld.value?.teams.find((t) => t.id === id)?.name || '';

// ---- 数据加载 ----
function onRowChanged() {
  load(code.value);
}
function onClaimLost() {
  api.expenseClearClaim(code.value);
  load(code.value);
}
async function load(c) {
  if (!c) return;
  loading.value = true;
  errMsg.value = '';
  try {
    const d = await api.expenseOpen(c);
    pld.value = d;
    rememberProject(c, d.project?.name); // 打开成功 → 记入本机「最近进入的项目」（再次进入免邀请码）
    // 本地存了认领 token 但服务端已不认（被重置/项目换了）→ 清掉引导重认领
    if (myRole.value === 'guest' && api.expenseClaimTok(c)) {
      api.expenseClearClaim(c);
      ElMessage.warning('身份已失效，请重新认领');
    }
  } catch (e) {
    pld.value = null;
    errMsg.value = e.message;
  } finally {
    loading.value = false;
  }
}

// ?code=xxx 直达（后退/切项目时跟随路由变化）
watch(() => route.query.code, (c) => {
  code.value = String(c || '');
  if (code.value) { activeTab.value = PROJ_TAB; load(code.value); } // 切项目标签复位到第一个（全项目统一支付）
  else errMsg.value = ''; // 离开项目回落地页时清掉上一次的报错
});
onMounted(() => {
  loadRecent(); // 落地页「最近进入的项目」本机记忆
  if (route.query.code) code.value = String(route.query.code);
  if (code.value) { activeTab.value = PROJ_TAB; load(code.value); }
});

// ---- 身份 ----
// 2026-09-04 放开：成员可操作「自己队伍」的全部行 —— 录入/编辑/删附件不限行归属（代录队友的行也行），
// 并可新增/编辑/删除「自己名下」的项目级行（team_id 空 = 全项目统一支付；出钱人创建时服务端强制=自己）；
// 跨队行与他人名下的项目级行仍仅负责人 —— 服务端 rowWriteError 同规则兜底
const open = () => status.value === 'open';
const myTeamId = computed(() => myMember.value?.team_id || null);
const canEditRow = (row) =>
  row.team_id != null && (isOwner.value || (myRole.value === 'member' && open() && Number(row.team_id) === myTeamId.value));
const canEditMemberRow = (row) => canEditRow(row) && myRole.value === 'member'; // 成员态同队行（prop 购买人字段冻结用）
// 能否在某队名下新增记录（负责人 or 本队已认领成员；同队级"＋ 添加记录"按钮口径）
const canAddIn = (t) => isOwner.value || (myRole.value === 'member' && myTeamId.value === t.id && open());
// 全项目统一支付 pane 可见：owner 恒可见（代录/纠错）；成员 open 可见（需自理入口）；有行即可见（含读他人行）
const PROJ_TAB = 'proj';
// 标签条横向滚动辅助：内容溢出时，鼠标纵向滚轮(或触控板双指)直接横滚标签；未溢出则放行页面滚动
function tabWheel(e) {
  const el = e.currentTarget;
  if (!el || el.scrollWidth <= el.clientWidth + 2) return;
  e.preventDefault();
  el.scrollLeft += (e.deltaX || e.deltaY) * (e.shiftKey ? 1.6 : 1);
}
const projPaneVisible = computed(() => isOwner.value || projPayRows.value.length > 0
  || (myRole.value === 'member' && open()));
// 项目级区新增入口（owner or 成员且 open）；成员服务端强制归属=自己，前端同口径
const projCanAdd = computed(() => isOwner.value || (myRole.value === 'member' && open()));
// 项目级行可写：owner 全行；成员仅自己名下且 open（closed 后只读 —— 与服务端 rowWriteError 一致）
const canEditProjRow = (row) => isOwner.value
  || (myRole.value === 'member' && open() && String(row.owner_name) === String(myMember.value?.name || ''));

// 认领（一账户一项目只占一个名字）：request 带已有 token 且名字不同 = 后端原子换名（旧名自动释放）
async function claim(name) {
  try {
    const d = await api.expenseClaim(code.value, name);
    api.expenseSaveClaim(code.value, d.token);
    ElMessage.success(d.switchedFrom
      ? `已放弃「${d.switchedFrom}」、换认领为「${name}」`
      : `你好，${name}！现在可以填报/代录本队记录，也能在全项目统一支付区录自己名下`);
    await load(code.value);
  } catch (e) {
    ElMessage.error(e.message);
  }
}
// 放弃认领：释放当前名字回到只读（想换名：先放弃，再点任意空名字）
async function releaseClaim() {
  if (!myMember.value) return;
  const nm = myMember.value.name;
  try {
    await ElMessageBox.confirm(`放弃认领「${nm}」？\n\n放弃后本浏览器/账户在该项目里不再占任何名字：不能填报、代录或编辑记录（回到只读），随时可以重新认领任意空名字。`, '放弃认领', { type: 'warning', confirmButtonText: '放弃认领', cancelButtonText: '再想想' });
  } catch { return; }
  try {
    await api.expenseRelease(code.value);
    api.expenseClearClaim(code.value);
    ElMessage.success(`已放弃「${nm}」，现在是只读访客`);
    await load(code.value);
  } catch (e) {
    ElMessage.error(e.message);
  }
}
const claimState = computed(() => {
  if (!pld.value) return '';
  if (myRole.value === 'owner') return 'owner';
  if (myRole.value === 'member') return 'member';
  return 'guest';
});

// ---- 统计 ----
const fmt = (n) => (Number.isFinite(n) && n > 0 ? n.toFixed(2) : '0.00');
const catAgg = computed(() => {
  const m = {};
  for (const c of CATEGORIES) m[c.key] = { total: 0, count: 0 };
  for (const r of pld.value?.rows || []) {
    const d = rowMoney(r.category, r.data);
    if (d) m[r.category].total += d;
    m[r.category].count++;
  }
  return m;
});
const teamCats = computed(() => CATEGORIES.filter((c) => c.key !== 'misc')); // 队伍块只列五类：⑥零散票据仅项目级区
const grandTotal = computed(() => CATEGORIES.reduce((s, c) => s + (catAgg.value[c.key]?.total || 0), 0));
const teamAgg = (teamId) => {
  const m = {};
  for (const c of CATEGORIES) m[c.key] = { total: 0, count: 0 };
  for (const r of (pld.value?.rows || []).filter((x) => x.team_id === teamId)) {
    const d = rowMoney(r.category, r.data);
    if (d) m[r.category].total += d;
    m[r.category].count++;
  }
  return m;
};
const rowsOf = (teamId, cat) => (pld.value?.rows || []).filter((x) => x.team_id === teamId && x.category === cat);
// ---- 全项目统一支付（项目级区块：team_id 空的行 —— 不属任何队伍：统一垫付 ＋ ⑥零散票据）----
// 注意：头部统计条 catAgg/grandTotal 本就遍历全部行（含项目级），与 Excel 总计口径一致
const projPayRows = computed(() => (pld.value?.rows || []).filter((r) => r.team_id == null));
const projRowsOf = (cat) => projPayRows.value.filter((r) => r.category === cat);
const projPayMoney = (cat) => projPayRows.value.reduce(
  (s, r) => (r.category === cat ? s + rowMoney(r.category, r.data) : s), 0);
const myTotal = computed(() => {
  if (!myMember.value) return 0;
  let s = 0;
  for (const r of pld.value?.rows || []) {
    if (r.owner_name === myMember.value.name) s += rowMoney(r.category, r.data);
  }
  return s;
});
const membersOf = (teamId) => (pld.value?.members || []).filter((m) => m.team_id === teamId);
// 某队员名下垫付合计（口径与 Excel 一致：金额记出钱人/垫付人名下）
const memberMoney = (teamId, name) => (pld.value?.rows || []).reduce(
  (s, r) => (r.team_id === teamId && String(r.owner_name) === String(name) ? s + rowMoney(r.category, r.data) : s), 0);

// ---- 横向标签（可查看主体：全项目统一支付为第一个 + 每队一个；激活键失效即钳回第一个） ----
const activeTab = ref(PROJ_TAB); // 'proj'（字符串哨兵）或队伍 id（number）
const viewTabs = computed(() => {
  const arr = [];
  if (projPaneVisible.value) arr.push({ key: PROJ_TAB, name: '全项目统一支付', cnt: projPayRows.value.length });
  for (const t of pld.value?.teams || []) {
    arr.push({ key: t.id, name: t.name, roster: membersOf(t.id).length,
      claimed: membersOf(t.id).filter((x) => x.claimed).length });
  }
  return arr;
});
watch(viewTabs, (tabs) => {
  // 队伍被删/项目切换/认领态变化致主体增减：当前键不在列表则回到第一个（单主体直排时也会把 'proj' 钳到唯一队伍）
  if (tabs.length && !tabs.some((x) => x.key === activeTab.value)) activeTab.value = tabs[0].key;
});
const activeTeam = computed(() => (activeTab.value === PROJ_TAB ? null
  : (pld.value?.teams.find((t) => t.id === activeTab.value) || null)));

// ---- 新增/编辑行 ----
const dlg = ref({ open: false, mode: 'create', row: null, teamId: null, initialCat: '' });
function openCreate(teamId, catKey = '') {
  dlg.value = { open: true, mode: 'create', row: null, teamId, initialCat: catKey };
}
// 全项目统一支付区块的新增入口：teamId=0 哨兵（弹窗内据此识别项目级模式）
function openProjCreate(catKey = '') {
  dlg.value = { open: true, mode: 'create', row: null, teamId: 0, initialCat: catKey };
}
function openEdit(row) {
  dlg.value = { open: true, mode: 'edit', row, teamId: row.team_id || 0, initialCat: row.category };
}
function onSaved(msg) {
  dlg.value.open = false;
  if (msg) ElMessage.success(msg);
  load(code.value);
}

// ---- 负责人管理工具 ----
const inviteUrl = computed(() => `${location.origin}/expense?code=${code.value}`);
// 复制邀请链接：优先 navigator.clipboard（仅 https/localhost 可用）→ execCommand 降级（http 内网也能复制）
// → 都不行则弹窗展示链接供长按/选中手动复制（浏览器拦截复制时最后的兜底）
async function copyInvite() {
  const txt = inviteUrl.value;
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(txt);
      ElMessage.success('邀请链接已复制，发到群里即可');
      return;
    }
  } catch { /* 权限被拒 → 走降级 */ }
  const ta = document.createElement('textarea');
  ta.value = txt;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:-999px;left:0;width:1px;height:1px;opacity:0';
  document.body.appendChild(ta);
  let done = false;
  try {
    ta.focus();
    ta.select();
    done = document.execCommand('copy');
  } catch { /* 老浏览器 */ }
  ta.remove();
  if (done) return ElMessage.success('邀请链接已复制，发到群里即可');
  ElMessageBox.alert(
    '一键复制被浏览器拦截（页面非 https 时常见）——请长按/选中下方链接，手动复制后发到群里：<br/><b style="word-break:break-all;color:var(--primary)">' + txt + '</b>',
    '复制邀请链接', { confirmButtonText: '知道了', dangerouslyUseHTMLString: true }
  );
}
async function toggleClose() {
  const next = status.value === 'open' ? 'closed' : 'open';
  try {
    await api.expensePatch(pld.value.project.id, { status: next });
    ElMessage.success(next === 'closed' ? '已截止填报（成员只读，仍可下载/导出）' : '已重新开放填报');
    await load(code.value);
  } catch (e) { ElMessage.error(e.message); }
}
async function deleteProject() {
  const p = pld.value;
  try {
    await ElMessageBox.confirm(
      `删除后不可恢复：项目「${p.project.name}」的 ${p.teams.length} 队 / ${p.members.length} 人名单、全部记录与上传附件原件都会一并删除。`,
      '删除报销项目', { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
    );
  } catch { return; }
  try {
    await api.expenseDelete(p.project.id);
    ElMessage.success('项目已删除');
    router.push('/expense');
  } catch (e) { ElMessage.error(e.message); }
}
async function addTeam() {
  const name = await promptText('新队伍名称');
  if (name === null) return;
  try { await api.expenseTeamCreate(pld.value.project.id, name); await load(code.value); }
  catch (e) { ElMessage.error(e.message); }
}
const promptText = (title, val = '') =>
  ElMessageBox.prompt(title, { inputValue: val, inputPattern: /\S+/, inputErrorMessage: '不能为空', confirmButtonText: '确定', cancelButtonText: '取消' })
    .then(({ value }) => String(value || '').trim())
    .catch(() => null);
async function renameTeam(t) {
  const name = await promptText('队伍名称', t.name);
  if (name === null || name === t.name) return;
  try { await api.expenseTeamRename(t.id, name); await load(code.value); }
  catch (e) { ElMessage.error(e.message); }
}
async function delTeam(t) {
  const rows = pld.value.rows.filter((x) => x.team_id === t.id).length;
  try {
    await ElMessageBox.confirm(
      `删除队伍「${t.name}」将同时删除其名单成员、${rows} 条记录与附件原件，不可恢复。`,
      '删除队伍', { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
    );
  } catch { return; }
  try { await api.expenseTeamDelete(t.id); await load(code.value); }
  catch (e) { ElMessage.error(e.message); }
}
async function addMember(t) {
  const name = await promptText(`给「${t.name}」添加成员姓名`);
  if (name === null) return;
  try { await api.expenseMemberCreate(pld.value.project.id, t.id, name); await load(code.value); }
  catch (e) { ElMessage.error(e.message); }
}
// 成员操作（下拉）：标记/取消「负责人本人」/ 重置认领 / 改名 / 移出
async function memberCmd(cmd, m) {
  if (cmd === 'owner') {
    // 负责人可能同时是队员：把某名单条目标记/取消为自己的队员身份（登录即占用、队员不可认领）
    const turnOn = !m.isOwner;
    const msg = turnOn
      ? `把「${m.name}」标记为负责人本人的队员身份？标记后该姓名不可被队员认领${m.claimed ? '（若已被抢先认领会立即重置）' : ''}，负责人登录即可填报自己名下的费用。`
      : `取消「${m.name}」的负责人标记？取消后它回到普通队员条目，队员可重新认领该姓名。`;
    try {
      await ElMessageBox.confirm(msg, turnOn ? '标记负责人本人' : '取消负责人标记',
        { type: 'warning', confirmButtonText: turnOn ? '标记' : '取消标记', cancelButtonText: '取消' });
    } catch { return; }
    try {
      await api.expenseMemberPatch(m.id, { is_owner: turnOn });
      ElMessage.success(turnOn ? '已标记 —— 登录即占用该队员身份，队员不可认领' : '已取消标记（回到可认领名单）');
    } catch (e) { ElMessage.error(e.message); }
  } else if (cmd === 'reset') {
    try {
      await ElMessageBox.confirm(`重置「${m.name}」的认领？对方将重新认领（旧设备上的身份立即失效）。`, '重置认领', { type: 'warning', confirmButtonText: '重置', cancelButtonText: '取消' });
    } catch { return; }
    try { await api.expenseMemberReset(m.id); ElMessage.success('已重置'); }
    catch (e) { ElMessage.error(e.message); }
  } else if (cmd === 'rename') {
    const name = await promptText('新姓名', m.name);
    if (name === null || name === m.name) return;
    try { await api.expenseMemberPatch(m.id, { name }); ElMessage.success('已改名（其记录同步更新）'); }
    catch (e) { ElMessage.error(e.message); }
  } else if (cmd === 'move') {
    const teams = pld.value.teams;
    const { value } = await ElMessageBox.prompt('转入哪个队伍？', '转移队伍', {
      inputValue: String(m.team_id), confirmButtonText: '确定', cancelButtonText: '取消',
      inputValidator: (v) => (teams.some((t) => Number(t.id) === Number(v)) ? true : '请输入队伍 id'),
    }).catch(() => null);
    if (!value) return;
    try { await api.expenseMemberPatch(m.id, { team_id: Number(value) }); await load(code.value); }
    catch (e) { ElMessage.error(e.message); }
  } else if (cmd === 'delete') {
    try {
      await ElMessageBox.confirm(
        `移出「${m.name}」将删除其名下 ${m.rowCount} 条记录与附件原件，不可恢复。${m.isOwner ? '（该条目是负责人本人的队员身份，移出后负责人名下记录一并删除）' : ''}`,
        '移出成员', { type: 'warning', confirmButtonText: '移出', cancelButtonText: '取消' }
      );
    } catch { return; }
    try { await api.expenseMemberDelete(m.id); await load(code.value); }
    catch (e) { ElMessage.error(e.message); }
  }
  await load(code.value);
}

// ---- 落地页：我的项目 ----
const mine = ref(null);
async function loadMine() {
  mine.value = null;
  if (!auth.token) return;
  try { mine.value = await api.expenseList(); } catch { /* 列表失败静默 */ }
}
const createDlg = ref(false);
const newName = ref('');
const newEvent = ref('');
async function createProject() {
  const name = newName.value.trim();
  if (!name) return ElMessage.warning('请填写项目名称');
  try {
    const d = await api.expenseCreate(name, newEvent.value.trim());
    ElMessage.success('项目已创建，去复制邀请链接发群吧');
    createDlg.value = false;
    router.push({ path: '/expense', query: { code: d.code } });
  } catch (e) { ElMessage.error(e.message); }
}
// 邀请码识别：直接输入 8 位码 / 粘贴整条邀请链接(?code=XXXX) / 粘贴带前后文字的码 —— 均归一为大写码
function extractCode(raw) {
  const s = String(raw || '').replace(/\s+/g, '');
  const m = s.match(/(?:[?&]|^)code=([A-Za-z0-9]{8})(?:$|[&#])/) // 完整链接/查询串里的 code=
    || s.match(/\b([A-Za-z0-9]{8})\b/);                          // 光秃秃的 8 位码（夹在文字里也认）
  return m ? m[1].toUpperCase() : '';
}
function enterCode() {
  const c = extractCode(draft.value);
  if (!c) {
    ElMessage.warning('没认出来邀请码 —— 可以直接粘贴完整的邀请链接，或只贴 8 位邀请码');
    return;
  }
  goProject(c);
}
function goProject(c) {
  // 不手动改 code.value —— 只推路由，watch(() => route.query.code) 统一负责置 code + load，
  // 避免中间出现「code 已置但 pld/loading 未就绪」的空帧
  router.push({ path: '/expense', query: { code: c } });
}
onMounted(() => loadMine());
</script>

<template>
  <div class="expense-page">
    <!-- ============ 落地页（无 code 生效项目） ============ -->
    <div v-if="!code" class="exp-wrap">
      <section class="hero card">
        <div class="hero-top">
          <h2>🧾 竞赛报销发票整理</h2>
          <el-button size="small" @click="router.push('/expense/guide')">📖 使用教程</el-button>
        </div>
        <p>负责人建项目 → 按"队伍→成员"预录名单 → 把链接发群，队员打开即可认领填报，各填各的、只读他人；发票 PDF / 查验 / 凭证截图 / 清单等原件直接传网页，项目级统一支付与零散票据单独成区，自动按队打包、一键导出 Excel 汇总金额。</p>
        <div class="steps">
          <span>① 负责人：创建项目 + 添加队伍名单</span>
          <span>② 发邀请链接：队员认领自己的姓名</span>
          <span>③ 填五类费用 + 全项目区录统一支付/零散票据</span>
          <span>④ 导出 Excel / 按队打包 ZIP 归档</span>
        </div>
      </section>

      <section class="enter card">
        <h3>已有邀请链接？</h3>
        <div class="enter-row">
          <el-input v-model="draft" placeholder="粘贴完整邀请链接，或直接输入 8 位邀请码" maxlength="300" clearable @keyup.enter="enterCode" />
          <el-button type="primary" @click="enterCode">进入填报</el-button>
        </div>
        <el-alert v-if="errMsg" type="error" :title="errMsg" show-icon :closable="false" style="margin-top:10px" />
      </section>

      <!-- 最近进入的项目（本机记忆 localStorage，匿名可用）：本浏览器打开过的项目免邀请码一键重进 -->
      <section v-if="recent.length" class="card mine">
        <div class="mine-head">
          <h3>🕘 最近进入的项目</h3>
          <el-button size="small" text type="danger" @click="clearRecent">清空记录</el-button>
        </div>
        <div v-for="r in recent" :key="r.code" class="mine-item">
          <div class="mi-main">
            <span class="mi-name">{{ r.name }}</span>
            <el-tag type="info" size="small" effect="plain">邀请码 {{ r.code }}</el-tag>
            <el-button size="small" text @click="dropRecent(r.code)">🗑 移除</el-button>
          </div>
          <el-button size="small" type="primary" plain @click="goProject(r.code)">进入</el-button>
        </div>
      </section>

      <template v-if="auth.token">
        <section class="card mine">
          <div class="mine-head">
            <h3>我的报销项目</h3>
            <el-button type="primary" size="small" @click="createDlg = true">＋ 新建项目</el-button>
          </div>
          <el-empty v-if="mine && !mine.length" description="还没有报销项目 —— 比赛费用报销从建项目开始" />
          <div v-for="p in mine || []" :key="p.id" class="mine-item">
            <div class="mi-main">
              <span class="mi-name">{{ p.name }}</span>
              <el-tag v-if="p.status === 'closed'" type="info" size="small">已截止</el-tag>
              <span class="mi-sub">{{ p.event }} · {{ p.team_count }} 队 · {{ p.member_count }} 人（已认领 {{ p.claimed_count }}）· {{ p.row_count }} 条记录</span>
            </div>
            <el-button size="small" @click="goProject(p.code)">进入管理</el-button>
          </div>
        </section>
      </template>
      <template v-else>
        <section class="card need-login">
          <p>想当负责人建项目？先登录本站（登录后还能随时看到自己的全部项目）</p>
          <el-button type="primary" @click="router.push('/login?redirect=/expense')">去登录</el-button>
        </section>
      </template>

      <el-dialog v-model="createDlg" title="新建报销项目" width="min(92vw, 420px)">
        <el-form label-width="80px" @submit.prevent>
          <el-form-item label="项目名称" required>
            <el-input v-model="newName" placeholder="如：电子设计大赛 报销" maxlength="40" />
          </el-form-item>
          <el-form-item label="竞赛名称">
            <el-input v-model="newEvent" placeholder="选填，如：2026 电赛省赛" maxlength="60" />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="createDlg = false">取消</el-button>
          <el-button type="primary" @click="createProject">创建</el-button>
        </template>
      </el-dialog>
    </div>

    <!-- ============ 填报/管理页（有 code） ============ -->
    <div v-else class="exp-wrap">
      <div v-if="loading" class="center-load"><el-icon class="is-loading" :size="26"><svg viewBox="0 0 1024 1024"><path fill="currentColor" d="M512 64a32 32 0 0 1 32 32v192a32 32 0 0 1-64 0V96a32 32 0 0 1 32-32m0 640a32 32 0 0 1 32 32v192a32 32 0 0 1-64 0V736a32 32 0 0 1 32-32m448-128a32 32 0 0 1-32 32H736a32 32 0 0 1 0-64h192a32 32 0 0 1 32 32m-640 0a32 32 0 0 1-32 32H96a32 32 0 0 1 0-64h192a32 32 0 0 1 32 32M195.2 195.2a32 32 0 0 1 45.248 0L376.32 331.008a32 32 0 0 1-45.248 45.248L195.2 240.448a32 32 0 0 1 0-45.248m452.544 452.544a32 32 0 0 1 45.248 0L828.8 783.552a32 32 0 0 1-45.248 45.248L647.744 692.992a32 32 0 0 1 0-45.248M828.8 195.2a32 32 0 0 1 0 45.248L692.992 376.32a32 32 0 0 1-45.248-45.248L783.552 195.2a32 32 0 0 1 45.248 0m-452.544 452.544a32 32 0 0 1 0 45.248L240.448 828.8a32 32 0 0 1-45.248-45.248l135.808-135.808a32 32 0 0 1 45.248 0"/></svg></el-icon></div>
      <el-empty v-else-if="errMsg" :description="errMsg">
        <el-button type="primary" @click="router.push('/expense')">返回报销整理首页</el-button>
        <p v-if="recent.some((x) => String(x.code) === String(code))" style="margin-top: 10px">
          <el-button size="small" text type="danger" @click="dropRecent(code); router.push('/expense')">这个项目已失效 —— 从最近进入中移除</el-button>
        </p>
      </el-empty>

      <template v-else-if="pld">
        <!-- 返回导航：退出项目回落地页；本项目已记入本机「🕘 最近进入的项目」，此后免邀请码再进 -->
        <div class="back-row">
          <el-button size="small" plain @click="router.push('/expense')">← 返回报销整理</el-button>
          <span class="sub2">离开后想再进：报销整理页 → 🕘 最近进入的项目（本浏览器免邀请码）</span>
        </div>
        <!-- 项目头部 -->
        <div class="head card">
          <div class="head-main">
            <h2>{{ pld.project.name }} <el-tag v-if="status === 'closed'" type="info" size="small">已截止</el-tag></h2>
            <p v-if="pld.project.event" class="sub2">🏆 {{ pld.project.event }}</p>
            <p class="sub2">邀请码 {{ pld.project.code }} · 队伍 {{ pld.teams.length }} · 名单 {{ pld.members.length }} 人</p>
          </div>
          <!-- 统计条 -->
          <div class="sum-bar">
            <span v-for="c in CATEGORIES" :key="c.key" class="sum-chip">
              {{ c.num }} {{ c.zh }} <b>{{ fmt(catAgg[c.key].total) }}</b>
              <i v-if="catAgg[c.key].count">×{{ catAgg[c.key].count }}</i>
            </span>
            <span class="sum-chip total">总计 <b>{{ fmt(grandTotal) }}</b></span>
          </div>
          <div class="head-ops">
            <el-button v-if="isOwner" size="small" type="primary" @click="addTeam">＋ 添加队伍</el-button>
            <el-button v-if="isOwner" size="small" type="primary" plain @click="copyInvite">📋 复制邀请链接</el-button>
            <a v-if="isOwner" class="btn-link" :href="api.expenseXlsxUrl(code)" download><el-button size="small" type="success">📊 导出 Excel</el-button></a>
            <el-button v-if="isOwner" size="small" plain :type="status === 'open' ? 'warning' : 'success'" @click="toggleClose">
              {{ status === 'open' ? '🛑 截止填报' : '▶ 重新开放' }}
            </el-button>
            <el-button v-if="isOwner" size="small" type="danger" plain @click="deleteProject">🗑 删除项目</el-button>
          </div>
        </div>

        <!-- 身份条：负责人本人也可能是队员（名单 is_owner 条目，登录即占用） -->
        <div v-if="claimState === 'owner' && myMember" class="who card">
          <span class="ok-dot"></span>
          你的队员身份：<b>{{ myMember.name }}</b>（{{ teamNameOf(myMember.team_id) }}队）· 已占用
          <el-tag v-if="open()" size="small" type="success">可填报/代录本队记录</el-tag>
          <el-tag size="small" type="danger" effect="plain">队员不能认领你的名字</el-tag>
          <span class="grow"></span>
          <span class="sub2">本人合计 <b class="my-total">¥{{ fmt(myTotal) }}</b> · 队员可互录互编本队记录、自理全项目区自己名下；跨队行与他人项目级行由你代录/纠错</span>
        </div>

        <!-- 身份条（成员/访客） -->
        <div class="who card" v-if="claimState !== 'owner'">
          <template v-if="claimState === 'member'">
            <span class="ok-dot"></span>
            <b>{{ myMember.name }}</b>（{{ teamNameOf(myMember.team_id) }}队）已认领
            <el-tag v-if="open()" size="small" type="success">可录/编本队行 · 全项目区可录自己名下</el-tag>
            <span class="grow"></span>
            <span class="sub2">本人合计 <b class="my-total">¥{{ fmt(myTotal) }}</b> · 本队互编，全项目区可自理自己名下（他人项目级行/跨队只读）</span>
            <el-button size="small" type="danger" plain @click="releaseClaim" title="放弃后回到只读，可重新认领其他名字">放弃认领（换名）</el-button>
          </template>
          <template v-else-if="claimState === 'guest'">
            <div class="claim-box">
              <p class="claim-tip">👋 认领你的名字后即可填报（一人一项目一个名字，各填各的；重复姓名先找负责人区分）</p>
              <div class="claim-chips">
                <template v-for="t in pld.teams" :key="t.id">
                  <span class="claim-group">{{ t.name }}</span>
                  <el-tag v-for="m in membersOf(t.id)" :key="m.id" class="claim-tag"
                          :type="m.isOwner ? 'danger' : (m.claimed ? 'info' : 'primary')" effect="plain"
                          :disabled="m.isOwner || m.claimed" @click="claim(m.name)">
                    {{ m.name }}{{ m.isOwner ? '（负责人本人·登录占用，不用认领）' : m.claimed ? '（已认领）' : ' — 点我认领' }}
                  </el-tag>
                </template>
              </div>
            </div>
          </template>
        </div>

        <!-- 主体标签条：可查看主体（全项目统一支付 + 各队）≥2 才出现；第一个=全项目统一支付，其后每队一个；
             点标签切换查看对应主体 —— 单主体时无标签条、直接整卡渲染（见下各 pane） -->
        <div v-if="viewTabs.length > 1" class="exp-tabbar" @wheel="tabWheel">
          <button v-for="tb in viewTabs" :key="String(tb.key)" type="button"
                  class="tabchip" :class="{ on: activeTab === tb.key }" @click="activeTab = tb.key">
            <template v-if="tb.key === PROJ_TAB">💰 全项目统一支付<i v-if="tb.cnt" class="tab-sub">{{ tb.cnt }} 条</i></template>
            <template v-else>🏁 {{ tb.name }}队<i class="tab-sub">名单 {{ tb.roster }} · 已认领 {{ tb.claimed }}</i></template>
          </button>
        </div>

        <!-- 全项目统一支付 pane（第一标签）：项目级行（team_id 空）—— owner 可记任一名单成员/本人并全权代录纠错；
             成员可新增（服务端强制归属=自己）与改/删自己名下，他人名下只读（closed 后成员只读）；⑥零散票据只在这里 -->
        <section v-if="projPaneVisible && (viewTabs.length === 1 || activeTab === PROJ_TAB)" class="team card pp-card">
          <div class="team-head">
            <div class="pp-head">
              <h3>💰 全项目统一支付</h3>
              <p class="sub2">项目级记录（不属任何队伍）：一人统一缴纳的费用可勾选涵盖的人（不必全体），或放一张含多人/跨队的 ⑥ 零散票据；成员可录自己名下（出钱人=本人）；统计进总计、导出 Excel 独立成块</p>
            </div>
            <div class="team-ops">
              <a v-if="isOwner" class="btn-link" :href="api.expenseZipUrl(code, 0)" download>
                <el-button size="small" type="success" plain>📦 附件 ZIP</el-button>
              </a>
              <el-button v-if="projCanAdd" size="small" type="primary" @click="openProjCreate()">＋ 添加记录</el-button>
            </div>
          </div>

          <template v-if="projPayRows.length">
            <div v-for="c in CATEGORIES" :key="'p' + c.key" class="cat-block" :class="'cat-' + c.key">
              <div class="cat-head">
                <span class="cat-title">{{ c.num }} {{ c.zh }}</span>
                <span v-if="projPayMoney(c.key)" class="cat-total">小计 ¥{{ fmt(projPayMoney(c.key)) }}（{{ projRowsOf(c.key).length }} 条）</span>
                <el-button v-if="projCanAdd" size="small" text type="primary" class="cat-add" @click="openProjCreate(c.key)">＋ 添加{{ c.zh }}</el-button>
              </div>
              <div v-if="!projRowsOf(c.key).length" class="cat-empty">暂无记录</div>
              <RowCard v-for="row in projRowsOf(c.key)" :key="row.id" :code="code" :row="row"
                       :editable="canEditProjRow(row)"
                       :locked-field="myRole === 'member' && canEditProjRow(row) && row.category === 'prop' ? '购买人' : ''"
                       @edit="openEdit(row)" @changed="onRowChanged" />
            </div>
          </template>
          <el-empty v-else description="还没有项目级记录" :image-size="60">
            <p v-if="isOwner" class="dim-tip">
              点「＋ 添加记录」：选类别 → 出钱人（任一队成员或你本人）→ 涵盖的人可勾选（可跨队）、选整个项目全体，或先不选人只存档；⑥ 零散票据（一张含多人/跨队的散票）也在这里添加。<template v-if="!pld.teams.length">还没有队伍 —— 可先点上方「＋ 添加队伍」建队预录名单；成员认领后也能自理自己名下的项目级记录。</template>
            </p>
            <p v-else class="dim-tip">你可以添加自己名下（出钱人自动=你本人）的统一支付或 ⑥ 零散票据；他人的项目级行只读，代他人垫付/公用开销请找负责人录。</p>
          </el-empty>
        </section>

        <!-- 队伍 pane（每队一个标签）：当前激活队伍；单主体时无标签条、直接渲染这唯一一张队伍卡 -->
        <section v-else-if="activeTeam" class="team card">
          <div class="team-head">
            <h3>🏁 {{ activeTeam.name }}队 <span class="sub2">名单 {{ membersOf(activeTeam.id).length }} 人 · 已认领 {{ membersOf(activeTeam.id).filter((x) => x.claimed).length }}</span></h3>
            <div class="team-ops">
              <a v-if="isOwner" class="btn-link" :href="api.expenseZipUrl(code, activeTeam.id)" download>
                <el-button size="small" type="success" plain>📦 附件 ZIP</el-button>
              </a>
              <el-button v-if="canAddIn(activeTeam)" size="small" type="primary" @click="openCreate(activeTeam.id)">＋ 添加记录</el-button>
              <el-dropdown v-if="isOwner" trigger="click" @command="(cmd) => { if (cmd === 'rename') renameTeam(activeTeam); if (cmd === 'del') delTeam(activeTeam); if (cmd === 'member') addMember(activeTeam); }">
                <el-button size="small" plain>⚙ 管理</el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="member">＋ 添加成员</el-dropdown-item>
                    <el-dropdown-item command="rename">✏ 改队名</el-dropdown-item>
                    <el-dropdown-item command="del" divided>🗑 删除队伍</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
          </div>

          <!-- 成员行：负责人可管理（标记本人/改名/重置认领/移出） -->
          <div class="member-row">
            <span v-for="m in membersOf(activeTeam.id)" :key="m.id" class="member-chip">              <span :class="['m-dot', { ok: m.claimed }]"></span>{{ m.name }}
              <el-tag v-if="m.isOwner" size="small" type="danger" effect="plain">负责人</el-tag>
              <el-tag v-if="m.me && !m.isOwner" size="small" type="success">我</el-tag>
              <el-tag v-if="m.claimed && !m.me && !m.isOwner" size="small" type="info">已认领</el-tag>
              <el-tag v-if="m.rowCount" size="small">{{ m.rowCount }} 条</el-tag>
              <el-tag v-if="memberMoney(activeTeam.id, m.name) > 0" size="small" type="warning" effect="plain">¥{{ fmt(memberMoney(activeTeam.id, m.name)) }}</el-tag>
              <el-dropdown v-if="isOwner" trigger="click" @command="(cmd) => memberCmd(cmd, m)">
                <span class="m-more">⋯</span>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="owner">{{ m.isOwner ? '取消「负责人本人」标记' : '标记为负责人本人' }}</el-dropdown-item>
                    <el-dropdown-item command="reset" :disabled="!m.claimed || m.isOwner">重置认领</el-dropdown-item>
                    <el-dropdown-item command="rename">改名（记录同步）</el-dropdown-item>
                    <el-dropdown-item command="move">转队</el-dropdown-item>
                    <el-dropdown-item command="delete" divided>移出（删其记录）</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </span>
            <p v-if="!membersOf(activeTeam.id).length" class="sub2" style="width:100%">
              <template v-if="isOwner">名单为空 —— 点右上「⚙ 管理 → ＋ 添加成员」把队员姓名预录进来，队员才能认领填写</template>
              <template v-else>负责人还没添加成员名单</template>
            </p>
          </div>

          <!-- 队伍块只列五类：⑥零散票据仅全项目统一支付区（后端队行 misc 400 兜底） -->
          <div v-for="c in teamCats" :key="c.key" class="cat-block" :class="'cat-' + c.key">
            <div class="cat-head">
              <span class="cat-title">{{ c.num }} {{ c.zh }}</span>
              <span v-if="teamAgg(activeTeam.id)[c.key].total" class="cat-total">小计 ¥{{ fmt(teamAgg(activeTeam.id)[c.key].total) }}（{{ teamAgg(activeTeam.id)[c.key].count }} 条）</span>
              <!-- 类别头常驻添加：同类别可多条（如一张车票一行，多张票就加多行），不限于空态 -->
              <el-button v-if="canAddIn(activeTeam)" size="small" text type="primary" class="cat-add" @click="openCreate(activeTeam.id, c.key)">＋ 添加{{ c.zh }}</el-button>
            </div>
            <div v-if="!rowsOf(activeTeam.id, c.key).length" class="cat-empty">暂无记录</div>
            <RowCard v-for="row in rowsOf(activeTeam.id, c.key)" :key="row.id" :code="code" :row="row" :editable="canEditRow(row)"
                     :locked-field="canEditMemberRow(row) && c.key === 'prop' ? '购买人' : ''"
                     @edit="openEdit(row)" @changed="onRowChanged" />
          </div>
        </section>

        <!-- 无可查看主体（无队伍 且 无项目级记录；owner/可写成员必达上方 pane —— 此处只可能是访客或闭幕后成员） -->
        <section v-else class="card">
          <el-empty description="还没有可查看的内容">
            <p class="dim-tip">负责人尚未建立队伍，也还没有全项目统一支付记录<template v-if="status === 'closed'">（该项目已截止填报）</template>，稍后再来，或联系负责人。</p>
          </el-empty>
        </section>

        <p class="foot-note">队员可互录互编本队记录、全项目区自理自己名下（他人项目级行/跨队只读）· 附件原件上传后按队打包 · 导出 Excel 每队一个工作表（块小计/总计为公式）</p>

        <!-- 录入/编辑弹窗 -->
        <RowFormDialog v-if="dlg.open" v-model="dlg.open" :mode="dlg.mode" :row="dlg.row" :team-id="dlg.teamId"
                       :initial-cat="dlg.initialCat" :teams="pld.teams" :members="pld.members" :me="pld.me" :code="code"
                       @saved="onSaved" @claim-lost="onClaimLost" />
      </template>
    </div>
  </div>
</template>

<style scoped>
.exp-wrap { max-width: 980px; margin: 0 auto; }
.card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-bottom: 14px; }
h2 { margin: 0 0 6px; font-size: 20px; }
h3 { margin: 0; font-size: 16px; }
.sub2 { color: var(--text-2); font-size: 12px; margin: 3px 0; }
.grow { flex: 1; }
.btn-link { text-decoration: none; }
.hero-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }

.hero p { color: var(--text-2); line-height: 1.7; margin: 8px 0 12px; }
.steps { display: flex; flex-wrap: wrap; gap: 8px; }
.steps span { background: var(--surface-2); padding: 4px 10px; border-radius: 20px; font-size: 13px; }

.enter-row { display: flex; gap: 8px; }
.enter-row .el-input { flex: 1; }
.back-row { display: flex; align-items: center; gap: 10px; margin: 2px 0 12px; }
.mi-main { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

.mine-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.mine-item { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 0; border-top: 1px dashed var(--border); flex-wrap: wrap; }
.mi-name { font-weight: 600; margin-right: 6px; }
.mi-sub { color: var(--text-2); font-size: 12px; margin-left: 4px; }

.need-login { text-align: center; }

.center-load { display: flex; justify-content: center; padding: 60px 0; }

.head-main .sub2 { margin: 0; }
.sum-bar { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
.sum-chip { background: var(--surface-2); padding: 4px 10px; border-radius: 8px; font-size: 13px; color: var(--text-2); }
.sum-chip b { color: var(--text); }
.sum-chip i { font-style: normal; font-size: 11px; opacity: .7; }
.sum-chip.total { background: var(--primary-tint); color: var(--primary-dark); }
.sum-chip.total b { color: var(--primary); }
.head-ops { display: flex; gap: 6px; flex-wrap: wrap; }
.head-ops .el-button, .head-ops a { margin-left: 0; }

.who { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ok-dot { width: 8px; height: 8px; background: #22c55e; border-radius: 50%; display: inline-block; }
.my-total { color: var(--primary); }
.claim-tip { margin: 0 0 8px; color: var(--text-2); }
.claim-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.claim-group { font-size: 12px; color: var(--text-2); margin-right: 2px; }
.claim-tag { cursor: pointer; }

.team-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.pp-head { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.pp-card { border-color: #f59e0b55; } /* 全项目统一支付区块：琥珀描边与普通队伍卡区分 */
.team-ops { display: flex; gap: 6px; }
.team-ops .el-button { margin-left: 0; }
.member-row { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 4px; }
.member-chip { display: inline-flex; align-items: center; gap: 4px; background: var(--surface-3); border: 1px solid var(--border); padding: 3px 8px; border-radius: 14px; font-size: 13px; }
.m-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--border); }
.m-dot.ok { background: #22c55e; }
.m-more { cursor: pointer; color: var(--text-2); padding: 0 2px; }

.cat-block { border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; margin-top: 8px; }
.cat-head { display: flex; align-items: center; flex-wrap: wrap; gap: 2px 6px; }
.cat-add { margin-left: auto; }
.cat-title { font-weight: 600; }
.cat-total { color: var(--text-2); font-size: 12px; margin-left: 8px; }
.cat-empty { color: var(--text-2); font-size: 12px; padding: 4px 2px; }
/* 主体横向标签条（全项目统一支付 + 各队）：溢出可横向滚动 —— 细滚动条可见可拖、鼠标滚轮/触控板横滚 */
.exp-tabbar { display: flex; gap: 6px; align-items: center; overflow-x: auto; overflow-y: hidden; padding: 2px 2px 6px;
  scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
.exp-tabbar::-webkit-scrollbar { height: 6px; }
.exp-tabbar::-webkit-scrollbar-track { background: transparent; }
.exp-tabbar::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
.exp-tabbar::-webkit-scrollbar-thumb:hover { background: var(--primary); }
.tabchip { flex: none; white-space: nowrap; font: inherit; border: 1px solid var(--border); background: var(--surface-2);
  color: var(--text-2); border-radius: 18px; padding: 5px 12px; font-size: 13px; cursor: pointer; transition: all .15s; }
.tabchip:hover { border-color: var(--primary); }
.tabchip.on { background: var(--primary-tint); border-color: var(--primary); color: var(--primary-dark); font-weight: 600; }
.tab-sub { font-style: normal; opacity: .72; font-size: 11px; margin-left: 6px; font-weight: 400; }
.foot-note { text-align: center; color: var(--text-2); font-size: 12px; margin: 4px 0 20px; }
@media (max-width: 768px) { .tabchip { font-size: 12px; padding: 4px 9px; } }
.dim-tip { color: var(--text-2); font-size: 13px; margin: 0 0 10px; line-height: 1.7; }
.dim-tip .el-empty__description + * { margin-top: 8px; }
</style>
