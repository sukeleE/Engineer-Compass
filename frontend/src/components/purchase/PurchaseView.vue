<template>
  <AuthView v-if="!auth.token" />
  <div v-else class="pv-wrap">
    <!-- 页头 -->
    <div class="pv-hero card">
      <div>
        <h2>🛒 物料采购</h2>
        <p class="sub2">比赛/项目物料采购的申请、审批、发票与金额统计闭环。选择档案 → 填报明细（支持 BOM 识别）→ 负责人/老师审批 → 通过后传发票。</p>
      </div>
      <el-button type="primary" @click="openCreate">＋ 新建采购申请</el-button>
    </div>

    <!-- 顶部统计卡 -->
    <div class="stat-cards">
      <div class="stat-card">
        <span class="sc-label">我的申请</span>
        <b class="sc-num">{{ mineAll.length }}</b><span class="sc-unit">份</span>
      </div>
      <div class="stat-card ok">
        <span class="sc-label">已通过金额</span>
        <b class="sc-num">¥{{ mineApprovedAmount.toFixed(2) }}</b>
      </div>
      <div class="stat-card warn">
        <span class="sc-label">待审批</span>
        <b class="sc-num">{{ mineByStatus.pending.count }}</b><span class="sc-unit">份 / ¥{{ mineByStatus.pending.amount.toFixed(0) }}</span>
      </div>
      <div class="stat-card danger">
        <span class="sc-label">待传发票</span>
        <b class="sc-num">{{ mineByStatus.approved.count }}</b><span class="sc-unit">份 / ¥{{ mineByStatus.approved.amount.toFixed(0) }}</span>
      </div>
      <div v-if="isApprover" class="stat-card primary">
        <span class="sc-label">待我审批</span>
        <b class="sc-num">{{ pendingForMe }}</b><span class="sc-unit">份</span>
      </div>
    </div>

    <!-- chip 标签条 -->
    <div class="exp-tabbar">
      <button class="tabchip" :class="{ on: tab === 'mine' }" @click="switchTab('mine')">📋 我的申请</button>
      <button v-if="isApprover" class="tabchip" :class="{ on: tab === 'approve' }" @click="switchTab('approve')">
        ✅ 审批工作台<span v-if="pendingForMe" class="tab-badge">{{ pendingForMe }}</span>
      </button>
      <button v-if="isApprover" class="tabchip" :class="{ on: tab === 'stats' }" @click="switchTab('stats')">📊 金额统计</button>
      <!-- 任何登录用户都可建档（建档后自动成为负责人），管理 tab 始终可见 -->
      <button class="tabchip" :class="{ on: tab === 'events' }" @click="switchTab('events')">🗂️ 比赛·项目管理</button>
    </div>

    <!-- ============ Tab 1：我的申请 ============ -->
    <div v-show="tab === 'mine'" class="card">
      <div class="filter-bar">
        <el-select v-model="mineFilter.status" placeholder="全部状态" clearable style="width: 130px" @change="loadMine">
          <el-option v-for="(zh, k) in STATUS_ZH" :key="k" :value="k" :label="zh" />
        </el-select>
        <el-date-picker v-model="mineRange" type="daterange" range-separator="至" start-placeholder="起"
          end-placeholder="止" value-format="YYYY-MM-DD" size="default" @change="loadMine" />
        <span class="spacer"></span>
        <span class="sum-hint">当前 {{ mineList.length }} 份 · 合计 <b>¥{{ mineListAmount.toFixed(2) }}</b></span>
        <el-button @click="loadMine">刷新</el-button>
      </div>

      <table v-if="mineList.length" class="rq-table">
        <thead>
          <tr><th>#</th><th>比赛/项目</th><th>物料</th><th class="r">金额</th><th>状态</th><th>提交时间</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="r in mineList" :key="r.id" class="row-click" @click="openDetail(r.id)">
            <td>{{ r.id }}</td>
            <td><span class="ev-tag">{{ r.kind === '项目' ? '📁' : '🏆' }}</span> {{ r.event_name }}</td>
            <td>{{ r.item_count }} 项<span v-if="r.remark" class="rk-note">：{{ r.remark }}</span></td>
            <td class="r money">¥{{ r.amount.toFixed(2) }}</td>
            <td><el-tag :type="statusType(r.status)" size="small" effect="light">{{ STATUS_ZH[r.status] }}</el-tag>
              <span v-if="r.status === 'approved'" class="red-dot" title="待传发票"></span></td>
            <td class="dim">{{ fmtTime(r.submit_time) }}</td>
            <td><el-button link type="primary" size="small">查看</el-button></td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty-wrap"><el-empty description="还没有采购申请" :image-size="80" /></div>

      <!-- 窄屏卡片 -->
      <div class="rq-cards">
        <div v-for="r in mineList" :key="r.id" class="rq-card" @click="openDetail(r.id)">
          <div class="rc-top">
            <b>#{{ r.id }} {{ r.event_name }}</b>
            <el-tag :type="statusType(r.status)" size="small">{{ STATUS_ZH[r.status] }}</el-tag>
          </div>
          <div class="rc-mid">{{ r.item_count }} 项物料<span v-if="r.remark"> · {{ r.remark }}</span></div>
          <div class="rc-bot"><span class="money">¥{{ r.amount.toFixed(2) }}</span><span class="dim">{{ fmtTime(r.submit_time) }}</span></div>
        </div>
      </div>
    </div>

    <!-- ============ Tab 2：审批工作台 ============ -->
    <div v-if="isApprover" v-show="tab === 'approve'" class="card">
      <div class="filter-bar">
        <el-select v-model="apFilter.event_id" placeholder="全部我负责的档案" clearable filterable style="width: 200px" @change="loadApprove">
          <el-option v-for="e in approverEvents" :key="e.id" :value="e.id"
            :label="`${e.kind === '项目' ? '📁' : '🏆'} ${e.name}`" />
        </el-select>
        <el-select v-model="apFilter.status" placeholder="全部状态" clearable style="width: 130px" @change="loadApprove">
          <el-option v-for="(zh, k) in STATUS_ZH" :key="k" :value="k" :label="zh" />
        </el-select>
        <el-date-picker v-model="apRange" type="daterange" range-separator="至" start-placeholder="起"
          end-placeholder="止" value-format="YYYY-MM-DD" @change="loadApprove" />
        <span class="spacer"></span>
        <el-button @click="loadApprove">刷新</el-button>
      </div>

      <table v-if="apList.length" class="rq-table">
        <thead>
          <tr><th>#</th><th>申请人</th><th>比赛/项目</th><th>物料</th><th class="r">金额</th><th>状态</th><th>提交时间</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="r in apList" :key="r.id" class="row-click" :class="{ 'row-pend': r.status === 'pending' }" @click="openDetail(r.id)">
            <td>{{ r.id }}<span v-if="r.status === 'pending'" class="red-dot" title="待审批"></span></td>
            <td>{{ r.applicant_name }}</td>
            <td>{{ r.kind === '项目' ? '📁' : '🏆' }} {{ r.event_name }}</td>
            <td>{{ r.item_count }} 项</td>
            <td class="r money">¥{{ r.amount.toFixed(2) }}</td>
            <td><el-tag :type="statusType(r.status)" size="small" effect="light">{{ STATUS_ZH[r.status] }}</el-tag></td>
            <td class="dim">{{ fmtTime(r.submit_time) }}</td>
            <td><el-button link type="primary" size="small">查看/审批</el-button></td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty-wrap"><el-empty description="没有符合条件的申请" :image-size="80" /></div>

      <div class="rq-cards">
        <div v-for="r in apList" :key="r.id" class="rq-card" @click="openDetail(r.id)">
          <div class="rc-top">
            <b>#{{ r.id }} {{ r.applicant_name }}</b>
            <el-tag :type="statusType(r.status)" size="small">{{ STATUS_ZH[r.status] }}</el-tag>
          </div>
          <div class="rc-mid">{{ r.kind === '项目' ? '📁' : '🏆' }} {{ r.event_name }} · {{ r.item_count }} 项</div>
          <div class="rc-bot"><span class="money">¥{{ r.amount.toFixed(2) }}</span><span class="dim">{{ fmtTime(r.submit_time) }}</span></div>
        </div>
      </div>
    </div>

    <!-- ============ Tab 3：金额统计 ============ -->
    <div v-show="tab === 'stats'" v-if="isApprover">
      <div class="card">
        <div class="filter-bar">
          <el-select v-model="stFilter.event_id" placeholder="全部档案" clearable filterable style="width: 200px" @change="loadStats">
            <el-option v-for="e in approverEvents" :key="e.id" :value="e.id"
              :label="`${e.kind === '项目' ? '📁' : '🏆'} ${e.name}`" />
          </el-select>
          <el-date-picker v-model="stRange" type="daterange" range-separator="至" start-placeholder="起"
            end-placeholder="止" value-format="YYYY-MM-DD" @change="loadStats" />
          <span class="spacer"></span>
          <el-button @click="loadStats">刷新</el-button>
        </div>
        <div class="stat-cards compact">
          <div class="stat-card"><span class="sc-label">申请总数</span><b class="sc-num">{{ stats?.total ?? 0 }}</b><span class="sc-unit">份</span></div>
          <div class="stat-card ok"><span class="sc-label">已通过总额</span><b class="sc-num">¥{{ (stats?.total_amount ?? 0).toFixed(2) }}</b></div>
          <div class="stat-card danger"><span class="sc-label">待传发票</span>
            <b class="sc-num">{{ stats?.by_status?.approved?.count ?? 0 }}</b><span class="sc-unit">份</span></div>
          <div class="stat-card warn"><span class="sc-label">待审批</span>
            <b class="sc-num">{{ stats?.by_status?.pending?.count ?? 0 }}</b><span class="sc-unit">份 / ¥{{ (stats?.by_status?.pending?.amount ?? 0).toFixed(0) }}</span></div>
        </div>
        <div ref="chartRef" class="chart"></div>
      </div>

      <div class="card">
        <h3>按比赛 / 项目</h3>
        <table class="st-table">
          <thead><tr><th>档案</th><th>类型</th><th class="r">申请数</th><th class="r">已通过金额</th><th class="r">待审批金额</th><th class="r">已驳回金额</th><th class="r">待传发票</th></tr></thead>
          <tbody>
            <tr v-for="g in stats?.by_event || []" :key="g.event_id">
              <td>{{ g.name }}</td><td>{{ g.kind }}</td>
              <td class="r">{{ g.count }}</td>
              <td class="r money">¥{{ g.approved_amount.toFixed(2) }}</td>
              <td class="r dim">¥{{ g.pending_amount.toFixed(2) }}</td>
              <td class="r dim">¥{{ g.rejected_amount.toFixed(2) }}</td>
              <td class="r"><span v-if="g.invoice_pending" class="inv-warn">{{ g.invoice_pending }} 份</span><span v-else>—</span></td>
            </tr>
          </tbody>
        </table>
        <el-empty v-if="!stats?.by_event?.length" :image-size="70" description="暂无数据" />
      </div>

      <div class="card">
        <h3>按个人</h3>
        <table class="st-table">
          <thead><tr><th>申请人</th><th class="r">申请数</th><th class="r">已通过金额</th><th class="r">待传发票</th></tr></thead>
          <tbody>
            <tr v-for="u in stats?.by_user || []" :key="u.user_id">
              <td>{{ u.name }}</td><td class="r">{{ u.count }}</td>
              <td class="r money">¥{{ u.approved_amount.toFixed(2) }}</td>
              <td class="r"><span v-if="u.invoice_pending" class="inv-warn">{{ u.invoice_pending }} 份</span><span v-else>—</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ============ Tab 4：比赛/项目管理 ============ -->
    <div v-show="tab === 'events'">
      <div class="card">
        <div class="filter-bar">
          <h3>我管理的档案</h3>
          <span class="spacer"></span>
          <el-button type="primary" @click="openEventCreate">＋ 建立比赛/项目档案</el-button>
        </div>
        <p class="sub2">任何登录用户均可建档，建档后自动成为该档案负责人，可添加其他负责人与老师；没有采购申请的档案可以删除，已有申请挂接时需先删除全部申请。</p>

        <div v-for="ev in managedEvents" :key="ev.id" class="ev-card">
          <div class="ev-head">
            <b>{{ ev.kind === '项目' ? '📁' : '🏆' }} {{ ev.name }}</b>
            <el-tag size="small" :type="ev.status === 'open' ? 'success' : 'info'">{{ ev.status === 'open' ? '开放申请' : '已关闭' }}</el-tag>
            <el-tag size="small" :type="ev.myRole === 'teacher' ? 'warning' : 'primary'" effect="plain" class="ml">
              我是{{ ev.myRole === 'teacher' ? '老师' : '负责人' }}{{ auth.user?.is_admin && !ev.myRole ? '（管理员）' : '' }}
            </el-tag>
            <span class="spacer"></span>
            <el-button v-if="ev.canSettings" link size="small" @click="openEventEdit(ev)">设置</el-button>
            <el-switch v-if="ev.canSettings" :model-value="ev.status === 'open'" active-text="开放" inactive-text="关闭"
              inline-prompt @change="(v) => toggleStatus(ev, v)" />
            <el-button v-if="ev.canSettings" link size="small" type="danger" @click="removeEvent(ev)">删除</el-button>
          </div>
          <div v-if="ev.description" class="ev-desc">{{ ev.description }}</div>

            <div v-if="ev.canManage" class="ap-zone">
              <div class="ap-list">
                <span v-for="a in (approversMap[ev.id] || [])" :key="a.user_id" class="ap-chip">
                  <el-tag size="small" :type="a.role === 'teacher' ? 'warning' : 'primary'" effect="plain">
                    {{ a.role === 'teacher' ? '老师' : '负责人' }}
                  </el-tag>
                  {{ displayName(a) }}
                  <span v-if="a.is_creator" class="creator-mark" title="建档者">👑</span>
                  <el-dropdown trigger="click" @command="(role) => switchRole(ev, a, role)">
                    <span class="role-switch">切换▾</span>
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item command="leader" :disabled="a.role === 'leader'">设为负责人</el-dropdown-item>
                        <el-dropdown-item command="teacher" :disabled="a.role === 'teacher'">设为老师</el-dropdown-item>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                  <span class="ap-del" @click="removeApprover(ev, a)">✕</span>
                </span>
                <span v-if="!(approversMap[ev.id] || []).length" class="dim">加载中…</span>
              </div>
              <div class="ap-add">
                <el-select v-model="addUserIdMap[ev.id]" filterable remote :remote-method="(q) => searchUsers(ev.id, q)"
                  :loading="searchingMap[ev.id]" placeholder="搜索用户名/昵称" size="small" style="width: 190px">
                  <el-option v-for="u in (userOptsMap[ev.id] || [])" :key="u.id" :value="u.id"
                    :label="`${displayName(u)}（@${u.username}）`" />
                </el-select>
                <el-radio-group v-model="addRoleMap[ev.id]" size="small">
                  <el-radio-button value="leader">负责人</el-radio-button>
                  <el-radio-button value="teacher">老师</el-radio-button>
                </el-radio-group>
                <el-button size="small" type="primary" plain @click="addApprover(ev)">添加审批人</el-button>
              </div>
            </div>
          </div>
        <el-empty v-if="!managedEvents.length" :image-size="80">
          <template #description>
            你还没有管理任何档案。<br />任何人都可以建档（如某场比赛、某个备赛项目），建档后你自动成为该档案负责人
          </template>
          <el-button type="primary" @click="openEventCreate">＋ 建立第一个比赛/项目档案</el-button>
        </el-empty>
      </div>
    </div>

    <!-- 导出条 -->
    <div class="card export-bar">
      <b>📥 导出 Excel</b>
      <el-select v-model="exportFilter.event_id" placeholder="全部比赛/项目" clearable filterable size="small"
        style="width: 190px" :disabled="!isApprover">
        <el-option v-for="e in events" :key="e.id" :value="e.id"
          :label="`${e.kind === '项目' ? '📁' : '🏆'} ${e.name}`" />
      </el-select>
      <el-date-picker v-model="exportRange" type="daterange" range-separator="至" start-placeholder="起"
        end-placeholder="止" value-format="YYYY-MM-DD" size="small" />
      <el-switch v-if="isApprover" v-model="exportMine" active-text="只导出我的" inline-prompt size="small" />
      <span class="spacer"></span>
      <el-button type="primary" size="small" :loading="exporting" @click="doExport">
        {{ exporting ? '导出中…' : '导出筛选结果（4 个工作表）' }}
      </el-button>
    </div>

    <!-- 弹窗：新建/修改申请 -->
    <RequestFormDialog v-model="formOpen" :events="events" :detail="formDetail" @saved="onSaved" />
    <!-- 弹窗：详情/审批/发票 -->
    <RequestDetailDialog v-model="detailOpen" :request-id="detailId" @changed="refreshAfterChange" @edit="onEditDetail" />

    <!-- 弹窗：建档 -->
    <el-dialog v-model="eventCreateOpen" title="建立比赛/项目档案" width="520px" append-to-body destroy-on-close>
      <el-form label-position="top">
        <el-form-item label="名称" required>
          <el-input v-model="evForm.name" maxlength="40" show-word-limit placeholder="如：2026 中国机器人大赛" />
        </el-form-item>
        <el-form-item label="类型">
          <el-radio-group v-model="evForm.kind">
            <el-radio value="比赛">🏆 比赛</el-radio>
            <el-radio value="项目">📁 项目</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="说明（选填）">
          <el-input v-model="evForm.description" type="textarea" :rows="3" maxlength="500" show-word-limit
            placeholder="比赛/项目简介、采购规则等" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="eventCreateOpen = false">取消</el-button>
        <el-button type="primary" :loading="evSaving" @click="saveEvent(false)">建档</el-button>
      </template>
    </el-dialog>

    <!-- 弹窗：档案设置 -->
    <el-dialog v-model="eventEditOpen" title="档案设置" width="520px" append-to-body destroy-on-close>
      <el-form label-position="top" v-if="editingEv">
        <el-form-item label="名称" required>
          <el-input v-model="evForm.name" maxlength="40" show-word-limit />
        </el-form-item>
        <el-form-item label="类型">
          <el-radio-group v-model="evForm.kind">
            <el-radio value="比赛">🏆 比赛</el-radio>
            <el-radio value="项目">📁 项目</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="evForm.description" type="textarea" :rows="3" maxlength="500" show-word-limit />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="eventEditOpen = false">取消</el-button>
        <el-button type="primary" :loading="evSaving" @click="saveEvent(true)">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import * as echarts from 'echarts';
