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
│  壳（前端 + 桌面）                        │
│  Next.js Web 与 Electron 桌面共用同一前端 │
├─────────────────────────────────────────┤
│  通信层（抽象：AgentEventBus）            │
│  现在：SSE              桌面版沿用 HTTP+SSE│
├─────────────────────────────────────────┤
│  核心（框架无关，纯 TS/Node，复用不变）   │
│  Agent 底座 · 工具/能力层 · 安全审批层    │
└─────────────────────────────────────────┘
```

**硬性约束**：

1. 从 Phase 1 起，`lib/` 下所有核心模块（registry / mcp / skill / subagent / agent / risk / policy / approval / audit / paths / workdir）保持**零 Next.js 依赖**，只依赖 `pi-agent-core` 与 Node 内置。
2. **核心模块逐步参数化，最终不依赖 `process.cwd()` 和 `process.env` 直读**：路径基准通过 `baseDir` 参数注入（Web 传 `process.cwd()`，桌面版由 Electron 壳经 `PRYSM_BASE_DIR=userData` 环境变量注入 Web 后端子进程）；配置数据通过注入的 data source（DB / config 对象）传入。允许在 Phase 2 前保留 env 兼容构造器，以保障测试与路由稳定过渡。
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
  env?: NodeJS.ProcessEnv;               // 兼容期 env 读取（经 config.envValue 统一代理）
  defaultProvider?: string;              // 默认模型 provider
  defaultModel?: string;                 // 默认模型 ID
  allowedRoots?: string[];               // 多工作区根（兼容 env，Phase 1b 后优先 workspace 表）
  skillsDir?: string;                    // 项目 skill 扫描目录（缺省 <baseDir>/skills）
  globalSkillsDir?: string;              // 全局技能目录（缺省 ~/.prysm/skills）
  mcpConfigPath?: string;                // mcp.json 路径
  modelRoutes?: Partial<Record<ModelRole, ModelRoute>>; // 模型路由注入（优先于 model_route 表）
  disableScheduler?: boolean;            // 定时任务调度器：置 true 关闭自动启动（测试用）
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
- 桌面版：Electron 主进程拉起 Next.js 服务并注入 `PRYSM_BASE_DIR=userData`，`lib/core.ts` 的 `createCore` 读取该环境变量作为 `baseDir`（见 `createCore` 内 `process.env.PRYSM_BASE_DIR ?? config.baseDir`），服务子进程内与 Web 完全同构。
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

三个 provider：`BuiltinToolProvider`（现有 26 工具原样迁入）、`McpToolProvider`、`SkillToolProvider`。

命名与元数据：

- 内置工具保留原名；MCP 工具 `mcp__<server>__<tool>`；Skill 工具 `skill__<name>__<tool>`。
- `TOOL_META`（`lib/tool-meta.ts`）现为 `{ label, type, surface?, sensitive?, capability? }`：`SENSITIVE_TOOLS` 已迁入 `sensitive`；`surface` 指导前端渲染与工具集筛选；`capability`（readonly/readwrite）供子 agent 筛选。
- **Phase 1a.1 已对当前 26 个内置工具逐一标记 `capability`**：
  - `readonly`：`list_dir` / `read_file` / `verify_file` / `search_files` / `find` / `web_search` / `fetch_url` / `env_info` / `port_check` / `todo_create` / `todo_modify` / `todo_list` / `plan_propose` / `use_skill` / `remember_memory` / `forget_memory` / `create_automation`
  - `readwrite`：`write_file` / `append_file` / `edit_file` / `create_dir` / `move_file` / `copy_file` / `delete_file` / `run_bash` / `spawn_subagent`

### 5.1 `spawn_subagent` 与循环依赖

`spawn_subagent` 归 `BuiltinToolProvider`，但它需要访问 agent 池和模型——而 `tools.ts` 当前不 import `agent.ts`（`agent.ts` 反向 import `tools.ts`）。直接实现会形成循环依赖。

**解法**：`spawn_subagent` 的 `execute` 通过**延迟注入**（runtime callback）访问 agent 池，而非编译期 import。具体：`BuiltinToolProvider` 接受可选的 `subagentFactory` 回调参数（Phase 5 注入），Phase 1a.1 预留工具定义但 factory 为空（工具不注册或返回「未启用」）。这样 `tools.ts` 不直接依赖 `agent.ts`。

### 5.2 `tools.ts` 现有 re-export 兼容

[tools.ts:12](file:///e:/code/opensource/develop/prysm/lib/tools.ts#L12) 当前 re-export `AGENT_WORKDIR` / `ALLOWED_ROOTS`，测试脚本从 `@/lib/tools` 引入。Phase 1a.1 保留这些 re-export 作为过渡，但标记 deprecated，指向新的 workspace 配置模块；Phase 1b 后测试改用 `PrysmCore.resolveWorkspace()`。

## 6. 能力模块

### 6.1 MCP（work 侧，全量）
- 依赖官方 `@modelcontextprotocol/sdk`；接入 **tools + resources + prompts** 三类能力。
- 传输（对齐 Trae Work MCP 配置）：**stdio（本地子进程）** + **streamable HTTP** + **SSE（远程）**。stdio 走 `command/args/env`；远程走 `url/headers`（如 `Authorization: Bearer xxx`，经 `requestInit` 透传）。SSE 为兼容旧 server 保留（SDK 标注 deprecated）。
- 配置：`mcp.json` 声明 server（command/args 或 url+transport）。默认位置 `<baseDir>/mcp.json`，后续可扩展 per-workspace 覆盖。
- **超时配置**：`START_MCP_TIMEOUT_MS`（连接，默认 15s）/ `RUN_MCP_TIMEOUT_MS`（工具/资源/prompt 调用，默认 60s），stdio 从 `env` 读取、远程从 `headers` 读取；这两个键不随环境变量/请求头透传给对端。
- **变量引用**：`${workspaceFolder}` 启动时替换为最近活跃会话绑定目录（回退默认工作区根 `agent-workdir`），用于构造项目相关命令参数/路径。
- `lib/tools/mcp.ts`：`McpClientPool`（连接生命周期）+ `McpToolProvider` + `jsonSchemaToTypebox`（JSON Schema → typebox，兜底 `Type.Unsafe`）+ `resolveTimeouts` / `applyWorkspaceFolder`。
- `execute` 调 `callTool`；`content` 的 text/image → `AgentToolResult.content`；`structuredContent` stringify 追加为 text；resources/prompts 映射为只读工具或上下文注入。
- **降级**：server 崩溃 / 连接超时 → 该 server 工具标记不可用，agent 收到错误提示而非整体卡死；可配自动重连。

### 6.2 Skill（coding 侧）
- Skill = 可复用能力包 = 提示词片段 + 可选工具（`pi-agent-core` 无此概念，自建轻量版，对齐 pi 的 `SKILL.md`）。
- `skills/<name>/SKILL.md`：frontmatter（`name` / `description` / `tools` / `version`）+ 正文。
- **双目录（Phase 4.1）**：项目技能 `<baseDir>/skills` + 全局技能 `~/.prysm/skills`（可经 `PrysmConfig.globalSkillsDir` 覆盖），同名冲突时项目优先；`SkillDef.source` 标记来源。全局目录写操作前经 `ensureGlobalSkillsDir` 做可写性探测，不可写时（如系统受控文件夹访问拦截）自动回退到 `<baseDir>/global-skills` 并持久化回退选择（`<baseDir>/skill-settings.json`）。
- **按需加载（Phase 4.1，对齐 Trae Work 技能设计）**：系统提示词仅注入已启用技能的**名称+描述索引**（`buildSkillIndex`），不再全量拼入正文；新增内置工具 `use_skill`，模型判断任务相关时调用它以加载完整正文（含技能目录路径，相对路径引用按该目录解析）。
- 生命周期：会话级启用/禁用；开发期热加载；`tools` 经 SkillToolProvider 同名暴露内置/MCP 工具。
- 手动调用：`/skill <名称> [任务]` 斜杠命令；设置面板技能卡片「运行」按钮（新建会话 + 预设技能调用提示词）。

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

### 6.7 偏好记忆（对齐 TraeWork「记忆」设计）
- 区别于「情景记忆」（SQLite 检索式对话轨迹），偏好记忆保存**显式偏好与规则**（markdown 文件），注入系统提示词跨会话持续生效。
- **存储**：全局 `<baseDir>/memory/user_profile.md` + 项目 `<baseDir>/memory/projects/<encoded-workdir>/project_memory.md`（按会话绑定工作目录区分，`lib/preference-memory.ts`）。
- **AI 管理**：内置工具 `remember_memory` / `forget_memory`（对话中"记住/更新/删除"偏好；scope=global|project，默认 project），会话 workdir 由 agent route 经 `setMemoryCtx` 注入。
- **注入**：`getAgent` 构造 systemPrompt 时拼入 `buildPreferencePrompt(workdir)`（全局 + 项目两级，含管理引导）；`context-analysis` 同步估算。
- **UI 管理**：设置面板「数据」Tab 偏好记忆区块（textarea 编辑 + 保存，`/api/memory-files`）；备份/恢复纳入偏好记忆文件（`BackupFile.preferenceMemory`）。

### 6.8 定时任务（自动化，对齐 TraeWork「定时任务」设计）
- 目标：按固定时间/固定间隔自动执行预设任务并生成结果，无需人工干预。触发方式：间隔（任意分钟）/ 固定时间（每天/每周/每月 cron）。
- **数据层** `lib/automation.ts`（独立 `automations.db`）：
  - `automations` 表：名称/内容（prompt）/形态（surface，创建后不可改）/绑定目录（workdir，创建后不可改）/触发（schedule_type=interval|cron + interval_minutes / cron_expr）/schedule_desc（展示描述）/启用态/next_run_at/last_run_at/last_status/last_session_id/run_count。
  - `automation_runs` 表：执行历史（每次执行生成独立会话，可跳转查看对话流）。
  - `computeNextRunAt`：interval 顺延；cron 取下一个匹配点。
- **cron 解析** `lib/cron.ts`（纯函数，零依赖）：标准 5 字段（分 时 日 月 周），支持 `*`、步进、范围、列表；日/周双限定取并集；周 7 归一化为 0；越界/非法表达式抛错；`nextCronRun` 逐分钟推进（上限 5 年防死循环）。
- **调度器** `lib/scheduler.ts`：`startScheduler` 模块级单例（幂等，Web dev 热重载不重复），每 30s tick；`tickAutomations` 选出到期任务执行；上一轮仍 `running` 的任务本轮跳过并记录 `skipped`（防同任务重叠）。`createCore` 自动启动，`PrysmConfig.disableScheduler` 可关闭（测试用）。
- **执行链路** `runAutomationNow`：每次执行**新建独立会话**（title=任务名，surface/workdir 按任务配置）→ `getAgent` + `prompt` + 会话持久化 + `logRun`（复用 `app/api/agent` 收尾链路，无 SSE）→ 记录 run + 推进 next_run → `eventBus` emit `automation_run`。失败记录 `failed` 不阻塞其他任务。
- **对话中创建**：内置工具 `create_automation`（对话中自然语言 → 模型解析为 interval_minutes / cron_expr 结构化参数），surface 取当前会话、workdir 取会话绑定目录；`TOOL_META` 两形态通用。
- **API** `/api/automations`：GET 列表+历史；POST action=create/update/toggle/delete/run。
- **前端**：左栏「自动化」视图（activityView 扩展）+ `components/automation-panel.tsx`：已配置（启停/立即运行/编辑/删除）/ 执行历史（跳转对话流）/ 任务模板（内置 3 模板）/ 手动新建弹窗（interval 或 每天/每周/每月 + 时:分）/ 「在对话中创建」（预填创建提示并聚焦输入框）。
- **备份**：`BackupFile.automations` 纳入导出/恢复（不含执行历史）。

### 6.9 多模型路由
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

> 下列扩展项 1–7 均已落地（对应路线表 Phase 1a.1 / 2 的 ✅ 完成标记）：目录级授权、`resolveInWorkdir` 返回 `ResolveResult`、策略迁入 `permission/global.json`、`mcp__*` / `skill__*` 通配、`SENSITIVE_TOOLS` 迁入 `TOOL_META.sensitive`、审批超时随策略配置。

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
| Electron 桌面 | 复用 Web 前端，SSE 经 HTTP 直传（BrowserWindow 加载 http://127.0.0.1:<port>） |

- **统一双通道**：现有代码有**两套独立事件系统**——`UiEvent`（`agent.ts:288`，`mapEvent(AgentEvent)` 映射，含 `turn_start`/`delta`/`tool_start`/`tool_end`/`turn_end`/`agent_end`）和 `ApprovalLifecycleEvent`（`approval.ts:34`，`subscribeApprovalLifecycle` 订阅，含 `required`/`resolved`/`expired`/`notice`）。`AgentEventBus` **统一两套通道**为单一事件流，审批事件映射为 `approval_request`/`approval_resolved`/`approval_expired`/`approval_notice`。
- **后续扩展**：`BusEvent`（`lib/events.ts`）现已并入 `PlanEvent`（`plan_proposed`/`plan_decided`/`plan_cancelled`）与 `AutomationEvent`（`automation_run`，定时任务调度器 emit），事件均纯 JSON 可序列化。
- **分阶段替换**：
  - Phase 1a.2：定义 `AgentEventBus` 接口；在 `app/api/agent/route.ts` 里用 **bus adapter** 把 `agent.subscribe(mapEvent)` 和 `subscribeApprovalLifecycle` 桥接成 bus 事件发出。核心层不动，只有路由层适配。
  - Phase 7.5：核心层直接通过 bus emit，移除 adapter，SSE 行为不变。
- **事件命名对齐**：`tool_start`/`tool_end` 保留不变；审批事件统一加 `approval_*` 前缀。
- **跨进程状态同步（已解决）**：`approval.ts` 的 `pending`/`listeners`/`lifecycleListeners` 全是模块级内存态。桌面版不再走 IPC——Electron 主进程与 Web 后端同机，BrowserWindow 直接消费 HTTP+SSE，审批事件天然经 SSE 到达渲染层，无需 IPC 序列化适配。

## 9. UI 壳

- **短期（Web 迭代）**：同一 Agent 会话按 `surface` 切视图——Work 视图（任务流、审批卡片、MCP 工具面板）、Coding 视图（diff、终端、文件树、测试结果）。
- **长期（桌面壳，已落地）**：**Electron 复用 Web 前端**——主进程拉起 Next.js 服务（开发 `next dev` / 打包 standalone `server.js`），`BrowserWindow` 加载 `http://127.0.0.1:<port>`，REST + SSE 全走 HTTP，前端零改动；主进程仅负责拉起服务、自动更新、外链打开。
- 桌面形态下文件/命令工具不受浏览器沙箱限制；MCP stdio 作为主进程子进程由 Web 后端统一管理。

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
| 1a.1 | 工具注册表抽象 + 18 工具 `capability` 标记 + `TOOL_META.sensitive` 迁移 + `spawn_subagent` 占位 | — | **✅ 完成** —— `lib/tools/registry.ts` + `lib/tool-meta.ts`（surface/capability/sensitive）+ `spawn_subagent` |
| 1a.2 | `AgentEventBus` 接口定义 + 路由层 bus adapter（桥接 `mapEvent` + `subscribeApprovalLifecycle`，核心层不动） | 1a.1 | **✅ 完成** —— `lib/events.ts`（`SimpleEventBus`，BusEvent 统一四类事件） |
| 1a.3 | Core 工厂 `createCore(config)` + `baseDir` 参数化 + 去除 `process.env` 直读（policy/approval/model/paths）+ 保留 env 兼容构造器 | 1a.2 | **✅ 完成** —— `lib/core.ts` `createCore` + `lib/config.ts`（`configure` / `basePath` / `envValue`） |
| 1b | 多工作区数据模型 + `paths.ts`/`workdir.ts` 改造 + `SYSTEM_PROMPT` 动态化 + env 一次性导入 + `sessions` 表加 `surface` 列 | 1a.3 | **✅ 完成** —— `lib/workspace.ts` + `sessions.surface` 列 + 目录授权 |
| 2 | 安全层升级：`resolveInWorkdir` 返回授权结果 + 目录授权（默认拒绝）+ 策略数据源迁移（最终落 `permission/global.json`）+ policy 通配 + `approval.ts` 配置化 | 1b | **✅ 完成** —— `resolveInWorkdir` 返回 `ResolveResult`；策略迁入 `permission/global.json`（`lib/permission.ts`）；`mcp__*` / `skill__*` 通配；权限模式（manual/auto/full/custom + LLM Guardian） |
| 3 | MCP 全量（tools+resources+prompts，stdio 先行） | 1a.1、2 | **✅ 完成** —— stdio + streamable HTTP + SSE 三传输、`START/RUN_MCP_TIMEOUT_MS` 超时、`${workspaceFolder}` 替换 |
| 4 | Skill 机制（SKILL.md + 动态注入 SYSTEM_PROMPT + 工具） | 1a.1 | **✅ 完成** —— 按需加载（`buildSkillIndex` + `use_skill`）、项目/全局双目录、不可写回退 |
| 5 | 子 agent 编排（`spawn_subagent` 延迟注入打破循环依赖）+ 多模型路由（`ensureModels`→注册表、`PROVIDER_FACTORIES`→动态、`getAgent`→按 config/表选取） | 3、4 | **✅ 完成** —— `lib/subagent.ts` + `lib/model-router.ts`（`modelRoutes` 注入优先于表） |
| 6 | 多模态输入 + 知识库/RAG（`buildContext` 注入顺序：压缩→记忆→RAG） | 1b、3 | **✅ 完成** —— 图片/附件输入（落盘会话 workspace）+ MCP image 渲染 + `lib/rag.ts`（SQLite FTS5 / BM25，无外部嵌入模型） |
| 7 | Plan mode + UI 分化（work/coding 视图） | 1a.1、3、4、5 | **✅ 完成** —— `lib/plan.ts`（propose/decide/cancel/超时/持久化）、`plan_propose` 工具、前端计划卡片与图片渲染、work/coding 视图 |
| 7.5 | 通信层落地（核心层直接 emit `AgentEventBus`，移除路由 adapter，审批事件可序列化） | 7 | **✅ 完成** —— `createCore` 内 agent/approval/plan 直接注入共享 bus（带 sessionId 供按会话隔离），路由只订阅 bus 做 SSE 传输，事件均纯 JSON 可序列化 |
| 8 | 桌面壳（Electron） | 1–7.5 | **✅ 完成** —— 复用 Web 前端：主进程拉起 Next.js 服务（开发 `next dev` / 打包 `standalone server.js` + `ELECTRON_RUN_AS_NODE`），BrowserWindow 加载 `http://127.0.0.1:30123`；数据经 `PRYSM_BASE_DIR=userData` 注入；esbuild 输出 CJS（`external: ["electron","electron-updater"]`）；`electron-builder` extraResources 打包 standalone；自动更新受 `PRYSM_AUTO_UPDATE` 门控 |

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
| 偏好记忆 | 显式偏好/规则 markdown 持久化，注入系统提示词跨会话生效 | 6.7 |
| 定时任务（自动化） | 固定时间/间隔自动执行预设任务并生成结果 | 6.8 |
| 审批策略体系 | 权限模式 + 资源授权（工具/路径/命令）+ LLM Guardian 决策链 | 2 |

