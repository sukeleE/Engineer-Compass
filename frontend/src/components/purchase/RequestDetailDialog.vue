<template>
  <!-- 申请详情：明细 / 审批轨迹 / 发票；审批与编辑操作按服务端权限位显隐 -->
  <el-dialog
    :model-value="modelValue"
    title="采购申请详情"
    width="820px"
    append-to-body
    destroy-on-close
    @update:model-value="(v) => emit('update:modelValue', v)"
    @closed="onClosed"
  >
    <div v-if="loading" class="loading-wrap"><span class="spin"></span> 加载中…</div>
    <template v-else-if="d">
      <!-- 概览 -->
      <div class="ov">
        <div class="ov-top">
          <span class="ev-name">{{ d.kind === '项目' ? '📁' : '🏆' }} {{ d.event_name }}</span>
          <el-tag :type="statusType(d.status)" effect="dark" size="small">{{ STATUS_ZH[d.status] }}</el-tag>
        </div>
        <div class="ov-meta">
          <span>申请人：<b>{{ d.applicant_name }}</b></span>
          <span>申请号：#{{ d.id }}</span>
          <span>提交：{{ fmtTime(d.submit_time) }}</span>
        </div>
        <div v-if="d.remark" class="ov-remark">备注：{{ d.remark }}</div>
        <el-alert v-if="d.status === 'rejected' && d.reject_reason" type="error" :closable="false" show-icon class="rej-alert">
          <template #title>驳回原因（{{ d.approver_name }}）：{{ d.reject_reason }}</template>
        </el-alert>
        <el-alert v-if="d.status === 'approved'" type="warning" :closable="false" show-icon class="rej-alert"
          title="审批已通过，请尽快上传发票（可多张）；未传发票前申请处于「待传发票」状态" />
      </div>

      <!-- 明细 -->
      <table class="d-table">
        <thead>
          <tr><th>#</th><th>物料/道具名称</th><th>规格型号</th><th>数量</th><th>单价(元)</th><th>金额(元)</th><th>链接</th><th>截图</th></tr>
        </thead>
        <tbody>
          <tr v-for="(it, i) in d.items" :key="it.id">
            <td>{{ i + 1 }}</td>
            <td>{{ it.name }}</td>
            <td>{{ it.spec || '—' }}</td>
            <td class="num">{{ it.qty }}</td>
            <td class="num">{{ it.unit_price.toFixed(2) }}</td>
            <td class="num amt">{{ it.amount.toFixed(2) }}</td>
            <td><a v-if="it.link" :href="it.link" target="_blank" rel="noopener" class="ext-link">查看↗</a><span v-else>—</span></td>
            <td>
              <img v-if="it.shot" class="thumb" :src="thumbUrl(it.shot)" alt="" @click="previewFile(it.shot)" />
              <span v-else>—</span>
            </td>
          </tr>
        </tbody>
        <tfoot>
          <tr><td colspan="5" class="sum-label">合计</td><td class="num sum-amt">¥{{ d.amount.toFixed(2) }}</td><td colspan="2"></td></tr>
        </tfoot>
      </table>

      <!-- 发票区 -->
      <div class="inv-zone">
        <div class="zone-head">
          <b>🧾 发票</b>
          <span class="hint">
            {{ d.invoice_count ? `已上传 ${d.invoice_count} 张` : '尚未上传发票' }}
          </span>
          <span class="spacer"></span>
          <template v-if="d.perm.canInvoice">
            <input ref="invInput" type="file" accept="image/*,.pdf" multiple hidden @change="onInvoices" />
            <el-button size="small" type="primary" :loading="invLoading" @click="invInput?.click()">
              {{ d.invoice_count ? '补传发票' : '上传发票' }}
            </el-button>
          </template>
        </div>
        <div v-if="d.invoices.length" class="inv-list">
          <div v-for="f in d.invoices" :key="f.id" class="inv-chip">
            <img v-if="isImage(f)" class="thumb sm" :src="thumbUrl(f)" alt="" @click="previewFile(f)" />
            <span v-else class="pdf-ic" @click="previewFile(f)">📄</span>
            <a class="inv-name" @click="previewFile(f)">{{ f.orig_name }}</a>
            <span class="inv-del" v-if="d.perm.canInvoice || auth.user?.is_admin" @click="delInvoice(f)">✕</span>
          </div>
        </div>
        <div v-else-if="!d.perm.canInvoice" class="zone-empty">审批通过后由申请人上传</div>
      </div>

      <!-- 审批轨迹 -->
      <div class="trail">
        <b class="zone-head-title">审批轨迹</b>
        <el-timeline class="tl">
          <el-timeline-item :timestamp="fmtTime(d.submit_time)" placement="top" type="primary" size="large">
            {{ d.applicant_name }} 提交申请
          </el-timeline-item>
          <el-timeline-item v-for="l in d.logs" :key="l.id" :timestamp="fmtTime(l.create_time)" placement="top"
            :type="l.result === 'approved' ? 'success' : 'danger'" size="large">
            <el-tag size="small" :type="l.role === 'teacher' ? 'warning' : 'primary'" effect="plain" class="role-tag">
              {{ l.role === 'teacher' ? '老师' : '负责人' }}
            </el-tag>
            <b>{{ l.approver_name }}</b>
            {{ l.result === 'approved' ? '审批通过' : '驳回申请' }}
            <span v-if="l.comment" class="log-comment">：{{ l.comment }}</span>
          </el-timeline-item>
          <el-timeline-item v-if="d.status === 'invoiced'" :timestamp="d.invoices.length ? fmtTime(d.invoices[d.invoices.length - 1].create_time) : ''"
            placement="top" type="success" size="large">
            发票已上传（{{ d.invoice_count }} 张）
          </el-timeline-item>
          <el-timeline-item v-else-if="d.status === 'approved'" placement="top" type="warning" size="large" hollow>
            等待申请人上传发票
          </el-timeline-item>
        </el-timeline>
      </div>
    </template>

    <template #footer>
      <template v-if="d">
        <!-- 申请人：待审批撤回 / 驳回后修改重提 / 待审批编辑 -->
        <el-button v-if="d.perm.canDelete" type="danger" plain @click="withdraw">撤回申请</el-button>
        <!-- 超级管理员：可强删任意状态申请（本人可撤回的场景只显示撤回，避免重复按钮） -->
        <el-button v-if="d.perm.isSuperAdmin && !d.perm.canDelete" type="danger" plain @click="adminDelete">删除申请</el-button>
        <el-button v-if="d.perm.canEdit" type="primary" @click="emit('edit', d)">
          {{ d.status === 'rejected' ? '修改并重新提交' : '修改申请' }}
        </el-button>
        <!-- 审批人：通过 / 驳回（不能审自己，admin 除外——以服务端 canApprove 为准） -->
        <template v-if="d.perm.canApprove">
          <el-button type="danger" plain :loading="acting" @click="reject">驳回</el-button>
          <el-button type="success" :loading="acting" @click="approve">✓ 通过</el-button>
        </template>
        <el-button @click="emit('update:modelValue', false)">关闭</el-button>
      </template>
      <el-button v-else @click="emit('update:modelValue', false)">关闭</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, reactive, watch, onBeforeUnmount } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../../api.js';
