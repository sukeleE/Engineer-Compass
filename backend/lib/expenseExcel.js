// 报销整理·xlsx 导出（SheetJS CE 已在依赖中，importPlan.js 同款用法）
// 布局：Sheet1 汇总 = 队伍→成员 两级展开（成员行×各类金额 + 个人合计，队小计/总计 =SUM 页内公式）
//       全项目统一支付块（team_id 为空的项目级行）在各队伍块之后、总计行之前，同样进 blocks → 计入全部总计
//       每队伍一个 sheet + 「全项目统一支付」sheet（各类块纵向堆叠全字段，金额 number，块小计/页底总计 =SUM）
// 行序：队伍内按名单顺序（同人按录入先后），公用"队伍"行置末；项目级 sheet 按录入先后
//       末 Sheet 附件清单（负责人逐槽核对是否交齐）
// 统计口径（2026-09-03 定）：金额记出钱人（垫付人）名下 →（下午修订）帮付三字段已删除，不再有"被代付人"；
//       涵盖的人写在「统一支付范围」列（'全部成员'=本队 / '全体成员'=整个项目 / 顿号名单=勾选，快照文本）
//       公用耗材行（owner_name='队伍'）在汇总单列"队伍（公用耗材）"行，不计入任何成员
//       全项目统一支付块（2026-09-03）：项目级行（team_id 空）在汇总独立块、独立 sheet、附件清单标"全项目统一支付"
//       ⑥零散票据（2026-09-03 下午）：第六类仅项目级行；汇总共六类金额列（C..H），个人合计 =SUM(C:H)
// 注意：CE 无法写单元格样式（无填充/字体）；aoa_to_sheet 不会把 "=…" 字符串当公式
//       → 公式一律旁路收集，sheet 建成后以 {t:'n', f} cell 覆盖
// 行号换算：aoa 索引 i → Excel 显示行 i+1（aoa[0]=第1行）
import * as XLSX from 'xlsx';
import { CATEGORIES, FIELDS, safeParseData, sumMoney, slotLabel, sanitizeName, fmtBytes } from './expenseMeta.js';

const L = (ci) => XLSX.utils.encode_col(ci); // 0-based 列号 → 列字母

// 文本注入防护：以 = + - @ 开头的用户文本会被 Excel 当作公式 → 统一加 ' 前缀
function cellSafe(v) {
  const s = String(v ?? '');
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
}
// 金额只落 number；非数/负值兜底空
function cellNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : '';
}

// sheet 名清洗（Excel 非法字符 / ≤31 字 / 重名去重）
function sheetName(name, used) {
  let s = sanitizeName(String(name), 28).replace(/[[\]:*?/\\]/g, '');
  if (!s) s = '队伍';
  let out = s;
  let i = 2;
  while (used.has(out)) out = `${s}(${i++})`;
  used.add(out);
  return out;
}

// 一行的附件文本：`槽位label：原文件名` 以 ；连接
function attsText(cat, list) {
  if (!list?.length) return '';
  return list.map((a) => `${slotLabel(cat, a.slot)}：${a.orig_name}`).join('；');
}

const catIdx = (key) => CATEGORIES.findIndex((c) => c.key === key);
const NZERO = () => new Array(CATEGORIES.length).fill(0); // 每出钱人一行 = 各类金额合计（列数随 CATEGORIES）
// 出钱人 → 各类金额合计（口径=垫付合计记出钱人名下）
function ownerSum(rowList) {
  const ot = new Map();
  for (const x of rowList) {
    const idx = catIdx(x.category);
    if (idx < 0) continue;
    if (!ot.has(x.owner_name)) ot.set(x.owner_name, NZERO());
    ot.get(x.owner_name)[idx] += sumMoney(x.category, safeParseData(x.data));
  }
  return ot;
}

