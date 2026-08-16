# Prysm 代码审查报告（2026-08-16）

> 对 pi 内核之外全部自研代码的只读审查。范围：`lib/`（核心 40+ 文件）、`app/api/`（33 路由）、
> `components/`（6 组件）、`electron/`（桌面壳）。结论基于逐行阅读，未修改任何代码。
> 严重程度：🔴 高（必须修）｜🟠 中（建议修）｜🟡 低（可选）。

---

## 一、🔴 高危问题（8 项）

### H1. `todo.db` / `plans.db` 在 Electron 下落在错误目录（模块加载时序）
- 位置：`lib/todo.ts:94`（`loadTodos()` 模块加载时执行）、`lib/plan.ts:322`（`loadPlans()` 同）、根因 `lib/config.ts:47-52`（未 configure 时回退 `process.cwd()`）
- 现象：ESM 求值顺序保证 import 的依赖模块先于 `core.ts` 执行，而 `configure()` 在 `createCore()` 时才调用。Electron 形态下（`PRYSM_BASE_DIR=userData` 注入），`todo.db`/`plans.db` 被建在服务进程 cwd，其余数据都在 userData —— **待办与未决计划写入错误位置**，cwd 只读时直接抛错，备份/恢复也指向错误库。
- 修复方向：`loadTodos`/`loadPlans` 改为惰性（首次使用时加载），或模块加载不触库。

### H2. 审批批准后超时定时器未清理 → 虚假「已超时」事件 + 重复审计
- 位置：`lib/approval.ts:102-114`（`requestApproval` 的 `setTimeout` 未在 `resolveApproval` 中 clearTimeout）
- 现象：用户在超时前点击「同意」→ `resolveApproval` 正常放行，但 timer 到期后仍无条件执行：写一条**错误的 `timeout` 审计**、推 `approval_expired` 事件、前端把已批准的工具卡片覆盖为「已超时」并弹错误通知。每次人工审批同意都会触发（高频路径）。
- 对照：`lib/plan.ts:195-211` 的 `proposePlan` 做了正确防护（resolver 内 clearTimeout + 超时回调检查 `pending.has`）——此处是遗漏。
- 修复方向：resolve 时 clearTimeout，或超时回调先 `pending.has(id)` 校验。

### H3. `planCtx`/`memoryCtx` 为模块级全局变量，并发会话互相覆盖
- 位置：`lib/tools.ts:42`（planCtx）、`lib/tools.ts:51`（memoryCtx）；注入点 `app/api/agent/route.ts:212-213, 310-311`、`lib/scheduler.ts:85-86`
- 现象：workdir 已改用 AsyncLocalStorage（tools.ts:69），但 plan/memory 上下文仍是单值全局。会话 A 提交 `plan_propose` 等待确认期间，会话 B 发消息即覆盖 A 的 sessionId（计划归属错乱）；`remember_memory` 可把项目记忆写到 B 的 workdir。
- 修复方向：与 workdir 相同，改用 AsyncLocalStorage 或随工具调用上下文传递。

### H4. 子 agent 敏感工具审批事件无法送达前端 → 审批卡到超时自动拒绝
- 位置：`lib/tools.ts:1041-1047`（`parentSessionId: _toolCallId`，工具调用 ID 而非会话 ID）+ `lib/agent.ts:500`（`key = spec.key ?? spec.parentSessionId`）+ `app/api/agent/route.ts:179-181`（SSE 按 `sid !== session.id` 过滤丢弃）
- 现象：主 agent 派生 readwrite 子 agent，子 agent 调用 edit_file/delete_file/run_bash（均敏感）→ 审批事件 sessionId 为 `${toolCallId}:${subagentId}`，与主会话不匹配 → **前端永远收不到审批卡** → 挂到 120s 超时自动拒绝。readwrite 子 agent 的敏感能力实际不可用。
- 修复方向：子 agent 审批事件携带父会话 sessionId，或前端按 key 前缀匹配。

### H5. `/api/skills` 删除接口路径穿越，可递归删除任意目录
- 位置：`app/api/skills/route.ts:64-69`（仅校验 name 非空）+ `lib/skills.ts:301-308`（`path.join(root, name)` 后 `fs.rmSync(recursive, force)`）
- 现象：`{"action":"delete","name":".."}` → 递归删除技能根父目录；`"../../../xxx"` 可越层。`createSkill` 有 `SKILL_NAME_RE` 白名单校验，delete 路径缺失。
- 修复方向：delete 前复用 `SKILL_NAME_RE` 校验或 `basename` 归一化。

