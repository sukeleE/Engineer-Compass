<script setup>
// 月历视图：竞赛/学习/小组任务完成事项按完成日期（done_at）落格 + 当日笔记
// 格内只显示 emoji（🏆竞赛 / 📚学习 / 🏗️小组 / 📝笔记，每个完成任务一个）；点击某日 → 弹窗显示当日完成明细 + 笔记回看/编辑
// 底部「✅ 已完成计划」：任何计划任务全部完成即计入
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api.js';
import RichEditor from './team/RichEditor.vue';
import auth from '../auth.js';
import { NOTE_STATUS, statusOf, fmtDate, pad2 } from '../utils/noteStatus.js';

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const TYPE_META = {
  comp: { emoji: '🏆', label: '竞赛' },
  study: { emoji: '📚', label: '学习' },
  team: { emoji: '🏗️', label: '小组' },
};

const calY = ref(new Date().getFullYear());
const calM = ref(new Date().getMonth()); // 0-11
const calData = ref({ comp: [], study: [], team: [], notes: [] }); // 当月聚合
const calLoading = ref(false);
const todayStr = fmtDate(new Date());

// 竞赛/学习全量列表（已完成计划计算用）；小组用 teamMyTasks
const schedules = ref([]);
const studies = ref([]);
const teamTasks = ref([]);

const ym = () => `${calY.value}-${pad2(calM.value + 1)}`;

async function loadCal() {
  calLoading.value = true;
  try {
    const [agg, list] = await Promise.all([
      api.calendarMonth(ym()),
      api.scheduleList(),
    ]);
    calData.value = agg;
    schedules.value = list.map((s) => ({ ...s, plan: undefined, phases: s.plan?.phases || [] }));
  } catch (e) {
    ElMessage.error(`加载月历失败：${e.message}`);
  } finally {
    calLoading.value = false;
  }
}
function calShift(dm) {
  calM.value += dm;
  if (calM.value > 11) { calM.value = 0; calY.value++; }
  if (calM.value < 0) { calM.value = 11; calY.value--; }
  loadCal();
}
function calGoToday() {
  calY.value = new Date().getFullYear();
  calM.value = new Date().getMonth();
  loadCal();
}

// ---- 月历格：按日期聚合当月完成事项 + 笔记 ----
const byDate = computed(() => {
  const map = {};
  const push = (date, key, item) => {
    if (!map[date]) map[date] = { date, comp: [], study: [], team: [], note: null };
    map[date][key].push(item);
  };
  for (const x of calData.value.comp) push(x.date, 'comp', x);
  for (const x of calData.value.study) push(x.date, 'study', x);
  for (const x of calData.value.team) push(x.date, 'team', x);
  for (const n of calData.value.notes) {
    if (!map[n.note_date]) map[n.note_date] = { date: n.note_date, comp: [], study: [], team: [], note: null };
    map[n.note_date].note = n;
  }
  return map;
});

const calCells = computed(() => {
  const days = new Date(calY.value, calM.value + 1, 0).getDate();
  const firstDow = new Date(calY.value, calM.value, 1).getDay(); // 0=周日
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= days; d++) {
    const ds = `${calY.value}-${pad2(calM.value + 1)}-${pad2(d)}`;
    cells.push({ date: ds, day: d, isToday: ds === todayStr, ...(byDate.value[ds] || { comp: [], study: [], team: [], note: null }) });
  }
  return cells;
});

// 格内 emoji 堆：每个完成任务一个 emoji（同类型相同），最多 4 个 + "+n"
const cellEmojis = (c) => {
  const list = [];
  for (const key of ['comp', 'study', 'team']) {
    for (let i = 0; i < c[key].length; i++) list.push(TYPE_META[key].emoji);
  }
  if (c.note) list.push('📝');
  return list;
};

// ---- 点击某日 → 弹窗：当日完成明细（按类型分组）+ 笔记回看/编辑 ----
const calDlg = ref(false);
const calDlgDate = ref('');
const calDlgItems = ref({ comp: [], study: [], team: [] });
const calDlgNote = ref(null);
const calDlgMode = ref('view'); // view 回看 | edit 记录/编辑
const dlgStatus = ref('');
const dlgContent = ref('');
const dlgSaving = ref(false);
const dlgDeleting = ref(false);

