<script setup>
// 项目文件的在线预览面板（点目录树里的文件即预览）
//
// 三个硬约束决定了这里的写法：
// 1. `<img src>` / `<video src>` / `<a download>` 都**不能带请求头** —— 又不能把 session token 放进 URL
//    （后端 access_log 会把 originalUrl 原样记进日志，管理员可见），所以统一走 api.shareFileBlob
//    取 blob → URL.createObjectURL。卸载/换文件时必须 revoke，否则 30MB 的 blob 会一直挂在内存里。
// 2. 文本一律 `<pre>{{ text }}</pre>` 插值渲染。**绝不用 v-html** —— 帖子内容来自其他用户，
//    v-html 等于在本站源下执行任意 HTML/脚本，这是本页最大的 XSS 面。
// 3. svg 内联渲染等于执行脚本（后端 isInlineOk 已排除），按二进制走下载不给预览；
//    **html 例外**：默认在 opaque origin 的 sandbox iframe 里直接渲染网页，可切「代码」看转义源码。
//    sandbox 永远不能加 allow-same-origin —— 一旦加上，沙箱页面拿回本站源 = 在本站源下执行任意
//    脚本（可读登录态、以受害者身份调本站 API）。allow-scripts 保留（网页常带脚本），opaque origin
//    下脚本能跑但碰不到父窗口/存储/Cookie；外链/表单只能出网，不能回灌本站。
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../../api.js';
import { fmtSize, isTextLike } from '../../utils/share.js';
import OfficePreview, { officePreviewType } from '../common/OfficePreview.vue';
import GhIcon from './GhIcon.vue';

const props = defineProps({
  file: { type: Object, default: null }, // share_file 行（null = 未选中）
  repo: { type: String, default: '' },   // 所属帖的 Gitee 仓库（owner/repo，空=非仓库帖）
  refName: { type: String, default: '' }, // 分支/标签
});
const emit = defineEmits(['close']);

const busy = ref(false);
const err = ref('');
const blobUrl = ref('');
const text = ref('');
const truncated = ref(false);
const codeLoaded = ref(false); // html 切到代码态时才懒拉 /text（默认渲染态不多拉一份）
const codeLoading = ref(false);
const htmlMode = ref('view'); // html 专属：view = 沙箱渲染网页 | code = 转义源码
const kind = ref(''); // text | html | office | image | pdf | audio | video | other
const officeBlob = ref(null);

// html 判定：以扩展名为准、mime text/html 兜底（部分上传端把 .html 存成 octet-stream）
const HTML_RE = /\.html?$/i;
const isHtmlFile = (f) => !!f && (String(f.mime || '').toLowerCase() === 'text/html' || HTML_RE.test(f.name || ''));

const isGitee = computed(() => props.file?.source === 'gitee');
// 在 Gitee 打开（新标签页）。仓库条目的「下载」也走它 —— 本站只代理字节，不落盘、不重发。
const giteeBlobUrl = computed(() =>
  (props.repo && props.file ? `https://gitee.com/${props.repo}/blob/${props.refName || 'master'}/${props.file.path}` : ''));

function cleanup() {
  if (blobUrl.value) { URL.revokeObjectURL(blobUrl.value); blobUrl.value = ''; }
  text.value = ''; truncated.value = false; codeLoaded.value = false;
  err.value = ''; kind.value = ''; htmlMode.value = 'view'; officeBlob.value = null;
}

const IMG = /^image\/(?!svg)/;
// Gitee 条目的字节不在本站磁盘上，只能让后端去仓库代理（/files/:fid/raw）
const NEW_URL = async (f) => URL.createObjectURL(await api.shareFileBlob(f.id, { raw: f.source === 'gitee' }));
// html 渲染态：强制 blob 的 MIME 为 text/html（后端对 html 走 attachment 下载，
// Content-Type 仍在，但 Gitee 代理/历史数据可能给 octet-stream，不强制 iframe 会退化成下载）
async function newHtmlUrl(f) {
  const b = await api.shareFileBlob(f.id, { raw: f.source === 'gitee' });
  const typed = b.type === 'text/html' ? b : new Blob([b], { type: 'text/html' });
  return URL.createObjectURL(typed);
}
// 新标签全屏预览地址（独立 bare 路由，鉴权/沙箱口径与本页内嵌 iframe 完全一致）
const frameUrl = computed(() =>
  props.file
    ? `/share/html/${props.file.id}?n=${encodeURIComponent(props.file.name)}${isGitee.value ? '&source=gitee' : ''}`
    : '');

