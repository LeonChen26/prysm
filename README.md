# WorkBuddy Agent

基于 [pi-agent-core](https://www.npmjs.com/package/@earendil-works/pi-agent-core) 的自主任务 Agent，可在工作区内自主读写文件、联网搜索、跨会话记忆，支持多提供商模型与工具审批流。

## 功能特性

- **自主执行**：理解意图后规划步骤，通过工具在工作区（`agent-workdir/`）内完成文件读写、网页抓取等任务
- **模型多提供商**：anthropic / deepseek / openai / google，通过环境变量切换
- **上下文压缩**：对话超长时自动摘要化旧消息，节省 token
- **情景记忆**：跨会话检索历史 episode，自动注入相关上下文（SQLite 持久化于 `agent-memory.db`）
- **工具审批**：敏感操作（写文件 / 删文件）先征求用户确认；支持白名单规则自动放行
- **并行工具执行**：单条消息含多个工具调用时并行执行，可切换为串行
- **联网搜索**：bing（默认，国内可直连）/ duckduckgo
- **待办清单**：任务拆解为步骤卡片，支持拖拽排序 / 删除 / 追加，实时展示进度与耗时
- **会话管理**：重命名 / 置顶 / 批量删除 / 清空消息 / 导出为 Markdown 或 JSON
- **代码高亮**：助手消息中的代码块语法高亮，支持一键复制

## 环境要求

- Node.js ≥ 20
- npm

## 快速开始

### 1. 安装依赖

```bash
npm install
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

访问 http://localhost:3000 ，在输入框下发任务即可与 Agent 交互。

## 生产构建与部署

### 本地构建 + 启动

```bash
npm run build
npm start          # 生产模式，默认 http://localhost:3000
```

### standalone 产物部署（推荐用于 ECS / 容器）

`next.config.mjs` 已启用 `output: "standalone"`，构建后会生成 `.next/standalone/`，内含精简依赖与 `server.js`，无需 node_modules 即可运行：

```bash
npm run build
cd .next/standalone
node server.js     # 默认 3000 端口，可用 PORT / HOSTNAME 覆盖
```

环境变量方式指定端口与绑定地址：

```bash
PORT=3100 HOSTNAME=0.0.0.0 node server.js
```

部署到服务器时建议用 `pm2` 等进程守护工具：

```bash
pm2 start .next/standalone/server.js --name workbuddy-agent
```

**注意**：
- 部署 standalone 时，需将构建机的 `.next/static/` 复制到 `.next/standalone/.next/static/`（若存在 `public/` 目录同样复制），否则静态资源 404
- Windows 本地构建 standalone 时，依赖复制阶段可能对个别包（如 typebox）报符号链接 ENOENT 警告，不影响产物运行；Linux / ECS 上无此问题

### 路由与接口

| 路径 | 说明 |
| --- | --- |
| `/` | 聊天主界面 |
| `GET /api/sessions` | 会话列表（置顶优先） |
| `POST /api/sessions` | 创建会话 |
| `GET /api/sessions/[id]` | 会话消息历史 |
| `PATCH /api/sessions/[id]` | 重命名或置顶（`{ title }` / `{ pinned: bool }`） |
| `DELETE /api/sessions/[id]` | 删除指定会话 |
| `GET /api/sessions/[id]/export?format=md\|json` | 导出会话对话为 Markdown / JSON 文件 |
| `POST /api/sessions/[id]/clear` | 清空会话消息（保留会话） |
| `GET /api/agent?sessionId=xxx` | 返回指定会话的消息历史 |
| `POST /api/agent` | 发送消息，SSE 流式返回 Agent 事件 |
| `POST /api/agent/stop` | 停止当前会话的 Agent |
| `POST /api/agent/approve` | 审批操作（同意 / 拒绝） |
| `POST /api/todos` | 待办操作（append / remove / reorder） |

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MODEL_PROVIDER` | `anthropic` | 模型提供商：`anthropic` / `deepseek` / `openai` / `google` |
| `MODEL_ID` | `claude-sonnet-4-5` | 模型 ID（deepseek: `deepseek-v4-flash` / `deepseek-v4-pro`） |
| `ANTHROPIC_API_KEY` | - | Anthropic Key |
| `DEEPSEEK_API_KEY` | - | DeepSeek Key |
| `OPENAI_API_KEY` | - | OpenAI Key |
| `GOOGLE_API_KEY` | - | Google Key |
| `MAX_CONTEXT_TOKENS` | `50000` | 累计 token 超过该值时摘要化最早的对话 |
| `KEEP_RECENT_MESSAGES` | `8` | 压缩时保留的最近消息条数 |
| `APPROVAL_TIMEOUT_MS` | `120000` | 敏感工具等待审批的超时毫秒数，超时视为拒绝 |
| `APPROVAL_ALLOW_TOOLS` | 空 | 免审批工具名白名单（逗号分隔），如 `append_file,create_dir` |
| `APPROVAL_ALLOW_PATHS` | 空 | 路径放行规则（逗号分隔）：`notes/` 目录前缀、`*.md` 文件名通配、其他视为路径前缀 |
| `MEMORY_RECALL_K` | `5` | 每次检索注入的历史 episode 条数 |
| `TOOL_EXECUTION` | `parallel` | 并行 / 串行工具执行：`parallel` / `sequential` |
| `WEB_SEARCH_PROVIDER` | `bing` | 搜索提供器：`bing` / `duckduckgo` |
| `AGENT_ALLOWED_PATHS` | 空 | 额外允许 Agent 访问的根目录白名单（逗号分隔的绝对或相对路径），默认仅 `agent-workdir/` |
| `PORT` | `3000` | standalone 产物监听端口 |
| `HOSTNAME` | - | standalone 产物绑定地址（如 `0.0.0.0`） |

## 数据与文件

| 路径 | 说明 |
| --- | --- |
| `agent-workdir/` | Agent 文件工具的工作区，所有读写被限制在此目录内 |
| `sessions.db` | 会话与消息历史（SQLite） |
| `agent-memory.db` | 情景记忆库（SQLite） |

> 三者在 standalone 产物中位于运行目录下，部署时注意持久化挂载。

## 测试脚本

根目录 `test-*.ts` 为针对各模块的脚本，用 `tsx` 直接运行：

```bash
npx tsx test-todo.ts       # 待办工具
npx tsx test-session.ts    # 会话存储
npx tsx test-policy.ts     # 审批白名单策略
npx tsx test-fileops.ts    # 文件操作工具
npx tsx test-web.ts        # 联网搜索 / 网页抓取
npx tsx test-verify.ts     # verify_file 自检
npx tsx test-parallel.ts   # 并行工具执行
npx tsx test-context.ts    # 上下文压缩
npx tsx test-approval.ts   # 工具审批流
```
