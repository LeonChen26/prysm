# 03 · 安全 / 审批 / 审计 / 工作区层

> 覆盖：`lib/approval.ts`、`lib/approval-policy.ts`、`lib/audit.ts`、`lib/permission.ts`、
> `lib/policy.ts`、`lib/risk.ts`、`lib/guardian.ts`、`lib/paths.ts`、`lib/workdir.ts`、`lib/workspace.ts`

## 1. 职责总览

| 模块 | 职责 | 关键单例/状态 |
|---|---|---|
| `approval.ts` | 审批请求生命周期（pending 队列 / 超时 / 事件） | `pending` Map、`listeners`/`lifecycleListeners` Set（模块级） |
| `approval-policy.ts` | 审批决策纯函数（完全访问 > 规则 > 资源授权 > 场景开关 > reviewer） | 无 |
| `audit.ts` | 审计落库 audit.db（脱敏 / 查询 / 清空） | `db` DatabaseSync |
| `permission.ts` | permission/global.json 配置读写、规则匹配 | `cached` PermissionConfig |
| `policy.ts` | 资源授权白/黑名单（工具通配 + 路径规则） | 无 |
| `risk.ts` | 风险分级（低/中/高/严重）与危险命令/受保护路径 | 无 |
| `guardian.ts` | LLM Guardian 自动审批决策 | 无 |
| `paths.ts` | 工作区根/路径解析与沙箱边界校验 | `AGENT_WORKDIR`/`ALLOWED_ROOTS` 模块级常量 |
| `workdir.ts` | 文件浏览器（list/read/create/write） | 无 |
| `workspace.ts` | workspace 表模型（种子/授权/增删） | `seeded` 布尔 |

## 2. 完整审批决策链

入口 `agent.ts:328 makeBeforeToolCall(sessionId)`（主/子 agent 共用）：

```
敏感判定（TOOL_META.sensitive / isSensitiveMcpTool）→ 非敏感直接放行
  ↓
规则命中：MCP → matchMcpRule；run_bash → matchCommandRule（精确>正则>前缀）
  ↓
decideApproval({ fullAccess, isMcp, ruleHit, policyDeny, policyAllow, scene, reviewer })
  (approval-policy.ts:49，纯函数)
  ├─ fullAccess（完全访问模式）→ 短路放行（仍写 auto 审计）
  ├─ ruleHit.allow → 放行（写 auto 审计）
  ├─ policyDeny（黑名单）→ 拦截（denied_auto 审计 + policy_notice 事件）
  ├─ policyAllow（白名单）→ 放行（auto 审计）
  ├─ 场景开关（deleteToolApproval=false 等）→ 按配置
  └─ ask（需人工）：
       ├─ risk.assessRisk() 风险分级（显示在卡片）
       ├─ reviewer=llm → guardianAssess：allow→auto 放行 / 拒绝→回退用户审批 / 不可用→用户审批
       └─ requestApproval({ id: toolCall.id }) 阻塞等待
             ├─ 用户 POST /api/agent/approve → resolveApproval
             └─ 超时（默认 120s）→ 拒绝
  ↓
ensureDirAuthorized（审批通过即"记住授权"）
  ↓
audit.logApproval()（approved/denied/timeout/denied_auto/auto/ask 全部落库，args 脱敏截断 500 字符）
```

## 3. 权限模式（lib/permission.ts）

- 单一事实来源：`<baseDir>/permission/global.json`；`getPermission()` 缓存读取、`savePermission` 写回并更新缓存。
- 模式：`manual`（人工）/ `auto`（LLM Guardian 决策）/ `full`（完全访问）/ `custom`（自定义）。
- **规则与模式解耦**：commandRules/mcpRules/resourceAuthorization 统一存 `customProfiles.default`，切换模式不改规则、只改 reviewer 与 full 短路。
- 命令规则匹配（`matchCommandRule`）：精确 > `r/正则/` > `前缀*`；MCP 规则（`matchMcpRule`）：`mcp__server__tool` 精确 > `server__*` > 裸 server。

## 4. 路径沙箱（lib/paths.ts）

`resolveInWorkdir(relative, root?)`（:58）：
1. `path.resolve` 解析（支持 `..` 与绝对路径，最终必须落在工作区根内）；
2. **最长前缀**匹配工作区根 → 无归属 = `outside`；
3. `resolveExistingRealpath`（:115）：已存在路径整体 realpath；不存在则向上找最近存在父目录 realpath 拼回；失败返回 null → 保守 `outside`；
4. realpath ≠ 字符串结果时**重新校验归属**（防符号链接逃逸）；
5. `isRootAuthorized(owner)` → `unauthorized` 走授权流。

`resolveInWorkdirOrThrow`（:167）抛错供工具层使用。

> 路径遍历防护整体健壮（`..`、绝对路径、symlink 均覆盖），残留：Windows 大小写敏感误拒（低）、TOCTOU（校验与执行分离，低）。

## 5. 工作区模型（lib/workspace.ts）

- 首次启动播种默认工作区（agent-workdir，authorized=1）+ 一次性导入 `AGENT_ALLOWED_PATHS`（authorized=0，默认拒绝）；
- `listWorkspaces/getWorkspace/getWorkspaceByRoot/addWorkspace/removeWorkspace/grantWorkspaceAccess/revokeWorkspaceAccess`；
- `isRootAuthorized`：default 恒授权；授权一旦 grant 即整根开放（不区分读写/敏感）。

## 6. 审计（lib/audit.ts）

- `logApproval`：args 经 `redactArgs` 脱敏（key 字段 + `sk-` 串）+ 截断 500 字符落 audit.db；
- 查询支持 `?tool=` / `?action=` 筛选、`?offset=` 分页（`whereClause` 固定条件串 + 参数化值）；
- 清空：`{ action: "clear" }`。

## 7. 关键设计决策

1. **决策链纯函数化**：`decideApproval` 无副作用，便于单测与策略演进；
2. **审批即授权**：用户批准后 `ensureDirAuthorized` 记住授权，减少重复打扰；
3. **规则命中优先于全局开关**：命令规则 `allow` 可短路黑名单（同 Trae 语义，但与「deny>allow」直觉冲突，M5）；
4. **审计全覆盖**：所有决定（含自动放行）落库留痕，`full` 模式也不例外。

## 8. 已知问题（详见 bug-audit.md）

| 级别 | 摘要 |
|---|---|
| 高 | paths.ts 模块级常量在 configure 前求值 → Electron 下路径基准错乱（paths.ts:27-28） |
| 高 | 审批超时 timer 无 entry 校验：批准后仍写 timeout 审计 + 推 expired（approval.ts:102-111） |
| 中 | approve 端点 `Boolean("false")===true` 把字符串 "false" 当批准（approve/route.ts:13） |
| 中 | Windows 绝对路径规则未归一化反斜杠 → 黑名单失效（policy.ts:27-42） |
| 中 | permission 缓存共享引用 + 返回共享常量对象（permission.ts:144/292-298） |
| 中 | 审计脱敏覆盖不全（ghp_/xoxb- 等明文落盘）+ `/key/` 正则过宽误脱敏（audit.ts:68-92） |
| 中 | commandRules allow 绕过资源授权黑名单（approval-policy.ts:56-63） |
| 中 | 审批 lifecycle 订阅从不取消（core.ts:130） |
| 中 | LLM Guardian 无调用超时 → beforeToolCall 永久阻塞（guardian.ts:93-108） |
| 低 | 大小写敏感误拒合法路径；TOCTOU；readWorkdirFile 全量读入；workspace 种子非原子；审计写库失败仅 console.error |
