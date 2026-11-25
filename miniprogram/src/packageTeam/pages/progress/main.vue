<template>
  <view class="page-wrap">
    <view v-if="canProgress" class="report-entry">
      <button class="report-entry-btn" @click="openReportEditor">✍️ 提交进度汇报</button>
    </view>

    <view v-if="loading" class="empty"><view class="empty-text">加载中…</view></view>
    <EmptyState v-else-if="!logs.length" icon="📈" text="还没有进度汇报" />
    <template v-else>
      <view v-for="g in logGroups" :key="g.key" class="week-group">
        <view class="week-head" @click="toggleWeek(g)">
          <text v-if="g.collapsible" class="week-arrow" :class="{ open: weekOpen(g) }">▸</text>
          <text class="week-title">{{ g.free ? '✍️ 自由汇报' : '📅 ' + g.label }}</text>
          <text class="week-count">{{ g.count }}份</text>
          <text v-if="g.late" class="tag tag-red">迟交{{ g.late }}</text>
          <text v-if="g.featured" class="tag tag-amber">优秀{{ g.featured }}</text>
        </view>
        <view v-if="weekOpen(g)" class="week-body">
          <view v-for="l in g.logs" :key="l.id" class="card log">
            <view class="log-head">
              <view class="avatar">{{ logName(l).slice(0, 1) }}</view>
              <view class="who">
                <text class="nick">{{ logName(l) }}</text>
                <text class="time">{{ l.create_time }}</text>
              </view>
              <view class="badges">
                <text v-if="l.featured" class="tag tag-amber">精选</text>
                <text v-if="l.is_late" class="tag tag-red">迟交</text>
                <text v-if="l.self_rating" class="tag tag-blue">自评 {{ l.self_rating }}★</text>
              </view>
            </view>
            <Markdown v-if="stripHtml(l.content)" :content="stripHtml(l.content)" clamp />
            <view v-if="l.schedule_id && !stripHtml(l.content) && l.attachments && l.attachments.length" class="att-note">
              本周周报以附件形式提交，点击下方文件查看
            </view>
            <AttachmentList v-if="l.attachments && l.attachments.length" :attachments="l.attachments"
              :team-id="id" :log-id="l.id" />
            <view v-if="l.review" class="review">组长点评：{{ l.review }}<text v-if="l.score">（{{ l.score }} 分）</text></view>

            <view v-if="canModify(l)" class="log-ops">
              <text class="link-btn" @click="openEdit(l)">编辑</text>
              <text class="link-btn danger" @click="removeLog(l)">删除</text>
            </view>

            <view class="comment-list">
              <view v-for="c in (l.comments || [])" :key="c.id" class="comment">
                <text class="c-name">{{ commentName(c) }}：</text><text class="c-content">{{ c.content }}</text>
                <text v-if="canDeleteComment(c)" class="c-del" @click="removeComment(l, c)">删</text>
              </view>
            </view>
            <view class="comment-bar">
              <input v-model="commentDrafts[l.id]" class="comment-input" placeholder="写评论…" confirm-type="send" @confirm="sendComment(l)" />
              <view class="mini-btn" @click="sendComment(l)">发送</view>
            </view>
          </view>
        </view>
      </view>
    </template>

  </view>
</template>

<script setup>
import { ref, reactive, computed } from 'vue';
import { onLoad, onShow, onUnload } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { confirm, toast } from '../../../utils/guard.js';
import auth from '../../../utils/auth.js';
import Markdown from '../../../components/Markdown.vue';
import EmptyState from '../../../components/EmptyState.vue';
import AttachmentList from '../../../components/AttachmentList.vue';
import { teamDisplayName } from '../../../utils/displayName.js';
import { readCache, writeCache } from '../../../utils/swrCache.js';

const id = ref(null);
const detail = ref(null);
const logs = ref([]);
const loading = ref(true);
const commentDrafts = reactive({});
const myId = auth.user ? auth.user.id : null;
let loadingAll = null;
let lastLoadedAt = 0;
function cacheKey(kind) {
  return `team-progress:${auth.user?.id || 'anon'}:${id.value}:${kind}`;
}
function compactDetail(d) {
  return d ? { me: d.me, perms: d.perms, members: d.members || [] } : null;
}

const canProgress = computed(() => !detail.value || detail.value.me.is_owner || detail.value.perms.progress);
function canModify(l) { return l.user_id === myId || (detail.value && detail.value.me.is_owner); }
function canDeleteComment(c) {
  if (!detail.value) return false;
  return c.user_id === myId || detail.value.me.is_owner || detail.value.perms.member;
}

