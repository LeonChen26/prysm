# Prysm 目标架构与落地路线（v8）

> 目标形态：从「单工具 chat Web」演进为 **Work + Coding 双形态的本地桌面应用**（类 trae / gpt-work）。
> 本文档是动手前的完整蓝图，汇总全部已定决策与分阶段路线。

## 0. 愿景与目标形态

- **Work 形态**：办公 / 自动化，价值来自接入外部工具生态（飞书、GitHub、浏览器、数据库、支付等）。
- **Coding 形态**：IDE 式编码（文件读写、命令执行、代码搜索、diff、测试、部署）+ 可复用能力沉淀。
- 二者共享同一套 Agent 底座、安全审批 / 审计，差别只在上层交互与下层工具来源。

## 1. 架构原则：核心与 UI 壳解耦

```
┌─────────────────────────────────────────┐
│  壳（可替换）                            │
│  现在：Next.js Web       未来：Electron    │
├─────────────────────────────────────────┤
│  通信层（抽象：AgentEventBus）            │
│  现在：SSE              未来：IPC/本地事件流 │
├─────────────────────────────────────────┤
│  核心（框架无关，纯 TS/Node，复用不变）   │
│  Agent 底座 · 工具/能力层 · 安全审批层    │
└─────────────────────────────────────────┘
```

**硬性约束**：

1. 从 Phase 1 起，`lib/` 下所有核心模块（registry / mcp / skill / subagent / agent / risk / policy / approval / audit / paths / workdir）保持**零 Next.js 依赖**，只依赖 `pi-agent-core` 与 Node 内置。
2. **核心模块逐步参数化，最终不依赖 `process.cwd()` 和 `process.env` 直读**：路径基准通过 `baseDir` 参数注入（Web 传 `process.cwd()`，Electron 传 `app.getPath('userData')`）；配置数据通过注入的 data source（DB / config 对象）传入。允许在 Phase 2 前保留 env 兼容构造器，以保障测试与路由稳定过渡。
3. **`AgentEventBus` 事件契约在 Phase 1a.2 定义**（接口先行），Phase 1b–7 通过路由层 adapter 桥接现有双通道，Phase 7.5 再替换为核心层直连 bus。

## 2. 总体分层：复用 vs 新建

| 层 | 现状 | 目标动作 |
| --- | --- | --- |
| 产品形态层 | 无 | 新建（work / coding 视图） |
| Agent 底座 | `pi-agent-core` | 复用 |
| 工具 / 能力扩展层 | 硬编码 `lib/tools.ts` | 新建（核心） |
| 安全审批 / 审计层 | `risk/policy/approval/audit` | 复用 + 扩展 |
| UI 壳 | 单一 `ChatPanel.tsx` | Web 先行，Electron 可替换 |

## 3. Core 工厂（新增）

为统一参数注入，新增 `lib/core.ts` 的 `createCore(config)` 工厂：

```ts
// lib/core.ts
export interface PrysmConfig {
  baseDir: string;                       // 路径基准：Web=process.cwd(), Electron=userData
  env?: NodeJS.ProcessEnv;               // 兼容期，Phase 2 前用于 policy/approval/model 默认值
  defaultProvider?: string;              // 默认模型 provider
  defaultModel?: string;                 // 默认模型 ID
  approvalTimeoutMs?: number;            // 审批超时
  allowedRoots?: string[];               // 多工作区根（兼容 env，Phase 1b 后优先 workspace 表）
  skillsDir?: string;                    // skill 扫描目录
  mcpConfigPath?: string;                // mcp.json 路径
}

export interface PrysmCore {
  getAgent: (sessionId: string, opts?: GetAgentOptions) => Promise<Agent>;
  listSessions: () => SessionInfo[];
  createSession: (surface?: Surface) => SessionInfo;
  listWorkspaces: () => WorkspaceInfo[];
  resolveWorkspace: (sessionId: string) => WorkspaceInfo;
  eventBus: AgentEventBus;
  // 后续扩展：registry, modelRouter, mcpPool 等
}

export function createCore(config: PrysmConfig): PrysmCore;
```

- Web 路由 `app/api/agent/route.ts` 启动时调用 `createCore({ baseDir: process.cwd(), env: process.env })`。
- Electron 主进程调用 `createCore({ baseDir: app.getPath('userData') })`。
- 现有模块级函数（`getAgent`/`createSession`/...）在 Phase 1a.3 改为从 `PrysmCore` 实例暴露，避免全局单例。

