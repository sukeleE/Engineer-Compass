<script>
// Office 文件类型判定同时导出给列表/调用方使用，避免各页面各写一套正则。
// 仅 .docx 走网页渲染；旧版 .doc 是二进制格式，浏览器端无法可靠还原，仍建议下载用 Word/WPS 打开。
export function officePreviewType(name = '', mime = '') {
  const n = String(name || '');
  const m = String(mime || '').toLowerCase();
  if (/\.docx$/i.test(n) || m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'word';
  if (/\.(xlsx|xlsm|xlsb|xls|xltx|xltm|xlt|ods|fods|csv)$/i.test(n)
    || [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'application/vnd.oasis.opendocument.spreadsheet',
      'text/csv',
    ].includes(m)) return 'excel';
  return '';
}
</script>

<script setup>
// 浏览器端 Office 预览：Word(.docx) 用 docx-preview 解析，Excel 用 SheetJS 解析。
// 安全口径：Excel 单元格全部通过 Vue 插值渲染；Word 先在离屏 DOM 中生成，再放进
// 「无 allow-scripts / 无 allow-same-origin」的 sandbox iframe，文档脚本和本站身份完全隔离。
import { computed, ref, shallowRef, watch } from 'vue';

const props = defineProps({
  name: { type: String, default: '' },
  blob: { type: Blob, default: null },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
  height: { type: String, default: '70vh' },
});

const EXCEL_MAX_ROWS = 500;
const EXCEL_MAX_COLS = 80;

const busy = ref(false);
const err = ref('');
const view = ref('');
const wordSrcDoc = ref('');
const excelWb = shallowRef(null);
const excelSheets = ref([]);
const activeSheet = ref(0);
const activeData = ref(null);
let parseSeq = 0;

const typeLabel = computed(() => ({ word: 'Word', excel: 'Excel' }[view.value] || 'Office'));
const showMask = computed(() => props.loading || busy.value);
const shownError = computed(() => props.error || err.value);

function resetOutput() {
  view.value = '';
  wordSrcDoc.value = '';
  excelWb.value = null;
  excelSheets.value = [];
  activeSheet.value = 0;
  activeData.value = null;
  err.value = '';
}

function hardenWordBody(body) {
  body.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (/^\s*(javascript|data|vbscript):/i.test(href)) a.removeAttribute('href');
    else { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  });
  // 双保险：即便解析库未来把属性透传出来，sandbox 之外也先清掉内联事件。
  body.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    }
  });
}

