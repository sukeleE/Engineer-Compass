<script setup>
// 成员与角色：成员/角色均使用紧凑小方块；点击后在页内展开详情，管理操作集中在详情区。
import { ref, computed, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../../api.js';
import { displayName, teamDisplayName } from '../../utils/displayName.js';
import { fmtDateOnly } from '../../utils/time.js';
import auth from '../../auth.js';

const router = useRouter();
const props = defineProps({ teamId: Number, me: Object, perms: Object, members: Array, roles: Array });

const members = ref(props.members || []);
const roles = ref(props.roles || []);
const inviteCode = ref('');

// —— 成员筛选与成员/角色详情展开 ——
const activeRoleFilter = ref('all');
const expandedMemberId = ref(null);
const expandedRoleId = ref(null);
const membersSecRef = ref(null);

const memberName = (m) => displayName(m || {});
const aiName = (a) => teamDisplayName(a, members.value);
const roleById = (id) => roles.value.find((r) => Number(r.id) === Number(id));
const roleMemberCount = (roleId) => members.value.filter((m) => (m.role_ids || []).map(Number).includes(Number(roleId))).length;
const noRoleCount = computed(() => members.value.filter((m) => !(m.role_ids || []).length).length);

const roleFilters = computed(() => [
  { key: 'all', name: '全部', count: members.value.length },
  ...roles.value.map((r) => ({ key: `role-${r.id}`, id: r.id, name: r.name, count: roleMemberCount(r.id) })),
  ...(noRoleCount.value ? [{ key: 'none', name: '无角色', count: noRoleCount.value }] : []),
]);

const filteredMembers = computed(() => {
  if (activeRoleFilter.value === 'none') return members.value.filter((m) => !(m.role_ids || []).length);
  if (activeRoleFilter.value.startsWith('role-')) {
    const rid = Number(activeRoleFilter.value.slice(5));
    return members.value.filter((m) => (m.role_ids || []).map(Number).includes(rid));
  }
  return members.value;
});

const selectedMember = computed(() => members.value.find((m) => Number(m.id) === Number(expandedMemberId.value)) || null);
const selectedRole = computed(() => roles.value.find((r) => Number(r.id) === Number(expandedRoleId.value)) || null);
const selectedRoleMembers = computed(() => selectedRole.value
  ? members.value.filter((m) => (m.role_ids || []).map(Number).includes(Number(selectedRole.value.id)))
  : []);

function toggleMember(m) {
  expandedMemberId.value = Number(expandedMemberId.value) === Number(m.id) ? null : m.id;
}
function toggleRole(r) {
  expandedRoleId.value = Number(expandedRoleId.value) === Number(r.id) ? null : r.id;
}
async function openMemberFromRole(m) {
  activeRoleFilter.value = 'all';
  expandedMemberId.value = m.id;
  await nextTick();
  membersSecRef.value?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
}
async function filterByRole(role, scroll = true) {
  activeRoleFilter.value = `role-${role.id}`;
  expandedRoleId.value = role.id;
  if (scroll) {
    await nextTick();
    membersSecRef.value?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }
}
function goProfile(m) {
  router.push(m.id === auth.user?.id ? '/me' : `/user/${m.id}`);
}

// —— 打卡排行榜：成员页简略展示前 3 名小方块，点击方块看完整榜（数据源=进度对齐的周期打卡）——
const lb = ref([]);
const lbLoading = ref(false);
const lbDlg = ref(false);
const lbRange = ref('month');
const lbActive = computed(() => lb.value.filter((x) => x.cnt > 0));
const lbTop = computed(() => lbActive.value.slice(0, 3));
const lbName = (x) => displayName({ real_name: x.real_name, nickname: x.name });
async function loadLeaderboard(range) {
  lbLoading.value = true;
  try {
    const r = await api.teamCheckinLeaderboard(props.teamId, range || lbRange.value, '');
    lb.value = r.board || [];
  } catch { /* 打卡为增量功能，加载失败静默，不影响成员管理 */ }
  finally { lbLoading.value = false; }
}
function switchLbRange(r) { lbRange.value = r; loadLeaderboard(r); }

// —— AI 智能分组：按成员信息+部门+竞赛给出建议，确认后逐人应用 ——
const aiDlg = ref(false);
const aiLoading = ref(false);
const aiApplying = ref(false);
const aiSuggest = ref([]);

async function aiGrouping() {
  aiLoading.value = true;
  try {
    const r = await api.teamAiGrouping(props.teamId);
    if (!r.assignments?.length) return ElMessage.info(r.message || '暂无分组建议');
    aiSuggest.value = r.assignments;
    aiDlg.value = true;
  } catch (e) { ElMessage.error(e.message); }
  finally { aiLoading.value = false; }
}

async function applyAiGrouping() {
  aiApplying.value = true;
  let n = 0;
  try {
    for (const a of aiSuggest.value) {
      try {
        await api.teamMemberRole(props.teamId, { user_id: a.user_id, role_id: a.suggest_role_id });
        n++;
      } catch { /* 单条失败继续其余成员 */ }
    }
    await reload();
    aiDlg.value = false;
    ElMessage.success(`已应用 AI 分组（${n}/${aiSuggest.value.length} 名成员）`);
  } catch (e) { ElMessage.error(e.message); }
  finally { aiApplying.value = false; }
}

// —— 组长/有成员管理权限者直接拉人：全站搜索，选中即加入（默认「组员」角色），并发入组通知 ——
const addDlg = ref(false);
const addIds = ref([]);
const addOptions = ref([]);
const addSearching = ref(false);
const addSaving = ref(false);

async function searchAdd(q) {
  if (!q) { addOptions.value = []; return; }
  addSearching.value = true;
  try {
    addOptions.value = (await api.teamUserSearch(q, props.teamId)).users;
  } finally { addSearching.value = false; }
}

async function submitAdd() {
  if (!addIds.value.length) return ElMessage.warning('请先搜索并选择用户');
  addSaving.value = true;
  try {
    const r = await api.teamMemberAdd(props.teamId, addIds.value);
    ElMessage.success(r.message || '已拉入小组');
    addDlg.value = false;
    await reload();
  } catch (e) { ElMessage.error(e.message); }
  finally { addSaving.value = false; }
}

const PERM_KEYS = [
  ['task', '任务管理'], ['progress', '进度汇报'], ['message', '发消息'],
  ['file_upload', '上传资料'], ['file_delete', '删除资料'],
  ['device', '设备管理'], ['device_approve', '预约审批'],
  ['member', '成员管理'], ['role', '角色管理'], ['team', '小组设置'],
];
const permLabel = (k) => PERM_KEYS.find((x) => x[0] === k)?.[1] || k;
const rolePerms = (r) => {
  if (Array.isArray(r?.permissions)) return r.permissions;
  try { return JSON.parse(r?.permissions || '[]'); } catch { return []; }
};

async function reload() {
  const d = await api.teamDetail(props.teamId);
  members.value = d.members;
  roles.value = d.roles;
  if (expandedMemberId.value && !members.value.some((m) => Number(m.id) === Number(expandedMemberId.value))) expandedMemberId.value = null;
  if (expandedRoleId.value && !roles.value.some((r) => Number(r.id) === Number(expandedRoleId.value))) expandedRoleId.value = null;
  if (activeRoleFilter.value.startsWith('role-')) {
    const rid = Number(activeRoleFilter.value.slice(5));
    if (!roles.value.some((r) => Number(r.id) === rid)) activeRoleFilter.value = 'all';
  }
}

async function loadInvite() {
  if (!inviteCode.value) inviteCode.value = (await api.teamInvite(props.teamId)).invite_code;
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}
async function copyInviteLink() {
  await loadInvite();
  await copyText(`${location.origin}/team?join=${inviteCode.value}`);
  ElMessage.success('邀请链接已复制，发给同学，打开即可加入');
}
async function copyInviteCode() {
  await loadInvite();
  await copyText(inviteCode.value);
  ElMessage.success('邀请码已复制');
}

// —— 自定义角色：新建/编辑使用弹窗，列表用小方块 ——
const roleDlg = ref(false);
const roleForm = ref({ id: null, name: '', level: 0, permissions: [] });
function editRole(role) {
  roleForm.value = { id: role.id, name: role.name, level: role.level, permissions: rolePerms(role) };
  roleDlg.value = true;
}
function newRole() {
  roleForm.value = { id: null, name: '', level: 1, permissions: ['progress', 'message', 'file_upload'] };
  roleDlg.value = true;
}
async function saveRole() {
  const f = roleForm.value;
  if (!f.name.trim()) return ElMessage.warning('角色名必填');
  try {
    await api.teamRoleSave(props.teamId, f);
    ElMessage.success(f.id ? '角色已更新' : `角色「${f.name}」已创建`);
    roleDlg.value = false;
    await reload();
  } catch (e) { ElMessage.error(e.message); }
}
async function removeRole(role) {
  const used = roleMemberCount(role.id) > 0;
  const tip = used ? '（有成员在使用，删除后这些成员将失去该角色权限）' : '';
  try { await ElMessageBox.confirm(`删除角色「${role.name}」？${tip}`, '确认', { type: 'warning' }); } catch { return; }
  try {
    await api.teamRoleDelete(props.teamId, role.id);
    if (Number(expandedRoleId.value) === Number(role.id)) expandedRoleId.value = null;
    await reload();
    ElMessage.success('角色已删除');
  } catch (e) { ElMessage.error(e.message); }
}

// 组长分配：多选（≤3），role_ids 数组整体替换
async function setMemberRoles(m, roleIds) {
  const ids = (roleIds || []).map(Number);
  try {
    await api.teamMemberRole(props.teamId, { user_id: m.id, role_ids: ids });
    await reload();
    ElMessage.success(`已更新 ${memberName(m)} 的角色（${ids.length} 个）`);
  } catch (e) { ElMessage.error(e.message); }
}

// —— 成员自选角色（≤3；组长也可自选/被分配，详情内同样开放）——
const selfDlg = ref(false);
const selfRoleIds = ref([]);
const myMember = computed(() => members.value.find((m) => m.is_me) || null);
function openSelfRole() {
  selfRoleIds.value = [...(myMember.value?.role_ids || [])];
  selfDlg.value = true;
}
async function saveSelfRole() {
  try {
    await api.teamSelfRole(props.teamId, { role_ids: selfRoleIds.value.map(Number) });
    ElMessage.success('我的角色已更新');
    selfDlg.value = false;
    await reload();
  } catch (e) { ElMessage.error(e.message); }
}

async function removeMember(m) {
  try { await ElMessageBox.confirm(`将 ${memberName(m)} 移出小组？`, '确认', { type: 'warning' }); } catch { return; }
  try {
    await api.teamMemberRemove(props.teamId, m.id);
    expandedMemberId.value = null;
    await reload();
    ElMessage.success('已移除');
  } catch (e) { ElMessage.error(e.message); }
}
async function transfer(m) {
  try {
    await ElMessageBox.confirm(`将组长转让给 ${memberName(m)}？转让后你将成为普通成员`, '转让组长', { type: 'warning' });
  } catch { return; }
  try {
    await api.teamTransfer(props.teamId, m.id);
    ElMessage.success('组长已转让');
    await reload();
  } catch (e) { ElMessage.error(e.message); }
}
async function dissolve() {
  try { await ElMessageBox.confirm('解散小组将删除所有任务/讨论/资料/设备数据，不可恢复！', '解散小组', { type: 'error' }); } catch { return; }
  try {
    await api.teamDelete(props.teamId);
    ElMessage.success('小组已解散');
    location.reload();
  } catch (e) { ElMessage.error(e.message); }
}

loadInvite();
loadLeaderboard('month');
</script>

<template>
  <div class="tm">
    <!-- 打卡排行榜（简略：前 3 名小方块，点击方块看完整榜） -->
    <div class="tm-sec" v-if="lbActive.length">
      <div class="tm-sec-head">
        <h4>🏆 打卡排行榜 <span class="tm-tip">本月，点击方块查看完整榜</span></h4>
        <el-button size="small" text type="primary" @click="lbDlg = true">完整排行榜 →</el-button>
      </div>
      <div class="lb-chips" v-loading="lbLoading">
        <div v-for="(m, i) in lbTop" :key="m.id" class="lb-chip" :class="`r${i}`" @click="lbDlg = true">
          <b class="lb-medal">{{ i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉' }}</b>
          <span class="lb-cavatar" v-if="m.avatar"><img :src="m.avatar" alt="" /></span>
          <span class="lb-cavatar" v-else>{{ (lbName(m) || '?').slice(0, 1) }}</span>
          <b class="lb-cname">{{ lbName(m) }}</b>
          <span class="lb-cnum"><b>{{ m.cnt }}</b> 次打卡</span>
        </div>
      </div>
    </div>

    <!-- 成员小方块 + 角色筛选 -->
    <div class="tm-sec" ref="membersSecRef">
      <div class="tm-sec-head">
        <h4>👥 成员 <span class="tm-tip">{{ members.length }} 人，点击方块查看详情</span></h4>
        <span class="tm-head-btns" v-if="perms.member">
          <el-button size="small" type="primary" plain @click="addIds = []; addOptions = []; addDlg = true">＋ 拉人进组</el-button>
          <el-button size="small" type="primary" plain :loading="aiLoading" @click="aiGrouping">🧠 AI 智能分组</el-button>
        </span>
      </div>

      <div class="filter-tags">
        <button v-for="f in roleFilters" :key="f.key" type="button" class="filter-chip"
          :class="{ active: activeRoleFilter === f.key }" @click="activeRoleFilter = f.key">
          {{ f.name }} <span>{{ f.count }}</span>
        </button>
      </div>

      <div class="member-grid">
        <button v-for="m in filteredMembers" :key="m.id" type="button" class="member-card"
          :class="{ me: m.is_me, active: Number(expandedMemberId) === Number(m.id) }" @click="toggleMember(m)">
          <span class="card-avatar">
            <img v-if="m.avatar" :src="m.avatar" alt="" />
            <template v-else>{{ memberName(m).charAt(0) || '?' }}</template>
          </span>
          <b class="card-name">{{ memberName(m) }}</b>
          <span class="card-meta">
            <template v-if="m.is_owner">👑 组长</template>
            <template v-else-if="m.role_names?.length">{{ m.role_names[0] }}</template>
            <template v-else>无角色</template>
          </span>
          <span class="card-badges">
            <i v-if="m.is_me">我</i>
            <i v-if="m.role_names.length > 1">+{{ m.role_names.length - 1 }}</i>
          </span>
        </button>
      </div>
      <div v-if="!filteredMembers.length" class="tm-empty">该角色下暂无成员</div>

      <!-- 成员详情 -->
      <div v-if="selectedMember" class="detail-panel member-detail">
        <div class="detail-head">
          <span class="detail-avatar">
            <img v-if="selectedMember.avatar" :src="selectedMember.avatar" alt="" />
            <template v-else>{{ memberName(selectedMember).charAt(0) || '?' }}</template>
          </span>
          <div class="detail-title">
            <div class="detail-name-line">
              <b>{{ memberName(selectedMember) }}</b>
              <el-tag v-if="selectedMember.is_owner" size="small" type="warning">👑 组长</el-tag>
              <el-tag v-if="selectedMember.is_me" size="small" type="info" effect="plain">我</el-tag>
            </div>
            <div class="detail-sub">@{{ selectedMember.username }} · 入组 {{ fmtDateOnly(selectedMember.join_time) }}</div>
          </div>
          <el-button size="small" @click="goProfile(selectedMember)">查看主页</el-button>
        </div>

        <div class="detail-roles">
          <span class="detail-label">角色</span>
          <template v-if="selectedMember.role_names?.length">
            <el-tag v-for="rn in selectedMember.role_names" :key="rn" size="small" effect="plain" class="role-tag">{{ rn }}</el-tag>
          </template>
          <el-tag v-else size="small" type="info" effect="plain">暂无角色</el-tag>
        </div>

        <div v-if="perms.member" class="detail-admin">
          <span class="detail-label">分配角色</span>
          <el-select :model-value="selectedMember.role_ids || []" size="small" multiple collapse-tags collapse-tags-tooltip
            :multiple-limit="3" style="width: 280px" placeholder="分配角色（≤3）"
            @change="(v) => setMemberRoles(selectedMember, v)">
            <el-option v-for="r in roles" :key="r.id" :value="r.id" :label="r.name" />
          </el-select>
          <el-button v-if="me.is_owner && !selectedMember.is_me" size="small" @click="transfer(selectedMember)">转让组长</el-button>
          <el-button v-if="!selectedMember.is_owner" size="small" type="danger" plain @click="removeMember(selectedMember)">移出小组</el-button>
        </div>
        <div v-else-if="selectedMember.is_me" class="detail-admin">
          <el-button size="small" type="primary" plain @click="openSelfRole">🎭 自选角色</el-button>
          <span class="tm-tip">组长可以之后调整你的角色</span>
        </div>
      </div>
    </div>

    <!-- 自定义角色小方块 -->
    <div class="tm-sec">
      <div class="tm-sec-head">
        <h4>🎭 自定义角色 <span class="tm-tip">点击方块查看权限和成员</span></h4>
        <el-button v-if="perms.role" size="small" type="primary" plain @click="newRole">＋ 新建角色</el-button>
      </div>

      <div class="role-grid">
        <div v-for="r in roles" :key="r.id" role="button" tabindex="0" class="role-card"
          :class="{ active: Number(expandedRoleId) === Number(r.id) }" @click="toggleRole(r)"
          @keydown.enter.prevent="toggleRole(r)" @keydown.space.prevent="toggleRole(r)">
          <b>{{ r.name }}</b>
          <span>Lv.{{ r.level }} · {{ roleMemberCount(r.id) }} 人</span>
          <i>{{ rolePerms(r).length }} 项权限</i>
          <span v-if="perms.role" class="role-card-actions" @click.stop>
            <el-button size="small" link @click="editRole(r)">编辑</el-button>
            <el-button size="small" link type="danger" @click="removeRole(r)">删除</el-button>
          </span>
        </div>
        <div v-if="perms.role" role="button" tabindex="0" class="role-card add-role" @click="newRole" @keydown.enter.prevent="newRole" @keydown.space.prevent="newRole">＋ 新建角色</div>
      </div>
      <div v-if="!roles.length" class="tm-empty">暂无自定义角色</div>

      <div v-if="selectedRole" class="detail-panel role-detail">
        <div class="detail-head">
          <div class="detail-title">
            <div class="detail-name-line"><b>{{ selectedRole.name }}</b><el-tag size="small" type="info" effect="plain">Lv.{{ selectedRole.level }}</el-tag></div>
            <div class="detail-sub">{{ roleMemberCount(selectedRole.id) }} 名成员 · {{ rolePerms(selectedRole).length }} 项权限</div>
          </div>
          <span class="detail-actions">
            <el-button size="small" @click="filterByRole(selectedRole)">查看这些成员</el-button>
            <el-button v-if="perms.role" size="small" @click="editRole(selectedRole)">编辑角色</el-button>
            <el-button v-if="perms.role" size="small" type="danger" plain @click="removeRole(selectedRole)">删除</el-button>
          </span>
        </div>
        <div class="detail-roles">
          <span class="detail-label">权限</span>
          <el-tag v-for="p in rolePerms(selectedRole)" :key="p" size="small" effect="plain" class="role-tag">{{ permLabel(p) }}</el-tag>
          <span v-if="!rolePerms(selectedRole).length" class="tm-tip">无额外权限</span>
        </div>
        <div class="detail-roles">
          <span class="detail-label">成员</span>
          <button v-for="m in selectedRoleMembers" :key="m.id" type="button" class="mini-member" @click="openMemberFromRole(m)">
            {{ memberName(m) }}
          </button>
          <span v-if="!selectedRoleMembers.length" class="tm-tip">暂无成员</span>
        </div>
      </div>
    </div>

    <!-- 成员自选角色弹窗（≤3） -->
    <el-dialog v-model="selfDlg" title="🎭 自选我的角色" width="420px" top="20vh">
      <p class="self-note">选择你的角色（≤3 个），权限叠加，组长可调整</p>
      <el-select v-model="selfRoleIds" multiple collapse-tags collapse-tags-tooltip
        :multiple-limit="3" placeholder="选择你的角色（≤3 个）" style="width:100%">
        <el-option v-for="r in roles" :key="r.id" :value="r.id" :label="r.name" />
      </el-select>
      <template #footer>
        <el-button @click="selfDlg = false">取消</el-button>
        <el-button type="primary" @click="saveSelfRole">保存</el-button>
      </template>
    </el-dialog>

    <!-- 角色新建/编辑弹窗 -->
    <el-dialog v-model="roleDlg" :title="roleForm.id ? '编辑角色' : '新建角色'" width="560px" top="14vh">
      <div class="role-dialog-form">
        <div class="rf-row">
          <el-input v-model="roleForm.name" placeholder="角色名（如：机械组组长）" style="flex:1.5" />
          <el-input-number v-model="roleForm.level" :min="0" :max="100" placeholder="等级" style="width:130px" />
        </div>
        <div class="rf-perms">
          <p class="self-note">勾选该角色拥有的权限；组长始终拥有全部管理权限。</p>
          <el-checkbox-group v-model="roleForm.permissions">
            <el-checkbox v-for="[k, label] in PERM_KEYS" :key="k" :value="k" :label="label" />
          </el-checkbox-group>
        </div>
      </div>
      <template #footer>
        <el-button @click="roleDlg = false">取消</el-button>
        <el-button type="primary" @click="saveRole">保存</el-button>
      </template>
    </el-dialog>

    <!-- 打卡排行榜完整弹窗 -->
    <el-dialog v-model="lbDlg" title="🏆 打卡排行榜" width="560px" top="10vh">
      <div class="lb-tools">
        <el-radio-group v-model="lbRange" size="small" @change="switchLbRange">
          <el-radio-button label="month">本月</el-radio-button>
          <el-radio-button label="all">全部</el-radio-button>
        </el-radio-group>
      </div>
      <div v-if="lbActive.length" class="lb-list" v-loading="lbLoading">
        <div v-for="(m, i) in lbActive" :key="m.id" class="lb-row" :class="{ top: i < 3 }">
          <span class="lb-rank">{{ i + 1 }}</span>
          <span class="lb-avatar" v-if="m.avatar"><img :src="m.avatar" alt="" /></span>
          <span class="lb-avatar" v-else>{{ (lbName(m) || '?').slice(0, 1) }}</span>
          <span class="lb-name" @click="goProfile({ id: m.id })">{{ lbName(m) }}</span>
          <span class="lb-stat">打卡 <b>{{ m.cnt }}</b></span>
          <span class="lb-stat">准时 <b>{{ m.ontime || 0 }}</b></span>
          <span class="lb-stat">⭐ {{ m.avg_score || '—' }}</span>
          <span v-if="m.featured_cnt" class="lb-stat">🏅 ×{{ m.featured_cnt }}</span>
        </div>
      </div>
      <div v-else class="lb-empty">该范围内还没有人打卡</div>
    </el-dialog>

    <!-- 拉人进组弹窗：全站搜索，选中后直接加入（默认组员角色，对方收到通知） -->
    <el-dialog v-model="addDlg" title="＋ 拉人进组" width="480px" top="20vh">
      <p class="self-note">搜索用户名 / 昵称 / 真实姓名，选中后直接加入本组，对方会收到通知</p>
      <el-select v-model="addIds" multiple filterable remote :remote-method="searchAdd"
        :loading="addSearching" :reserve-keyword="false" style="width:100%"
        placeholder="输入用户名或昵称搜索（已在组内的同学不会出现）">
        <el-option v-for="u in addOptions" :key="u.id" :value="u.id"
          :label="u.username ? `${displayName(u)}（@${u.username}）` : displayName(u)">
          <span class="add-opt">
            <el-avatar :size="20" :src="u.avatar || undefined">{{ displayName(u).charAt(0) }}</el-avatar>
            {{ displayName(u) }} <i v-if="u.username">@{{ u.username }}</i>
          </span>
        </el-option>
      </el-select>
      <template #footer>
        <el-button @click="addDlg = false">取消</el-button>
        <el-button type="primary" :loading="addSaving" @click="submitAdd">加入小组</el-button>
      </template>
    </el-dialog>

    <!-- AI 智能分组建议弹窗 -->
    <el-dialog v-model="aiDlg" title="🧠 AI 智能分组建议" width="560px" top="6vh">
      <p class="ai-note">AI 按成员信息与部门建议分组（组长除外）</p>
      <div v-for="a in aiSuggest" :key="a.user_id" class="ai-row">
        <span class="ai-name">{{ aiName(a) }}</span>
        <span class="ai-from">{{ a.current_role === '无' ? '（无角色）' : a.current_role }}</span>
        <el-icon><i class="ai-arrow">→</i></el-icon>
        <el-tag type="success" effect="light">{{ a.suggest_role }}</el-tag>
      </div>
      <template #footer>
        <el-button @click="aiDlg = false">取消</el-button>
        <el-button type="primary" :loading="aiApplying" @click="applyAiGrouping">✅ 应用分组</el-button>
      </template>
    </el-dialog>

    <!-- 邀请 / 设置 -->
    <div class="tm-sec">
      <h4>🔑 邀请与设置</h4>
      <div class="invite-row">
        <span class="invite-code">{{ inviteCode || '加载中…' }}</span>
        <el-button size="small" type="primary" plain @click="copyInviteLink">🔗 复制邀请链接</el-button>
        <el-button size="small" @click="copyInviteCode">复制邀请码</el-button>
      </div>
      <div class="invite-tip">
        <span class="tm-tip">把邀请链接发给同学，未登录会先去登录，打开后确认即可一键加入；也可在「项目小组 → 邀请码加入」输码</span>
      </div>
      <div v-if="me.is_owner" class="owner-actions">
        <el-button size="small" type="danger" plain @click="dissolve">解散小组</el-button>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.tm-sec { margin-bottom: 20px;
  h4 { margin: 0 0 10px; font-size: 14px; }
  .tm-sec-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .tm-tip { font-size: 12px; color: #94a3b8; font-weight: 400; margin-left: 8px; }
  .tm-empty { color: #94a3b8; font-size: 13px; padding: 10px 0; text-align: center; }
}
.tm-head-btns { display: inline-flex; gap: 8px; }
.loading-wait { color: #94a3b8; font-size: 13px; }

.filter-tags { display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 12px; }
.filter-chip {
  border: 1px solid var(--border); background: var(--card-bg); color: var(--text-2);
  border-radius: 999px; padding: 5px 11px; font-size: 12.5px; cursor: pointer; transition: all .15s;
  span { color: #94a3b8; margin-left: 3px; }
  &:hover { border-color: color-mix(in srgb, var(--primary) 45%, white); color: var(--primary); }
  &.active { background: var(--primary); border-color: var(--primary); color: #fff; span { color: rgba(255,255,255,.82); } }
}

.member-grid, .role-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(138px, 1fr)); gap: 10px;
}
.member-card, .role-card {
  position: relative; text-align: left; border: 1px solid var(--border); background: var(--card-bg);
  border-radius: 14px; padding: 12px; min-height: 104px; cursor: pointer; transition: all .15s;
  display: flex; flex-direction: column; align-items: flex-start; gap: 6px;
  &:hover { transform: translateY(-1px); border-color: color-mix(in srgb, var(--primary) 45%, white); box-shadow: 0 4px 14px color-mix(in srgb, var(--primary) 10%, transparent); }
  &.active { border-color: var(--primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary) 20%, white); }
}
.member-card {
  &.me { background: var(--primary-tint); border-color: color-mix(in srgb, var(--primary) 30%, white); }
  .card-name { font-size: 13.5px; line-height: 1.25; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card-meta { color: var(--text-2); font-size: 12px; }
  .card-badges { display: flex; gap: 4px; position: absolute; right: 8px; top: 8px;
    i { font-style: normal; font-size: 11px; line-height: 1; padding: 3px 5px; border-radius: 999px; background: rgba(148,163,184,.14); color: var(--text-2); }
  }
}
.card-avatar, .detail-avatar {
  display: inline-flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0;
  background: var(--primary); color: #fff; font-weight: 600;
  img { width: 100%; height: 100%; object-fit: cover; }
}
.card-avatar { width: 38px; height: 38px; border-radius: 50%; font-size: 16px; }

.role-card {
  min-height: 92px;
  b { font-size: 14px; }
  span { color: var(--text-2); font-size: 12.5px; }
  i { font-style: normal; color: #94a3b8; font-size: 12px; }
  .role-card-actions { position: absolute; right: 6px; bottom: 4px; display: flex; }
}
.add-role {
  align-items: center !important; justify-content: center; border-style: dashed; color: var(--primary);
  font-size: 14px; font-weight: 600;
}

.detail-panel {
  margin-top: 12px; border: 1px solid color-mix(in srgb, var(--primary) 25%, var(--border));
  background: color-mix(in srgb, var(--primary) 4%, var(--card-bg)); border-radius: 14px; padding: 14px;
}
.detail-head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.detail-avatar { width: 48px; height: 48px; border-radius: 50%; font-size: 19px; }
.detail-title { flex: 1; min-width: 0; }
.detail-name-line { display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
  b { font-size: 16px; }
}
.detail-sub { color: var(--text-2); font-size: 12.5px; margin-top: 3px; }
.detail-actions { display: inline-flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.detail-roles, .detail-admin { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin-top: 9px; }
.detail-label { color: var(--text-2); font-size: 12.5px; min-width: 34px; }
.role-tag { margin: 0; }
.mini-member {
  border: 1px solid var(--border); background: var(--card-bg); border-radius: 999px; padding: 4px 10px;
  cursor: pointer; font-size: 12.5px; &:hover { color: var(--primary); border-color: var(--primary); }
}

.role-dialog-form {
  .rf-row { display: flex; gap: 8px; align-items: center; }
  .rf-perms { margin-top: 12px; }
}
.invite-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  .invite-code { font-family: monospace; font-size: 15px; letter-spacing: 2px; color: var(--primary-dark); background: var(--primary-tint); border: 1px dashed color-mix(in srgb, var(--primary) 30%, white); border-radius: 8px; padding: 5px 12px; }
}
.invite-tip { margin-top: 6px; }
.owner-actions { margin-top: 12px; }
.self-note, .ai-note { color: #94a3b8; font-size: 12.5px; margin: 0 0 12px; }
.add-opt { display: inline-flex; align-items: center; gap: 6px;
  i { color: #94a3b8; font-style: normal; font-size: 12px; margin-left: 2px; }
  :deep(.el-avatar) { background: var(--primary); font-size: 11px; }
}
.ai-row { display: flex; align-items: center; gap: 10px; border: 1px solid var(--border); border-radius: 8px;
  padding: 8px 12px; margin-bottom: 8px;
  .ai-name { font-size: 13.5px; font-weight: 600; flex: 1; }
  .ai-from { color: #94a3b8; font-size: 12.5px; text-decoration: line-through; }
  .ai-arrow { font-style: normal; color: var(--primary); }
}
.lb-chips { display: flex; gap: 10px; flex-wrap: wrap; }
.lb-chip {
  display: flex; align-items: center; gap: 8px; min-width: 160px;
  border: 1px solid var(--border); border-radius: 12px; background: var(--card-bg);
  padding: 8px 14px 8px 10px; cursor: pointer; transition: all .15s;
  &:hover { border-color: #93c5fd; box-shadow: 0 2px 8px color-mix(in srgb, var(--primary) 10%, transparent); transform: translateY(-1px); }
  &.r0 { background: color-mix(in srgb, #f59e0b 10%, white); border-color: #fde68a; }
  .lb-medal { font-size: 16px; }
  .lb-cavatar, .lb-avatar { width: 28px; height: 28px; border-radius: 50%; overflow: hidden; flex-shrink: 0;
    display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600;
    background: color-mix(in srgb, var(--primary) 12%, white); color: var(--primary);
    img { width: 100%; height: 100%; object-fit: cover; }
  }
  .lb-cname { font-size: 13.5px; }
  .lb-cnum { margin-left: auto; font-size: 12px; color: var(--text-2); white-space: nowrap;
    b { color: var(--text-1); font-size: 14px; } }
}
.lb-tools { margin-bottom: 10px; }
.lb-list { display: flex; flex-direction: column; gap: 6px; }
.lb-row { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border: 1px solid var(--border);
  border-radius: 10px; font-size: 13.5px; flex-wrap: wrap;
  &.top { background: color-mix(in srgb, #f59e0b 8%, white); border-color: #fde68a; }
  .lb-rank { width: 26px; text-align: center; font-weight: 700; }
  .lb-name { min-width: 90px; cursor: pointer; &:hover { color: var(--primary); } }
  .lb-stat { color: var(--text-2); font-size: 12.5px; b { color: var(--text-1); } }
}
.lb-empty { color: #94a3b8; font-size: 13px; padding: 20px 0; text-align: center; }

@media (max-width: 768px) {
  .member-grid, .role-grid { grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 8px; }
  .member-card, .role-card { min-height: 96px; padding: 10px; }
  .detail-head { align-items: flex-start; }
  .detail-actions { width: 100%; padding-left: 60px; }
  .rf-row { flex-wrap: wrap; }
  .rf-row .el-input-number { width: 100% !important; }
  .lb-chip { min-width: 0; flex: 1 1 calc(50% - 10px); }
}
</style>