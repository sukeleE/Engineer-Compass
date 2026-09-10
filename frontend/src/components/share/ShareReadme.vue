<script setup>
// 资源分享页的「README」区：选中帖的正文 + 附件 + 点赞收藏 + 讨论区
// 由旧详情弹窗（el-dialog sh-detail-dlg）整体搬来 —— 只换容器与观感，权限判定与事件语义不变。
// 讨论区按 GitHub issue 风排版：左头像 + 右「昵称 commented 相对时间」头栏 + 正文。
import { ref, computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import auth from '../../auth.js';
import { openImage } from '../../utils/imageViewer.js';
import { cnt } from '../../utils/share.js';
import { fmtRelative } from '../../utils/time.js';
import AttachmentList from '../team/AttachmentList.vue';
import GhIcon from './GhIcon.vue';

const props = defineProps({
  post: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },      // 就地渲染错误（深链指向已删/无权帖），不弹 toast
  inList: { type: Boolean, default: true },  // false → 提示「不在当前列表视图」（来自通知/收藏/别的页）
  sending: { type: Boolean, default: false },// 父层 commentSending
  feishuBusy: { type: Boolean, default: false },
  feishuUrl: { type: String, default: '' },
  ghostPage: { type: Boolean, default: false },
  // 独立详情页（/share/:id）用：列表页是「下方展开的框」，独立页是页面主体，
  // 两者的关闭按钮、「不在当前列表视图」提示、未选中空态都只有列表页语境才成立
  standalone: { type: Boolean, default: false },
});
const emit = defineEmits(['like', 'fav', 'comment', 'del-comment', 'edit', 'del', 'feishu-edit', 'feishu-sync', 'close']);

const router = useRouter();

// 头像/昵称 → 主页：组件内自己做，不为每个作者和每条评论绕一圈 emit（逻辑同 ShareView 的 toProfile）
const toProfile = (uid) => router.push(Number(uid) === Number(auth.user?.id) ? '/me' : `/user/${uid}`);

const isMine = computed(() => !!props.post && !!auth.user
  && (Number(props.post.author_id) === Number(auth.user.id) || auth.user.is_admin));
const canDelComment = (c) => Number(c.user_id) === Number(auth.user?.id) || auth.user?.is_admin;

// 富文本里的图片点击 → 全屏预览（与旧详情弹窗一致）
function onRichClick(e) {
  if (e.target.tagName === 'IMG') openImage(e.target.currentSrc || e.target.src, '帖子图片');
}

// 评论输入框留组件内（纯瞬态 UI 状态），发送时把文本抛给父层去调接口与更新计数。
// 「发送中」是数据状态 → 由父层经 sending 传入。
const commentInput = ref('');
function send() {
  const text = commentInput.value.trim();
  if (!text) return ElMessage.warning('写点评论内容');
  emit('comment', text);
}
// 父层发完会刷新 cur（comment_count 变化）—— 以此当信号清空输入框，父层无需 defineExpose
watch(() => props.post?.comment_count, () => { commentInput.value = ''; });
</script>

