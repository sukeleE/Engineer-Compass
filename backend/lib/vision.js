// 报销票据图片视觉识别（2026-09-10）：智谱 GLM-4V 系（OpenAI 兼容 POST /chat/completions）
// 与 ai.js（DeepSeek 纯文本）完全独立 —— 键/模型/接口地址各走 VISION_* 环境变量：
//   VISION_API_KEY：智谱开放平台 key（open.bigmodel.cn 申请，形如 id.secret）
//   VISION_MODEL：默认 glm-4.6v-flash（新免费视觉模型，支持 base64/本地图，128K 上下文；
//     老 glm-4v-flash 不支持 base64 只接受图片 URL —— 勿用）；VISION_BASE_URL 可换其它兼容网关
// 职责只到「图片 → 结构化 JSON」：不落库、不写行 —— 识别结果由前端预填表单、人工确认后照常走行 CRUD；
// 看不清的字段宁可不填也不编造（模型输出按类别字段白名单归一后返回，拿不准一律空）
// ⚠️ 响应解析：glm-4.6v-flash 是「思考型」模型 —— 答案在 choices[0].message.content、
//   思考过程在 reasoning_content。必须经 extractModelText 取正文，切勿把整个响应体丢给 JSON 解析
//   （曾因此让识别功能整段静默失效：信封对象解析成功但 fields 恒空，见 extractModelText 注释）
// 错误契约：key 未配置/限流/超时等统一抛 VisionError(message, hint)，路由层转 502 {error, hint}
import { FIELDS, catMeta } from './expenseMeta.js';

const VISION_URL = () => process.env.VISION_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const VISION_MODEL = () => process.env.VISION_MODEL || 'glm-4.6v-flash';
const MAX_TOKENS = 1024; // flash 系 max_tokens 设高会 400（老 glm-4v-flash 上限 1024）
const TIMEOUT_MS = 90_000; // 视觉推理较慢：默认 90s（前端 fetch 余量 120s）
const EXTRA_MAX = 6; // extra 参考信息条数上限（只读展示，不写行）

export class VisionError extends Error {
  constructor(message, hint = '') {
    super(message);
    this.name = 'VisionError';
    this.hint = hint;
  }
}

// ---- 可自动回填的字段（类别 FIELDS 白名单子集）----
// 排除：归属/权限锚点（购买人）、自由文本（备注）、范围键（统一支付范围）、票面无从判断的（是否日常家用）
const VISION_SKIP_KEYS = new Set(['购买人', '备注', '统一支付范围', '是否日常家用']);
const VISION_TYPES = new Set(['text', 'money', 'date', 'yn']);
export function visionFieldList(cat) {
  return (FIELDS[cat] || []).filter((f) => VISION_TYPES.has(f.type) && !VISION_SKIP_KEYS.has(f.key));
}
// extra 白名单：票面其余对核对有用的信息 —— 只作参考展示，绝不写回 data
export const VISION_EXTRA_KEYS = ['乘车人', '座位号', '发票号码', '发票代码', '开票日期', '销售方名称', '购方名称', '证件号'];

const fieldSpec = (f) => (f.type === 'money' ? '纯数字、最多两位小数，不带￥/元字'
  : f.type === 'date' ? '仅输出 YYYY-MM-DD'
    : f.type === 'yn' ? '只能输出"是"或"否"'
      : '短文本，按票面原样输出勿改写');

function buildSystemPrompt(cat) {
  const zh = catMeta(cat)?.zh || '票据';
  const fs = visionFieldList(cat);
  const spec = fs.length ? fs.map((f) => `"${f.key}"：${fieldSpec(f)}`).join('\n')
    : '（无可用字段 —— 返回空 fields 即可）';
  return `你是报销票据 OCR 识别助手。识别用户上传的「${zh}」票据图片，只输出一个 json 对象，不要任何多余文字、不要 markdown 代码块。
本类别可输出的字段（键名必须与下列完全一致，多余键一律丢弃）：
${spec}
规则：
1. 图片看不清、票据正文无法确认的值一律输出空字符串 ""，禁止编造、猜测或脑补，宁可空。
2. 金额取票面「价税合计(小写)」；日期按票面日期规整为 YYYY-MM-DD；火车票车次如 G1234（字母数字原样）。
3. 火车票：出发时间=票面乘车日期；到达时间=票面到站日期（未印则空）；出发地/到达地为站名（可含"站"字）；座位等级如 二等座/硬卧/一等座。
4. 出钱人/购买人、涵盖范围、备注、是否日常家用 等一律不识别、不输出。
5. 其他对人工核对有用的票面信息（如 乘车人/座位号/发票号码/发票代码/开票日期/销售方名称/购方名称，最多 ${EXTRA_MAX} 项）放入 extra，每项为 {"k":"键名","v":"值"}。
最终输出形如 {"fields":{...},"extra":[...]}："fields" 必须存在（无可识别项时为空对象），"extra" 无内容时为空数组。`;
}

