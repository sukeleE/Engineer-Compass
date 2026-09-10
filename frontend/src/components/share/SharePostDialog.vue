<script setup>
// 发帖 / 编辑帖子弹窗（列表页与详情页共用）
// 从 ShareView.vue 整体抽出：表单状态、附件读入、飞书三按钮、从飞书导入都在这里，
// 两个页面只负责「打开」和「收到 changed 后刷新自己那份数据」——
// 否则同一套逻辑要在列表页和详情页各留一份，必然漂移。
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../../api.js';
import auth from '../../auth.js';
import { fmtSize } from '../../utils/share.js';
import RichEditor from '../team/RichEditor.vue';
import DocPicker from '../team/DocPicker.vue';
import { normAtts } from '../team/AttachmentList.vue';
import ResourcePicker from '../ResourcePicker.vue';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  // 待编辑的帖子（完整详情对象）；null / 不传 = 新建
  editing: { type: Object, default: null },
  tagList: { type: Array, default: () => [] },
  // 幽灵页（/ghost-share）：发帖恒为幽灵帖，且不显示归属勾选
  ghost: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue', 'changed']);

// 不做本地 visible 镜像：直接透传 modelValue，避免「本地 ref 与父层 prop 各说各话」
// 那种关闭后再次打开不重置表单的经典错位。打开瞬间初始化表单即可。
watch(() => props.modelValue, (v) => { if (v) init(); });

const form = ref({ title: '', content: '', atts: [], tags: [], files: [], giteeRepo: '', giteeRef: '', isGhost: true }); // isGhost：幽灵用户发帖默认「仅怪奇可见」
const editingId = ref(null);
const fileInput = ref(null);
const MAX_ATT_TOTAL = 25 * 1024 * 1024;

// 项目文件夹（一条帖子 = 一个项目）：files 是**全量**清单，保存时整树替换
// filesKnown=false 表示手上没有权威清单（编辑态但详情没带回 files）——此时禁用文件夹操作，
// 否则「只带新增 id 提交」会把原文件夹整树清掉（PUT 是 purge + 重绑语义）
const filesKnown = ref(true);
// 同理：编辑态但详情没带回 gitee_repo 时**不提交这个字段**（PUT 是「空串=解绑」，
// 拿不准就不表态，否则一次改标题会把仓库绑定抹掉）
const giteeKnown = ref(true);

function init() {
  feishuOpened.value = false;
  folOpen.value = false;
  folFail.value = [];
  giteePre.value = null;
  giteeErr.value = '';
  if (props.editing) {
    editingId.value = props.editing.id;
    // 必须浅拷贝：normAtts 对数组入参返回**同一引用**，直接赋值会让编辑器的附件数组
    // 与详情页里那份是同一个 —— 删个 chip 就当场改掉了背后的帖子，取消也回滚不了
    const atts = normAtts(props.editing.attachments).map((a) => ({ ...a }));
    filesKnown.value = Array.isArray(props.editing.files);
    giteeKnown.value = 'gitee_repo' in props.editing;
    form.value = {
      title: props.editing.title,
      content: props.editing.content,
      atts,
      tags: [...(props.editing.tags || [])],
      files: (props.editing.files || []).map((f) => ({ ...f })),
      giteeRepo: props.editing.gitee_repo || '',
      giteeRef: props.editing.gitee_ref || '',
      isGhost: true,
    };
  } else {
    editingId.value = null;
    filesKnown.value = true;
    giteeKnown.value = true;
    form.value = { title: '', content: '', atts: [], tags: [], files: [], giteeRepo: '', giteeRef: '', isGhost: true };
  }
}

const attPick = (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  for (const f of files) {
    if (f.size > 10 * 1024 * 1024) { ElMessage.warning(`「${f.name}」超过 10MB 上限`); continue; }
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result).split(',')[1];
      const total2 = form.value.atts.reduce((s, a) => s + (a.data || '').length, 0) + data.length;
      if (total2 > MAX_ATT_TOTAL) { ElMessage.warning('附件总量超限（≤25MB）'); return; }
      form.value.atts.push({ name: f.name, size: f.size, mime: f.type || 'application/octet-stream', data });
    };
    reader.readAsDataURL(f);
  }
};