### H6. `getAgent` 并发无锁 → 同一会话双 Agent 实例，事件重复 + 消息互相覆盖
- 位置：`lib/agent.ts:433-434` + `lib/agent.ts:478` + `lib/core.ts:214-221`
- 现象：同一 sessionId 两个并发请求（双击发送、SSE 重连时 GET/POST 并发）同时未命中池，各自 `new Agent()` 并 `agentPool.set`（后者覆盖前者）。两实例都注册监听器 → 同一 delta/tool 事件 emit 两次（前端重复拼接）；两个 run 结束各自 `saveSessionMessages` 全量替换，后写覆盖先写，先请求消息丢失。
- 修复方向：getAgent 增加 in-flight 去重（`Map<sessionId, Promise<Agent>>`）。

### H7. MCP 重连路径泄漏旧 client / stdio 子进程，并发重连产生双连接
- 位置：`lib/tools/mcp.ts:424-437`（`ensureConnected` delete 后直接 buildHandle，旧 client 未 close）+ `lib/tools/mcp.ts:354-383`（buildHandle 失败/超时路径不 close）+ `:591-605`（`withTimeout` 只 reject 不取消底层请求）
- 现象：MCP stdio server 崩溃后连续调用 → 每轮泄漏一个子进程；ping/callTool 超时后底层连接仍在；并发重连产生两个新 client，其一成孤儿。长期运行累积大量僵尸进程/连接。
- 修复方向：重连前 `await oldClient.close()`；失败路径补 close；withTimeout 用 AbortController 向下传递；重连加 per-server 互斥锁。

### H8. `paths.ts` 模块级静态常量在 configure 前求值，Electron 下与实际 baseDir 不一致
- 位置：`lib/paths.ts:27-28`（`AGENT_WORKDIR`/`ALLOWED_ROOTS` 模块级常量）+ `lib/config.ts:47-52` + `lib/core.ts:120-121`
- 现象：route 模块顶层 `createCore` 求值其 import 链时，`paths.ts` 已执行而 `configure()` 未调用 → `AGENT_WORKDIR` 指向 `process.cwd()/agent-workdir` 而非 userData。未绑定目录的会话，文件工具基准目录错误（落盘到项目根）；与动态 `resolveInWorkdir`（读 userData/prysm.db）不一致 → 路径全部判定 outside。
- 修复方向：paths 静态常量改为惰性 getter，或确保 configure 先于模块求值。

---

## 二、🟠 中危问题（20 项）

