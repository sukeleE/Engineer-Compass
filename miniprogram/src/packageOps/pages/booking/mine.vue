<template>
  <view class="page-wrap">
    <scroll-view scroll-x class="chips" :show-scrollbar="false">
      <view v-for="s in statuses" :key="s.key" class="chip" :class="{ on: status === s.key }" @click="status = s.key">{{ s.label }}</view>
    </scroll-view>

    <EmptyState v-if="!filtered.length" icon="📅" text="暂无预约记录" />

    <view v-for="b in filtered" :key="b.id" class="card booking" @click="openOne(b)">
      <view class="b-head">
        <text class="b-res">{{ isReg(b) ? b.item_name : b.resource_name }}</text>
        <view class="b-tags">
          <text v-if="isReg(b)" class="tag tag-blue">{{ regLabel(b) }}</text>
          <text v-if="!isReg(b) && b.source === 'team'" class="tag tag-purple">固定组队</text>
          <text class="tag" :class="bkCls(b.status)">{{ bkLabel(b.status) }}</text>
        </view>
      </view>
      <image v-if="isReg(b) && b.item_thumb" :src="b.item_thumb" class="reg-thumb" mode="aspectFill" @click.stop="previewImg(b.item_thumb)" />
      <view class="b-line">项目：{{ b.project_name }}</view>
      <view class="b-line">{{ isReg(b) ? '登记于' : '时间' }}：{{ b.start_time }}<template v-if="!isReg(b)"> ~ {{ b.end_time }}</template></view>
      <template v-if="!isReg(b)">
        <view v-if="b.headcount > 1" class="b-line">人数：{{ b.headcount }} 人</view>
        <view v-if="b.qty > 1" class="b-line">数量：{{ b.qty }} 件</view>
      </template>
      <view v-if="b.purpose" class="b-line">用途：{{ b.purpose }}</view>
      <view v-if="b.status === 'rejected' && b.reject_reason" class="b-reject">驳回：{{ b.reject_reason }}</view>
      <view v-if="b.perm && b.perm.canCancel" class="b-ops">
        <view class="mini-btn danger" @click="cancel(b)">取消预约</view>
      </view>
    </view>

    <view v-if="bkOpen" class="modal-mask" @click="bkOpen = false">
      <view class="modal" @click.stop>
        <view class="modal-title">预约详情</view>
        <scroll-view scroll-y class="modal-scroll" v-if="bkDetail">
          <view class="bk-head">
            <text class="bk-res">{{ isReg(bkDetail.booking) ? bkDetail.booking.item_name : bkDetail.booking.resource_name }}</text>
            <view class="b-tags">
              <text v-if="isReg(bkDetail.booking)" class="tag tag-blue">{{ regLabel(bkDetail.booking) }}</text>
              <text class="tag" :class="bkCls(bkDetail.booking.status)">{{ bkLabel(bkDetail.booking.status) }}</text>
            </view>
          </view>
          <image v-if="isReg(bkDetail.booking) && bkDetail.booking.item_image" :src="bkDetail.booking.item_image" class="reg-photo" mode="widthFix" @click="previewImg(bkDetail.booking.item_image)" />
          <view class="b-line">项目：{{ bkDetail.booking.project_name }}</view>
          <view class="b-line">预约人：{{ bkDetail.booking.booker_name }}<text v-if="bkDetail.booking.booker_student_no">（{{ bkDetail.booking.booker_student_no }}）</text></view>
          <view class="b-line">{{ isReg(bkDetail.booking) ? '登记于' : '时间' }}：{{ bkDetail.booking.start_time }}<template v-if="!isReg(bkDetail.booking)"> ~ {{ bkDetail.booking.end_time }}</template></view>
          <template v-if="!isReg(bkDetail.booking)">
            <view v-if="bkDetail.booking.qty > 1" class="b-line">数量：{{ bkDetail.booking.qty }} 件</view>
            <view v-if="bkDetail.booking.headcount > 1" class="b-line">人数：{{ bkDetail.booking.headcount }} 人</view>
            <view v-if="bkDetail.booking.participants && bkDetail.booking.participants.length" class="b-line">
              参与人：{{ bkDetail.booking.participants.map((x) => x.user_name).join('、') }}
            </view>
          </template>
          <view v-if="bkDetail.booking.purpose" class="b-line">用途：{{ bkDetail.booking.purpose }}</view>
          <view v-if="bkDetail.booking.reject_reason" class="b-reject">驳回：{{ bkDetail.booking.reject_reason }}</view>
          <view class="f-label">操作轨迹</view>
          <view v-for="l in bkDetail.logs" :key="l.id" class="log-row">
            <text class="log-action">{{ logLabel(l.action) }}</text>
            <text class="log-meta">{{ l.actor_name }} · {{ l.create_time }}</text>
            <text v-if="l.comment" class="log-comment">{{ l.comment }}</text>
          </view>
        </scroll-view>
        <view v-else class="loading-text">加载中…</view>
        <button class="btn btn-primary modal-btn" @click="bkOpen = false">关闭</button>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { confirm, toast } from '../../../utils/guard.js';