function buildWordDocument(bodyHtml, cssText) {
  const safeCss = String(cssText || '')
    .replace(/@import[^;]*(?:;|$)/gi, '')
    .replace(/url\(\s*(['"]?)https?:[^)]+\)/gi, '');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<style>
${safeCss}
html, body { margin: 0; padding: 0; background: #f3f4f6; }
body { padding: 18px; box-sizing: border-box; }
.docx-wrapper { background: transparent !important; padding: 0 !important; min-height: auto !important; }
.docx-wrapper > section { margin: 0 auto 16px !important; box-shadow: 0 1px 4px rgba(15,23,42,.18) !important; }
table { border-collapse: collapse; }
</style>
</head>
<body>${bodyHtml}</body>
</html>`;
}

async function renderWord(blob) {
  const { renderAsync } = await import('docx-preview');
  const body = document.createElement('div');
  const style = document.createElement('div');
  await renderAsync(blob, body, style, {
    className: 'docx',
    inWrapper: true,
    breakPages: true,
    ignoreWidth: false,
    ignoreHeight: false,
    ignoreFonts: false,
    debug: false,
    experimental: false,
    trimXmlDeclaration: true,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    renderEndnotes: true,
    renderChanges: false,
    renderComments: false,
    renderAltChunks: false, // 不渲染 DOCX 内嵌 HTML altChunk，减少不可信 HTML 面。
    useBase64URL: true,
  });
  hardenWordBody(body);
  wordSrcDoc.value = buildWordDocument(body.innerHTML, style.innerHTML);
}

function cellText(XLSX, wb, ws, r, c) {
  const cell = ws[XLSX.utils.encode_cell({ r, c })];
  if (!cell || cell.t === 'z' || cell.v === undefined || cell.v === null) return { text: '', num: false };
  const text = cell.w ?? XLSX.utils.format_cell(cell, null, { date1904: !!wb.Workbook?.Date1904 });
  if (text === undefined || text === null) return { text: '', num: false };
  return { text: String(text), num: cell.t === 'n' };
}

function renderExcelSheet() {
  const XLSX = excelWb.value?.XLSX;
  const wb = excelWb.value?.wb;
  if (!XLSX || !wb) return;
  const name = wb.SheetNames[activeSheet.value];
  const ws = wb.Sheets[name];
  if (!ws || !ws['!ref']) {
    activeData.value = { name, columns: [], rows: [], totalRows: 0, totalCols: 0, truncatedRows: false, truncatedCols: false };
    return;
  }
  const range = XLSX.utils.decode_range(ws['!ref']);
  const totalRows = Math.max(0, range.e.r - range.s.r + 1);
  const totalCols = Math.max(0, range.e.c - range.s.c + 1);
  const lastRow = Math.min(range.e.r, range.s.r + EXCEL_MAX_ROWS - 1);
  const lastCol = Math.min(range.e.c, range.s.c + EXCEL_MAX_COLS - 1);
  const columns = [];
  for (let c = range.s.c; c <= lastCol; c++) columns.push({ letter: XLSX.utils.encode_col(c), index: c });
  const rows = [];
  for (let r = range.s.r; r <= lastRow; r++) {
    const cells = [];
    for (let c = range.s.c; c <= lastCol; c++) cells.push(cellText(XLSX, wb, ws, r, c));
    rows.push({ number: r + 1, cells });
  }
  activeData.value = {
    name, columns, rows, totalRows, totalCols,
    truncatedRows: totalRows > EXCEL_MAX_ROWS,
    truncatedCols: totalCols > EXCEL_MAX_COLS,
  };
}

async function renderExcel(blob) {
  const XLSX = await import('@e965/xlsx');
  const buffer = await blob.arrayBuffer();
  const wb = XLSX.read(buffer, {
    type: 'array',
    cellDates: true,
    cellNF: true,
    cellHTML: false,
    cellStyles: false,
    dense: false,
  });
  if (!wb.SheetNames?.length) throw new Error('工作簿中没有工作表');
  excelWb.value = { XLSX, wb };
  excelSheets.value = wb.SheetNames.map((name, index) => ({ name, index }));
  activeSheet.value = 0;
  renderExcelSheet();
}

function selectSheet(index) {
  if (index === activeSheet.value) return;
  activeSheet.value = index;
  renderExcelSheet();
}

async function parse(blob) {
  const seq = ++parseSeq;
  resetOutput();
  if (!blob) return;
  const type = officePreviewType(props.name, blob.type);
  if (!type) {
    err.value = '该文件类型不支持网页预览（旧版 .doc 请下载后用 Word/WPS 打开）';
    return;
  }
  view.value = type;
  busy.value = true;
  try {
    if (type === 'word') await renderWord(blob);
    else await renderExcel(blob);
  } catch (e) {
    if (seq !== parseSeq) return;
    console.warn('[office-preview] parse failed:', e);
    err.value = /password|encrypt/i.test(String(e?.message || e))
      ? '加密或受保护的 Office 文件暂不支持在线预览'
      : `文件解析失败，请下载后查看（${e?.message || '未知错误'}）`;
  } finally {
    if (seq === parseSeq) busy.value = false;
  }
}

watch(() => [props.blob, props.name], () => parse(props.blob), { immediate: true });
</script>

<template>
  <div class="office-preview">
    <div v-if="showMask" class="office-mask">
      <span class="office-spinner"></span>
      正在解析{{ typeLabel }}文档…
    </div>

    <div v-if="shownError" class="office-error">⚠ {{ shownError }}</div>

    <template v-else-if="view === 'word' && wordSrcDoc">
      <iframe
        class="office-word-frame"
        :srcdoc="wordSrcDoc"
        sandbox="allow-popups"
        referrerpolicy="no-referrer"
        title="Word 文档预览"
      ></iframe>
    </template>

    <div v-else-if="view === 'excel' && activeData" class="excel-wrap">
      <div v-if="excelSheets.length > 1" class="sheet-tabs" role="tablist">
        <button
          v-for="s in excelSheets"
          :key="s.index"
          type="button"
          role="tab"
          :class="{ on: s.index === activeSheet }"
          @click="selectSheet(s.index)"
        >{{ s.name }}</button>
      </div>
      <p
        v-if="activeData.truncatedRows || activeData.truncatedCols"
        class="office-note"
      >仅预览前 {{ EXCEL_MAX_ROWS }} 行、{{ EXCEL_MAX_COLS }} 列；完整内容请下载查看。</p>
      <div class="excel-scroll" :style="{ maxHeight: height }">
        <table class="excel-grid">
          <thead>
            <tr>
              <th class="corner"></th>
              <th v-for="col in activeData.columns" :key="col.index">{{ col.letter }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in activeData.rows" :key="row.number">
              <th class="row-no">{{ row.number }}</th>
              <td v-for="(cell, i) in row.cells" :key="i" :class="{ num: cell.num }">{{ cell.text }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="excel-meta">
        {{ activeData.name }} · {{ activeData.totalRows }} 行 × {{ activeData.totalCols }} 列
      </div>
    </div>

    <div v-else-if="!showMask" class="office-empty">暂无可预览的 Office 文件</div>
  </div>
</template>

<style lang="scss" scoped>
.office-preview {
  position: relative;
  min-height: 180px;
  background: var(--card-bg, #fff);
  border-radius: 8px;
  overflow: hidden;
}
.office-mask {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-2, #475569);
  background: rgba(255, 255, 255, 0.78);
  font-size: 13px;
}
.office-spinner {
  width: 18px;
  height: 18px;
  border: 2px solid #cbd5e1;
  border-top-color: var(--primary, #2563eb);
  border-radius: 50%;
  animation: office-spin .8s linear infinite;
}
@keyframes office-spin { to { transform: rotate(360deg); } }
.office-error,
.office-note,
.office-empty {
  margin: 0;
  padding: 14px 18px;
  font-size: 13px;
  color: var(--text-2, #475569);
}
.office-error { color: #b91c1c; background: #fef2f2; }
.office-note { padding: 8px 12px; color: #b45309; background: #fffbeb; border-bottom: 1px solid #fde68a; }
.office-word-frame {
  display: block;
  width: 100%;
  height: v-bind(height);
  border: 0;
  background: #f3f4f6;
}
.sheet-tabs {
  display: flex;
  gap: 4px;
  padding: 8px 10px 0;
  overflow-x: auto;
  background: #f8fafc;
  border-bottom: 1px solid #e2e8f0;
  button {
    flex: 0 0 auto;
    border: 1px solid #cbd5e1;
    border-bottom: 0;
    border-radius: 6px 6px 0 0;
    background: #fff;
    color: #475569;
    padding: 6px 12px;
    font: inherit;
    font-size: 12.5px;
    cursor: pointer;
    &.on {
      color: var(--primary, #2563eb);
      border-color: var(--primary, #2563eb);
      background: #eff6ff;
    }
  }
}
.excel-scroll {
  overflow: auto;
  background: #fff;
}
.excel-grid {
  border-collapse: separate;
  border-spacing: 0;
  font-size: 12.5px;
  color: #0f172a;
  white-space: nowrap;
  th, td {
    border-right: 1px solid #e2e8f0;
    border-bottom: 1px solid #e2e8f0;
    padding: 4px 8px;
    max-width: 360px;
    overflow: hidden;
    text-overflow: ellipsis;
    background: #fff;
  }
  thead th {
    position: sticky;
    top: 0;
    z-index: 2;
    text-align: center;
    font-weight: 600;
    color: #64748b;
    background: #f1f5f9;
  }
  .corner {
    left: 0;
    z-index: 3;
    min-width: 44px;
    border-left: 1px solid #e2e8f0;
  }
  .row-no {
    position: sticky;
    left: 0;
    z-index: 1;
    min-width: 44px;
    text-align: center;
    font-weight: 500;
    color: #64748b;
    background: #f8fafc;
  }
  td { white-space: pre-wrap; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
}
.excel-meta {
  padding: 7px 12px;
  color: #64748b;
  background: #f8fafc;
  border-top: 1px solid #e2e8f0;
  font-size: 12px;
}
</style>
