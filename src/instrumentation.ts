import type { Instrumentation } from "next";
import { emitApplicationDiagnostic } from "@/lib/app-diagnostics";

export const onRequestError: Instrumentation.onRequestError = async (
  _error,
  _request,
  context,
) => {
  const phase = context.routeType;
  if (
    phase !== "render" &&
    phase !== "route" &&
    phase !== "action" &&
    phase !== "proxy"
  )
    return;
  emitApplicationDiagnostic({
    diagnosticId: globalThis.crypto.randomUUID(),
    component: "application",
    severity: "error",
    eventCode: "application.request.unhandled",
    phase,
    errorCode: "NEXT_UNHANDLED_REQUEST_ERROR",
  });
};
