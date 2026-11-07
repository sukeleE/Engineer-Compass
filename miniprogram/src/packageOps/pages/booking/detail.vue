<template>
  <view class="page-wrap" v-if="project">
    <view class="card head">
      <view class="h-row">
        <text class="h-name">{{ project.name }}</text>
        <text class="tag" :class="project.status === 'open' ? 'tag-green' : 'tag-gray'">{{ project.status === 'open' ? '开放中' : '已关闭' }}</text>
        <text v-if="canManage" class="mini-btn" @click="openProjectForm">⚙ 设置</text>
      </view>
      <view v-if="project.description" class="h-desc">{{ project.description }}</view>
    </view>

    <Tabs v-model="tab" :tabs="[{ key: 'resources', label: '资源', badge: resources.length }, { key: 'bookings', label: '预约记录', badge: bookings.length }, { key: 'timeline', label: '时段总览' }, { key: 'register', label: '借用登记' }, { key: 'teams', label: '组队' }]" />

    <block v-if="tab === 'resources'">
      <view v-if="canManage" class="res-admin-row">
          <button class="btn btn-ghost half" @click="openResForm()">＋ 添加资源</button>
          <button class="btn btn-outline half" @click="importOpen = true">📥 批量导入</button>
        </view>
      <EmptyState v-if="!resources.length" icon="📦" text="暂无可预约资源" />
      <view v-for="r in resources" :key="r.id" class="card res">
        <view class="r-head">
          <text class="r-icon">{{ r.icon }}</text>
          <view class="r-main">
            <text class="r-name">{{ r.name }}</text>
            <text class="r-sub">{{ r.kind_label }}{{ r.location ? ' · ' + r.location : '' }}{{ r.spec ? ' · ' + r.spec : '' }}</text>
          </view>
          <text class="tag" :class="r.status === 'active' ? 'tag-blue' : 'tag-gray'">{{ r.status === 'active' ? '可用' : '已归档' }}</text>
        </view>
        <view class="r-meta">
          <text v-if="r.is_space">容纳 {{ r.capacity }} 人</text>
          <text v-else>库存 {{ r.quantity }}{{ r.unit ? ' ' + r.unit : '' }}（损坏 {{ r.damaged_qty }}）</text>
          <text class="mode">{{ r.approve_mode === 'first_come' ? '先到先得' : '需审批' }}</text>
        </view>
        <button v-if="r.status === 'active' && project.status === 'open'" class="btn btn-primary btn-sm btn-block" @click="openBook(r)">预约此资源</button>
        <view v-if="canManage" class="r-ops">
          <text class="mini-btn" @click="openResForm(r)">编辑</text>
          <text v-if="r.status === 'active'" class="mini-btn" @click="archiveRes(r)">归档</text>
          <text v-else class="mini-btn" @click="restoreRes(r)">恢复</text>
          <text class="mini-btn danger" @click="removeRes(r)">删除</text>
        </view>
      </view>
    </block>

    <block v-else-if="tab === 'bookings'">
      <EmptyState v-if="!bookings.length" icon="📅" text="暂无预约记录" />
      <view v-for="b in bookings" :key="b.id" class="card booking" @click="openBookingOne(b)">
        <view class="b-head">
          <text class="b-res">{{ isReg(b) ? b.item_name : b.resource_name }}</text>
          <view class="b-tags">
            <text v-if="isReg(b)" class="tag tag-blue">{{ regLabel(b) }}</text>
          <text v-if="!isReg(b) && b.source === 'team'" class="tag tag-purple">固定组队</text>
            <text class="tag" :class="bkCls(b.status)">{{ bkLabel(b.status) }}</text>
          </view>
        </view>
        <image v-if="isReg(b) && b.item_thumb" :src="b.item_thumb" class="reg-thumb" mode="aspectFill" @click.stop="previewImg(b.item_thumb)" />
        <view class="b-line">预约人：{{ b.booker_name }}<text v-if="b.booker_student_no">（{{ b.booker_student_no }}）</text></view>
        <view class="b-line">{{ isReg(b) ? '登记于' : '时间' }}：{{ b.start_time }}<template v-if="!isReg(b)"> ~ {{ b.end_time }}</template></view>
        <view v-if="!isReg(b) && b.headcount > 1" class="b-line">人数：{{ b.headcount }} 人</view>
        <view v-if="!isReg(b) && b.qty > 1" class="b-line">数量：{{ b.qty }}{{ b.unit ? ' ' + b.unit : ' 件' }}</view>
        <view v-if="b.purpose" class="b-line">用途：{{ b.purpose }}</view>
        <view v-if="b.status === 'rejected' && b.reject_reason" class="b-reject">驳回：{{ b.reject_reason }}</view>
        <view v-if="b.perm && (b.perm.canApprove || b.perm.canReject || b.perm.canCancel)" class="b-ops" @click.stop>
          <view v-if="b.perm.canApprove" class="mini-btn" @click="approve(b)">批准</view>
          <view v-if="b.perm.canReject" class="mini-btn danger" @click="openReject(b)">驳回</view>
          <view v-if="b.perm.canCancel" class="mini-btn danger" @click="cancel(b)">取消</view>
        </view>
      </view>
    </block>

    <block v-else-if="tab === 'timeline'">
      <view class="tl-head">
        <picker mode="date" :value="tlFrom" @change="onTlDate">
          <view class="tl-date">📆 {{ tlFrom || '本周' }} ›</view>
        </picker>
        <text class="tl-tip">展示起 7 天内待审批/已确认预约</text>
      </view>
      <view v-if="!tlData" class="empty"><view class="empty-text">加载中…</view></view>
      <EmptyState v-else-if="!tlData.bookings.length" icon="🗓" text="该时段窗口内没有预约" />
      <view v-for="g in tlGroups" :key="g.resource.id" class="card tl-group">
        <view class="tlg-head">
          <text class="tlg-name">{{ g.resource.icon }} {{ g.resource.name }}</text>
          <text class="tlg-count">{{ g.bookings.length }} 单</text>
        </view>
        <view v-if="!g.bookings.length" class="tlg-empty">窗口内无预约</view>
        <view v-for="b in g.bookings" :key="b.id" class="tl-row" @click="openBookingOne({ id: b.id })">
          <text class="tl-time">{{ String(b.start_time).slice(5, 16) }}~{{ String(b.end_time).slice(11, 16) }}</text>
          <text class="tl-who ellipsis">{{ b.booker_name }}</text>
          <text class="tag" :class="bkCls(b.status)">{{ bkLabel(b.status) }}</text>
        </view>
      </view>
    </block>

    <!-- 借用登记：未入台账的设备/教室拍照速登，不进时段总览 -->
    <block v-else-if="tab === 'register'">
      <view class="card reg-card">
        <view class="seg">
          <view class="seg-item" :class="{ on: reg.kind === 'device' }" @click="switchRegKind('device')">📦 借设备</view>
          <view class="seg-item" :class="{ on: reg.kind === 'room' }" @click="switchRegKind('room')">🏫 借教室</view>
        </view>
        <view class="f-label">{{ reg.kind === 'room' ? '教室编号（必填）' : '物品名称（必填）' }}</view>
        <input v-model="reg.item_name" class="modal-input" maxlength="40" :placeholder="reg.kind === 'room' ? '如：N2-201' : '如：数字示波器'" />
        <view class="f-label">学号（选填，默认用个人资料中的学号）</view>
        <input v-model="reg.student_no" class="modal-input" type="number" maxlength="20" placeholder="4-20 位数字" />
        <view class="f-label">{{ reg.kind === 'room' ? '教室内环境照片（必拍）' : '所借物品照片（必拍）' }}</view>
        <view class="reg-shot" @click="chooseRegImage">
          <image v-if="reg.image" :src="reg.image" class="reg-shot-img" mode="aspectFill" />
          <text v-else class="reg-shot-tip">📷 点击拍照 / 从相册选择</text>
        </view>
        <view class="f-label">备注（选填，≤200 字）</view>
        <textarea v-model="reg.purpose" class="modal-textarea" maxlength="200" placeholder="补充说明" />
        <button class="btn btn-primary btn-block reg-submit" :disabled="regBusy" @click="submitReg">{{ regBusy ? '提交中…' : '提交借用登记' }}</button>
        <view class="reg-tip">登记不进时段总览，可在「预约记录」和「我的预约」里查看</view>
      </view>
    </block>

    <block v-else-if="tab === 'teams'">
      <BookingTeamPanel v-if="tab === 'teams'" :project-id="id" />
    </block>

    <!-- 预约表单 -->
    <view v-if="bookOpen" class="modal-mask" @click="bookOpen = false">
      <view class="modal" @click.stop>
        <view class="modal-title">预约「{{ bookRes ? bookRes.name : '' }}」</view>
        <scroll-view scroll-y class="modal-scroll">
          <view class="f-label">开始（日期 + 时间）</view>
          <view class="time-row">
            <view class="half">
              <picker mode="date" :value="form.date1" :start="today" @change="onDate1">
                <view class="modal-input picker-like">{{ form.date1 || '选择日期' }}</view>
              </picker>
            </view>
            <view class="half">
              <picker mode="time" :value="form.start" @change="onStart">
                <view class="modal-input picker-like">{{ form.start || '开始' }}</view>
              </picker>
            </view>
          </view>
          <view class="f-label">结束（可跨天，最长连续 7 天，每日 07:00–22:00）</view>
          <view class="time-row">
            <view class="half">
              <picker mode="date" :value="form.date2" :start="form.date1 || today" @change="onDate2">
                <view class="modal-input picker-like">{{ form.date2 || '选择日期' }}</view>
              </picker>
            </view>
            <view class="half">
              <picker mode="time" :value="form.end" @change="onEnd">
                <view class="modal-input picker-like">{{ form.end || '结束' }}</view>
              </picker>
            </view>
          </view>
          <view v-if="bookRes && !bookRes.is_space" class="f-label">借用数量（库存 {{ bookRes.quantity }}）</view>
          <input v-if="bookRes && !bookRes.is_space" v-model.number="form.qty" class="modal-input" type="number" placeholder="数量" @input="scheduleCheck" />
          <template v-if="bookRes && bookRes.is_space">
            <view class="f-label">参与方式（本人默认计入，最多 100 人）</view>
            <view class="seg join-seg">
              <view class="seg-item" :class="{ on: form.joinMode === 'solo' }" @click="switchJoin('solo')">仅本人</view>
              <view class="seg-item" :class="{ on: form.joinMode === 'custom' }" @click="switchJoin('custom')">临时选人</view>
              <view class="seg-item" :class="{ on: form.joinMode === 'team' }" @click="switchJoin('team')">固定组队</view>
            </view>
            <template v-if="form.joinMode === 'custom'">
              <view class="part-row">
                <input v-model="partKeyword" class="modal-input part-input" placeholder="搜用户名 / 昵称 / 真名" @confirm="searchParticipants" />
                <view class="mini-btn" @click="searchParticipants">搜索</view>
              </view>
              <view v-if="partResults.length" class="part-results">
                <view v-for="u in partResults" :key="u.id" class="part-item" @click="addParticipant(u)">
                  ＋ {{ u.real_name || u.nickname || u.username }}<text v-if="u.real_name && u.nickname !== u.real_name">（{{ u.nickname || u.username }}）</text>
                </view>
              </view>
              <view class="part-chips">
                <text class="tag tag-blue">我</text>
                <text v-for="u in form.participantChips" :key="u.id" class="tag tag-gray part-chip" @click="removeParticipant(u.id)">
                  {{ u.real_name || u.nickname || u.username }} ×
                </text>
              </view>
            </template>
            <template v-else-if="form.joinMode === 'team'">
              <view v-if="!myTeams.length" class="f-hint">你还没有担任队长的组队，可在「组队」tab 先新建</view>
              <picker v-else :range="myTeams" range-key="name" :value="teamIndex" @change="onTeamPick">
                <view class="modal-input picker-like">{{ currentTeam ? currentTeam.name : '选择我创建的组队' }}</view>
              </picker>
              <view v-if="currentTeam" class="part-chips">
                <text class="tag tag-blue">我（队长）</text>
                <text v-for="m in currentTeam.members" :key="m.user_id" class="tag tag-gray part-chip">{{ m.user_name }}</text>
              </view>
            </template>
          </template>
          <view v-if="conflictInfo" class="conflict" :class="conflictInfo.ok ? 'ok' : 'no'">
            <view>{{ conflictInfo.text }}</view>
            <view v-for="(c, i) in conflictInfo.conflicts" :key="i" class="cf-item">{{ c.start_time }} ~ {{ c.end_time }}</view>
          </view>
          <view class="f-label">用途说明（选填，≤200 字）</view>
          <textarea v-model="form.purpose" class="modal-textarea" maxlength="200" placeholder="预约用途" />
        </scroll-view>
        <view class="modal-actions">
          <button class="btn btn-ghost modal-btn" @click="bookOpen = false">取消</button>
          <button class="btn btn-primary modal-btn" @click="submitBook">提交预约</button>
        </view>
      </view>
    </view>

    <!-- 添加 / 编辑资源 -->
    <view v-if="resOpen" class="modal-mask" @click="resOpen = false">
      <view class="modal" @click.stop>
        <view class="modal-title">{{ editingRes ? '编辑资源' : '添加资源' }}</view>
        <scroll-view scroll-y class="modal-scroll">
          <view class="f-label">资源类型</view>
          <picker :range="kindLabels" :value="kindIndex" :disabled="!!editingRes" @change="onKind">
            <view class="modal-input picker-like">{{ kindLabels[kindIndex] }}</view>
          </picker>
          <view class="f-label">名称</view>
          <input v-model="resForm.name" class="modal-input" maxlength="30" placeholder="资源名称（必填）" />
          <view class="f-label">规格 / 位置（选填）</view>
          <input v-model="resForm.spec" class="modal-input" maxlength="40" placeholder="规格型号" />
          <input v-model="resForm.location" class="modal-input" maxlength="60" placeholder="存放位置" />
          <view v-if="kindIndex === 1" class="f-label">可容纳人数</view>
          <input v-if="kindIndex === 1" v-model.number="resForm.capacity" class="modal-input" type="number" placeholder="人数（1-9999）" />
          <template v-else>
            <view class="f-label">库存数量 / 单位</view>
            <view class="time-row">
              <input v-model.number="resForm.quantity" class="modal-input half" type="number" placeholder="库存" />
              <input v-model="resForm.unit" class="modal-input half" maxlength="8" placeholder="单位（个/套）" />
            </view>
            <view v-if="editingRes" class="f-label">损坏数量</view>
            <input v-if="editingRes" v-model.number="resForm.damaged_qty" class="modal-input" type="number" placeholder="损坏数（0-9999）" />
          </template>
          <view class="f-label">审批模式</view>
          <picker :range="modeLabels" :value="resForm.modeIndex" @change="onResMode">
            <view class="modal-input picker-like">{{ modeLabels[resForm.modeIndex] }}</view>
          </picker>
        </scroll-view>
        <view class="modal-actions">
          <button class="btn btn-ghost modal-btn" @click="resOpen = false">取消</button>
          <button class="btn btn-primary modal-btn" @click="submitRes">保存资源</button>
        </view>
      </view>
    </view>

    <!-- 项目设置 -->
    <view v-if="psOpen" class="modal-mask" @click="psOpen = false">
      <view class="modal" @click.stop>
        <view class="modal-title">项目设置</view>
        <view class="f-label">项目名称</view>
        <input v-model="psForm.name" class="modal-input" maxlength="40" placeholder="项目名称（必填）" />
        <view class="f-label">项目说明</view>
        <textarea v-model="psForm.description" class="modal-textarea" maxlength="500" placeholder="项目说明（选填）" />
        <view class="f-label">默认审批模式</view>
        <picker :range="psModeLabels" :value="psForm.modeIndex" @change="onPsMode">
          <view class="modal-input picker-like">{{ psModeLabels[psForm.modeIndex] }}</view>
        </picker>
        <view class="switch-row">
          <text>开放预约</text>
          <switch :checked="psForm.open" color="#2563eb" @change="onPsStatus" />
        </view>
        <view class="modal-actions">
          <button class="btn btn-ghost modal-btn" @click="psOpen = false">取消</button>
          <button class="btn btn-primary modal-btn" @click="submitProject">保存</button>
        </view>
      </view>
    </view>

    <!-- 预约详情 -->
    <view v-if="bkOpen" class="modal-mask" @click="bkOpen = false">
      <view class="modal" @click.stop>
        <view class="modal-title">预约详情</view>
        <scroll-view scroll-y class="modal-scroll" v-if="bkDetail">
          <view class="bk-head">
            <text class="bk-res">{{ isReg(bkDetail.booking) ? bkDetail.booking.item_name : bkDetail.booking.resource_name }}</text>
            <view class="b-tags">
              <text v-if="isReg(bkDetail.booking)" class="tag tag-blue">{{ regLabel(bkDetail.booking) }}</text>
              <text class="tag" :class="bkCls(bkDetail.booking.status)">{{ bkLabel(bkDetail.booking.status) }}</text>
            </view>
          </view>
          <image v-if="isReg(bkDetail.booking) && bkDetail.booking.item_image" :src="bkDetail.booking.item_image" class="reg-photo" mode="widthFix" @click="previewImg(bkDetail.booking.item_image)" />
          <view class="b-line">预约人：{{ bkDetail.booking.booker_name }}<text v-if="bkDetail.booking.booker_student_no">（{{ bkDetail.booking.booker_student_no }}）</text></view>
          <view class="b-line">{{ isReg(bkDetail.booking) ? '登记于' : '时间' }}：{{ bkDetail.booking.start_time }}<template v-if="!isReg(bkDetail.booking)"> ~ {{ bkDetail.booking.end_time }}</template></view>
          <template v-if="!isReg(bkDetail.booking)">
            <view v-if="bkDetail.booking.qty > 1" class="b-line">数量：{{ bkDetail.booking.qty }} 件</view>
            <view v-if="bkDetail.booking.headcount > 1" class="b-line">人数：{{ bkDetail.booking.headcount }} 人</view>
            <view v-if="bkDetail.booking.participants && bkDetail.booking.participants.length" class="b-line">
              参与人：{{ bkDetail.booking.participants.map((x) => x.user_name).join('、') }}
            </view>
          </template>
          <view v-if="bkDetail.booking.purpose" class="b-line">用途：{{ bkDetail.booking.purpose }}</view>
          <view v-if="bkDetail.booking.reject_reason" class="b-reject">驳回：{{ bkDetail.booking.reject_reason }}</view>
          <view class="f-label">操作轨迹</view>
          <view v-for="l in bkDetail.logs" :key="l.id" class="log-row">
            <text class="log-action">{{ logLabel(l.action) }}</text>
            <text class="log-meta">{{ l.actor_name }} · {{ l.create_time }}</text>
            <text v-if="l.comment" class="log-comment">{{ l.comment }}</text>
          </view>
        </scroll-view>
        <view v-else class="loading-text">加载中…</view>
        <button class="btn btn-primary modal-btn" @click="bkOpen = false">关闭</button>
      </view>
    </view>
    <!-- 资源批量导入 -->
    <ResourceImport v-if="importOpen" :project-id="id" @close="importOpen = false" @imported="onImported" />
  </view>
  <view v-else class="empty"><view class="empty-text">加载中…</view></view>
