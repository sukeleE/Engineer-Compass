<template>
  <view class="page-wrap">
    <Tabs v-model="tab" :tabs="[{ key: 'comp', label: '待审竞赛', badge: pendings.length }, { key: 'user', label: '用户管理', badge: users.length }, { key: 'feedback', label: '反馈', badge: feedbacks.length }, { key: 'notice', label: '公告管理', badge: notices.length }]" />

    <block v-if="tab === 'comp'">
      <EmptyState v-if="!pendings.length" icon="✅" text="没有待审核的竞赛收录" />
      <view v-for="c in pendings" :key="c.id" class="card comp">
        <view class="c-head">
          <text class="c-name">{{ c.name }}</text>
          <text v-if="c.type" class="tag tag-blue">{{ c.type }}</text>
        </view>
        <view v-if="c.short_name" class="c-line">简称：{{ c.short_name }}</view>
        <view class="c-line">来源：{{ sourceLabel(c.source_type) }} · 置信度 {{ c.confidence || '—' }}</view>
        <view v-if="c.difficulty" class="c-line">难度：{{ c.difficulty }}</view>
        <view class="c-line c-link" @click="openExternal(c.source_url)">🔗 官方来源（点击复制）</view>
        <view class="c-time">提交于 {{ c.create_time }}</view>
        <view class="c-ops">
          <view class="mini-btn danger" @click="reject(c)">拒绝收录</view>
          <view class="mini-btn" @click="accept(c)">采纳转正</view>
        </view>
      </view>
    </block>

    <block v-else-if="tab === 'notice'">
      <button class="btn btn-primary btn-block" @click="openNotice">＋ 发布公告</button>
      <EmptyState v-if="!notices.length" icon="📢" text="还没有公告" />
      <view v-for="n in notices" :key="n.id" class="card notice">
        <view class="n-head">
          <text class="n-title">
            <text v-if="n.pinned" class="pin">置顶</text>
            {{ n.title }}
          </text>
        </view>
        <view class="n-content">{{ n.content }}</view>
        <view class="n-time">{{ n.admin_name || '管理员' }} · {{ n.create_time }}</view>
        <view class="n-ops">
          <text class="mini-btn" @click="openNoticeEdit(n)">编辑</text>
          <text class="mini-btn danger" @click="removeNotice(n)">删除</text>
        </view>
      </view>
    </block>

    <block v-else-if="tab === 'user'">
      <view class="search-bar">
        <input v-model="userQuery" class="search-input" maxlength="20" placeholder="搜昵称/登录名/真名/邮箱" @confirm="loadUsers(true)" />
        <button class="btn btn-ghost search-btn" @click="loadUsers(true)">搜索</button>
      </view>
      <EmptyState v-if="!users.length" icon="👤" text="暂无匹配用户" />
      <view v-for="u in users" :key="u.id" class="card user-card">
        <view class="u-head">
          <text class="u-name">{{ u.real_name || u.nickname || u.username }}</text>
          <text v-if="u.is_admin" class="tag tag-blue">管理员</text>
          <text class="tag" :class="userStatusCls(u.status)">{{ userStatusLabel(u.status) }}</text>
        </view>
        <view class="u-line">@{{ u.username }}<text v-if="u.email"> · {{ u.email }}</text></view>
        <view class="u-line">注册：{{ String(u.create_time).slice(0, 10) }}<text v-if="u.phone"> · {{ u.phone }}</text></view>
        <view v-if="u.id !== myId" class="c-ops">
          <template v-if="u.status === 0">
            <view class="mini-btn warn" @click="setUserStatus(u, 2)">禁言</view>
            <view class="mini-btn danger" @click="setUserStatus(u, 1)">封禁</view>
          </template>
          <view v-else class="mini-btn" @click="setUserStatus(u, 0)">解除限制</view>
        </view>
      </view>
      <LoadMore v-if="users.length" :loading="userLoading" :finished="userFinished" @more="loadUsers(false)" />
    </block>

    <block v-else>
      <EmptyState v-if="!feedbacks.length" icon="📮" text="暂无用户反馈" />
      <view v-for="fb in feedbacks" :key="fb.id" class="card fb-card">
        <view class="fb-head">
          <text class="fb-who">{{ fb.real_name || fb.nickname || fb.username || '匿名用户' }}</text>
          <text class="fb-time">{{ fb.create_time }}</text>
        </view>
        <view class="fb-content">{{ fb.content }}</view>
        <view v-if="fb.contact_email" class="u-line">联系方式：{{ fb.contact_email }}</view>
        <view class="c-ops">
          <view v-if="fb.contact_email" class="mini-btn" @click="copyContact(fb)">复制联系方式</view>
          <view class="mini-btn danger" @click="removeFeedback(fb)">删除反馈</view>
        </view>
      </view>
      <LoadMore v-if="feedbacks.length" :loading="fbLoading" :finished="fbFinished" @more="loadFeedbacks(false)" />
    </block>

    <view v-if="noticeOpen" class="modal-mask" @click="noticeOpen = false">
      <view class="modal" @click.stop>
        <view class="modal-title">{{ editingNotice ? '编辑公告' : '发布公告' }}</view>
        <input v-model="noticeForm.title" class="modal-input" maxlength="60" placeholder="公告标题（必填，≤60 字）" />
        <textarea v-model="noticeForm.content" class="modal-textarea" maxlength="2000" placeholder="公告内容（必填）" />
        <view class="switch-row">
          <text>置顶公告</text>
          <switch :checked="noticeForm.pinned" color="#2563eb" @change="onPin" />
        </view>
        <view class="modal-actions">
          <button class="btn btn-ghost modal-btn" @click="noticeOpen = false">取消</button>
          <button class="btn btn-primary modal-btn" @click="submitNotice">{{ editingNotice ? '保存修改' : '发布' }}</button>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, reactive, computed, watch } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { confirm, toast } from '../../../utils/guard.js';
