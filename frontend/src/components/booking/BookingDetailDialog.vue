<template>
  <el-dialog model-value @close="emit('close')" :title="isReg ? `借用登记 #${id}` : `预约 #${id}`" width="560px" append-to-body destroy-on-close>
    <div v-loading="loading">
      <template v-if="data">
        <div class="bd-head">
          <el-tag :type="STATUS_META[b.status]?.type || 'info'" size="large">{{ STATUS_META[b.status]?.label || b.status }}</el-tag>
          <el-tag v-if="isReg" :type="b.item_kind === 'room' ? 'warning' : 'success'" size="small" effect="plain">
            {{ REG_KIND_META[b.item_kind]?.icon }} {{ REG_KIND_META[b.item_kind]?.label }}
          </el-tag>
          <template v-else>
            <el-tag v-if="b.approve_mode === 'first_come'" type="success" size="small" effect="plain">先到先得</el-tag>
            <el-tag v-else type="warning" size="small" effect="plain">需审批</el-tag>
          </template>
        </div>

        <dl v-if="!isReg" class="bd-dl">
          <div><dt>项目</dt><dd>{{ b.project_name }}</dd></div>
          <div><dt>资源</dt><dd>{{ KIND_MAP[b.kind]?.icon || '📦' }} {{ b.resource_name }}<span v-if="b.is_space">（空间）</span></dd></div>
          <div><dt>时间</dt><dd>{{ b.start_time }} <b>～</b> {{ b.end_time }}<span class="bd-dur">（{{ durationLabel(b.start_time, b.end_time) }}）</span></dd></div>
          <div><dt>{{ b.is_space ? '人数' : '借用数量' }}</dt>
            <dd>{{ b.is_space ? `👥 ${b.headcount} 人` : `×${b.qty} ${b.unit || '件'}` }}</dd></div>
          <div><dt>预约人</dt><dd>{{ b.booker_name }}<span class="bd-src">{{ SRC_ZH[b.source] || '' }}</span></dd></div>
          <div v-if="b.purpose"><dt>用途</dt><dd>{{ b.purpose }}</dd></div>
          <div v-if="b.status === 'rejected' && b.reject_reason"><dt>驳回理由</dt><dd class="bd-reject">{{ b.reject_reason }}</dd></div>
          <div v-if="b.approver_name"><dt>审批</dt><dd>{{ b.approver_name }} · {{ b.approve_time }}</dd></div>
          <div v-if="b.status === 'canceled' && b.cancel_by_name"><dt>取消人</dt>
            <dd>{{ b.cancel_by_name }} · {{ b.cancel_time }}</dd></div>
        </dl>

        <!-- 借用登记：拍照快速记录，无时段/库存概念 -->
        <dl v-else class="bd-dl">
          <div><dt>所属项目</dt><dd>{{ b.project_name }}</dd></div>
          <div><dt>类型</dt><dd>{{ REG_KIND_META[b.item_kind]?.icon }} {{ b.item_kind === 'room' ? '教室借用' : '设备借用' }}</dd></div>
          <div><dt>{{ b.item_kind === 'room' ? '教室编号' : '物品名称' }}</dt><dd><b>{{ b.item_name }}</b></dd></div>
          <div><dt>登记时间</dt><dd>{{ b.start_time }}</dd></div>
          <div><dt>登记人</dt><dd>{{ b.booker_name }}<span v-if="b.booker_student_no" class="bd-src">学号 {{ b.booker_student_no }}</span></dd></div>
          <div v-if="b.purpose"><dt>备注</dt><dd>{{ b.purpose }}</dd></div>
          <div v-if="b.status === 'canceled' && b.cancel_by_name"><dt>取消人</dt>
            <dd>{{ b.cancel_by_name }} · {{ b.cancel_time }}</dd></div>
        </dl>
        <img v-if="isReg && b.item_image" :src="b.item_image" class="bd-photo" alt="借用照片"
          @click="openImage(b.item_image, b.item_name || '借用照片')" />

        <!-- 参与人头像组 -->
        <div v-if="!isReg" class="bd-people">
          <span class="bp-label">参与人（{{ b.participants?.length || 0 }}）</span>
          <div class="bp-list">
            <span v-for="p in b.participants" :key="p.user_id" class="bp-person">
              <el-avatar :size="24" :src="p.avatar || undefined">{{ (p.user_name || '?').charAt(0) }}</el-avatar>
              <span>{{ p.user_name }}<i v-if="p.is_booker" class="bp-booker">预约</i></span>
            </span>
          </div>
        </div>

        <!-- 轨迹 -->
        <el-timeline class="bd-log">
          <el-timeline-item v-for="l in logs" :key="l.id" :type="LOG_META[l.action]?.type || 'info'"
            :timestamp="l.create_time" placement="top">
            {{ LOG_META[l.action]?.label || l.action }} · {{ l.actor_name }}<span v-if="l.comment">：{{ l.comment }}</span>
          </el-timeline-item>
        </el-timeline>
      </template>
    </div>

    <template #footer>
      <template v-if="data">
        <el-button v-if="perm.canApprove && !isReg" type="success" :loading="acting" @click="doApprove">✅ 通过</el-button>
        <el-button v-if="perm.canReject && !isReg" type="danger" plain :loading="acting" @click="doReject">❌ 驳回</el-button>
        <el-button v-if="perm.canCancel" type="warning" plain :loading="acting" @click="doCancel">
          🚫 {{ isReg ? '取消登记' : '取消预约' }}
        </el-button>
        <el-button @click="emit('close')">关闭</el-button>
      </template>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../../api.js';
