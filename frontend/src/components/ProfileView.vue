<script setup>
// 用户公开主页（只读）：任何登录用户可在小组内点击成员头像/昵称进入，了解其
// 基本资料 + 竞赛备赛计划进度 + 学习日程进度 + 参加的项目小组
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api } from '../api.js';
import auth from '../auth.js';
import PlanTiles from './team/PlanTiles.vue';

const route = useRoute();
const data = ref(null);
const loading = ref(false);
const error = ref('');

const uid = computed(() => Number(route.params.id));
const isMe = computed(() => auth.user?.id === uid.value);

// 转成 PlanTiles 的紧凑标签数据（只取展示所需字段）
const schedTiles = (arr) => arr.map((s) => ({ id: s.id, name: s.comp_name, done: s.done, total: s.total, phases: s.phases || [] }));
const studyTiles = (arr) => arr.map((s) => ({ id: s.id, name: s.topic, done: s.done, total: s.total, phases: s.phases || [], level: s.level }));

async function load() {
  if (!auth.token) { error.value = '登录后查看用户主页'; return; }
  loading.value = true;
  error.value = '';
  try {
    data.value = await api.userPublic(uid.value);
  } catch (e) {
    error.value = e.message;
    data.value = null;
  } finally {
    loading.value = false;
  }
}

watch(uid, load);
onMounted(load);
</script>

<template>
  <main class="profile-page">
    <!-- 未登录 -->
    <div v-if="!auth.token" class="need-login">
      <div class="nl-icon">👤</div>
      <h2>查看用户主页需要登录</h2>
      <router-link :to="`/login?redirect=/user/${uid}`"><el-button type="primary" size="large">去登录 / 注册</el-button></router-link>
    </div>

    <div v-else v-loading="loading" class="profile-body">
      <!-- 加载失败 -->
      <el-empty v-if="error" :description="error" />

      <template v-else-if="data">
        <!-- 头部资料卡 -->
        <div class="pv-head">
          <span class="pv-avatar">
            <img v-if="data.user.avatar" :src="data.user.avatar" alt="" />
            <template v-else>{{ data.user.nickname?.[0] || '?' }}</template>
          </span>
          <div class="pv-info">
            <div class="pv-name">
              <b>{{ data.user.nickname }}</b>
              <span class="pv-username">@{{ data.user.username }}</span>
              <el-tag v-if="isMe" size="small" type="warning" style="margin-left:6px">这是我</el-tag>
            </div>
            <div class="pv-meta">加入于 {{ (data.user.create_time || '').slice(0, 10) }} · 参加 {{ data.teams.length }} 个小组</div>
            <router-link v-if="isMe" to="/me" class="pv-manage">⚙️ 前往我的管理界面</router-link>
          </div>
        </div>

        <!-- 🏆 竞赛备赛计划（全部显示，含已完成——成果展示；紧凑标签点击展开详细进度） -->
        <section v-if="data.schedules.length" class="pv-sec">
          <h3>🏆 竞赛备赛计划（{{ data.schedules.length }}）</h3>
          <PlanTiles :items="schedTiles(data.schedules)" />
        </section>
        <el-empty v-else description="暂无竞赛备赛计划" :image-size="70" class="pv-empty" />

        <!-- 📚 学习日程（紧凑标签点击展开详细进度） -->
        <section v-if="data.studies.length" class="pv-sec">
          <h3>📚 学习日程（{{ data.studies.length }}）</h3>
          <PlanTiles :items="studyTiles(data.studies)" />
        </section>
        <el-empty v-else description="暂无学习日程" :image-size="70" class="pv-empty" />

        <!-- 🏗️ 参加的小组 -->
        <section v-if="data.teams.length" class="pv-sec">
          <h3>🏗️ 参加的项目小组（{{ data.teams.length }}）</h3>
          <div class="team-grid">
            <router-link v-for="t in data.teams" :key="t.id" :to="`/team?team=${t.id}`" class="team-card">
              <div class="tc-top">
                <b>{{ t.name }}</b>
                <el-tag v-if="t.is_owner" size="small" type="warning">👑 组长</el-tag>
              </div>
              <div v-if="t.desc" class="tc-desc">{{ t.desc }}</div>
              <div class="tc-meta">
                <el-tag v-for="rn in t.role_names || []" :key="rn" size="small" effect="plain" style="margin-right:4px">{{ rn }}</el-tag>
                <span class="tc-count">{{ t.member_count }} 人</span>
              </div>
            </router-link>
          </div>
        </section>
        <el-empty v-else description="未参加任何小组" :image-size="70" class="pv-empty" />
      </template>
    </div>
  </main>
</template>

<style lang="scss" scoped>
.profile-page { padding: 20px 24px; max-width: 900px; margin: 0 auto; }
.need-login { text-align: center; padding: 80px 0;
  .nl-icon { font-size: 48px; }
  h2 { margin: 12px 0 6px; }
}
.profile-body { min-height: 400px; }

.pv-head {
  display: flex; align-items: center; gap: 16px; margin-bottom: 20px;
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 14px; padding: 18px 20px;
  .pv-avatar {
    width: 72px; height: 72px; border-radius: 50%; background: var(--primary); color: #fff;
    display: flex; align-items: center; justify-content: center; font-size: 28px; flex-shrink: 0; overflow: hidden;
    img { width: 100%; height: 100%; object-fit: cover; }
  }
  .pv-info { min-width: 0; }
  .pv-name { display: flex; align-items: center; flex-wrap: wrap; gap: 6px;
    b { font-size: 20px; }
    .pv-username { color: var(--text-2); font-size: 13px; }
  }
  .pv-meta { color: var(--text-2); font-size: 12.5px; margin-top: 4px; }
  .pv-manage { display: inline-block; margin-top: 8px; font-size: 12.5px; color: var(--primary); }
}

.pv-sec { margin-top: 18px;
  h3 { font-size: 15px; margin: 0 0 10px; }
}
.pv-empty { background: var(--card-bg); border: 1px dashed var(--border); border-radius: 12px; margin-top: 18px; }

.team-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
.team-card {
  display: block; background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px;
  padding: 12px 14px; text-decoration: none; color: inherit; transition: all .15s;
  &:hover { border-color: #93c5fd; box-shadow: 0 2px 10px color-mix(in srgb, var(--primary) 10%, transparent); }
  .tc-top { display: flex; align-items: center; gap: 6px; b { font-size: 14.5px; } }
  .tc-desc { color: var(--text-2); font-size: 12.5px; margin: 4px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tc-meta { display: flex; align-items: center; flex-wrap: wrap; margin-top: 6px;
    .tc-count { margin-left: auto; color: var(--text-2); font-size: 12px; }
  }
}
</style>
