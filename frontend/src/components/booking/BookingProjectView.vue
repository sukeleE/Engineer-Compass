<template>
  <AuthView v-if="!auth.token" />
  <div v-else-if="notFound" class="pv-wrap">
    <el-result icon="warning" title="项目不存在或无权查看" sub-title="关闭的项目仅负责人、管理员和已有预约的成员可见">
      <template #extra><el-button type="primary" @click="$router.push('/booking')">返回资源预约</el-button></template>
    </el-result>
  </div>

  <div v-else class="pv-wrap bpv-wrap" v-loading="loading">
    <!-- 头部 -->
    <div class="pv-hero card bpv-hero">
      <div class="bpv-title">
        <el-button link @click="$router.push('/booking')">← 返回大厅</el-button>
        <h2>
          📁 {{ project.name }}
          <el-tag v-if="project.status === 'closed'" type="info" size="small">已关闭</el-tag>
          <el-tag v-else type="success" size="small">开放中</el-tag>
        </h2>
        <p class="sub2">{{ project.description || '暂无项目说明' }}</p>
        <p class="bpv-meta dim">负责人：{{ project.creator_name || '—' }} ｜ 默认新资源审批方式：{{ MODE_ZH[project.default_approve_mode] }} ｜ {{ project.resource_count }} 项资源</p>
      </div>
      <el-button v-if="project.canManage" @click="openSettings">⚙️ 项目设置</el-button>
    </div>

    <!-- tab -->
    <div class="exp-tabbar">
      <button class="tabchip" :class="{ on: tab === 'week' }" @click="switchTab('week')">🗓 周视图</button>
      <button class="tabchip" :class="{ on: tab === 'resources' }" @click="switchTab('resources')">📦 可用资源</button>
      <button class="tabchip" :class="{ on: tab === 'teams' }" @click="switchTab('teams')">👥 固定组队</button>
      <button class="tabchip" :class="{ on: tab === 'approvals' }" @click="switchTab('approvals')">
        📑 预约与审批<i v-if="project.pending_count" class="tab-badge">{{ project.pending_count }}</i>
      </button>
    </div>

    <!-- 周视图 -->
    <div v-show="tab === 'week'" class="card bpv-week">
      <WeekGantt :project="project" :data="timeline" :from="weekFrom" :loading="tlLoading"
        @navigate="onNavigate" @select-slot="openBooking" @select-booking="openDetail"
        @toggle-history="onToggleHistory" />
    </div>

    <!-- 资源 -->
    <div v-show="tab === 'resources'" class="card">
      <ResourcePanel v-if="tabLoaded.resources" ref="resourcePanelRef" :project="project" @changed="onDataChanged" />
    </div>

    <!-- 组队 -->
    <div v-show="tab === 'teams'" class="card">
      <TeamPanel v-if="tabLoaded.teams" ref="teamPanelRef" :project="project" />
    </div>

    <!-- 预约与审批 -->
    <div v-show="tab === 'approvals'" class="card">
      <div class="filter-bar">
        <el-select v-model="listStatus" style="width: 130px" @change="loadBookings">
          <el-option label="待审批" value="pending" />
          <el-option label="已确认" value="confirmed" />
          <el-option label="已驳回" value="rejected" />
          <el-option label="已取消" value="canceled" />
        </el-select>
        <el-checkbox v-model="listMine" @change="loadBookings">只看与我相关</el-checkbox>
        <span class="spacer"></span>
        <el-button @click="loadBookings">刷新</el-button>
      </div>

      <div v-if="bookings.length" class="table-scroll">
        <table class="rq-table">
          <thead>
            <tr><th>资源</th><th>时段</th><th>人/量</th><th>预约人</th><th>状态</th><th style="width: 210px">操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="b in bookings" :key="b.id" class="row-click" @click="openDetail(b.id)">
              <td>{{ KIND_MAP[b.kind]?.icon }} {{ b.resource_name }}</td>
              <td class="dim">{{ b.start_time }}<br />～ {{ b.end_time }}</td>
              <td>{{ b.is_space ? `👥 ${b.headcount} 人` : `×${b.qty} ${b.unit || '件'}` }}</td>
              <td>{{ b.booker_name }}<span class="bk-src">{{ SRC_ZH[b.source] }}</span></td>
              <td><el-tag :type="STATUS_META[b.status]?.type" size="small">{{ STATUS_META[b.status]?.label }}</el-tag></td>
              <td @click.stop>
                <el-button v-if="b.status === 'pending' && b.perm?.canApprove"
                  link type="success" size="small" :loading="actingId === b.id" @click="quickApprove(b)">通过</el-button>
                <el-button v-if="b.status === 'pending' && b.perm?.canReject"
                  link type="danger" size="small" @click="quickReject(b)">驳回</el-button>
                <el-button link type="primary" size="small" @click="openDetail(b.id)">详情</el-button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="empty-wrap"><el-empty :description="listStatus === 'pending' ? '没有待审批预约' : '暂无预约记录'" :image-size="80" /></div>
    </div>

    <!-- 设置弹窗 -->
    <el-dialog v-model="settingsOpen" title="项目设置" width="520px" append-to-body destroy-on-close>
      <el-form label-position="top">
        <el-form-item label="项目名称" required>
          <el-input v-model="sf.name" maxlength="40" show-word-limit />
        </el-form-item>
        <el-form-item label="项目说明">
          <el-input v-model="sf.description" type="textarea" :rows="3" maxlength="500" show-word-limit />
        </el-form-item>
        <el-form-item label="新资源的默认审批方式（不影响已有资源）">
          <el-radio-group v-model="sf.default_approve_mode">
            <el-radio value="approval">需审批</el-radio>
            <el-radio value="first_come">先到先得</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="项目状态">
          <el-radio-group v-model="sf.status">
            <el-radio value="open">开放（接受新预约）</el-radio>
            <el-radio value="closed">关闭（仅负责人/管理员/已有预约者可见）</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="settingsOpen = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveSettings">保存</el-button>
      </template>
    </el-dialog>

    <!-- 预约弹窗 -->
    <BookingDialog v-if="bookingInitial" :project="project" :resources="bookableResources"
      :initial="bookingInitial" @close="bookingInitial = null" @saved="onBookingSaved" />

    <!-- 详情弹窗 -->
    <BookingDetailDialog v-if="detailId" :id="detailId" @close="detailId = null" @changed="onDataChanged" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import auth from '../../auth.js';