// —— 项目文件夹上传（webkitdirectory → 相对路径 → 分批 multipart）——
// 服务端每请求限 10 个文件 / 30MB（multer limits 硬约束），客户端据此分批；
// 超 30MB 的文件在这里就先挡掉并给出逐文件原因，省的为必失败的文件白传一遍。
const folInput = ref(null);
const folBusy = ref(false);
const folProg = ref('');
const folOpen = ref(false);      // 展开文件清单
const folFail = ref([]);         // 逐文件失败原因（路径非法 / 超限 / 网络）
const MAX_FILE = 30 * 1024 * 1024;
const FOLDER_MAX = 200 * 1024 * 1024; // 与服务端 shareFiles.js 的 FOLDER_MAX 一致（仅前置提示，服务端仍会校验）
const BATCH = 10;

const rel = (f) => f.webkitRelativePath || f.name;
// 体积只算本站磁盘上的文件：Gitee 条目不落盘，算进 200MB 配额会让人莫名其妙撞上限
const folTotal = computed(() => form.value.files.filter((f) => f.source !== 'gitee').reduce((s, f) => s + (Number(f.size) || 0), 0));
const giteeRows = computed(() => form.value.files.filter((f) => f.source === 'gitee'));

// —— Gitee 仓库（公开仓库免 token 直连；SSRF 闸门在服务端 lib/gitee.js）——
// 这里只做「预览」：把仓库地址交给服务端拉一次树，现显示「已拉取 N 个文件」，
// 让用户确认拉对了仓库再发布。真正的入库在提交时由服务端**自己重拉一遍**
// ——绝不把这棵树当成表单数据提交（否则谁都能给别人的帖子伪造任意路径）。
const giteeBusy = ref(false);
const giteePre = ref(null); // { repo, ref, count, truncated }
const giteeErr = ref('');
async function giteePreview() {
  const repo = form.value.giteeRepo.trim();
  if (!repo) return ElMessage.warning('先填仓库地址，如 owner/repo');
  giteeBusy.value = true; giteeErr.value = ''; giteePre.value = null;
  try {
    giteePre.value = await api.shareGiteeTree(repo, form.value.giteeRef.trim());
  } catch (e) {
    giteeErr.value = e.message + (e.hint ? `（${e.hint}）` : '');
  } finally { giteeBusy.value = false; }
}
const giteeClear = () => { form.value.giteeRepo = ''; form.value.giteeRef = ''; giteePre.value = null; giteeErr.value = ''; };

async function folPick(e) {
  const picked = [...(e.target.files || [])];
  e.target.value = ''; // 同一目录再选一次也能触发 change
  if (!picked.length) return;
  if (!filesKnown.value) return ElMessage.warning('这份帖子详情没带回文件清单，请从帖子详情页进编辑再传');
  if (form.value.files.length + picked.length > 2000) return ElMessage.warning('单个项目最多 2000 个文件');

  const ok = [], tooBig = [];
  for (const f of picked) (f.size > MAX_FILE ? tooBig : ok).push(f);
  folFail.value = tooBig.map((f) => `${rel(f)}：超过 30MB 单文件上限`);

  // 配额前置提示：服务端按「暂存总量」（= 这一个待发项目）卡 200MB，超了会白传一遍再被拒
  const sum = ok.reduce((s, f) => s + f.size, 0);
  const bound = form.value.files.filter((f) => !f._new).reduce((s, f) => s + (Number(f.size) || 0), 0);
  if (bound + sum > FOLDER_MAX) {
    return ElMessage.warning(`项目文件夹上限 200MB，本次会超出（已选 ${fmtSize(bound + sum)}），请拆分成多个帖子`);
  }

  folBusy.value = true;
  let added = 0;
  try {
    for (let i = 0; i < ok.length; i += BATCH) {
      const b = ok.slice(i, i + BATCH);
      folProg.value = `上传中 ${Math.min(i + BATCH, ok.length)}/${ok.length} 个文件…`;
      try {
        const r = await api.shareUploads(b, b.map(rel));
        for (const row of r.rows || []) form.value.files.push({ ...row, _new: true });
        added += (r.rows || []).length;
        for (const x of r.rejected || []) folFail.value.push(`${x.path}：${x.reason}`);
      } catch (err) {
        // 一批失败不中断后续批次：网络抖动/单批超限时其余文件仍能传上去
        for (const f of b) folFail.value.push(`${rel(f)}：${err.message}`);
      }
    }
  } finally {
    folBusy.value = false;
    folProg.value = '';
  }
  if (added) folOpen.value = true;
  if (added) ElMessage.success(`已加入 ${added} 个文件${folFail.value.length ? `，${folFail.value.length} 个失败` : ''}`);
  else if (folFail.value.length) ElMessage.error(`全部失败，原因见下方清单`);
}

