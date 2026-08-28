<script setup>
// 设备预约：设备台账 + 预约提交（冲突检测）+ 审批
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../../api.js';

const props = defineProps({ teamId: Number, me: Object, perms: Object, devices: Array });

const devices = ref(props.devices || []);
const bookings = ref([]);
const showNewDev = ref(false);
const newDev = ref({ name: '', spec: '' });
const showBook = ref(false);
const book = ref({ device_id: null, start_time: '', end_time: '', purpose: '' });

const STATUS = { pending: { label: '待审批', tag: 'warning' }, approved: { label: '已批准', tag: 'success' }, rejected: { label: '已拒绝/取消', tag: 'info' } };

const myBookings = computed(() => bookings.value.filter((b) => b.user_id === props.me.user_id));
const allBookings = computed(() => bookings.value);

async function reload() {
  devices.value = (await api.teamDetail(props.teamId)).devices;
  bookings.value = await api.teamBookings(props.teamId);
}

async function addDevice() {
  if (!newDev.value.name.trim()) return ElMessage.warning('设备名必填');
  try {
    await api.teamDeviceAdd(props.teamId, newDev.value);
    ElMessage.success('设备已添加');
    newDev.value = { name: '', spec: '' };
    showNewDev.value = false;
    await reload();
  } catch (e) { ElMessage.error(e.message); }
}

async function removeDevice(d) {
  try {
    await api.teamDeviceDelete(props.teamId, d.id);
    devices.value = devices.value.filter((x) => x.id !== d.id);
    ElMessage.success('设备已删除');
  } catch (e) { ElMessage.error(e.message); }
}

async function submitBooking() {
  const b = book.value;
  if (!b.device_id) return ElMessage.warning('请选择设备');
  if (!b.start_time || !b.end_time || b.start_time >= b.end_time) return ElMessage.warning('请选择正确的时间区间');
  try {
    await api.teamBooking(props.teamId, { ...b, device_id: b.device_id });
    ElMessage.success('预约已提交，等待审批');
    showBook.value = false;
    book.value = { device_id: null, start_time: '', end_time: '', purpose: '' };
    await reload();
  } catch (e) { ElMessage.error(e.message); }
}

async function approve(b, status) {
  try {
    await api.teamBookingApprove(props.teamId, b.id, status);
    ElMessage.success(status === 'approved' ? '已批准' : '已驳回');
    await reload();
  } catch (e) { ElMessage.error(e.message); }
}

onMounted(() => reload().catch((e) => ElMessage.error(e.message)));
</script>

