<template>
  <view class="page-wrap" v-if="data">
    <view class="card head">
      <view class="name-row">
        <text class="name">{{ data.team.name }}</text>
        <text v-if="data.me.is_owner" class="tag tag-amber">组长</text>
      </view>
      <view v-if="data.team.desc" class="desc">{{ data.team.desc }}</view>
      <view class="invite" @click="copyCode">
        <text>邀请码：<text class="code">{{ data.team.invite_code }}</text></text>
        <text class="copy">复制</text>
      </view>
      <view class="stat-row">
        <view class="stat"><text class="num">{{ data.members.length }}</text><text class="lbl">成员</text></view>
        <view class="stat"><text class="num">{{ data.tasks.length }}</text><text class="lbl">协作任务</text></view>
        <view class="stat"><text class="num">{{ data.roles.length }}</text><text class="lbl">角色</text></view>
        <view class="stat"><text class="num">{{ data.devices.length }}</text><text class="lbl">设备</text></view>
      </view>
    </view>

    <view class="card grid">
      <view v-for="e in entries" :key="e.url" class="grid-item" @click="go(e.url)">
        <text class="gi-icon">{{ e.icon }}</text>
        <text class="gi-name">{{ e.name }}</text>
      </view>
    </view>

    <view v-if="data.me.is_owner" class="card owner-card">
      <view class="section-title" style="margin-left:0">组长操作</view>
      <view class="owner-row" @click="editTeam"><text>✏️ 编辑小组信息</text><text class="arrow">›</text></view>
      <view class="owner-row danger" @click="removeTeam"><text>🗑 解散小组</text><text class="arrow">›</text></view>
    </view>
  </view>
  <view v-else class="empty"><view class="empty-text">加载中…</view></view>
</template>

<script setup>
import { ref } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { confirm, toast } from '../../../utils/guard.js';

const id = ref(null);
const data = ref(null);
const entries = [
  { name: '成员角色', icon: '👤', url: '/packageTeam/pages/members/main' },
  { name: '小组任务', icon: '✅', url: '/packageTeam/pages/tasks/main' },
  { name: '进度汇报', icon: '📈', url: '/packageTeam/pages/progress/main' },
  { name: '周期打卡', icon: '🗓', url: '/packageTeam/pages/checkin/main' },
  { name: '组内群聊', icon: '💬', url: '/packageTeam/pages/chat/list' },
  { name: '小组文件', icon: '📁', url: '/packageTeam/pages/files/main' },
  { name: '设备预约', icon: '🔧', url: '/packageTeam/pages/devices/main' },
  { name: '考勤打卡', icon: '⏰', url: '/packageTeam/pages/attendance/main' },
];

async function load() {
  data.value = await api.teamDetail(id.value);
}
function withId(url) { return url + '?id=' + id.value; }
function go(url) { uni.navigateTo({ url: withId(url) }); }
function copyCode() {
  uni.setClipboardData({ data: data.value.team.invite_code, success: () => toast('邀请码已复制', 'success') });
}
async function editTeam() {
  const t = data.value.team;
  const res = await new Promise((resolve) => {
    uni.showModal({
      title: '修改小组名称', editable: true, placeholderText: t.name,
      success: (m) => resolve(m.confirm ? (m.content || '').trim() : ''),
    });
  });
  if (!res) return;
  await api.teamUpdate(id.value, { name: res, desc: t.desc });
  toast('已更新', 'success');
  load();
}
async function removeTeam() {
  if (!(await confirm('解散后小组所有数据将删除且不可恢复，确认解散？', '高危操作'))) return;
  await api.teamDelete(id.value);
  toast('小组已解散', 'success');
  uni.switchTab({ url: '/pages/team/main' });
}

onLoad((o) => { id.value = Number(o.id); load(); });
onShow(() => { if (id.value) load(); });
</script>

<style lang="scss" scoped>
.head .name-row { display: flex; align-items: center; gap: 14rpx; }
.name { font-size: 36rpx; font-weight: 800; color: #1e293b; }
.desc { font-size: 26rpx; color: #64748b; margin-top: 12rpx; line-height: 1.6; }
.invite { display: flex; justify-content: space-between; align-items: center; background: #eff6ff; border-radius: 12rpx; padding: 18rpx 22rpx; margin-top: 18rpx; font-size: 26rpx; color: #1e40af; }
.invite .code { font-weight: 800; letter-spacing: 2rpx; }
.invite .copy { color: #2563eb; font-weight: 600; }
.stat-row { display: flex; margin-top: 24rpx; }
.stat { flex: 1; text-align: center; }
.stat .num { display: block; font-size: 36rpx; font-weight: 800; color: #2563eb; }
.stat .lbl { font-size: 23rpx; color: #94a3b8; }
.grid { display: flex; flex-wrap: wrap; padding: 12rpx; }
.grid-item { width: 25%; display: flex; flex-direction: column; align-items: center; gap: 10rpx; padding: 26rpx 0; }
.gi-icon { font-size: 52rpx; }
.gi-name { font-size: 24rpx; color: #475569; }
.owner-row { display: flex; justify-content: space-between; align-items: center; padding: 26rpx 8rpx; border-bottom: 1rpx solid #f1f5f9; font-size: 27rpx; color: #334155; }
.owner-row:last-child { border-bottom: none; }
.owner-row.danger { color: #ef4444; }
.arrow { color: #94a3b8; }
</style>