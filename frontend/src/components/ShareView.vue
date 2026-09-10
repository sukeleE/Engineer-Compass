<script setup>
// 资源分享（GitHub 仓库页形态）：仓库头 + 标签页 + 文件表 + README 框 + About 侧栏
// 一条帖子 = 文件表里的一行；点行 → 下方 README 框展开该帖正文/附件/讨论（不再弹详情弹窗）
// tabs：资源(全部) / 我的帖子 / 我的收藏 —— 复用后端已有的 scope=mine|favs
// 幽灵页（/ghost-share）：只留「资源」一个静态标签 + 排序，不发 scope（scope 会绕过幽灵隔离）
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api.js';
import auth from '../auth.js';
import RichEditor from './team/RichEditor.vue';
import DocPicker from './team/DocPicker.vue';
import { normAtts } from './team/AttachmentList.vue';
import ResourcePicker from './ResourcePicker.vue';
import ShareFileTable from './share/ShareFileTable.vue';
import ShareReadme from './share/ShareReadme.vue';
import GhIcon from './share/GhIcon.vue';

const router = useRouter();
const route = useRoute();
// ghost 模式（/ghost-share 秘密分享页）：只显示幽灵帖、发帖恒为幽灵帖；普通分享页幽灵用户发帖默认也发幽灵帖
const props = defineProps({ ghost: { type: Boolean, default: false } });
const toProfile = (uid) => router.push(Number(uid) === Number(auth.user?.id) ? '/me' : `/user/${uid}`);

// —— 视图：标签页 + 排序 + 标签子板块 + 分页 ——
const TABS = [
  { key: 'all', full: '📄 资源', short: '资源' },
  { key: 'mine', full: '📝 我的帖子', short: '帖子' },
  { key: 'favs', full: '⭐ 我的收藏', short: '收藏' },
];
const tab = ref('all');
const scope = computed(() => (props.ghost || tab.value === 'all' ? '' : tab.value)); // 幽灵页恒不发 scope
const SORTS = [
  { key: 'hot', full: '🔥 最热门', short: '最热' },
  { key: 'new', full: '🕐 最新', short: '最新' },
  { key: 'fav', full: '⭐ 收藏最高', short: '收藏' },
];
const sort = ref('hot');
const tag = ref('');
const page = ref(1);
const size = 10;
const rows = ref([]);
const total = ref(0);
const stats = ref({ posts: 0, likes: 0, favs: 0, comments: 0 }); // 仓库头徽标；首屏 load 前即可安全渲染
const loading = ref(false);
const tagList = ref([]);
const filterText = ref(''); // 文件表筛选框（只筛当前页，后端无搜索接口）

// matchMedia 监听用具名函数 + onBeforeUnmount 移除（旧实现传匿名函数，切路由会累积监听器）
const mqNarrow = window.matchMedia('(max-width: 768px)');
const isNarrow = ref(mqNarrow.matches);
const onMq = (e) => { isNarrow.value = e.matches; };
onMounted(() => mqNarrow.addEventListener('change', onMq));
onBeforeUnmount(() => mqNarrow.removeEventListener('change', onMq));
const tabLabel = (t) => (isNarrow.value ? t.short : t.full);
const sortLabel = (s) => (isNarrow.value ? s.short : s.full);

