<template>
  <!-- 借用登记（设备 / 教室同一套表单）：拍照 + 名称 + 学号，时间由服务端记录。挂在项目页第 5 个 tab。 -->
  <div class="reg-card">
    <div class="exp-tabbar">
      <button class="tabchip" :class="{ on: kind === 'device' }" @click="switchKind('device')">📦 借设备</button>
      <button class="tabchip" :class="{ on: kind === 'room' }" @click="switchKind('room')">🏫 借教室</button>
    </div>

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
    <p class="reg-tip">登记不进周视图甘特，可在本页「预约与审批」表和「我的预约」里查看记录。</p>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import auth, { patchUser } from '../../auth.js';
import { api } from '../../api.js';
import { compressImage } from '../../utils/imageCompress.js';

const props = defineProps({ project: { type: Object, required: true } });
const emit = defineEmits(['registered']);

const kind = ref('device');
const submitting = ref(false);
const shotRef = ref(null);
// thumb 只给项目表/管理列表用（≤6 万字符），原图 item_image 只在点开单条时按 id 取
const reg = reactive({ item_name: '', student_no: '', image: '', thumb: '' });
const isRoom = computed(() => kind.value === 'room');

function switchKind(k) {
  // 设备/教室是同一套表单，切换时清掉上一类的名称与照片，学号保留
  if (k !== kind.value) {
    reg.item_name = '';
    reg.image = '';
    reg.thumb = '';
  }
  kind.value = k;
}

// ============ 拍照 ============
const pickShot = () => shotRef.value?.click();

function toDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(new Error('图片读取失败'));
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
    const d = await api.bookingBorrowRegister(props.project.id, {
      kind: isRoom.value ? 'room' : 'device',
      item_name: name,
      item_image: reg.image,
      item_thumb: reg.thumb,
    });
    ElMessage.success(d.message || '登记成功');
    reg.item_name = '';
    reg.image = '';
    reg.thumb = '';
    emit('registered');
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    submitting.value = false;
  }
}

onMounted(() => { reg.student_no = auth.user?.student_no || ''; });
</script>

<style lang="scss" scoped>
.reg-card { padding: 14px; }
.reg-title { margin: 12px 0 2px; font-size: 15px; }
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
</style>
