<template>
  <view class="page-wrap" v-if="d">
    <view class="card head">
      <view class="h-row">
        <text class="h-title">{{ d.event_name }}</text>
        <text class="tag" :class="statusCls(d.status)">{{ statusLabel(d.status) }}</text>
      </view>
      <view class="h-line">申请人：{{ d.applicant_name }}（{{ d.kind }}）</view>
      <view class="h-line">提交：{{ d.submit_time || d.create_time }}</view>
      <view v-if="d.approver_name" class="h-line">审批：{{ d.approver_name }}（{{ d.approver_role === 'teacher' ? '老师' : '负责人' }}）· {{ d.approve_time }}</view>
      <view v-if="d.reject_reason" class="reject-box">驳回理由：{{ d.reject_reason }}</view>
      <view class="amount">¥{{ d.amount }}</view>
    </view>

    <view v-if="d.remark" class="card">
      <view class="section-title" style="margin-left:0">备注</view>
      <view class="remark">{{ d.remark }}</view>
    </view>

    <view class="section-title">物料明细（{{ d.items.length }}）</view>
    <view v-for="it in d.items" :key="it.id" class="card item">
      <view class="i-head">
        <text class="i-name">{{ it.name }}</text>
        <text class="i-amount">¥{{ it.amount }}</text>
      </view>
      <view v-if="it.spec" class="i-line">规格：{{ it.spec }}</view>
      <view class="i-line">数量 {{ it.qty }} × 单价 ¥{{ it.unit_price }}</view>
      <view v-if="it.link" class="i-link" @click="openExternal(it.link)">🔗 购买链接（点击复制）</view>
      <view v-if="it.shot" class="shot-wrap">
        <image :src="fileUrl(it.shot.id)" class="i-shot" mode="widthFix" @click="previewFile('/api/purchase/files/' + it.shot.id, it.shot.orig_name)" />
        <text v-if="d.perm.canEdit" class="shot-del" @click.stop="removeShot(it)">删除截图</text>
      </view>
      <button v-else-if="d.perm.canEdit" class="btn btn-outline btn-sm btn-block" @click="uploadShot(it)">＋ 上传购买截图</button>
    </view>

    <view class="section-title">发票（{{ d.invoices.length }}）</view>
    <EmptyState v-if="!d.invoices.length" icon="🧾" text="还没有上传发票" />
    <view v-for="f in d.invoices" :key="f.id" class="card file-row" @click="previewFile('/api/purchase/files/' + f.id, f.orig_name)">
      <text class="file-icon">📄</text>
      <view class="file-main">
        <text class="file-name ellipsis">{{ f.orig_name }}</text>
        <text class="file-size">{{ sizeText(f.size) }} · {{ String(f.create_time).slice(5, 16) }}</text>
      </view>
      <text v-if="canDeleteInvoice" class="file-del" @click.stop="removeInvoice(f)">删除</text>
      <text class="file-open">打开</text>
    </view>

    <view v-if="d.logs.length" class="section-title">审批轨迹</view>
    <view v-for="l in d.logs" :key="l.id" class="card log">
      <text class="log-r" :class="l.result === 'approved' ? 'ok' : 'no'">{{ l.result === 'approved' ? '通过' : '驳回' }}</text>
      <text class="log-who">{{ l.approver_name }} · {{ l.create_time }}</text>
      <text v-if="l.comment" class="log-cm">{{ l.comment }}</text>
    </view>

    <view class="action-bar" v-if="d.perm.canEdit || d.perm.canDelete || d.perm.canApprove || d.perm.canInvoice">
      <button v-if="d.perm.canEdit" class="btn btn-ghost" @click="goEdit">编辑</button>
      <button v-if="d.perm.canDelete" class="btn btn-danger" @click="withdraw">撤回</button>
      <button v-if="d.perm.canInvoice" class="btn btn-outline" @click="uploadInvoice">传发票</button>
      <button v-if="d.perm.canApprove" class="btn btn-danger" @click="openReject">驳回</button>
      <button v-if="d.perm.canApprove" class="btn btn-primary" @click="approve">批准</button>
    </view>

    <view v-if="rejectOpen" class="modal-mask" @click="rejectOpen = false">
      <view class="modal" @click.stop>
        <view class="modal-title">驳回申请</view>
        <textarea v-model="reason" class="modal-textarea" maxlength="200" placeholder="必须填写驳回理由（学生据此修改）" />
        <view class="modal-actions">
          <button class="btn btn-ghost modal-btn" @click="rejectOpen = false">取消</button>
          <button class="btn btn-primary modal-btn" @click="reject">确认驳回</button>
        </view>
      </view>
    </view>
  </view>
  <EmptyState v-else :icon="loadError ? '⚠️' : '⏳'" :text="loadError || '加载中…'" :btn-text="loadError ? '重新加载' : ''" @action="load" />