import EmptyState from '../../../components/EmptyState.vue';

const statuses = [
  { key: '', label: '全部' },
  { key: 'pending', label: '待审批' },
  { key: 'confirmed', label: '已确认' },
  { key: 'rejected', label: '已驳回' },
  { key: 'canceled', label: '已取消' },
];
const status = ref('');
const rows = ref([]);
const filtered = computed(() => (status.value ? rows.value.filter((b) => b.status === status.value) : rows.value));

function bkLabel(s) { return { pending: '待审批', confirmed: '已确认', rejected: '已驳回', canceled: '已取消' }[s] || s; }
function bkCls(s) { return { pending: 'tag-amber', confirmed: 'tag-green', rejected: 'tag-red', canceled: 'tag-gray' }[s] || 'tag-gray'; }
function isReg(b) { return !!b && (b.item_kind === 'device' || b.item_kind === 'room'); }
function regLabel(b) { return b && b.item_kind === 'room' ? '教室登记' : '设备登记'; }
function previewImg(url) { uni.previewImage({ urls: [url] }); }

async function load() {
  const r = await api.bookingMine();
  rows.value = r.bookings || [];
}
async function cancel(b) {
  if (!(await confirm('确认取消该预约？'))) return;
  await api.bookingCancel(b.id);
  toast('已取消', 'success');
  load();
}

const bkOpen = ref(false);
const bkDetail = ref(null);
function logLabel(a) { return { created: '提交预约', approved: '审批通过', rejected: '驳回', canceled: '取消' }[a] || a; }
async function openOne(b) {
  bkOpen.value = true;
  bkDetail.value = null;
  const r = await api.bookingOne(b.id);
  bkDetail.value = { booking: r.booking, logs: r.logs || [] };
}

onShow(load);
</script>

<style lang="scss" scoped>
.chips { white-space: nowrap; margin-bottom: 16rpx; }
.chip { display: inline-block; background: #fff; border: 1rpx solid #e2e8f0; color: #475569; font-size: 24rpx; border-radius: 28rpx; padding: 10rpx 24rpx; margin-right: 12rpx; }
.chip.on { background: #eff6ff; border-color: #2563eb; color: #2563eb; font-weight: 700; }
.booking .b-head { display: flex; justify-content: space-between; align-items: center; gap: 12rpx; }
.b-res { font-size: 29rpx; font-weight: 700; color: #1e293b; flex: 1; }
.b-line { font-size: 24rpx; color: #64748b; margin-top: 8rpx; }
.b-reject { font-size: 23rpx; color: #b91c1c; background: #fef2f2; border-radius: 10rpx; padding: 10rpx 14rpx; margin-top: 10rpx; }
.b-tags { display: flex; gap: 8rpx; flex-shrink: 0; }
.reg-thumb { width: 200rpx; height: 150rpx; border-radius: 12rpx; margin: 12rpx 0; background: #f1f5f9; }
.reg-photo { width: 100%; border-radius: 12rpx; margin: 12rpx 0; }
.b-ops { display: flex; justify-content: flex-end; margin-top: 14rpx; }
.mini-btn { background: #eff6ff; color: #2563eb; font-size: 24rpx; border-radius: 26rpx; padding: 10rpx 28rpx; }
.mini-btn.danger { background: #fee2e2; color: #ef4444; }
.modal-mask { position: fixed; inset: 0; background: rgba(15,23,42,0.45); z-index: 100; display: flex; align-items: center; justify-content: center; padding: 48rpx; }
.modal { width: 100%; background: #fff; border-radius: 24rpx; padding: 32rpx; max-height: 82vh; display: flex; flex-direction: column; }
.modal-title { font-size: 32rpx; font-weight: 800; text-align: center; margin-bottom: 18rpx; }
.modal-scroll { max-height: 58vh; }
.modal-btn { height: 80rpx; font-size: 28rpx; margin-top: 18rpx; }
.bk-head { display: flex; justify-content: space-between; align-items: center; gap: 12rpx; margin-bottom: 12rpx; }
.bk-res { font-size: 30rpx; font-weight: 800; color: #1e293b; flex: 1; }
.f-label { font-size: 24rpx; color: #64748b; margin: 16rpx 4rpx 8rpx; }
.log-row { display: flex; flex-wrap: wrap; gap: 10rpx; align-items: center; background: #f8fafc; border-radius: 12rpx; padding: 14rpx 18rpx; margin-top: 10rpx; }
.log-action { font-size: 24rpx; font-weight: 700; color: #2563eb; }
.log-meta { font-size: 22rpx; color: #94a3b8; }
.log-comment { width: 100%; font-size: 23rpx; color: #475569; }
.loading-text { text-align: center; color: #94a3b8; padding: 60rpx 0; font-size: 26rpx; }
</style>
