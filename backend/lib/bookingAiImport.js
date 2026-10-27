// 资源预约·AI 混合台账导入（物品 item / 空间 space 可在同一工作簿、同一 Sheet 或分段表格中）
// 安全原则：AI 只做“表头/字段理解 + 行分类 + 归一化建议”，每条结果必须带 sheet/row 且能回溯原表；
// 最终仍由前端预览、后端 normResourceBody + bulk 事务校验，AI 不直接入库、不能创建无来源行。
import * as XLSX from 'xlsx';
import { parseCsvText, decodeCsvBuffer } from './csvText.js';
import { callDeepSeek } from '../routes/ai.js';
import { BookingImportError, BOOKING_IMPORT_MAX } from './bookingImport.js';

const cellText = (v) => (v === null || v === undefined ? '' : String(v).trim());
const clampText = (v, n) => cellText(v).slice(0, n);

export function normalizeKind(v, fallback = '') {
  const s = cellText(v).replace(/[\s\-—_（）()]/g, '');
  if (!s) return fallback;
  if (/^(物品|设备|仪器|工具|物料|器材|资产|item)$/i.test(s) || /物品资源|物料|仪器|工具|器材/.test(s)) return 'item';
  if (/^(空间|场地|教室|房间|会议室|实验室|报告厅|机房|活动室|space)$/i.test(s) || /空间资源|会议室|实验室|教室|场地|报告厅|机房|活动室/.test(s)) return 'space';
  // “设备柜/工具箱”是物品；“xx实验室/会议室/教室”通常是空间
  if (/实验室|会议室|教室|报告厅|场地|活动室|房间$/.test(s)) return 'space';
  if (/设备|仪器|工具|电脑|投影|摄像|器材|物料/.test(s)) return 'item';
  return fallback;
}

export function normalizeApproveText(v) {
  const s = cellText(v);
  if (!s) return '';
  if (/先到先得|免审|自动确认|无需审批|不用审批|否$/i.test(s)) return 'first_come';
  if (/审批|审核|人工确认|需确认|是$/i.test(s)) return 'approval';
  return '';
}

function splitEquipment(v) {
  if (Array.isArray(v)) return v.map((x) => clampText(x, 20)).filter(Boolean).slice(0, 20);
  return String(v ?? '').split(/[,，、;；/／\n\r]+/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
}

// 读取多 Sheet；保留 Excel 原始行号，供预览和错误回溯
export function readBookingSheets(buf, ext) {
  if (ext === 'csv') {
    const aoa = parseCsvText(decodeCsvBuffer(buf));
    return [{ name: 'CSV', aoa }];
  }
  let wb;
  try {
    wb = XLSX.read(buf, { type: 'buffer' });
  } catch (e) {
    throw new BookingImportError(`Excel 解析失败：${String(e?.message || e).slice(0, 100)}，请确认文件未损坏或另存为 .xlsx/.csv`);
  }
  if (!wb.SheetNames?.length) throw new BookingImportError('Excel 里没有工作表');
  return wb.SheetNames.map((name) => ({
    name,
    aoa: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, raw: false, defval: '' }),
  }));
}

const compactSheets = (sheets) => sheets.map((s, si) => ({
  name: s.name || `Sheet${si + 1}`,
  rows: (s.aoa || [])
    .map((cells, i) => ({ r: i + 1, cells: (Array.isArray(cells) ? cells : []).map(cellText) }))
    .filter((row) => row.cells.some(Boolean)),
}));

// ---------------- 规则解析：AI 不可用或标准混合模板时的确定性兜底 ----------------
const MIXED_ALIASES = {
  kind: ['资源类型', '类型', '类别', '分类', '物品/空间'],
  name: ['资源名称', '物品名称', '空间名称', '名称', '资源名', '物品', '空间'],
  approve: ['审批方式', '预约方式', '审批模式'],
  spec: ['规格型号', '规格', '型号'],
  quantity: ['库存数量', '库存', '数量'],
  unit: ['单位'],
  location: ['存放位置', '位置', '房间号', '教室', '地点'],
  capacity: ['可容纳人数', '容纳人数', '容量', '人数'],
  equipment: ['室内设备', '设备清单', '配套设备', '设备'],
};
const FIELD_KEYS = ['kind', 'name', 'approve', 'spec', 'quantity', 'unit', 'location', 'capacity', 'equipment'];