async function load() {
  loading.value = true;
  try {
    const data = await api.sharePosts({
      sort: sort.value, tag: tag.value, page: page.value, size,
      ...(scope.value ? { scope: scope.value } : {}),
      ...(props.ghost ? { ghost: 1 } : {}),
    });
    rows.value = data.rows;
    total.value = data.total;
    if (data.stats) stats.value = data.stats;
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}
async function loadTags() {
  try { tagList.value = await api.shareTags(); } catch { /* 标签加载失败不阻塞列表 */ }
}

// 切「我的帖子/我的收藏」：未登录后端必 401 → 提前拦截并引导，且**不切 tab**（否决式）
function changeTab(k) {
  if (k === tab.value) return;
  if (k !== 'all' && needLogin()) return;
  tab.value = k;
  page.value = 1;
  load();
}
function changeSort(v) { sort.value = v; page.value = 1; load(); }
function pickTag(t) { tag.value = t; page.value = 1; load(); }
function onPage(v) { page.value = v; load(); }

const isMine = (p) => !!auth.user && (Number(p.author_id) === Number(auth.user.id) || auth.user.is_admin);
const needLogin = () => {
  if (auth.token) return false;
  ElMessage.warning('请先登录');
  router.push('/login?redirect=/share');
  return true;
};

// —— 选中态（README 区）——
// 选中帖一律按 id 直拉详情：它可能不在当前页/当前 tab 的列表里（消息通知、我的收藏点进来），
// 评论也只有详情接口返回 —— 所以不能改成「从列表行取」。
const selId = ref(null);
const cur = ref(null);
const curLoading = ref(false);
const curError = ref('');
const feishuUrl = ref('');
const readmeRef = ref(null);

// 唯一 api.sharePost + 唯一 normAtts 调用点（4 处刷新都走它，漏一处附件就变回 JSON 字符串）
// normAtts 对数组入参返回同一引用 → 详情对象是「活」的，父层 applyActs 同步计数才有意义
async function fetchPost(id) {
  const d = await api.sharePost(id);
  d.attachments = normAtts(d.attachments);
  return d;
}
async function selectPost(id) {
  selId.value = Number(id);
  curLoading.value = true;
  curError.value = '';
  feishuUrl.value = '';
  try {
    cur.value = await fetchPost(id);
    // 嵌入式查看：查该帖是否已关联飞书文档（有则显示直达链接）
    if (auth.token) {
      api.feishuBizStatus('share_post', id).then((s) => { if (s?.mapped) feishuUrl.value = s.doc_url; }).catch(() => {});
    }
    await nextTick();
    scrollToReadme();
  } catch (e) {
    cur.value = null;
    curError.value = e.message; // 就地渲染（深链指向已删/无权帖），不弹 toast、不整页清空
  } finally {
    curLoading.value = false;
  }
}
function scrollToReadme() {
  const el = readmeRef.value?.$el;
  if (!el) return;
  // 只在 README 大半在屏幕外时才滚，避免小幅跳动
  if (el.getBoundingClientRect().top > window.innerHeight * 0.5) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// 点行：URL 是选中态的持久化载体，但必须「先本地生效」——
// 目标 URL 与当前完全相同时 vue-router 会去重、watch 不触发，此时要能刷新/重试（否则像「点了没反应」）
function pickRow(id) {
  if (Number(route.query.post) === Number(id)) { selectPost(id); return; }
  router.replace({ query: { ...route.query, post: String(id) } }).catch(() => {});
}
function closeReadme() {
  selId.value = null;
  cur.value = null;
  curError.value = '';
  feishuUrl.value = '';
  router.replace({ query: { ...route.query, post: undefined } }).catch(() => {});
}
// 深链 / 站内二次跳转 / 浏览器前进后退统一入口（immediate 覆盖首次挂载）
function applyQueryPost(v) {
  const id = Number(v);
  if (!id) {
    selId.value = null; cur.value = null; curError.value = ''; feishuUrl.value = '';
    return;
  }
  if (Number(selId.value) === id && cur.value) { scrollToReadme(); return; }
  selectPost(id);
}
watch(() => route.query.post, applyQueryPost, { immediate: true });

// —— 列表与 README 是两个数据持有者，任何计数/标志变更必须同时写，否则两处数字会对不上 ——
function applyActs(id, patch) {
  const n = Number(id);
  const r = rows.value.find((x) => Number(x.id) === n);
  if (r) Object.assign(r, patch);
  if (Number(cur.value?.id) === n) Object.assign(cur.value, patch);
}

// —— 点赞 / 收藏（toggle，乐观更新） ——
async function toggleLike(p, ev) {
  if (ev?.stopPropagation) ev.stopPropagation();
  if (needLogin()) return;
  try {
    const r = await api.shareLike(p.id);
    applyActs(p.id, { is_liked: r.liked ? 1 : 0, like_count: r.count });
    stats.value.likes += r.liked ? 1 : -1; // 头部徽标同步
  } catch (e) { ElMessage.error(e.message); }
}
async function toggleFav(p, ev) {
  if (ev?.stopPropagation) ev.stopPropagation();
  if (needLogin()) return;
  try {
    const r = await api.shareFav(p.id);
    applyActs(p.id, { is_faved: r.faved ? 1 : 0, fav_count: r.count });
    stats.value.favs += r.faved ? 1 : -1;
  } catch (e) { ElMessage.error(e.message); }
}

// —— 评论 ——
const commentSending = ref(false);
async function sendComment(text) {
  if (!cur.value || needLogin()) return;
  commentSending.value = true;
  try {
    const c = await api.shareComment(cur.value.id, text);
    (cur.value.comments ||= []).push(c);
    applyActs(cur.value.id, { comment_count: (cur.value.comment_count || 0) + 1 });
    stats.value.comments += 1;
  } catch (e) { ElMessage.error(e.message); } finally { commentSending.value = false; }
}
async function delComment(c) {
  try {
    await api.shareCommentDelete(c.id);
    cur.value.comments = cur.value.comments.filter((x) => x.id !== c.id);
    applyActs(cur.value.id, { comment_count: Math.max(0, (cur.value.comment_count || 0) - 1) });
    stats.value.comments = Math.max(0, stats.value.comments - 1);
    ElMessage.success('评论已删除');
  } catch (e) { ElMessage.error(e.message); }
}

async function delPost(p) {
  try {
    await ElMessageBox.confirm(`删除帖子「${p.title}」？评论与点赞收藏将一并删除`, '删除帖子', { type: 'warning' });
  } catch { return; }
  try {
    await api.shareDelete(p.id);
    // 选中态与 URL 一起清：否则刷新还会去拉一个已删帖
    if (Number(selId.value) === Number(p.id)) closeReadme();
    ElMessage.success('帖子已删除');
    await load(); await loadTags();
    stats.value.posts = Math.max(0, stats.value.posts - 1);
  } catch (e) { ElMessage.error(e.message); }
}

// —— 发帖 / 编辑弹窗 ——
const postDlg = ref(false);
const editingId = ref(null);
const form = ref({ title: '', content: '', atts: [], tags: [], isGhost: true }); // isGhost：幽灵用户发帖默认「仅怪奇可见」
const fileInput = ref(null);
const MAX_ATT_TOTAL = 25 * 1024 * 1024;
const attPick = (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  for (const f of files) {
    if (f.size > 10 * 1024 * 1024) { ElMessage.warning(`「${f.name}」超过 10MB 上限`); continue; }
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result).split(',')[1];
      const total2 = form.value.atts.reduce((s, a) => s + (a.data || '').length, 0) + data.length;
      if (total2 > MAX_ATT_TOTAL) { ElMessage.warning('附件总量超限（≤25MB）'); return; }
      form.value.atts.push({ name: f.name, size: f.size, mime: f.type || 'application/octet-stream', data });
    };
    reader.readAsDataURL(f);
  }
};
// 从「我的资源」引用：选中后生成/复用分享链接，push 引用型附件条目（无 data 有 url）
const resPickDlg = ref(false);
const impDlg = ref(false);   // 从飞书导入文档选择器
const onResourcePick = (r) => {
  form.value.atts.push({ name: r.name, size: r.size, mime: r.mime, url: r.url });
  ElMessage.success(`已引用「${r.name}」`);
};
function openNew() {
  if (needLogin()) return;
  editingId.value = null;
  form.value = { title: '', content: '', atts: [], tags: [], isGhost: true };
  feishuOpened.value = false;
  postDlg.value = true;
}
function openEdit(p) {
  if (!isMine(p)) return;
  editingId.value = p.id;
  feishuOpened.value = false;
  // 必须浅拷贝：normAtts 对数组入参返回**同一引用**，直接赋值会让编辑器的附件数组
  // 与 README/列表里那份是同一个 —— 删个 chip 就当场改掉了背后的帖子，取消也回滚不了
  const atts = normAtts(p.attachments).map((a) => ({ ...a }));
  form.value = { title: p.title, content: p.content, atts, tags: [...(p.tags || [])], isGhost: true };
  postDlg.value = true;
}
async function submit() {
  if (!form.value.title.trim()) return ElMessage.warning('标题必填');
  const text = form.value.content.replace(/<[^>]*>/g, '').trim();
  if (!text && !form.value.atts.length) return ElMessage.warning('写点内容或附上资源');
  try {
    if (editingId.value) {
      await api.shareUpdate(editingId.value, { title: form.value.title, content: form.value.content, attachments: form.value.atts, tags: form.value.tags });
      ElMessage.success('帖子已更新');
    } else {
      // 幽灵帖归属：秘密分享页恒为幽灵帖；普通页幽灵用户由「仅怪奇可见」勾选决定；普通用户恒普通帖
      const isGhost = props.ghost ? 1 : (auth.user?.is_ghost ? (form.value.isGhost ? 1 : 0) : 0);
      await api.shareCreate({ title: form.value.title, content: form.value.content, attachments: form.value.atts, tags: form.value.tags, is_ghost: isGhost });
      ElMessage.success(props.ghost ? '👻 秘密帖子发布成功' : '🚀 开楼成功');
      stats.value.posts += 1;
    }
    postDlg.value = false;
    await load(); await loadTags();
    // README 正显示这条帖时同步刷新（编辑的正是当前查看的）
    if (cur.value?.id === editingId.value) cur.value = await fetchPost(editingId.value);
  } catch (e) { ElMessage.error(e.message); }
}

