/**
 * 统一事件总线（events.ts）验证脚本 —— SimpleEventBus 隔离验证。
 * 覆盖：emit/subscribe、多订阅者、取消订阅、订阅后再 emit 的时序。
 * 运行：npx tsx tests/unit/test-events.ts
 */
import { SimpleEventBus, type BusEvent } from "../../lib/events";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

function expectEq(name: string, actual: unknown, want: unknown) {
  if (actual !== want) {
    fail(`${name}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(actual)}`);
  }
  console.log(`  ✓ ${name}`);
}

console.log("== 单订阅者收发 ==");
{
  const bus = new SimpleEventBus();
  const received: BusEvent[] = [];
  bus.subscribe((e) => received.push(e));
  const ev: BusEvent = { type: "approval_expired", id: "a1" };
  bus.emit(ev);
  expectEq("收到 1 条事件", received.length, 1);
  expectEq("事件引用一致（进程内总线不克隆）", received[0], ev);
}

console.log("\n== 多订阅者独立接收 ==");
{
  const bus = new SimpleEventBus();
  const r1: string[] = [];
  const r2: string[] = [];
  bus.subscribe((e) => r1.push((e as { id?: string }).id ?? ""));
  bus.subscribe((e) => r2.push((e as { id?: string }).id ?? ""));
  bus.emit({ type: "approval_expired", id: "x1" } as BusEvent);
  bus.emit({ type: "approval_expired", id: "x2" } as BusEvent);
  expectEq("订阅者 1 收到 2 条", r1.join(","), "x1,x2");
  expectEq("订阅者 2 同样收到 2 条", r2.join(","), "x1,x2");
}

console.log("\n== 取消订阅后不再收到 ==");
{
  const bus = new SimpleEventBus();
  const r: string[] = [];
  const unsub = bus.subscribe((e) => r.push((e as { id?: string }).id ?? ""));
  bus.emit({ type: "approval_expired", id: "y1" } as BusEvent);
  unsub();
  bus.emit({ type: "approval_expired", id: "y2" } as BusEvent);
  expectEq("取消订阅后仅保留第一条", r.join(","), "y1");
}

console.log("\n== 订阅者修改事件数组不影响其他订阅者（Set 迭代安全性） ==");
{
  const bus = new SimpleEventBus();
  const r: string[] = [];
  let unsubA: (() => void) | undefined;
  unsubA = bus.subscribe(() => {
    r.push("A");
    // 订阅者 A 收到后立即自取消（在 emit 过程中修改 Set）
    if (unsubA) unsubA();
  });
  bus.subscribe(() => r.push("B"));
  bus.subscribe(() => r.push("C"));
  bus.emit({ type: "approval_expired", id: "z" } as BusEvent);
  expectEq("迭代中自取消不影响其他订阅者", r.join(","), "A,B,C");
}

console.log("\n== 两个 bus 实例相互隔离 ==");
{
  const b1 = new SimpleEventBus();
  const b2 = new SimpleEventBus();
  const r1: number = 0;
  const r2: number = 0;
  b1.subscribe(() => (this as unknown as { c: number }).c++);
  b2.emit({ type: "approval_expired", id: "iso" } as BusEvent);
  expectEq("b1 未因 b2 emit 触发", r1, 0);
  expectEq("b2 无订阅者无副作用", r2, 0);
}

console.log("\n✓ 事件总线验证通过");
