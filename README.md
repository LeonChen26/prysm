# Prysm

Prysm —— **本地单用户的工作 + 编程双形态 AI 助手桌面应用**（类 trae / gpt-work）。

基于 [pi-agent-core](https://www.npmjs.com/package/@earendil-works/pi-agent-core) 的自主任务 Agent，可在工作区内自主读写文件、联网搜索、跨会话记忆、接入外部工具生态（MCP / Skill），支持多提供商模型路由与完整的工具审批流。

核心逻辑与 UI 壳解耦：**Web（Next.js）** 与 **桌面（Electron）** 共用同一套核心 `lib/` **与同一份前端**；桌面壳只负责拉起本地 Web 服务并用 BrowserWindow 加载（REST + SSE 全走 HTTP）。

## 两种形态

| 形态 | 定位 | 工具来源 |
| --- | --- | --- |
| **Work** | 办公 / 自动化 | 外部工具生态（MCP、网页、文件） |
| **Coding** | IDE 式编码 | 文件读写、命令执行、代码搜索、subagent、测试 |

二者共享同一 Agent 底座与安全审批 / 审计，差别在上层交互与下层工具来源。

## Web 形态（开发 / 部署）

通过浏览器访问，`npm run dev` 启动即可使用。

## 桌面形态（Electron）

`npm run electron:dev` 启动桌面应用。**复用 Web 前端**：主进程拉起 Next.js 服务（开发 `next dev` / 打包 standalone `server.js`），BrowserWindow 加载 `http://127.0.0.1:30123`；数据基准经 `PRYSM_BASE_DIR=userData` 注入，所有 DB / 配置 / 技能落于用户数据目录。支持打包安装与自动更新（见「打包分发」）。

## 功能特性

### 自主执行与工具

- **自主执行**：理解意图后规划步骤，通过工具在工作区内完成文件读写、网页抓取、命令执行等任务
- **并行工具执行**：单条消息含多个工具调用时并行执行，可切换为串行
- **联网搜索**：bing（默认，国内可直连）/ duckduckgo
- **系统工具**：`env_info` 查看运行环境、`port_check` 排查端口占用
- **工具执行内联展示**：任务执行时工具卡片（名称 / 参数 / 结果）实时内联到消息流，结束后保留回顾
- **工具注册表**：内置 / MCP / Skill 三类工具 provider 统一注册，按 `surface`/`capability` 筛选

### 模型与路由

- **多模型路由**：强模型编排、小模型执行/摘要/标题；路由优先级 `PrysmConfig` 注入 > `model_route` 表 > 默认；子 agent 默认小模型，不可用自动回退主模型
- **多提供商**：anthropic / deepseek / openai / google，通过环境变量或路由表切换
- **上下文压缩**：对话超长时自动摘要化旧消息，节省 token

### 子 agent（任务级编排）

- 主 agent 通过 `spawn_subagent` 派生**只读研究型** / **读写执行型**子 agent
- 独立池键控（`parentSessionId:subagentId`），上下文隔离，只回传摘要
- 并发 / 超时 / 取消 / token 预算控制；超时返回部分结果并降级

### Plan mode（执行前规划）

- 主 agent 先产出结构化计划（步骤 + 涉及工具 + 预期），UI 渲染为可确认卡片，**用户确认后才执行**
- 与审批流独立：审批是「工具调用时」逐次确认，Plan mode 是「执行前」一次性确认
- 支持批准 / 拒绝 / 取消，超时视为拒绝；计划持久化到 `plans.db`
- Web 与桌面（共用同一前端）均支持计划卡片渲染

### 多模态输入

- 图片 / 附件作为消息输入，上传落盘到当前会话所属工作区根目录
- 消息支持图片块渲染；MCP 返回的 `image` 亦可内联展示

### 知识库 / RAG

- work 形态对项目文档做检索增强，区别于「情景记忆」（跨会话经验）
- 本地 SQLite + FTS5，BM25 关键词匹配（中文按字符分词），**无需外部嵌入模型**
- 增量扫描已授权工作区文本文件（按 mtime+size 跳过未变更）
- 上下文注入顺序：压缩 → 情景记忆 → RAG，各有 token 预算

### 工作区与多工作区

- 多工作区数据模型（`prysm.db` 的 `workspace` 表），默认播种 `agent-workdir`
- 从 `AGENT_ALLOWED_PATHS` 一次性导入（仅表为空时；导入后 env 只读兼容）
- **目录授权 + 默认拒绝**（Phase 2）：首次访问未授权目录需授权，默认工作区恒授权
- **工作区文件浏览器**：侧栏可视化目录树，支持浏览 / 预览 / 新建 / 上传文件

### 安全 / 审批 / 审计

- **工具审批**：敏感操作（写文件 / 删文件 / 执行命令）先征求用户确认，审批卡片位于对话窗内并带风险分级与倒计时；支持白名单自动放行与黑名单强制拦截
- **策略规则化**：工具 / 路径白黑名单（支持 `mcp__*` / `skill__*` 通配）、命令规则（allow / ask / deny）、审批超时统一存于 `<baseDir>/permission/global.json`，设置面板「审批」Tab 可视化管理
- **权限模式**：手动审批 / 自动审批（LLM Guardian 决策）/ 完全访问 / 自定义，一键切换并持久化
- **审批历史审计**：每次审批决定（同意 / 拒绝 / 超时 / 策略拦截 / 自动放行）持久化到 `audit.db`，侧栏可筛选（工具 / 动作）、分页、查看与清空；敏感参数自动脱敏

### MCP & Skill

- **MCP**：接入官方 `@modelcontextprotocol/sdk`，支持 **tools + resources + prompts**；传输支持 **stdio（本地子进程）+ streamable HTTP + SSE（远程）**，远程 server 可配置 `url` / `headers`（如 Bearer 鉴权）；连接 / 调用超时（`START_MCP_TIMEOUT_MS` / `RUN_MCP_TIMEOUT_MS`）与 `${workspaceFolder}` 变量替换；设置面板管理 server（传输类型切换、参数编辑）；连接状态与工具清单可视化；崩溃降级 + 自动重连
- **Skill**：`skills/<name>/SKILL.md`（frontmatter + 正文）；**按需加载**——系统提示词仅注入名称/描述索引，模型判断任务相关时经 `use_skill` 工具加载正文；项目技能 `<baseDir>/skills` + 全局技能 `~/.prysm/skills` 双目录（同名项目优先），全局目录不可写时自动回退并持久化；会话级启用 / 禁用 / 热加载，`/skill <名称> [任务]` 手动调用

### 记忆与数据

- **情景记忆**：跨会话检索历史 episode，自动注入相关上下文（SQLite 持久化于 `agent-memory.db`），侧栏可查看 / 删除 / 清空
- **偏好记忆**：对话中 `remember_memory` / `forget_memory` 显式记住 / 更新 / 删除偏好与规则（scope 全局 / 项目），全局 `memory/user_profile.md` + 项目 `memory/projects/<workdir>/project_memory.md`，注入系统提示词跨会话生效；设置面板「数据」Tab 可视化编辑
- **定时任务（自动化）**：按固定间隔 / 固定时间（每天 / 每周 / 每月 cron）自动执行预设任务并生成结果，无需人工干预；对话中 `create_automation` 自然语言创建；左栏「自动化」面板管理（启停 / 立即运行 / 编辑删除 / 执行历史跳转 / 任务模板）；每次执行生成独立会话可回看对话流
- **待办清单**：任务拆解为步骤卡片，支持拖拽排序 / 删除 / 追加，实时进度与耗时；持久化到 `todo.db`
- **数据备份恢复**：一键导出 / 导入会话、记忆（情景 + 偏好）、任务计划与定时任务（侧栏「备份 / 恢复」）

### 会话与消息

- **会话管理**：新建 / 重命名 / 置顶 / 批量删除 / 清空消息 / 导出为 Markdown 或 JSON
- **会话搜索**：按关键词搜索会话标题与消息内容，命中片段点击直达
- **消息操作**：复制文本 / 复制 Markdown / 编辑用户消息后重发 / 重新生成回复 / 删除单条 / 超长折叠 / 多选批量删除
- **智能标题**：对话多轮后自动生成精炼会话标题
- **完成通知**：任务结束且页面不在前台时发送浏览器通知（铃铛开关）

### 渲染体验

- 代码块语法高亮 + 一键复制，超长代码块内部滚动
- LaTeX 公式（KaTeX）、`thinking` 代码块折叠为思考过程、`mermaid` 流程图（跟随主题）
- GFM 任务列表 checkbox、消息时间显示、流式打字机光标、消息平滑淡入
- **文件引用卡片**：`wb://路径` 独立行渲染为文件引用卡片，点击侧栏预览

### 可观测性

- **运行日志**：记录每次 Agent 执行（耗时 / 消息数 / 结果），侧栏可查看
- **运行统计概览**：总运行 / 成功率 / 总耗时 / 平均耗时、最近 7 天柱状图、工具使用排行
- **MCP 连接状态** / **子 agent 资源** / **模型路由命中**：面板可查

## 环境要求

- Node.js ≥ **20.9**
- npm

## 快速开始（Web）

### 1. 安装依赖

```bash
npm ci       # 严格按 package-lock.json 安装（推荐，保证版本一致）
# 或 npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env.local
```

编辑 `.env.local`，至少填写所用提供商的 API Key 并设置模型：

```bash
# 模型提供商: anthropic | deepseek | openai | google
MODEL_PROVIDER=deepseek
MODEL_ID=deepseek-v4-flash

# 按提供商填写对应 Key（只填一个即可）
# ANTHROPIC_API_KEY=sk-xxx
DEEPSEEK_API_KEY=sk-xxx
# OPENAI_API_KEY=sk-xxx
# GOOGLE_API_KEY=sk-xxx
```

> `.env.local` 已被 gitignore，不会提交。全部可用变量见下文「环境变量」表。

### 3. 启动开发服务器

```bash
npm run dev
```

访问 http://localhost:30123 ，在输入框下发任务即可与 Agent 交互。

## 快速开始（桌面 Electron）

核心与 Web 共用，无需额外配置模型即可使用（读取同一 `.env.local`）：

```bash
npm run electron:dev     # 编译主进程并启动桌面应用（自动复用/拉起 next dev）
```

## 生产构建与部署（Web）

### 本地构建 + 启动

```bash
npm run build
npm start          # 生产模式，默认 http://localhost:30123
```

### standalone 产物部署（推荐用于 ECS / 容器）

`next.config.mjs` 已启用 `output: "standalone"`，构建后生成 `.next/standalone/`，内含精简依赖与 `server.js`：

```bash
npm run build
cd .next/standalone
node server.js     # 默认 30123 端口，可用 PORT / HOSTNAME 覆盖
```

部署到服务器时建议用 `pm2` 等进程守护：

```bash
pm2 start .next/standalone/server.js --name prysm
```

**注意**：部署 standalone 时，需将构建机的 `.next/static/` 复制到 `.next/standalone/.next/static/`（若存在 `public/` 目录同样复制），否则静态资源 404。

## 打包分发（桌面）

基于 **electron-builder**，输出到 `release-build/`：

| 命令 | 说明 |
| --- | --- |
| `npm run electron:build` | 仅编译主进程（esbuild → `dist-electron/main.cjs`） |
| `npm run dist` | 构建当前平台安装包（不发布） |
| `npm run dist:win` / `dist:mac` / `dist:linux` | 构建指定平台安装包（不发布） |
| `npm run release` | 构建并发布到 GitHub Releases（需 `GH_TOKEN`） |
| `npm run release:github` | 构建并发布 Windows 安装包到 GitHub Releases（需 `GH_TOKEN`） |

产物：`Prysm-Setup-<version>.exe`（NSIS 安装包）、`.blockmap`（增量更新）、`latest.yml`（自动更新元数据）、`win-unpacked/`（绿色版）。

**自动更新**：electron-updater 已接线，受 `PRYSM_AUTO_UPDATE=1` 门控；更新源默认 GitHub Releases，可用 `PRYSM_UPDATE_URL` 覆盖为自建服务器。详见 [docs/distribution.md](docs/distribution.md)。

## 路由与接口

| 路径 | 说明 |
| --- | --- |
| `/` | 聊天主界面 |
| `GET /api/sessions` | 会话列表（置顶优先） |
| `POST /api/sessions` | 创建会话 |
| `GET /api/sessions/[id]` | 会话消息历史 |
| `PATCH /api/sessions/[id]` | 重命名或置顶（`{ title }` / `{ pinned: bool }`） |
| `DELETE /api/sessions/[id]` | 删除指定会话 |
| `DELETE /api/sessions/[id]/messages` | 删除会话中的单条消息 |
| `GET /api/sessions/[id]/export?format=md\|json` | 导出会话为 Markdown / JSON |
| `POST /api/sessions/[id]/clear` | 清空会话消息（保留会话） |
| `GET /api/sessions/search?q=xxx` | 按关键词搜索会话消息内容 |
| `GET /api/agent?sessionId=xxx` | 返回指定会话的消息历史 |
| `POST /api/agent` | 发送消息，SSE 流式返回 Agent 事件 |
| `POST /api/agent/stop` | 停止当前会话的 Agent |
| `POST /api/agent/approve` | 审批操作（同意 / 拒绝） |
| `GET /api/agent/pending` | 当前未决审批（刷新页面后恢复审批卡片） |
| `GET /api/agent/logs` | 最近 Agent 运行日志 |
| `GET /api/audit` | 审批历史列表（`?tool=` / `?action=` 筛选，`?offset=` 分页） |
| `POST /api/audit` | 清空审批历史（`{ action: "clear" }`） |
| `GET /api/stats` | 运行统计概览 |
| `POST /api/todos` | 待办操作（append / remove / reorder） |
| `GET /api/memory` | 情景记忆列表 |
| `DELETE /api/memory?id=xxx` | 删除单条记忆 |
| `POST /api/memory` | 清空全部记忆（`{ action: "clear" }`） |
| `GET /api/backup` | 导出全部数据（会话 + 记忆 + 任务计划 + 审批历史）为 JSON |
| `POST /api/backup` | 导入备份并清空重建 |
| `GET /api/workdir?path=xxx` | 列出工作区目录条目 |
| `GET /api/workdir/content?path=xxx` | 预览工作区内文本文件 |
| `POST /api/workdir` | 新建文件 / 目录（JSON）或上传文件（multipart） |
| `GET /api/workspaces` | 全部工作区（含授权状态） |
| `POST /api/workspaces` | 新增工作区（`{ root, name? }`） |
| `POST /api/workspaces/[id]/authorize` | 授权 / 撤销工作区（`{ authorized: bool }`） |
| `GET /api/mcp` | MCP 服务器列表与连接状态；POST 增删（stdio / http / sse） |
| `GET /api/skills` | 全部已登记技能（含 enabled 状态） |
| `POST /api/skills` | 启用 / 禁用 / 重载技能（`{ name, action }`） |
| `GET /api/automations` | 定时任务列表与执行历史 |
| `POST /api/automations` | 定时任务操作（create / update / toggle / delete / run） |
| `GET /api/memory-files` | 偏好记忆文件内容（全局 / 项目） |
| `POST /api/memory-files` | 保存 / 重置偏好记忆（`{ action: "save"\|"reset" }`） |
| `GET /api/permission` | 权限与审批配置（permission.json）及配置文件路径 |
| `POST /api/permission` | 保存完整配置（`{ config }`）或切换模式（`{ activeMode }`） |
| `GET /api/health` | 健康检查（Electron 壳启动后轮询，就绪后加载窗口） |
| `GET /api/plans?sessionId=xxx&id=yyy` | 未决计划列表 / 单个计划（Plan mode） |
| `POST /api/plans` | 计划决定（`{ id, action: "approve"\|"reject"\|"cancel" }`） |
| `GET /api/rag?q=xxx&limit=20` | 知识库检索；无 `q` 时返回索引概览 |
| `POST /api/rag` | 重建 / 增量索引全部已授权工作区（`{ action: "index" }`） |
| `POST /api/upload` | 上传图片（`{ data: base64, mimeType? }`），落盘到工作区根 |

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MODEL_PROVIDER` | `anthropic` | 模型提供商：`anthropic` / `deepseek` / `openai` / `google` |
| `MODEL_ID` | `claude-sonnet-4-5` | 默认模型 ID（deepseek: `deepseek-v4-flash` / `deepseek-v4-pro`） |
| `ANTHROPIC_API_KEY` | - | Anthropic Key |
| `DEEPSEEK_API_KEY` | - | DeepSeek Key |
| `OPENAI_API_KEY` | - | OpenAI Key |
| `GOOGLE_API_KEY` | - | Google Key |
| `MAX_CONTEXT_TOKENS` | `50000` | 累计 token 超过该值时摘要化最早对话 |
| `KEEP_RECENT_MESSAGES` | `8` | 压缩时保留的最近消息条数 |
| `MEMORY_RECALL_K` | `5` | 每次检索注入的历史 episode 条数 |
| `TOOL_EXECUTION` | `parallel` | 并行 / 串行工具执行：`parallel` / `sequential` |
| `WEB_SEARCH_PROVIDER` | `bing` | 搜索提供器：`bing` / `duckduckgo` |
| `AGENT_ALLOWED_PATHS` | 空 | 额外允许 Agent 访问的根目录白名单（逗号分隔），首次启动一次性导入工作区表 |
| `RAG_ENABLED` | `true` | RAG 是否启用（`false` 关闭） |
| `RAG_MAX_CHARS` | `4000` | 注入上下文的检索结果最大字符数 |
| `RAG_RECALL_K` | `5` | 每轮检索返回的最大文档段数 |
| `RAG_SCAN_LIMIT` | `2000` | 单次扫描处理的最大文件数 |
| `PRYSM_AUTO_UPDATE` | - | 桌面版自动更新开关（`1` 启用，仅打包版生效） |
| `PRYSM_UPDATE_URL` | - | 桌面版自动更新源覆盖（自建服务器） |
| `PRYSM_BASE_DIR` | `config.baseDir` | 桌面版由 Electron 注入 `userData`，作为 DB / 配置 / 技能的数据基准 |
| `PRYSM_WEB_PORT` | `30123` | 桌面版本地 Web 服务端口（打包版 standalone 也适用） |
| `PRYSM_LLM_JUDGE` | - | LLM-as-Judge 自动评分开关（`1` 启用，每次运行后主模型打分 0-10） |
| `START_MCP_TIMEOUT_MS` | `15000` | MCP 连接超时（stdio 读 env / 远程读 headers） |
| `RUN_MCP_TIMEOUT_MS` | `60000` | MCP 工具 / 资源 / prompt 调用超时 |
| `PORT` | `3000` | standalone 产物监听端口 |
| `HOSTNAME` | - | standalone 产物绑定地址（如 `0.0.0.0`） |

## 数据与文件

| 路径 | 说明 |
| --- | --- |
| `agent-workdir/` | Agent 文件工具的工作区（默认工作区），所有读写被限制在各工作区内 |
| `sessions.db` | 会话与消息历史（SQLite） |
| `agent-memory.db` | 情景记忆库（SQLite） |
| `todo.db` | 任务计划持久化（SQLite） |
| `audit.db` | 审批历史审计（SQLite） |
| `plans.db` | Plan mode 计划持久化（SQLite） |
| `agent-rag.db` | 知识库 / RAG 索引（SQLite + FTS5） |
| `prysm.db` | 工作区 / 模型路由等配置（SQLite） |
| `automations.db` | 定时任务配置与执行历史（SQLite） |
| `permission/` | 审批 / 权限配置（`global.json`，单一事实来源） |
| `memory/` | 偏好记忆（全局 `user_profile.md` + 各项目 `project_memory.md`） |

> Web 形态下位于构建 / 运行目录；桌面形态下位于 `userData` 目录。部署时注意持久化挂载。

## 目录结构

```
lib/                  # 核心逻辑（框架无关，纯 TS/Node，Web 与 Electron 共用）
  core.ts             # PrysmCore 工厂（baseDir 参数注入）
  events.ts           # AgentEventBus 统一事件流
  config.ts           # 配置注入
  agent.ts            # Agent 底座（基于 pi-agent-core）
  tools.ts            # 内置工具定义
  tool-meta.ts        # 工具元数据（label/type/surface/capability/sensitive）
  tools/              # 工具注册表 + 内置 / MCP / Skill provider
  skills.ts           # Skill 加载（索引 / 双目录 / 回退）与 use_skill
  plan.ts             # Plan mode
  subagent.ts         # 子 agent 编排
  model-router.ts     # 多模型路由
  rag.ts              # 知识库 / RAG
  workspace.ts        # 多工作区模型
  policy.ts / risk.ts # 安全策略 / 风险分级
  permission.ts / approval-policy.ts / guardian.ts  # 权限配置 / 审批决策链 / LLM Guardian
  approval.ts / audit.ts  # 审批流 / 审计
  sessions.ts / memory.ts / todo.ts  # 会话 / 记忆 / 待办持久化
  preference-memory.ts# 偏好记忆（全局 + 项目 markdown）
  automation.ts / cron.ts / scheduler.ts  # 定时任务（数据层 / cron 解析 / 调度器）
app/api/              # Web 路由（REST + SSE）
components/           # Web 前端组件（ChatPanel 等）
electron/             # 桌面壳（主进程：拉起 Web 服务 + BrowserWindow 加载；esbuild → main.cjs）
docs/                 # 架构蓝图与分发文档
tests/                # unit / web / e2e 测试
```

## 测试脚本

```bash
npm run typecheck     # TypeScript 类型检查
npm run test:unit     # 37 个离线单测（工具/审批/审计/工作区/MCP/Skill/模型路由/子agent/RAG/多模态/Plan/定时任务/桌面壳等）
npm run test:web      # 联网搜索与网页抓取
npm run test:e2e      # 端到端测试（需先启动 npm run dev）
```

## 文档

- [docs/architecture.md](docs/architecture.md) —— 目标架构与落地路线（v8，12 Phase 全部完成）
- [docs/distribution.md](docs/distribution.md) —— 打包与分发说明
- [docs/learning-roadmap.md](docs/learning-roadmap.md) —— 代码学习 / 检视路线图（小白向，从零读懂本项目）
- [docs/bug-audit.md](docs/bug-audit.md) —— 代码审查报告（自研代码已知问题清单与修复建议）
- [docs/design/](docs/design/) —— 自研代码设计文档（按模块归类，含 01-core / 02-tools / 03-security / 04-data / 05-web / 06-electron）