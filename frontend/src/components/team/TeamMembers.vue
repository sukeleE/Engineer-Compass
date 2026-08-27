<script setup>
// 成员与角色：成员列表（改角色/移除）+ 高自由度自定义角色 + 邀请码 + 转让/解散
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../../api.js';
import auth from '../../auth.js';

const router = useRouter();
// 点击成员头像/昵称 → 进入其公开主页（只读）；自己 → 我的管理界面
const toProfile = (m) => router.push(m.id === auth.user?.id ? '/me' : `/user/${m.id}`);

const props = defineProps({ teamId: Number, me: Object, perms: Object, members: Array, roles: Array });

const members = ref(props.members || []);
const roles = ref(props.roles || []);
const inviteCode = ref('');
const showRoleForm = ref(false);
const roleForm = ref({ id: null, name: '', level: 0, permissions: [] });

// —— AI 智能分组：按成员信息+部门+竞赛给出建议，确认后逐人应用 ——
const aiDlg = ref(false);
const aiLoading = ref(false);
const aiApplying = ref(false);
const aiSuggest = ref([]); // [{user_id, nickname, current_role, suggest_role, suggest_role_id}]

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

const PERM_KEYS = [
  ['task', '任务管理'], ['progress', '进度汇报'], ['message', '发消息'],
  ['file_upload', '上传资料'], ['file_delete', '删除资料'],
  ['device', '设备管理'], ['device_approve', '预约审批'],
  ['member', '成员管理'], ['role', '角色管理'], ['team', '小组设置'],
];
const permLabel = (k) => PERM_KEYS.find((x) => x[0] === k)?.[1] || k;
const rolePerms = (r) => { try { return JSON.parse(r.permissions || '[]'); } catch { return []; } };

const allPerms = computed(() => roles.value.map((r) => rolePerms(r)));

async function reload() {
  const d = await api.teamDetail(props.teamId);
  members.value = d.members;
  roles.value = d.roles;
}

async function loadInvite() {
  if (!inviteCode.value) inviteCode.value = (await api.teamInvite(props.teamId)).invite_code;
}

function editRole(role) {
  roleForm.value = { id: role.id, name: role.name, level: role.level, permissions: rolePerms(role) };
  showRoleForm.value = true;
}

function newRole() {
  roleForm.value = { id: null, name: '', level: 1, permissions: ['progress', 'message', 'file_upload'] };
  showRoleForm.value = true;
}

async function saveRole() {
  const f = roleForm.value;
  if (!f.name.trim()) return ElMessage.warning('角色名必填');
  try {
    await api.teamRoleSave(props.teamId, f);
    ElMessage.success(f.id ? '角色已更新' : `角色「${f.name}」已创建`);
    showRoleForm.value = false;
    await reload();
  } catch (e) { ElMessage.error(e.message); }
}

async function removeRole(role) {
  const used = members.value.some((m) => (m.role_ids || []).includes(role.id));
  const tip = used ? `（有成员在使用，删除后这些成员将失去该角色权限）` : '';
  try {
    await ElMessageBox.confirm(`删除角色「${role.name}」？${tip}`, '确认', { type: 'warning' });
  } catch { return; }
  try {
    await api.teamRoleDelete(props.teamId, role.id);
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
    ElMessage.success(`已更新 ${m.nickname} 的角色（${ids.length} 个）`);
  } catch (e) { ElMessage.error(e.message); }
}

// —— 成员自选角色（≤3；组长也可自选/被分配，行内同样开放）——
const selfDlg = ref(false);
const selfRoleIds = ref([]);

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

const myMember = computed(() => members.value.find((m) => m.is_me) || null);

async function removeMember(m) {
  try {
    await ElMessageBox.confirm(`将 ${m.nickname} 移出小组？`, '确认', { type: 'warning' });
  } catch { return; }
  try {
    await api.teamMemberRemove(props.teamId, m.id);
    await reload();
    ElMessage.success('已移除');
  } catch (e) { ElMessage.error(e.message); }
}

async function transfer(m) {
  try {
    await ElMessageBox.confirm(`将组长转让给 ${m.nickname}？转让后你将成为普通成员`, '转让组长', { type: 'warning' });
  } catch { return; }
  try {
    await api.teamTransfer(props.teamId, m.id);
    ElMessage.success('组长已转让');
    await reload();
  } catch (e) { ElMessage.error(e.message); }
}

