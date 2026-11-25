<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api.js';

const competitions = ref([]);
const compId = ref(null);
const comp = ref(null);
const loading = ref(false);
const selectedProcessId = ref(null);
const selectedNode = ref(null);
const resourceDialog = ref(false);
const savingDates = ref(false);
const savingResource = ref(false);

const dateForm = reactive({
  registration_start_date: '',
  registration_deadline: '',
  competition_start_date: '',
  competition_end_date: '',
  date_status: 'unknown',
  date_source_url: '',
  official_url: '',
});

const resourceForm = reactive({
  tech_node_id: null,
  title: '',
  url: '',
  provider: '',
  resource_type: 'docs',
  category: 'knowledge',
});

const DATE_STATUS = [
  { value: 'exact', label: '已精确到日' },
  { value: 'partial', label: '部分日期明确' },
  { value: 'month_only', label: '仅公布月份' },
  { value: 'unknown', label: '待官方公布' },
];
const RESOURCE_TYPES = [
  { value: 'docs', label: '官方文档' },
  { value: 'course', label: '课程' },
  { value: 'video', label: '视频' },
  { value: 'project', label: '项目' },
  { value: 'article', label: '文章' },
  { value: 'tool', label: '工具' },
];

const processOptions = computed(() => comp.value?.process || []);
const resources = computed(() => (comp.value?.media || []).filter((item) => (
  item.category === 'knowledge' && item.source_type !== 'search'
)));
const resourcesByNode = computed(() => {
  const map = new Map();
  for (const resource of resources.value) {
    if (!resource.tech_node_id) continue;
    if (!map.has(resource.tech_node_id)) map.set(resource.tech_node_id, []);
    map.get(resource.tech_node_id).push(resource);
  }
  return map;
});
const treeData = computed(() => {
  if (!comp.value || !selectedProcessId.value) return [];
  const rows = (comp.value.tech_nodes || []).filter((node) => node.process_id === selectedProcessId.value);
  const byParent = new Map();
  for (const node of rows) {
    const key = Number(node.parent_id) || 0;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(node);
  }
  const build = (parentId) => (byParent.get(parentId) || [])
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id)
    .map((node) => ({
      ...node,
      resourceCount: (resourcesByNode.value.get(node.id) || []).length,
      children: build(node.id),
    }));
  return build(0);
});
const selectedResources = computed(() => (
  selectedNode.value ? resourcesByNode.value.get(selectedNode.value.id) || [] : []
));

async function loadCompetitions() {
  competitions.value = await api.competitions({ status: 'active' });
  if (!compId.value && competitions.value.length) {
    compId.value = competitions.value[0].id;
    await loadDetail();
  }
}

async function loadDetail() {
  if (!compId.value) return;
  loading.value = true;
  try {
    comp.value = await api.competition(compId.value);
    const nextProcessId = comp.value.process?.some((item) => item.id === selectedProcessId.value)
      ? selectedProcessId.value
      : comp.value.process?.[0]?.id || null;
    selectedProcessId.value = nextProcessId;
    selectedNode.value = null;
    for (const key of Object.keys(dateForm)) dateForm[key] = comp.value[key] || '';
    dateForm.date_status = comp.value.date_status || 'unknown';
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    loading.value = false;
  }
}

async function saveDates() {
  if (!comp.value) return;
  savingDates.value = true;
  try {
    const result = await api.updateCompetition(comp.value.id, { ...dateForm });
    comp.value = result.competition;
    ElMessage.success('竞赛日期已保存');
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    savingDates.value = false;
  }
}

async function addProcess() {
  if (!comp.value) return;
  let value;
  try {
    ({ value } = await ElMessageBox.prompt('新增子赛项或备赛阶段名称', '新增阶段', {
      inputPlaceholder: '例如：硬件组 / 算法组 / 决赛',
      inputValidator: (text) => !!String(text || '').trim() || '名称不能为空',
    }));
  } catch {
    return;
  }
  await api.addCompetitionProcess(comp.value.id, { phase_name: value.trim() });
  ElMessage.success('阶段已新增');
  await loadDetail();
}

