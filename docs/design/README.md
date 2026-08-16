# Prysm 设计文档（自研代码部分）

> 本目录是 **pi 内核（pi-agent-core / pi-ai）之外、项目自研代码** 的设计文档。
> 目标读者：需要理解 Prysm 内部实现、参与维护或排查问题的开发者。
> 配套文档：[学习/检视路线图](../learning-roadmap.md)（小白向）、[代码审查报告](../bug-audit.md)（已知问题清单）。

## 边界：哪些是自研，哪些是 pi 内核

| 来源 | 内容 |
|---|---|
| **pi-agent-core** | `Agent` 基座（prompt / 流式执行 / 工具调用循环）、`AgentTool` 等核心类型 |
| **pi-ai** | 模型工厂（anthropic / deepseek / openai / google）、`Usage` 等类型 |
| **本项目自研** | 除上述外的一切：核心编排、工具系统、安全审批、数据层、Web API、前端 UI、桌面壳 |

> 原则：`lib/` 下所有自研模块**零 Next.js 依赖**，只依赖 pi 包与 Node 内置。

## 模块地图

```
┌────────────────────────────────────────────────────────────┐
│ 壳层                                                     │
│  app/（Next.js 路由+页面）   components/（React UI）       │
│  electron/（桌面主进程）                                    │
├────────────────────────────────────────────────────────────┤
│ 核心层 lib/                                                │
│  01 编排：core.ts agent.ts events.ts context*.ts           │
│           subagent.ts model-router.ts                      │
│  02 工具：tools.ts tool-meta.ts tools/ registry/builtin/   │
│           mcp/skill  skills.ts web.ts                      │
│  03 安全：approval*.ts audit.ts permission.ts policy.ts     │
│           risk.ts guardian.ts paths.ts workdir.ts workspace.ts │
│  04 数据：session.ts memory.ts preference-memory.ts        │
│           rag.ts todo.ts plan.ts automation.ts cron.ts     │
│           scheduler.ts insights.ts judge.ts stats.ts       │
│           backup.ts prysm-db.ts config.ts                  │
└────────────────────────────────────────────────────────────┘
```

## 文档清单

| 文档 | 覆盖模块 | 内容 |
|---|---|---|
| [01-core.md](01-core.md) | core / agent / events / context / agent-context / messages / session / subagent / model-router | 核心编排：Agent 生命周期、事件总线、上下文注入、会话持久化、子 agent、模型路由 |
| [02-tools.md](02-tools.md) | tools / tool-meta / tools/registry / builtin / mcp / skill / skills / web | 工具系统：注册表、内置 25 工具、MCP 客户端池、Skill 机制、联网搜索 |
| [03-security.md](03-security.md) | approval / approval-policy / audit / permission / policy / risk / guardian / paths / workdir / workspace | 安全层：审批决策链、权限策略、审计、路径沙箱、工作区模型 |
| [04-data.md](04-data.md) | session / memory / preference-memory / rag / todo / plan / automation / cron / scheduler / insights / judge / stats / backup / prysm-db / config | 数据层：各 SQLite 库、记忆、RAG、定时任务、观测评估、备份恢复 |
| [05-web.md](05-web.md) | app/api/** 全部路由 + components/** | Web 层：REST + SSE 路由、前端组件结构与数据流 |
| [06-electron.md](06-electron.md) | electron/（main / build / after-pack / loadEnv） | 桌面壳：复用 Web 前端、standalone 打包、自动更新 |

## 数据流总览（一次对话请求）

```
用户输入
  → app/api/agent/route.ts（SSE）
    → core.getAgent(sessionId)（池化取/建 Agent）
      → agent.prompt()（pi 内核执行循环）
        → 上下文注入 buildContext（压缩 → 记忆 → RAG）
        → 工具调用前 beforeToolCall（安全审批决策链）
          → 工具执行（registry 解析 → builtin/MCP/Skill）
        → 事件 emit（delta / tool_start / tool_end / approval_*）
      → 收尾：持久化消息 → 标题 → logRun → judge → remember
  → SSE 推送前端渲染
```

## 与架构蓝图的关系

[architecture.md](../architecture.md) 是 v8 蓝图（12 Phase 全部完成），本文档是**实现层**的设计说明，两者对应关系：
蓝图 §3-§4（Core 工厂/数据模型）→ 01-core、04-data；§5-§6（工具/能力）→ 02-tools；
§7（安全）→ 03-security；§8（通信）→ 01-core（events）；§9（UI）→ 05-web、06-electron。
