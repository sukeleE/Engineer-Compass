<template>
  <view class="page-wrap">
    <view class="top-ops">
      <button class="btn btn-ghost half" @click="goMine">📋 我的预约</button>
      <button class="btn btn-primary half" @click="openCreate">＋ 新建预约项目</button>
    </view>
    <view v-if="canLab" class="lab-entry" @click="goRecords">🗂️ 借用记录管理（跨项目登记 / Excel 导出）›</view>

    <EmptyState v-if="!list.length" icon="🏢" text="暂无预约项目，创建后可登记场地/物品资源" />

    <view v-for="p in list" :key="p.id" class="card project" @click="openDetail(p)">
      <view class="p-head">
        <text class="p-name ellipsis">{{ p.name }}</text>
        <text class="tag" :class="p.status === 'open' ? 'tag-green' : 'tag-gray'">{{ p.status === 'open' ? '开放中' : '已关闭' }}</text>
      </view>
      <view v-if="p.description" class="p-desc ellipsis-2">{{ p.description }}</view>
      <view class="p-stats">
        <text>📦 {{ p.resource_count }} 个资源</text>
        <text v-if="p.canManage" class="pend">待审 {{ p.pending_count }}</text>
        <text>我的预约 {{ p.my_booking_count }}</text>
      </view>
      <view class="p-creator">负责人：{{ managerText(p) }}</view>
    </view>

    <view v-if="createOpen" class="modal-mask" @click="createOpen = false">
      <view class="modal" @click.stop>
        <view class="modal-title">新建预约项目</view>
        <input v-model="form.name" class="modal-input" maxlength="40" placeholder="项目名称（必填）" />
        <textarea v-model="form.description" class="modal-textarea" maxlength="500" placeholder="项目说明（选填）" />
        <view class="f-label">默认审批模式</view>
        <picker :range="modeLabels" :value="modeIndex" @change="onMode">
          <view class="modal-input picker-like">{{ modeLabels[modeIndex] }}</view>
        </picker>
        <view class="modal-actions">
          <button class="btn btn-ghost modal-btn" @click="createOpen = false">取消</button>
          <button class="btn btn-primary modal-btn" @click="submitCreate">创建</button>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, reactive, computed } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { toast, ensureLogin } from '../../../utils/guard.js';
import { canAdmin } from '../../../utils/adminPerms.js';
import auth from '../../../utils/auth.js';
import EmptyState from '../../../components/EmptyState.vue';

const canLab = computed(() => canAdmin('lab', auth.user));

const list = ref([]);
const createOpen = ref(false);
const form = reactive({ name: '', description: '', default_approve_mode: 'approval' });
const modeLabels = ['审批制（提交后负责人审批）', '先到先得（提交即确认）'];
const modeIndex = ref(0);

async function load() {
  const r = await api.bookingProjects();
  list.value = r.projects || [];
}
function managerText(p) {
  const ms = p.managers;
  if (!Array.isArray(ms) || !ms.length) return p.creator_name || '—';
  return ms.length === 1 ? ms[0].name : ms[0].name + ' 等 ' + ms.length + ' 人';
}
function openDetail(p) { uni.navigateTo({ url: '/packageOps/pages/booking/detail?id=' + p.id }); }
function goMine() { uni.navigateTo({ url: '/packageOps/pages/booking/mine' }); }
function goRecords() { uni.navigateTo({ url: '/packageOps/pages/booking/records' }); }
function openCreate() {
  if (!ensureLogin('登录后才能创建预约项目')) return;
  form.name = ''; form.description = ''; form.default_approve_mode = 'approval'; modeIndex.value = 0;
  createOpen.value = true;
}
function onMode(e) {
  modeIndex.value = Number(e.detail.value);
  form.default_approve_mode = modeIndex.value === 0 ? 'approval' : 'first_come';
}
async function submitCreate() {
  if (!form.name.trim()) return toast('请填写项目名称');
  await api.bookingProjectCreate({ name: form.name.trim(), description: form.description.trim(), default_approve_mode: form.default_approve_mode });
  createOpen.value = false;
  toast('项目已创建', 'success');
  load();
}

onShow(load);
</script>

<style lang="scss" scoped>
.top-ops { display: flex; gap: 16rpx; margin-bottom: 18rpx; }
.lab-entry { background: #eff6ff; color: #2563eb; border-radius: 14rpx; padding: 20rpx 24rpx; font-size: 25rpx; margin-bottom: 18rpx; }
.half { flex: 1; height: 80rpx; font-size: 27rpx; }
.project .p-head { display: flex; justify-content: space-between; align-items: center; gap: 14rpx; }
.p-name { font-size: 30rpx; font-weight: 800; color: #1e293b; flex: 1; }
.p-desc { font-size: 25rpx; color: #64748b; margin-top: 10rpx; line-height: 1.6; }
.p-stats { display: flex; gap: 24rpx; font-size: 23rpx; color: #64748b; margin-top: 14rpx; }
.p-stats .pend { color: #b45309; font-weight: 700; }
.p-creator { font-size: 22rpx; color: #94a3b8; margin-top: 8rpx; }
.modal-mask { position: fixed; inset: 0; background: rgba(15,23,42,0.45); z-index: 100; display: flex; align-items: center; justify-content: center; padding: 48rpx; }
.modal { width: 100%; background: #fff; border-radius: 24rpx; padding: 32rpx; }
.modal-title { font-size: 32rpx; font-weight: 800; text-align: center; margin-bottom: 20rpx; }
.modal-input { background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 14rpx; padding: 20rpx 22rpx; font-size: 27rpx; margin-bottom: 16rpx; }
.picker-like { color: #334155; }
.modal-textarea { width: 100%; box-sizing: border-box; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 14rpx; padding: 20rpx 22rpx; font-size: 27rpx; min-height: 150rpx; margin-bottom: 8rpx; }
.f-label { font-size: 24rpx; color: #64748b; margin: 8rpx 4rpx 10rpx; }
.modal-actions { display: flex; gap: 18rpx; margin-top: 14rpx; }
.modal-btn { flex: 1; height: 80rpx; font-size: 28rpx; }
</style>
