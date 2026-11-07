<template>
  <view class="page-wrap">
    <button class="btn btn-primary btn-block" @click="openCreate">＋ 新建报销项目</button>
    <EmptyState v-if="!list.length" icon="🧾" text="还没有报销项目，创建后生成邀请码，成员凭码在线填报票据" />
    <view v-for="p in list" :key="p.id" class="card project" @click="openDetail(p)">
      <view class="p-head">
        <text class="p-name ellipsis">{{ p.name }}</text>
        <view class="p-head-right">
          <text class="tag" :class="p.status === 'open' ? 'tag-green' : 'tag-gray'">{{ p.status === 'open' ? '收集中' : '已截止' }}</text>
          <text class="del-btn" @click.stop="remove(p)">删除</text>
        </view>
      </view>
      <view v-if="p.event" class="p-line">竞赛：{{ p.event }}</view>
      <view class="p-line">邀请码：<text class="code">{{ p.code }}</text><text class="copy" @click.stop="copy(p.code)">复制</text></view>
      <view class="p-stats">
        <text>{{ p.team_count }} 队</text>
        <text>{{ p.member_count }} 人（已认领 {{ p.claimed_count }}）</text>
        <text>{{ p.row_count }} 条票据</text>
      </view>
    </view>

    <view v-if="createOpen" class="modal-mask" @click="createOpen = false">
      <view class="modal" @click.stop>
        <view class="modal-title">新建报销项目</view>
        <input v-model="form.name" class="modal-input" maxlength="40" placeholder="项目名称（必填，如：电赛省赛报销）" />
        <input v-model="form.event" class="modal-input" maxlength="60" placeholder="关联竞赛（选填）" />
        <view class="modal-actions">
          <button class="btn btn-ghost modal-btn" @click="createOpen = false">取消</button>
          <button class="btn btn-primary modal-btn" @click="submitCreate">创建</button>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, reactive } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { confirm, toast, ensureLogin } from '../../../utils/guard.js';
import EmptyState from '../../../components/EmptyState.vue';

const list = ref([]);
const createOpen = ref(false);
const form = reactive({ name: '', event: '' });

async function load() { list.value = await api.expenseList(); }
function openCreate() {
  if (!ensureLogin('登录后才能创建报销项目')) return;
  form.name = ''; form.event = '';
  createOpen.value = true;
}
async function submitCreate() {
  if (!form.name.trim()) return toast('请填写项目名称');
  await api.expenseCreate({ name: form.name.trim(), event: form.event.trim() });
  createOpen.value = false;
  toast('已创建，邀请码已生成', 'success');
  load();
}
function copy(code) { uni.setClipboardData({ data: code, success: () => toast('邀请码已复制', 'success') }); }
async function remove(p) {
  if (!(await confirm('删除报销项目「' + p.name + '」？全部队伍与票据数据将清除且不可恢复。', '高危操作'))) return;
  await api.expenseDelete(p.id);
  toast('已删除', 'success');
  load();
}
function openDetail(p) { uni.navigateTo({ url: '/packageOps/pages/expense/detail?id=' + p.id }); }

onShow(load);
</script>

<style lang="scss" scoped>
.project .p-head { display: flex; justify-content: space-between; align-items: center; gap: 14rpx; }
.p-name { font-size: 30rpx; font-weight: 800; color: #1e293b; flex: 1; }
.p-line { font-size: 25rpx; color: #64748b; margin-top: 10rpx; }
.code { font-weight: 800; color: #2563eb; letter-spacing: 2rpx; }
.copy { color: #2563eb; margin-left: 14rpx; font-size: 24rpx; }
.p-stats { display: flex; gap: 22rpx; font-size: 23rpx; color: #94a3b8; margin-top: 14rpx; }
.p-head-right { display: flex; align-items: center; gap: 16rpx; flex-shrink: 0; }
.del-btn { color: #ef4444; font-size: 24rpx; background: #fee2e2; border-radius: 24rpx; padding: 6rpx 22rpx; }
.modal-mask { position: fixed; inset: 0; background: rgba(15,23,42,0.45); z-index: 100; display: flex; align-items: center; justify-content: center; padding: 48rpx; }
.modal { width: 100%; background: #fff; border-radius: 24rpx; padding: 32rpx; }
.modal-title { font-size: 32rpx; font-weight: 800; text-align: center; margin-bottom: 20rpx; }
.modal-input { background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 14rpx; padding: 20rpx 22rpx; font-size: 27rpx; margin-bottom: 16rpx; }
.modal-actions { display: flex; gap: 18rpx; margin-top: 8rpx; }
.modal-btn { flex: 1; height: 80rpx; font-size: 28rpx; }
</style>