import auth from '../../auth.js';
import { api } from '../../api.js';
import { displayName } from '../../utils/displayName.js';
import AuthView from '../AuthView.vue';
import RequestFormDialog from './RequestFormDialog.vue';
import RequestDetailDialog from './RequestDetailDialog.vue';

const STATUS_ZH = { pending: '待审批', approved: '待传发票', invoiced: '已传发票', rejected: '已驳回' };
const statusType = (s) => ({ pending: 'warning', approved: 'danger', invoiced: 'success', rejected: 'info' }[s] || 'info');
const fmtTime = (t) => (t ? String(t).slice(5, 16) : '');

// ==================== 基础数据 ====================
const events = ref([]);
const isApprover = computed(() => !!auth.user?.is_admin || events.value.some((e) => e.canApprove));
const canManageAny = computed(() => events.value.some((e) => e.canManage));
const approverEvents = computed(() => events.value.filter((e) => e.canApprove));
const managedEvents = computed(() => events.value.filter((e) => e.canManage));

async function loadEvents() {
  const { events: list } = await api.purchaseEvents();
  events.value = list;
}

// ==================== 标签 ====================
const tab = ref('mine');
async function switchTab(t) {
  tab.value = t;
  await nextTick();
  if (t === 'approve' && !apLoaded.value) loadApprove();
  if (t === 'stats') { await loadStats(); }
  if (t === 'events') loadAllApprovers();
}

