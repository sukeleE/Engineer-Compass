<template>
  <el-dialog :model-value="true" @close="emit('close')" title="预约资源" width="560px" append-to-body destroy-on-close>
    <el-form label-position="top" v-loading="loading">
      <!-- 时段 -->
      <el-form-item label="预约时段">
        <template v-if="initial && !manualTime">
          <div class="bd-slot">
            <b>{{ initial.start_time }}</b> <span>～</span> <b>{{ initial.end_time }}</b>
            <el-tag size="small" type="info">{{ durationLabel(initial.start_time, initial.end_time) }}</el-tag>
            <el-button link type="primary" size="small" @click="manualTime = true">改用表单选时间</el-button>
          </div>
        </template>
        <template v-else>
          <div class="bd-time">
            <el-date-picker v-model="f.d1" type="date" value-format="YYYY-MM-DD" :disabled-date="pastDate" size="default" placeholder="开始日期" />
            <el-select v-model="f.t1" style="width: 96px" placeholder="开始">
              <el-option v-for="t in startOpts" :key="t" :value="t" :label="t" />
            </el-select>
            <span class="bd-sep">至</span>
            <el-date-picker v-model="f.d2" type="date" value-format="YYYY-MM-DD" :disabled-date="pastDate" size="default" placeholder="结束日期" />
            <el-select v-model="f.t2" style="width: 96px" placeholder="结束">
              <el-option v-for="t in endOpts" :key="t" :value="t" :label="t" />
            </el-select>
          </div>
          <p class="bd-rule dim">每天开放 07:00–22:00；30 分钟一格；支持跨天连续预约（最长 7 天）</p>
        </template>
      </el-form-item>

      <!-- 资源 -->
      <el-form-item label="选择资源" required>
        <el-select v-model="f.resource_id" style="width: 100%" placeholder="选择要预约的资源">
          <el-option-group label="🏢 空间资源（同时段独占）">
            <el-option v-for="r in spaceResources" :key="r.id" :value="r.id"
              :label="`${r.name}（容量 ${r.capacity} 人 · ${MODE_ZH[r.approve_mode]}${r.location ? ' · ' + r.location : ''}）`" />
          </el-option-group>
          <el-option-group label="📦 物品资源（按库存共享）">
            <el-option v-for="r in itemResources" :key="r.id" :value="r.id"
              :label="`${r.name}（库存 ${r.quantity} ${r.unit || '件'} · ${MODE_ZH[r.approve_mode]}）`" />
          </el-option-group>
        </el-select>
      </el-form-item>

      <el-form-item v-if="resource && resource.is_space" label="参与人数（含本人）">
        <el-tag size="large" :type="headcount > resource.capacity ? 'danger' : 'info'">
          👥 {{ headcount }} / {{ resource.capacity }} 人
        </el-tag>
        <span v-if="headcount > resource.capacity" class="bd-err">超过容量，请减少参与人</span>
      </el-form-item>
      <el-form-item v-else-if="resource" label="借用数量">
        <el-input-number v-model="f.qty" :min="1" :max="resource.quantity" />
        <span class="dim">库存 {{ resource.quantity }} {{ resource.unit || '件' }}</span>
      </el-form-item>

      <!-- 人员 -->
      <el-form-item label="参与方式">
        <el-radio-group v-model="f.source">
          <el-radio value="solo">单人</el-radio>
          <el-radio value="multi">多人</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item v-if="f.source === 'multi'" label="多人方式">
        <el-radio-group v-model="f.multiKind">
          <el-radio value="team">固定组队</el-radio>
          <el-radio value="custom">临时选人</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item v-if="f.source === 'multi' && f.multiKind === 'team'" label="选择我创建的组队">
        <el-select v-model="f.team_id" style="width: 100%" placeholder="仅可选择自己担任队长的组队">
          <el-option v-for="t in myTeams" :key="t.id" :value="t.id"
            :label="`👥 ${t.name}（${t.members.length} 名队员）`" />
        </el-select>
        <div v-if="selectedTeam" class="bd-chips">
          <el-tag size="small" type="success">{{ displayName(auth.user) }}（队长）</el-tag>
          <el-tag v-for="m in selectedTeam.members" :key="m.user_id" size="small">{{ displayName(m) }}</el-tag>
        </div>
      </el-form-item>
      <el-form-item v-if="f.source === 'multi' && f.multiKind === 'custom'" label="临时选择参与人（全站搜索）">
        <el-select v-model="f.participant_ids" multiple filterable remote :remote-method="searchUser"
          :loading="searching" :reserve-keyword="false" style="width: 100%" placeholder="搜索用户名或昵称添加">
          <el-option v-for="u in userOptions" :key="u.id" :value="u.id"
            :label="`${displayName(u)}（@${u.username}）`" />
        </el-select>
        <div class="bd-chips">
          <el-tag size="small" type="success" closable>{{ displayName(auth.user) }}（我，自动计入）</el-tag>
        </div>
      </el-form-item>

      <el-form-item label="用途（可选）">
        <el-input v-model="f.purpose" type="textarea" :rows="2" maxlength="200" show-word-limit
          placeholder="做什么用、预计安排等（≤200 字）" />
      </el-form-item>

      <el-alert v-if="checkError" :title="checkError" type="error" :closable="false" show-icon style="margin-bottom: 10px" />
      <el-alert v-else-if="checkOk" title="该时段可预约" type="success" :closable="false" show-icon style="margin-bottom: 10px" />
    </el-form>

    <template #footer>
      <el-button @click="emit('close')">取消</el-button>
      <el-button type="primary" :loading="submitting" :disabled="!canSubmit" @click="submit">提交预约</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import auth from '../../auth.js';