function matchAlias(text, aliases) {
  if (!text) return 0;
  if (aliases.includes(text)) return 2;
  return aliases.some((a) => text.includes(a)) ? 1 : 0;
}

function detectHeader(row) {
  const cells = row.cells;
  const cols = {};
  const used = new Set();
  // 精确匹配优先，避免“设备”同时抢走 equipment/name
  for (const [key, aliases] of Object.entries(MIXED_ALIASES)) {
    let best = -1;
    let bestScore = 0;
    cells.forEach((text, ci) => {
      if (used.has(ci)) return;
      const score = matchAlias(text, aliases);
      if (score > bestScore) { best = ci; bestScore = score; }
    });
    if (best >= 0 && bestScore === 2) { cols[key] = best; used.add(best); }
  }
  for (const [key, aliases] of Object.entries(MIXED_ALIASES)) {
    if (cols[key] !== undefined) continue;
    let best = -1;
    let bestScore = 0;
    cells.forEach((text, ci) => {
      if (used.has(ci)) return;
      const score = matchAlias(text, aliases);
      if (score > bestScore) { best = ci; bestScore = score; }
    });
    if (best >= 0 && bestScore === 1) { cols[key] = best; used.add(best); }
  }

  const nameCi = cols.name;
  if (nameCi === undefined) return null;
  const exactName = ['资源名称', '物品名称', '空间名称', '名称'].includes(cells[nameCi]);
  const fieldCount = Object.keys(cols).filter((k) => k !== 'name').length;
  const score = 10 + fieldCount;
  // 只有一个“物品资源”标题不算表头；标准表头至少再有 1～2 个字段
  if (!exactName && fieldCount < 2) return null;
  return { row: row.r, cols, score };
}

function kindBySheetName(name) {
  return normalizeKind(name, '');
}

function inferKindFromRow(name, vals) {
  const byName = normalizeKind(name, '');
  if (byName) return { kind: byName, confidence: byName === 'space' ? 'medium' : 'medium' };
  if (vals.capacity || vals.equipment) return { kind: 'space', confidence: 'medium' };
  if (vals.spec || vals.quantity || vals.unit) return { kind: 'item', confidence: 'medium' };
  return { kind: 'item', confidence: 'low' };
}

function isSkipRow(name) {
  return !name || /(合计|总计|小计|共计)/.test(name) || (/^\d+$/.test(name) && name.length < 6);
}

function buildRuleItem(kind, source, cols) {
  const name = cellText(source.cells[cols.name]);
  const out = {
    kind,
    name,
    spec: cols.spec !== undefined ? clampText(source.cells[cols.spec], 40) : '',
    quantity: cols.quantity !== undefined ? source.cells[cols.quantity] ?? '' : '',
    unit: cols.unit !== undefined ? clampText(source.cells[cols.unit], 8) : '',
    location: cols.location !== undefined ? clampText(source.cells[cols.location], 60) : '',
    capacity: cols.capacity !== undefined ? source.cells[cols.capacity] ?? '' : '',
    equipment: cols.equipment !== undefined ? splitEquipment(source.cells[cols.equipment]) : [],
    approve_mode: cols.approve !== undefined ? normalizeApproveText(source.cells[cols.approve]) : '',
    _sheet: source.sheetName,
    _sheet_index: source.sheetIndex,
    _row: source.r,
  };
  return out;
}