// 移除一个文件。已绑帖的旧文件在服务端是「整树替换」，所以这里只是从清单里划掉，
// 保存时才真正落库删盘；尚未提交的新文件顺带把暂存行删掉（否则白占配额）
async function folRemove(i) {
  const f = form.value.files[i];
  if (!f) return;
  form.value.files.splice(i, 1);
  if (f._new && f.id) {
    try { await api.shareFileDrop(f.id); } catch { /* 删不掉就留给服务端 sweep（24h）兜 */ }
  }
}

// 从「我的资源」引用：选中后生成/复用分享链接，push 引用型附件条目（无 data 有 url）
const resPickDlg = ref(false);
const impDlg = ref(false);   // 从飞书导入文档选择器
const onResourcePick = (r) => {
  form.value.atts.push({ name: r.name, size: r.size, mime: r.mime, url: r.url });
  ElMessage.success(`已引用「${r.name}」`);
};

async function submit() {
  if (!form.value.title.trim()) return ElMessage.warning('标题必填');
  if (folBusy.value) return ElMessage.warning('文件夹还在上传，等传完再发布');
  const text = form.value.content.replace(/<[^>]*>/g, '').trim();
  if (!text && !form.value.atts.length && !form.value.files.length && !form.value.giteeRepo.trim()) {
    return ElMessage.warning('写点内容或附上资源');
  }
  const wasEditing = !!editingId.value;
  // 只传 id（服务端只认本人名下、未绑帖的暂存行；已绑帖的旧 id 命不中 UPDATE 但本就在树上）
  const fileIds = form.value.files.map((f) => f.id).filter(Boolean);
  const fileArg = filesKnown.value ? fileIds : undefined; // 清单不可信时**别传这个字段**（PUT 是整树替换，传空=清空文件夹）
  // gitee_repo 是三态字段：缺省不动 / 空串解绑 / 有值则由服务端重拉。同样「拿不准就不传」
  const giteeArg = giteeKnown.value ? { gitee_repo: form.value.giteeRepo.trim(), gitee_ref: form.value.giteeRef.trim() } : {};
  try {
    let res;
    if (wasEditing) {
      res = await api.shareUpdate(editingId.value, { title: form.value.title, content: form.value.content, attachments: form.value.atts, tags: form.value.tags, files: fileArg, ...giteeArg });
      ElMessage.success('帖子已更新');
    } else {
      // 幽灵帖归属：秘密分享页恒为幽灵帖；普通页幽灵用户由「仅怪奇可见」勾选决定；普通用户恒普通帖
      const isGhost = props.ghost ? 1 : (auth.user?.is_ghost ? (form.value.isGhost ? 1 : 0) : 0);
      res = await api.shareCreate({ title: form.value.title, content: form.value.content, attachments: form.value.atts, tags: form.value.tags, files: fileArg, is_ghost: isGhost, ...giteeArg });
      editingId.value = res.id;
      ElMessage.success(props.ghost ? '👻 秘密帖子发布成功' : '🚀 开楼成功');
    }
    // 帖子已保存，但 Gitee 没拉成功（限流/断网/仓库改名）：如实说一声，别让人以为仓库已经挂上了。
    // 正文与文件都已入库，用户可在详情页点「同步仓库」重试，不用重打一遍。
    if (res?.gitee_error) ElMessage.warning(`帖子已保存，但仓库没绑上：${res.gitee_error}${res.gitee_hint ? `（${res.gitee_hint}）` : ''}`);
    emit('update:modelValue', false);
    emit('changed', { id: editingId.value, isNew: !wasEditing });
  } catch (e) { ElMessage.error(e.message); }
}

