<template>
  <view class="page-wrap">
    <Tabs :tabs="tabs" :model-value="tab" @update:model-value="switchTab" />

    <!-- ============ 待办 ============ -->
    <view v-if="tab === 'due'">
      <EmptyState v-if="!dues.length" icon="✅" text="当前没有待办打卡任务" />
      <view v-for="d in dues" :key="d.schedule.id + '-' + d.period_key" class="card due-card">
        <view class="due-head">
          <text class="due-title ellipsis">{{ d.schedule.title }}</text>
          <text class="tag" :class="statusCls(d.status)">{{ statusText(d) }}</text>
        </view>
        <view class="due-meta">周期：{{ d.period_key }}<text v-if="d.overdue" class="overdue">（历史周期补交）</text></view>
        <view class="due-meta">截止：{{ d.due_at }}</view>
        <view v-if="d.schedule.need_self_progress || d.schedule.need_self_rating" class="due-meta">
          打卡要求：
          <text v-if="d.schedule.need_self_progress">自评进度</text>
          <text v-if="d.schedule.need_self_progress && d.schedule.need_self_rating">、</text>
          <text v-if="d.schedule.need_self_rating">自评星级</text>
        </view>
        <view class="due-actions">
          <button class="btn" :class="d.log ? 'btn-ghost' : 'btn-primary'" @click="openSubmit(d)">
            {{ d.log ? '查看 / 修改打卡' : (d.status === 'late_window' || d.overdue ? '补交打卡' : '去打卡') }}
          </button>
        </view>
      </view>
    </view>

    <!-- ============ 任务 ============ -->
    <view v-else-if="tab === 'sched'">
      <button v-if="canTask" class="btn btn-primary btn-block" @click="openSchedCreate">＋ 新建打卡任务</button>
      <EmptyState v-if="!schedules.length" icon="🗂" text="还没有打卡任务，负责人可创建" />
      <view v-for="s in schedules" :key="s.id" class="card sched-card" :class="{ off: !s.active }">
        <view class="sched-head">
          <text class="sched-title">{{ s.title }}</text>
          <text class="tag" :class="s.active ? 'tag-green' : 'tag-gray'">{{ s.active ? '进行中' : '已停用' }}</text>
        </view>
        <view class="sched-meta">{{ freqText(s) }}</view>
        <view class="sched-meta">
          迟交通道：{{ s.allow_late ? '允许补交' : '关闭' }}
          <text v-if="s.need_self_progress"> · 自评进度</text>
          <text v-if="s.need_self_rating"> · 自评星级</text>
          <text v-if="s.auto_feature"> · {{ s.auto_feature }} 星自动精选</text>
        </view>
        <view v-if="canTask" class="sched-actions">
          <view class="mini-btn" @click="openSchedEdit(s)">编辑</view>
          <view class="mini-btn" @click="toggleActive(s)">{{ s.active ? '停用' : '启用' }}</view>
          <view class="mini-btn danger" @click="removeSched(s)">删除</view>
        </view>
      </view>
    </view>

    <!-- ============ 看板 ============ -->
    <view v-else-if="tab === 'board'">
      <view v-if="!schedules.length" class="empty"><view class="empty-text">暂无打卡任务</view></view>
      <template v-else>
        <view class="filter-row">
          <picker :range="schedNames" @change="onBoardSched">
            <view class="filter-pick">任务：{{ boardSchedName }} ▾</view>
          </picker>
          <picker :range="roleNames" @change="onBoardRole">
            <view class="filter-pick">角色：{{ roleNames[boardRoleIdx] }} ▾</view>
          </picker>
        </view>
        <view v-if="board" class="card board-summary">
          已提交 {{ board.submitted_total }} 人次 · 成员 {{ board.members.length }} 人 · 周期 {{ board.periods.length }} 期
        </view>
        <scroll-view v-if="board" scroll-x class="board-scroll">
          <view class="board-table">
            <view class="board-row board-header">
              <view class="cell-name">成员</view>
              <view v-for="p in board.periods" :key="p.key" class="cell-period">{{ p.label }}</view>
            </view>
            <view v-for="m in board.members" :key="m.id" class="board-row">
              <view class="cell-name">
                <text class="ellipsis">{{ boardName(m) }}</text>
              </view>
              <view
                v-for="c in m.cells"
                :key="c.key"
                class="cell-state"
                :class="'st-' + c.state"
                @click="c.log_id ? openLog(c.log_id) : null"
              >
                <text v-if="c.log_id">{{ c.score ? c.score + '分' : (c.state === 'late' ? '迟' : '交') }}</text>
                <text v-else class="cell-dot">{{ c.state === 'miss' ? '缺' : '·' }}</text>
              </view>
            </view>
          </view>
        </scroll-view>
        <view class="legend">
          <text class="lg st-on">按时</text>
          <text class="lg st-late">迟交</text>
          <text class="lg st-miss">缺卡</text>
          <text class="lg st-wait">未到期</text>
          <text class="lg-tip">点击「交/迟」格子查看汇报详情</text>
        </view>
      </template>
    </view>

    <!-- ============ 排行 / 优秀墙 ============ -->
    <view v-else>
      <view class="filter-row">
        <view class="seg">
          <view class="seg-item" :class="{ on: rankRange === 'month' }" @click="setRange('month')">本月</view>
          <view class="seg-item" :class="{ on: rankRange === 'all' }" @click="setRange('all')">全部</view>
        </view>
        <picker :range="rankSchedNames" @change="onRankSched">
          <view class="filter-pick">{{ rankSchedNames[rankSchedIdx] }} ▾</view>
        </picker>
      </view>

      <view class="section-title">打卡排行榜</view>
      <EmptyState v-if="!leaderboard.length" icon="🏆" text="暂无打卡记录" />
      <view v-for="(m, i) in leaderboard" :key="m.id" class="card rank-row">
        <text class="rank-no" :class="{ top: i < 3 }">{{ i + 1 }}</text>
        <view class="rank-main">
          <text class="rank-name ellipsis">{{ boardName(m) }}</text>
          <view class="rank-stats">
            <text>打卡 {{ m.cnt }} 次</text>
            <text>准时率 {{ m.punctuality }}%</text>
            <text v-if="m.avg_score">均分 {{ m.avg_score }}</text>
            <text v-if="m.featured_cnt">精选 {{ m.featured_cnt }}</text>
            <text v-if="m.streak">连续 {{ m.streak }} 天</text>
          </view>
        </view>
      </view>

      <view class="section-title">当期优秀汇报</view>
      <EmptyState
        v-if="!featuredGroups.current.length"
        icon="⭐"
        :text="featuredList.length ? '本周暂无优秀汇报' : '还没有精选汇报'"
      />
      <view v-for="r in featuredGroups.current" :key="r.id" class="card ft-card" @click="openLog(r.id)">
        <view class="ft-head">
          <text class="ft-name">{{ logAuthorName(r) }}</text>
          <text class="tag tag-amber">精选{{ r.score ? ' · ' + r.score + '分' : '' }}</text>
        </view>
        <view class="ft-content ellipsis-2">{{ stripHtml(r.content) || '（附图汇报）' }}</view>
        <view class="ft-meta">{{ r.schedule_title }} · {{ r.create_time }}</view>
      </view>
      <template v-if="featuredGroups.past.length">
        <view class="ft-past-head" @click="pastFtOpen = !pastFtOpen">
          <text class="ft-arrow" :class="{ open: pastFtOpen }">▸</text>
          <text class="ft-past-title">往期优秀汇报（{{ featuredGroups.past.length }}）</text>
          <text class="ft-past-hint">{{ pastFtOpen ? '收起' : '展开' }}</text>
        </view>
        <view v-if="pastFtOpen">
          <view v-for="r in featuredGroups.past" :key="r.id" class="card ft-card" @click="openLog(r.id)">
        <view class="ft-head">
          <text class="ft-name">{{ logAuthorName(r) }}</text>
          <text class="tag tag-amber">精选{{ r.score ? ' · ' + r.score + '分' : '' }}</text>
        </view>
        <view class="ft-content ellipsis-2">{{ stripHtml(r.content) || '（附图汇报）' }}</view>
        <view class="ft-meta">{{ r.schedule_title }} · {{ r.create_time }}</view>
          </view>
        </view>
      </template>
    </view>

    <!-- ============ 打卡提交弹窗 ============ -->
    <view v-if="subOpen" class="modal-mask" @click="subOpen = false">
      <view class="modal" @click.stop>
        <view class="modal-title">{{ subTarget && subTarget.schedule.title }}</view>
        <view class="modal-desc text-muted" v-if="subTarget">
          周期 {{ subTarget.period_key }} · 截止 {{ subTarget.due_at }}
        </view>
        <textarea v-model="subContent" class="modal-textarea" placeholder="记录本期进展、问题与下一步…" maxlength="3000" />
        <view v-if="subTarget && subTarget.schedule.need_self_progress" class="rate-row">
          <text class="rate-label">自评进度</text>
          <view class="stepper">
            <view class="step-btn" @click="stepProgress(-10)">－</view>
            <text class="step-val">{{ subProgress }}%</text>
            <view class="step-btn" @click="stepProgress(10)">＋</view>
          </view>
        </view>
        <view v-if="subTarget && subTarget.schedule.need_self_rating" class="rate-row">
          <text class="rate-label">自评星级</text>
          <view class="stars">
            <text v-for="n in 5" :key="n" class="star" :class="{ on: n <= subRating }" @click="subRating = n">★</text>
          </view>
        </view>
        <view class="img-line">
          <view class="mini-btn" @click="addSubImage">📷 附图/附件{{ subImages.length ? '(' + subImages.length + ')' : '' }}</view>
        </view>
        <view v-if="subImageEntries.length" class="img-preview">
          <image v-for="e in subImageEntries" :key="e.idx" :src="e.att.temp" class="thumb" mode="aspectFill" @click="previewImg(e.att.temp)" />
        </view>
        <view v-for="e in subFileEntries" :key="'f' + e.idx" class="sub-file">
          <text class="sub-file-icon">📄</text>
          <text class="sub-file-name" @click="openSubFile(e.att)">{{ e.att.name || '附件' }}</text>
        </view>
        <view class="modal-actions">
          <button class="btn btn-ghost modal-btn" @click="subOpen = false">取消</button>
          <button class="btn btn-primary modal-btn" :disabled="subBusy" @click="submitCheckin">
            {{ subBusy ? '提交中…' : '提交打卡' }}
          </button>
        </view>
      </view>
    </view>

    <!-- ============ 任务表单弹窗 ============ -->
    <view v-if="schedOpen" class="modal-mask" @click="schedOpen = false">
      <view class="modal modal-lg" @click.stop>
        <view class="modal-title">{{ editing ? '编辑打卡任务' : '新建打卡任务' }}</view>
        <scroll-view scroll-y class="form-scroll">
          <view class="form-label">任务标题（1–40 字）</view>
          <input v-model="sf.title" class="modal-input" placeholder="如：每日学习进展汇报" maxlength="40" />

          <view class="form-label">任务类型</view>
          <view class="seg">
            <view class="seg-item" :class="{ on: sf.kind === 'recurring' }" @click="setKind('recurring')">周期任务</view>
            <view class="seg-item" :class="{ on: sf.kind === 'once' }" @click="setKind('once')">定时汇报</view>
          </view>

          <template v-if="sf.kind === 'once'">
            <view class="form-label">截止日期</view>
            <picker mode="date" :value="sf.once_date" @change="(e) => (sf.once_date = e.detail.value)">
              <view class="pick-box">{{ sf.once_date || '选择日期' }}</view>
            </picker>
            <view class="form-label">截止时间</view>
            <picker mode="time" :value="sf.once_time" @change="(e) => (sf.once_time = e.detail.value)">
              <view class="pick-box">{{ sf.once_time || '选择时间' }}</view>
            </picker>
          </template>

          <template v-else>
            <view class="form-label">周期频率</view>
            <view class="seg">
              <view class="seg-item" :class="{ on: sf.freq === 'daily' }" @click="setFreq('daily')">每日</view>
              <view class="seg-item" :class="{ on: sf.freq === 'weekly' }" @click="setFreq('weekly')">每周</view>
            </view>
            <template v-if="sf.freq === 'weekly'">
              <view class="form-label">截止星期{{ legacyMulti ? '（可多选）' : '（单选）' }}</view>
              <view class="wd-row">
                <view v-for="(w, i) in WD" :key="i" class="wd-chip" :class="{ on: sf.weekdays.indexOf(i + 1) >= 0 }" @click="toggleWeekday(i + 1)">
                  周{{ w }}
                </view>
              </view>
            </template>
            <view class="form-label">每日截止时间</view>
            <picker mode="time" :value="sf.due_time" @change="(e) => (sf.due_time = e.detail.value)">
              <view class="pick-box">{{ sf.due_time }}</view>
            </picker>
            <view class="form-label">开始日期</view>
            <picker mode="date" :value="sf.start_date" @change="(e) => (sf.start_date = e.detail.value)">
              <view class="pick-box">{{ sf.start_date }}</view>
            </picker>
            <view class="form-label">结束日期（可空，表示长期）</view>
            <picker mode="date" :value="sf.end_date" @change="(e) => (sf.end_date = e.detail.value)">
              <view class="pick-box">{{ sf.end_date || '长期有效' }}</view>
            </picker>
          </template>

          <view class="form-label">规则开关</view>
          <view class="switch-row" @click="sf.allow_late = sf.allow_late ? 0 : 1">
            <text>允许迟交通道</text><text class="switch" :class="{ on: sf.allow_late }"></text>
          </view>
          <view class="switch-row" @click="sf.need_self_progress = sf.need_self_progress ? 0 : 1">
            <text>提交时填写自评进度（0–100）</text><text class="switch" :class="{ on: sf.need_self_progress }"></text>
          </view>
          <view class="switch-row" @click="sf.need_self_rating = sf.need_self_rating ? 0 : 1">
            <text>提交时填写自评星级（1–5）</text><text class="switch" :class="{ on: sf.need_self_rating }"></text>
          </view>
          <view class="form-label">自动精选规则</view>
          <view class="seg">
            <view class="seg-item" :class="{ on: sf.auto_feature === 0 }" @click="sf.auto_feature = 0">关闭</view>
            <view class="seg-item" :class="{ on: sf.auto_feature === 4 }" @click="sf.auto_feature = 4">4 星</view>
            <view class="seg-item" :class="{ on: sf.auto_feature === 5 }" @click="sf.auto_feature = 5">5 星</view>
          </view>
        </scroll-view>
        <view class="modal-actions">
          <button class="btn btn-ghost modal-btn" @click="schedOpen = false">取消</button>
          <button class="btn btn-primary modal-btn" :disabled="schedSaving" @click="saveSched">
            {{ schedSaving ? '保存中…' : '保存' }}
          </button>
        </view>
      </view>
    </view>

    <!-- ============ 汇报详情弹窗 ============ -->
    <view v-if="logOpen && logDetail" class="modal-mask" @click="logOpen = false">
      <view class="modal modal-lg" @click.stop>
        <view class="modal-title ellipsis">{{ logDetail.schedule_title || '打卡汇报' }}</view>
        <scroll-view scroll-y class="form-scroll">
          <view class="log-meta">
            {{ logAuthorName(logDetail) }} · {{ logDetail.create_time }}
            <text v-if="logDetail.is_late" class="tag tag-amber">迟交</text>
            <text v-if="logDetail.featured" class="tag tag-amber">精选</text>
          </view>
          <view v-if="logDetail.self_progress !== null && logDetail.self_progress !== undefined" class="log-meta">
            自评进度：{{ logDetail.self_progress }}%
          </view>
          <view v-if="logDetail.self_rating" class="log-meta">自评星级：{{ logDetail.self_rating }} ★</view>
          <view v-if="stripHtml(logDetail.content)" class="log-content">{{ stripHtml(logDetail.content) }}</view>
          <AttachmentList v-if="logDetail.attachments && logDetail.attachments.length" :attachments="logDetail.attachments" />
          <view v-if="logDetail.comments && logDetail.comments.length" class="comment-list">
            <view v-for="c in logDetail.comments" :key="c.id" class="comment-item">
              <text class="c-name">{{ commentAuthorName(c) }}：</text><text>{{ c.content }}</text>
            </view>
          </view>

          <template v-if="canTask">
            <view class="form-label" style="margin-top: 20rpx">组长评分</view>
            <view class="stars">
              <text v-for="n in 5" :key="n" class="star big" :class="{ on: n <= rvScore }" @click="rvScore = rvScore === n ? 0 : n">★</text>
              <text class="rate-clear" @click="rvScore = 0">清除</text>
            </view>
            <view class="form-label">点评（可选）</view>
            <textarea v-model="rvReview" class="modal-textarea" placeholder="给成员一句点评…" maxlength="500" />
            <view class="switch-row" @click="rvFeatured = rvFeatured ? 0 : 1">
              <text>标记为优秀汇报</text><text class="switch" :class="{ on: rvFeatured }"></text>
            </view>
          </template>
          <view v-else-if="logDetail.score || logDetail.review" class="review-box">
            <text v-if="logDetail.score" class="tag tag-blue">组长评分 {{ logDetail.score }} 星</text>
            <text v-if="logDetail.review" class="review-text">{{ logDetail.review }}</text>
          </view>
        </scroll-view>
        <view class="modal-actions">
          <button class="btn btn-ghost modal-btn" @click="logOpen = false">关闭</button>
          <button v-if="canTask" class="btn btn-primary modal-btn" :disabled="reviewBusy" @click="saveReview">
            {{ reviewBusy ? '保存中…' : '保存评价' }}
          </button>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, reactive, computed, watch } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { confirm, toast } from '../../../utils/guard.js';
