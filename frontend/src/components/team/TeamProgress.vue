<script setup>
// 进度对齐：任务列表（组长建任务/分配负责人/进度跟踪）+ 成员进度汇报时间线（富文本 + 附件 + 评论）
// 编写汇报独立成弹窗，与时间线浏览区区分
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../../api.js';
import auth from '../../auth.js';
import { openImage } from '../../utils/imageViewer.js';
import RichEditor from './RichEditor.vue';
import AttachmentList, { normAtts } from './AttachmentList.vue';
import CommentThread from './CommentThread.vue';
import ResourcePicker from '../ResourcePicker.vue';
import DocPicker from './DocPicker.vue';

const router = useRouter();
// 点击作者头像/昵称 → 进入其公开主页（只读）；自己 → 我的管理界面
const toProfile = (x) => router.push(x.user_id === auth.user?.id ? '/me' : `/user/${x.user_id}`);

const props = defineProps({ teamId: Number, me: Object, perms: Object, members: Array, tasks: Array });

const tasks = ref(props.tasks || []);
const logs = ref([]);
const showNew = ref(false);
const newTask = ref({ title: '', desc: '', deadline: '', assignee_id: null });

// —— 汇报编写/编辑弹窗 ——
const reportDlg = ref(false);
const reportHtml = ref('');
const reportAtts = ref([]); // [{name,size,mime,data}]
const editingLogId = ref(null); // null=新汇报；有值=编辑该条
const impDlg = ref(false);   // 从飞书导入文档选择器
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

