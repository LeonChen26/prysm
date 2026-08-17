/**
 * LLM Guardian（lib/guardian.ts）纯函数验证脚本 —— 无需真实 LLM。
 * 覆盖：parseGuardianOutput（正常 JSON / 夹带文本 / 字段校验 / 越界截断 / 异常输入）。
 * 运行：npx tsx tests/unit/test-guardian.ts
 */
import { parseGuardianOutput } from "../../lib/guardian";

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

// ---------- 1. 正常 JSON 解析 ----------
console.log("== parseGuardianOutput：正常 JSON ==");
expectEq("allow:true, 有 reason", parseGuardianOutput('{"allow":true,"reason":"safe"}'), {
  allow: true,
  reason: "safe",
});
expectEq("allow:false, 中文 reason", parseGuardianOutput('{"allow":false,"reason":"危险"}'), {
  allow: false,
  reason: "危险",
});

// ---------- 2. 夹带文本（ surrounding text ） ----------
console.log("\n== parseGuardianOutput：夹带说明文本 ==");
expectEq(
  "前后有中文说明，正则仍可提取 JSON",
  parseGuardianOutput('根据分析 {"allow":true,"reason":"可以"} 结论'),
  { allow: true, reason: "可以" },
);

// ---------- 3. 字段校验：allow ----------
console.log("\n== parseGuardianOutput：allow 字段校验 ==");
expectEq("缺少 allow 字段 → null", parseGuardianOutput('{"reason":"无 allow"}'), null);
expectEq("allow 为字符串 → null", parseGuardianOutput('{"allow":"true","reason":"ok"}'), null);
expectEq("allow 为数字 → null", parseGuardianOutput('{"allow":1,"reason":"ok"}'), null);
expectEq("allow 为 null → null", parseGuardianOutput('{"allow":null,"reason":"ok"}'), null);

// ---------- 4. reason 处理 ----------
console.log("\n== parseGuardianOutput：reason 处理 ==");
expectEq("reason 为空字符串 → 保持空串", parseGuardianOutput('{"allow":true,"reason":""}'), {
  allow: true,
  reason: "",
});
expectEq("缺少 reason 字段 → undefined", parseGuardianOutput('{"allow":true}'), {
  allow: true,
  reason: undefined,
});
{
  const longReason = "测".repeat(250);
  const out = parseGuardianOutput(JSON.stringify({ allow: true, reason: longReason }));
  expectTrue("reason 超长(250字) 截断到 200", out?.reason?.length === 200);
  expectTrue("截断后前 200 字符保留", out?.reason === longReason.slice(0, 200));
}

// ---------- 5. 异常输入容错 ----------
console.log("\n== parseGuardianOutput：异常输入 ==");
expectEq("无任何 JSON → null", parseGuardianOutput("这只是一段普通文本"), null);
expectEq("损坏 JSON（缺右花括号）→ null", parseGuardianOutput('{"allow":true'), null);
expectEq("损坏 JSON（引号错位）→ null", parseGuardianOutput('{"allow":true,}'), null);
expectEq("空串 → null", parseGuardianOutput(""), null);

console.log("\n✓ LLM Guardian 纯函数解析验证通过");
process.exit(0);