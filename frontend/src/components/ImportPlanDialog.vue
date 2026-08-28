<script setup>
// 计划导入弹窗（备赛/学习/小组通用）：上传 .docx/.pdf/.xlsx/.md → AI 读文档转成固定格式计划 → 预览确认后保存
// 流程与「先对话后成稿」一致：AI 产出 → 用户确认 → 才走 scheduleManual / studyManual / teamPlanSave 落库
import { ref, computed, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api.js';
import DocPicker from './team/DocPicker.vue';

const props = defineProps({
  modelValue: Boolean,
  mode: { type: String, default: 'schedule' }, // schedule 备赛 / study 学习 / team 小组计划
  teamId: { type: Number, default: null },     // mode='team' 时必传：小组 id
});
const emit = defineEmits(['update:modelValue', 'created']);

const MAX_SIZE = 20 * 1024 * 1024;
const fileInput = ref(null);
const docDlg = ref(false);   // 飞书文档拾取弹窗
const fileName = ref('');
const converting = ref(false);
const result = ref(null); // {title|topic, phases[], summary?, resource_keywords[]}
const saving = ref(false);

const totalTasks = computed(() => result.value?.phases.reduce((n, p) => n + (p.tasks?.length || 0), 0) || 0);

watch(() => props.modelValue, (v) => { if (v) { result.value = null; fileName.value = ''; } });

async function onFile(e) {
  const f = e.target.files?.[0];
  e.target.value = ''; // 支持重复选择同一文件
  if (!f) return;
  if (f.size > MAX_SIZE) return ElMessage.warning('文档过大（单文件 ≤20MB）');
  if (!/\.(docx|pdf|xlsx?|md|txt)$/i.test(f.name)) return ElMessage.warning('暂不支持该格式（支持 Word .docx / PDF / Excel / Markdown / 纯文本）');
  fileName.value = f.name;
  converting.value = true;
  try {
    const r = await api.planImport(f, props.mode);
    result.value = r.plan;
  } catch (err) {
    ElMessage.error(err.message);
    result.value = null;
  } finally {
    converting.value = false;
  }
}

// 飞书文档导入：raw 模式拿到 document_id → 后端拉 markdown → 走 /import/plan-text 与文件导入同一套 AI 转换
async function onDocPicked(doc) {
  if (!doc?.document_id) return;
  fileName.value = doc.name || '飞书文档';
  docDlg.value = false;
  converting.value = true;
  try {
    const c = await api.feishuDocContent(doc.document_id, 'markdown');
    if (!c?.content || c.content.replace(/\s/g, '').length < 20) {
      ElMessage.warning('该文档没有可读文本内容（纯图片文档暂不支持）');
      return;
    }
    const r = await api.planImportText({ mode: props.mode, text: c.content, source_name: doc.name || '飞书文档' });
    result.value = r.plan;
  } catch (err) {
    ElMessage.error(err.message);
    result.value = null;
  } finally {
    converting.value = false;
  }
}

async function confirm() {
  const p = result.value;
  if (!p) return;
  if (props.mode !== 'study' && !p.title.trim()) return ElMessage.warning('填写计划标题');
  if (props.mode === 'study' && !p.topic.trim()) return ElMessage.warning('填写学习主题');
  saving.value = true;
  try {
    if (props.mode === 'study') {
      const res = await api.studyManual({ topic: p.topic.trim() || undefined, phases: p.phases });
      ElMessage.success('✅ 导入成功，已保存为学习计划');
      emit('created', res);
    } else if (props.mode === 'team') {
      const res = await api.teamPlanSave(props.teamId, { title: p.title.trim() || undefined, plan_json: { phases: p.phases } });
      ElMessage.success('✅ 导入成功，已保存为小组计划');
      emit('created', res);
    } else {
      const res = await api.scheduleManual({ title: p.title.trim() || undefined, phases: p.phases });
      ElMessage.success('✅ 导入成功，已保存为备赛计划');
      emit('created', res);
    }
    emit('update:modelValue', false);
  } catch (e) { ElMessage.error(e.message); } finally { saving.value = false; }
}
</script>

<template>
  <el-dialog :model-value="modelValue" :title="mode === 'study' ? '📄 导入学习计划' : mode === 'team' ? '📄 导入小组计划' : '📄 导入备赛计划'"
    width="760px" :close-on-click-modal="false" append-to-body @update:model-value="(v) => emit('update:modelValue', v)">
    <p class="ip-tip">上传文档，AI 只做格式划分（保留原文），预览确认后保存</p>

    <!-- ① 文档选择：本地文件 / 飞书文档 -->
    <div v-if="!converting && !result" class="ip-pick">
      <input ref="fileInput" type="file" class="hide-file"
        accept=".docx,.pdf,.xls,.xlsx,.md,.txt" @change="onFile" />
      <div class="ip-btns">
        <el-button type="primary" size="large" @click="fileInput?.click()">📂 选择文件导入</el-button>
        <el-button type="success" size="large" plain @click="docDlg = true">📄 从飞书文档导入</el-button>
      </div>
      <p class="ip-hint">支持 Word .docx / PDF / Excel .xls/.xlsx / Markdown / 纯文本，单文件 ≤20MB；<br>
        或从飞书云文档导入（扫描版 PDF 无文字层、纯图片文档无法阅读）</p>
    </div>

    <!-- ② AI 转换中 -->
    <div v-else-if="converting" v-loading="true" class="ip-loading">
      <p>📄 正在阅读「{{ fileName }}」并生成计划…</p>
      <p class="ip-hint">AI 划分结构需要 10-60 秒，请稍候</p>
    </div>

    <!-- ③ 预览确认 -->
    <div v-else-if="result" class="ip-preview">
      <div class="ip-head">
        <el-input v-if="mode !== 'study'" v-model="result.title" placeholder="计划标题（可修改）" />
        <template v-else>
          <el-input v-model="result.topic" placeholder="学习主题（可修改）" style="flex:1.2" />
          <el-input v-model="result.summary" placeholder="学习目标摘要" style="flex:2" />
        </template>
      </div>
      <div v-if="mode === 'study' && result.resource_keywords?.length" class="ip-kw">
        关键词：
        <el-tag v-for="k in result.resource_keywords" :key="k" size="small" class="ip-tag">{{ k }}</el-tag>
      </div>
      <div v-for="(p, i) in result.phases" :key="i" class="ip-phase">
        <div class="ip-ph-head">
          <span class="ip-idx">阶段{{ i + 1 }}</span>
          <b>{{ p.phase }}</b>
          <span class="ip-date">{{ p.date }}</span>
          <span class="ip-wh">每周约 {{ p.week_hours }}h</span>
        </div>
        <ul class="ip-tasks">
          <li v-for="(t, j) in p.tasks" :key="j">{{ t.text }}</li>
        </ul>
        <p v-if="p.check_standard" class="ip-check">达标要求：{{ p.check_standard }}</p>
      </div>
      <div class="ip-count">共 {{ result.phases.length }} 阶段 / {{ totalTasks }} 任务，确认后保存</div>
    </div>

    <template #footer>
      <el-button v-if="result" @click="result = null">🔄 重新导入</el-button>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button v-if="result" type="primary" :loading="saving" @click="confirm">✅ 确认导入</el-button>
    </template>

    <!-- 飞书文档拾取（raw 模式仅回传 document_id/name/url，不落 biz 映射） -->
    <DocPicker v-model="docDlg" raw @picked="onDocPicked" />
  </el-dialog>
</template>

<style lang="scss" scoped>
.hide-file { display: none; }
.ip-tip { color: #94a3b8; font-size: 12.5px; margin: 0 0 14px; }
.ip-pick { text-align: center; padding: 30px 0 24px;
  .ip-btns { display: flex; justify-content: center; gap: 12px; }
  .ip-hint { color: #94a3b8; font-size: 12.5px; margin: 14px 0 0; line-height: 1.9; }
}
.ip-loading { text-align: center; padding: 30px 0; min-height: 120px;
  p { margin: 0 0 6px; font-size: 14px; color: var(--text); }
}
.ip-preview {
  .ip-head { display: flex; gap: 8px; margin-bottom: 12px; }
  .ip-kw { font-size: 12.5px; color: var(--text-2); margin: 0 0 10px;
    .ip-tag { margin-left: 6px; }
  }
  .ip-phase {
    border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; margin-bottom: 10px; background: var(--surface-3);
    .ip-ph-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px;
      .ip-idx { font-size: 12.5px; font-weight: 600; color: var(--text-2); white-space: nowrap; }
      b { font-size: 14px; }
      .ip-date { font-size: 12.5px; color: #94a3b8; }
      .ip-wh { margin-left: auto; font-size: 12px; color: var(--primary); background: color-mix(in srgb, var(--primary) 8%, transparent); border-radius: 999px; padding: 1px 10px; white-space: nowrap; }
    }
    .ip-tasks { margin: 0; padding-left: 20px;
      li { font-size: 13.5px; line-height: 1.9; color: var(--text); }
    }
    .ip-check { margin: 8px 0 0; font-size: 12.5px; color: var(--badge-fg); }
  }
  .ip-count { font-size: 12.5px; color: #94a3b8; }
}
</style>
