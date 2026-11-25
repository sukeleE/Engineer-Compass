<script setup>
import { ref, computed } from 'vue';
import { ElMessage } from 'element-plus';
import ToolPanel from './ToolPanel.vue';
import {
  todos, addTodo, toggleTodo, removeTodo, clearDoneTodos, todayStr,
} from '../../utils/studyTools.js';

defineProps({ open: Boolean, panelStyle: { type: Object, default: () => ({}) } });
const emit = defineEmits(['close']);

const text = ref('');
const todayList = computed(() => todos.filter((t) => t.date === todayStr()));
const pastList = computed(() => todos.filter((t) => t.date !== todayStr() && !t.done));
const doneCount = computed(() => todayList.value.filter((t) => t.done).length);

function add() {
  if (!addTodo(text.value)) return ElMessage.warning('先写一条待办');
  text.value = '';
}
</script>

<template>
  <ToolPanel :open="open" :panel-style="panelStyle" icon="✅" title="今日待办" :subtitle="`${todayStr()} · 已完成 ${doneCount}/${todayList.length}`" @close="emit('close')">
    <div class="todo-form">
      <el-input v-model="text" placeholder="今天要完成什么？" maxlength="60" @keyup.enter="add" />
      <el-button type="primary" @click="add">添加</el-button>
    </div>

    <div v-if="!todayList.length && !pastList.length" class="todo-empty">今天还没有待办，先列一件最重要的事。</div>

    <div v-if="todayList.length" class="todo-group">
      <div class="todo-group-head">今天</div>
      <div v-for="t in todayList" :key="t.id" class="todo-item" :class="{ done: t.done }">
        <el-checkbox :model-value="t.done" @change="toggleTodo(t.id)" />
        <span class="todo-text" @click="toggleTodo(t.id)">{{ t.text }}</span>
        <el-button link type="danger" size="small" @click="removeTodo(t.id)">删除</el-button>
      </div>
    </div>

    <div v-if="pastList.length" class="todo-group">
      <div class="todo-group-head">往期未完成</div>
      <div v-for="t in pastList" :key="t.id" class="todo-item">
        <el-checkbox :model-value="t.done" @change="toggleTodo(t.id)" />
        <span class="todo-text" @click="toggleTodo(t.id)">{{ t.text }}</span>
        <span class="todo-date">{{ t.date.slice(5) }}</span>
        <el-button link type="danger" size="small" @click="removeTodo(t.id)">删除</el-button>
      </div>
    </div>

    <div v-if="doneCount" class="todo-foot">
      <el-button link type="primary" size="small" @click="clearDoneTodos">清除已完成</el-button>
    </div>
  </ToolPanel>
</template>

<style lang="scss" scoped>
.todo-form { display: flex; gap: 8px; margin-bottom: 14px; }
.todo-empty { text-align: center; color: var(--text-3); font-size: 13px; padding: 50px 10px; }
.todo-group { margin-bottom: 16px; }
.todo-group-head { font-size: 12.5px; color: var(--text-2); font-weight: 600; margin: 0 2px 8px; }
.todo-item {
  display: flex; align-items: center; gap: 8px;
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px;
  padding: 10px 12px; margin-bottom: 8px;
}
.todo-text { flex: 1; min-width: 0; font-size: 13.5px; color: var(--text); cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.todo-item.done .todo-text { color: var(--text-3); text-decoration: line-through; }
.todo-date { font-size: 11.5px; color: var(--text-3); white-space: nowrap; }
.todo-foot { text-align: right; padding-top: 4px; border-top: 1px dashed var(--border); }
</style>
