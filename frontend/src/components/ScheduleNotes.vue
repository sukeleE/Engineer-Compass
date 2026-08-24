<script setup>
// 日程笔记浮窗（日程规划页三个 tab 共享）：可拖动手柄、可收起；点「写笔记」或历史条目 → 居中大弹窗
// 编写/回看统一走弹窗（查看/编辑/删除/切换日期）
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api.js';
import RichEditor from './team/RichEditor.vue';
import { NOTE_STATUS, statusOf, excerpt, fmtDate } from '../utils/noteStatus.js';

const props = defineProps({
  schedules: { type: Array, default: () => [] }, // 供「关联备赛」选择
  active: { type: Boolean, default: true },      // 视图可见 → 自动刷新
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

// —— 浮窗：收起 / 拖动 ——
const collapsed = ref(false);
const dragRef = ref(null);
const pos = ref({ left: null, top: null }); // null → 默认右下角
const dragging = ref(null);
function dragStart(e) {
  if (e.target.closest('button')) return; // 不干扰按钮点击
  const el = dragRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  dragging.value = { sx: e.clientX, sy: e.clientY, ox: rect.left, oy: rect.top };
  window.addEventListener('pointermove', dragMove);
  window.addEventListener('pointerup', dragEnd);
  e.preventDefault();
}
function dragMove(e) {
  if (!dragging.value) return;
  const x = dragging.value.ox + e.clientX - dragging.value.sx;
  const y = dragging.value.oy + e.clientY - dragging.value.sy;
  pos.value = {
    left: Math.max(0, Math.min(x, window.innerWidth - 340)),
    top: Math.max(0, Math.min(y, window.innerHeight - 50)),
  };
}
function dragEnd() {
  dragging.value = null;
  window.removeEventListener('pointermove', dragMove);
  window.removeEventListener('pointerup', dragEnd);
}
onBeforeUnmount(() => {
  window.removeEventListener('pointermove', dragMove);
  window.removeEventListener('pointerup', dragEnd);
});

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
  <div ref="dragRef" class="sn-float" :style="pos.left !== null ? { left: pos.left + 'px', top: pos.top + 'px' } : {}">
    <!-- 拖拽手柄 + 收起/展开 -->
    <div class="sn-head" @pointerdown.prevent="dragStart">
      <b>📝 日程笔记</b>
      <span class="sn-sub">拖动此栏可移动</span>
      <el-button size="small" text class="sn-ctl" :title="collapsed ? '展开' : '收起'"
        @click="collapsed = !collapsed">{{ collapsed ? '⤢ 展开' : '⤡ 收起' }}</el-button>
    </div>

    <template v-if="!collapsed">
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
    </template>

    <!-- 编写 / 回看弹窗（居中大尺寸） -->
    <el-dialog v-model="dlg" :title="`${date} ${['周日','周一','周二','周三','周四','周五','周六'][new Date(date + 'T00:00:00').getDay()]}${dlgMode === 'edit' ? ' · 编辑' : ''}`"
      width="640px" top="4vh" class="editor-dlg" :close-on-click-modal="false" destroy-on-close append-to-body>
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
// 浮窗：fixed 右下角，可拖动（拖动后 left/top 覆盖 right/bottom），三 tab 共享
.sn-float {
  position: fixed; right: 18px; bottom: 18px; z-index: 900;
  width: 330px; max-height: calc(100vh - 70px); overflow-y: auto;
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px;
  padding: 10px 12px; box-shadow: 0 8px 28px rgba(15, 23, 42, .16);
  scrollbar-width: thin;

  .sn-head {
    display: flex; align-items: center; gap: 8px; margin-bottom: 10px;
    cursor: move; user-select: none; padding: 2px 0;
    b { font-size: 15px; }
    .sn-sub { font-size: 11px; color: var(--text-2); flex: 1; }
    .sn-ctl { margin-left: auto; flex-shrink: 0; }
  }

  .sn-write { width: 100%; margin-bottom: 10px; }

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
