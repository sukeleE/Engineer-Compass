<template>
  <el-dialog :model-value="modelValue" @close="emit('close')" title="导入资源" width="1040px" append-to-body destroy-on-close>
    <div v-loading="parsing || saving" element-loading-text="正在识别表格，请稍候…">
      <div class="ri-actions">
        <el-dropdown trigger="click" @command="downloadTpl">
          <el-button size="small" plain :loading="tplLoading">⬇️ 下载模板 ▾</el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="mixed">混合资源模板（推荐）</el-dropdown-item>
              <el-dropdown-item command="item">仅物品资源模板</el-dropdown-item>
              <el-dropdown-item command="space">仅空间资源模板</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button v-if="rows.length" size="small" type="primary" plain :loading="parsing" @click="pickFile">
          📂 重新选择表格
        </el-button>
        <span v-if="fileName" class="ri-file">
          已选：{{ fileName }}
          <template v-if="stats">（物品 {{ stats.item }} / 空间 {{ stats.space }}，{{ effectiveCount }} 条可导入）</template>
        </span>
      </div>

      <div v-if="!rows.length" class="ri-upload-panel">
        <div class="ri-dropzone" :class="{ dragover: dragOver }" @click="pickFile"
          @dragover.prevent="dragOver = true" @dragleave.prevent="dragOver = false" @drop.prevent="onDrop">
          <div class="ri-drop-icon">📂</div>
          <b>点击选择表格，或将表格拖到这里</b>
          <p>支持 .xlsx / .xls / .csv，单次最多 200 条，文件不超过 10MB</p>
          <p class="dim">物品和空间可以放在同一张表，也可以分在不同工作表</p>
        </div>
        <el-checkbox v-model="autoImport" class="ri-auto-check">标准表格识别无误后自动导入</el-checkbox>
        <p class="ri-tip">
          系统会先按标准格式解析；标准表格不调用 AI。遇到字段名不统一、物品/空间混排、多 Sheet 或分段表格时，才会自动使用 AI 整理，并在导入前展示预览。
        </p>
        <input ref="fileInput" type="file" accept=".xlsx,.xls,.csv" hidden @change="onFile" />
      </div>

      <template v-else>
        <el-alert class="ri-stat" :type="parseAlertType" :closable="false" show-icon :title="parseAlertTitle" />
        <el-alert v-if="warnings.length" class="ri-warn" type="warning" :closable="false" show-icon
          title="表格解析结果，请核对后再导入">
          <ul class="ri-warn-list">
            <li v-for="(w, i) in warnings" :key="i">{{ w }}</li>
          </ul>
        </el-alert>

        <div class="ri-preview-head">
          <p class="ri-tip">
            每行一条资源；红色行需要修正，黄色行表示 AI 置信度较低。可直接修改类型、库存、容量、审批方式等字段。
          </p>
          <el-button size="small" plain @click="addRow">＋ 添加一行</el-button>
        </div>

        <div class="ri-table-wrap">
          <table class="ri-table">
            <thead>
              <tr>
                <th style="width: 42px">#</th>
                <th style="width: 104px">类型*</th>
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
                <td>
                  <el-select v-model="row.kind" size="small" style="width: 92px">
                    <el-option value="item" label="📦 物品" />
                    <el-option value="space" label="🏢 空间" />
                  </el-select>
                </td>
                <td>
                  <el-input v-model="row.name" size="small" placeholder="资源名称" />
                  <el-tag v-for="(issue, ii) in row.issues" :key="ii" size="small" type="danger" effect="plain"
                    class="issue-tag" :title="issue">!</el-tag>
                </td>
                <td><el-input v-model="row.spec" size="small" placeholder="物品规格" :disabled="row.kind === 'space'" /></td>
                <td><el-input-number v-model="row.quantity" :min="1" :max="9999" size="small" controls-position="right"
                  style="width: 96px" :disabled="row.kind === 'space'" /></td>
                <td><el-input v-model="row.unit" size="small" maxlength="8" placeholder="件" :disabled="row.kind === 'space'" /></td>
                <td><el-input v-model="row.location" size="small" placeholder="存放位置/房间号" /></td>
                <td><el-input-number v-model="row.capacity" :min="1" :max="9999" size="small" controls-position="right"
                  style="width: 96px" :disabled="row.kind === 'item'" /></td>
                <td><el-input v-model="row.equipment_text" size="small" placeholder="投影、白板…"
                  :disabled="row.kind === 'item'" /></td>
                <td>
                  <el-select v-model="row.approve_mode" size="small" clearable placeholder="项目默认" style="width: 104px">
                    <el-option value="approval" label="需审批" />
                    <el-option value="first_come" label="先到先得" />
                    <el-option value="" label="项目默认" />
                  </el-select>
                </td>
                <td class="source-cell dim" :title="`${row._sheet || ''} 第 ${row._row || ''} 行`">
                  <template v-if="row._sheet">{{ row._sheet }} / 第{{ row._row }}行</template>
                  <template v-else>手动</template>
                </td>
                <td><el-button link type="danger" size="small" @click="rows.splice(i, 1)">删</el-button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <input v-if="rows.length" ref="fileInput" type="file" accept=".xlsx,.xls,.csv" hidden @change="onFile" />
    </div>

    <template #footer>
      <el-button @click="emit('close')">取消</el-button>
      <el-button v-if="rows.length" type="primary" :loading="saving" :disabled="parsing" @click="submit">
        确认导入 {{ effectiveCount }} 条
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../../api.js';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  project: { type: Object, required: true },
  existingNames: { type: Array, default: () => [] },
});
const emit = defineEmits(['close', 'saved']);

