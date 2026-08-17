import { listModelRoutes, setModelRoute } from "@/lib/model-router";
import {
  isOpenAICompatConfigured,
  openaiCompatModels,
  OPENAI_COMPAT_ID,
} from "@/lib/model-router";
import type { ModelRole } from "@/lib/config";
import { envValue } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 支持的 provider 与可选模型目录（与 model-router PROVIDER_FACTORIES 对齐） */
const PROVIDER_DEFS = [
  {
    id: "anthropic",
    name: "Anthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    models: [
      "claude-opus-4-5",
      "claude-sonnet-4-5",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    models: ["deepseek-v4-pro", "deepseek-v4-flash"],
  },
  {
    id: "openai",
    name: "OpenAI",
    apiKeyEnv: "OPENAI_API_KEY",
    models: [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-5",
      "gpt-5-mini",
      "gpt-5.2",
      "gpt-5.2-pro",
      "gpt-5.3-codex",
      "o3",
      "o3-mini",
      "o4-mini",
    ],
  },
  {
    id: "google",
    name: "Google",
    apiKeyEnv: "GOOGLE_API_KEY",
    models: [
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-3-pro-preview",
      "gemini-3.5-flash",
    ],
  },
  // OpenAI 兼容自定义端点（仅配置 OPENAI_COMPAT_BASE_URL/API_KEY 后展示）
  {
    id: OPENAI_COMPAT_ID,
    name: "OpenAI Compatible",
    apiKeyEnv: "OPENAI_COMPAT_API_KEY",
    models: openaiCompatModels(),
  },
] as const;

/** 仅当 OpenAI 兼容端点已配置时展示该 provider（避免设置页出现"未配置"噪音项） */
const PROVIDERS = PROVIDER_DEFS.filter(
  (p) => p.id !== OPENAI_COMPAT_ID || isOpenAICompatConfigured(),
);

const ROLES: { id: ModelRole; name: string; hint: string }[] = [
  { id: "orchestrator", name: "主 Agent（编排）", hint: "负责主任务规划与执行" },
  { id: "subagent", name: "子 Agent", hint: "子任务执行，建议用小模型" },
  { id: "summarize", name: "摘要", hint: "会话摘要等轻任务" },
  { id: "title", name: "标题", hint: "会话标题生成等轻任务" },
];

/** GET /api/model-routes —— 各角色路由 + 可用 provider/模型目录 + 鉴权状态 */
export async function GET() {
  try {
    const routes = listModelRoutes();
    const providers = PROVIDERS.map((p) => ({
      id: p.id,
      name: p.name,
      apiKeyEnv: p.apiKeyEnv,
      baseUrl: p.id === OPENAI_COMPAT_ID ? envValue("OPENAI_COMPAT_BASE_URL") : undefined,
      hasApiKey: Boolean(envValue(p.apiKeyEnv)),
      models: p.models.map((m) => ({ id: m, name: m })),
    }));
    return Response.json({ routes, providers, roles: ROLES });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** PUT /api/model-routes —— 更新某角色路由（body: { role, provider, model }） */
export async function PUT(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const role = String(body?.role ?? "") as ModelRole;
    const provider = String(body?.provider ?? "").trim();
    const model = String(body?.model ?? "").trim();
    if (!ROLES.some((r) => r.id === role)) {
      return Response.json(
        { error: `role 仅支持: ${ROLES.map((r) => r.id).join(", ")}` },
        { status: 400 },
      );
    }
    if (!provider) {
      return Response.json({ error: "provider 不能为空" }, { status: 400 });
    }
    if (!model) {
      return Response.json({ error: "model 不能为空" }, { status: 400 });
    }
    const route = setModelRoute(role, provider, model);
    return Response.json({ ok: true, role, route });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
