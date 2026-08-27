<script setup>
// 资源分享（贴吧式板块）：楼主开楼（富文本 + 多媒介附件 + 索引标签子板块）
// 三种排序视图：最热门 / 最新 / 收藏最高；标签 chips 构成子板块；点赞 / 收藏 / 评论
import { ref, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api.js';
import auth from '../auth.js';
import { openImage } from '../utils/imageViewer.js';
import { cnt, excerpt, firstImage, attDataURL } from '../utils/share.js';
import RichEditor from './team/RichEditor.vue';
import AttachmentList from './team/AttachmentList.vue';
import ResourcePicker from './ResourcePicker.vue';

const router = useRouter();
const route = useRoute();
const toProfile = (uid) => router.push(uid === auth.user?.id ? '/me' : `/user/${uid}`);

// —— 列表状态：排序视图 + 标签子板块 + 分页 ——
const sort = ref('hot'); // hot 最热门 | new 最新 | fav 收藏最高
const tag = ref('');
const page = ref(1);
const size = 10;
const rows = ref([]);
const total = ref(0);
const loading = ref(false);
const tagList = ref([]);

const SORTS = [
  { key: 'hot', full: '🔥 最热门', short: '最热' },
  { key: 'new', full: '🕐 最新', short: '最新' },
  { key: 'fav', full: '⭐ 收藏最高', short: '收藏' },
];
const mqNarrow = window.matchMedia('(max-width: 768px)');
const isNarrow = ref(mqNarrow.matches);
mqNarrow.addEventListener('change', (e) => { isNarrow.value = e.matches; });
const sortLabel = (s) => (isNarrow.value ? s.short : s.full);

async function load() {
  loading.value = true;
  try {
    const data = await api.sharePosts({ sort: sort.value, tag: tag.value, page: page.value, size });
    rows.value = data.rows;
    total.value = data.total;
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}
async function loadTags() {
  try { tagList.value = await api.shareTags(); } catch { /* 标签加载失败不阻塞列表 */ }
}
function changeSort(s) { sort.value = s; page.value = 1; load(); }
function pickTag(t) { tag.value = t; page.value = 1; load(); }
// 深链：/share?post=ID 自动打开详情（用户管理页「我的帖子/收藏」跳转过来）
function deepLink() {
  const id = Number(route.query.post);
  if (id) openPost({ id });
}
onMounted(() => { load(); loadTags(); deepLink(); });

const isMine = (p) => !!auth.user && (Number(p.author_id) === Number(auth.user.id) || auth.user.is_admin);
const needLogin = () => {
  if (auth.token) return false;
  ElMessage.warning('请先登录');
  router.push('/login?redirect=/share');
  return true;
};

// 富文本里的图片点击 → 全屏预览
function onRichClick(e) {
  if (e.target.tagName === 'IMG') openImage(e.target.currentSrc || e.target.src, '帖子图片');
}

// —— 发帖 / 编辑弹窗 ——
const postDlg = ref(false);
const editingId = ref(null);
const form = ref({ title: '', content: '', atts: [], tags: [] });
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
      const total = form.value.atts.reduce((s, a) => s + a.data.length, 0) + data.length;
      if (total > MAX_ATT_TOTAL) { ElMessage.warning('附件总量超限（≤25MB）'); return; }
      form.value.atts.push({ name: f.name, size: f.size, mime: f.type || 'application/octet-stream', data });
    };
    reader.readAsDataURL(f);
  }
};
// 从「我的资源」引用：选中后生成/复用分享链接，push 引用型附件条目（无 data 有 url）
const resPickDlg = ref(false);
const onResourcePick = (r) => {
  form.value.atts.push({ name: r.name, size: r.size, mime: r.mime, url: r.url });
  ElMessage.success(`已引用「${r.name}」`);
};
function openNew() {
  if (needLogin()) return;
  editingId.value = null;
  form.value = { title: '', content: '', atts: [], tags: [] };
  postDlg.value = true;
}
function openEdit(p) {
  if (!isMine(p)) return;
  editingId.value = p.id;
  let atts = [];
  try { atts = typeof p.attachments === 'string' ? JSON.parse(p.attachments) : p.attachments || []; } catch {}
  form.value = { title: p.title, content: p.content, atts, tags: [...(p.tags || [])] };
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
      await api.shareCreate({ title: form.value.title, content: form.value.content, attachments: form.value.atts, tags: form.value.tags });
      ElMessage.success('🚀 开楼成功');
    }
    postDlg.value = false;
    await load(); await loadTags();
    // 详情弹窗开着时同步刷新（编辑的正是当前查看的帖子）
    if (detailDlg.value && editingId.value && cur.value?.id === editingId.value) {
      cur.value = await api.sharePost(editingId.value);
    }
  } catch (e) { ElMessage.error(e.message); }
}