async function removeProcess() {
  const process = processOptions.value.find((item) => item.id === selectedProcessId.value);
  if (!process) return;
  try {
    await ElMessageBox.confirm(
      `删除子赛项「${process.phase_name}」会同时删除其技术树和资源，确认继续？`,
      '删除子赛项',
      { type: 'warning' },
    );
  } catch {
    return;
  }
  await api.deleteCompetitionProcess(process.id);
  ElMessage.success('子赛项已删除');
  selectedProcessId.value = null;
  await loadDetail();
}

async function addNode(parent = null) {
  if (!selectedProcessId.value) return ElMessage.warning('请先选择或新增子赛项');
  let value;
  try {
    ({ value } = await ElMessageBox.prompt(
      parent ? `在「${parent.node_name}」下新增知识点` : '新增根知识点',
      '新增知识点',
      {
        inputPlaceholder: '例如：GPIO / 定时器 / PCB布局',
        inputValidator: (text) => !!String(text || '').trim() || '名称不能为空',
      },
    ));
  } catch {
    return;
  }
  await api.addTechNode(comp.value.id, {
    process_id: selectedProcessId.value,
    parent_id: parent?.id || 0,
    node_name: value.trim(),
  });
  ElMessage.success('知识点已新增');
  await loadDetail();
}

async function renameNode(node) {
  let value;
  try {
    ({ value } = await ElMessageBox.prompt('修改知识点名称', '重命名知识点', {
      inputValue: node.node_name,
      inputValidator: (text) => !!String(text || '').trim() || '名称不能为空',
    }));
  } catch {
    return;
  }
  await api.updateTechNode(node.id, { node_name: value.trim() });
  ElMessage.success('知识点已更新');
  await loadDetail();
}

async function removeNode(node) {
  try {
    await ElMessageBox.confirm(
      `删除「${node.node_name}」会同时删除它的子知识点和关联资源，确认继续？`,
      '删除知识点',
      { type: 'warning' },
    );
  } catch {
    return;
  }
  await api.deleteTechNode(node.id);
  ElMessage.success('知识点已删除');
  await loadDetail();
}

function onNodeClick(node) {
  selectedNode.value = node;
}

function openResource(node) {
  selectedNode.value = node;
  Object.assign(resourceForm, {
    tech_node_id: node.id,
    title: '',
    url: '',
    provider: '',
    resource_type: 'docs',
    category: 'knowledge',
  });
  resourceDialog.value = true;
}

async function saveResource() {
  if (!resourceForm.title.trim()) return ElMessage.warning('请填写资源标题');
  if (!resourceForm.url.trim()) return ElMessage.warning('请填写真实资源链接');
  savingResource.value = true;
  try {
    await api.addCompetitionResource(comp.value.id, { ...resourceForm });
    ElMessage.success('学习资源已补充');
    resourceDialog.value = false;
    await loadDetail();
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    savingResource.value = false;
  }
}

async function removeResource(resource) {
  try {
    await ElMessageBox.confirm(`删除资源「${resource.title}」？`, '删除资源', { type: 'warning' });
  } catch {
    return;
  }
  await api.deleteCompetitionResource(resource.id);
  ElMessage.success('资源已删除');
  await loadDetail();
}

function resourceTypeLabel(type) {
  return RESOURCE_TYPES.find((item) => item.value === type)?.label || '资源';
}

onMounted(loadCompetitions);
</script>

