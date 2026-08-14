/**
 * 对话共享工具（components/chat-types.ts）验证脚本 —— 纯函数断言，无 React 依赖。
 * 覆盖：readSSE（SSE 流解析，含 chunk 切分/跨 chunk 事件/坏数据容错）、
 *      时间格式化（formatDuration/RelTime/GroupLabel/MsgTime）、
 *      工具卡片状态文本与色阶、审批参数格式化、UsageInfo 累加、
 *      工具卡片 localStorage 持久化（load/save/clear，上限 50、running 过滤）。
 * 运行：npx tsx tests/unit/test-chat-types.ts
 */
import {
  readSSE,
  formatDuration,
  formatRelTime,
  formatGroupLabel,
  formatMsgTime,
  toolCardStateText,
  toolCardStateClass,
  formatApprovalArgs,
  addUsage,
  loadToolCards,
  saveToolCards,
  clearToolCards,
  type ToolCard,
  type UsageInfo,
  type SseEvent,
} from "../../components/chat-types";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

function expectEq(name: string, actual: unknown, want: unknown) {
  const ok =
    typeof actual === "object" && typeof want === "object"
      ? JSON.stringify(actual) === JSON.stringify(want)
      : actual === want;
  if (!ok) {
    fail(
      `${name}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(actual)}`,
    );
  }
  console.log(`  ✓ ${name}`);
}

function expectTrue(name: string, cond: boolean, detail?: string) {
  if (!cond) fail(`${name}${detail ? `（${detail}）` : ""}`);
  console.log(`  ✓ ${name}`);
}

// ==================================================================
// 1. readSSE：SSE 流解析（通信层核心，边界条件最多）
// ==================================================================
console.log("== readSSE：单 chunk 内完整单事件 ==");
{
  const got: SseEvent[] = [];
  const body = `data: ${JSON.stringify({ type: "delta", delta: "hi" })}\n\n`;
  await fakeReadSSE(body, (e) => got.push(e));
  expectEq("收到 1 条事件", got.length, 1);
  expectEq("type=delta 正确", got[0].type, "delta");
  expectEq("delta=hi 正确", got[0].delta, "hi");
}

console.log("\n== readSSE：单 chunk 内多事件（连续多条 data:） ==");
{
  const got: SseEvent[] = [];
  const e1 = JSON.stringify({ type: "turn_start", id: "a" });
  const e2 = JSON.stringify({ type: "delta", delta: "x" });
  const e3 = JSON.stringify({ type: "turn_end", usage: { input: 1 } });
  await fakeReadSSE(`data: ${e1}\n\ndata: ${e2}\n\ndata: ${e3}\n\n`, (e) => got.push(e));
  expectEq("3 条事件全部解析", got.map((e) => e.type).join(","), "turn_start,delta,turn_end");
  expectEq("第 3 条 usage.input 透传", (got[2] as { usage?: UsageInfo }).usage?.input, 1);
}

console.log("\n== readSSE：事件跨 chunk 切割（事件头部与 data JSON 分在两个 chunk） ==");
{
  const got: SseEvent[] = [];
  const payload = JSON.stringify({ type: "tool_start", toolName: "write_file", id: "c1" });
  // 切成两半，模拟 TCP 分段到达
  const half1 = payload.slice(0, Math.floor(payload.length / 2));
  const half2 = payload.slice(Math.floor(payload.length / 2));
  const chunks = [`data: ${half1}`, `${half2}\n\n`];
  await fakeReadSSEChunks(chunks, (e) => got.push(e));
  expectEq("跨 chunk 切分后仍正确组装为 1 条", got.length, 1);
  expectEq("跨 chunk 事件 type 正确", got[0].type, "tool_start");
  expectEq("跨 chunk 事件 toolName 完整", got[0].toolName, "write_file");
}

console.log("\n== readSSE：同一 chunk 多条事件，最后一条的 \\n\\n 落在下一个 chunk ==");
{
  const got: SseEvent[] = [];
  const e1 = JSON.stringify({ type: "delta", delta: "A" });
  const e2 = JSON.stringify({ type: "delta", delta: "B" });
  const chunks = [`data: ${e1}\n\ndata: ${e2}`, `\n\n`];
  await fakeReadSSEChunks(chunks, (e) => got.push(e));
  expectEq("分两段收尾得到 2 条", got.length, 2);
  expectEq("第 1 条 delta=A", got[0].delta, "A");
  expectEq("第 2 条 delta=B", got[1].delta, "B");
}

