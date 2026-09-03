<script setup>
// 报销记录录入/编辑弹窗：按 FIELDS 元数据生成表单
// 成员态：姓名/队伍冻结（归属服务端强制注入）；owner：可挑选名单成员或"队伍"（公用耗材）
// money→el-input-number(precision2) yn→三态 radio  textarea→textarea
// 2026-09-03 下午：帮付三字段已全部删除（无 yn 联动字段）；prop「是否日常家用=是」仍有使用图软提示
import { reactive, ref, computed, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../../api.js';
import auth from '../../auth.js'; // 负责人本人显示名（全项目统一支付可填"负责人本人"）
import { FIELDS, SLOTS, CATEGORIES } from '../../utils/expenseMeta.js';

const props = defineProps({
  modelValue: Boolean, mode: String, row: Object, teamId: Number, teams: Array,
  members: Array, code: String, me: Object, // {role, member}
  initialCat: String, // 新增时预选类别（类别块"＋添加"直达本类；编辑沿用 row.category）
});
const emit = defineEmits(['update:modelValue', 'saved', 'claim-lost']);

const isOwner = computed(() => props.me?.role === 'owner');
const myMember = computed(() => props.me?.member || null);

// 分类（新增时可先选；编辑继承 row.category）
const cat = ref(props.mode === 'create' ? (props.initialCat || '') : props.row.category);
const fields = computed(() => (cat.value ? FIELDS[cat.value] : []));
const slots = computed(() => (cat.value ? SLOTS[cat.value] : []));
const meta = computed(() => CATEGORIES.find((x) => x.key === cat.value));
const teamSel = ref(props.mode === 'create' ? props.teamId : props.row.team_id);
const teamName = computed(() => props.teams?.find((t) => t.id === teamSel.value)?.name || '');
// 负责人创建时挑选归属（名单成员 / prop 公用"队伍"）；成员创建锁定自己
const ownerSel = ref('');
const roster = computed(() => (props.members || []).filter((m) => m.team_id === teamSel.value));

// —— 全项目统一支付（项目级行）：create 从 teamId=0 入口进入；edit 由行 team_id 为空识别 ——
// 弹窗只可能被负责人打开（成员名下出现项目行也只是被代录，只读）；范围不必全体：
// 可勾选子集（跨队可）或留空 —— 详见下方 pay-zone 项目级分支
const isProjPay = computed(() => props.mode === 'create' ? Number(props.teamId) === 0
  : !!(props.row && props.row.team_id == null));
// 负责人本人显示名（服务端比对 username/nickname 同名即可，跨队名单外的兜底出钱人）
const selfName = () => String(auth.user?.nickname || auth.user?.username || '').trim();

// —— 统一支付/项目级记录（2026-09-03）：一人垫付多人/全队/整个项目的一笔费用；⑥零散票据=一张
//    可能含多人/跨队成员的票据文件（该类别仅项目级区可选，队行服务端 400 兜底）——
// 行归属=出钱人（与垫付统计口径一致）；「统一支付范围」= 文本快照说明涵盖哪些成员：
//   '全部成员' = 本队全体 · '全体成员' = 整个项目全体 · 顿号名单 = 勾选（可跨队）· 空 = 未标注（票据归档）
// 项目级（isProjPay）范围放开：不必全体 —— 可整个项目/勾选子集/留空（2026-09-03 下午）
const unified = ref(false); // 统一支付模式（create 可切换；edit 由行数据锁定；项目级行恒为 true）
const payMode = ref('team'); // team 本队全部 / proj 整个项目全部 / custom 勾选（可跨队）/ none 留空（仅项目级）
const payNames = ref([]); // 范围 = 勾选的成员名
const canSwitchMode = computed(() => props.mode === 'create');
const scopeText = () => payMode.value === 'proj' ? '全体成员'
  : payMode.value === 'team' ? '全部成员'
    : payMode.value === 'none' ? ''
      : payNames.value.map((s) => String(s).trim()).filter(Boolean).join('、');
// 自定义勾选的候选 = 整个项目所有队伍成员（按队分组带队名，跨队垫付由此表达）
const payPool = computed(() => {
  const byT = new Map();
  for (const m of props.members || []) {
    if (!byT.has(m.team_id)) byT.set(m.team_id, []);
    byT.get(m.team_id).push(m);
  }
  return [...byT.entries()].map(([tid, ms]) => ({
    tid,
    tname: String((props.teams || []).find((t) => t.id === tid)?.name || ''),
    ms,
  }));
});
const hasName = (n) => payNames.value.includes(String(n));
function toggleName(n, on) {
  const i = payNames.value.indexOf(String(n));
  if (on && i < 0) payNames.value.push(String(n));
  else if (!on && i >= 0) payNames.value.splice(i, 1);
}
// 统一支付/项目级行只展示通用字段：金额 / 备注（+ prop 日常家用 yn）；⑥零散票据另带「票据名称」text
// —— 一次集体垫付没有个体明细
const payFields = computed(() => (fields.value || []).filter((f) =>
  f.type === 'money' || f.type === 'yn' || (f.type === 'textarea' && f.key === '备注') ||
  (cat.value === 'misc' && f.type === 'text')));
// 单人行隐藏 meta 的 multi 键（范围区在统一支付模式单独渲染）
const renderFields = computed(() =>
  unified.value ? payFields.value : (fields.value || []).filter((f) => f.type !== 'multi'));

const form = reactive({});
const saving = ref(false);

// date 键只接受 YYYY-MM-DD（日历控件值），存量自由文本/脏值规整为空（null 表示未选）
const normDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : null);

