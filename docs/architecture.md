# Prysm 目标架构与落地路线（v5）

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

**硬性约束**：从 Phase 1 起，`lib/` 下所有核心模块（registry / mcp / skill / subagent / agent / risk / policy / approval / audit / paths / workdir）保持**零 Next.js 依赖**，只依赖 `pi-agent-core` 与 Node 内置。

## 2. 总体分层：复用 vs 新建

| 层 | 现状 | 目标动作 |
| --- | --- | --- |
| 产品形态层 | 无 | 新建（work / coding 视图） |
| Agent 底座 | `pi-agent-core` | 复用 |
| 工具 / 能力扩展层 | 硬编码 `lib/tools.ts` | 新建（核心） |
| 安全审批 / 审计层 | `risk/policy/approval/audit` | 复用 + 扩展 |
| UI 壳 | 单一 `ChatPanel.tsx` | Web 先行，Electron 可替换 |

## 3. 数据模型

- **工作区模型：多项目 / 多工作区**。现有 `lib/paths.ts` 的 `ALLOWED_ROOTS`（env `AGENT_ALLOWED_PATHS`，逗号分隔）**已支持多根**，Phase 1b 将其从 env 驱动升级为一等公民数据模型（workspace/project 表 + UI 管理）。需同步改造 `lib/workdir.ts`（文件浏览器后端，同样依赖 `resolveInWorkdir`，当前锁死单根）。
- **会话模型：work / coding 独立上下文**。会话带 `surface`（work/coding）标签，各自维护独立 Agent 上下文。
- **部署：纯本地单用户**。数据本地 SQLite（sessions / memory / todo / audit + 新增 policy / authorization），不做账号与云同步。

## 4. 工具 / 能力扩展层（核心）

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

`resolve(filter)` 在 Phase 1 预留接口，Phase 5 子 agent 用它筛选只读 / 读写工具集，避免返工。

三个 provider：`BuiltinToolProvider`（现有 18 工具原样迁入）、`McpToolProvider`、`SkillToolProvider`。

命名与元数据：

- 内置工具保留原名；MCP 工具 `mcp__<server>__<tool>`；Skill 工具 `skill__<name>__<tool>`。
- `TOOL_META`（`lib/tool-meta.ts`，当前仅 `{ label, type }`）迁移为 `{ label, type, surface?, sensitive? }`：将 `agent.ts` 中硬编码的 `SENSITIVE_TOOLS` 集合迁入 `TOOL_META.sensitive`，新增 `surface` 字段指导前端渲染。

## 5. 能力模块

### 5.1 MCP（work 侧，全量）
- 依赖官方 `@modelcontextprotocol/sdk`；接入 **tools + resources + prompts** 三类能力。
- 传输：**stdio（本地子进程）先行**，SSE / streamable HTTP 后补。
- 配置：`mcp.json` 声明 server（command/args 或 url+transport）。
- `lib/tools/mcp.ts`：`McpClientPool`（连接生命周期）+ `McpToolProvider` + `jsonSchemaToTypebox`（JSON Schema → typebox，兜底 `Type.Unsafe`）。
- `execute` 调 `callTool`；`content` 的 text/image → `AgentToolResult.content`；`structuredContent` stringify 追加为 text；resources/prompts 映射为只读工具或上下文注入。
- **降级**：server 崩溃 / 连接超时 → 该 server 工具标记不可用，agent 收到错误提示而非整体卡死；可配自动重连。

### 5.2 Skill（coding 侧）
- Skill = 可复用能力包 = 提示词片段 + 可选工具（`pi-agent-core` 无此概念，自建轻量版，对齐 pi 的 `SKILL.md`）。
- `skills/<name>/SKILL.md`：frontmatter（`name` / `description` / `tools` / `version`）+ 正文。
- 启动扫描 `skills/`，正文拼入 `SYSTEM_PROMPT`，`tools` 注册到 registry。
- 生命周期：会话级启用/禁用；开发期热加载；版本/冲突用 `name+version` 去重，后注册覆盖。

