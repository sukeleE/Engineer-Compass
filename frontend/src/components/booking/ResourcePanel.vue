<template>
  <div class="rp-wrap">
    <div v-if="project.canManage" class="rp-bar">
      <el-dropdown split-button type="primary" size="small" @click="formOpen = true" @command="handleAddCommand">
        ＋ 添加资源
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="manual">✍️ 手动添加</el-dropdown-item>
            <el-dropdown-item command="import">📥 导入表格（AI 自动识别）</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <el-radio-group v-model="showStatus" size="small" style="margin-left: auto">
        <el-radio-button value="active">在用</el-radio-button>
        <el-radio-button value="all">全部（含归档）</el-radio-button>
      </el-radio-group>
    </div>

    <div v-loading="loading">
      <div v-for="g in groups" :key="g.key" class="rp-group">
        <h4><span class="rp-gicon">{{ g.icon }}</span>{{ g.label }}<span class="rp-gcount">{{ g.list.length }}</span></h4>
        <div v-if="g.list.length" class="rp-cards">
          <article v-for="r in g.list" :key="r.id" class="rs-card" :class="{ archived: r.status === 'archived' }">
            <img v-if="r.image" :src="r.image" class="rs-photo" alt="资源照片" @click="openDetail(r)" />
            <div class="rs-main">
              <b class="rs-name" @click="openDetail(r)">{{ r.name }}</b>
              <el-tag size="small" :type="r.approve_mode === 'first_come' ? 'success' : 'warning'" effect="plain">
                {{ MODE_ZH[r.approve_mode] }}
              </el-tag>
              <el-tag v-if="r.status === 'archived'" size="small" type="info">已归档</el-tag>
            </div>
            <div class="rs-meta">
              <template v-if="r.is_space">
                <span>👥 容量 {{ r.capacity }} 人</span>
                <span v-if="r.location">📍 {{ r.location }}</span>
                <span v-for="e in r.params?.equipment" :key="e" class="rs-tag">🛠 {{ e }}</span>
              </template>
              <template v-else>
                <span>📦 库存 {{ r.quantity }} {{ r.unit }}</span>
                <span v-if="r.spec">📐 {{ r.spec }}</span>
                <span v-if="r.location">📍 {{ r.location }}</span>
              </template>
            </div>
            <div v-if="project.canManage" class="rs-actions">
              <el-button link type="primary" size="small" @click="openDetail(r)">详情</el-button>
              <el-button link type="primary" size="small" @click="edit(r)">编辑</el-button>
              <el-button v-if="r.status === 'active'" link type="warning" size="small" @click="archive(r)">归档</el-button>
              <el-button v-else link type="success" size="small" @click="restore(r)">恢复</el-button>
              <el-button link type="danger" size="small" @click="remove(r)">删除</el-button>
            </div>
          </article>
        </div>
        <p v-else class="rp-empty dim">暂无{{ g.label }}</p>
      </div>
    </div>

    <ResourceFormDialog v-if="formOpen" :model-value="formOpen" :project="project" :resource="editing"
      @close="formOpen = false" @saved="onSaved" />
    <ResourceImportDialog v-if="importOpen" :model-value="importOpen" :project="project"
      :existing-names="resources.map((r) => r.name)" @close="importOpen = false" @saved="onSaved" />
    <ResourceDetailDialog v-if="detailRes" :resource="detailRes" @close="detailRes = null" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../../api.js';
import { KINDS, MODE_ZH } from '../../utils/booking.js';
import ResourceFormDialog from './ResourceFormDialog.vue';
import ResourceImportDialog from './ResourceImportDialog.vue';
import ResourceDetailDialog from './ResourceDetailDialog.vue';

const props = defineProps({ project: { type: Object, required: true } });
const emit = defineEmits(['changed']);

const resources = ref([]);
const loading = ref(false);
const showStatus = ref('active');
const formOpen = ref(false);
const importOpen = ref(false);
const editing = ref(null);
const detailRes = ref(null);
function openDetail(r) { detailRes.value = r; }
function handleAddCommand(cmd) {
  if (cmd === 'import') importOpen.value = true;
  else formOpen.value = true;
}

const groups = computed(() => KINDS.map((k) => ({
  ...k,
  list: resources.value.filter((r) => r.kind === k.key),
})).filter((g) => g.list.length));

async function load() {
  loading.value = true;
  try {
    resources.value = (await api.bookingResources(props.project.id, { status: showStatus.value })).resources;
  } finally {
    loading.value = false;
  }
}
function onSaved() {
  formOpen.value = false;
  importOpen.value = false;
  load();
  emit('changed');
}
function edit(r) {
  editing.value = r;
  formOpen.value = true;
}
async function archive(r) {
  try {
    await ElMessageBox.confirm(`归档「${r.name}」后不再接受新预约（历史预约保留），确认？`, '归档资源', { type: 'warning' });
  } catch { return; }
  await api.bookingResourceArchive(r.id);
  ElMessage.success('已归档');
  load();
  emit('changed');
}
async function restore(r) {
  await api.bookingResourceRestore(r.id);
  ElMessage.success('已恢复');
  load();
  emit('changed');
}
async function remove(r) {
  try {
    await ElMessageBox.confirm(`确认删除资源「${r.name}」？此操作不可恢复。`, '删除资源', { type: 'warning' });
  } catch { return; }
  try {
    await api.bookingResourceDelete(r.id);
    ElMessage.success('已删除');
    load();
  } catch (e) {
    ElMessage.error(e.message);
  }
}
watch(showStatus, load);
onMounted(load);
defineExpose({ reload: load });
</script>

<style lang="scss" scoped>
.rp-bar { display: flex; gap: 8px; align-items: center; margin-bottom: 14px; }
.rp-group { margin-bottom: 18px;
  h4 { margin: 0 0 8px; font-size: 14px; display: flex; align-items: center; gap: 6px; }
}
.rp-gicon { font-size: 16px; }
.rp-gcount { font-size: 12px; color: var(--text-3); font-weight: 400; }
.rp-empty { font-size: 12.5px; margin: 0 0 6px; }
.rp-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
.rs-card {
  border: 1px solid var(--border-2); border-radius: 10px; padding: 12px 14px;
  background: var(--card-bg); display: flex; flex-direction: column; gap: 8px;
  &.archived { opacity: .6; }
}
.rs-main { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rs-name { font-size: 14px; }
.rs-name { cursor: pointer; &:hover { color: var(--primary); } }
.rs-photo {
  width: 100%; aspect-ratio: 16 / 8; object-fit: cover; border-radius: 8px;
  border: 1px solid var(--border-2); cursor: zoom-in; background: var(--surface-2);
}
.rs-meta { display: flex; flex-wrap: wrap; gap: 6px 12px; font-size: 12.5px; color: var(--text-2); }
.rs-tag { color: var(--text-3); }
.rs-actions { margin-top: auto; padding-top: 4px; border-top: 1px dashed var(--border-2); }
</style>