// 类别块纵向堆叠的明细 sheet 数据（队伍 sheet / 全项目统一支付 sheet 共用）；sortedRows 需已按展示序排好
function detailArrays(sortedRows, attsByRow) {
  const aoaT = [];
  const merges = [];
  const subs = []; // {col(0-based money 列), first, subR}
  let maxCols = 1;
  for (const c of CATEGORIES) {
    const catRows = sortedRows.filter((x) => x.category === c.key);
    if (!catRows.length) continue;
    // 统一支付范围列：仅当该类别内存在统一支付行才带出（meta 每类都含此键，普通表不空列）
    const anyScope = catRows.some((x) => String(safeParseData(x.data)['统一支付范围'] || '').trim());
    const colDefs = anyScope ? FIELDS[c.key] : FIELDS[c.key].filter((f) => f.type !== 'multi');
    const cols = ['成员姓名', ...colDefs.map((f) => f.label), '附件文件'];
    const w = cols.length;
    maxCols = Math.max(maxCols, w);
    const titleR = aoaT.length;
    aoaT.push([`${c.num} ${c.zh}（金额单位：元；附件原件见 ZIP 包）`]);
    merges.push({ s: { r: titleR, c: 0 }, e: { r: titleR, c: w - 1 } });
    aoaT.push(cols);
    const moneyCol = 1 + FIELDS[c.key].findIndex((f) => f.key === c.sumKey);
    const firstD = aoaT.length;
    for (const x of catRows) {
      const d = safeParseData(x.data);
      const rowArr = [cellSafe(x.owner_name)];
      for (const f of colDefs) {
        rowArr.push(f.type === 'money' ? cellNum(d[f.key]) : cellSafe(d[f.key]));
      }
      rowArr.push(attsText(c.key, attsByRow.get(x.id)));
      aoaT.push(rowArr);
    }
    const subR = aoaT.length; // 小计行 aoa idx
    aoaT.push([`小计（${c.zh}）`]);
    merges.push({ s: { r: subR, c: 0 }, e: { r: subR, c: moneyCol - 1 } });
    subs.push({ col: moneyCol, first: firstD, subR });
  }
  return { aoaT, merges, subs, maxCols };
}

/**
 * rows: [{id, team_id(可空=NULL=全项目统一支付), category, owner_name, data(string JSON)}]
 * atts: [{row_id, slot, orig_name, size}]
 * teams: [{id, name}]（需按展示顺序传入）
 * members: [{id, team_id, name, ord}]（名单；汇总按此列出每个人查漏；缺参时退化为按行 owner 归集）
 * 返回 xlsx Buffer
 */
