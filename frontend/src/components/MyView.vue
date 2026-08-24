<script setup>
// 「我的」个人中心：账号信息 + 数据概览（备赛/学习计划、小组）+ 快捷入口 + 退出登录
// 未登录时内嵌 AuthView 完成登录
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api } from '../api.js';
import auth, { clearAuth } from '../auth.js';
import AuthView from './AuthView.vue';

const router = useRouter();
const loading = ref(false);
const profile = ref(null); // api.me()：{ user, teams[] }
const schedules = ref([]);
const studies = ref([]);

async function load() {
  if (!auth.token) return;
  loading.value = true;
  try {
    const [me, sched, study] = await Promise.all([api.me(), api.scheduleList(), api.studyList()]);
    profile.value = me;
    schedules.value = sched;
    studies.value = study;
  } catch (e) {
    if (e.message.includes('401') || e.message.includes('登录')) clearAuth();
    else ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}

// 备赛计划总进度
const planStat = computed(() => {
  const all = schedules.value.flatMap((s) => (s.plan?.phases || []).flatMap((p) => p.tasks || []));
  return { count: schedules.value.length, done: all.filter((t) => t.done).length, total: all.length };
});
// 学习日程总进度
const studyStat = computed(() => {
  const all = studies.value.flatMap((s) => (s.plan?.phases || []).flatMap((p) => p.tasks || []));
  return { count: studies.value.length, done: all.filter((t) => t.done).length, total: all.length };
});
const pct = (st) => (st.total ? Math.round((st.done / st.total) * 100) : 0);

function logout() {
  clearAuth();
  ElMessage.success('已退出登录');
  router.push('/');
}

onMounted(load);
</script>

<template>
  <!-- 未登录：内嵌登录界面 -->
  <AuthView v-if="!auth.token" />

  <main v-else v-loading="loading" class="me-page">
    <!-- 账号卡片 -->
    <section class="me-card">
      <div class="me-avatar">{{ auth.user?.nickname?.charAt(0) || '👤' }}</div>
      <div class="me-info">
        <h2>{{ auth.user?.nickname }}
          <el-tag v-if="auth.user?.is_admin" size="small" type="danger" style="margin-left:8px">管理员</el-tag>
        </h2>
        <p class="me-id">@{{ auth.user?.username }}</p>
        <p class="me-mail">
          <template v-if="auth.user?.email">📧 {{ auth.user.email }}</template>
          <template v-else>📧 未绑定邮箱（可用「账号密码」登录）</template>
        </p>
      </div>
      <div class="me-actions">
        <el-button type="danger" plain @click="logout">退出登录</el-button>
      </div>
    </section>

    <!-- 数据统计 -->
    <section class="stat-row">
      <router-link to="/schedule" class="stat-card">
        <b class="sc-num">{{ planStat.count }}</b>
        <span class="sc-label">备赛计划</span>
        <el-progress :percentage="pct(planStat)" :stroke-width="6" :show-text="false" />
        <span class="sc-sub">{{ planStat.done }}/{{ planStat.total }} 任务完成 · {{ pct(planStat) }}%</span>
      </router-link>
      <router-link to="/schedule?tab=study" class="stat-card">
        <b class="sc-num">{{ studyStat.count }}</b>
        <span class="sc-label">学习日程</span>
        <el-progress :percentage="pct(studyStat)" :stroke-width="6" :show-text="false" />
        <span class="sc-sub">{{ studyStat.done }}/{{ studyStat.total }} 任务完成 · {{ pct(studyStat) }}%</span>
      </router-link>
      <router-link to="/team" class="stat-card">
        <b class="sc-num">{{ profile?.teams?.length || 0 }}</b>
        <span class="sc-label">加入小组</span>
        <span class="sc-sub">{{ profile?.teams?.map((t) => t.role_name || '组长').join(' / ') || '尚未加入小组' }}</span>
      </router-link>
    </section>

    <!-- 数据归属说明 -->
    <el-alert
      type="success" :closable="false" class="me-tip"
      title="登录后创建的计划已存入数据库并关联到本账号，任何设备登录都能查看"
    />

    <!-- 我的小组 -->
    <section v-if="profile?.teams?.length" class="me-block">
      <h3>🏗️ 我的小组</h3>
      <div class="team-list">
        <router-link v-for="t in profile.teams" :key="t.id" to="/team" class="team-item">
          <div class="ti-info">
            <b>{{ t.name }}</b>
            <span class="ti-desc">{{ t.desc || '—' }}</span>
          </div>
          <el-tag size="small" :type="t.is_owner ? 'danger' : 'info'">
            {{ t.is_owner ? '👑 组长' : t.role_name || '组员' }}
          </el-tag>
          <span class="ti-count">{{ t.member_count }} 人</span>
        </router-link>
      </div>
    </section>

    <!-- 快捷入口 -->
    <section class="me-block">
      <h3>⚡ 快捷入口</h3>
      <div class="quick-row">
        <router-link to="/schedule" class="quick-btn">📅 日程规划（竞赛 + 学习）</router-link>
        <router-link to="/team" class="quick-btn">🏗️ 项目小组</router-link>
        <router-link to="/" class="quick-btn">🗓️ 竞赛时间轴</router-link>
        <router-link v-if="auth.user?.is_admin" to="/admin" class="quick-btn">🧠 AI 收录管理</router-link>
      </div>
    </section>
  </main>
</template>

<style lang="scss" scoped>
.me-page { padding: 20px 24px 80px; max-width: 860px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }

.me-card {
  display: flex; align-items: center; gap: 18px;
  background: linear-gradient(135deg, #1e3a8a, #2563eb);
  color: #fff; border-radius: 14px; padding: 22px 24px;
  box-shadow: 0 6px 20px rgba(37, 99, 235, .25);

  .me-avatar {
    width: 64px; height: 64px; border-radius: 50%; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 28px; background: rgba(255, 255, 255, .18); border: 2px solid rgba(255, 255, 255, .4);
  }
  .me-info { flex: 1; min-width: 0;
    h2 { margin: 0; font-size: 20px; }
    .me-id { margin: 2px 0 0; font-size: 13px; opacity: .75; }
    .me-mail { margin: 4px 0 0; font-size: 12.5px; opacity: .85; }
  }
}

.stat-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.stat-card {
  display: flex; flex-direction: column; gap: 6px;
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px;
  padding: 16px 18px; text-decoration: none; color: var(--text);
  transition: transform .15s, box-shadow .15s;
  &:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(30, 41, 59, .1); }
  .sc-num { font-size: 26px; color: #2563eb; }
  .sc-label { font-size: 13px; color: var(--text-2); }
  .sc-sub { font-size: 12px; color: #94a3b8; }
}

.me-tip { border-radius: 10px; }

.me-block {
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px;
  h3 { margin: 0 0 12px; font-size: 15px; }
}
.team-list { display: flex; flex-direction: column; gap: 8px; }
.team-item {
  display: flex; align-items: center; gap: 12px; text-decoration: none; color: var(--text);
  border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px;
  transition: background .15s;
  &:hover { background: #f1f5f9; }
  .ti-info { flex: 1; min-width: 0; b { display: block; font-size: 14px; }
    .ti-desc { font-size: 12px; color: var(--text-2); display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  }
  .ti-count { font-size: 12px; color: #94a3b8; }
}
.quick-row { display: flex; gap: 10px; flex-wrap: wrap; }
.quick-btn {
  text-decoration: none; font-size: 13px; color: #2563eb;
  border: 1px solid #2563eb55; background: #2563eb0d; border-radius: 999px;
  padding: 7px 16px; transition: all .15s;
  &:hover { background: #2563eb; color: #fff; }
}
</style>