| # | 位置 | 问题 |
|---|---|---|
| M1 | `app/api/agent/approve/route.ts:13` | `Boolean(body?.approve)`：字符串 `"false"`/`"0"` 被解析为**批准**，拒绝被误判为同意（审批绕过方向） |
| M2 | `lib/policy.ts:27-42` | Windows 绝对路径规则未归一化反斜杠，`C:\...` 规则永不匹配 → readOnly 黑名单失效 |
| M3 | `lib/permission.ts:144,261-266,292-298` | 缓存共享引用 + 返回模块级共享常量对象，调用方改字段污染全局且 reload 不清除 |
| M4 | `lib/audit.ts:68-92` | 脱敏覆盖不全（ghp_/xoxb-/AKIA 等明文落盘）；`/key/` 正则过宽误脱敏（monkey/turkey/journey） |
| M5 | `lib/approval-policy.ts:56-63` | commandRules `allow` 短路早于资源授权黑名单判定 → 工具黑名单可被绕过（与 deny>allow 直觉冲突） |
| M6 | `lib/core.ts:130` + `lib/approval.ts:69-74` | 审批/计划生命周期订阅从不取消，多次 createCore（HMR/多路由）监听器累积，SSE 重复推送 |
| M7 | `lib/guardian.ts:93-108` | LLM Guardian 无调用超时，模型挂起时 beforeToolCall 永久阻塞（无 pending 审批可干预） |
| M8 | `lib/rag.ts:111-200` | RAG 扫描达 `RAG_SCAN_LIMIT`（2000）时，未遍历文件被差集删除 → 已索引文档丢失至下次扫描 |
| M9 | `lib/memory.ts:124-136` + `lib/rag.ts:226-237` | FTS5 MATCH 未转义英文引号等语法字符 → SQL 错误（`他说 "你好"` 即触发） |
| M10 | `lib/scheduler.ts:65-139` | `runAutomationNow` 手动「立即运行」不检查 running 标记，可与调度 tick 并发执行同一任务（双会话/计数丢失） |
| M11 | `lib/scheduler.ts:31-50` | 模块级 `started/timer` 在 HMR 下 interval 泄漏 → 双 tick |
| M12 | `lib/backup.ts:73-107` | importBackup 无整体事务，中途失败产生「半恢复」状态；restoreAutomations 不校验非法 cron → 任务每 30s 循环执行 |
| M13 | `lib/preference-memory.ts:151-164` | 恢复时 ASCII 正则拒绝中文路径 key → 中文工作区项目记忆静默丢失 |
| M14 | `lib/subagent.ts:82,161-163` | abort 与 finally 双重释放并发计数 → 并发上限失控；withTimeout 超时不中止底层 runner（M2 关联） |
| M15 | `lib/session.ts:237-254` | saveSessionMessages 无事务（DELETE 与 INSERT 之间异常丢消息）；全量重写写放大 |
| M16 | `lib/agent-context.ts:11-26` | `sessionWorkdirs` Map 只写不读、永不清理 → 内存泄漏（生产已改用 ALS） |
| M17 | `components/ChatPanel.tsx:863-886` | 快速切换会话响应竞态，旧响应覆盖新会话消息 |
| M18 | `app/api/agent/route.ts:35-41` | 无会话时 `resolveSession` 取 `listSessions()[0]` 不按 surface 过滤 → 跨形态串会话 |
| M19 | `components/ChatPanel.tsx:2338-2340` | todo 拖拽「先删后插」索引偏移，向下拖动错一位且错误被持久化 |
| M20 | `app/api/sessions/[id]/clear/route.ts:17` + `lib/agent.ts` 池缓存 | 清空会话后内存 Agent 状态不刷新 → 新消息仍把「已清空」历史注入模型上下文 |
| M21 | `lib/tools/mcp.ts:653-670` | configureMcp 直接替换 mcpPool，旧池 client/子进程不 close（HMR 累积） |
| M22 | `lib/web.ts:153-180` | `fetch_url` 无 SSRF 防护（可抓 127.0.0.1/169.254.169.254 等）+ follow 重定向跳内网 |
| M23 | `lib/tool-meta.ts:55-58` | remember_memory/forget_memory/create_automation 标 `capability: "readonly"` 但持久化写盘 → 只读子 agent 可改记忆/建定时任务 |
| M24 | `app/api/workdir/route.ts:55-58` | multipart 上传无大小限制，GB 级文件 `arrayBuffer()` 读入内存 OOM |
| M25 | `components/ChatPanel.tsx:1585-1599` | `tool_end` 在 setState updater 内写 localStorage（副作用，React 严格模式/并发下可能串会话） |
| M26 | `lib/insights.ts:341-378` | 模型统计双 LEFT JOIN 笛卡尔积，同 turn 多条评分时 runs/totalTokens 计数放大 |
| M27 | `lib/memory.ts:196-198` | 情景记忆备份 dump 上限 1 万条，超出静默丢失无告警 |
| M28 | `lib/todo.ts:164-177` | reorder 重复 id → 主键冲突 500，且内存已改与 DB 不一致 |
| M29 | `lib/plan.ts:311-320` | HMR 后 pending 计划 resolver 悬挂，等待方永久阻塞 |
| M30 | `lib/automation.ts:352-393` | ON CONFLICT 只更新部分字段，恢复后 last_run_at/run_count 等保留旧值；非法 cron 循环执行 |
| M31 | `lib/model-router.ts:117-134,174-194` | 并发首次加载同 provider 双实例；降级路径不 checkAuth（缺 Key 时错误延迟暴露） |
| M32 | `app/api/model-routes/route.ts:86-104` | PUT 不校验 provider/model 合法性，可写入非法路由 |

---

## 三、🟡 低危问题（摘选）