export function buildExpenseWorkbook({ project, teams, members, rows, atts }) {
  const wb = XLSX.utils.book_new();
  const pname = cellSafe(project.name || '报销项目');
  const ev = cellSafe(project.event || '');
  const nowStr = new Date().toLocaleString('zh-CN', { hour12: false });
  const attsByRow = new Map();
  for (const a of atts) {
    if (!attsByRow.has(a.row_id)) attsByRow.set(a.row_id, []);
    attsByRow.get(a.row_id).push(a);
  }
  const usedSheets = new Set();
  const projRows = rows.filter((x) => x.team_id == null); // 全项目统一支付行（项目级区块）

  // ---------- Sheet1 汇总：队伍 → 成员 两级 + 全项目统一支付块（均 =SUM 页内公式）----------
  // 名单成员无记录也照列（负责人一望即知谁还没填）；公用耗材行单列"队伍（公用耗材）"
  // 列布局随 CATEGORIES：0 队伍 / 1 成员 / 2..(1+N) 各类金额 / 2+N 个人合计
  const N = CATEGORIES.length;
  const moneyLo = 2, moneyHi = 1 + N, totalCol = 2 + N;
  const mSum = [{ s: { r: 0, c: 0 }, e: { r: 0, c: totalCol } }]; // 首行大标题跨全表
  const aoa = [[`「${pname}」费用汇总${ev ? `（${ev}）` : ''}　金额单位：元　成员金额=垫付合计　生成：${nowStr}`],
    ['队伍', '成员', ...CATEGORIES.map((c) => `${c.num}${c.zh}`), '个人合计']];
  const blocks = []; // 每队+全项目块 { first: 首行 aoa idx, subR: 小计行 aoa idx }
  for (const t of teams) {
    const tRows = rows.filter((x) => x.team_id === t.id);
    const roster = (members || []).filter((m) => m.team_id === t.id);
    if (!roster.length && !tRows.length) continue;
    const ownerTot = ownerSum(tRows);
    // 行序：名单在前（未认领也列）、其余 owner（如公用"队伍"）按行录入先后追加
    const lines = [...roster.map((m) => m.name)];
    for (const nm of ownerTot.keys()) if (!lines.includes(nm)) lines.push(nm);
    if (!lines.length) continue;
    const first = aoa.length;
    for (let i = 0; i < lines.length; i++) {
      const nm = lines[i];
      // 队行不含零散票据（服务端 400），⑥列对队伍恒 0 —— 与"无记录类别显 0"同风格，不做特判
      aoa.push([i === 0 ? cellSafe(t.name) : '', cellSafe(nm === '队伍' ? '队伍（公用耗材）' : nm),
        ...(ownerTot.get(nm) || NZERO())]);
    }
    const subR = aoa.length; // 小计行将占此 aoa idx
    blocks.push({ first, subR });
    aoa.push([null, '小计']);
    mSum.push({ s: { r: first, c: 0 }, e: { r: subR, c: 0 } }); // 队伍列纵向合并（含小计行）
  }
  // 全项目统一支付块（含⑥零散票据）：紧随队伍块、先于总计行（block 结构同队伍 → 公式自动覆盖）
  if (projRows.length) {
    const ownerTot = ownerSum(projRows);
    const first = aoa.length;
    let firstLine = true;
    for (const nm of ownerTot.keys()) {
      aoa.push([firstLine ? cellSafe('全项目统一支付') : '', cellSafe(nm), ...(ownerTot.get(nm) || NZERO())]);
      firstLine = false;
    }
    const subR = aoa.length;
    blocks.push({ first, subR });
    aoa.push([null, '小计']);
    mSum.push({ s: { r: first, c: 0 }, e: { r: subR, c: 0 } });
  }
  let grandR = -1;
  if (blocks.length) {
    grandR = aoa.length;
    aoa.push(['总计（各队伍小计＋全项目统一支付小计）', null]);
    mSum.push({ s: { r: grandR, c: 0 }, e: { r: grandR, c: 1 } });
  }
  const noteR = aoa.length;
  aoa.push(['注：成员金额=该人名下垫付合计（谁出钱记谁名下）。一张票据涵盖多人时，涵盖的人写在明细的「统一支付范围」列（勾选名单快照）。公用耗材行的"队伍（公用耗材）"不计入成员。"全项目统一支付"块=项目级记录（不属任何队伍：统一垫付 + ⑥零散票据）。附件原件按队伍/项目在网页下载 ZIP。']);
  mSum.push({ s: { r: noteR, c: 0 }, e: { r: noteR, c: totalCol } });
  const wsSum = XLSX.utils.aoa_to_sheet(aoa);
  for (const b of blocks) {
    for (let r = b.first; r < b.subR; r++) { // 每个成员行：个人合计 =SUM(本行各类金额)
      wsSum[XLSX.utils.encode_cell({ r, c: totalCol })] =
        { t: 'n', f: `=SUM(${L(moneyLo)}${r + 1}:${L(moneyHi)}${r + 1})` };
    }
    for (let c = moneyLo; c <= moneyHi; c++) { // 块小计每列 =SUM(本块成员行)
      wsSum[XLSX.utils.encode_cell({ r: b.subR, c })] =
        { t: 'n', f: `=SUM(${L(c)}${b.first + 1}:${L(c)}${b.subR})` };
    }
    // 小计行的"个人合计"格 = 该行各类小计横向之和
    wsSum[XLSX.utils.encode_cell({ r: b.subR, c: totalCol })] =
      { t: 'n', f: `=SUM(${L(moneyLo)}${b.subR + 1}:${L(moneyHi)}${b.subR + 1})` };
  }
  if (grandR >= 0) {
    for (let c = moneyLo; c <= totalCol; c++) { // 全部总计每列 =SUM(各块小计行同列，含全项目统一支付块)
      wsSum[XLSX.utils.encode_cell({ r: grandR, c })] =
        { t: 'n', f: `=SUM(${blocks.map((b) => `${L(c)}${b.subR + 1}`).join(',')})` };
    }
  }
  wsSum['!merges'] = mSum;
  wsSum['!cols'] = [{ wch: 16 }, { wch: 20 }, ...Array(N).fill({ wch: 10 }), { wch: 11 }];
  XLSX.utils.book_append_sheet(wb, wsSum, sheetName('汇总', usedSheets));

  // ---------- 每队伍一 sheet（原有布局不变）----------
  for (const t of teams) {
    const tRows = rows.filter((x) => x.team_id === t.id);
    if (!tRows.length) continue;
    // 名单顺序排名（同队内）；公用"队伍"置末；名单外的 owner（理论不该有）放名单后
    const mOrder = new Map((members || []).filter((m) => m.team_id === t.id).map((m, i) => [m.name, i]));
    const rankOf = (nm) => (nm === '队伍' ? 9e8 : (mOrder.has(nm) ? mOrder.get(nm) : 5e8));
    const sorted = [...tRows].sort((a, b) => rankOf(a.owner_name) - rankOf(b.owner_name) || a.id - b.id);
    const { aoaT, merges, subs, maxCols } = detailArrays(sorted, attsByRow);
    const grandR = aoaT.length;
    aoaT.push(['本队总计（五类之和）']);
    merges.push({ s: { r: grandR, c: 0 }, e: { r: grandR, c: Math.max(0, maxCols - 2) } });
    const noteR = aoaT.length;
    aoaT.push([`附件原件按队伍在网页「下载附件 ZIP」获取（发票/查验/凭证/清单/使用图）；生成时间 ${nowStr}`]);
    merges.push({ s: { r: noteR, c: 0 }, e: { r: noteR, c: maxCols - 1 } });

    const ws = XLSX.utils.aoa_to_sheet(aoaT);
    for (const s of subs) {
      const colL = L(s.col);
      ws[XLSX.utils.encode_cell({ r: s.subR, c: s.col })] =
        { t: 'n', f: `=SUM(${colL}${s.first + 1}:${colL}${s.subR})` };
    }
    // 页底总计 =SUM(各块小计格)，列取全表最宽列（跨块列号不同也没关系：不同行）
    if (subs.length) {
      ws[XLSX.utils.encode_cell({ r: grandR, c: maxCols - 1 })] =
        { t: 'n', f: `=SUM(${subs.map((s) => `${L(s.col)}${s.subR + 1}`).join(',')})` };
    }
    ws['!merges'] = merges;
    ws['!cols'] = [{ wch: 10 }, ...Array(Math.max(0, maxCols - 1)).fill({ wch: 24 })];
    XLSX.utils.book_append_sheet(wb, ws, sheetName(t.name, usedSheets));
  }

  // ---------- 全项目统一支付 sheet（项目级行明细：统一垫付＋⑥零散票据，不属任何队伍；涵盖的人见各行「统一支付范围」列）----------
  if (projRows.length) {
    const { aoaT, merges, subs, maxCols } = detailArrays([...projRows].sort((a, b) => a.id - b.id), attsByRow);
    const grandR = aoaT.length;
    aoaT.push(['全项目统一支付总计']);
    merges.push({ s: { r: grandR, c: 0 }, e: { r: grandR, c: Math.max(0, maxCols - 2) } });
    const noteR = aoaT.length;
    aoaT.push([`本表为项目级统一支付明细：不属任何队伍（统一垫付＋⑥零散票据），涵盖的人见各行「统一支付范围」列（可跨队勾选）；金额记出钱人（垫付人）名下。附件原件在网页「全项目统一支付」区下载附件 ZIP；生成时间 ${nowStr}`]);
    merges.push({ s: { r: noteR, c: 0 }, e: { r: noteR, c: maxCols - 1 } });

    const ws = XLSX.utils.aoa_to_sheet(aoaT);
    for (const s of subs) {
      const colL = L(s.col);
      ws[XLSX.utils.encode_cell({ r: s.subR, c: s.col })] =
        { t: 'n', f: `=SUM(${colL}${s.first + 1}:${colL}${s.subR})` };
    }
    if (subs.length) {
      ws[XLSX.utils.encode_cell({ r: grandR, c: maxCols - 1 })] =
        { t: 'n', f: `=SUM(${subs.map((s) => `${L(s.col)}${s.subR + 1}`).join(',')})` };
    }
    ws['!merges'] = merges;
    ws['!cols'] = [{ wch: 10 }, ...Array(Math.max(0, maxCols - 1)).fill({ wch: 24 })];
    XLSX.utils.book_append_sheet(wb, ws, sheetName('全项目统一支付', usedSheets));
  }

  // ---------- 附件清单（队伍 + 全项目统一支付行）----------
  const attAoa = [['队伍', '分类', '成员', '附件槽位', '文件名', '大小']];
  const pushAttLines = (tlabel, catRows) => {
    for (const x of catRows) {
      const cf = CATEGORIES[catIdx(x.category)];
      const list = attsByRow.get(x.id) || [];
      if (!list.length) {
        attAoa.push([tlabel, `${cf.num}${cf.zh}`, cellSafe(x.owner_name), '', '（该行无附件）', '']);
        continue;
      }
      for (const a of list) {
        attAoa.push([tlabel, `${cf.num}${cf.zh}`, cellSafe(x.owner_name), slotLabel(x.category, a.slot), cellSafe(a.orig_name), fmtBytes(a.size)]);
      }
    }
  };
  for (const t of teams) {
    for (const c of CATEGORIES) {
      pushAttLines(cellSafe(t.name), rows.filter((x) => x.team_id === t.id && x.category === c.key));
    }
  }
  for (const c of CATEGORIES) {
    pushAttLines('全项目统一支付', projRows.filter((x) => x.category === c.key));
  }
  if (attAoa.length === 1) attAoa.push(['（暂无记录）']);
  const wsAtt = XLSX.utils.aoa_to_sheet(attAoa);
  wsAtt['!cols'] = [{ wch: 16 }, { wch: 10 }, { wch: 12 }, { wch: 18 }, { wch: 42 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, wsAtt, sheetName('附件清单', usedSheets));

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
