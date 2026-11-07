<template>
  <view class="page-wrap" v-if="post">
    <view class="card head">
      <view class="title">{{ post.title }}</view>
      <view v-if="post.tags && post.tags.length" class="tags">
        <text v-for="t in post.tags" :key="t" class="tag tag-blue">#{{ t }}</text>
      </view>
      <view class="author" @click="openUser">
        <image v-if="post.avatar" :src="post.avatar" class="avatar-img" mode="aspectFill" />
        <view v-else class="avatar">{{ avatarText }}</view>
        <view class="au-main">
          <text class="au-name">{{ post.nickname || post.username }}</text>
          <text class="au-time">{{ post.create_time }} · {{ post.is_public ? '开源' : '私密' }}</text>
        </view>
        <view v-if="isMine" class="owner-ops">
          <text class="mini-btn" @click.stop="openEdit">编辑</text>
          <text class="mini-btn" @click.stop="toggleVisibility">{{ post.is_public ? '转私密' : '转开源' }}</text>
          <text class="mini-btn danger" @click.stop="removePost">删除</text>
        </view>
      </view>
    </view>

    <view v-if="post.content" class="card">
      <Markdown :content="post.content" />
    </view>

    <view v-if="attachments.length" class="card">
      <view class="section-title" style="margin-left: 0">附件（{{ attachments.length }}）</view>
      <image
        v-for="(a, i) in imageAtts"
        :key="'img' + i"
        :src="inlineImageUrl(a)"
        class="att-image"
        mode="widthFix"
        @click="previewAttachment(a)"
      />
      <view v-for="(a, i) in fileAtts" :key="'f' + i" class="file-row" @click="previewAttachment(a)">
        <text class="file-icon">📄</text>
        <view class="file-main">
          <text class="file-name ellipsis">{{ a.name }}</text>
          <text class="file-size">{{ sizeText(a.size) }}</text>
        </view>
        <text v-if="isMine" class="file-del" @click.stop="removeStaged(f)">删除</text>
        <text class="file-open">打开</text>
      </view>
    </view>

    <view v-if="post.files && post.files.length" class="card">
      <view class="section-title" style="margin-left: 0">项目文件（{{ post.files.length }}）</view>
      <view v-for="f in post.files" :key="f.id" class="file-row" @click="openStaged(f)">
        <text class="file-icon">🗂</text>
        <view class="file-main">
          <text class="file-name ellipsis">{{ f.name }}</text>
          <text class="file-size">{{ f.path || '' }}</text>
        </view>
        <text v-if="isMine" class="file-del" @click.stop="removeStaged(f)">删除</text>
        <text class="file-open">打开</text>
      </view>
    </view>

    <view v-if="post.gitee_repo" class="card repo-row" @click="openExternal(post.gitee_repo)">
      <text>🔗 Gitee 仓库</text>
      <text class="repo-link ellipsis">{{ post.gitee_repo }}</text>
    </view>

    <view class="section-title">评论（{{ post.comments.length }}）</view>
    <EmptyState v-if="!post.comments.length" icon="💬" text="还没有评论，来抢沙发" />
    <view v-for="c in post.comments" :key="c.id" class="card comment">
      <view class="c-head">
        <image v-if="c.avatar" :src="c.avatar" class="c-avatar" mode="aspectFill" />
        <view v-else class="c-avatar c-avatar-text">{{ (c.nickname || '?').slice(0, 1) }}</view>
        <text class="c-name">{{ c.nickname || '用户' }}</text>
        <text class="c-time">{{ c.create_time.slice(5, 16) }}</text>
        <text v-if="c.user_id === myId" class="c-del" @click="removeComment(c)">删除</text>
      </view>
      <view class="c-content">{{ c.content }}</view>
    </view>

    <view class="composer">
      <view class="stat-btn" :class="{ on: post.is_liked }" @click="toggleLike">👍 {{ post.like_count }}</view>
      <view class="stat-btn" :class="{ on: post.is_faved }" @click="toggleFav">⭐ {{ post.fav_count }}</view>
      <input v-model="draft" class="composer-input" placeholder="写评论…" confirm-type="send" @confirm="sendComment" />
      <button class="btn btn-primary composer-btn" @click="sendComment">发送</button>
    </view>

    <view v-if="textOpen" class="modal-mask" @click="textOpen = false">
      <view class="modal modal-lg" @click.stop>
        <view class="modal-title ellipsis">{{ textTitle }}</view>
        <scroll-view scroll-y class="text-scroll">
          <text class="text-content">{{ textContent }}</text>
          <text v-if="textTruncated" class="text-tip">（文件较大，仅预览前 512KB）</text>
        </scroll-view>
        <button class="btn btn-ghost btn-block" @click="textOpen = false">关闭</button>
      </view>
    </view>
  </view>
  <view v-else class="empty"><view class="empty-text">加载中…</view></view>
