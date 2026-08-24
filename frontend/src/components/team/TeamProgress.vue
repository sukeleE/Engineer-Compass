<script setup>
// 进度对齐：任务列表（组长建任务/分配负责人/进度跟踪）+ 成员进度汇报时间线（富文本 + 附件 + 评论）
// 编写汇报独立成弹窗，与时间线浏览区区分
import { ref, computed } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../../api.js';
import { openImage } from '../../utils/imageViewer.js';
import RichEditor from './RichEditor.vue';
import AttachmentList from './AttachmentList.vue';
import CommentThread from './CommentThread.vue';

const props = defineProps({ teamId: Number, me: Object, perms: Object, members: Array, tasks: Array });

const tasks = ref(props.tasks || []);
const logs = ref([]);
const showNew = ref(false);
const newTask = ref({ title: '', desc: '', deadline: '', assignee_id: null });

// —— 汇报编写弹窗 ——
const reportDlg = ref(false);
const reportHtml = ref('');
const reportAtts = ref([]); // [{name,size,mime,data}]
const fileInput = ref(null);
const MAX_ATT_TOTAL = 25 * 1024 * 1024;

const STATUS = { todo: { label: '待开始', tag: 'info' }, doing: { label: '进行中', tag: 'warning' }, done: { label: '已完成', tag: 'success' } };

async function reload() {
  tasks.value = (await api.teamDetail(props.teamId)).tasks;
  logs.value = await api.teamLogs(props.teamId);
}

function canEditTask(t) {
  return t.assignee_id === props.me.user_id || props.perms.task;
}

async function createTask() {
  if (!newTask.value.title.trim()) return ElMessage.warning('任务标题必填');
  try {
    await api.teamTaskCreate(props.teamId, newTask.value);
    ElMessage.success('任务已创建');
    newTask.value = { title: '', desc: '', deadline: '', assignee_id: null };
    showNew.value = false;
    await reload();
  } catch (e) { ElMessage.error(e.message); }
}

async function updateTask(t, patch) {
  try {
    await api.teamTaskUpdate(props.teamId, t.id, patch);
    Object.assign(t, patch);
  } catch (e) { ElMessage.error(e.message); }
}

async function removeTask(t) {
  try {
    await api.teamTaskDelete(props.teamId, t.id);
    tasks.value = tasks.value.filter((x) => x.id !== t.id);
    ElMessage.success('任务已删除');
  } catch (e) { ElMessage.error(e.message); }
}

// 附件选择（图片/音频/视频/任意文件 → base64）
async function pickAtts(e) {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  for (const f of files) {
    if (f.size > 10 * 1024 * 1024) { ElMessage.warning(`「${f.name}」超过 10MB 上限`); continue; }
    const data = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.readAsDataURL(f);
    });
    const total = reportAtts.value.reduce((s, a) => s + a.data.length, 0) + data.length;
    if (total > MAX_ATT_TOTAL) { ElMessage.warning('附件总量超限（≤25MB）'); break; }
    reportAtts.value.push({ name: f.name, size: f.size, mime: f.type || 'application/octet-stream', data });
  }
}

function openReport() {
  reportHtml.value = '';
  reportAtts.value = [];
  reportDlg.value = true;
}

async function submitReport() {
  const text = reportHtml.value.replace(/<[^>]*>/g, '').trim();
  if (!text && !reportAtts.value.length) return ElMessage.warning('写点今天的进展，或附上文件');
  try {
    await api.teamLog(props.teamId, { content: reportHtml.value, attachments: reportAtts.value });
    reportDlg.value = false;
    await reload();
    ElMessage.success('进度已汇报');
  } catch (e) { ElMessage.error(e.message); }
}

// 富文本内容里的图片：点击 → 全屏预览
function onRichClick(e, l) {
  if (e.target.tagName === 'IMG') {
    openImage(e.target.currentSrc || e.target.src, `汇报图片-${l.id}`);
  }
}

const overall = computed(() => {
  const all = tasks.value;
  if (!all.length) return 0;
  return Math.round(all.reduce((s, t) => s + (t.progress || 0), 0) / all.length);
});

reload().catch((e) => ElMessage.error(e.message));
</script>

