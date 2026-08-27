<script setup>
// 通用「对话式 AI 计划」弹窗：AI 先提问（分组方式/计划周期/投入时间），信息足够后输出计划
// 模式：team-create（建组前确认分组+计划，前端确认后调 POST /team）| team-generate / team-edit（小组计划）
//       schedule / schedule-edit（个人竞赛备赛日程）| study / study-edit（学习日程）
// 已保存模式（除 team-create）收到 plan 后后端已入库，emit done({plan_id, plan, departments?}) 由父级刷新
import { ref, watch, nextTick } from 'vue';
import { api } from '../api.js';

const props = defineProps({
  modelValue: Boolean,
  mode: { type: String, required: true }, // team-create | team-generate | team-edit | schedule | schedule-edit | study | study-edit
  teamId: Number, planId: Number, compId: Number, scheduleId: Number, studyId: Number,
  title: String, // 弹窗标题（默认按模式）
});
const emit = defineEmits(['update:modelValue', 'done']);

const META = {
  'team-create': { title: '💬 AI 对话智能建组', hint: 'AI 会先向你确认：分几个部门、备赛周期与时间、成员分工 —— 然后生成部门与备赛计划' },
  'team-generate': { title: '💬 AI 对话生成小组计划', hint: 'AI 会先确认分组方式与计划周期，再按部门拆分任务' },
  'team-edit': { title: '💬 AI 对话修改小组计划', hint: '告诉 AI 想怎么调整（阶段时间/任务/分工）；已勾选任务自动保留' },
  schedule: { title: '💬 AI 对话生成备赛日程', hint: 'AI 会先确认你的基础、备赛周期与每周投入，再生成分阶段日程' },
  'schedule-edit': { title: '💬 AI 对话修改备赛日程', hint: '告诉 AI 想怎么调整；已勾选任务自动保留' },
  study: { title: '💬 AI 对话生成学习日程', hint: 'AI 会先确认学习主题、水平、目标与时间投入，再生成计划' },
  'study-edit': { title: '💬 AI 对话修改学习日程', hint: '告诉 AI 想怎么调整；已勾选任务自动保留' },
};
const meta = META[props.mode] || { title: '💬 AI 对话', hint: '' };

const messages = ref([]); // [{role, content}] 完整历史（后端截取最近 N 条）
const input = ref('');
const sending = ref(false);
const error = ref('');
const result = ref(null); // {action:'plan', reply, plan, departments?, plan_id?} —— 出现即展示预览
const bodyRef = ref(null);

function cfg() {
  return {
    mode: props.mode,
    team_id: props.teamId || undefined,
    plan_id: props.planId || undefined,
    comp_id: props.compId || undefined,
    schedule_id: props.scheduleId || undefined,
    study_id: props.studyId || undefined,
  };
}

async function ask() {
  sending.value = true;
  error.value = '';
  try {
    const res = await api.planChat(cfg(), messages.value);
    messages.value.push({ role: 'assistant', content: res.reply });
    if (res.action === 'plan') result.value = res;
  } catch (e) {
    error.value = e.message;
  } finally {
    sending.value = false;
  }
}

async function send() {
  const content = input.value.trim();
  if (!content || sending.value) return;
  messages.value.push({ role: 'user', content });
  input.value = '';
  await ask();
}

function confirm() {
  // team-create：父级拿 departments+plan 调 POST /team；其余模式后端已保存，父级拿 plan_id 刷新
  emit('done', {
    plan: result.value?.plan,
    departments: result.value?.departments,
    plan_id: result.value?.plan_id,
  });
}

// 打开时：会话 key（模式+各 id）变化 → 重置对话；首次打开自动发起首问
const lastKey = ref('');
const keyOf = () => [props.mode, props.teamId, props.planId, props.compId, props.scheduleId, props.studyId].join('|');
watch(() => props.modelValue, (v) => {
  if (!v) return;
  const k = keyOf();
  if (k !== lastKey.value) {
    lastKey.value = k;
    messages.value = [];
    result.value = null;
    error.value = '';
  }
  if (!messages.value.length) ask();
});

// 新消息自动滚到底
watch([() => messages.value.length, sending], async () => {
  await nextTick();
  if (bodyRef.value) bodyRef.value.scrollTop = bodyRef.value.scrollHeight;
});

// 结果预览里的任务文本（兼容字符串与对象）
const taskText = (t) => (typeof t === 'string' ? t : t?.text || '');
</script>

