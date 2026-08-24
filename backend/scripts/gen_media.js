// 学习资源生成器：为全部竞赛生成媒体平台检索链接（视频/文章）
// 生成策略：
//  - intro（竞赛介绍）    ：竞赛名 → 8 平台搜索模板
//  - process（备赛流程）  ：竞赛名+备赛 → 8 平台搜索模板
//  - knowledge（知识点）  ：每个子赛项前3个技术栈根节点 × 3 平台（B站/CSDN/知乎）
//  - manual：重点竞赛人工核实的真实链接（不经过搜索）
// 幂等：重复运行先清空 search 类型，保留 manual；再次运行 manual 也重建
import db from '../db/database.js';
import { SEARCH, KNOWLEDGE_PLATFORMS } from '../routes/platforms.js';

const ALL_PLATFORMS = Object.keys(SEARCH); // 8 平台

const enc = encodeURIComponent;
const insert = db.prepare(
  `INSERT INTO media_resource (comp_id, category, platform, title, keyword, url, tech_node_id, source_type)
   VALUES (?,?,?,?,?,?,?,?)`
);

// 人工核实的真实链接样例（2026-08-24 经搜索核验的高质量稳定入口）
const MANUAL_SAMPLES = [
  // 全国大学生电子设计竞赛（comp_id 按简称匹配）
  { match: '电赛', items: [
    { category: 'intro', platform: 'bilibili', title: '电赛官方B站（全国大学生电子设计竞赛）', url: 'https://space.bilibili.com/29404331' },
    { category: 'process', platform: 'github', title: '电赛备赛仓库（历年赛题/方案汇总）', url: 'https://github.com/search?q=%E7%94%B5%E5%AD%90%E8%AE%BE%E8%AE%A1%E7%AB%9E%E8%B5%9B&type=repositories' },
    { category: 'knowledge', platform: 'bilibili', title: 'STM32 入门教程（B站搜「江科大」）', url: 'https://search.bilibili.com/all?keyword=STM32%E5%85%A5%E9%97%A8%E6%95%99%E7%A8%8B' },
  ]},
  // 全国大学生数学建模竞赛
  { match: '数学建模', items: [
    { category: 'intro', platform: 'bilibili', title: '数学建模国赛官方B站号', url: 'https://space.bilibili.com/502549543' },
    { category: 'process', platform: 'zhihu', title: '数学建模备赛经验（知乎专栏）', url: 'https://www.zhihu.com/topic/19631671' },
    { category: 'knowledge', platform: 'csdn', title: '数学建模算法合集（CSDN）', url: 'https://so.csdn.net/so/search?q=%E6%95%B0%E5%AD%A6%E5%BB%BA%E6%A8%A1%E7%AE%97%E6%B3%95' },
  ]},
  // 全国大学生机器人大赛 RoboMaster（机甲大师，CURC 子赛项，简称含"机甲大师"）
  { match: '机甲', items: [
    { category: 'intro', platform: 'robomaster', title: 'RoboMaster 官网（赛事官方）', url: 'https://www.robomaster.com/zh-CN/' },
    { category: 'intro', platform: 'bilibili', title: 'RoboMaster 官方B站（赛事集锦）', url: 'https://space.bilibili.com/23444049' },
    { category: 'process', platform: 'github', title: 'RoboMaster 官方开发文档（GitHub）', url: 'https://github.com/RoboMaster' },
    { category: 'process', platform: 'robomaster', title: 'RoboMaster 开发者社区（论坛）', url: 'https://bbs.robomaster.com/' },
  ]},
  // 全国大学生智能汽车竞赛（简称"智能车"）
  { match: '智能车', items: [
    { category: 'intro', platform: 'official', title: '智能车竞赛官网', url: 'https://www.smartcarrace.com/' },
    { category: 'process', platform: 'bilibili', title: '智能车官方交流B站号（TSINGHUAJOKING，规则宣讲/总决赛回放）', url: 'https://search.bilibili.com/all?keyword=TSINGHUAJOKING' },
    { category: 'knowledge', platform: 'github', title: '智能车开源方案仓库', url: 'https://github.com/search?q=%E6%99%BA%E8%83%BD%E8%BD%A6%E7%AB%9E%E8%B5%9B&type=repositories' },
  ]},
];

function shortNameOf(comp) {
  return comp.short_name || comp.name;
}

let count = 0;
const comps = db.prepare("SELECT id, name, short_name FROM competition WHERE status = 'active'").all();

db.exec('BEGIN');
try {
  // 幂等清空（search 与 manual 都重建）
  db.exec('DELETE FROM media_resource');

  for (const comp of comps) {
    const short = shortNameOf(comp);
    // intro + process：8 平台
    for (const [plat, make] of Object.entries(SEARCH)) {
      const kwIntro = enc(comp.name);
      insert.run(comp.id, 'intro', plat, `${short} 竞赛介绍`, comp.name, make(kwIntro), null, 'search');
      const kwProc = enc(`${comp.name} 备赛`);
      insert.run(comp.id, 'process', plat, `${short} 备赛流程`, `${comp.name} 备赛`, make(kwProc), null, 'search');
      count += 2;
    }
    // knowledge：每个子赛项前 3 个技术栈根节点 × 3 平台
    const roots = db.prepare(
      `SELECT ts.id, ts.node_name, ts.process_id FROM tech_stack ts
       WHERE ts.comp_id = ? AND ts.parent_id = 0 ORDER BY ts.process_id, ts.id`
    ).all(comp.id);
    const perProcess = new Map(); // process_id -> 已取根数
    for (const r of roots) {
      const n = perProcess.get(r.process_id) || 0;
      if (n >= 3) continue; // 每子赛项最多 3 个根节点
      perProcess.set(r.process_id, n + 1);
      const kw = enc(`${r.node_name} ${short}`);
      for (const plat of KNOWLEDGE_PLATFORMS) {
        insert.run(comp.id, 'knowledge', plat, `${r.node_name}（${short}）`, `${r.node_name} ${short}`, SEARCH[plat](kw), r.id, 'search');
        count++;
      }
    }
  }

  // 人工核实样例（按简称匹配入库）
  for (const sample of MANUAL_SAMPLES) {
    const comp = comps.find((c) => (c.short_name || '').includes(sample.match) || c.name.includes(sample.match));
    if (!comp) { console.log(`⚠️ 未匹配到 ${sample.match}，跳过`); continue; }
    for (const it of sample.items) {
      insert.run(comp.id, it.category, it.platform, it.title, it.title, it.url, null, 'manual');
      count++;
    }
  }

  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}

const total = db.prepare('SELECT COUNT(*) c FROM media_resource').get();
const byCat = db.prepare('SELECT category, COUNT(*) c FROM media_resource GROUP BY category').all();
console.log(`✅ 学习资源已生成：共 ${total.c} 条`);
console.log('   分类统计:', byCat.map((r) => `${r.category}=${r.c}`).join('  '));
