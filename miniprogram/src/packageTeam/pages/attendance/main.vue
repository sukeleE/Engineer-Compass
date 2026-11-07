<template>
  <view class="page-wrap" v-if="data">
    <view class="card policy-card">
      <view class="p-head">
        <text class="p-name">{{ data.policy.name || '考勤规则' }}</text>
        <text class="tag" :class="data.policy.active ? 'tag-green' : 'tag-gray'">{{ data.policy.active ? '启用中' : '已停用' }}</text>
      </view>
      <view class="p-line">工作日：{{ workdayText }}</view>
      <view class="p-line">考勤时段：{{ data.policy.slots.length }} 个（{{ slotText }}）</view>
      <view class="p-line">请假模式：{{ data.policy.leave_mode === 'register' ? '仅登记（自动通过）' : '需负责人审批' }}</view>
      <view v-if="data.policy.start_date || data.policy.end_date" class="p-line">生效期：{{ data.policy.start_date || '不限' }} 至 {{ data.policy.end_date || '不限' }}</view>
      <view v-if="!data.in_scope" class="p-warn">⚠️ 你不在当前考勤范围内，仅可查看，不能打卡</view>
    </view>

    <Tabs v-model="tab" :tabs="tabs" />

    <!-- 今日打卡 -->
    <block v-if="tab === 'today'">
      <view v-if="!data.policy.active" class="card hint-card">考勤规则尚未启用，请等待负责人配置</view>
      <view v-else-if="!data.today_working" class="card hint-card">😴 今天不是考勤工作日，好好休息</view>
      <template v-else>
        <view v-for="c in data.today" :key="c.slot_id" class="card slot-card">
          <view class="s-head">
            <view class="s-main">
              <text class="s-name">{{ c.slot_name }}</text>
              <text class="s-time">{{ slotTime(c.slot_id) }}</text>
            </view>
            <text class="tag" :class="cellMeta(c.status).cls">{{ cellMeta(c.status).label }}</text>
          </view>
          <view v-if="c.record" class="s-record">✅ {{ hm(c.record.checkin_time) }} · {{ sourceLabel(c.record.source) }}</view>
          <view v-else-if="c.leave" class="s-record">📋 {{ c.leave.leave_type }}（{{ c.leave.status === 'approved' ? '已批准' : '待审批' }}）</view>
          <view v-if="c.status === 'can_checkin' && data.in_scope" class="s-ops">
            <button class="btn btn-primary btn-sm" @click="checkin(c)">立即打卡</button>
          </view>
          <view v-else-if="c.status === 'absent'" class="s-record miss">该时段已缺勤，可联系考勤负责人补卡</view>
        </view>
        <button v-if="data.in_scope" class="btn btn-ghost btn-block" @click="openRedeem">🔑 签到码打卡</button>
      </template>
    </block>

    <!-- 近 14 天 -->
    <block v-else-if="tab === 'recent'">
      <view v-for="d in data.recent" :key="d.date" class="card day-card">
        <view class="d-head">
          <text class="d-date">{{ d.date.slice(5) }} {{ weekDay(d.date) }}</text>
          <text v-if="!d.working" class="tag tag-gray">休息</text>
        </view>
        <view v-if="d.working" class="d-cells">
          <text v-for="c in d.cells" :key="c.slot_id" class="mini-tag" :class="cellMeta(c.status).cls">{{ c.slot_name }}·{{ cellMeta(c.status).label }}</text>
        </view>
      </view>
    </block>

    <!-- 请假 -->
    <block v-else-if="tab === 'leave'">
      <button class="btn btn-primary btn-block" @click="openLeaveForm">＋ 发起请假</button>

      <template v-if="data.makeups && data.makeups.length">
        <view class="section-title">补签任务</view>
        <view v-for="m in data.makeups" :key="m.id" class="card mk-card">
          <view class="mk-head">
            <text class="mk-title">补签 · {{ m.planned_at }}</text>
            <text class="tag" :class="makeupMeta(m.status).cls">{{ makeupMeta(m.status).label }}</text>
          </view>
          <view class="text-muted text-small">关联请假 {{ m.start_date }} 至 {{ m.end_date }}（{{ m.leave_type }}）· 要求时长 {{ m.minutes_required || 60 }} 分钟</view>
          <view v-if="m.status === 'pending'" class="mk-ops">
            <button class="btn btn-primary btn-sm" @click="makeupCheckin(m)">补签签到</button>
          </view>
          <view v-else-if="m.status === 'checkin'" class="mk-ops">
            <button class="btn btn-primary btn-sm" @click="makeupCheckout(m)">完成签退</button>
          </view>
        </view>
      </template>

      <view class="section-title">我的请假（{{ data.leaves.length }}）</view>
      <EmptyState v-if="!data.leaves.length" icon="📝" text="暂无请假记录" />
      <view v-for="l in data.leaves" :key="l.id" class="card leave-card">
        <view class="l-head">
          <text class="l-type">{{ l.leave_type }}</text>
          <text class="tag" :class="leaveMeta(l.status).cls">{{ leaveMeta(l.status).label }}</text>
        </view>
        <view class="l-line">日期：{{ l.start_date }}{{ l.start_date !== l.end_date ? ' 至 ' + l.end_date : '' }}{{ l.slot_id ? '（' + slotName(l.slot_id) + '）' : '（全天）' }}</view>
        <view class="l-line">事由：{{ l.reason }}</view>
        <view v-if="l.review_note" class="l-line">审批备注：{{ l.review_note }}</view>
        <view v-if="l.makeup_id" class="l-line">补签：{{ l.makeup_at }}（{{ makeupMeta(l.makeup_status).label }}）</view>
        <view v-if="l.status === 'pending'" class="l-ops">
          <view class="mini-btn danger" @click="removeLeave(l)">撤销请假</view>
        </view>
      </view>
    </block>

    <!-- 管理（考勤负责人） -->
    <block v-else-if="tab === 'manage'">
      <view class="seg">
        <view v-for="s in mSegs" :key="s.key" class="seg-item" :class="{ on: mtab === s.key }" @click="switchManage(s.key)">{{ s.label }}</view>
      </view>

      <block v-if="mtab === 'code'">
        <button class="btn btn-primary btn-block" @click="openCodeForm">＋ 发布今日签到码</button>
        <EmptyState v-if="!codes.length" icon="🔑" text="暂无签到码" />
        <view v-for="c in codes" :key="c.id" class="card code-card">
          <view class="c-head">
            <text class="c-code">{{ c.code }}</text>
            <text class="tag" :class="c.status === 'active' ? 'tag-green' : 'tag-gray'">{{ c.status === 'active' ? '生效中' : '已停用' }}</text>
          </view>
          <view class="l-line">{{ c.slot_name }} · 截止 {{ c.expires_at.slice(11, 16) }}</view>
          <view class="l-line">已用 {{ c.use_count || 0 }} 次{{ c.max_uses ? ' / 上限 ' + c.max_uses : ' / 不限次数' }}</view>
          <view v-if="c.status === 'active'" class="l-ops">
            <view class="mini-btn" @click="copyCode(c.code)">复制码</view>
            <view class="mini-btn danger" @click="disableCode(c)">停用</view>
          </view>
        </view>
      </block>

      <block v-else-if="mtab === 'approve'">
        <EmptyState v-if="!pendingLeaves.length" icon="✅" text="暂无待审批请假" />
        <view v-for="l in pendingLeaves" :key="l.id" class="card leave-card">
          <view class="l-head">
            <text class="l-type">{{ l.real_name || l.nickname || '成员' }} · {{ l.leave_type }}</text>
            <text class="tag tag-amber">待审批</text>
          </view>
          <view class="l-line">日期：{{ l.start_date }}{{ l.start_date !== l.end_date ? ' 至 ' + l.end_date : '' }}</view>
          <view class="l-line">事由：{{ l.reason }}</view>
          <view class="l-ops">
            <view class="mini-btn" @click="reviewLeave(l, 'approved')">批准</view>
            <view class="mini-btn danger" @click="reviewLeave(l, 'rejected')">驳回</view>
          </view>
        </view>
      </block>

      <block v-else>
        <picker mode="date" :value="boardDate" @change="onBoardDate">
          <view class="card picker-like board-picker">📅 {{ boardDate }}（点击切换日期）</view>
        </picker>
        <view v-if="board && !board.working" class="card hint-card">当天不是考勤工作日</view>
        <template v-else-if="board">
          <EmptyState v-if="!board.rows.length" icon="👥" text="考勤范围内暂无成员" />
          <view v-for="r in board.rows" :key="r.id" class="card board-row">
            <view class="br-head">
              <text class="br-name">{{ r.real_name || r.nickname }}</text>
              <text v-if="r.is_owner" class="tag tag-amber">组长</text>
            </view>
            <view class="d-cells">
              <text v-for="c in r.cells" :key="c.slot_id" class="mini-tag" :class="cellMeta(c.status).cls">{{ c.slot_name }}·{{ cellMeta(c.status).label }}</text>
            </view>
            <view class="l-ops">
              <view class="mini-btn" @click="openProxy(r)">代签</view>
            </view>
          </view>
        </template>
      </block>
    </block>

      <block v-else-if="mtab === 'stats'">
        <picker mode="date" fields="month" :value="statsMonth" @change="onStatsMonth">
          <view class="card picker-like board-picker">📅 {{ statsMonth }}（点击切换月份）</view>
        </picker>
        <EmptyState v-if="stats && !stats.rows.length" icon="📊" text="考勤范围内暂无成员" />
        <view v-for="r in (stats ? stats.rows : [])" :key="r.user_id" class="card stat-row">
          <text class="stat-name">{{ r.real_name || r.nickname || ('成员#' + r.user_id) }}</text>
          <view class="stat-cells">
            <text class="mini-tag tag-green">正常 {{ r.normal }}</text>
            <text class="mini-tag tag-amber">迟到 {{ r.late }}</text>
            <text class="mini-tag tag-purple">请假 {{ r.leave }}</text>
            <text class="mini-tag tag-red">缺勤 {{ r.absent }}</text>
          </view>
          <view class="stat-rate">出勤率 {{ attendanceRate(r) }}%</view>
        </view>
      </block>

      <block v-else-if="mtab === 'setting'">
        <view class="card">
          <view class="f-label">规则名称</view>
          <input v-model="setting.name" class="modal-input" placeholder="如：2026 赛季日常考勤" maxlength="30" />
          <view class="switch-row">
            <text>启用该考勤规则</text>
            <switch :checked="setting.active === 1" color="#2563eb" @change="onActiveSwitch" />
          </view>
          <view class="f-label">工作日</view>
          <view class="wd-row">
            <view v-for="(w, i) in workdayOptions" :key="i" class="wd-chip" :class="{ on: setting.workdays.indexOf(i + 1) >= 0 }" @click="toggleWorkday(i + 1)">{{ w }}</view>
          </view>
          <view class="f-label">考勤时段（开始 ≤ 迟到界限 ≤ 结束）</view>
          <view v-for="(s, i) in setting.slots" :key="i" class="slot-edit">
            <input v-model="s.name" class="slot-name-input" placeholder="时段名" maxlength="20" />
            <view class="slot-times">
              <picker mode="time" :value="s.start" @change="(e) => (s.start = e.detail.value)"><text class="time-pick">{{ s.start }}</text></picker>
              <picker mode="time" :value="s.late" @change="(e) => (s.late = e.detail.value)"><text class="time-pick">{{ s.late }}</text></picker>
              <picker mode="time" :value="s.end" @change="(e) => (s.end = e.detail.value)"><text class="time-pick">{{ s.end }}</text></picker>
              <text v-if="setting.slots.length > 1" class="slot-del" @click="removeSlot(i)">删</text>
            </view>
          </view>
          <view class="mini-btn add-slot" @click="addSlot">＋ 新增时段</view>

          <view class="f-label">请假模式</view>
          <view class="seg">
            <view class="seg-item" :class="{ on: setting.leave_mode === 'approval' }" @click="setting.leave_mode = 'approval'">需审批</view>
            <view class="seg-item" :class="{ on: setting.leave_mode === 'register' }" @click="setting.leave_mode = 'register'">仅登记</view>
          </view>
          <view class="switch-row">
            <text>允许请假时登记补签</text>
            <switch :checked="setting.allow_makeup === 1" color="#2563eb" @change="onSettingMakeupSwitch" />
          </view>
          <view class="f-label">补签要求时长（分钟，1–480）</view>
          <input v-model.number="setting.makeup_minutes" type="number" class="modal-input" placeholder="60" />
          <view class="f-label">生效日期（可空）</view>
          <picker mode="date" :value="setting.start_date" @change="(e) => (setting.start_date = e.detail.value)">
            <view class="modal-input picker-like">{{ setting.start_date || '不限开始日期' }}</view>
          </picker>
          <picker mode="date" :value="setting.end_date" @change="(e) => (setting.end_date = e.detail.value)">
            <view class="modal-input picker-like">{{ setting.end_date || '不限结束日期' }}</view>
          </picker>
          <button class="btn btn-primary btn-block" :disabled="settingBusy" @click="saveSettings">{{ settingBusy ? '保存中…' : '保存考勤规则' }}</button>
        </view>
      </block>
    <!-- 签到码打卡弹窗 -->
    <view v-if="redeemOpen" class="modal-mask" @click="redeemOpen = false">
      <view class="modal" @click.stop>
        <view class="modal-title">签到码打卡</view>
        <input v-model="redeemInput" class="modal-input" placeholder="输入负责人发布的 6 位签到码" maxlength="6" />
        <view class="modal-actions">
          <button class="btn btn-ghost modal-btn" @click="redeemOpen = false">取消</button>
          <button class="btn btn-primary modal-btn" @click="redeemCode">提交打卡</button>
        </view>
      </view>
    </view>

    <!-- 请假表单 -->
    <view v-if="leaveOpen" class="modal-mask" @click="leaveOpen = false">
      <view class="modal modal-lg" @click.stop>
        <view class="modal-title">发起请假</view>
        <scroll-view scroll-y class="modal-scroll">
          <view class="f-label">开始日期</view>
          <picker mode="date" :value="leaveForm.start_date" @change="onStartDate">
            <view class="modal-input picker-like">{{ leaveForm.start_date || '选择日期' }}</view>
          </picker>
          <view class="f-label">结束日期</view>
          <picker mode="date" :value="leaveForm.end_date" :start="leaveForm.start_date" @change="onEndDate">
            <view class="modal-input picker-like">{{ leaveForm.end_date || '选择日期' }}</view>
          </picker>
          <view class="f-label">请假类型</view>
          <picker :range="leaveTypes" :value="leaveTypeIndex" @change="onLeaveType">
            <view class="modal-input picker-like">{{ leaveForm.leave_type }}</view>
          </picker>
          <view class="f-label">请假时段（默认全天）</view>
          <picker :range="slotRange" range-key="label" :value="slotIndex" @change="onSlotPick">
            <view class="modal-input picker-like">{{ slotRange[slotIndex].label }}</view>
          </picker>
          <view class="f-label">请假原因（1-200 字）</view>
          <textarea v-model="leaveForm.reason" class="modal-textarea" maxlength="200" placeholder="请说明请假原因" />
          <view class="switch-row">
            <text>同时登记补签（需考勤规则支持）</text>
            <switch :checked="leaveForm.makeup_on" color="#2563eb" @change="onMakeupSwitch" />
          </view>
          <block v-if="leaveForm.makeup_on">
            <picker mode="date" :value="leaveForm.makeup_date" :start="leaveForm.end_date" @change="onMakeupDate">
              <view class="modal-input picker-like">{{ leaveForm.makeup_date || '补签日期' }}</view>
            </picker>
            <picker mode="time" :value="leaveForm.makeup_time" @change="onMakeupTime">
              <view class="modal-input picker-like">{{ leaveForm.makeup_time || '补签时间' }}</view>
            </picker>
          </block>
        </scroll-view>
        <view class="modal-actions">
          <button class="btn btn-ghost modal-btn" @click="leaveOpen = false">取消</button>
          <button class="btn btn-primary modal-btn" @click="submitLeave">提交申请</button>
        </view>
      </view>
    </view>

    <!-- 发布签到码（负责人） -->
    <view v-if="mgrCodeOpen" class="modal-mask" @click="mgrCodeOpen = false">
      <view class="modal" @click.stop>
        <view class="modal-title">发布今日签到码</view>
        <picker :range="data.policy.slots" range-key="name" :value="codeSlotIndex" @change="onCodeSlot">
          <view class="modal-input picker-like">{{ data.policy.slots[codeSlotIndex] ? data.policy.slots[codeSlotIndex].name : '选择时段' }}</view>
        </picker>
        <view class="modal-actions">
          <button class="btn btn-ghost modal-btn" @click="mgrCodeOpen = false">取消</button>
          <button class="btn btn-primary modal-btn" @click="submitCode">生成签到码</button>
        </view>
      </view>
    </view>
    <!-- 代签弹窗（考勤负责人） -->
    <view v-if="proxyOpen" class="modal-mask" @click="proxyOpen = false">
      <view class="modal modal-lg" @click.stop>
        <view class="modal-title">代成员打卡</view>
        <scroll-view scroll-y class="modal-scroll">
          <view class="f-label">成员</view>
          <view class="modal-input picker-like">{{ proxyName }}</view>
          <view class="f-label">日期</view>
          <picker mode="date" :value="proxyForm.date" :end="todayStr()" @change="(e) => (proxyForm.date = e.detail.value)">
            <view class="modal-input picker-like">{{ proxyForm.date }}</view>
          </picker>
          <view class="f-label">考勤时段</view>
          <picker :range="data.policy.slots" range-key="name" @change="onProxySlot">
            <view class="modal-input picker-like">{{ proxySlotName }}</view>
          </picker>
          <view class="f-label">打卡时间（可空，默认当前/迟到界限）</view>
          <picker mode="time" :value="proxyForm.time" @change="(e) => (proxyForm.time = e.detail.value)">
            <view class="modal-input picker-like">{{ proxyForm.time || '使用默认时间' }}</view>
          </picker>
          <view class="f-label">备注（选填）</view>
          <input v-model="proxyForm.note" class="modal-input" placeholder="如：设备故障现场补签" maxlength="100" />
        </scroll-view>
        <view class="modal-actions">
          <button class="btn btn-ghost modal-btn" @click="proxyOpen = false">取消</button>
          <button class="btn btn-primary modal-btn" :disabled="proxyBusy" @click="submitProxy">{{ proxyBusy ? '提交中…' : '确认代签' }}</button>
        </view>
      </view>
    </view>
  </view>
  <view v-else class="empty"><view class="empty-text">加载中…</view></view>
