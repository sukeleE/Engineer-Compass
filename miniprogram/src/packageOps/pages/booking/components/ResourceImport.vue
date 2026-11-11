<template>
  <view class="modal-mask" @click="$emit('close')">
    <view class="modal" @click.stop>
      <view class="modal-title">批量导入资源</view>
      <scroll-view scroll-y class="modal-scroll">
        <!-- 步骤一：模板 -->
        <view class="step-title">① 下载填写模板</view>
        <view class="tpl-row">
          <view class="mini-btn" @click="downloadTpl('item')">物品模板</view>
          <view class="mini-btn" @click="downloadTpl('space')">空间模板</view>
          <view class="mini-btn" @click="downloadTpl('mixed')">混合模板</view>
        </view>
        <view class="f-hint">小程序只能从微信聊天记录选文件：模板打开后点右上角「…」转发给好友或文件传输助手，再从聊天里选回。</view>

        <!-- 步骤二：上传解析 -->
        <view class="step-title">② 选择表格（xlsx / xls / csv，≤100MB，最多 2000 条）</view>
        <button class="btn btn-primary btn-block" :disabled="parsing" @click="chooseFile">{{ parsing ? '解析中…' : '选择表格并智能解析' }}</button>
        <view v-if="parseInfo" class="parse-info">
          <text>解析方式：{{ parseInfo.ai_used ? 'AI 识别' : '标准规则' }}</text>
          <text v-if="parseInfo.strategy">（{{ parseInfo.strategy }}）</text>
        </view>
        <view v-for="(w, i) in warnings" :key="'w' + i" class="warn-line">⚠ {{ w }}</view>

        <!-- 步骤三：分组预览核对 -->
        <template v-if="items.length">
          <view class="step-title">③ 按工作表分组核对（{{ validItems.length }} 条可导入 / {{ items.length - validItems.length }} 条异常）</view>
          <view class="stat-row">
            <text class="tag tag-blue">物品 {{ stats.item }}</text>
            <text class="tag tag-purple">空间 {{ stats.space }}</text>
            <text class="tag tag-red">异常 {{ stats.invalid }}</text>
            <text class="tag" style="background:#f1f5f9;color:#475569">分组 {{ groupView.length }}</text>
          </view>

          <view v-for="g in groupView" :key="g.key" class="grp" :class="{ off: g.excluded }">
            <view class="grp-head">
              <switch :checked="!g.excluded" color="#2563eb" style="transform:scale(0.8)" @change="(e) => toggleGroup(g, e.detail.value)" />
              <text class="grp-name">🗂️ {{ g.name }}</text>
              <text class="grp-count">{{ g.list.length }} 条<text v-if="g.invalid"> · 异常 {{ g.invalid }}</text><text v-if="g.skipped"> · 跳过 {{ g.skipped }}</text></text>
            </view>
            <view v-for="it in g.list" :key="it._uid" class="imp-card" :class="{ bad: !it.valid }">
              <view class="imp-head">
                <text class="imp-name">{{ it.name || '（空名称）' }}</text>
                <text class="tag" :class="it.kind === 'space' ? 'tag-purple' : 'tag-blue'">{{ it.kind === 'space' ? '空间' : '物品' }}</text>
              </view>
              <view class="imp-line">
                <text v-if="it.kind === 'space'">容纳 {{ it.capacity }} 人</text>
                <text v-else>库存 {{ it.quantity }}{{ it.unit ? ' ' + it.unit : '' }}</text>
                <text v-if="it.location"> · {{ it.location }}</text>
                <text v-if="it.spec"> · {{ it.spec }}</text>
              </view>
              <view v-for="(msg, j) in it.issues" :key="j" class="issue-line">✕ {{ msg }}</view>
              <view v-for="(msg, j) in it.warnings" :key="'g' + j" class="warn-line">⚠ {{ msg }}</view>
              <text class="imp-del" @click="dropRow(it._uid)">移除该行</text>
            </view>
          </view>
        </template>
        <EmptyState v-else-if="parsed" icon="📭" text="未从表格中解析出资源行" />
      </scroll-view>
      <view class="modal-actions">
        <button class="btn btn-ghost modal-btn" @click="$emit('close')">取消</button>
        <button class="btn btn-primary modal-btn" :disabled="!validItems.length || importing" @click="submit">{{ importing ? '导入中…' : '确认导入 ' + (validItems.length || '') + ' 条' }}</button>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue';
import { api } from '../../../../utils/api.js';
import { toast } from '../../../../utils/guard.js';
import { downloadAndOpen } from '../../../../utils/download.js';
import EmptyState from '../../../../components/EmptyState.vue';

const props = defineProps({ projectId: { type: Number, required: true } });
const emit = defineEmits(['close', 'imported']);

const parsing = ref(false);
const importing = ref(false);
const parsed = ref(false);
const items = ref([]);
const groupMeta = ref([]);
const warnings = ref([]);
const parseInfo = ref(null);
let uidSeq = 0;

const stats = computed(() => {
  const s = { item: 0, space: 0, invalid: 0 };
  for (const it of items.value) {
    if (it.kind === 'space') s.space += 1; else s.item += 1;
    if (!it.valid) s.invalid += 1;
  }
  return s;
});
// 服务端分组摘要（含空分组/跳过数）+ 行数据合并
const groupView = computed(() => {
  const map = new Map();
  for (const g of groupMeta.value) {
    map.set(g.name, { key: 'g' + g.sheet_index + ':' + g.name, name: g.name, excluded: !!g.excluded, skipped: g.skipped || 0, invalid: 0, list: [] });
  }
  for (const it of items.value) {
    const gn = it.group_name || '';
    if (!map.has(gn)) map.set(gn, { key: 'manual:' + (gn || 'empty'), name: gn || '未分组', excluded: false, skipped: 0, invalid: 0, list: [] });
    map.get(gn).list.push(it);
  }
  const out = [...map.values()];
  for (const g of out) g.invalid = g.list.filter((x) => !x.valid).length;
  return out;
});
const validItems = computed(() => items.value.filter((x) => x.valid && !isExcluded(x.group_name)));
function isExcluded(name) {
  const g = groupView.value.find((x) => x.name === (name || ''));
  return !!g?.excluded;
}
function toggleGroup(g, included) {
  g.excluded = !included;
  const meta = groupMeta.value.find((m) => m.name === g.name);
  if (meta) meta.excluded = g.excluded;
}

