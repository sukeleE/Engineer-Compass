<template>
  <view class="page-wrap" v-if="data">
    <view class="top-actions">
      <button v-if="canMember" class="btn btn-primary btn-block" @click="searchOpen = true">＋ 拉人入组</button>
      <button class="btn btn-ghost btn-block" @click="openSelfRole">🏷 选择我的角色</button>
    </view>
    <button v-if="data.me.is_owner" class="btn btn-outline btn-block transfer-btn" @click="openTransfer">🔁 转让组长</button>

    <view class="section-title">成员（{{ data.members.length }}）</view>
    <view v-for="m in data.members" :key="m.id" class="card member">
      <view class="m-head">
        <view class="avatar">{{ memberName(m).slice(0, 1) }}</view>
        <view class="m-info">
          <view class="m-name">
            {{ memberName(m) }}
            <text v-if="m.is_owner" class="tag tag-amber">组长</text>
            <text v-else-if="m.is_me" class="tag tag-blue">我</text>
          </view>
          <view class="m-roles">
            <text v-for="rn in (m.role_names || [])" :key="rn" class="tag tag-gray">{{ rn }}</text>
            <text v-if="!(m.role_names || []).length" class="text-small text-muted">未分配角色</text>
          </view>
        </view>
      </view>
      <view v-if="canMember && !m.is_owner" class="m-actions">
        <picker v-if="assignableRoles.length" :range="roleNames" @change="(e) => assign(m, e)">
          <view class="mini-btn">分配角色</view>
        </picker>
        <view class="mini-btn danger" @click="remove(m)">移出</view>
      </view>
    </view>

    <view v-if="canRole" class="section-title row-title">
      <text>角色（{{ data.roles.length }}）</text>
      <text class="add-link" @click="openRoleCreate">＋ 新建角色</text>
    </view>
    <view v-else class="section-title">角色（{{ data.roles.length }}）</view>
    <view v-for="r in data.roles" :key="r.id" class="card role-card">
      <view class="role-head">
        <text class="role-name">{{ r.name }}</text>
        <text class="text-small text-muted">等级 {{ r.level }}</text>
      </view>
      <view class="perm-list">
        <text v-for="p in r.permissions" :key="p" class="tag tag-blue">{{ permLabel(p) }}</text>
        <text v-if="!r.permissions.length" class="text-small text-muted">无权限</text>
      </view>
      <view v-if="canRole" class="role-actions">
        <view class="mini-btn" @click="openRoleEdit(r)">编辑</view>
        <view class="mini-btn danger" @click="removeRole(r)">删除</view>
      </view>
    </view>

    <!-- 拉人弹窗 -->
    <view v-if="searchOpen" class="modal-mask" @click="searchOpen = false">
      <view class="modal" @click.stop>
        <view class="modal-title">搜索用户拉入小组</view>
        <view class="search-row">
          <input v-model="keyword" class="modal-input" placeholder="用户名 / 昵称 / 真名" @confirm="doSearch" />
          <button class="btn btn-primary search-btn" @click="doSearch">搜索</button>
        </view>
        <scroll-view scroll-y class="result-list">
          <view v-for="u in results" :key="u.id" class="result-item">
            <text class="ellipsis">{{ memberName(u) }}（{{ u.username }}）</text>
            <view class="mini-btn" @click="addUser(u)">拉入</view>
          </view>
          <view v-if="searched && !results.length" class="text-muted text-small empty-tip">无匹配用户</view>
        </scroll-view>
        <button class="btn btn-ghost btn-block" @click="searchOpen = false">关闭</button>
      </view>
    </view>

    <!-- 角色表单弹窗 -->
    <view v-if="roleOpen" class="modal-mask" @click="roleOpen = false">
      <view class="modal modal-lg" @click.stop>
        <view class="modal-title">{{ roleEditing ? '编辑角色' : '新建角色' }}</view>
        <scroll-view scroll-y class="form-scroll">
          <view class="form-label">角色名称</view>
          <input v-model="rf.name" class="modal-input" placeholder="如：硬件组、文档组" maxlength="20" />
          <view class="form-label">等级（0–100，越高权限优先）</view>
          <view class="stepper">
            <view class="step-btn" @click="stepLevel(-10)">－</view>
            <text class="step-val">{{ rf.level }}</text>
            <view class="step-btn" @click="stepLevel(10)">＋</view>
          </view>
          <view class="form-label">权限（可多选）</view>
          <view class="perm-pick">
            <view
              v-for="p in PERM_KEYS"
              :key="p"
              class="perm-chip"
              :class="{ on: rf.permissions.indexOf(p) >= 0 }"
              @click="togglePerm(p)"
            >{{ permLabel(p) }}</view>
          </view>
        </scroll-view>
        <view class="modal-actions">
          <button class="btn btn-ghost modal-btn" @click="roleOpen = false">取消</button>
          <button class="btn btn-primary modal-btn" :disabled="roleSaving" @click="saveRole">
            {{ roleSaving ? '保存中…' : '保存' }}
          </button>
        </view>
      </view>
    </view>

    <!-- 自选角色弹窗 -->
    <view v-if="selfOpen" class="modal-mask" @click="selfOpen = false">
      <view class="modal modal-lg" @click.stop>
        <view class="modal-title">选择我的角色（最多 3 个）</view>
        <scroll-view scroll-y class="form-scroll">
          <view class="perm-pick">
            <view
              v-for="r in data.roles"
              :key="r.id"
              class="perm-chip"
              :class="{ on: selfPicked.indexOf(r.id) >= 0 }"
              @click="toggleSelf(r.id)"
            >{{ r.name }}</view>
          </view>
          <view v-if="!data.roles.length" class="text-muted empty-tip">小组还没有角色，请联系组长创建</view>
        </scroll-view>
        <view class="modal-actions">
          <button class="btn btn-ghost modal-btn" @click="selfOpen = false">取消</button>
          <button class="btn btn-primary modal-btn" :disabled="selfSaving" @click="saveSelfRole">
            {{ selfSaving ? '保存中…' : '保存' }}
          </button>
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
import { displayName } from '../../../utils/displayName.js';

