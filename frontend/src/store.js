// 全局轻量状态：AI 对话的当前上下文（正在查看的竞赛）
import { reactive } from 'vue';

export const store = reactive({
  currentCompId: null,
  currentCompName: null,
});
