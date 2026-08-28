<script setup>
// 项目小组：我的小组列表 + 创建/加入 + 组内工作台（TeamDetail）
import { ref, computed, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api } from '../api.js';
import auth, { clearAuth } from '../auth.js';
import TeamDetail from './TeamDetail.vue';
import PlanChat from './PlanChat.vue';

const router = useRouter();
const route = useRoute();

const teams = ref([]);
const loading = ref(false);
const selTeamId = ref(null); // 选中的小组 id（横向标签页选择）
const selTeam = computed(() => teams.value.find((t) => t.id === selTeamId.value) || null);

// ?team=<id> 深链：从「我的」小组卡片直达对应工作台；选中变化同步回 URL
function selectByQuery(id) {
  const t = teams.value.find((x) => x.id === Number(id));
  if (t) selTeamId.value = t.id;
}
watch(selTeamId, (id) => {
  if (id) router.replace({ query: { ...route.query, team: id } }).catch(() => {});
});
watch(() => route.query.team, (id) => { if (id) selectByQuery(id); });
const showCreate = ref(false);
const showJoin = ref(false);
const showChat = ref(false); // AI 对话建组弹窗
const newTeam = ref({ name: '', desc: '', comp_id: null });
const joinCode = ref('');
const comps = ref([]); // 竞赛列表（AI 智能建组用）

async function loadComps() {
  try { comps.value = await api.competitions({ status: 'active' }); } catch { /* 竞赛加载失败不阻塞建组 */ }
}