// 初始化表单（新增=全空；编辑=回填 row.data）
function initForm() {
  for (const k of Object.keys(form)) delete form[k];
  if (!cat.value) return;
  for (const f of FIELDS[cat.value]) {
    if (f.type === 'multi') continue; // 范围键走统一支付状态，不进表单
    const v = props.mode === 'edit' ? props.row.data?.[f.key] : '';
    form[f.key] = f.type === 'money' ? (v === '' || v === undefined || v === null ? null : v)
      : f.type === 'date' ? normDate(v)
        : String(v ?? '');
  }
  // 统一支付/范围回填（编辑按行数据锁定；新增默认单人）：'全部成员'=本队 / '全体成员'=整个项目 / 其余=勾选名单（可空）
  const sc = String((props.mode === 'edit' ? props.row.data?.['统一支付范围'] : '') || '').trim();
  unified.value = !!sc || isProjPay.value; // 项目级行必走统一支付模式；范围可留空（票据归档）
  if (sc === '全体成员') payMode.value = 'proj';
  else if (sc === '全部成员') payMode.value = 'team';
  else if (sc) { payMode.value = 'custom'; payNames.value = sc.split(/[、,，\s]+/).map((s) => s.trim()).filter(Boolean); }
  else if (isProjPay.value) {
    // 项目级新增默认：五类=整个项目全体（历史口径），⑥零散票据=勾选（多为部分成员）；编辑空范围=留空
    payMode.value = props.mode === 'create' ? (cat.value === 'misc' ? 'custom' : 'proj') : 'none';
    payNames.value = [];
  } else { payMode.value = 'team'; payNames.value = []; }
  if (props.mode === 'edit') ownerSel.value = String(props.row.owner_name);
  else if (isProjPay.value) ownerSel.value = selfName() || (props.members || [])[0]?.name || '';
  else ownerSel.value = roster.value[0]?.name || '';
}
watch(cat, initForm, { immediate: true });
watch(() => props.teamId, (t) => { if (props.mode === 'create' && t) teamSel.value = t; });
watch(teamSel, () => { if (props.mode === 'create' && isOwner.value && roster.value.length) ownerSel.value = roster.value[0].name; });

const isMember = () => !!myMember.value && !isOwner.value;
const lockField = (f) => {
  // 购买人锁定：成员 prop 行必须=本人；公用"队伍"行必须=队伍（服务端同规则强制）
  if (f.key === '购买人' && isMember()) return true;
  if (f.key === '购买人' && props.mode === 'edit' && String(props.row.owner_name) === '队伍') return true;
  return false;
};
const propPhotoTip = computed(() =>
  cat.value === 'prop' && form['是否日常家用'] === '是' && props.mode === 'edit' && !(props.row.atts || []).some((a) => a.slot === 'usagePhoto')
    ? '选了"是"（日常/家用）请记得上传「项目使用图」照片'
    : cat.value === 'prop' && form['是否日常家用'] === '是'
      ? '若属于日常/家用物品，请在录入后上传「项目使用图」照片'
      : '');