function openCalDay(c) {
  calDlgDate.value = c.date;
  calDlgItems.value = { comp: c.comp, study: c.study, team: c.team };
  calDlgNote.value = c.note;
  dlgStatus.value = c.note?.status || '';
  dlgContent.value = c.note?.content || '';
  calDlgMode.value = c.note ? 'view' : 'edit';
  calDlg.value = true;
}
const dlgHasItems = computed(() => ['comp', 'study', 'team'].some((k) => calDlgItems.value[k].length));
async function calDlgSave() {
  if (!dlgContent.value.trim() && !dlgStatus.value) return ElMessage.warning('写点内容或选个状态再保存');
  dlgSaving.value = true;
  try {
    const res = await api.noteSave({
      note_date: calDlgDate.value, content: dlgContent.value, status: dlgStatus.value,
    });
    await loadCal();
    calDlgNote.value = { id: res.id, note_date: calDlgDate.value, status: dlgStatus.value, content: dlgContent.value };
    calDlgMode.value = 'view';
    ElMessage.success('📝 笔记已保存');
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    dlgSaving.value = false;
  }
}
async function calDlgDelete() {
  if (!calDlgNote.value) return;
  dlgDeleting.value = true;
  try {
    await api.noteDelete(calDlgNote.value.id);
    calDlgNote.value = null;
    dlgContent.value = '';
    dlgStatus.value = '';
    calDlgMode.value = 'edit';
    await loadCal();
    ElMessage.success('已删除');
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    dlgDeleting.value = false;
  }
}

// ---- 底部「✅ 已完成计划」：任务全部完成即计入（含完成日期 = 最后任务完成日）----
const planState = (tasks) => {
  const all = tasks || [];
  const done = all.filter((t) => t.done).length;
  const dates = all.filter((t) => t.done && t.done_at).map((t) => t.done_at).sort();
  return { done, total: all.length, date: dates.length ? dates[dates.length - 1] : null };
};
const donePlans = computed(() => {
  const out = { comp: [], study: [], team: [] };
  for (const s of schedules.value) {
    const st = planState((s.phases || []).flatMap((p) => p.tasks || []));
    if (st.total > 0 && st.done === st.total) out.comp.push({ name: s.comp_name || '我的日程', ...st });
  }
  for (const s of studies.value) {
    const st = planState((s.plan?.phases || []).flatMap((p) => p.tasks || []));
    if (st.total > 0 && st.done === st.total) out.study.push({ name: s.topic || '学习日程', ...st });
  }
  for (const t of teamTasks.value) {
    for (const p of t.plans || []) {
      const st = planState((p.phases || []).flatMap((ph) => ph.tasks || []));
      if (st.total > 0 && st.done === st.total) out.team.push({ name: `${t.team_name} · ${p.title}`, ...st });
    }
  }
  return out;
});
const hasDonePlans = computed(() => donePlans.value.comp.length + donePlans.value.study.length + donePlans.value.team.length > 0);

onMounted(() => {
  loadCal();
  if (auth.token) {
    api.studyList().then((r) => { studies.value = r; }).catch((e) => ElMessage.error(`加载学习日程失败：${e.message}`));
    api.teamMyTasks().then((r) => { teamTasks.value = r; }).catch((e) => ElMessage.error(`加载小组任务失败：${e.message}`));
  }
});
</script>