async function load() {
  loading.value = true;
  try {
    const res = await api.me();
    teams.value = res.teams;
    // 保持选中状态（标签页仍存在则保留，否则重置为第一个）
    if (selTeamId.value && !teams.value.some((t) => t.id === selTeamId.value)) selTeamId.value = null;
    if (!selTeamId.value && teams.value.length) selTeamId.value = teams.value[0].id;
    // ?team=<id> 深链：列表加载完成后选中对应小组
    if (route.query.team) selectByQuery(route.query.team);
  } catch (e) {
    if (e.message.includes('401') || e.message.includes('登录')) clearAuth();
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}

// 建组：直接创建，或带「AI 对话」确认的 departments+plan（chatResult）一并提交
async function create(chatResult) {
  if (!newTeam.value.name.trim()) return ElMessage.warning('请输入小组名称');
  loading.value = true;
  try {
    const card = chatResult ? { ...newTeam.value, departments: chatResult.departments, plan: chatResult.plan } : newTeam.value;
    const res = await api.teamCreate(card);
    if (res.ai_depts?.length) {
      ElMessage.success(`已创建「${res.name}」，已按对话确认拆分为部门：${res.ai_depts.join('、')}（备赛计划已生成）`);
    } else if (res.plan_id) {
      ElMessage.success(`已创建「${res.name}」，备赛计划已生成（AI 服务不可用，已用模板兜底）`);
    } else {
      ElMessage.success(`已创建「${res.name}」，邀请码 ${res.invite_code}`);
    }
    showCreate.value = false;
    showChat.value = false;
    newTeam.value = { name: '', desc: '', comp_id: null };
    await load();
    if (teams.value.some((x) => x.id === res.id)) selTeamId.value = res.id;
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}

async function join() {
  if (!joinCode.value.trim()) return ElMessage.warning('请输入邀请码');
  loading.value = true;
  try {
    const res = await api.teamJoin(joinCode.value);
    ElMessage.success(res.message);
    joinCode.value = '';
    showJoin.value = false;
    await load();
    if (teams.value.some((x) => x.id === res.id)) selTeamId.value = res.id;
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}

function logout() {
  clearAuth();
  ElMessage.success('已退出登录');
  router.push('/');
}

onMounted(() => { if (auth.token) { load(); loadComps(); } });
</script>

<template>
  <div class="team-page">
    <!-- 未登录 -->
    <div v-if="!auth.token" class="need-login">
      <div class="nl-icon">🏗️</div>
      <h2>项目小组需要登录</h2>
      <p>进度对齐 · 小组讨论 · 资料共享 · 设备预约 —— 登录后创建或加入小组</p>
      <router-link to="/login?redirect=/team"><el-button type="primary" size="large">去登录 / 注册</el-button></router-link>
    </div>

    <template v-else>
      <div class="team-head">
        <div>
          <h2>🏗️ 项目小组</h2>
          <p class="head-sub">👤 {{ auth.user?.nickname }}<span v-if="auth.user?.is_admin" class="admin-tag">管理员</span>
            · 加入 {{ teams.length }} 个小组</p>
        </div>
        <div class="head-actions">
          <el-button @click="showJoin = true">🔑 邀请码加入</el-button>
          <el-button type="primary" @click="showCreate = true">＋ 创建小组</el-button>
          <el-button text @click="logout">退出</el-button>
        </div>
      </div>

      <!-- 创建 / 加入 -->
      <el-dialog :model-value="showCreate" title="创建小组" width="460px" @update:model-value="(v) => (showCreate = v)">
        <el-form label-position="top">
          <el-form-item label="① 选择参赛竞赛（AI 将据此拆分部门并编写备赛计划）">
            <el-select v-model="newTeam.comp_id" filterable placeholder="选择竞赛（可选：不选则手动建组）" style="width: 100%">
              <el-option :value="null" label="🚫 暂不关联竞赛（手动建组）" />
              <el-option v-for="c in comps" :key="c.id" :label="c.name" :value="c.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="② 小组名称"><el-input v-model="newTeam.name" maxlength="30" placeholder="如：智能车竞速组" /></el-form-item>
          <el-form-item label="③ 小组简介"><el-input v-model="newTeam.desc" type="textarea" :rows="2" placeholder="选填" /></el-form-item>
          <el-alert v-if="newTeam.comp_id" type="success" :closable="false" class="ai-tip"
            title="🧠 创建后自动：AI 拆部门（机械/电控/软件）→ 生成备赛计划，组长可分配" />
          <div class="create-actions">
            <el-button type="success" plain @click="showChat = true">💬 AI 对话智能建组</el-button>
            <el-button type="primary" :loading="loading" @click="create()">🏗️ 直接创建（你将成为组长）</el-button>
          </div>
          <div class="create-tip">💬 对话：AI 先问分组与周期再生成；直接创建走一键 AI</div>
        </el-form>
      </el-dialog>

      <!-- AI 对话建组：先与 AI 确认部门分组与备赛周期 → 按对话确认的方案建组 -->
      <PlanChat v-model="showChat" mode="team-create" :comp-id="newTeam.comp_id"
        @done="(r) => create(r)" />
      <el-dialog :model-value="showJoin" title="邀请码加入" width="420px" @update:model-value="(v) => (showJoin = v)">
        <el-form label-position="top">
          <el-form-item label="邀请码">
            <el-input v-model="joinCode" placeholder="8 位邀请码，如 A8J2J992" style="text-transform: uppercase" @keyup.enter="join" />
          </el-form-item>
          <el-button type="primary" :loading="loading" @click="join">加入小组</el-button>
        </el-form>
      </el-dialog>

      <div v-loading="loading" class="team-body">
        <!-- 横向小组标签页：小组多时自动横向滚动（移动端 el-tabs 全局压缩样式已兜底） -->
        <el-tabs v-if="teams.length" v-model="selTeamId" class="team-tabs">
          <el-tab-pane v-for="t in teams" :key="t.id" :name="t.id">
            <template #label>
              <span class="tt-label">
                <span class="tt-name">{{ t.name }}</span>
                <el-tag v-if="t.is_owner" size="small" type="warning" class="tt-tag">组长</el-tag>
              </span>
            </template>
          </el-tab-pane>
        </el-tabs>
        <el-empty v-else class="team-empty" description="还没有小组 — 创建或输入邀请码加入" />

        <!-- 组内工作台（:key 强制重建——切组时子组件 onMounted 重新加载，避免显示旧组数据） -->
        <TeamDetail v-if="selTeam" :key="selTeam.id" :team-id="selTeam.id" :my-role="selTeam.role_name" />
        <div v-else-if="teams.length" class="detail-placeholder">
          <div class="dp-icon">🏗️</div>
          <p>选择上方小组标签进入工作台</p>
        </div>
      </div>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.team-page { padding: 20px 24px; max-width: 1280px; margin: 0 auto; }
.ai-tip { margin-bottom: 12px; border-radius: 8px; }
.create-actions { display: flex; gap: 8px; }
.create-tip { margin-top: 8px; color: #94a3b8; font-size: 12px; }
.need-login { text-align: center; padding: 80px 0;
  .nl-icon { font-size: 48px; }
  h2 { margin: 12px 0 6px; }
  p { color: var(--text-2); margin: 0 0 20px; }
}
.team-head { display: flex; justify-content: space-between; align-items: flex-end; flex-wrap: wrap; gap: 10px; margin-bottom: 16px;
  h2 { margin: 0; font-size: 20px; }
  .head-sub { margin: 4px 0 0; color: var(--text-2); font-size: 13px;
    .admin-tag { background: var(--badge-tint); color: var(--badge-fg); border-radius: 4px; padding: 1px 6px; font-size: 11px; margin-left: 4px; }
  }
  .head-actions { display: flex; gap: 8px; }
}
.team-body { display: flex; flex-direction: column; gap: 14px; }

// 横向小组标签页：白底圆角卡包裹，标签间留隙；多小组超宽时 el-tabs 内部横向滚动
.team-tabs {
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 4px 10px 0;
  :deep(.el-tabs__header) { margin-bottom: 0; }
  :deep(.el-tabs__nav-wrap) { overflow-x: auto; overflow-y: hidden; }
  :deep(.el-tabs__nav-wrap::-webkit-scrollbar) { display: none; }
  :deep(.el-tabs__item) { font-size: 13.5px; padding: 0 14px; }
  .tt-label { display: inline-flex; align-items: center; gap: 6px;
    .tt-name { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tt-tag { flex-shrink: 0; }
  }
}
.team-empty { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 60px 0; }
.detail-placeholder { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 90px 0; text-align: center; color: #94a3b8;
  .dp-icon { font-size: 42px; } p { margin: 8px 0 0; }
}
</style>
