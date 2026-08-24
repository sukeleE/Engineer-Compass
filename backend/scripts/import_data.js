// 导入脚本：解析 竞赛数据/*.md → SQLite 种子数据（84项竞赛 / 子赛项 / 技术栈树）
// 用法：npm run import   （幂等：先清空三张表再导入）
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../db/database.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', '竞赛数据');
const DATA_YEAR = 2025; // 数据整理基准年

// ---------- 解析工具 ----------

// "- **简称**：电赛" → ["简称", "电赛"]
function parseKV(line) {
  const m = line.match(/^\s*-\s*\*\*([^*]+)\*\*[：:]\s*(.*)$/);
  return m ? [m[1].trim(), m[2].trim()] : null;
}

// 时间线文本 → 结构化字段
// "校内选拔约4-5月｜报名约5-6月｜全国竞赛约8月（奇数年，四天三夜）（时间可能逐年变动）"
function parseTimeline(raw) {
  const t = { sign_start: null, sign_end: null, province_time: null, national_time: null, start_month: null };
  const parts = raw.split('｜').map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    if (p.startsWith('报名')) t.sign_start = p;
    else if (p.startsWith('省赛')) t.province_time = p;
    else if (p.startsWith('全国') || p.startsWith('国赛') || p.startsWith('总决赛')) t.national_time = p;
    if (!t.sign_end && /截止|结束/.test(p)) t.sign_end = p;
  }
  const months = [...raw.matchAll(/(\d{1,2})(?:-(\d{1,2}))?月/g)].map((m) => parseInt(m[1]));
  if (months.length) t.start_month = Math.min(...months); // 启动月份取时间线上最早的月份
  return t;
}

// 技术栈树解析：深度 = 连接符前 "│" 的个数 + 1（对缩进不敏感）
// "     ├─ 硬件设计"          → depth 1
// "     │  ├─ STM32"          → depth 2
function parseTechTree(lines) {
  const nodes = [];
  for (const line of lines) {
    const m = line.match(/^\s*([│\s]*)[├└]─\s*(.+)$/);
    if (!m) continue;
    const depth = (m[1].match(/│/g) || []).length + 1;
    let name = m[2].trim();
    let desc = null;
    const nm = name.match(/^(.*?)（(.*)）$/); // "PCB设计（Altium Designer/立创EDA）" → 名称+说明
    if (nm) { name = nm[1].trim(); desc = nm[2].trim(); }
    nodes.push({ name, desc, depth });
  }
  return nodes;
}

