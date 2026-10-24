<template>
  <div class="pv-wrap lab-wrap">
    <!-- 页头 -->
    <div class="pv-hero card">
      <div>
        <h2>📦 资源借用 <el-tag v-if="canAdmin('lab')" size="small" type="danger" effect="light">实验室管理员</el-tag></h2>
        <p class="sub2">借设备、借教室都做一次登记：对着实物或教室内拍照，填写物品名称（教室编号）、姓名、学号，时间自动记录。</p>
      </div>
      <!-- 全局查看 + 导出是实验室管理员的独立页面，不在学生端里摊开 -->
      <el-button v-if="canAdmin('lab')" size="small" @click="$router.push('/lab-admin')">🗂️ 借用记录管理</el-button>
    </div>

    <div class="exp-tabbar">
      <button class="tabchip" :class="{ on: seg === 'device' }" @click="switchSeg('device')">📦 借设备</button>
      <button class="tabchip" :class="{ on: seg === 'room' }" @click="switchSeg('room')">🏫 借教室</button>
      <button class="tabchip" :class="{ on: seg === 'mine' }" @click="switchSeg('mine')">📋 我的借用</button>
    </div>

    <!-- ============ 借用登记（设备 / 教室同一套表单） ============ -->
    <div v-if="seg === 'device' || seg === 'room'" class="card reg-card">
      <h3 class="reg-title">{{ isRoom ? '🏫 借教室登记' : '📦 借设备登记' }}</h3>
      <p class="reg-sub">
        {{ isRoom ? '对着教室内环境拍一张照片，再填写教室编号、姓名、学号。' : '对着所借物品拍一张照片，再填写物品名称、姓名、学号。' }}
      </p>

      <div class="shot" @click="pickShot">
        <img v-if="reg.image" :src="reg.image" alt="借用照片" />
        <div v-else class="shot-ph">
          <span>📷</span>
          <b>点击拍照</b>
          <i>{{ isRoom ? '对着教室内环境' : '对着所借物品' }}</i>
        </div>
        <span v-if="reg.image" class="shot-retake">重拍</span>
      </div>
      <input ref="shotRef" type="file" accept="image/*" capture="environment" hidden @change="onShot" />

      <el-form label-position="top" class="reg-form">
        <el-form-item :label="isRoom ? '所借教室编号' : '所借物品名称'" required>
          <el-input v-model="reg.item_name" maxlength="40" show-word-limit
            :placeholder="isRoom ? '如：N2-201' : '如：数字示波器'" />
        </el-form-item>
        <el-form-item label="姓名（实名信息，不可修改）">
          <el-input :model-value="auth.user?.real_name || ''" disabled />
        </el-form-item>
        <el-form-item label="学号" required>
          <el-input v-model="reg.student_no" maxlength="20" placeholder="4-20 位数字" />
        </el-form-item>
      </el-form>

      <el-button type="primary" class="reg-submit" :loading="submitting" @click="submitReg">提交借用登记</el-button>
      <p class="reg-tip">登记时间由系统自动记录，可在「我的借用」查看。</p>
    </div>

    <!-- ============ 我的借用 ============ -->
    <div v-if="seg === 'mine'" class="card" v-loading="mineLoading">
      <div v-for="b in mine" :key="b.id" class="mine-row">
        <div class="mr-main">
          <img v-if="b.item_image" :src="b.item_image" class="mr-thumb" alt="" />
          <span class="mr-kind">{{ kindOf(b) === 'room' ? '🏫' : '📦' }}</span>
          <b>{{ regTitle(b) }}</b>
          <el-tag :type="STATUS_META[b.status]?.type || 'info'" size="small">{{ STATUS_META[b.status]?.label || b.status }}</el-tag>
        </div>
        <div class="mr-meta">{{ kindOf(b) === 'room' ? '教室借用' : '设备借用' }} · 登记于 {{ b.start_time }}</div>
        <div class="mr-foot">
          <span class="dim">{{ b.booker_name }} {{ b.booker_student_no || '未填学号' }}</span>
          <el-button v-if="b.status === 'pending' || b.status === 'confirmed'" link type="danger" size="small" @click="cancelBorrow(b)">取消</el-button>
        </div>
      </div>
      <div v-if="!mine.length" class="empty-wrap"><el-empty description="还没有借用记录" :image-size="80" /></div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import auth, { patchUser } from '../../auth.js';
import { api } from '../../api.js';
import { canAdmin } from '../../utils/adminPerms.js';
import { compressImage } from '../../utils/imageCompress.js';
import { STATUS_META } from '../../utils/booking.js';

const seg = ref('device');
const projectId = ref(null);

const mine = ref([]);
const mineLoading = ref(false);

const submitting = ref(false);
const shotRef = ref(null);
// thumb 只给管理员列表用（≤6 万字符），原图 item_image 只在点开单条时按 id 取
const reg = reactive({ item_name: '', student_no: '', image: '', thumb: '' });
const isRoom = computed(() => seg.value === 'room');

const kindOf = (b) => (b.item_kind === 'room' || b.item_kind === 'device' ? b.item_kind : (b.is_space ? 'room' : 'device'));
const regTitle = (b) => b.item_name || b.resource_name || '借用登记';

