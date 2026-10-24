<template>
  <div class="pv-wrap lab-admin-wrap">
    <!-- 页头 -->
    <div class="pv-hero card">
      <div>
        <h2>🗂️ 借用记录管理 <el-tag size="small" type="danger" effect="light">仅借用记录管理员</el-tag></h2>
        <p class="sub2">全部项目、全部学生的设备借用、教室借用登记汇总在这里：按类型/状态/日期/关键字筛选，点缩略图看原图，一键导出 Excel 表格。</p>
      </div>
      <el-button type="primary" :loading="exporting" @click="doExport">
        {{ exporting ? '导出中…' : '⬇️ 导出借用记录表格' }}
      </el-button>
    </div>

    <!-- 全局统计（不受下方筛选影响） -->
    <div class="stat-cards rec-stats">
      <div class="stat-card primary">
        <span class="sc-label">累计登记</span>
        <b class="sc-num">{{ stats.total }}</b><span class="sc-unit">条</span>
      </div>
      <div class="stat-card warn">
        <span class="sc-label">今日登记</span>
        <b class="sc-num">{{ stats.today }}</b><span class="sc-unit">条</span>
      </div>
      <div class="stat-card ok">
        <span class="sc-label">设备借用</span>
        <b class="sc-num">{{ stats.device }}</b><span class="sc-unit">条</span>
      </div>
      <div class="stat-card ok">
        <span class="sc-label">教室借用</span>
        <b class="sc-num">{{ stats.room }}</b><span class="sc-unit">条</span>
      </div>
      <div class="stat-card">
        <span class="sc-label">涉及学生</span>
        <b class="sc-num">{{ stats.people }}</b><span class="sc-unit">人</span>
      </div>
    </div>

    <!-- 筛选 -->
    <div class="card">
      <div class="filter-bar">
        <el-select v-model="f.kind" placeholder="全部类型" clearable style="width: 128px" @change="load">
          <el-option value="device" label="📦 设备借用" />
          <el-option value="room" label="🏫 教室借用" />
        </el-select>
        <el-select v-model="f.status" placeholder="全部状态" clearable style="width: 118px" @change="load">
          <el-option v-for="(m, k) in STATUS_META" :key="k" :value="k" :label="m.label" />
        </el-select>
        <el-date-picker v-model="range" type="daterange" range-separator="至" start-placeholder="开始日期"
          end-placeholder="结束日期" value-format="YYYY-MM-DD" style="width: 250px" @change="load" />
        <el-input v-model="f.q" placeholder="物品 / 教室 / 姓名 / 学号" clearable style="width: 210px"
          @keyup.enter="load" @clear="load" />
        <el-button @click="load">查询</el-button>
        <el-button @click="resetFilter">重置</el-button>
        <span class="spacer"></span>
        <span class="dim">筛选结果 {{ matched }} 条</span>
      </div>

      <div v-loading="loading">
        <!-- 宽屏表格 -->
        <div class="table-scroll rec-table-wrap">
          <table v-if="records.length" class="rq-table">
            <thead>
              <tr>
                <th>照片</th><th>所属项目</th><th>类型</th><th>借用物品 / 教室</th><th>姓名</th><th>学号</th>
                <th>登记时间</th><th>状态</th><th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="b in records" :key="b.id">
                <td>
                  <img v-if="b.item_thumb" :src="b.item_thumb" class="rec-thumb" alt="借用照片" @click="viewPhoto(b)" />
                  <span v-else class="rec-thumb ph">{{ b.has_image ? '📷' : '—' }}</span>
                </td>
                <td class="dim">{{ b.project_name || '—' }}</td>
                <td>{{ kindLabel(b.kind) }}</td>
                <td><b>{{ b.item_name || '—' }}</b></td>
                <td>{{ b.booker_name || '—' }}</td>
                <td class="dim">{{ b.booker_student_no || '未填' }}</td>
                <td class="dim">{{ b.start_time }}</td>
                <td>
                  <el-tag :type="STATUS_META[b.status]?.type || 'info'" size="small">
                    {{ STATUS_META[b.status]?.label || b.status }}
                  </el-tag>
                </td>
                <td>
                  <el-button v-if="b.has_image" link type="primary" size="small" @click="viewPhoto(b)">查看照片</el-button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 窄屏卡片 -->
        <div class="rec-cards">
          <div v-for="b in records" :key="b.id" class="rec-card">
            <img v-if="b.item_thumb" :src="b.item_thumb" class="rec-card-thumb" alt="借用照片" @click="viewPhoto(b)" />
            <span v-else class="rec-card-thumb ph">{{ b.kind === 'room' ? '🏫' : '📦' }}</span>
            <div class="rec-card-main">
              <div class="rc-line">
                <b>{{ b.item_name || '—' }}</b>
                <el-tag :type="STATUS_META[b.status]?.type || 'info'" size="small">
                  {{ STATUS_META[b.status]?.label || b.status }}
                </el-tag>
              </div>
              <div class="rc-sub">{{ kindLabel(b.kind) }} · {{ b.booker_name || '—' }} {{ b.booker_student_no || '未填学号' }}</div>
              <div class="rc-sub">{{ b.project_name || '—' }} · 登记于 {{ b.start_time }}</div>
            </div>
          </div>
        </div>

        <div v-if="!records.length && !loading" class="empty-wrap">
          <el-empty description="没有符合条件的借用记录" :image-size="80" />
        </div>
      </div>

      <p v-if="matched > records.length" class="rec-note">
        共 {{ matched }} 条，页面只显示最近 {{ records.length }} 条；导出会包含当前筛选下的全部记录（上限 5000 条）。
      </p>
      <p class="rec-note">照片不写进表格（原图较大），需要时点缩略图查看。</p>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../../api.js';