<template>
  <div class="cal-wrap">
    <div class="cal-toolbar">
      <el-button size="small" @click="calShift(-1)">‹ 上月</el-button>
      <b class="cal-ym">{{ calY }} 年 {{ calM + 1 }} 月</b>
      <el-button size="small" @click="calShift(1)">下月 ›</el-button>
      <el-button size="small" text @click="calGoToday">回到本月</el-button>
      <span class="cal-hint">💡 点击日期查看当天完成的事与笔记</span>
    </div>
    <div v-loading="calLoading" class="cal-box">
      <div class="cal-week">
        <span v-for="w in ['日', '一', '二', '三', '四', '五', '六']" :key="w">{{ w }}</span>
      </div>
      <div class="cal-grid">
        <div v-for="(c, i) in calCells" :key="i" class="cal-cell"
          :class="{ blank: !c, today: c?.isToday, hasnote: c?.note }" @click="c && openCalDay(c)">
          <template v-if="c">
            <div class="cal-day">{{ c.day }}</div>
            <div class="cal-emojis" :title="`${c.comp.length} 竞赛 · ${c.study.length} 学习 · ${c.team.length} 小组${c.note ? ' · 有笔记' : ''}`">
              <template v-for="(e, j) in cellEmojis(c).slice(0, 4)" :key="j"><span class="cal-emoji">{{ e }}</span></template>
              <span v-if="cellEmojis(c).length > 4" class="cal-more">+{{ cellEmojis(c).length - 4 }}</span>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- ✅ 已完成计划：任何计划任务全部完成即计入 -->
    <div v-if="hasDonePlans || auth.token" class="done-plans">
      <h4>✅ 已完成计划</h4>
      <div class="dp-grid">
        <div v-if="donePlans.comp.length" class="dp-sec">
          <div class="dp-sec-title">🏆 竞赛</div>
          <div v-for="(p, i) in donePlans.comp" :key="'c' + i" class="dp-item">
            <b>{{ p.name }}</b>
            <span class="dp-badge">✓ {{ p.done }}/{{ p.total }}</span>
            <span v-if="p.date" class="dp-date">完成于 {{ p.date }}</span>
          </div>
        </div>
        <div v-if="donePlans.study.length" class="dp-sec">
          <div class="dp-sec-title">📚 学习</div>
          <div v-for="(p, i) in donePlans.study" :key="'s' + i" class="dp-item">
            <b>{{ p.name }}</b>
            <span class="dp-badge">✓ {{ p.done }}/{{ p.total }}</span>
            <span v-if="p.date" class="dp-date">完成于 {{ p.date }}</span>
          </div>
        </div>
        <div class="dp-sec">
          <div class="dp-sec-title">🏗️ 小组</div>
          <template v-if="auth.token">
            <div v-for="(p, i) in donePlans.team" :key="'t' + i" class="dp-item">
              <b>{{ p.name }}</b>
              <span class="dp-badge">✓ {{ p.done }}/{{ p.total }}</span>
              <span v-if="p.date" class="dp-date">完成于 {{ p.date }}</span>
            </div>
            <div v-if="!donePlans.team.length" class="dp-none">暂无已全部完成的小组计划</div>
          </template>
          <div v-else class="dp-none">🔒 登录后同步小组任务</div>
        </div>
      </div>
    </div>

    <!-- 点击日期 → 当日完成明细 + 笔记回看 / 编辑 -->
    <el-dialog v-model="calDlg" :title="`${calDlgDate} ${WEEK_CN[new Date(calDlgDate + 'T00:00:00').getDay()]}`" width="640px" top="4vh" class="editor-dlg" destroy-on-close>
      <!-- ✅ 当日完成事项：按类型 emoji 分组 -->
      <div class="dlg-items">
        <template v-if="dlgHasItems">
          <template v-for="key in ['comp', 'study', 'team']" :key="key">
            <div v-if="calDlgItems[key].length" class="di-group">
              <div class="di-title">{{ TYPE_META[key].emoji }} {{ TYPE_META[key].label }}</div>
              <div v-for="(it, i) in calDlgItems[key]" :key="i" class="di-item">
                <b>{{ it.plan_name }}</b>
                <span class="di-task">{{ it.task }}</span>
              </div>
            </div>
          </template>
        </template>
        <div v-else class="di-none">✨ 这天没有完成的事项</div>
      </div>

      <!-- 📝 笔记区 -->
      <div class="dlg-note-sec">
        <div v-if="calDlgMode === 'view' && calDlgNote" class="dlg-note-view">
          <div v-if="statusOf(calDlgNote.status)" class="dlg-status"
            :style="{ color: statusOf(calDlgNote.status).color, background: statusOf(calDlgNote.status).color + '1a' }">
            {{ statusOf(calDlgNote.status).emoji }} 今日状态：{{ statusOf(calDlgNote.status).label }}
          </div>
          <div v-if="calDlgNote.content" class="dlg-body" v-html="calDlgNote.content"></div>
          <div v-else class="dlg-empty">这天只记录了状态，没有文字内容</div>
        </div>
        <div v-else>
          <el-select v-model="dlgStatus" size="small" placeholder="今日学习状态" clearable class="dlg-status-sel">
            <el-option v-for="st in NOTE_STATUS" :key="st.key" :value="st.key" :label="`${st.emoji} ${st.label}`" />
          </el-select>
          <RichEditor v-model="dlgContent" placeholder="记录今天学了什么、卡在哪、明天做什么…" />
        </div>
      </div>
      <template #footer>
        <el-button v-if="calDlgMode === 'view' && calDlgNote" size="small" type="danger" plain
          :loading="dlgDeleting" @click="calDlgDelete">删除</el-button>
        <el-button v-if="calDlgMode === 'view' && calDlgNote" size="small" type="primary" plain
          @click="calDlgMode = 'edit'">✏️ 编辑</el-button>
        <el-button v-if="calDlgMode === 'edit'" size="small" @click="calDlg = false">取消</el-button>
        <el-button v-if="calDlgMode === 'edit'" size="small" type="primary" :loading="dlgSaving"
          @click="calDlgSave">💾 保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style lang="scss" scoped>