</template>

<script setup>
import { ref, computed } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { confirm, toast, ensureLogin } from '../../../utils/guard.js';
import { previewAttachment, inlineImageUrl, previewFile, openExternal } from '../../../utils/preview.js';
import auth from '../../../utils/auth.js';
import Markdown from '../../../components/Markdown.vue';
import EmptyState from '../../../components/EmptyState.vue';

const id = ref(null);
const post = ref(null);
const draft = ref('');
const myId = auth.user ? auth.user.id : null;
const isMine = computed(() => !!post.value && !!myId && post.value.author_id === myId);

function parseAtts(s) {
  try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}
const attachments = computed(() => parseAtts(post.value ? post.value.attachments : '[]'));
const imageAtts = computed(() => attachments.value.filter((a) => /^image\//i.test(a.mime || '') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.name || '')));
const fileAtts = computed(() => attachments.value.filter((a) => imageAtts.value.indexOf(a) < 0));
const avatarText = computed(() => ((post.value.nickname || post.value.username || '?').slice(0, 1).toUpperCase()));
function sizeText(n) {
  const v = Number(n) || 0;
  if (v > 1048576) return (v / 1048576).toFixed(1) + ' MB';
  if (v > 1024) return Math.round(v / 1024) + ' KB';
  return v + ' B';
}

async function load() { post.value = await api.sharePost(id.value); }
function openUser() { uni.navigateTo({ url: '/packageShare/pages/user/main?id=' + post.value.author_id }); }
function openEdit() { uni.navigateTo({ url: '/packageShare/pages/post/publish?id=' + post.value.id }); }
async function toggleVisibility() {
  const next = post.value.is_public ? 0 : 1;
  const tip = next ? '设为开源后任何人凭链接可见，确认？' : '设为私密后仅你自己可见，确认？';
  if (!(await confirm(tip))) return;
  const r = await api.shareVisibility(post.value.id, { is_public: next });
  post.value.is_public = next;
  toast(r.message || '已更新', 'success');
}
const TEXT_EXTS = ['txt', 'md', 'markdown', 'html', 'htm', 'json', 'log', 'js', 'ts', 'vue', 'css', 'scss', 'yml', 'yaml', 'xml'];
const textOpen = ref(false);
const textTitle = ref('');
const textContent = ref('');
const textTruncated = ref(false);
function isTextName(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  return TEXT_EXTS.indexOf(ext) >= 0;
}
async function openStaged(f) {
  if (isTextName(f.name)) {
    try {
      const r = await api.shareFileText(f.id);
      textTitle.value = f.name;
      textContent.value = r.text || '（空文件）';
      textTruncated.value = !!r.truncated;
      textOpen.value = true;
      return;
    } catch (e) { /* 回退下载预览 */ }
  }
  previewFile('/api/share/files/' + f.id, f.name);
}

async function toggleLike() {
  if (!ensureLogin()) return;
  const r = await api.shareLike(id.value);
  post.value.is_liked = r.liked ? 1 : 0;
  post.value.like_count = r.count;
}
async function toggleFav() {
  if (!ensureLogin()) return;
  const r = await api.shareFav(id.value);
  post.value.is_faved = r.faved ? 1 : 0;
  post.value.fav_count = r.count;
  toast(r.faved ? '已收藏' : '已取消收藏', 'success');
}
async function sendComment() {
  if (!ensureLogin()) return;
  const content = draft.value.trim();
  if (!content) return toast('评论内容不能为空');
  await api.shareCommentAdd(id.value, { content });
  draft.value = '';
  toast('评论成功', 'success');
  load();
}
async function removeComment(c) {
  if (!(await confirm('删除这条评论？'))) return;
  await api.shareCommentDelete(id.value, c.id);
  load();
}
async function removeStaged(f) {
  if (!(await confirm('删除项目文件「' + f.name + '」？已发布帖子中的引用会同步失效。'))) return;
  await api.shareFileDelete(f.id);
  toast('已删除', 'success');
  load();
}
async function removePost() {
  if (!(await confirm('删除后帖子不可恢复，确认删除？'))) return;
  await api.shareDelete(id.value);
  toast('已删除', 'success');
  setTimeout(() => uni.navigateBack(), 600);
}

onLoad((o) => { id.value = Number(o.id); load(); });
onShow(() => { if (id.value && post.value) load(); });
</script>

<style lang="scss" scoped>
.head .title { font-size: 36rpx; font-weight: 800; color: #1e293b; line-height: 1.4; }
.tags { display: flex; flex-wrap: wrap; gap: 8rpx; margin-top: 14rpx; }
.author { display: flex; align-items: center; gap: 16rpx; margin-top: 20rpx; }
.avatar-img, .avatar { width: 72rpx; height: 72rpx; border-radius: 50%; }
.avatar { background: #2563eb; color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700; }
.au-main { flex: 1; display: flex; flex-direction: column; }
.au-name { font-size: 27rpx; font-weight: 700; color: #1e293b; }
.au-time { font-size: 22rpx; color: #94a3b8; margin-top: 4rpx; }
.mini-btn { background: #eff6ff; color: #2563eb; font-size: 23rpx; border-radius: 24rpx; padding: 8rpx 22rpx; }
.mini-btn.danger { background: #fee2e2; color: #ef4444; }
.att-image { width: 100%; border-radius: 14rpx; margin-bottom: 14rpx; }
.file-row { display: flex; align-items: center; gap: 16rpx; padding: 18rpx 0; border-bottom: 1rpx solid #f1f5f9; }
.file-row:last-child { border-bottom: none; }
.file-icon { font-size: 40rpx; }
.file-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.file-name { font-size: 27rpx; color: #1e293b; }
.file-size { font-size: 22rpx; color: #94a3b8; margin-top: 4rpx; }
.file-open { font-size: 24rpx; color: #2563eb; background: #eff6ff; border-radius: 24rpx; padding: 8rpx 22rpx; }
.file-del { font-size: 24rpx; color: #ef4444; background: #fef2f2; border-radius: 24rpx; padding: 8rpx 22rpx; margin-right: 12rpx; }
.repo-row { display: flex; align-items: center; gap: 14rpx; font-size: 26rpx; color: #334155; }
.repo-link { flex: 1; color: #2563eb; font-size: 24rpx; }
.comment .c-head { display: flex; align-items: center; gap: 12rpx; }
.c-avatar { width: 56rpx; height: 56rpx; border-radius: 50%; }
.c-avatar-text { background: #64748b; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 24rpx; }
.c-name { font-size: 26rpx; font-weight: 700; color: #334155; }
.c-time { font-size: 21rpx; color: #94a3b8; flex: 1; }
.c-del { font-size: 22rpx; color: #ef4444; }
.c-content { font-size: 27rpx; color: #334155; margin-top: 12rpx; line-height: 1.6; }
.composer { position: fixed; left: 0; right: 0; bottom: 0; display: flex; align-items: center; gap: 12rpx; padding: 12rpx 20rpx calc(12rpx + env(safe-area-inset-bottom)); background: #fff; border-top: 1rpx solid #e2e8f0; z-index: 50; }
.stat-btn { font-size: 26rpx; color: #64748b; background: #f1f5f9; border-radius: 30rpx; padding: 12rpx 18rpx; white-space: nowrap; }
.stat-btn.on { background: #eff6ff; color: #2563eb; font-weight: 700; }
.composer-input { flex: 1; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 34rpx; padding: 0 24rpx; height: 72rpx; font-size: 26rpx; min-width: 0; }
.composer-btn { width: 120rpx; height: 72rpx; font-size: 26rpx; padding: 0; flex-shrink: 0; }
.owner-ops { display: flex; gap: 10rpx; flex-shrink: 0; }
.modal-mask { position: fixed; inset: 0; background: rgba(15,23,42,.45); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { width: 660rpx; background: #fff; border-radius: 24rpx; padding: 32rpx; }
.modal-lg { max-height: 82vh; display: flex; flex-direction: column; }
.modal-title { font-size: 30rpx; font-weight: 700; margin-bottom: 16rpx; }
.text-scroll { max-height: 60vh; background: #f8fafc; border-radius: 12rpx; padding: 20rpx; margin-bottom: 18rpx; }
.text-content { font-size: 25rpx; color: #334155; line-height: 1.7; white-space: pre-wrap; word-break: break-all; }
.text-tip { display: block; color: #94a3b8; font-size: 22rpx; margin-top: 12rpx; }
</style>