export function ruleParseMixedSheets(rawSheets, forcedKind = '') {
  const sheets = compactSheets(rawSheets);
  const items = [];
  const skipped = [];
  const warnings = [];
  let truncated = 0;

  for (let si = 0; si < sheets.length; si++) {
    const sheet = sheets[si];
    const headers = sheet.rows.map((row) => ({ ...detectHeader(row), rowObj: row })).filter((h) => h && h.score >= 11)
      .sort((a, b) => a.row - b.row);

    if (headers.length) {
      for (let hi = 0; hi < headers.length; hi++) {
        const h = headers[hi];
        const start = h.row + 1;
        const end = hi + 1 < headers.length ? headers[hi + 1].row : Infinity;
        let sectionKind = forcedKind || kindBySheetName(sheet.name);
        for (let k = sheet.rows.findIndex((x) => x.r === h.row) - 1; k >= 0 && h.row - sheet.rows[k].r <= 3; k--) {
          sectionKind = normalizeKind(sheet.rows[k].cells.join(' '), sectionKind);
        }

        for (const row of sheet.rows.filter((x) => x.r >= start && x.r < end)) {
          const name = cellText(row.cells[h.cols.name]);
          if (isSkipRow(name)) {
            skipped.push({ sheet: sheet.name, sheet_index: si, row: row.r, reason: name ? '合计/序号行' : '空行' });
            continue;
          }
          const vals = {
            spec: cellText(row.cells[h.cols.spec]),
            quantity: cellText(row.cells[h.cols.quantity]),
            unit: cellText(row.cells[h.cols.unit]),
            location: cellText(row.cells[h.cols.location]),
            capacity: cellText(row.cells[h.cols.capacity]),
            equipment: cellText(row.cells[h.cols.equipment]),
          };
          const explicit = h.cols.kind !== undefined ? normalizeKind(row.cells[h.cols.kind], '') : '';
          const inferred = explicit
            ? { kind: explicit, confidence: 'high' }
            : sectionKind
              ? { kind: sectionKind, confidence: explicit || forcedKind || kindBySheetName(sheet.name) ? 'high' : 'medium' }
              : inferKindFromRow(name, vals);
          if (items.length >= BOOKING_IMPORT_MAX) { truncated++; continue; }
          items.push({ ...buildRuleItem(inferred.kind, { ...row, sheetName: sheet.name, sheetIndex: si }, h.cols), confidence: inferred.confidence });
        }
      }
    } else {
      // 无标准表头的弱兜底：AI 不可用时尽量给预览，不静默丢行
      for (const row of sheet.rows) {
        const isFirstRow = row.r === sheet.rows[0].r;
        const headerLike = /名称|类型|类别|分类|数量|库存|容量|位置|地点|房间|地址|审批|规格|型号|设备或房间|在哪里|多少/.test(row.cells.join(' '));
        if (isFirstRow && headerLike) {
          skipped.push({ sheet: sheet.name, sheet_index: si, row: row.r, reason: '表头/字段说明行' });
          continue;
        }

        const candidates = row.cells.filter((x) => x && x.length >= 2 && !/^(名称|类型|备注|说明)$/.test(x) && !/合计|总计/.test(x));
        const name = candidates.find((x) => !/^\d+(\.\d+)?(人|台|件|把|套|个)?$/.test(x)) || '';
        if (isSkipRow(name)) { skipped.push({ sheet: sheet.name, sheet_index: si, row: row.r, reason: '标题/合计/非资源行' }); continue; }
        const numberCell = row.cells.find((x) => /^\d+(\.\d+)?$/.test(x));
        const kind = forcedKind || kindBySheetName(sheet.name) || inferKindFromRow(name, {}).kind;
        if (items.length >= BOOKING_IMPORT_MAX) { truncated++; continue; }
        items.push({
          kind, name, spec: '', quantity: kind === 'item' ? (numberCell || '') : '',
          unit: '', location: kind === 'space' ? name : '', capacity: kind === 'space' ? (numberCell || '') : '',
          equipment: [], approve_mode: '', _sheet: sheet.name, _sheet_index: si, _row: row.r, confidence: 'low',
        });
      }
    }
  }

  if (!items.length) warnings.push('规则解析未识别到有效资源行');
  if (truncated) warnings.push(`最多导入 ${BOOKING_IMPORT_MAX} 条，已截断后续 ${truncated} 行`);
  return { items, skipped, truncated: truncated > 0, warnings: [`已使用规则解析 ${sheets.length} 个工作表`, ...warnings], source: 'rules' };
}


