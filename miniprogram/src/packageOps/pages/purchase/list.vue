<template>
  <view class="page-wrap">
    <view class="toolbar">
      <view v-if="canApproveAny" class="seg">
        <view class="seg-item" :class="{ on: scope === 'mine' }" @click="switchScope('mine')">我的申请</view>
        <view class="seg-item" :class="{ on: scope === 'approve' }" @click="switchScope('approve')">待我审批</view>
      </view>
      <view class="tool-btn" @click="openStats">📊 统计</view>
      <view class="tool-btn" @click="exportXlsx">{{ exporting ? "导出中…" : "⬇ 导出" }}</view>
      <view class="tool-btn primary" @click="openEvent">＋ 档案</view>
    </view>

    <view class="sub-bar">
      <scroll-view scroll-x class="chips" :show-scrollbar="false">
        <view v-for="s in statuses" :key="s.key" class="chip" :class="{ on: status === s.key }" @click="changeStatus(s.key)">{{ s.label }}</view>
      </scroll-view>
      <view class="manage-entry" @click="openEventList">档案管理 ›</view>
    </view>

    <EmptyState v-if="!loading && !rows.length" icon="🛒" text="暂无采购申请" btnText="新建采购申请" @action="goCreate" />

    <view v-for="r in rows" :key="r.id" class="card req" @click="openDetail(r)">
      <view class="r-head">
        <text class="r-title ellipsis">{{ r.event_name }}</text>
        <text class="tag" :class="statusCls(r.status)">{{ statusLabel(r.status) }}</text>
      </view>
      <view class="r-line">申请人：{{ r.applicant_name }} · {{ r.item_count }} 项物料</view>
      <view v-if="r.remark" class="r-line ellipsis">备注：{{ r.remark }}</view>
      <view v-if="r.status === 'rejected' && r.reject_reason" class="r-reject">驳回理由：{{ r.reject_reason }}</view>
      <view class="r-foot">
        <text class="r-amount">¥{{ r.amount }}</text>
        <text class="r-time">{{ String(r.submit_time || r.update_time).slice(5, 16) }}</text>
      </view>
    </view>

    <view class="fab" @click="goCreate">＋</view>

    <!-- 新建档案 -->
    <view v-if="eventOpen" class="modal-mask" @click="eventOpen = false">
      <view class="modal" @click.stop>
        <view class="modal-title">新建采购档案</view>
        <input v-model="evForm.name" class="modal-input" maxlength="40" placeholder="比赛/项目名称（必填）" />
        <picker :range="kinds" :value="kindIndex" @change="onKind">
          <view class="modal-input picker-like">{{ kinds[kindIndex] }}</view>
        </picker>
        <textarea v-model="evForm.description" class="modal-textarea" maxlength="500" placeholder="档案说明（选填）" />
        <view class="modal-actions">
          <button class="btn btn-ghost modal-btn" @click="eventOpen = false">取消</button>
          <button class="btn btn-primary modal-btn" @click="submitEvent">创建</button>
        </view>
      </view>
    </view>

    <!-- 档案管理列表 -->
    <view v-if="eventListOpen" class="modal-mask" @click="eventListOpen = false">
      <view class="modal modal-lg" @click.stop>
        <view class="modal-title">采购档案（{{ events.length }}）</view>
        <scroll-view scroll-y class="modal-scroll">
          <EmptyState v-if="!events.length" icon="📁" text="还没有档案，点右上角＋新建" />
          <view v-for="e in events" :key="e.id" class="ev-row">
            <view class="ev-main" @click="openEventEdit(e)">
              <text class="ev-name ellipsis">{{ e.name }}</text>
              <view class="ev-meta">
                <text class="mini-tag">{{ e.kind }}</text>
                <text class="mini-tag" :class="e.status === 'open' ? 'tag-green' : 'tag-gray'">{{ e.status === 'open' ? '开放中' : '已关闭' }}</text>
                <text v-if="e.myRole" class="mini-tag tag-blue">{{ e.myRole === 'leader' ? '负责人' : '老师' }}</text>
              </view>
            </view>
            <view v-if="e.canManage || e.canSettings" class="ev-ops">
              <text v-if="e.canManage" class="mini-btn" @click.stop="openApprovers(e)">审批人</text>
              <text v-if="e.canSettings" class="mini-btn" @click.stop="openEventEdit(e)">设置</text>
            </view>
          </view>
        </scroll-view>
        <button class="btn btn-primary modal-btn" @click="eventListOpen = false">关闭</button>
      </view>
    </view>

    <!-- 档案设置（改名/类型/说明/关闭重开/删除） -->
    <view v-if="eventEditOpen" class="modal-mask" @click="eventEditOpen = false">
      <view class="modal" @click.stop>
        <view class="modal-title">档案设置</view>
        <input v-model="editForm.name" class="modal-input" maxlength="40" placeholder="比赛/项目名称" />
        <picker :range="kinds" :value="editKindIndex" @change="onEditKind">
          <view class="modal-input picker-like">{{ kinds[editKindIndex] }}</view>
        </picker>
        <textarea v-model="editForm.description" class="modal-textarea" maxlength="500" placeholder="档案说明（选填）" />
        <view class="switch-row">
          <text>开放申请</text>
          <switch :checked="editForm.status === 'open'" color="#2563eb" @change="onEditStatus" />
        </view>
        <view class="modal-actions">
          <button v-if="editEvent && editEvent.canSettings" class="btn btn-danger modal-btn" @click="removeEvent">删除档案</button>
          <button class="btn btn-ghost modal-btn" @click="eventEditOpen = false">取消</button>
          <button class="btn btn-primary modal-btn" @click="saveEvent">保存</button>
        </view>
      </view>
    </view>

    <!-- 审批人管理 -->
    <view v-if="approverOpen" class="modal-mask" @click="approverOpen = false">
      <view class="modal modal-lg" @click.stop>
        <view class="modal-title">审批人管理</view>
        <scroll-view scroll-y class="modal-scroll">
          <view v-for="a in approvers" :key="a.user_id" class="ap-row">
            <view class="ap-main">
              <text class="ap-name">{{ a.real_name || a.nickname || a.username }}</text>
              <text class="ap-sub">{{ a.role === 'teacher' ? '老师' : '负责人' }}<text v-if="a.is_creator"> · 建档者</text></text>
            </view>
            <text v-if="!a.is_creator" class="mini-btn danger" @click="removeApprover(a)">移除</text>
          </view>
          <EmptyState v-if="!approvers.length" icon="👤" text="暂无审批人" />
          <view class="ap-search">
            <input v-model="userQuery" class="modal-input" maxlength="20" placeholder="搜登录名/昵称/真名添加审批人" @confirm="searchUsers" />
            <button class="btn btn-ghost search-btn" @click="searchUsers">搜索</button>
          </view>
          <view v-for="u in userHits" :key="u.id" class="ap-row">
            <view class="ap-main">
              <text class="ap-name">{{ u.real_name || u.nickname || u.username }}</text>
              <text class="ap-sub">@{{ u.username }}</text>
            </view>
            <view class="ap-add">
              <text class="mini-btn" @click="addApprover(u, 'leader')">负责人</text>
              <text class="mini-btn" @click="addApprover(u, 'teacher')">老师</text>
            </view>
          </view>
        </scroll-view>
        <button class="btn btn-primary modal-btn" @click="approverOpen = false">完成</button>
      </view>
    </view>

    <!-- 统计 -->
    <view v-if="statsOpen" class="modal-mask" @click="statsOpen = false">
      <view class="modal modal-lg" @click.stop>
        <view class="modal-title">采购统计{{ statsMine ? '（我的）' : '（全档案）' }}</view>
        <scroll-view scroll-y class="modal-scroll" v-if="stats">
          <view class="st-grid">
            <view class="st-cell"><text class="st-num">{{ stats.total }}</text><text class="st-lbl">申请总数</text></view>
            <view class="st-cell"><text class="st-num red">¥{{ stats.total_amount }}</text><text class="st-lbl">已通过金额</text></view>
          </view>
          <view class="st-section">按状态</view>
          <view v-for="(v, k) in stats.by_status" :key="k" class="st-line">
            <text>{{ statusLabel(k) }}</text>
            <text>{{ v.count }} 单 · ¥{{ v.amount }}</text>
          </view>
          <view class="st-section">按档案（{{ stats.by_event.length }}）</view>
          <view v-for="g in stats.by_event" :key="g.event_id" class="st-line">
            <text class="ellipsis st-name">{{ g.name }}</text>
            <text>{{ g.count }} 单 · 已批 ¥{{ g.approved_amount }}</text>
          </view>
          <view v-if="!statsMine && stats.by_user.length" class="st-section">按申请人</view>
          <view v-for="g in stats.by_user" :key="g.user_id" class="st-line">
            <text class="ellipsis st-name">{{ g.name }}</text>
            <text>{{ g.count }} 单 · ¥{{ g.approved_amount }}</text>
          </view>
        </scroll-view>
        <view v-else class="loading-text">加载中…</view>
        <button class="btn btn-primary modal-btn" @click="statsOpen = false">关闭</button>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, reactive, computed } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { qs } from '../../../utils/request.js';
