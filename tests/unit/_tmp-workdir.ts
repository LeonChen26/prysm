/**
 * 测试辅助：为依赖工作区的测试注入临时 baseDir。
 *
 * 必须通过 ESM import 顺序保证本模块在 lib/tools / lib/paths / lib/agent 等业务模块
 * 之前求值（这些模块加载时即从 workspace 表解析 AGENT_WORKDIR / 可访问根）。
 *
 * 目的：测试不依赖开发库 prysm.db 的工作区状态（例如项目根被添加为已授权工作区后，
 * "../xx" 越界会被判定为已授权而放行，导致 test-fileops / test-verify 的越界用例失败）。
 * 注入临时 baseDir 后，工作区仅含默认 agent-workdir，越界语义可复现。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configure } from "../../lib/config";

/** 本次测试的临时 baseDir（自动创建，含默认 agent-workdir 工作区） */
export const tmpBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "prysm-wd-"));

// 必须在任何读取工作区/路径的模块加载前注入，否则它们会读取开发库状态
configure({ baseDir: tmpBaseDir });
