<template>
  <el-dialog :model-value="modelValue" @close="emit('close')" title="导入资源" width="1180px" append-to-body destroy-on-close>
    <div v-loading="parsing || saving" element-loading-text="正在识别表格，大文件可能需要几十秒…">
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
          <template v-if="stats">（物品 {{ stats.item }} / 空间 {{ stats.space }}，{{ effectiveCount }} 条可导入 / {{ groupCount }} 个分组）</template>
        </span>
      </div>

      <div v-if="!rows.length" class="ri-upload-panel">
        <div class="ri-dropzone" :class="{ dragover: dragOver }" @click="pickFile"
          @dragover.prevent="dragOver = true" @dragleave.prevent="dragOver = false" @drop.prevent="onDrop">
          <div class="ri-drop-icon">📂</div>
          <b>点击选择表格，或将表格拖到这里</b>
          <p>支持 .xlsx / .xls / .csv，单次最多 2000 条，文件不超过 100MB</p>
          <p class="dim">一个 Excel 可含多个工作表（如每个房间一张表），导入后按工作表分组展示，结构与原表一致</p>
        </div>
        <el-checkbox v-model="autoImport" class="ri-auto-check">标准表格识别无误后自动导入</el-checkbox>
        <p class="ri-tip">
          系统会先按标准格式解析；标准表格不调用 AI。遇到字段名不统一、物品/空间混排、多 Sheet 或分段表格时，才会自动使用 AI 整理，并在导入前展示预览。
          「资产编号」按台件登记的明细行会自动跳过，避免与汇总行重复计数。
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
            顶部标签切换工作表（每个标签=一个分组），可整组取消勾选或就地修改组名；红色行需要修正，黄色行表示 AI 置信度较低。可直接修改类型、库存、容量、审批方式等字段。
          </p>
          <el-button size="small" plain @click="addRow">＋ 添加一行</el-button>
        </div>

        <div class="ri-tabs">
          <button v-for="(g, idx) in groupView" :key="g.key" type="button" class="ri-tab"
            :class="{ active: idx === activeIndex, excluded: g.excluded }" :title="g.name"
            @click="activeIndex = idx">
            <span class="ri-tab-name">{{ g.name }}</span>
            <span class="ri-tab-badge">{{ g.list.length }}</span>
            <span v-if="g.invalid" class="ri-tab-dot" :title="`异常 ${g.invalid} 行`"></span>
          </button>
        </div>
        <section v-if="activeGroup" :key="activeGroup.key" class="ri-group" :class="{ excluded: activeGroup.excluded }">
          <header class="ri-group-head">
            <el-checkbox :model-value="!activeGroup.excluded" @change="(v) => toggleGroup(activeGroup, v)" />
            <el-input v-model="activeGroup.name" size="small" class="ri-gname-input" @change="renameGroup(activeGroup)" />
            <span class="ri-gmeta">
              {{ activeGroup.list.length }} 条
              <template v-if="activeGroup.invalid"> · <b class="ri-danger-text">异常 {{ activeGroup.invalid }}</b></template>
              <template v-if="activeGroup.skipped"> · 跳过明细 {{ activeGroup.skipped }}</template>
            </span>
          </header>
          <div v-if="activeGroup.list.length" class="ri-table-wrap">
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
                <tr v-for="row in activeGroup.list" :key="row._uid" :class="{ invalid: row.issues?.length, low: row.confidence === 'low' }">
                  <td class="dim">{{ rowIndexMap[row._uid] + 1 }}</td>
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
                  <td><el-button link type="danger" size="small" @click="removeRow(row)">删</el-button></td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="ri-group-empty dim">该工作表无有效资源行（空表或明细均被跳过），仍可改名或整组排除。</p>
        </section>
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

const IMPORT_MAX = 2000;
const fileInput = ref(null);
const rows = ref([]);
const groupMeta = ref([]); // 服务端分组摘要（含空分组/跳过数），name 可就地编辑
const warnings = ref([]);
const stats = ref(null);
const fileName = ref('');
const parsing = ref(false);
const saving = ref(false);
const tplLoading = ref(false);
const dragOver = ref(false);
const autoImport = ref(true);
const parseInfo = ref({ strategy: '', aiUsed: false, canAuto: false });
let uidSeq = 0;
const activeIndex = ref(0); // 当前查看的分组（按索引追踪，组改名不影响）

const STRATEGY_ZH = {
  standard_item: '标准物品资源表',
  standard_space: '标准空间资源表',
  standard_mixed: '标准混合资源表',
  ai: 'AI 智能识别',
  rules_fallback: '规则兜底识别',
};

