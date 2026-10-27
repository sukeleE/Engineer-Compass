<template>
  <el-dialog :model-value="modelValue" @close="emit('close')" title="批量导入资源（AI 混合识别）"
    width="980px" append-to-body destroy-on-close>
    <el-radio-group v-model="mode" class="ri-kind">
      <el-radio-button value="mixed">🤖 AI 混合识别</el-radio-button>
      <el-radio-button v-for="k in KINDS" :key="k.key" :value="k.key">{{ k.icon }} 仅{{ k.label }}</el-radio-button>
    </el-radio-group>

    <div class="ri-actions">
      <el-button size="small" plain :loading="tplLoading" @click="downloadTpl">⬇️ 下载模板</el-button>
      <el-button size="small" type="primary" plain :loading="parsing" @click="pickFile">
        📂 选择表格（xlsx/xls/csv）
      </el-button>
      <span v-if="fileName" class="ri-file">
        已选：{{ fileName }}（{{ effectiveCount }} 条有效行<template v-if="stats">，物品 {{ stats.item }} / 空间 {{ stats.space }}</template>）
      </span>
      <input ref="fileInput" type="file" accept=".xlsx,.xls,.csv" hidden @change="onFile" />
    </div>

    <el-alert v-if="stats" class="ri-stat" :type="stats.invalid ? 'warning' : 'success'" :closable="false" show-icon
      :title="`识别结果：物品 ${stats.item} 条，空间 ${stats.space} 条，异常 ${stats.invalid} 条，跳过 ${stats.skipped || 0} 行，低置信度 ${stats.low_confidence || 0} 条`" />

    <el-alert v-if="warnings.length" class="ri-warn" type="warning" :closable="false" show-icon
      title="表格解析结果，请逐行核对后再导入">
      <ul class="ri-warn-list">
        <li v-for="(w, i) in warnings" :key="i">{{ w }}</li>
      </ul>
    </el-alert>

    <p class="ri-tip">
      <template v-if="mode === 'mixed'">
        AI 模式支持物品和空间放在同一 Sheet、不同 Sheet 或上下分段；类型列可填「物品/空间」，也可由 AI 根据名称和字段判断。<br />
      </template>
      当前录入 <b>{{ modeLabel }}</b>：每行一条，一次最多 200 行。黄色行为低置信度，导入前可直接修改类型、库存、容量等字段。
    </p>

    <div class="ri-table-wrap">
      <table class="ri-table" :class="{ mixed: mode === 'mixed' }">
        <thead>
          <tr>
            <th style="width: 42px">#</th>
            <th v-if="mode === 'mixed'" style="width: 104px">类型*</th>
            <th style="min-width: 150px">名称*</th>
            <th style="width: 128px">规格型号</th>
            <th style="width: 104px">库存*</th>
            <th style="width: 70px">单位</th>
            <th style="min-width: 120px">位置/房间号</th>
            <th style="width: 104px">容量*</th>
            <th style="min-width: 150px">室内设备</th>
            <th style="width: 118px">审批方式</th>
            <th style="width: 105px">来源</th>
            <th style="width: 48px"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in rows" :key="i" :class="{ invalid: row.issues?.length, low: row.confidence === 'low' }">
            <td class="dim">{{ i + 1 }}</td>
            <td v-if="mode === 'mixed'">
              <el-select v-model="row.kind" size="small" style="width: 92px">
                <el-option value="item" label="📦 物品" />
                <el-option value="space" label="🏢 空间" />
              </el-select>
            </td>
            <td>
              <el-input v-model="row.name" size="small" placeholder="资源名称" />
              <el-tag v-for="(issue, ii) in row.issues" :key="ii" size="small" type="danger" effect="plain" class="issue-tag"
                :title="issue">!</el-tag>
            </td>
            <td><el-input v-model="row.spec" size="small" placeholder="物品规格" :disabled="row.kind === 'space' && mode === 'mixed'" /></td>
            <td><el-input-number v-model="row.quantity" :min="1" :max="9999" size="small" controls-position="right"
              style="width: 96px" :disabled="row.kind === 'space' && mode === 'mixed'" /></td>
            <td><el-input v-model="row.unit" size="small" maxlength="8" placeholder="件" :disabled="row.kind === 'space' && mode === 'mixed'" /></td>
            <td><el-input v-model="row.location" size="small" placeholder="存放位置/房间号" /></td>
            <td><el-input-number v-model="row.capacity" :min="1" :max="9999" size="small" controls-position="right"
              style="width: 96px" :disabled="row.kind === 'item' && mode === 'mixed'" /></td>
            <td><el-input v-model="row.equipment_text" size="small" placeholder="投影仪，白板"
              :disabled="row.kind === 'item' && mode === 'mixed'" /></td>
            <td>
              <el-select v-model="row.approve_mode" size="small" style="width: 104px">
                <el-option value="" label="项目默认" />
                <el-option value="approval" label="需审批" />
                <el-option value="first_come" label="先到先得" />
              </el-select>
            </td>
            <td class="dim source-cell">
              <span v-if="row._sheet">{{ row._sheet }}<template v-if="row._row">#{{ row._row }}</template></span>
              <span v-else>手动</span>
            </td>
            <td><el-button link type="danger" size="small" @click="rows.splice(i, 1)">删</el-button></td>
          </tr>
        </tbody>
      </table>
    </div>
    <el-button size="small" plain style="margin-top: 8px" @click="addRow">
      ＋ 加一行{{ mode === 'mixed' ? '（物品）' : '' }}
    </el-button>
    <el-button v-if="mode === 'mixed'" size="small" plain style="margin-left: 6px" @click="addRow('space')">＋ 加空间行</el-button>

    <template #footer>
      <el-button @click="emit('close')">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submit">导入 {{ effectiveCount }} 条</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../../api.js';
