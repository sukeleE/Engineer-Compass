// 资源预约·表格导入解析（xlsx/xls/csv → 与 bulk 入参同构的 raw 行）
// 与 BOM 识别的关键差异：这里只做「表格 → 行」映射，**不做 normResourceBody 校验**——
// 校验/事务/重名全部留给 POST .../bulk，保证预览表格行号与 bulk「第 N 行」错误完全一致。
// 因此坏数字（空容量、"abc"库存）原样透传，绝不静默兜底成默认值。
import * as XLSX from 'xlsx';
import { parseCsvText, decodeCsvBuffer } from './csvText.js';

export const BOOKING_IMPORT_MAX = 200;
export const BOOKING_IMPORT_LIMIT_BYTES = 10 * 1024 * 1024;

export class BookingImportError extends Error {}

const cellText = (v) => (v === null || v === undefined ? '' : String(v).trim());

// 表头别名（有序：先精确等值，再 includes 包含）
const HEAD_ALIASES = {
  name: ['名称', '资源名称', '物品名称', '空间名称', '资源名', '物品', '空间'],
  approve: ['审批方式', '预约方式', '审批模式'],
  space: {
    location: ['位置', '房间号', '教室', '地点'],
    capacity: ['容量', '可容纳人数', '容纳人数', '人数'],
    equipment: ['室内设备', '设备清单', '设备'],
  },
  item: {
    spec: ['规格型号', '规格', '型号'],
    quantity: ['库存数量', '库存', '数量'],
    unit: ['单位'],
    location: ['存放位置', '位置', '房间号', '地点'],
  },
};

const matchHead = (text, aliases) => {
  if (!text) return false;
  if (aliases.some((a) => text === a)) return true;
  return aliases.some((a) => text.includes(a));
};

// 在前若干行里打分找表头：名称列必须命中（权重 10），其余每命中一列 +1；同分取靠上的行
function findHeader(kind, rows) {
  const fieldAliases = kind === 'space' ? HEAD_ALIASES.space : HEAD_ALIASES.item;
  let best = null; // { row, score, cols: {name, ...fields, approve} }
  const limit = Math.min(5, rows.length);
  for (let i = 0; i < limit; i++) {
    const r = rows[i];
    const pick = (aliases) => {
      const k = r.findIndex((c) => c && matchHead(c, aliases));
      return k < 0 ? null : k;
    };
    const name = pick(HEAD_ALIASES.name);
    if (name === null) continue;
    const cols = { name };
    let score = 10;
    for (const [key, aliases] of Object.entries(fieldAliases)) {
      let k = pick(aliases);
      if (k === name) k = null; // 名称列不兼任
      if (k !== null) { cols[key] = k; score += 1; }
    }
    let approve = pick(HEAD_ALIASES.approve);
    if (approve === name) approve = null;
    if (approve !== null) { cols.approve = approve; score += 1; }
    if (!best || score > best.score) best = { row: i, score, cols };
  }
  return best;
}

const isTotalRow = (s) => /(合计|总计|小计|共计)/.test(s);

// 审批方式文本 → 'first_come' | 'approval' | ''（空回落项目默认；无法辨认也置空，交 bulk）
function normApprove(text, badRows, dataRowNo) {
  const s = cellText(text);
  if (!s) return '';
  if (/先到先得|免审|自动确认/.test(s)) return 'first_come';
  if (/审批/.test(s)) return 'approval';
  badRows.add(dataRowNo);
  return '';
}

// 室内设备/设备清单文本 → 数组（分隔符比手填表单更宽容；长度/项数不校验，交 bulk）
function splitEquipment(v) {
  return String(v ?? '').split(/[,，、;；/／\n\r]+/).map((s) => s.trim()).filter(Boolean);
}

