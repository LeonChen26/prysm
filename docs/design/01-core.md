# 01 · 核心编排层（Core / Agent / Events / Context / Session / Subagent / ModelRouter）

> 覆盖：`lib/core.ts`、`lib/agent.ts`、`lib/events.ts`、`lib/context.ts`、`lib/context-analysis.ts`、
> `lib/agent-context.ts`、`lib/messages.ts`、`lib/session.ts`、`lib/subagent.ts`、`lib/model-router.ts`

## 1. 职责总览

| 模块 | 职责 | 关键状态 |
|---|---|---|
| `core.ts` | PrysmCore 工厂：统一注入配置、装配事件总线、暴露领域 API | 无（每次 createCore 新建） |
| `agent.ts` | Agent 底座：池化管理、系统提示词、审批决策链、上下文注入、子 agent 执行器 | `agentPool` / `agentModels` / `stoppedSessions`（模块级） |
| `events.ts` | 统一 `BusEvent` 类型 + `SimpleEventBus`（进程内发布订阅） | 无 |
| `context.ts` | 上下文压缩（token 估算 + 超限摘要化旧消息） | 阈值惰性读 env |
| `context-analysis.ts` | 上下文构成统计（右侧面板 Tab 数据源） | 无 |
| `agent-context.ts` | 会话级 workdir 内存映射 | `sessionWorkdirs` Map |
| `messages.ts` | AgentMessage → 纯文本提取 | 无 |
| `session.ts` | 会话/消息 SQLite 持久化（软删 + 轮次级联） | `db` 单例 |
| `subagent.ts` | 子 agent 编排（并发槽 / 超时 / 取消 / 记录池） | `pool` / `running` |
| `model-router.ts` | 多模型路由（注入 > 表 > 默认）与 provider 实例缓存 | `db` / `modelsCache` |

## 2. Core 工厂（lib/core.ts）

`createCore(config)` 是唯一装配入口，Web 路由与 Electron 共用：

```ts
createCore({
  baseDir,              // Web=process.cwd()，Electron=PRYSM_BASE_DIR(userData)
  env, defaultProvider, defaultModel,
  allowedRoots, skillsDir, globalSkillsDir, mcpConfigPath,
  modelRoutes, disableScheduler,
})
```

创建时依次：`configure(config)` 写全局配置 → 新建 `SimpleEventBus` → 订阅审批/计划生命周期（转译为 BusEvent）→ `bindAutomationEventBus` → `startScheduler()`（幂等）。

**关键点**：`getAgent(sessionId)` 包装了池化获取，并用 `WeakSet<Agent>` 保证每个 Agent 实例只注册一次 bus 监听器——这是修过「流式文本重复拼接」bug 的防护（同实例多次 getAgent 不重复订阅）。事件统一带 sessionId emit，路由层按会话过滤。

## 3. Agent 底座（lib/agent.ts）

### 3.1 池化与构造流程

`getAgent(sessionId)`（:432-480）：
1. 池命中直接返回实例；
2. 未命中：`resolveModel("orchestrator")` + `checkAuth` → `getSessionMessages` 恢复历史 → 读 surface/workdir → 拼 basePrompt + skillIndex + preferenceMemory → `new Agent({ initialState, streamFn, toolExecution, transformContext: buildContext, beforeToolCall: makeBeforeToolCall(sessionId) })` → 入池。

> ⚠️ 无并发锁：同一 sessionId 两个并发请求可能各自 `new Agent()`，后者覆盖前者（见 bug-audit H1）。

### 3.2 系统提示词（按 surface 分化）

- base prompt 按 `surface`（work/coding）给出不同定位说明；
- 附加 `buildSkillIndex`（已启用技能的名称+描述索引）与 `buildPreferencePrompt(workdir)`（全局+项目偏好记忆）。

### 3.3 上下文注入顺序（buildContext）

代码实际顺序（两处 `base.unshift`）：

```
[RAG 检索结果, 情景记忆, 压缩后的消息历史]
```

> 文件头注释写「压缩 → 记忆 → RAG」，实际为反序（先 unshift RAG 后被记忆覆盖在前）。读取顺序最终为 RAG 最前。已知文档与实现不符（低危，bug-audit L7）。

### 3.4 审批决策链（makeBeforeToolCall）

见 [03-security.md](03-security.md) §2，入口在 agent.ts:328。

### 3.5 子 agent 执行器

`spawn_subagent` 工具经 `subagentFactory` 回调注入（避免 tools↔agent 循环依赖）。子 agent 用 `resolveAgentTools({ capability })` 筛选只读/读写工具集。

## 4. 事件总线（lib/events.ts）