<template>
  <div class="catalog-editor" v-loading="loading">
    <div class="editor-toolbar">
      <el-select
        v-model="compId"
        filterable
        clearable
        placeholder="搜索并选择竞赛"
        style="width: min(520px, 100%)"
        @change="loadDetail"
      >
        <el-option
          v-for="item in competitions"
          :key="item.id"
          :label="item.name"
          :value="item.id"
        />
      </el-select>
      <el-button :disabled="!compId" @click="loadDetail">刷新</el-button>
    </div>

    <el-empty v-if="!comp" description="选择一项竞赛开始维护" />

    <template v-else>
      <div class="editor-section">
        <div class="section-head">
          <div>
            <h3>精确日期</h3>
            <p>只填写官方明确到日的日期；未公布就保持为空，不猜测。</p>
          </div>
          <el-button type="primary" :loading="savingDates" @click="saveDates">保存日期</el-button>
        </div>
        <el-form label-position="top" class="date-form">
          <el-form-item label="报名开始日">
            <el-date-picker v-model="dateForm.registration_start_date" type="date" value-format="YYYY-MM-DD" clearable style="width:100%" />
          </el-form-item>
          <el-form-item label="报名截止日">
            <el-date-picker v-model="dateForm.registration_deadline" type="date" value-format="YYYY-MM-DD" clearable style="width:100%" />
          </el-form-item>
          <el-form-item label="比赛开始日">
            <el-date-picker v-model="dateForm.competition_start_date" type="date" value-format="YYYY-MM-DD" clearable style="width:100%" />
          </el-form-item>
          <el-form-item label="比赛结束日">
            <el-date-picker v-model="dateForm.competition_end_date" type="date" value-format="YYYY-MM-DD" clearable style="width:100%" />
          </el-form-item>
          <el-form-item label="日期状态">
            <el-select v-model="dateForm.date_status" style="width:100%">
              <el-option v-for="item in DATE_STATUS" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="日期来源">
            <el-input v-model="dateForm.date_source_url" placeholder="官方通知或赛程页面 URL" />
          </el-form-item>
          <el-form-item label="竞赛官网">
            <el-input v-model="dateForm.official_url" placeholder="https://..." />
          </el-form-item>
        </el-form>
      </div>

      <div class="editor-section">
        <div class="section-head">
          <div>
            <h3>技术树与知识点资源</h3>
            <p>技术树支持继续向下扩展；资源只收录真实网站或页面链接，没有就保持空缺。</p>
          </div>
          <div class="head-actions">
            <el-button size="small" @click="addProcess">新增子赛项</el-button>
            <el-button size="small" type="primary" @click="addNode(null)">新增根知识点</el-button>
          </div>
        </div>

        <div class="tree-controls">
          <span>当前子赛项</span>
          <el-select v-model="selectedProcessId" placeholder="选择子赛项" style="width:320px" @change="selectedNode = null">
            <el-option v-for="item in processOptions" :key="item.id" :label="item.phase_name" :value="item.id" />
          </el-select>
          <el-button link type="danger" :disabled="!selectedProcessId" @click="removeProcess">删除当前子赛项</el-button>
        </div>

        <div class="tree-editor-grid">
          <div class="tree-panel">
            <el-empty v-if="!treeData.length" description="暂无技术树，可新增根知识点" :image-size="60" />
            <el-tree
              v-else
              :data="treeData"
              node-key="id"
              default-expand-all
              :expand-on-click-node="false"
              @node-click="onNodeClick"
            >
              <template #default="{ data }">
                <div class="tree-row">
                  <span class="tree-name">{{ data.node_name }}</span>
                  <span class="tree-level">L{{ data.level }}</span>
                  <span class="tree-res-count" :class="{ empty: !data.resourceCount }">
                    {{ data.resourceCount ? `${data.resourceCount} 资源` : '待补资源' }}
                  </span>
                  <span class="tree-actions" @click.stop>
                    <el-button link size="small" @click="addNode(data)">加子项</el-button>
                    <el-button link size="small" @click="openResource(data)">加资源</el-button>
                    <el-button link size="small" @click="renameNode(data)">改名</el-button>
                    <el-button link size="small" type="danger" @click="removeNode(data)">删除</el-button>
                  </span>
                </div>
              </template>
            </el-tree>
          </div>

          <div class="node-panel">
            <template v-if="selectedNode">
              <div class="node-panel-head">
                <div>
                  <b>{{ selectedNode.node_name }}</b>
                  <span>L{{ selectedNode.level }} · {{ selectedResources.length }} 条真实资源</span>
                </div>
                <el-button size="small" type="primary" @click="openResource(selectedNode)">补充资源</el-button>
              </div>
              <el-empty v-if="!selectedResources.length" description="这个知识点暂未找到合适资源" :image-size="55" />
              <div v-else class="resource-list">
                <div v-for="resource in selectedResources" :key="resource.id" class="resource-row">
                  <el-tag size="small">{{ resourceTypeLabel(resource.resource_type) }}</el-tag>
                  <a :href="resource.url" target="_blank">{{ resource.title }}</a>
                  <span>{{ resource.provider || resource.platform }}</span>
                  <el-button link type="danger" size="small" @click="removeResource(resource)">删除</el-button>
                </div>
              </div>
            </template>
            <el-empty v-else description="点击左侧知识点查看和补充资源" :image-size="55" />
          </div>
        </div>
      </div>
    </template>

    <el-dialog v-model="resourceDialog" title="补充真实学习资源" width="560px" append-to-body>
      <el-form label-position="top">
        <el-form-item label="资源标题" required>
          <el-input v-model="resourceForm.title" placeholder="例如：STM32 GPIO 官方文档 / 数据结构公开课" />
        </el-form-item>
        <el-form-item label="真实链接" required>
          <el-input v-model="resourceForm.url" placeholder="https://..." />
        </el-form-item>
        <div class="resource-form-grid">
          <el-form-item label="资源类型">
            <el-select v-model="resourceForm.resource_type" style="width:100%">
              <el-option v-for="item in RESOURCE_TYPES" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="提供方">
            <el-input v-model="resourceForm.provider" placeholder="官方文档 / 作者 / 平台" />
          </el-form-item>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="resourceDialog = false">取消</el-button>
        <el-button type="primary" :loading="savingResource" @click="saveResource">保存资源</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style lang="scss" scoped>
