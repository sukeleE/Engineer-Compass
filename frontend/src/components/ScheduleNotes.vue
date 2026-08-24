<script setup>
// 日程笔记面板（备赛日程页右侧）：每日富文本笔记 + 学习状态 + 本月历史回看
// 与月历联动：切换月份/日期即切换视角；父组件通过 active 通知可见时刷新
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
    applyDate();
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
    ElMessage.success('已删除');
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    deleting.value = false;
  }
}

function goDate(d) {
  date.value = d; // 触发 watch → applyDate
}

// 可见（视图切回 / 首次挂载）时刷新，保证与月历新增的笔记同步
function refresh() {
  loadMonth().then(applyDate);
}
watch(() => props.active, (v) => { if (v) refresh(); });
// 任何日期变更都回填对应笔记（同月历史点击走这里；跨月由 onDateChange 拉新数据后再回填）
watch(date, applyDate);
onMounted(() => { if (props.active) refresh(); });
</script>

<template>
  <div class="sn-panel">
    <div class="sn-head">
      <b>📝 日程笔记</b>
      <span class="sn-sub">每日学习记录 · 月历点击日期可回看</span>
    </div>

    <!-- 日期 + 学习状态 -->
    <div class="sn-tools">
      <el-date-picker v-model="date" type="date" value-format="YYYY-MM-DD" size="small"
        :clearable="false" class="sn-date" @change="onDateChange" />
      <el-select v-model="status" size="small" placeholder="今日状态" clearable class="sn-status">
        <el-option v-for="st in NOTE_STATUS" :key="st.key" :value="st.key"
          :label="`${st.emoji} ${st.label}`" />
      </el-select>
    </div>

    <!-- 关联备赛（选填，日历回看时展示竞赛名） -->
    <el-select v-if="schedules.length" v-model="scheduleId" size="small" clearable filterable
      placeholder="关联备赛（选填）" class="sn-schedule">
      <el-option v-for="s in schedules" :key="s.id" :value="s.id" :label="s.comp_name" />
    </el-select>

    <div v-loading="loading" class="sn-editor-wrap">
      <RichEditor v-model="content" placeholder="今天学了什么？卡在哪？明天做什么…" />
      <div class="sn-actions">
        <el-button size="small" type="primary" :loading="saving" @click="saveNote">💾 保存</el-button>
        <el-button v-if="activeNote" size="small" type="danger" plain :loading="deleting" @click="deleteNote(activeNote)">
          删除今日笔记
        </el-button>
      </div>
    </div>

    <!-- 本月历史 -->
    <div class="sn-list-head">本月笔记（{{ history.length }}）</div>
    <div class="sn-list">
      <div v-for="n in history" :key="n.id" class="sn-item" :class="{ cur: n.note_date === date }"
        :title="'回看 ' + n.note_date" @click="goDate(n.note_date)">
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
      <span v-if="!history.length" class="sn-empty">这个月还没有笔记 — 从上方开始记录吧</span>
    </div>
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

  .sn-tools { display: flex; gap: 8px; margin-bottom: 8px;
    .sn-date { flex: 1; }
    .sn-status { width: 128px; }
  }
  .sn-schedule { width: 100%; margin-bottom: 8px; }

  .sn-editor-wrap { :deep(.re-body) { height: 170px; } }

  .sn-actions { display: flex; gap: 8px; margin-top: 8px; }

  .sn-list-head { margin: 14px 0 6px; font-size: 12.5px; color: var(--text-2); font-weight: 600; }

  .sn-list { display: flex; flex-direction: column; gap: 6px; }

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
</style>