.cal-wrap { max-width: 1080px; }
.cal-toolbar {
  display: flex; align-items: center; gap: 8px; margin-bottom: 10px;
  .cal-ym { font-size: 15px; min-width: 110px; text-align: center; }
  .cal-hint { margin-left: auto; color: var(--text-2); font-size: 12px; }
}
.cal-box {
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 10px;
}
.cal-week {
  display: grid; grid-template-columns: repeat(7, 1fr); text-align: center;
  font-size: 12px; color: var(--text-2); font-weight: 600; padding: 4px 0 8px;
}
.cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; }
.cal-cell {
  min-height: 80px; border: 1px solid var(--border); border-radius: 8px; padding: 4px 6px;
  cursor: pointer; transition: all .15s; background: #fff; overflow: hidden;
  &:hover { border-color: #2563eb; box-shadow: 0 1px 6px rgba(37, 99, 235, .18); }
  &.blank { visibility: hidden; }
  &.today { border-color: #2563eb; background: #eff6ff; }
  &.hasnote { border-color: #f59e0b; }
  &.today.hasnote { border-color: #2563eb; background: #eff6ff; }

  .cal-day { font-size: 12.5px; font-weight: 700; color: #475569; }
  .today & .cal-day { color: #2563eb; }
  .cal-emojis {
    display: flex; align-items: center; gap: 2px; flex-wrap: wrap; margin-top: 5px; min-height: 20px;
    .cal-emoji { font-size: 15px; line-height: 1; }
    .cal-more { font-size: 10px; color: #94a3b8; }
  }
}

// 已完成计划
.done-plans {
  margin-top: 16px; background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px;
  h4 { margin: 0 0 10px; font-size: 14px; }
  .dp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
  .dp-sec {
    .dp-sec-title { font-size: 13px; font-weight: 600; margin-bottom: 6px; color: var(--text-2); }
    .dp-item {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      background: #f8fafc; border: 1px solid var(--border); border-radius: 8px;
      padding: 6px 10px; margin-bottom: 6px; font-size: 12.5px;
      b { flex: 1; min-width: 0; }
      .dp-badge { color: #16a34a; font-weight: 700; white-space: nowrap; }
      .dp-date { color: var(--text-2); font-size: 11.5px; white-space: nowrap; }
    }
    .dp-none { color: #cbd5e1; font-size: 12.5px; padding: 4px 0; }
  }
}

// 点击日期弹窗：完成事项分组 + 笔记回看
.dlg-items { margin-bottom: 14px;
  .di-group { margin-bottom: 10px;
    .di-title { font-size: 13px; font-weight: 700; margin-bottom: 4px; }
    .di-item {
      display: flex; gap: 8px; align-items: baseline; font-size: 13px;
      padding: 4px 10px; border-left: 3px solid var(--border); margin-bottom: 4px;
      b { color: var(--text-2); font-weight: 600; white-space: nowrap; max-width: 40%; overflow: hidden; text-overflow: ellipsis; }
      .di-task { color: #1e293b; }
    }
  }
  .di-none { color: #94a3b8; font-size: 13px; padding: 6px 0; }
}
.dlg-note-sec {
  border-top: 1px dashed var(--border); padding-top: 12px;
  .dlg-note-title { font-size: 13px; font-weight: 700; margin-bottom: 6px; }
}
.dlg-note-view {
  .dlg-status {
    display: inline-block; padding: 3px 12px; border-radius: 999px;
    font-size: 13px; font-weight: 600; margin-bottom: 10px;
  }
  .dlg-body {
    line-height: 1.8; font-size: 14px; color: #1e293b; overflow-y: auto; max-height: 32vh;
    :deep(img) { max-width: 100%; border-radius: 6px; }
    :deep(video) { max-width: 100%; border-radius: 6px; }
    :deep(iframe) { width: 100%; max-width: 640px; height: 360px; border-radius: 6px; border: none; }
    :deep(a) { color: #2563eb; }
  }
  .dlg-empty { color: #94a3b8; font-size: 13px; padding: 10px 0; }
}
.dlg-status-sel { width: 100%; margin-bottom: 8px; }
</style>
