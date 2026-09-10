<script setup>
// 单条资源详情页（/share/:id、/ghost-share/:id）
// 从 ShareView「点行 → 下方展开 README」改为独立子路由：URL 可分享、可前进后退、
// 大文件夹与正文不再挤在列表下方。
// 取参与加载照 ProfileView.vue 的范式（computed 取参 + watch + onMounted），
// 不跟 /share 共用组件——同组件复用实例时 onMounted 不重跑，从列表点进另一条帖会拿不到新数据。
import { ref, computed, watch, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api.js';
import auth from '../auth.js';
import { normAtts } from './team/AttachmentList.vue';
import { fmtSize } from '../utils/share.js';
import ShareReadme from './share/ShareReadme.vue';
import SharePostDialog from './share/SharePostDialog.vue';
import ShareFileTree from './share/ShareFileTree.vue';
import ShareFilePreview from './share/ShareFilePreview.vue';
import GhIcon from './share/GhIcon.vue';

const router = useRouter();
const route = useRoute();
// ghost 模式：/ghost-share/:id（秘密分享的单帖页），返回与文案走幽灵口径
const props = defineProps({ ghost: { type: Boolean, default: false } });

const listPath = computed(() => (props.ghost ? '/ghost-share' : '/share'));
const id = computed(() => Number(route.params.id));

const cur = ref(null);
const loading = ref(false);
const errMsg = ref('');
const feishuUrl = ref('');
const feishuBusy = ref(false);
const commentSending = ref(false);
const tagList = ref([]);

const isMine = (p) => !!auth.user && (Number(p.author_id) === Number(auth.user.id) || auth.user.is_admin);
const needLogin = () => {
  if (auth.token) return false;
  ElMessage.warning('请先登录');
  router.push(`/login?redirect=${encodeURIComponent(route.fullPath)}`);
  return true;
};

// 唯一 api.sharePost + 唯一 normAtts 调用点：漏掉 normAtts 附件就变回 JSON 字符串
async function fetchPost(idv) {
  const d = await api.sharePost(idv);
  d.attachments = normAtts(d.attachments);
  return d;
}

// 目录树里选中的文件（预览面板的数据源）；换帖时清掉，避免带着上一条帖的文件 id 去取
const selFile = ref(null);

// 两类来源分开算：ZIP 只能打本站磁盘上的文件，Gitee 条目要走仓库代理、不进包
const giteeFiles = computed(() => (cur.value?.files || []).filter((f) => f.source === 'gitee'));
const uploadFiles = computed(() => (cur.value?.files || []).filter((f) => f.source !== 'gitee'));
const giteeHref = computed(() => (cur.value?.gitee_repo ? `https://gitee.com/${cur.value.gitee_repo}` : ''));

// 「同步」把仓库最新文件树拉下来覆盖（作者/管理员；限流或仓库改名会失败，提示原样透出）
const giteeBusy = ref(false);
async function syncGitee() {
  if (!cur.value || giteeBusy.value) return;
  giteeBusy.value = true;
  try {
    const r = await api.shareGiteeSync(cur.value.id, cur.value.gitee_repo, cur.value.gitee_ref);
    ElMessage.success(`已同步 ${r.count} 个文件`);
    if (selFile.value) selFile.value = null; // 行被整树替换了，旧选中项的 id 已失效
    await load();
  } catch (e) { ElMessage.error(e.message); } finally { giteeBusy.value = false; }
}

async function load() {
  const idv = id.value;
  if (!idv) { errMsg.value = '资源不存在'; cur.value = null; return; }
  loading.value = true;
  errMsg.value = '';
  selFile.value = null;
  try {
    cur.value = await fetchPost(idv);
    // 嵌入式查看：查该帖是否已关联飞书文档（有则显示直达链接）
    if (auth.token) {
      api.feishuBizStatus('share_post', idv).then((s) => { if (s?.mapped) feishuUrl.value = s.doc_url; }).catch(() => {});
    }
  } catch (e) {
    cur.value = null;
    errMsg.value = e.message; // 就地渲染（已删/幽灵帖对普通用户同语义 404），不弹 toast、不整页清空
  } finally {
    loading.value = false;
  }
}
async function loadTags() {
  try { tagList.value = await api.shareTags(); } catch { /* 标签加载失败不影响正文 */ }
}

// 本页只有一份数据（cur），不像列表页那样要同时写 rows + cur 两处
const applyActs = (patch) => { if (cur.value) Object.assign(cur.value, patch); };

async function toggleLike(p) {
  if (needLogin()) return;
  try {
    const r = await api.shareLike(p.id);
    applyActs({ is_liked: r.liked ? 1 : 0, like_count: r.count });
  } catch (e) { ElMessage.error(e.message); }
}
async function toggleFav(p) {
  if (needLogin()) return;
  try {
    const r = await api.shareFav(p.id);
    applyActs({ is_faved: r.faved ? 1 : 0, fav_count: r.count });
  } catch (e) { ElMessage.error(e.message); }
}

async function sendComment(text) {
  if (!cur.value || needLogin()) return;
  commentSending.value = true;
  try {
    const c = await api.shareComment(cur.value.id, text);
    (cur.value.comments ||= []).push(c);
    applyActs({ comment_count: (cur.value.comment_count || 0) + 1 });
  } catch (e) { ElMessage.error(e.message); } finally { commentSending.value = false; }
}
async function delComment(c) {
  try {
    await api.shareCommentDelete(c.id);
    cur.value.comments = cur.value.comments.filter((x) => x.id !== c.id);
    applyActs({ comment_count: Math.max(0, (cur.value.comment_count || 0) - 1) });
    ElMessage.success('评论已删除');
  } catch (e) { ElMessage.error(e.message); }
}

async function delPost(p) {
  try {
    await ElMessageBox.confirm(`删除帖子「${p.title}」？评论与点赞收藏将一并删除`, '删除帖子', { type: 'warning' });
  } catch { return; }
  try {
    await api.shareDelete(p.id);
    ElMessage.success('帖子已删除');
    router.push(listPath.value); // 帖子没了，留在详情页就是死链
  } catch (e) { ElMessage.error(e.message); }
}

// —— 编辑弹窗（与列表页共用 SharePostDialog）——
const postDlg = ref(false);
const editing = ref(null);
function openEdit(p) {
  if (!isMine(p)) return;
  editing.value = p;
  postDlg.value = true;
}
// 弹窗里发生的任何后端变更（提交/飞书编辑/飞书同步/从飞书导入）→ 刷新本页这份数据
async function onDialogChanged({ id: pid, isNew }) {
  await loadTags();
  if (!cur.value || Number(cur.value.id) === Number(pid) || isNew) {
    if (isNew) { router.replace(`${listPath.value}/${pid}`); return; } // 弹窗里新建的 → 直接落到它自己的页
    await load();
  }
}

watch(id, load);
onMounted(() => { load(); loadTags(); });
</script>

<template>
  <main class="sharep-page">
    <!-- 面包屑：仓库头 → 当前资源，返回入口放最左 -->
    <header class="gh-crumb-wrap">
      <button class="gh-back" @click="router.push(listPath)">
        <GhIcon name="arrow-left" :size="14" /> {{ ghost ? '返回秘密分享' : '返回资源分享' }}
      </button>
      <div class="gh-crumb">
        <GhIcon name="book" :size="16" />
        <span class="gh-owner">Engineer-Compass</span>
        <span class="gh-sep">/</span>
        <b>{{ ghost ? '秘密分享' : '资源分享' }}</b>
        <span class="gh-sep">/</span>
        <span class="gh-cur">{{ cur?.title || (loading ? '加载中…' : '资源不存在') }}</span>
      </div>
    </header>

    <div class="gh-body">
      <div class="gh-main">
        <!-- 项目文件夹（一条帖子 = 一个项目）：树在上、正文在下，点文件就地预览 -->
        <ShareFileTree
          v-if="cur?.files?.length" :files="cur.files" :selected-id="selFile?.id"
          class="gh-tree" @select="selFile = $event"
        />
        <ShareFilePreview
          v-if="selFile" :file="selFile" :repo="cur?.gitee_repo || ''" :ref-name="cur?.gitee_ref || ''"
          @close="selFile = null"
        />
        <ShareReadme
          standalone :post="cur" :loading="loading" :error="errMsg" :sending="commentSending"
          :feishu-busy="feishuBusy" :feishu-url="feishuUrl" :ghost-page="ghost"
          @like="toggleLike" @fav="toggleFav" @comment="sendComment" @del-comment="delComment"
          @edit="openEdit" @del="delPost" @close="router.push(listPath)"
        />
      </div>

      <aside class="gh-aside">
        <div class="gh-abox">
          <div class="gh-ahead">About</div>
          <p class="gh-atext">
            {{ ghost ? '幽灵帖仅幽灵账号可见，普通用户完全看不到这里的内容。' : '这条资源的正文、附件与讨论都在左侧。' }}
          </p>
          <p v-if="uploadFiles.length" class="gh-atext">
            项目文件夹：<b>{{ uploadFiles.length }}</b> 个文件 · {{ fmtSize(uploadFiles.reduce((s, f) => s + (Number(f.size) || 0), 0)) }}
          </p>
          <p v-if="giteeFiles.length" class="gh-atext">
            Gitee 仓库：<b>{{ giteeFiles.length }}</b> 个文件
          </p>
          <p class="gh-atext dim">
            想要更长的正文？作者可以用「飞书编辑」在飞书里写长文再同步回来。
          </p>
        </div>
        <!-- Gitee 仓库：文件树是从仓库拉的快照，点「同步」可刷新；打开原仓库在新标签页 -->
        <div v-if="cur?.gitee_repo" class="gh-abox">
          <div class="gh-ahead">Gitee 仓库</div>
          <a class="gh-zip" :href="giteeHref" target="_blank" rel="noopener noreferrer">
            <GhIcon name="repo" :size="14" /> {{ cur.gitee_repo }}
          </a>
          <p class="gh-atext dim" style="margin-top:8px">
            {{ cur.gitee_ref ? `分支/标签：${cur.gitee_ref}` : '默认分支' }} · 文件树是拉取时的快照
          </p>
          <button v-if="isMine(cur)" class="gh-zip" :disabled="giteeBusy" style="margin-top:8px" @click="syncGitee">
            {{ giteeBusy ? '同步中…' : '↻ 同步仓库' }}
          </button>
        </div>
        <!-- 整包下载：浏览器直连，公开帖匿名也能下；文件夹原样成 ZIP 目录 -->
        <div v-if="uploadFiles.length" class="gh-abox">
          <div class="gh-ahead">Download</div>
          <a class="gh-zip" :href="api.shareZipUrl(cur.id)" download>
            <GhIcon name="download" :size="14" /> 下载整个项目（ZIP）
          </a>
          <p class="gh-atext dim" style="margin-top:8px">ZIP 里保留原目录结构；Gitee 仓库条目不含在内。</p>
        </div>
        <div v-if="cur?.tags?.length" class="gh-abox">
          <div class="gh-ahead">Topics</div>
          <div class="gh-topics">
            <button v-for="t in cur.tags" :key="t" class="gh-topic" @click="router.push(listPath)">{{ t }}</button>
          </div>
        </div>
      </aside>
    </div>

    <SharePostDialog v-model="postDlg" :editing="editing" :tag-list="tagList" :ghost="ghost" @changed="onDialogChanged" />
  </main>
</template>

<style lang="scss" scoped>
// 与列表页同源的仓库页观感（列表页那份是 scoped，这里需要自己一份；变量全部走主题变量，暗色自动跟随）
.sharep-page { padding: 20px 24px 60px; max-width: 1180px; margin: 0 auto; }

.gh-crumb-wrap { margin-bottom: 14px; }
.gh-back {
  display: inline-flex; align-items: center; gap: 5px; margin-bottom: 10px;
  border: 1px solid var(--border-2); background: var(--card-bg); color: var(--text-2);
  border-radius: 6px; padding: 4px 12px; font-size: 12.5px; cursor: pointer; font-family: inherit;
  &:hover { border-color: var(--primary); color: var(--primary); }
}
.gh-crumb {
  display: flex; align-items: center; gap: 7px; font-size: 18px; color: var(--text-2);
  flex-wrap: wrap;
  .gh-owner { color: var(--primary); cursor: default; }
  .gh-sep { color: var(--text-3); }
  b { color: var(--primary); font-weight: 600; }
  .gh-cur {
    color: var(--text); font-weight: 600; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
}

.gh-body { display: grid; grid-template-columns: minmax(0, 1fr) 288px; gap: 18px; align-items: start; }
.gh-main { min-width: 0; }
.gh-tree { margin-bottom: 16px; }

.gh-zip {
  display: inline-flex; align-items: center; gap: 6px; text-decoration: none;
  border: 1px solid var(--border-2); background: var(--card-bg); color: var(--text-2);
  border-radius: 6px; padding: 4px 12px; font-size: 12.5px;
  &:hover { border-color: var(--primary); color: var(--primary); }
  // 同一套外观也用在 <button> 上（同步仓库），按钮要额外补字体与禁用态
  &[disabled] { opacity: .6; cursor: default; &:hover { border-color: var(--border-2); color: var(--text-2); } }
}
button.gh-zip { font-family: inherit; cursor: pointer; }

.gh-aside { display: flex; flex-direction: column; gap: 12px; }
.gh-abox {
  border: 1px solid var(--border-2); border-radius: 6px; background: var(--card-bg);
  padding: 12px 14px;
}
.gh-ahead { font-size: 13px; font-weight: 600; color: var(--text); margin-bottom: 8px; }
.gh-atext {
  margin: 0 0 8px; font-size: 12.5px; line-height: 1.6; color: var(--text-2);
  &.dim { color: var(--text-3); margin-bottom: 0; }
}
.gh-topics { display: flex; flex-wrap: wrap; gap: 6px; }
.gh-topic {
  border: 1px solid var(--border-2); background: var(--primary-tint); color: var(--primary);
  border-radius: 999px; padding: 1px 10px; font-size: 11.5px; cursor: pointer; font-family: inherit;
  &:hover { border-color: var(--primary); }
}

@media (max-width: 900px) {
  .gh-body { grid-template-columns: minmax(0, 1fr); }
  .gh-aside { order: -1; }
}
@media (max-width: 768px) {
  .sharep-page { padding: 14px 12px 60px; }
  .gh-crumb { font-size: 16px; }
}
</style>
