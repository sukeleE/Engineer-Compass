<template>
  <view class="page-wrap" v-if="data">
    <Tabs v-model="tab" :tabs="[{ key: 'tasks', label: '协作任务', badge: data.tasks.length }, { key: 'plans', label: '备赛计划', badge: plans.length }]" />

    <!-- 协作任务 -->
    <block v-if="tab === 'tasks'">
      <button v-if="data.perms.task" class="btn btn-primary btn-block" @click="openCreate">＋ 新建任务</button>
      <EmptyState v-if="!data.tasks.length" icon="✅" text="暂无协作任务" />
      <view v-for="t in data.tasks" :key="t.id" class="card task-card">
        <view class="t-head">
          <text class="t-title">{{ t.title }}</text>
          <text class="tag" :class="statusCls(t.status)">{{ statusLabel(t.status) }}</text>
        </view>
        <view v-if="t.desc" class="t-desc">{{ t.desc }}</view>
        <view class="t-meta">
          <text v-if="t.assignee_id || t.assignee_name">负责人：{{ assigneeName(t) }}</text>
          <text v-if="t.deadline">截止：{{ t.deadline }}</text>
        </view>
        <view class="progress-line">
          <view class="progress-fill" :style="{ width: (t.progress || 0) + '%' }"></view>
        </view>
        <view class="t-actions">
          <view class="mini-btn" @click="cycleStatus(t)">流转状态</view>
          <view v-if="data.perms.task" class="mini-btn danger" @click="removeTask(t)">删除</view>
        </view>
      </view>
    </block>

    <!-- 备赛计划 -->
    <block v-else>
      <view v-if="canEditPlan" class="plan-actions">
        <button class="btn btn-primary plan-btn" @click="generate">AI 生成计划</button>
        <button class="btn btn-ghost plan-btn" @click="aiGrouping">AI 智能分组</button>
      </view>
      <EmptyState v-if="!plans.length" icon="🗺️" text="暂无备赛计划，可让 AI 按部门生成" />
      <view v-for="p in plans" :key="p.id" class="card plan-card">
        <view class="plan-head">
          <text class="plan-title ellipsis">{{ p.title }} <text v-if="p.plan && p.plan.comp_name" class="text-small text-muted">· {{ p.plan.comp_name }}</text></text>
          <view v-if="canEditPlan" class="plan-head-actions">
            <text class="link-btn" @click="openRename(p)">重命名</text>
            <text class="link-btn danger" @click="deletePlan(p)">删除</text>
          </view>
        </view>
        <view v-for="(ph, pi) in p.plan.phases" :key="pi" class="phase">
          <view class="phase-name">{{ ph.phase }} <text class="text-small text-muted">{{ ph.date }}</text></view>
          <view v-if="ph.check_standard" class="phase-std">达标要求：{{ ph.check_standard }}</view>
          <view v-for="(task, ti) in ph.tasks" :key="ti" class="plan-task">
            <text class="checkbox" :class="{ checked: task.done }" @click="togglePlanTask(p, pi, ti)">{{ task.done ? '✓' : '' }}</text>
            <view class="plan-task-body" @click="togglePlanTask(p, pi, ti)">
              <text class="plan-task-text" :class="{ done: task.done }">{{ task.text }}</text>
              <view class="plan-task-meta">
                <text class="tag tag-gray">{{ task.dept || '通用' }}</text>
                <text v-if="task.mode === 'multi'" class="tag tag-purple">{{ (task.completions || []).length }}/{{ task.target || 3 }} 次</text>
                <text v-if="task.done_by" class="text-small text-muted">{{ task.done_by }}</text>
              </view>
            </view>
            <view v-if="task.mode === 'multi' && !task.done" class="mini-btn" @click.stop="completeOnce(p, pi, ti)">+1</view>
            <view v-if="canEditPlan" class="mini-btn" @click.stop="openSplit(p, pi, ti)">拆分</view>
          </view>
        </view>
      </view>
    </block>

    <!-- 新建任务弹窗 -->
    <view v-if="createOpen" class="modal-mask" @click="createOpen = false">
      <view class="modal" @click.stop>
        <view class="modal-title">新建协作任务</view>
        <input v-model="form.title" class="modal-input" placeholder="任务标题（必填）" />
        <textarea v-model="form.desc" class="modal-textarea" placeholder="任务描述（选填）" />
        <picker :range="memberNames" @change="(e) => (form.assignee_id = data.members[Number(e.detail.value)].id)">
          <view class="modal-input picker-like">{{ form.assignee_id ? memberName(form.assignee_id) : '选择负责人（可选）' }}</view>
        </picker>
        <picker mode="date" @change="(e) => (form.deadline = e.detail.value)">
          <view class="modal-input picker-like">{{ form.deadline || '选择截止日期（可选）' }}</view>
        </picker>
        <view class="modal-actions">
          <button class="btn btn-ghost modal-btn" @click="createOpen = false">取消</button>
          <button class="btn btn-primary modal-btn" @click="submitTask">创建</button>
        </view>
      </view>
    </view>

    <!-- 拆分任务弹窗 -->
    <view v-if="splitOpen" class="modal-mask" @click="splitOpen = false">
      <view class="modal" @click.stop>
        <view class="modal-title">拆分子任务</view>
        <view class="modal-desc text-muted">每行一个子任务，提交后原位替换当前任务（继承部门）</view>
        <button class="btn btn-ghost btn-sm ai-split-btn" :disabled="aiAssistBusy" @click="aiAssist">{{ aiAssistBusy ? 'AI 拆解中…' : '✨ AI 智能拆解' }}</button>
        <textarea v-model="splitText" class="modal-textarea tall" :placeholder="splitPlaceholder" />
        <view class="modal-actions">
          <button class="btn btn-ghost modal-btn" @click="splitOpen = false">取消</button>
          <button class="btn btn-primary modal-btn" :disabled="splitBusy" @click="saveSplit">{{ splitBusy ? '提交中…' : '确认拆分' }}</button>
        </view>
      </view>
    </view>

    <!-- 重命名计划弹窗 -->
    <view v-if="renameOpen" class="modal-mask" @click="renameOpen = false">
      <view class="modal" @click.stop>
        <view class="modal-title">重命名计划</view>
        <input v-model="renameVal" class="modal-input" placeholder="计划标题" maxlength="60" />
        <view class="modal-actions">
          <button class="btn btn-ghost modal-btn" @click="renameOpen = false">取消</button>
          <button class="btn btn-primary modal-btn" @click="saveRename">保存</button>
        </view>
      </view>
    </view>

    <!-- AI 分组建议弹窗 -->
    <view v-if="groupOpen" class="modal-mask" @click="groupOpen = false">
      <view class="modal modal-lg" @click.stop>
        <view class="modal-title">AI 智能分组建议</view>
        <scroll-view scroll-y class="group-list">
          <view v-if="!groupRows.length" class="text-muted empty-tip">{{ groupMsg || '暂无建议' }}</view>
          <view v-for="(g, i) in groupRows" :key="i" class="group-row">
            <view class="group-main">
              <text class="group-name">{{ groupName(g) }}</text>
              <text class="text-small text-muted">{{ g.current_role || '无角色' }} → {{ g.suggest_role }}</text>
            </view>
            <view class="mini-btn" @click="applyGrouping(g)">应用</view>
          </view>
        </scroll-view>
        <button class="btn btn-ghost btn-block" @click="groupOpen = false">关闭</button>
      </view>
    </view>
  </view>
  <view v-else class="empty"><view class="empty-text">加载中…</view></view>
