/**
 * MCP 接入（tools/mcp.ts + registry 集成）验证脚本 —— 纯结构断言 + 真实 mock stdio server。
 * 覆盖：
 * - jsonSchemaToTypebox / mcpResultToAgentContent / toolSource / loadMcpConfig 纯函数
 * - McpClientPool：连接 mock server、status、toolsOf、callTool、resources、prompts
 * - McpToolProvider：工具命名 mcp__<server>__<tool>、execute 转发
 * - isSensitiveMcpTool：readOnly/destructive/无标注 三档判定
 * - resolveAgentTools：默认注册表含内置工具 + MCP 工具
 * 运行：npx tsx tests/unit/test-mcp.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configure, resetConfig } from "../../lib/config";
import {
  McpClientPool,
  McpToolProvider,
  isSensitiveMcpTool,
  jsonSchemaToTypebox,
  loadMcpConfig,
  mcpResultToAgentContent,
  mcpToolProviders,
  getMcpPool,
  resetMcpPool,
} from "../../lib/tools/mcp";
import { ToolRegistry, resolveAgentTools, resetToolRegistry } from "../../lib/tools/registry";
import { toolSource } from "../../lib/risk";

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
    fail(`${name}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(actual)}`);
  }
  console.log(`  ✓ ${name}`);
}

const here = path.dirname(fileURLToPath(import.meta.url)); // tests/unit
const projectRoot = path.resolve(here, "../..");
const fixture = path.join(projectRoot, "tests", "fixtures", "mcp-mock-server.mjs");

// ---------------------------------------------------------------- 纯函数

console.log("== jsonSchemaToTypebox：JSON Schema → typebox ==");
{
  const s = jsonSchemaToTypebox({ type: "object", properties: { name: { type: "string" } }, required: ["name"] });
  expectEq("object 含必填字段 → type=object", s.type, "object");
  expectEq("必填字段进入 required", (s as { required?: string[] }).required, ["name"]);
  const opt = jsonSchemaToTypebox({ type: "object", properties: { note: { type: "string" } } });
  const optReq = (opt as { required?: string[] }).required ?? [];
  expectEq("非必填字段不进 required", optReq.includes("note"), false);
  const lit = jsonSchemaToTypebox({ type: "string", enum: ["a", "b"] });
  expectEq("enum → union(anyOf)", (lit as { anyOf?: unknown[] }).anyOf?.length, 2);
  const arr = jsonSchemaToTypebox({ type: "array", items: { type: "integer" } });
  expectEq("array → array", arr.type, "array");
  const num = jsonSchemaToTypebox({ type: "number" });
  expectEq("number → number", num.type, "number");
  const unk = jsonSchemaToTypebox({ $ref: "#/definitions/x" });
  expectEq("无法映射 → Unsafe 原样透传", (unk as { $ref?: string }).$ref, "#/definitions/x");
}

console.log("\n== mcpResultToAgentContent：MCP 结果 → AgentToolResult content ==");
{
  const r = mcpResultToAgentContent({
    content: [
      { type: "text", text: "ok" },
      { type: "image", data: "base64", mimeType: "image/png" },
    ],
    structuredContent: { rows: 3 },
  } as never);
  expectEq("text 保留", r.content.filter((c) => c.type === "text").map((c) => c.text).join("|"), "ok|{\"rows\":3}");
  expectEq("image 保留", r.content.some((c) => c.type === "image" && (c as { mimeType: string }).mimeType === "image/png"), true);
  expectEq("非错误默认 false", r.isError, false);
  const err = mcpResultToAgentContent({ content: [{ type: "text", text: "boom" }], isError: true } as never);
  expectEq("isError 透传", err.isError, true);
}

console.log("\n== toolSource：工具名 → 来源 ==");
expectEq("mcp__* → mcp", toolSource("mcp__server__tool"), "mcp");
expectEq("skill__* → skill", toolSource("skill__name__tool"), "skill");
expectEq("内置 → core", toolSource("write_file"), "core");

console.log("\n== loadMcpConfig：缺失 / 非法 / 正常 ==");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prysm-mcp-cfg-"));
  const missing = path.join(tmp, "no-such.json");
  expectEq("文件缺失 → 空对象", JSON.stringify(loadMcpConfig(missing)), "{}");
  const bad = path.join(tmp, "bad.json");
  fs.writeFileSync(bad, "{ not json", "utf-8");
  expectEq("解析失败 → 空对象", JSON.stringify(loadMcpConfig(bad)), "{}");
  const good = path.join(tmp, "good.json");
  fs.writeFileSync(good, JSON.stringify({ servers: { a: { command: "x" } } }), "utf-8");
  expectEq("正常解析", JSON.stringify(loadMcpConfig(good)), JSON.stringify({ a: { command: "x" } }));
}

// ------------------------------------------------------------- 真实连接

console.log("\n== McpClientPool：连接 mock stdio server ==");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prysm-mcp-"));
const mcpJson = path.join(tmpDir, "mcp.json");
fs.writeFileSync(
  mcpJson,
  JSON.stringify(
    {
      servers: {
        mock: { command: process.execPath, args: [fixture], cwd: projectRoot },
      },
    },
    null,
    2,
  ),
  "utf-8",
);

// 重置全局池与配置，让 getMcpPool() 惰性读取 <baseDir>/mcp.json
resetConfig();
resetMcpPool();
configure({ baseDir: tmpDir, env: {} });
const pool = getMcpPool();

{
  const statuses = await pool.ensureInit();
  const mock = statuses.find((s) => s.name === "mock");
  if (!mock) fail("mock server 未出现在状态列表");
  expectEq("连接成功", mock.status, "connected");
  expectEq("tools 数量", mock.tools, 3);
  expectEq("resources 数量", mock.resources, 1);
  expectEq("prompts 数量", mock.prompts, 1);
  expectEq("传输类型 stdio", mock.transport, "stdio");
}

{
  const defs = await pool.toolsOf("mock");
  const names = defs.map((d) => d.name).sort();
  expectEq("工具定义齐全", names, ["delete_all", "echo", "hello"]);
  const hello = defs.find((d) => d.name === "hello")!;
  expectEq("readOnlyHint 透传", hello.readOnlyHint, true);
  const del = defs.find((d) => d.name === "delete_all")!;
  expectEq("destructiveHint 透传", del.destructiveHint, true);
}

{
  const res = await pool.callTool("mock", "hello", { name: "prysm" });
  const text = (res.content?.[0] as { type: "text"; text?: string })?.text;
  expectEq("callTool 调用成功", text, "hello, prysm");
  const echo = await pool.callTool("mock", "echo", { text: "abc" });
  expectEq("echo 回显", (echo.content?.[0] as { text?: string })?.text, "abc");
}

{
  const resources = await pool.listResources("mock");
  expectEq("listResources", resources.map((r) => r.uri), ["mock://doc"]);
  const prompts = await pool.listPrompts("mock");
  expectEq("listPrompts", prompts.map((p) => p.name), ["greet"]);
  const greet = await pool.getPrompt("mock", "greet");
  expectEq("getPrompt", greet.messages?.[0]?.role, "user");
}

console.log("\n== McpToolProvider：映射为 AgentTool ==");
{
  const provider = new McpToolProvider(pool, "mock");
  const tools = await provider.load();
  const names = tools.map((t) => t.name).sort();
  expectEq("命名 mcp__mock__*", names, ["mcp__mock__delete_all", "mcp__mock__echo", "mcp__mock__hello"]);
  const hello = tools.find((t) => t.name === "mcp__mock__hello")!;
  expectEq("label 取 title", hello.label, "打招呼");
  const r = await hello.execute("call-1", { name: "tester" });
  expectEq("execute 转发 callTool", (r.content[0] as { text?: string }).text, "hello, tester");
}

console.log("\n== registry 聚合：MCP provider 注册进工具注册表 ==");
{
  const reg = new ToolRegistry();
  for (const p of await mcpToolProviders()) reg.register(p);
  const names = (await reg.resolve()).map((t) => t.name).sort();
  expectEq(
    "含全部 mcp 工具",
    names,
    ["mcp__mock__delete_all", "mcp__mock__echo", "mcp__mock__hello"],
  );
}

console.log("\n== isSensitiveMcpTool：按标注判定（含默认敏感） ==");
expectEq("readOnly → 非敏感", isSensitiveMcpTool("mcp__mock__hello"), false);
expectEq("destructive → 敏感", isSensitiveMcpTool("mcp__mock__delete_all"), true);
expectEq("无标注 → 默认敏感", isSensitiveMcpTool("mcp__mock__echo"), true);
expectEq("非 MCP 名 → false", isSensitiveMcpTool("write_file"), false);
expectEq("未连接 server → 默认敏感", isSensitiveMcpTool("mcp__ghost__tool"), true);

console.log("\n== resolveAgentTools：默认注册表含内置 + MCP ==");
{
  resetToolRegistry();
  const all = await resolveAgentTools();
  const names = new Set(all.map((t) => t.name));
  expectEq("含内置工具", names.has("list_dir"), true);
  expectEq("含 MCP 工具", names.has("mcp__mock__hello"), true);
  expectEq("工具总量 = 内置 + MCP", all.length, 23); // 20 内置（含 spawn_subagent/plan_propose）+ 3 MCP
}

console.log("\n== McpClientPool：close 后状态清空 ==");
{
  await pool.close();
  expectEq("close 后 status 为空", pool.status().length, 0);
}

console.log("\n✓ MCP 接入验证通过");
resetConfig();
resetMcpPool();
resetToolRegistry();
process.exit(0);
