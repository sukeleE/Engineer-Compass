<template>
  <view class="page-wrap">
    <!-- 用户头部 -->
    <view class="card profile" @click="loggedIn && openProfile()">
      <image v-if="loggedIn && auth.user.avatar" :src="auth.user.avatar" class="avatar avatar-img" mode="aspectFill" />
      <view v-else class="avatar">{{ avatarText }}</view>
      <view class="profile-info">
        <template v-if="loggedIn">
          <view class="nick-row">
            <text class="nickname">{{ auth.user.nickname || auth.user.username }}</text>
            <text class="tag" :class="auth.user.real_name ? 'tag-green' : 'tag-amber'">
              {{ auth.user.real_name ? '已实名' : '未实名' }}
            </text>
          </view>
          <view class="text-muted text-small">账号：{{ auth.user.username }}</view>
          <view v-if="auth.user.email" class="text-muted text-small ellipsis">邮箱：{{ auth.user.email }}</view>
        </template>
        <template v-else>
          <view class="nickname">未登录</view>
          <view class="text-muted text-small">登录后同步备赛日程与小组协作</view>
        </template>
      </view>
    </view>

    <!-- 未登录：微信一键登录 -->
    <button v-if="!loggedIn" class="btn btn-primary btn-block wechat-btn" :disabled="logging" @click="quickLogin">
      {{ logging ? '正在登录…' : '微信一键登录' }}
    </button>

    <!-- 已登录菜单 -->
    <view v-if="loggedIn" class="card menu">
      <view class="menu-item" @click="openProfile">
        <text class="menu-label">头像与昵称</text>
        <text class="menu-value ellipsis">{{ auth.user.nickname || auth.user.username }} ›</text>
      </view>
      <view class="menu-item" @click="openPhone">
        <text class="menu-label">手机号</text>
        <text class="menu-value">{{ auth.user.phone || '未绑定' }} ›</text>
      </view>
      <view class="menu-item" @click="openLibrary">
        <text class="menu-label">个人资源库</text>
        <text class="menu-value">文件 / 分享链接 ›</text>
      </view>
      <view class="menu-item" @click="openRealName">
        <text class="menu-label">实名认证</text>
        <text class="menu-value">{{ auth.user.real_name || '未填写' }} ›</text>
      </view>
      <view class="menu-item" @click="copyBaseUrl">
        <text class="menu-label">后端地址</text>
        <text class="menu-value ellipsis">{{ baseUrl }} ›</text>
      </view>
      <view class="menu-item">
        <text class="menu-label">小程序版本</text>
        <text class="menu-value">v1.0.0（全量模块）</text>
      </view>
    </view>

    <button v-if="loggedIn" class="btn btn-danger btn-block" @click="doLogout">退出登录</button>

    <view class="tips text-muted">
      小程序与网页版（H5）共用同一账号体系与数据库；管理后台、复杂文件预览等场景请使用网页版。
    </view>

    <!-- 实名认证弹窗（校验口径与后端 PUT /auth/real-name、/auth/student-no 完全一致） -->
    <view v-if="realNameOpen" class="modal-mask" @click="closeRealName">
      <view class="modal rn-modal" @click.stop>
        <view class="modal-head">
          <view class="modal-title">实名认证</view>
          <view class="modal-close" @click="closeRealName">✕</view>
        </view>
        <scroll-view scroll-y class="modal-body">
          <view class="modal-desc text-muted">
            资源预约、经费报销、物料采购等功能需实名。真实姓名仅用于署名与管理追责，不会公开展示到其他模块。
          </view>

          <view class="field-label">真实姓名 <text class="req">*</text></view>
          <input
            v-model="realName"
            class="modal-input"
            placeholder="请输入真实姓名，如：张三 / John Smith"
            :maxlength="24"
            cursor-spacing="24"
            @input="realNameErr = ''"
          />
          <view v-if="realNameErr" class="field-err">{{ realNameErr }}</view>
          <view v-else class="field-tip text-muted">2-20 个字符，支持汉字、英文字母、空格与间隔号（·），不可为纯数字或符号</view>

          <view class="field-label">学号 <text class="field-optional text-muted">（选填，实验室借用登记用）</text></view>
          <input
            v-model="studentNo"
            class="modal-input"
            type="number"
            placeholder="填写则须为 4-20 位数字，留空不修改"
            :maxlength="20"
            cursor-spacing="24"
            @input="studentNoErr = ''"
          />
          <view v-if="studentNoErr" class="field-err">{{ studentNoErr }}</view>
        </scroll-view>

        <view class="modal-actions">
          <button class="btn btn-ghost modal-btn" @click="closeRealName">取消</button>
          <button class="btn btn-primary modal-btn" :disabled="savingRealName" @click="saveRealName">
            {{ savingRealName ? '保存中…' : '保存并继续' }}
          </button>
        </view>
      </view>
    </view>

    <!-- 头像与昵称 -->
    <view v-if="profileOpen" class="modal-mask" @click="profileOpen = false">
      <view class="modal" @click.stop>
        <view class="modal-title">编辑资料</view>
        <view class="avatar-row">
          <image v-if="avatarPreview" :src="avatarPreview" class="avatar-edit" mode="aspectFill" />
          <view v-else class="avatar-edit avatar-text">{{ avatarText }}</view>
          <view class="avatar-ops">
            <button class="btn btn-ghost btn-sm" @click="pickAvatar">更换头像</button>
            <button v-if="auth.user.avatar || avatarPreview" class="btn btn-ghost btn-sm" @click="clearAvatar">清除头像</button>
          </view>
        </view>
        <view class="modal-desc text-muted">头像支持 jpg/png/webp，自动压缩上传</view>
        <input v-model="nicknameInput" class="modal-input" placeholder="昵称（1-20 字）" maxlength="20" />
        <view class="modal-actions">
          <button class="btn btn-ghost modal-btn" @click="profileOpen = false">取消</button>
          <button class="btn btn-primary modal-btn" :disabled="savingProfile" @click="saveProfile">{{ savingProfile ? '保存中…' : '保存' }}</button>
        </view>
      </view>
    </view>

    <!-- 手机号 -->
    <view v-if="phoneOpen" class="modal-mask" @click="phoneOpen = false">
      <view class="modal" @click.stop>
        <view class="modal-title">手机号</view>
        <view class="modal-desc text-muted">绑定后便于负责人联系；留空可解绑（本期暂不做短信验证）</view>
        <input v-model="phoneInput" class="modal-input" type="number" maxlength="11" placeholder="11 位大陆手机号，留空解绑" />
        <view class="modal-actions">
          <button class="btn btn-ghost modal-btn" @click="phoneOpen = false">取消</button>
          <button class="btn btn-primary modal-btn" :disabled="savingPhone" @click="savePhone">{{ savingPhone ? '保存中…' : '保存' }}</button>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { auth, isLoggedIn, patchUser, clearAuth } from '../../utils/auth.js';