</template>

<script setup>
import { ref, reactive, computed } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { confirm, toast } from '../../../utils/guard.js';
import auth, { patchUser } from '../../../utils/auth.js';
import Tabs from '../../../components/Tabs.vue';
import EmptyState from '../../../components/EmptyState.vue';
import BookingTeamPanel from './components/BookingTeamPanel.vue';
import ResourceImport from './components/ResourceImport.vue';

const id = ref(null);
const project = ref(null);
const resources = ref([]);
const bookings = ref([]);
const tab = ref('resources');
const canManage = computed(() => !!project.value && project.value.canManage);
const today = new Date().toISOString().slice(0, 10);

function bkLabel(s) { return { pending: '待审批', confirmed: '已确认', rejected: '已驳回', canceled: '已取消' }[s] || s; }
function bkCls(s) { return { pending: 'tag-amber', confirmed: 'tag-green', rejected: 'tag-red', canceled: 'tag-gray' }[s] || 'tag-gray'; }
function logLabel(a) { return { created: '提交预约', approved: '审批通过', rejected: '驳回', canceled: '取消', restored: '恢复', archived: '归档' }[a] || a; }
function isReg(b) { return !!b && (b.item_kind === 'device' || b.item_kind === 'room'); }
function regLabel(b) { return b && b.item_kind === 'room' ? '教室登记' : '设备登记'; }
function previewImg(url) { uni.previewImage({ urls: [url] }); }
function snap30(hhmm) {
  const parts = String(hhmm).split(':');
  const h = parts[0];
  const m = Number(parts[1]);
  return h + ':' + (m < 30 ? '00' : '30');
}

