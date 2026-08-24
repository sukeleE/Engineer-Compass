<script setup>
// 小组 AI 备赛计划：AI 按小组部门/角色拆分任务、多部门并行跟进
// 全员可见+可勾选进度；组长（或「小组设置」权限）可生成/编辑/删除；下方保留成员计划同步
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../../api.js';
import auth from '../../auth.js';
import { fmtDate } from '../../utils/noteStatus.js';
import TeamPlans from './TeamPlans.vue';

const props = defineProps({ teamId: Number, me: Object, roles: Array, perms: Object });

const canEdit = computed(() => props.me?.is_owner || props.perms?.team);
// 我的全部角色名（多角色：任一匹配本部门即可勾）
const myRoleNames = computed(() => (props.me?.roles || []).map((r) => r.name));
// 勾选权限（与后端同规则）：组长/小组设置权限可勾一切；通用任务全员；其余仅本部门成员
const canCheck = (t) => canEdit.value || !t.dept || t.dept === '通用' || myRoleNames.value.includes(t.dept);
const plans = ref([]);
const comps = ref([]);
const genCompId = ref(null);
const loading = ref(false);
const genLoading = ref(false);

const deptOptions = computed(() => [...(props.roles || []).map((r) => r.name), '通用']);
const TAGS = ['success', 'warning', 'danger', 'primary'];
const tagType = (dept) => (dept === '通用' ? 'info' : TAGS[Math.abs([...(dept || '')].reduce((s, c) => s + c.charCodeAt(0), 0)) % TAGS.length]);

const tasksOf = (p) => p.tasks || [];
const pct = (done, total) => (total ? Math.round((done / total) * 100) : 0);
const phaseStats = (ph) => { const t = tasksOf(ph); return { done: t.filter((x) => x.done).length, total: t.length }; };
// 整份计划汇总
const planStats = (p) => {
  let done = 0, total = 0;
  for (const ph of p.plan?.phases || []) for (const t of ph.tasks || []) { total++; if (t.done) done++; }
  return { done, total };
};

// 部门汇总：{ 部门名: {done,total} }
function deptStats(plan) {
  const m = {};
  for (const ph of plan.phases || []) for (const t of ph.tasks || []) {
    const d = t.dept || '通用';
    m[d] = m[d] || { done: 0, total: 0 };
    m[d].total++; if (t.done) m[d].done++;
  }
  return m;
}
// 阶段内按部门分组（带任务索引，勾选用）
function deptGroups(ph) {
  const m = new Map();
  (ph.tasks || []).forEach((t, idx) => {
    const d = t.dept || '通用';
    if (!m.has(d)) m.set(d, []);
    m.get(d).push({ t, idx });
  });
  return [...m.entries()];
}

async function load() {
  loading.value = true;
  try { plans.value = await api.teamPlanList(props.teamId); } catch (e) { ElMessage.error(e.message); } finally { loading.value = false; }
}

async function loadComps() {
  try {
    comps.value = await api.competitions({ status: 'active' });
    if (comps.value.length) genCompId.value = comps.value[0].id;
  } catch { /* 竞赛列表失败不阻塞页面 */ }
}

// —— 生成（组长）——
async function generate() {
  if (!genCompId.value) return ElMessage.warning('请先选择竞赛');
  genLoading.value = true;
  try {
    const r = await api.teamPlanGenerate(props.teamId, genCompId.value);
    ElMessage.success(r.template ? '已生成小组计划（AI 服务不可用，已用子赛项模板兜底）' : '🎉 AI 小组计划已生成（按部门拆分）');
    await load();
  } catch (e) { ElMessage.error(e.message); } finally { genLoading.value = false; }
}

// —— 勾选任务（本部门成员；乐观更新，done/done_by 成对回滚）——
async function toggle(prow, phIdx, task) {
  const old = { done: task.t.done, done_by: task.t.done_by, done_at: task.t.done_at };
  task.t.done = !task.t.done;
  task.t.done_by = task.t.done ? (auth.user?.nickname || auth.user?.username || '') : null;
  task.t.done_at = task.t.done ? fmtDate(new Date()) : null; // 完成日期（月历按完成日聚合；取消清空）
  try { await api.teamPlanTaskToggle(props.teamId, prow.id, phIdx, task.idx, task.t.done); }
  catch (e) { task.t.done = old.done; task.t.done_by = old.done_by; task.t.done_at = old.done_at; ElMessage.error(e.message); }
}

// —— 编辑（组长）——
const editDlg = ref(false);
const editPlan = ref(null); // { id, title, phases[] }
function openEdit(prow) {
  editPlan.value = { id: prow.id, title: prow.title, phases: JSON.parse(JSON.stringify(prow.plan.phases || [])) };
  editDlg.value = true;
}
const addTask = (ph) => { ph.tasks = ph.tasks || []; ph.tasks.push({ text: '', dept: '通用', done: false }); };
const delTask = (ph, i) => ph.tasks.splice(i, 1);
const addPhase = () => editPlan.value.phases.push({ phase: '新阶段', date: '', check_standard: '', week_hours: 10, tasks: [] });
const delPhase = (i) => editPlan.value.phases.splice(i, 1);