import { openImage } from '../../utils/imageViewer.js';
import auth from '../../auth.js';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  requestId: { type: [Number, String], default: null },
});
const emit = defineEmits(['update:modelValue', 'changed', 'edit']);

const STATUS_ZH = { pending: '待审批', approved: '待传发票', invoiced: '已传发票', rejected: '已驳回' };
const statusType = (s) => ({ pending: 'warning', approved: 'danger', invoiced: 'success', rejected: 'info' }[s] || 'info');

const d = ref(null);
const loading = ref(false);
const acting = ref(false);
const invLoading = ref(false);
const invInput = ref(null);

function fmtTime(t) { return t ? String(t).slice(0, 16) : ''; }
function isImage(f) { return /^image\//.test(f.mime) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.orig_name); }

// 文件预览：token 不进 URL，统一 fetch blob；图片走全局查看器，PDF 新开页
// reactive Map：异步拉取完成后赋值要触发缩略图重渲染
const blobUrls = reactive(new Map()); // fid → {url, mime} | null(占位)
function thumbUrl(f) {
  if (!f) return '';
  if (!blobUrls.has(f.id)) {
    blobUrls.set(f.id, null); // 占位防并发重复拉
    api.purchaseFileBlob(f.id).then((blob) => {
      blobUrls.set(f.id, { url: URL.createObjectURL(blob), mime: f.mime || blob.type });
    }).catch(() => blobUrls.delete(f.id));
    return '';
  }
  return blobUrls.get(f.id)?.url || '';
}
function previewFile(f) {
  const cached = blobUrls.get(f.id);
  const show = (entry) => {
    if (isImage(f) || /^image\//.test(entry.mime)) openImage(entry.url, f.orig_name);
    else window.open(entry.url, '_blank', 'noopener');
  };
  if (cached) return show(cached);
  api.purchaseFileBlob(f.id).then((blob) => {
    const entry = { url: URL.createObjectURL(blob), mime: f.mime || blob.type };
    blobUrls.set(f.id, entry);
    show(entry);
  }).catch((e) => ElMessage.error(e.message));
}

async function load() {
  if (!props.requestId) return;
  // 仅首次打开显示整窗 loading；审批/发票后的刷新保留旧内容，避免整窗闪「加载中」
  const firstLoad = !d.value;
  if (firstLoad) loading.value = true;
  try {
    d.value = (await api.purchaseRequestDetail(props.requestId)).detail;
  } catch (e) {
    ElMessage.error(e.message);
    if (firstLoad) emit('update:modelValue', false);
  } finally {
    loading.value = false;
  }
}

async function approve() {
  try {
    const { value } = await ElMessageBox.prompt('可填写审批意见（选填），确认通过该申请？', '审批通过', {
      confirmButtonText: '确认通过', cancelButtonText: '取消', inputType: 'textarea',
      inputPlaceholder: '意见选填', inputValue: '',
      inputValidator: (v) => (v || '').length <= 200 || '意见不超过 200 字',
    });
    acting.value = true;
    await api.purchaseApprove(d.value.id, value || '');
    ElMessage.success('已通过');
    await load();
    emit('changed');
  } catch (e) {
    if (e !== 'cancel' && e?.message) ElMessage.error(e.message);
  } finally {
    acting.value = false;
  }
}

async function reject() {
  try {
    const { value } = await ElMessageBox.prompt('请填写驳回原因（必填，申请人将据此修改）', '驳回申请', {
      confirmButtonText: '确认驳回', cancelButtonText: '取消', inputType: 'textarea',
      inputPlaceholder: '例如：单价偏高，请附比价截图',
      inputValidator: (v) => !!(v && v.trim()) || '驳回原因必填',
    });
    acting.value = true;
    await api.purchaseReject(d.value.id, value.trim());
    ElMessage.success('已驳回');
    await load();
    emit('changed');
  } catch (e) {
    if (e !== 'cancel' && e?.message) ElMessage.error(e.message);
  } finally {
    acting.value = false;
  }
}

async function withdraw() {
  try {
    await ElMessageBox.confirm('撤回后该申请及其明细、截图将一并删除，确定撤回？', '撤回申请', {
      confirmButtonText: '撤回并删除', cancelButtonText: '取消', type: 'warning',
    });
    await api.purchaseRequestDelete(d.value.id);
    ElMessage.success('已撤回');
    emit('changed');
    emit('update:modelValue', false);
  } catch (e) {
    if (e !== 'cancel' && e?.message) ElMessage.error(e.message);
  }
}

async function adminDelete() {
  try {
    await ElMessageBox.confirm(
      `将删除申请 #${d.value.id}（${d.value.applicant_name}）及其全部明细、截图、发票与审批记录，删除后不可恢复，确定删除？`,
      '管理员删除申请',
      { confirmButtonText: '确认删除', cancelButtonText: '取消', type: 'error' },
    );
    await api.purchaseRequestDelete(d.value.id);
    ElMessage.success('申请已删除');
    emit('changed');
    emit('update:modelValue', false);
  } catch (e) {
    if (e !== 'cancel' && e?.message) ElMessage.error(e.message);
  }
}

async function onInvoices(e) {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (!files.length) return;
  const bad = files.find((f) => !( /^image\//.test(f.type) || /\.pdf$/i.test(f.name)));
  if (bad) return ElMessage.error(`「${bad.name}」不支持：发票仅接受图片或 PDF`);
  const big = files.find((f) => f.size > 25 * 1024 * 1024);
  if (big) return ElMessage.error(`「${big.name}」超过 25MB`);
  invLoading.value = true;
  let ok = 0;
  try {
    for (const f of files) {
      await api.purchaseInvoiceUpload(d.value.id, f);
      ok++;
    }
    ElMessage.success(`已上传 ${ok} 张发票`);
    await load();
    emit('changed');
  } catch (err) {
    ElMessage.error(err.message + (ok ? `（已成功 ${ok}/${files.length} 张）` : ''));
    if (ok) { await load(); emit('changed'); }
  } finally {
    invLoading.value = false;
  }
}

async function delInvoice(f) {
  try {
    await ElMessageBox.confirm(`删除发票「${f.orig_name}」？若删光全部发票，状态将退回「待传发票」。`, '删除发票', {
      confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning',
    });
    await api.purchaseFileDelete(f.id);
    const old = blobUrls.get(f.id);
    if (old) URL.revokeObjectURL(old.url);
    blobUrls.delete(f.id);
    ElMessage.success('已删除');
    await load();
    emit('changed');
  } catch (e) {
    if (e !== 'cancel' && e?.message) ElMessage.error(e.message);
  }
}

watch(() => props.modelValue, (open) => { if (open) load(); });
onBeforeUnmount(() => { for (const v of blobUrls.values()) if (v) URL.revokeObjectURL(v.url); });
function onClosed() { for (const v of blobUrls.values()) if (v) URL.revokeObjectURL(v.url); blobUrls.clear(); d.value = null; }
</script>

<style scoped>
.loading-wrap { padding: 40px; text-align: center; color: var(--text-2); display: flex;
  align-items: center; justify-content: center; gap: 8px; }
.spin { width: 14px; height: 14px; border: 2px solid var(--border-2); border-top-color: var(--primary);
  border-radius: 50%; animation: pv-spin .7s linear infinite; display: inline-block; }
@keyframes pv-spin { to { transform: rotate(360deg); } }
.ov { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; margin-bottom: 14px; background: var(--surface-1); }
.ov-top { display: flex; align-items: center; gap: 10px; }
.ov-top .ev-name { font-weight: 700; font-size: 15px; }
.ov-meta { display: flex; gap: 18px; flex-wrap: wrap; color: var(--text-2); font-size: 13px; margin-top: 6px; }
.ov-remark { margin-top: 6px; font-size: 13px; color: var(--text-2); }
.rej-alert { margin-top: 10px; }
.d-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.d-table th, .d-table td { border: 1px solid var(--border); padding: 6px 8px; text-align: left; }
.d-table th { background: var(--surface-1); color: var(--text-2); font-weight: 600; white-space: nowrap; }
.d-table .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.d-table .amt { color: var(--primary); font-weight: 600; }
.sum-label { text-align: right; font-weight: 600; }
.sum-amt { font-size: 15px; font-weight: 700; color: var(--primary); }
.ext-link { color: var(--primary); text-decoration: none; }
.thumb { width: 46px; height: 46px; object-fit: cover; border-radius: 6px; border: 1px solid var(--border); cursor: zoom-in; }
.thumb.sm { width: 34px; height: 34px; }
.inv-zone, .trail { margin-top: 18px; }
.zone-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.zone-head .hint { color: var(--text-3); font-size: 12px; }
.zone-head .spacer { flex: 1; }
.zone-head-title { font-size: 14px; display: block; margin-bottom: 10px; }
.zone-empty { color: var(--text-3); font-size: 13px; padding: 8px 2px; }
.inv-list { display: flex; flex-direction: column; gap: 6px; }
.inv-chip { display: flex; align-items: center; gap: 8px; border: 1px solid var(--border); border-radius: 8px; padding: 5px 10px; background: var(--surface-1); }
.pdf-ic { font-size: 22px; cursor: pointer; }
.inv-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; cursor: pointer; color: var(--primary); }
.inv-del { cursor: pointer; color: var(--danger); padding: 2px 6px; border-radius: 6px; }
.inv-del:hover { background: var(--danger-tint); }
.trail { margin-top: 20px; }
.tl { margin-top: 8px; padding-left: 4px; }
.role-tag { margin-right: 6px; }
.log-comment { color: var(--text-2); }
@media (max-width: 768px) {
  .d-table { display: block; overflow-x: auto; }
}
</style>
