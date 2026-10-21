// 荣誉墙标签口径（前后端约定；后端不硬拒，只 trim + 截断 —— 录入端 allow-create 允许自建值）
// 与 backend/routes/honor.js 的 LIMITS 对应：级别/奖等 ≤20 字，班级每个 ≤20 字、≤6 个
//
// 授予级别（honor.award_level）：决定前台金/银/铜配色（HonorView 的 tierOf 仍用正则兜底自建值）
// 奖等（honor.prize_rank）：奖状上的获奖等次
export const LEVEL_OPTS = ['国际级', '国家级', '省级', '市级', '校级'];
export const RANK_OPTS = ['特等奖', '一等奖', '二等奖', '三等奖', '优胜奖'];