</template>

<script setup>
import { ref, computed } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { confirm, toast } from '../../../utils/guard.js';
import { previewFile, openExternal, authedUrl } from '../../../utils/preview.js';
import { chooseImage, chooseInvoiceFile } from '../../../utils/upload.js';
import EmptyState from '../../../components/EmptyState.vue';

const id = ref(null);
const d = ref(null);
const loadError = ref('');
const rejectOpen = ref(false);
const reason = ref('');

function statusLabel(s) { return { pending: '待审批', approved: '已通过·待传票', invoiced: '已传发票', rejected: '已驳回' }[s] || s; }
function statusCls(s) { return { pending: 'tag-amber', approved: 'tag-blue', invoiced: 'tag-green', rejected: 'tag-red' }[s] || 'tag-gray'; }
function sizeText(n) {
  const v = Number(n) || 0;
  if (v > 1048576) return (v / 1048576).toFixed(1) + ' MB';
  if (v > 1024) return Math.round(v / 1024) + ' KB';
  return v + ' B';
}
function fileUrl(fid) {
  // <image> 无法带 Authorization 头，走后端支持的 ?token= 直连（同 previewImages 链路）
  return authedUrl('/api/purchase/files/' + fid);
}

async function load() {
  try {
    const r = await api.purchaseRequest(id.value);
    d.value = r.detail;
    loadError.value = '';
  } catch (e) {
    // request.js 已全局 toast；首次加载失败时停留重试态，避免无限“加载中”
    if (!d.value) loadError.value = e.message || '加载失败，请稍后重试';
  }
}
function goEdit() { uni.navigateTo({ url: '/packageOps/pages/purchase/create?id=' + id.value }); }
async function withdraw() {
  if (!(await confirm('撤回后该申请及其附件将删除，确认撤回？'))) return;
  await api.purchaseDelete(id.value);
  toast('已撤回', 'success');
  setTimeout(() => uni.navigateBack(), 600);
}
async function approve() {
  if (!(await confirm('确认批准该采购申请？'))) return;
  await api.purchaseApprove(id.value, { comment: '' });
  toast('已批准', 'success');
  load();
}
function openReject() { reason.value = ''; rejectOpen.value = true; }
async function reject() {
  if (!reason.value.trim()) return toast('请填写驳回理由');
  await api.purchaseReject(id.value, { reason: reason.value.trim() });
  rejectOpen.value = false;
  toast('已驳回', 'success');
  load();
}
const canDeleteInvoice = computed(() => !!d.value && (d.value.perm.canInvoice || d.value.perm.isSuperAdmin));

async function uploadShot(it) {
  try {
    const filePath = await chooseImage();
    uni.showLoading({ title: '上传中…', mask: true });
    await api.purchaseShot(id.value, it.id, filePath);
    uni.hideLoading();
    toast('截图已上传', 'success');
    load();
  } catch (e) {
    uni.hideLoading();
  }
}
async function removeShot(it) {
  if (!(await confirm('删除该物料的购买截图？'))) return;
  await api.purchaseFileDelete(it.shot.id);
  toast('已删除', 'success');
  load();
}
async function removeInvoice(f) {
  if (!(await confirm('删除发票「' + f.orig_name + '」？删光发票后状态将退回待传发票。'))) return;
  await api.purchaseFileDelete(f.id);
  toast('已删除', 'success');
  load();
}
async function uploadInvoice() {
  try {
    const picked = await chooseInvoiceFile();
    uni.showLoading({ title: '上传中…', mask: true });
    await api.purchaseInvoice(id.value, picked.filePath);
    uni.hideLoading();
    toast('发票已上传', 'success');
    load();
  } catch (e) {
    uni.hideLoading();
  }
}