</template>

<script setup>
import { ref, computed } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { confirm, toast } from '../../../utils/guard.js';
import Tabs from '../../../components/Tabs.vue';
import EmptyState from '../../../components/EmptyState.vue';
import { displayName, teamDisplayName } from '../../../utils/displayName.js';

const id = ref(null);
const data = ref(null);
const tab = ref('tasks');
const plans = ref([]);
const createOpen = ref(false);
const form = ref({ title: '', desc: '', deadline: '', assignee_id: null });
const splitPlaceholder = '子任务 1\n子任务 2\n子任务 3';

const STATUS_FLOW = ['todo', 'doing', 'done'];
const canEditPlan = computed(() => data.value?.me.is_owner || data.value?.perms.team);
const canMember = computed(() => data.value?.me.is_owner || data.value?.perms.member);
const memberNames = computed(() => (data.value?.members || []).map((m) => displayName(m)));
function memberName(uid) { const m = (data.value?.members || []).find((x) => x.id === uid); return m ? displayName(m) : ''; }
function assigneeName(task) { return teamDisplayName(task, data.value?.members || [], 'assignee_name'); }
function groupName(g) { return teamDisplayName(g, data.value?.members || []); }
function statusLabel(s) { return { todo: '待办', doing: '进行中', done: '已完成' }[s] || s; }
function statusCls(s) { return { todo: 'tag-gray', doing: 'tag-amber', done: 'tag-green' }[s] || 'tag-gray'; }