import { loginWithWechat, logout } from '../../utils/wechat.js';
import { api } from '../../utils/api.js';
import { BASE_URL } from '../../env.js';
import { chooseImageAsBase64 } from '../../utils/fileBase64.js';

const logging = ref(false);
const realNameOpen = ref(false);
const realName = ref('');
const studentNo = ref('');
const realNameErr = ref('');
const studentNoErr = ref('');
const savingRealName = ref(false);
// 与后端 auth.js REALNAME_RE 同口径：首尾汉字/字母，中间允许空格/间隔号/点
const REALNAME_RE = /^[一-龥A-Za-z][一-龥A-Za-z·•.\s]{0,18}[一-龥A-Za-z.]$/;
const baseUrl = BASE_URL;

const loggedIn = computed(() => isLoggedIn());
const avatarText = computed(() => {
  if (!loggedIn.value) return '客';
  const name = auth.user.nickname || auth.user.username || '用';
  return name.slice(0, 1).toUpperCase();
});

async function quickLogin() {
  logging.value = true;
  try {
    await loginWithWechat();
    uni.showToast({ title: '登录成功', icon: 'success' });
  } catch (e) {
    if (e.needBind) {
      uni.navigateTo({ url: `/pages/login/main?bind_ticket=${e.bindTicket}&mock=${e.mock ? 1 : 0}` });
    }
    // 其他错误 request 层已 toast
  } finally {
    logging.value = false;
  }
}