import { STATUS_META } from '../../utils/booking.js';
import { openImage } from '../../utils/imageViewer.js';

const loading = ref(false);
const exporting = ref(false);
const records = ref([]);
const matched = ref(0);
const stats = reactive({ total: 0, today: 0, device: 0, room: 0, people: 0 });
const f = reactive({ kind: '', status: '', q: '' });
const range = ref(null);

const kindLabel = (k) => (k === 'room' ? '🏫 教室' : '📦 设备');

function params() {
  const p = {};
  if (f.kind) p.kind = f.kind;
  if (f.status) p.status = f.status;
  if (f.q.trim()) p.q = f.q.trim();
  if (range.value?.length === 2) { p.from = range.value[0]; p.to = range.value[1]; }
  return p;
}

async function load() {
  loading.value = true;
  try {
    const d = await api.bookingBorrowRecords(params());
    records.value = d.records || [];
    matched.value = d.matched || 0;
    Object.assign(stats, d.stats || {});
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}

function resetFilter() {
  f.kind = '';
  f.status = '';
  f.q = '';
  range.value = null;
  load();
}

async function doExport() {
  exporting.value = true;
  try {
    const { blob, name } = await api.bookingBorrowExport(params());
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    ElMessage.success('已导出 Excel');
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    exporting.value = false;
  }
}

// 列表只带缩略图；点开单条再取原图（避免几十 MB 的 dataURL 一次传下来）
async function viewPhoto(b) {
  if (!b.has_image) return ElMessage.info('这条登记没有照片');
  try {
    const { booking } = await api.bookingDetail(b.id);
    if (booking?.item_image) openImage(booking.item_image, b.item_name || '借用照片');
    else ElMessage.info('这条登记没有照片');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

onMounted(load);
</script>

<style lang="scss" scoped>
.lab-admin-wrap { padding-bottom: 30px; }

// 5 张统计卡：默认 4 列会把第 5 张甩到下一行
.rec-stats { grid-template-columns: repeat(5, 1fr); }

.rec-table-wrap { display: block; }
.rec-cards { display: none; }

.rec-thumb {
  width: 38px;
  height: 38px;
  border-radius: 8px;
  object-fit: cover;
  border: 1px solid var(--border);
  cursor: zoom-in;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  &.ph { cursor: default; background: var(--surface-2); color: var(--text-3); font-size: 15px; }
}

.rec-card {
  display: flex;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
  &:last-child { border-bottom: 0; }
}
.rec-card-thumb {
  width: 54px;
  height: 54px;
  flex: none;
  border-radius: 10px;
  object-fit: cover;
  border: 1px solid var(--border);
  cursor: zoom-in;
  &.ph {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--surface-2);
    font-size: 20px;
    cursor: default;
  }
}
.rec-card-main { min-width: 0; flex: 1; }
.rc-line { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 14px; }
.rc-sub { font-size: 12.5px; color: var(--text-2); margin-top: 3px; }

.rec-note { margin: 8px 0 0; font-size: 11.5px; color: var(--text-3); }

@media (max-width: 768px) {
  .rec-stats { grid-template-columns: repeat(2, 1fr); }
  .rec-table-wrap { display: none; }
  .rec-cards { display: block; }
  .filter-bar :deep(.el-date-editor) { width: 100% !important; }
  .filter-bar :deep(.el-input), .filter-bar :deep(.el-select) { width: 100% !important; }
}
</style>