// —— 飞书编辑（P1）：分享帖 ↔ 飞书文档 ——
// 「飞书编辑」= 创建/打开飞书文档（新建自动带存量内容 + 自动同步回库）；「从飞书同步」= 手动拉取最新
const feishuBusy = ref(false);
const feishuOpened = ref(false); // 本次编辑已打开飞书（显示「飞书编辑中」状态条）
async function feishuEdit() {
  let pid = editingId.value;
  // 新建帖尚未发布：有草稿先发布创建帖子拿 id；空内容直接让后端自动创建（share_post 需 title）
  if (!pid) {
    if (!form.value.title.trim()) return ElMessage.warning('先填标题，再转飞书编辑');
    const text = form.value.content.replace(/<[^>]*>/g, '').trim();
    if (text || form.value.atts.length || form.value.files.length) {
      try {
        // 带上 files：否则「先传文件夹再点飞书编辑」的路径会把暂存行落成孤儿（永远绑不上帖）
        const r = await api.shareCreate({
          title: form.value.title, content: form.value.content, attachments: form.value.atts,
          tags: form.value.tags, files: filesKnown.value ? form.value.files.map((f) => f.id).filter(Boolean) : undefined,
        });
        pid = r.id;
        editingId.value = pid;
        emit('changed', { id: pid, isNew: true });
      } catch (e) { ElMessage.error(e.message); return; }
    }
  }
  feishuBusy.value = true;
  try {
    const r = await api.feishuBizOpen('share_post', pid ?? null, { title: form.value.title });
    feishuOpened.value = true;
    window.open(r.url, '_blank');
    ElMessage.success(r.created ? '已创建飞书文档并打开，可在飞书里完善内容' : '已同步最新内容，飞书文档已打开');
    emit('changed', { id: pid, isNew: false });
  } catch (e) { ElMessage.error(e.message); }
  finally { feishuBusy.value = false; }
}

async function feishuSync() {
  const pid = editingId.value;
  if (!pid) return ElMessage.warning('请先发布帖子或点「飞书编辑」创建文档');
  feishuBusy.value = true;
  try {
    const r = await api.feishuBizSync('share_post', pid);
    ElMessage.success(r.message || '✅ 已从飞书同步');
    emit('changed', { id: pid, isNew: false });
  } catch (e) { ElMessage.error(e.message); }
  finally { feishuBusy.value = false; }
}

// 从飞书导入：内容回填编辑器；无帖子时后端自动创建（id 绑定编辑态，提交走更新而非新建）
function onImported(html, id) {
  form.value.content = html;
  if (id) editingId.value = id;
  emit('changed', { id: id || editingId.value, isNew: false });
}
</script>