const includedRows = computed(() => rows.value.filter((r) => !groupOf(r.group_name)?.excluded));
const effectiveCount = computed(() => includedRows.value.filter((r) => String(r.name || '').trim()).length);
const groupCount = computed(() => groupView.value.filter((g) => !g.excluded && g.list.length).length);
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
  return base;
});

// 分组视图：服务端摘要 + 行数据合并（手动新增的未分组行也会形成「未分组」）
const groupView = computed(() => {
  const map = new Map();
  for (const g of groupMeta.value) {
    map.set(g.name, {
      key: 'g' + g.sheet_index + ':' + g.name, name: g.name, origName: g.name,
      excluded: !!g.excluded, open: true, skipped: g.skipped || 0, invalid: 0, list: [],
    });
  }
  for (const r of rows.value) {
    const gn = r.group_name || '';
    if (!map.has(gn)) {
      map.set(gn, {
        key: 'manual:' + (gn || 'empty'), name: gn || '未分组', origName: gn,
        excluded: false, open: true, skipped: 0, invalid: 0, list: [],
      });
    }
    map.get(gn).list.push(r);
  }
  const out = [...map.values()];
  for (const g of out) g.invalid = g.list.filter((r) => r.issues?.length).length;
  return out;
});
// 标签页只渲染当前组；索引钳制，删组/删行后不会越界
const activeGroup = computed(() => groupView.value[Math.min(activeIndex.value, groupView.value.length - 1)] || null);
watch(() => groupView.value.length, (n) => {
  if (activeIndex.value > n - 1) activeIndex.value = Math.max(0, n - 1);
});
const rowIndexMap = computed(() => {
  const m = {};
  rows.value.forEach((r, i) => { m[r._uid] = i; });
  return m;
});
function groupOf(name) {
  return groupView.value.find((g) => g.origName === (name || ''));
}

watch(() => props.modelValue, (open) => {
  if (open) resetState();
});
watch(rows, () => validatePreview(), { deep: true });

