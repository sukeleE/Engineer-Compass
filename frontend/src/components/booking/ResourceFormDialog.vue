<template>
  <el-dialog :model-value="modelValue" @close="emit('close')" :title="resource ? '编辑资源' : '添加资源'"
    width="520px" append-to-body destroy-on-close>
    <el-form label-position="top">
      <el-form-item label="资源类型" required>
        <el-radio-group v-model="f.kind" :disabled="!!resource">
          <el-radio-button v-for="k in KINDS" :key="k.key" :value="k.key">{{ k.icon }} {{ k.label }}</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="名称" required>
        <el-input v-model="f.name" maxlength="30" show-word-limit :placeholder="meta.space ? '如：工程训练中心 301' : '如：大疆 RoboMaster S1'" />
      </el-form-item>
      <el-form-item label="位置">
        <el-input v-model="f.location" maxlength="60" :placeholder="meta.space ? '楼栋/房间号' : '存放位置'" />
      </el-form-item>

      <!-- 实物 / 现场照片（可选）：录入时拍一张，资源详情里可查看 -->
      <el-form-item label="资源照片（可选）">
        <div class="rf-shot" @click="pickShot">
          <img v-if="f.image" :src="f.image" alt="资源照片" />
          <div v-else class="rf-shot-ph"><span>📷</span><b>点击拍照 / 上传图片</b></div>
          <span v-if="f.image" class="rf-shot-retake">重拍</span>
        </div>
        <input ref="shotRef" type="file" accept="image/*" capture="environment" hidden @change="onShot" />
        <el-button v-if="f.image" link type="danger" size="small" style="margin-left: 10px" @click="f.image = ''">移除照片</el-button>
      </el-form-item>

      <!-- 空间：容量 + 设备参数 -->
      <template v-if="meta.space">
        <el-form-item label="可容纳人数" required>
          <el-input-number v-model="f.capacity" :min="1" :max="9999" :disabled="!!resource" />
          <span class="rf-hint">同一时段独占，预约人数不能超过容量</span>
        </el-form-item>
        <el-form-item label="室内设备（可选，回车添加，如投影仪、白板、通风橱）">
          <el-select v-model="f.equipment" multiple filterable allow-create default-first-option
            :reserve-keyword="false" style="width: 100%" placeholder="输入设备名后回车">
            <el-option v-for="e in f.equipment" :key="e" :value="e" :label="e" />
          </el-select>
        </el-form-item>
      </template>

      <!-- 物品：库存 + 单位 + 规格 -->
      <template v-else>
        <el-form-item label="库存数量" required>
          <el-input-number v-model="f.quantity" :min="1" :max="9999" />
          <el-input v-model="f.unit" maxlength="8" style="width: 96px; margin-left: 10px" placeholder="单位（件/台）" />
          <span class="rf-hint">按数量库存共享，借完为止</span>
        </el-form-item>
        <el-form-item label="规格型号（可选）">
          <el-input v-model="f.spec" maxlength="40" placeholder="如：STM32F407 开发板" />
        </el-form-item>
      </template>

      <el-form-item label="审批方式（该资源独立生效）">
        <el-radio-group v-model="f.approve_mode">
          <el-radio value="approval">需审批</el-radio>
          <el-radio value="first_come">先到先得</el-radio>
        </el-radio-group>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="emit('close')">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submit">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../../api.js';
import { KINDS, KIND_MAP } from '../../utils/booking.js';
import { compressImage } from '../../utils/imageCompress.js';

const props = defineProps({
  modelValue: Boolean,
  project: { type: Object, required: true },
  resource: { type: Object, default: null },
});
const emit = defineEmits(['close', 'saved']);

const empty = () => ({
  kind: 'space', name: '', location: '', capacity: 30, quantity: 1,
  unit: '', spec: '', equipment: [], image: '', approve_mode: props.project.default_approve_mode || 'approval',
});
const f = ref(empty());
const saving = ref(false);
const shotRef = ref(null);
const meta = computed(() => KIND_MAP[f.value.kind]);

watch(() => props.modelValue, (v) => {
  if (!v) return;
  if (props.resource) {
    f.value = {
      kind: props.resource.kind, name: props.resource.name, location: props.resource.location,
      capacity: props.resource.capacity ?? 30, quantity: props.resource.quantity ?? 1,
      unit: props.resource.unit || '', spec: props.resource.spec || '',
      equipment: props.resource.params?.equipment || [],
      image: props.resource.image || '',
      approve_mode: props.resource.approve_mode,
    };
  } else {
    f.value = empty();
  }
}, { immediate: true });

// ============ 拍照（与借用登记同一套压缩口径，后端单字段 ≤40 万字符） ============
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
    let out = await compressImage(file, { maxEdge: 900, quality: 0.8 });
    let url = await toDataUrl(out);
    if (url.length > 380000) {
      out = await compressImage(file, { maxEdge: 640, quality: 0.7 });
      url = await toDataUrl(out);
    }
    if (url.length > 380000) return ElMessage.warning('图片过大，请换一张更小的图片');
    f.value.image = url;
  } catch (err) {
    ElMessage.error(err.message || '图片处理失败');
  }
}

async function submit() {
  if (!f.value.name.trim()) return ElMessage.warning('请填写资源名称');
  const isSpace = meta.value.space;
  if (isSpace && !(f.value.capacity >= 1)) return ElMessage.warning('请填写可容纳人数');
  if (!isSpace && !(f.value.quantity >= 1)) return ElMessage.warning('请填写库存数量');
  const body = {
    kind: f.value.kind, name: f.value.name.trim(), location: f.value.location,
    image: f.value.image || '', approve_mode: f.value.approve_mode,
    ...(isSpace
      ? { capacity: f.value.capacity, equipment: f.value.equipment }
      : { quantity: f.value.quantity, unit: f.value.unit, spec: f.value.spec }),
  };
  saving.value = true;
  try {
    if (props.resource) {
      // 编辑时 kind/容量库存之外字段按类型提交；容量库存变更后端有占用复检
      const editBody = { name: body.name, location: body.location, image: body.image, approve_mode: body.approve_mode };
      if (isSpace) editBody.capacity = body.capacity, editBody.equipment = body.equipment;
      else editBody.quantity = body.quantity, editBody.unit = body.unit, editBody.spec = body.spec;
      await api.bookingResourceUpdate(props.resource.id, editBody);
      ElMessage.success('已保存');
    } else {
      await api.bookingResourceCreate(props.project.id, body);
      ElMessage.success('资源已添加');
    }
    emit('saved');
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    saving.value = false;
  }
}
</script>

<style lang="scss" scoped>
.rf-hint { margin-left: 12px; font-size: 12px; color: var(--text-3); }
.rf-shot {
  position: relative;
  width: 220px;
  aspect-ratio: 4 / 3;
  border-radius: 10px;
  border: 1px dashed var(--border);
  background: var(--surface-2);
  overflow: hidden;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  img { width: 100%; height: 100%; object-fit: cover; }
}
.rf-shot-ph {
  display: flex; flex-direction: column; align-items: center; gap: 6px; color: var(--text-3);
  span { font-size: 26px; }
  b { font-size: 12.5px; font-weight: 400; }
}
.rf-shot-retake {
  position: absolute; right: 8px; bottom: 8px; padding: 3px 9px; border-radius: 999px;
  background: rgba(0, 0, 0, 0.55); color: #fff; font-size: 11.5px;
}
</style>