## 4. 数据模型

### 4.1 工作区模型：多项目 / 多工作区

- 现有 `lib/paths.ts` 的 `ALLOWED_ROOTS`（env `AGENT_ALLOWED_PATHS`，逗号分隔）**已支持多根**，Phase 1b 将其从 env 驱动升级为一等公民数据模型（workspace/project 表 + UI 管理）。
- **env 迁移路径**：Phase 1b 提供一次性导入——启动时若检测到 `AGENT_ALLOWED_PATHS` 且 workspace 表为空，自动导入为 workspace 记录；导入后 env 仅保留只读兼容，不再作为权威来源。
- 需同步改造 `lib/workdir.ts`（文件浏览器后端，同样依赖 `resolveInWorkdir`，当前锁死单根）。

### 4.2 会话模型：work / coding 独立上下文

- 会话带 `surface`（work/coding）标签，各自维护独立 Agent 上下文。
- **一个 session 只属于一个 surface**（创建会话时确定），`agentPool` 继续按 `sessionId` 键控，不需要复合 key。surface 影响：系统提示词、工具集筛选（`resolve({surface})`）、UI 视图。
- **schema 迁移**：现有 `session.ts` 的 `sessions` 表（`id/title/created_at/updated_at/pinned`）需加 `surface` 列（`TEXT NOT NULL DEFAULT 'coding'`），沿用现有 `PRAGMA table_info` + 补列的迁移模式。

### 4.3 存储：纯本地单用户，SQLite

- **驱动统一用 `node:sqlite`（Node 内置，`engines >=20.9` 已满足）**，与现有 `audit.ts` / `session.ts` / `memory.ts` / `todo.ts` 一致，不引入 better-sqlite3。
- **DB 组织决策**：现有 4 个独立 DB（`sessions.db` / `agent-memory.db` / `todo.db` / `audit.db`）保持不动；Phase 2 新增的 policy / authorization / workspace / model_route 表**合并进一个新的 `prysm.db`**（配置与授权类数据集中管理），不继续散建。
- **DB 文件位置参数化**：现在在 `process.cwd()`，Phase 1a.3 起改为 `baseDir` 注入；桌面版放 `app.getPath('userData')`。
- 不做账号与云同步。

## 5. 工具 / 能力扩展层（核心）

把「工具从哪来」与「工具怎么执行」解耦：

```ts
// lib/tools/registry.ts
interface ToolProvider {
  id: string;                    // builtin / mcp:<server> / skill:<name>
  load(): Promise<AgentTool[]>;
}

interface ToolFilter {
  surface?: "work" | "coding";
  capability?: "readonly" | "readwrite";
}

class ToolRegistry {
  register(p: ToolProvider): void;
  resolve(filter?: ToolFilter): Promise<AgentTool[]>;  // 聚合，冲突时后注册者覆盖；filter 供子 agent 按类型筛选
}
```

- `resolve(filter)` 在 Phase 1a.1 预留接口，Phase 5 子 agent 用它筛选只读 / 读写工具集，避免返工。
- **注册时机：静态注册**。registry 在会话/Agent 构造时一次性 resolve；**不使用** `pi-agent-core` 的 `addedToolNames` 运行时动态添加工具机制（保持简单，后续有需要再议）。

三个 provider：`BuiltinToolProvider`（现有 18 工具原样迁入）、`McpToolProvider`、`SkillToolProvider`。

命名与元数据：

- 内置工具保留原名；MCP 工具 `mcp__<server>__<tool>`；Skill 工具 `skill__<name>__<tool>`。
- `TOOL_META`（`lib/tool-meta.ts`，当前仅 `{ label, type }`）迁移为 `{ label, type, surface?, sensitive?, capability? }`：将 `agent.ts` 中硬编码的 `SENSITIVE_TOOLS` 集合迁入 `sensitive`，新增 `surface` 指导前端渲染与工具集筛选，`capability`（readonly/readwrite）供子 agent 筛选。
- **Phase 1a.1 需对现有 18 工具逐一标记 `capability`**：
  - `readonly`：`list_dir` / `read_file` / `verify_file` / `search_files` / `web_search` / `fetch_url` / `env_info` / `port_check` / `todo_create` / `todo_modify` / `todo_list`
  - `readwrite`：`write_file` / `append_file` / `create_dir` / `move_file` / `copy_file` / `delete_file` / `run_bash`