onLoad((o) => { id.value = Number(o.id); });
onShow(() => { if (id.value) load(); });
</script>

<style lang="scss" scoped>
.head .h-row { display: flex; justify-content: space-between; align-items: center; gap: 14rpx; }
.h-title { font-size: 32rpx; font-weight: 800; color: #1e293b; flex: 1; }
.h-line { font-size: 25rpx; color: #64748b; margin-top: 10rpx; }
.reject-box { background: #fef2f2; color: #b91c1c; font-size: 24rpx; border-radius: 10rpx; padding: 12rpx 16rpx; margin-top: 12rpx; }
.amount { text-align: right; font-size: 44rpx; font-weight: 800; color: #dc2626; margin-top: 12rpx; }
.remark { font-size: 26rpx; color: #334155; line-height: 1.6; }
.item .i-head { display: flex; justify-content: space-between; align-items: center; }
.i-name { font-size: 28rpx; font-weight: 700; color: #1e293b; flex: 1; }
.i-amount { color: #dc2626; font-weight: 700; }
.i-line { font-size: 24rpx; color: #64748b; margin-top: 8rpx; }
.i-link { font-size: 24rpx; color: #2563eb; margin-top: 8rpx; }
.i-shot { width: 100%; border-radius: 12rpx; margin-top: 12rpx; }
.shot-wrap { position: relative; }
.shot-del { position: absolute; top: 22rpx; right: 12rpx; background: rgba(239,68,68,0.92); color: #fff; font-size: 22rpx; border-radius: 22rpx; padding: 6rpx 18rpx; }
.file-del { font-size: 24rpx; color: #ef4444; background: #fef2f2; border-radius: 24rpx; padding: 8rpx 20rpx; margin-right: 12rpx; }
.btn-sm { height: 72rpx; font-size: 26rpx; margin-top: 12rpx; }
.file-row { display: flex; align-items: center; gap: 16rpx; }
.file-icon { font-size: 40rpx; }
.file-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.file-name { font-size: 27rpx; color: #1e293b; }
.file-size { font-size: 22rpx; color: #94a3b8; margin-top: 4rpx; }
.file-open { font-size: 24rpx; color: #2563eb; background: #eff6ff; border-radius: 24rpx; padding: 8rpx 22rpx; }
.log { display: flex; flex-wrap: wrap; align-items: center; gap: 12rpx; }
.log-r { font-size: 24rpx; border-radius: 8rpx; padding: 4rpx 14rpx; }
.log-r.ok { background: #f0fdf4; color: #166534; }
.log-r.no { background: #fef2f2; color: #b91c1c; }
.log-who { font-size: 24rpx; color: #64748b; }
.log-cm { width: 100%; font-size: 24rpx; color: #475569; margin-top: 6rpx; }
.modal-mask { position: fixed; inset: 0; background: rgba(15,23,42,0.45); z-index: 100; display: flex; align-items: center; justify-content: center; padding: 48rpx; }
.modal { width: 100%; background: #fff; border-radius: 24rpx; padding: 32rpx; }
.modal-title { font-size: 32rpx; font-weight: 800; text-align: center; margin-bottom: 20rpx; }
.modal-textarea { width: 100%; box-sizing: border-box; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 14rpx; padding: 20rpx 22rpx; font-size: 27rpx; min-height: 180rpx; }
.modal-actions { display: flex; gap: 18rpx; margin-top: 20rpx; }
.modal-btn { flex: 1; height: 80rpx; font-size: 28rpx; }
.action-bar { z-index: 60; }
.action-bar .btn { flex: 1; height: 78rpx; font-size: 26rpx; padding: 0 10rpx; }
</style>