// ==================== 我的申请 ====================
const mineAll = ref([]);
const mineList = ref([]);
const mineFilter = reactive({ status: '' });
const mineRange = ref(null);

async function loadMineAll() {
  mineAll.value = (await api.purchaseRequests({ mine: 1, limit: 500 })).requests;
}
async function loadMine() {
  const params = { mine: 1 };
  if (mineFilter.status) params.status = mineFilter.status;
  if (mineRange.value?.length === 2) { params.from = mineRange.value[0]; params.to = mineRange.value[1]; }
  mineList.value = (await api.purchaseRequests(params)).requests;
}
const mineListAmount = computed(() => mineList.value.reduce((s, r) => s + r.amount, 0));
function sumBy(list) {
  const g = {
    pending: { count: 0, amount: 0 }, approved: { count: 0, amount: 0 },
    invoiced: { count: 0, amount: 0 }, rejected: { count: 0, amount: 0 },
  };
  for (const r of list) if (g[r.status]) { g[r.status].count++; g[r.status].amount += r.amount; }
  return g;
}
const mineByStatus = computed(() => sumBy(mineAll.value));
const mineApprovedAmount = computed(() =>
  mineAll.value.filter((r) => r.status === 'approved' || r.status === 'invoiced').reduce((s, r) => s + r.amount, 0));

