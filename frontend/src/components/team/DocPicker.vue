<script setup>
// 「从飞书导入」文档选择器：列出飞书云盘 docx 文档（文件夹可进入），选中后导入内容到指定业务记录
// 导入走 /feishu/biz/import（服务端 blocks→md→html→UPDATE 业务表，不创建映射）：
// 之后点「飞书编辑」仍会新建本站自己的文档，两者互不绑定
import { ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../../api.js';

const props = defineProps({
  modelValue: Boolean,
  bizType: String,       // daily_note / progress_log / share_post
  bizId: [Number, String],
  extra: Object,         // 自动创建所需附加参数（progress_log 需 { team_id }；share_post 需 { title }）
  raw: Boolean,          // raw 模式：只选择文档回传，不导入业务记录（调用方自行 api.feishuDocContent 读取）
});
const emit = defineEmits(['update:modelValue', 'imported', 'picked']); // imported(content, bizId?)；picked({document_id,name,url}) 仅 raw 模式

const flist = ref([]);
const floading = ref(false);
const importing = ref(false);
const sel = ref(null);
const folder = ref('');   // 当前文件夹 token（空 = 云盘根目录）
const fstack = ref([]);   // 文件夹导航栈

async function load() {
  floading.value = true;
  try {
    const r = await api.feishuDocList(folder.value ? { folder_token: folder.value } : {});
    // 只展示可导入的 docx 文档 + 可进入的文件夹（sheet/file 无 docx blocks API）
    flist.value = (r.items || []).filter((f) => f.type === 'folder' || f.type === 'docx');
  } catch (e) { ElMessage.error(e.message); }
  finally { floading.value = false; }
}
function enterFolder(row) { fstack.value.push(row.token); folder.value = row.token; sel.value = null; load(); }
function backFolder() { fstack.value.pop(); folder.value = fstack.value[fstack.value.length - 1] || ''; sel.value = null; load(); }

watch(() => props.modelValue, (v) => { if (v) { folder.value = ''; fstack.value = []; sel.value = null; load(); } });

async function doImport() {
  if (!sel.value) return ElMessage.warning('请先选择要导入的文档');
  importing.value = true;
  try {
    if (props.raw) {
      emit('picked', { document_id: sel.value.token, name: sel.value.name, url: sel.value.url });
      emit('update:modelValue', false);
      return;
    }
    const r = await api.feishuBizImport(props.bizType, props.bizId, sel.value.token, props.extra || {});
    ElMessage.success(r.message || '✅ 已从飞书文档导入');
    emit('imported', r.content || '', r.id || null); // r.id：无记录时后端自动创建的新记录 id
    emit('update:modelValue', false);
  } catch (e) { ElMessage.error(e.message); }
  finally { importing.value = false; }
}
</script>

<template>
  <el-dialog :model-value="modelValue" title="📥 从飞书导入文档" width="620px"
    :close-on-click-modal="false" destroy-on-close append-to-body
    @update:model-value="emit('update:modelValue', $event)">
    <div class="dp-tip">{{ raw ? '选择飞书云盘里的文档，将读取其内容（不导入任何记录）' : '选择飞书云盘里的文档，内容将导入为当前记录（不建立长期绑定）' }}</div>
    <div class="dp-nav">
      <el-button v-if="folder" size="small" @click="backFolder">← 返回上级</el-button>
      <span class="dp-path">{{ folder ? '文件夹内' : '飞书云盘根目录' }}（仅显示文档与文件夹）</span>
    </div>
    <el-table :data="flist" highlight-current-row v-loading="floading" max-height="340"
      empty-text="云盘根目录没有可导入的文档"
      @current-change="(row) => (sel = row.type === 'docx' ? row : null)"
      @row-dblclick="(row) => row.type === 'folder' && enterFolder(row)">
      <el-table-column label="类型" width="70">
        <template #default="{ row }"><span style="font-size:17px">{{ row.type === 'folder' ? '📁' : '📄' }}</span></template>
      </el-table-column>
      <el-table-column prop="name" label="文档名称" min-width="240" show-overflow-tooltip />
      <el-table-column label="操作" width="110">
        <template #default="{ row }">
          <el-button v-if="row.type === 'folder'" size="small" link type="primary" @click="enterFolder(row)">进入</el-button>
          <span v-else style="font-size:12px;color:#94a3b8">可导入</span>
        </template>
      </el-table-column>
    </el-table>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :disabled="!sel" :loading="importing" @click="doImport">{{ raw ? '选择此文档' : '📥 导入此文档' }}</el-button>
    </template>
  </el-dialog>
</template>

<style lang="scss" scoped>
.dp-tip { font-size: 12.5px; color: var(--text-2); background: var(--surface-2); border-radius: 8px; padding: 8px 12px; margin-bottom: 10px; }
.dp-nav { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.dp-path { font-size: 12.5px; color: var(--text-2); }
</style>
