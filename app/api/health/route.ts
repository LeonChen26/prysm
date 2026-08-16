import { NextResponse } from "next/server";

/**
 * 健康检查：Electron 主进程启动后轮询本端点确认 Web 后端就绪，再加载窗口。
 */
export function GET() {
  return NextResponse.json({ ok: true });
}
