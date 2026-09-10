<script setup>
// 后台管理控制台（/admin-console，仅管理员）：用户管理 / 操作日志 / 公告 / 服务器状态
import { ref, reactive, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api.js';
import auth from '../auth.js';
import { fmtDateTime, fmtDateTimeS } from '../utils/time.js';
import { compressImage, shrinkHint } from '../utils/imageCompress.js';
import { openImage } from '../utils/imageViewer.js';

const tab = ref('users');

// ---- 操作日志：action 中文映射（与后端 audit_log 埋点一一对应） ----
const ACTION_LABELS = {
  login: '登录', logout: '登出', register: '注册',
  'plan-create': 'AI 制定计划', 'plan-manual': '自编计划', 'plan-chat': '对话式计划',
  'team-plan': '小组计划', 'team-join': '加入小组', 'team-invite': '获取邀请码',
  'friend-request': '好友申请', 'friend-accept': '接受好友', 'friend-reject': '拒绝好友', 'dm-send': '发送私信',
  'comment-share': '分享评论', 'comment-team': '小组评论',
  'user-status': '封禁/禁言', 'user-role': '角色管理',
  'post-delete': '删除帖子', 'comment-delete': '删除评论',
  'announce-create': '发布公告', 'announce-update': '编辑公告', 'announce-delete': '删除公告',
  'resource-upload': '上传资源', 'resource-delete': '删除资源', 'resource-admin-delete': '管理员删资源',
  'resource-share': '分享资源', 'resource-unshare': '撤销分享',
  'plan-import': '导入计划',
  'honor-create': '添加荣誉', 'honor-bulk': '批量上传奖状', 'honor-update': '编辑荣誉',
  'honor-delete': '删除荣誉', 'honor-image-set': '上传奖状图', 'honor-image-clear': '删除奖状图',
};
const actionLabel = (a) => ACTION_LABELS[a] || a;
const STATUS_LABELS = { 0: ['正常', 'success'], 1: ['封禁', 'danger'], 2: ['禁言', 'warning'] };

// ==================== Tab1 用户管理 ====================
const users = reactive({ loading: false, q: '', list: [], total: 0, page: 1, size: 20 });
async function loadUsers() {
  users.loading = true;
  try {
    const r = await api.adminUsers({ q: users.q, page: users.page, size: users.size });
    users.list = r.list; users.total = r.total;
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    users.loading = false;
  }
}

// 封禁(1)/禁言(2)/解封(0)，带确认
async function setStatus(u, status) {
  const label = STATUS_LABELS[status][0];
  const tip = {
    1: `封禁后该用户将无法登录和使用任何功能，确定封禁「${u.nickname || u.username}」？`,
    2: `禁言后该用户仍可登录浏览，但无法发帖/评论/私信/团队发言，确定禁言「${u.nickname || u.username}」？`,
    0: `确定解除对「${u.nickname || u.username}」的限制？`,
  }[status];
  try {
    await ElMessageBox.confirm(tip, `${label}确认`, { type: status === 0 ? 'info' : 'warning' });
  } catch { return; }
  try {
    await api.adminSetStatus(u.id, status);
    ElMessage.success(`已将 ${u.nickname || u.username} ${label}`);
    loadUsers();
  } catch (e) {
    ElMessage.error(e.message);
  }
}

// 用户详情弹窗：基本信息 + 内容统计 + 最近操作日志
const detailDlg = ref(false);
const detail = ref(null);
const detailLoading = ref(false);
async function openDetail(u) {
  detailDlg.value = true;
  detail.value = null;
  detailLoading.value = true;
  try { detail.value = await api.adminUserDetail(u.id); } catch (e) { ElMessage.error(e.message); detailDlg.value = false; } finally { detailLoading.value = false; }
}

// 设为/取消管理员（带确认；后端禁止操作自己）
async function setRole(u, is_admin) {
  const act = is_admin ? '设为管理员' : '取消管理员';
  const tip = is_admin
    ? `确定将「${u.nickname || u.username}」设为管理员？其将获得后台管理全部权限。`
    : `确定取消「${u.nickname || u.username}」的管理员身份？`;
  try {
    await ElMessageBox.confirm(tip, `${act}确认`, { type: 'warning' });
  } catch { return; }
  try {
    await api.adminSetRole(u.id, is_admin);
    ElMessage.success(`已${act} ${u.nickname || u.username}`);
    loadUsers();
  } catch (e) { ElMessage.error(e.message); }
}

// ==================== Tab2 内容管理（帖子 / 评论） ====================
const contentTab = ref('posts');
const posts = reactive({ loading: false, q: '', list: [], total: 0, page: 1, size: 20 });
async function loadPosts() {
  posts.loading = true;
  try {
    const r = await api.adminPosts({ q: posts.q, page: posts.page, size: posts.size });
    posts.list = r.list; posts.total = r.total;
  } catch (e) { ElMessage.error(e.message); } finally { posts.loading = false; }
}
async function delPost(p) {
  try {
    await ElMessageBox.confirm(`删除帖子「${p.title}」？评论/点赞/收藏/通知将一并清理，不可恢复。`, '删除帖子', { type: 'warning' });
  } catch { return; }
  try {
    await api.adminPostDelete(p.id);
    ElMessage.success('帖子已删除');
    loadPosts();
    if (comments.postId === p.id) { comments.postId = null; comments.page = 1; loadComments(); }
  } catch (e) { ElMessage.error(e.message); }
}

const comments = reactive({ loading: false, q: '', postId: null, list: [], total: 0, page: 1, size: 20 });
async function loadComments() {
  comments.loading = true;
  try {
    const r = await api.adminComments({ q: comments.q, postId: comments.postId, page: comments.page, size: comments.size });
    comments.list = r.list; comments.total = r.total;
  } catch (e) { ElMessage.error(e.message); } finally { comments.loading = false; }
}
function viewPostComments(p) {
  comments.postId = p.id;
  comments.page = 1;
  contentTab.value = 'comments';
  loadComments();
}
async function delComment(c) {
  try {
    await ElMessageBox.confirm(`删除评论「${(c.content || '').slice(0, 40)}${(c.content || '').length > 40 ? '…' : ''}」？`, '删除评论', { type: 'warning' });
  } catch { return; }
  try {
    await api.adminCommentDelete(c.id);
    ElMessage.success('评论已删除');
    loadComments();
  } catch (e) { ElMessage.error(e.message); }
}

// ==================== Tab3 操作日志 ====================
const logs = reactive({ loading: false, q: '', action: '', list: [], total: 0, page: 1, size: 20 });
async function loadLogs() {
  logs.loading = true;
  try {
    const r = await api.adminLogs({ q: logs.q, action: logs.action, page: logs.page, size: logs.size });
    logs.list = r.list; logs.total = r.total;
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    logs.loading = false;
  }
}
const detailText = (d) => {
  if (!d) return '';
  try {
    const o = typeof d === 'string' ? JSON.parse(d) : d;
    return Object.entries(o).filter(([k, v]) => v !== null && v !== undefined && v !== '' && k !== 'label')
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ');
  } catch { return String(d); }
};

// ==================== Tab 访问记录（含游客） ====================
const visits = reactive({ loading: false, q: '', list: [], total: 0, page: 1, size: 20 });
async function loadVisits() {
  visits.loading = true;
  try {
    const r = await api.adminVisits({ q: visits.q, page: visits.page, size: visits.size });
    visits.list = r.list; visits.total = r.total;
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    visits.loading = false;
  }
}

// ==================== Tab4 公告管理 ====================
const anns = ref([]);
const annLoading = ref(false);
async function loadAnns() {
  annLoading.value = true;
  try { anns.value = await api.adminAnnouncements(); } catch (e) { ElMessage.error(e.message); } finally { annLoading.value = false; }
}

const annDlg = ref(false);
const annForm = reactive({ id: null, title: '', content: '', pinned: false });
function openAnnDlg(a) {
  annForm.id = a?.id ?? null;
  annForm.title = a?.title || '';
  annForm.content = a?.content || '';
  annForm.pinned = !!a?.pinned;
  annDlg.value = true;
}
async function saveAnn() {
  if (!annForm.title.trim()) return ElMessage.warning('标题不能为空');
  if (!annForm.content.trim()) return ElMessage.warning('内容不能为空');
  try {
    if (annForm.id) {
      await api.adminAnnouncementUpdate(annForm.id, { title: annForm.title, content: annForm.content, pinned: annForm.pinned });
      ElMessage.success('公告已更新');
    } else {
      await api.adminAnnouncementCreate({ title: annForm.title, content: annForm.content, pinned: annForm.pinned });
      ElMessage.success('公告已发布，全站顶部横幅将展示');
    }
    annDlg.value = false;
    loadAnns();
  } catch (e) {
    ElMessage.error(e.message);
  }
}
async function togglePin(a) {
  try {
    await api.adminAnnouncementUpdate(a.id, { pinned: a.pinned ? 0 : 1 });
    ElMessage.success(a.pinned ? '已取消置顶' : '已置顶（顶部横幅优先展示）');
    loadAnns();
  } catch (e) { ElMessage.error(e.message); }
}
async function delAnn(a) {
  try {
    await ElMessageBox.confirm(`删除公告「${a.title}」？删除后横幅立即消失。`, '删除确认', { type: 'warning' });
  } catch { return; }
  try {
    await api.adminAnnouncementDelete(a.id);
    ElMessage.success('已删除');
    loadAnns();
  } catch (e) { ElMessage.error(e.message); }
}

// ==================== Tab5 资源管理（全部用户上传） ====================
const resources = reactive({ loading: false, q: '', list: [], total: 0, page: 1, size: 20 });
async function loadResources() {
  resources.loading = true;
  try {
    const r = await api.adminResources({ q: resources.q, page: resources.page, size: resources.size });
    resources.list = r.list; resources.total = r.total;
  } catch (e) { ElMessage.error(e.message); } finally { resources.loading = false; }
}
async function delResource(row) {
  const who = row.nickname || row.username;
  try {
    await ElMessageBox.confirm(
      `删除「${row.file_name}」（${fmtBytes(row.file_size)}，上传者 ${who}）？磁盘文件将一并删除，不可恢复。`,
      '删除资源', { type: 'warning' });
  } catch { return; }
  try {
    await api.adminResourceDelete(row.id);
    ElMessage.success('资源已删除');
    loadResources();
  } catch (e) { ElMessage.error(e.message); }
}

// ==================== Tab7 荣誉墙（奖状图 + 奖项信息） ====================
const honors = reactive({ loading: false, list: [] });
async function loadHonors() {
  honors.loading = true;
  try { honors.list = (await api.adminHonors()).list || []; }
  catch (e) { ElMessage.error(e.message); } finally { honors.loading = false; }
}

// 表单持有**图片三态**：没动（keepUrl 原样）/ 换成新图（file + preview）/ 勾了删除（removeImg）。
// 三者对应三个不同的接口动作，互斥由 handleHonorPick / toggleHonorRemove 保证。
const honorDlg = ref(false);
const honorForm = reactive({
  id: null, title: '', winner: '', award_level: '', award_date: '', description: '',
  sort_order: '', is_active: true,
  file: null, preview: '', hint: '', removeImg: false, keepUrl: '', imageName: '',
});
function honorReset() {
  if (honorForm.preview) URL.revokeObjectURL(honorForm.preview);
  Object.assign(honorForm, { file: null, preview: '', hint: '', removeImg: false });
}
function openHonorDlg(h) {
  honorReset();
  Object.assign(honorForm, {
    id: h?.id ?? null,
    title: h?.title || '', winner: h?.winner || '', award_level: h?.award_level || '',
    award_date: h?.award_date || '', description: h?.description || '',
    sort_order: h?.sort_order ?? '', is_active: h ? !!h.is_active : true,
    keepUrl: h?.image_url || '', imageName: h?.image_name || '',
  });
  honorDlg.value = true;
}

// 选图 → 立刻压缩（3–8MB 的手机照压到 ~300KB，后端没有图像库，这里是唯一一道）
async function handleHonorPick(e) {
  const f = (e.target.files || [])[0];
  e.target.value = ''; // 不清空则同一张图再选一次不触发 change
  if (!f) return;
  if (!f.type.startsWith('image/')) return ElMessage.warning('请选择图片文件');
  const out = await compressImage(f);
  if (honorForm.preview) URL.revokeObjectURL(honorForm.preview);
  honorForm.file = out;
  honorForm.preview = URL.createObjectURL(out);
  honorForm.hint = shrinkHint(f, out);
  honorForm.removeImg = false; // 选了新图就不再是"删除"
}
function toggleHonorRemove() {
  honorForm.removeImg = !honorForm.removeImg;
  if (honorForm.removeImg && honorForm.file) honorReset(); // 勾删除 → 丢掉刚选的新图
}

async function saveHonor() {
  if (!honorForm.title.trim()) return ElMessage.warning('奖项名称不能为空');
  const meta = {
    title: honorForm.title.trim(), winner: honorForm.winner, award_level: honorForm.award_level,
    award_date: honorForm.award_date, description: honorForm.description,
    is_active: honorForm.is_active ? 1 : 0,
  };
  // 排序留空 = 交给后端自动排到最前（新建）/ 保持原值（编辑）：不能把空串塞成 Number('')=0
  if (String(honorForm.sort_order).trim() !== '') meta.sort_order = Number(honorForm.sort_order);
  let id = honorForm.id;
  try {
    if (id) await api.adminHonorUpdate(id, meta);
    else id = (await api.adminHonorCreate(meta)).id;
  } catch (e) { return ElMessage.error(e.message); }

  // 第二步（独立端点）：图片。这里失败时**不关弹窗** —— 元数据已经存进去了，
  // 提示出来让管理员原地重试即可，别让他以为整条都没保存。
  let warn = '';
  try {
    if (honorForm.file) await api.adminHonorImageSet(id, honorForm.file);
    else if (honorForm.removeImg && honorForm.keepUrl) await api.adminHonorImageClear(id);
  } catch (e) { warn = e.message; }
  loadHonors();
  if (warn) {
    honorForm.id = id; // 已建成了：再点保存就是编辑，不会重复建条
    honorForm.keepUrl = honorForm.file ? honorForm.keepUrl : '';
    return ElMessage.warning(`奖项信息已保存，但图片没处理成功：${warn}。可留在本窗口重试`);
  }
  ElMessage.success(honorForm.id ? '荣誉已更新' : '荣誉已添加');
  honorDlg.value = false;
}

async function toggleHonorActive(h) {
  try {
    await api.adminHonorUpdate(h.id, { is_active: h.is_active ? 1 : 0 });
    ElMessage.success(h.is_active ? '已上架，前台立即可见' : '已下架，前台不再展示');
  } catch (e) {
    h.is_active = !h.is_active; // 失败要把开关拨回去，否则界面在撒谎
    ElMessage.error(e.message);
  }
}

async function delHonor(h) {
  try {
    await ElMessageBox.confirm(
      `删除荣誉「${h.title}」？${h.has_image ? '奖状图片会一并从磁盘删除，' : ''}不可恢复。`,
      '删除荣誉', { type: 'warning' });
  } catch { return; }
  try {
    await api.adminHonorDelete(h.id);
    ElMessage.success('已删除');
    loadHonors();
  } catch (e) { ElMessage.error(e.message); }
}

// 批量：一次多选 N 张 → 建 N 条（标题取文件名），之后再逐条补奖项信息
// 注：不能用 $refs —— <script setup> 的模板 ref 不挂到 $refs 上，只有声明的 ref 本身（模板里自动解包）
const bulkInput = ref(null);
const honorFileInput = ref(null);
const bulkLoading = ref(false);
async function handleBulkPick(e) {
  const picked = [...(e.target.files || [])];
  e.target.value = '';
  if (!picked.length) return;
  if (picked.length > 20) return ElMessage.warning('一次最多上传 20 张');
  bulkLoading.value = true;
  try {
    const imgs = [];
    for (const f of picked) {
      if (!f.type.startsWith('image/')) { ElMessage.warning(`「${f.name}」不是图片，已跳过`); continue; }
      imgs.push(await compressImage(f));
    }
    if (!imgs.length) return;
    const r = await api.adminHonorBulk(imgs);
    ElMessage.success(r.message || `已创建 ${r.count} 条荣誉`);
    loadHonors();
  } catch (e) { ElMessage.error(e.message); } finally { bulkLoading.value = false; }
}

// ==================== Tab6 服务器状态 ====================
const stat = ref(null);
const statLoading = ref(false);
async function loadStatus() {
  statLoading.value = true;
  try { stat.value = await api.serverStatus(); } catch (e) { ElMessage.error(e.message); } finally { statLoading.value = false; }
}

const fmtBytes = (b) => {
  const n = Number(b) || 0;
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
};
const fmtUp = (s) => {
  const sec = Number(s) || 0;
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return `${d ? `${d} 天 ` : ''}${h} 小时 ${m} 分`;
};
const pct = (used, total) => (total ? Math.round((used / total) * 100) : 0);
// el-table 时间列 formatter：UTC 串 → 本地 'YYYY-MM-DD HH:MM'（DB CURRENT_TIMESTAMP 是 UTC）
const fmtT = (_r, _c, v) => fmtDateTime(v);

onMounted(() => { loadUsers(); loadPosts(); loadComments(); loadLogs(); loadVisits(); loadAnns(); loadResources(); loadHonors(); loadStatus(); });
</script>

<template>
  <main class="admin-page">
    <div class="page-head">
      <h2>⚙️ 后台管理控制台</h2>
      <p class="sub">用户操作审计 · 封禁/禁言 · 全局公告 · 服务器状态</p>
    </div>

    <el-tabs v-model="tab">
      <!-- ========== Tab1 用户管理 ========== -->
      <el-tab-pane label="👤 用户管理" name="users">
        <div class="toolbar">
          <el-input v-model="users.q" placeholder="搜索昵称 / 邮箱 / 用户名" clearable style="width: 260px"
            @keyup.enter="users.page = 1; loadUsers()" @clear="users.page = 1; loadUsers()">
            <template #append><el-button @click="users.page = 1; loadUsers()">搜索</el-button></template>
          </el-input>
          <span class="count">共 {{ users.total }} 位用户</span>
        </div>
        <el-table :data="users.list" v-loading="users.loading" stripe>
          <el-table-column prop="id" label="ID" width="70" />
          <el-table-column label="用户" min-width="140">
            <template #default="{ row }">
              <b>{{ row.nickname || row.username }}</b>
              <span class="cell-sub">@{{ row.username }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="email" label="邮箱" min-width="180" show-overflow-tooltip />
          <el-table-column prop="create_time" label="注册时间" width="160" :formatter="fmtT" />
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag size="small" :type="STATUS_LABELS[row.status][1]">{{ STATUS_LABELS[row.status][0] }}</el-tag>
              <el-tag v-if="row.is_admin" size="small" type="primary" style="margin-left:4px">管理员</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="300">
            <template #default="{ row }">
              <el-button link type="primary" size="small" @click="openDetail(row)">详情</el-button>
              <template v-if="row.is_admin">
                <el-button v-if="row.id !== auth.user?.id" link type="warning" size="small" @click="setRole(row, 0)">取消管理员</el-button>
                <span v-else class="cell-sub">当前账号</span>
                <el-button v-if="row.id !== auth.user?.id" link type="danger" size="small" @click="setStatus(row, 1)" :disabled="row.status === 1">封禁</el-button>
              </template>
              <template v-else>
                <el-button link type="primary" size="small" @click="setRole(row, 1)">设为管理员</el-button>
                <el-button v-if="row.status !== 1" link type="danger" size="small" @click="setStatus(row, 1)">封禁</el-button>
                <el-button v-if="row.status !== 2" link type="warning" size="small" @click="setStatus(row, 2)">禁言</el-button>
                <el-button v-if="row.status !== 0" link type="success" size="small" @click="setStatus(row, 0)">解封</el-button>
              </template>
            </template>
          </el-table-column>
        </el-table>
        <el-pagination class="pg" background layout="total, prev, pager, next" :total="users.total"
          :page-size="users.size" v-model:current-page="users.page" @current-change="loadUsers" />
      </el-tab-pane>

      <!-- ========== Tab2 内容管理（帖子 / 评论） ========== -->
      <el-tab-pane label="📄 内容管理" name="content">
        <div class="toolbar">
          <el-radio-group v-model="contentTab">
            <el-radio-button value="posts">📝 帖子</el-radio-button>
            <el-radio-button value="comments">💬 评论</el-radio-button>
          </el-radio-group>
          <el-input v-if="contentTab === 'posts'" v-model="posts.q" placeholder="搜索标题 / 作者" clearable style="width: 240px"
            @keyup.enter="posts.page = 1; loadPosts()" @clear="posts.page = 1; loadPosts()" />
          <el-input v-else v-model="comments.q" placeholder="搜索评论内容 / 作者" clearable style="width: 240px"
            @keyup.enter="comments.page = 1; loadComments()" @clear="comments.page = 1; loadComments()" />
          <span v-if="comments.postId" class="tip">
            筛选：帖子 #{{ comments.postId }} 的评论
            <el-button link type="primary" size="small" @click="comments.postId = null; comments.page = 1; loadComments()">清除</el-button>
          </span>
          <span class="count">{{ contentTab === 'posts' ? `共 ${posts.total} 篇帖子` : `共 ${comments.total} 条评论` }}</span>
        </div>

        <!-- 帖子列表 -->
        <template v-if="contentTab === 'posts'">
          <el-table :data="posts.list" v-loading="posts.loading" stripe>
            <el-table-column prop="id" label="ID" width="70" />
            <el-table-column label="标题" min-width="220" show-overflow-tooltip>
              <template #default="{ row }"><b>{{ row.title }}</b></template>
            </el-table-column>
            <el-table-column label="作者" width="130">
              <template #default="{ row }">
                <b>{{ row.nickname || row.username }}</b>
                <span v-if="row.user_status" class="cell-sub" style="color:#ef4444">已{{ STATUS_LABELS[row.user_status][0] }}</span>
              </template>
            </el-table-column>
            <el-table-column label="评论" width="70">
              <template #default="{ row }">{{ row.comment_count }}</template>
            </el-table-column>
            <el-table-column label="点赞" width="70">
              <template #default="{ row }">{{ row.like_count }}</template>
            </el-table-column>
            <el-table-column prop="create_time" label="发布时间" width="160" :formatter="fmtT" />
            <el-table-column label="操作" width="130" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" size="small" @click="viewPostComments(row)">看评论</el-button>
                <el-button link type="danger" size="small" @click="delPost(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-pagination class="pg" background layout="total, prev, pager, next" :total="posts.total"
            :page-size="posts.size" v-model:current-page="posts.page" @current-change="loadPosts" />
        </template>

        <!-- 评论列表 -->
        <template v-else>
          <el-table :data="comments.list" v-loading="comments.loading" stripe>
            <el-table-column prop="id" label="ID" width="70" />
            <el-table-column label="内容" min-width="240" show-overflow-tooltip />
            <el-table-column label="所属帖子" min-width="160" show-overflow-tooltip>
              <template #default="{ row }">
                <el-button v-if="row.post_id" link type="primary" size="small" @click="viewPostComments({ id: row.post_id })">#{{ row.post_id }} {{ row.post_title }}</el-button>
                <span v-else class="cell-sub">（帖子已删除）</span>
              </template>
            </el-table-column>
            <el-table-column label="作者" width="130">
              <template #default="{ row }"><b>{{ row.nickname || row.username }}</b></template>
            </el-table-column>
            <el-table-column prop="create_time" label="时间" width="160" :formatter="fmtT" />
            <el-table-column label="操作" width="90" fixed="right">
              <template #default="{ row }">
                <el-button link type="danger" size="small" @click="delComment(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-pagination class="pg" background layout="total, prev, pager, next" :total="comments.total"
            :page-size="comments.size" v-model:current-page="comments.page" @current-change="loadComments" />
        </template>
      </el-tab-pane>

      <!-- ========== Tab3 操作日志 ========== -->
      <el-tab-pane label="🧾 操作日志" name="logs">
        <div class="toolbar">
          <el-input v-model="logs.q" placeholder="搜索目标 / 用户名" clearable style="width: 220px"
            @keyup.enter="logs.page = 1; loadLogs()" @clear="logs.page = 1; loadLogs()" />
          <el-select v-model="logs.action" placeholder="全部动作" clearable style="width: 170px" @change="logs.page = 1; loadLogs()">
            <el-option v-for="(label, key) in ACTION_LABELS" :key="key" :value="key" :label="label" />
          </el-select>
          <el-button @click="logs.page = 1; loadLogs()">查询</el-button>
          <span class="count">共 {{ logs.total }} 条记录</span>
        </div>
        <el-table :data="logs.list" v-loading="logs.loading" stripe>
          <el-table-column prop="create_time" label="时间" width="165" :formatter="fmtT" />
          <el-table-column label="用户" width="120">
            <template #default="{ row }">
              <b>{{ row.user_nickname || row.username }}</b>
              <span class="cell-sub">#{{ row.user_id }}</span>
            </template>
          </el-table-column>
          <el-table-column label="动作" width="110">
            <template #default="{ row }"><el-tag size="small">{{ actionLabel(row.action) }}</el-tag></template>
          </el-table-column>
          <el-table-column prop="target" label="目标" min-width="120" show-overflow-tooltip />
          <el-table-column label="详情" min-width="180" show-overflow-tooltip>
            <template #default="{ row }">{{ detailText(row.detail) }}</template>
          </el-table-column>
          <el-table-column prop="ip" label="IP" width="120" />
        </el-table>
        <el-pagination class="pg" background layout="total, prev, pager, next" :total="logs.total"
          :page-size="logs.size" v-model:current-page="logs.page" @current-change="loadLogs" />
      </el-tab-pane>

      <!-- ========== Tab 访问记录（含游客） ========== -->
      <el-tab-pane label="🌐 访问记录" name="visits">
        <div class="toolbar">
          <el-input v-model="visits.q" placeholder="搜索 IP / 用户名 / 路径" clearable style="width: 240px"
            @keyup.enter="visits.page = 1; loadVisits()" @clear="visits.page = 1; loadVisits()" />
          <el-button @click="visits.page = 1; loadVisits()">查询</el-button>
          <span class="count">共 {{ visits.total }} 次访问</span>
        </div>
        <el-table :data="visits.list" v-loading="visits.loading" stripe>
          <el-table-column prop="create_time" label="时间" width="165" :formatter="fmtT" />
          <el-table-column label="访问者" width="140">
            <template #default="{ row }">
              <template v-if="row.user_id != null">
                <b>{{ row.username }}</b>
                <span class="cell-sub">#{{ row.user_id }}</span>
              </template>
              <el-tag v-else size="small" type="warning" effect="plain">游客</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="method" label="方法" width="80" />
          <el-table-column prop="path" label="路径" min-width="220" show-overflow-tooltip />
          <el-table-column prop="ip" label="IP" width="130" />
        </el-table>
        <el-pagination class="pg" background layout="total, prev, pager, next" :total="visits.total"
          :page-size="visits.size" v-model:current-page="visits.page" @current-change="loadVisits" />
      </el-tab-pane>

      <!-- ========== Tab 公告管理 ========== -->
      <el-tab-pane label="📢 公告管理" name="anns">
        <div class="toolbar">
          <el-button type="primary" size="small" @click="openAnnDlg(null)">＋ 发布公告</el-button>
          <span class="tip">置顶公告显示在全站顶部横幅</span>
        </div>
        <el-table :data="anns" v-loading="annLoading" stripe>
          <el-table-column prop="title" label="标题" min-width="180" show-overflow-tooltip />
          <el-table-column label="置顶" width="80">
            <template #default="{ row }">
              <el-tag v-if="row.pinned" size="small" type="danger">📌 置顶</el-tag>
              <span v-else class="cell-sub">—</span>
            </template>
          </el-table-column>
          <el-table-column prop="content" label="内容" min-width="240" show-overflow-tooltip />
          <el-table-column prop="admin_name" label="发布人" width="110" />
          <el-table-column prop="create_time" label="发布时间" width="165" :formatter="fmtT" />
          <el-table-column label="操作" width="180">
            <template #default="{ row }">
              <el-button link type="primary" size="small" @click="openAnnDlg(row)">编辑</el-button>
              <el-button link :type="row.pinned ? 'info' : 'danger'" size="small" @click="togglePin(row)">
                {{ row.pinned ? '取消置顶' : '置顶' }}
              </el-button>
              <el-button link type="danger" size="small" @click="delAnn(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="!annLoading && !anns.length" description="暂无公告 — 发布后全站可见" :image-size="60" />
      </el-tab-pane>

      <!-- ========== Tab4 资源管理 ========== -->
      <el-tab-pane label="📁 资源管理" name="resources">
        <div class="toolbar">
          <el-input v-model="resources.q" placeholder="搜索文件名 / 昵称 / 用户名" clearable style="width: 260px"
            @keyup.enter="resources.page = 1; loadResources()" @clear="resources.page = 1; loadResources()">
            <template #append><el-button @click="resources.page = 1; loadResources()">搜索</el-button></template>
          </el-input>
          <span class="count">共 {{ resources.total }} 个文件</span>
        </div>
        <el-table :data="resources.list" v-loading="resources.loading" stripe>
          <el-table-column prop="id" label="ID" width="70" />
          <el-table-column prop="file_name" label="文件名" min-width="200" show-overflow-tooltip />
          <el-table-column label="上传者" min-width="140">
            <template #default="{ row }">
              <b>{{ row.nickname || row.username }}</b>
              <span class="cell-sub">@{{ row.username }}</span>
            </template>
          </el-table-column>
          <el-table-column label="大小" width="100">
            <template #default="{ row }">{{ fmtBytes(row.file_size) }}</template>
          </el-table-column>
          <el-table-column prop="file_type" label="类型" width="150" show-overflow-tooltip />
          <el-table-column prop="create_time" label="上传时间" width="165" :formatter="fmtT" />
          <el-table-column label="操作" width="90" fixed="right">
            <template #default="{ row }">
              <el-button link type="danger" size="small" @click="delResource(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-pagination class="pg" background layout="total, prev, pager, next" :total="resources.total"
          :page-size="resources.size" v-model:current-page="resources.page" @current-change="loadResources" />
      </el-tab-pane>

      <!-- ========== Tab7 荣誉墙（前台 /honor 公开可见） ========== -->
      <el-tab-pane label="🏅 荣誉墙" name="honors">
        <div class="toolbar">
          <el-button type="primary" size="small" @click="openHonorDlg(null)">＋ 添加荣誉</el-button>
          <el-button size="small" :loading="bulkLoading" @click="bulkInput?.click()">
            📦 批量上传多张奖状
          </el-button>
          <input ref="bulkInput" type="file" accept="image/*" multiple hidden @change="handleBulkPick" />
          <span class="tip">
            共 {{ honors.list.length }} 条 · 奖状图会在上传前自动压缩 ·
            批量上传后标题取文件名，请点「编辑」逐条补充奖项信息
          </span>
        </div>
        <el-table :data="honors.list" v-loading="honors.loading" stripe>
          <el-table-column label="奖状图" width="86">
            <template #default="{ row }">
              <img v-if="row.has_image" class="hon-thumb" :src="row.image_url" alt="" @click="openImage(row.image_url, row.title)" />
              <span v-else class="cell-sub">无图</span>
            </template>
          </el-table-column>
          <el-table-column prop="title" label="奖项名称" min-width="200" show-overflow-tooltip />
          <el-table-column prop="award_level" label="级别" width="90">
            <template #default="{ row }">{{ row.award_level || '—' }}</template>
          </el-table-column>
          <el-table-column prop="winner" label="获奖者" min-width="120" show-overflow-tooltip>
            <template #default="{ row }">{{ row.winner || '—' }}</template>
          </el-table-column>
          <el-table-column prop="award_date" label="获奖时间" width="100" />
          <el-table-column prop="sort_order" label="排序" width="70" />
          <el-table-column label="上架" width="80">
            <template #default="{ row }">
              <el-switch v-model="row.is_active" size="small" @change="toggleHonorActive(row)" />
            </template>
          </el-table-column>
          <el-table-column prop="admin_name" label="录入人" width="100" />
          <el-table-column label="操作" width="130" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" size="small" @click="openHonorDlg(row)">编辑</el-button>
              <el-button link type="danger" size="small" @click="delHonor(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="!honors.loading && !honors.list.length"
          description="还没有荣誉 — 点「添加荣誉」或「批量上传多张奖状」" :image-size="60" />
        <p class="tip" style="margin-top:10px">
          下架的荣誉不会出现在前台，但其奖状图管理员仍可预览（方便确认后再上架）。
        </p>
      </el-tab-pane>

      <!-- ========== Tab5 服务器状态 ========== -->
      <el-tab-pane label="🖥️ 服务器状态" name="status">
        <div class="toolbar">
          <el-button :loading="statLoading" @click="loadStatus">刷新</el-button>
        </div>
        <div v-if="stat" class="stat-grid" v-loading="statLoading">
          <div class="stat-card"><b>{{ stat.counts.users }}</b><span>注册用户</span></div>
          <div class="stat-card"><b>{{ stat.counts.posts }}</b><span>分享帖子</span></div>
          <div class="stat-card"><b>{{ stat.counts.teams }}</b><span>项目小组</span></div>
          <div class="stat-card"><b>{{ stat.counts.todayLogins }}</b><span>今日登录</span></div>

          <div class="stat-panel">
            <div class="sp-row"><span>运行时长</span><b>{{ fmtUp(stat.uptime) }}</b></div>
            <div class="sp-row"><span>系统平台</span><b>{{ stat.platform }} · {{ stat.arch }}</b></div>
            <div class="sp-row"><span>Node 版本</span><b>{{ stat.node }}</b></div>
            <div class="sp-row"><span>CPU</span><b>{{ stat.cpus }} 核 · 1分钟负载 {{ (stat.loadavg[0] || 0).toFixed(2) }}</b></div>
          </div>

          <div class="stat-panel">
            <div class="sp-row"><span>内存占用</span><b>{{ fmtBytes(stat.totalmem - stat.freemem) }} / {{ fmtBytes(stat.totalmem) }}</b></div>
            <el-progress :percentage="pct(stat.totalmem - stat.freemem, stat.totalmem)" :stroke-width="10" />
            <div class="sp-row" style="margin-top:10px"><span>进程内存 (RSS)</span><b>{{ fmtBytes(stat.memRss) }}</b></div>
            <div class="sp-row"><span>数据库文件</span><b>{{ fmtBytes(stat.dbSize) }}</b></div>
          </div>

          <div class="stat-panel">
            <div class="sp-row">
              <span>磁盘占用</span>
              <b v-if="stat.disk">{{ fmtBytes(stat.disk.total - stat.disk.free) }} / {{ fmtBytes(stat.disk.total) }}</b>
              <b v-else class="cell-sub">当前环境不支持磁盘检测</b>
            </div>
            <el-progress v-if="stat.disk" :percentage="pct(stat.disk.total - stat.disk.free, stat.disk.total)"
              :stroke-width="10" :color="pct(stat.disk.total - stat.disk.free, stat.disk.total) > 85 ? '#ef4444' : '#10b981'" />
            <div class="sp-row" style="margin-top:10px"><span>数据更新时间</span><b>{{ fmtDateTimeS(stat.time) }}</b></div>
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>

    <!-- 用户详情弹窗：基本信息 + 内容统计 + 最近操作日志 -->
    <el-dialog v-model="detailDlg" title="👤 用户详情" width="680px" :close-on-click-modal="false">
      <div v-loading="detailLoading" style="min-height: 200px">
        <template v-if="detail">
          <div class="ud-head">
            <b class="ud-nick">{{ detail.user.nickname || detail.user.username }}</b>
            <el-tag size="small">@{{ detail.user.username }}</el-tag>
            <el-tag size="small" :type="STATUS_LABELS[detail.user.status][1]">{{ STATUS_LABELS[detail.user.status][0] }}</el-tag>
            <el-tag v-if="detail.user.is_admin" size="small" type="primary">管理员</el-tag>
            <span class="cell-sub">{{ detail.user.email }} · 注册于 {{ fmtDateTime(detail.user.create_time) }}</span>
          </div>
          <div class="ud-stats">
            <div><b>{{ detail.stats.posts }}</b><span>发帖</span></div>
            <div><b>{{ detail.stats.comments }}</b><span>评论</span></div>
            <div><b>{{ detail.stats.teams }}</b><span>所在小组</span></div>
          </div>
          <div class="ud-res">
            <div class="ud-res-title">📁 上传资源（{{ detail.resources.length }}）</div>
            <el-table :data="detail.resources" size="small" max-height="200" stripe>
              <el-table-column prop="file_name" label="文件名" min-width="180" show-overflow-tooltip />
              <el-table-column label="大小" width="90">
                <template #default="{ row }">{{ fmtBytes(row.file_size) }}</template>
              </el-table-column>
              <el-table-column prop="create_time" label="上传时间" width="155" :formatter="fmtT" />
              <el-table-column label="操作" width="70">
                <template #default="{ row }">
                  <el-button link type="primary" size="small" tag="a"
                    :href="api.resourceDownload(row.id)" target="_blank">下载</el-button>
                </template>
              </el-table-column>
            </el-table>
            <el-empty v-if="!detail.resources.length" description="该用户未上传资源" :image-size="50" />
          </div>
          <div class="ud-logs">
            <div class="ud-logs-title">最近操作日志（最多 20 条）</div>
            <el-table :data="detail.logs" size="small" max-height="300" stripe>
              <el-table-column prop="create_time" label="时间" width="155" :formatter="fmtT" />
              <el-table-column label="动作" width="105">
                <template #default="{ row }"><el-tag size="small">{{ actionLabel(row.action) }}</el-tag></template>
              </el-table-column>
              <el-table-column prop="target" label="目标" min-width="110" show-overflow-tooltip />
              <el-table-column label="详情" min-width="140" show-overflow-tooltip>
                <template #default="{ row }">{{ detailText(row.detail) }}</template>
              </el-table-column>
            </el-table>
            <el-empty v-if="!detail.logs.length" description="该用户暂无操作记录" :image-size="50" />
          </div>
        </template>
      </div>
    </el-dialog>

    <!-- 公告发布 / 编辑弹窗 -->
    <el-dialog v-model="annDlg" :title="annForm.id ? '编辑公告' : '发布公告'" width="520px" :close-on-click-modal="false">
      <el-form label-width="70px">
        <el-form-item label="标题"><el-input v-model="annForm.title" maxlength="60" show-word-limit placeholder="公告标题（≤60 字）" /></el-form-item>
        <el-form-item label="内容"><el-input v-model="annForm.content" type="textarea" :rows="6" maxlength="2000" show-word-limit placeholder="公告正文（显示在全站顶部）" /></el-form-item>
        <el-form-item label="置顶"><el-switch v-model="annForm.pinned" active-text="顶部横幅优先展示" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="annDlg = false">取消</el-button>
        <el-button type="primary" @click="saveAnn">{{ annForm.id ? '保存' : '发布' }}</el-button>
      </template>
    </el-dialog>

    <!-- 荣誉 添加 / 编辑弹窗（奖项信息与奖状图分开提交，见 routes/honor.js 注释） -->
    <el-dialog v-model="honorDlg" :title="honorForm.id ? '编辑荣誉' : '添加荣誉'" width="560px"
      :close-on-click-modal="false" @closed="honorReset">
      <el-form label-width="80px">
        <el-form-item label="奖项名称">
          <el-input v-model="honorForm.title" maxlength="60" show-word-limit placeholder="如：全国大学生电子设计竞赛 一等奖（≤60 字）" />
        </el-form-item>
        <el-form-item label="级别">
          <el-input v-model="honorForm.award_level" maxlength="20" placeholder="如：国家级 / 省级 / 校级（≤20 字）" />
        </el-form-item>
        <el-form-item label="获奖者">
          <el-input v-model="honorForm.winner" maxlength="40" placeholder="如：张三、李四（≤40 字）" />
        </el-form-item>
        <el-form-item label="获奖时间">
          <el-input v-model="honorForm.award_date" maxlength="20" placeholder="如：2025-08 或 2025 年 8 月（≤20 字）" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="honorForm.description" type="textarea" :rows="2" maxlength="200" show-word-limit
            placeholder="一句话说明，可不填（≤200 字）" />
        </el-form-item>
        <el-form-item label="奖状图">
          <div class="hon-pick">
            <img v-if="honorForm.preview || (honorForm.keepUrl && !honorForm.removeImg)" class="hon-prev"
              :src="honorForm.preview || honorForm.keepUrl" alt="" />
            <div v-else class="hon-empty">{{ honorForm.removeImg ? '（保存后删除图片）' : '暂无图片' }}</div>
            <div class="hon-acts">
              <input ref="honorFileInput" type="file" accept="image/*" hidden @change="handleHonorPick" />
              <el-button size="small" @click="honorFileInput?.click()">
                {{ (honorForm.keepUrl || honorForm.preview) && !honorForm.removeImg ? '更换图片' : '选择图片' }}
              </el-button>
              <el-button v-if="honorForm.keepUrl && !honorForm.file" size="small"
                :type="honorForm.removeImg ? 'info' : 'danger'" @click="toggleHonorRemove">
                {{ honorForm.removeImg ? '取消删除' : '删除图片' }}
              </el-button>
              <span v-if="honorForm.hint" class="tip">{{ honorForm.hint }}</span>
              <span v-else-if="honorForm.imageName" class="tip">当前：{{ honorForm.imageName }}</span>
            </div>
          </div>
        </el-form-item>
        <el-form-item label="排序">
          <el-input v-model="honorForm.sort_order" style="width:140px" placeholder="数字越大越靠前" />
          <span class="tip" style="margin-left:8px">留空 = 自动排到最前</span>
        </el-form-item>
        <el-form-item label="上架">
          <el-switch v-model="honorForm.is_active" active-text="显示在前台荣誉墙" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="honorDlg = false">取消</el-button>
        <el-button type="primary" @click="saveHonor">{{ honorForm.id ? '保存' : '添加' }}</el-button>
      </template>
    </el-dialog>
  </main>
</template>

<style lang="scss" scoped>
.admin-page { padding: 12px 20px 80px; max-width: 1100px; }
.page-head { margin-bottom: 12px; }
.page-head h2 { margin: 0; }
.page-head .sub { margin: 4px 0 0; color: var(--text-2, #64748b); font-size: 13px; }
.toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.count { font-size: 12.5px; color: var(--text-2, #64748b); }
.tip { font-size: 12px; color: var(--text-2, #64748b); }
.cell-sub { color: var(--text-2, #94a3b8); font-size: 12px; margin-left: 6px; }
.pg { margin-top: 12px; justify-content: flex-end; }

.stat-grid {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px;
  @media (max-width: 768px) { grid-template-columns: repeat(2, 1fr); }
}
.stat-card {
  background: var(--card-bg); border: 1px solid var(--border, #e2e8f0); border-radius: 12px;
  padding: 16px; display: flex; flex-direction: column; gap: 4px;
  b { font-size: 26px; color: var(--primary); }
  span { font-size: 12.5px; color: var(--text-2, #64748b); }
}
.stat-panel {
  grid-column: span 2; background: var(--card-bg); border: 1px solid var(--border, #e2e8f0);
  border-radius: 12px; padding: 14px 16px;
  @media (max-width: 768px) { grid-column: span 2; }
  .sp-row {
    display: flex; justify-content: space-between; align-items: center;
    font-size: 13px; margin-bottom: 8px;
    span { color: var(--text-2, #64748b); }
    b { font-weight: 600; }
  }
}

/* 用户详情弹窗 */
.ud-head {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px;
  .ud-nick { font-size: 17px; }
}
.ud-stats {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 14px;
  div {
    background: var(--surface-3); border: 1px solid var(--border, #e2e8f0); border-radius: 10px;
    padding: 12px; display: flex; flex-direction: column; gap: 2px; text-align: center;
    b { font-size: 20px; color: var(--primary); }
    span { font-size: 12px; color: var(--text-2, #64748b); }
  }
}
.ud-res, .ud-logs {
  margin-top: 14px;
  .ud-res-title, .ud-logs-title { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
}

/* 荣誉墙 */
.hon-thumb {
  width: 64px; height: 48px; object-fit: cover; border-radius: 6px; cursor: zoom-in;
  border: 1px solid var(--border, #e2e8f0); display: block;
}
.hon-pick { display: flex; align-items: flex-start; gap: 12px; width: 100%; }
.hon-prev {
  width: 132px; height: 96px; object-fit: contain; border-radius: 8px;
  border: 1px solid var(--border, #e2e8f0); background: var(--surface-2);
  flex-shrink: 0;
}
.hon-empty {
  width: 132px; height: 96px; border-radius: 8px; flex-shrink: 0;
  border: 1px dashed var(--border, #e2e8f0); background: var(--surface-3);
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; color: var(--text-2, #94a3b8); text-align: center; padding: 4px;
}
.hon-acts { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; min-width: 0; }
</style>