### 5.3 子 agent（任务级编排）
- 主 agent 通过 `spawn_subagent` 内置工具派生；prysm 层维护「子 agent 池」（复用 `agentPool` 思路）。
- 类型：只读研究型（`resolve({capability:"readonly"})`）/ 读写执行型（`resolve({capability:"readwrite"})`）。
- 上下文隔离：每个子 agent 是独立 `Agent` 实例，完成后只返回摘要/结构化结果，不污染主上下文。
- 权限/审批继承：敏感操作走同一 `risk/policy/approval/audit`，审批卡片带「子 agent」标识回传父会话。
- 并发/资源控制：并发数、超时、取消（复用 stop）、token/耗时预算。
- **降级**：子 agent 超时 → 返回已完成的部分结果 + 超时标记；token 预算耗尽 → 强制终止并回传摘要。

### 5.4 Plan mode（计划模式）
- 定位：`todo` 是「执行中拆解」，Plan mode 是「执行前规划 + 人工确认」。
- 主 agent 先产出结构化计划（步骤 + 涉及工具 + 预期），UI 渲染为可编辑卡片，用户确认后才执行；本质是在 agent loop 前加一道人工闸门，复用 `todo` 数据模型 + 审批流机制。

### 5.5 多模态输入
- 图片/附件作为消息输入（work 形态常见），以及 MCP 返回 `image` 的渲染。
- 消息 `content` 支持 image/attachment，上传走 workdir；前端 `chat-blocks` 扩展图片渲染。

### 5.6 知识库 / RAG
- work 形态对项目文档做检索增强，区别于现有「情景记忆」（跨会话经验，`buildContext` 中的 `retrieveEpisodes`）。
- 新增检索源（本地文件索引 / 向量库），在 `buildContext` 里与现有 memory 注入并列。
- 依赖 `buildContext` 挂载点（Phase 1a）和多工作区文档索引（Phase 1b）。

### 5.7 多模型路由
- 强模型编排、小模型执行/摘要/标题。现有 `ensureModels` 已支持多 provider，`generateTitle`/`summarize` 已用模型做轻任务，此处显式化 + 路由策略化。
- 模型注册表 + 按任务类型/成本路由；子 agent 默认用小模型。
- **降级**：路由目标模型不可用 → 回退主模型并记录告警。

## 6. 安全 / 权限 / 审计

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

1. **目录级授权 + 默认拒绝**（类 Claude Desktop）：首次访问某目录/命令需授权，可记住授权；新增持久化「授权表」替代/增强 `APPROVAL_*` env 白名单。
2. **SQLite 策略 + 可视化**：白/黑名单、风险规则存入 SQLite，前端可视化配置、动态生效；`policy.ts` 从 env 惰性解析改为 DB 读取 + 缓存。
3. **policy 通配**：工具名匹配支持 `mcp__*` / `skill__*`，批量管控。
4. **敏感判定**：将 `agent.ts` 硬编码的 `SENSITIVE_TOOLS` 集合迁入 `TOOL_META.sensitive`，MCP/Skill/子 agent 工具按元数据判定。
5. **风险分级**：`risk.ts` 的 `TOOL_BASE_RISK` 增加按来源（mcp/skill/subagent）的默认等级。

## 7. 通信层抽象（AgentEventBus）

核心只 `emit` 事件，壳侧适配：

| 壳 | 适配方式 |
| --- | --- |
| Web（现在） | SSE 长连接 |
| Electron（未来） | IPC / 主进程↔渲染进程事件流 |

`AgentEventBus` 定义统一事件契约（`turn_start` / `tool_call` / `tool_result` / `approval_request` / `turn_end` 等），核心不感知传输细节。Phase 8 桌面壳的硬前置，在 Phase 7.5 落地。

## 8. UI 壳

- **短期（Web 迭代）**：同一 Agent 会话按 `surface` 切视图——Work 视图（任务流、审批卡片、MCP 工具面板）、Coding 视图（diff、终端、文件树、测试结果）。
- **长期（桌面壳）**：核心 + 前端组件不变，仅换壳为 **Electron**；核心 + MCP stdio 迁入主进程。
- 桌面形态下 MCP stdio 成为首选传输，文件/命令工具不再受浏览器沙箱限制。

## 9. 配置体系

| 配置 | 格式 | 加载时机 | 说明 |
| --- | --- | --- | --- |
| MCP servers | `mcp.json` | 启动 + 热加载 | command/args（stdio）或 url+transport（远程） |
| Skills | `skills/<name>/SKILL.md` | 启动 + 热加载 | frontmatter + 正文 |
| 多工作区 | SQLite `workspace` 表 | 启动 | project 根目录、授权状态 |
| 模型路由 | SQLite `model_route` 表 | 启动 | 任务类型 → 模型/provider 映射 |
| 安全策略 | SQLite `policy` 表 | 启动 + 动态 | 白/黑名单、风险规则、授权记录 |