console.log("\n== readSSE：损坏事件（非 JSON / 空 data）静默跳过不抛错 ==");
{
  const got: SseEvent[] = [];
  let threw = false;
  try {
    await fakeReadSSEChunks(
      [
        "data: not-a-json\n\n", // 非法 JSON → 忽略
        "data:  \n\n",          // 空 payload → 忽略
        `data: ${JSON.stringify({ type: "done" })}\n\n`, // 合法
      ],
      (e) => got.push(e),
    );
  } catch {
    threw = true;
  }
  expectTrue("损坏事件未抛错", !threw);
  expectEq("仅合法事件被解析", got.length, 1);
  expectEq("合法事件 type=done", got[0].type, "done");
}

console.log("\n== readSSE：data 前缀前后空白正确剥离 ==");
{
  const got: SseEvent[] = [];
  const payload = JSON.stringify({ type: "delta", delta: "ok" });
  // 多行 SSE 注释/非 data 行应被跳过；data: 前后允许空格
  await fakeReadSSE(
    `: this is a comment\n  data:   ${payload}   \n\n`,
    (e) => got.push(e),
  );
  expectEq("data 前后空白+注释行跳过", got.length, 1);
  expectEq("解析后 delta=ok", got[0].delta, "ok");
}

console.log("\n== readSSE：无 response.body（空）时安全返回 ==");
{
  const got: SseEvent[] = [];
  let threw = false;
  try {
    await readSSE(new Response(null) as never, (e) => got.push(e));
  } catch {
    threw = true;
  }
  expectTrue("空 body 不抛错", !threw);
  expectEq("空 body 不触发任何回调", got.length, 0);
}

console.log("\n== readSSE：\\r\\n 换行（服务端 Windows 风格）也可正确切行 ==");
{
  const got: SseEvent[] = [];
  const p = JSON.stringify({ type: "done" });
  await fakeReadSSE(`data: ${p}\r\n\r\n`, (e) => got.push(e));
  // split("\\n") 会把 "\\r" 留在行尾，但 line.trim() 能去掉 "\\r" 从而匹配 data:
  expectEq("CRLF 分隔后至少能解析事件", got.length >= 1, true);
}

// ==================================================================
// 2. 时间格式化
// ==================================================================
console.log("\n== formatDuration：毫秒/秒展示 ==");
expectEq("0ms → 0ms", formatDuration(0), "0ms");
expectEq("<1s 显示毫秒", formatDuration(999), "999ms");
expectEq("1000ms → 1.0s", formatDuration(1000), "1.0s");
expectEq("1234ms → 1.2s（保留一位小数）", formatDuration(1234), "1.2s");
expectEq("9999ms → 10.0s", formatDuration(9999), "10.0s");

console.log("\n== formatRelTime：相对时间（需固定 Date.now，否则不稳定） ==");
{
  const savedNow = Date.now;
  const base = new Date(2026, 0, 15, 12, 0, 0).getTime();
  (Date as unknown as { now: () => number }).now = () => base;
  try {
    expectEq("差 0ms → 刚刚", formatRelTime(base), "刚刚");
    expectEq("59 秒 → 刚刚（<60_000）", formatRelTime(base - 59_000), "刚刚");
    expectEq("1 分钟", formatRelTime(base - 60_000), "1 分钟前");
    expectEq("59 分钟", formatRelTime(base - 59 * 60_000), "59 分钟前");
    expectEq("1 小时", formatRelTime(base - 3600_000), "1 小时前");
    expectEq("23 小时", formatRelTime(base - 23 * 3600_000), "23 小时前");
    expectEq("1 天", formatRelTime(base - 86400_000), "1 天前");
    expectEq("6 天", formatRelTime(base - 6 * 86400_000), "6 天前");
    // 超过 7 天 → 绝对日期：2026/01/08
    expectEq(">7 天 → 年月日", formatRelTime(base - 8 * 86400_000), "2026/1/7");
    expectEq("0 ts 保护 → 空串", formatRelTime(0), "");
  } finally {
    Date.now = savedNow;
  }
}