// —— 飞书编辑（P1）：分享帖 ↔ 飞书文档 ——
// 「飞书编辑」= 创建/打开飞书文档（新建自动带存量内容 + 自动同步回库）；「从飞书同步」= 手动拉取最新
const feishuBusy = ref(false);
const feishuOpened = ref(false); // 本次编辑已打开飞书（显示「飞书编辑中」状态条）
async function feishuEdit(p) {
  let pid = p?.id || editingId.value;
  // 新建帖尚未发布：有草稿先发布创建帖子拿 id；空内容直接让后端自动创建（share_post 需 title）
  if (!pid) {
    if (!form.value.title.trim()) return ElMessage.warning('先填标题，再转飞书编辑');
    const text = form.value.content.replace(/<[^>]*>/g, '').trim();
    if (text || form.value.atts.length) {
      try {
        const r = await api.shareCreate({ title: form.value.title, content: form.value.content, attachments: form.value.atts, tags: form.value.tags });
        pid = r.id;
        editingId.value = pid;
        await load();
      } catch (e) { ElMessage.error(e.message); return; }
    }
  }
  feishuBusy.value = true;
  try {
    const r = await api.feishuBizOpen('share_post', pid ?? null, { title: form.value.title });
    feishuUrl.value = r.url || '';
    feishuOpened.value = true;
    window.open(r.url, '_blank');
    ElMessage.success(r.created ? '已创建飞书文档并打开，可在飞书里完善内容' : '已同步最新内容，飞书文档已打开');
    if (cur.value?.id === pid) cur.value = await fetchPost(pid);
  } catch (e) { ElMessage.error(e.message); }
  finally { feishuBusy.value = false; }
}