### 5.1 `spawn_subagent` 与循环依赖

`spawn_subagent` 归 `BuiltinToolProvider`，但它需要访问 agent 池和模型——而 `tools.ts` 当前不 import `agent.ts`（`agent.ts` 反向 import `tools.ts`）。直接实现会形成循环依赖。

**解法**：`spawn_subagent` 的 `execute` 通过**延迟注入**（runtime callback）访问 agent 池，而非编译期 import。具体：`BuiltinToolProvider` 接受可选的 `subagentFactory` 回调参数（Phase 5 注入），Phase 1a.1 预留工具定义但 factory 为空（工具不注册或返回「未启用」）。这样 `tools.ts` 不直接依赖 `agent.ts`。

### 5.2 `tools.ts` 现有 re-export 兼容

[tools.ts:12](file:///e:/code/opensource/develop/prysm/lib/tools.ts#L12) 当前 re-export `AGENT_WORKDIR` / `ALLOWED_ROOTS`，测试脚本从 `@/lib/tools` 引入。Phase 1a.1 保留这些 re-export 作为过渡，但标记 deprecated，指向新的 workspace 配置模块；Phase 1b 后测试改用 `PrysmCore.resolveWorkspace()`。

## 6. 能力模块

### 6.1 MCP（work 侧，全量）
- 依赖官方 `@modelcontextprotocol/sdk`；接入 **tools + resources + prompts** 三类能力。
- 传输：**stdio（本地子进程）先行**，SSE / streamable HTTP 后补。
- 配置：`mcp.json` 声明 server（command/args 或 url+transport）。默认位置 `<baseDir>/mcp.json`，后续可扩展 per-workspace 覆盖。
- `lib/tools/mcp.ts`：`McpClientPool`（连接生命周期）+ `McpToolProvider` + `jsonSchemaToTypebox`（JSON Schema → typebox，兜底 `Type.Unsafe`）。
- `execute` 调 `callTool`；`content` 的 text/image → `AgentToolResult.content`；`structuredContent` stringify 追加为 text；resources/prompts 映射为只读工具或上下文注入。
- **降级**：server 崩溃 / 连接超时 → 该 server 工具标记不可用，agent 收到错误提示而非整体卡死；可配自动重连。

### 6.2 Skill（coding 侧）
- Skill = 可复用能力包 = 提示词片段 + 可选工具（`pi-agent-core` 无此概念，自建轻量版，对齐 pi 的 `SKILL.md`）。
- `skills/<name>/SKILL.md`：frontmatter（`name` / `description` / `tools` / `version`）+ 正文。
- 启动扫描 `skills/`（默认 `<baseDir>/skills`），`tools` 注册到 registry。
- **注入时机**：`SYSTEM_PROMPT`（现为 `agent.ts` 静态常量）改为在 `getAgent` 构造 Agent 时**按会话启用的 skill 动态拼装**（基础提示词 + 启用 skill 的正文），而非全局静态拼接。
- **`SYSTEM_PROMPT` 硬编码路径修正**：现有提示词正文写死「agent-workdir 目录」（`agent.ts:29-30`），多工作区后工作区根不再固定。Phase 1b 将基础提示词改为**函数**（`buildSystemPrompt(workspaceRoots)`），动态注入当前工作区路径。
- 生命周期：会话级启用/禁用；开发期热加载；版本/冲突用 `name+version` 去重，后注册覆盖。

### 6.3 子 agent（任务级编排）
- 主 agent 通过 `spawn_subagent` 内置工具派生；prysm 层维护「子 agent 池」。
- **池键控**：`agentPool` 按 `sessionId` 键控不变；子 agent 用独立池，key 为 `${parentSessionId}:${subagentId}`，与主会话池隔离。
- 类型：只读研究型（`resolve({capability:"readonly"})`）/ 读写执行型（`resolve({capability:"readwrite"})`）。
- 上下文隔离：每个子 agent 是独立 `Agent` 实例，完成后只返回摘要/结构化结果，不污染主上下文。
- 权限/审批继承：敏感操作走同一 `risk/policy/approval/audit`，审批卡片带「子 agent」标识回传父会话。
- 并发/资源控制：并发数、超时、取消（复用 stop）、token/耗时预算。
- **降级**：子 agent 超时 → 返回已完成的部分结果 + 超时标记；token 预算耗尽 → 强制终止并回传摘要。

### 6.4 Plan mode（计划模式）
- 定位：`todo` 是「执行中拆解」，Plan mode 是「执行前规划 + 人工确认」。
- 主 agent 先产出结构化计划（步骤 + 涉及工具 + 预期），UI 渲染为可编辑卡片，用户确认后才执行。
- **与审批流的语义区分**：审批流是「工具调用时」的逐次确认（`beforeToolCall`）；Plan mode 是「执行前」对整体计划的一次性确认。二者**复用 UI 卡片组件与确认交互**，但是两条独立链路，不混用 `beforeToolCall` 钩子。
- 数据模型复用 `todo`。
- **与 surface 的关系**：Plan mode 是通用机制，但 prompt/卡片文案按 surface 区分——coding 形态强调「编码计划、涉及文件/命令」，work 形态强调「工作流计划、涉及 MCP 工具」。

### 6.5 多模态输入
- 图片/附件作为消息输入（work 形态常见），以及 MCP 返回 `image` 的渲染。
- 消息 `content` 支持 image/attachment；**上传落盘到当前会话所属 workspace 的根目录**（多工作区下按会话的 workspace 归属定位）；前端 `chat-blocks` 扩展图片渲染。

### 6.6 知识库 / RAG
- work 形态对项目文档做检索增强，区别于现有「情景记忆」（跨会话经验，`buildContext` 中的 `retrieveEpisodes`）。
- 新增检索源（本地文件索引 / 向量库），在 `buildContext` 里与现有 memory 注入并列。
- **注入顺序与 token 预算**：`buildContext` 内部流程为 ① `transformContext`（上下文压缩/摘要） → ② 情景记忆注入 → ③ RAG 检索注入（Phase 6 新增）。三者各有 token 预算上限，按优先级分配（压缩 > 记忆 > RAG），超出则截断。
- 依赖 `buildContext` 挂载点（Phase 1a.1）和多工作区文档索引（Phase 1b）。
- **待 Phase 6 前细化的决策点**：索引策略（全量 vs 增量）、索引存储位置（建议随 workspace 存 `prysm.db` 或独立索引文件）、嵌入模型选型（本地 vs API）。

### 6.7 多模型路由
- 强模型编排、小模型执行/摘要/标题。现有 `ensureModels` 已支持多 provider，`generateTitle`/`summarize` 已用模型做轻任务，此处显式化 + 路由策略化。
- **改造点（三处）**：
  1. `ensureModels`（`agent.ts:42`）：当前是模块级单例 `let models`，仅缓存单一 provider/model。需改为**模型注册表**（多 provider/model 并存），按需获取。
  2. `PROVIDER_FACTORIES`（`agent.ts:13-18`）：当前硬编码 4 个 provider map。需改为动态注册（从 `model_route` 表读取）。
  3. `getAgent`（`agent.ts:211`）：当前硬编码 `DEFAULT_PROVIDER`/`DEFAULT_MODEL`。需改为从 `PrysmConfig` / `model_route` 表选取。
- `DEFAULT_PROVIDER`/`DEFAULT_MODEL` 参数化（Phase 1a.3）：当前 `agent.ts:22-24` 是模块级常量读 env，改为 `PrysmConfig.defaultProvider` / `defaultModel`。
- 子 agent 默认用小模型。
- 模型注册表存 `prysm.db` 的 `model_route` 表。
- **降级**：路由目标模型不可用 → 回退主模型并记录告警。

## 7. 安全 / 权限 / 审计

现有链路保留：

```
beforeToolCall
  → policy.isDenied()      黑名单拦截
  → policy.isAutoApproved() 白名单放行
  → risk.assessRisk()      风险分级
  → approval.requestApproval() 人工审批（超时拒绝）
  → audit.logApproval()     落审计
```

扩展：

1. **目录级授权 + 默认拒绝**（类 Claude Desktop）：首次访问某目录/命令需授权，可记住授权；新增持久化「授权表」（`prysm.db`）替代/增强 `APPROVAL_*` env 白名单。
2. **`paths.ts` 接口变更（Phase 2 前置）**：`resolveInWorkdir` 当前越界直接 `throw`，需改为返回结构化结果（`{ ok } | { ok: false, needsAuthorization, root }`），让上层走授权/审批流而非崩溃。所有调用方（`tools.ts` / `workdir.ts`）同步适配。
3. **`policy.ts` 数据源注入（Phase 1a.3/2）**：当前 `parse()` 在模块加载时直读 `process.env`，`cached` 模块级缓存。需改为通过 `PrysmConfig` 初始化，并支持运行时 reload（Phase 2 从 `prysm.db` 读取）。保留 env 兼容构造器供测试，但路由使用注入配置。
4. **policy 通配**：工具名匹配支持 `mcp__*` / `skill__*`，批量管控。
5. **敏感判定**：将 `agent.ts` 硬编码的 `SENSITIVE_TOOLS` 集合迁入 `TOOL_META.sensitive`，MCP/Skill/子 agent 工具按元数据判定。
6. **风险分级**：`risk.ts` 的 `TOOL_BASE_RISK` 增加按来源（mcp/skill/subagent）的默认等级。
7. **`approval.ts` 参数化（Phase 1a.3）**：`APPROVAL_TIMEOUT_MS`（`approval.ts:61`）当前是模块级常量读 env，需改为 `PrysmConfig.approvalTimeoutMs` 注入。保留 env 兼容构造器供测试。

## 8. 通信层抽象（AgentEventBus）

核心只 `emit` 事件，壳侧适配：

| 壳 | 适配方式 |
| --- | --- |
| Web（现在） | SSE 长连接 |
| Electron（未来） | IPC / 主进程↔渲染进程事件流 |

- **统一双通道**：现有代码有**两套独立事件系统**——`UiEvent`（`agent.ts:288`，`mapEvent(AgentEvent)` 映射，含 `turn_start`/`delta`/`tool_start`/`tool_end`/`turn_end`/`agent_end`）和 `ApprovalLifecycleEvent`（`approval.ts:34`，`subscribeApprovalLifecycle` 订阅，含 `required`/`resolved`/`expired`/`notice`）。`AgentEventBus` **统一两套通道**为单一事件流，审批事件映射为 `approval_request`/`approval_resolved`/`approval_expired`/`approval_notice`。
- **分阶段替换**：
  - Phase 1a.2：定义 `AgentEventBus` 接口；在 `app/api/agent/route.ts` 里用 **bus adapter** 把 `agent.subscribe(mapEvent)` 和 `subscribeApprovalLifecycle` 桥接成 bus 事件发出。核心层不动，只有路由层适配。
  - Phase 7.5：核心层直接通过 bus emit，移除 adapter，SSE 行为不变。
- **事件命名对齐**：`tool_start`/`tool_end` 保留不变；审批事件统一加 `approval_*` 前缀。
- **跨进程状态同步（Phase 8 前置）**：`approval.ts` 的 `pending`/`listeners`/`lifecycleListeners` 全是模块级内存态。Web 单进程无问题；Electron 主进程→渲染进程需经 IPC 序列化传递审批事件。Phase 7.5 落地时确保所有事件可序列化（无函数引用、无循环结构），`AgentEventBus` 在 Electron 侧做 IPC 适配。

## 9. UI 壳

- **短期（Web 迭代）**：同一 Agent 会话按 `surface` 切视图——Work 视图（任务流、审批卡片、MCP 工具面板）、Coding 视图（diff、终端、文件树、测试结果）。
- **长期（桌面壳）**：核心 + 前端组件不变，仅换壳为 **Electron**；核心 + MCP stdio 迁入主进程。
- 桌面形态下 MCP stdio 成为首选传输，文件/命令工具不再受浏览器沙箱限制。

## 10. 配置体系

| 配置 | 格式 | 位置 | 加载时机 | 说明 |
| --- | --- | --- | --- | --- |
| Core 启动配置 | `PrysmConfig` 对象 | 代码注入 | 启动 | `baseDir` / `defaultProvider` / `defaultModel` / `approvalTimeoutMs` / env 兼容 |
| MCP servers | `mcp.json` | `<baseDir>/mcp.json` | 启动 + 热加载 | command/args（stdio）或 url+transport（远程） |
| Skills | `SKILL.md` | `<baseDir>/skills/<name>/` | 启动 + 热加载 | frontmatter + 正文 |
| 多工作区 | `workspace` 表 | `prysm.db` | 启动 | project 根目录、授权状态 |
| 模型路由 | `model_route` 表 | `prysm.db` | 启动 | 任务类型 → 模型/provider 映射 |
| 安全策略 | `policy` 表 | `prysm.db` | 启动 + 动态 | 白/黑名单、风险规则、授权记录 |
| 审批超时 | `approval_timeout_ms` 字段 | `prysm.db` policy 表 / Core config | 启动 | 替代 `APPROVAL_TIMEOUT_MS` env |

优先级：SQLite 策略 > `PrysmConfig` > env（兼容期保留）> 默认值。env 配置（`APPROVAL_*` / `AGENT_ALLOWED_PATHS` / `MODEL_PROVIDER` / `MODEL_ID` / `APPROVAL_TIMEOUT_MS`）在 Phase 2 前兼容，之后逐步迁移到 SQLite 或 `PrysmConfig`（workspace 表提供一次性导入）。

## 11. 可观测性

- **审计**（现有）：`audit.ts` 记录每次敏感操作的审批结果。
- **运行日志**（现有）：`agent.ts` 的 `runLogs`（内存，50 条上限，含工具调用次数统计），作为运行统计基础。
- **MCP 连接状态**：server 在线/离线、最后错误，前端面板可查。
- **子 agent 资源**：并发数、token/耗时，父会话可见。
- **模型路由**：命中/未命中、fallback 次数、累计成本估算。
- 不引入额外可观测性框架，复用现有 `console.log` + audit 表 + runLogs，桌面版可扩展为本地日志面板。

## 12. 分阶段路线（12 Phase）

| Phase | 内容 | 依赖 | 验收 |
| --- | --- | --- | --- |
| 1a.1 | 工具注册表抽象 + 18 工具 `capability` 标记 + `TOOL_META.sensitive` 迁移 + `spawn_subagent` 占位 | — | test 全绿、行为不变、`resolve(filter)` 接口预留 |
| 1a.2 | `AgentEventBus` 接口定义 + 路由层 bus adapter（桥接 `mapEvent` + `subscribeApprovalLifecycle`，核心层不动） | 1a.1 | SSE 行为不变、事件命名统一 |
| 1a.3 | Core 工厂 `createCore(config)` + `baseDir` 参数化 + 去除 `process.env` 直读（policy/approval/model/paths）+ 保留 env 兼容构造器 | 1a.2 | Web 路由改用 core 实例、test 全绿、无模块级 cwd/env 依赖 |
| 1b | 多工作区数据模型 + `paths.ts`/`workdir.ts` 改造 + `SYSTEM_PROMPT` 动态化 + env 一次性导入 + `sessions` 表加 `surface` 列 | 1a.3 | 支持多 project 根、文件浏览器多根可用、提示词含实际工作区路径 |
| 2 | 安全层升级：`resolveInWorkdir` 返回授权结果 + 目录授权（默认拒绝）+ `policy.ts` 数据源迁移 SQLite（`prysm.db`）+ policy 通配 + `approval.ts` 配置化 | 1b | 越界目录默认拒绝并触发授权、策略可持久化/可视化、无 env 直读 |
| 3 | MCP 全量（tools+resources+prompts，stdio 先行） | 1a.1、2 | MCP 三能力接入、敏感走授权、崩溃可降级 |
| 4 | Skill 机制（SKILL.md + 动态注入 SYSTEM_PROMPT + 工具） | 1a.1 | skill 启用后生效、工具可调用 |
| 5 | 子 agent 编排（`spawn_subagent` 延迟注入打破循环依赖）+ 多模型路由（`ensureModels`→注册表、`PROVIDER_FACTORIES`→动态、`getAgent`→按 config/表选取） | 3、4 | 派生只读/执行子 agent、审批回传、小模型降本 |
| 6 | 多模态输入 + 知识库/RAG（`buildContext` 注入顺序：压缩→记忆→RAG） | 1b、3 | 图片/附件输入（落盘会话 workspace）、MCP image 渲染、文档检索注入 |
| 7 | Plan mode + UI 分化（work/coding 视图） | 1a.1、3、4、5 | **✅ 完成** —— `lib/plan.ts`（propose/decide/cancel/超时/持久化）、`plan_propose` 工具、前端计划卡片与图片渲染、work/coding 视图 |
| 7.5 | 通信层落地（核心层直接 emit `AgentEventBus`，移除路由 adapter，审批事件可序列化） | 7 | **✅ 完成** —— `createCore` 内 agent/approval/plan 直接注入共享 bus（带 sessionId 供按会话隔离），路由只订阅 bus 做 SSE 传输，事件均纯 JSON 可序列化 |
| 8 | 桌面壳（Electron） | 1–7.5 | **✅ 完成** —— `electron/` 主进程（`baseDir=userData`、IPC 桥、事件流 `prysm:event`）、preload contextBridge、静态渲染页、esbuild 打包、`npm run electron:dev` 启动 |

## 13. 决策汇总

| # | 维度 | 决策 |
| --- | --- | --- |
| 1 | 工作区模型 | 多项目 / 多工作区（基于现有 `ALLOWED_ROOTS` 升级，env 一次性导入） |
| 2 | 部署形态 | 纯本地单用户 |
| 3 | 桌面框架 | Electron |
| 4 | MCP 范围 | tools + resources + prompts |
| 5 | 会话模型 | work / coding 独立上下文（一个 session 一个 surface） |
| 6 | 权限模型 | 目录级授权 + 默认拒绝 |
| 7 | 策略存储 | SQLite（`node:sqlite` 驱动）+ 可视化；新表集中进 `prysm.db` |
| 8 | 工具注册 | 静态注册，不用 `addedToolNames` 运行时动态添加 |
| 9 | 路径基准 | `baseDir` 参数注入，核心最终不依赖 `process.cwd()` |
| 10 | 配置注入 | 新增 `createCore(config)` 工厂统一注入，兼容 env 构造器过渡 |
| 11 | 事件通道 | `AgentEventBus` 统一 `UiEvent` + `ApprovalLifecycleEvent` 双通道，先 adapter 后直连 |
| 12 | 子 agent 依赖 | `spawn_subagent` 延迟注入（runtime callback），打破 tools↔agent 循环 |
| 13 | 模型管理 | `ensureModels` 单例 → 模型注册表；`PROVIDER_FACTORIES` → 动态注册；默认模型参数化 |

## 14. 已纳入能力清单

| 能力 | 定位 | 落位 Phase |
| --- | --- | --- |
| 子 agent | 任务级并行与隔离（只读研究 / 读写执行） | 5 |
| Plan mode | 执行前规划 + 人工确认（独立于审批流） | 7 |
| 多模态输入 | 图片/附件输入 + MCP image 渲染 | 6 |
| 知识库 / RAG | 项目文档检索增强，与情景记忆并列 | 6 |
| 多模型路由 | 强模型编排、小模型执行，子 agent 默认小模型 | 5 |

## 15. 工程默认方案

- **打包/分发**：Electron Builder + 签名 + `electron-updater` 自动更新，Win/Mac/Linux 三平台。
- **测试**：核心沿用 `test:unit` 纯 TS 单测；MCP 用 mock server 测；桌面壳用 Playwright；Web session 数据用一次性迁移脚本导入桌面 SQLite。
- **pi-coding-agent**：不整体引入（终端 TUI 与桌面/Web 形态冲突、职责重叠），只借鉴其 SKILL.md 格式与 Extension 注册工具的思路。
- **降级策略**：MCP 崩溃 → 工具标记不可用 + 自动重连；子 agent 超时 → 返回部分结果；模型路由失败 → 回退主模型。各模块独立降级，不整体卡死。
- **Electron 主进程 ESM**：`package.json` 已设 `"type": "module"`，Electron 主进程可直接使用 ESM 加载核心；渲染进程复用 Next.js/React 前端组件，通过 IPC 与主进程通信。

## 16. 遗留决策点（Phase 6 前敲定）

- RAG 索引策略：全量 vs 增量；索引存储位置（建议随 workspace 存 `prysm.db` 或独立索引文件）；嵌入模型选型（本地 vs API）。
- Plan mode 确认交互细节：是否支持编辑/跳过步骤、是否允许部分确认、失败后回退策略。