import { api } from '../../api.js';
import AuthView from '../AuthView.vue';
import WeekGantt from './WeekGantt.vue';
import ResourcePanel from './ResourcePanel.vue';
import TeamPanel from './TeamPanel.vue';
import BookingDialog from './BookingDialog.vue';
import BookingDetailDialog from './BookingDetailDialog.vue';
import { MODE_ZH, STATUS_META, KIND_MAP, fmtDate, mondayOf, parseLocal } from '../../utils/booking.js';

const route = useRoute();
const router = useRouter();

const SRC_ZH = { solo: '', team: ' · 组队', custom: ' · 临时多人' };

const loading = ref(true);
const notFound = ref(false);
const project = ref({});
const timeline = ref(null);
const tlLoading = ref(false);
const tab = ref('week');
const tabLoaded = ref({ resources: false, teams: false, approvals: false });
const weekFrom = ref(mondayOf(new Date()));
const allHistory = ref(false);

const bookings = ref([]);
const listStatus = ref('pending');
const listMine = ref(false);
const actingId = ref(null);

const settingsOpen = ref(false);
const saving = ref(false);
const sf = ref({ name: '', description: '', default_approve_mode: 'approval', status: 'open' });

const bookingInitial = ref(null);
const detailId = ref(null);

const resourcePanelRef = ref(null);
const teamPanelRef = ref(null);

const bookableResources = computed(() => (timeline.value?.resources || []).filter((r) => r.status === 'active'));

async function loadProject() {
  const d = await api.bookingProject(route.params.id);
  // 实验室项目走「资源」板块（借设备/借教室），通用项目页不再提供第二个借入口
  if (d.project?.name === '实验室') { router.replace('/resources'); return false; }
  project.value = d.project;
  return true;
}
async function loadTimeline() {
  tlLoading.value = true;
  try {
    timeline.value = await api.bookingTimeline(project.value.id, {
      from: fmtDate(weekFrom.value), days: 7, ...(allHistory.value ? { all: 1 } : {}),
    });
  } finally {
    tlLoading.value = false;
  }
}
async function onDataChanged() {
  // 资源/审批/预约动作后：项目计数 + 甘特 + 预约列表 + 子面板一起刷新
  try { if (!(await loadProject())) return; } catch { /* 404 等已在详情内提示 */ }
  loadTimeline();
  if (tabLoaded.value.approvals) loadBookings();
  resourcePanelRef.value?.reload?.();
}
function onNavigate(d) {
  weekFrom.value = d;
  loadTimeline();
}
function onToggleHistory(v) {
  allHistory.value = v;
  loadTimeline();
}

