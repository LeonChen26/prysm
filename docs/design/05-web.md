# 05 · Web 层（REST + SSE 路由与前端组件）

> 覆盖：`app/api/**` 全部路由 + `app/page.tsx`、`app/layout.tsx` + `components/**`（ChatPanel / chat-types / chat-blocks / DiffView / settings-view / automation-panel）

## 1. 职责总览

| 类别 | 文件 | 职责 |
|---|---|---|
| 入口 | app/page.tsx / layout.tsx | 渲染 ChatPanel；根布局 + 全局样式 + KaTeX |
| 主组件 | components/ChatPanel.tsx（4749 行） | 主聊天面板：会话管理、SSE 消费、审批/计划/工具卡片、设置/自动化/文件视图 |
| 类型/纯函数 | components/chat-types.ts | 类型定义 + readSSE 解析 + 工具卡片 localStorage + 时间/用量工具 |
| 消息渲染 | components/chat-blocks.tsx | 图标 / CodeBlock / ThinkingBlock / MermaidDiagram / FileRefCards |
| diff 渲染 | components/DiffView.tsx | unified diff 解析与高亮 |
| 设置面板 | components/settings-view.tsx（1406 行） | 模型路由 / 权限审批 / MCP / Skill / 备份恢复 / 偏好记忆 |
| 自动化面板 | components/automation-panel.tsx | 定时任务：已配置 / 历史 / 模板 / 新建编辑 |
| 路由 | app/api/**（33 个） | REST + SSE 后端 |

## 2. SSE 主链路（app/api/agent/route.ts + ChatPanel.tsx）

### 2.1 服务端流程

```
POST /api/agent（body: sessionId/messages/model/approvalMode/...）
  → resolveSession（无 sessionId 时取 listSessions()[0] —— ⚠️ 不按 surface 过滤，M2）
  → 创建 ReadableStream
  → 发 session 事件 → 订阅 core.eventBus（按 sessionId 过滤）
  → runWithWorkdir(wd) + a.prompt + waitForIdle
  → finally：
      saveSessionMessages（全量替换）
      → 自动/智能标题 → logRun → judgeRun（fire-and-forget）→ rememberMessages
      → unsubBus → send(done|stopped) → controller.close()
  → 客户端断开：cancel() → agent.abort() → AbortError → 只发 stopped（closed 守卫吞掉）
```

**防「Controller is already closed」**：`send` 用 `closed` 标记 + try/catch，关闭后静默丢弃（设计正确）。

### 2.2 前端 SSE 消费

- `streamReply`：`busyRef` 镜像防重入 → POST → `readSSE` 逐事件回调；
- delta → 追加到 assistant 占位；tool_start 去重（c.some(id)）→ tool_end 落状态并 `saveToolCards` 持久化（每会话 50 条上限）；approval_required → 追加卡片 + 每秒 countdownTick；plan_proposed → 计划卡片。

### 2.3 编辑 / 重新生成

- `rewindToIndex`（编辑）：UI 索引映射回全量消息下标截断；
- `rewindToText`（重新生成）：文本匹配（修过截断失效 bug）；
- 两者互斥（else if）。

## 3. 关键路由一览

| 路由 | 方法/动作 | 说明 |
|---|---|---|
| /api/agent | POST（SSE）/ GET | 主入口；消息历史 |
| /api/agent/approve · pending · stop · logs | POST/POST/GET/POST | 审批决定 / 未决恢复 / 中断 / 日志 |
| /api/sessions (+ [id] / messages / clear / export / search) | REST | 会话 CRUD + 消息软删 + 清空 + 导出 + 搜索 |
| /api/workdir (+ content) | REST + multipart | 文件浏览器（list/create/upload/preview） |
| /api/workspaces (+ [id]/authorize) | REST | 工作区列表/新增/授权 |
| /api/mcp /api/skills | GET/POST | MCP 与 Skill 管理（action 分发） |
| /api/automations | GET/POST | 定时任务 CRUD/运行 |
| /api/memory /api/memory-files | REST | 情景记忆 / 偏好记忆文件 |
| /api/backup | GET/POST | 备份导出 / 导入 |
| /api/audit /api/stats /api/insights(+score) | REST | 审计 / 统计 / 观测评估 |
| /api/todos /api/plans /api/rag /api/permission | REST | 待办 / 计划 / RAG / 权限配置 |
| /api/model-routes | GET/PUT | 模型路由目录/更新 |
| /api/context/[sessionId] | GET | 上下文构成分析 |
| /api/upload /api/health | POST/GET | 图片上传（遗留，前端未用）/ 健康检查 |

## 4. 前端组件要点

### 4.1 ChatPanel.tsx

- 状态：messages / cards（工具卡片）/ todos / plans / approvals / sessions / busy / surface / panelCollapsed / activityView 等；
- **会话切换竞态**：`switchSession` 无请求序号/Abort，旧响应可覆盖新会话（M1）；
- **todo 拖拽**：先删后插索引偏移，向下拖动错一位（M3）；
- **消息 key**：`messages.map((m, i) => key={i})`，删除后折叠/选中状态错位（M6）；
- **tool_end 在 setState updater 内写 localStorage**（副作用，M7）；
- **readSSE 无 AbortSignal**（M8）；
- 自动滚动 effect 依赖 [messages, cards, todos, busy]，高频 delta 滚动动画堆积（L9）。

### 4.2 chat-types.ts

`readSSE`（:509-535）：解析 `data:` 行 JSON；工具卡片 localStorage 读写（saveToolCards 静默吞异常）。

### 4.3 chat-blocks.tsx

CodeBlock（语法高亮+复制）、ThinkingBlock（折叠）、MermaidDiagram（MutationObserver 监听主题切换，已正确清理）、FileRefCards（`wb://` 引用）。

### 4.4 DiffView.tsx

unified diff 解析：文件头（灰/绿粗体）、hunk 头（品牌蓝底）、增行（绿底）、删行（红底）、上下文。

### 4.5 settings-view.tsx

Tab 化布局（General / Model / Approval / Integration / Data），5 类设置；保存经 /api/permission 合并写回。

### 4.6 automation-panel.tsx

30s 轮询 /api/automations；模板（写周报/会议纪要/数据分析等）；新建弹窗（interval 或 cron）。

## 5. 已知问题（详见 bug-audit.md）

| 级别 | 摘要 |
|---|---|
| 高 | /api/skills delete 路径穿越递归删目录（skills/route.ts:64-69 + skills.ts:301） |
| 中 | switchSession 响应竞态（ChatPanel.tsx:863-886）；无会话时跨形态串会话（agent/route.ts:35-41）；todo 拖拽排序错位（ChatPanel.tsx:2338）；multipart 上传无大小限制 OOM；清空会话后内存 Agent 状态不刷新（clear/route.ts:17）；消息 key=index；tool_end updater 副作用；readSSE 无 abort；backup 导入无大小限制 |
| 低 | 批量删除未检查 busyRef；model-routes PUT 不校验 provider/model；滚动动画堆积；automation catch 全返 400 |

## 6. 做得好的方面

- SQL 全部参数化（无注入）；路径双重校验；SSE closed 守卫 + cancel→abort + finally 保证持久化；
- 事件去重（WeakSet + tool_start 按 id）；审批参数脱敏；图片校验（MIME 白名单 + base64 严格正则 + 10MB + 随机文件名）；
- 定时器清理规范（countdownTick / automation 轮询 / MermaidObserver / scheduler 均正确 clear）。