import { toast, confirm, ensureLogin } from '../../../utils/guard.js';
import { downloadAndOpen } from '../../../utils/download.js';
import EmptyState from '../../../components/EmptyState.vue';

const statuses = [
  { key: '', label: '全部' },
  { key: 'pending', label: '待审批' },
  { key: 'approved', label: '已通过' },
  { key: 'invoiced', label: '已传发票' },
  { key: 'rejected', label: '已驳回' },
];
const kinds = ['比赛', '项目'];
const scope = ref('mine');
const status = ref('');
const rows = ref([]);
const events = ref([]);
const loading = ref(false);
const eventOpen = ref(false);
const evForm = reactive({ name: '', kind: '比赛', description: '' });
const kindIndex = ref(0);

const canApproveAny = computed(() => events.value.some((e) => e.canApprove));
function statusLabel(s) { return { pending: '待审批', approved: '已通过·待传票', invoiced: '已传发票', rejected: '已驳回' }[s] || s; }
function statusCls(s) { return { pending: 'tag-amber', approved: 'tag-blue', invoiced: 'tag-green', rejected: 'tag-red' }[s] || 'tag-gray'; }

async function loadEvents() { events.value = (await api.purchaseEvents()).events || []; }
async function load() {
  loading.value = true;
  try {
    const p = { status: status.value };
    if (scope.value === 'mine') p.mine = 1;
    const r = await api.purchaseRequests(p);
    rows.value = r.requests || [];
  } finally {
    loading.value = false;
  }
}
function switchScope(s) { scope.value = s; load(); }
function changeStatus(s) { status.value = s; load(); }
const exporting = ref(false);
async function exportXlsx() {
  if (exporting.value) return;
  exporting.value = true;
  try {
    const p = { status: status.value };
    if (scope.value === 'mine') p.mine = 1;
    const today = new Date().toISOString().slice(0, 10);
    await downloadAndOpen('/api/purchase/export.xlsx' + qs(p), '物料采购-' + today + '.xlsx');
  } catch (e) { /* 下载工具已 toast */ } finally {
    exporting.value = false;
  }
}
function goCreate() {
  if (!ensureLogin('登录后才能提交采购申请')) return;
  uni.navigateTo({ url: '/packageOps/pages/purchase/create' });
}
function openEvent() {
  if (!ensureLogin('登录后才能新建采购档案')) return;
  evForm.name = ''; evForm.kind = '比赛'; evForm.description = ''; kindIndex.value = 0;
  eventOpen.value = true;
}
function openDetail(r) { uni.navigateTo({ url: '/packageOps/pages/purchase/detail?id=' + r.id }); }
function onKind(e) { kindIndex.value = Number(e.detail.value); evForm.kind = kinds[kindIndex.value]; }
async function submitEvent() {
  if (!evForm.name.trim()) return toast('请填写名称');
  await api.purchaseEventCreate({ name: evForm.name.trim(), kind: evForm.kind, description: evForm.description.trim() });
  eventOpen.value = false;
  toast('档案已创建', 'success');
  loadEvents();
}

