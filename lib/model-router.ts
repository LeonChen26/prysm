/**
 * 多模型路由（Phase 5）
 * 强模型编排、小模型执行/摘要/标题。按 role 选取 provider/model：
 * - orchestrator：主 agent（默认 useDefault）
 * - subagent：子 agent（默认小模型，不可用则回退主模型）
 * - summarize / title：轻任务（默认跟随主模型）
 *
 * 路由优先级：PrysmConfig.modelRoutes 注入 > model_route 表（prysm.db）> 默认。
 * 模型实例缓存：按 provider 缓存 createModels 实例（取代 agent.ts 模块级单例）。
 * 降级：路由目标不可用（无 auth / 模型不存在）→ 回退主模型并记录告警。
 *
 * 本模块只依赖 config / prysm-db / pi-ai，不依赖 Next.js / pi-agent-core。
 */
import type { MutableModels, Models, Provider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import { DatabaseSync } from "node:sqlite";
import {
  basePath,
  getConfig,
  getDefaultModel,
  getDefaultProvider,
  type ModelRole,
  type ModelRoute,
} from "./config";
import { getPrysmDb } from "./prysm-db";

/** 支持的 provider 工厂（动态 import 避免首屏加载全部 SDK） */
const PROVIDER_FACTORIES = {
  anthropic: () => import("@earendil-works/pi-ai/providers/anthropic"),
  deepseek: () => import("@earendil-works/pi-ai/providers/deepseek"),
  openai: () => import("@earendil-works/pi-ai/providers/openai"),
  google: () => import("@earendil-works/pi-ai/providers/google"),
} as const;

type ProviderId = keyof typeof PROVIDER_FACTORIES;

/** 各角色默认路由（subagent 用小模型 deepseek，其余跟随主模型） */
function defaultRoute(role: ModelRole): ModelRoute {
  if (role === "subagent") return { provider: "deepseek", model: "deepseek-chat" };
  return { provider: getDefaultProvider(), model: getDefaultModel() };
}

/** 主模型路由（always 主模型，供降级兜底） */
function mainRoute(): ModelRoute {
  return { provider: getDefaultProvider(), model: getDefaultModel() };
}

// ------------------------------------------------------------ model_route 表

let db: DatabaseSync | undefined;

function getDb(): DatabaseSync {
  const d = getPrysmDb();
  if (!db) {
    // 自愈：缺省时把默认路由写入表（幂等，ON CONFLICT 忽略）
    const ins = d.prepare(
      "INSERT OR IGNORE INTO model_route (role, provider, model, created_at) VALUES (?, ?, ?, ?)",
    );
    const now = Date.now();
    for (const role of ["orchestrator", "subagent", "summarize", "title"]) {
      const r = defaultRoute(role as ModelRole);
      ins.run(role, r.provider, r.model, now);
    }
    db = d;
  }
  return d;
}

/** 仅用于测试：丢弃表连接缓存（连接本身由 prysm-db 管理） */
export function resetModelRouterDb(): void {
  db = undefined;
}

/** 从 model_route 表读某角色路由（未命中返回 undefined） */
function routeFromDb(role: ModelRole): ModelRoute | undefined {
  const row = getDb()
    .prepare("SELECT provider, model FROM model_route WHERE role = ?")
    .get(role) as { provider: string; model: string } | undefined;
  return row ? { provider: row.provider, model: row.model } : undefined;
}

/** 写入（或更新）某角色路由到表 */
export function setModelRoute(role: ModelRole, provider: string, model: string): ModelRoute {
  const r = { provider, model };
  getDb()
    .prepare(
      "INSERT INTO model_route (role, provider, model, created_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(role) DO UPDATE SET provider = excluded.provider, model = excluded.model",
    )
    .run(role, provider, model, Date.now());
  return r;
}

/** 全部角色路由（注入 > 表 > 默认） */
export function listModelRoutes(): Record<ModelRole, ModelRoute> {
  const out = {} as Record<ModelRole, ModelRoute>;
  for (const role of ["orchestrator", "subagent", "summarize", "title"] as ModelRole[]) {
    out[role] = getModelRoute(role);
  }
  return out;
}

/** 解析某角色路由（注入 > 表 > 默认） */
export function getModelRoute(role: ModelRole): ModelRoute {
  const injected = getConfig().modelRoutes?.[role];
  if (injected?.provider && injected?.model) return injected;
  const fromDb = routeFromDb(role);
  if (fromDb) return fromDb;
  return defaultRoute(role);
}

// ------------------------------------------------------------ 模型实例缓存

const modelsCache = new Map<string, MutableModels>();

/** 按 provider 加载并缓存 createModels 实例（多 provider 并存） */
export async function getModels(
  providerId: string,
): Promise<MutableModels> {
  const cached = modelsCache.get(providerId);
  if (cached) return cached;
  const factory = PROVIDER_FACTORIES[providerId as ProviderId];
  if (!factory) {
    throw new Error(
      `不支持的模型提供商: "${providerId}"。可用: ${Object.keys(PROVIDER_FACTORIES).join(", ")}`,
    );
  }
  const mod = (await factory()) as unknown as Record<string, () => unknown>;
  const provider = mod[`${providerId}Provider`]() as Provider;
  const m = createModels();
  m.setProvider(provider);
  modelsCache.set(providerId, m);
  return m;
}

/** 仅用于测试/dev：清空模型实例缓存 */
export function resetModelRouter(): void {
  modelsCache.clear();
}

// ------------------------------------------------------------ 路由解析（含降级）

export interface ResolvedModel {
  models: Models;
  /** 命中模型（types 收窄用 Model<Api>） */
  model: NonNullable<ReturnType<Models["getModel"]>>;
  provider: string;
  modelId: string;
  /** 是否回退主模型（路由目标不可用） */
  fallback: boolean;
  /** 回退原因（fallback=true 时） */
  reason?: string;
}

/**
 * 按 role 解析最终使用的模型实例。
 * 路由目标不可用（无 API Key / 模型不存在）→ 回退主模型并记录告警。
 */
export async function resolveModel(role: ModelRole): Promise<ResolvedModel> {
  const route = getModelRoute(role);
  try {
    const models = await getModels(route.provider);
    const model = models.getModel(route.provider, route.model);
    if (!model) throw new Error(`模型 "${route.model}" 不存在`);
    const auth = await models.checkAuth(route.provider);
    if (!auth) throw new Error("未配置 API Key");
    return {
      models,
      model,
      provider: route.provider,
      modelId: route.model,
      fallback: false,
    };
  } catch (err) {
    const main = mainRoute();
    const models = await getModels(main.provider);
    const model = models.getModel(main.provider, main.model);
    if (!model) {
      throw new Error(
        `${role} 路由 "${route.provider}:${route.model}" 与主模型均不可用: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    console.error(
      `[model-router] ${role} 路由 "${route.provider}:${route.model}" 不可用，回退主模型 "${main.provider}:${main.model}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      models,
      model,
      provider: main.provider,
      modelId: main.model,
      fallback: true,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 供日志/审计使用：basePath 下 prysm.db 位置（无副作用） */
export function modelDbPath(): string {
  return basePath("prysm.db");
}