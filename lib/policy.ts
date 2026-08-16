/**
 * 审批资源授权（policy）—— 文件后端
 *
 * 数据源：permission/global.json（lib/permission.ts 为单一事实来源），
 * 不兼容历史数据库（prysm.db policy 表）与 env APPROVAL_* 回退。
 *
 * 映射关系（与 Trae resourceAuthorization 对齐）：
 * - 工具白/黑名单 → resourceAuthorization.tools.{allow,deny}（支持 mcp__* / skill__* 通配）
 * - 路径白/黑名单 → resourceAuthorization.filesystem.{readWrite,readOnly}
 * - 命令规则（allow/ask/deny）→ commandRules，由决策链 ruleHit 处理（不在此模块）
 *
 * 优先级：deny（黑名单） > allow（白名单）。
 */

import { getResourceAuthorization } from "./permission";

interface PathRule {
  prefix: string;
  regex?: RegExp;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 解析路径规则：以 / 结尾 → 目录前缀；含 * → 文件名通配；其他 → 路径前缀 */
function parsePathRules(items: string[]): PathRule[] {
  const rules: PathRule[] = [];
  for (const item of items) {
    const rule = item.replace(/^\.?\//, "").trim();
    if (!rule) continue;
    if (rule.includes("*")) {
      // 通配规则只匹配文件名（最后一段）
      const re = new RegExp("^" + rule.split("*").map(escapeRegex).join(".*") + "$");
      rules.push({ prefix: rule, regex: re });
    } else {
      // 目录/路径前缀：去掉结尾斜杠，按路径段匹配，避免 sub/dir 误匹配 sub/dirx
      rules.push({ prefix: rule.replace(/\/+$/, "") });
    }
  }
  return rules;
}

/** 从工具参数中提取相对路径（write_file/delete_file 用 path，move/copy 用目标 to） */
function extractRelPath(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  if (typeof a.path === "string") return a.path;
  if (typeof a.to === "string") return a.to;
  return null;
}

function normPath(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/^\.\//, "");
}

function matchesPath(pathRules: PathRule[], rel: string): boolean {
  const norm = normPath(rel);
  for (const rule of pathRules) {
    if (rule.regex) {
      const fileName = norm.split("/").pop() ?? norm;
      if (rule.regex.test(fileName)) return true;
    } else if (
      norm === rule.prefix ||
      norm.startsWith(rule.prefix + "/") ||
      // 隐藏文件前缀宽松匹配：.env 规则同时命中 .env.local（安全方向宁可多拦）
      (rule.prefix.startsWith(".") && norm.startsWith(rule.prefix + "."))
    ) {
      return true;
    }
  }
  return false;
}

/** 工具名匹配：支持精确名与通配（mcp__* / skill__* 等批量管控） */
function matchesToolName(rules: string[], name: string): boolean {
  for (const rule of rules) {
    if (rule === name) return true;
    if (rule.includes("*")) {
      const re = new RegExp("^" + rule.split("*").map(escapeRegex).join(".*") + "$");
      if (re.test(name)) return true;
    }
  }
  return false;
}

export interface DenyResult {
  denied: boolean;
  reason?: string;
}

/**
 * 判断某次敏感工具调用是否被资源授权强制拦截（黑名单）。
 * 命中返回 true（不进入审批，直接拒绝）。
 */
export function isDenied(toolName: string, args: unknown): DenyResult {
  const ra = getResourceAuthorization();
  if (matchesToolName(ra.tools.deny, toolName)) {
    return { denied: true, reason: `工具 ${toolName} 被策略禁止` };
  }
  const rel = extractRelPath(args);
  if (rel && matchesPath(parsePathRules(ra.filesystem.readOnly), rel)) {
    return { denied: true, reason: `路径 "${rel}" 被策略禁止` };
  }
  return { denied: false };
}

/**
 * 判断某次敏感工具调用是否应自动放行（白名单）。
 * 优先工具白名单（支持通配），其次路径规则；未命中返回 false（走人工/Guardian 审批）。
 */
export function isAutoApproved(toolName: string, args: unknown): boolean {
  const ra = getResourceAuthorization();
  if (matchesToolName(ra.tools.allow, toolName)) return true;
  const rel = extractRelPath(args);
  if (rel && matchesPath(parsePathRules(ra.filesystem.readWrite), rel)) return true;
  return false;
}
