<template>
  <view class="page-wrap">
    <EmptyState v-if="!allowed" icon="🔒" text="需要「借用记录」管理权限才能查看" />
    <template v-else>
      <view class="card filter-card">
        <view class="seg">
          <view class="seg-item" :class="{ on: filter.kind === '' }" @click="setKind('')">全部</view>
          <view class="seg-item" :class="{ on: filter.kind === 'device' }" @click="setKind('device')">📦 设备</view>
          <view class="seg-item" :class="{ on: filter.kind === 'room' }" @click="setKind('room')">🏫 教室</view>
        </view>
        <view class="filter-row">
          <picker :range="statusLabels" :value="statusIndex" @change="onStatus">
            <view class="pick">{{ statusLabels[statusIndex] }}</view>
          </picker>
          <input v-model="keyword" class="q-input" placeholder="物品/教室/姓名/学号" @confirm="onSearch" />
          <view class="mini-btn" @click="onSearch">搜索</view>
        </view>
        <view class="filter-row date-row">
          <picker mode="date" :value="filter.from" @change="onFrom">
            <view class="pick">{{ filter.from || '开始日期' }}</view>
          </picker>
          <text class="tilde">~</text>
          <picker mode="date" :value="filter.to" @change="onTo">
            <view class="pick">{{ filter.to || '结束日期' }}</view>
          </picker>
          <view class="mini-btn ghost" @click="resetDate">清除</view>
        </view>
        <view class="filter-row">
          <button class="btn btn-primary half" :disabled="exporting" @click="doExport">{{ exporting ? '导出中…' : '⬇ 导出 Excel' }}</button>
          <button class="btn btn-ghost half" @click="load">刷新</button>
        </view>
      </view>

      <view v-if="stats" class="stat-grid">
        <view class="stat-cell"><text class="stat-num">{{ stats.total }}</text><text class="stat-lbl">登记总数</text></view>
        <view class="stat-cell"><text class="stat-num">{{ stats.device }}</text><text class="stat-lbl">设备</text></view>
        <view class="stat-cell"><text class="stat-num">{{ stats.room }}</text><text class="stat-lbl">教室</text></view>
        <view class="stat-cell"><text class="stat-num">{{ stats.today }}</text><text class="stat-lbl">今日</text></view>
        <view class="stat-cell"><text class="stat-num">{{ stats.people }}</text><text class="stat-lbl">借用人数</text></view>
      </view>

      <EmptyState v-if="!loading && !records.length" icon="🗂️" text="当前筛选下没有借用登记" />
      <view v-for="b in records" :key="b.id" class="card rec-card">
        <image v-if="b.item_thumb" :src="b.item_thumb" class="rec-thumb" mode="aspectFill" @click="viewImage(b)" />
        <view class="rec-main">
          <view class="rec-head">
            <text class="rec-name">{{ b.item_name }}</text>
            <view class="rec-tags">
              <text class="tag" :class="b.kind === 'room' ? 'tag-purple' : 'tag-blue'">{{ b.kind === 'room' ? '教室' : '设备' }}</text>
              <text class="tag" :class="statusCls(b.status)">{{ statusLabel(b.status) }}</text>
            </view>
          </view>
          <view class="rec-line">登记人：{{ b.booker_name }}<text v-if="b.booker_student_no">（{{ b.booker_student_no }}）</text></view>
          <view class="rec-line">项目：{{ b.project_name }}</view>
          <view class="rec-line">登记于：{{ b.start_time }}</view>
          <view v-if="b.purpose" class="rec-line remark">备注：{{ b.purpose }}</view>
          <view v-if="b.has_image && !b.item_thumb" class="rec-line photo-link" @click="viewImage(b)">📷 查看现场照片</view>
        </view>
      </view>
    </template>
  </view>
</template>

<script setup>
import { ref, reactive, computed } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { qs } from '../../../utils/request.js';
import { toast } from '../../../utils/guard.js';
import { downloadAndOpen } from '../../../utils/download.js';
import { canAdmin } from '../../../utils/adminPerms.js';
import auth from '../../../utils/auth.js';
import EmptyState from '../../../components/EmptyState.vue';

const allowed = computed(() => canAdmin('lab', auth.user));
const records = ref([]);
const stats = ref(null);
const loading = ref(false);
const exporting = ref(false);
const keyword = ref('');
const filter = reactive({ kind: '', status: '', from: '', to: '' });
const statusLabels = ['全部状态', '待审批', '已确认', '已驳回', '已取消'];
const statusKeys = ['', 'pending', 'confirmed', 'rejected', 'canceled'];
const statusIndex = ref(0);

