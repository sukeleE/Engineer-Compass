<template>
  <AuthView v-if="!auth.token" />
  <div v-else class="pv-wrap bk-wrap">
    <!-- 页头 -->
    <div class="pv-hero card">
      <div>
        <h2>🏢 资源预约</h2>
        <p class="sub2">按项目管理空间与物品两类资源：空间资源独占、按容量限人数，物品资源按库存数量共享；拖选时段即可预约，支持固定组队与临时多人，预约时长与人员在周视图上一目了然。</p>
      </div>
      <el-button type="primary" @click="openCreate">＋ 创建预约项目</el-button>
    </div>

    <!-- 顶部统计卡 -->
    <div class="stat-cards">
      <div class="stat-card">
        <span class="sc-label">我的预约</span>
        <b class="sc-num">{{ mineActive }}</b><span class="sc-unit">个进行中</span>
      </div>
      <div class="stat-card warn">
        <span class="sc-label">待我审批</span>
        <b class="sc-num">{{ managedPending }}</b><span class="sc-unit">个待批</span>
      </div>
      <div class="stat-card ok">
        <span class="sc-label">我参与的</span>
        <b class="sc-num">{{ mineInvolved }}</b><span class="sc-unit">个预约</span>
      </div>
      <div class="stat-card primary">
        <span class="sc-label">我管理的项目</span>
        <b class="sc-num">{{ managed.length }}</b><span class="sc-unit">个</span>
      </div>
    </div>

    <div class="exp-tabbar">
      <button class="tabchip" :class="{ on: tab === 'all' }" @click="switchTab('all')">📅 全部项目</button>
      <button class="tabchip" :class="{ on: tab === 'mine' }" @click="switchTab('mine')">📋 我的预约</button>
      <button class="tabchip" :class="{ on: tab === 'managed' }" @click="switchTab('managed')">🛠 我管理的</button>
    </div>

    <!-- ============ 项目大厅 ============ -->
    <div v-show="tab === 'all' || tab === 'managed'" class="bk-grid">
      <article v-for="p in shownProjects" :key="p.id" class="bk-proj card" @click="enter(p.id)">
        <div class="bp-head">
          <h3>📁 {{ p.name }}</h3>
          <el-tag v-if="p.status === 'closed'" type="info" size="small">已关闭</el-tag>
          <el-tag v-else type="success" size="small" effect="light">开放中</el-tag>
        </div>
        <p class="bp-desc">{{ p.description || '暂无项目说明' }}</p>
        <div class="bp-foot">
          <span class="bp-stat">📦 {{ p.resource_count }} 项资源</span>
          <span v-if="p.canManage && p.pending_count" class="bp-stat warn">⏳ {{ p.pending_count }} 待审批</span>
          <span v-if="p.my_booking_count" class="bp-stat">🙋 我有 {{ p.my_booking_count }} 个预约</span>
          <span class="bp-go">进入 →</span>
        </div>
      </article>
      <div v-if="!shownProjects.length" class="empty-wrap"><el-empty :description="tab === 'managed' ? '你还没有管理任何项目' : '还没有预约项目，点右上角创建第一个'" :image-size="90" /></div>
    </div>

    <!-- ============ 我的预约 ============ -->
    <div v-show="tab === 'mine'" class="card">
      <div class="filter-bar">
        <el-select v-model="mineStatus" placeholder="全部状态" clearable style="width: 130px" @change="loadMine">
          <el-option v-for="(m, k) in STATUS_META" :key="k" :value="k" :label="m.label" />
        </el-select>
        <span class="spacer"></span>
        <el-button @click="loadAll">刷新</el-button>
      </div>
      <table v-if="mineList.length" class="rq-table">
        <thead>
          <tr><th>项目</th><th>资源</th><th>时段</th><th>人/量</th><th>状态</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="b in mineList" :key="b.id" class="row-click" @click="openDetail(b.id)">
            <td>{{ b.project_name }}</td>
            <td>
              <span v-if="isRegBooking(b)">{{ REG_KIND_META[b.item_kind]?.icon }} {{ b.item_name }}</span>
              <span v-else>{{ b.resource_name }}</span>
            </td>
            <td class="dim">
              <template v-if="isRegBooking(b)">登记于 {{ b.start_time }}</template>
              <template v-else>{{ b.start_time }}<br />～ {{ b.end_time }}</template>
            </td>
            <td>{{ isRegBooking(b) ? '—' : (b.is_space ? `👥 ${b.headcount} 人` : `×${b.qty} ${b.unit || '件'}`) }}</td>
            <td><el-tag :type="STATUS_META[b.status]?.type || 'info'" size="small">{{ STATUS_META[b.status]?.label || b.status }}</el-tag></td>
            <td><el-button link type="primary" size="small">查看</el-button></td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty-wrap"><el-empty description="还没有预约记录" :image-size="80" /></div>

      <div class="rq-cards">
        <div v-for="b in mineList" :key="b.id" class="rq-card" @click="openDetail(b.id)">
          <div class="rc-top">
            <b>{{ isRegBooking(b) ? `${REG_KIND_META[b.item_kind]?.icon} ${b.item_name}` : b.resource_name }}</b>
            <el-tag :type="STATUS_META[b.status]?.type || 'info'" size="small">{{ STATUS_META[b.status]?.label || b.status }}</el-tag>
          </div>
          <div class="rc-mid">{{ b.project_name }} · {{ isRegBooking(b) ? REG_KIND_META[b.item_kind]?.label : (b.is_space ? `${b.headcount} 人` : `×${b.qty}${b.unit || '件'}`) }}</div>
          <div class="rc-bot"><span class="dim">{{ isRegBooking(b) ? `登记于 ${b.start_time}` : `${b.start_time} ~ ${b.end_time}` }}</span></div>
        </div>
      </div>
    </div>

    <!-- 创建项目 -->
    <el-dialog v-model="createOpen" title="创建预约项目" width="520px" append-to-body destroy-on-close>
      <el-form label-position="top">
        <el-form-item label="项目名称" required>
          <el-input v-model="form.name" maxlength="40" show-word-limit placeholder="如：2026 机械创新设计大赛备赛" />
        </el-form-item>
        <el-form-item label="项目说明">
          <el-input v-model="form.description" type="textarea" :rows="3" maxlength="500" show-word-limit
            placeholder="可预约的资源范围、使用规范、负责人联系方式等" />
        </el-form-item>
        <el-form-item label="新资源的默认审批方式（每个资源仍可单独改）">
          <el-radio-group v-model="form.default_approve_mode">
            <el-radio value="approval">需审批：提交后负责人审批，通过才生效</el-radio>
            <el-radio value="first_come">先到先得：不冲突即自动确认</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createOpen = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitCreate">创建并进入</el-button>
      </template>
    </el-dialog>

    <BookingDetailDialog v-if="detailId" :id="detailId" @close="detailId = null" @changed="loadAll" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import auth from '../../auth.js';
