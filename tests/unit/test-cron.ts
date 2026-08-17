/**
 * lib/cron.ts 单元测试 —— 纯函数断言，无外部依赖。
 * 覆盖：parseCron 合法/非法表达式、dow 归一化、nextCronRun 定时计算与不可达表达式。
 * 运行：npx tsx tests/unit/test-cron.ts
 */
import { parseCron, nextCronRun } from "../../lib/cron";

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
  if (!cond) {
    fail(`${name}: 期望 true${detail ? `，${detail}` : ""}`);
  }
  console.log(`  ✓ ${name}`);
}

function expectThrows(name: string, fn: () => void, wantMsg: string) {
  try {
    fn();
    fail(`${name}: 未抛异常，期望包含 "${wantMsg}"`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes(wantMsg)) {
      fail(`${name}: 异常消息 "${msg}" 不包含 "${wantMsg}"`);
    }
  }
  console.log(`  ✓ ${name}`);
}

// —— 固定时间戳，避免依赖真实时钟 ——
// 2025-01-15 (周三) 10:00:00 本地时间
const FROM_MS = new Date(2025, 0, 15, 10, 0, 0).getTime();

// —— parseCron 合法表达式 ——
console.log("== parseCron() 合法表达式 ==");

(function () {
  const p = parseCron("* * * * *");
  expectEq("'* * * * *' 所有字段 wildcard", {
    m_wc: p.minute.wildcard,
    h_wc: p.hour.wildcard,
    d_wc: p.day.wildcard,
    mo_wc: p.month.wildcard,
    dow_wc: p.dow.wildcard,
  }, { m_wc: true, h_wc: true, d_wc: true, mo_wc: true, dow_wc: true });
  expectEq("'* * * * *' minute 覆盖 0-59", p.minute.values.size, 60);
  expectEq("'* * * * *' hour 覆盖 0-23", p.hour.values.size, 24);
  expectEq("'* * * * *' day 覆盖 1-31", p.day.values.size, 31);
  expectEq("'* * * * *' month 覆盖 1-12", p.month.values.size, 12);
  expectEq("'* * * * *' dow 覆盖 0-6", p.dow.values.size, 7);
})();

(function () {
  const p = parseCron("30 * * * *");
  expectEq("'30 * * * *' minute 值为 {30}", p.minute.values, new Set([30]));
  expectEq("'30 * * * *' minute 非 wildcard", p.minute.wildcard, false);
})();

(function () {
  const p = parseCron("1-5 * * * *");
  expectEq("'1-5 * * * *' minute 值为 {1,2,3,4,5}", p.minute.values, new Set([1, 2, 3, 4, 5]));
})();

(function () {
  const p = parseCron("1,3,5 * * * *");
  expectEq("'1,3,5 * * * *' minute 值为 {1,3,5}", p.minute.values, new Set([1, 3, 5]));
})();

(function () {
  const p = parseCron("*/5 * * * *");
  const expected = new Set<number>();
  for (let i = 0; i <= 59; i += 5) expected.add(i);
  expectEq("'*/5 * * * *' minute 步长5", p.minute.values, expected);
  expectEq("'*/5 * * * *' minute wildcard=false (part非纯*)", p.minute.wildcard, false);
})();

(function () {
  const p = parseCron("1-10/2 * * * *");
  expectEq("'1-10/2 * * * *' minute 范围+步长", p.minute.values, new Set([1, 3, 5, 7, 9]));
})();

(function () {
  const p = parseCron("30 9 * * *");
  expectEq("'30 9 * * *' minute={30}, hour={9}", {
    m: p.minute.values,
    h: p.hour.values,
  }, { m: new Set([30]), h: new Set([9]) });
})();

(function () {
  const p = parseCron("0 0 * * 1");
  expectEq("'0 0 * * 1' dow={1}", p.dow.values, new Set([1]));
})();

(function () {
  const p = parseCron("0 0 1 1 *");
  expectEq("'0 0 1 1 *' day={1}, month={1}", {
    d: p.day.values,
    mo: p.month.values,
  }, { d: new Set([1]), mo: new Set([1]) });
})();

(function () {
  const p = parseCron("0 9-17 * * 1-5");
  expectEq("'0 9-17 * * 1-5' hour 范围", p.hour.values.size, 9);
  expectEq("'0 9-17 * * 1-5' dow 范围", p.dow.values, new Set([1, 2, 3, 4, 5]));
})();

(function () {
  const p = parseCron("0 0 1,15 * *");
  expectEq("'0 0 1,15 * *' day 列表", p.day.values, new Set([1, 15]));
})();

// —— parseCron 非法表达式 ——
console.log("\n== parseCron() 非法表达式 ==");

