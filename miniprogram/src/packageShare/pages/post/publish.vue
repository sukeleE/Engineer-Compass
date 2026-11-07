<template>
  <view class="page-wrap">
    <view class="card">
      <input v-model="form.title" class="title-input" maxlength="60" placeholder="标题（必填，≤60 字）" />
      <textarea v-model="form.content" class="content-area" maxlength="8000" placeholder="分享内容、经验、教程或项目说明（支持简单 Markdown）" />
      <view class="f-label">标签（最多 5 个，用逗号或空格分隔）</view>
      <input v-model="tagText" class="line-input" placeholder="例如：单片机, 电赛, 开源" />
      <view v-if="tags.length" class="tag-row">
        <text v-for="t in tags" :key="t" class="tag tag-blue">#{{ t }}</text>
      </view>

      <view class="f-label">图片附件（最多 6 张，单张 ≤7MB）</view>
      <view class="att-grid">
        <view v-for="(a, i) in images" :key="i" class="att-cell">
          <image :src="inlineImageUrl(a)" class="att-img" mode="aspectFill" @click="previewAttachment(a)" />
          <view class="att-del" @click="removeImage(i)">×</view>
        </view>
        <view v-if="images.length < 6" class="att-add" @click="addImage">＋</view>
      </view>

      <view class="switch-row">
        <view>
          <text class="sw-title">公开开源</text>
          <text class="sw-desc">关闭后仅自己可见</text>
        </view>
        <switch :checked="form.is_public === 1" color="#2563eb" @change="onPublic" />
      </view>

      <button class="btn btn-primary btn-block" :disabled="submitting" @click="submit">{{ submitting ? (editId ? '保存中…' : '发布中…') : (editId ? '保存修改' : '发布分享') }}</button>
    </view>
  </view>
</template>

<script setup>
import { reactive, ref, computed } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { toast } from '../../../utils/guard.js';
import { chooseImageAsBase64 } from '../../../utils/fileBase64.js';
import { previewAttachment, inlineImageUrl } from '../../../utils/preview.js';

const form = reactive({ title: '', content: '', is_public: 1 });
const tagText = ref('');
const images = ref([]);
const submitting = ref(false);
const editId = ref(0);

onLoad((o) => {
  if (!o || !o.id) return;
  editId.value = Number(o.id);
  uni.setNavigationBarTitle({ title: '编辑分享' });
  loadForEdit();
});

async function loadForEdit() {
  const post = await api.sharePost(editId.value);
  form.title = post.title || '';
  form.content = post.content || '';
  form.is_public = post.is_public ? 1 : 0;
  tagText.value = (post.tags || []).join(', ');
  try { images.value = JSON.parse(post.attachments || '[]'); } catch (e) { images.value = []; }
}

const tags = computed(() => tagText.value.split(/[,，\s、]+/).map((s) => s.trim()).filter(Boolean).slice(0, 5));

async function addImage() {
  try {
    const a = await chooseImageAsBase64(7);
    images.value.push(a);
  } catch (e) { /* 用户取消或超限已提示 */ }
}
function removeImage(i) { images.value.splice(i, 1); }
function onPublic(e) { form.is_public = e.detail.value ? 1 : 0; }

async function submit() {
  const title = form.title.trim();
  if (!title) return toast('请填写标题');
  const content = form.content.trim();
  if (!content && !images.value.length) return toast('写点内容或至少附一张图片');
  if (submitting.value) return;
  submitting.value = true;
  try {
    const payload = {
      title,
      content,
      tags: tags.value,
      attachments: images.value,
      is_public: form.is_public,
    };
    if (editId.value) {
      await api.shareUpdate(editId.value, payload);
      toast('修改已保存', 'success');
    } else {
      await api.shareCreate(payload);
      toast('发布成功', 'success');
    }
    setTimeout(() => uni.navigateBack(), 700);
  } finally {
    submitting.value = false;
  }
}
</script>

<style lang="scss" scoped>
.title-input { background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 14rpx; padding: 20rpx 22rpx; font-size: 30rpx; font-weight: 700; }
.content-area { width: 100%; box-sizing: border-box; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 14rpx; padding: 20rpx 22rpx; font-size: 27rpx; min-height: 320rpx; margin-top: 16rpx; line-height: 1.6; }
.f-label { font-size: 24rpx; color: #64748b; margin: 20rpx 4rpx 10rpx; }
.line-input { background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 14rpx; padding: 18rpx 22rpx; font-size: 27rpx; }
.tag-row { display: flex; flex-wrap: wrap; gap: 10rpx; margin-top: 12rpx; }
.att-grid { display: flex; flex-wrap: wrap; gap: 16rpx; }
.att-cell { position: relative; width: 200rpx; height: 200rpx; }
.att-img { width: 200rpx; height: 200rpx; border-radius: 14rpx; }
.att-del { position: absolute; top: -12rpx; right: -12rpx; width: 40rpx; height: 40rpx; border-radius: 50%; background: rgba(15,23,42,0.7); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 30rpx; }
.att-add { width: 200rpx; height: 200rpx; border: 2rpx dashed #cbd5e1; border-radius: 14rpx; display: flex; align-items: center; justify-content: center; font-size: 60rpx; color: #94a3b8; }
.switch-row { display: flex; justify-content: space-between; align-items: center; margin: 26rpx 0; }
.sw-title { font-size: 28rpx; font-weight: 700; color: #1e293b; display: block; }
.sw-desc { font-size: 22rpx; color: #94a3b8; }
</style>