function detectStandardBookingSheets(rawSheets) {
  const sheets = compactSheets(rawSheets);
  const profiles = new Array(sheets.length).fill(null);
  let nonEmpty = 0;

  for (let si = 0; si < sheets.length; si++) {
    const sheet = sheets[si];
    if (!sheet.rows.length) continue;
    nonEmpty++;

    const first = sheet.rows[0];
    const h = detectHeader(first);
    if (!h || h.row !== first.r) return null;
    const has = (key) => h.cols[key] !== undefined;

    let kind = '';
    if (has('kind')) {
      // 标准混合表：每一行的类型都必须能明确归一化；模糊类型交给 AI 理解。
      for (const row of sheet.rows.slice(1)) {
        const name = cellText(row.cells[h.cols.name]);
        if (!name || isSkipRow(name)) continue;
        if (!normalizeKind(row.cells[h.cols.kind], '')) return null;
      }
      kind = 'mixed';
    } else {
      const sheetKind = kindBySheetName(sheet.name);
      const hasQuantity = has('quantity');
      const hasCapacity = has('capacity');
      if (hasQuantity && hasCapacity) {
        if (!sheetKind) return null; // 同表同时有库存和容量但无类型列，属于歧义/非标表
        kind = sheetKind;
      } else if (hasQuantity) {
        kind = 'item';
      } else if (hasCapacity) {
        kind = 'space';
      } else if (sheetKind) {
        kind = sheetKind;
      } else {
        return null;
      }
      if (kind === 'item' && !hasQuantity) return null;
      if (kind === 'space' && !hasCapacity) return null;
    }

    const hasNamedData = sheet.rows.slice(1).some((row) => {
      const name = cellText(row.cells[h.cols.name]);
      return name && !isSkipRow(name);
    });
    if (!hasNamedData) return null;
    profiles[si] = { kind };
  }

  if (!nonEmpty) return null;
  const used = profiles.filter(Boolean).map((x) => x.kind);
  const hasMixed = used.includes('mixed');
  const hasItem = used.includes('item');
  const hasSpace = used.includes('space');
  const strategy = hasMixed || (hasItem && hasSpace)
    ? 'standard_mixed'
    : hasItem ? 'standard_item' : 'standard_space';
  return { profiles, strategy };
}

export async function autoParseMixedBooking(buf, ext) {
  const rawSheets = readBookingSheets(buf, ext);
  const standard = detectStandardBookingSheets(rawSheets);

  if (standard) {
    const parsed = ruleParseMixedSheets(rawSheets, '');
    const label = {
      standard_item: '标准物品资源',
      standard_space: '标准空间资源',
      standard_mixed: '标准混合资源',
    }[standard.strategy];
    const items = parsed.items.map((it) => {
      const profile = standard.profiles[it._sheet_index];
      return {
        ...it,
        kind: profile && profile.kind !== 'mixed' ? profile.kind : it.kind,
        confidence: 'high',
        warnings: [],
      };
    });
    return {
      ...parsed,
      items,
      source: standard.strategy,
      strategy: standard.strategy,
      ai_used: false,
      warnings: [
        `已识别为${label}表格，未调用 AI`,
        ...parsed.warnings.filter((x) => !x.startsWith('已使用规则解析')),
      ],
    };
  }

  const parsed = await aiParseMixedBooking(buf, ext);
  return { ...parsed, ai_used: parsed.source === 'ai' };
}

// ---------------- AI 解析 ----------------
const SYSTEM_PROMPT = `你是实验室/竞赛资源台账解析器。用户会给一个或多个工作表，每行前面带 Excel 原始行号。
只依据表格内容判断，禁止编造表格中不存在的资源。
资源类型只有：item=物品资源（设备/仪器/工具/物料，按库存数量借用），space=空间资源（教室/实验室/会议室/场地，按容量独占预约）。
物品字段：spec 规格型号、quantity 库存数量、unit 单位、location 存放位置。
空间字段：location 房间号/位置、capacity 可容纳人数、equipment 室内设备数组。
审批方式 approve_mode 只能输出 approval（需审批）、first_come（先到先得/免审）或空字符串（留空用项目默认）。
跳过表头、标题、说明、备注、合计行；分段标题要结合下文判断默认类型。无法确定类型时也要输出最可能的类型，并把 confidence 设为 low。
输出严格 JSON，不要 Markdown：
{"items":[{"sheet_index":0,"row":3,"kind":"item","name":"电烙铁","spec":"60W","quantity":10,"unit":"把","location":"A柜","capacity":"","equipment":[],"approve_mode":"approval","confidence":"high","reason":"类型列明确"}],"skipped":[{"sheet_index":0,"row":1,"reason":"表头"}]}
confidence 只能为 high/medium/low。`;

function buildAiPayload(rawSheets) {
  const compact = compactSheets(rawSheets);
  let truncatedRows = 0;
  let budget = BOOKING_IMPORT_MAX;
  const sheets = compact.map((s) => {
    const rows = [];
    for (const row of s.rows) {
      if (budget <= 0) { truncatedRows++; continue; }
      rows.push([row.r, ...row.cells.slice(0, 16).map((x) => x.slice(0, 80))]);
      budget -= 1;
    }
    return { name: s.name, rows };
  });
  return { payload: { sheets }, truncatedRows, sheetCount: compact.length };
}

