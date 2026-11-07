<template>
  <view class="page-wrap">
    <view class="card">
      <view class="f-label">比赛/项目档案</view>
      <picker :range="openEvents" range-key="name" :value="eventIndex" @change="onEvent">
        <view class="line-input picker-like">{{ currentEvent ? currentEvent.name : '请选择档案' }}</view>
      </picker>

      <view class="f-label row-title">
        <text>物料明细</text>
        <view class="title-ops">
          <text class="add-row bom-btn" @click="recognizeBom">{{ bomBusy ? '识别中…' : '🤖 BOM 识别' }}</text>
          <text class="add-row" @click="addItem">＋ 添加一行</text>
        </view>
      </view>
      <view v-for="(it, i) in form.items" :key="i" class="item">
        <view class="item-head">
          <text class="item-no">#{{ i + 1 }}</text>
          <text v-if="form.items.length > 1" class="item-del" @click="removeItem(i)">删除</text>
        </view>
        <input v-model="it.name" class="line-input" maxlength="60" placeholder="物料名称（必填）" />
        <input v-model="it.spec" class="line-input" maxlength="40" placeholder="规格型号（选填）" />
        <view class="num-row">
          <input v-model="it.qty" class="line-input half" type="digit" placeholder="数量" @input="calc(i)" />
          <input v-model="it.unit_price" class="line-input half" type="digit" placeholder="单价（元）" @input="calc(i)" />
        </view>
        <input v-model="it.link" class="line-input" placeholder="购买链接（选填，http 开头）" />
        <view class="item-amount">小计：¥{{ rowAmount(it) }}</view>
      </view>

      <view class="f-label">备注（≤300 字）</view>
      <textarea v-model="form.remark" class="modal-textarea" maxlength="300" placeholder="用途、紧急程度等说明" />

      <view class="total-bar">
        <text>合计金额</text>
        <text class="total-num">¥{{ total }}</text>
      </view>
      <button class="btn btn-primary btn-block" :disabled="submitting" @click="submit">{{ submitting ? '提交中…' : (editId ? '保存并重新提交' : '提交申请') }}</button>
    </view>
  </view>
</template>

<script setup>
import { reactive, ref, computed } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { toast } from '../../../utils/guard.js';

const events = ref([]);
const openEvents = computed(() => events.value.filter((e) => e.status === 'open' || (editId && e.id === form.event_id)));
const eventIndex = ref(0);
const currentEvent = computed(() => openEvents.value[eventIndex.value] || null);
const editId = ref(null);
const submitting = ref(false);
const bomBusy = ref(false);
const form = reactive({ event_id: null, remark: '', items: [{ name: '', spec: '', qty: '', unit_price: '', link: '' }] });

function onEvent(e) {
  eventIndex.value = Number(e.detail.value);
  form.event_id = openEvents.value[eventIndex.value].id;
}
function addItem() {
  if (form.items.length >= 50) return toast('一次最多 50 行');
  form.items.push({ name: '', spec: '', qty: '', unit_price: '', link: '' });
}
function removeItem(i) { form.items.splice(i, 1); }

// BOM 表识别填表：支持图片（拍照/相册，走视觉识别）与聊天文件（xlsx/xls/csv/pdf）
function recognizeBom() {
  uni.showActionSheet({
    itemList: ['拍照 / 相册图片', '从聊天记录选表格或 PDF'],
    success: (m) => {
      if (m.tapIndex === 0) {
        uni.chooseMedia({
          count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'],
          success: (r) => runBom(r.tempFiles[0].tempFilePath),
          fail: () => {},
        });
      } else {
        uni.chooseMessageFile({
          count: 1, type: 'file', extension: ['xlsx', 'xls', 'csv', 'pdf'],
          success: (r) => runBom(r.tempFiles[0].path),
          fail: () => {},
        });
      }
    },
    fail: () => {},
  });
}
async function runBom(filePath) {
  if (bomBusy.value) return;
  bomBusy.value = true;
  uni.showLoading({ title: '识别中…', mask: true });
  try {
    const out = await api.purchaseRecognizeBom(filePath);
    const rows = out.items || [];
    if (!rows.length) {
      uni.hideLoading();
      toast('没有识别出确定的物料行，请手工填写或换更清晰的文件');
      return;
    }
    let added = 0;
    let hitLimit = false;
    for (const r of rows) {
      if (form.items.length >= 50) { hitLimit = true; break; }
      form.items.push({
        name: r.name || '', spec: r.spec || '',
        qty: String(r.qty || 1), unit_price: String(r.unit_price || 0), link: '',
      });
      added += 1;
    }
    uni.hideLoading();
    const warns = Array.isArray(out.warnings) ? out.warnings : [];
    if (warns.length) {
      uni.showModal({
        title: '已识别追加 ' + added + ' 行',
        content: warns.join('\n') + (hitLimit ? '\n（已达 50 行上限，剩余未追加）' : ''),
        showCancel: false,
      });
    } else {
      toast('已识别追加 ' + added + ' 行，请核对' + (hitLimit ? '（50 行上限）' : ''), 'success');
    }
  } catch (e) {
    uni.hideLoading();
  } finally {
    bomBusy.value = false;
  }
}
function calc() { /* 金额由 computed 派生，占位保留扩展 */ }
function rowAmount(it) {
  const q = Number(it.qty); const p = Number(it.unit_price);
  return Number.isFinite(q) && Number.isFinite(p) ? (q * p).toFixed(2) : '0.00';
}
const total = computed(() => form.items.reduce((s, it) => s + Number(rowAmount(it)), 0).toFixed(2));

