<script setup>
// 竞赛详情弹窗：4个Tab（基础信息 / 备赛流程 / 树状技术栈 / 参赛选择）
import { ref, computed, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api.js';
import TechTreeChart from './TechTreeChart.vue';

const props = defineProps({ open: Boolean, compId: Number });
const emit = defineEmits(['close']);

const comp = ref(null);
const loading = ref(false);
const activeTab = ref('info');
const selProcess = ref(null);
const joined = ref(null); // 加入日程的结果 { id, plan, note }
const joining = ref(false);

const TYPE_COLORS = {
  电子机器人: '#3b82f6', 机械: '#f59e0b', 综合: '#10b981', 数学基础: '#8b5cf6',
  设计艺术: '#ec4899', 经管商科: '#14b8a6', 医学技能: '#ef4444',
};
const colorOf = (t) => TYPE_COLORS[t] || '#64748b';

// 媒体平台元数据（学习资源 Tab）
const PLATFORM_META = {
  bilibili: { name: 'B站', icon: '📺', color: '#00a1d6' },
  zhihu: { name: '知乎', icon: '🧠', color: '#0084ff' },
  csdn: { name: 'CSDN', icon: '💻', color: '#cf0000' },
  wechat: { name: '微信公众号', icon: '📱', color: '#07c160' },
  douyin: { name: '抖音', icon: '🎵', color: '#3b3b3b' },
  cnki: { name: '知网', icon: '📚', color: '#0b4da2' },
  github: { name: 'GitHub', icon: '🐙', color: '#181717' },
  tencent: { name: '腾讯视频', icon: '🎬', color: '#ff7218' },
  robomaster: { name: 'RoboMaster', icon: '🤖', color: '#b08d00' },
  official: { name: '官网', icon: '🏛️', color: '#2563eb' },
};
const metaOf = (p) => PLATFORM_META[p] || { name: p, icon: '🔗', color: '#64748b' };

// 学习资源：按分类取 + knowledge 按子赛项/节点分组
const mediaByCat = (cat) => (comp.value?.media || []).filter((m) => m.category === cat);
const knowledgeGroups = computed(() => {
  const map = new Map();
  for (const m of comp.value?.media || []) {
    if (m.category !== 'knowledge') continue;
    const key = m.process_name || '其他';
    if (!map.has(key)) map.set(key, new Map());
    const nodeMap = map.get(key);
    if (!nodeMap.has(m.tech_node)) nodeMap.set(m.tech_node, []);
    nodeMap.get(m.tech_node).push(m);
  }
  return [...map.entries()].map(([processName, nodes]) => ({
    processName,
    nodes: [...nodes.entries()].map(([name, items]) => ({ name, items })),
  }));
});

watch(
  () => props.compId,
  async (id) => {
    if (!id) return;
    loading.value = true;
    joined.value = null;
    activeTab.value = 'info';
    try {
      comp.value = await api.competition(id);
      const firstWithTree = comp.value.process.find((p) => p.tech_stack?.length) || comp.value.process[0];
      selProcess.value = firstWithTree?.id ?? null;
    } catch (e) {
      ElMessage.error(`加载详情失败：${e.message}`);
    } finally {
      loading.value = false;
    }
  },
  { immediate: true }
);

const curProcess = computed(() => comp.value?.process.find((p) => p.id === selProcess.value) || null);
const processOptions = computed(() =>
  (comp.value?.process || []).map((p) => ({ id: p.id, label: p.phase_name, hasTree: !!p.tech_stack?.length }))
);

async function join() {
  joining.value = true;
  try {
    joined.value = await api.scheduleAdd(props.compId);
    ElMessage.success('✅ 备赛日程已保存，可在顶部「📋 我的备赛日程」查看');
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    joining.value = false;
  }
}
</script>

<template>
  <el-dialog
    :model-value="open" width="880px" destroy-on-close
    :title="comp?.name || '竞赛详情'"
    @update:model-value="(v) => !v && emit('close')"
  >
    <div v-loading="loading" class="comp-dialog">
      <template v-if="comp">
        <!-- AI 收录标记 -->
        <div v-if="comp.source_type !== 'official'" class="ai-notice">
          ⚠️ AI 收集信息，待核实 · 来源：
          <a v-if="comp.source_url" :href="comp.source_url" target="_blank">{{ comp.source_url }}</a>
          <span v-else>无来源链接</span>
        </div>

        <el-tabs v-model="activeTab">
          <!-- Tab1 基础信息 -->
          <el-tab-pane label="基础信息" name="info">
            <!-- 竞赛官网横幅 -->
            <a v-if="comp.official_url" class="official-banner" :href="comp.official_url" target="_blank">
              <span class="ob-icon">🏛️</span>
              <span class="ob-text">
                <b>竞赛官网</b>
                <em>{{ comp.official_url.replace(/^https?:\/\//, '').replace(/\/$/, '') }}</em>
              </span>
              <span class="ob-go">前往官网 ↗</span>
            </a>
            <div v-else class="official-missing">
              <span class="ob-icon">🏛️</span>
              <span>官网暂未收录 — 可在「🧠 AI 收录」页粘贴官方资料补充</span>
            </div>
            <el-descriptions :column="2" border>
              <el-descriptions-item label="全称">{{ comp.name }}</el-descriptions-item>
              <el-descriptions-item label="简称">{{ comp.short_name || '—' }}</el-descriptions-item>
              <el-descriptions-item label="赛道">
                <el-tag :style="{ background: colorOf(comp.type) + '1a', color: colorOf(comp.type), borderColor: colorOf(comp.type) + '55' }">
                  {{ comp.type }}
                </el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="难度">
                <span style="color:#f59e0b">{{ '★'.repeat(comp.difficulty || 0) }}</span>
                <span style="color:#e2e8f0">{{ '☆'.repeat(5 - (comp.difficulty || 0)) }}</span>
                <span v-if="comp.difficulty" style="margin-left:6px;color:#94a3b8">（{{ comp.difficulty }}/5）</span>
              </el-descriptions-item>
              <el-descriptions-item label="举办周期">{{ comp.cycle || '—' }}</el-descriptions-item>
              <el-descriptions-item label="组队">{{ comp.team || '—' }}</el-descriptions-item>
              <el-descriptions-item label="时间线">
                <span class="timeline-text">{{ comp.timeline_raw || '—' }}</span>
              </el-descriptions-item>
              <el-descriptions-item label="适合专业">{{ comp.suitable_major || '—' }}</el-descriptions-item>
              <el-descriptions-item label="数据状态">
                <el-tag size="small" :type="comp.status === 'pending' ? 'warning' : 'success'">
                  {{ comp.status === 'pending' ? '待审核' : '正式' }}
                </el-tag>
                <el-tag v-if="comp.source_type === 'ai_search'" size="small" type="warning" style="margin-left:6px">AI收录</el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="简介" :span="2">{{ comp.intro || '—' }}</el-descriptions-item>
            </el-descriptions>
          </el-tab-pane>

          <!-- Tab2 备赛流程 -->
          <el-tab-pane label="备赛流程" name="process">
            <el-timeline v-if="comp.process?.length">
              <el-timeline-item
                v-for="p in comp.process" :key="p.id"
                :timestamp="p.suggest_month ? `建议启动：${p.suggest_month}月` : '启动时间以官网为准'"
                placement="top"
              >
                <div class="phase">
                  <div class="phase-name">{{ p.phase_name }}</div>
                  <div v-if="p.phase_desc" class="phase-desc">{{ p.phase_desc }}</div>
                  <div v-if="p.check_standard" class="phase-check">✅ 达标要求：{{ p.check_standard }}</div>
                </div>
              </el-timeline-item>
            </el-timeline>
            <el-empty v-else description="暂无备赛流程数据" />
          </el-tab-pane>

          <!-- Tab3 树状技术栈 -->
          <el-tab-pane label="树状技术栈" name="stack">
            <div class="stack-toolbar">
              <span class="stack-label">选择子赛项：</span>
              <el-select v-model="selProcess" style="width: 380px" placeholder="选择子赛项查看技术栈">
                <el-option v-for="p in processOptions" :key="p.id" :value="p.id" :label="p.label" />
              </el-select>
            </div>
            <TechTreeChart v-if="curProcess" :process="curProcess" />
            <el-empty v-else description="该竞赛暂无技术栈数据" />
          </el-tab-pane>

          <!-- Tab4 学习资源（视频/文章，按分类 + 技术栈节点） -->
          <el-tab-pane label="🎬 学习资源" name="media">
            <el-empty v-if="!(comp.media || []).length" description="暂无学习资源数据" />
            <template v-else>
              <!-- 竞赛介绍 -->
              <div v-if="mediaByCat('intro').length" class="media-block">
                <h4 class="media-title">🎥 竞赛介绍 · 视频与文章</h4>
                <div class="plat-grid">
                  <a
                    v-for="m in mediaByCat('intro')" :key="m.id"
                    class="plat-card" :href="m.url" target="_blank"
                    :style="{ borderTopColor: metaOf(m.platform).color }"
                  >
                    <span class="p-icon">{{ metaOf(m.platform).icon }}</span>
                    <div class="p-info">
                      <b>{{ metaOf(m.platform).name }}</b>
                      <span class="p-kw">{{ m.title }}</span>
                    </div>
                    <span class="p-go">↗</span>
                    <span v-if="m.source_type === 'manual'" class="p-badge">已核实</span>
                  </a>
                </div>
              </div>

              <!-- 备赛流程 -->
              <div v-if="mediaByCat('process').length" class="media-block">
                <h4 class="media-title">🗓️ 备赛流程 · 视频与攻略</h4>
                <div class="plat-grid">
                  <a
                    v-for="m in mediaByCat('process')" :key="m.id"
                    class="plat-card" :href="m.url" target="_blank"
                    :style="{ borderTopColor: metaOf(m.platform).color }"
                  >
                    <span class="p-icon">{{ metaOf(m.platform).icon }}</span>
                    <div class="p-info">
                      <b>{{ metaOf(m.platform).name }}</b>
                      <span class="p-kw">{{ m.title }}</span>
                    </div>
                    <span class="p-go">↗</span>
                    <span v-if="m.source_type === 'manual'" class="p-badge">已核实</span>
                  </a>
                </div>
              </div>

              <!-- 知识点（按子赛项分组，联动技术栈） -->
              <div v-if="knowledgeGroups.length" class="media-block">
                <h4 class="media-title">📚 相关知识点视频 <span class="media-sub">（按备赛阶段/子赛项分组，源自技术栈）</span></h4>
                <el-collapse>
                  <el-collapse-item v-for="g in knowledgeGroups" :key="g.processName" :title="g.processName">
                    <div v-for="nd in g.nodes" :key="nd.name" class="kn-row">
                      <b class="kn-name">{{ nd.name }}</b>
                      <div class="kn-links">
                        <a
                          v-for="m in nd.items" :key="m.id"
                          class="kn-chip" :href="m.url" target="_blank"
                          :style="{ borderColor: metaOf(m.platform).color, color: metaOf(m.platform).color }"
                        >
                          {{ metaOf(m.platform).icon }} {{ metaOf(m.platform).name }}
                        </a>
                      </div>
                    </div>
                  </el-collapse-item>
                </el-collapse>
              </div>
            </template>
          </el-tab-pane>

          <!-- Tab5 参赛选择 -->
          <el-tab-pane label="参赛选择" name="join">
            <template v-if="!joined">
              <div class="join-intro">
                <p>确认要参加 <b>{{ comp.name }}</b> 吗？</p>
                <p class="join-tip">系统将结合当前日期自动生成个性化备赛计划：分月任务清单、每周学习时长、阶段达标指标、采购清单建议。</p>
              </div>
              <el-button type="primary" size="large" :loading="joining" @click="join">➕ 加入我的备赛日程</el-button>
            </template>
            <template v-else>
              <div class="plan-head">
                <h3>📋 {{ comp.short_name || comp.name }} 备赛计划</h3>
                <div>
                  <el-button size="small" type="primary" plain tag="a" :href="api.scheduleExportUrl(joined.id)" target="_blank">
                    导出 Markdown
                  </el-button>
                </div>
              </div>
              <el-alert v-if="joined.note" :title="joined.note" type="info" :closable="false" style="margin-bottom:10px" />
              <div v-for="(ph, i) in (joined.plan.phases || [])" :key="i" class="phase plan-phase">
                <div class="phase-name">阶段{{ i + 1 }}：{{ ph.phase || ph.阶段名称 }}</div>
                <div v-if="ph.date" class="phase-date">🗓️ {{ ph.date }}</div>
                <ul class="task-list">
                  <li v-for="(t, j) in (ph.tasks || ph.任务清单 || [])" :key="j">☐ {{ typeof t === 'string' ? t : t.text }}</li>
                </ul>
                <div v-if="ph.check_standard || ph.达标要求" class="phase-check">
                  ✅ 达标要求：{{ ph.check_standard || ph.达标要求 }}
                </div>
                <div v-if="ph.week_hours" class="phase-week">
                  🕐 每周最低学习时长：{{ ph.week_hours }} 小时
                </div>
              </div>
              <el-button size="small" @click="joined = null">重新生成</el-button>
            </template>
          </el-tab-pane>
        </el-tabs>
      </template>
    </div>
  </el-dialog>
</template>

<style lang="scss" scoped>
.comp-dialog { min-height: 320px; }

.ai-notice {
  background: #fef3c7; color: #92400e; border: 1px solid #fde68a;
  border-radius: 8px; padding: 8px 12px; margin-bottom: 12px; font-size: 13px;
  a { color: #92400e; word-break: break-all; }
}

.timeline-text { white-space: normal; }

// 官网横幅
.official-banner {
  display: flex; align-items: center; gap: 12px; text-decoration: none;
  background: linear-gradient(135deg, #2563eb, #1d4ed8);
  color: #fff; border-radius: 10px; padding: 12px 16px; margin-bottom: 14px;
  box-shadow: 0 4px 14px rgba(37, 99, 235, .25);
  transition: transform .2s, box-shadow .2s;
  &:hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(37, 99, 235, .35); }
  .ob-icon { font-size: 24px; }
  .ob-text { flex: 1; min-width: 0;
    b { display: block; font-size: 15px; }
    em { font-style: normal; font-size: 12.5px; opacity: .85; word-break: break-all; }
  }
  .ob-go {
    font-size: 13px; font-weight: 600; white-space: nowrap;
    background: rgba(255, 255, 255, .18); border: 1px solid rgba(255, 255, 255, .35);
    border-radius: 999px; padding: 5px 14px;
  }
}
.official-missing {
  display: flex; align-items: center; gap: 8px;
  background: #f1f5f9; border: 1px dashed #cbd5e1; color: #94a3b8;
  border-radius: 10px; padding: 10px 14px; margin-bottom: 14px; font-size: 13px;
}

.phase {
  background: #f8fafc; border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px;
  .phase-name { font-weight: 600; margin-bottom: 4px; }
  .phase-desc { color: var(--text-2); font-size: 13px; line-height: 1.6; white-space: normal; }
  .phase-check { margin-top: 6px; color: #047857; font-size: 13px; }
  &.plan-phase { margin-bottom: 10px; .task-list { margin: 6px 0; padding-left: 18px; color: var(--text-2); li { line-height: 1.7; } } }
}

.stack-toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.stack-label { color: var(--text-2); font-size: 13px; }

.join-intro { margin-bottom: 16px; p { margin: 6px 0; } .join-tip { color: var(--text-2); font-size: 13px; } }

// 学习资源
.media-block { margin-bottom: 16px;
  .media-title { margin: 0 0 10px; font-size: 14px;
    .media-sub { font-size: 12px; color: var(--text-2); font-weight: 400; }
  }
}
.plat-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(185px, 1fr)); gap: 8px;
  .plat-card {
    display: flex; align-items: center; gap: 8px; text-decoration: none; color: var(--text);
    background: #f8fafc; border: 1px solid var(--border); border-top: 3px solid #64748b;
    border-radius: 8px; padding: 8px 10px; position: relative; transition: all .2s;
    &:hover { background: #f1f5f9; transform: translateY(-2px); box-shadow: 0 4px 10px rgba(0,0,0,.08); }
    .p-icon { font-size: 18px; }
    .p-info { flex: 1; min-width: 0; b { display: block; font-size: 13px; }
      .p-kw { font-size: 11.5px; color: var(--text-2); display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    }
    .p-go { color: #94a3b8; font-size: 13px; }
    .p-badge {
      position: absolute; top: -7px; right: -5px; font-size: 10px; color: #fff;
      background: #16a34a; border-radius: 4px; padding: 1px 5px;
    }
  }
}
.kn-row {
  display: flex; align-items: center; gap: 10px; padding: 7px 4px; flex-wrap: wrap;
  border-bottom: 1px dashed var(--border);
  &:last-child { border-bottom: none; }
  .kn-name { min-width: 130px; font-size: 13px; }
  .kn-links { display: flex; gap: 6px; flex-wrap: wrap;
    .kn-chip {
      font-size: 12px; text-decoration: none; border: 1px solid; border-radius: 999px;
      padding: 2px 10px; background: #fff; transition: all .2s;
      &:hover { background: #f1f5f9; }
    }
  }
}
.plan-head { display: flex; justify-content: space-between; align-items: center; h3 { margin: 0 0 10px; } }
.phase-week { margin-top: 4px; color: #1d4ed8; font-size: 13px; }
.phase-date { margin-top: 4px; color: var(--text-2); font-size: 13px; }
</style>