const PERM_LABELS = {
  task: '任务管理', progress: '进度汇报', message: '发消息', file_upload: '上传资料',
  file_delete: '删除资料', device: '设备管理', device_approve: '预约审批',
  attendance: '考勤管理', member: '成员管理', role: '角色管理', team: '小组设置',
};
const PERM_KEYS = Object.keys(PERM_LABELS);

const id = ref(null);
const data = ref(null);
const searchOpen = ref(false);
const keyword = ref('');
const results = ref([]);
const searched = ref(false);

const canMember = computed(() => data.value?.me.is_owner || data.value?.perms.member);
const canRole = computed(() => data.value?.me.is_owner || data.value?.perms.role);
const assignableRoles = computed(() => data.value?.roles || []);
const roleNames = computed(() => (data.value?.roles || []).map((r) => r.name));

function permLabel(p) { return PERM_LABELS[p] || p; }
function memberName(u) { return displayName(u) || u?.username || '?'; }

async function load() { data.value = await api.teamDetail(id.value); }

async function doSearch() {
  if (!keyword.value.trim()) return;
  const res = await api.teamUserSearch(keyword.value.trim(), id.value);
  results.value = res.users || [];
  searched.value = true;
}
async function addUser(u) {
  const r = await api.teamMemberAdd(id.value, [u.id]);
  toast(r.message || '已拉入小组', 'success');
  await load();
}
async function assign(m, e) {
  const role = data.value.roles[Number(e.detail.value)];
  if (!role) return;
  await api.teamMemberRole(id.value, { user_id: m.id, role_id: role.id });
  toast('角色已分配', 'success');
  load();
}
async function remove(m) {
  if (!(await confirm('将「' + memberName(m) + '」移出小组？'))) return;
  await api.teamMemberRemove(id.value, m.id);
  toast('已移出', 'success');
  load();
}

// ---------- 角色 CRUD ----------
const roleOpen = ref(false);
const roleEditing = ref(null);
const roleSaving = ref(false);
const rf = reactive({ name: '', level: 0, permissions: [] });
function openRoleCreate() {
  roleEditing.value = null;
  rf.name = ''; rf.level = 10; rf.permissions = [];
  roleOpen.value = true;
}
function openRoleEdit(r) {
  roleEditing.value = r;
  rf.name = r.name; rf.level = r.level; rf.permissions = [...(r.permissions || [])];
  roleOpen.value = true;
}
function stepLevel(delta) {
  let v = Number(rf.level) + delta;
  if (v < 0) v = 0;
  if (v > 100) v = 100;
  rf.level = v;
}
function togglePerm(p) {
  const i = rf.permissions.indexOf(p);
  if (i >= 0) rf.permissions.splice(i, 1); else rf.permissions.push(p);
}
async function saveRole() {
  if (!rf.name.trim()) return toast('请填写角色名称');
  roleSaving.value = true;
  try {
    const card = { name: rf.name.trim(), level: Number(rf.level) || 0, permissions: rf.permissions };
    if (roleEditing.value) card.id = roleEditing.value.id;
    await api.teamRoleSave(id.value, card);
    toast('已保存', 'success');
    roleOpen.value = false;
    load();
  } finally {
    roleSaving.value = false;
  }
}
async function removeRole(r) {
  if (!(await confirm('删除角色「' + r.name + '」？引用该角色的成员将变为无角色。'))) return;
  await api.teamRoleDelete(id.value, r.id);
  toast('已删除角色', 'success');
  load();
}

// ---------- 转让组长 ----------
async function openTransfer() {
  const candidates = (data.value?.members || []).filter((m) => !m.is_owner);
  if (!candidates.length) return toast('没有可转让的成员');
  const names = candidates.map((m) => memberName(m));
  uni.showActionSheet({
    itemList: names,
    success: async (res) => {
      const target = candidates[res.tapIndex];
      const ok = await confirm('确认将组长转让给「' + memberName(target) + '」？转让后你将不再是组长。', '转让组长');
      if (!ok) return;
      await api.teamTransfer(id.value, target.id);
      toast('已转让组长', 'success');
      load();
    },
  });
}