<template>
  <div class="tp">
    <!-- 总进度 + 编写入口 -->
    <div class="tp-head">
      <div class="tp-overall">
        <div class="tp-label">小组整体进度</div>
        <el-progress :percentage="overall" :stroke-width="12" :format="() => `${overall}%`" style="flex:1" />
        <el-button type="primary" @click="openReport">📝 编写汇报</el-button>
      </div>
    </div>

    <!-- 汇报编写弹窗（富文本 + 附件，与浏览区分开） -->
    <el-dialog v-model="reportDlg" title="📝 编写进度汇报" width="780px" :close-on-click-modal="false"
      destroy-on-close append-to-body>
      <RichEditor v-model="reportHtml" placeholder="今天做了什么？卡在哪？下一步？（支持加粗/列表/插入图片）" />
      <div class="rp-tools">
        <input ref="fileInput" type="file" multiple hidden @change="pickAtts" />
        <el-button size="small" @click="fileInput.click()">📎 附件（图片/音频/视频/文件）</el-button>
        <span v-if="reportAtts.length" class="att-chips">
          <el-tag v-for="(a, i) in reportAtts" :key="i" closable size="small" @close="reportAtts.splice(i, 1)">
            {{ a.name }}
          </el-tag>
        </span>
        <span class="rp-tip">图片会以缩略图展示，点击可放大下载</span>
      </div>
      <template #footer>
        <el-button @click="reportDlg = false">取消</el-button>
        <el-button type="primary" @click="submitReport">提交汇报</el-button>
      </template>
    </el-dialog>

    <!-- 任务列表 -->
    <div class="tp-tasks">
      <div class="tp-tools">
        <h4>📌 任务看板（{{ tasks.length }}）</h4>
        <el-button v-if="perms.task" size="small" type="primary" plain @click="showNew = !showNew">
          {{ showNew ? '收起' : '＋ 新建任务' }}
        </el-button>
      </div>

      <div v-if="showNew" class="task-new">
        <el-input v-model="newTask.title" placeholder="任务标题（如：机械结构装配）" style="flex:2" />
        <el-select v-model="newTask.assignee_id" placeholder="负责人" clearable style="flex:1">
          <el-option v-for="m in members.filter(x => !x.is_owner || x.is_me)" :key="m.id" :value="m.id"
            :label="`${m.nickname}${m.is_owner ? '（组长）' : ''}`" />
        </el-select>
        <el-date-picker v-model="newTask.deadline" type="date" placeholder="截止日期" value-format="YYYY-MM-DD" style="flex:1" />
        <el-button type="primary" @click="createTask">创建</el-button>
        <el-input v-model="newTask.desc" placeholder="任务说明（选填）" style="flex:2" />
      </div>

      <div v-if="!tasks.length" class="tp-empty">暂无任务 — 有「任务管理」权限的成员可创建</div>
      <div v-for="t in tasks" :key="t.id" class="task-card" :class="t.status">
        <div class="tc-top">
          <b>{{ t.title }}</b>
          <el-tag size="small" :type="STATUS[t.status].tag">{{ STATUS[t.status].label }}</el-tag>
        </div>
        <div v-if="t.desc" class="tc-desc">{{ t.desc }}</div>
        <div class="tc-meta">
          <span v-if="t.assignee_name">👤 {{ t.assignee_name }}</span>
          <span v-if="t.deadline">⏰ {{ t.deadline }}</span>
          <span class="tc-date">创建 {{ t.create_time?.slice(0, 10) }}</span>
        </div>
        <div class="tc-progress">
          <el-progress :percentage="t.progress || 0" :stroke-width="8" :status="t.status === 'done' ? 'success' : undefined" style="flex:1" />
          <template v-if="canEditTask(t)">
            <el-select v-model="t.status" size="small" style="width: 100px" @change="(v) => updateTask(t, { status: v })">
              <el-option v-for="(s, k) in STATUS" :key="k" :value="k" :label="s.label" />
            </el-select>
            <el-input-number v-model="t.progress" :min="0" :max="100" size="small" style="width: 110px"
              @change="(v) => updateTask(t, { progress: v })" />
            <el-button v-if="perms.task" size="small" text type="danger" @click="removeTask(t)">删除</el-button>
          </template>
        </div>
      </div>
    </div>

    <!-- 进度汇报时间线 -->
    <div class="tp-logs">
      <h4>🗣️ 成员进度汇报</h4>
      <el-timeline v-if="logs.length">
        <el-timeline-item v-for="l in logs" :key="l.id" :timestamp="`${l.nickname} · ${l.create_time?.slice(5, 16)}`">
          <div v-if="l.content" class="log-rich" v-html="l.content" @click="(e) => onRichClick(e, l)"></div>
          <AttachmentList v-if="l.attachments?.length" :attachments="l.attachments" />
          <CommentThread :team-id="teamId" type="log" :target="l" />
        </el-timeline-item>
      </el-timeline>
      <div v-else class="tp-empty">还没有汇报 — 点右上「📝 编写汇报」记录进展</div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.tp-head { margin-bottom: 16px;
  .tp-overall { display: flex; align-items: center; gap: 12px;
    .tp-label { font-size: 13px; color: var(--text-2); white-space: nowrap; }
  }
}
.rp-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px;
  .att-chips { display: flex; gap: 4px; flex-wrap: wrap; }
  .rp-tip { margin-left: auto; color: #94a3b8; font-size: 12px; }
}
.log-rich { line-height: 1.8; font-size: 13.5px;
  :deep(img) { max-width: 100%; max-height: 320px; border-radius: 8px; cursor: zoom-in; }
  :deep(video) { max-width: 100%; max-height: 320px; border-radius: 8px; }
  :deep(a) { color: #2563eb; }
}
.tp-tasks {
  .tp-tools { display: flex; justify-content: space-between; align-items: center; h4 { margin: 0 0 10px; } }
  .task-new { display: flex; gap: 8px; flex-wrap: wrap; background: #f8fafc; border: 1px dashed var(--border); border-radius: 10px; padding: 10px; margin-bottom: 10px; }
  .tp-empty { color: #94a3b8; font-size: 13px; padding: 14px 0; }
  .task-card {
    border: 1px solid var(--border); border-left: 3px solid #94a3b8; border-radius: 10px; padding: 10px 12px; margin-bottom: 10px;
    &.done { border-left-color: #16a34a; background: #f0fdf4; }
    &.doing { border-left-color: #f59e0b; }
    .tc-top { display: flex; justify-content: space-between; align-items: center; b { font-size: 14px; } }
    .tc-desc { color: var(--text-2); font-size: 13px; margin: 4px 0; }
    .tc-meta { display: flex; gap: 12px; color: var(--text-2); font-size: 12px; margin-bottom: 6px; flex-wrap: wrap;
      .tc-date { margin-left: auto; }
    }
    .tc-progress { display: flex; align-items: center; gap: 8px; }
  }
}
.tp-logs { margin-top: 18px; h4 { margin: 0 0 10px; } .tp-empty { color: #94a3b8; font-size: 13px; padding: 14px 0; } }
</style>