expectThrows("字段数不足 (3字段)", () => parseCron("* * *"), "须为 5 字段");
expectThrows("字段数过多 (6字段)", () => parseCron("* * * * * *"), "须为 5 字段");
expectThrows("minute 越界 (60)", () => parseCron("60 * * * *"), "值越界");
expectThrows("hour 越界 (24)", () => parseCron("* 24 * * *"), "值越界");
expectThrows("day 越界 (0)", () => parseCron("* * 0 * *"), "值越界");
expectThrows("month 越界 (13)", () => parseCron("* * * 13 *"), "值越界");
expectThrows("dow 越界 (8)", () => parseCron("* * * * 8"), "值越界");
expectThrows("minute 非法语法 (abc)", () => parseCron("abc * * * *"), "值非法");
expectThrows("范围非法 (a-b)", () => parseCron("a-b * * * *"), "范围非法");
expectThrows("步进非法 (*/0)", () => parseCron("*/0 * * * *"), "步进非法");
expectThrows("空列表片段 (1,)", () => parseCron("1, * * * *"), "空片段");
expectThrows("空字段 (纯空白)", () => parseCron("  "), "须为 5 字段");

// —— dow 归一化 ——
console.log("\n== parseCron() dow 归一化 ==");

(function () {
  const p = parseCron("0 0 * * 7");
  expectEq("dow=7 归一化为 0", p.dow.values, new Set([0]));
})();

(function () {
  const p = parseCron("0 0 * * 0,7");
  expectEq("dow=0,7 归一化后去重为 {0}", p.dow.values, new Set([0]));
})();

(function () {
  const p = parseCron("0 0 * * 6,7");
  expectEq("dow=6,7 归一化为 {0,6}", p.dow.values, new Set([0, 6]));
})();

// —— nextCronRun 正常计算 ——
console.log("\n== nextCronRun() 正常计算 ==");

(function () {
  // 2025-01-15 10:00 → 次日 09:00
  const result = nextCronRun("0 9 * * *", FROM_MS);
  expectEq("'0 9 * * *' 每日9am", result, new Date(2025, 0, 16, 9, 0, 0).getTime());
})();

(function () {
  // 2025-01-15 10:00 → 同日 10:15
  const result = nextCronRun("*/15 * * * *", FROM_MS);
  expectEq("'*/15 * * * *' 每15分钟", result, new Date(2025, 0, 15, 10, 15, 0).getTime());
})();

(function () {
  // 2025-01-15 (周三) → 下一个周一 2025-01-20 00:00
  const result = nextCronRun("0 0 * * 1", FROM_MS);
  expectEq("'0 0 * * 1' 每周一零点", result, new Date(2025, 0, 20, 0, 0, 0).getTime());
})();

(function () {
  // 2025-01-15 10:00 → 2025-02-01 14:30
  const result = nextCronRun("30 14 1 * *", FROM_MS);
  expectEq("'30 14 1 * *' 每月1号14:30", result, new Date(2025, 1, 1, 14, 30, 0).getTime());
})();

// —— nextCronRun 从 Date 对象出发 ——
console.log("\n== nextCronRun() 从 Date 对象出发 ==");

(function () {
  const fromDate = new Date(2025, 0, 15, 10, 0, 0);
  const result = nextCronRun("*/15 * * * *", fromDate);
  expectEq("Date 对象输入等价于时间戳", result, new Date(2025, 0, 15, 10, 15, 0).getTime());
})();

// —— nextCronRun 跨月/跨年 ——
console.log("\n== nextCronRun() 边界情况 ==");

(function () {
  // 1月31日 → 2月1日
  const from = new Date(2025, 0, 31, 23, 50, 0).getTime();
  const result = nextCronRun("0 0 1 * *", from);
  expectEq("1月31日午夜 → 2月1日零点", result, new Date(2025, 1, 1, 0, 0, 0).getTime());
})();

(function () {
  // 年内最后一天 → 次年
  const from = new Date(2025, 11, 31, 23, 59, 0).getTime();
  const result = nextCronRun("0 0 1 1 *", from);
  expectEq("12月31日 → 次年1月1日", result, new Date(2026, 0, 1, 0, 0, 0).getTime());
})();

// —— nextCronRun 不可达表达式 ——
console.log("\n== nextCronRun() 不可达表达式 ==");

expectThrows(
  "2月31日不可达",
  () => nextCronRun("0 0 31 2 *", FROM_MS),
  "5 年内无匹配",
);

// —— 额外：日/周并集逻辑 ——
console.log("\n== nextCronRun() 日/周并集 ==");

(function () {
  // 2025-01-15 周三，day=15 且 dow=3 → 两者都受限取并集
  const from = new Date(2025, 0, 14, 23, 50, 0).getTime(); // 1月14日周二
  const result = nextCronRun("0 0 15 * 3", from); // day=15 或 dow=3(周三)
  // 1月15日是周三 (dow=3)，也是 day=15，所以 2025-01-15 00:00 匹配
  expectEq("日/周并集匹配", result, new Date(2025, 0, 15, 0, 0, 0).getTime());
})();

console.log("\n✓ cron 模块全部测试通过");
process.exit(0);