// 切「代码」时懒拉文本（512KB 截断，与普通文本预览同口径）
async function switchHtmlMode(m) {
  if (htmlMode.value === m) return;
  htmlMode.value = m;
  if (m === 'code' && !codeLoaded.value) {
    codeLoading.value = true;
    try {
      const r = await api.shareFileText(props.file.id);
      text.value = r.text; truncated.value = !!r.truncated; codeLoaded.value = true;
    } catch (e) { ElMessage.error(e.message); htmlMode.value = 'view'; }
    finally { codeLoading.value = false; }
  }
}

async function load(f) {
  cleanup();
  if (!f) return;
  busy.value = true;
  try {
    const mime = String(f.mime || '');
    // 先全部取到本地再一次性上屏：中途赋值会让「空 <pre>（假可见）/ src 为空的 <img>」先闪一下，
    // 探针与肉眼都会把它当成「加载完了但内容是空的」
    let kind2 = 'other', txt = '', trun = false, url = '', office = null;
    if (isHtmlFile(f)) {
      // html 默认沙箱渲染整页（不取文本，切到代码态再懒拉）
      kind2 = 'html'; url = await newHtmlUrl(f);
    } else if (officePreviewType(f.name, mime)) {
      // Word/Excel：浏览器端解析，blob 交给沙箱/表格渲染器；不暴露 token URL
      kind2 = 'office'; office = await api.shareFileBlob(f.id, { raw: f.source === 'gitee' });
    } else if (isTextLike(mime, f.name)) {
      const r = await api.shareFileText(f.id);
      kind2 = 'text'; txt = r.text; trun = !!r.truncated;
    } else if (mime === 'image/svg+xml') {
      kind2 = 'other'; // svg 内联渲染等于执行脚本，只给下载（后端 isInlineOk 同样排除）
    } else if (IMG.test(mime)) {
      kind2 = 'image'; url = await NEW_URL(f);
    } else if (mime === 'application/pdf') {
      kind2 = 'pdf'; url = await NEW_URL(f);
    } else if (mime.startsWith('audio/')) {
      kind2 = 'audio'; url = await NEW_URL(f);
    } else if (mime.startsWith('video/')) {
      kind2 = 'video'; url = await NEW_URL(f);
    }
    // 压缩包/未知 → other（只提供下载，不预览）
    kind.value = kind2; text.value = txt; truncated.value = trun; blobUrl.value = url; officeBlob.value = office;
  } catch (e) { err.value = e.message; } finally { busy.value = false; }
}

// immediate 必须有：组件由 v-if="selFile" 挂载，挂载时 props.file 已经是选中项，
// 只挂 watch 的话首次打开永远不会触发（面板会停在"不支持预览"的空态）
watch(() => props.file, load, { immediate: true });
onBeforeUnmount(cleanup);

async function download() {
  const f = props.file;
  if (!f) return;
  try {
    const b = await api.shareFileBlob(f.id, { dl: true, raw: f.source === 'gitee' });
    const u = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = u; a.download = f.name; // Gitee 代理没有 Content-Disposition，文件名只能由前端给
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 10000);
  } catch (e) { ElMessage.error(e.message); }
}
</script>