<template>
  <!-- 结构保持原样：App.vue 的 .editor-dlg .el-dialog__body > .el-select 是直接子元素选择器 -->
  <el-dialog :model-value="modelValue" :title="editingId ? '✏️ 编辑帖子' : '📝 开楼发帖'" width="720px" top="3vh"
    class="editor-dlg" :close-on-click-modal="false" destroy-on-close append-to-body
    @update:model-value="emit('update:modelValue', $event)">
    <el-input v-model="form.title" maxlength="60" show-word-limit placeholder="帖子标题（≤60 字）" class="sh-title" />
    <div class="sh-tools">
      <input ref="fileInput" type="file" multiple hidden @change="attPick" />
      <el-button size="small" @click="fileInput.click()">📎 附件（图片/视频/音频/文件）</el-button>
      <el-button size="small" plain @click="resPickDlg = true">📁 我的资源</el-button>
      <span v-if="form.atts.length" class="att-chips">
        <el-tag v-for="(a, i) in form.atts" :key="i" closable size="small" class="att-tag" :title="a.name"
          @close="form.atts.splice(i, 1)">
          {{ a.name }}
        </el-tag>
      </span>
    </div>
    <!-- 项目文件夹：一条帖子 = 一个项目，整棵树保存（详见 utils/share.js 的 buildTree） -->
    <div class="sh-tools" style="margin-bottom:6px">
      <input ref="folInput" type="file" webkitdirectory multiple hidden @change="folPick" />
      <el-button size="small" :loading="folBusy" :disabled="!filesKnown" @click="folInput.click()">
        📁 上传文件夹（项目制）
      </el-button>
      <span v-if="folProg" class="fol-prog">{{ folProg }}</span>
      <template v-else-if="form.files.length">
        <button class="fol-sum" @click="folOpen = !folOpen">
          📦 {{ form.files.length }} 个文件 · {{ fmtSize(folTotal) }}
          <span v-if="folNew" class="fol-new">（其中 {{ folNew }} 个本次新传）</span>
          {{ folOpen ? '▾' : '▸' }}
        </button>
      </template>
      <span v-else-if="!filesKnown" class="fol-hint">文件清单未加载，请在帖子详情页编辑</span>
      <span v-else class="fol-hint">把整个文件夹拖进来式上传，浏览时按目录树展开</span>
    </div>
    <div v-if="folOpen && form.files.length" class="fol-list">
      <div v-for="(f, i) in form.files" :key="f.id || f.path" class="fol-item" :class="{ fresh: f._new }">
        <span class="fol-path" :title="f.path">{{ f.path }}</span>
        <!-- Gitee 条目的增删由仓库地址决定（保存时服务端重拉整树），不在这里逐个摘 -->
        <span v-if="f.source === 'gitee'" class="fol-gt">Gitee</span>
        <span class="fol-size">{{ fmtSize(f.size) }}</span>
        <button v-if="f.source !== 'gitee'" class="fol-del" title="移除" @click="folRemove(i)">✕</button>
      </div>
    </div>
    <div v-if="folFail.length" class="fol-fail">
      <p><b>{{ folFail.length }} 个文件未上传：</b></p>
      <p v-for="(x, i) in folFail" :key="i">{{ x }}</p>
      <button class="fol-ok" @click="folFail = []">知道了</button>
    </div>

    <!-- Gitee 仓库：粘贴仓库地址 → 服务端拉一次树做确认 → 保存时再拉一次入库（客户端传的树一律不采信） -->
    <div class="gt-box">
      <div class="gt-row">
        <span class="gt-label">Gitee 仓库</span>
        <el-input v-model="form.giteeRepo" size="small" class="gt-repo" clearable
          placeholder="owner/repo 或 https://gitee.com/owner/repo（公开仓库，可不填）" />
        <el-input v-model="form.giteeRef" size="small" class="gt-ref" placeholder="分支/标签（默认主分支）" />
        <el-button size="small" :loading="giteeBusy" :disabled="!form.giteeRepo.trim()" @click="giteePreview">拉取预览</el-button>
        <el-button v-if="form.giteeRepo.trim()" size="small" text @click="giteeClear">清空</el-button>
      </div>
      <p v-if="giteeErr" class="gt-err">⚠️ {{ giteeErr }}</p>
      <p v-else-if="giteePre" class="gt-ok">
        ✅ {{ giteePre.repo }}<template v-if="giteePre.ref"> @{{ giteePre.ref }}</template>
        共 {{ giteePre.count }} 个文件<template v-if="giteePre.truncated">（超过 500 个，只收录前 500）</template>
        —— 发布时按这个清单入库，可点文件在线预览
      </p>
      <p v-else-if="giteeRows.length" class="gt-hint">当前已绑定 {{ giteeRows.length }} 个仓库文件；点「拉取预览」可看最新清单</p>
      <p v-else class="gt-hint">公开仓库免配置直连；拉的是文件清单（不下载文件内容），浏览时按需代理取用</p>
    </div>

    <!-- 可切到飞书文档里写长文（P1）；新建帖点按钮自动发布后再编辑；打开后本站留窗显示状态条 -->
    <div class="sh-tools" style="margin-bottom:6px">
      <el-button size="small" type="primary" plain :loading="feishuBusy" @click="feishuEdit">✏️ 飞书编辑（长文在飞书写）</el-button>
      <el-button size="small" plain :loading="feishuBusy" @click="feishuSync">🔄 从飞书同步</el-button>
      <el-button size="small" plain @click="impDlg = true">📥 从飞书导入</el-button>
    </div>
    <div v-if="feishuOpened" class="pd-feishu-open">
      ✅ 已在飞书打开该文档 — 在飞书写完后点「🔄 从飞书同步」更新到这里
    </div>
    <RichEditor v-model="form.content" placeholder="分享资料说明 / 备赛经验 / 作品展示…" />
    <el-select v-model="form.tags" multiple filterable allow-create default-first-option :multiple-limit="5"
      placeholder="索引标签（≤5 个，自建即成为子板块）" class="sh-tags">
      <el-option v-for="t in tagList" :key="t.name" :value="t.name" :label="`#${t.name}`" />
    </el-select>
    <!-- 幽灵用户发帖归属（秘密分享页恒为幽灵帖，无需勾选） -->
    <el-checkbox v-if="!ghost && auth.user?.is_ghost" v-model="form.isGhost" class="sh-ghost-chk">
      👻 仅怪奇可见（幽灵帖，普通用户看不到）
    </el-checkbox>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" @click="submit">{{ editingId ? '保存修改' : '发布' }}</el-button>
    </template>
  </el-dialog>
  <!-- 从飞书导入文档选择器（必须挂弹窗外面——弹窗 destroy-on-close 会销毁内部组件，导入按钮将无反应） -->
  <DocPicker v-model="impDlg" biz-type="share_post" :biz-id="editingId ?? null"
    :extra="{ title: form.title }" @imported="onImported" />
  <ResourcePicker v-model="resPickDlg" @pick="onResourcePick" />