import { chooseImageAsBase64, isImage } from '../../../utils/fileBase64.js';
import Tabs from '../../../components/Tabs.vue';
import EmptyState from '../../../components/EmptyState.vue';
import AttachmentList from '../../../components/AttachmentList.vue';
import { previewAttachment } from '../../../utils/preview.js';
import { displayName, teamDisplayName } from '../../../utils/displayName.js';

const WD = ['一', '二', '三', '四', '五', '六', '日'];
const tabs = [
  { key: 'due', label: '待办' },
  { key: 'sched', label: '任务' },
  { key: 'board', label: '看板' },
  { key: 'rank', label: '排行' },
];

const id = ref(null);
const tab = ref('due');
const detail = ref(null);
const dues = ref([]);
const schedules = ref([]);
const leaderboard = ref([]);
const featuredList = ref([]);

const canTask = computed(() => !!(detail.value && (detail.value.me.is_owner || detail.value.perms.task)));

function todayStr() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}
function stripHtml(html) {
  return String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
}
function freqText(s) {
  if (s.kind === 'once') return '定时 · ' + String(s.once_at || '').replace('T', ' ');
  if (s.freq === 'daily') return '每日 ' + s.due_time + ' 截止' + (s.end_date ? '（至 ' + s.end_date + '）' : '');
  const names = (s.weekdays || []).slice().sort().map((x) => '周' + WD[x - 1]).join('、');
  if ((s.weekdays || []).length === 1) return '每' + names + ' ' + s.due_time + ' 截止 · 周期内可提前提交';
  return '每周 ' + names + ' · ' + s.due_time + ' 截止';
}
function statusText(d) {
  if (d.log) return d.late ? '已补交' : '已提交';
  if (d.status === 'waiting') return '待提交';
  if (d.status === 'late_window' || d.overdue) return '可补交';
  if (d.status === 'missed') return '已缺卡';
  return d.status;
}
function statusCls(status) {
  if (status === 'submitted') return 'tag-green';
  if (status === 'waiting') return 'tag-blue';
  if (status === 'late_window') return 'tag-amber';
  return 'tag-red';
}
function attUrl(a) {
  if (a.data) return 'data:' + (a.mime || 'image/jpeg') + ';base64,' + a.data;
  return a.url || '';
}
function previewImg(url) { uni.previewImage({ urls: [url] }); }
// 实名展示：看板/排行榜行自带 real_name（字段名为 name）；汇报/评论按 user_id 从成员名单解析
function boardName(m) {
  return displayName({ real_name: m.real_name, nickname: m.name || m.nickname, username: m.username, id: m.id }) || m.name || '?';
}
function teamMembers() { return detail.value?.members || []; }
function logAuthorName(l) { return teamDisplayName(l, teamMembers()) || l.nickname || '成员'; }
function commentAuthorName(c) { return teamDisplayName(c, teamMembers()) || c.nickname || '成员'; }