// ---------- 自选角色 ----------
const selfOpen = ref(false);
const selfSaving = ref(false);
const selfPicked = ref([]);
function openSelfRole() {
  const me = data.value?.members.find((m) => m.is_me);
  selfPicked.value = me ? [...(me.role_ids || [])] : [];
  selfOpen.value = true;
}
function toggleSelf(rid) {
  const i = selfPicked.value.indexOf(rid);
  if (i >= 0) {
    selfPicked.value.splice(i, 1);
  } else {
    if (selfPicked.value.length >= 3) return toast('最多选择 3 个角色');
    selfPicked.value.push(rid);
  }
}
async function saveSelfRole() {
  selfSaving.value = true;
  try {
    await api.teamSelfRole(id.value, { role_ids: selfPicked.value });
    toast('已更新我的角色', 'success');
    selfOpen.value = false;
    load();
  } finally {
    selfSaving.value = false;
  }
}

onLoad((o) => { id.value = Number(o.id); load(); });
onShow(() => { if (id.value && data.value) load(); });
</script>

<style lang="scss" scoped>
.top-actions { display: flex; gap: 16rpx; }
.top-actions .btn { flex: 1; }
.transfer-btn { margin: 18rpx 0 8rpx; height: 78rpx; font-size: 27rpx; }
.member { padding: 24rpx 28rpx; }
.m-head { display: flex; gap: 18rpx; }
.avatar { width: 80rpx; height: 80rpx; border-radius: 50%; background: linear-gradient(135deg, #2563eb, #60a5fa); color: #fff; text-align: center; line-height: 80rpx; font-size: 32rpx; font-weight: 700; flex-shrink: 0; }
.m-info { flex: 1; min-width: 0; }
.m-name { font-size: 29rpx; font-weight: 700; color: #1e293b; display: flex; align-items: center; gap: 10rpx; }
.m-roles { display: flex; gap: 8rpx; margin-top: 10rpx; flex-wrap: wrap; }
.m-actions { display: flex; gap: 16rpx; justify-content: flex-end; margin-top: 16rpx; }
.mini-btn { background: #eff6ff; color: #2563eb; font-size: 24rpx; border-radius: 26rpx; padding: 10rpx 28rpx; }
.mini-btn.danger { background: #fee2e2; color: #ef4444; }
.row-title { justify-content: space-between; }
.add-link { color: #2563eb; font-size: 25rpx; font-weight: 600; }
.role-card { padding: 22rpx 28rpx; }
.role-head { display: flex; justify-content: space-between; }
.role-name { font-weight: 700; color: #1e293b; }
.perm-list { display: flex; flex-wrap: wrap; gap: 10rpx; margin-top: 12rpx; }
.role-actions { display: flex; gap: 14rpx; margin-top: 16rpx; }
.modal-mask { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { width: 660rpx; background: #fff; border-radius: 24rpx; padding: 32rpx; }
.modal-lg { max-height: 82vh; display: flex; flex-direction: column; }
.modal-title { font-size: 31rpx; font-weight: 700; margin-bottom: 18rpx; }
.search-row { display: flex; gap: 14rpx; margin-bottom: 16rpx; }
.modal-input { flex: 1; height: 80rpx; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 12rpx; padding: 0 20rpx; font-size: 26rpx; }
.search-btn { width: 150rpx; height: 80rpx; font-size: 25rpx; padding: 0; }
.result-list { max-height: 480rpx; margin-bottom: 16rpx; }
.result-item { display: flex; justify-content: space-between; align-items: center; padding: 20rpx 8rpx; border-bottom: 1rpx solid #f1f5f9; font-size: 26rpx; }
.empty-tip { padding: 24rpx; text-align: center; }
.form-scroll { max-height: 56vh; }
.form-label { font-size: 25rpx; color: #475569; font-weight: 600; margin: 16rpx 0 10rpx; }
.stepper { display: flex; align-items: center; gap: 22rpx; margin-bottom: 14rpx; }
.step-btn { width: 64rpx; height: 64rpx; border-radius: 50%; background: #eff6ff; color: #2563eb; text-align: center; line-height: 62rpx; font-size: 36rpx; }
.step-val { font-size: 30rpx; font-weight: 700; min-width: 100rpx; text-align: center; }
.perm-pick { display: flex; flex-wrap: wrap; gap: 12rpx; margin-bottom: 16rpx; }
.perm-chip { background: #f1f5f9; color: #64748b; border-radius: 12rpx; padding: 12rpx 22rpx; font-size: 24rpx; }
.perm-chip.on { background: #2563eb; color: #fff; }
.modal-actions { display: flex; gap: 18rpx; margin-top: 12rpx; }
.modal-btn { flex: 1; height: 80rpx; font-size: 27rpx; }
</style>
