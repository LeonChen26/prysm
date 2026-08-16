import {
  createSkill,
  deleteSkill,
  disableSkill,
  enableSkill,
  listSkills,
  reloadSkills,
  skillRoot,
  type SkillSource,
} from "@/lib/skills";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 解析创建/删除目标来源（默认项目） */
function resolveScope(raw: unknown): SkillSource {
  return raw === "global" ? "global" : "project";
}

/** GET /api/skills —— 全部已登记技能（含 enabled 状态与 source，技能面板用） */
export async function GET() {
  try {
    return Response.json({ skills: listSkills() });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** POST /api/skills —— 启用/禁用/重载/新建/删除（body: { name, action, scope }） */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const action = String(body?.action ?? "");
    if (action === "reload") {
      const skills = reloadSkills();
      return Response.json({ ok: true, skills });
    }
    const name = String(body?.name ?? "").trim();
    if (!name) {
      return Response.json({ error: "name 不能为空" }, { status: 400 });
    }
    if (action === "create") {
      try {
        const skill = createSkill(
          {
            name,
            description: body?.description ? String(body.description) : undefined,
            tools: Array.isArray(body?.tools) ? body.tools.map(String) : undefined,
            body: body?.body ? String(body.body) : undefined,
          },
          skillRoot(resolveScope(body?.scope)),
        );
        return Response.json({ ok: true, skill });
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 400 },
        );
      }
    }
    if (action === "delete") {
      try {
        if (!deleteSkill(name, skillRoot(resolveScope(body?.scope)))) {
          return Response.json({ error: `技能 ${name} 不存在` }, { status: 404 });
        }
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 400 },
        );
      }
      return Response.json({ ok: true, name, deleted: true });
    }
    if (action === "enable") {
      if (!enableSkill(name)) {
        return Response.json({ error: `技能 ${name} 未登记` }, { status: 404 });
      }
      return Response.json({ ok: true, name, enabled: true });
    }
    if (action === "disable") {
      if (!disableSkill(name)) {
        return Response.json({ error: `技能 ${name} 未登记` }, { status: 404 });
      }
      return Response.json({ ok: true, name, enabled: false });
    }
    return Response.json(
      { error: "action 仅支持 enable / disable / reload / create / delete" },
      { status: 400 },
    );
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