## 15. 工程默认方案

- **打包/分发**：Electron Builder + 签名 + `electron-updater` 自动更新（`PRYSM_AUTO_UPDATE=1` 门控，`PRYSM_UPDATE_URL` 可覆盖更新源），Win/Mac/Linux 三平台。
- **测试**：核心沿用 `test:unit` 纯 TS 单测；MCP 用 mock server 测；桌面壳用静态一致性检查（`test-electron.ts`）+ 冒烟启动；Web session 数据用一次性迁移脚本导入桌面 SQLite。
- **pi-coding-agent**：不整体引入（终端 TUI 与桌面/Web 形态冲突、职责重叠），只借鉴其 SKILL.md 格式与 Extension 注册工具的思路。
- **降级策略**：MCP 崩溃 → 工具标记不可用 + 自动重连；子 agent 超时 → 返回部分结果；模型路由失败 → 回退主模型。各模块独立降级，不整体卡死。
- **Electron 主进程构建**：esbuild 输出 **CJS**（`main.cjs`）——ESM 输出下 electron-updater 内部 `require("child_process")` 会触发 "Dynamic require" 崩溃；`external: ["electron","electron-updater"]`（bundle 进 electron 会拿到二进制路径字符串而非 API，electron-updater 顶层副作用会触发 spawn 崩溃）；开发/打包判定用 `process.defaultApp`（部分环境下 `app.isPackaged` 误判 true）。

## 16. 遗留决策点（已解决）

- ~~RAG 索引策略~~：已落地为 SQLite FTS5 + BM25 关键词匹配（中文按字符分词），增量扫描已授权工作区（按 mtime+size 跳过未变更），无需外部嵌入模型；索引存独立 `agent-rag.db`。
- ~~Plan mode 确认交互细节~~：已支持批准 / 拒绝 / 取消（超时视为拒绝），计划持久化 `plans.db`，Web 与 Electron 均可渲染计划卡片。