async function loadBase() { detail.value = await api.teamDetail(id.value); }
async function loadDues() {
  const r = await api.checkinMy(id.value);
  dues.value = r.dues || [];
}
async function loadSchedules() {
  const r = await api.checkinSchedules(id.value);
  schedules.value = r.schedules || [];
  if (!boardSchedId.value && schedules.value.length) boardSchedId.value = schedules.value[0].id;
}
async function loadAll() {
  await loadBase();
  await Promise.all([loadDues(), loadSchedules()]);
}

function switchTab(k) {
  tab.value = k;
  if (k === 'board' && boardSchedId.value && !board.value) loadBoard();
  if (k === 'rank' && !leaderboard.value.length) loadRank();
}

// ---------- 打卡提交 ----------
const subOpen = ref(false);
const subTarget = ref(null);
const subContent = ref('');
const subImages = ref([]);
const subProgress = ref(0);
const subRating = ref(0);
const subBusy = ref(false);
const subImageEntries = computed(() => subImages.value.map((a, idx) => ({ att: a, idx })).filter((e) => isImage(e.att)));
const subFileEntries = computed(() => subImages.value.map((a, idx) => ({ att: a, idx })).filter((e) => !isImage(e.att)));
function openSubFile(a) { previewAttachment(a); }

async function openSubmit(d) {
  subTarget.value = d;
  subContent.value = '';
  subImages.value = [];
  subProgress.value = 0;
  subRating.value = 0;
  if (d.log && d.log.id) {
    try {
      const rows = await api.checkinLogsByIds(id.value, [d.log.id]);
      const full = rows && rows.length ? rows[0] : null;
      if (full) {
        subContent.value = stripHtml(full.content);
        subProgress.value = full.self_progress || 0;
        subRating.value = full.self_rating || 0;
        subImages.value = (full.attachments || []).map((a) => Object.assign({}, a, { temp: attUrl(a) }));
      }
    } catch (e) { /* 拉取旧内容失败仍允许新提交 */ }
  }
  subOpen.value = true;
}
async function addSubImage() {
  try {
    const att = await chooseImageAsBase64(7);
    subImages.value.push(Object.assign({}, att, { temp: attUrl(att) }));
  } catch (e) { /* 用户取消 */ }
}
function stepProgress(delta) {
  let v = Number(subProgress.value) + delta;
  if (v < 0) v = 0;
  if (v > 100) v = 100;
  subProgress.value = v;
}
async function submitCheckin() {
  const t = subTarget.value;
  if (!t) return;
  if (!subContent.value.trim() && !subImages.value.length) return toast('内容或附件至少填写一项');
  subBusy.value = true;
  try {
    const sched = t.schedule;
    const card = {
      schedule_id: sched.id,
      period_key: t.period_key,
      content: subContent.value,
      attachments: subImages.value.map(({ temp, ...rest }) => rest),
    };
    if (sched.need_self_progress) card.self_progress = Number(subProgress.value) || 0;
    if (sched.need_self_rating) card.self_rating = Number(subRating.value) || 0;
    const r = await api.checkinSubmit(id.value, card);
    toast(r.message || '打卡成功', 'success');
    subOpen.value = false;
    loadDues();
  } finally {
    subBusy.value = false;
  }
}

