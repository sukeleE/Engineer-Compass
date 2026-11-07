<template>
  <view class="page-wrap" v-if="detail">
    <Tabs v-model="tab" :tabs="[{ key: 'devices', label: '设备台账' }, { key: 'bookings', label: '预约记录', badge: bookings.length }]" />

    <block v-if="tab === 'devices'">
      <button v-if="detail.perms.device" class="btn btn-primary btn-block" @click="addOpen = true">＋ 添加设备</button>
      <EmptyState v-if="!detail.devices.length" icon="🔧" text="暂无设备，组长可添加" />
      <view v-for="d in detail.devices" :key="d.id" class="card device">
        <view class="d-head">
          <text class="d-name">{{ d.name }}</text>
          <text class="tag" :class="d.in_use ? 'tag-red' : 'tag-green'">{{ d.in_use ? '使用中' : '空闲' }}</text>
        </view>
        <view v-if="d.spec" class="d-spec">{{ d.spec }}</view>
        <view class="d-ops">
          <view class="mini-btn" @click="openBooking(d)">预约</view>
          <view v-if="detail.perms.device" class="mini-btn danger" @click="removeDevice(d)">删除</view>
        </view>
      </view>
    </block>

    <block v-else>
      <EmptyState v-if="!bookings.length" icon="📅" text="暂无预约记录" />
      <view v-for="b in bookings" :key="b.id" class="card booking">
        <view class="b-head">
          <text class="b-device">{{ b.device_name }}</text>
          <text class="tag" :class="statusCls(b.status)">{{ statusLabel(b.status) }}</text>
        </view>
        <view class="b-line">预约人：{{ b.user_name }}</view>
        <view class="b-line">时间：{{ b.start_time }} ~ {{ b.end_time }}</view>
        <view v-if="b.purpose" class="b-line">用途：{{ b.purpose }}</view>
        <view class="b-ops">
          <view v-if="detail.perms.device_approve && b.status === 'pending'" class="mini-btn" @click="approve(b, 'approved')">批准</view>
          <view v-if="detail.perms.device_approve && b.status === 'pending'" class="mini-btn danger" @click="approve(b, 'rejected')">驳回</view>
          <view v-if="b.user_id === myId && b.status === 'pending'" class="mini-btn danger" @click="cancel(b)">取消</view>
        </view>
      </view>
    </block>

    <!-- 添加设备 -->
    <view v-if="addOpen" class="modal-mask" @click="addOpen = false">
      <view class="modal" @click.stop>
        <view class="modal-title">添加设备</view>
        <input v-model="devForm.name" class="modal-input" placeholder="设备名称（必填）" />
        <input v-model="devForm.spec" class="modal-input" placeholder="规格型号（选填）" />
        <view class="modal-actions">
          <button class="btn btn-ghost modal-btn" @click="addOpen = false">取消</button>
          <button class="btn btn-primary modal-btn" @click="addDevice">保存</button>
        </view>
      </view>
    </view>

    <!-- 预约表单 -->
    <view v-if="bookOpen" class="modal-mask" @click="bookOpen = false">
      <view class="modal" @click.stop>
        <view class="modal-title">预约「{{ bookingDevice?.name }}」</view>
        <picker mode="date" @change="(e) => (bookForm.date = e.detail.value)">
          <view class="modal-input picker-like">{{ bookForm.date || '选择日期' }}</view>
        </picker>
        <view class="time-row">
          <picker mode="time" @change="(e) => (bookForm.start = e.detail.value)">
            <view class="modal-input picker-like half">{{ bookForm.start || '开始时间' }}</view>
          </picker>
          <picker mode="time" @change="(e) => (bookForm.end = e.detail.value)">
            <view class="modal-input picker-like half">{{ bookForm.end || '结束时间' }}</view>
          </picker>
        </view>
        <input v-model="bookForm.purpose" class="modal-input" placeholder="用途（选填）" />
        <view class="modal-actions">
          <button class="btn btn-ghost modal-btn" @click="bookOpen = false">取消</button>
          <button class="btn btn-primary modal-btn" @click="submitBooking">提交预约</button>
        </view>
      </view>
    </view>
  </view>
  <view v-else class="empty"><view class="empty-text">加载中…</view></view>
</template>