</template>

<script setup>
import { ref, reactive, computed } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { confirm, toast } from '../../../utils/guard.js';
import Tabs from '../../../components/Tabs.vue';
import EmptyState from '../../../components/EmptyState.vue';

const id = ref(null);
const data = ref(null);
const tab = ref('today');
const leaveTypes = ['事假', '病假', '公假', '调休', '其他'];

const CELL_META = {
  waiting: { label: '未开始', cls: 'tag-gray' },
  can_checkin: { label: '可打卡', cls: 'tag-blue' },
  absent: { label: '缺勤', cls: 'tag-red' },
  normal: { label: '正常', cls: 'tag-green' },
  late: { label: '迟到', cls: 'tag-amber' },
  leave: { label: '请假', cls: 'tag-purple' },
  leave_pending: { label: '请假待批', cls: 'tag-amber' },
};
function cellMeta(s) { return CELL_META[s] || { label: s, cls: 'tag-gray' }; }
function leaveMeta(s) {
  const m = { pending: { label: '待审批', cls: 'tag-amber' }, approved: { label: '已批准', cls: 'tag-green' }, rejected: { label: '已驳回', cls: 'tag-red' } };
  return m[s] || { label: s, cls: 'tag-gray' };
}
function makeupMeta(s) {
  const m = { pending: { label: '待签到', cls: 'tag-amber' }, checkin: { label: '已签到', cls: 'tag-blue' }, completed: { label: '已完成', cls: 'tag-green' }, missed: { label: '已错过', cls: 'tag-red' } };
  return m[s] || { label: s, cls: 'tag-gray' };
}
function hm(t) { return t ? String(t).slice(11, 16) : ''; }
function weekDay(ds) {
  const d = new Date(String(ds).replace(/-/g, '/'));
  return '周' + '日一二三四五六'[d.getDay()];
}
function sourceLabel(s) { return { self: '本人打卡', proxy: '负责人代签', code: '签到码' }[s] || s; }
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