// 从飞书导入：内容回填编辑器；无帖子时后端自动创建（id 绑定编辑态，提交走更新而非新建）
function onImported(html, id) {
  form.value.content = html;
  if (id) editingId.value = id;
  load();
}
async function feishuSync(p) {
  const pid = p?.id || editingId.value;
  if (!pid) return ElMessage.warning('请先发布帖子或点「飞书编辑」创建文档');
  feishuBusy.value = true;
  try {
    const r = await api.feishuBizSync('share_post', pid);
    ElMessage.success(r.message || '✅ 已从飞书同步');
    if (cur.value?.id === pid) cur.value = await fetchPost(pid);
  } catch (e) { ElMessage.error(e.message); }
  finally { feishuBusy.value = false; }
}

const emptyText = computed(() => (tag.value
  ? `「${tag.value}」子板块还没有帖子，来开第一楼`
  : (props.ghost ? '还没有秘密帖子，来开第一座幽灵楼' : '还没有帖子，点「开楼发帖」分享第一个资源')));
const inList = computed(() => !!cur.value && rows.value.some((r) => Number(r.id) === Number(cur.value.id)));

onMounted(() => { load(); loadTags(); });
</script>

<template>
  <main class="share-page">
    <!-- 仓库头：面包屑 + 标题 + 描述 + 徽标 + 主按钮 -->
    <header class="gh-repohead">
      <div class="gh-crumb">
        <GhIcon name="book" :size="16" />
        <span class="gh-owner">Engineer-Compass</span>
        <span class="gh-sep">/</span>
        <b>{{ props.ghost ? '秘密分享' : '资源分享' }}</b>
        <span class="gh-vis">{{ props.ghost ? '🔒 仅怪奇可见' : '公开' }}</span>
      </div>
      <p class="gh-desc">{{ props.ghost ? '怪奇小队专属领地：幽灵帖仅幽灵可见，普通世界完全无痕' : '贴吧式交流区：分享资料/经验/作品，图文视频音频文件' }}</p>
      <div class="gh-headrow">
        <div class="gh-badges">
          <span class="gh-badge"><GhIcon name="file" :size="14" /> {{ stats.posts }} 个资源</span>
          <span class="gh-badge"><GhIcon name="thumbsup" :size="14" /> {{ stats.likes }}</span>
          <span class="gh-badge"><GhIcon name="star" :size="14" /> {{ stats.favs }}</span>
          <span class="gh-badge"><GhIcon name="comment" :size="14" /> {{ stats.comments }}</span>
          <span class="gh-badge"><GhIcon name="tag" :size="14" /> {{ tagList.length }} 个标签</span>
        </div>
        <el-button type="primary" @click="openNew">{{ props.ghost ? '👻 开幽灵帖' : '📝 开楼发帖' }}</el-button>
      </div>
    </header>

    <!-- 标签页条（幽灵页只留一个静态标签：scope 非空会绕过幽灵隔离，混进普通帖） -->
    <div class="gh-tabbar">
      <nav class="gh-tabs" role="tablist">
        <template v-if="props.ghost">
          <span class="gh-tab on static" role="tab" aria-selected="true">👻 秘密帖子</span>
        </template>
        <template v-else>
          <button
            v-for="t in TABS" :key="t.key" class="gh-tab" :class="{ on: tab === t.key }"
            role="tab" :aria-selected="tab === t.key" @click="changeTab(t.key)"
          >{{ tabLabel(t) }}</button>
        </template>
      </nav>
      <el-dropdown trigger="click" @command="changeSort">
        <button class="gh-sortbtn">{{ sortLabel(SORTS.find((s) => s.key === sort)) }} <GhIcon name="chevron-down" :size="14" /></button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item v-for="s in SORTS" :key="s.key" :command="s.key" :disabled="s.key === sort">{{ sortLabel(s) }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>

    <!-- 两栏主体：左 = 文件表 + README；右 = About -->
    <div class="gh-body">
      <div class="gh-main">
        <!-- 标签过滤条（选中标签时出现，可一键清除） -->
        <div v-if="tag" class="gh-filterbar">
          正在筛选子板块 <b>#{{ tag }}</b>
          <button class="gh-filterx" @click="pickTag('')">清除 ×</button>
        </div>

        <ShareFileTable
          v-model:filter="filterText" :rows="rows" :selected-id="selId" :loading="loading"
          :empty-text="emptyText"
          @select="pickRow" @like="toggleLike" @fav="toggleFav"
        />

        <el-pagination v-if="total > size" class="gh-pager" background layout="prev, pager, next" :total="total"
          :page-size="size" :current-page="page" @current-change="onPage" />

        <div ref="readmeRef">
          <ShareReadme
            :post="cur" :loading="curLoading" :error="curError" :in-list="inList" :sending="commentSending"
            :feishu-busy="feishuBusy" :feishu-url="feishuUrl" :ghost-page="props.ghost"
            @like="toggleLike" @fav="toggleFav" @comment="sendComment" @del-comment="delComment"
            @edit="openEdit" @del="delPost" @feishu-edit="feishuEdit" @feishu-sync="feishuSync" @close="closeReadme"
          />
        </div>
      </div>

      <!-- About 侧栏：说明 + Topics（标签过滤的唯一入口） -->
      <aside class="gh-aside">
        <div class="gh-abox">
          <div class="gh-ahead">About</div>
          <p class="gh-atext">{{ props.ghost ? '幽灵帖仅幽灵账号可见，普通用户完全看不到这里的内容。' : '分享备赛资料、经验与作品。一条帖子就是一行资源，点行在下方展开正文与讨论。' }}</p>
        </div>
        <div class="gh-abox">
          <div class="gh-ahead">Topics</div>
          <div class="gh-topics">
            <button class="gh-topic" :class="{ on: tag === '' }" @click="pickTag('')">全部</button>
            <button v-for="t in tagList" :key="t.name" class="gh-topic" :class="{ on: tag === t.name }" @click="pickTag(t.name)">
              {{ t.name }} <i>{{ t.count }}</i>
            </button>
          </div>
          <p v-if="!tagList.length" class="gh-atext dim">还没有标签，发帖时填一个即成为子板块</p>
        </div>
      </aside>
    </div>

    <!-- 发帖 / 编辑弹窗（结构保持原样：App.vue 的 .editor-dlg .el-dialog__body > .el-select 是直接子元素选择器） -->
    <el-dialog v-model="postDlg" :title="editingId ? '✏️ 编辑帖子' : '📝 开楼发帖'" width="720px" top="3vh"
      class="editor-dlg" :close-on-click-modal="false" destroy-on-close append-to-body>
      <el-input v-model="form.title" maxlength="60" show-word-limit placeholder="帖子标题（≤60 字）" class="sh-title" />
      <div class="sh-tools">
        <input ref="fileInput" type="file" multiple hidden @change="attPick" />
        <el-button size="small" @click="fileInput.click()">📎 附件（图片/视频/音频/文件）</el-button>
        <el-button size="small" plain @click="resPickDlg = true">📁 我的资源</el-button>
        <span v-if="form.atts.length" class="att-chips">
          <el-tag v-for="(a, i) in form.atts" :key="i" closable size="small" class="att-tag" :title="a.name"
            @close="form.atts.splice(i, 1)">
            {{ a.name }}
          </el-tag>
        </span>
      </div>
      <!-- 可切到飞书文档里写长文（P1）；新建帖点按钮自动发布后再编辑；打开后本站留窗显示状态条 -->
      <div class="sh-tools" style="margin-bottom:6px">
        <el-button size="small" type="primary" plain :loading="feishuBusy" @click="feishuEdit({ id: editingId })">✏️ 飞书编辑（长文在飞书写）</el-button>
        <el-button size="small" plain :loading="feishuBusy" @click="feishuSync({ id: editingId })">🔄 从飞书同步</el-button>
        <el-button size="small" plain @click="impDlg = true">📥 从飞书导入</el-button>
      </div>
      <div v-if="feishuOpened" class="pd-feishu-open">
        ✅ 已在飞书打开该文档 — 在飞书写完后点「🔄 从飞书同步」更新到这里
      </div>
      <RichEditor v-model="form.content" placeholder="分享资料说明 / 备赛经验 / 作品展示…" />
      <el-select v-model="form.tags" multiple filterable allow-create default-first-option :multiple-limit="5"
        placeholder="索引标签（≤5 个，自建即成为子板块）" class="sh-tags">
        <el-option v-for="t in tagList" :key="t.name" :value="t.name" :label="`#${t.name}`" />
      </el-select>
      <!-- 幽灵用户发帖归属（秘密分享页恒为幽灵帖，无需勾选） -->
      <el-checkbox v-if="!props.ghost && auth.user?.is_ghost" v-model="form.isGhost" class="sh-ghost-chk">
        👻 仅怪奇可见（幽灵帖，普通用户看不到）
      </el-checkbox>
      <template #footer>
        <el-button @click="postDlg = false">取消</el-button>
        <el-button type="primary" @click="submit">{{ editingId ? '保存修改' : '发布' }}</el-button>
      </template>
    </el-dialog>
    <!-- 从飞书导入文档选择器（必须挂弹窗外面——弹窗 destroy-on-close 会销毁内部组件，导入按钮将无反应） -->
    <DocPicker v-model="impDlg" biz-type="share_post" :biz-id="editingId ?? null"
      :extra="{ title: form.title }" @imported="onImported" />
    <ResourcePicker v-model="resPickDlg" @pick="onResourcePick" />
  </main>
</template>

<style lang="scss" scoped>
.share-page { padding: 20px 24px 60px; max-width: 1180px; margin: 0 auto; }

// —— 仓库头 ——
.gh-repohead { margin-bottom: 14px; }
.gh-crumb {
  display: flex; align-items: center; gap: 7px; font-size: 18px; color: var(--text-2);
  .gh-owner { color: var(--primary); cursor: default; }
  .gh-sep { color: var(--text-3); }
  b { color: var(--primary); font-weight: 600; }
  .gh-vis {
    margin-left: 6px; font-size: 11.5px; color: var(--text-2);
    border: 1px solid var(--border-2); border-radius: 999px; padding: 1px 9px;
  }
}
.gh-desc { margin: 6px 0 10px; color: var(--text-2); font-size: 13px; }
.gh-headrow { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.gh-badges { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.gh-badge {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 12.5px; color: var(--text-2);
  b { color: var(--text); }
}

// —— 标签页条：底边线通栏，页签压在线上（GitHub 的 repo 导航形态） ——
.gh-tabbar {
  display: flex; align-items: flex-end; justify-content: space-between; gap: 10px;
  border-bottom: 1px solid var(--border-2); margin-bottom: 16px;
}
.gh-tabs { display: flex; gap: 2px; overflow-x: auto; scrollbar-width: none;
  &::-webkit-scrollbar { display: none; }
}
.gh-tab {
  border: 0; background: transparent; cursor: pointer; font-family: inherit;
  padding: 8px 12px; font-size: 13.5px; color: var(--text-2); white-space: nowrap;
  border-bottom: 2px solid transparent; margin-bottom: -1px; transition: color .15s;
  &:hover { color: var(--text); }
  &.on { color: var(--text); font-weight: 600; border-bottom-color: var(--primary); }
  &.static { cursor: default; }
}
.gh-sortbtn {
  display: inline-flex; align-items: center; gap: 5px; flex: none;
  border: 1px solid var(--border-2); background: var(--card-bg); color: var(--text-2);
  border-radius: 6px; padding: 4px 10px; font-size: 12.5px; cursor: pointer; font-family: inherit;
  margin-bottom: 8px;
  &:hover { border-color: var(--primary); color: var(--primary); }
}

// —— 两栏主体 ——
.gh-body { display: grid; grid-template-columns: minmax(0, 1fr) 288px; gap: 20px; align-items: start; }
.gh-main { min-width: 0; }

.gh-filterbar {
  display: flex; align-items: center; gap: 8px; margin-bottom: 10px;
  font-size: 12.5px; color: var(--text-2);
  b { color: var(--primary); }
  .gh-filterx {
    margin-left: auto; border: 1px solid var(--border-2); background: var(--card-bg);
    color: var(--text-2); border-radius: 6px; padding: 3px 9px; font-size: 12px;
    cursor: pointer; font-family: inherit;
    &:hover { border-color: var(--primary); color: var(--primary); }
  }
}
.gh-pager { margin-top: 14px; justify-content: center; }

// —— About 侧栏 ——
.gh-aside { display: flex; flex-direction: column; gap: 14px; }
.gh-abox {
  border: 1px solid var(--border-2); border-radius: 6px; background: var(--card-bg);
  padding: 12px 14px;
}
.gh-ahead { font-size: 13px; font-weight: 600; color: var(--text); margin-bottom: 8px; }
.gh-atext { margin: 0; font-size: 12.5px; line-height: 1.7; color: var(--text-2);
  &.dim { color: var(--text-3); margin-top: 8px; }
}
.gh-topics { display: flex; flex-wrap: wrap; gap: 6px; }
.gh-topic {
  border: 1px solid var(--border-2); background: var(--card-bg); color: var(--primary);
  border-radius: 999px; padding: 2px 10px; font-size: 12px; cursor: pointer; font-family: inherit;
  transition: all .15s;
  i { font-style: normal; color: var(--text-3); margin-left: 3px; font-size: 11px; }
  &:hover { background: var(--primary-tint); border-color: var(--primary); }
  &.on { background: var(--primary); border-color: var(--primary); color: #fff;
    i { color: color-mix(in srgb, #fff 75%, transparent); } }
}

// —— 发帖弹窗（沿用原有样式） ——
.sh-title { margin-bottom: 10px; }
.sh-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px;
  .att-chips { display: flex; gap: 4px; flex-wrap: wrap; }
  // 附件名不换行：过长省略号 + title 悬浮全名（断行会竖排挤压排版）
  .att-tag {
    max-width: 240px; vertical-align: middle;
    :deep(.el-tag__content) {
      display: inline-block; max-width: 200px; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; vertical-align: middle;
    }
  }
}
.sh-tags { width: 100%; margin-top: 10px; }
.sh-ghost-chk { margin: 8px 0 2px; font-size: 13px; color: var(--primary); }

// 编写留窗状态条：飞书打开后提示回站同步
.pd-feishu-open {
  font-size: 12.5px; color: var(--success-fg); background: var(--success-tint); border: 1px solid var(--success-border);
  border-radius: 8px; padding: 6px 12px; margin-bottom: 6px;
}

// 窄屏：两栏折单栏，About 提到表格上方（保证标签过滤仍可达）
@media (max-width: 900px) {
  .gh-body { grid-template-columns: minmax(0, 1fr); }
  .gh-aside { order: -1; }
}
@media (max-width: 768px) {
  .share-page { padding: 14px 12px 60px; }
  .gh-crumb { font-size: 16px; }
  .gh-badge:nth-child(n + 4) { display: none; } /* 徽标瘦身，留资源数/赞/藏 */
}
</style>
