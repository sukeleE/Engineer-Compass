<template>
  <view>
    <button class="btn btn-ghost btn-block" @click="openForm()">＋ 新建固定组队</button>
    <view v-if="loading" class="empty"><view class="empty-text">加载中…</view></view>
    <EmptyState v-else-if="!teams.length" icon="👥" text="还没有固定组队，队长可带整队一键预约" />
    <view v-for="t in teams" :key="t.id" class="card team-card">
      <view class="tm-head">
        <text class="tm-name">👥 {{ t.name }}</text>
        <text class="tag tag-blue">队长 {{ t.owner_name }}</text>
      </view>
      <view class="tm-members">
        <text v-if="!t.members.length" class="tm-empty">暂无成员（仅队长本人）</text>
        <text v-for="m in t.members" :key="m.user_id" class="tag tag-gray tm-chip">{{ m.user_name }}</text>
      </view>
      <view v-if="t.canManage" class="tm-ops">
        <text class="mini-btn" @click="openForm(t)">编辑成员/改名</text>
        <text class="mini-btn danger" @click="remove(t)">删除组队</text>
      </view>
    </view>

    <!-- 新建 / 编辑组队 -->
    <view v-if="formOpen" class="modal-mask" @click="formOpen = false">
      <view class="modal" @click.stop>
        <view class="modal-title">{{ editing ? '编辑固定组队' : '新建固定组队' }}</view>
        <scroll-view scroll-y class="modal-scroll">
          <view class="f-label">队伍名称（1–20 字）</view>
          <input v-model="form.name" class="modal-input" maxlength="20" placeholder="如：魔毯底盘组" />
          <view class="f-label">成员（全站搜索，不含队长本人；最多 30 人）</view>
          <view class="part-row">
            <input v-model="keyword" class="modal-input part-input" placeholder="搜用户名 / 昵称 / 真名" @confirm="search" />
            <view class="mini-btn" @click="search">搜索</view>
          </view>
          <view v-if="hits.length" class="part-results">
            <view v-for="u in hits" :key="u.id" class="part-item" @click="addMember(u)">
              ＋ {{ u.real_name || u.nickname || u.username }}<text v-if="u.real_name && u.nickname !== u.real_name">（{{ u.nickname || u.username }}）</text>
            </view>
          </view>
          <view class="part-chips">
            <text class="tag tag-blue">我（队长）</text>
            <text v-for="m in form.chips" :key="m.id" class="tag tag-gray part-chip" @click="removeMember(m.id)">{{ m.label }} ×</text>
          </view>
          <view class="f-hint">组队仅用于预约模块；之后改队不影响已下预约的历史参与人快照。</view>
        </scroll-view>
        <view class="modal-actions">
          <button class="btn btn-ghost modal-btn" @click="formOpen = false">取消</button>
          <button class="btn btn-primary modal-btn" :disabled="saving" @click="submit">{{ saving ? '保存中…' : '保存' }}</button>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, reactive } from 'vue';
import { api } from '../../../../utils/api.js';
import { confirm, toast } from '../../../../utils/guard.js';
import auth from '../../../../utils/auth.js';
import EmptyState from '../../../../components/EmptyState.vue';

const props = defineProps({ projectId: { type: Number, required: true } });

const teams = ref([]);
const loading = ref(false);
const formOpen = ref(false);
const saving = ref(false);
const editing = ref(null);
const form = reactive({ name: '', memberIds: [], chips: [] });
const keyword = ref('');
const hits = ref([]);

async function load() {
  loading.value = true;
  try {
    const r = await api.bookingTeams(props.projectId);
    teams.value = r.teams || [];
  } finally {
    loading.value = false;
  }
}
load();

