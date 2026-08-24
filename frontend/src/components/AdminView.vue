<script setup>
// AI 收录管理端：待审核列表（采纳/拒绝/查看）+ 未知竞赛 AI 收录表单
import { ref, reactive, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api.js';
import CompDialog from './CompDialog.vue';

const tab = ref('pending');
const pendingList = ref([]);
const loading = ref(false);

// ---- 待审核列表 ----
async function loadPending() {
  loading.value = true;
  try {
    pendingList.value = await api.pending();
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}

async function verify(c) {
  try {
    await api.verifyCompetition(c.id);
    ElMessage.success(`「${c.name}」已采纳转正，将出现在时间轴上`);
    loadPending();
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function reject(c) {
  try {
    await ElMessageBox.confirm(`拒绝收录「${c.name}」？将从系统删除。`, '确认拒绝', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await api.deleteCompetition(c.id);
    ElMessage.success('已拒绝并删除');
    loadPending();
  } catch (e) {
    ElMessage.error(e.message);
  }
}

// ---- AI 收录表单 ----
const material = ref('');
const extracting = ref(false);
const submitted = ref(false);
const card = reactive({
  name: '', short_name: '', type: '', start_month: null, sign_start: '',
  sign_end: '', province_time: '', national_time: '', cycle: '',
  difficulty: null, intro: '', suitable_major: '', team: '', source_url: '',
  confidence: null, data_year: null,
});
const SUBMIT_FIELDS = [
  'name', 'short_name', 'type', 'start_month', 'sign_start', 'sign_end',
  'province_time', 'national_time', 'cycle', 'difficulty', 'intro',
  'suitable_major', 'team', 'source_url', 'confidence', 'data_year',
];

async function extract() {
  if (material.value.trim().length < 20) {
    ElMessage.warning('请粘贴官方通知/官网/资料正文，至少 20 字');
    return;
  }
  extracting.value = true;
  submitted.value = false;
  try {
    const r = await api.extract(material.value);
    Object.assign(card, {
      name: r.name || '', short_name: r.short_name || '', type: r.type || '',
      start_month: r.start_month || null, sign_start: r.sign_start || '',
      sign_end: r.sign_end || '', province_time: r.province_time || '',
      national_time: r.national_time || '', cycle: r.cycle || '',
      difficulty: r.difficulty || null, intro: r.intro || '',
      suitable_major: r.suitable_major || '', team: r.team || '',
      source_url: r.source_url || '', confidence: r.confidence || null,
      data_year: r.data_year || null,
    });
    ElMessage.success(`AI 已提炼卡片（置信度 ${r.confidence ?? '未知'}），请核对后补 source_url`);
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    extracting.value = false;
  }
}

async function submit() {
  if (!card.name.trim()) return ElMessage.warning('name（竞赛名称）必填');
  if (!card.source_url.trim()) return ElMessage.warning('必须提供 source_url（官方来源链接），系统拒绝无来源的收录');
  const body = {};
  for (const k of SUBMIT_FIELDS) {
    if (card[k] !== null && card[k] !== '' && card[k] !== undefined) body[k] = card[k];
  }
  try {
    const r = await api.addCompetition(body);
    submitted.value = true;
    ElMessage.success(`已入库待审核（id=${r.id}），可在上方「待审核」列表采纳转正`);
    loadPending();
  } catch (e) {
    ElMessage.error(e.message);
  }
}

function resetForm() {
  Object.assign(card, {
    name: '', short_name: '', type: '', start_month: null, sign_start: '',
    sign_end: '', province_time: '', national_time: '', cycle: '',
    difficulty: null, intro: '', suitable_major: '', team: '', source_url: '',
    confidence: null, data_year: null,
  });
  material.value = '';
  submitted.value = false;
}

// ---- 详情弹窗 ----
const dialogOpen = ref(false);
const currentId = ref(null);
function openDetail(c) {
  currentId.value = c.id;
  dialogOpen.value = true;
}

const difficultyStars = (d) => (d ? '★'.repeat(Math.min(d, 5)) : '—');

onMounted(loadPending);
</script>

<template>
  <main class="admin-page">
    <div class="page-head">
      <h2>🧠 AI 收录管理端</h2>
      <p class="sub">未知竞赛知识增长引擎：用户问库外竞赛 → AI 提炼资料 → 待审核 → 人工采纳转正</p>
    </div>

    <el-tabs v-model="tab">
      <!-- ========== Tab1 待审核列表 ========== -->
      <el-tab-pane label="待审核" name="pending">
        <div class="toolbar">
          <span class="count">共 {{ pendingList.length }} 条待审核</span>
          <el-button size="small" :loading="loading" @click="loadPending">刷新</el-button>
        </div>

        <el-empty v-if="!loading && !pendingList.length" description="暂无待审核竞赛，可在「AI 收录」页录入新竞赛" />

        <div v-loading="loading" class="pending-list">
          <div v-for="c in pendingList" :key="c.id" class="p-card">
            <div class="p-main">
              <div class="p-title">
                <b>{{ c.name }}</b>
                <el-tag v-if="c.short_name" size="small" style="margin-left:8px">{{ c.short_name }}</el-tag>
                <el-tag size="small" type="warning" style="margin-left:6px">待审核</el-tag>
              </div>
              <div class="p-meta">
                <span>赛道：{{ c.type }}</span>
                <span>难度：{{ difficultyStars(c.difficulty) }}</span>
                <span v-if="c.confidence">AI置信度：{{ c.confidence }}</span>
                <span>录入：{{ c.create_time }}</span>
              </div>
              <div v-if="c.source_url" class="p-src">
                🔗 来源：
                <a :href="c.source_url" target="_blank">{{ c.source_url }}</a>
              </div>
              <div v-else class="p-src warn">⚠️ 无来源链接（不应存在，正常流程已拦截）</div>
            </div>
            <div class="p-actions">
              <el-button size="small" @click="openDetail(c)">查看详情</el-button>
              <el-button size="small" type="success" @click="verify(c)">✅ 采纳转正</el-button>
              <el-button size="small" type="danger" plain @click="reject(c)">拒绝</el-button>
            </div>
          </div>
        </div>
      </el-tab-pane>

      <!-- ========== Tab2 AI 收录 ========== -->
      <el-tab-pane label="AI 收录" name="ingest">
        <div class="ingest">
          <div class="ingest-step">
            <h4>① 粘贴资料（官方通知 / 官网简介 / 往届公告，≥20 字）</h4>
            <el-input
              v-model="material" type="textarea" :rows="5"
              placeholder="例：关于举办2026年全国大学生嵌入式芯片与系统设计竞赛的通知：本届大赛由中国电子学会主办……报名时间2026年3月1日至4月15日……"
            />
            <div class="step-actions">
              <el-button type="primary" :loading="extracting" @click="extract">🤖 AI 提炼竞赛卡片</el-button>
            </div>
          </div>

          <div class="ingest-step" v-if="card.name || extracting">
            <h4>② 核对并补全信息（AI 提取结果可编辑）</h4>
            <el-form label-width="110px" label-position="left" class="card-form">
              <div class="form-row">
                <el-form-item label="竞赛名称 *"><el-input v-model="card.name" /></el-form-item>
                <el-form-item label="简称"><el-input v-model="card.short_name" /></el-form-item>
              </div>
              <div class="form-row">
                <el-form-item label="赛道"><el-input v-model="card.type" placeholder="电子机器人/机械/综合…" /></el-form-item>
                <el-form-item label="难度(1-5)">
                  <el-select v-model="card.difficulty" placeholder="选择" clearable style="width:100%">
                    <el-option v-for="i in 5" :key="i" :label="'★'.repeat(i)" :value="i" />
                  </el-select>
                </el-form-item>
                <el-form-item label="建议启动月">
                  <el-select v-model="card.start_month" placeholder="选择" clearable style="width:100%">
                    <el-option v-for="m in 12" :key="m" :label="`${m}月`" :value="m" />
                  </el-select>
                </el-form-item>
              </div>
              <div class="form-row">
                <el-form-item label="报名起"><el-input v-model="card.sign_start" placeholder="2026-03-01" /></el-form-item>
                <el-form-item label="报名止"><el-input v-model="card.sign_end" placeholder="2026-04-15" /></el-form-item>
                <el-form-item label="省赛/校赛"><el-input v-model="card.province_time" /></el-form-item>
                <el-form-item label="国赛/决赛"><el-input v-model="card.national_time" /></el-form-item>
              </div>
              <div class="form-row">
                <el-form-item label="举办周期"><el-input v-model="card.cycle" placeholder="每年一届/两年一届" /></el-form-item>
                <el-form-item label="组队"><el-input v-model="card.team" placeholder="3人/队" /></el-form-item>
                <el-form-item label="适合专业"><el-input v-model="card.suitable_major" /></el-form-item>
              </div>
              <el-form-item label="来源链接 *">
                <el-input v-model="card.source_url" placeholder="https://xxx.edu.cn/notice/… （官方来源，必填）" />
              </el-form-item>
              <el-form-item label="简介">
                <el-input v-model="card.intro" type="textarea" :rows="3" />
              </el-form-item>
              <div class="ai-tags">
                <el-tag v-if="card.confidence" type="info" size="small">AI 置信度：{{ card.confidence }}</el-tag>
                <el-tag v-if="card.data_year" type="info" size="small">数据年份：{{ card.data_year }}</el-tag>
              </div>
            </el-form>
            <div class="step-actions">
              <el-button type="primary" @click="submit">📥 提交入库（待审核）</el-button>
              <el-button @click="resetForm">清空重来</el-button>
            </div>
            <el-alert
              v-if="submitted" type="success" :closable="false" style="margin-top:10px"
              title="已入库待审核！切换到「待审核」列表可采纳转正"
            />
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>

    <CompDialog :open="dialogOpen" :comp-id="currentId" @close="dialogOpen = false" />
  </main>
</template>

<style lang="scss" scoped>
.admin-page { padding: 12px 20px 80px; max-width: 1100px; }

.page-head {
  h2 { margin: 0 0 4px; font-size: 20px; }
  .sub { color: var(--text-2); font-size: 13px; margin: 0 0 10px; }
}

.toolbar {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;
  .count { color: var(--text-2); font-size: 13px; }
}

.pending-list { display: flex; flex-direction: column; gap: 10px; }

.p-card {
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px;
  padding: 12px 14px; display: flex; align-items: center; justify-content: space-between;
  gap: 12px; flex-wrap: wrap;
  .p-main { flex: 1; min-width: 320px; }
  .p-title { display: flex; align-items: center; flex-wrap: wrap; b { font-size: 15px; } }
  .p-meta { display: flex; gap: 14px; color: var(--text-2); font-size: 12.5px; margin-top: 5px; flex-wrap: wrap; }
  .p-src {
    margin-top: 5px; font-size: 12.5px; color: var(--text-2);
    a { color: #1d4ed8; word-break: break-all; }
    &.warn { color: #b45309; }
  }
  .p-actions { display: flex; gap: 6px; }
}

.ingest {
  max-width: 860px;
  .ingest-step {
    background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px;
    padding: 14px 16px; margin-bottom: 14px;
    h4 { margin: 0 0 10px; font-size: 14px; }
    .step-actions { margin-top: 10px; }
  }
  .form-row { display: flex; gap: 12px; flex-wrap: wrap; .el-form-item { flex: 1; min-width: 180px; } }
  .ai-tags { display: flex; gap: 8px; margin-bottom: 10px; }
}
</style>