// 名称选择区（负责人 = 出钱人；统一支付出钱人必须是个人，公用"队伍"仅单人行可选）
// 全项目统一支付：出钱人 = 项目里任意队伍的成员（跨队）或负责人本人
const pickList = computed(() => {
  if (isProjPay.value) {
    const tname = (tid) => String((props.teams || []).find((t) => t.id === tid)?.name || '');
    const ls = (props.members || []).map((m) => ({
      v: m.name,
      label: `${m.name}（${tname(m.team_id)}队${m.claimed ? '' : '·未认领'}）`,
    }));
    const me = selfName();
    if (me && !ls.some((x) => x.v === me)) ls.unshift({ v: me, label: `${me}（负责人本人）` });
    // 编辑回填的原出钱人可能已不在名单（成员改名/移出）→ 兜底展示原值
    if (ownerSel.value && !ls.some((x) => x.v === ownerSel.value)) ls.unshift({ v: ownerSel.value, label: `${ownerSel.value}（原出钱人）` });
    return ls;
  }
  const members = roster.value.map((m) => ({ v: m.name, label: `${m.name}（成员${m.claimed ? '' : '·未认领'}）` }));
  if (cat.value === 'prop' && isOwner.value && !unified.value) members.unshift({ v: '队伍', label: '队伍（公用耗材，全体分摊）' });
  return members;
});