// ==================== 审批工作台 ====================
const apList = ref([]);
const apLoaded = ref(false);
const apFilter = reactive({ event_id: null, status: '' });
const apRange = ref(null);
const pendingForMe = computed(() => apList.value.filter((r) => r.status === 'pending').length);

async function loadApprove() {
  const params = {};
  if (apFilter.event_id) params.event_id = apFilter.event_id;
  if (apFilter.status) params.status = apFilter.status;
  if (apRange.value?.length === 2) { params.from = apRange.value[0]; params.to = apRange.value[1]; }
  if (auth.user?.is_admin && !params.event_id) {
    // 管理员无所属档案：不带参即全部
  }
  apList.value = (await api.purchaseRequests(params)).requests
    .sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0) || b.id - a.id);
  apLoaded.value = true;
}

// ==================== 统计 + 图表 ====================
const stats = ref(null);
const stFilter = reactive({ event_id: null });
const stRange = ref(null);
const chartRef = ref(null);
let chart = null;

async function loadStats() {
  const params = {};
  if (stFilter.event_id) params.event_id = stFilter.event_id;
  if (stRange.value?.length === 2) { params.from = stRange.value[0]; params.to = stRange.value[1]; }
  stats.value = await api.purchaseStats(params);
  await nextTick();
  renderChart();
}
function renderChart() {
  if (!chartRef.value || !stats.value?.by_event?.length) return;
  if (!chart) chart = echarts.init(chartRef.value);
  const rows = stats.value.by_event;
  chart.setOption({
    title: { text: '各档案金额（元）', left: 0, textStyle: { fontSize: 13 } },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: { data: ['已通过', '待审批', '已驳回'], right: 0, textStyle: { fontSize: 11 } },
    grid: { left: 8, right: 10, top: 44, bottom: 4, containLabel: true },
    xAxis: { type: 'category', data: rows.map((r) => (r.name.length > 8 ? r.name.slice(0, 8) + '…' : r.name)),
      axisLabel: { interval: 0, rotate: rows.length > 4 ? 20 : 0, fontSize: 11 } },
    yAxis: { type: 'value' },
    series: [
      { name: '已通过', type: 'bar', data: rows.map((r) => r.approved_amount), itemStyle: { color: '#22c55e' } },
      { name: '待审批', type: 'bar', data: rows.map((r) => r.pending_amount), itemStyle: { color: '#f59e0b' } },
      { name: '已驳回', type: 'bar', data: rows.map((r) => r.rejected_amount), itemStyle: { color: '#94a3b8' } },
    ],
  }, true);
  chart.resize();
}
function onResize() { chart?.resize(); }