// —— 点赞 / 收藏（toggle，乐观更新） ——
async function toggleLike(p, ev) {
  if (ev?.stopPropagation) ev.stopPropagation();
  if (needLogin()) return;
  try {
    const r = await api.shareLike(p.id);
    p.is_liked = r.liked ? 1 : 0;
    p.like_count = r.count;
  } catch (e) { ElMessage.error(e.message); }
}
async function toggleFav(p, ev) {
  if (ev?.stopPropagation) ev.stopPropagation();
  if (needLogin()) return;
  try {
    const r = await api.shareFav(p.id);
    p.is_faved = r.faved ? 1 : 0;
    p.fav_count = r.count;
  } catch (e) { ElMessage.error(e.message); }
}

// —— 详情弹窗（含评论） ——
const detailDlg = ref(false);
const cur = ref(null);
const commentInput = ref('');
const commentSending = ref(false);
async function openPost(p) {
  try {
    cur.value = await api.sharePost(p.id);
    detailDlg.value = true;
  } catch (e) { ElMessage.error(e.message); }
}
async function sendComment() {
  if (!cur.value) return;
  if (needLogin()) return;
  const text = commentInput.value.trim();
  if (!text) return ElMessage.warning('写点评论内容');
  commentSending.value = true;
  try {
    const c = await api.shareComment(cur.value.id, text);
    cur.value.comments.push(c);
    cur.value.comment_count = (cur.value.comment_count || 0) + 1;
    commentInput.value = '';
  } catch (e) { ElMessage.error(e.message); } finally { commentSending.value = false; }
}
async function delComment(c) {
  try {
    await api.shareCommentDelete(c.id);
    cur.value.comments = cur.value.comments.filter((x) => x.id !== c.id);
    cur.value.comment_count = Math.max(0, (cur.value.comment_count || 0) - 1);
    ElMessage.success('评论已删除');
  } catch (e) { ElMessage.error(e.message); }
}
async function delPost(p) {
  try {
    await ElMessageBox.confirm(`删除帖子「${p.title}」？评论与点赞收藏将一并删除`, '删除帖子', { type: 'warning' });
  } catch { return; }
  try {
    await api.shareDelete(p.id);
    detailDlg.value = false;
    ElMessage.success('帖子已删除');
    await load(); await loadTags();
  } catch (e) { ElMessage.error(e.message); }
}
</script>