async function load() {
  const [p, rs, bs, ts] = await Promise.all([
    api.bookingProject(id.value),
    api.bookingResources(id.value),
    api.bookingList(id.value),
    api.bookingTeams(id.value),
  ]);
  project.value = p.project;
  resources.value = rs.resources || [];
  bookings.value = bs.bookings || [];
  const me = auth.user ? auth.user.id : null;
  myTeams.value = (ts.teams || []).filter((x) => x.owner_id === me);
  if (tab.value === 'timeline') loadTimeline();
}

// ============ 新建预约（跨天 + 参与人 + 实时冲突预检） ============
const bookOpen = ref(false);
const bookRes = ref(null);
const form = reactive({ date1: '', start: '', date2: '', end: '', qty: 1, purpose: '', joinMode: 'solo', teamId: null, participantIds: [], participantChips: [] });
const myTeams = ref([]);
const teamIndex = ref(0);
const currentTeam = computed(() => myTeams.value[teamIndex.value] || null);
const importOpen = ref(false);
const conflictInfo = ref(null);
let conflictTimer = null;
const partKeyword = ref('');
const partResults = ref([]);

function openBook(r) {
  bookRes.value = r;
  form.date1 = today; form.date2 = today; form.start = '09:00'; form.end = '10:00';
  form.qty = 1; form.purpose = ''; form.participantIds = []; form.participantChips = [];
  form.joinMode = 'solo'; form.teamId = null; teamIndex.value = 0;
  partKeyword.value = ''; partResults.value = [];
  conflictInfo.value = null;
  bookOpen.value = true;
  checkConflict();
}
function switchJoin(mode) {
  form.joinMode = mode;
  if (mode === 'team') {
    const t = myTeams.value[teamIndex.value];
    form.teamId = t ? t.id : null;
  } else {
    form.teamId = null;
  }
  scheduleCheck();
}
function onTeamPick(e) {
  teamIndex.value = Number(e.detail.value);
  const t = myTeams.value[teamIndex.value];
  form.teamId = t ? t.id : null;
  scheduleCheck();
}
function onDate1(e) {
  form.date1 = e.detail.value;
  if (form.date2 < form.date1) form.date2 = form.date1;
  scheduleCheck();
}
function onDate2(e) { form.date2 = e.detail.value; scheduleCheck(); }
function onStart(e) { form.start = snap30(e.detail.value); scheduleCheck(); }
function onEnd(e) { form.end = snap30(e.detail.value); scheduleCheck(); }
function scheduleCheck() {
  if (conflictTimer) clearTimeout(conflictTimer);
  conflictTimer = setTimeout(checkConflict, 400);
}
function bookingWindow() {
  if (!form.date1 || !form.date2 || !form.start || !form.end) return null;
  const start_time = form.date1 + ' ' + form.start;
  const end_time = form.date2 + ' ' + form.end;
  if (!(end_time > start_time)) return null;
  return { start_time, end_time };
}
function buildBookingCard(win) {
  const card = { resource_id: bookRes.value.id, start_time: win.start_time, end_time: win.end_time };
  if (bookRes.value.is_space) {
    if (form.joinMode === 'team' && form.teamId) {
      card.source = 'team';
      card.team_id = form.teamId;
    } else if (form.joinMode === 'custom' && form.participantIds.length) {
      card.source = 'custom';
      card.participant_ids = form.participantIds.slice();
    } else {
      card.source = 'solo';
    }
  } else {
    card.source = 'solo';
    card.qty = Number(form.qty) || 1;
  }
  return card;
}
async function checkConflict() {
  conflictInfo.value = null;
  const win = bookingWindow();
  if (!win || !bookRes.value) return;
  const card = buildBookingCard(win);
  try {
    const r = await api.bookingConflicts(id.value, card, { showError: false });
    const txt = r.would_status === 'confirmed' ? '✓ 该时段空闲，提交即确认' : '✓ 该时段空闲，提交后待审批';
    conflictInfo.value = { ok: true, text: txt, conflicts: [] };
  } catch (e) {
    const list = (e.data && e.data.conflicts) || [];
    conflictInfo.value = { ok: false, text: e.message || '该时段存在冲突', conflicts: list };
  }
}
async function searchParticipants() {
  const q = partKeyword.value.trim();
  if (!q) return;
  const r = await api.bookingUserSearch(q);
  const ids = form.participantIds;
  const myId = auth.user ? auth.user.id : null;
  partResults.value = (r.users || []).filter((u) => u.id !== myId && ids.indexOf(u.id) < 0);
}
function addParticipant(u) {
  if (form.participantIds.length >= 99) return toast('单次预约最多 100 人');
  if (form.participantIds.indexOf(u.id) >= 0) return;
  form.participantIds.push(u.id);
  form.participantChips.push({ id: u.id, nickname: u.nickname, username: u.username, real_name: u.real_name || '' });
  partResults.value = partResults.value.filter((x) => x.id !== u.id);
  scheduleCheck();
}
function removeParticipant(uid) {
  form.participantIds = form.participantIds.filter((x) => x !== uid);
  form.participantChips = form.participantChips.filter((x) => x.id !== uid);
  scheduleCheck();
}
function nowSlotText() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
}
async function submitBook() {
  if (!form.date1 || !form.date2 || !form.start || !form.end) return toast('请完整选择开始与结束时间');
  const win = bookingWindow();
  if (!win) return toast('结束时间需晚于开始时间');
  if (win.start_time < nowSlotText()) return toast('开始时间不能早于当前时间');
  const card = buildBookingCard(win);
  card.purpose = form.purpose.trim();
  try {
    await api.bookingCreate(id.value, card);
    bookOpen.value = false;
    toast('预约已提交', 'success');
    tab.value = 'bookings';
    load();
  } catch (e) { /* 409 冲突等已 toast */ }
}
function onImported() {
  importOpen.value = false;
  load();
}

