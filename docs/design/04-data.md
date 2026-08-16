# 04 · 数据层（记忆 / RAG / 待办 / 计划 / 定时任务 / 观测评估 / 备份 / 配置）

> 覆盖：`lib/session.ts`（见 01-core）、`lib/memory.ts`、`lib/preference-memory.ts`、`lib/rag.ts`、
> `lib/todo.ts`、`lib/plan.ts`、`lib/automation.ts`、`lib/cron.ts`、`lib/scheduler.ts`、
> `lib/insights.ts`、`lib/judge.ts`、`lib/stats.ts`、`lib/backup.ts`、`lib/prysm-db.ts`、`lib/config.ts`

## 1. 数据库布局

| 库文件 | 表 | 归属 |
|---|---|---|
| `sessions.db` | sessions / session_messages | 会话与消息 |
| `agent-memory.db` | episodes + FTS5 | 情景记忆 |
| `agent-rag.db` | rag_docs + FTS5 | 知识库索引 |
| `todo.db` | todos | 待办清单 |
| `plans.db` | plans | Plan mode 计划 |
| `automations.db` | automations / automation_runs | 定时任务 |
| `audit.db` | audit | 审批历史 |
| `insights.db` | turns / scores | 观测 + 评估 |
| `prysm.db` | workspace / policy / model_route | 配置与授权 |

> 驱动统一 `node:sqlite`（Node ≥20.9 内置，DatabaseSync 同步）。Web 形态位于运行目录，桌面形态位于 userData。

## 2. 配置注入（lib/config.ts）

- `configure({ baseDir, env, ... })` 由 `createCore()` 调用；未注入时 `getConfig()` 惰性回退 `{ baseDir: process.cwd() }`；
- `basePath()` 拼 baseDir 下路径；`envValue()` 优先注入 env。

> ⚠️ 模块加载时序：任何模块在 configure 前调用 getConfig 会固化 cwd 基准。todo.ts/plan.ts 在**模块加载时**即开库（H1），Electron 下落在错误目录。

## 3. 情景记忆（lib/memory.ts）

- episodes 表 + FTS5 虚拟表；中文插空格分词（`中 文`）便于 FTS 匹配；
- 写入：`rememberMessages` 全量去重写入（`UNIQUE(role,content)`，跨会话同内容只存首条）；
- 检索：`retrieveEpisodes` 把查询词分词后 `"token" OR ...` 拼 MATCH，BM25 排序，注入 buildContext（agent.ts 有 try/catch）；
- 删除/清空/分页列表 + dump/restore 备份。

> ⚠️ FTS5 MATCH 未转义英文引号等特殊字符 → SQL 错误（M3）；备份 dump 上限 1 万条（M2）；deleteEpisode 两步删除无事务。

## 4. 偏好记忆（lib/preference-memory.ts）

- 存储：全局 `<baseDir>/memory/user_profile.md` + 项目 `<baseDir>/memory/projects/<encoded-workdir>/project_memory.md`（按行追加）；
- `buildPreferencePrompt(workdir)` 拼入系统提示词（agent.ts:460 使用）；
- 工具：`remember_memory` / `forget_memory`（scope=global|project）；
- `encodeWorkdir` 只替换 `\ / : * ? " < > |`，中文原样保留（恢复时被 ASCII 正则过滤 → M6 中文路径记忆丢失）；
- **无模块级缓存**（每次直读文件）；「读-改-写」非原子（多进程并发写丢更新）。

## 5. 知识库 / RAG（lib/rag.ts）

- 对已授权工作区根做**增量索引**：按 mtime+size 跳过未变更，跳过 >1MB / 二进制 / 黑名单扩展名与目录；
- 索引存 `agent-rag.db`；`retrieveRagText` BM25 检索注入 buildContext（有 try/catch）；
- `indexRoot` 递归 walk + 差集删除「已消失文件」+ 清理孤儿 FTS 行。

> ⚠️ 扫描上限 `RAG_SCAN_LIMIT`（默认 2000）时，未遍历文件被误删（H2）——relPaths 只含已遍历文件，差集删除误伤。

## 6. 待办（lib/todo.ts）

