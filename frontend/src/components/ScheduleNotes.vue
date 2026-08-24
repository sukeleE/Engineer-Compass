<script setup>
// 日程笔记面板（备赛日程页右侧）：每日富文本笔记 + 学习状态 + 本月历史回看
// 编写/回看统一走「📝 写笔记 / 点历史条目」→ 居中大弹窗（查看/编辑/删除）
import { ref, computed, watch, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api.js';
import RichEditor from './team/RichEditor.vue';
import { NOTE_STATUS, statusOf, excerpt, fmtDate } from '../utils/noteStatus.js';

const props = defineProps({
  schedules: { type: Array, default: () => [] }, // 供「关联备赛」选择
  active: { type: Boolean, default: true },      // 视图可见 → 自动刷新（月历里保存的笔记回来能看到）
});

const date = ref(fmtDate(new Date()));
const status = ref('');
const content = ref('');
const scheduleId = ref(null);
const monthNotes = ref([]);
const saving = ref(false);
const deleting = ref(false);
const loading = ref(false);
const dlg = ref(false);      // 笔记弹窗
const dlgMode = ref('edit'); // view 回看 | edit 编写/编辑

// 当前日期对应的笔记（本月列表内查找；跨月时重拉列表）
const activeNote = computed(() => monthNotes.value.find((n) => n.note_date === date.value) || null);

// 历史列表：按日期倒序；同日期多条（登录后遗留的 'local' 旧笔记）只保留一条
const history = computed(() => {
  const seen = new Set();
  return monthNotes.value.filter((n) => !seen.has(n.note_date) && seen.add(n.note_date));
});

async function loadMonth() {
  loading.value = true;
  try {
    monthNotes.value = await api.notesMonth(date.value.slice(0, 7));
  } catch (e) {
    ElMessage.error(`加载笔记失败：${e.message}`);
  } finally {
    loading.value = false;
  }
}

// 把日期对应笔记填入编辑器（无笔记则清空）
function applyDate() {
  const n = activeNote.value;
  content.value = n?.content || '';
  status.value = n?.status || '';
  scheduleId.value = n?.schedule_id ?? null;
}

function onDateChange() {
  // 跨月切换：先拉新月份列表，再按新月份数据回填编辑器
  loadMonth().then(applyDate);
}

// 打开笔记弹窗：d 目标日期；mode view（有笔记回看）/ edit（编写或编辑）
function openDlg(d, mode) {
  date.value = d;
  dlgMode.value = mode;
  applyDate(); // 与当前日期相同时 watch 不触发，手动回填
  dlg.value = true;
}

// 编辑态切到查看态（保存后回看刚写的内容）
function backToView() {
  dlgMode.value = 'view';
  applyDate();
}

async function saveNote() {
  if (!content.value.trim() && !status.value) return ElMessage.warning('写点内容或选个状态再保存');
  saving.value = true;
  try {
    await api.noteSave({
      note_date: date.value,
      content: content.value,
      status: status.value,
      schedule_id: scheduleId.value || null,
    });
    await loadMonth();
    backToView();
    ElMessage.success('📝 笔记已保存');
  } catch (e) {
    ElMessage.error(`保存失败：${e.message}`);
  } finally {
    saving.value = false;
  }
}

async function deleteNote(n) {
  if (!n) return;
  deleting.value = true;
  try {
    await api.noteDelete(n.id);
    if (n.note_date === date.value) {
      content.value = '';
      status.value = '';
      scheduleId.value = null;
    }
    await loadMonth();
    dlg.value = false;
    ElMessage.success('已删除');
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    deleting.value = false;
  }
}

// 可见（视图切回 / 首次挂载）时刷新，保证与月历新增的笔记同步
function refresh() {
  loadMonth().then(applyDate);
}
watch(() => props.active, (v) => { if (v) refresh(); });
watch(date, applyDate);
onMounted(() => { if (props.active) refresh(); });
</script>

<template>
  <div class="sn-panel">
    <div class="sn-head">
      <b>📝 日程笔记</b>
      <span class="sn-sub">每日学习记录 · 点日期可回看</span>
    </div>

    <el-button type="primary" class="sn-write" size="large" @click="openDlg(date, 'edit')">📝 写笔记</el-button>

    <div class="sn-list-head">本月笔记（{{ history.length }}）</div>
    <div class="sn-list" v-loading="loading">
      <div v-for="n in history" :key="n.id" class="sn-item" :class="{ cur: n.note_date === date }"
        :title="'回看 ' + n.note_date" @click="openDlg(n.note_date, 'view')">
        <span class="sn-dot" :style="statusOf(n.status) ? { background: statusOf(n.status).color } : {}" />
        <div class="sn-item-main">
          <div class="sn-item-top">
            {{ n.note_date.slice(5) }}
            <template v-if="statusOf(n.status)">· {{ statusOf(n.status).emoji }} {{ statusOf(n.status).label }}</template>
          </div>
          <div class="sn-item-ex">{{ excerpt(n.content) }}</div>
        </div>
        <el-button text size="small" type="danger" title="删除该笔记" @click.stop="deleteNote(n)">🗑</el-button>
      </div>
      <span v-if="!history.length" class="sn-empty">这个月还没有笔记 — 点上方「写笔记」开始记录吧</span>
    </div>

    <!-- 编写 / 回看弹窗（居中大尺寸） -->
    <el-dialog v-model="dlg" :title="`${date} ${['周日','周一','周二','周三','周四','周五','周六'][new Date(date + 'T00:00:00').getDay()]}${dlgMode === 'edit' ? ' · 编辑' : ''}`"
      width="780px" top="6vh" :close-on-click-modal="false" destroy-on-close append-to-body>
      <!-- 回看模式 -->
      <template v-if="dlgMode === 'view' && activeNote">
        <div v-if="statusOf(activeNote.status)" class="dn-status"
          :style="{ color: statusOf(activeNote.status).color, background: statusOf(activeNote.status).color + '1a' }">
          {{ statusOf(activeNote.status).emoji }} 今日状态：{{ statusOf(activeNote.status).label }}
        </div>
        <div v-if="activeNote.content" class="dn-body" v-html="activeNote.content"></div>
        <div v-else class="dn-empty">这天只记录了状态，没有文字内容</div>
      </template>
      <!-- 编写 / 编辑模式 -->
      <template v-else>
        <div class="dn-tools">
          <el-date-picker v-model="date" type="date" value-format="YYYY-MM-DD" size="small"
            :clearable="false" @change="onDateChange" />
          <el-select v-model="status" size="small" placeholder="今日学习状态" clearable>
            <el-option v-for="st in NOTE_STATUS" :key="st.key" :value="st.key"
              :label="`${st.emoji} ${st.label}`" />
          </el-select>
          <el-select v-if="schedules.length" v-model="scheduleId" size="small" clearable filterable
            placeholder="关联备赛（选填）" class="dn-schedule">
            <el-option v-for="s in schedules" :key="s.id" :value="s.id" :label="s.comp_name" />
          </el-select>
        </div>
        <RichEditor v-model="content" placeholder="今天学了什么？卡在哪？明天做什么…（支持插图 / 粘贴视频链接）" />
      </template>
      <template #footer>
        <template v-if="dlgMode === 'view' && activeNote">
          <el-button size="small" type="danger" plain :loading="deleting" @click="deleteNote(activeNote)">🗑 删除</el-button>
          <el-button size="small" type="primary" plain @click="dlgMode = 'edit'">✏️ 编辑</el-button>
        </template>
        <template v-else>
          <el-button size="small" @click="dlg = false">取消</el-button>
          <el-button v-if="activeNote" size="small" type="danger" plain :loading="deleting"
            @click="deleteNote(activeNote)">🗑 删除</el-button>
          <el-button size="small" type="primary" :loading="saving" @click="saveNote">💾 保存</el-button>
        </template>
      </template>
    </el-dialog>
  </div>
</template>

<style lang="scss" scoped>
.sn-panel {
  width: 340px; flex-shrink: 0; position: sticky; top: 12px;
  max-height: calc(100vh - 60px); overflow-y: auto;
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px;
  padding: 12px 14px; box-shadow: 0 2px 10px rgba(0, 0, 0, .05);
  scrollbar-width: thin;

  .sn-head {
    display: flex; align-items: baseline; gap: 8px; margin-bottom: 10px;
    b { font-size: 15px; }
    .sn-sub { font-size: 11px; color: var(--text-2); }
  }

  .sn-write { width: 100%; margin-bottom: 12px; }

  .sn-list-head { margin: 0 0 6px; font-size: 12.5px; color: var(--text-2); font-weight: 600; }

  .sn-list { display: flex; flex-direction: column; gap: 6px; min-height: 40px; }

  .sn-item {
    display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 8px;
    border: 1px solid var(--border); cursor: pointer; background: #fff;
    transition: all .15s;
    &:hover { border-color: #93c5fd; background: #eff6ff; }
    &.cur { border-color: #2563eb; background: #eff6ff; }

    .sn-dot { width: 8px; height: 8px; border-radius: 50%; background: #e2e8f0; flex-shrink: 0; }
    .sn-item-main { flex: 1; min-width: 0; }
    .sn-item-top { font-size: 12px; font-weight: 600; }
    .sn-item-ex {
      font-size: 11.5px; color: var(--text-2); white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis;
    }
  }

  .sn-empty { color: #94a3b8; font-size: 12px; padding: 8px 0; text-align: center; }
}

// 弹窗内
.dn-tools { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap;
  .el-date-picker { width: 150px; }
  .dn-schedule { width: 200px; }
}
.dn-status { display: inline-block; font-size: 13px; font-weight: 600; padding: 4px 12px; border-radius: 999px; margin-bottom: 12px; }
.dn-body { line-height: 1.9; font-size: 14px; max-height: 55vh; overflow-y: auto;
  :deep(img) { max-width: 100%; border-radius: 8px; }
  :deep(video) { max-width: 100%; border-radius: 8px; }
  :deep(iframe) { width: 100%; max-width: 640px; height: 360px; border-radius: 8px; border: none; }
  :deep(a) { color: #2563eb; }
}
.dn-empty { color: #94a3b8; font-size: 13px; text-align: center; padding: 40px 0; }
</style>
