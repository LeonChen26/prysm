# Prysm 代码学习 / 检视路线图（小白版）

> 这篇文章把你当成完全没看过这个项目代码的人来写：不用懂 Agent、不用懂 Next.js 内部，
> 只需要会一点 TypeScript / JavaScript 基础。按下面的顺序走，你就能从「打开仓库不知道看什么」
> 到「能读明白一条消息是怎么被处理的，甚至能自己定位 bug」。

---

## 第 0 步：先跑起来（30 分钟）

不看代码先运行，建立「它到底是个什么」的直觉：

```bash
npm ci                 # 装依赖（第一次会很久）
cp .env.example .env.local   # 然后填一个可用的 API Key（如 DEEPSEEK_API_KEY）
npm run dev            # 启动 Web 版，浏览器打开 http://localhost:30123
```

打开后随便发一句话，比如「帮我看看当前目录有哪些文件」，观察：
1. 消息是怎么被流式打出来的（一个字节一个字节蹦出来）；
2. 右侧会出现工具卡片（这个例子会调用 `list_dir`）；
3. 如果工具是敏感的（比如写文件），会出现一个审批卡片等你点。

**看完这三个现象，再往下走。** 它们分别对应：Agent 流式执行、工具系统、安全审批——恰好是这个项目最核心的三条线。

---

## 第 1 步：看懂项目的「地图」（1 小时）

先打开顶层结构，认门：

```
app/          → 后端路由 + 页面（浏览器访问的就是这里）
  api/        → 所有 HTTP 接口（REST + SSE）
components/   → 前端页面组件（聊天界面）
lib/          → ★核心★ 所有业务逻辑（纯 TypeScript，不依赖前端框架）
  tools/      → 工具注册表 + MCP + Skill
docs/         → 文档（你正在看的这份就是）
electron/     → 桌面壳（把 Web 包成桌面应用）
tests/        → 单元 / 集成 / 端到端测试
```

**最重要的认知**：`lib/` 是大脑，`app/api/` 是嘴巴（把大脑的能力暴露给浏览器），`components/` 是脸（显示给用户）。Electron 只是把「浏览器」包装成桌面窗口。

> 打开 [docs/design/README.md](design/README.md)，里面有模块地图和一次请求的完整数据流图。这是全文最重要的两张图。

---

## 第 2 步：理解「一次对话是怎么发生的」（2 小时）

这是整个项目的灵魂。打开 [docs/design/01-core.md](design/01-core.md)，按这条线走：

```
用户在输入框打字 → 点发送
  ↓
components/ChatPanel.tsx    前端把消息 POST 给 /api/agent（走 SSE 长连接）
  ↓
app/api/agent/route.ts      后端入口：找到会话 → 拿到 Agent 实例
  ↓
lib/agent.ts 的 getAgent()  池化获取 Agent（有就复用，没有就新建）
  ↓
Agent.prompt()              ★这是 pi-agent-core 内核的调用★（你不需要懂内部）
                             内核会循环：想下一步 → 决定是否调用工具 → 执行工具 → 继续
  ↓
工具执行前后会触发事件（delta 文本 / tool_start 工具开始 / approval_required 要审批）
  ↓
lib/events.ts 的事件总线 → SSE 推回浏览器 → 前端渲染
```

**练习**：在 `app/api/agent/route.ts` 里搜 `a.prompt(`，然后在 `lib/agent.ts` 里搜 `new Agent(`。找到这两处，你就抓住了主线的两头。

---

## 第 3 步：看懂「工具系统」（2 小时）

Agent 不会自己干活，它靠「工具」。打开 [docs/design/02-tools.md](design/02-tools.md)：

1. `lib/tool-meta.ts` —— 工具清单（先看这个，认识 25 个内置工具都叫啥）；
2. `lib/tools.ts` —— 工具实现（挑一个简单的看：`env_info` 或 `list_dir`）；
3. `lib/tools/registry.ts` —— 注册表（工具从哪来：内置 / MCP / Skill 三类）。

**关键概念**：工具 = 一个函数 + 一段给模型的描述。模型不会执行代码，它只是「请求调用某个工具 + 传参数」，真正执行的是这个函数。

**练习**：给模型发「运行环境是什么」，它会调用 `env_info`。去 `lib/tools.ts` 里找到 `env_info` 的实现，你就知道工具长什么样了。

---

## 第 4 步：看懂「安全审批」（1.5 小时）

这是最有意思的部分。打开 [docs/design/03-security.md](design/03-security.md)：

- 核心思想：**默认不信任**。写文件、删文件、执行命令都是敏感操作，必须先问用户；
- 整条链路在 `lib/agent.ts` 的 `makeBeforeToolCall` 里（搜这个函数名）：
  模型要调敏感工具 → 问用户 → 用户点同意/拒绝 → 记录到审计库；
- 决策逻辑在 `lib/approval-policy.ts`（纯函数，最好读）；
- 配置存在 `permission/global.json`（白名单/黑名单/超时）。

**练习**：发一条「写一个 hello.txt」的消息，观察审批卡片，然后去 `lib/audit.ts` 里找「这条审批被记录到哪了」。

---

## 第 5 步：看懂「数据都存哪」（1.5 小时）

