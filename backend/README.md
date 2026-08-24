# Engineer-Compass 后端（阶段一）

Express + SQLite（Node 内置 `node:sqlite`，无需原生编译依赖，Node ≥ 22.5）。

## 快速开始

```bash
cd backend
npm install
npm run import     # 导入 竞赛数据/*.md → data/compass.db（幂等，可重复执行）
npm start          # 启动 http://localhost:3000
```

可选：复制 `.env.example` 为 `.env`，填入 `DEEPSEEK_API_KEY`（DeepSeek 平台获取）。
未配置时：AI 接口返回友好提示；日程生成自动降级为基础模板计划。

## 目录结构

```
backend/
├── server.js              # Express 入口（CORS / JSON / 路由挂载 / 404 / 错误处理）
├── db/
│   ├── schema.sql         # 4张表结构（competition/competition_process/tech_stack/user_schedule）
│   └── database.js        # node:sqlite 连接 + schema 初始化
├── scripts/
│   └── import_data.js     # Markdown → SQLite 种子数据导入
├── routes/
│   ├── competitions.js    # 竞赛：列表/详情/搜索/pending审核/新增/删除
│   ├── ai.js              # DeepSeek：问答转发 / 未知竞赛资料提炼
│   └── schedule.js        # 日程：AI生成/列表/编辑/导出Markdown/删除
├── data/compass.db        # SQLite 数据库（导入后生成）
└── .env.example
```

## 接口文档

### 竞赛
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/competition` | 全部赛事，支持 `?type=&difficulty=&status=` 筛选 |
| GET | `/api/competition/:id` | 单条详情（含子赛项流程 + 每子赛项技术栈树） |
| GET | `/api/competition/search?q=` | 模糊搜索；未命中返回 hint 引导走 AI 收录 |
| GET | `/api/competition/pending` | 待审核列表（管理端） |
| POST | `/api/competition` | AI/用户新增（**必须带 source_url**，自动 status=pending） |
| POST | `/api/competition/:id/verify` | 采纳转正 pending→active |
| DELETE | `/api/competition/:id` | 删除（级联删子赛项+技术栈） |

### AI（需 DEEPSEEK_API_KEY）
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/ai/chat` | 通用问答，body: `{question, comp_id?/comp_name?}`（上下文感知） |
| POST | `/api/ai/extract` | 未知竞赛资料提炼，body: `{material}`（粘贴官方通知）→ 结构化竞赛卡片 JSON |

### 日程
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/schedule/add` | 生成备赛计划，body: `{comp_id, user_id?}`（AI 生成，无 key 降级模板；plan 统一归一化：phases[].{phase,date,tasks[{text,done}],check_standard,week_hours}） |
| GET | `/api/schedule/list?user_id=` | 用户日程列表（plan 已归一化） |
| POST | `/api/schedule/:id/edit` | 手动修改，body: `{plan_json}`（标记 is_custom=1；任务勾选/新增/改期都走这里） |
| POST | `/api/schedule/:id/optimize` | AI 优化现有计划（按任务文本保留已完成勾选，is_custom 重置为 0；无 key 返回 502） |
| GET | `/api/schedule/:id/export?format=` | 导出：`md`（默认）/ `excel`（CSV 带 UTF-8 BOM，Excel 直接打开中文不乱码） |
| DELETE | `/api/schedule/:id` | 删除日程 |

### 其他
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |

## 数据库（data/compass.db）

| 表 | 数据量 | 说明 |
|---|---|---|
| competition | 84 | 高教学会 2023 版 84 项 A 类竞赛，source_type=official / status=active |
| competition_process | 398 | 子赛项（赛制规则 → phase_desc，达标建议 → check_standard） |
| tech_stack | 2072 | 技术栈树（parent_id 递归，每子赛项一个根组，level 1-2） |
| user_schedule | 0 | 用户日程（LocalStorage + 本表双存） |

AI 收录的新竞赛 id 从 85 起（不在官方 84 项内），以 `status=pending` 等待人工审核转正。

## 已知限制

- 时间信息为近年届次整理（2025 基准年），"（时间可能逐年变动）"字段需每年刷新
- DeepSeek API 不带联网搜索：未知竞赛需用户粘贴资料（后续可接入博查/Tavily 搜索 API 自动化）
- 观察目录 34 项竞赛（数学竞赛等）未收录，可按需通过收录接口加入