// ============ 档案管理 ============
const eventListOpen = ref(false);
function openEventList() {
  if (!ensureLogin('登录后才能管理采购档案')) return;
  eventListOpen.value = true;
}

// 档案设置
const eventEditOpen = ref(false);
const editEvent = ref(null);
const editForm = reactive({ name: '', kind: '比赛', description: '', status: 'open' });
const editKindIndex = ref(0);
function openEventEdit(e) {
  if (!e.canSettings) { toast('仅建档者或管理员可修改档案设置'); return; }
  editEvent.value = e;
  editForm.name = e.name;
  editForm.kind = e.kind;
  editForm.description = e.description || '';
  editForm.status = e.status;
  editKindIndex.value = Math.max(0, kinds.indexOf(e.kind));
  eventListOpen.value = false;
  eventEditOpen.value = true;
}
function onEditKind(e) { editKindIndex.value = Number(e.detail.value); editForm.kind = kinds[editKindIndex.value]; }
function onEditStatus(ev) { editForm.status = ev.detail.value ? 'open' : 'closed'; }
async function saveEvent() {
  if (!editForm.name.trim()) return toast('请填写名称');
  await api.purchaseEventUpdate(editEvent.value.id, {
    name: editForm.name.trim(),
    kind: editForm.kind,
    description: editForm.description.trim(),
    status: editForm.status,
  });
  eventEditOpen.value = false;
  toast('已保存', 'success');
  loadEvents();
}
async function removeEvent() {
  const e = editEvent.value;
  if (!(await confirm('删除档案「' + e.name + '」？其下无申请时才可删除。'))) return;
  await api.purchaseEventDelete(e.id);
  eventEditOpen.value = false;
  toast('档案已删除', 'success');
  loadEvents();
}

