import {
  addPolicyRule,
  listPolicyRules,
  removePolicyRule,
  type PolicyKind,
} from "@/lib/policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_KINDS: PolicyKind[] = [
  "allow_tools",
  "allow_paths",
  "allow_commands",
  "deny_tools",
  "deny_paths",
  "deny_commands",
  "approval_timeout_ms",
];

/** GET /api/policy —— 全部策略规则（白/黑名单 + 审批超时，可视化用） */
export async function GET() {
  try {
    return Response.json({ rules: listPolicyRules() });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** POST /api/policy —— 新增规则（body: { kind, value }） */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const kind = String(body?.kind ?? "") as PolicyKind;
    const value = String(body?.value ?? "").trim();
    if (!VALID_KINDS.includes(kind)) {
      return Response.json(
        { error: `kind 仅支持: ${VALID_KINDS.join(", ")}` },
        { status: 400 },
      );
    }
    if (!value) {
      return Response.json({ error: "value 不能为空" }, { status: 400 });
    }
    const rule = addPolicyRule(kind, value);
    return Response.json({ rule }, { status: 201 });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** DELETE /api/policy?id=123 —— 删除规则 */
export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url);
    const id = Number(url.searchParams.get("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return Response.json({ error: "id 非法" }, { status: 400 });
    }
    const removed = removePolicyRule(id);
    if (!removed) {
      return Response.json({ error: "规则不存在" }, { status: 404 });
    }
    return Response.json({ ok: true, id });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