function normName(v) {
  return String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
}
// 三条规则与后端完全一致，错误直接显示在弹窗内（不靠一闪而过的 toast）
function validateRealName(v) {
  const s = normName(v);
  const len = Array.from(s).length; // 按码点计
  if (len < 2 || len > 20) return '姓名长度需为 2-20 个字符';
  if (!REALNAME_RE.test(s)) return '姓名仅支持汉字、英文字母、空格和间隔号（·）';
  if ((s.match(/[一-龥A-Za-z]/g) || []).length < 2) return '姓名不能为纯数字、纯符号或单字';
  return '';
}
function openRealName() {
  realName.value = auth.user.real_name || '';
  studentNo.value = auth.user.student_no || '';
  realNameErr.value = '';
  studentNoErr.value = '';
  realNameOpen.value = true;
}
// 保存中禁止点遮罩/✕ 关闭，避免请求半途而废
function closeRealName() {
  if (savingRealName.value) return;
  realNameOpen.value = false;
}

async function saveRealName() {
  const name = normName(realName.value);
  realNameErr.value = validateRealName(name);
  const sno = studentNo.value.trim();
  studentNoErr.value = sno && !/^\d{4,20}$/.test(sno) ? '学号须为 4-20 位数字' : '';
  if (realNameErr.value || studentNoErr.value) return;
  savingRealName.value = true;
  try {
    // 两项本地校验都通过后再发请求；姓名是主信息，学号仅在填写且变化时提交
    const r1 = await api.setRealName(name);
    patchUser({ real_name: r1.user?.real_name || name });
    if (sno && sno !== (auth.user.student_no || '')) {
      const r2 = await api.setStudentNo(sno);
      patchUser({ student_no: r2.user?.student_no || sno });
    }
    uni.showToast({ title: '实名认证已保存', icon: 'success' });
    realNameOpen.value = false;
  } catch (e) {
    // request 层已弹 toast；后端兜底校验错误同步到弹窗内行提示
    const msg = e && e.message ? e.message : '保存失败，请重试';
    if (msg.indexOf('姓名') >= 0) realNameErr.value = msg;
    else if (msg.indexOf('学号') >= 0) studentNoErr.value = msg;
  } finally {
    savingRealName.value = false;
  }
}

// ============ 头像与昵称 ============
const profileOpen = ref(false);
const nicknameInput = ref('');
const avatarPreview = ref('');
const avatarChanged = ref(false);
const savingProfile = ref(false);
function openProfile() {
  nicknameInput.value = auth.user.nickname || auth.user.username || '';
  avatarPreview.value = auth.user.avatar || '';
  avatarChanged.value = false;
  profileOpen.value = true;
}
async function pickAvatar() {
  try {
    const img = await chooseImageAsBase64(4);
    const dataUrl = 'data:' + img.mime + ';base64,' + img.data;
    if (dataUrl.length > 150000) return uni.showToast({ title: '头像过大，请换一张', icon: 'none' });
    avatarPreview.value = dataUrl;
    avatarChanged.value = true;
  } catch (e) { /* 用户取消选择 */ }
}
function clearAvatar() {
  avatarPreview.value = '';
  avatarChanged.value = true;
}
async function saveProfile() {
  const nk = nicknameInput.value.trim();
  if (!nk) return uni.showToast({ title: '昵称不能为空', icon: 'none' });
  savingProfile.value = true;
  try {
    const card = { nickname: nk };
    if (avatarChanged.value) card.avatar = avatarPreview.value;
    const r = await api.updateProfile(card);
    patchUser(r.user);
    uni.showToast({ title: '已保存', icon: 'success' });
    profileOpen.value = false;
  } finally {
    savingProfile.value = false;
  }
}

// ============ 手机号 ============
const phoneOpen = ref(false);
const phoneInput = ref('');
const savingPhone = ref(false);
function openPhone() {
  phoneInput.value = auth.user.phone || '';
  phoneOpen.value = true;
}
async function savePhone() {
  const phone = phoneInput.value.trim();
  if (phone && !/^1[3-9]\d{9}$/.test(phone)) return uni.showToast({ title: '手机号格式不正确', icon: 'none' });
  savingPhone.value = true;
  try {
    const r = await api.setPhone(phone);
    patchUser(r.user);
    uni.showToast({ title: '已保存', icon: 'success' });
    phoneOpen.value = false;
  } finally {
    savingPhone.value = false;
  }
}
function openLibrary() {
  uni.navigateTo({ url: '/packageShare/pages/library/main' });
}

function doLogout() {
  uni.showModal({
    title: '退出登录',
    content: '确定退出当前账号吗？',
    success: (m) => {
      if (!m.confirm) return;
      logout();
      uni.showToast({ title: '已退出', icon: 'success' });
    },
  });
}