打开 [docs/design/04-data.md](design/04-data.md)，看那张「数据库布局」表：

| 库文件 | 存什么 | 对应 lib 文件 |
|---|---|---|
| sessions.db | 会话和消息 | session.ts |
| agent-memory.db | 情景记忆（跨会话经验） | memory.ts |
| agent-rag.db | 知识库索引 | rag.ts |
| todo.db / plans.db | 待办 / 计划 | todo.ts / plan.ts |
| automations.db | 定时任务 | automation.ts |
| audit.db | 审批历史 | audit.ts |
| insights.db | 运行统计和评分 | insights.ts |
| prysm.db | 工作区 / 权限 / 模型路由 | prysm-db.ts |

**认知**：全部用 Node 内置 SQLite（`node:sqlite`），单文件数据库，不需要装任何数据库服务。数据文件就在项目根目录（Electron 版在用户数据目录）。

---

## 第 6 步：看懂「前端」（1.5 小时）

打开 [docs/design/05-web.md](design/05-web.md)：

- `ChatPanel.tsx` 是唯一的大组件（4000+ 行），别被吓到——它本质是：**一堆状态 + 一个 SSE 回调处理函数**；
- 打开 `components/chat-types.ts`，找 `readSSE` 函数——这是前端把服务端推来的事件变成 UI 更新的「翻译官」；
- 工具卡片 / 审批卡片 / 计划卡片在 `ChatPanel.tsx` 里各自有一段处理逻辑，搜 `tool_start`、`approval_required`、`plan_proposed` 就能定位。

**练习**：发一条消息让它调用工具，在浏览器 DevTools（F12）→ Network 里看 `/api/agent` 的响应流，你能看到原始事件（`data: {"type":"delta",...}` 这种格式）。

---

## 第 7 步：读懂 pi 内核的边界（1 小时）

这个项目最大的「分层技巧」是：**Agent 内核用别人写好的 pi-agent-core，自己只做外围**。打开 [docs/design/README.md](design/README.md) 看「边界」表：

- `node_modules/@earendil-works/pi-agent-core/` 里是内核（Agent 类、工具循环）；
- 你的项目里只需要理解 3 个接触点：
  1. `new Agent({...})` —— 创建（lib/agent.ts）；
  2. `agent.prompt(...)` —— 开始执行（app/api/agent/route.ts）；
  3. `beforeToolCall` / `transformContext` —— 两个钩子，分别做「工具前审批」和「上下文压缩」。

**为什么要这样设计**：内核负责「跟模型说话、循环调用工具」这些脏活，项目自己负责「工具从哪来、是否安全、数据存哪、怎么展示」。想改业务逻辑，永远不用碰内核。

---

## 第 8 步：跑测试 + 动手改 bug（入门验收）

测试是理解代码行为的捷径：

```bash
npm run typecheck    # 类型检查
npm run test:unit    # 单元测试（37 个套件，纯本地不联网）
npm run test:e2e     # 端到端（需先 npm run dev）
```

看 `tests/unit/` 下的文件名，它们和 `lib/` 一一对应（test-session.ts 测 session.ts…）。
**建议挑一个看**：`tests/unit/test-session.ts`，你会看到「软删」这种逻辑怎么用测试锁住行为。

**动手建议（从易到难）**：
1. 在 `lib/tools.ts` 里给某个工具加一行 log，看它什么时候被调用；
2. 把 `lib/approval-policy.ts` 的某个条件改一下，跑 test-approval-policy.ts 看测试怎么「揪住」你；
3. 挑战：修 [docs/bug-audit.md](bug-audit.md) 里标记「一行修复」的 H5（skills 删除校验），跑测试确认没破坏。

---

## 推荐阅读顺序速查表

| 顺序 | 看什么 | 目的 |
|---|---|---|
| 0 | 跑起来 | 建立直觉 |
| 1 | docs/design/README.md 模块地图 | 认门 |
| 2 | 01-core.md + agent 主链路 | 抓主线 |
| 3 | 02-tools.md + tools.ts | 理解工具 |
| 4 | 03-security.md + approval 链路 | 理解安全 |
| 5 | 04-data.md + 数据库表 | 理解数据 |
| 6 | 05-web.md + SSE | 理解前端 |
| 7 | pi 内核边界 | 理解分层 |
| 8 | 测试 + 改 bug | 验收 |

## 常见疑问速答

**Q：为什么这么多「模块级变量」？（如 agentPool、pending Map）**
A：单进程、单用户本地应用，用模块级变量做「全局状态」最简单。代价是热重载/并发下容易出问题——[bug-audit.md](bug-audit.md) 里一半的 bug 都是这类。

**Q：SSE 是什么？**
A：浏览器和服务器的「单向直播」——服务器可以不停往一个连接里推数据。打字机效果就是靠它。

**Q：为什么测试名字都是 test-xxx.ts？**
A：用 `tsx` 直接跑 TypeScript 文件做测试，零框架，简单直接。想看某模块行为，直接跑对应测试文件。

**Q：我想加一个新工具，要动哪些文件？**
A：① `lib/tools.ts` 加实现；② `lib/tool-meta.ts` 加元数据（label/type/surface/capability/sensitive）；③ 跑 typecheck + test-tool-registry。三步完事——这就是「注册表静态注册」设计的红利。
