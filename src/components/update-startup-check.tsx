"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useMessages } from "./language";
import { useUpdateState } from "./update-state";
import { Button } from "./ui/button";

export function UpdateStartupCheck() {
  const it = useMessages();
  const path = usePathname();
  const { check, info, task } = useUpdateState();
  const [dismissedVersion, setDismissedVersion] = useState("");
  const version = info?.latestVersion || "";
  if (
    !version ||
    !info?.updateAvailable ||
    path.startsWith("/settings/system-update") ||
    [
      "starting",
      "queued",
      "running",
      "reconnecting",
      "verifying",
      "rolling-back",
    ].includes(task.phase) ||
    dismissedVersion === version
  )
    return null;

  return (
    <aside className="update-notification" role="status" aria-live="polite">
      <div className="update-notification-copy">
        <strong>{it.updateNoticeTitle.replace("{version}", version)}</strong>
        <span>
          {check.phase === "failed"
            ? it.updateCheckStale.replace("{version}", version)
            : it.updateNoticeBody}
        </span>
      </div>
      <Button asChild>
        <Link href="/settings/system-update">{it.viewUpdate}</Link>
      </Button>
      <Button
        type="button"
        variant="outline"
        className="update-notification-later"
        aria-label={it.close}
        onClick={() => setDismissedVersion(version)}
      >
        {it.later}
      </Button>
    </aside>
  );
}