function findAiRow(sheets, sheetIndex, rowNo) {
  const si = Number.isInteger(sheetIndex) ? sheetIndex : sheets.findIndex((s) => s.name === sheetIndex);
  const sheet = sheets[si];
  const row = sheet?.rows.find((x) => Number(x.r) === Number(rowNo));
  return { sheet: sheet || null, sheetIndex: si, row: row || null };
}

function parseAiOutput(raw, rawSheets) {
  const text = String(raw || '').replace(/^```json\s*|```$/g, '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new BookingImportError('AI 输出不是合法 JSON');
  const data = JSON.parse(m[0]);
  const arr = Array.isArray(data.items) ? data.items : [];
  const sheets = compactSheets(rawSheets);
  const items = [];
  const skipped = Array.isArray(data.skipped) ? data.skipped.slice(0, 100).map((x) => ({
    sheet: sheets[Number(x.sheet_index)]?.name || x.sheet || '',
    sheet_index: Number(x.sheet_index) || 0,
    row: Number(x.row) || 0,
    reason: clampText(x.reason, 80) || 'AI 判断跳过',
  })).filter((x) => x.row) : [];

  for (const x of arr) {
    const found = findAiRow(sheets, Number(x.sheet_index), x.row);
    if (!found.sheet || !found.row) continue; // 无来源行一律丢弃，防止 AI 编造
    const kind = normalizeKind(x.kind, '');
    if (!kind) continue;
    const sourceText = found.row.cells.join(' | ');
    let name = clampText(x.name, 30);
    const warnings = [];
    const compact = (v) => String(v || '').replace(/\s/g, '');
    if (!name || !compact(sourceText).includes(compact(name))) {
      warnings.push('AI 提取名称与原表不完全一致，请重点核对');
    }
    const confidence = ['high', 'medium', 'low'].includes(x.confidence) ? x.confidence : 'medium';
    items.push({
      kind,
      name,
      spec: clampText(x.spec, 40),
      quantity: kind === 'item' ? (x.quantity ?? '') : '',
      unit: clampText(x.unit, 8),
      location: clampText(x.location, 60),
      capacity: kind === 'space' ? (x.capacity ?? '') : '',
      equipment: splitEquipment(x.equipment),
      approve_mode: normalizeApproveText(x.approve_mode) || normalizeApproveText(found.row.cells.find((c) => /需审批|要审批|人工审批|先到先得|免审|自动确认|无需审批|不用审批/.test(c)) || ""),
      confidence: warnings.length ? 'low' : confidence,
      warnings,
      reason: clampText(x.reason, 80),
      _sheet: found.sheet.name,
      _sheet_index: found.sheetIndex,
      _row: found.row.r,
    });
  }
  return { items, skipped };
}

export async function aiParseMixedBooking(buf, ext) {
  const rawSheets = readBookingSheets(buf, ext);
  const { payload, truncatedRows, sheetCount } = buildAiPayload(rawSheets);
  let ai = null;
  const aiWarnings = [];
  try {
    const raw = await callDeepSeek([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `请解析这个资源台账 JSON：\n${JSON.stringify(payload)}` },
    ], { json: true, timeoutMs: 120000 });
    ai = parseAiOutput(raw, rawSheets);
  } catch (e) {
    aiWarnings.push(`AI 识别暂不可用，已自动切换规则解析：${clampText(e.message, 120)}`);
  }

  if (ai?.items?.length) {
    const warnings = [
      `AI 已识别 ${ai.items.length} 条资源，请逐行核对后再导入`,
      `工作表：${payload.sheets.map((s) => s.name).join('、')}`,
      ...aiWarnings,
    ];
    if (truncatedRows) warnings.push(`单次最多处理 ${BOOKING_IMPORT_MAX} 行，已截断后续 ${truncatedRows} 行`);
    return { items: ai.items.slice(0, BOOKING_IMPORT_MAX), skipped: ai.skipped || [], truncated: truncatedRows > 0, warnings, source: 'ai', ai_used: true };
  }

  const fallback = ruleParseMixedSheets(rawSheets, '');
  if (ai && !ai.items?.length) aiWarnings.push('AI 未识别到有效资源行，已切换规则解析');
  return { ...fallback, warnings: [...aiWarnings, ...fallback.warnings], source: 'rules_fallback', ai_used: false, sheetCount };
}