// ---------- 任务 CRUD ----------
const schedOpen = ref(false);
const editing = ref(null);
const schedSaving = ref(false);
const legacyMulti = ref(false);
const sf = reactive({
  title: '', kind: 'recurring', freq: 'daily', weekdays: [], due_time: '21:00',
  start_date: '', end_date: '', once_date: '', once_time: '21:00',
  allow_late: 1, need_self_progress: 0, need_self_rating: 0, auto_feature: 0,
});
function resetSf() {
  Object.assign(sf, {
    title: '', kind: 'recurring', freq: 'daily', weekdays: [], due_time: '21:00',
    start_date: todayStr(), end_date: '', once_date: todayStr(), once_time: '21:00',
    allow_late: 1, need_self_progress: 0, need_self_rating: 0, auto_feature: 0,
  });
  legacyMulti.value = false;
}
function openSchedCreate() { resetSf(); editing.value = null; schedOpen.value = true; }
function openSchedEdit(s) {
  editing.value = s;
  legacyMulti.value = (s.weekdays || []).length > 1;
  Object.assign(sf, {
    title: s.title, kind: s.kind, freq: s.freq, weekdays: [...(s.weekdays || [])],
    due_time: s.due_time || '21:00', start_date: s.start_date || todayStr(),
    end_date: s.end_date || '', once_date: (s.once_at || '').slice(0, 10) || todayStr(),
    once_time: (s.once_at || '').slice(11, 16) || '21:00',
    allow_late: s.allow_late ? 1 : 0, need_self_progress: s.need_self_progress ? 1 : 0,
    need_self_rating: s.need_self_rating ? 1 : 0, auto_feature: s.auto_feature || 0,
  });
  schedOpen.value = true;
}
function setKind(k) { sf.kind = k; }
function setFreq(f) {
  sf.freq = f;
  if (f === 'weekly' && !legacyMulti.value) {
    if (sf.weekdays.length !== 1) sf.weekdays = [7];
    if (!editing.value) sf.due_time = '23:59';
  }
}
function toggleWeekday(n) {
  const i = sf.weekdays.indexOf(n);
  if (legacyMulti.value) {
    if (i >= 0) sf.weekdays.splice(i, 1); else sf.weekdays.push(n);
  } else {
    sf.weekdays = i >= 0 ? [] : [n];
  }
}
async function saveSched() {
  if (!sf.title.trim()) return toast('请填写任务标题');
  if (sf.kind === 'once' && (!sf.once_date || !sf.once_time)) return toast('请选择定时汇报的截止日期与时间');
  if (sf.kind === 'recurring' && sf.freq === 'weekly' && !sf.weekdays.length) return toast('请选择截止星期');
  const body = {
    title: sf.title.trim(),
    kind: sf.kind,
    allow_late: sf.allow_late ? 1 : 0,
    need_self_progress: sf.need_self_progress ? 1 : 0,
    need_self_rating: sf.need_self_rating ? 1 : 0,
    auto_feature: sf.auto_feature,
  };
  if (sf.kind === 'once') {
    body.once_at = sf.once_date + 'T' + sf.once_time;
  } else {
    body.freq = sf.freq;
    body.weekdays = sf.weekdays;
    body.due_time = sf.due_time;
    body.start_date = sf.start_date;
    body.end_date = sf.end_date;
  }
  schedSaving.value = true;
  try {
    if (editing.value) await api.checkinScheduleUpdate(id.value, editing.value.id, body);
    else await api.checkinScheduleCreate(id.value, body);
    toast('已保存', 'success');
    schedOpen.value = false;
    await loadSchedules();
  } finally {
    schedSaving.value = false;
  }
}
async function toggleActive(s) {
  const body = { active: s.active ? 0 : 1 };
  await api.checkinScheduleUpdate(id.value, s.id, body);
  toast(s.active ? '已停用' : '已启用', 'success');
  loadSchedules();
}
async function removeSched(s) {
  if (!(await confirm('删除打卡任务「' + s.title + '」？历史汇报保留，但不再继续打卡。'))) return;
  await api.checkinScheduleDelete(id.value, s.id);
  toast('已删除', 'success');
  board.value = null;
  await loadSchedules();
}