async function saveEdit() {
  const ep = editPlan.value;
  const valid = ep.phases.some((p) => (p.tasks || []).some((t) => t.text && String(t.text).trim()));
  if (!valid) return ElMessage.warning('计划需至少包含一个带任务名称的阶段');
  try {
    await api.teamPlanSave(props.teamId, { id: ep.id, title: ep.title, plan_json: { phases: ep.phases } });
    ElMessage.success('已保存');
    editDlg.value = false;
    await load();
  } catch (e) { ElMessage.error(e.message); }
}

async function removePlan(prow) {
  try { await ElMessageBox.confirm(`确定删除「${prow.title}」？成员的勾选进度将一并删除`, '删除小组计划', { type: 'warning' }); }
  catch { return; }
  try { await api.teamPlanDelete(props.teamId, prow.id); ElMessage.success('已删除'); await load(); }
  catch (e) { ElMessage.error(e.message); }
}

onMounted(() => { load(); loadComps(); });
</script>

<template>
  <div class="tpv">
    <el-alert type="info" :closable="false" class="tpv-tip" show-icon
      title="小组备赛计划：AI 按小组部门拆分任务 → 组长分配 → 各部门并行跟进勾选；「计划同步」为成员个人计划汇总" />

    <!-- 生成区（组长） -->
    <div v-if="canEdit" class="gen-row">
      <el-select v-model="genCompId" filterable placeholder="选择竞赛" style="width: 300px">
        <el-option v-for="c in comps" :key="c.id" :label="c.name" :value="c.id" />
      </el-select>
      <el-button type="primary" :loading="genLoading" @click="generate">🧠 AI 生成小组计划</el-button>
      <span class="gen-tip">AI 将结合小组部门（{{ deptOptions.join('、') }}）拆分任务</span>
    </div>

    <div v-loading="loading" style="min-height: 60px">
      <div v-if="!plans.length" class="tpv-empty">
        {{ canEdit ? '还没有小组计划，选择竞赛点击「AI 生成小组计划」开始' : '组长尚未生成小组计划，稍后再来' }}
      </div>

      <!-- 计划卡片 -->
      <div v-for="p in plans" :key="p.id" class="plan-box">
        <div class="pb-head">
          <div class="pb-title">
            <b>{{ p.title }}</b>
            <el-tag v-if="p.plan?.comp_name" size="small" effect="plain" type="primary">{{ p.plan.comp_name }}</el-tag>
            <span class="pb-time">{{ String(p.update_time || p.create_time || '').slice(0, 16) }} 更新</span>
          </div>
          <div class="pb-ops">
            <el-button v-if="canEdit" size="small" @click="openEdit(p)">✏️ 编辑</el-button>
            <el-button v-if="canEdit" size="small" type="danger" plain @click="removePlan(p)">删除</el-button>
          </div>
        </div>

        <!-- 总进度 + 部门看板 -->
        <div class="pb-stats">
          <el-progress :percentage="pct(planStats(p).done, planStats(p).total)" :stroke-width="8" class="pb-bar" />
          <div class="dept-row">
            <el-tag v-for="(st, d) in deptStats(p.plan)" :key="d" size="small" effect="light" :type="tagType(d)" class="dept-tag">
              {{ d }} · {{ st.done }}/{{ st.total }}
            </el-tag>
          </div>
        </div>

        <!-- 阶段折叠 -->
        <el-collapse>
          <el-collapse-item v-for="(ph, pi) in p.plan.phases || []" :key="pi" :name="pi">
            <template #title>
              <div class="ph-title">
                <span class="ph-name">阶段{{ pi + 1 }} {{ ph.phase }}</span>
                <span class="ph-extra">
                  <template v-if="ph.date">📅 {{ ph.date }}</template>
                  <template v-if="ph.week_hours"> · ⏱ {{ ph.week_hours }}h/周</template>
                </span>
                <el-tag size="small" :type="phaseStats(ph).done === phaseStats(ph).total && phaseStats(ph).total ? 'success' : 'info'" effect="plain">
                  {{ phaseStats(ph).done }}/{{ phaseStats(ph).total }}
                </el-tag>
              </div>
            </template>

            <div v-if="ph.check_standard" class="ph-check">✅ 达标要求：{{ ph.check_standard }}</div>
            <div v-for="[dept, items] in deptGroups(ph)" :key="dept" class="dept-group">
              <div class="dg-head"><el-tag size="small" :type="tagType(dept)" effect="dark">{{ dept }}</el-tag></div>
              <el-checkbox v-for="task in items" :key="task.idx" :model-value="task.t.done"
                :disabled="!canCheck(task.t)" :title="canCheck(task.t) ? '' : `仅「${task.t.dept}」成员可勾选`"
                @change="toggle(p, pi, task)" class="task-line">
                <span class="task-text" :class="{ done: task.t.done }">{{ task.t.text }}</span>
                <span v-if="task.t.done_by" class="done-by">👤 {{ task.t.done_by }}</span>
              </el-checkbox>
            </div>
            <div v-if="!ph.tasks?.length" class="ph-none">（本阶段暂无任务）</div>
          </el-collapse-item>
        </el-collapse>
      </div>
    </div>

    <!-- 成员计划同步（沿用原「计划同步」） -->
    <div class="sync-sec">
      <div class="sync-title">📡 成员计划同步（个人备赛 / 学习日程）</div>
      <TeamPlans :team-id="teamId" />
    </div>

    <!-- 编辑弹窗（组长） -->
    <el-dialog v-model="editDlg" title="✏️ 编辑小组计划" width="760px" top="4vh">
      <template v-if="editPlan">
        <div class="ed-title">
          <el-input v-model="editPlan.title" placeholder="计划名称" style="max-width: 340px" />
        </div>
        <div class="ed-scroll">
          <div v-for="(ph, pi) in editPlan.phases" :key="pi" class="ed-phase">
            <div class="ed-phase-head">
              <b>阶段{{ pi + 1 }}</b>
              <el-button size="small" type="danger" plain @click="delPhase(pi)">删除阶段</el-button>
            </div>
            <div class="ed-grid">
              <el-input v-model="ph.phase" placeholder="阶段名称" />
              <el-input v-model="ph.date" placeholder="日期（如 2026-09-01 ~ 09-30）" />
            </div>
            <el-input v-model="ph.check_standard" placeholder="本阶段达标要求" class="ed-mt" />
            <div class="ed-grid ed-mt">
              <el-input-number v-model="ph.week_hours" :min="0" :max="80" controls-position="right" />
              <span class="ed-week">小时/周</span>
            </div>
            <div class="ed-tasks">
              <div v-for="(t, ti) in ph.tasks" :key="ti" class="ed-task">
                <el-checkbox v-model="t.done" />
                <el-input v-model="t.text" placeholder="任务描述" size="small" />
                <el-select v-model="t.dept" size="small" style="width: 130px">
                  <el-option v-for="d in deptOptions" :key="d" :label="d" :value="d" />
                </el-select>
                <el-button size="small" text type="danger" @click="delTask(ph, ti)">✕</el-button>
              </div>
              <el-button size="small" @click="addTask(ph)">＋ 加任务</el-button>
            </div>
          </div>
        </div>
        <el-button class="ed-add-phase" @click="addPhase">＋ 加阶段</el-button>
      </template>
      <template #footer>
        <el-button @click="editDlg = false">取消</el-button>
        <el-button type="primary" @click="saveEdit">保存计划</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style lang="scss" scoped>