<template>
  <main class="share-page">
    <!-- 头部：标题 + 开楼按钮 -->
    <div class="sp-head">
      <div>
        <h2>📤 资源分享</h2>
        <p class="sp-sub">贴吧式交流区：分享资料/经验/作品，图文视频音频文件</p>
      </div>
      <el-button type="primary" size="large" @click="openNew">📝 开楼发帖</el-button>
    </div>

    <!-- 排序子板块 + 标签子板块 -->
    <div class="sp-boards">
      <el-radio-group v-model="sort" size="small" @change="changeSort">
        <el-radio-button v-for="s in SORTS" :key="s.key" :value="s.key">{{ sortLabel(s) }}</el-radio-button>
      </el-radio-group>
      <div class="sp-tags">
        <span class="sp-tag-label">子板块：</span>
        <span class="chip" :class="{ active: tag === '' }" @click="pickTag('')">全部</span>
        <span v-for="t in tagList" :key="t.name" class="chip" :class="{ active: tag === t.name }" @click="pickTag(t.name)">
          #{{ t.name }} <i>{{ t.count }}</i>
        </span>
      </div>
    </div>

    <!-- 帖子列表 -->
    <div v-loading="loading" class="sp-list">
      <div v-for="p in rows" :key="p.id" class="post-card" @click="openPost(p)">
        <img v-if="firstImage(p)" :src="attDataURL(firstImage(p))" class="pc-thumb" alt="" loading="lazy" />
        <div class="pc-main">
          <div class="pc-title">
            <b>{{ p.title }}</b>
            <el-tag v-for="t in p.tags" :key="t" size="small" effect="plain" class="pc-tag">#{{ t }}</el-tag>
          </div>
          <div class="pc-ex">{{ excerpt(p.content) || '（纯附件帖）' }}</div>
          <div class="pc-meta">
            <span class="pc-author u-link" @click.stop="toProfile(p.author_id)">
              <img v-if="p.avatar" :src="p.avatar" alt="" class="pc-ava" />{{ p.nickname }}
            </span>
            <span class="pc-time">{{ p.create_time?.slice(0, 16) }}</span>
            <span class="pc-actions">
              <button class="act" :class="{ on: p.is_liked }" title="点赞" @click.stop="toggleLike(p, $event)">👍 {{ cnt(p.like_count) }}</button>
              <button class="act" :class="{ on: p.is_faved }" title="收藏" @click.stop="toggleFav(p, $event)">⭐ {{ cnt(p.fav_count) }}</button>
              <span class="act plain" title="评论">💬 {{ cnt(p.comment_count) }}</span>
            </span>
          </div>
        </div>
      </div>

      <el-empty v-if="!loading && !rows.length" :description="tag ? `「${tag}」子板块还没有帖子，来开第一楼` : '还没有帖子，点「开楼发帖」分享第一个资源'" />
    </div>

    <el-pagination v-if="total > size" class="sp-pager" background layout="prev, pager, next" :total="total"
      :page-size="size" :current-page="page" @current-change="(v) => { page = v; load(); }" />

    <!-- 发帖 / 编辑弹窗 -->
    <el-dialog v-model="postDlg" :title="editingId ? '✏️ 编辑帖子' : '📝 开楼发帖'" width="720px" top="3vh"
      class="editor-dlg" :close-on-click-modal="false" destroy-on-close append-to-body>
      <el-input v-model="form.title" maxlength="60" show-word-limit placeholder="帖子标题（≤60 字）" class="sh-title" />
      <div class="sh-tools">
        <input ref="fileInput" type="file" multiple hidden @change="attPick" />
        <el-button size="small" @click="fileInput.click()">📎 附件（图片/视频/音频/文件）</el-button>
        <el-button size="small" plain @click="resPickDlg = true">📁 我的资源</el-button>
        <span v-if="form.atts.length" class="att-chips">
          <el-tag v-for="(a, i) in form.atts" :key="i" closable size="small" @close="form.atts.splice(i, 1)">
            {{ a.name }}
          </el-tag>
        </span>
      </div>
      <RichEditor v-model="form.content" placeholder="分享资料说明 / 备赛经验 / 作品展示…" />
      <el-select v-model="form.tags" multiple filterable allow-create default-first-option :multiple-limit="5"
        placeholder="索引标签（≤5 个，自建即成为子板块）" class="sh-tags">
        <el-option v-for="t in tagList" :key="t.name" :value="t.name" :label="`#${t.name}`" />
      </el-select>
      <template #footer>
        <el-button @click="postDlg = false">取消</el-button>
        <el-button type="primary" @click="submit">{{ editingId ? '保存修改' : '发布' }}</el-button>
      </template>
    </el-dialog>
    <ResourcePicker v-model="resPickDlg" @pick="onResourcePick" />

    <!-- 帖子详情弹窗 -->
    <el-dialog v-model="detailDlg" width="760px" top="3vh" class="sh-detail-dlg" :close-on-click-modal="true"
      destroy-on-close append-to-body>
      <template v-if="cur">
        <h3 class="pd-title">{{ cur.title }}</h3>
        <div class="pd-meta">
          <span class="u-link pd-author" @click="toProfile(cur.author_id)">
            <img v-if="cur.avatar" :src="cur.avatar" alt="" class="pc-ava" />{{ cur.nickname }}
          </span>
          <span class="pd-time">{{ cur.create_time?.slice(0, 16) }}</span>
          <el-tag v-for="t in cur.tags" :key="t" size="small" effect="plain">#{{ t }}</el-tag>
          <span v-if="isMine(cur)" class="pd-own">
            <el-button size="small" text type="primary" @click="openEdit(cur)">✏️ 编辑</el-button>
            <el-button size="small" text type="danger" @click="delPost(cur)">🗑 删除</el-button>
          </span>
        </div>

        <!-- 正文（富文本，图片点击全屏预览） -->
        <div v-if="cur.content" class="pd-body" v-html="cur.content" @click="onRichClick"></div>
        <div v-else class="pd-empty">（纯附件帖）</div>
        <AttachmentList v-if="cur.attachments?.length" :attachments="cur.attachments" />

        <!-- 点赞 / 收藏 -->
        <div class="pd-acts">
          <el-button :type="cur.is_liked ? 'primary' : 'default'" round @click="toggleLike(cur)">
            {{ cur.is_liked ? '👍 已点赞' : '👍 点赞' }} {{ cnt(cur.like_count) }}
          </el-button>
          <el-button :type="cur.is_faved ? 'warning' : 'default'" round @click="toggleFav(cur)">
            {{ cur.is_faved ? '⭐ 已收藏' : '⭐ 收藏' }} {{ cnt(cur.fav_count) }}
          </el-button>
        </div>

        <!-- 评论 -->
        <div class="pd-comments">
          <div class="pd-c-head">💬 评论（{{ cnt(cur.comment_count) }}）</div>
          <div v-if="cur.comments.length" class="c-list">
            <div v-for="c in cur.comments" :key="c.id" class="c-item">
              <div class="c-top">
                <span class="u-link c-author" @click="toProfile(c.user_id)">
                  <img v-if="c.avatar" :src="c.avatar" alt="" class="pc-ava" />{{ c.nickname }}
                </span>
                <span class="c-time">{{ c.create_time?.slice(5, 16) }}</span>
                <el-button v-if="Number(c.user_id) === Number(auth.user?.id) || auth.user?.is_admin"
                  size="small" text type="danger" class="c-del" @click="delComment(c)">删除</el-button>
              </div>
              <div class="c-text">{{ c.content }}</div>
            </div>
          </div>
          <div v-else class="c-empty">还没有评论，来抢沙发</div>
          <div class="c-input">
            <el-input v-model="commentInput" placeholder="友善评论，Enter 发送" @keyup.enter="sendComment" />
            <el-button type="primary" :loading="commentSending" @click="sendComment">评论</el-button>
          </div>
        </div>
      </template>
    </el-dialog>
  </main>