// ---------- 单条竞赛块解析 ----------
function parseCompetitionBlock(block) {
  const lines = block.split('\n');
  const hm = lines[0].match(/^###\s*第(\d+)项[：:]\s*(.*)$/);
  if (!hm) return null;

  const comp = {
    id: parseInt(hm[1]),
    name: hm[2].trim(),
    type: '综合', // 默认赛道
    subs: [],
  };
  let curSub = null;
  let inTree = false;
  let treeLines = [];

  const flushTree = () => {
    if (treeLines.length && curSub) {
      curSub.tree = treeLines;
      treeLines = [];
    }
    inTree = false;
  };

  for (const line of lines.slice(1)) {
    if (!line.trim() || line.startsWith('####')) continue;

    // 技术栈/能力树标题 → 进入树收集模式
    const tm = line.match(/^\s*-\s*\*\*(技术栈|能力与工具要求)\*\*[：:]*\s*$/);
    if (tm) { flushTree(); inTree = true; continue; }
    // 树收集模式：只收树形行（├/└），遇到其他行立即结束并继续正常处理
    if (inTree) {
      if (/[├└]─/.test(line)) { treeLines.push(line); continue; }
      flushTree();
    }

    // 通用键值行
    const kv = parseKV(line);
    if (kv) {
      flushTree();
      const [k, v] = kv;
      switch (k) {
        case '简称': comp.short_name = v; break;
        case '赛道': comp.type = v; break;
        case '周期': comp.cycle = v; break;
        case '时间线':
          comp.timeline_raw = v;
          Object.assign(comp, parseTimeline(v));
          break;
        case '难度': comp.difficulty = (v.match(/★/g) || []).length || null; break;
        case '适合专业': comp.suitable_major = v; break;
        case '组队': comp.team = v; break;
        case '简介': comp.intro = v; break;
        default: break; // 未知键忽略
      }
      continue;
    }

    // 子赛项条目："1. **名称**" 或 "1. **名称**（补充说明）"
    const sm = line.match(/^(\d+)\.\s*\*\*(.+?)\*\*(.*)$/);
    if (sm) {
      flushTree();
      const trailing = (sm[3] || '').trim();
      curSub = { order: parseInt(sm[1]), name: (sm[2].trim() + (trailing ? ` ${trailing}` : '')), rule: null, check: null, tree: [] };
      comp.subs.push(curSub);
      continue;
    }

    // 子赛项内部字段
    if (curSub) {
      const rm = line.match(/^\s*-\s*\*\*赛制与规则\*\*[：:]\s*(.*)$/);
      if (rm) { curSub.rule = rm[1].trim(); continue; }
      const cm = line.match(/^\s*-\s*\*\*达标建议\*\*[：:]\s*(.*)$/);
      if (cm) { curSub.check = cm[1].trim(); continue; }
      // 其他未知字段（如备注）忽略
    }
  }
  flushTree();
  return comp;
}

// ---------- 主流程 ----------
const files = readdirSync(DATA_DIR)
  .filter((f) => f.endsWith('.md') && f !== 'README.md')
  .sort();

db.exec('BEGIN');
try {
  db.exec('DELETE FROM tech_stack; DELETE FROM competition_process; DELETE FROM competition;');

  const insComp = db.prepare(`INSERT INTO competition
    (id,name,short_name,type,start_month,sign_start,sign_end,province_time,national_time,timeline_raw,cycle,difficulty,intro,suitable_major,team,source_type,status,data_year)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insProc = db.prepare(`INSERT INTO competition_process
    (comp_id,phase_name,phase_desc,suggest_month,check_standard,sub_event_order)
    VALUES (?,?,?,?,?,?)`);
  const insNode = db.prepare(`INSERT INTO tech_stack
    (comp_id,process_id,parent_id,node_name,node_desc,level)
    VALUES (?,?,?,?,?,?)`);

  let compCount = 0, subCount = 0, nodeCount = 0;

  for (const file of files) {
    const content = readFileSync(join(DATA_DIR, file), 'utf8');
    const blocks = content.split(/(?=^###\s*第\d+项)/m);
    for (const block of blocks) {
      const comp = parseCompetitionBlock(block);
      if (!comp) continue;

      insComp.run(
        comp.id, comp.name, comp.short_name ?? null, comp.type,
        comp.start_month ?? null, comp.sign_start ?? null, comp.sign_end ?? null,
        comp.province_time ?? null, comp.national_time ?? null, comp.timeline_raw ?? null,
        comp.cycle ?? null, comp.difficulty ?? null, comp.intro ?? null,
        comp.suitable_major ?? null, comp.team ?? null,
        'official', 'active', DATA_YEAR
      );
      compCount++;

      for (const sub of comp.subs) {
        const r = insProc.run(
          comp.id, sub.name, sub.rule, comp.start_month ?? null, sub.check, sub.order
        );
        subCount++;
        // 技术栈树：根节点 = 子赛项名（level 1），parent_id 用实际插入的 rowid 递归
        const stack = [];
        for (const n of parseTechTree(sub.tree || [])) {
          while (stack.length && stack[stack.length - 1].depth >= n.depth) stack.pop();
          const parentId = stack.length ? stack[stack.length - 1].rowid : 0;
          const nr = insNode.run(comp.id, r.lastInsertRowid, parentId, n.name, n.desc, n.depth);
          stack.push({ depth: n.depth, rowid: nr.lastInsertRowid });
          nodeCount++;
        }
      }
    }
  }

  db.exec('COMMIT');
  console.log(`✅ 导入完成：${compCount} 项竞赛 / ${subCount} 个子赛项 / ${nodeCount} 个技术栈节点（来源 ${files.length} 个文件）`);
} catch (err) {
  db.exec('ROLLBACK');
  console.error('❌ 导入失败，已回滚：', err);
  process.exit(1);
}