console.log("\n== formatGroupLabel：会话分组边界（基于当前真实 Date，无 mock） ==");
{
  // 不用 mock：直接基于当前真实时间计算今天 00:00、昨天 00:00 等时间戳
  const n = new Date();
  const startToday = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  const yesterday0 = startToday - 86400_000;
  const d7ago = startToday - 7 * 86400_000;

  expectEq("今天 00:00:00 → 今天", formatGroupLabel(startToday), "今天");
  expectEq("今天某时刻（距 startToday + 1h）→ 今天", formatGroupLabel(startToday + 3600_000), "今天");
  expectEq("昨天 23:59:59.999 → 昨天", formatGroupLabel(startToday - 1), "昨天");
  expectEq("昨天 00:00 → 昨天", formatGroupLabel(yesterday0), "昨天");
  expectEq("6 天前 00:00 → 7天内（startToday - 6*86400000 ≥ startToday - 7天）",
    formatGroupLabel(startToday - 6 * 86400_000), "7天内");
  expectEq("刚好 7 天前 00:00 → 7天内（边界包含）",
    formatGroupLabel(d7ago), "7天内");
  expectEq("8 天前 23:59:59 → 更早（< startToday - 7天）",
    formatGroupLabel(d7ago - 1), "更早");
}

console.log("\n== formatMsgTime：同日 HH:mm，跨日 MM/DD HH:mm（基于当前真实 Date） ==");
{
  const n = new Date();
  const y = n.getFullYear();
  const m = n.getMonth();
  const d = n.getDate();
  // 同日 9:05 → 补零
  expectEq("同日 9:05 → 补零 09:05", formatMsgTime(new Date(y, m, d, 9, 5, 0).getTime()), "09:05");
  expectEq("同日 14:00", formatMsgTime(new Date(y, m, d, 14, 0, 0).getTime()), "14:00");
  // 跨日 = 昨天
  const pm = d === 1 ? new Date(y, m - 1, 28, 9, 0, 0) : new Date(y, m, d - 1, 9, 0, 0);
  const mm = pm.getMonth() + 1;
  const dd = pm.getDate();
  const padH = String(9).padStart(2, "0");
  expectEq(`跨日（昨天）→ ${mm}/${dd} ${padH}:00`,
    formatMsgTime(pm.getTime()), `${mm}/${dd} ${padH}:00`);
  expectEq("0 ts → 空串", formatMsgTime(0), "");
}

// ==================================================================
// 3. 工具卡片状态（审批结果覆盖默认状态）
// ==================================================================
console.log("\n== toolCardStateText：优先级 running > approval > done/error ==");
expectEq("running 无视审批", toolCardStateText({ status: "running", approval: { action: "approved" } } as ToolCard), "运行中");
expectEq("done + approved 显示审批结果", toolCardStateText({ status: "done", approval: { action: "approved" } } as ToolCard), "已通过审批");
expectEq("done + denied", toolCardStateText({ status: "done", approval: { action: "denied" } } as ToolCard), "已拒绝");
expectEq("error + denied_auto → 已拦截（审批优先，忽略 error 完成态）", toolCardStateText({ status: "error", approval: { action: "denied_auto" } } as ToolCard), "已拦截");
expectEq("done + elapsed=123 → 完成 · 123ms", toolCardStateText({ status: "done", elapsedMs: 123 } as ToolCard), "完成 · 123ms");
expectEq("done + elapsed=1500 → 完成 · 1.5s", toolCardStateText({ status: "done", elapsedMs: 1500 } as ToolCard), "完成 · 1.5s");
expectEq("error 无 elapsed → 失败", toolCardStateText({ status: "error" } as ToolCard), "失败");

console.log("\n== toolCardStateClass：审批语义色 + error danger ==");
expectEq("denied → danger", toolCardStateClass({ status: "done", approval: { action: "denied" } } as ToolCard), "card-state-danger");
expectEq("denied_auto → danger", toolCardStateClass({ status: "done", approval: { action: "denied_auto" } } as ToolCard), "card-state-danger");
expectEq("timeout → warning", toolCardStateClass({ status: "done", approval: { action: "timeout" } } as ToolCard), "card-state-warning");
expectEq("approved → success", toolCardStateClass({ status: "done", approval: { action: "approved" } } as ToolCard), "card-state-success");
expectEq("auto → brand", toolCardStateClass({ status: "done", approval: { action: "auto" } } as ToolCard), "card-state-brand");
expectEq("无审批 + error → danger", toolCardStateClass({ status: "error" } as ToolCard), "card-state-danger");
expectEq("无审批 + done → 空串（默认灰）", toolCardStateClass({ status: "done" } as ToolCard), "");