const workdayText = computed(() => {
  const names = { 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六', 7: '周日' };
  return (data.value.policy.workdays || []).map((w) => names[w]).join('、');
});
const slotText = computed(() => (data.value.policy.slots || []).map((s) => s.start + '-' + s.end).join('，'));
function slot(sid) { return (data.value.policy.slots || []).find((x) => String(x.id) === String(sid)); }
function slotName(sid) { const s = slot(sid); return s ? s.name : '指定时段'; }
function slotTime(sid) { const s = slot(sid); return s ? s.start + ' ~ ' + s.end : ''; }

const tabs = computed(() => {
  const base = [{ key: 'today', label: '今日打卡' }, { key: 'recent', label: '近14天' }, { key: 'leave', label: '请假' }];
  if (data.value && data.value.is_manager) base.push({ key: 'manage', label: '管理' });
  return base;
});

async function load() { data.value = await api.attendanceMy(id.value); }

// ============ 打卡 ============
async function checkin(c) {
  await api.attendanceCheckin(id.value, { slot_id: c.slot_id });
  toast('打卡成功', 'success');
  load();
}
const redeemOpen = ref(false);
const redeemInput = ref('');
function openRedeem() { redeemInput.value = ''; redeemOpen.value = true; }
async function redeemCode() {
  const code = redeemInput.value.trim().toUpperCase();
  if (!code) return toast('请输入签到码');
  await api.attendanceCheckin(id.value, { code });
  redeemOpen.value = false;
  toast('打卡成功', 'success');
  load();
}

// ============ 请假 ============
const leaveOpen = ref(false);
const leaveForm = reactive({ start_date: '', end_date: '', slot_id: '', leave_type: '事假', reason: '', makeup_on: false, makeup_date: '', makeup_time: '' });
const leaveTypeIndex = computed(() => Math.max(0, leaveTypes.indexOf(leaveForm.leave_type)));
const slotRange = computed(() => [{ label: '全天（所有时段）', id: '' }].concat((data.value.policy.slots || []).map((s) => ({ label: s.name + '（' + s.start + '-' + s.end + '）', id: s.id }))));
const slotIndex = computed(() => {
  const i = slotRange.value.findIndex((s) => String(s.id) === String(leaveForm.slot_id));
  return i < 0 ? 0 : i;
});
function onStartDate(e) { leaveForm.start_date = e.detail.value; }
function onEndDate(e) { leaveForm.end_date = e.detail.value; }
function onLeaveType(e) { leaveForm.leave_type = leaveTypes[Number(e.detail.value)]; }
function onSlotPick(e) { leaveForm.slot_id = slotRange.value[Number(e.detail.value)].id; }
function onMakeupSwitch(e) { leaveForm.makeup_on = e.detail.value; }
function onMakeupDate(e) { leaveForm.makeup_date = e.detail.value; }
function onMakeupTime(e) { leaveForm.makeup_time = e.detail.value; }
function openLeaveForm() {
  const ds = todayStr();
  Object.assign(leaveForm, { start_date: ds, end_date: ds, slot_id: '', leave_type: '事假', reason: '', makeup_on: false, makeup_date: '', makeup_time: '' });
  leaveOpen.value = true;
}
async function submitLeave() {
  if (!leaveForm.start_date || !leaveForm.end_date) return toast('请选择请假日期');
  if (leaveForm.end_date < leaveForm.start_date) return toast('结束日期不能早于开始日期');
  if (!leaveForm.reason.trim()) return toast('请填写请假原因');
  const card = { start_date: leaveForm.start_date, end_date: leaveForm.end_date, leave_type: leaveForm.leave_type, reason: leaveForm.reason.trim() };
  if (leaveForm.slot_id) card.slot_id = leaveForm.slot_id;
  if (leaveForm.makeup_on) {
    if (!leaveForm.makeup_date || !leaveForm.makeup_time) return toast('请完整选择补签时间');
    card.makeup_at = leaveForm.makeup_date + ' ' + leaveForm.makeup_time;
  }
  await api.attendanceLeaveCreate(id.value, card);
  leaveOpen.value = false;
  toast('请假已提交', 'success');
  load();
}
async function removeLeave(l) {
  if (!(await confirm('撤销该请假单？'))) return;
  await api.attendanceLeaveDelete(id.value, l.id);
  toast('已撤销', 'success');
  load();
}
async function makeupCheckin(m) {
  await api.attendanceMakeupCheckin(id.value, m.id);
  toast('补签签到成功', 'success');
  load();
}
async function makeupCheckout(m) {
  await api.attendanceMakeupCheckout(id.value, m.id);
  toast('补签已完成', 'success');
  load();
}

// ============ 管理端 ============
const mtab = ref('code');
const mSegs = [{ key: 'code', label: '签到码' }, { key: 'approve', label: '待审批' }, { key: 'board', label: '考勤看板' }, { key: 'stats', label: '统计' }, { key: 'setting', label: '设置' }];
const codes = ref([]);
const managerLeaves = ref([]);
const board = ref(null);
const boardDate = ref(todayStr());
const mgrLoaded = { code: false, approve: false, board: false };
const pendingLeaves = computed(() => managerLeaves.value.filter((l) => l.status === 'pending'));

async function switchManage(k) {
  mtab.value = k;
  if (k === 'code' && !mgrLoaded.code) { mgrLoaded.code = true; loadCodes(); }
  if (k === 'approve' && !mgrLoaded.approve) { mgrLoaded.approve = true; loadApprove(); }
  if (k === 'board' && !mgrLoaded.board) { mgrLoaded.board = true; loadBoard(); }
  if (k === 'stats' && !stats.value) loadStats();
  if (k === 'setting' && !setting.name) loadSettings();
}
async function loadCodes() {
  const r = await api.attendanceCodes(id.value);
  codes.value = r.codes || [];
}
async function loadApprove() {
  const r = await api.attendanceLeaves(id.value);
  managerLeaves.value = r.leaves || [];
}
async function loadBoard() { board.value = await api.attendanceBoard(id.value, { date: boardDate.value }); }
function onBoardDate(e) { boardDate.value = e.detail.value; loadBoard(); }

const mgrCodeOpen = ref(false);
const codeSlotIndex = ref(0);
function openCodeForm() { codeSlotIndex.value = 0; mgrCodeOpen.value = true; }
function onCodeSlot(e) { codeSlotIndex.value = Number(e.detail.value); }
async function submitCode() {
  const slots = data.value.policy.slots || [];
  if (!slots.length) return toast('当前没有考勤时段');
  const s = slots[codeSlotIndex.value] || slots[0];
  await api.attendanceCodeCreate(id.value, { slot_id: s.id });
  mgrCodeOpen.value = false;
  toast('签到码已发布', 'success');
  loadCodes();
}
async function disableCode(c) {
  if (!(await confirm('停用签到码 ' + c.code + '？'))) return;
  await api.attendanceCodeDelete(id.value, c.id);
  loadCodes();
}
function copyCode(code) {
  uni.setClipboardData({ data: code, success: () => toast('签到码已复制', 'success') });
}
async function reviewLeave(l, status) {
  let note = '';
  if (status === 'rejected') {
    const res = await new Promise((resolve) => {
      uni.showModal({
        title: '驳回原因', editable: true, placeholderText: '可填写驳回说明（选填）',
        success: (m) => resolve(m.confirm ? (m.content || '').trim() : null),
      });
    });
    if (res === null) return;
    note = res;
  }
  await api.attendanceLeaveStatus(id.value, l.id, { status, review_note: note });
  toast(status === 'approved' ? '已批准' : '已驳回', 'success');
  loadApprove();
  load();
}

// ============ 统计 ============
const statsMonth = ref(todayStr().slice(0, 7));
const stats = ref(null);
function onStatsMonth(e) { statsMonth.value = e.detail.value; loadStats(); }
async function loadStats() { stats.value = await api.attendanceStats(id.value, { month: statsMonth.value }); }
function attendanceRate(r) {
  const denom = r.total || 0;
  if (!denom) return 0;
  return Math.round(((r.normal + r.late) / denom) * 100);
}

// ============ 规则设置 ============
const workdayOptions = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const setting = reactive({
  name: '', active: 1, workdays: [], slots: [], leave_mode: 'approval',
  allow_makeup: 1, makeup_minutes: 60, start_date: '', end_date: '',
});
const settingBusy = ref(false);
async function loadSettings() {
  const r = await api.attendanceSettings(id.value);
  const s = r.settings || {};
  Object.assign(setting, {
    name: s.name || '考勤规则',
    active: s.active ? 1 : 0,
    workdays: Array.isArray(s.workdays) ? [...s.workdays] : [1, 2, 3, 4, 5],
    slots: (s.slots || []).map((x) => ({ ...x })),
    leave_mode: s.leave_mode || 'approval',
    allow_makeup: s.allow_makeup ? 1 : 0,
    makeup_minutes: s.makeup_minutes || 60,
    start_date: s.start_date || '',
    end_date: s.end_date || '',
  });
  if (!setting.slots.length) setting.slots = [{ id: 's_' + Date.now().toString(36), name: '上午', start: '08:00', late: '08:15', end: '10:00' }];
}
function onActiveSwitch(e) { setting.active = e.detail.value ? 1 : 0; }
function onSettingMakeupSwitch(e) { setting.allow_makeup = e.detail.value ? 1 : 0; }
function toggleWorkday(n) {
  const i = setting.workdays.indexOf(n);
  if (i >= 0) setting.workdays.splice(i, 1); else setting.workdays.push(n);
  setting.workdays.sort();
}
function addSlot() {
  if (setting.slots.length >= 8) return toast('最多 8 个时段');
  setting.slots.push({ id: 's_' + Date.now().toString(36), name: '时段' + (setting.slots.length + 1), start: '14:00', late: '14:15', end: '16:00' });
}
function removeSlot(i) { setting.slots.splice(i, 1); }
async function saveSettings() {
  if (!setting.name.trim()) return toast('请填写规则名称');
  if (!setting.workdays.length) return toast('请至少选择一个工作日');
  if (!setting.slots.length) return toast('请至少设置一个时段');
  settingBusy.value = true;
  try {
    await api.attendanceSettingsSave(id.value, {
      name: setting.name.trim(),
      active: setting.active,
      workdays: setting.workdays,
      slots: setting.slots,
      leave_mode: setting.leave_mode,
      allow_makeup: setting.allow_makeup,
      makeup_minutes: Number(setting.makeup_minutes) || 60,
      start_date: setting.start_date,
      end_date: setting.end_date,
    });
    toast('考勤规则已保存', 'success');
    load();
  } finally {
    settingBusy.value = false;
  }
}
// ============ 代签 ============
const proxyOpen = ref(false);
const proxyBusy = ref(false);
const proxyName = ref('');
const proxyForm = reactive({ user_id: 0, date: '', slot_id: '', time: '', note: '' });
const proxySlotName = computed(() => {
  const s = (data.value.policy.slots || []).find((x) => String(x.id) === String(proxyForm.slot_id));
  return s ? s.name : '选择时段';
});
function openProxy(r) {
  proxyName.value = r.real_name || r.nickname || ('成员#' + r.id);
  Object.assign(proxyForm, { user_id: r.id, date: boardDate.value, slot_id: '', time: '', note: '' });
  proxyOpen.value = true;
}
function onProxySlot(e) {
  const s = data.value.policy.slots[Number(e.detail.value)];
  if (s) proxyForm.slot_id = s.id;
}
async function submitProxy() {
  if (!proxyForm.slot_id) return toast('请选择考勤时段');
  proxyBusy.value = true;
  try {
    const card = { user_id: proxyForm.user_id, date: proxyForm.date, slot_id: proxyForm.slot_id };
    if (proxyForm.time) card.time = proxyForm.time;
    if (proxyForm.note.trim()) card.note = proxyForm.note.trim();
    await api.attendanceProxy(id.value, card);
    toast('代签成功', 'success');
    proxyOpen.value = false;
    loadBoard();
  } finally {
    proxyBusy.value = false;
  }
}

onLoad((o) => { id.value = Number(o.id); });
onShow(() => { if (id.value) load(); });
</script>

<style lang="scss" scoped>
.policy-card .p-head { display: flex; justify-content: space-between; align-items: center; }
.p-name { font-size: 32rpx; font-weight: 800; color: #1e293b; }
.p-line { font-size: 25rpx; color: #475569; margin-top: 10rpx; }
.p-warn { margin-top: 14rpx; background: #fef3c7; color: #b45309; font-size: 24rpx; border-radius: 10rpx; padding: 14rpx 18rpx; }
.hint-card { text-align: center; color: #64748b; font-size: 27rpx; padding: 44rpx 28rpx; }

.slot-card .s-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16rpx; }
.s-main { display: flex; flex-direction: column; gap: 8rpx; }
.s-name { font-size: 30rpx; font-weight: 700; color: #1e293b; }
.s-time { font-size: 24rpx; color: #64748b; }
.s-record { margin-top: 14rpx; font-size: 25rpx; color: #166534; }
.s-record.miss { color: #b91c1c; }
.s-ops, .mk-ops { display: flex; justify-content: flex-end; margin-top: 16rpx; }
.btn-sm { height: 64rpx; line-height: 64rpx; font-size: 26rpx; border-radius: 32rpx; padding: 0 40rpx; }

.day-card .d-head { display: flex; justify-content: space-between; align-items: center; }
.d-date { font-weight: 700; color: #334155; font-size: 27rpx; }
.d-cells { display: flex; flex-wrap: wrap; gap: 10rpx; margin-top: 14rpx; }
.mini-tag { font-size: 21rpx; border-radius: 8rpx; padding: 4rpx 12rpx; line-height: 1.6; }

.leave-card .l-head, .mk-head, .c-head, .br-head { display: flex; justify-content: space-between; align-items: center; gap: 12rpx; }
.l-type, .mk-title, .c-code, .br-name { font-size: 28rpx; font-weight: 700; color: #1e293b; }
.c-code { font-size: 38rpx; letter-spacing: 6rpx; color: #2563eb; }
.l-line { font-size: 25rpx; color: #475569; margin-top: 10rpx; }
.l-ops { display: flex; gap: 14rpx; justify-content: flex-end; margin-top: 16rpx; }
.mini-btn { background: #eff6ff; color: #2563eb; font-size: 24rpx; border-radius: 26rpx; padding: 10rpx 28rpx; }
.mini-btn.danger { background: #fee2e2; color: #ef4444; }
.mk-card { border-left: 6rpx solid #2563eb; }

.seg { display: flex; background: #fff; border-radius: 16rpx; padding: 8rpx; margin-bottom: 18rpx; border: 1rpx solid #e2e8f0; }
.seg-item { flex: 1; text-align: center; font-size: 26rpx; color: #64748b; padding: 16rpx 0; border-radius: 12rpx; }
.seg-item.on { background: #2563eb; color: #fff; font-weight: 700; }
.board-picker { font-size: 27rpx; color: #1e40af; text-align: center; }
.board-picker.card { margin-bottom: 18rpx; }

.modal-mask { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); z-index: 100; display: flex; align-items: center; justify-content: center; padding: 48rpx; }
.modal { width: 100%; background: #fff; border-radius: 24rpx; padding: 32rpx; }
.modal-lg { max-height: 80vh; display: flex; flex-direction: column; }
.modal-title { font-size: 32rpx; font-weight: 800; color: #1e293b; margin-bottom: 20rpx; text-align: center; }
.modal-scroll { max-height: 56vh; }
.modal-input { background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 14rpx; padding: 20rpx 22rpx; font-size: 27rpx; margin-bottom: 16rpx; }
.picker-like { color: #334155; }
.modal-textarea { width: 100%; box-sizing: border-box; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 14rpx; padding: 20rpx 22rpx; font-size: 27rpx; min-height: 160rpx; margin-bottom: 16rpx; }
.f-label { font-size: 24rpx; color: #64748b; margin: 6rpx 4rpx 8rpx; }
.switch-row { display: flex; justify-content: space-between; align-items: center; font-size: 26rpx; color: #334155; margin: 8rpx 0 16rpx; }
.modal-actions { display: flex; gap: 18rpx; margin-top: 8rpx; }
.modal-btn { flex: 1; height: 80rpx; font-size: 28rpx; }
.wd-row { display: flex; gap: 10rpx; flex-wrap: wrap; margin-bottom: 16rpx; }
.wd-chip { background: #f1f5f9; color: #64748b; border-radius: 12rpx; padding: 12rpx 20rpx; font-size: 24rpx; }
.wd-chip.on { background: #2563eb; color: #fff; }
.slot-edit { background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 14rpx; padding: 18rpx; margin-bottom: 14rpx; }
.slot-name-input { height: 68rpx; background: #fff; border: 1rpx solid #e2e8f0; border-radius: 10rpx; padding: 0 18rpx; font-size: 26rpx; margin-bottom: 12rpx; }
.slot-times { display: flex; align-items: center; gap: 12rpx; flex-wrap: wrap; }
.time-pick { background: #eff6ff; color: #2563eb; border-radius: 10rpx; padding: 10rpx 18rpx; font-size: 24rpx; }
.slot-del { color: #ef4444; font-size: 24rpx; padding: 0 10rpx; }
.add-slot { display: inline-block; margin-bottom: 18rpx; }
.stat-row { padding: 22rpx 26rpx; }
.stat-name { font-size: 28rpx; font-weight: 700; color: #1e293b; display: block; margin-bottom: 12rpx; }
.stat-cells { display: flex; gap: 10rpx; flex-wrap: wrap; }
.stat-rate { font-size: 23rpx; color: #2563eb; margin-top: 12rpx; font-weight: 600; }
</style>