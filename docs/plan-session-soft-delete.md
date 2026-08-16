# Plan：会话消息软删 + 上下文一致性

> 背景：会话删除在 `saveSessionMessages` 全量替换（DELETE + 重插）下会导致行 id 漂移、
> 上下文断裂（删 user 消息留下"无因之果"的 assistant 回复）。本次把单条/批量删除改为
> **软删 + 轮次级联**，真删只保留在"清空会话 / 删除会话"两个整体操作上。
> 设计讨论见会话记录（对照 Pi session 系统的"存储与视图分离"）。

## 目标

- **单条/批量删除** → 软删（`deleted` 标记，行保留可追溯），并**轮次级联**：
  连同该条到下一个 user 消息前的回复一起隐藏，杜绝"无因之果"。
- **清空会话 / 删除会话** → 保持物理 DELETE（真删）。
- 存储层不再"删行重插"，消除索引漂移与上下文断裂；`agent.state.messages` 与 DB 保持一致。

## 改动清单

### 1. `lib/session.ts`

| 函数 | 改动 |
|---|---|
| `getDb()` | 按现有 PRAGMA 迁移模式加列：`ALTER TABLE session_messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0` |
| `getSessionMessages` | 查询加 `AND deleted = 0`（所有读取方：agent 加载、上下文分析、导出、搜索、备份自动只看到未删消息） |
| `saveSessionMessages` | DELETE 条件改为 `WHERE session_id = ? AND deleted = 0`——全量替换时保留软删行，这是软删成立的关键 |
| `deleteSessionMessages` | 重写为软删：读未删数组（带行 id）→ 对每个 index 计算级联区间（该条到下一 user 消息前）→ 合并去重 → `UPDATE ... SET deleted = 1 WHERE id IN (...)` → 返回删后未删数组 |
| `clearSessionMessages` / `deleteSession` | 不变（真删，符合"真删留到 session 删除"） |

### 2. `app/api/sessions/[id]/messages/route.ts`

- 接口不变（index/indices），删后仍返回未删数组并同步 `agent.state.messages`。

### 3. `components/ChatPanel.tsx`

- 删除确认文案：提示"将连同该条之后到下一条提问前的回复一起隐藏"。

### 4. `tests/unit/test-session.ts`

- 更新既有删除用例语义（级联删除改变结果）；新增：软删后行仍在且 `deleted=1`、
  级联删除、保存不丢软删行、清空/删会话真删。

## 取舍（已定）

- 备份恢复导出未删消息 → 软删行不进备份（用户视角，合理）。
- 软删行永久占用磁盘（无清理机制，后续可选加"过期真删"）。
- 编辑重发 bug（rewindToText 匹配失效）**不纳入本次**，单独排期。

## 验证

- `npx tsx tests/unit/test-session.ts` 通过
- typecheck 通过
- 手动验证：删中间一轮 → 重新生成 → 上下文无已删消息