// —— 任务说明编辑：卡片 desc 行「✏️」→ 小弹窗（纯文本；可从飞书文档导入，HTML 转纯文本）——
const descDlg = ref(false);
const descTask = ref(null);
const descText = ref('');
const descImpDlg = ref(false);
function openDesc(t) {
  descTask.value = t;
  descText.value = t.desc || '';
  descDlg.value = true;
}
// HTML 片段 → 纯文本（team_task.desc 是纯文本列，插值展示会转义，不能存标签）
function htmlToText(h) {
  return String(h || '').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
}
async function onDescPicked({ document_id }) {
  try {
    const r = await api.feishuDocContent(document_id, 'html');
    descText.value = htmlToText(r.content);
    ElMessage.success(r.title ? `已读取「${r.title}」` : '✅ 已读取文档内容');
  } catch (e) { ElMessage.error(e.message); }
}
async function saveDesc() {
  const t = descTask.value;
  if (!t) return;
  await updateTask(t, { desc: descText.value.trim() });
  descDlg.value = false;
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

// 从「我的资源」引用：生成/复用分享链接，push 引用型附件（无 data 有 url，撤销后时间线处失效）
const resPickDlg = ref(false);
const onResourcePick = (r) => {
  reportAtts.value.push({ name: r.name, size: r.size, mime: r.mime, url: r.url });
  ElMessage.success(`已引用「${r.name}」`);
};

// 编辑已有汇报：预填内容与附件（附件浅拷贝，避免改坏时间线原数据）
function editLog(l) {
  reportHtml.value = l.content || '';
  reportAtts.value = normAtts(l.attachments).map((a) => ({ ...a }));
  editingLogId.value = l.id;
  reportDlg.value = true;
  // 嵌入式查看：查询该汇报是否已关联飞书文档（有则显示「在飞书打开」徽标）
  feishuDoc.value = l.feishu_url || '';
  feishuOpened.value = false;
}

async function submitReport() {
  const text = reportHtml.value.replace(/<[^>]*>/g, '').trim();
  if (!text && !reportAtts.value.length) return ElMessage.warning('写点今天的进展，或附上文件');
  try {
    if (editingLogId.value) {
      await api.teamLogUpdate(props.teamId, editingLogId.value, { content: reportHtml.value, attachments: reportAtts.value });
      ElMessage.success('汇报已更新');
    } else {
      await api.teamLog(props.teamId, { content: reportHtml.value, attachments: reportAtts.value });
      ElMessage.success('进度已汇报');
    }
    reportDlg.value = false;
    await reload();
  } catch (e) { ElMessage.error(e.message); }
}

// ---- 飞书编辑（P1）：进度汇报 ↔ 飞书文档（未提交过时先自动创建汇报记录，再在飞书里完善）
// 交互：查看 = 时间线嵌入式渲染 + 飞书徽标；编写 = 飞书新标签打开 + 时间线顶部横幅（同步/导入/打开）
const feishuBusy = ref(false);
const feishuDoc = ref('');      // 已关联飞书文档链接（显示「在飞书打开」）
const feishuOpened = ref(false); // 本次编辑已打开飞书（显示「飞书编辑中」状态条）
const lastLog = ref(null);      // 最近一次直跳创建的飞书汇报 {id, url} —— 横幅的同步/导入入口（弹窗只在点「✏️ 修改」后才有）

// 「📝 编写汇报」主按钮：直接跳飞书编辑页（后端自动创建汇报记录，写完后回站横幅「从飞书同步」/「从飞书导入」）
async function feishuNewLog() {
  feishuBusy.value = true;
  try {
    const r = await api.feishuBizOpen('progress_log', null, { team_id: props.teamId });
    lastLog.value = { id: r.id, url: r.url };
    window.open(r.url, '_blank');
    ElMessage.success(r.created ? '已创建飞书汇报文档并打开 — 写完后点上方横幅「🔄 从飞书同步」更新到这里' : '已同步最新内容，飞书文档已打开');
    await reload();
  } catch (e) { ElMessage.error(e.message); }
  finally { feishuBusy.value = false; }
}

// 从飞书导入：内容回填编辑器；无记录时后端自动创建（id 绑定编辑态，提交走更新而非新建）
function onImported(html, id) {
  reportHtml.value = html;
  if (id) editingLogId.value = id;
  reload();
}

async function feishuEditLog() {
  // 尚未提交过：先创建汇报记录拿 id（飞书文档需要业务记录 id）
  if (!editingLogId.value) {
    const text = reportHtml.value.replace(/<[^>]*>/g, '').trim();
    if (!text && !reportAtts.value.length) return ElMessage.warning('写点今天的进展，再转飞书编辑');
    try {
      const r = await api.teamLog(props.teamId, { content: reportHtml.value, attachments: reportAtts.value });
      editingLogId.value = r.id;
      await reload();
    } catch (e) { ElMessage.error(e.message); return; }
  }
  feishuBusy.value = true;
  try {
    const r = await api.feishuBizOpen('progress_log', editingLogId.value);
    feishuDoc.value = r.url || '';
    feishuOpened.value = true;
    window.open(r.url, '_blank');
    ElMessage.success(r.created ? '已创建飞书文档并打开，本站窗口保持可同步' : '已同步最新内容，飞书文档已打开');
    await reload();
  } catch (e) { ElMessage.error(e.message); }
  finally { feishuBusy.value = false; }
}
async function feishuSyncLog() {
  const pid = editingLogId.value || lastLog.value?.id;
  if (!pid) return ElMessage.warning('先点「飞书编辑」或「编写汇报」创建文档，再从飞书同步');
  feishuBusy.value = true;
  try {
    const r = await api.feishuBizSync('progress_log', pid);
    ElMessage.success(r.message || '✅ 已从飞书同步');
    await reload();
  } catch (e) { ElMessage.error(e.message); }
  finally { feishuBusy.value = false; }
}

async function removeLog(l) {
  try { await ElMessageBox.confirm('确定撤回这条进度汇报？评论与附件将一并删除', '撤回汇报', { type: 'warning' }); }
  catch { return; }
  try {
    await api.teamLogDelete(props.teamId, l.id);
    logs.value = logs.value.filter((x) => x.id !== l.id);
    ElMessage.success('汇报已撤回');
  } catch (e) { ElMessage.error(e.message); }
}

// 可编辑/撤回：本人或组长（Number 兜底，防类型不一致导致按钮不显示）
const canEditLog = (l) => Number(l.user_id) === Number(props.me.user_id) || props.me.is_owner;

// 作者角色（members 由 TeamDetail 传入，含 role_names 数组）
const roleNamesOf = (uid) => props.members?.find((x) => Number(x.id) === Number(uid))?.role_names || [];

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
        <el-button type="primary" :loading="feishuBusy" @click="feishuNewLog">📝 编写汇报（飞书）</el-button>
        <el-button plain :loading="feishuBusy" @click="impDlg = true">📥 从飞书导入</el-button>
      </div>
    </div>

    <!-- 汇报编写弹窗（富文本 + 附件，与浏览区分开） -->
    <el-dialog v-model="reportDlg" :title="editingLogId ? '✏️ 编辑进度汇报' : '📝 编写进度汇报'" width="640px" top="4vh" class="editor-dlg" :close-on-click-modal="false"
      destroy-on-close append-to-body>
      <!-- 可切到飞书文档写长文（P1）；未提交过时点按钮自动创建汇报再编辑；打开后本站留窗显示状态条 -->
      <div class="rp-feishu">
        <el-button size="small" type="primary" plain :loading="feishuBusy" @click="feishuEditLog">📄 飞书编辑</el-button>
        <el-button size="small" plain :loading="feishuBusy" @click="feishuSyncLog">🔄 从飞书同步</el-button>
        <el-button size="small" plain @click="impDlg = true">📥 从飞书导入</el-button>
      </div>
      <div v-if="feishuOpened" class="rp-feishu-open">
        ✅ 已在飞书打开该文档 — 在飞书写完后点「🔄 从飞书同步」更新到这里
      </div>
      <RichEditor v-model="reportHtml" placeholder="今天做了什么？卡在哪？下一步？" />
      <div class="rp-tools">
        <input ref="fileInput" type="file" multiple hidden @change="pickAtts" />
        <el-button size="small" @click="fileInput.click()">📎 附件（图片/音频/视频/文件）</el-button>
        <el-button size="small" plain @click="resPickDlg = true">📁 我的资源</el-button>
        <ResourcePicker v-model="resPickDlg" @pick="onResourcePick" />
        <span v-if="reportAtts.length" class="att-chips">
          <el-tag v-for="(a, i) in reportAtts" :key="i" closable size="small" class="att-tag" :title="a.name"
            @close="reportAtts.splice(i, 1)">
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

    <!-- 任务说明编辑弹窗（纯文本；可从飞书文档导入，HTML 转纯文本） -->
    <el-dialog v-model="descDlg" title="✏️ 编辑任务说明" width="480px" top="18vh" append-to-body :close-on-click-modal="false">
      <div class="rp-feishu">
        <el-button size="small" plain @click="descImpDlg = true">📥 从飞书导入</el-button>
      </div>
      <el-input v-model="descText" type="textarea" :rows="4" placeholder="任务说明（纯文本，导入的飞书文档会自动转为文本）" />
      <template #footer>
        <el-button @click="descDlg = false">取消</el-button>
        <el-button type="primary" @click="saveDesc">保存</el-button>
      </template>
    </el-dialog>
    <!-- 从飞书导入文档选择器（弹窗与横幅共用；必须挂弹窗外面——弹窗 destroy-on-close 会销毁内部组件，横幅导入将无反应） -->
    <DocPicker v-model="impDlg" biz-type="progress_log" :biz-id="editingLogId ?? lastLog?.id ?? null"
      :extra="{ team_id: props.teamId }" @imported="onImported" />
    <DocPicker v-model="descImpDlg" raw @picked="onDescPicked" />

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
        <div v-if="t.desc" class="tc-desc">
          {{ t.desc }}
          <el-button v-if="canEditTask(t)" size="small" text type="primary" class="desc-edit" @click="openDesc(t)">✏️</el-button>
        </div>
        <div v-else-if="canEditTask(t)" class="tc-desc"><el-button size="small" text type="primary" @click="openDesc(t)">✏️ 添加说明</el-button></div>
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
      <!-- 直跳横幅：主按钮「编写汇报」进飞书后，本站唯一的同步/导入入口（弹窗需点「✏️ 修改」才有） -->
      <div v-if="lastLog" class="rp-banner">
        <span>🪶 最近从飞书编写：</span>
        <a :href="lastLog.url" target="_blank" rel="noopener">📄 在飞书打开 →</a>
        <el-button size="small" :loading="feishuBusy" @click="feishuSyncLog">🔄 从飞书同步</el-button>
        <el-button size="small" @click="impDlg = true">📥 从飞书导入</el-button>
        <el-button size="small" text class="banner-close" @click="lastLog = null">✕</el-button>
      </div>
      <el-timeline v-if="logs.length">
        <el-timeline-item v-for="l in logs" :key="l.id" :timestamp="l.create_time?.slice(5, 16)">
          <!-- 作者行：汇报者 + 修改/撤回（本人或组长） -->
          <div class="log-head">
            <span class="log-avatar u-link" v-if="l.avatar" @click="toProfile(l)"><img :src="l.avatar" alt="" /></span>
            <span class="log-author u-link" @click="toProfile(l)">{{ l.nickname || '未知成员' }}</span>
            <el-tag v-for="rn in roleNamesOf(l.user_id)" :key="rn" size="small" effect="plain">{{ rn }}</el-tag>
            <el-tag v-if="Number(l.user_id) === Number(me.user_id)" size="small" type="info">我</el-tag>
            <span class="log-actions">
              <el-button v-if="canEditLog(l)" size="small" text type="primary" @click="editLog(l)">✏️ 修改</el-button>
              <el-button v-if="canEditLog(l)" size="small" text type="danger" @click="removeLog(l)">↩️ 撤回</el-button>
            </span>
          </div>
          <!-- 嵌入式查看：该汇报已关联飞书文档 → 徽标 + 在飞书打开 -->
          <div v-if="l.feishu_url" class="rp-feishu-link">
            🪶 已关联飞书文档 <a :href="l.feishu_url" target="_blank" rel="noopener">📄 在飞书打开 →</a>
          </div>
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
  .tp-overall { display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    .tp-label { font-size: 13px; color: var(--text-2); white-space: nowrap; }
  }
}
.rp-feishu { display: flex; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; }
// 嵌入式查看：飞书文档徽标（时间线条目顶部）
.rp-feishu-link {
  display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
  font-size: 12.5px; color: var(--text-2); background: var(--primary-tint); border: 1px solid color-mix(in srgb, var(--primary) 30%, white);
  border-radius: 8px; padding: 6px 12px; margin: 4px 0 8px;
  a { color: var(--primary); font-weight: 600; text-decoration: none; &:hover { text-decoration: underline; } }
}
// 编写留窗状态条：飞书打开后提示回站同步
.rp-feishu-open {
  font-size: 12.5px; color: var(--success-fg); background: var(--success-tint); border: 1px solid var(--success-border);
  border-radius: 8px; padding: 6px 12px; margin-bottom: 6px;
}
// 直跳横幅：时间线顶部（最近一次飞书编写的同步/导入入口）
.rp-banner {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  font-size: 12.5px; color: var(--primary-dark); background: var(--primary-tint); border: 1px solid color-mix(in srgb, var(--primary) 30%, white);
  border-radius: 8px; padding: 6px 12px; margin-bottom: 10px;
  a { color: var(--primary); font-weight: 600; text-decoration: none; &:hover { text-decoration: underline; } }
  .banner-close { margin-left: auto; }
}
.rp-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px;
  .att-chips { display: flex; gap: 4px; flex-wrap: wrap; }
  // 附件名不换行：过长省略号 + title 悬浮全名（断行会竖排挤压排版）
  .att-tag {
    max-width: 240px; vertical-align: middle;
    :deep(.el-tag__content) {
      display: inline-block; max-width: 200px; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; vertical-align: middle;
    }
  }
  .rp-tip { margin-left: auto; color: #94a3b8; font-size: 12px; }
}
.log-rich { line-height: 1.8; font-size: 13.5px;
  :deep(img) { max-width: 100%; max-height: 320px; border-radius: 8px; cursor: zoom-in; }
  :deep(video) { max-width: 100%; max-height: 320px; border-radius: 8px; }
  :deep(a) { color: var(--primary); }
}
.tp-tasks {
  .tp-tools { display: flex; justify-content: space-between; align-items: center; h4 { margin: 0 0 10px; } }
  .task-new { display: flex; gap: 8px; flex-wrap: wrap; background: var(--surface-3); border: 1px dashed var(--border); border-radius: 10px; padding: 10px; margin-bottom: 10px; }
  .tp-empty { color: #94a3b8; font-size: 13px; padding: 14px 0; }
  .task-card {
    border: 1px solid var(--border); border-left: 3px solid #94a3b8; border-radius: 10px; padding: 10px 12px; margin-bottom: 10px;
    &.done { border-left-color: #16a34a; background: var(--success-tint); }
    &.doing { border-left-color: #f59e0b; }
    .tc-top { display: flex; justify-content: space-between; align-items: center; b { font-size: 14px; } }
    .tc-desc { color: var(--text-2); font-size: 13px; margin: 4px 0;
      .desc-edit { margin-left: 2px; padding: 0 4px; }
    }
    .tc-meta { display: flex; gap: 12px; color: var(--text-2); font-size: 12px; margin-bottom: 6px; flex-wrap: wrap;
      .tc-date { margin-left: auto; }
    }
    .tc-progress { display: flex; align-items: center; gap: 8px; }
  }
  // 移动端：进度条独占一行，状态/进度/删除控件换到下一行（窄屏单行放不下）
  @media (max-width: 768px) {
    .tc-progress { flex-wrap: wrap; }
    .tc-progress .el-progress { flex: 1 1 100% !important; } /* 压过内联 style="flex:1" */
  }
}
.tp-logs { margin-top: 18px; h4 { margin: 0 0 10px; } .tp-empty { color: #94a3b8; font-size: 13px; padding: 14px 0; } }
.log-head {
  display: flex; align-items: center; gap: 8px; margin-bottom: 8px;
  .log-avatar {
    width: 26px; height: 26px; border-radius: 50%; overflow: hidden; flex-shrink: 0;
    display: inline-flex; align-items: center; justify-content: center;
    background: var(--primary)1a; border: 1px solid var(--primary)33;
    img { width: 100%; height: 100%; object-fit: cover; }
  }
  .log-author { font-size: 13.5px; font-weight: 600; }
  .u-link { cursor: pointer; &:hover { color: var(--primary); } }
  .log-actions { margin-left: auto; display: flex; gap: 2px; }
}
.log-rich {
  :deep(video) { max-width: 100%; max-height: 320px; border-radius: 8px; }
  :deep(iframe) { width: 100%; max-width: 640px; height: 360px; border-radius: 8px; border: none; }
}
</style>