优先级：SQLite 策略 > env（兼容期保留）> 默认值。env 配置仅在 Phase 2 前兼容，之后逐步迁移到 SQLite。

## 10. 可观测性

- **审计**（现有）：`audit.ts` 记录每次敏感操作的审批结果。
- **MCP 连接状态**：server 在线/离线、最后错误，前端面板可查。
- **子 agent 资源**：并发数、token/耗时，父会话可见。
- **模型路由**：命中/未命中、fallback 次数、累计成本估算。
- 不引入额外可观测性框架，复用现有 `console.log` + audit 表，桌面版可扩展为本地日志面板。

## 11. 分阶段路线（10 Phase）

| Phase | 内容 | 依赖 | 验收 |
| --- | --- | --- | --- |
| 1a | 工具注册表抽象（纯重构，零 Next.js） | — | test 全绿、行为不变、`resolve(filter)` 接口预留 |
| 1b | 多工作区数据模型 + `paths.ts`/`workdir.ts` 改造 | 1a | 支持多 project 根、文件浏览器多根可用 |
| 2 | 安全层升级：目录授权（默认拒绝）+ SQLite 策略 + policy 通配 | 1b | 越界目录默认拒绝、策略可持久化/可视化 |
| 3 | MCP 全量（tools+resources+prompts，stdio 先行） | 1a、2 | MCP 三能力接入、敏感走授权、崩溃可降级 |
| 4 | Skill 机制（SKILL.md + 注入 + 工具） | 1a | skill 启用后生效、工具可调用 |
| 5 | 子 agent 编排 + 多模型路由 | 3、4 | 派生只读/执行子 agent、审批回传、小模型降本 |
| 6 | 多模态输入 + 知识库/RAG | 1b、3 | 图片/附件输入、MCP image 渲染、文档检索注入 |
| 7 | Plan mode + UI 分化（work/coding 视图） | 1a、3、4、5 | 先计划确认再执行、两类工具分视图 |
| 7.5 | 通信层抽象（AgentEventBus） | 7 | 核心只 emit、SSE 适配不变、为桌面壳铺路 |
| 8 | 桌面壳（Electron） | 1–7.5 | 核心迁主进程、MCP stdio、前端复用、IPC 适配 |

## 12. 决策汇总

| # | 维度 | 决策 |
| --- | --- | --- |
| 1 | 工作区模型 | 多项目 / 多工作区（基于现有 `ALLOWED_ROOTS` 升级） |
| 2 | 部署形态 | 纯本地单用户 |
| 3 | 桌面框架 | Electron |
| 4 | MCP 范围 | tools + resources + prompts |
| 5 | 会话模型 | work / coding 独立上下文 |
| 6 | 权限模型 | 目录级授权 + 默认拒绝 |
| 7 | 策略存储 | SQLite + 可视化 |

## 13. 已纳入能力清单

| 能力 | 定位 | 落位 Phase |
| --- | --- | --- |
| 子 agent | 任务级并行与隔离（只读研究 / 读写执行） | 5 |
| Plan mode | 执行前规划 + 人工确认 | 7 |
| 多模态输入 | 图片/附件输入 + MCP image 渲染 | 6 |
| 知识库 / RAG | 项目文档检索增强，与情景记忆并列 | 6 |
| 多模型路由 | 强模型编排、小模型执行，子 agent 默认小模型 | 5 |

## 14. 工程默认方案

- **打包/分发**：Electron Builder + 签名 + `electron-updater` 自动更新，Win/Mac/Linux 三平台。
- **测试**：核心沿用 `test:unit` 纯 TS 单测；MCP 用 mock server 测；桌面壳用 Playwright；Web session 数据用一次性迁移脚本导入桌面 SQLite。
- **pi-coding-agent**：不整体引入（终端 TUI 与桌面/Web 形态冲突、职责重叠），只借鉴其 SKILL.md 格式与 Extension 注册工具的思路。
- **降级策略**：MCP 崩溃 → 工具标记不可用 + 自动重连；子 agent 超时 → 返回部分结果；模型路由失败 → 回退主模型。各模块独立降级，不整体卡死。