import { openExternal } from '../../../utils/preview.js';
import auth from '../../../utils/auth.js';
import Tabs from '../../../components/Tabs.vue';
import EmptyState from '../../../components/EmptyState.vue';
import LoadMore from '../../../components/LoadMore.vue';

const tab = ref('comp');
const pendings = ref([]);
const notices = ref([]);
const noticeOpen = ref(false);
const editingNotice = ref(null);
const noticeForm = reactive({ title: '', content: '', pinned: false });
const myId = computed(() => (auth.user ? auth.user.id : 0));

function sourceLabel(s) { return { ai_search: 'AI 检索', manual: '人工录入', ingest: '用户收录' }[s] || s || '—'; }
function userStatusLabel(s) { return { 0: '正常', 1: '封禁', 2: '禁言' }[s] || '正常'; }
function userStatusCls(s) { return { 0: 'tag-green', 1: 'tag-red', 2: 'tag-amber' }[s] || 'tag-green'; }

async function loadPending() {
  try { pendings.value = await api.pendingCompetitions(); } catch (e) { pendings.value = []; }
}
async function loadNotices() {
  try { notices.value = await api.adminAnnouncements(); } catch (e) { notices.value = []; }
}
async function accept(c) {
  if (!(await confirm('采纳「' + c.name + '」并转为正式竞赛？'))) return;
  await api.verifyCompetition(c.id);
  toast('已采纳', 'success');
  loadPending();
}
async function reject(c) {
  if (!(await confirm('拒绝收录将删除该条及其子赛项/技术栈，确认？', '高危操作'))) return;
  await api.deleteCompetition(c.id);
  toast('已删除', 'success');
  loadPending();
}
function openNotice() {
  editingNotice.value = null;
  noticeForm.title = ''; noticeForm.content = ''; noticeForm.pinned = false;
  noticeOpen.value = true;
}
function openNoticeEdit(n) {
  editingNotice.value = n;
  noticeForm.title = n.title; noticeForm.content = n.content; noticeForm.pinned = !!n.pinned;
  noticeOpen.value = true;
}
function onPin(e) { noticeForm.pinned = e.detail.value; }
async function submitNotice() {
  if (!noticeForm.title.trim()) return toast('请填写标题');
  if (!noticeForm.content.trim()) return toast('请填写公告内容');
  const card = { title: noticeForm.title.trim(), content: noticeForm.content.trim(), pinned: noticeForm.pinned ? 1 : 0 };
  if (editingNotice.value) await api.adminAnnouncementUpdate(editingNotice.value.id, card);
  else await api.adminAnnouncementCreate(card);
  noticeOpen.value = false;
  toast(editingNotice.value ? '已更新' : '公告已发布', 'success');
  loadNotices();
}
async function removeNotice(n) {
  if (!(await confirm('删除公告「' + n.title + '」？'))) return;
  await api.adminAnnouncementDelete(n.id);
  toast('已删除', 'success');
  loadNotices();
}

// ============ 用户管理 ============
const users = ref([]);
const userQuery = ref('');
const userPage = ref(1);
const userTotal = ref(0);
const userLoading = ref(false);
const userLoaded = ref(false);
const userFinished = computed(() => users.value.length >= userTotal.value);
async function loadUsers(reset) {
  if (reset) { userPage.value = 1; users.value = []; }
  userLoading.value = true;
  try {
    const p = { page: userPage.value, size: 20 };
    if (userQuery.value.trim()) p.q = userQuery.value.trim();
    const r = await api.adminUsers(p);
    userTotal.value = r.total || 0;
    users.value = users.value.concat(r.list || []);
    userLoaded.value = true;
  } catch (e) {
    users.value = [];
  } finally {
    userLoading.value = false;
  }
}
async function setUserStatus(u, status) {
  const label = { 1: '封禁', 2: '禁言', 0: '解除限制' }[status];
  if (!(await confirm('确认对「' + (u.nickname || u.username) + '」执行「' + label + '」？'))) return;
  await api.adminUserStatus(u.id, status);
  toast('已' + label, 'success');
  loadUsers(true);
}

