import {
  disableSkill,
  enableSkill,
  listSkills,
  reloadSkills,
} from "@/lib/skills";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/skills —— 全部已登记技能（含 enabled 状态，技能面板用） */
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

/** POST /api/skills —— 启用/禁用/重载（body: { name, action: "enable"|"disable"|"reload" }） */
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
      { error: "action 仅支持 enable / disable / reload" },
      { status: 400 },
    );
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