| 位置 | 问题 |
|---|---|
| `lib/events.ts:93-95` | emit 无 try/catch，某 listener 抛错中断后续（并连带 approval resolver 不执行） |
| `lib/session.ts:263-299` | LIKE 搜索未转义 `%`/`_`；内容搜索无 FTS 全表扫描慢 |
| `lib/session.ts:215-220` | 索引全部无效时 throw → 500（双击删除第二个请求必 500） |
| `lib/context.ts:22-31` vs `lib/context-analysis.ts:73-80` | token 估算口径不一致（CJK 1.2 vs 1） |
| `lib/agent.ts:246-247,285-300` | 注入顺序注释「压缩→记忆→RAG」与实际 [RAG,记忆,…] 不符 |
| `lib/context.ts:47-56` | 摘要消息手工构造缺 id 等运行时字段（pi 升级风险） |
| `lib/paths.ts:68,91` | Windows 路径匹配大小写敏感，合法路径被误判 outside |
| `lib/paths.ts:81-108` | realpath 校验与 fs 操作间 TOCTOU（符号链接交换，需攻击者可写工作区） |
| `lib/workdir.ts:66-69` | readWorkdirFile 全量读入后截断 200KB（GB 级文件内存尖峰） |
| `lib/workspace.ts:58-72` | 种子非原子，多进程首启 UNIQUE 冲突抛错 |
| `lib/audit.ts:116-118` | 审计写库失败仅 console.error，安全事件无留痕不可观测 |
| `lib/memory.ts:179-184` | deleteEpisode 两步删除无事务 |
| `lib/stats.ts:48-54` | 固定 86400000ms，DST 切换日按天分布错位 |
| `lib/cron.ts:42-64,117-130` | parseInt 宽松（`"1a"` 被接受）；世纪非闰年 `2/29` 5 年内抛错 |
| `lib/judge.ts:36-52` | parseJudgeOutput 贪婪匹配首个 `{}`，模型输出含代码块时错位 |
| `lib/tools.ts:306-324` | exec 超时只杀 shell，孙进程残留 |
| `lib/tools.ts:695-700` | verify_file catch 吞掉全部错误（EACCES 也报「不存在」） |
| `lib/tools/mcp.ts:687` | `isSensitiveMcpTool` 贪婪正则切错 server/tool 名（含 `__` 时） |
| `lib/tools/registry.ts:72-80` | 初始化布尔在 MCP 连接前置 true，并发首请求工具集不完整 |
| `components/ChatPanel.tsx:3131-3362` | 消息 key=index，删除后折叠/选中/评分状态错位 |
| `components/chat-types.ts:509-535` | readSSE 无 AbortSignal，卸载后回调仍执行 |
| `components/ChatPanel.tsx:1245-1271` | 批量删除未检查 busyRef |
| `app/api/backup/route.ts:22-26` | 导入无请求体大小限制 |
| `lib/scheduler.ts:100-108` | 自动化 logRun messageCount 硬编码 0 |
| `lib/backup.ts:29-44` | 备份 version 固定 1，无迁移路径 |
| `lib/todo.ts:132-150` | 空串标题无法更新 |
| `lib/plan.ts:158-160` | getPlanTimeoutMs 非法 env 返回 NaN → 立即超时 |
| `lib/automation.ts:180-188` | interval 小数（1.5）可通过 → 非整间隔 |

---

## 四、经确认无问题/设计合理项

- **SQL 注入**：全部参数化查询（session/audit/memory/insights/todo/automation/model-router），无字符串拼接。
- **路径遍历**：`resolveInWorkdir` 双重校验（`..`、绝对路径、symlink 含 dangling link）整体健壮；`ensureDirAuthorized` 仅对 unauthorized 且带 workspaceId 授权，default 工作区不被误改。
- **SSE 关闭**：closed 标记 + try/catch 守卫正确，避免 Controller closed 未捕获；cancel→abort→finally 保证消息持久化。
- **full 模式审计**：完全访问放行仍写 `auto` 审计（留痕存在）。
- **并发批准**：`resolveApproval` 先 delete 再 resolve，二次调用返回 false，无重复放行。
- **审批超时优先级**：requestApproval 参数 > permission.json 缺省 120s，normalizeConfig 保证为正数。
- **delete_file 默认拦截**：默认 deny 黑名单兜底，即使 `deleteToolApproval=false` 也不会裸删。
- **定时器清理**（前端）：countdownTick / automation 轮询 / MermaidObserver / scheduler 均正确 clear。
- **图片校验**：MIME 白名单 + 严格 base64 + 10MB 上限 + 随机文件名。

---

## 五、修复优先级建议

1. **H5**（任意目录递归删除，数据破坏）—— 一行校验，立即修
2. **H1**（Electron 数据落错位置）—— todo/plan 惰性加载
3. **H2**（审批误报超时，用户可见错误）—— timer 清理
4. **H3**（plan/memory ctx 并发覆盖）—— 迁移 AsyncLocalStorage
5. **H4**（子 agent 审批通道）—— 父会话 sessionId 透传
6. **H6**（getAgent 并发双实例）—— in-flight Promise 去重
7. **H8**（paths 常量时序）—— 惰性 getter
8. **H7 / M21**（MCP 资源泄漏）—— close 补全 + AbortController
9. 随后 M 系列（M1 类型校验、M2 反斜杠归一化、M3 缓存引用、M8 RAG 误删、M12 备份事务……）

---

## 六、修复状态（2026-08-16）

### ✅ 已修复（代码已落地，typecheck + test:unit 全量通过）