async function ensureProject() {
  const { project } = await api.bookingLabProject();
  projectId.value = project.id;
}

function switchSeg(s) {
  // 设备/教室是同一套登记表，切换时清掉上一类的名称与照片，学号保留
  if (s !== seg.value && (s === 'device' || s === 'room')) {
    reg.item_name = '';
    reg.image = '';
    reg.thumb = '';
  }
  seg.value = s;
  if (s === 'mine') loadMine();
}

async function loadMine() {
  if (!projectId.value) return;
  mineLoading.value = true;
  try {
    const { bookings } = await api.bookingList(projectId.value, { mine: 1 });
    mine.value = bookings;
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    mineLoading.value = false;
  }
}

// ============ 拍照 ============
const pickShot = () => shotRef.value?.click();

function toDataUrl(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result || ''));
    fr.onerror = () => rej(new Error('图片读取失败'));
    fr.readAsDataURL(file);
  });
}

async function onShot(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    // 后端单字段上限 40 万字符：长边 900 起步，超限再缩一档
    let out = await compressImage(file, { maxEdge: 900, quality: 0.8 });
    let url = await toDataUrl(out);
    if (url.length > 380000) {
      out = await compressImage(file, { maxEdge: 640, quality: 0.7 });
      url = await toDataUrl(out);
    }
    if (url.length > 380000) return ElMessage.warning('图片过大，请换一张更小的图片');
    reg.image = url;
    // 缩略图：管理员全局列表里显示，避免几十 MB 的 dataURL 一次传下来
    const small = await compressImage(file, { maxEdge: 240, quality: 0.6 });
    reg.thumb = await toDataUrl(small);
  } catch (err) {
    ElMessage.error(err.message || '图片处理失败');
  }
}

async function submitReg() {
  const name = reg.item_name.trim();
  if (!name) return ElMessage.warning(isRoom.value ? '请填写所借教室编号' : '请填写所借物品名称');
  if (!reg.image) return ElMessage.warning(isRoom.value ? '请拍摄教室内环境照片' : '请拍摄所借物品照片');
  const sno = String(reg.student_no || '').trim();
  if (!/^\d{4,20}$/.test(sno)) return ElMessage.warning('学号须为 4-20 位数字');
  submitting.value = true;
  try {
    // 学号变更先落库，再由后端从 user 取快照
    if (sno !== auth.user?.student_no) {
      const r = await api.setStudentNo(sno);
      patchUser({ student_no: r.user?.student_no || sno });
    }
    const d = await api.bookingBorrowRegister({
      kind: isRoom.value ? 'room' : 'device',
      item_name: name,
      item_image: reg.image,
      item_thumb: reg.thumb,
    });
    ElMessage.success(d.message || '登记成功');
    reg.item_name = '';
    reg.image = '';
    reg.thumb = '';
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    submitting.value = false;
  }
}

async function cancelBorrow(b) {
  try {
    await ElMessageBox.confirm(`确认取消「${regTitle(b)}」的借用登记？`, '取消借用', { type: 'warning' });
  } catch { return; }
  try {
    await api.bookingCancel(b.id);
    ElMessage.success('已取消');
    await loadMine();
  } catch (e) {
    ElMessage.error(e.message);
  }
}

onMounted(async () => {
  if (!auth.token) return;
  reg.student_no = auth.user?.student_no || '';
  try {
    await ensureProject();
  } catch (e) {
    ElMessage.error(e.message);
  }
});
</script>

<style lang="scss" scoped>
.lab-wrap { padding-bottom: 30px; }

// ---- 登记表单 ----
.reg-card { padding: 14px; }
.reg-title { margin: 0 0 2px; font-size: 15px; }
.reg-sub { margin: 0 0 12px; font-size: 12.5px; color: var(--text-3); }
.shot {
  position: relative;
  width: 100%;
  aspect-ratio: 4 / 3;
  max-height: 260px;
  border-radius: 12px;
  border: 1px dashed var(--border);
  background: var(--surface-2);
  overflow: hidden;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  img { width: 100%; height: 100%; object-fit: cover; }
}
.shot-ph {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  color: var(--text-3);
  span { font-size: 30px; }
  b { font-size: 13.5px; color: var(--text-2); }
  i { font-style: normal; font-size: 11.5px; }
}
.shot-retake {
  position: absolute;
  right: 8px;
  bottom: 8px;
  padding: 3px 9px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 11.5px;
}
.reg-form { margin-top: 12px; }
.reg-submit { width: 100%; }
.reg-tip { margin: 8px 0 0; font-size: 11.5px; color: var(--text-3); text-align: center; }

// ---- 记录列表 ----
.mine-row {
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
  &:last-child { border-bottom: 0; }
}
.mr-main { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mr-thumb { width: 40px; height: 40px; border-radius: 8px; object-fit: cover; border: 1px solid var(--border); }
.mr-kind { font-size: 13px; }
.mr-meta { font-size: 12.5px; color: var(--text-2); margin-top: 3px; }
.mr-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 4px; }
</style>
