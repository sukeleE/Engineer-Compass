// 竞赛官网种子脚本：为核验过的竞赛填充 official_url（弹窗基础信息页展示）
// 全部链接 2026-08-24 经联网核验（官网可达性 + 高校官方通知引用交叉确认）
// 幂等：按简称/名称匹配 UPDATE，重复运行安全
import db from '../db/database.js';

// match: 匹配关键词（简称优先，名称兜底） / url: 官网地址
const OFFICIAL_URLS = [
  { match: '电子设计',    url: 'https://www.nuedc-training.com.cn/' },  // 全国大学生电子设计竞赛（培训网=官方信息发布+报名入口）
  { match: '数模国赛',    url: 'https://www.mcm.edu.cn/' },             // 全国大学生数学建模竞赛
  { match: '智能车',      url: 'https://www.smartcarrace.com/' },       // 全国大学生智能汽车竞赛
  { match: '机械创新',    url: 'http://umic.ckcest.cn/' },              // 全国大学生机械创新设计大赛
  { match: '大挑',        url: 'https://www.tiaozhanbei.net/' },        // 挑战杯·课外学术科技作品竞赛
  { match: '小挑',        url: 'https://www.tiaozhanbei.net/' },        // 挑战杯·中国大学生创业计划大赛（同一官网）
  { match: '国创大赛',    url: 'https://cy.ncss.cn/' },                 // 中国国际大学生创新大赛（全国大学生创业服务网，官方报名平台）
  { match: '机甲',        url: 'https://www.robomaster.com/zh-CN/' },   // 全国大学生机器人大赛 RoboMaster 机甲大师
  { match: 'ACM',         url: 'https://icpc.global/' },                // ACM-ICPC 国际大学生程序设计竞赛
  { match: '嵌入式',      url: 'https://www.socchina.net/' },           // 全国大学生嵌入式芯片与系统设计竞赛
  { match: '节能减排',    url: 'https://www.jienengjianpai.org/' },     // 全国大学生节能减排社会实践与科技竞赛
];

const upd = db.prepare(`UPDATE competition SET official_url = ? WHERE id = ? AND status = 'active'`);
let hit = 0, miss = 0;

for (const { match, url } of OFFICIAL_URLS) {
  // 简称优先，名称兜底（同源记录如大挑/小挑各自匹配）
  const rows = db.prepare(
    `SELECT id, name, short_name FROM competition
     WHERE status = 'active' AND (short_name LIKE ? OR name LIKE ?)`
  ).all(`%${match}%`, `%${match}%`);
  if (!rows.length) { console.log(`⚠️ 未匹配「${match}」，跳过`); miss++; continue; }
  for (const r of rows) { upd.run(url, r.id); hit++; console.log(`✅ [${r.id}] ${r.short_name} → ${url}`); }
}

const filled = db.prepare("SELECT COUNT(*) c FROM competition WHERE official_url IS NOT NULL AND status='active'").get();
console.log(`\n完成：写入 ${hit} 条，未匹配 ${miss} 个；active 竞赛官网覆盖率 ${filled.c} 个`);