async function load() {
  data.value = await api.teamDetail(id.value);
  plans.value = await api.teamPlan(id.value);
}
function openCreate() {
  form.value = { title: '', desc: '', deadline: '', assignee_id: null };
  createOpen.value = true;
}
async function submitTask() {
  if (!form.value.title.trim()) return toast('标题必填');
  await api.collabTaskCreate(id.value, form.value);
  toast('任务已创建', 'success');
  createOpen.value = false;
  load();
}
async function cycleStatus(t) {
  const idx = STATUS_FLOW.indexOf(t.status);
  const next = STATUS_FLOW[(idx + 1) % STATUS_FLOW.length];
  const progress = next === 'done' ? 100 : next === 'doing' ? Math.max(t.progress || 0, 30) : 0;
  await api.collabTaskUpdate(id.value, t.id, { status: next, progress });
  load();
}
async function removeTask(t) {
  if (!(await confirm('删除该协作任务？'))) return;
  await api.collabTaskDelete(id.value, t.id);
  load();
}
async function togglePlanTask(p, pi, ti) {
  const task = p.plan.phases[pi].tasks[ti];
  if (task.mode === 'multi') return;
  try {
    await api.teamPlanTask(id.value, p.id, { phase_idx: pi, task_idx: ti, done: !task.done });
    load();
  } catch (e) { /* 403 部门限权已由 request 层提示 */ }
}
async function completeOnce(p, pi, ti) {
  try {
    await api.teamPlanTaskComplete(id.value, p.id, { phase_idx: pi, task_idx: ti, complete: true });
    load();
  } catch (e) { /* 限权提示 */ }
}

// ---------- AI 生成（先选竞赛） ----------
async function generate() {
  const comps = await api.competitions();
  if (!comps || !comps.length) return toast('暂无已转正竞赛，无法生成计划');
  const names = comps.map((c) => c.name);
  uni.showActionSheet({
    itemList: names.slice(0, 30),
    success: async (res) => {
      const comp = comps[res.tapIndex];
      uni.showLoading({ title: 'AI 生成中…', mask: true });
      try {
        const r = await api.teamPlanGenerate(id.value, { comp_id: comp.id });
        uni.hideLoading();
        toast(r.template ? 'AI 不可用，已用模板生成' : '已生成', 'success');
        load();
      } catch (e) { uni.hideLoading(); }
    },
  });
}

// ---------- 计划重命名 / 删除 ----------
const renameOpen = ref(false);
const renameVal = ref('');
let renameTarget = null;
function openRename(p) {
  renameTarget = p;
  renameVal.value = p.title || '';
  renameOpen.value = true;
}
async function saveRename() {
  if (!renameVal.value.trim()) return toast('标题不能为空');
  await api.teamPlanSave(id.value, { id: renameTarget.id, title: renameVal.value.trim(), plan_json: renameTarget.plan });
  toast('已保存', 'success');
  renameOpen.value = false;
  load();
}
async function deletePlan(p) {
  if (!(await confirm('删除计划「' + p.title + '」？勾选记录会一并清除。'))) return;
  await api.teamPlanDelete(id.value, p.id);
  toast('已删除', 'success');
  load();
}

// ---------- 任务拆分 ----------
const splitOpen = ref(false);
const splitText = ref('');
const splitBusy = ref(false);
let splitCtx = null;
function openSplit(p, pi, ti) {
  splitCtx = { p, pi, ti };
  splitText.value = '';
  splitOpen.value = true;
}
const aiAssistBusy = ref(false);
async function aiAssist() {
  const phase = splitCtx.p.plan.phases[splitCtx.pi];
  const t = phase && phase.tasks ? phase.tasks[splitCtx.ti] : null;
  const taskText = t ? t.text : '';
  if (!taskText) return toast('任务文本为空，无法拆解');
  aiAssistBusy.value = true;
  uni.showLoading({ title: 'AI 拆解中…', mask: true });
  try {
    const r = await api.taskAssist({ task_text: taskText });
    const subs = r.subtasks || [];
    if (!subs.length) return toast('AI 未返回有效子任务');
    splitText.value = subs.slice(0, 12).join('\n');
    if (r.hint) toast(r.hint);
  } finally {
    uni.hideLoading();
    aiAssistBusy.value = false;
  }
}
async function saveSplit() {
  const subtasks = splitText.value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!subtasks.length) return toast('请至少填写一个子任务');
  if (subtasks.length > 12) return toast('最多拆成 12 个子任务');
  splitBusy.value = true;
  try {
    await api.teamPlanTaskSplit(id.value, splitCtx.p.id, {
      phase_idx: splitCtx.pi,
      task_idx: splitCtx.ti,
      subtasks,
    });
    toast('已拆分', 'success');
    splitOpen.value = false;
    load();
  } finally {
    splitBusy.value = false;
  }
}

// ---------- AI 智能分组 ----------
const groupOpen = ref(false);
const groupRows = ref([]);
const groupMsg = ref('');
async function aiGrouping() {
  if (!canMember.value) return;
  uni.showLoading({ title: 'AI 分析中…', mask: true });
  try {
    const r = await api.teamAiGrouping(id.value, {});
    uni.hideLoading();
    groupRows.value = r.assignments || [];
    groupMsg.value = r.message || '';
    groupOpen.value = true;
  } catch (e) { uni.hideLoading(); }
}
async function applyGrouping(g) {
  await api.teamMemberRole(id.value, { user_id: g.user_id, role_id: g.suggest_role_id });
  toast('已应用「' + g.suggest_role + '」', 'success');
  groupRows.value = groupRows.value.filter((x) => x.user_id !== g.user_id);
  load();
}