<template>
  <div v-if="file" class="fp-wrap">
    <div class="fp-head">
      <GhIcon :name="isGitee ? 'repo' : 'file-directory-fill'" :size="14" />
      <span class="fp-path" :title="file.path">{{ file.path }}</span>
      <span v-if="isGitee" class="fp-tag">Gitee</span>
      <span v-if="kind === 'html'" class="fp-seg">
        <button class="fp-btn" :class="{ on: htmlMode === 'view' }" title="沙箱中渲染网页"
          @click="switchHtmlMode('view')">🌐 网页</button>
        <button class="fp-btn" :class="{ on: htmlMode === 'code' }" title="查看 HTML 源码"
          @click="switchHtmlMode('code')">&lt;/&gt; 代码</button>
      </span>
      <a v-if="kind === 'html'" class="fp-btn" :href="frameUrl" target="_blank" rel="noopener noreferrer"
        title="在新标签页全屏预览（同样为沙箱隔离）">↗ 新窗口</a>
      <span class="fp-size">{{ fmtSize(file.size) }}</span>
      <a v-if="isGitee && giteeBlobUrl" class="fp-btn" :href="giteeBlobUrl" target="_blank" rel="noopener noreferrer">在 Gitee 打开</a>
      <button class="fp-btn" title="下载" @click="download"><GhIcon name="download" :size="14" /> 下载</button>
      <button class="fp-btn x" title="关闭预览" @click="emit('close')">✕</button>
    </div>

    <div v-loading="busy || codeLoading" class="fp-body">
      <p v-if="err" class="fp-err">{{ err }}</p>

      <!-- html 渲染态：opaque origin 沙箱（禁 allow-same-origin），脚本可跑但拿不到本站身份 -->
      <iframe v-else-if="kind === 'html' && htmlMode === 'view'" :src="blobUrl" class="fp-html"
        sandbox="allow-scripts allow-popups allow-forms" referrerpolicy="no-referrer" :title="file.name"></iframe>

      <!-- html 源码态：与普通文本同口径，Vue 插值转义 -->
      <template v-else-if="kind === 'html' && htmlMode === 'code'">
        <pre class="fp-pre">{{ text }}</pre>
        <p v-if="truncated" class="fp-trunc">文件较大，仅显示前 512KB —— 完整内容请下载</p>
      </template>

      <template v-else-if="kind === 'text'">
        <!-- 文本：Vue 插值天然转义。**绝不能用 v-html** —— 内容来自其他用户 -->
        <pre class="fp-pre">{{ text }}</pre>
        <p v-if="truncated" class="fp-trunc">文件较大，仅显示前 512KB —— 完整内容请下载</p>
      </template>

      <img v-else-if="kind === 'image'" :src="blobUrl" class="fp-img" :alt="file.name" />
      <iframe v-else-if="kind === 'pdf'" :src="blobUrl" class="fp-pdf" :title="file.name"></iframe>
      <audio v-else-if="kind === 'audio'" :src="blobUrl" controls class="fp-audio"></audio>
      <video v-else-if="kind === 'video'" :src="blobUrl" controls class="fp-video"></video>
      <OfficePreview v-else-if="kind === 'office'" :name="file.name" :blob="officeBlob" height="480px" />

      <div v-else-if="!busy" class="fp-other">
        <p>这类文件不支持页内预览</p>
        <button class="fp-dl" @click="download"><GhIcon name="download" :size="14" /> 下载查看</button>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.fp-wrap {
  border: 1px solid var(--border-2); border-radius: 6px; background: var(--card-bg);
  overflow: hidden; margin-top: 12px;
}
.fp-head {
  display: flex; align-items: center; gap: 8px; padding: 7px 12px;
  background: var(--surface-1); border-bottom: 1px solid var(--border);
  font-size: 12px; color: var(--text-2);
}
.fp-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.fp-size { flex: none; color: var(--text-3); }
.fp-tag {
  flex: none; font-size: 10.5px; line-height: 1.6; padding: 0 6px; border-radius: 999px;
  background: var(--primary-tint); color: var(--primary); border: 1px solid var(--border-2);
}
.fp-btn {
  flex: none; display: inline-flex; align-items: center; gap: 4px;
  border: 1px solid var(--border-2); background: var(--card-bg); color: var(--text-2);
  border-radius: 6px; padding: 2px 8px; font-size: 12px; cursor: pointer; font-family: inherit;
  &:hover { border-color: var(--primary); color: var(--primary); }
  &.x { border: 0; background: transparent; font-size: 14px; padding: 0 2px; }
}
/* 网页/代码分段开关：两钮拼成一组（中间圆角/边框重叠） */
.fp-seg { flex: none; display: inline-flex; .fp-btn { border-radius: 0; margin-left: -1px; }
  .fp-btn:first-child { border-radius: 6px 0 0 6px; margin-left: 0; }
  .fp-btn:last-child { border-radius: 0 6px 6px 0; }
  .fp-btn.on { border-color: var(--primary); color: var(--primary); background: var(--primary-tint); z-index: 1; }
}
.fp-body { min-height: 90px; max-height: 520px; overflow: auto; }
.fp-pre {
  margin: 0; padding: 12px 14px; font-size: 12.5px; line-height: 1.6;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--text); white-space: pre-wrap; word-break: break-word;
}
.fp-trunc { margin: 0; padding: 6px 14px 10px; font-size: 12px; color: var(--text-3); }
.fp-img { display: block; max-width: 100%; margin: 0 auto; }
.fp-pdf { width: 100%; height: 480px; border: 0; background: #fff; }
/* html 沙箱渲染：白底（网页多按白底写）+ 暗主题下显式分隔边 */
.fp-html { width: 100%; height: 480px; border: 0; background: #fff; display: block; }
.fp-audio { display: block; width: 100%; padding: 12px; box-sizing: border-box; }
.fp-video { display: block; max-width: 100%; max-height: 460px; margin: 0 auto; }
.fp-other { padding: 22px; text-align: center; font-size: 13px; color: var(--text-3); }
.fp-dl {
  margin-top: 8px; display: inline-flex; align-items: center; gap: 5px;
  border: 1px solid var(--border-2); background: var(--card-bg); color: var(--text-2);
  border-radius: 6px; padding: 4px 12px; font-size: 12.5px; cursor: pointer; font-family: inherit;
  &:hover { border-color: var(--primary); color: var(--primary); }
}
.fp-err { margin: 0; padding: 18px; text-align: center; font-size: 13px; color: var(--danger-fg, #d1242f); }
</style>