function close() { emit('update:modelValue', false); }
async function save() {
  if (!cat.value) return ElMessage.warning('先选择费用类别');
  // 队伍行统一支付必须有范围；项目级行（含⑥零散票据）范围可空（仅存档/事后补标注）
  if (unified.value && !isProjPay.value) {
    const scope = scopeText();
    if (!scope) return ElMessage.warning('统一支付需选择涵盖范围（本队全部 / 整个项目全部 / 自定义勾选）');
    if (scope.length > 200) return ElMessage.warning('成员太多放不下了：直接用「本队全部成员」或「整个项目全部成员」');
  }
  if (isOwner.value && !ownerSel.value) {
    return ElMessage.warning(isProjPay.value
      ? '出钱人不能为空：选项目里任一队伍的成员，或负责人本人'
      : '该队还没有名单成员，无法归属 —— 先关掉弹窗，点队伍右上「⚙ 管理 → ＋ 添加成员」预录姓名后再录入');
  }
  const data = {};
  for (const f of renderFields.value) {
    let v = form[f.key];
    if (f.type === 'money') v = v === null || v === undefined || v === '' ? '' : Number(v);
    else v = String(v ?? '').trim();
    data[f.key] = v;
  }
  // 范围写入（白名单键，单人行=空）；后端创建时校验包含者都是本队名单成员
  data['统一支付范围'] = unified.value ? scopeText() : '';
  // prop 购买人：成员强制本人；负责人默认=归属（"队伍"公用行也在此生效）；编辑行沿用原值
  if (cat.value === 'prop') {
    if (!data.购买人) data.购买人 = isOwner.value ? ownerSel.value : (myMember.value?.name || '');
  }
  saving.value = true;
  try {
    let resp;
    if (props.mode === 'create') {
      // 全项目统一支付走项目级分支（后端 team_id=NULL；范围=弹窗所选：整个项目/子集/留空均收），其余=队伍行
      resp = isProjPay.value
        ? await api.expenseRowProjCreate(props.code, cat.value, data, isOwner.value ? ownerSel.value : undefined)
        : await api.expenseRowCreate(props.code, teamSel.value, cat.value, data, isOwner.value ? ownerSel.value : undefined);
    } else {
      resp = await api.expenseRowUpdate(props.code, props.row.id, { data });
    }
    for (const w of resp.warnings || []) ElMessage.warning(w);
    if (cat.value === 'prop' && data.是否日常家用 === '是') ElMessage.warning('是日常/家用物品的话，记得上传「项目使用图」(照片)');
    close();
    emit('saved', props.mode === 'create' ? '已添加记录' : '已保存');
  } catch (e) {
    if (/认领|身份/.test(e.message)) { api.expenseClearClaim(props.code); emit('claim-lost'); }
    ElMessage.error(e.message);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <el-dialog :model-value="modelValue" :title="meta ? `${meta.num} ${meta.zh} · ${props.mode === 'create' ? '录入' : '修改'}` : '录入记录'"
             width="min(94vw, 560px)" destroy-on-close @update:model-value="close" append-to-body>
    <template v-if="props.mode === 'create' && !cat">
      <!-- 第一步：选类别（队伍行五类；项目级区含 ⑥零散票据） -->
      <p style="margin:4px 0 10px">{{ isProjPay ? '选择费用类别（全项目统一支付 · 项目级，不属任何队伍；⑥零散票据也在这里）' : `选择费用类别（${teamName}队）` }}</p>
      <div class="cat-pick">
        <el-tag v-for="c in (isProjPay ? CATEGORIES : CATEGORIES.filter((x) => x.key !== 'misc'))" :key="c.key"
                class="cp" @click="cat = c.key" size="large">
          {{ c.num }} {{ c.zh }}
        </el-tag>
      </div>
      <p class="dim">附件要求：发票 PDF / 发票查验 / 付款凭证截图等按类别不同，录入后在上传区逐个添加</p>
    </template>

    <template v-else>
      <div v-if="isOwner && !roster.length && cat !== 'prop' && !isProjPay" class="tip-warn" style="margin-bottom:8px">
        ⚠ 该队名单为空：归属选不出成员 —— 先取消，进队伍「⚙ 管理 → ＋ 添加成员」预录姓名；公用物品类（⑤耗材道具）可归属"队伍"代录
      </div>
      <p class="dim line">
        <!-- 全项目统一支付：区块名 + 全项目成员挑选出钱人（含负责人本人） -->
        <template v-if="isProjPay">
          区块：<b>全项目统一支付</b><el-tag size="small" type="warning" effect="plain" style="margin:0 4px">不属任何队伍 · 涵盖整个项目</el-tag>
          <template v-if="isOwner">
            · 出钱人：
            <el-select v-model="ownerSel" size="small" style="width: 200px" :disabled="props.mode === 'edit'">
              <el-option v-for="o in pickList" :key="o.v" :label="o.label" :value="o.v" />
            </el-select>
          </template>
        </template>
        <template v-else>
          队伍：<b>{{ teamName }}</b>
          <template v-if="isMember()"> · 成员：<b>{{ myMember.name }}</b><el-tag size="small" style="margin-left:6px">本人</el-tag></template>
          <template v-else>
            · 归属（出钱人）：
            <el-select v-model="ownerSel" size="small" style="width: 180px" :disabled="props.mode === 'edit'">
              <el-option v-for="o in pickList" :key="o.v" :label="o.label" :value="o.v" />
            </el-select>
          </template>
        </template>
        <template v-if="props.mode === 'edit'"> · 类别：{{ meta.zh }}<el-tag type="info" size="small" style="margin-left:6px">类别不可改</el-tag></template>
      </p>

      <!-- 录入方式：单人记录 / 统一支付（一人为多人/全部垫付）；全项目统一支付区块固定=统一支付 -->
      <div v-if="!isProjPay && canSwitchMode" class="mode-bar">
        <el-radio-group v-model="unified" size="small">
          <el-radio-button :value="false">单人记录</el-radio-button>
          <el-radio-button :value="true">统一支付（一人为多人/全部垫付）</el-radio-button>
        </el-radio-group>
      </div>
      <div v-else class="mode-bar mode-locked">
        <template v-if="isProjPay">
          录入方式：
          <el-tag size="small" type="warning" effect="plain">{{ meta?.key === 'misc' ? '⑥ 零散票据 · 项目级存档' : '全项目统一支付 · 项目级垫付' }}</el-tag>
          <span class="dim">类别创建后不可改；涵盖的人可在下方勾选（⑥零散票据也可先留空）</span>
        </template>
        <template v-else>
          录入方式：
          <el-tag size="small" :type="unified ? 'warning' : 'info'" effect="plain">
            {{ unified ? '统一支付（一人为多人垫付）' : '单人记录' }}
          </el-tag>
          <span class="dim">类别与录入方式创建后不可改</span>
        </template>
      </div>
      <p v-if="unified" class="pay-tip">
        <template v-if="isProjPay">
          <template v-if="meta?.key === 'misc'">
            ⑥零散票据：把<b>一张可能含多人/跨队成员</b>的票据文件放这儿（如几张打车票、一次代缴的报名费）——「票据名称」写清这张票是什么，下方勾选涵盖的人（可跨队）；暂不确定可先留空，只作存档。
          </template>
          <template v-else>
            全项目统一支付：出钱人（{{ props.mode === 'create' ? ownerSel || '待选' : ownerSel }}）为下方所选范围内的人垫付一笔「{{ meta?.zh }}」——金额=这一笔合计，统计记出钱人名下；发票/凭证按类别传一份即可。
          </template>
        </template>
        <template v-else>
          统一支付：{{ isOwner ? '所选出钱人' : '你' }}为范围内的人垫付一笔「{{ meta?.zh }}」——范围可勾选多人、其他队伍的成员，或直接选整个项目；金额=这一笔合计，统计记出钱人名下，发票/凭证按类别传一份即可。
        </template>
      </p>

      <el-form label-width="110px" label-position="left" size="default" @submit.prevent>
        <el-form-item v-for="f in renderFields" :key="f.key" :label="f.label">
          <el-input-number v-if="f.type === 'money'" v-model="form[f.key]" :precision="2" :min="0" :controls="false"
                           placeholder="金额，单位元" style="width:100%" />
          <el-date-picker v-else-if="f.type === 'date'" v-model="form[f.key]" type="date"
                          value-format="YYYY-MM-DD" format="YYYY-MM-DD" style="width:100%"
                          clearable :placeholder="f.placeholder || '点击日历选择日期'" :disabled="lockField(f)" />
          <el-radio-group v-else-if="f.type === 'yn'" v-model="form[f.key]" :disabled="lockField(f)">
            <el-radio-button value="">不涉及</el-radio-button>
            <el-radio-button value="是">是</el-radio-button>
            <el-radio-button value="否">否</el-radio-button>
          </el-radio-group>
          <el-input v-else-if="f.type === 'textarea'" v-model="form[f.key]" type="textarea" :rows="2"
                    maxlength="200" show-word-limit :disabled="lockField(f)" :placeholder="f.placeholder || ''" />
          <el-input v-else v-model="form[f.key]" :maxlength="f.max || 40" :disabled="lockField(f)" :placeholder="f.placeholder || ''" />
        </el-form-item>
      </el-form>

      <!-- 统一支付：本次涵盖范围（本队全部 / 整个项目全部 / 自定义勾选·可跨队）；项目级行=整个项目/勾选/留空 -->
      <div v-if="unified" class="pay-zone">
        <template v-if="isProjPay">
          <div class="pay-row">
            <span class="pay-lb">涵盖的人</span>
            <el-radio-group v-model="payMode" size="small" :disabled="saving">
              <el-radio-button value="proj">整个项目全部（{{ (props.members || []).length }} 人）</el-radio-button>
              <el-radio-button value="custom">自定义勾选（可跨队）</el-radio-button>
              <el-radio-button value="none">暂不选（仅存档）</el-radio-button>
            </el-radio-group>
          </div>
          <template v-if="payMode === 'proj'">
            <p class="pay-hint">将涵盖整个项目的全体成员（{{ payPool.map((g) => `${g.tname}队 ${g.ms.length} 人`).join('、') }}）—— 一人统一缴纳全项目费用时选这项</p>
          </template>
          <template v-else-if="payMode === 'none'">
            <p class="pay-hint">先不标注涵盖的人 —— 记录只作存档；之后想补范围可再点「✏ 编辑」</p>
          </template>
          <div v-else class="pay-names">
            <template v-for="g in payPool" :key="g.tid">
              <div class="pay-grp">{{ g.tname }}队</div>
              <div class="pay-line">
                <el-checkbox v-for="m in g.ms" :key="m.id" :model-value="hasName(m.name)" :disabled="saving"
                             @change="toggleName(m.name, $event)">
                  {{ m.name }}<i v-if="!m.claimed" class="pay-uncl">（未认领）</i>
                </el-checkbox>
              </div>
            </template>
            <p v-if="!payPool.length" class="pay-hint">项目还没有任何名单成员 —— 可先在队伍「⚙ 管理 → ＋ 添加成员」预录后回来勾选，或选「暂不选（仅存档）」</p>
            <p v-else-if="!payNames.length" class="pay-hint">{{ meta?.key === 'misc' ? '勾选这张票据涵盖的成员（可跨队勾选）' : '勾选本次垫付涵盖的成员（可跨队勾选）' }}</p>
            <p v-else class="pay-hint">已勾选：{{ payNames.join('、') }}</p>
          </div>
        </template>
        <template v-else>
          <div class="pay-row">
            <span class="pay-lb">涵盖范围</span>
            <el-radio-group v-model="payMode" size="small" :disabled="saving">
              <el-radio-button value="team" :disabled="!roster.length">本队全部（{{ roster.length }} 人）</el-radio-button>
              <el-radio-button value="proj">整个项目全部（{{ (props.members || []).length }} 人）</el-radio-button>
              <el-radio-button value="custom">自定义勾选</el-radio-button>
            </el-radio-group>
          </div>
          <template v-if="payMode === 'team'">
            <p class="pay-hint">将涵盖本队全部成员：{{ roster.map((m) => m.name).join('、') }}</p>
          </template>
          <template v-else-if="payMode === 'proj'">
            <p class="pay-hint">将涵盖整个项目的全体成员（{{ payPool.map((g) => `${g.tname}队 ${g.ms.length} 人`).join('、') }}）——报名费、全团住宿等由一人统一缴纳时选这项</p>
          </template>
        <div v-else class="pay-names">
          <template v-for="g in payPool" :key="g.tid">
            <div class="pay-grp">{{ g.tname }}队</div>
            <div class="pay-line">
              <el-checkbox v-for="m in g.ms" :key="m.id" :model-value="hasName(m.name)" :disabled="saving"
                           @change="toggleName(m.name, $event)">
                {{ m.name }}<i v-if="!m.claimed" class="pay-uncl">（未认领）</i>
              </el-checkbox>
            </div>
          </template>
          <p v-if="!payPool.length" class="pay-hint">项目还没有任何名单成员 —— 先在各队「⚙ 管理 → ＋ 添加成员」预录</p>
          <p v-else-if="!payNames.length" class="pay-hint">勾选本次垫付的成员（可跨队伍勾选）</p>
        </div>
        </template>
      </div>

      <div v-if="propPhotoTip" class="tip-warn">⚠ {{ propPhotoTip }}</div>

      <template v-if="props.mode === 'create'">
        <p class="dim" style="margin-top:10px">录入后需上传：{{ slots.map((s) => s.label).join('、') }}（缺的可在卡片上补传）</p>
      </template>
      <div v-if="slots.length" class="slot-tips">
        <span v-for="s in slots" :key="s.key" class="st">{{ s.label }}</span>
      </div>
    </template>

    <template #footer>
      <el-button @click="close">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!cat" @click="save">{{ props.mode === 'create' ? '保存并继续传附件' : '保存' }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.cat-pick { display: flex; flex-wrap: wrap; gap: 8px; }
.cp { cursor: pointer; font-size: 15px; padding: 8px 14px; }
.dim { color: var(--text-2); font-size: 12px; margin: 2px 0; }
.line { display: flex; align-items: center; gap: 4px; margin-bottom: 10px; }
.tip-warn { color: #b45309; background: #fef3c7; border-radius: 6px; padding: 4px 10px; font-size: 12px; margin: 4px 0; }
.slot-tips { display: flex; flex-wrap: wrap; gap: 6px; }
.st { border: 1px dashed var(--border); border-radius: 6px; padding: 2px 8px; font-size: 12px; color: var(--text-2); }
.mode-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.mode-locked { font-size: 13px; color: var(--text); }
.pay-tip { color: #b45309; background: #fef9ec; border: 1px dashed #fcd34d; border-radius: 6px; padding: 5px 10px; font-size: 12px; margin: 0 0 8px; }
.pay-zone { border: 1px dashed var(--border); border-radius: 8px; padding: 8px 10px; margin-top: 2px; }
.pay-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pay-lb { font-size: 12px; color: var(--text-2); }
.pay-names { margin-top: 6px; }
.pay-grp { font-size: 12px; color: var(--text-2); margin: 8px 0 2px; }
.pay-grp:first-child { margin-top: 0; }
.pay-line { display: flex; flex-wrap: wrap; gap: 2px 10px; }
.pay-line .el-checkbox { margin-right: 0; height: 26px; }
.pay-names .el-checkbox { margin-right: 0; height: 26px; }
.pay-uncl { font-style: normal; color: var(--text-2); font-size: 12px; }
.pay-hint { color: var(--text-2); font-size: 12px; margin: 6px 0 0; }
</style>
