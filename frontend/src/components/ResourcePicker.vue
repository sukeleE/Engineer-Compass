<script setup>
// 通用「从我的资源选择」弹窗（引用功能）：
// 列出当前用户「我的资源」，选中后自动生成（或复用）分享链接并 emit pick({id, name, size, mime, url})
// 用于 5 类入口：小组资料引用 / 分享帖附件 / 讨论附图 / 汇报附件 / 富文本插图
// 语义：不复制文件，引用指向原资源——撤销分享后所有引用一并失效
import { ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api.js';

const props = defineProps({
  modelValue: Boolean,
  onlyImage: Boolean, // true 时只展示图片类资源（富文本插图 / 讨论附图）
});
const emit = defineEmits(['update:modelValue', 'pick']);

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

watch(() => props.modelValue, (v) => { if (v) { page.value = 1; sel.value = null; load(); } });

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
</script>

<template>
  <el-dialog :model-value="modelValue" title="📁 从我的资源引用" width="640px"
    :close-on-click-modal="false" destroy-on-close append-to-body
    @update:model-value="emit('update:modelValue', $event)">
    <div class="rp-tip">
      引用不复制文件，生成可撤销的公开下载链接
    </div>
    <el-table :data="list" highlight-current-row v-loading="loading" max-height="360"
      :empty-text="onlyImage ? '还没有图片资源 — 先去「我的资源」上传' : '还没有资源 — 先去「我的资源」上传'"
      @current-change="(row) => (sel = row)">
      <el-table-column prop="file_name" label="文件名" min-width="200" show-overflow-tooltip />
      <el-table-column label="大小" width="90">
        <template #default="{ row }">{{ fmtSize(row.file_size) }}</template>
      </el-table-column>
      <el-table-column label="类型" width="130">
        <template #default="{ row }">
          <span>{{ row.file_type || '未知' }}</span>
          <el-tag v-if="row.shared" size="small" type="success" effect="plain" style="margin-left: 4px">已分享</el-tag>
        </template>
      </el-table-column>
    </el-table>
    <el-pagination v-if="total > size" class="rp-pg" small background layout="prev, pager, next"
      :total="total" :page-size="size" v-model:current-page="page" @current-change="load" />
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :disabled="!sel" :loading="picking" @click="confirm">
        📎 使用此文件
      </el-button>
    </template>
  </el-dialog>
</template>

<style lang="scss" scoped>
.rp-tip { font-size: 12.5px; color: #64748b; background: #f1f5f9; border-radius: 8px; padding: 8px 12px; margin-bottom: 10px; }
.rp-pg { margin-top: 10px; justify-content: flex-end; }
</style>