.tpv-tip { margin-bottom: 12px; border-radius: 10px; }
.gen-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px;
  .gen-tip { color: #94a3b8; font-size: 12.5px; }
}
.tpv-empty { color: #94a3b8; text-align: center; padding: 40px 0; font-size: 13px; }

.plan-box { border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; margin-bottom: 14px;
  background: var(--card-bg);
  .pb-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 8px;
    .pb-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0;
      b { font-size: 15px; }
      .pb-time { color: #94a3b8; font-size: 12px; }
    }
    .pb-ops { flex-shrink: 0; }
  }
  .pb-stats { margin-bottom: 10px;
    .pb-bar { margin-bottom: 6px; }
    .dept-row { display: flex; gap: 6px; flex-wrap: wrap;
      .dept-tag { font-weight: 500; }
    }
  }
  .ph-title { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;
    .ph-name { font-weight: 600; font-size: 13.5px; }
    .ph-extra { color: #94a3b8; font-size: 12px; }
  }
  .ph-check { background: #f8fafc; border: 1px dashed var(--border); border-radius: 8px;
    padding: 6px 10px; font-size: 12.5px; color: var(--text-2); margin-bottom: 8px; }
  .dept-group { margin-bottom: 8px;
    .dg-head { margin-bottom: 4px; }
    .task-line { display: flex; align-items: flex-start; width: 100%; margin: 0;
      .task-text { font-size: 13px; line-height: 1.6;
        &.done { color: #94a3b8; text-decoration: line-through; }
      }
      .done-by { font-size: 11.5px; color: #94a3b8; margin-left: 6px; }
    }
  }
  .ph-none { color: #cbd5e1; font-size: 12.5px; }
}

.sync-sec { margin-top: 18px; border-top: 1px dashed var(--border); padding-top: 14px;
  .sync-title { font-size: 14px; font-weight: 600; margin-bottom: 10px; }
}

.ed-scroll { max-height: 56vh; overflow-y: auto; padding-right: 6px; }
.ed-title { margin-bottom: 10px; }
.ed-phase { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin-bottom: 10px;
  .ed-phase-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .ed-grid { display: flex; gap: 8px; align-items: center;
    .el-input { flex: 1; }
  }
  .ed-mt { margin-top: 8px; }
  .ed-week { color: var(--text-2); font-size: 12.5px; }
  .ed-tasks { margin-top: 10px; display: flex; flex-direction: column; gap: 6px;
    .ed-task { display: flex; gap: 6px; align-items: center; }
  }
}
.ed-add-phase { margin-top: 2px; }
</style>