// ============ 借用登记（拍照速登，不进时段总览） ============
const reg = reactive({ kind: 'device', item_name: '', student_no: (auth.user && auth.user.student_no) || '', image: '', thumb: '', purpose: '' });
const regBusy = ref(false);
function switchRegKind(k) {
  if (reg.kind === k) return;
  reg.kind = k; reg.item_name = ''; reg.image = ''; reg.thumb = '';
}
function readFileBase64(fp) {
  return new Promise((resolve, reject) => {
    uni.getFileSystemManager().readFile({ filePath: fp, encoding: 'base64', success: (r) => resolve(r.data), fail: reject });
  });
}
async function chooseRegImage() {
  const res = await new Promise((resolve, reject) => {
    uni.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'], success: resolve, fail: reject });
  }).catch(() => null);
  if (!res) return;
  let fp = res.tempFiles[0].tempFilePath;
  let url = 'data:image/jpeg;base64,' + await readFileBase64(fp);
  if (url.length > 380000) {
    try {
      const c = await new Promise((resolve, reject) => uni.compressImage({ src: fp, quality: 60, success: resolve, fail: reject }));
      fp = c.tempFilePath;
      url = 'data:image/jpeg;base64,' + await readFileBase64(fp);
    } catch (e) { /* 压缩失败则交给后端 40 万字符校验 */ }
  }
  if (url.length > 380000) return toast('图片过大，请换一张更小的图片');
  reg.image = url;
  reg.thumb = '';
  try {
    const t = await new Promise((resolve, reject) => uni.compressImage({ src: fp, quality: 40, compressedWidth: 240, success: resolve, fail: reject }));
    const turl = 'data:image/jpeg;base64,' + await readFileBase64(t.tempFilePath);
    if (turl.length <= 60000) reg.thumb = turl;
  } catch (e) { /* 缩略图可选，失败留空不影响登记 */ }
}
async function submitReg() {
  const name = reg.item_name.trim();
  if (!name) return toast(reg.kind === 'room' ? '请填写教室编号' : '请填写物品名称');
  if (!reg.image) return toast(reg.kind === 'room' ? '请拍摄教室内环境照片' : '请拍摄所借物品照片');
  const sno = reg.student_no.trim();
  if (sno && !/^\d{4,20}$/.test(sno)) return toast('学号须为 4-20 位数字');
  regBusy.value = true;
  try {
    if (sno && sno !== ((auth.user && auth.user.student_no) || '')) {
      const r = await api.setStudentNo(sno);
      patchUser({ student_no: (r.user && r.user.student_no) || sno });
    }
    await api.bookingBorrowRegister(id.value, {
      kind: reg.kind, item_name: name, item_image: reg.image, item_thumb: reg.thumb, purpose: reg.purpose.trim(),
    });
    toast('借用登记成功', 'success');
    reg.item_name = ''; reg.image = ''; reg.thumb = ''; reg.purpose = '';
    tab.value = 'bookings';
    load();
  } finally {
    regBusy.value = false;
  }
}
// ============ 资源管理（新增/编辑/归档/删除） ============
const resOpen = ref(false);
const editingRes = ref(null);
const kindLabels = ['物品资源', '空间资源'];
const modeLabels = ['审批制', '先到先得'];
const kindIndex = ref(0);
const resForm = reactive({ name: '', spec: '', location: '', capacity: '', quantity: 1, unit: '', damaged_qty: 0, modeIndex: 0 });
function openResForm(r) {
  editingRes.value = r || null;
  if (r) {
    kindIndex.value = r.is_space ? 1 : 0;
    resForm.name = r.name;
    resForm.spec = r.spec || '';
    resForm.location = r.location || '';
    resForm.capacity = r.capacity || '';
    resForm.quantity = r.quantity || 1;
    resForm.unit = r.unit || '';
    resForm.damaged_qty = r.damaged_qty || 0;
    resForm.modeIndex = r.approve_mode === 'first_come' ? 1 : 0;
  } else {
    kindIndex.value = 0;
    Object.assign(resForm, { name: '', spec: '', location: '', capacity: '', quantity: 1, unit: '', damaged_qty: 0, modeIndex: 0 });
  }
  resOpen.value = true;
}
function onKind(e) { kindIndex.value = Number(e.detail.value); }
function onResMode(e) { resForm.modeIndex = Number(e.detail.value); }
async function submitRes() {
  if (!resForm.name.trim()) return toast('请填写资源名称');
  const isSpace = kindIndex.value === 1;
  const card = {
    name: resForm.name.trim(),
    spec: resForm.spec.trim(),
    location: resForm.location.trim(),
    approve_mode: resForm.modeIndex === 1 ? 'first_come' : 'approval',
  };
  if (isSpace) card.capacity = Number(resForm.capacity);
  else {
    card.quantity = Number(resForm.quantity);
    card.unit = resForm.unit.trim();
    if (editingRes.value) card.damaged_qty = Number(resForm.damaged_qty) || 0;
  }
  if (editingRes.value) await api.bookingResourceUpdate(editingRes.value.id, card);
  else await api.bookingResourceCreate(id.value, card);
  resOpen.value = false;
  toast(editingRes.value ? '已保存' : '资源已添加', 'success');
  load();
}
async function archiveRes(r) {
  if (!(await confirm('归档「' + r.name + '」？归档后不再接受新预约，历史预约保留。'))) return;
  await api.bookingResourceArchive(r.id);
  toast('已归档', 'success');
  load();
}
async function restoreRes(r) {
  await api.bookingResourceRestore(r.id);
  toast('已恢复', 'success');
  load();
}
async function removeRes(r) {
  if (!(await confirm('删除资源「' + r.name + '」？已有预约记录的资源不可删除，请改用归档。'))) return;
  await api.bookingResourceDelete(r.id);
  toast('已删除', 'success');
  load();
}