</template>

<style lang="scss" scoped>
.share-page { padding: 20px 24px 60px; max-width: 980px; margin: 0 auto; }

.sp-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 14px;
  h2 { margin: 0; font-size: 22px; }
  .sp-sub { color: var(--text-2); font-size: 13px; margin: 4px 0 0; }
}

.sp-boards { margin-bottom: 14px;
  .sp-tags { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 10px;
    .sp-tag-label { font-size: 13px; color: var(--text-2); }
    .chip {
      border: 1px solid var(--border); background: #fff; border-radius: 999px;
      padding: 4px 12px; font-size: 12.5px; cursor: pointer; color: var(--text-2);
      transition: all .15s;
      i { font-style: normal; font-size: 11px; color: #94a3b8; margin-left: 3px; }
      &:hover { border-color: #93c5fd; color: #2563eb; }
      &.active { background: #2563eb; border-color: #2563eb; color: #fff; i { color: #dbeafe; } }
    }
  }
}

.sp-list { display: flex; flex-direction: column; gap: 10px; min-height: 200px; }
.post-card {
  display: flex; gap: 12px; background: var(--card-bg); border: 1px solid var(--border);
  border-radius: 12px; padding: 12px 14px; cursor: pointer; transition: all .15s;
  &:hover { border-color: #93c5fd; box-shadow: 0 2px 10px rgba(37, 99, 235, .08); }
  .pc-thumb {
    width: 110px; height: 78px; border-radius: 8px; object-fit: cover; flex-shrink: 0;
    border: 1px solid var(--border); background: #f1f5f9;
  }
  .pc-main { flex: 1; min-width: 0; }
  .pc-title { display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    b { font-size: 15px; }
    .pc-tag { font-size: 11px; }
  }
  .pc-ex {
    color: var(--text-2); font-size: 13px; margin: 5px 0 8px; line-height: 1.6;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .pc-meta { display: flex; align-items: center; gap: 10px; font-size: 12.5px; color: var(--text-2);
    flex-wrap: wrap;
    .pc-ava { width: 20px; height: 20px; border-radius: 50%; object-fit: cover; margin-right: 4px; vertical-align: middle; }
    .u-link { cursor: pointer; &:hover { color: #2563eb; } }
    .pc-actions { margin-left: auto; display: flex; gap: 4px; align-items: center;
      .act {
        border: 1px solid var(--border); background: #fff; border-radius: 999px;
        padding: 3px 10px; font-size: 12px; cursor: pointer; color: var(--text-2); line-height: 1.6;
        transition: all .15s;
        &:hover { border-color: #93c5fd; color: #2563eb; }
        &.on { background: #eff6ff; border-color: #2563eb; color: #2563eb; font-weight: 600; }
        &.plain { cursor: default; &:hover { border-color: var(--border); color: var(--text-2); } }
      }
    }
  }
}

.sp-pager { margin-top: 16px; justify-content: center; }

// —— 发帖弹窗 ——
.sh-title { margin-bottom: 10px; }
.sh-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px;
  .att-chips { display: flex; gap: 4px; flex-wrap: wrap; }
}
.sh-tags { width: 100%; margin-top: 10px; }

// —— 详情弹窗 ——
.pd-title { margin: 0 0 8px; font-size: 19px; }
.pd-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px;
  color: var(--text-2); font-size: 12.5px;
  .pd-author { cursor: pointer; &:hover { color: #2563eb; } font-weight: 600; color: var(--text); }
  .pc-ava { width: 20px; height: 20px; border-radius: 50%; object-fit: cover; margin-right: 4px; vertical-align: middle; }
  .pd-own { margin-left: auto; display: flex; gap: 2px; }
}
.pd-body { line-height: 1.9; font-size: 14px; overflow-wrap: anywhere; /* 长串/URL 强制断行，防竖排 */
  :deep(img) { max-width: 100%; border-radius: 8px; cursor: zoom-in; }
  :deep(video) { max-width: 100%; border-radius: 8px; }
  :deep(iframe) { width: 100%; max-width: 640px; height: 360px; border-radius: 8px; border: none; }
  :deep(a) { color: #2563eb; }
}
.pd-empty { color: #94a3b8; font-size: 13px; padding: 10px 0; }
.pd-acts { display: flex; gap: 10px; margin: 14px 0; }

.pd-comments { border-top: 1px solid var(--border); padding-top: 12px;
  .pd-c-head { font-size: 14px; font-weight: 600; margin-bottom: 10px; }
  .c-list { display: flex; flex-direction: column; gap: 10px; max-height: 300px; overflow-y: auto; }
  .c-item { background: #f8fafc; border: 1px solid var(--border); border-radius: 10px; padding: 8px 12px;
    .c-top { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text-2);
      .c-author { font-weight: 600; color: var(--text); cursor: pointer; &:hover { color: #2563eb; } }
      .pc-ava { width: 18px; height: 18px; border-radius: 50%; object-fit: cover; margin-right: 3px; vertical-align: middle; }
      .c-del { margin-left: auto; }
    }
    .c-text { font-size: 13.5px; margin-top: 4px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
  }
  .c-empty { color: #94a3b8; font-size: 13px; padding: 12px 0; }
  .c-input { display: flex; gap: 8px; margin-top: 10px; .el-input { flex: 1; } }
}

@media (max-width: 768px) {
  .share-page { padding: 14px 12px 60px; }
  .post-card { .pc-thumb { width: 84px; height: 60px; } .pc-ex { -webkit-line-clamp: 2; } }
}
</style>
