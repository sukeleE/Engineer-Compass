<template>
  <view class="page-wrap" v-if="data">
    <view class="card head">
      <view class="h-row">
        <text class="h-name">{{ data.project.name }}</text>
        <text class="tag" :class="data.project.status === 'open' ? 'tag-green' : 'tag-gray'">{{ data.project.status === 'open' ? '收集中' : '已截止' }}</text>
      </view>
      <view v-if="data.project.event" class="h-line">竞赛：{{ data.project.event }}</view>
      <view class="h-line">邀请码：<text class="code">{{ data.project.code }}</text><text class="copy" @click="copyCode">复制</text></view>
    </view>

    <Tabs v-model="tab" :tabs="[{ key: 'overview', label: '队伍名单' }, { key: 'rows', label: '费用明细', badge: data.rows.length }]" />

    <block v-if="tab === 'overview'">
      <view class="section-title">队伍（{{ data.teams.length }}）</view>
      <view v-for="t in data.teams" :key="t.id" class="card team">
        <view class="t-head">
          <text class="t-name">{{ t.name }}</text>
          <text class="mini-btn danger" @click="removeTeam(t)">删队</text>
        </view>
        <view class="t-members">
          <text v-for="m in membersOf(t.id)" :key="m.id" class="member-chip" :class="{ off: !m.claimed }">
            {{ m.name }}{{ m.claimed ? '' : '（待认领）' }}<text v-if="m.me" class="me">·我</text>
            <text v-if="!m.isOwner" class="reset" @click="resetMember(m)">重置</text>
          </text>
        </view>
        <view class="add-member" @click="openMember(t)">＋ 添加成员</view>
      </view>
      <EmptyState v-if="!data.teams.length" icon="👥" text="还没有队伍，先创建一支队伍" btnText="创建队伍" @action="openTeam" />
      <button class="btn btn-ghost btn-block" @click="openTeam">＋ 新建队伍</button>
    </block>

    <block v-else>
      <view class="card summary">
        <text class="sum-title">费用合计</text>
        <text class="sum-num">¥{{ grandTotal }}</text>
      </view>
      <view v-for="g in groupedRows" :key="g.key" class="card group">
        <view class="g-head">
          <text class="g-name">{{ g.label }}</text>
          <text class="g-sum">¥{{ g.total }}</text>
        </view>
        <view v-for="r in g.rows" :key="r.id" class="row">
          <view class="r-head">
            <text class="r-owner">{{ r.owner_name }}</text>
            <text class="r-time">{{ String(r.update_time).slice(5, 16) }}</text>
          </view>
          <view v-for="(v, k) in nonEmpty(r.data)" :key="k" class="r-line">{{ k }}：{{ v }}</view>
          <view v-if="r.atts.length" class="r-atts">
            <text v-for="a in r.atts" :key="a.id" class="att" @click="openAtt(a)">📎 {{ a.orig_name }}</text>
          </view>
        </view>
      </view>
      <EmptyState v-if="!data.rows.length" icon="🧾" text="暂无票据记录，成员可凭邀请码在 H5 端填报" />
    </block>

    <view v-if="teamOpen" class="modal-mask" @click="teamOpen = false">
      <view class="modal" @click.stop>
        <view class="modal-title">新建队伍</view>
        <input v-model="teamName" class="modal-input" maxlength="30" placeholder="队伍名称（必填）" />
        <view class="modal-actions">
          <button class="btn btn-ghost modal-btn" @click="teamOpen = false">取消</button>
          <button class="btn btn-primary modal-btn" @click="submitTeam">创建</button>
        </view>
      </view>
    </view>

    <view v-if="memberOpen" class="modal-mask" @click="memberOpen = false">
      <view class="modal" @click.stop>
        <view class="modal-title">添加成员到「{{ memberTeam ? memberTeam.name : '' }}」</view>
        <input v-model="memberName" class="modal-input" maxlength="20" placeholder="成员姓名（必填）" />
        <view class="modal-actions">
          <button class="btn btn-ghost modal-btn" @click="memberOpen = false">取消</button>
          <button class="btn btn-primary modal-btn" @click="submitMember">添加</button>
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
import { previewFile } from '../../../utils/preview.js';
import Tabs from '../../../components/Tabs.vue';
import EmptyState from '../../../components/EmptyState.vue';

const CAT = {
  reg: { label: '① 报名费', sumKey: '金额' },
  train: { label: '② 车票', sumKey: '金额' },
  hotel: { label: '③ 住宿', sumKey: '实付金额' },
  mail: { label: '④ 邮寄费', sumKey: '金额' },
  prop: { label: '⑤ 耗材道具', sumKey: '金额' },
  misc: { label: '⑥ 零散票据', sumKey: '金额' },
};
const id = ref(null);
const data = ref(null);
const tab = ref('overview');
const teamOpen = ref(false);
const teamName = ref('');
const memberOpen = ref(false);
const memberName = ref('');
const memberTeam = ref(null);

function membersOf(tid) { return (data.value.members || []).filter((m) => m.team_id === tid); }
function nonEmpty(d) {
  const out = {};
  for (const k in d) { if (d[k] !== '' && d[k] !== null && d[k] !== undefined) out[k] = d[k]; }
  return out;
}
function moneyOf(r) {
  const key = (CAT[r.category] || {}).sumKey || '金额';
  const n = Number((r.data || {})[key]);
  return Number.isFinite(n) ? n : 0;
}
const groupedRows = computed(() => {
  const map = new Map();
  for (const r of (data.value ? data.value.rows : [])) {
    if (!map.has(r.category)) map.set(r.category, []);
    map.get(r.category).push(r);
  }
  return Object.keys(CAT).filter((k) => map.has(k)).map((k) => {
    const rows = map.get(k);
    const total = rows.reduce((s, r) => s + moneyOf(r), 0);
    return { key: k, label: CAT[k].label, rows, total: total.toFixed(2) };
  });
});
const grandTotal = computed(() => (data.value ? data.value.rows.reduce((s, r) => s + moneyOf(r), 0).toFixed(2) : '0.00'));