// ============ 项目设置 ============
const psOpen = ref(false);
const psModeLabels = ['审批制（提交后负责人审批）', '先到先得（提交即确认）'];
const psForm = reactive({ name: '', description: '', modeIndex: 0, open: true });
function openProjectForm() {
  const p = project.value;
  psForm.name = p.name;
  psForm.description = p.description || '';
  psForm.modeIndex = p.default_approve_mode === 'first_come' ? 1 : 0;
  psForm.open = p.status === 'open';
  psOpen.value = true;
}
function onPsMode(e) { psForm.modeIndex = Number(e.detail.value); }
function onPsStatus(ev) { psForm.open = ev.detail.value; }
async function submitProject() {
  if (!psForm.name.trim()) return toast('请填写项目名称');
  await api.bookingProjectUpdate(id.value, {
    name: psForm.name.trim(),
    description: psForm.description.trim(),
    default_approve_mode: psForm.modeIndex === 1 ? 'first_come' : 'approval',
    status: psForm.open ? 'open' : 'closed',
  });
  psOpen.value = false;
  toast('已保存', 'success');
  load();
}

// ============ 审批 ============
async function approve(b) {
  await api.bookingApprove(b.id);
  toast('已批准', 'success');
  load();
}
async function openReject(b) {
  const reason = await new Promise((resolve) => {
    uni.showModal({
      title: '驳回预约', editable: true, placeholderText: '必须填写驳回理由',
      success: (m) => resolve(m.confirm ? (m.content || '').trim() : ''),
    });
  });
  if (!reason) return toast('驳回需要填写理由');
  await api.bookingReject(b.id, { reason });
  toast('已驳回', 'success');
  load();
}
async function cancel(b) {
  if (!(await confirm('确认取消该预约？'))) return;
  await api.bookingCancel(b.id);
  toast('已取消', 'success');
  load();
}