import { STATUS_META, KIND_MAP, REG_KIND_META, isRegBooking, durationLabel } from '../../utils/booking.js';
import { openImage } from '../../utils/imageViewer.js';

const props = defineProps({ id: { type: [Number, String], required: true } });
const emit = defineEmits(['close', 'changed']);

const data = ref(null);
const loading = ref(false);
const acting = ref(false);
const b = computed(() => data.value?.booking);
const logs = computed(() => data.value?.logs || []);
const perm = computed(() => b.value?.perm || {});
const isReg = computed(() => isRegBooking(b.value));

const SRC_ZH = { solo: '（单人）', team: '（固定组队）', custom: '（临时组队）' };
const LOG_META = {
  created: { label: '提交预约', type: 'primary' },
  approved: { label: '审批通过', type: 'success' },
  rejected: { label: '驳回', type: 'danger' },
  canceled: { label: '取消预约', type: 'info' },
};

async function load() {
  loading.value = true;
  try {
    data.value = await api.bookingDetail(props.id);
  } catch (e) {
    ElMessage.error(e.message);
    emit('close');
  } finally {
    loading.value = false;
  }
}
async function doApprove() {
  try {
    await ElMessageBox.confirm('确认通过该预约？通过后时段正式占用。', '审批通过', { type: 'success' });
  } catch { return; }
  acting.value = true;
  try {
    await api.bookingApprove(b.value.id);
    ElMessage.success('已通过');
    await load();
    emit('changed');
  } catch (e) { ElMessage.error(e.message); } finally { acting.value = false; }
}
async function doReject() {
  let reason = '';
  try {
    const r = await ElMessageBox.prompt('请填写驳回理由（将通知预约人）', '驳回预约', {
      confirmButtonText: '确认驳回', cancelButtonText: '取消', inputType: 'textarea',
      inputValidator: (v) => (v && v.trim() ? true : '驳回必须填写理由'),
    });
    reason = r.value;
  } catch { return; }
  acting.value = true;
  try {
    await api.bookingReject(b.value.id, reason.trim());
    ElMessage.success('已驳回');
    await load();
    emit('changed');
  } catch (e) { ElMessage.error(e.message); } finally { acting.value = false; }
}
async function doCancel() {
  try {
    await ElMessageBox.confirm(
      isReg.value ? '确认取消这条借用登记？' : '确认取消该预约？取消后时段立即释放。',
      isReg.value ? '取消登记' : '取消预约', { type: 'warning' });
  } catch { return; }
  acting.value = true;
  try {
    await api.bookingCancel(b.value.id);
    ElMessage.success(isReg.value ? '登记已取消' : '预约已取消');
    await load();
    emit('changed');
  } catch (e) { ElMessage.error(e.message); } finally { acting.value = false; }
}
onMounted(load);
defineExpose({ reload: load });
</script>

<style lang="scss" scoped>
.bd-head { display: flex; gap: 8px; margin-bottom: 14px; }
.bd-dl {
  margin: 0; display: flex; flex-direction: column; gap: 8px;
  div { display: flex; gap: 12px; font-size: 13.5px; }
  dt { width: 64px; flex: none; color: var(--text-3); }
  dd { margin: 0; color: var(--text); }
}
.bd-dur { color: var(--text-3); font-size: 12.5px; }
.bd-src { color: var(--text-3); margin-left: 6px; font-size: 12px; }
.bd-reject { color: #b91c1c; }
.bd-people { margin-top: 14px; }
.bp-label { font-size: 12.5px; color: var(--text-3); }
.bp-list { display: flex; flex-wrap: wrap; gap: 10px 14px; margin-top: 8px; }
.bp-person { display: inline-flex; align-items: center; gap: 5px; font-size: 13px;
  :deep(.el-avatar) { background: var(--primary); font-size: 12px; }
}
.bp-booker { font-style: normal; font-size: 11px; color: var(--primary); border: 1px solid var(--primary);
  border-radius: 999px; padding: 0 6px; margin-left: 2px; }
.bd-log { margin-top: 16px; padding-left: 4px; }
.bd-photo {
  display: block; margin-top: 12px; width: 100%; max-height: 320px; object-fit: contain;
  border-radius: 10px; border: 1px solid var(--border); cursor: zoom-in; background: var(--surface-2);
}
</style>