// ============ 反馈 ============
const feedbacks = ref([]);
const fbPage = ref(1);
const fbTotal = ref(0);
const fbLoading = ref(false);
const fbLoaded = ref(false);
const fbFinished = computed(() => feedbacks.value.length >= fbTotal.value);
async function loadFeedbacks(reset) {
  if (reset) { fbPage.value = 1; feedbacks.value = []; }
  fbLoading.value = true;
  try {
    const r = await api.adminFeedback({ page: fbPage.value, size: 20 });
    fbTotal.value = r.total || 0;
    feedbacks.value = feedbacks.value.concat(r.list || []);
    fbLoaded.value = true;
  } catch (e) {
    feedbacks.value = [];
  } finally {
    fbLoading.value = false;
  }
}
async function removeFeedback(fb) {
  if (!(await confirm('删除该条反馈？'))) return;
  await api.adminFeedbackDelete(fb.id);
  toast('已删除', 'success');
  loadFeedbacks(true);
}
function copyContact(fb) {
  uni.setClipboardData({ data: fb.contact_email, success: () => toast('联系方式已复制', 'success') });
}

// 切 Tab 懒加载，避免无权限模块刷屏报错
watch(tab, (k) => {
  if (k === 'user' && !userLoaded.value) loadUsers(true);
  if (k === 'feedback' && !fbLoaded.value) loadFeedbacks(true);
});

onShow(() => {
  loadPending();
  loadNotices();
  if (tab.value === 'user') loadUsers(true);
  if (tab.value === 'feedback') loadFeedbacks(true);
});
</script>

<style lang="scss" scoped>
.comp .c-head, .notice .n-head, .user-card .u-head { display: flex; justify-content: space-between; align-items: center; gap: 12rpx; }
.c-name, .n-title, .u-name { font-size: 29rpx; font-weight: 700; color: #1e293b; flex: 1; }
.c-line, .u-line { font-size: 24rpx; color: #64748b; margin-top: 8rpx; }
.c-link { color: #2563eb; }
.c-time, .n-time, .fb-time { font-size: 22rpx; color: #94a3b8; margin-top: 10rpx; }
.c-ops, .n-ops { display: flex; gap: 14rpx; justify-content: flex-end; margin-top: 16rpx; }
.mini-btn { background: #eff6ff; color: #2563eb; font-size: 24rpx; border-radius: 26rpx; padding: 10rpx 28rpx; }
.mini-btn.danger { background: #fee2e2; color: #ef4444; }
.mini-btn.warn { background: #fef3c7; color: #b45309; }
.pin { background: #fef3c7; color: #b45309; font-size: 20rpx; border-radius: 8rpx; padding: 2rpx 10rpx; margin-right: 8rpx; }
.n-content { font-size: 26rpx; color: #334155; margin-top: 12rpx; line-height: 1.6; white-space: pre-wrap; }
.search-bar { display: flex; gap: 12rpx; align-items: center; margin-bottom: 16rpx; }
.search-input { flex: 1; background: #fff; border: 1rpx solid #e2e8f0; border-radius: 14rpx; padding: 18rpx 22rpx; font-size: 26rpx; }
.search-btn { flex: none; height: 72rpx; font-size: 25rpx; padding: 0 28rpx; }
.fb-head { display: flex; justify-content: space-between; align-items: center; gap: 12rpx; }
.fb-who { font-size: 27rpx; font-weight: 700; color: #1e293b; }
.fb-content { font-size: 26rpx; color: #334155; line-height: 1.6; margin-top: 10rpx; white-space: pre-wrap; }
.modal-mask { position: fixed; inset: 0; background: rgba(15,23,42,0.45); z-index: 100; display: flex; align-items: center; justify-content: center; padding: 48rpx; }
.modal { width: 100%; background: #fff; border-radius: 24rpx; padding: 32rpx; }
.modal-title { font-size: 32rpx; font-weight: 800; text-align: center; margin-bottom: 20rpx; }
.modal-input { background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 14rpx; padding: 20rpx 22rpx; font-size: 27rpx; margin-bottom: 16rpx; }
.modal-textarea { width: 100%; box-sizing: border-box; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 14rpx; padding: 20rpx 22rpx; font-size: 27rpx; min-height: 220rpx; }
.switch-row { display: flex; justify-content: space-between; align-items: center; margin: 18rpx 0; font-size: 27rpx; }
.modal-actions { display: flex; gap: 18rpx; margin-top: 12rpx; }
.modal-btn { flex: 1; height: 80rpx; font-size: 28rpx; }
</style>