function switchTab(t) {
  tab.value = t;
  if (t === 'approvals' && !tabLoaded.value.approvals) {
    tabLoaded.value.approvals = true;
    loadBookings();
  }
  if (t === 'resources' && !tabLoaded.value.resources) tabLoaded.value.resources = true;
  if (t === 'teams' && !tabLoaded.value.teams) tabLoaded.value.teams = true;
}

async function loadBookings() {
  bookings.value = (await api.bookingList(project.value.id, {
    status: listStatus.value, ...(listMine.value ? { mine: 1 } : {}),
  })).bookings;
}
async function quickApprove(b) {
  actingId.value = b.id;
  try {
    await api.bookingApprove(b.id);
    ElMessage.success('已通过');
    await loadBookings();
    onDataChanged();
  } catch (e) { ElMessage.error(e.message); } finally { actingId.value = null; }
}
async function quickReject(b) {
  let reason;
  try {
    const r = await ElMessageBox.prompt('请填写驳回理由（将通知预约人）', `驳回 #${b.id}`, {
      confirmButtonText: '确认驳回', cancelButtonText: '取消', inputType: 'textarea',
      inputValidator: (v) => (v && v.trim() ? true : '驳回必须填写理由'),
    });
    reason = r.value;
  } catch { return; }
  actingId.value = b.id;
  try {
    await api.bookingReject(b.id, reason.trim());
    ElMessage.success('已驳回');
    await loadBookings();
    onDataChanged();
  } catch (e) { ElMessage.error(e.message); } finally { actingId.value = null; }
}

function openBooking(initial) {
  bookingInitial.value = initial;
}
function onBookingSaved() {
  bookingInitial.value = null;
  ElMessage({ message: '预约流程已完成', type: 'success', duration: 1200 });
  onDataChanged();
}
function openDetail(v) {
  // 甘特/手风琴 emit 预约对象，审批表与 ?bid= 传数字 id
  detailId.value = typeof v === 'object' && v ? v.id : v;
}

function openSettings() {
  sf.value = {
    name: project.value.name,
    description: project.value.description || '',
    default_approve_mode: project.value.default_approve_mode,
    status: project.value.status,
  };
  settingsOpen.value = true;
}
async function saveSettings() {
  if (!sf.value.name.trim()) return ElMessage.warning('项目名称不能为空');
  if (sf.value.status === 'closed' && project.value.status === 'open') {
    try {
      await ElMessageBox.confirm('关闭后项目不再接受新预约，且仅负责人/管理员/已有预约者可见。确认关闭？', '关闭项目', { type: 'warning' });
    } catch { return; }
  }
  saving.value = true;
  try {
    await api.bookingProjectUpdate(project.value.id, {
      name: sf.value.name.trim(),
      description: sf.value.description,
      default_approve_mode: sf.value.default_approve_mode,
      status: sf.value.status,
    });
    ElMessage.success('已保存');
    settingsOpen.value = false;
    await loadProject();
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  if (!auth.token) return;
  try {
    // ?date=YYYY-MM-DD 定位到所在周；?bid= 自动打开详情
    const qd = parseLocal(`${route.query.date} 12:00`);
    if (qd) weekFrom.value = mondayOf(qd);
    if (!(await loadProject())) return; // 实验室项目已转「资源」板块
    await loadTimeline();
    if (route.query.bid) detailId.value = Number(route.query.bid);
  } catch (e) {
    if (e.status === 404) notFound.value = true;
    else ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
});
</script>

<style lang="scss" scoped>
.bpv-hero { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.bpv-title {
  h2 { margin: 6px 0 8px; font-size: 20px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
}
.bpv-meta { font-size: 12.5px; margin: 8px 0 0; }
.bpv-week { padding: 14px; }
.tab-badge {
  font-style: normal; background: #f59e0b; color: #fff; font-size: 11px; border-radius: 999px;
  padding: 0 6px; margin-left: 4px; line-height: 16px;
}
.bk-src { color: var(--text-3); font-size: 12px; margin-left: 4px; }
</style>