onLoad((o) => { id.value = Number(o.id); });
onShow(() => { if (id.value) load(); });
</script>

<style lang="scss" scoped>
.task-card { padding: 24rpx 28rpx; }
.t-head { display: flex; justify-content: space-between; align-items: center; gap: 14rpx; }
.t-title { font-size: 29rpx; font-weight: 700; color: #1e293b; flex: 1; }
.t-desc { font-size: 25rpx; color: #64748b; margin-top: 10rpx; }
.t-meta { display: flex; gap: 20rpx; font-size: 23rpx; color: #94a3b8; margin-top: 12rpx; }
.progress-line { height: 10rpx; background: #f1f5f9; border-radius: 5rpx; overflow: hidden; margin-top: 14rpx; }
.progress-fill { height: 100%; background: linear-gradient(90deg, #2563eb, #60a5fa); }
.t-actions { display: flex; gap: 14rpx; justify-content: flex-end; margin-top: 16rpx; }
.mini-btn { background: #eff6ff; color: #2563eb; font-size: 24rpx; border-radius: 26rpx; padding: 10rpx 28rpx; }
.mini-btn.danger { background: #fee2e2; color: #ef4444; }
.plan-actions { display: flex; gap: 16rpx; }
.plan-btn { flex: 1; height: 80rpx; font-size: 27rpx; }
.plan-card { padding: 24rpx 28rpx; }
.plan-head { display: flex; justify-content: space-between; align-items: center; gap: 14rpx; margin-bottom: 14rpx; }
.plan-title { font-size: 29rpx; font-weight: 700; color: #1e293b; flex: 1; }
.plan-head-actions { display: flex; gap: 18rpx; flex-shrink: 0; }
.link-btn { font-size: 24rpx; color: #2563eb; }
.link-btn.danger { color: #ef4444; }
.phase { padding: 14rpx 0; border-top: 1rpx solid #f8fafc; }
.phase-name { font-size: 27rpx; font-weight: 700; color: #334155; margin-bottom: 8rpx; }
.phase-std { font-size: 23rpx; color: #b45309; background: #fef3c7; border-radius: 10rpx; padding: 8rpx 16rpx; margin-bottom: 10rpx; }
.plan-task { display: flex; align-items: flex-start; gap: 14rpx; padding: 12rpx 0; }
.checkbox { width: 38rpx; height: 38rpx; border: 2rpx solid #cbd5e1; border-radius: 10rpx; flex-shrink: 0; text-align: center; line-height: 36rpx; color: #fff; font-size: 26rpx; }
.checkbox.checked { background: #16a34a; border-color: #16a34a; }
.plan-task-body { flex: 1; }
.plan-task-text { font-size: 26rpx; color: #334155; }
.plan-task-text.done { color: #94a3b8; text-decoration: line-through; }
.plan-task-meta { display: flex; gap: 10rpx; align-items: center; margin-top: 6rpx; flex-wrap: wrap; }
.modal-mask { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { width: 660rpx; background: #fff; border-radius: 24rpx; padding: 32rpx; }
.modal-lg { max-height: 82vh; display: flex; flex-direction: column; }
.modal-title { font-size: 31rpx; font-weight: 700; margin-bottom: 18rpx; }
.modal-desc { margin-bottom: 14rpx; font-size: 23rpx; }
.modal-input { height: 84rpx; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 12rpx; padding: 0 20rpx; font-size: 26rpx; margin-bottom: 16rpx; line-height: 84rpx; }
.modal-textarea { width: 100%; box-sizing: border-box; min-height: 140rpx; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 12rpx; padding: 18rpx 20rpx; font-size: 26rpx; margin-bottom: 16rpx; }
.modal-textarea.tall { min-height: 280rpx; }
.ai-split-btn { height: 68rpx; line-height: 68rpx; font-size: 25rpx; margin-bottom: 14rpx; }
.picker-like { color: #475569; }
.modal-actions { display: flex; gap: 18rpx; }
.modal-btn { flex: 1; height: 80rpx; font-size: 28rpx; }
.group-list { max-height: 60vh; margin-bottom: 16rpx; }
.group-row { display: flex; align-items: center; gap: 16rpx; padding: 20rpx 8rpx; border-bottom: 1rpx solid #f1f5f9; }
.group-main { flex: 1; display: flex; flex-direction: column; gap: 6rpx; }
.group-name { font-size: 27rpx; font-weight: 700; color: #1e293b; }
.empty-tip { padding: 30rpx; text-align: center; }
</style>