// ---- 值归一（与 expenseMeta.normData 语义对齐：类型不符/非法一律空）----
const pad2 = (n) => String(n).padStart(2, '0');
function normMoney(v) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Math.round(Number(v) * 100) / 100;
  return Number.isFinite(n) && n >= 0 ? n : '';
}
function normDateStr(v) {
  const s = String(v ?? '').trim();
  const m = s.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/);
  if (!m) return '';
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
  return `${y}-${pad2(mo)}-${pad2(d)}`;
}
function normYn(v) {
  const s = String(v ?? '').trim();
  if (s === '是' || s === 'true' || s === '1') return '是';
  if (s === '否' || s === 'false' || s === '0' || s === '无') return '否';
  return '';
}
function normByType(f, v) {
  if (f.type === 'money') return normMoney(v);
  if (f.type === 'date') return normDateStr(v);
  if (f.type === 'yn') return normYn(v);
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  return s.slice(0, f.max || 40);
}

// ---- 与视觉服务通信 ----
async function postOnce(body, timeoutMs) {
  const key = String(process.env.VISION_API_KEY || '').trim();
  const resp = await fetch(VISION_URL(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text().catch(() => '');
  if (resp.status === 429) {
    throw new VisionError('识别服务繁忙（免费模型限流 429），请稍后重试', '稍等几分钟再试，或升级模型配额');
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new VisionError(`识别服务鉴权失败（${resp.status}）—— 检查 VISION_API_KEY 是否有效`, 'VISION_API_KEY 在服务器 .env 中配置，形如 id.secret（open.bigmodel.cn 申请）');
  }
  if (resp.status === 502 || resp.status === 503 || resp.status === 504) {
    throw new VisionError('识别服务暂不可用，请稍后重试', `识别服务返回 ${resp.status}，可检查 VISION_BASE_URL/VISION_MODEL 配置`);
  }
  if (!resp.ok) return { status: resp.status, text }; // 交上层决策（400 去 response_format 重试等）
  return { status: resp.status, text };
}

// 取模型正文（2026-09-10 修，此前的实现让整个识别功能静默失效）：
//   glm-4.6v-flash 是「思考型」模型 —— 最终答案在 choices[0].message.content，
//   思考过程在同级 reasoning_content。早前版本把「整个 HTTP 响应体」交给 parseModelJson 做贪心
//   /\{[\s\S]*\}/ 匹配：匹配到的是最外层信封对象且 JSON.parse 成功 → parsed.fields 恒为 undefined
//   → 恒返回空 fields，前端提示「未识别到可回填的字段（图片模糊？）」—— 模型其实答得完全正确。
// 返回 {text, finish, reasoningLen}：text=正文；finish=finish_reason；
//   reasoningLen>0 且 text 空 = 思考烧光 max_tokens 被截断（finish=length），需上层给明确文案而非静默空
export function extractModelText(bodyText) {
  let env = null;
  try { env = JSON.parse(String(bodyText || '')); } catch { /* 非标准信封：回落原文 */ }
  const ch = env?.choices?.[0];
  if (!ch?.message) return { text: String(bodyText || ''), finish: '', reasoningLen: 0 };
  const msg = ch.message;
  let c = msg.content;
  if (Array.isArray(c)) c = c.map((x) => (typeof x === 'string' ? x : x?.text || '')).join(''); // 兼容多模态数组
  return {
    text: typeof c === 'string' ? c : '',
    finish: String(ch.finish_reason || ''),
    reasoningLen: String(msg.reasoning_content || '').length,
  };
}

function parseModelJson(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (m) s = m[0];
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}

// 主入口：category（六类键）+ images=[{mime:'image/jpeg', b64:'…'}] → {fields:{中文键:值}, extra:[{k,v}], warnings:[]}
export async function callVision(category, images, { timeoutMs = TIMEOUT_MS } = {}) {
  const key = String(process.env.VISION_API_KEY || '').trim();
  if (!key) {
    throw new VisionError('未配置视觉识别服务（VISION_API_KEY）—— 图片识别暂不可用，可先手动填表',
      '检查 .env 中的 VISION_API_KEY：智谱开放平台申请（open.bigmodel.cn，key 形如 id.secret），配置后重启后端即可识别');
  }
  if (!images || !images.length) throw new VisionError('缺少待识别图片');
  const zh = catMeta(category)?.zh || '票据';
  const msgs = [
    { role: 'system', content: buildSystemPrompt(category) },
    {
      role: 'user',
      content: [
        { type: 'text', text: `请识别这张${zh}票据图片（类别 ${category}）。按上述要求只输出 json。` },
        ...images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.b64}` } })),
      ],
    },
  ];
  const bodyBase = { model: VISION_MODEL(), messages: msgs, temperature: 0.1, max_tokens: MAX_TOKENS };
  const warnings = [];
  let out = await postOnce({ ...bodyBase, response_format: { type: 'json_object' } }, timeoutMs);
  // 部分视觉模型不支持 response_format 参数（400 带该字样）→ 去掉再试一次；prompt 本身已约束 json 输出
  if (out.status === 400 && out.text.includes('response_format')) {
    warnings.push('当前视觉模型不支持 json 模式，已按宽松模式识别');
    out = await postOnce(bodyBase, timeoutMs);
  }
  if (out.status !== 200) {
    if (out.status === 400) {
      throw new VisionError(`识别服务拒绝了请求（400）：${String(out.text || '').slice(0, 160)}`,
        '多为图片格式/模型名问题 —— 仅支持 jpg/png/webp/gif/bmp，图片建议 <10MB，或检查 VISION_MODEL 拼写');
    }
    throw new VisionError(`识别服务返回异常（${out.status}），请稍后重试`, '可检查 VISION_BASE_URL/VISION_MODEL 配置');
  }
  // 正文只取 choices[0].message.content（见 extractModelText 注释：此处曾整段静默失效）
  let got = extractModelText(out.text);
  if (!got.text.trim() && (got.finish === 'length' || got.reasoningLen > 0)) {
    // 思考型模型把 max_tokens 烧在 reasoning 上 → content 空。升配额重试一次
    // （老 glm-4v-flash 上限 1024，升配额会 400 —— 那就保持空，由下方给出明确文案）
    const out2 = await postOnce({ ...bodyBase, max_tokens: Math.max(MAX_TOKENS * 4, 4096) }, timeoutMs);
    if (out2.status === 200) {
      const got2 = extractModelText(out2.text);
      if (got2.text.trim()) { got = got2; warnings.push('模型思考较长，已自动提高输出配额重试成功'); }
    }
  }
  if (!got.text.trim()) {
    throw new VisionError('识别失败：模型这次没给出结果（思考超长被截断）—— 请重试一次',
      '思考型视觉模型先"想"再答，偶尔想太久没能输出。直接再点一次通常即可；连续失败可换更清晰或裁剪后的票据图');
  }
  const parsed = parseModelJson(got.text);
  if (!parsed) throw new VisionError('识别结果不是合法 JSON，请重试或换一张更清晰的图片', '模型偶发乱码：直接再点一次识别，或把票据拍正/光线充足');

  // fields：只留本类别可自动回填键、值类型归一、空值丢弃
  const fields = {};
  for (const f of visionFieldList(category)) {
    const v = normByType(f, parsed.fields?.[f.key]);
    if (v !== '' && v !== null && v !== undefined) fields[f.key] = v;
  }
  // extra：白名单键、trim ≤30、同键去重留首、限条数
  const extra = [];
  const seen = new Set();
  const rawExtra = Array.isArray(parsed.extra) ? parsed.extra : [];
  for (const x of rawExtra.slice(0, EXTRA_MAX * 3)) {
    const k = String(x?.k || '').trim();
    const v = String(x?.v || '').trim().replace(/\s+/g, ' ').slice(0, 30);
    if (k && v && VISION_EXTRA_KEYS.includes(k) && !seen.has(k)) {
      seen.add(k);
      extra.push({ k, v });
    }
    if (extra.length >= EXTRA_MAX) break;
  }
  return { fields, extra, warnings };
}