// ==================== 档案管理 ====================
const approversMap = reactive({}); // event_id → approvers[]
const userOptsMap = reactive({});
const addUserIdMap = reactive({});
const addRoleMap = reactive({});
const searchingMap = reactive({});

async function loadApprovers(ev) {
  try {
    const { approvers } = await api.purchaseApprovers(ev.id);
    approversMap[ev.id] = approvers;
  } catch (e) { ElMessage.error(e.message); }
}
async function loadAllApprovers() {
  for (const ev of managedEvents.value) {
    if (!approversMap[ev.id]) await loadApprovers(ev);
    if (addRoleMap[ev.id] === undefined) addRoleMap[ev.id] = 'leader';
  }
}
async function searchUsers(evId, q) {
  if (!q || !q.trim()) { userOptsMap[evId] = []; return; }
  searchingMap[evId] = true;
  try {
    const { users } = await api.purchaseUserSearch(q.trim(), evId);
    userOptsMap[evId] = users;
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    searchingMap[evId] = false;
  }
}
async function addApprover(ev) {
  const uid = addUserIdMap[ev.id];
  if (!uid) return ElMessage.warning('请先搜索并选择用户');
  try {
    const r = await api.purchaseApproverAdd(ev.id, uid, addRoleMap[ev.id] || 'leader');
    ElMessage.success(r.message || '已添加');
    addUserIdMap[ev.id] = null;
    userOptsMap[ev.id] = [];
    await loadApprovers(ev);
  } catch (e) { ElMessage.error(e.message); }
}
async function switchRole(ev, a, role) {
  try {
    const r = await api.purchaseApproverAdd(ev.id, a.user_id, role);
    ElMessage.success(r.message || '已切换身份');
    await loadApprovers(ev);
  } catch (e) { ElMessage.error(e.message); }
}
async function removeApprover(ev, a) {
  try {
    await ElMessageBox.confirm(`将 ${displayName(a)} 移出「${ev.name}」的审批人？`, '移除审批人', {
      confirmButtonText: '移除', cancelButtonText: '取消', type: 'warning',
    });
    await api.purchaseApproverRemove(ev.id, a.user_id);
    ElMessage.success('已移除');
    await loadApprovers(ev);
  } catch (e) {
    if (e !== 'cancel' && e?.message) ElMessage.error(e.message);
  }
}
async function toggleStatus(ev, open) {
  if (open) {
    try {
      await api.purchaseEventUpdate(ev.id, { status: 'open' });
      ElMessage.success('已重新开放申请');
    } catch (e) { ElMessage.error(e.message); }
  } else {
    try {
      await ElMessageBox.confirm(`关闭「${ev.name}」后将无法提交新申请（已有申请与审批不受影响），确定关闭？`, '关闭档案', {
        confirmButtonText: '关闭', cancelButtonText: '取消', type: 'warning',
      });
      await api.purchaseEventUpdate(ev.id, { status: 'closed' });
      ElMessage.success('已关闭');
    } catch (e) {
      if (e !== 'cancel' && e?.message) ElMessage.error(e.message);
      return;
    }
  }
  await loadEvents();
}