import { api } from '../../api.js';
import { displayName } from '../../utils/displayName.js';
import { MODE_ZH, timeOptions, fmtDate, durationLabel } from '../../utils/booking.js';

const props = defineProps({
  project: { type: Object, required: true },
  resources: { type: Array, default: () => [] },
  initial: { type: Object, default: null }, // {resource_id, start_time, end_time}
});
const emit = defineEmits(['close', 'saved']);

const loading = ref(false);
const submitting = ref(false);
const searching = ref(false);
const manualTime = ref(!!props.initial?.manual);
const checkError = ref('');
const checkOk = ref(false);
const myTeams = ref([]);
const userOptions = ref([]);

const today = new Date();
const f = ref({
  resource_id: props.initial?.resource_id || null,
  d1: props.initial?.start_time?.slice(0, 10) || fmtDate(today),
  t1: props.initial?.start_time?.slice(11) || '09:00',
  d2: props.initial?.end_time?.slice(0, 10) || fmtDate(today),
  t2: props.initial?.end_time?.slice(11) || '10:00',
  qty: 1,
  source: 'solo',
  multiKind: 'team',
  team_id: null,
  participant_ids: [],
  purpose: '',
});

const startOpts = timeOptions('start');
const endOpts = timeOptions('end');
const spaceResources = computed(() => props.resources.filter((r) => r.is_space));
const itemResources = computed(() => props.resources.filter((r) => !r.is_space));
const resource = computed(() => props.resources.find((r) => r.id === f.value.resource_id) || null);
const selectedTeam = computed(() => myTeams.value.find((t) => t.id === f.value.team_id) || null);
const headcount = computed(() => {
  if (f.value.source === 'solo') return 1;
  if (f.value.multiKind === 'team') return selectedTeam.value ? selectedTeam.value.members.length + 1 : 1;
  return 1 + f.value.participant_ids.length;
});
const startStr = computed(() => (props.initial && !manualTime.value) ? props.initial.start_time : `${f.value.d1} ${f.value.t1}`);
const endStr = computed(() => (props.initial && !manualTime.value) ? props.initial.end_time : `${f.value.d2} ${f.value.t2}`);
const source = computed(() => (f.value.source === 'solo' ? 'solo' : f.value.multiKind));
const pastDate = (d) => {
  const n = new Date(); n.setHours(0, 0, 0, 0);
  return d.getTime() < n.getTime();
};
const canSubmit = computed(() => {
  if (!resource.value || !startStr.value || !endStr.value) return false;
  if (checkError.value) return false;
  if (resource.value.is_space && headcount.value > resource.value.capacity) return false;
  if (f.value.source === 'multi' && f.value.multiKind === 'team' && !f.value.team_id) return false;
  return true;
});

async function searchUser(q) {
  if (!q) { userOptions.value = []; return; }
  searching.value = true;
  try {
    userOptions.value = (await api.bookingUserSearch(q)).users;
  } finally { searching.value = false; }
}

// 400ms 防抖实时校验（窗口/容量/库存/冲突，后端为最终准绳）
// checkSeq 丢弃过期响应：快速连改开始/结束时，先发出的「结束早于开始」400（后端短路、
// 返回极快）可能晚于后发出的 200 落回，无序号保护会把成功态反盖成错误。
let timer = null;
let checkSeq = 0;
async function runCheck() {
  checkError.value = '';
  checkOk.value = false;
  if (!resource.value || f.value.source === 'multi' && f.value.multiKind === 'team' && !f.value.team_id) return;
  if (resource.value.is_space && headcount.value > resource.value.capacity) {
    checkError.value = `人数 ${headcount.value} 超过容量 ${resource.value.capacity} 人`;
    return;
  }
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const seq = ++checkSeq;
    try {
      await api.bookingConflicts(props.project.id, payload());
      if (seq === checkSeq) checkOk.value = true;
    } catch (e) {
      if (seq === checkSeq) checkError.value = e.message;
    }
  }, 400);
}
function payload() {
  return {
    resource_id: f.value.resource_id,
    start_time: startStr.value,
    end_time: endStr.value,
    source: source.value,
    ...(resource.value && !resource.value.is_space ? { qty: f.value.qty } : {}),
    ...(source.value === 'team' ? { team_id: f.value.team_id } : {}),
    ...(source.value === 'custom' ? { participant_ids: f.value.participant_ids } : {}),
    purpose: f.value.purpose,
  };
}
watch(
  () => [f.value.resource_id, f.value.d1, f.value.t1, f.value.d2, f.value.t2, f.value.qty,
    f.value.source, f.value.multiKind, f.value.team_id, [...f.value.participant_ids], manualTime.value],
  runCheck,
);

async function submit() {
  submitting.value = true;
  try {
    const d = await api.bookingCreate(props.project.id, payload());
    ElMessage.success(d.message || '预约成功');
    emit('saved', d.booking);
  } catch (e) {
    checkError.value = e.message;
    ElMessage.error(e.message);
  } finally {
    submitting.value = false;
  }
}

onMounted(async () => {
  try {
    myTeams.value = (await api.bookingTeams(props.project.id)).teams.filter((t) => t.isOwner);
  } catch { /* 非项目成员也能看到开放项目，组队接口失败不阻塞 */ }
  runCheck();
});
</script>

<style lang="scss" scoped>
.bd-slot { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 14px; }
.bd-time { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.bd-sep { color: var(--text-3); }
.bd-rule { font-size: 12px; margin: 6px 0 0; }
.bd-err { color: var(--danger-fg); font-size: 12.5px; margin-left: 10px; }
.bd-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.dim { color: var(--text-3); font-size: 12.5px; margin-left: 8px; }
</style>