<template>
  <el-dialog :model-value="modelValue" :title="title || meta.title" width="580px" top="6vh"
    @update:model-value="(v) => emit('update:modelValue', v)">
    <div class="pc">
      <div class="pc-hint">💡 {{ meta.hint }}</div>

      <!-- 对话区 -->
      <div ref="bodyRef" class="pc-body">
        <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
          <div class="bubble">{{ m.content }}</div>
        </div>
        <div v-if="sending" class="msg assistant">
          <div class="bubble typing"><span></span><span></span><span></span></div>
        </div>
        <div v-if="error" class="chat-error">
          <span>⚠️ {{ error }}</span>
          <el-button size="small" type="primary" plain @click="ask">重试</el-button>
        </div>
      </div>

      <!-- 计划预览（生成后替换输入区） -->
      <div v-if="result" class="pc-result">
        <div class="res-head">📋 AI 计划已生成 —— 请确认</div>
        <div v-if="result.departments?.length" class="dept-chips">
          <el-tag v-for="d in result.departments" :key="d.name" type="success" effect="light">
            🏛 {{ d.name }}<template v-if="d.duty"> · {{ d.duty }}</template>
          </el-tag>
        </div>
        <div v-if="result.plan?.topic" class="res-topic">
          📚 {{ result.plan.topic }}<span v-if="result.plan.summary" class="res-summary"> — {{ result.plan.summary }}</span>
        </div>
        <div class="phase-preview">
          <div v-for="(ph, i) in result.plan?.phases || []" :key="i" class="rp-phase">
            <div class="rp-head">
              <b>阶段{{ i + 1 }} {{ ph.phase }}</b>
              <span v-if="ph.date" class="rp-date">📅 {{ ph.date }}</span>
              <span v-if="ph.week_hours" class="rp-week">⏱ {{ ph.week_hours }}h/周</span>
            </div>
            <ul>
              <li v-for="(t, j) in (ph.tasks || []).slice(0, 4)" :key="j">
                {{ taskText(t) }}
                <el-tag v-if="t?.dept && t.dept !== '通用'" size="small" effect="plain" class="rp-dept">{{ t.dept }}</el-tag>
              </li>
              <li v-if="(ph.tasks || []).length > 4" class="rp-more">…共 {{ ph.tasks.length }} 项任务</li>
            </ul>
          </div>
        </div>
        <div class="res-actions">
          <el-button @click="result = null">💬 继续修改</el-button>
          <el-button type="primary" @click="confirm">{{ meta.title.includes('建组') ? '✅ 按此方案建组' : '✅ 完成' }}</el-button>
        </div>
      </div>

      <!-- 输入区 -->
      <div v-else class="pc-input">
        <el-input
          v-model="input" placeholder="如：分 3 组：机械/电控/软件，备赛到 11 月"
          :disabled="sending" @keyup.enter="send"
        />
        <el-button type="primary" :loading="sending" @click="send">发送</el-button>
      </div>
    </div>
  </el-dialog>
</template>

<style lang="scss" scoped>
.pc-hint {
  background: #eff6ff; border: 1px solid #bfdbfe; color: #1d4ed8;
  border-radius: 8px; padding: 8px 12px; font-size: 12.5px; margin-bottom: 10px; line-height: 1.6;
}
.pc-body {
  height: 380px; overflow-y: auto; padding: 4px 6px 4px 0; display: flex; flex-direction: column; gap: 10px;
  border: 1px solid var(--border); border-radius: 10px; padding: 12px; background: #fafbfc;

  .msg { display: flex;
    &.user { justify-content: flex-end; }
    .bubble {
      max-width: 82%; padding: 9px 13px; border-radius: 12px; font-size: 13.5px; line-height: 1.7;
      white-space: pre-wrap; word-break: break-word;
    }
    &.assistant .bubble { background: #fff; border: 1px solid var(--border); border-top-left-radius: 3px; }
    &.user .bubble { background: #2563eb; color: #fff; border-top-right-radius: 3px; }
    .typing { display: flex; gap: 4px; align-items: center;
      span { width: 6px; height: 6px; border-radius: 50%; background: #93c5fd; animation: blink 1s infinite;
        &:nth-child(2) { animation-delay: .2s; } &:nth-child(3) { animation-delay: .4s; } }
    }
  }
  .chat-error { color: #b91c1c; font-size: 12.5px; display: flex; align-items: center; gap: 8px; justify-content: center; }
  @keyframes blink { 0%, 100% { opacity: .2; } 50% { opacity: 1; } }
}
.pc-input { display: flex; gap: 8px; margin-top: 10px; }
.pc-result { margin-top: 10px; border: 1px solid #86efac; background: #f0fdf4; border-radius: 10px; padding: 12px;

  .res-head { font-weight: 600; font-size: 14px; color: #166534; margin-bottom: 8px; }
  .dept-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .res-topic { font-size: 13px; color: #14532d; margin-bottom: 6px;
    .res-summary { color: var(--text-2); }
  }
  .phase-preview { display: flex; flex-direction: column; gap: 6px; max-height: 240px; overflow-y: auto;
    .rp-phase { background: #fff; border: 1px solid #d1fae5; border-radius: 8px; padding: 8px 10px;
      .rp-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px;
        .rp-date { color: var(--text-2); font-size: 12px; }
        .rp-week { color: #1d4ed8; font-size: 12px; }
      }
      ul { margin: 6px 0 0; padding-left: 18px; color: var(--text); font-size: 12.5px; line-height: 1.8;
        .rp-dept { margin-left: 6px; }
        .rp-more { color: #94a3b8; list-style: none; margin-left: -18px; }
      }
    }
  }
  .res-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
}
</style>