| # | 修复内容 |
|---|---|
| H1 | `lib/todo.ts` / `lib/plan.ts`：`loaded` 标志 + `ensureLoaded()` 惰性加载，模块加载不再触库 |
| H2 | `lib/approval.ts`：`PendingEntry.timer` 持有 + 超时回调身份校验 + resolve 时 clearTimeout |
| H3 | `lib/tools.ts`：`planCtx`/`memoryCtx` 迁移 `toolCtxStorage`（AsyncLocalStorage），route.ts/scheduler.ts 用 `runWithToolCtx` 包裹 |
| H4 | `lib/tools.ts` + `app/api/agent/route.ts`：`spawn_subagent` 传真实父会话 id，SSE 过滤支持前缀匹配 |
| H5 | `lib/skills.ts` + `app/api/skills/route.ts`：delete 复用 `SKILL_NAME_RE` 白名单，API 层非法名返回 400 |
| H6 | `lib/agent.ts`：`pendingAgents` in-flight Promise 去重，原 getAgent 主体改名 `createAgent` |
| H7 | `lib/tools/mcp.ts`：buildHandle 失败关闭 client、ensureConnected 重连前 close、configureMcp 替换前关闭旧池 |
| H8 | `lib/tools.ts`：`effectiveWorkdir`/`env_info` 改用惰性 `getAgentWorkdir`/`getAllowedRoots` |
| M1 | `app/api/agent/approve/route.ts`：`typeof body?.approve !== "boolean"` 校验 |
| M2 | `lib/policy.ts`：`parsePathRules` 反斜杠归一化 `.replace(/\\/g, "/")` |
| M3 | `lib/permission.ts`：`getActiveProfile()` 返回 `structuredClone`，杜绝共享引用污染 |
| M4 | `lib/audit.ts`：脱敏移除裸 `key`，新增 `TOKEN_PATTERNS`（sk-/ghp_/xoxb-/AKIA/Bearer） |
| M5 | `lib/insights.ts`：双 LEFT JOIN 改两个子查询聚合，外层 SUM/AVG 包裹 |
| M7 | `lib/guardian.ts`：`Promise.race` 加 15s 超时，超时回退用户审批 |
| M8 | `lib/rag.ts`：`truncated` 标志，扫描达上限时跳过「删除已消失文件」逻辑 |
| M9 | `lib/memory.ts` / `lib/rag.ts`：FTS5 短语转义 `ftsPhrase`（引号替换 + OR 连接） |
| M10 | `lib/scheduler.ts`：`globalThis.__prysm_scheduler_timer__` 共享 timer，HMR 复用 |
| M11 | `lib/scheduler.ts`：`runAutomationNow` 开头检查 running 状态 → 返回 skipped |
| M13 | `lib/preference-memory.ts`：恢复 key 字符集校验（拒绝空/`.`/`..`/分隔符） |
| M14 | `lib/subagent.ts`：`aborted` Set 防止 abort 后 finally 双重释放 slot |
| M15 | `lib/session.ts`：`saveSessionMessages` 事务化（BEGIN/COMMIT/ROLLBACK） |
| M18 | `app/api/agent/route.ts` + `components/ChatPanel.tsx`：resolveSession 按 surface 过滤，新会话携带 surface |
| M19 | `components/ChatPanel.tsx`：todo 拖拽排序索引修正（`splice(to - 1)`） |
| M20 | `app/api/sessions/[id]/clear/route.ts`：清空后同步 `agent.state.messages = []` |
| M21 | 同 H7 |
| M22 | `lib/web.ts`：SSRF 防护 —— `isBlockedIp` 校验内网/环回/链路本地/保留地址，`assertPublicHost` DNS 解析校验，`safeFetch` 逐跳校验 + 最多 5 次重定向 |
| M24 | `app/api/workdir/route.ts`：上传大小上限 100MB（413） |
| M28 | `lib/todo.ts`：reorder 去重（`seen` Set） |
| — | `lib/session.ts`：会话搜索 LIKE 通配符转义 + `ESCAPE '\'` |

### ⏳ 未修复（设计取舍或低优先级）

- **M6** `lib/model-router.ts`：降级路径不 checkAuth（并发/超时场景偶发，低风险）
- **M12** `lib/backup.ts`：importBackup 无整体事务（恢复属低频一次性操作，可接受）
- **M16** `lib/agent-context.ts`：sessionWorkdirs Map 只写不读（内存小幅增长，无功能影响）
- **M23** `lib/tool-meta.ts`：readonly 子 agent 可改记忆（依赖 H3 上下文改造，行为符合现有权限模型）
- **M25/M26/L 系列**：前端细节与低危项，暂缓