.catalog-editor { min-height: 300px; }
.editor-toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 14px; }
.editor-section {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--card-bg);
  padding: 16px;
  margin-bottom: 16px;
}
.section-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
  h3 { margin: 0 0 4px; font-size: 16px; }
  p { margin: 0; color: var(--text-2); font-size: 12.5px; }
}
.head-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.date-form {
  display: grid;
  grid-template-columns: repeat(4, minmax(140px, 1fr));
  gap: 0 12px;
}
.tree-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  color: var(--text-2);
  font-size: 13px;
}
.tree-editor-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(280px, .65fr);
  gap: 14px;
}
.tree-panel,
.node-panel {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
  background: var(--surface-3);
  min-height: 260px;
}
.tree-panel :deep(.el-tree-node__content) { min-height: 36px; }
.tree-row { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; padding-right: 6px; }
.tree-name { min-width: 100px; flex: 1; font-size: 13px; color: var(--text); }
.tree-level { flex-shrink: 0; color: var(--text-2); font-size: 11px; }
.tree-res-count { flex-shrink: 0; color: #047857; font-size: 11px; }
.tree-res-count.empty { color: #b45309; }
.tree-actions { flex-shrink: 0; display: flex; align-items: center; }
.tree-actions :deep(.el-button) { margin-left: 4px; font-size: 11px; }
.node-panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
  b { display: block; font-size: 14px; }
  span { display: block; margin-top: 3px; color: var(--text-2); font-size: 11.5px; }
}
.resource-list { display: flex; flex-direction: column; gap: 7px; }
.resource-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 8px;
  background: var(--card-bg);
  a { min-width: 0; color: var(--text); text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  span { color: var(--text-2); font-size: 11.5px; }
}
.resource-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

@media (max-width: 900px) {
  .date-form { grid-template-columns: 1fr 1fr; }
  .tree-editor-grid { grid-template-columns: 1fr; }
}
@media (max-width: 600px) {
  .date-form, .resource-form-grid { grid-template-columns: 1fr; }
  .section-head { flex-direction: column; }
}
</style>