<template>
  <div class="gh-readme">
    <!-- 加载中 / 出错 / 正常 三态：深链指向已删帖时错误就地显示，不整页清空 -->
    <div v-if="loading" v-loading="true" class="gh-rstate" />
    <div v-else-if="error" class="gh-rstate err">
      <GhIcon name="file" :size="20" />
      <p>{{ error }}</p>
      <button class="gh-btn" @click="emit('close')">关闭</button>
    </div>

    <template v-else-if="post">
      <!-- 框头栏：文件名 + 右上关闭 + 作者专属操作（同旧弹窗的 pd-own） -->
      <div class="gh-rhead">
        <span class="gh-rfile">
          <GhIcon name="book" :size="16" />
          <b>{{ post.title }}</b>
        </span>
        <span class="gh-racts">
          <template v-if="isMine">
            <el-button size="small" text type="primary" :loading="feishuBusy" @click="emit('feishu-edit', post)">飞书编辑</el-button>
            <el-button size="small" text type="primary" :loading="feishuBusy" @click="emit('feishu-sync', post)">同步</el-button>
            <el-button size="small" text @click="emit('edit', post)">编辑</el-button>
            <el-button size="small" text type="danger" @click="emit('del', post)">删除</el-button>
          </template>
          <button v-if="!standalone" class="gh-x" title="关闭" @click="emit('close')">×</button>
        </span>
      </div>

      <!-- 该帖不在当前列表视图（来自消息通知 / 我的收藏 / 别的标签或页码）→ 明说，免得用户找不到高亮行。
           独立页没有「列表」这个语境，冷启动深链会恒真，必须屏蔽 -->
      <div v-if="!inList && !standalone" class="gh-rhint">
        该帖不在当前列表视图（可能来自消息通知、我的收藏或其它标签/页码）
      </div>

      <!-- 元信息条 -->
      <div class="gh-rmeta">
        <span class="gh-author" @click="toProfile(post.author_id)">
          <img v-if="post.avatar" :src="post.avatar" alt="" class="gh-ava" />{{ post.nickname }}
        </span>
        <span class="gh-dot">·</span>
        <span :title="post.create_time">{{ fmtRelative(post.create_time) }}</span>
        <span v-for="t in post.tags" :key="t" class="gh-rtag">#{{ t }}</span>
        <!-- is_ghost 只有详情接口返回（列表不返回），所以归属徽标只能在这里给 -->
        <span v-if="post.is_ghost" class="gh-rghost">👻 仅怪奇可见</span>
      </div>

      <!-- 已关联飞书文档 → 直达链接（点「飞书编辑」后出现） -->
      <div v-if="feishuUrl" class="gh-rfeishu">
        <a :href="feishuUrl" target="_blank" rel="noopener">打开飞书文档编辑 →</a>
      </div>

      <!-- 正文（富文本，图片点击全屏预览） -->
      <div v-if="post.content" class="gh-rbody" v-html="post.content" @click="onRichClick"></div>
      <div v-else class="gh-rempty">（纯附件帖）</div>
      <div v-if="post.attachments?.length" class="gh-ratt">
        <AttachmentList :attachments="post.attachments" />
      </div>

      <!-- 点赞 / 收藏 -->
      <div class="gh-rdock">
        <button class="gh-btn" :class="{ on: post.is_liked }" @click="emit('like', post)">
          <GhIcon name="thumbsup" :size="14" /> 点赞 {{ cnt(post.like_count) }}
        </button>
        <button class="gh-btn" :class="{ on: post.is_faved }" @click="emit('fav', post)">
          <GhIcon :name="post.is_faved ? 'star-fill' : 'star'" :size="14" /> 收藏 {{ cnt(post.fav_count) }}
        </button>
      </div>

      <!-- 讨论区（issue 风） -->
      <div class="gh-disc">
        <div class="gh-dhead">
          <GhIcon name="comment-discussion" :size="15" />
          <b>讨论</b>
          <span class="gh-dcount">{{ cnt(post.comment_count) }}</span>
        </div>

        <div v-if="post.comments?.length" class="gh-clist">
          <div v-for="c in post.comments" :key="c.id" class="gh-citem">
            <img v-if="c.avatar" :src="c.avatar" alt="" class="gh-cava" @click="toProfile(c.user_id)" />
            <span v-else class="gh-cava ghost" @click="toProfile(c.user_id)">{{ String(c.nickname || '?').slice(0, 1) }}</span>
            <div class="gh-cbox">
              <div class="gh-ctop">
                <span class="gh-cauthor" @click="toProfile(c.user_id)">{{ c.nickname }}</span>
                <span class="gh-ctime">commented {{ fmtRelative(c.create_time) }}</span>
                <button v-if="canDelComment(c)" class="gh-cdel" title="删除评论" @click="emit('del-comment', c)">删除</button>
              </div>
              <div class="gh-ctext">{{ c.content }}</div>
            </div>
          </div>
        </div>
        <div v-else class="gh-cempty">还没有评论，来抢沙发</div>

        <div class="gh-cinput">
          <el-input v-model="commentInput" placeholder="友善评论，Enter 发送" @keyup.enter="send" />
          <el-button type="primary" :loading="sending" @click="send">评论</el-button>
        </div>
      </div>
    </template>

    <!-- 未选中：给个入口提示，别留一块空白（独立页无「未选中」状态，不渲染） -->
    <div v-else-if="!standalone" class="gh-rstate hint">
      <GhIcon name="comment-discussion" :size="20" />
      <p>点上方任意一行，在这里查看帖子正文、附件与讨论</p>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.gh-readme {
  margin-top: 16px;
  border: 1px solid var(--border-2);
  border-radius: 6px;
  background: var(--card-bg);
  overflow: hidden;
}

.gh-rstate {
  min-height: 120px; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 8px;
  color: var(--text-3); font-size: 13px; padding: 24px 16px;
  p { margin: 0; }
  &.err p { color: var(--text-2); }
}

