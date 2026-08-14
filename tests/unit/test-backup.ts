/**
 * 备份恢复（backup.ts）格式校验验证脚本。
 * 重点覆盖 importBackup 的数据验证边界（坏格式/坏版本/缺失字段 → 抛错拒绝），
 * 确保损坏的备份文件不会污染数据库。
 * 合法导入（真实 restore）属于集成层，已由 e2e 场景覆盖。
 * 运行：npx tsx tests/unit/test-backup.ts
 */
import { exportBackup, importBackup, type BackupFile } from "../../lib/backup";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

function expectThrows(name: string, fn: () => void, wantMsg: string) {
  try {
    fn();
    fail(`${name}: 期望抛错但未抛`);
  } catch (e) {
    const msg = (e as Error).message;
    if (!msg.includes(wantMsg)) {
      fail(`${name}: 错误消息应包含 "${wantMsg}"，实际 "${msg}"`);
    }
    console.log(`  ✓ ${name} → ${msg}`);
  }
}

console.log("== importBackup 拒绝非法输入 ==");

expectThrows("null 输入", () => importBackup(null), "备份文件格式不正确");
expectThrows("undefined 输入", () => importBackup(undefined), "备份文件格式不正确");
expectThrows("空对象 {} 输入", () => importBackup({}), "备份文件格式不正确");
expectThrows(
  "version=2（不支持的版本）",
  () => importBackup({ version: 2 as unknown as 1, sessions: [] }),
  "缺少 version=1",
);
expectThrows(
  "version=0（过旧版本）",
  () => importBackup({ version: 0 as unknown as 1, sessions: [] }),
  "缺少 version=1",
);
expectThrows(
  "sessions 非数组",
  () => importBackup({ version: 1, sessions: "not-array" as unknown as BackupFile["sessions"] }),
  "sessions 数组",
);
expectThrows(
  "仅 version=1，缺 sessions",
  () => importBackup({ version: 1 } as Partial<BackupFile>),
  "sessions 数组",
);

console.log("\n== importBackup 容忍可选字段缺失（降级为空数组） ==");
{
  // messagesBySession / memory / todos 缺省或类型错误时应降级为空数组，
  // 不抛错（能进入 restore，之后由子模块处理）。
  // 我们验证在这之前不会因格式校验抛错（后面 restore 会因 sessions.db 不存在而抛另一种错，不在此覆盖）。
  const minimal: BackupFile = {
    version: 1,
    exportedAt: Date.now(),
    sessions: [],
    messagesBySession: {},
    memory: [],
    todos: [],
  };
  try {
    importBackup(minimal);
    // 如果 sessions DB 存在则会安静返回，否则抛错（各环境不一致）。
    // 我们只关心格式校验阶段通过，所以捕获"非格式类"错误即可。
    console.log("  ✓ 最小合法备份格式未被格式校验拒绝");
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("备份文件格式不正确")) {
      fail(`最小合法备份不应触发格式校验: ${msg}`);
    }
    console.log(`  ✓ 最小合法备份通过格式校验（后续 ${msg.split("\n")[0]} 属集成层）`);
  }
}

{
  // 缺 messagesBySession / memory / todos（都是可选）
  const partial: Partial<BackupFile> = {
    version: 1,
    exportedAt: Date.now(),
    sessions: [],
  };
  try {
    importBackup(partial);
    console.log("  ✓ 可选字段缺失的备份未被格式校验拒绝");
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("备份文件格式不正确")) {
      fail(`可选字段缺失不应触发格式校验: ${msg}`);
    }
    console.log(`  ✓ 可选字段缺失通过格式校验（后续 ${msg.split("\n")[0]} 属集成层）`);
  }
}

console.log("\n== exportBackup 返回值形状（冒烟） ==");
{
  // 注意：exportBackup 依赖 session/memory/todo 的 SQLite，可能因环境而异。
  // 我们仅验证返回对象的必备顶层字段存在且类型正确，不关心具体条数。
  const b = exportBackup();
  if (!b || typeof b !== "object") fail("exportBackup 返回非对象");
  if (b.version !== 1) fail(`exportBackup version 应为 1，实际 ${b.version}`);
  if (typeof b.exportedAt !== "number" || b.exportedAt <= 0) fail("exportBackup.exportedAt 非法");
  if (!Array.isArray(b.sessions)) fail("exportBackup.sessions 非数组");
  if (typeof b.messagesBySession !== "object") fail("exportBackup.messagesBySession 非对象");
  if (!Array.isArray(b.memory)) fail("exportBackup.memory 非数组");
  if (!Array.isArray(b.todos)) fail("exportBackup.todos 非数组");
  console.log("  ✓ exportBackup 返回对象具备合法形状 {version, exportedAt, sessions, messagesBySession, memory, todos}");
}

console.log("\n✓ 备份恢复格式校验验证通过");