function tplUrl(kind) {
  return '/api/booking/projects/' + props.projectId + '/resources/import-template?kind=' + kind;
}
async function downloadTpl(kind) {
  const name = kind === 'mixed' ? '资源导入模板_混合.xlsx' : '资源导入模板_' + (kind === 'space' ? '空间' : '物品') + '.xlsx';
  try {
    await downloadAndOpen(tplUrl(kind), name);
  } catch (e) { /* 下载工具已 toast */ }
}
function chooseFile() {
  uni.chooseMessageFile({
    count: 1,
    type: 'file',
    extension: ['xlsx', 'xls', 'csv'],
    success: (r) => uploadParse(r.tempFiles[0].path),
    fail: () => {},
  });
}
async function uploadParse(filePath) {
  parsing.value = true;
  try {
    const out = await api.bookingResourceAutoParse(props.projectId, filePath);
    items.value = (out.items || []).map((it) => ({ ...it, _uid: ++uidSeq }));
    groupMeta.value = Array.isArray(out.groups) ? out.groups.map((g) => ({ ...g, excluded: false })) : [];
    warnings.value = out.warnings || [];
    parseInfo.value = { ai_used: !!out.ai_used, strategy: out.strategy || out.source || '' };
    parsed.value = true;
    if (!items.value.length) toast('没有识别出确定的资源行，请核对模板格式');
  } catch (e) { /* request/upload 已全局 toast */ } finally {
    parsing.value = false;
  }
}
function dropRow(uid) {
  const i = items.value.findIndex((x) => x._uid === uid);
  if (i >= 0) items.value.splice(i, 1);
}
async function submit() {
  const rows = validItems.value;
  if (!rows.length) return toast('没有可导入的有效行');
  importing.value = true;
  try {
    const payload = rows.map((it) => ({
      kind: it.kind,
      name: it.name,
      spec: it.spec || '',
      location: it.location || '',
      group_name: it.group_name || '',
      quantity: it.quantity,
      unit: it.unit || '',
      capacity: it.capacity,
      equipment: Array.isArray(it.equipment) ? it.equipment : [],
      approve_mode: it.approve_mode || '',
    }));
    const r = await api.bookingResourceBulk(props.projectId, payload);
    toast(r.message || '导入成功', 'success');
    emit('imported');
  } catch (e) { /* 已 toast（含坏行行号） */ } finally {
    importing.value = false;
  }
}
</script>

<style lang="scss" scoped>
.modal-mask { position: fixed; inset: 0; background: rgba(15,23,42,0.45); z-index: 110; display: flex; align-items: center; justify-content: center; padding: 40rpx; }
.modal { width: 100%; max-height: 86vh; background: #fff; border-radius: 24rpx; padding: 32rpx; display: flex; flex-direction: column; }
.modal-title { font-size: 32rpx; font-weight: 800; text-align: center; margin-bottom: 20rpx; }
.modal-scroll { max-height: 64vh; }
.step-title { font-size: 27rpx; font-weight: 700; color: #1e293b; margin: 20rpx 0 12rpx; }
.tpl-row { display: flex; gap: 14rpx; }
.mini-btn { flex: 1; text-align: center; font-size: 25rpx; color: #2563eb; background: #eff6ff; border-radius: 24rpx; padding: 14rpx 0; }
.f-hint { font-size: 22rpx; color: #94a3b8; line-height: 1.6; margin-top: 12rpx; }
.parse-info { font-size: 23rpx; color: #2563eb; margin-top: 14rpx; }
.warn-line { font-size: 23rpx; color: #b45309; background: #fffbeb; border-radius: 10rpx; padding: 10rpx 16rpx; margin-top: 10rpx; }
.stat-row { display: flex; gap: 12rpx; margin: 12rpx 0; flex-wrap: wrap; }
.grp { border: 1rpx solid #e2e8f0; border-radius: 16rpx; padding: 14rpx 16rpx; margin-bottom: 16rpx; }
.grp.off { opacity: .55; background: #f8fafc; }
.grp-head { display: flex; align-items: center; gap: 10rpx; margin-bottom: 8rpx; }
.grp-name { font-size: 26rpx; font-weight: 700; color: #1e293b; flex: 1; }
.grp-count { font-size: 22rpx; color: #64748b; }
.imp-card { background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 16rpx; padding: 18rpx; margin-bottom: 14rpx; position: relative; }
.imp-card.bad { border-color: #fecaca; background: #fef2f2; }
.imp-head { display: flex; justify-content: space-between; align-items: center; gap: 12rpx; }
.imp-name { font-size: 27rpx; font-weight: 700; color: #1e293b; flex: 1; }
.imp-line { font-size: 23rpx; color: #64748b; margin-top: 8rpx; }
.issue-line { font-size: 23rpx; color: #b91c1c; margin-top: 6rpx; }
.imp-del { position: absolute; right: 18rpx; bottom: 14rpx; font-size: 22rpx; color: #ef4444; }
.modal-actions { display: flex; gap: 18rpx; margin-top: 18rpx; }
.modal-btn { flex: 1; height: 80rpx; font-size: 27rpx; }
</style>
