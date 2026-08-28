<script setup>
// 通用「引用资源」弹窗（5 类入口：小组资料 / 分享帖附件 / 讨论附图 / 汇报附件 / 插图）
// 两个来源 tab：
//   我的资源 — 站内上传，选中生成可撤销公开下载链接引用（不复制文件）
//   飞书云盘 — 绑定飞书账号后可直接选取云盘文件/文档，引用其飞书链接（P2）
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api.js';

const props = defineProps({
  modelValue: Boolean,
  onlyImage: Boolean, // true 时只展示图片类资源（富文本插图 / 讨论附图）→ 不显示飞书云盘 tab
});
const emit = defineEmits(['update:modelValue', 'pick']);

// —— 我的资源 ——
const list = ref([]);
const total = ref(0);
const page = ref(1);
const size = ref(10);
const loading = ref(false);
const picking = ref(false);
const sel = ref(null);

const isImg = (r) => (r.file_type || '').startsWith('image/');
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : (n || 0) + ' B');

async function load() {
  loading.value = true;
  try {
    const r = await api.resourceList({ page: page.value, size: size.value });
    list.value = props.onlyImage ? r.list.filter(isImg) : r.list;
    total.value = r.total;
  } catch (e) { ElMessage.error(e.message); }
  finally { loading.value = false; }
}

// —— 飞书云盘（P2）：绑定后列出云盘文件/文件夹，选中引用其飞书链接 ——
const tab = ref('mine');
const feishu = ref({ bound: false, loading: false }); // 绑定状态
const flist = ref([]);
const floading = ref(false);
const fsel = ref(null);
const fstack = ref([]); // 文件夹导航栈（token）
const folder = ref(''); // 当前 folder_token（空 = 云盘根目录）

const TYPE_ICON = { docx: '📄', sheet: '📊', slides: '📽️', file: '📦', folder: '📁', bitable: '🧮', mindnote: '🧠', media: '🎬', pdf: '📕', doc: '📄' };
const typeIcon = (t) => TYPE_ICON[t] || '📄';
const isFolder = (r) => r.type === 'folder';

async function loadFeishu() {
  floading.value = true;
  try {
    const r = await api.feishuDocList(folder.value ? { folder_token: folder.value } : {});
    flist.value = r.items || [];
  } catch (e) { ElMessage.error(e.message); }
  finally { floading.value = false; }
}
function enterFolder(row) {
  fstack.value.push(row.token);
  folder.value = row.token;
  fsel.value = null;
  loadFeishu();
}
function backFolder() {
  fstack.value.pop();
  folder.value = fstack.value[fstack.value.length - 1] || '';
  fsel.value = null;
  loadFeishu();
}
// 打开弹窗：查绑定状态（授权窗口绑定完成后 postMessage 自动刷新）
const feishuListener = (e) => {
  if (e.data?.type === 'feishu-bound') { feishu.value.bound = true; loadFeishu(); }
};
function checkFeishu() {
  api.feishuStatus().then((s) => { feishu.value.bound = !!s.bound; if (s.bound && tab.value === 'feishu') loadFeishu(); })
    .catch(() => { feishu.value.bound = false; });
}
function bindFeishu() {
  api.feishuAuth().then(({ url }) => window.open(url, '_blank'))
    .catch((e) => ElMessage.error(e.message));
}

watch(() => props.modelValue, (v) => {
  if (!v) return;
  page.value = 1; sel.value = null; fsel.value = null;
  load();
  if (props.onlyImage) tab.value = 'mine';
  checkFeishu();
});
watch(tab, (t) => { if (t === 'feishu' && feishu.value.bound) loadFeishu(); });
onMounted(() => window.addEventListener('message', feishuListener));
onBeforeUnmount(() => window.removeEventListener('message', feishuListener));

// 确认引用：我的资源走分享链接；飞书云盘直接用飞书链接（附件白名单已放行飞书域）
async function confirm() {
  if (!sel.value) return ElMessage.warning('请先选择要引用的资源');
  picking.value = true;
  try {
    const share = await api.resourceShare(sel.value.id); // 幂等：已有分享链接直接复用
    emit('pick', { id: sel.value.id, name: sel.value.file_name, size: sel.value.file_size, mime: sel.value.file_type, url: share.url });
    emit('update:modelValue', false);
  } catch (e) { ElMessage.error(e.message); }
  finally { picking.value = false; }
}
function confirmFeishu() {
  if (!fsel.value) return ElMessage.warning('请先选择要引用的文件');
  emit('pick', { id: 0, name: fsel.value.name, size: 0, mime: 'application/octet-stream', url: fsel.value.url });
  emit('update:modelValue', false);
}
</script>