<template>
  <div class="tdv">
    <!-- 设备台账 -->
    <div class="tdv-tools">
      <b>🔧 设备台账（{{ devices.length }}）</b>
      <div style="display:flex; gap:8px">
        <el-button size="small" @click="showBook = true">🗓 预约设备</el-button>
        <el-button v-if="perms.device" size="small" type="primary" plain @click="showNewDev = !showNewDev">
          {{ showNewDev ? '收起' : '＋ 添加设备' }}
        </el-button>
      </div>
    </div>

    <div v-if="showNewDev" class="dev-new">
      <el-input v-model="newDev.name" placeholder="设备名（如 STM32F407 开发板）" style="flex:1.5" />
      <el-input v-model="newDev.spec" placeholder="规格/数量（如 x2）" style="flex:1" />
      <el-button type="primary" @click="addDevice">添加</el-button>
    </div>

    <div v-if="!devices.length" class="tdv-empty">暂无设备 — 有「设备管理」权限的成员可添加</div>
    <div v-for="d in devices" :key="d.id" class="dev-row">
      <span class="d-icon">🔧</span>
      <div class="d-info">
        <b>{{ d.name }}</b>
        <span v-if="d.spec" class="d-spec">{{ d.spec }}</span>
      </div>
      <el-tag v-if="d.in_use" size="small" type="danger">使用中</el-tag>
      <el-tag v-else size="small" type="success">空闲</el-tag>
      <el-button v-if="perms.device" size="small" text type="danger" @click="removeDevice(d)">删</el-button>
    </div>

    <!-- 预约弹窗 -->
    <el-dialog :model-value="showBook" title="预约设备" width="440px" @update:model-value="(v) => (showBook = v)">
      <el-form label-position="top">
        <el-form-item label="设备">
          <el-select v-model="book.device_id" style="width:100%" placeholder="选择要预约的设备">
            <el-option v-for="d in devices" :key="d.id" :value="d.id" :label="`${d.name}${d.spec ? '（' + d.spec + '）' : ''}`" />
          </el-select>
        </el-form-item>
        <div style="display:flex; gap:10px">
          <el-form-item label="开始时间" style="flex:1">
            <el-date-picker v-model="book.start_time" type="datetime" value-format="YYYY-MM-DD HH:mm" placeholder="开始" style="width:100%" />
          </el-form-item>
          <el-form-item label="结束时间" style="flex:1">
            <el-date-picker v-model="book.end_time" type="datetime" value-format="YYYY-MM-DD HH:mm" placeholder="结束" style="width:100%" />
          </el-form-item>
        </div>
        <el-form-item label="用途">
          <el-input v-model="book.purpose" placeholder="如：电机驱动调试" />
        </el-form-item>
        <el-button type="primary" @click="submitBooking">提交预约（等待审批）</el-button>
      </el-form>
    </el-dialog>

    <!-- 预约列表：我的 + 全部 -->
    <div class="tdv-bookings">
      <h4>🗓 我的预约</h4>
      <div v-if="!myBookings.length" class="tdv-empty">暂无预约</div>
      <div v-for="b in myBookings" :key="b.id" class="bk-row">
        <b>{{ b.device_name }}</b>
        <span class="bk-time">{{ b.start_time }} ~ {{ b.end_time }}</span>
        <el-tag size="small" :type="STATUS[b.status].tag">{{ STATUS[b.status].label }}</el-tag>
        <span v-if="b.purpose" class="bk-purpose">{{ b.purpose }}</span>
        <el-button v-if="b.status === 'pending'" size="small" text type="danger"
          @click="approve(b, 'rejected')">取消</el-button>
      </div>

      <template v-if="perms.device_approve">
        <h4 class="bk-all-title">🛂 全部预约（审批）</h4>
        <div v-for="b in allBookings" :key="'a' + b.id" class="bk-row">
          <b>{{ b.device_name }}</b>
          <span class="bk-time">{{ b.start_time }} ~ {{ b.end_time }}</span>
          <el-tag size="small" :type="STATUS[b.status].tag">{{ STATUS[b.status].label }}</el-tag>
          <span class="bk-who">{{ b.user_name }} · {{ b.purpose }}</span>
          <template v-if="b.status === 'pending'">
            <el-button size="small" type="success" plain @click="approve(b, 'approved')">批准</el-button>
            <el-button size="small" type="danger" plain @click="approve(b, 'rejected')">驳回</el-button>
          </template>
        </div>
      </template>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.tdv-tools { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.tdv-empty { color: #94a3b8; font-size: 13px; padding: 12px 0; }
.dev-new { display: flex; gap: 8px; background: var(--surface-3); border: 1px dashed var(--border); border-radius: 10px; padding: 10px; margin-bottom: 10px; }
.dev-row {
  display: flex; align-items: center; gap: 10px; border: 1px solid var(--border); border-radius: 10px;
  padding: 8px 12px; margin-bottom: 8px;
  .d-icon { font-size: 18px; }
  .d-info { flex: 1; b { font-size: 13.5px; } .d-spec { margin-left: 8px; color: var(--text-2); font-size: 12px; } }
}
.tdv-bookings { margin-top: 18px;
  h4 { margin: 0 0 10px; font-size: 14px; }
  .bk-all-title { margin-top: 18px; }
  .bk-row {
    display: flex; align-items: center; gap: 10px; border: 1px solid var(--border); border-radius: 10px;
    padding: 8px 12px; margin-bottom: 8px; flex-wrap: wrap; font-size: 13px;
    .bk-time { color: var(--text-2); font-size: 12.5px; }
    .bk-purpose, .bk-who { color: var(--text-2); font-size: 12.5px; }
  }
}
</style>