// ============ 预约详情（含操作轨迹） ============
const bkOpen = ref(false);
const bkDetail = ref(null);
async function openBookingOne(b) {
  bkOpen.value = true;
  bkDetail.value = null;
  const r = await api.bookingOne(b.id);
  bkDetail.value = { booking: r.booking, logs: r.logs || [] };
}

// ============ 时段总览（甘特数据降级为按资源分组的时段列表） ============
const tlFrom = ref('');
const tlData = ref(null);
const tlGroups = computed(() => {
  if (!tlData.value) return [];
  const map = {};
  for (const b of tlData.value.bookings) {
    if (!map[b.resource_id]) map[b.resource_id] = [];
    map[b.resource_id].push(b);
  }
  return tlData.value.resources.map((r) => ({ resource: r, bookings: map[r.id] || [] }));
});
function onTlDate(e) { tlFrom.value = e.detail.value; loadTimeline(); }
async function loadTimeline() {
  tlData.value = null;
  const p = { days: 7 };
  if (tlFrom.value) p.from = tlFrom.value;
  tlData.value = await api.bookingTimeline(id.value, p);
  if (!tlFrom.value) tlFrom.value = tlData.value.from;
}

onLoad((o) => { id.value = Number(o.id); });
onShow(() => {
  if (!id.value) return;
  load();
  if (tab.value === 'timeline') loadTimeline();
});
</script>