</template>

<style lang="scss" scoped>
.sh-title { margin-bottom: 10px; }
.sh-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px;
  .att-chips { display: flex; gap: 4px; flex-wrap: wrap; }
  // 附件名不换行：过长省略号 + title 悬浮全名（断行会竖排挤压排版）
  .att-tag {
    max-width: 240px; vertical-align: middle;
    :deep(.el-tag__content) {
      display: inline-block; max-width: 200px; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; vertical-align: middle;
    }
  }
}
.sh-tags { width: 100%; margin-top: 10px; }
.sh-ghost-chk { margin: 8px 0 2px; font-size: 13px; color: var(--primary); }

// —— 项目文件夹清单 ——
.fol-prog { font-size: 12.5px; color: var(--primary); }
.fol-hint { font-size: 12px; color: var(--text-3); }
.fol-sum {
  border: 0; background: transparent; cursor: pointer; font-family: inherit;
  font-size: 12.5px; color: var(--text-2); padding: 0;
  &:hover { color: var(--text); }
  .fol-new { color: var(--primary); }
}
.fol-list {
  max-height: 168px; overflow: auto; margin-bottom: 10px;
  border: 1px solid var(--border); border-radius: 6px; background: var(--surface-3);
}
.fol-item {
  display: flex; align-items: center; gap: 8px; padding: 4px 8px; font-size: 12px; color: var(--text-2);
  & + .fol-item { border-top: 1px solid var(--border); }
  &.fresh .fol-path { color: var(--primary); }
}
.fol-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fol-size { flex: none; color: var(--text-3); }
.fol-gt {
  flex: none; font-size: 10.5px; padding: 0 6px; border-radius: 999px;
  background: var(--primary-tint); color: var(--primary); border: 1px solid var(--border-2);
}
.fol-del {
  flex: none; border: 0; background: transparent; cursor: pointer; color: var(--text-3);
  font-size: 13px; line-height: 1; padding: 0 2px;
  &:hover { color: var(--primary); }
}
.fol-fail {
  margin-bottom: 10px; padding: 6px 10px; border-radius: 6px; font-size: 12px;
  color: var(--danger-fg, #d1242f); background: var(--danger-tint); border: 1px solid var(--danger-border, #ffc1c0);
  p { margin: 2px 0; word-break: break-all; }
  .fol-ok { margin-top: 4px; border: 1px solid var(--border-2); background: var(--card-bg); color: var(--text-2); border-radius: 6px; padding: 1px 8px; cursor: pointer; font-family: inherit; font-size: 12px; }
}

// —— Gitee 仓库行 ——
.gt-box {
  margin-bottom: 10px; padding: 8px 10px;
  border: 1px solid var(--border); border-radius: 6px; background: var(--surface-3);
}
.gt-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.gt-label { flex: none; font-size: 12.5px; color: var(--text-2); }
.gt-repo { flex: 1 1 260px; min-width: 200px; }
.gt-ref { flex: 0 1 150px; min-width: 120px; }
.gt-err { margin: 6px 0 0; font-size: 12px; color: var(--danger-fg, #d1242f); }
.gt-ok { margin: 6px 0 0; font-size: 12px; color: var(--success-fg); }
.gt-hint { margin: 6px 0 0; font-size: 12px; color: var(--text-3); }

// 编写留窗状态条：飞书打开后提示回站同步
.pd-feishu-open {
  font-size: 12.5px; color: var(--success-fg); background: var(--success-tint); border: 1px solid var(--success-border);
  border-radius: 8px; padding: 6px 12px; margin-bottom: 6px;
}
</style>