// ---------- 看板 ----------
const boardSchedId = ref(0);
const boardRoleIdx = ref(0);
const board = ref(null);
let boardRoleIdForReq = '';
const schedNames = computed(() => schedules.value.map((s) => s.title));
const boardSchedName = computed(() => {
  const s = schedules.value.find((x) => x.id === boardSchedId.value);
  return s ? s.title : '请选择';
});
const roleNames = computed(() => {
  const names = ['全部角色'];
  if (board.value) for (const r of board.value.roles) names.push(r.name);
  return names;
});
function onBoardSched(e) {
  const idx = Number(e.detail.value);
  const s = schedules.value[idx];
  if (s) { boardSchedId.value = s.id; loadBoard(); }
}
function onBoardRole(e) {
  boardRoleIdx.value = Number(e.detail.value);
  if (board.value) {
    const r = board.value.roles[boardRoleIdx.value - 1];
    boardRoleIdForReq = r ? r.id : '';
    loadBoard();
  }
}
async function loadBoard() {
  const sid = boardSchedId.value;
  if (!sid) return;
  board.value = await api.checkinBoard(id.value, sid, { role_id: boardRoleIdForReq });
}

// ---------- 汇报详情 / 评分 ----------
const logOpen = ref(false);
const logDetail = ref(null);
const rvScore = ref(0);
const rvReview = ref('');
const rvFeatured = ref(0);
const reviewBusy = ref(false);
async function openLog(lid) {
  const rows = await api.checkinLogsByIds(id.value, [lid]);
  if (!rows || !rows.length) return toast('汇报不存在或已删除');
  logDetail.value = rows[0];
  rvScore.value = rows[0].score || 0;
  rvReview.value = rows[0].review || '';
  rvFeatured.value = rows[0].featured ? 1 : 0;
  logOpen.value = true;
}
async function saveReview() {
  if (!logDetail.value) return;
  reviewBusy.value = true;
  try {
    await api.checkinReview(id.value, logDetail.value.id, {
      score: rvScore.value || null,
      review: rvReview.value,
      featured: rvFeatured.value,
    });
    toast('已评价', 'success');
    logOpen.value = false;
    if (tab.value === 'board') loadBoard();
    if (tab.value === 'rank') loadRank();
  } finally {
    reviewBusy.value = false;
  }
}