export function parseBookingAoa(kind, aoa) {
  const warnings = [];
  const rows = (aoa || []).map((r) => (Array.isArray(r) ? r.map(cellText) : []))
    .filter((r) => r.some((c) => c !== ''));
  if (!rows.length) throw new BookingImportError('表格里没有读到内容，请按模板填写后重试');

  const head = findHeader(kind, rows);
  if (!head) {
    throw new BookingImportError('未识别到表头（需包含「名称」列），请下载模板按格式整理后重试');
  }
  const { row: headIdx, cols } = head;
  const headLabels = Object.entries(cols)
    .map(([k, ci]) => ({ k, t: rows[headIdx][ci] }))
    .filter((x) => x.t);
  const labelOf = (k) => headLabels.find((x) => x.k === k)?.t || '';
  warnings.push(`已识别表头（第 ${headIdx + 1} 行）：${headLabels.map((x) => x.t).join('、')}`);

  const items = [];
  let skipped = 0;
  const badApproveRows = new Set();
  let truncated = 0;

  for (let i = headIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const dataRowNo = i - headIdx; // 预览/ bulk 行号（表头不算）
    const name = cellText(r[cols.name]);
    if (!name || isTotalRow(name)) { skipped += 1; continue; }
    // 序号/分页残留行（名称列是纯数字且整行只有这一格）
    if (/^\d+$/.test(name) && r.filter((c) => c !== '').length <= 1) { skipped += 1; continue; }

    const base = { kind, name, location: '' };
    if (kind === 'space') {
      base.location = cols.location !== undefined ? cellText(r[cols.location]).slice(0, 60) : '';
      // 数字原样保留（number 或数字字符串）；空/坏值原样透传给 bulk 报「第 N 行」
      base.capacity = cols.capacity !== undefined ? r[cols.capacity] ?? '' : '';
      base.equipment = cols.equipment !== undefined ? splitEquipment(r[cols.equipment]) : [];
    } else {
      base.spec = cols.spec !== undefined ? cellText(r[cols.spec]).slice(0, 40) : '';
      base.quantity = cols.quantity !== undefined ? r[cols.quantity] ?? '' : '';
      base.unit = cols.unit !== undefined ? cellText(r[cols.unit]).slice(0, 8) : '';
      base.location = cols.location !== undefined ? cellText(r[cols.location]).slice(0, 60) : '';
    }
    base.approve_mode = cols.approve !== undefined
      ? normApprove(r[cols.approve], badApproveRows, dataRowNo) : '';

    if (items.length >= BOOKING_IMPORT_MAX) { truncated += 1; continue; }
    items.push(base);
  }

  if (skipped) warnings.push(`已跳过 ${skipped} 行空行/合计/序号行`);
  if (badApproveRows.size) {
    warnings.push(`第 ${[...badApproveRows].sort((a, b) => a - b).join('、')} 行审批方式无法辨认，已留空（导入时用项目默认）`);
  }
  if (truncated) warnings.push(`最多导入 ${BOOKING_IMPORT_MAX} 条，已截断后续 ${truncated} 行`);
  if (!items.length) warnings.push('表头下没有有效数据行');
  return { items, warnings };
}

export function recognizeBookingXlsx(kind, buf) {
  let wb;
  try {
    wb = XLSX.read(buf, { type: 'buffer' });
  } catch (e) {
    throw new BookingImportError(`Excel 解析失败：${String(e?.message || e).slice(0, 100)}，请确认文件未损坏或另存为 .xlsx/.csv`);
  }
  const sn = wb.SheetNames?.[0];
  if (!sn) throw new BookingImportError('Excel 里没有工作表');
  const ws = wb.Sheets[sn];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
  const { items, warnings } = parseBookingAoa(kind, aoa);
  return { items, warnings: [`工作表「${sn}」`, ...warnings], source: 'xlsx' };
}

export function recognizeBookingCsv(kind, buf) {
  const { items, warnings } = parseBookingAoa(kind, parseCsvText(decodeCsvBuffer(buf)));
  return { items, warnings: ['CSV 文件（编码自动识别）', ...warnings], source: 'csv' };
}

// ---------------- 导入模板（仅表头，无示例行——示例行会被原样导成垃圾资源） ----------------
const TEMPLATE = {
  space: {
    sheet: '空间资源',
    head: ['名称', '位置', '容量', '室内设备（多个用逗号或顿号分隔）', '审批方式（需审批/先到先得，留空用项目默认）'],
    widths: [22, 18, 10, 34, 36],
  },
  item: {
    sheet: '物品资源',
    head: ['名称', '规格型号', '库存', '单位', '位置', '审批方式（需审批/先到先得，留空用项目默认）'],
    widths: [22, 20, 8, 8, 18, 36],
  },
  mixed: {
    sheet: '混合资源',
    head: ['资源类型（物品/空间）', '资源名称', '规格型号（物品）', '库存数量（物品）', '单位（物品）', '位置/房间号', '可容纳人数（空间）', '室内设备（多个用逗号或顿号分隔）', '审批方式（需审批/先到先得，留空用项目默认）'],
    widths: [20, 20, 18, 14, 10, 20, 16, 34, 36],
  },
};

export function buildBookingTemplate(kind) {
  const t = TEMPLATE[kind];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([t.head]);
  ws['!cols'] = t.widths.map((w) => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, TEMPLATE[kind].sheet || '资源导入');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