// 审批人管理
const approverOpen = ref(false);
const approverEvent = ref(null);
const approvers = ref([]);
const userQuery = ref('');
const userHits = ref([]);
async function openApprovers(e) {
  approverEvent.value = e;
  approverOpen.value = true;
  userQuery.value = '';
  userHits.value = [];
  const r = await api.purchaseApprovers(e.id);
  approvers.value = r.approvers || [];
}
async function searchUsers() {
  const q = userQuery.value.trim();
  if (!q) return toast('请输入关键词');
  const eid = approverEvent.value.id;
  const r = await api.purchaseUserSearch(q, eid);
  userHits.value = r.users || [];
  if (!userHits.value.length) toast('未找到匹配用户');
}
async function addApprover(u, role) {
  const eid = approverEvent.value.id;
  await api.purchaseApproverAdd(eid, { user_id: u.id, role });
  toast('已添加', 'success');
  const r = await api.purchaseApprovers(eid);
  approvers.value = r.approvers || [];
  userHits.value = userHits.value.filter((x) => x.id !== u.id);
}
async function removeApprover(a) {
  if (!(await confirm('移除审批人「' + (a.real_name || a.nickname || a.username) + '」？'))) return;
  const eid = approverEvent.value.id;
  await api.purchaseApproverRemove(eid, a.user_id);
  const r = await api.purchaseApprovers(eid);
  approvers.value = r.approvers || [];
}

// 统计
const statsOpen = ref(false);
const stats = ref(null);
const statsMine = ref(false);
async function openStats() {
  if (!ensureLogin('登录后才能查看统计')) return;
  statsOpen.value = true;
  stats.value = null;
  // 无任何审批身份时走个人统计（后端 403 兜底）
  const mine = !canApproveAny.value;
  statsMine.value = mine;
  try {
    stats.value = await api.purchaseStats(mine ? { mine: 1 } : {});
  } catch (e) {
    stats.value = await api.purchaseStats({ mine: 1 });
    statsMine.value = true;
  }
}

onShow(() => { loadEvents(); load(); });
</script>