async function load() { data.value = await api.expenseDetail(id.value); }
function copyCode() { uni.setClipboardData({ data: data.value.project.code, success: () => toast('邀请码已复制', 'success') }); }
function openAtt(a) { previewFile('/api/expense/o/' + data.value.project.code + '/file/' + a.id + '/download', a.orig_name); }

function openTeam() { teamName.value = ''; teamOpen.value = true; }
async function submitTeam() {
  if (!teamName.value.trim()) return toast('请填写队伍名称');
  await api.expenseTeamAdd(id.value, { name: teamName.value.trim() });
  teamOpen.value = false;
  toast('已创建', 'success');
  load();
}
async function removeTeam(t) {
  if (!(await confirm('删除队伍将同时移除其名单和票据记录，确认删除？', '高危操作'))) return;
  await api.expenseTeamRemove(t.id);
  toast('已删除', 'success');
  load();
}
function openMember(t) { memberTeam.value = t; memberName.value = ''; memberOpen.value = true; }
async function submitMember() {
  if (!memberName.value.trim()) return toast('请填写姓名');
  await api.expenseMemberAdd(id.value, memberTeam.value.id, { name: memberName.value.trim() });
  memberOpen.value = false;
  toast('已添加', 'success');
  load();
}
async function resetMember(m) {
  if (!(await confirm('重置后「' + m.name + '」需重新认领，确认？'))) return;
  await api.expenseMemberReset(m.id);
  toast('已重置认领', 'success');
  load();
}

onLoad((o) => { id.value = Number(o.id); });
onShow(() => { if (id.value) load(); });
</script>

<style lang="scss" scoped>
.head .h-row { display: flex; justify-content: space-between; align-items: center; gap: 14rpx; }
.h-name { font-size: 32rpx; font-weight: 800; color: #1e293b; flex: 1; }
.h-line { font-size: 25rpx; color: #64748b; margin-top: 10rpx; }
.code { font-weight: 800; color: #2563eb; letter-spacing: 2rpx; }
.copy { color: #2563eb; margin-left: 14rpx; font-size: 24rpx; }
.team .t-head { display: flex; justify-content: space-between; align-items: center; }
.t-name { font-size: 29rpx; font-weight: 700; color: #1e293b; }
.mini-btn { background: #eff6ff; color: #2563eb; font-size: 23rpx; border-radius: 24rpx; padding: 8rpx 22rpx; }
.mini-btn.danger { background: #fee2e2; color: #ef4444; }
.t-members { display: flex; flex-wrap: wrap; gap: 12rpx; margin-top: 16rpx; }
.member-chip { background: #f0fdf4; color: #166534; font-size: 23rpx; border-radius: 24rpx; padding: 8rpx 18rpx; }
.member-chip.off { background: #f1f5f9; color: #94a3b8; }
.member-chip .me { font-weight: 700; }
.member-chip .reset { color: #b45309; margin-left: 10rpx; }
.add-member { margin-top: 16rpx; color: #2563eb; font-size: 25rpx; }
.summary { display: flex; justify-content: space-between; align-items: center; background: linear-gradient(135deg, #2563eb, #1d4ed8); }
.summary .sum-title { color: #dbeafe; font-size: 27rpx; }
.summary .sum-num { color: #fff; font-size: 44rpx; font-weight: 800; }
.group .g-head { display: flex; justify-content: space-between; align-items: center; border-bottom: 1rpx solid #f1f5f9; padding-bottom: 14rpx; }
.g-name { font-size: 28rpx; font-weight: 700; color: #1e293b; }
.g-sum { color: #dc2626; font-weight: 700; }
.row { padding: 18rpx 0; border-bottom: 1rpx solid #f8fafc; }
.row:last-child { border-bottom: none; }
.r-head { display: flex; justify-content: space-between; }
.r-owner { font-size: 26rpx; font-weight: 700; color: #334155; }
.r-time { font-size: 21rpx; color: #94a3b8; }
.r-line { font-size: 24rpx; color: #64748b; margin-top: 6rpx; }
.r-atts { display: flex; flex-wrap: wrap; gap: 12rpx; margin-top: 10rpx; }
.att { font-size: 23rpx; color: #2563eb; background: #eff6ff; border-radius: 10rpx; padding: 6rpx 14rpx; }
.modal-mask { position: fixed; inset: 0; background: rgba(15,23,42,0.45); z-index: 100; display: flex; align-items: center; justify-content: center; padding: 48rpx; }
.modal { width: 100%; background: #fff; border-radius: 24rpx; padding: 32rpx; }
.modal-title { font-size: 32rpx; font-weight: 800; text-align: center; margin-bottom: 20rpx; }
.modal-input { background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 14rpx; padding: 20rpx 22rpx; font-size: 27rpx; margin-bottom: 16rpx; }
.modal-actions { display: flex; gap: 18rpx; margin-top: 8rpx; }
.modal-btn { flex: 1; height: 80rpx; font-size: 28rpx; }
</style>

