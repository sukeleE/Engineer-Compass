<script setup>
// 报销记录卡片：meta 驱动展示字段 + 每槽位附件 chip（图片大图预览 / PDF 新开 / 其余下载）
import { ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../../api.js';
import { FIELDS, SLOTS, CATEGORIES, rowMoney, slotLabel } from '../../utils/expenseMeta.js';
import { openImage } from '../../utils/imageViewer.js';

const props = defineProps({
  row: Object, code: String,
  editable: Boolean,      // 可编辑/可删除/可上传（服务端权限已在父层判定）
  lockedField: String,    // 该字段冻结（prop 成员行的购买人）
});
const emit = defineEmits(['edit', 'changed']);

const cat = props.row.category;
const fields = FIELDS[cat];
const money = rowMoney(cat, props.row.data);
const scopeTxt = String(props.row.data?.['统一支付范围'] || '').trim(); // 非空 = 统一支付行（一人垫付多人/全项目）
// 展示用标题：'全部成员'=本队 / '全体成员'=整个项目（数据按原样存，仅提示语释义）
const scopeTitle = scopeTxt === '全体成员' ? '涵盖：整个项目全体成员' : `涵盖：${scopeTxt || ''}`;
const fmt = (n) => (Number.isFinite(n) && n > 0 ? n.toFixed(2) : '—');
const yn = (v) => ({ '': '', 是: ['ok', '是'], 否: ['no', '否'] }[v] || ['', '']);
const showVal = (f) => {
  const v = props.row.data?.[f.key];
  if (v === undefined || v === null || v === '') return null;
  return String(v);
};
const fieldsShown = (f) => {
  if (f.type === 'yn') return false; // yn 单独渲染
  return true;
};

// ---- 附件 ----
const fileInput = ref(null);
const pendingSlot = ref(null);
const uploading = ref(''); // `${row.id}/${slot}` 进行中防重复点
const MAX = 25 * 1024 * 1024;
const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');
const attOf = (slot) => props.row.atts?.find((a) => a.slot === slot) || null;
const attListOf = (slot) => props.row.atts?.filter((a) => a.slot === slot) || [];
// 统一支付行 = 项目级行（team_id 空：全项目统一支付区/⑥零散票据）或 统一支付范围非空（一人垫付多人）
// → 附件每槽可多份（追加、逐份删）；单人常规记录（个人行且无范围）每槽仍一份（服务端同规则，重传=替换）
const rowMulti = props.row.team_id == null || scopeTxt !== '';
const attUrl = (a) => api.expenseFileUrl(props.code, a.id);
const isImg = (a) => (a.mime || '').startsWith('image/');

function openAtt(a) {
  const url = attUrl(a);
  if (isImg(a)) openImage(url, a.orig_name);
  else if ((a.mime || '') === 'application/pdf') window.open(url, '_blank');
  else { const el = document.createElement('a'); el.href = url; el.setAttribute('download', a.orig_name); el.click(); }
}
function clickUpload(slot) {
  if (!props.editable || uploading.value) return;
  pendingSlot.value = slot;
  fileInput.value?.click();
}
async function onFile(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > MAX) return ElMessage.error('附件过大（单文件 ≤25MB）');
  const slot = pendingSlot.value;
  if (!slot) return;
  uploading.value = `${props.row.id}/${slot}`;
  try {
    await api.expenseAttUpload(props.code, props.row.id, slot, file);
    ElMessage.success(`「${slotLabel(cat, slot)}」已上传`);
    emit('changed');
  } catch (err) {
    ElMessage.error(err.message);
    if (/认领|身份/.test(err.message)) emit('claim-lost');
  } finally {
    uploading.value = '';
  }
}
async function delAtt(a) {
  try {
    await ElMessageBox.confirm(`删除附件「${a.orig_name}」？`, '删除附件', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' });
  } catch { return; }
  try {
    await api.expenseAttDelete(props.code, props.row.id, a.id);
    ElMessage.success('附件已删除');
    emit('changed');
  } catch (e) { ElMessage.error(e.message); }
}
async function delRow() {
  const n = props.row.atts?.length || 0;
  const zh = CATEGORIES.find((x) => x.key === cat)?.zh || cat;
  try {
    await ElMessageBox.confirm(`删除这条${zh}记录${n ? `（含 ${n} 个附件原件，一并删除）` : ''}？`, '删除记录', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' });
  } catch { return; }
  try {
    await api.expenseRowDelete(props.code, props.row.id);
    ElMessage.success('记录已删除');
    emit('changed');
  } catch (e) { ElMessage.error(e.message); }
}
</script>

<template>
  <div class="row-card">
    <div class="rc-top">
      <span class="rc-name">{{ row.owner_name }}</span>
      <el-tag v-if="scopeTxt" size="small" type="warning" effect="plain" :title="`统一支付（${scopeTitle}）`">统一支付</el-tag>
      <span class="rc-time">{{ (row.update_time || '').slice(0, 16) }}</span>
      <span class="grow"></span>
      <template v-if="editable">
        <el-button size="small" text type="primary" @click="emit('edit', row)">✏ 编辑</el-button>
        <el-button size="small" text type="danger" @click="delRow">🗑</el-button>
      </template>
    </div>

    <!-- 字段值（meta 驱动） -->
    <div class="rc-fields">
      <template v-for="f in fields" :key="f.key">
        <!-- money -->
        <div v-if="f.type === 'money'" class="rc-cell money">
          <span class="rc-label">{{ f.label.replace('(元)', '') }}</span>
          <b :class="{ empty: !(row.data?.[f.key] > 0) }">¥{{ fmt(row.data?.[f.key]) }}</b>
        </div>
        <!-- yn -->
        <div v-else-if="f.type === 'yn'" class="rc-cell">
          <span class="rc-label">{{ f.label }}</span>
          <span v-if="yn(row.data?.[f.key])" :class="['yn', yn(row.data?.[f.key])[0]]">{{ yn(row.data?.[f.key])[1] }}</span>
          <span v-else class="yn off">未填</span>
        </div>
        <!-- text / textarea -->
        <div v-else class="rc-cell full" :class="{ locked: f.key === lockedField }">
          <span class="rc-label">{{ f.label }}</span>
          <span v-if="showVal(f)" class="rc-val">{{ showVal(f) }}</span>
          <span v-else class="rc-val empty">—</span>
        </div>
      </template>
    </div>

    <!-- 附件槽位 -->
    <div class="att-row">
      <template v-for="s in SLOTS[cat]" :key="s.key">
        <!-- 统一支付行（项目级行/统一支付范围非空）：每槽可多份 —— 逐份 chip，随时可再传 -->
        <template v-if="rowMulti">
          <div v-for="a in attListOf(s.key)" :key="a.id" class="att-chip has">
            <span class="att-ok" :title="slotLabel(cat, s.key)">
              {{ isImg(a) ? '🖼️' : (a.mime === 'application/pdf' ? '📕' : '📄') }}
              <a class="att-name" :title="a.orig_name" @click.prevent="openAtt(a)">{{ a.orig_name }}</a>
            </span>
            <span class="att-meta">{{ fmtBytes(a.size) }}</span>
            <a v-if="editable" class="att-x" title="下载" :href="api.expenseFileUrl(code, a.id, true)">⬇</a>
            <a v-if="editable" class="att-x" title="删除" @click.prevent="delAtt(a)">✕</a>
          </div>
          <!-- 再传入口（统一支付原件往往不止一张；槽位为空时即是上传入口） -->
          <span v-if="editable" class="att-empty" :title="`「${slotLabel(cat, s.key)}」统一支付行可存多份`" @click="clickUpload(s.key)">
            {{ uploading === `${row.id}/${s.key}` ? '上传中…' : (attListOf(s.key).length ? `＋${slotLabel(cat, s.key)}` : `${slotLabel(cat, s.key)} ＋上传`) }}
          </span>
          <span v-else-if="!attListOf(s.key).length" class="att-empty" data-ok>未交</span>
        </template>
        <!-- 单人常规记录：每槽一份（重传=替换） -->
        <template v-else>
          <!-- 已上传 -->
          <div v-if="attOf(s.key)" class="att-chip has">
            <span class="att-ok" :title="slotLabel(cat, s.key)">
              {{ isImg(attOf(s.key)) ? '🖼️' : (attOf(s.key).mime === 'application/pdf' ? '📕' : '📄') }}
              <a class="att-name" :title="attOf(s.key).orig_name" @click.prevent="openAtt(attOf(s.key))">{{ attOf(s.key).orig_name }}</a>
            </span>
            <span class="att-meta">{{ fmtBytes(attOf(s.key).size) }}</span>
            <a v-if="editable" class="att-x" title="下载" :href="api.expenseFileUrl(code, attOf(s.key).id, true)">⬇</a>
            <a v-if="editable" class="att-x" title="删除" @click.prevent="delAtt(attOf(s.key))">✕</a>
          </div>
          <!-- 未上传 -->
          <span v-else class="att-empty" @click="clickUpload(s.key)">
            {{ slotLabel(cat, s.key) }}
            <i v-if="editable">{{ uploading === `${row.id}/${s.key}` ? '上传中…' : '＋上传' }}</i>
            <i v-else>未交</i>
          </span>
        </template>
      </template>
    </div>
    <input v-show="false" ref="fileInput" type="file" accept=".pdf,.jpg,.jpeg,.jfif,.png,.gif,.webp,.bmp" @change="onFile" />
  </div>
</template>

<style scoped>
.row-card { border: 1px dashed var(--border); border-radius: 8px; padding: 8px 10px; margin: 6px 0; background: var(--surface-3); }
.rc-top { display: flex; align-items: center; gap: 8px; }
.rc-name { font-weight: 600; }
.rc-time { color: var(--text-2); font-size: 11px; }
.grow { flex: 1; }
.rc-top .el-button { margin-left: 0; }
.rc-fields { display: flex; flex-wrap: wrap; gap: 4px 18px; padding: 6px 0; }
.rc-cell { display: flex; flex-direction: column; min-width: 70px; }
.rc-cell.money { min-width: 84px; }
.rc-cell.full { flex: 1 1 200px; }
.rc-cell.locked { opacity: .75; }
.rc-label { font-size: 11px; color: var(--text-2); }
.rc-val { word-break: break-all; font-size: 13px; }
.empty { color: #cbd5e1; }
.rc-cell.money b { font-size: 14px; color: var(--primary-dark); }
.yn { font-size: 12px; padding: 0 6px; border-radius: 8px; align-self: flex-start; }
.yn.ok { background: #dcfce7; color: #15803d; }
.yn.no { background: #fee2e2; color: #b91c1c; }
.yn.off { background: var(--surface-2); color: var(--text-2); }
.att-row { display: flex; flex-wrap: wrap; gap: 6px; }
.att-chip { display: inline-flex; align-items: center; gap: 6px; border-radius: 6px; padding: 2px 8px; font-size: 12px; }
.att-chip.has { background: var(--card-bg); border: 1px solid var(--border); }
.att-name { cursor: pointer; color: var(--primary); text-decoration: none; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; vertical-align: bottom; }
.att-meta { color: var(--text-2); font-size: 11px; }
.att-x { cursor: pointer; color: var(--text-2); font-size: 12px; text-decoration: none; }
.att-empty { border: 1px dashed #cbd5e1; color: var(--text-2); border-radius: 6px; padding: 2px 8px; font-size: 12px; }
.att-empty i { font-style: normal; }
.att-empty[data-ok] { cursor: default; }
.att-empty { cursor: pointer; }
</style>