function openForm(t) {
  editing.value = t || null;
  keyword.value = '';
  hits.value = [];
  if (t) {
    form.name = t.name;
    form.memberIds = t.members.map((m) => m.user_id);
    form.chips = t.members.map((m) => ({ id: m.user_id, label: m.user_name }));
  } else {
    form.name = '';
    form.memberIds = [];
    form.chips = [];
  }
  formOpen.value = true;
}
async function search() {
  const q = keyword.value.trim();
  if (!q) return;
  const r = await api.bookingUserSearch(q);
  const ids = form.memberIds;
  const myId = auth.user ? auth.user.id : null;
  hits.value = (r.users || []).filter((u) => u.id !== myId && ids.indexOf(u.id) < 0);
}
function addMember(u) {
  if (form.memberIds.length >= 30) return toast('每队最多 30 名成员（不含队长）');
  if (form.memberIds.indexOf(u.id) >= 0) return;
  form.memberIds.push(u.id);
  const label = u.real_name || u.nickname || u.username;
  form.chips.push({ id: u.id, label: label });
  hits.value = hits.value.filter((x) => x.id !== u.id);
}
function removeMember(uid) {
  form.memberIds = form.memberIds.filter((x) => x !== uid);
  form.chips = form.chips.filter((x) => x.id !== uid);
}
async function submit() {
  const name = form.name.trim();
  if (!name) return toast('请填写队伍名称');
  if (form.memberIds.length > 30) return toast('最多 30 名成员');
  saving.value = true;
  try {
    const card = { name: name, member_ids: form.memberIds.slice() };
    if (editing.value) await api.bookingTeamUpdate(editing.value.id, card);
    else await api.bookingTeamCreate(props.projectId, card);
    formOpen.value = false;
    toast('已保存', 'success');
    load();
  } finally {
    saving.value = false;
  }
}
async function remove(t) {
  if (!(await confirm('删除组队「' + t.name + '」？历史预约保留（仅解除关联）。'))) return;
  await api.bookingTeamDelete(t.id);
  toast('组队已删除', 'success');
  load();
}
</script>

<style lang="scss" scoped>
.team-card .tm-head { display: flex; justify-content: space-between; align-items: center; gap: 14rpx; }
.tm-name { font-size: 29rpx; font-weight: 700; color: #1e293b; flex: 1; }
.tm-members { display: flex; flex-wrap: wrap; gap: 10rpx; margin-top: 16rpx; }
.tm-chip { font-size: 23rpx; }
.tm-empty { font-size: 24rpx; color: #94a3b8; }
.tm-ops { display: flex; gap: 20rpx; margin-top: 16rpx; justify-content: flex-end; }
.mini-btn { font-size: 24rpx; color: #2563eb; background: #eff6ff; border-radius: 24rpx; padding: 8rpx 22rpx; }
.mini-btn.danger { color: #ef4444; background: #fef2f2; }
.modal-mask { position: fixed; inset: 0; background: rgba(15,23,42,0.45); z-index: 100; display: flex; align-items: center; justify-content: center; padding: 48rpx; }
.modal { width: 100%; max-height: 82vh; background: #fff; border-radius: 24rpx; padding: 32rpx; display: flex; flex-direction: column; }
.modal-title { font-size: 32rpx; font-weight: 800; text-align: center; margin-bottom: 20rpx; }
.modal-scroll { max-height: 60vh; }
.modal-input { background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 14rpx; padding: 20rpx 22rpx; font-size: 27rpx; margin-bottom: 16rpx; }
.f-label { font-size: 24rpx; color: #64748b; margin: 8rpx 4rpx 10rpx; }
.f-hint { font-size: 22rpx; color: #94a3b8; line-height: 1.6; margin-top: 12rpx; }
.part-row { display: flex; gap: 12rpx; align-items: center; }
.part-input { flex: 1; margin-bottom: 0; }
.part-results { background: #fff; border: 1rpx solid #e2e8f0; border-radius: 14rpx; margin-top: 8rpx; max-height: 320rpx; overflow: hidden; }
.part-item { padding: 18rpx 22rpx; font-size: 26rpx; color: #2563eb; border-bottom: 1rpx solid #f1f5f9; }
.part-chips { display: flex; flex-wrap: wrap; gap: 10rpx; margin-top: 16rpx; }
.part-chip { font-size: 23rpx; }
.modal-actions { display: flex; gap: 18rpx; margin-top: 18rpx; }
.modal-btn { flex: 1; height: 80rpx; font-size: 28rpx; }
</style>