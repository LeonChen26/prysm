# 02 · 工具系统层（Tools / Registry / MCP / Skill / Web）

> 覆盖：`lib/tools.ts`、`lib/tool-meta.ts`、`lib/tools/registry.ts`、`lib/tools/builtin.ts`、
> `lib/tools/mcp.ts`、`lib/tools/skill.ts`、`lib/skills.ts`、`lib/web.ts`

## 1. 职责总览

| 模块 | 职责 |
|---|---|
| `tools.ts` | 25 个内置工具定义；AsyncLocalStorage 会话 workdir 隔离；shell 执行；glob 搜索 |
| `tool-meta.ts` | 工具展示元数据（label/surface/capability/sensitive） |
| `tools/registry.ts` | 工具注册表：聚合 builtin/MCP/Skill 三类 provider，按 filter 筛选 |
| `tools/builtin.ts` | 内置工具 provider（返回 tools.ts 数组） |
| `tools/mcp.ts` | MCP 客户端池：stdio/HTTP/SSE 连接、生命周期、超时、重连、工具映射 |
| `tools/skill.ts` | Skill 工具 provider：按 enabled 技能声明从内置/MCP 工具集同名筛选 |
| `skills.ts` | SKILL.md 解析、扫描/启停/增删、全局目录回退 |
| `web.ts` | 联网搜索（Bing/DDG）与网页抓取转纯文本 |

## 2. 工具注册表（lib/tools/registry.ts）

```ts
interface ToolProvider { id: string; load(): Promise<AgentTool[]> }
class ToolRegistry {
  register(p);                    // builtin / mcp:<server> / skill:<name>
  resolve(filter?): Promise<AgentTool[]>;  // 聚合，同名后注册者覆盖
  matchesFilter(tool, filter);    // 按 TOOL_META 的 capability/surface 过滤
}
```

- `initToolRegistry()`（:72）幂等注册 builtin → MCP → Skill；**注册顺序决定同名覆盖优先级**。
- MCP/Skill 工具无 TOOL_META 时不剔除（保持全部可用）。
- 修改 MCP 配置后需手动 `resetToolRegistry()`（API 层已接线）。

> ⚠️ `registryInitialized` 布尔在 await MCP 连接前即置 true，并发首个请求可能拿到不完整工具集（bug-audit 工具层 M4）。

## 3. 内置工具（lib/tools.ts，25 个）

### 3.1 分类

| 类别 | 工具 |
|---|---|
| 文件 | list_dir / read_file / write_file / append_file / edit_file / create_dir / move_file / copy_file / delete_file / verify_file |
| 搜索 | search_files / find / find_in_workdir（同 find） |
| 执行 | run_bash / env_info / port_check |
| 任务 | todo_create / todo_modify / todo_list |
| 计划 | plan_propose |
| 子 agent | spawn_subagent |
| 记忆/技能 | remember_memory / forget_memory / use_skill |
| 自动化 | create_automation |
| 网络 | web_search / fetch_url |

### 3.2 workdir 并发隔离（AsyncLocalStorage）

- `runWithWorkdir(wd, fn)`（:75）用 `AsyncLocalStorage` 包裹整个 prompt+工具链；
- 工具内 `effectiveWorkdir()`（:88）读存储上下文，回退模块常量 `AGENT_WORKDIR`；
- 路径解析统一走 `resolveInWorkdirOrThrow` → `lib/paths.ts` 的 realpath 双重校验。

> ⚠️ 仅 workdir 用了 ALS；`planCtx`/`memoryCtx` 仍是模块级单值全局变量，并发会话互相覆盖（bug-audit 工具层 H1）。

### 3.3 关键工具实现要点

- `read_file`：大文件分片读取（offset/limit）；
- `edit_file`：唯一匹配校验、空串校验、CRLF/BOM 兼容（归一化 LF 匹配后恢复行尾）；
- `find`：纯 JS glob + 递归遍历，按命中数 limit 提前终止（无深度上限，bug-audit M5）；
- `run_bash`：Node 默认 shell 执行（修复过 Windows Git Bash 检测缺陷），exec timeout 只杀 shell 不杀孙进程（L7）；
- `spawn_subagent`：经注入回调调用 subagent.ts，`_toolCallId` 作为 parentSessionId 传入（H3 隐患）。

