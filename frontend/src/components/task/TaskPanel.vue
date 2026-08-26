<script setup>
// 任务详情面板：点击计划子任务展开——①完成+评星 ②暂存网页链接 ③AI 拆解任务+智能推荐资源
// 面板只发事件不写数据：数据写入与保存由父级各自链路完成（个人计划全量保存 / 小组计划单项接口）
import { ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../../api.js';
import auth from '../../auth.js';

const props = defineProps({
  task: { type: Object, required: true },
  // 完成开关/评星/链接增删的可编辑性：个人恒 true；小组 = canCheck（组长/通用/本部门）
  canCheck: { type: Boolean, default: true },
  // AI 拆分「一键应用」可用性：小组 = 组长（canEditPlan）
  canSplit: { type: Boolean, default: true },
  // 任务类型（一次/多次）与目标次数设定权：个人恒 true；小组 = 组长（canEditPlan）
  canEditMode: { type: Boolean, default: true },
});
// complete=完成一次；undo(i)=撤销第 i 条记录（仅本人记录或组长可点）；update:mode/update:target=类型/目标次数设定
const emit = defineEmits(['toggle-done', 'update:stars', 'update:links', 'split', 'complete', 'undo', 'update:mode', 'update:target']);

// 平台元数据（与 StudyView/CompDialog 学习资源一致，代码库既有「各组件自带一份」先例）
const PLATFORM_META = {
  bilibili: { name: 'B站', icon: '📺', color: '#00a1d6' },
  zhihu: { name: '知乎', icon: '🧠', color: '#0084ff' },
  csdn: { name: 'CSDN', icon: '💻', color: '#cf0000' },
  wechat: { name: '微信公众号', icon: '📱', color: '#07c160' },
  douyin: { name: '抖音', icon: '🎵', color: '#3b3b3b' },
  cnki: { name: '知网', icon: '📚', color: '#0b4da2' },
  github: { name: 'GitHub', icon: '🐙', color: '#181717' },
  tencent: { name: '腾讯视频', icon: '🎬', color: '#ff7218' },
};
const metaOf = (p) => PLATFORM_META[p] || { name: p, icon: '🔗', color: '#64748b' };

// ---- 暂存链接：URL 必填校验（http/https，双保险：后端同样清洗）、标题选填、去重 ----
const linkUrl = ref('');
const linkTitle = ref('');
function addLink() {
  const url = linkUrl.value.trim();
  if (!url) return ElMessage.warning('请输入网页链接');
  let ok = false;
  try { ok = ['http:', 'https:'].includes(new URL(url).protocol); } catch { ok = false; }
  if (!ok) return ElMessage.warning('请输入 http(s) 开头的链接');
  if ((props.task.links || []).some((l) => l.url === url)) return ElMessage.warning('该链接已存在');
  const title = linkTitle.value.trim() || null;
  emit('update:links', [...(props.task.links || []), { url, title }]);
  linkUrl.value = '';
  linkTitle.value = '';
}
function removeLink(i) {
  emit('update:links', (props.task.links || []).filter((_, k) => k !== i));
}
const hostOf = (l) => {
  try { return l.title || new URL(l.url).hostname.replace(/^www\./, ''); } catch { return l.url; }
};

// ---- AI 拆解：一次调用返回 subtasks + keywords → resources（平台搜索链接，无幻觉） ----
const aiLoading = ref(false);
const aiResult = ref(null); // { subtasks, keywords, resources, degraded, hint? }
const aiError = ref('');
async function runAssist() {
  const text = props.task.text;
  if (!text) return ElMessage.warning('任务文本为空，无法拆解');
  aiLoading.value = true;
  aiError.value = '';
  try {
    const res = await api.taskAssist(text);
    aiResult.value = res;
  } catch (e) {
    aiError.value = e.message;
  } finally {
    aiLoading.value = false;
  }
}
async function applySplit() {
  const subs = aiResult.value?.subtasks || [];
  if (!subs.length) return;
  try {
    await ElMessageBox.confirm(
      `将「${props.task.text}」替换为 ${subs.length} 个子任务？原任务的完成状态将重置`,
      '应用拆分', { type: 'warning', confirmButtonText: '应用拆分' }
    );
  } catch { return; }
  emit('split', subs);
}
</script>

<template>
  <div class="tp-panel" @click.stop>
    <!-- ① 完成 + 评星 -->
    <div class="tp-sec">
      <div class="tp-sec-head">
        <span class="tp-sec-title">✅ 完成与评价</span>
      </div>
      <!-- 任务类型：一次任务 / 多次任务（个人恒可设；小组仅组长可设） -->
      <div v-if="canEditMode" class="tp-mode-row">
        <el-radio-group :model-value="task.mode === 'multi' ? 'multi' : 'once'" size="small" @change="emit('update:mode', $event)">
          <el-radio-button value="once">一次任务</el-radio-button>
          <el-radio-button value="multi">多次任务</el-radio-button>
        </el-radio-group>
        <template v-if="task.mode === 'multi'">
          <span class="tp-tip2">达标次数</span>
          <el-input-number :model-value="task.target ?? 3" :min="1" :max="100" size="small" style="width: 100px"
            @change="emit('update:target', $event)" />
        </template>
      </div>
      <!-- 一次任务：勾选 + 评星 -->
      <template v-if="task.mode !== 'multi'">
        <div class="tp-done-row">
          <el-checkbox :model-value="!!task.done" :disabled="!canCheck" @change="emit('toggle-done')">
            {{ task.done ? '已完成' : '未完成' }}
          </el-checkbox>
          <el-rate
            :model-value="task.stars ?? 0" size="small" clearable
            :disabled="!task.done || !canCheck"
            @change="emit('update:stars', $event || null)"
          />
          <span v-if="!task.done" class="tp-tip2">完成任务后可评星</span>
          <span v-else-if="task.stars" class="tp-tip2">已评 {{ task.stars }} 星</span>
        </div>
      </template>
      <!-- 多次任务：完成一次 + 完成记录 + 达标评星 -->
      <template v-else>
        <div class="tp-multi-bar">
          <span class="tp-count" :class="{ ok: task.done }">×{{ (task.completions || []).length }}/{{ task.target || 3 }}</span>
          <span v-if="task.done" class="tp-done-badge">✅ 已达标</span>
          <span v-else class="tp-tip2">完成 {{ (task.target || 3) - (task.completions || []).length }} 次即可达标</span>
          <el-button size="small" type="success" :disabled="!canCheck" @click="emit('complete')">✅ 完成一次</el-button>
        </div>
        <div v-if="task.done" class="tp-done-row">
          <el-rate
            :model-value="task.stars ?? 0" size="small" clearable
            :disabled="!canCheck"
            @change="emit('update:stars', $event || null)"
          />
          <span v-if="task.stars" class="tp-tip2">已评 {{ task.stars }} 星</span>
        </div>
        <div v-if="(task.completions || []).length" class="tp-recs">
          <div v-for="(c, i) in task.completions" :key="i" class="tp-rec">
            <span class="tp-rec-i">#{{ i + 1 }}</span>
            <span class="tp-rec-by">👤 {{ c.by }}</span>
            <span class="tp-rec-at">📅 {{ c.at }}</span>
            <el-button v-if="canCheck && (Number(c.uid) === Number(auth.user?.id) || canEditMode)"
              size="small" text type="danger" @click="emit('undo', i)">✕</el-button>
          </div>
        </div>
        <div v-else class="tp-empty">暂无完成记录</div>
      </template>
    </div>

    <!-- ② 暂存网页链接 -->
    <div class="tp-sec">
      <div class="tp-sec-head">
        <span class="tp-sec-title">🔗 暂存网页链接</span>
        <span class="tp-tip2">点击可跳转，方便回看资料</span>
      </div>
      <div v-if="canCheck" class="tp-link-form">
        <el-input v-model="linkUrl" size="small" placeholder="https://…" @keyup.enter="addLink" />
        <el-input v-model="linkTitle" size="small" placeholder="标题（选填）" @keyup.enter="addLink" />
        <el-button size="small" type="primary" @click="addLink">添加</el-button>
      </div>
      <div v-if="(task.links || []).length" class="tp-link-list">
        <div v-for="(l, i) in task.links" :key="i" class="tp-link">
          <a :href="l.url" target="_blank" rel="noopener" class="tp-link-a">🔗 {{ hostOf(l) }}</a>
          <el-button v-if="canCheck" size="small" text type="danger" @click="removeLink(i)">✕</el-button>
        </div>
      </div>
      <div v-else class="tp-empty">暂未添加链接</div>
    </div>

    <!-- ③ AI 拆解任务 + 推荐资源 -->
    <div class="tp-sec">
      <div class="tp-sec-head">
        <span class="tp-sec-title">🤖 AI 拆解任务</span>
        <span class="tp-tip2">拆成可执行子任务 + 推荐各平台学习资源</span>
      </div>
      <el-button size="small" type="success" plain :loading="aiLoading" :disabled="!task.text" @click="runAssist">
        {{ aiResult ? '🔄 重新生成' : '🤖 AI 拆解 + 推荐资源' }}
      </el-button>

      <el-alert v-if="aiResult?.hint" type="warning" :closable="false" class="tp-hint" :title="aiResult.hint" />
      <div v-if="aiError" class="tp-err">{{ aiError }}</div>

      <template v-if="aiResult">
        <!-- 子任务预览 -->
        <div class="tp-ai-block">
          <div class="tp-ai-label">📋 拆分为 {{ aiResult.subtasks.length }} 个子任务（应用后替换原任务）</div>
          <ol class="tp-subs">
            <li v-for="(s, i) in aiResult.subtasks" :key="i">{{ s }}</li>
          </ol>
          <el-button v-if="canSplit" size="small" type="success" @click="applySplit">✅ 一键应用拆分</el-button>
          <span v-else class="tp-tip2">仅组长可应用拆分</span>
        </div>
        <!-- 细分关键词 -->
        <div v-if="aiResult.keywords?.length" class="tp-ai-block">
          <div class="tp-ai-label">🔑 细分关键词</div>
          <el-tag v-for="(k, i) in aiResult.keywords" :key="i" size="small" effect="plain" class="tp-kw">{{ k }}</el-tag>
        </div>
        <!-- 推荐资源（平台搜索链接） -->
        <div v-if="aiResult.resources?.length" class="tp-ai-block">
          <div class="tp-ai-label">📚 推荐资源（平台内搜索链接）</div>
          <div class="tp-res">
            <a v-for="(x, i) in aiResult.resources" :key="i" :href="x.url" target="_blank" rel="noopener" class="tp-res-a">
              <span class="tp-res-icon" :style="{ background: metaOf(x.platform).color }">{{ metaOf(x.platform).icon }}</span>
              <span class="tp-res-main">
                <b>{{ x.title }}</b>
                <span class="tp-res-sub">{{ metaOf(x.platform).name }} · {{ x.kind === 'detail' ? '细分检索' : '主题检索' }}</span>
              </span>
            </a>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.tp-panel {
  display: flex; flex-direction: column; gap: 12px;
  background: #f8fafc; border: 1px solid var(--border); border-radius: 10px;
  padding: 12px 14px; margin-top: 6px; width: 100%;
}
.tp-sec { display: flex; flex-direction: column; gap: 8px; }
.tp-sec-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
  .tp-sec-title { font-size: 13px; font-weight: 600; color: var(--text); }
  .tp-tip2 { font-size: 12px; color: #94a3b8; }
}
.tp-done-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.tp-mode-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  .el-radio-group { flex-shrink: 0; }
}
.tp-multi-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.tp-count { font-size: 13px; font-weight: 600; color: #f59e0b;
  &.ok { color: #16a34a; }
}
.tp-done-badge { font-size: 12px; font-weight: 600; color: #16a34a; }
.tp-recs { display: flex; flex-direction: column; gap: 4px; }
.tp-rec { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text);
  .tp-rec-i { color: #94a3b8; font-size: 11.5px; min-width: 20px; }
  .tp-rec-by { font-weight: 500; }
  .tp-rec-at { color: #94a3b8; }
}
.tp-tip2 { font-size: 12px; color: #94a3b8; }
.tp-link-form { display: flex; gap: 8px; flex-wrap: wrap;
  .el-input { flex: 1; min-width: 140px; }
}
.tp-link-list { display: flex; flex-direction: column; gap: 4px; }
.tp-link { display: flex; align-items: center; gap: 4px;
  .tp-link-a { font-size: 12.5px; color: #2563eb; text-decoration: none; word-break: break-all;
    &:hover { text-decoration: underline; }
  }
}
.tp-empty { color: #cbd5e1; font-size: 12.5px; }
.tp-hint { margin-top: 4px; border-radius: 8px; }
.tp-err { color: #ef4444; font-size: 12.5px; }
.tp-ai-block { display: flex; flex-direction: column; gap: 6px; }
.tp-ai-label { font-size: 12.5px; color: var(--text-2); }
.tp-subs { margin: 0; padding-left: 20px;
  li { font-size: 13px; line-height: 1.8; color: var(--text); }
}
.tp-kw { margin-right: 6px; }
.tp-res { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 6px; }
.tp-res-a {
  display: flex; align-items: center; gap: 8px; text-decoration: none; color: var(--text);
  background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px;
  transition: all .15s;
  &:hover { border-color: #93c5fd; box-shadow: 0 2px 8px rgba(37, 99, 235, .08); }
  .tp-res-icon {
    width: 26px; height: 26px; border-radius: 6px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center; font-size: 14px; color: #fff;
  }
  .tp-res-main { min-width: 0; display: flex; flex-direction: column;
    b { font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tp-res-sub { font-size: 11px; color: #94a3b8; }
  }
}
</style>