const fileInput = ref(null);
const rows = ref([]);
const warnings = ref([]);
const stats = ref(null);
const fileName = ref('');
const parsing = ref(false);
const saving = ref(false);
const tplLoading = ref(false);
const dragOver = ref(false);
const autoImport = ref(true);
const parseInfo = ref({ strategy: '', aiUsed: false, canAuto: false });

const STRATEGY_ZH = {
  standard_item: '标准物品资源表',
  standard_space: '标准空间资源表',
  standard_mixed: '标准混合资源表',
  ai: 'AI 智能识别',
  rules_fallback: '规则兜底识别',
};

const effectiveCount = computed(() => rows.value.filter((r) => String(r.name || '').trim()).length);
const parseAlertType = computed(() => {
  if (parseInfo.value.aiUsed) return stats.value?.invalid ? 'warning' : 'info';
  if (stats.value?.invalid || stats.value?.skipped || stats.value?.low_confidence) return 'warning';
  return 'success';
});
const parseAlertTitle = computed(() => {
  const name = STRATEGY_ZH[parseInfo.value.strategy] || '表格';
  const base = `${name}：物品 ${stats.value?.item || 0} 条，空间 ${stats.value?.space || 0} 条，异常 ${stats.value?.invalid || 0} 条，跳过 ${stats.value?.skipped || 0} 行，低置信度 ${stats.value?.low_confidence || 0} 条`;
  if (parseInfo.value.aiUsed) return `非标准格式已由 AI 整理，请核对后导入。${base}`;
  if (stats.value?.invalid) return `标准表格已解析，但有 ${stats.value.invalid} 行需要修正。${base}`;
  if (parseInfo.value.strategy === 'rules_fallback') return `AI 暂不可用，已使用规则兜底，请核对后导入。${base}`;
  return `${base}`;
});

watch(() => props.modelValue, (open) => {
  if (open) resetState();
});
watch(rows, () => validatePreview(), { deep: true });