## 4. MCP 客户端池（lib/tools/mcp.ts）

### 4.1 连接生命周期

```
init()（幂等，initialized 标志）
  → 逐 server buildHandle：
      createClient（stdio 子进程 / streamable HTTP / SSE）
      → ping 超时探测
      → listTools/listResources/listPrompts 并行 allSettled
      → status: connecting → connected | error
  → transport.onclose/onerror → markError
```

- **调用路径**：`callTool/readResource/getPrompt` → `ensureConnected`（error 时 delete 句柄重建）→ `withTimeout`。
- **配置**：`mcp.json`（command/args 或 url+transport），`saveMcpConfig` 临时文件+rename 原子写。
- **超时**：`START_MCP_TIMEOUT_MS`（默认 15s）/ `RUN_MCP_TIMEOUT_MS`（默认 60s）。
- **变量**：`${workspaceFolder}` 启动时替换为最近活跃会话绑定目录。
- **敏感判定**：`isSensitiveMcpTool` 按 annotations，未标注默认按敏感（`/^mcp__(.+)__(.+)$/` 贪婪分割，L4）。

> ⚠️ 重连路径泄漏旧 client/stdio 子进程（H2）；withTimeout 超时不取消底层请求（H3）；崩溃降级 + 按需重连但无退避/无并发锁。

## 5. Skill 机制（lib/skills.ts + tools/skill.ts）

### 5.1 SKILL.md 格式

```markdown
---
name: my-skill
description: 一句话说明
tools: [read_file, web_search]   # 可选：声明工具依赖
---
技能正文（markdown）
```

### 5.2 加载与生命周期

- **双目录**：项目技能 `<baseDir>/skills` + 全局技能 `~/.prysm/skills`（同名项目优先）；
- 全局目录不可写时自动回退 `<baseDir>/global-skills` 并持久化（`skill-settings.json`）；
- **按需加载**：系统提示词仅注入名称+描述索引（`buildSkillIndex`），模型判断任务相关时经 `use_skill` 工具加载正文；
- 生命周期：`loadSkills`（扫描）→ `initSkills`/`reloadSkills`（登记 loaded/enabled）→ 会话级启用/禁用 → 热加载；
- `createSkill` 校验 `SKILL_NAME_RE`；`deleteSkill` 直接 `rmSync`（⚠️ 缺名称校验 → 路径穿越，bug-audit 高 H2）。

## 6. 联网搜索与抓取（lib/web.ts）

- `webSearch`（:128）：按 `WEB_SEARCH_PROVIDER` 选 Bing/DDG → `fetchText`（15s 超时、follow 重定向）→ 正则解析结果块；
- `fetchUrlAsText`（:153）：仅允许 http/https → fetch（20s 超时、follow 重定向）→ `res.text()` 全量解码 → `htmlToText` 转纯文本，200KB 截断。

> ⚠️ 无 SSRF 防护（可抓内网/元数据地址，M2）；非 UTF-8 页面乱码（L9）；全量下载后截断（M7）。

## 7. 关键设计决策

1. **注册表静态注册**：会话/Agent 构造时一次性 resolve，不用 pi 的运行时动态添加机制。
2. **MCP/Skill 均为「加载器」**：provider 在 resolve 时惰性加载，配置热更新后 reset 重建。
3. **路径安全统一出口**：所有文件工具经 `resolveInWorkdirOrThrow`，realpath 双重校验防符号链接逃逸。
4. **Skill 按需加载**：系统提示词瘦身，正文按需注入。

## 8. 已知问题（详见 bug-audit.md）

| 级别 | 摘要 |
|---|---|
| 高 | planCtx/memoryCtx 全局变量并发覆盖（tools.ts:42/51） |
| 高 | MCP 重连泄漏 client/子进程（mcp.ts:424-437）；超时不取消底层请求（:591-605） |
| 高 | deleteSkill 路径穿越（skills.ts:301） |
| 中 | SSRF（web.ts:153）；capability 标记错误（remember_memory 等标 readonly 但写盘）；注册表初始化竞态（registry.ts:72）；find 递归无上限（tools.ts:146） |
| 低 | 路径大小写敏感；非 UTF-8 乱码；exec 孙进程残留；verify_file 吞错；saveMcpConfig pid 命名冲突 |