import { api } from '../../api.js';
import AuthView from '../AuthView.vue';
import BookingDetailDialog from './BookingDetailDialog.vue';
import { STATUS_META, REG_KIND_META, isRegBooking } from '../../utils/booking.js';

const router = useRouter();
const tab = ref('all');
const projects = ref([]);
const managed = ref([]);
const mineList = ref([]);
const mineStatus = ref('');
const createOpen = ref(false);
const saving = ref(false);
const detailId = ref(null);
const form = ref({ name: '', description: '', default_approve_mode: 'approval' });

const shownProjects = computed(() => (tab.value === 'managed' ? managed.value : projects.value));
const mineActive = computed(() => mineList.value.filter((b) => b.status === 'pending' || b.status === 'confirmed').length);
const mineInvolved = computed(() => mineList.value.length);
const managedPending = computed(() => managed.value.reduce((s, p) => s + (p.pending_count || 0), 0));

async function loadAll() {
  const [all, man, mine] = await Promise.all([
    api.bookingProjects('all'),
    api.bookingProjects('managed'),
    api.bookingMine(mineStatus.value || undefined),
  ]);
  projects.value = all.projects;
  managed.value = man.projects;
  mineList.value = mine.bookings;
}
async function loadMine() {
  mineList.value = (await api.bookingMine(mineStatus.value || undefined)).bookings;
}
function switchTab(t) {
  tab.value = t;
}
function enter(id) {
  router.push(`/booking/${id}`);
}
function openCreate() {
  form.value = { name: '', description: '', default_approve_mode: 'approval' };
  createOpen.value = true;
}
async function submitCreate() {
  if (!form.value.name.trim()) return ElMessage.warning('请填写项目名称');
  saving.value = true;
  try {
    const { project } = await api.bookingProjectCreate(form.value);
    ElMessage.success('项目已创建');
    createOpen.value = false;
    router.push(`/booking/${project.id}`);
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    saving.value = false;
  }
}
function openDetail(id) {
  detailId.value = id;
}
onMounted(() => { if (auth.token) loadAll(); });
</script>

<style lang="scss" scoped>
.bk-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;
}
.bk-proj {
  padding: 18px 20px;
  margin-bottom: 0; // grid 间距走 gap，抵消全局 .card 的 margin-bottom
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition: border-color .15s, transform .15s;
  &:hover { border-color: var(--primary); transform: translateY(-2px); }
}
.bp-head { display: flex; align-items: center; justify-content: space-between; gap: 10px;
  h3 { margin: 0; font-size: 16.5px; }
}
.bp-desc {
  margin: 0; min-height: 42px; font-size: 13px; line-height: 1.65; color: var(--text-2);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.bp-foot { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; font-size: 12.5px; color: var(--text-3); }
.bp-stat { display: inline-flex; align-items: center; gap: 3px;
  &.warn { color: #b45309; font-weight: 600; }
}
.bp-go { margin-left: auto; color: var(--primary); font-weight: 600; }
@media (max-width: 768px) {
  .rq-table { display: none; }   // 我的预约：窄屏改卡片
  .rq-cards { display: block; }
}
@media (max-width: 640px) {
  .bk-grid { grid-template-columns: 1fr; }
}
</style>