<script setup>
import { ref, reactive, computed } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { confirm, toast } from '../../../utils/guard.js';
import auth from '../../../utils/auth.js';
import Tabs from '../../../components/Tabs.vue';
import EmptyState from '../../../components/EmptyState.vue';

const id = ref(null);
const detail = ref(null);
const tab = ref('devices');
const bookings = ref([]);
const myId = computed(() => auth.user?.id);
const addOpen = ref(false);
const devForm = reactive({ name: '', spec: '' });
const bookOpen = ref(false);
const bookingDevice = ref(null);
const bookForm = reactive({ date: '', start: '', end: '', purpose: '' });

function statusLabel(s) { return { pending: '待审批', approved: '已批准', rejected: '已驳回/取消' }[s] || s; }
function statusCls(s) { return { pending: 'tag-amber', approved: 'tag-green', rejected: 'tag-red' }[s] || 'tag-gray'; }

async function load() {
  detail.value = await api.teamDetail(id.value);
  bookings.value = await api.collabBookings(id.value);
}
async function addDevice() {
  if (!devForm.name.trim()) return toast('设备名必填');
  await api.collabDeviceCreate(id.value, { name: devForm.name, spec: devForm.spec });
  addOpen.value = false;
  devForm.name = ''; devForm.spec = '';
  toast('已添加', 'success');
  load();
}
async function removeDevice(d) {
  if (!(await confirm('删除该设备？'))) return;
  await api.collabDeviceDelete(id.value, d.id);
  load();
}
function openBooking(d) {
  bookingDevice.value = d;
  bookForm.date = ''; bookForm.start = ''; bookForm.end = ''; bookForm.purpose = '';
  bookOpen.value = true;
}
async function submitBooking() {
  if (!bookForm.date || !bookForm.start || !bookForm.end) return toast('请完整选择日期和时间');
  const start_time = bookForm.date + ' ' + bookForm.start + ':00';
  const end_time = bookForm.date + ' ' + bookForm.end + ':00';
  if (start_time >= end_time) return toast('结束时间需晚于开始时间');
  try {
    await api.collabBookingCreate(id.value, { device_id: bookingDevice.value.id, start_time, end_time, purpose: bookForm.purpose });
    bookOpen.value = false;
    toast('预约已提交', 'success');
    tab.value = 'bookings';
    load();
  } catch (e) { /* 409 冲突已 toast */ }
}
async function approve(b, status) {
  await api.collabBookingUpdate(id.value, b.id, { status });
  load();
}
async function cancel(b) {
  if (!(await confirm('取消该预约？'))) return;
  await api.collabBookingUpdate(id.value, b.id, {});
  load();
}

onLoad((o) => { id.value = Number(o.id); });
onShow(() => { if (id.value) load(); });
</script>

<style lang="scss" scoped>
.device, .booking { padding: 24rpx 28rpx; }
.d-head, .b-head { display: flex; justify-content: space-between; align-items: center; gap: 14rpx; }
.d-name, .b-device { font-size: 29rpx; font-weight: 700; color: #1e293b; }
.d-spec { font-size: 24rpx; color: #64748b; margin-top: 8rpx; }
.d-ops, .b-ops { display: flex; gap: 14rpx; justify-content: flex-end; margin-top: 16rpx; }
.mini-btn { background: #eff6ff; color: #2563eb; font-size: 24rpx; border-radius: 26rpx; padding: 10rpx 28rpx; }
.mini-btn.danger { background: #fee2e2; color: #ef4444; }
.b-line { font-size: 25rpx; color: #475569; margin-top: 10rpx; }
.modal-mask { position: fixed; inset: 0; background: rgba(15,23,42,.45); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { width: 660rpx; background: #fff; border-radius: 24rpx; padding: 32rpx; }
.modal-title { font-size: 31rpx; font-weight: 700; margin-bottom: 18rpx; }
.modal-input { height: 84rpx; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 12rpx; padding: 0 20rpx; font-size: 26rpx; margin-bottom: 16rpx; line-height: 84rpx; }
.picker-like { color: #475569; }
.time-row { display: flex; gap: 14rpx; }
.half { flex: 1; }
.modal-actions { display: flex; gap: 18rpx; }
.modal-btn { flex: 1; height: 80rpx; font-size: 28rpx; }
</style>