<style lang="scss" scoped>
.head .h-row { display: flex; justify-content: space-between; align-items: center; gap: 14rpx; }
.h-name { font-size: 32rpx; font-weight: 800; color: #1e293b; flex: 1; }
.h-desc { font-size: 25rpx; color: #64748b; margin-top: 10rpx; }
.res .r-head { display: flex; align-items: center; gap: 16rpx; }
.r-icon { font-size: 48rpx; }
.r-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.r-name { font-size: 29rpx; font-weight: 700; color: #1e293b; }
.r-sub { font-size: 23rpx; color: #94a3b8; margin-top: 4rpx; }
.r-meta { display: flex; justify-content: space-between; font-size: 24rpx; color: #475569; margin: 14rpx 0; }
.r-meta .mode { color: #2563eb; }
.r-ops { display: flex; gap: 14rpx; justify-content: flex-end; margin-top: 12rpx; }
.btn-sm { height: 72rpx; font-size: 26rpx; }
.mini-btn { background: #eff6ff; color: #2563eb; font-size: 24rpx; border-radius: 26rpx; padding: 10rpx 28rpx; }
.mini-btn.danger { background: #fee2e2; color: #ef4444; }
.booking .b-head { display: flex; justify-content: space-between; align-items: center; gap: 12rpx; }
.b-res { font-size: 29rpx; font-weight: 700; color: #1e293b; flex: 1; }
.b-line { font-size: 24rpx; color: #64748b; margin-top: 8rpx; }
.b-reject { font-size: 23rpx; color: #b91c1c; background: #fef2f2; border-radius: 10rpx; padding: 10rpx 14rpx; margin-top: 10rpx; }
.b-ops { display: flex; gap: 14rpx; justify-content: flex-end; margin-top: 14rpx; }
.tl-head { display: flex; align-items: center; gap: 16rpx; margin-bottom: 14rpx; }
.tl-date { background: #fff; border: 1rpx solid #e2e8f0; border-radius: 14rpx; padding: 14rpx 24rpx; font-size: 25rpx; color: #2563eb; font-weight: 700; }
.tl-tip { font-size: 22rpx; color: #94a3b8; flex: 1; }
.tl-group { padding: 22rpx 26rpx; }
.tlg-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12rpx; }
.tlg-name { font-size: 27rpx; font-weight: 700; color: #1e293b; }
.tlg-count { font-size: 22rpx; color: #94a3b8; }
.tlg-empty { font-size: 23rpx; color: #cbd5e1; padding: 8rpx 0; }
.tl-row { display: flex; align-items: center; gap: 14rpx; padding: 12rpx 0; border-bottom: 1rpx solid #f8fafc; }
.tl-time { font-size: 23rpx; color: #475569; flex: none; width: 210rpx; }
.tl-who { flex: 1; min-width: 0; font-size: 24rpx; color: #334155; }
.conflict { border-radius: 14rpx; padding: 16rpx 20rpx; font-size: 24rpx; margin: 8rpx 0; line-height: 1.6; }
.conflict.ok { background: #f0fdf4; color: #166534; }
.conflict.no { background: #fef2f2; color: #b91c1c; }
.cf-item { font-size: 22rpx; margin-top: 4rpx; }
.bk-head { display: flex; justify-content: space-between; align-items: center; gap: 12rpx; margin-bottom: 12rpx; }
.bk-res { font-size: 30rpx; font-weight: 800; color: #1e293b; flex: 1; }
.log-row { display: flex; flex-wrap: wrap; gap: 10rpx; align-items: center; background: #f8fafc; border-radius: 12rpx; padding: 14rpx 18rpx; margin-top: 10rpx; }
.log-action { font-size: 24rpx; font-weight: 700; color: #2563eb; }
.log-meta { font-size: 22rpx; color: #94a3b8; }
.log-comment { width: 100%; font-size: 23rpx; color: #475569; }
.loading-text { text-align: center; color: #94a3b8; padding: 60rpx 0; font-size: 26rpx; }
.modal-mask { position: fixed; inset: 0; background: rgba(15,23,42,0.45); z-index: 100; display: flex; align-items: center; justify-content: center; padding: 48rpx; }
.modal { width: 100%; background: #fff; border-radius: 24rpx; padding: 32rpx; max-height: 84vh; display: flex; flex-direction: column; }
.modal-title { font-size: 32rpx; font-weight: 800; text-align: center; margin-bottom: 18rpx; }
.modal-scroll { max-height: 58vh; }
.modal-input { background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 14rpx; padding: 18rpx 22rpx; font-size: 27rpx; margin-bottom: 14rpx; }
.picker-like { color: #334155; }
.modal-textarea { width: 100%; box-sizing: border-box; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 14rpx; padding: 18rpx 22rpx; font-size: 27rpx; min-height: 140rpx; }
.f-label { font-size: 24rpx; color: #64748b; margin: 10rpx 4rpx; }
.time-row { display: flex; gap: 14rpx; }
.half { flex: 1; }
.switch-row { display: flex; justify-content: space-between; align-items: center; margin: 14rpx 0; font-size: 27rpx; color: #334155; }
.modal-actions { display: flex; gap: 18rpx; margin-top: 18rpx; }
.modal-btn { flex: 1; height: 80rpx; font-size: 28rpx; }

/* ===== 借用登记 / 参与人 / 登记单展示 ===== */
.seg { display: flex; gap: 12rpx; margin-bottom: 14rpx; }
.seg-item { flex: 1; text-align: center; background: #f1f5f9; color: #64748b; border-radius: 26rpx; padding: 16rpx 0; font-size: 25rpx; }
.seg-item.on { background: #eff6ff; color: #2563eb; font-weight: 700; }
.reg-card { padding: 26rpx 28rpx; }
.reg-shot { height: 300rpx; border: 2rpx dashed #cbd5e1; border-radius: 16rpx; display: flex; align-items: center; justify-content: center; overflow: hidden; background: #f8fafc; margin-bottom: 14rpx; }
.reg-shot-img { width: 100%; height: 100%; }
.reg-shot-tip { color: #94a3b8; font-size: 26rpx; }
.reg-submit { margin-top: 20rpx; }
.reg-tip { font-size: 22rpx; color: #94a3b8; margin-top: 14rpx; line-height: 1.6; }
.reg-thumb { width: 200rpx; height: 150rpx; border-radius: 12rpx; margin: 12rpx 0; background: #f1f5f9; }
.reg-photo { width: 100%; border-radius: 12rpx; margin: 12rpx 0; }
.b-tags { display: flex; gap: 8rpx; flex-shrink: 0; }
.part-row { display: flex; gap: 12rpx; align-items: center; }
.part-input { flex: 1; margin-bottom: 0; }
.part-results { background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 12rpx; margin-top: 10rpx; max-height: 280rpx; overflow: hidden; }
.part-item { padding: 16rpx 20rpx; font-size: 25rpx; color: #2563eb; border-bottom: 1rpx solid #f1f5f9; }
.part-item:last-child { border-bottom: none; }
.part-chips { display: flex; flex-wrap: wrap; gap: 10rpx; margin-top: 12rpx; }
.part-chip { padding: 8rpx 18rpx; }
.res-admin-row { display: flex; gap: 14rpx; margin-bottom: 18rpx; }
.res-admin-row .half { flex: 1; height: 76rpx; font-size: 26rpx; }
.join-seg { margin-top: 4rpx; }
.f-hint { font-size: 22rpx; color: #94a3b8; line-height: 1.6; margin-top: 10rpx; }
</style>