function statusLabel(s) {
  return { pending: '待审批', confirmed: '已确认', rejected: '已驳回', canceled: '已取消' }[s] || s;
}
function statusCls(s) {
  return { pending: 'tag-amber', confirmed: 'tag-green', rejected: 'tag-red', canceled: 'tag-gray' }[s] || 'tag-gray';
}
function buildParams() {
  const p = {};
  if (filter.kind) p.kind = filter.kind;
  if (filter.status) p.status = filter.status;
  if (filter.from) p.from = filter.from;
  if (filter.to) p.to = filter.to;
  const q = keyword.value.trim();
  if (q) p.q = q;
  return p;
}
async function load() {
  if (!allowed.value) return;
  loading.value = true;
  try {
    const r = await api.bookingBorrowRecords(buildParams());
    records.value = r.records || [];
    stats.value = r.stats || null;
  } finally {
    loading.value = false;
  }
}
function setKind(k) {
  filter.kind = k;
  load();
}
function onStatus(e) {
  statusIndex.value = Number(e.detail.value);
  filter.status = statusKeys[statusIndex.value];
  load();
}
function onFrom(e) { filter.from = e.detail.value; load(); }
function onTo(e) { filter.to = e.detail.value; load(); }
function resetDate() {
  filter.from = '';
  filter.to = '';
  load();
}
function onSearch() { load(); }
async function viewImage(b) {
  if (b.item_thumb && !b.has_image) {
    uni.previewImage({ urls: [b.item_thumb] });
    return;
  }
  uni.showLoading({ title: '加载原图…', mask: true });
  try {
    const r = await api.bookingOne(b.id);
    const url = r.booking && r.booking.item_image;
    uni.hideLoading();
    if (url) uni.previewImage({ urls: [url] });
    else if (b.item_thumb) uni.previewImage({ urls: [b.item_thumb] });
    else toast('该记录没有现场照片');
  } catch (e) {
    uni.hideLoading();
  }
}
async function doExport() {
  exporting.value = true;
  try {
    const today = new Date().toISOString().slice(0, 10);
    await downloadAndOpen('/api/booking/borrow-records/export' + qs(buildParams()), '借用记录-' + today + '.xlsx');
  } catch (e) { /* 下载工具已 toast */ } finally {
    exporting.value = false;
  }
}
onShow(load);
</script>

<style lang="scss" scoped>
.filter-card { padding: 24rpx; }
.seg { display: flex; gap: 12rpx; margin-bottom: 16rpx; }
.seg-item { flex: 1; text-align: center; background: #f1f5f9; color: #64748b; border-radius: 26rpx; padding: 14rpx 0; font-size: 25rpx; }
.seg-item.on { background: #eff6ff; color: #2563eb; font-weight: 700; }
.filter-row { display: flex; gap: 12rpx; align-items: center; margin-bottom: 14rpx; }
.pick { background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 12rpx; padding: 14rpx 20rpx; font-size: 25rpx; color: #334155; min-width: 180rpx; }
.q-input { flex: 1; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 12rpx; padding: 14rpx 20rpx; font-size: 25rpx; }
.mini-btn { font-size: 24rpx; color: #2563eb; background: #eff6ff; border-radius: 22rpx; padding: 12rpx 24rpx; white-space: nowrap; }
.mini-btn.ghost { background: #f1f5f9; color: #64748b; }
.tilde { color: #94a3b8; }
.half { flex: 1; height: 76rpx; font-size: 26rpx; }
.stat-grid { display: flex; gap: 12rpx; margin-bottom: 20rpx; }
.stat-cell { flex: 1; background: #fff; border: 1rpx solid #e2e8f0; border-radius: 16rpx; padding: 16rpx 0; display: flex; flex-direction: column; align-items: center; }
.stat-num { font-size: 34rpx; font-weight: 800; color: #2563eb; }
.stat-lbl { font-size: 21rpx; color: #94a3b8; margin-top: 4rpx; }
.rec-card { display: flex; gap: 18rpx; }
.rec-thumb { width: 160rpx; height: 160rpx; border-radius: 12rpx; background: #f1f5f9; flex-shrink: 0; }
.rec-main { flex: 1; min-width: 0; }
.rec-head { display: flex; justify-content: space-between; align-items: center; gap: 10rpx; }
.rec-name { font-size: 28rpx; font-weight: 700; color: #1e293b; flex: 1; }
.rec-tags { display: flex; gap: 8rpx; flex-shrink: 0; }
.rec-line { font-size: 23rpx; color: #64748b; margin-top: 6rpx; }
.rec-line.remark { color: #475569; }
.photo-link { color: #2563eb; }
</style>