function resetState() {
  rows.value = [];
  groupMeta.value = [];
  warnings.value = [];
  stats.value = null;
  fileName.value = '';
  parsing.value = false;
  saving.value = false;
  dragOver.value = false;
  autoImport.value = true;
  parseInfo.value = { strategy: '', aiUsed: false, canAuto: false };
  activeIndex.value = 0;
}
function blankRow(kind = 'item', groupName = '') {
  return {
    _uid: ++uidSeq,
    kind, name: '', spec: '', quantity: 1, unit: '', location: '', capacity: 1,
    equipment_text: '', approve_mode: '', confidence: 'high', issues: [],
    group_name: groupName, _sheet: '', _row: null,
  };
}
function addRow() {
  if (rows.value.length >= IMPORT_MAX) return ElMessage.warning(`一次最多导入 ${IMPORT_MAX} 条`);
  // 加到当前查看的分组（origName 是规范 group_name，'未分组' 对应空串）
  const groupName = activeGroup.value ? activeGroup.value.origName : '';
  rows.value.push(blankRow('item', groupName));
}
function removeRow(row) {
  const i = rows.value.findIndex((r) => r._uid === row._uid);
  if (i >= 0) rows.value.splice(i, 1);
}
function toCommonRow(it) {
  return {
    _uid: ++uidSeq,
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
    group_name: it.group_name ?? it._sheet ?? '',
    _sheet: it._sheet || '',
    _row: it._row || null,
  };
}
function toggleGroup(g, included) {
  const meta = groupMeta.value.find((m) => m.name === g.origName);
  g.excluded = !included;
  if (meta) meta.excluded = g.excluded;
}
function renameGroup(g) {
  const next = String(g.name || '').trim().slice(0, 30);
  const prev = g.origName;
  if (!next || next === prev) { g.name = prev || '未分组'; return; }
  // 目标组已存在则拒绝并还原，避免组内同名冲突
  if (groupView.value.some((x) => x !== g && x.origName === next)) {
    ElMessage.warning(`已存在分组「${next}」，请换一个组名`);
    g.name = prev || '未分组';
    return;
  }
  for (const r of rows.value) {
    if ((r.group_name || '') === prev) r.group_name = next;
  }
  const meta = groupMeta.value.find((m) => m.name === prev);
  if (meta) meta.name = next;
  g.origName = next;
  g.key = 'g:' + next + ':' + uidSeq++;
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
  if (file.size > 100 * 1024 * 1024) return ElMessage.warning('文件不能超过 100MB');

  parsing.value = true;
  try {
    const d = await api.bookingResourceAutoParseImport(props.project.id, file);
    fileName.value = file.name;
    stats.value = d.stats || null;
    warnings.value = Array.isArray(d.warnings) ? d.warnings : [];
    parseInfo.value = { strategy: d.strategy || d.source || '', aiUsed: Boolean(d.ai_used), canAuto: Boolean(d.can_auto_import) };
    groupMeta.value = Array.isArray(d.groups) ? d.groups.map((g) => ({ ...g, excluded: false })) : [];
    rows.value = (d.items || []).map(toCommonRow);
    activeIndex.value = 0;

    if (!rows.value.length) {
      resetState();
      fileName.value = file.name;
      return ElMessage.warning('表格里没有识别出有效资源行，请核对后重试');
    }
    if (d.can_auto_import && autoImport.value) {
      try {
        await bulkItems(buildPayload(includedRows.value));
      } catch (bulkError) {
        ElMessage.error(bulkError.message || '自动导入失败，请核对后手动确认导入');
      }
      return;
    }
    if (d.stats?.invalid) ElMessage.warning(`有 ${d.stats.invalid} 行需要修正，请查看红色感叹号`);
  } catch (err) {
    rows.value = [];
    groupMeta.value = [];
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
    const next = [];
    const name = String(r.name || '').trim();
    if (name.length > 30) next.push('资源名称不能超过 30 字');
    const key = (r.group_name || '') + '\u0000' + name;
    if (seen.has(key)) next.push('同组内存在同名资源');
    seen.add(key);
    if (r.kind === 'space') {
      if (!Number.isInteger(Number(r.capacity)) || Number(r.capacity) < 1 || Number(r.capacity) > 9999) next.push('空间容量须为 1–9999 的整数');
    } else if (!Number.isInteger(Number(r.quantity)) || Number(r.quantity) < 1 || Number(r.quantity) > 9999) {
      next.push('物品库存须为 1–9999 的整数');
    }
    // 仅在结果变化时回写，避免 deep watch 自触发造成递归更新
    const prev = Array.isArray(r.issues) ? r.issues : [];
    if (next.length !== prev.length || next.some((x, i) => x !== prev[i])) r.issues = next;
    if (next.length) errorCount++;
  });
  return errorCount;
}
function buildPayload(list) {
  return list.map((r) => {
    const base = {
      kind: r.kind === 'space' ? 'space' : 'item',
      name: String(r.name || '').trim(),
      location: String(r.location || '').trim(),
      group_name: String(r.group_name || '').trim().slice(0, 30),
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
  const named = includedRows.value.filter((r) => String(r.name || '').trim());
  if (!named.length) return ElMessage.warning('请至少填写一行有效数据（或取消整组排除）');
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
.ri-danger-text { color: var(--el-color-danger, #ef4444); }
.ri-tabs { display: flex; gap: 8px; overflow-x: auto; padding: 4px 2px 10px; margin-bottom: 12px; border-bottom: 1px solid var(--border-2, #d8dee8); }
.ri-tab {
  flex: none; display: inline-flex; align-items: center; gap: 6px; max-width: 220px;
  padding: 6px 12px; border-radius: 18px; border: 1px solid var(--border-2, #d8dee8);
  background: var(--bg-2, #f6f8fa); color: var(--text-2, #475569); font-size: 12.5px; cursor: pointer;
}
.ri-tab:hover { border-color: var(--el-color-primary, #409eff); }
.ri-tab.active {
  border-color: var(--el-color-primary, #409eff); color: var(--el-color-primary, #409eff);
  background: color-mix(in srgb, #409eff 8%, white); font-weight: 600;
}
.ri-tab.excluded { opacity: .5; }
.ri-tab.excluded .ri-tab-name { text-decoration: line-through; }
.ri-tab-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 140px; }
.ri-tab-badge { background: rgba(15, 23, 42, .08); border-radius: 10px; padding: 0 7px; font-size: 11px; line-height: 16px; }
.ri-tab.active .ri-tab-badge { background: color-mix(in srgb, #409eff 18%, white); }
.ri-tab-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--el-color-danger, #ef4444); flex: none; }
.ri-group { border: 1px solid var(--border-2, #d8dee8); border-radius: 10px; overflow: hidden; }
.ri-group.excluded { opacity: .55; background: var(--bg-2, #f6f8fa); }
.ri-group-head {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px; background: var(--bg-2, #f6f8fa);
  border-bottom: 1px solid var(--border-2, #d8dee8);
}
.ri-gname-input { width: 260px; }
.ri-gmeta { font-size: 12.5px; color: var(--text-3); margin-right: auto; }
.ri-group-empty { padding: 30px 12px; text-align: center; font-size: 13px; margin: 0; }
.ri-table-wrap { overflow: auto; max-height: 50vh; }
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