async function removeEvent(ev) {
  try {
    await ElMessageBox.confirm(
      `确定删除档案「${ev.name}」？档案下的审批人配置会一并删除，且不可恢复；若仍有采购申请将无法删除。`,
      '删除比赛/项目档案',
      { confirmButtonText: '确认删除', cancelButtonText: '取消', type: 'warning' },
    );
    await api.purchaseEventDelete(ev.id);
    ElMessage.success('档案已删除');
    await loadEvents();
    if (tab.value === 'events') await nextTick(loadAllApprovers);
  } catch (e) {
    if (e !== 'cancel' && e?.message) ElMessage.error(e.message);
  }
}

// ---- 建档 / 设置弹窗 ----
const eventCreateOpen = ref(false);
const eventEditOpen = ref(false);
const editingEv = ref(null);
const evSaving = ref(false);
const evForm = reactive({ name: '', kind: '比赛', description: '' });

function openEventCreate(auto = false) {
  evForm.name = ''; evForm.kind = '比赛'; evForm.description = '';
  editingEv.value = null;
  autoOpenFormAfterEvent.value = auto;
  eventCreateOpen.value = true;
}
function openEventEdit(ev) {
  editingEv.value = ev;
  evForm.name = ev.name; evForm.kind = ev.kind; evForm.description = ev.description;
  eventEditOpen.value = true;
}
async function saveEvent(isEdit) {
  if (!evForm.name.trim()) return ElMessage.warning('请填写名称');
  evSaving.value = true;
  try {
    if (isEdit) {
      await api.purchaseEventUpdate(editingEv.value.id, {
        name: evForm.name.trim(), kind: evForm.kind, description: evForm.description,
      });
      ElMessage.success('已保存');
      eventEditOpen.value = false;
    } else {
      const r = await api.purchaseEventCreate({
        name: evForm.name.trim(), kind: evForm.kind, description: evForm.description,
      });
      eventCreateOpen.value = false;
      if (autoOpenFormAfterEvent.value) {
        // 首次建档 → 直接接上申请单（档案列表按 id 倒序，新档案会被默认选中）
        await loadEvents();
        await nextTick();
        formDetail.value = null;
        formOpen.value = true;
        autoOpenFormAfterEvent.value = false;
        return;
      }
      ElMessage.success(r.message || '建档成功');
      tab.value = 'events';
    }
    await loadEvents();
    if (tab.value === 'events') await nextTick(loadAllApprovers);
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    evSaving.value = false;
  }
}