function members() { return detail.value?.members || []; }
function logName(l) { return teamDisplayName(l, members()) || l.nickname || '成员'; }
function commentName(c) { return teamDisplayName(c, members()) || c.nickname || '成员'; }
function stripHtml(html) {
  return String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ');
}
// ==================== 汇报按周折叠（历史周期打包，默认只展开最新一周；自由汇报置顶常显） ====================
function isoWeekOf(dateStr) {
  const [Y, M, D] = String(dateStr).split('-').map(Number);
  const d = new Date(Date.UTC(Y, M - 1, D));
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - day + 3); // 本周四
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  firstThu.setUTCDate(firstThu.getUTCDate() - ((firstThu.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((d - firstThu) / (7 * 864e5));
  return { year: d.getUTCFullYear(), week, key: `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}` };
}
function logWeekKey(l) {
  return /W/.test(l.period_key) ? l.period_key : isoWeekOf(l.period_key).key;
}
function weekMd(d) { return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`; }
function weekRangeLabel(key) {
  const [y, w] = key.split('-W').map(Number);
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7;
  const mon = new Date(jan4);
  mon.setUTCDate(jan4.getUTCDate() - jan4Dow + (w - 1) * 7);
  const sun = new Date(mon);
  sun.setUTCDate(mon.getUTCDate() + 6);
  const endMd = sun.getUTCFullYear() === y ? weekMd(sun) : `${sun.getUTCFullYear()}年${weekMd(sun)}`;
  return `第${w}周 · ${weekMd(mon)}–${endMd}`;
}
// 自由汇报（无 schedule_id）置顶不可折叠；打卡汇报按 ISO 周打包，周键倒序
const logGroups = computed(() => {
  const groups = [];
  const free = logs.value.filter((l) => !l.schedule_id);
  if (free.length) {
    groups.push({ key: 'free', free: true, collapsible: false, label: '自由汇报', logs: free,
      count: free.length, late: 0, featured: free.filter((l) => l.featured).length });
  }
  const map = new Map();
  for (const l of logs.value) {
    if (!l.schedule_id) continue;
    const key = logWeekKey(l);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(l);
  }
  for (const key of [...map.keys()].sort((a, b) => (a < b ? 1 : -1))) {
    const arr = map.get(key);
    groups.push({ key, free: false, collapsible: true, label: weekRangeLabel(key), logs: arr,
      count: arr.length, late: arr.filter((l) => l.is_late).length,
      featured: arr.filter((l) => l.featured).length });
  }
  return groups;
});
const expandedWeeks = reactive({});
let lastLatestWeek = null;
// 仅在出现新的最新周时自动展开（首次加载/跨周新汇报），不覆盖用户手动收起状态
function ensureLatestWeek() {
  const latest = logGroups.value.find((g) => !g.free);
  if (!latest || latest.key === lastLatestWeek) return;
  expandedWeeks[latest.key] = true;
  lastLatestWeek = latest.key;
}
function toggleWeek(g) {
  if (!g.collapsible) return;
  expandedWeeks[g.key] = !expandedWeeks[g.key];
}
function weekOpen(g) { return !g.collapsible || !!expandedWeeks[g.key]; }

function openReportEditor() {
  uni.navigateTo({ url: `/packageTeam/pages/progress/edit?teamId=${id.value}` });
}
function openEdit(l) {
  uni.navigateTo({ url: `/packageTeam/pages/progress/edit?teamId=${id.value}&logId=${l.id}` });
}
function onProgressRefresh(payload = {}) {
  if (Number(payload.teamId) !== Number(id.value)) return;
  load(true);
}

function restoreCache() {
  const cachedDetail = readCache(cacheKey('detail'))?.value;
  const cachedLogs = readCache(cacheKey('logs'))?.value;
  if (cachedDetail) detail.value = cachedDetail;
  if (Array.isArray(cachedLogs)) logs.value = cachedLogs;
  if (detail.value || logs.value.length) loading.value = false;
}
async function loadDetail() {
  const d = await api.teamDetail(id.value);
  detail.value = d;
  writeCache(cacheKey('detail'), compactDetail(d));
}
async function loadLogs() {
  const rows = await api.collabLogs(id.value, { limit: 200, meta: 1 });
  logs.value = Array.isArray(rows) ? rows : [];
  writeCache(cacheKey('logs'), logs.value);
  ensureLatestWeek();
  loading.value = false;
}
async function load(force = false) {
  if (!id.value) return;
  if (loadingAll) return loadingAll;
  if (!force && Date.now() - lastLoadedAt < 10000) return;
  lastLoadedAt = Date.now();
  loadingAll = Promise.allSettled([loadDetail(), loadLogs()]);
  try {
    await loadingAll;
  } finally {
    loadingAll = null;
    loading.value = false;
  }
}

// ---------- 删除 ----------
async function removeLog(l) {
  if (!(await confirm('删除这条进度汇报？'))) return;
  await api.collabLogDelete(id.value, l.id);
  toast('已删除', 'success');
  load(true);
}

// ---------- 评论 ----------
async function sendComment(l) {
  const content = (commentDrafts[l.id] || '').trim();
  if (!content) return toast('评论内容不能为空');
  await api.collabComment(id.value, 'log', l.id, { content });
  commentDrafts[l.id] = '';
  toast('评论成功', 'success');
  load(true);
}
async function removeComment(l, c) {
  if (!(await confirm('删除这条评论？'))) return;
  await api.collabCommentDelete(id.value, c.id);
  toast('已删除', 'success');
  load(true);
}

onLoad((o) => {
  id.value = Number(o.id);
  uni.$on('team:progress:refresh', onProgressRefresh);
  restoreCache();
  load();
});
onShow(() => { if (id.value) load(); });
onUnload(() => {
  uni.$off('team:progress:refresh', onProgressRefresh);
});
</script>

<style lang="scss" scoped>
.report-entry { margin-bottom: 20rpx; }
.report-entry-btn {
  height: 92rpx;
  line-height: 92rpx;
  border-radius: 16rpx;
  background: linear-gradient(135deg, #2563eb, #3b82f6);
  color: #fff;
  font-size: 29rpx;
  font-weight: 700;
  box-shadow: 0 10rpx 24rpx rgba(37, 99, 235, .2);
}
.report-entry-btn::after { border: none; }
.mini-btn { background: #eff6ff; color: #2563eb; font-size: 24rpx; border-radius: 26rpx; padding: 12rpx 28rpx; }
.log { padding: 24rpx 28rpx; }
.log-head { display: flex; align-items: center; gap: 14rpx; }
.avatar { width: 68rpx; height: 68rpx; border-radius: 50%; background: linear-gradient(135deg, #2563eb, #60a5fa); color: #fff; text-align: center; line-height: 68rpx; font-weight: 700; flex-shrink: 0; }
.who { flex: 1; min-width: 0; }
.nick { font-weight: 700; color: #1e293b; font-size: 27rpx; display: block; }
.time { font-size: 22rpx; color: #94a3b8; }
.badges { display: flex; gap: 8rpx; flex-wrap: wrap; justify-content: flex-end; }
.review { margin-top: 14rpx; background: #eff6ff; color: #1e40af; border-radius: 10rpx; padding: 12rpx 18rpx; font-size: 24rpx; }
.att-note { margin-top: 12rpx; padding: 12rpx 16rpx; border-radius: 10rpx; background: #f8fafc; color: #64748b; font-size: 23rpx; }
.log-ops { display: flex; gap: 24rpx; margin-top: 14rpx; justify-content: flex-end; }
.link-btn { font-size: 24rpx; color: #2563eb; }
.link-btn.danger { color: #ef4444; }
.comment-list { margin-top: 14rpx; border-top: 1rpx solid #f1f5f9; padding-top: 12rpx; }
.comment { font-size: 25rpx; color: #475569; padding: 8rpx 0; display: flex; align-items: baseline; gap: 6rpx; }
.c-name { font-weight: 700; color: #334155; flex-shrink: 0; }
.c-content { flex: 1; }
.c-del { color: #ef4444; font-size: 22rpx; flex-shrink: 0; padding: 0 10rpx; }
.comment-bar { display: flex; gap: 14rpx; align-items: center; margin-top: 12rpx; }
.comment-input { flex: 1; height: 68rpx; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 34rpx; padding: 0 24rpx; font-size: 25rpx; }
.week-group { margin-bottom: 18rpx; }
.week-head { display: flex; align-items: center; gap: 10rpx; flex-wrap: wrap; background: #eff6ff; border: 1rpx solid #dbeafe; border-radius: 14rpx; padding: 16rpx 22rpx; }
.week-arrow { font-size: 26rpx; color: #64748b; transition: transform .2s; }
.week-arrow.open { transform: rotate(90deg); }
.week-title { font-size: 27rpx; font-weight: 700; color: #1e293b; }
.week-count { font-size: 23rpx; color: #64748b; }
.week-body { display: flex; flex-direction: column; gap: 14rpx; margin-top: 14rpx; }
.week-body .card { margin-bottom: 0; }
</style>