<style lang="scss" scoped>
.toolbar { display: flex; align-items: center; gap: 16rpx; margin-bottom: 16rpx; }
.seg { flex: 1; display: flex; background: #fff; border-radius: 16rpx; padding: 8rpx; border: 1rpx solid #e2e8f0; }
.tool-btn { flex: none; height: 68rpx; line-height: 68rpx; padding: 0 24rpx; border-radius: 14rpx; background: #fff; border: 1rpx solid #e2e8f0; color: #334155; font-size: 25rpx; font-weight: 700; }
.tool-btn.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
.seg-item { flex: 1; text-align: center; font-size: 26rpx; color: #64748b; padding: 14rpx 0; border-radius: 12rpx; }
.seg-item.on { background: #2563eb; color: #fff; font-weight: 700; }
.sub-bar { display: flex; align-items: center; gap: 12rpx; margin-bottom: 16rpx; }
.chips { flex: 1; white-space: nowrap; }
.chip { display: inline-block; background: #fff; border: 1rpx solid #e2e8f0; color: #475569; font-size: 24rpx; border-radius: 28rpx; padding: 10rpx 24rpx; margin-right: 12rpx; }
.chip.on { background: #eff6ff; border-color: #2563eb; color: #2563eb; font-weight: 700; }
.manage-entry { flex: none; font-size: 23rpx; color: #2563eb; background: #eff6ff; border-radius: 24rpx; padding: 10rpx 20rpx; }
.req .r-head { display: flex; justify-content: space-between; align-items: center; gap: 14rpx; }
.r-title { font-size: 29rpx; font-weight: 700; color: #1e293b; flex: 1; }
.r-line { font-size: 24rpx; color: #64748b; margin-top: 8rpx; }
.r-reject { font-size: 23rpx; color: #b91c1c; background: #fef2f2; border-radius: 10rpx; padding: 10rpx 14rpx; margin-top: 10rpx; }
.r-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 14rpx; }
.r-amount { color: #dc2626; font-size: 32rpx; font-weight: 800; }
.r-time { font-size: 22rpx; color: #94a3b8; }
.fab { position: fixed; right: 36rpx; bottom: calc(60rpx + env(safe-area-inset-bottom)); width: 96rpx; height: 96rpx; border-radius: 50%; background: #2563eb; color: #fff; font-size: 56rpx; display: flex; align-items: center; justify-content: center; box-shadow: 0 8rpx 24rpx rgba(37,99,235,0.4); z-index: 40; }
.modal-mask { position: fixed; inset: 0; background: rgba(15,23,42,0.45); z-index: 100; display: flex; align-items: center; justify-content: center; padding: 48rpx; }
.modal { width: 100%; background: #fff; border-radius: 24rpx; padding: 32rpx; }
.modal-lg { max-height: 82vh; display: flex; flex-direction: column; }
.modal-scroll { max-height: 56vh; }
.modal-title { font-size: 32rpx; font-weight: 800; text-align: center; margin-bottom: 20rpx; }
.modal-input { background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 14rpx; padding: 20rpx 22rpx; font-size: 27rpx; margin-bottom: 16rpx; }
.picker-like { color: #334155; }
.modal-textarea { width: 100%; box-sizing: border-box; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 14rpx; padding: 20rpx 22rpx; font-size: 27rpx; min-height: 160rpx; margin-bottom: 16rpx; }
.modal-actions { display: flex; gap: 18rpx; }
.modal-btn { flex: 1; height: 80rpx; font-size: 28rpx; }
.switch-row { display: flex; justify-content: space-between; align-items: center; margin: 6rpx 0 14rpx; font-size: 27rpx; color: #334155; }
.mini-tag { display: inline-block; font-size: 20rpx; border-radius: 8rpx; padding: 2rpx 12rpx; background: #f1f5f9; color: #475569; margin-right: 8rpx; }
.mini-btn { background: #eff6ff; color: #2563eb; font-size: 23rpx; border-radius: 24rpx; padding: 8rpx 20rpx; margin-left: 10rpx; }
.mini-btn.danger { background: #fee2e2; color: #ef4444; }
.ev-row { display: flex; align-items: center; gap: 14rpx; padding: 20rpx 6rpx; border-bottom: 1rpx solid #f1f5f9; }
.ev-main { flex: 1; min-width: 0; }
.ev-name { font-size: 28rpx; font-weight: 700; color: #1e293b; display: block; }
.ev-meta { margin-top: 8rpx; }
.ev-ops { flex: none; display: flex; }
.ap-row { display: flex; align-items: center; gap: 14rpx; padding: 18rpx 6rpx; border-bottom: 1rpx solid #f1f5f9; }
.ap-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4rpx; }
.ap-name { font-size: 27rpx; font-weight: 700; color: #1e293b; }
.ap-sub { font-size: 22rpx; color: #94a3b8; }
.ap-add { flex: none; display: flex; }
.ap-search { display: flex; gap: 12rpx; align-items: center; margin: 18rpx 0 8rpx; }
.ap-search .modal-input { flex: 1; margin-bottom: 0; }
.search-btn { flex: none; height: 72rpx; font-size: 25rpx; padding: 0 26rpx; }
.loading-text { text-align: center; color: #94a3b8; padding: 60rpx 0; font-size: 26rpx; }
.st-grid { display: flex; gap: 16rpx; margin-bottom: 12rpx; }
.st-cell { flex: 1; background: #f8fafc; border-radius: 16rpx; padding: 24rpx 0; display: flex; flex-direction: column; align-items: center; gap: 8rpx; }
.st-num { font-size: 34rpx; font-weight: 800; color: #1e293b; }
.st-num.red { color: #dc2626; }
.st-lbl { font-size: 22rpx; color: #64748b; }
.st-section { font-size: 25rpx; font-weight: 700; color: #334155; margin: 20rpx 4rpx 10rpx; }
.st-line { display: flex; justify-content: space-between; gap: 16rpx; font-size: 24rpx; color: #475569; padding: 12rpx 6rpx; border-bottom: 1rpx solid #f8fafc; }
.st-name { flex: 1; min-width: 0; }
</style>