// ==================================================================
// 4. 审批参数格式化（按工具展示）
// ==================================================================
console.log("\n== formatApprovalArgs：run_bash 显示命令 ==");
expectEq("run_bash 直接命令", formatApprovalArgs("run_bash", { command: "npm install" }), "npm install");
expectEq("run_bash 非 string command 降级 JSON", formatApprovalArgs("run_bash", { command: 123 }), '{"command":123}');

console.log("\n== formatApprovalArgs：write_file/append_file 路径 + 内容预览 ==");
{
  const longContent = "x".repeat(300);
  const out = formatApprovalArgs("write_file", { path: "a/b.ts", content: longContent });
  expectTrue("包含路径行", out.startsWith("路径: a/b.ts"), `实际: ${out.slice(0, 30)}`);
  expectTrue("包含内容行数（1 行）", out.includes("内容(1 行):"), `实际: ${out}`);
  expectTrue("长内容截断后加省略号", out.includes("…"), `实际尾部: ${out.slice(-20)}`);
}
expectEq("write_file 无 content 时仅路径（undefined 不进入 content 分支）", formatApprovalArgs("write_file", { path: "x.md" }), "路径: x.md");

console.log("\n== formatApprovalArgs：delete_file / move_file / copy_file 路径 ==");
expectEq("delete_file 单路径", formatApprovalArgs("delete_file", { path: "old.log" }), "路径: old.log");
expectEq("move_file 显示 from+to 两行", formatApprovalArgs("move_file", { from: "a.txt", to: "b.txt" }), "路径: a.txt\n路径: b.txt");
expectEq("copy_file from 非字符串时过滤掉", formatApprovalArgs("copy_file", { from: 1, to: "out" }), "路径: out");

console.log("\n== formatApprovalArgs：未知工具走 JSON ==");
const jsonOut = formatApprovalArgs("custom_tool", { a: 1, b: ["x"] });
expectTrue("未知工具格式含 JSON 缩进", jsonOut.includes('"a": 1') && jsonOut.includes('"b"'));
expectEq("null/undefined args → 空串", formatApprovalArgs("write_file", null), "");
expectEq("非 object args → 空串", formatApprovalArgs("write_file", "string"), "");

// ==================================================================
// 5. UsageInfo 累加（可选字段 cacheWrite1h / reasoning）
// ==================================================================
console.log("\n== addUsage：b null → 返回 a ==");
const a1: UsageInfo = {
  input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1.0 },
};
expectEq("b=null 返回 a（引用）", addUsage(a1, null), a1);
expectEq("a=undefined b=null 返回 null", addUsage(undefined, null), null);

console.log("\n== addUsage：a null → 返回 b（原引用），b null → 返回 a（原引用） ==");
const b1: UsageInfo = {
  input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cacheWrite1h: 5, totalTokens: 100,
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
};
const resNullA = addUsage(null, b1)!;
expectEq("a=null 返回 b（引用同一对象）", resNullA, b1);
expectTrue("a=null 时返回原引用（非克隆）", resNullA === b1);

console.log("\n== addUsage：两个都有值 → 逐字段相加 ==");
const a2: UsageInfo = {
  input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5, totalTokens: 15,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 },
};
const b2: UsageInfo = {
  input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cacheWrite1h: 8, totalTokens: 100,
  cost: { input: 1, output: 2, cacheRead: 0.3, cacheWrite: 0.4, total: 3.7 },
};
const sum = addUsage(a2, b2)!;
expectEq("sum.input", sum.input, 11);
expectEq("sum.output", sum.output, 22);
expectEq("sum.cacheRead", sum.cacheRead, 33);
expectEq("sum.cacheWrite", sum.cacheWrite, 44);
expectEq("sum.cacheWrite1h（仅 b 有值）", sum.cacheWrite1h, 8);
expectEq("sum.reasoning（仅 a 有值 → 被默认 +0 保持正确）", sum.reasoning, 5);
expectEq("sum.totalTokens", sum.totalTokens, 115);
expectEq("sum.cost.input", sum.cost.input, 1.1);
expectEq("sum.cost.total（总计）", sum.cost.total, 4.07);
// 验证返回的 cost 是全新对象（不共享引用）：修改源后 sum 不受影响
const savedB2Total = b2.cost.total;
b2.cost.total = 99999;
expectTrue("cost 对象为新构造（修改 b2 不影响 sum.cost.total）", sum.cost.total === 4.07, `实际 sum.cost.total=${sum.cost.total}`);
b2.cost.total = savedB2Total;

