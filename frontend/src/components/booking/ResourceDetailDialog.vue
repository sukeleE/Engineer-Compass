<template>
  <!-- 资源详情：录入时拍的照片 + 台账字段。只读，管理动作仍在资源列表里 -->
  <el-dialog model-value @close="emit('close')" title="资源详情" width="520px" append-to-body destroy-on-close>
    <div v-if="resource">
      <img v-if="resource.image" :src="resource.image" class="rd-photo" alt="资源照片"
        @click="openImage(resource.image, resource.name)" />
      <div v-else class="rd-photo ph"><span>📷 暂无照片</span></div>

      <div class="rd-head">
        <h3>{{ KIND_MAP[resource.kind]?.icon || '📦' }} {{ resource.name }}</h3>
        <el-tag size="small" :type="resource.approve_mode === 'first_come' ? 'success' : 'warning'" effect="plain">
          {{ MODE_ZH[resource.approve_mode] }}
        </el-tag>
        <el-tag v-if="resource.status === 'archived'" size="small" type="info">已归档</el-tag>
      </div>

      <dl class="rd-dl">
        <div><dt>类型</dt><dd>{{ resource.is_space ? '🏢 空间资源' : '📦 物品资源' }}</dd></div>
        <div v-if="resource.is_space"><dt>容量</dt><dd>👥 {{ resource.capacity }} 人</dd></div>
        <template v-else>
          <div><dt>库存</dt><dd>×{{ resource.quantity }} {{ resource.unit || '件' }}</dd></div>
          <div v-if="resource.spec"><dt>规格型号</dt><dd>{{ resource.spec }}</dd></div>
        </template>
        <div v-if="resource.location"><dt>位置</dt><dd>📍 {{ resource.location }}</dd></div>
        <div v-if="resource.is_space && resource.params?.equipment?.length">
          <dt>室内设备</dt>
          <dd>
            <span v-for="e in resource.params.equipment" :key="e" class="rd-tag">🛠 {{ e }}</span>
          </dd>
        </div>
      </dl>
      <p class="rd-tip">点上方照片可查看大图；需要修改请在「可用资源」里点编辑。</p>
    </div>

    <template #footer>
      <el-button @click="emit('close')">关闭</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { KIND_MAP, MODE_ZH } from '../../utils/booking.js';
import { openImage } from '../../utils/imageViewer.js';

defineProps({ resource: { type: Object, required: true } });
const emit = defineEmits(['close']);
</script>

<style lang="scss" scoped>
.rd-photo {
  display: block; width: 100%; max-height: 300px; object-fit: contain;
  border-radius: 10px; border: 1px solid var(--border); background: var(--surface-2); cursor: zoom-in;
  &.ph {
    aspect-ratio: 16 / 7; display: flex; align-items: center; justify-content: center;
    color: var(--text-3); font-size: 13px; cursor: default;
  }
}
.rd-head {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 14px;
  h3 { margin: 0; font-size: 16px; }
}
.rd-dl {
  margin: 12px 0 0; display: flex; flex-direction: column; gap: 8px;
  div { display: flex; gap: 12px; font-size: 13.5px; }
  dt { width: 64px; flex: none; color: var(--text-3); }
  dd { margin: 0; }
}
.rd-tag {
  display: inline-block; margin: 0 8px 4px 0; font-size: 12.5px; color: var(--text-2);
}
.rd-tip { margin: 12px 0 0; font-size: 12px; color: var(--text-3); }
</style>