// ---------- 排行榜 / 优秀墙 ----------
const rankRange = ref('month');
const rankSchedIdx = ref(0);
const rankSchedNames = computed(() => ['全部任务', ...schedules.value.map((s) => s.title)]);
function setRange(r) { rankRange.value = r; loadRank(); }
function onRankSched(e) { rankSchedIdx.value = Number(e.detail.value); loadRank(); }
async function loadRank() {
  const card = { range: rankRange.value };
  const sched = schedules.value[rankSchedIdx.value - 1];
  if (sched) card.schedule_id = sched.id;
  const [lb, ft] = await Promise.all([
    api.checkinLeaderboard(id.value, card),
    api.checkinFeatured(id.value, sched ? { schedule_id: sched.id } : {}),
  ]);
  leaderboard.value = lb.board || [];
  featuredList.value = ft.reports || [];
}

// ---------- 优秀墙：当期（最新一周）常显，往期合并折叠 ----------
function isoWeekOf(dateStr) {
  const [Y, M, D] = String(dateStr).split('-').map(Number);
  const d = new Date(Date.UTC(Y, M - 1, D));
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - day + 3); // 本周四
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  firstThu.setUTCDate(firstThu.getUTCDate() - ((firstThu.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((d - firstThu) / (7 * 864e5));
  return { year: d.getUTCFullYear(), week, key: `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}` };
}
function currentIsoWeekKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return isoWeekOf(`${y}-${m}-${d}`).key;
}
function featuredWeekKey(r) {
  // 周打卡 period_key 为 YYYY-Www；日打卡为 YYYY-MM-DD；异常缺省时回退 create_time
  const pk = r.period_key || (r.create_time ? String(r.create_time).slice(0, 10) : '');
  if (!pk) return 'unknown';
  return /W/.test(pk) ? pk : isoWeekOf(pk).key;
}
const featuredGroups = computed(() => {
  const currentKey = currentIsoWeekKey();
  if (!featuredList.value.length) return { currentKey, current: [], past: [] };
  return {
    currentKey,
    current: featuredList.value.filter((r) => featuredWeekKey(r) === currentKey),
    // 只有真实当前自然周算当期；历史周和无法判定周期的数据全部收进往期，默认折叠
    past: featuredList.value.filter((r) => featuredWeekKey(r) !== currentKey),
  };
});
const pastFtOpen = ref(false);
watch(() => featuredGroups.value.currentKey, () => { pastFtOpen.value = false; });

onLoad((o) => {
  id.value = Number(o.id);
  loadAll();
});
onShow(() => {
  if (id.value && detail.value) loadAll();
});
</script>

<style lang="scss" scoped>
.filter-row { display: flex; gap: 14rpx; margin-bottom: 18rpx; }
.filter-pick { background: #fff; border: 1rpx solid #e2e8f0; border-radius: 12rpx; padding: 16rpx 22rpx; font-size: 25rpx; color: #334155; }
.due-card { padding: 24rpx 28rpx; }
.due-head { display: flex; justify-content: space-between; align-items: center; gap: 14rpx; }
.due-title { font-size: 30rpx; font-weight: 700; color: #1e293b; flex: 1; }
.due-meta { font-size: 24rpx; color: #64748b; margin-top: 10rpx; }
.overdue { color: #b45309; }
.due-actions { margin-top: 18rpx; display: flex; justify-content: flex-end; }
.due-actions .btn { width: 260rpx; height: 72rpx; font-size: 26rpx; }
.sched-card.off { opacity: 0.62; }
.sched-head { display: flex; justify-content: space-between; align-items: center; }
.sched-title { font-size: 29rpx; font-weight: 700; color: #1e293b; }
.sched-meta { font-size: 24rpx; color: #64748b; margin-top: 10rpx; }
.sched-actions { display: flex; gap: 14rpx; margin-top: 16rpx; }
.mini-btn { background: #eff6ff; color: #2563eb; font-size: 24rpx; border-radius: 26rpx; padding: 10rpx 28rpx; }
.mini-btn.danger { background: #fee2e2; color: #ef4444; }
.board-summary { font-size: 24rpx; color: #475569; padding: 18rpx 24rpx; }
.board-scroll { width: 100%; white-space: nowrap; }
.board-table { display: inline-block; min-width: 100%; }
.board-row { display: flex; border-bottom: 1rpx solid #f1f5f9; background: #fff; }
.board-header { position: sticky; top: 0; z-index: 2; background: #f8fafc; }
.cell-name { width: 170rpx; flex-shrink: 0; padding: 16rpx 12rpx; font-size: 24rpx; font-weight: 600; color: #334155; display: flex; align-items: center; }
.cell-period { width: 130rpx; flex-shrink: 0; padding: 14rpx 8rpx; font-size: 21rpx; color: #64748b; text-align: center; }
.cell-state { width: 130rpx; flex-shrink: 0; height: 88rpx; display: flex; align-items: center; justify-content: center; font-size: 22rpx; margin: 6rpx 4rpx; border-radius: 10rpx; }
.st-on { background: #dcfce7; color: #166534; }
.st-late { background: #fef3c7; color: #b45309; }
.st-miss { background: #fee2e2; color: #b91c1c; }
.st-wait { background: #f1f5f9; color: #cbd5e1; }
.cell-dot { font-size: 28rpx; }
.legend { display: flex; align-items: center; gap: 14rpx; padding: 18rpx 8rpx; font-size: 22rpx; color: #64748b; flex-wrap: wrap; }
.lg { padding: 4rpx 16rpx; border-radius: 8rpx; }
.lg-tip { color: #94a3b8; }
.rank-row { display: flex; align-items: center; gap: 18rpx; padding: 22rpx 26rpx; }
.rank-no { width: 52rpx; height: 52rpx; border-radius: 50%; background: #f1f5f9; color: #64748b; text-align: center; line-height: 52rpx; font-weight: 700; flex-shrink: 0; }
.rank-no.top { background: #fef3c7; color: #b45309; }
.rank-main { flex: 1; min-width: 0; }
.rank-name { font-size: 28rpx; font-weight: 700; color: #1e293b; display: block; }
.rank-stats { display: flex; gap: 16rpx; flex-wrap: wrap; font-size: 22rpx; color: #64748b; margin-top: 8rpx; }
.ft-card { padding: 22rpx 26rpx; }
.ft-head { display: flex; justify-content: space-between; align-items: center; }
.ft-name { font-weight: 700; color: #1e293b; font-size: 27rpx; }
.ft-content { font-size: 26rpx; color: #475569; margin-top: 12rpx; line-height: 1.6; white-space: pre-wrap; }
.ft-meta { font-size: 21rpx; color: #94a3b8; margin-top: 10rpx; }
.ft-past-head { display: flex; align-items: center; gap: 10rpx; background: #eff6ff; border: 1rpx solid #dbeafe; border-radius: 14rpx; padding: 16rpx 22rpx; margin-top: 18rpx; }
.ft-arrow { font-size: 26rpx; color: #64748b; transition: transform .2s; }
.ft-arrow.open { transform: rotate(90deg); }
.ft-past-title { font-size: 27rpx; font-weight: 700; color: #1e293b; }
.ft-past-hint { margin-left: auto; font-size: 23rpx; color: #64748b; }
.modal-mask { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { width: 660rpx; background: #fff; border-radius: 24rpx; padding: 32rpx; }
.modal-lg { max-height: 82vh; display: flex; flex-direction: column; }
.modal-title { font-size: 31rpx; font-weight: 700; color: #1e293b; }
.modal-desc { margin: 10rpx 0 18rpx; font-size: 23rpx; }
.modal-textarea { width: 100%; box-sizing: border-box; min-height: 200rpx; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 14rpx; padding: 18rpx 22rpx; font-size: 27rpx; margin-bottom: 18rpx; }
.modal-input { height: 84rpx; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 12rpx; padding: 0 20rpx; font-size: 26rpx; margin-bottom: 16rpx; }
.form-scroll { max-height: 56vh; }
.form-label { font-size: 25rpx; color: #475569; font-weight: 600; margin: 16rpx 0 10rpx; }
.pick-box { background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 12rpx; height: 80rpx; line-height: 80rpx; padding: 0 20rpx; font-size: 26rpx; color: #334155; margin-bottom: 14rpx; }
.seg { display: flex; gap: 12rpx; margin-bottom: 14rpx; flex-wrap: wrap; }
.seg-item { background: #f1f5f9; color: #64748b; border-radius: 26rpx; padding: 10rpx 28rpx; font-size: 24rpx; }
.seg-item.on { background: #eff6ff; color: #2563eb; font-weight: 700; }
.wd-row { display: flex; gap: 10rpx; margin-bottom: 14rpx; flex-wrap: wrap; }
.wd-chip { background: #f1f5f9; color: #64748b; border-radius: 12rpx; padding: 10rpx 20rpx; font-size: 24rpx; }
.wd-chip.on { background: #2563eb; color: #fff; }
.switch-row { display: flex; justify-content: space-between; align-items: center; padding: 18rpx 4rpx; border-bottom: 1rpx solid #f1f5f9; font-size: 26rpx; color: #334155; }
.switch { width: 78rpx; height: 42rpx; border-radius: 21rpx; background: #cbd5e1; position: relative; transition: background 0.2s; }
.switch::after { content: ''; position: absolute; top: 4rpx; left: 4rpx; width: 34rpx; height: 34rpx; border-radius: 50%; background: #fff; transition: left 0.2s; }
.switch.on { background: #2563eb; }
.switch.on::after { left: 40rpx; }
.rate-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16rpx; }
.rate-label { font-size: 26rpx; color: #475569; font-weight: 600; }
.stepper { display: flex; align-items: center; gap: 18rpx; }
.step-btn { width: 60rpx; height: 60rpx; border-radius: 50%; background: #eff6ff; color: #2563eb; text-align: center; line-height: 58rpx; font-size: 34rpx; }
.step-val { font-size: 28rpx; font-weight: 700; min-width: 90rpx; text-align: center; }
.stars { display: flex; align-items: center; gap: 10rpx; }
.star { font-size: 44rpx; color: #cbd5e1; }
.star.on { color: #f59e0b; }
.star.big { font-size: 56rpx; }
.rate-clear { font-size: 23rpx; color: #94a3b8; margin-left: 14rpx; }
.img-line { margin: 8rpx 0; }
.img-preview { display: flex; gap: 14rpx; flex-wrap: wrap; margin-bottom: 16rpx; }
.thumb { width: 140rpx; height: 140rpx; border-radius: 12rpx; margin: 8rpx 0; }
.modal-actions { display: flex; gap: 18rpx; margin-top: 12rpx; }
.modal-btn { flex: 1; height: 80rpx; font-size: 27rpx; }
.log-meta { font-size: 24rpx; color: #64748b; margin-bottom: 10rpx; display: flex; align-items: center; gap: 8rpx; flex-wrap: wrap; }
.log-content { font-size: 27rpx; color: #334155; line-height: 1.7; white-space: pre-wrap; background: #f8fafc; border-radius: 12rpx; padding: 18rpx; margin: 12rpx 0; }
.sub-file { display: flex; align-items: center; gap: 12rpx; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 12rpx; padding: 14rpx 18rpx; margin-bottom: 14rpx; }
.sub-file-icon { font-size: 34rpx; flex-shrink: 0; }
.sub-file-name { flex: 1; min-width: 0; font-size: 25rpx; color: #1e293b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.comment-list { margin-top: 14rpx; border-top: 1rpx solid #f1f5f9; padding-top: 12rpx; }
.comment-item { font-size: 25rpx; color: #475569; padding: 8rpx 0; }
.c-name { font-weight: 700; color: #334155; }
.review-box { background: #eff6ff; border-radius: 12rpx; padding: 18rpx; margin-top: 14rpx; }
.review-text { display: block; font-size: 25rpx; color: #1e40af; margin-top: 10rpx; }
</style>