// ==================== 弹窗：申请 ====================
const formOpen = ref(false);
const formDetail = ref(null);
const detailOpen = ref(false);
const detailId = ref(null);

// 建档成功后自动接上新申请单（首次使用：无档案时点「新建采购申请」的链路）
const autoOpenFormAfterEvent = ref(false);
function openCreate() {
  if (!events.value.some((e) => e.status === 'open')) {
    ElMessage.info('请先建立比赛/项目档案（你会自动成为负责人），保存后即可继续填申请');
    openEventCreate(true);
    return;
  }
  formDetail.value = null;
  formOpen.value = true;
}
function openDetail(id) {
  detailId.value = id;
  detailOpen.value = true;
}
function onEditDetail(d) {
  // 详情 → 修改：关详情，开表单（带入完整明细）
  detailOpen.value = false;
  formDetail.value = d;
  formOpen.value = true;
}
async function onSaved() {
  await refreshAfterChange();
}
async function refreshAfterChange() {
  await Promise.all([
    loadEvents(),
    loadMineAll(),
    loadMine(),
    isApprover.value ? loadApprove().catch(() => {}) : null,
    tab.value === 'stats' ? loadStats().catch(() => {}) : null,
  ]);
}

// ==================== 导出 ====================
const exportFilter = reactive({ event_id: null });
const exportRange = ref(null);
const exportMine = ref(false);
const exporting = ref(false);

async function doExport() {
  const params = {};
  if (isApprover.value && !exportMine.value) {
    if (exportFilter.event_id) params.event_id = exportFilter.event_id;
  } else {
    params.mine = 1;
  }
  if (exportRange.value?.length === 2) { params.from = exportRange.value[0]; params.to = exportRange.value[1]; }
  exporting.value = true;
  try {
    const { blob, name } = await api.purchaseExportBlob(params);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    exporting.value = false;
  }
}

// ==================== 启动 ====================
onMounted(async () => {
  window.addEventListener('resize', onResize);
  try {
    await loadEvents();
  } catch (e) {
    ElMessage.error(e.message);
    return;
  }
  await Promise.all([
    loadMineAll(),
    loadMine(),
    isApprover.value ? loadApprove().catch(() => {}) : null,
  ]);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  chart?.dispose();
  chart = null;
});
watch(tab, (t) => { if (t !== 'stats') { chart?.dispose(); chart = null; chartRef.value = null; } });
</script>

<style scoped>
.pv-wrap { max-width: 1060px; margin: 0 auto; padding-bottom: 20px; }
.card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-bottom: 14px; }
h2 { margin: 0 0 6px; font-size: 20px; }
h3 { margin: 0; font-size: 15px; }
.sub2 { color: var(--text-2); font-size: 12.5px; margin: 4px 0 0; line-height: 1.6; }
.pv-hero { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }

/* 统计卡 */
.stat-cards { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 14px; }
.stat-cards.compact { grid-template-columns: repeat(4, 1fr); margin: 12px 0; }
.stat-card { background: var(--card-bg); border: 1px solid var(--border); border-left: 4px solid var(--border-2);
  border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.stat-card.ok { border-left-color: #22c55e; }
.stat-card.warn { border-left-color: #f59e0b; }
.stat-card.danger { border-left-color: #ef4444; }
.stat-card.primary { border-left-color: var(--primary); }
.sc-label { color: var(--text-2); font-size: 12px; }
.sc-num { font-size: 20px; color: var(--text); font-variant-numeric: tabular-nums; }
.sc-unit { color: var(--text-3); font-size: 11px; }

/* 标签条（同 ExpenseView 口径） */
.exp-tabbar { display: flex; gap: 6px; align-items: center; overflow-x: auto; padding: 2px 2px 8px;
  scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
.tabchip { flex: none; white-space: nowrap; font: inherit; border: 1px solid var(--border); background: var(--surface-2);
  color: var(--text-2); border-radius: 18px; padding: 5px 12px; font-size: 13px; cursor: pointer; transition: all .15s; }
.tabchip:hover { border-color: var(--primary); }
.tabchip.on { background: var(--primary-tint); border-color: var(--primary); color: var(--primary-dark); font-weight: 600; }
.tab-badge { display: inline-block; margin-left: 5px; background: #ef4444; color: #fff; font-size: 10px;
  border-radius: 9px; padding: 0 6px; line-height: 15px; font-weight: 700; }

.filter-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.spacer { flex: 1; }
.sum-hint { font-size: 12.5px; color: var(--text-2); }
.sum-hint b { color: var(--primary); }

/* 表格 */
.rq-table, .st-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.rq-table th, .rq-table td, .st-table th, .st-table td { border-bottom: 1px solid var(--border); padding: 8px 8px; text-align: left; }
.rq-table th, .st-table th { color: var(--text-2); font-weight: 600; font-size: 12.5px; background: var(--surface-1); }
.st-table td, .st-table th { border: 1px solid var(--border); }
.rq-table .r, .st-table .r { text-align: right; font-variant-numeric: tabular-nums; }
.money { color: var(--primary); font-weight: 600; }
.dim { color: var(--text-3); font-size: 12px; }
.rk-note { color: var(--text-3); font-size: 12px; margin-left: 4px; }
.row-click { cursor: pointer; }
.row-click:hover td { background: var(--surface-1); }
.row-pend td { background: color-mix(in srgb, #f59e0b 5%, transparent); }
.ev-tag { margin-right: 2px; }
.red-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #ef4444;
  margin-left: 6px; vertical-align: middle; }
.inv-warn { color: #ef4444; font-weight: 600; font-size: 12.5px; }
.empty-wrap { padding: 20px 0; }

/* 窄屏卡片 */
.rq-cards { display: none; }
.rq-card { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; cursor: pointer; }
.rc-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 14px; }
.rc-mid { color: var(--text-2); font-size: 12.5px; margin: 5px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rc-bot { display: flex; justify-content: space-between; font-size: 12.5px; }

/* 图表 */
.chart { width: 100%; height: 280px; margin-top: 10px; }

/* 档案卡 */
.ev-card { border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; margin-top: 12px;
  background: var(--surface-1); }
.ev-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ev-head b { font-size: 14.5px; }
.ml { margin-left: 2px; }
.ev-desc { color: var(--text-2); font-size: 12.5px; margin: 6px 0; line-height: 1.6; }
.ap-zone { margin-top: 8px; border-top: 1px dashed var(--border); padding-top: 10px; display: flex;
  flex-direction: column; gap: 8px; }
.ap-list { display: flex; flex-wrap: wrap; gap: 6px; }
.ap-chip { display: inline-flex; align-items: center; gap: 5px; background: var(--card-bg);
  border: 1px solid var(--border); border-radius: 16px; padding: 3px 8px 3px 6px; font-size: 12.5px; }
.creator-mark { font-size: 11px; }
.role-switch { color: var(--text-3); font-size: 11px; cursor: pointer; margin-left: 2px; }
.role-switch:hover { color: var(--primary); }
.ap-del { cursor: pointer; color: var(--danger); padding: 0 4px; border-radius: 6px; }
.ap-del:hover { background: var(--danger-tint); }
.ap-add { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

/* 导出条 */
.export-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.export-bar b { font-size: 14px; }

@media (max-width: 768px) {
  .pv-hero { flex-direction: column; }
  .stat-cards { grid-template-columns: repeat(2, 1fr); }
  .stat-cards.compact { grid-template-columns: repeat(2, 1fr); }
  .sc-num { font-size: 17px; }
  .rq-table, .st-table { display: none; }
  .rq-cards { display: block; }
  .chart { height: 240px; }
  .tabchip { font-size: 12px; padding: 4px 9px; }
}
</style>