- `BusEvent` = `UiEvent`（delta/tool_start/tool_end/turn_end/agent_end...）+ `ApprovalEvent`（approval_request/resolved/expired/notice）+ `PlanEvent`（plan_proposed/decided/cancelled）+ `AutomationEvent`（automation_run）。
- `SimpleEventBus`：`Set<listener>` + emit 遍历，subscribe 返回退订函数。
- 所有事件纯 JSON 可序列化（审批/计划均已在核心层 emit 前映射为普通对象）。

> ⚠️ emit 无 try/catch：任一监听器抛错会中断后续监听器（bug-audit L1）。

## 5. 上下文压缩（lib/context.ts）

- token 估算：CJK ≈ 1.2 字符/token，其他 3.5；
- 超 `MAX_CONTEXT_TOKENS`（默认 50000）时：把最早一批消息交给 LLM 摘要为一条 assistant 消息，保留最近 `KEEP_RECENT_MESSAGES`（默认 8）条；摘要失败降级为直接丢弃旧消息（保证不 throw，符合 pi `transformContext` 契约）。

> ⚠️ 摘要消息手工构造（role/content/timestamp），缺 id 等运行时字段（bug-audit L19）。

## 6. 会话持久化（lib/session.ts）

### 6.1 表结构

`sessions`（id/title/created_at/updated_at/pinned/surface/workdir）+ `session_messages`（id/session_id/seq/role/content/deleted）。

### 6.2 消息保存语义

- `saveSessionMessages`：`DELETE ... WHERE deleted = 0` 后全量重插（软删行保留，id 稳定）。
- `getSessionMessages`：一律 `WHERE deleted = 0 ORDER BY id`。
- `deleteSessionMessages`（软删 + 轮次级联）：UI 索引映射回全量行（跳过 toolResult 行），从删除点级联到「下一条 user 消息之前」统一 `UPDATE deleted=1`。
- `clearSessionMessages` / `deleteSession`：物理删除。

> ⚠️ saveSessionMessages 无事务（DELETE 与 INSERT 之间异常会丢消息，bug-audit M3）。

### 6.3 搜索

`LIKE '%query%'` 参数化 + 每会话最多 1 条命中 + 片段裁剪。通配符 `%`/`_` 未转义（bug-audit L2）。

## 7. 子 agent（lib/subagent.ts）

- 池 key：`${parentSessionId}:${subagentId}`（tools.ts 传 `parentSessionId: _toolCallId`，即工具调用 ID）。
- 并发槽 `MAX_CONCURRENCY=3`；`withTimeout(runner, 120s)`；取消 `abortSubagent` 幂等。
- 流程：acquireSlot → pool.set(running) → withTimeout → 成功/失败/超时更新 rec.status → finally releaseSlot。

> ⚠️ abort 与 finally 双重释放并发计数（M1）；withTimeout 超时仅 reject 不中止底层 runner（M2）；子 agent 审批事件 sessionId 与主会话隔离冲突，前端收不到审批卡（H3，见 bug-audit）。

## 8. 模型路由（lib/model-router.ts）

- 角色：orchestrator / subagent / summarize / title。
- 优先级：`PrysmConfig.modelRoutes` 注入 > `model_route` 表（prysm.db）> 默认。
- provider 实例缓存 `modelsCache`；路由目标不可用 → 回退主模型并记录告警。
- 首次 getDb 时 `INSERT OR IGNORE` 默认路由（自愈）。

> ⚠️ 并发首次加载同一 provider 可能创建多实例（M5）；降级路径不 checkAuth（M6）。

## 9. 关键设计决策

1. **零 Next.js 依赖**：核心层只用 pi 包 + Node 内置；baseDir 注入替代 process.cwd() 直读。
2. **事件总线统一**：审批/计划/自动化事件全部经 bus 转发，SSE 只做传输。
3. **软删 + 轮次级联**：单条删除不真删，杜绝「无因之果」上下文断裂。
4. **池化复用**：Agent 实例按会话常驻内存池，消息状态以内存为准、DB 为持久化镜像。
5. **buildContext 不抛错契约**：摘要/记忆/RAG 检索全部 try/catch 降级，保证 pi 执行循环不断。

## 10. 已知问题（详见 bug-audit.md）

| 级别 | 摘要 |
|---|---|
| 高 | getAgent 并发无锁 → 双实例、事件重复、消息覆盖（agent.ts:433） |
| 高 | 子 agent 敏感工具审批事件无法送达前端 → 卡到超时拒绝（tools.ts:1041 + route.ts:179） |
| 中 | saveSessionMessages 无事务（session.ts:237）；subagent 双重释放计数（subagent.ts:82/161）；model-router 并发双创建（M5）；降级不 checkAuth（M6）；agent-context 内存泄漏（M4）；会话删除不清理池（M8） |
| 低 | events emit 无 try/catch；LIKE 未转义；token 估算口径不一致（context vs context-analysis）；注入顺序注释不符；stoppedSessions 残留；DB 单例无 reset |