console.log("\n== addUsage：都无可选字段 → 结果也无多余字段 ==");
const aMin: UsageInfo = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const bMin: UsageInfo = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const sumMin = addUsage(aMin, bMin)!;
expectTrue("无 cacheWrite1h → 结果不含该字段", !("cacheWrite1h" in sumMin));
expectTrue("无 reasoning → 结果不含该字段", !("reasoning" in sumMin));

// ==================================================================
// 6. 工具卡片 localStorage 持久化（需 polyfill localStorage）
// ==================================================================
console.log("\n== toolCards 持久化：polyfill localStorage 后 load/save/clear 正常 ==");
polyfillLocalStorage();
{
  clearToolCards("sess-1");
  expectEq("空会话读取 → 空数组", loadToolCards("sess-1"), []);
  expectEq("null sessionId → 空数组", loadToolCards(null), []);

  const c1: ToolCard = { id: "t1", toolName: "read_file", args: {}, status: "done", result: "OK" };
  const cRunning: ToolCard = { id: "t2", toolName: "write_file", args: {}, status: "running" };
  saveToolCards("sess-1", [c1, cRunning]);
  // running 卡片不持久化，只能读到 done
  const loaded = loadToolCards("sess-1");
  expectEq("running 卡片被过滤，只存 done", loaded.length, 1);
  expectEq("已存卡片 id=t1", loaded[0].id, "t1");

  // 超过 50 条上限 → 只保留最新 50 条
  const many: ToolCard[] = [];
  for (let i = 0; i < 55; i++) many.push({ id: `n${i}`, toolName: "x", args: {}, status: "done" });
  saveToolCards("sess-1", many);
  const trimmed = loadToolCards("sess-1");
  expectEq(">50 条被截断为 50", trimmed.length, 50);
  expectEq("保留最后 50 条（首条应为 n5）", trimmed[0].id, "n5");
  expectEq("末条应为 n54", trimmed[49].id, "n54");

  // clearToolCards 后读不到
  clearToolCards("sess-1");
  expectEq("clear 后再读 → 空数组", loadToolCards("sess-1"), []);

  // saveToolCards 遇 null sessionId → 不抛错（静默）
  let threwSaveNull = false;
  try { saveToolCards(null, [c1]); } catch { threwSaveNull = true; }
  expectTrue("saveToolCards(null) 不抛错", !threwSaveNull);

  // localStorage 抛错场景（如 quota exceeded）→ 降级为不持久化
  const savedGetItem = (globalThis as unknown as { localStorage: Storage }).localStorage.getItem;
  (globalThis as unknown as { localStorage: Storage }).localStorage.getItem = () => { throw new Error("QUOTA"); };
  expectEq("localStorage.getItem 抛错 → 返回 []（降级）", loadToolCards("sess-x"), []);
  (globalThis as unknown as { localStorage: Storage }).localStorage.getItem = savedGetItem;
}
disposeLocalStorage();

console.log("\n✓ 对话共享工具函数验证通过");
process.exit(0);

// ==================================================================
// 辅助：fakeReadSSE —— 构造 Response 把字符串作为 ReadableStream 供 readSSE 消费
// ==================================================================
async function fakeReadSSE(textBody: string, onEvent: (e: SseEvent) => void) {
  return fakeReadSSEChunks([textBody], onEvent);
}

async function fakeReadSSEChunks(chunks: string[], onEvent: (e: SseEvent) => void) {
  const enc = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(chunks[i++]));
    },
  });
  const resp = new Response(stream) as never;
  await readSSE(resp, onEvent);
}

// localStorage polyfill（兼容 Node.js 环境）
function polyfillLocalStorage() {
  const store = new Map<string, string>();
  const impl: Storage = {
    get length() { return store.size; },
    clear() { store.clear(); },
    getItem(k: string) { const v = store.get(k); return v === undefined ? null : v; },
    key(i: number) { return [...store.keys()][i] ?? null; },
    removeItem(k: string) { store.delete(k); },
    setItem(k: string, v: string) { store.set(k, v); },
  };
  (globalThis as unknown as { localStorage: Storage }).localStorage = impl;
}
function disposeLocalStorage() {
  delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
}