import { KINDS, KIND_MAP } from '../../utils/booking.js';

const props = defineProps({
  modelValue: Boolean,
  project: { type: Object, required: true },
  existingNames: { type: Array, default: () => [] },
});
const emit = defineEmits(['close', 'saved']);

const mode = ref('mixed');
const rows = ref([]);
const saving = ref(false);
const parsing = ref(false);
const tplLoading = ref(false);
const warnings = ref([]);
const stats = ref(null);
const fileName = ref('');
const fileInput = ref(null);

const modeLabel = computed(() => mode.value === 'mixed' ? 'AI 混合模式' : KIND_MAP[mode.value]?.label);
const effectiveCount = computed(() => rows.value.filter((r) => String(r.name || '').trim()).length);

function blankRow(kind = 'item') {
  const rowKind = mode.value === 'mixed' ? kind : mode.value;
  return {
    kind: rowKind, name: '', spec: '', quantity: undefined, unit: '', location: '',
    capacity: undefined, equipment_text: '', approve_mode: '', confidence: 'high', issues: [],
    _sheet: '', _row: null,
  };
}
const numOrUndef = (v) => {
  if (v === '' || v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
};
const toCommonRow = (it, forcedKind = '') => ({
  kind: forcedKind || it.kind || 'item',
  name: it.name || '',
  spec: it.spec || '',
  quantity: numOrUndef(it.quantity),
  unit: it.unit || '',
  location: it.location || '',
  capacity: numOrUndef(it.capacity),
  equipment_text: Array.isArray(it.equipment) ? it.equipment.join('，') : (it.equipment_text || ''),
  approve_mode: it.approve_mode || '',
  confidence: it.confidence || 'high',
  issues: Array.isArray(it.issues) ? [...it.issues] : [],
  _sheet: it._sheet || '',
  _row: it._row || null,
});
function resetBlankRows() {
  if (mode.value === 'mixed') rows.value = [blankRow('item'), blankRow('item'), blankRow('space')];
  else rows.value = [blankRow(mode.value), blankRow(mode.value), blankRow(mode.value)];
}
function addRow(kind = 'item') {
  if (rows.value.length >= 200) return ElMessage.warning('一次最多 200 条');
  rows.value.push(blankRow(kind));
}
watch(() => [props.modelValue, mode.value], ([open]) => {
  if (open) {
    resetBlankRows();
    warnings.value = [];
    stats.value = null;
    fileName.value = '';
  }
});

function pickFile() { fileInput.value?.click(); }
async function onFile(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  parsing.value = true;
  warnings.value = [];
  stats.value = null;
  try {
    const d = mode.value === 'mixed'
      ? await api.bookingResourceAiParseImport(props.project.id, 'mixed', file)
      : await api.bookingResourceParseImport(props.project.id, mode.value, file);
    rows.value = (d.items || []).map((it) => toCommonRow(it, mode.value === 'mixed' ? '' : mode.value));
    stats.value = d.stats || null;
    warnings.value = Array.isArray(d.warnings) ? d.warnings : [];
    fileName.value = file.name;
    if (!d.items?.length) {
      ElMessage.warning('表格里没有识别出有效资源行，请核对后重试');
      resetBlankRows();
    } else if (d.stats?.invalid) {
      ElMessage.warning(`有 ${d.stats.invalid} 行需要修正，请查看红色感叹号`);
    }
  } catch (err) {
    fileName.value = '';
    ElMessage.error(err.message);
  } finally {
    parsing.value = false;
  }
}

function validateNamedRows(named) {
  const seen = new Set();
  let errorCount = 0;
  named.forEach((r) => {
    r.issues = Array.isArray(r.issues) ? r.issues.filter((x) => String(x).includes('AI 提取')) : [];
    const kind = mode.value === 'mixed' ? r.kind : mode.value;
    const name = String(r.name || '').trim();
    if (!name || name.length > 30) r.issues.push('资源名称必填且不能超过 30 字');
    if (seen.has(name)) r.issues.push('表格内存在同名资源');
    seen.add(name);
    if (props.existingNames.some((x) => String(x || '').trim() === name)) r.issues.push('项目内已存在同名资源');
    if (kind === 'space') {
      if (!Number.isInteger(Number(r.capacity)) || Number(r.capacity) < 1 || Number(r.capacity) > 9999) r.issues.push('空间容量须为 1–9999 的整数');
    } else {
      if (!Number.isInteger(Number(r.quantity)) || Number(r.quantity) < 1 || Number(r.quantity) > 9999) r.issues.push('物品库存须为 1–9999 的整数');
    }
    if (r.issues.length) errorCount++;
  });
  return errorCount;
}

async function downloadTpl() {
  tplLoading.value = true;
  try {
    const { blob, name } = await api.bookingResourceTemplateBlob(props.project.id, mode.value);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    tplLoading.value = false;
  }
}

async function submit() {
  const named = rows.value.filter((r) => String(r.name || '').trim());
  if (!named.length) return ElMessage.warning('请至少填写一行有效数据');
  const errors = validateNamedRows(named);
  if (errors) return ElMessage.error(`有 ${errors} 行信息不正确，请修正红色感叹号后再导入`);

  const items = named.map((r) => {
    const kind = mode.value === 'mixed' ? r.kind : mode.value;
    const base = {
      kind,
      name: String(r.name).trim(),
      location: r.location || '',
      approve_mode: r.approve_mode || props.project.default_approve_mode || 'approval',
    };
    if (kind === 'space') {
      base.capacity = Number(r.capacity);
      base.equipment = String(r.equipment_text || '').split(/[,，、;；\n]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
    } else {
      base.spec = r.spec || '';
      base.quantity = Number(r.quantity);
      base.unit = r.unit || '';
    }
    return base;
  });
  saving.value = true;
  try {
    const d = await api.bookingResourceBulk(props.project.id, items);
    ElMessage.success(d.message || `已导入 ${items.length} 条`);
    emit('saved');
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    saving.value = false;
  }
}
</script>

<style lang="scss" scoped>
.ri-kind { margin-bottom: 8px; }
.ri-actions { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
.ri-file { font-size: 12.5px; color: var(--text-3); }
.ri-stat, .ri-warn { margin-bottom: 8px; }
.ri-warn-list { margin: 4px 0 0; padding-left: 18px; font-size: 12.5px; line-height: 1.7; }
.ri-tip { font-size: 12.5px; color: var(--text-3); margin: 4px 0 10px; }
.ri-table-wrap { overflow-x: auto; border: 1px solid var(--border-2); border-radius: 8px; }
.ri-table { width: 100%; border-collapse: collapse; min-width: 1080px;
  th, td { padding: 6px 8px; border-bottom: 1px solid var(--border-2); font-size: 12.5px; text-align: left; vertical-align: middle; }
  th { background: var(--bg-2, #f6f8fa); color: var(--text-3); font-weight: 500; white-space: nowrap; }
  tbody tr.low { background: color-mix(in srgb, #f59e0b 7%, white); }
  tbody tr.invalid { background: color-mix(in srgb, #ef4444 7%, white); }
}
.dim { color: var(--text-3); white-space: nowrap; }
.source-cell { font-size: 11.5px; max-width: 110px; overflow: hidden; text-overflow: ellipsis; }
.issue-tag { width: 18px; height: 18px; padding: 0; margin-left: 4px; line-height: 17px; text-align: center; cursor: help; }
</style>