async function loadEvents() { events.value = (await api.purchaseEvents()).events || []; }
async function loadEdit(id) {
  const r = await api.purchaseRequest(id);
  const d = r.detail;
  editId.value = id;
  form.event_id = d.event_id;
  form.remark = d.remark || '';
  form.items = d.items.map((it) => ({ id: it.id, name: it.name, spec: it.spec || '', qty: String(it.qty), unit_price: String(it.unit_price), link: it.link || '' }));
  const idx = openEvents.value.findIndex((e) => e.id === d.event_id);
  eventIndex.value = idx < 0 ? 0 : idx;
  uni.setNavigationBarTitle({ title: '编辑采购申请' });
}

async function submit() {
  if (!form.event_id) return toast('请选择比赛/项目档案');
  const items = [];
  for (let i = 0; i < form.items.length; i++) {
    const it = form.items[i];
    if (!it.name.trim()) return toast('第 ' + (i + 1) + ' 行物料名称为空');
    const qty = Number(it.qty);
    const price = Number(it.unit_price);
    if (!(qty > 0)) return toast('第 ' + (i + 1) + ' 行数量需大于 0');
    if (!(price >= 0)) return toast('第 ' + (i + 1) + ' 行单价不正确');
    if (it.link && !/^https?:\/\//i.test(it.link)) return toast('第 ' + (i + 1) + ' 行链接需 http 开头');
    const row = { name: it.name.trim(), spec: it.spec.trim(), qty, unit_price: price, link: it.link.trim() };
    if (it.id) row.id = it.id;
    items.push(row);
  }
  if (!items.length) return toast('至少填写一条物料');
  submitting.value = true;
  try {
    const card = { event_id: form.event_id, items, remark: form.remark.trim() };
    if (editId.value) await api.purchaseUpdate(editId.value, card);
    else await api.purchaseCreate(card);
    toast(editId.value ? '已重新提交' : '申请已提交', 'success');
    setTimeout(() => uni.navigateBack(), 700);
  } finally {
    submitting.value = false;
  }
}

onLoad((o) => {
  loadEvents().then(() => {
    form.event_id = openEvents.value.length ? openEvents.value[0].id : null;
    if (o.id) loadEdit(Number(o.id));
  });
});
</script>

<style lang="scss" scoped>
.f-label { font-size: 24rpx; color: #64748b; margin: 18rpx 4rpx 10rpx; }
.row-title { display: flex; justify-content: space-between; align-items: center; }
.add-row { color: #2563eb; font-size: 24rpx; }
.title-ops { display: flex; gap: 20rpx; align-items: center; }
.bom-btn { color: #6d28d9; }
.line-input { background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 12rpx; padding: 16rpx 20rpx; font-size: 26rpx; margin-bottom: 12rpx; }
.picker-like { color: #334155; }
.item { background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 16rpx; padding: 18rpx; margin-bottom: 16rpx; }
.item-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10rpx; }
.item-no { font-weight: 700; color: #2563eb; font-size: 26rpx; }
.item-del { font-size: 23rpx; color: #ef4444; }
.num-row { display: flex; gap: 12rpx; }
.half { flex: 1; }
.item-amount { text-align: right; font-size: 24rpx; color: #dc2626; font-weight: 700; }
.modal-textarea { width: 100%; box-sizing: border-box; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 12rpx; padding: 18rpx 20rpx; font-size: 26rpx; min-height: 150rpx; }
.total-bar { display: flex; justify-content: space-between; align-items: center; margin: 24rpx 4rpx; font-size: 28rpx; color: #334155; }
.total-num { font-size: 40rpx; font-weight: 800; color: #dc2626; }
</style>