- 内存数组 `todos` 为权威状态 + 每次变更后全量落盘（DELETE+INSERT 事务）；
- **模块加载时立即 `loadTodos()`**（H1：Electron 下落在 cwd）；
- `reorderTodos` 无去重 → 重复 id 主键冲突（M10）。

## 7. Plan mode（lib/plan.ts）

- `plan_propose` 阻塞等待用户确认（最长 `getPlanTimeoutMs`），超时视为拒绝；
- pending 计划内存 Map + plans.db 持久化，重启恢复未决；
- 事件：proposed / decided / cancelled；`proposePlan` resolver 内正确 `clearTimeout(timer)` + 超时回调检查 `pending.has(id)`（**审批流程未做同样防护，见 03-security H2**）；
- **模块加载时立即 `loadPlans()`**（H1）。

## 8. 定时任务（lib/automation.ts + cron.ts + scheduler.ts）

### 8.1 数据层（automation.ts）

- `automations` 表：名称/内容/形态（surface，不可改）/绑定目录/触发（interval 或 cron）/启用态/next_run_at/last_run_at/last_status/last_session_id/run_count；
- `automation_runs`：执行历史（每次执行生成独立会话）；
- `computeNextRunAt`：interval 顺延；cron 取下一匹配点。

### 8.2 cron 解析（cron.ts，纯函数零依赖）

标准 5 字段（分 时 日 月 周）：`*`、数字、`a-b`、步进、列表；日/周双限定取并集；dow 7→0 归一化；`nextCronRun` 逐分钟推进（上限 5 年防死循环）。

### 8.3 调度器（scheduler.ts）

- `startScheduler` 模块级单例（`started`/`timer`），每 30s `tickAutomations`；
- 防重叠：`lastStatus==="running"` 的任务本轮跳过标记 skipped；
- `runAutomationNow`：新建独立会话 → getAgent + prompt + 持久化 + logRun → 推进 next_run_at → recordRun → bus emit `automation_run`；
- 由 `createCore` 启动（`disableScheduler` 可关，测试用）。

> ⚠️ 手动「立即运行」绕过 running 检查可并发（M5）；HMR 下 interval 泄漏双 tick（M4）；logRun messageCount 硬编码 0。

## 9. 观测与评估（insights.ts / judge.ts / stats.ts）

- `insights.ts`：turns 表（recordRun）+ scores 表（人工评分 / 规则评估 run_error/run_stopped/no_tools / LLM-Judge）；`getInsightsOverview` 聚合汇总/优化建议/评分趋势/模型表现；
- `judge.ts`：`PRYSM_LLM_JUDGE=1` 开启，run 结束后异步主模型打分 0-10，解析 JSON 写 scores（fire-and-forget，调用方 try/catch）；
- `stats.ts`：纯函数 `computeStats(logs, days)` 算成功率/平均耗时/工具排行/按天分布。

> ⚠️ insights 模型统计双 LEFT JOIN 笛卡尔积放大计数（M1）；judgeTrend 无效 run_id → 1970 年点（L）。

## 10. 备份 / 恢复（lib/backup.ts）

- 导出：会话+消息、情景记忆（dump 1 万条上限）、偏好记忆、todos、automations、plans → 单 JSON（version=1）；
- 导入：**清空重建**——会话/记忆/待办各自事务、偏好覆盖写、automations 逐条 upsert；
- **无整体事务**：中途失败产生「半恢复」状态（M7）；automation 恢复不校验非法 cron（M8）。

## 11. 已知问题（详见 bug-audit.md）

| 级别 | 摘要 |
|---|---|
| 高 | todo.db / plans.db 模块加载时开库，Electron 下落在 cwd（todo.ts:94 / plan.ts:322） |
| 高 | RAG 扫描上限误删已索引文档（rag.ts:111-200） |
| 中 | insights 双 JOIN 计数放大；记忆备份 1 万条截断；FTS5 MATCH 未转义；scheduler 热重载双 tick；手动运行无互斥；中文工作区偏好记忆恢复丢失；importBackup 无整体事务；automation 恢复非法 cron 循环执行；plan HMR resolver 悬挂；todo reorder 重复 id |
| 低 | deleteEpisode 无事务；stats DST 错位；cron parseInt 宽松/世纪闰年边界；judge 解析贪婪；preference-memory 非原子写 |