function resetState() {
  rows.value = [];
  warnings.value = [];
  stats.value = null;
  fileName.value = '';
  parsing.value = false;
  saving.value = false;
  dragOver.value = false;
  autoImport.value = true;
  parseInfo.value = { strategy: '', aiUsed: false, canAuto: false };
}
function blankRow(kind = 'item') {
  return {
    kind, name: '', spec: '', quantity: 1, unit: '', location: '', capacity: 1,
    equipment_text: '', approve_mode: '', confidence: 'high', issues: [], _sheet: '', _row: null,
  };
}
function addRow() {
  if (rows.value.length >= 200) return ElMessage.warning('一次最多导入 200 条');
  rows.value.push(blankRow('item'));
}
function toCommonRow(it) {
  return {
    kind: it.kind === 'space' ? 'space' : 'item',
    name: it.name || '',
    spec: it.spec || '',
    quantity: it.quantity ?? '',
    unit: it.unit || '',
    location: it.location || '',
    capacity: it.capacity ?? '',
    equipment_text: Array.isArray(it.equipment) ? it.equipment.join('，') : (it.equipment_text || ''),
    approve_mode: it.approve_mode || '',
    confidence: it.confidence || 'high',
    issues: Array.isArray(it.issues) ? [...it.issues] : [],
    _sheet: it._sheet || '',
    _row: it._row || null,
  };
}
function pickFile() { fileInput.value?.click(); }
function onFile(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (file) handleFile(file);
}
function onDrop(e) {
  dragOver.value = false;
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFile(file);
}
async function handleFile(file) {
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (!['xlsx', 'xls', 'csv'].includes(ext)) return ElMessage.warning('仅支持 .xlsx / .xls / .csv 表格文件');
  if (file.size > 10 * 1024 * 1024) return ElMessage.warning('文件不能超过 10MB');

  parsing.value = true;
  try {
    const d = await api.bookingResourceAutoParseImport(props.project.id, file);
    fileName.value = file.name;
    stats.value = d.stats || null;
    warnings.value = Array.isArray(d.warnings) ? d.warnings : [];
    parseInfo.value = { strategy: d.strategy || d.source || '', aiUsed: Boolean(d.ai_used), canAuto: Boolean(d.can_auto_import) };
    rows.value = (d.items || []).map(toCommonRow);

    if (!rows.value.length) {
      resetState();
      fileName.value = file.name;
      return ElMessage.warning('表格里没有识别出有效资源行，请核对后重试');
    }
    if (d.can_auto_import && autoImport.value) {
      try {
        await bulkItems(buildPayload(rows.value));
      } catch (bulkError) {
        ElMessage.error(bulkError.message || '自动导入失败，请核对后手动确认导入');
      }
      return;
    }
    if (d.stats?.invalid) ElMessage.warning(`有 ${d.stats.invalid} 行需要修正，请查看红色感叹号`);
  } catch (err) {
    rows.value = [];
    ElMessage.error(err.message || '表格识别失败');
  } finally {
    parsing.value = false;
  }
}
function validatePreview() {
  const named = rows.value.filter((r) => String(r.name || '').trim());
  const seen = new Set();
  let errorCount = 0;
  named.forEach((r) => {
    r.issues = [];
    const name = String(r.name || '').trim();
    if (name.length > 30) r.issues.push('资源名称不能超过 30 字');
    if (seen.has(name)) r.issues.push('表格内存在同名资源');
    seen.add(name);
    if (props.existingNames.some((x) => String(x || '').trim() === name)) r.issues.push('项目内已存在同名资源');
    if (r.kind === 'space') {
      if (!Number.isInteger(Number(r.capacity)) || Number(r.capacity) < 1 || Number(r.capacity) > 9999) r.issues.push('空间容量须为 1–9999 的整数');
    } else if (!Number.isInteger(Number(r.quantity)) || Number(r.quantity) < 1 || Number(r.quantity) > 9999) {
      r.issues.push('物品库存须为 1–9999 的整数');
    }
    if (r.issues.length) errorCount++;
  });
  return errorCount;
}
function buildPayload(list) {
  return list.map((r) => {
    const base = {
      kind: r.kind === 'space' ? 'space' : 'item',
      name: String(r.name || '').trim(),
      location: String(r.location || '').trim(),
      approve_mode: r.approve_mode || props.project.default_approve_mode || 'approval',
    };
    if (base.kind === 'space') {
      base.capacity = Number(r.capacity);
      base.equipment = String(r.equipment_text || '').split(/[,，、;；\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 20);
    } else {
      base.spec = String(r.spec || '').trim();
      base.quantity = Number(r.quantity);
      base.unit = String(r.unit || '').trim();
    }
    return base;
  });
}
async function bulkItems(items) {
  saving.value = true;
  try {
    const d = await api.bookingResourceBulk(props.project.id, items);
    ElMessage.success(d.message || `已导入 ${items.length} 条资源`);
    emit('saved');
  } finally {
    saving.value = false;
  }
}
async function submit() {
  const named = rows.value.filter((r) => String(r.name || '').trim());
  if (!named.length) return ElMessage.warning('请至少填写一行有效数据');
  const errors = validatePreview();
  if (errors) return ElMessage.error(`有 ${errors} 行信息不正确，请修正红色感叹号后再导入`);
  try {
    await bulkItems(buildPayload(named));
  } catch (e) {
    ElMessage.error(e.message);
  }
}
async function downloadTpl(kind = 'mixed') {
  tplLoading.value = true;
  try {
    const { blob, name } = await api.bookingResourceTemplateBlob(props.project.id, kind);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
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
</script>

<style lang="scss" scoped>
.ri-actions { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
.ri-file { font-size: 12.5px; color: var(--text-3); }
.ri-upload-panel { max-width: 760px; margin: 0 auto; padding: 10px 0 4px; }
.ri-dropzone {
  border: 1.5px dashed var(--border-2, #c8d0dc);
  border-radius: 14px;
  padding: 38px 24px;
  text-align: center;
  cursor: pointer;
  background: var(--bg-2, #f8fafc);
  transition: all .18s ease;
  b { display: block; margin: 10px 0 6px; font-size: 15px; }
  p { margin: 4px 0; font-size: 12.5px; }
  &:hover, &.dragover { border-color: var(--el-color-primary, #409eff); background: color-mix(in srgb, #409eff 6%, white); }
}
.ri-drop-icon { font-size: 42px; line-height: 1; }
.ri-auto-check { display: block; margin: 12px 0 6px; }
.ri-stat, .ri-warn { margin-bottom: 8px; }
.ri-warn-list { margin: 4px 0 0; padding-left: 18px; font-size: 12.5px; line-height: 1.7; }
.ri-preview-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ri-tip { font-size: 12.5px; color: var(--text-3); margin: 4px 0 10px; }
.dim { color: var(--text-3); }
.ri-table-wrap { overflow-x: auto; border: 1px solid var(--border-2); border-radius: 8px; }
.ri-table {
  width: 100%; border-collapse: collapse; min-width: 1080px;
  th, td { padding: 6px 8px; border-bottom: 1px solid var(--border-2); font-size: 12.5px; text-align: left; vertical-align: middle; }
  th { background: var(--bg-2, #f6f8fa); color: var(--text-3); font-weight: 500; white-space: nowrap; }
  tbody tr.low { background: color-mix(in srgb, #f59e0b 7%, white); }
  tbody tr.invalid { background: color-mix(in srgb, #ef4444 7%, white); }
}
.source-cell { font-size: 11.5px; max-width: 110px; overflow: hidden; text-overflow: ellipsis; }
.issue-tag { width: 18px; height: 18px; padding: 0; margin-left: 4px; line-height: 17px; text-align: center; cursor: help; }
</style>
