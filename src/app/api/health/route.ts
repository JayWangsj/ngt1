import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { emitApplicationDiagnostic } from "@/lib/app-diagnostics";
import { getStudioRuntimeInfo } from "@/lib/studio-update";
import { isLoopbackRequest } from "@/lib/request-source";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  if (!isLoopbackRequest(request))
    return Response.json({ status: "unavailable" }, { status: 403 });
  let phase: "database-check" | "work-order-read" | "runtime-info" =
    "database-check";
  try {
    await db.$queryRaw`SELECT 1`;
    phase = "work-order-read";
    await db.$queryRaw`SELECT "id" FROM "WorkOrder" LIMIT 1`;
    phase = "runtime-info";
    return Response.json({ status: "ok", ...(await getStudioRuntimeInfo()) });
  } catch {
    emitApplicationDiagnostic({
      diagnosticId: randomUUID(),
      component: "application",
      severity: "error",
      eventCode: "application.health_check.failed",
      phase,
      errorCode: "HEALTH_CHECK_FAILED",
    });
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}
