/**
 * LLM-as-Judge（lib/judge.ts）验证脚本 —— 纯函数断言，无需真实 LLM。
 * 覆盖：judgeEnabled 开关（默认关 / PRYSM_LLM_JUDGE=1 开）、
 *      parseJudgeOutput（正常 JSON / 夹带文本 / 越界截断 / 非 JSON / 损坏 JSON）。
 * 运行：npx tsx tests/unit/test-judge.ts
 */
import { configure, resetConfig } from "../../lib/config";
import { judgeEnabled, parseJudgeOutput } from "../../lib/judge";

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

// ---------- 1. 开关：默认关闭 ----------
console.log("== judgeEnabled：默认关闭，PRYSM_LLM_JUDGE=1 开启 ==");
configure({ baseDir: process.cwd(), env: {} });
expectEq("未配置时默认关闭", judgeEnabled(), false);
configure({ baseDir: process.cwd(), env: { PRYSM_LLM_JUDGE: "1" } });
expectEq("PRYSM_LLM_JUDGE=1 开启", judgeEnabled(), true);
configure({ baseDir: process.cwd(), env: { PRYSM_LLM_JUDGE: "true" } });
expectEq("PRYSM_LLM_JUDGE=true 开启", judgeEnabled(), true);
configure({ baseDir: process.cwd(), env: { PRYSM_LLM_JUDGE: "yes" } });
expectEq("PRYSM_LLM_JUDGE=yes 开启", judgeEnabled(), true);
configure({ baseDir: process.cwd(), env: { PRYSM_LLM_JUDGE: "0" } });
expectEq("PRYSM_LLM_JUDGE=0 关闭", judgeEnabled(), false);

// ---------- 2. 输出解析：正常 JSON ----------
console.log("\n== parseJudgeOutput：正常 JSON ==");
expectEq("纯 JSON 完整解析", parseJudgeOutput('{"score":8,"reason":"完成得很好"}'), {
  score: 8,
  reason: "完成得很好",
});

console.log("\n== parseJudgeOutput：夹带说明文本（Markdown 代码块包裹） ==");
expectEq(
  "代码块内 JSON 仍可提取",
  parseJudgeOutput('好的，评估结果如下：\n```json\n{"score":6,"reason":"部分完成"}\n```'),
  { score: 6, reason: "部分完成" },
);

console.log("\n== parseJudgeOutput：越界截断（>10 → 10，<0 → 0，小数取整） ==");
expectEq("score=12 → 截断为 10", parseJudgeOutput('{"score":12}'), { score: 10 });
expectEq("score=-3 → 截断为 0", parseJudgeOutput('{"score":-3}'), { score: 0 });
expectEq("score=7.6 → 四舍五入 8", parseJudgeOutput('{"score":7.6}'), { score: 8 });

console.log("\n== parseJudgeOutput：reason 超长截断 ==");
{
  const longReason = "x".repeat(500);
  const out = parseJudgeOutput(JSON.stringify({ score: 5, reason: longReason }));
  expectEq("reason 截断到 200", out?.reason?.length, 200);
}

console.log("\n== parseJudgeOutput：异常输入容错 ==");
expectEq("非 JSON 文本 → null", parseJudgeOutput("评分完毕"), null);
expectEq("损坏 JSON → null", parseJudgeOutput('{"score":8'), null);
expectEq("空串 → null", parseJudgeOutput(""), null);
expectEq("score 非数字 → 无 score 字段", parseJudgeOutput('{"score":"高","reason":"好"}'), {
  reason: "好",
});
expectEq("reason 非字符串 → 无 reason 字段", parseJudgeOutput('{"score":7,"reason":123}'), {
  score: 7,
});

resetConfig();
console.log("\n✓ LLM-as-Judge 解析与开关验证通过");
process.exit(0);