async function dissolve() {
  try {
    await ElMessageBox.confirm('解散小组将删除所有任务/讨论/资料/设备数据，不可恢复！', '解散小组', { type: 'error' });
  } catch { return; }
  try {
    await api.teamDelete(props.teamId);
    ElMessage.success('小组已解散');
    location.reload();
  } catch (e) { ElMessage.error(e.message); }
}

loadInvite();
</script>

<template>
  <div class="tm">
    <!-- 成员 -->
    <div class="tm-sec">
      <div class="tm-sec-head">
        <h4>👥 成员（{{ members.length }}）</h4>
        <el-button v-if="perms.member" size="small" type="primary" plain :loading="aiLoading" @click="aiGrouping">🧠 AI 智能分组</el-button>
      </div>
      <div v-for="m in members" :key="m.id" class="member-row" :class="{ me: m.is_me }">
        <span class="m-avatar" :title="m.nickname" @click="toProfile(m)">
          <img v-if="m.avatar" :src="m.avatar" alt="" />
          <template v-else>{{ m.nickname?.[0] || '?' }}</template>
        </span>
        <div class="m-info">
          <b class="u-link" @click="toProfile(m)">{{ m.nickname }}<el-tag v-if="m.is_owner" size="small" type="warning" style="margin-left:6px">👑 组长</el-tag>
            <el-tag v-if="m.is_me" size="small" type="info" effect="plain" style="margin-left:4px">我</el-tag>
          </b>
          <span class="m-user">@{{ m.username }}</span>
        </div>
        <template v-if="perms.member">
          <el-select :model-value="m.role_ids || []" size="small" multiple collapse-tags collapse-tags-tooltip
            :multiple-limit="3" style="width: 220px" placeholder="分配角色（≤3）"
            @change="(v) => setMemberRoles(m, v)">
            <el-option v-for="r in roles" :key="r.id" :value="r.id" :label="r.name" />
          </el-select>
          <el-button v-if="me.is_owner && !m.is_me" size="small" text @click="transfer(m)">转让</el-button>
          <el-button v-if="!m.is_owner" size="small" text type="danger" @click="removeMember(m)">移除</el-button>
        </template>
        <template v-else-if="m.is_me">
          <el-button size="small" type="primary" plain @click="openSelfRole">🎭 自选角色</el-button>
        </template>
        <template v-else>
          <el-tag v-for="rn in m.role_names || []" :key="rn" size="small" style="margin-right:4px">{{ rn }}</el-tag>
          <el-tag v-if="!(m.role_names || []).length" size="small">无角色</el-tag>
        </template>
      </div>
    </div>

    <!-- 成员自选角色弹窗（≤3） -->
    <el-dialog v-model="selfDlg" title="🎭 自选我的角色" width="420px" top="20vh">
      <p class="self-note">选择你的角色（≤3 个），权限叠加，组长可调整</p>
      <el-select v-model="selfRoleIds" multiple collapse-tags collapse-tags-tooltip
        :multiple-limit="3" placeholder="选择角色（≤3）" style="width:100%">
        <el-option v-for="r in roles" :key="r.id" :value="r.id" :label="r.name" />
      </el-select>
      <template #footer>
        <el-button @click="selfDlg = false">取消</el-button>
        <el-button type="primary" @click="saveSelfRole">保存角色</el-button>
      </template>
    </el-dialog>

    <!-- 角色 -->
    <div class="tm-sec">
      <div class="tm-sec-head">
        <h4>🎭 自定义角色 <span class="tm-tip">组长可创建任意角色并勾选权限</span></h4>
        <el-button v-if="perms.role" size="small" type="primary" plain @click="newRole">＋ 新建角色</el-button>
      </div>

      <div v-if="showRoleForm" class="role-form">
        <div class="rf-row">
          <el-input v-model="roleForm.name" placeholder="角色名（如：机械组组长）" style="flex:1.5" />
          <el-input-number v-model="roleForm.level" :min="0" :max="100" placeholder="等级" style="width:120px" />
          <el-button type="primary" @click="saveRole">保存</el-button>
          <el-button @click="showRoleForm = false">取消</el-button>
        </div>
        <div class="rf-perms">
          <el-checkbox-group v-model="roleForm.permissions">
            <el-checkbox v-for="[k, label] in PERM_KEYS" :key="k" :value="k" :label="label" />
          </el-checkbox-group>
        </div>
      </div>

      <div v-if="!roles.length" class="tm-empty">暂无自定义角色</div>
      <div v-for="r in roles" :key="r.id" class="role-row">
        <div class="r-info">
          <b>{{ r.name }}</b>
          <el-tag size="small" type="info" effect="plain">Lv.{{ r.level }}</el-tag>
          <span class="r-perms">
            <el-tag v-for="p in rolePerms(r)" :key="p" size="small" effect="plain">{{ permLabel(p) }}</el-tag>
          </span>
        </div>
        <template v-if="perms.role">
          <el-button size="small" text @click="editRole(r)">编辑</el-button>
          <el-button size="small" text type="danger" @click="removeRole(r)">删除</el-button>
        </template>
      </div>
    </div>

    <!-- AI 智能分组建议弹窗 -->
    <el-dialog v-model="aiDlg" title="🧠 AI 智能分组建议" width="560px" top="6vh">
      <p class="ai-note">AI 按成员信息与部门建议分组（组长除外）</p>
      <div v-for="a in aiSuggest" :key="a.user_id" class="ai-row">
        <span class="ai-name">{{ a.nickname }}</span>
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
        <span class="tm-tip">邀请码发给同学，在「项目小组 → 邀请码加入」粘贴即可</span>
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
  .tm-sec-head { display: flex; justify-content: space-between; align-items: center; gap: 8px;
    .tm-tip { font-size: 12px; color: #94a3b8; font-weight: 400; margin-left: 8px; }
  }
  .tm-tip { font-size: 12px; color: #94a3b8; margin-left: 6px; }
  .tm-empty { color: #94a3b8; font-size: 13px; padding: 10px 0; }
}
.member-row {
  display: flex; align-items: center; gap: 10px; border: 1px solid var(--border); border-radius: 10px;
  padding: 8px 12px; margin-bottom: 8px;
  &.me { background: #eff6ff; border-color: #bfdbfe; }
  .m-avatar {
    width: 32px; height: 32px; border-radius: 50%; background: #2563eb; color: #fff;
    display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0;
    cursor: pointer; overflow: hidden; transition: box-shadow .15s;
    &:hover { box-shadow: 0 0 0 2px #bfdbfe; }
    img { width: 100%; height: 100%; object-fit: cover; }
  }
  .m-info { flex: 1; min-width: 0; b { font-size: 13.5px; } .m-user { color: var(--text-2); font-size: 12px; margin-left: 6px; } }
  .u-link { cursor: pointer; &:hover { color: #2563eb; } }
}
.role-form { background: #f8fafc; border: 1px dashed var(--border); border-radius: 10px; padding: 12px; margin-bottom: 10px;
  .rf-row { display: flex; gap: 8px; align-items: center; }
  .rf-perms { margin-top: 10px; }
}

// 移动端：成员行/角色表单换行（220px select 横排放不下）
@media (max-width: 768px) {
  .member-row { flex-wrap: wrap; }
  .member-row .m-info { flex: 1 1 100%; }
  .rf-row { flex-wrap: wrap; }
  .rf-row .el-select { width: 100% !important; }
}
.role-row {
  display: flex; align-items: center; gap: 10px; border: 1px solid var(--border); border-radius: 10px;
  padding: 8px 12px; margin-bottom: 8px;
  .r-info { flex: 1; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; b { font-size: 13.5px; }
    .r-perms { display: flex; gap: 4px; flex-wrap: wrap; }
  }
}
.invite-row { display: flex; align-items: center; gap: 10px;
  .invite-code { font-family: monospace; font-size: 15px; letter-spacing: 2px; color: #1d4ed8; background: #eff6ff; border: 1px dashed #bfdbfe; border-radius: 8px; padding: 5px 12px; }
}
.owner-actions { margin-top: 12px; }
.self-note { color: #94a3b8; font-size: 12.5px; margin: 0 0 12px; }
.ai-note { color: #94a3b8; font-size: 12.5px; margin: 0 0 12px; }
.ai-row { display: flex; align-items: center; gap: 10px; border: 1px solid var(--border); border-radius: 8px;
  padding: 8px 12px; margin-bottom: 8px;
  .ai-name { font-size: 13.5px; font-weight: 600; flex: 1; }
  .ai-from { color: #94a3b8; font-size: 12.5px; text-decoration: line-through; }
  .ai-arrow { font-style: normal; color: #2563eb; }
}
</style>
