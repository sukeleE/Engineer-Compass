<script setup>
// 小组工作台：Tabs 切换（进度对齐 / 备赛计划 / 讨论 / 资料共享 / 设备预约 / 成员与角色）
import { ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api.js';
import TeamProgress from './team/TeamProgress.vue';
import TeamPlanView from './team/TeamPlanView.vue';
import TeamChat from './team/TeamChat.vue';
import TeamFiles from './team/TeamFiles.vue';
import TeamDevices from './team/TeamDevices.vue';
import TeamMembers from './team/TeamMembers.vue';

const props = defineProps({ teamId: Number, myRole: String });

const detail = ref(null);
const loading = ref(false);
const active = ref('progress');

watch(
  () => props.teamId,
  async (id) => {
    if (!id) return;
    loading.value = true;
    try {
      detail.value = await api.teamDetail(id);
    } catch (e) {
      ElMessage.error(e.message);
    } finally {
      loading.value = false;
    }
  },
  { immediate: true }
);
</script>

<template>
  <div class="team-detail" v-loading="loading">
    <template v-if="detail">
      <div class="td-head">
        <div>
          <h3>{{ detail.team.name }}</h3>
          <p v-if="detail.team.desc" class="td-desc">{{ detail.team.desc }}</p>
          <div class="td-tags">
            <el-tag size="small" type="warning" v-if="detail.me.is_owner">👑 组长</el-tag>
            <el-tag size="small" v-else>{{ detail.me.role?.name || '无角色' }}</el-tag>
            <el-tag size="small" type="info" effect="plain">🔑 {{ detail.team.invite_code }}</el-tag>
            <el-tag size="small" type="success" effect="plain">{{ detail.members.length }} 人</el-tag>
          </div>
        </div>
      </div>

      <el-tabs v-model="active">
        <el-tab-pane label="📊 进度对齐" name="progress">
          <TeamProgress :team-id="detail.team.id" :me="detail.me" :perms="detail.perms" :members="detail.members" :tasks="detail.tasks" />
        </el-tab-pane>
        <el-tab-pane label="🎯 备赛计划" name="plans">
          <TeamPlanView :team-id="detail.team.id" :me="detail.me" :roles="detail.roles" :perms="detail.perms" />
        </el-tab-pane>
        <el-tab-pane label="💬 讨论" name="chat">
          <TeamChat :team-id="detail.team.id" :me="detail.me" :perms="detail.perms" />
        </el-tab-pane>
        <el-tab-pane label="📁 资料共享" name="files">
          <TeamFiles :team-id="detail.team.id" :me="detail.me" :perms="detail.perms" />
        </el-tab-pane>
        <el-tab-pane label="🔧 设备预约" name="devices">
          <TeamDevices :team-id="detail.team.id" :me="detail.me" :perms="detail.perms" :devices="detail.devices" />
        </el-tab-pane>
        <el-tab-pane label="👥 成员与角色" name="members">
          <TeamMembers :team-id="detail.team.id" :me="detail.me" :perms="detail.perms" :members="detail.members" :roles="detail.roles" />
        </el-tab-pane>
      </el-tabs>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.team-detail { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; min-height: 480px; }
.td-head { margin-bottom: 6px;
  h3 { margin: 0; font-size: 18px; }
  .td-desc { color: var(--text-2); font-size: 13px; margin: 4px 0 8px; }
  .td-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
}
</style>