.gh-rhead {
  display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;
  padding: 8px 14px; background: var(--surface-1); border-bottom: 1px solid var(--border);
  .gh-rfile {
    display: flex; align-items: center; gap: 8px; min-width: 0;
    color: var(--text-3);
    b { color: var(--text); font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
  }
  .gh-racts { display: flex; align-items: center; gap: 2px; flex: none; }
  .gh-x {
    border: 0; background: transparent; cursor: pointer; color: var(--text-3);
    font-size: 20px; line-height: 1; padding: 0 4px; font-family: inherit;
    &:hover { color: var(--text); }
  }
}

.gh-rhint {
  padding: 7px 14px; font-size: 12.5px; color: var(--text-2);
  background: var(--surface-2); border-bottom: 1px solid var(--border);
}

.gh-rmeta {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 8px 14px 0; font-size: 12.5px; color: var(--text-2);
  .gh-dot { color: var(--text-3); }
  .gh-author {
    display: inline-flex; align-items: center; gap: 6px; cursor: pointer; font-weight: 600;
    &:hover { color: var(--primary); }
  }
  .gh-ava { width: 20px; height: 20px; border-radius: 50%; object-fit: cover; }
  .gh-rtag {
    background: var(--primary-tint); color: var(--primary);
    border-radius: 999px; padding: 1px 9px; font-size: 11.5px;
  }
  .gh-rghost {
    background: var(--surface-2); color: var(--text-2);
    border-radius: 999px; padding: 1px 9px; font-size: 11.5px;
  }
}

.gh-rfeishu {
  margin: 10px 14px 0; padding: 7px 12px; border-radius: 6px;
  background: var(--success-tint); border: 1px solid var(--success-border);
  font-size: 12.5px;
  a { color: var(--success-fg); text-decoration: none; &:hover { text-decoration: underline; } }
}

.gh-rbody {
  padding: 12px 16px; font-size: 14px; line-height: 1.75; color: var(--text);
  overflow-wrap: anywhere;
  :deep(img) { max-width: 100%; height: auto; border-radius: 6px; cursor: zoom-in; }
  :deep(p) { margin: 0 0 10px; }
  :deep(a) { color: var(--primary); }
  :deep(pre) {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: 6px; padding: 10px 12px; overflow-x: auto;
    font-family: var(--font-mono); font-size: 12.5px;
  }
  :deep(table) { border-collapse: collapse; width: 100%; }
  :deep(th), :deep(td) { border: 1px solid var(--border); padding: 5px 9px; }
}
.gh-rempty { padding: 12px 16px; color: var(--text-3); font-size: 13px; }
.gh-ratt { padding: 0 16px 4px; }

.gh-rdock {
  display: flex; gap: 8px; padding: 10px 16px;
  border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
  background: var(--surface-1);
  .gh-btn {
    display: inline-flex; align-items: center; gap: 6px;
    border: 1px solid var(--border-2); background: var(--card-bg); color: var(--text-2);
    border-radius: 6px; padding: 5px 12px; font-size: 12.5px; cursor: pointer;
    font-family: inherit; transition: all .15s;
    &:hover { border-color: var(--primary); color: var(--primary); }
    &.on { background: var(--primary-tint); border-color: var(--primary); color: var(--primary); font-weight: 600; }
  }
}

.gh-disc { padding: 12px 16px 16px; }
.gh-dhead {
  display: flex; align-items: center; gap: 7px; margin-bottom: 12px;
  color: var(--text-2);
  b { color: var(--text); font-size: 14px; }
  .gh-dcount {
    background: var(--surface-2); color: var(--text-2);
    border-radius: 999px; padding: 0 8px; font-size: 12px;
  }
}

.gh-clist { display: flex; flex-direction: column; gap: 12px; margin-bottom: 14px; }
.gh-citem { display: flex; gap: 10px; align-items: flex-start; }
.gh-cava {
  width: 30px; height: 30px; border-radius: 50%; object-fit: cover; flex: none; cursor: pointer;
  &.ghost {
    display: inline-flex; align-items: center; justify-content: center;
    background: var(--surface-2); color: var(--text-2); font-size: 13px; font-weight: 600;
  }
}
.gh-cbox { flex: 1; min-width: 0; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.gh-ctop {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 10px; background: var(--surface-1); border-bottom: 1px solid var(--border);
  font-size: 12.5px;
  .gh-cauthor { font-weight: 600; color: var(--text); cursor: pointer; &:hover { color: var(--primary); } }
  .gh-ctime { color: var(--text-3); }
  .gh-cdel {
    margin-left: auto; border: 0; background: transparent; cursor: pointer;
    color: var(--text-3); font-size: 12px; font-family: inherit; padding: 0;
    &:hover { color: #dc2626; }
  }
}
.gh-ctext { padding: 9px 10px; font-size: 13.5px; line-height: 1.65; color: var(--text); white-space: pre-wrap; overflow-wrap: anywhere; }
.gh-cempty { color: var(--text-3); font-size: 13px; padding: 4px 0 14px; }

.gh-cinput { display: flex; gap: 8px; }
</style>