function copyBaseUrl() {
  uni.setClipboardData({ data: BASE_URL, success: () => uni.showToast({ title: '后端地址已复制', icon: 'none' }) });
}

onShow(() => {
  // auth 为响应式，登录/绑定返回后视图自动刷新
  if (!isLoggedIn()) { clearAuth(); return; }
  // 其他模块触发实名门禁（request.js 写标志）→ 跳到本页后自动打开实名弹窗
  if (uni.getStorageSync('ec_pending_realname')) {
    uni.removeStorageSync('ec_pending_realname');
    openRealName();
  }
});
</script>

<style lang="scss" scoped>
.profile { display: flex; align-items: center; gap: 24rpx; }
.avatar {
  width: 110rpx;
  height: 110rpx;
  border-radius: 50%;
  background: linear-gradient(135deg, #2563eb, #60a5fa);
  color: #fff;
  font-size: 44rpx;
  font-weight: 700;
  text-align: center;
  line-height: 110rpx;
  flex-shrink: 0;
}
.profile-info { flex: 1; min-width: 0; }
.nick-row { display: flex; align-items: center; gap: 14rpx; }
.nickname { font-size: 34rpx; font-weight: 700; color: #1e293b; }
.tag { display: inline-flex; padding: 4rpx 14rpx; border-radius: 8rpx; font-size: 22rpx; }
.tag-green { background: #f0fdf4; color: #166534; }
.tag-amber { background: #fef3c7; color: #b45309; }

.wechat-btn { margin-bottom: 20rpx; }
.menu { padding: 0 28rpx; }
.menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 100rpx;
  border-bottom: 1rpx solid #f1f5f9;
  gap: 20rpx;
}
.menu-item:last-child { border-bottom: none; }
.menu-label { font-size: 28rpx; color: #334155; }
.menu-value { font-size: 26rpx; color: #94a3b8; max-width: 420rpx; text-align: right; }
.tips { padding: 30rpx 16rpx; font-size: 23rpx; line-height: 1.7; }

.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal { width: 620rpx; background: #fff; border-radius: 24rpx; padding: 36rpx; }
.modal-title { font-size: 32rpx; font-weight: 700; color: #1e293b; }
.modal-desc { margin: 12rpx 0 24rpx; font-size: 24rpx; line-height: 1.6; }
.modal-input {
  height: 88rpx;
  background: #f8fafc;
  border: 1rpx solid #e2e8f0;
  border-radius: 14rpx;
  padding: 0 24rpx;
  font-size: 27rpx;
  margin-bottom: 20rpx;
}
.modal-actions { display: flex; gap: 20rpx; margin-top: 12rpx; }
.modal-btn { flex: 1; height: 80rpx; font-size: 28rpx; }

/* 实名认证弹窗：标题栏 + 限高滚动正文（键盘弹起也不溢出） */
.modal-head { display: flex; align-items: center; justify-content: space-between; }
.modal-close {
  width: 60rpx; height: 60rpx; line-height: 56rpx; text-align: center;
  color: #94a3b8; font-size: 30rpx; border-radius: 50%;
}
.rn-modal { max-height: 84vh; display: flex; flex-direction: column; }
.modal-body { max-height: 54vh; }
.modal-body .modal-desc { margin-top: 16rpx; }
.field-label { font-size: 26rpx; font-weight: 600; color: #334155; margin: 18rpx 0 12rpx; }
.req { color: #ef4444; }
.field-optional { font-weight: 400; }
.field-err { color: #dc2626; font-size: 23rpx; line-height: 1.5; margin: -10rpx 0 12rpx; }
.field-tip { font-size: 22rpx; line-height: 1.5; margin: -10rpx 0 6rpx; }
.avatar.avatar-img { padding: 0; }
.avatar-row { display: flex; align-items: center; gap: 24rpx; margin-bottom: 12rpx; }
.avatar-edit { width: 120rpx; height: 120rpx; border-radius: 50%; flex-shrink: 0; }
.avatar-text { background: linear-gradient(135deg, #2563eb, #60a5fa); color: #fff; text-align: center; line-height: 120rpx; font-size: 48rpx; font-weight: 700; }
.avatar-ops { display: flex; flex-direction: column; gap: 12rpx; }
.avatar-ops .btn-sm { height: 64rpx; line-height: 64rpx; font-size: 24rpx; padding: 0 28rpx; }
</style>