<template>
  <el-dialog :model-value="modelValue" title="📁 从资源库引用" width="680px"
    :close-on-click-modal="false" destroy-on-close append-to-body
    @update:model-value="emit('update:modelValue', $event)">
    <el-tabs v-model="tab">
      <!-- 我的资源 -->
      <el-tab-pane label="我的资源" name="mine">
        <div class="rp-tip">引用不复制文件，生成可撤销的公开下载链接</div>
        <el-table :data="list" highlight-current-row v-loading="loading" max-height="360"
          :empty-text="onlyImage ? '还没有图片资源 — 先去「我的资源」上传' : '还没有资源 — 先去「我的资源」上传'"
          @current-change="(row) => (sel = row)">
          <el-table-column prop="file_name" label="文件名" min-width="200" show-overflow-tooltip />
          <el-table-column label="大小" width="90">
            <template #default="{ row }">{{ fmtSize(row.file_size) }}</template>
          </el-table-column>
          <el-table-column label="类型" width="140">
            <template #default="{ row }">
              <span>{{ row.file_type || '未知' }}</span>
              <el-tag v-if="row.shared" size="small" type="success" effect="plain" style="margin-left: 4px">已分享</el-tag>
            </template>
          </el-table-column>
        </el-table>
        <el-pagination v-if="total > size" class="rp-pg" small background layout="prev, pager, next"
          :total="total" :page-size="size" v-model:current-page="page" @current-change="load" />
      </el-tab-pane>

      <!-- 飞书云盘（P2） -->
      <el-tab-pane name="feishu">
        <template #label>🪶 飞书云盘</template>
        <div v-if="!feishu.bound" class="rp-tip rp-feishu-empty">
          绑定飞书账号后可直接选取云盘里的文件 / 文档（引用其飞书链接）
          <el-button size="small" type="primary" plain style="margin-left: 8px" @click="bindFeishu">🔗 绑定飞书账号</el-button>
        </div>
        <template v-else>
          <div class="rp-fnav">
            <el-button v-if="folder" size="small" @click="backFolder">← 返回上级</el-button>
            <span class="rp-fpath">{{ folder ? '文件夹内' : '飞书云盘根目录' }}（共 {{ flist.length }} 项）</span>
          </div>
          <el-table :data="flist" highlight-current-row v-loading="floading" max-height="360"
            empty-text="云盘根目录为空"
            @current-change="(row) => (fsel = isFolder(row) ? null : row)"
            @row-dblclick="(row) => isFolder(row) && enterFolder(row)">
            <el-table-column label="类型" width="70">
              <template #default="{ row }"><span style="font-size:17px">{{ typeIcon(row.type) }}</span></template>
            </el-table-column>
            <el-table-column prop="name" label="名称" min-width="220" show-overflow-tooltip />
            <el-table-column label="操作" width="110">
              <template #default="{ row }">
                <el-button v-if="isFolder(row)" size="small" link type="primary" @click="enterFolder(row)">进入</el-button>
                <span v-else style="font-size:12px;color:#94a3b8">可引用</span>
              </template>
            </el-table-column>
          </el-table>
        </template>
      </el-tab-pane>
    </el-tabs>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <template v-if="tab === 'mine'">
        <el-button type="primary" :disabled="!sel" :loading="picking" @click="confirm">📎 使用此文件</el-button>
      </template>
      <template v-else>
        <el-button type="primary" :disabled="!fsel || !feishu.bound" @click="confirmFeishu">📎 引用飞书链接</el-button>
      </template>
    </template>
  </el-dialog>
</template>

<style lang="scss" scoped>
.rp-tip { font-size: 12.5px; color: var(--text-2); background: var(--surface-2); border-radius: 8px; padding: 8px 12px; margin-bottom: 10px; }
.rp-feishu-empty { display: flex; align-items: center; flex-wrap: wrap; }
.rp-pg { margin-top: 10px; justify-content: flex-end; }
.rp-fnav { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.rp-fpath { font-size: 12.5px; color: var(--text-2); }
</style>
