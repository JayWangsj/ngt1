"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CalendarDays,
  ChevronRight,
  CircleAlert,
  Copy,
  DatabaseBackup,
  Download,
  Activity,
  FlaskConical,
  Languages,
  Smartphone,
  Sparkles,
  Trash2,
  Upload,
  Wrench,
} from "lucide-react";
import { clearDataAction, updateBusinessClockAction } from "@/app/actions";
import { LanguageSwitch, useMessages } from "./language";
import { Button } from "./ui/button";
import { DatePicker, SimpleSelect } from "./business-select";
import { Field } from "./forms";
import {
  FaultCatalogManager,
  type FaultCatalogItem,
} from "./fault-catalog-manager";
import {
  isAlwaysMotionEnabled,
  setAlwaysMotionEnabled,
} from "@/lib/motion-preference";
import {
  readOrderViewportFollow,
  writeOrderViewportFollow,
} from "@/lib/order-motion";
import {
  DeviceModelManager,
  QuickServiceManager,
  type QuickServiceView,
  type SavedModelView,
} from "./catalog-managers";
import settingsCardStyles from "./settings-card.module.css";
import settingsEntryStyles from "./settings-entry.module.css";
import businessDateStyles from "./business-date-settings.module.css";
import settingsActionStyles from "./settings-action.module.css";
import motionSettingControlStyles from "./motion-setting-control.module.css";
import motionSwitchStyles from "./ui/motion-switch.module.css";

const memorySampleSaveRetryCodes = new Set([
  "REPORT_SAVE_FAILED",
  "SAVE_UNCONFIRMED",
  "SAVE_UNAVAILABLE",
  "DOCUMENTS_NOT_WRITABLE",
  "DOCUMENTS_FOLDER_UNAVAILABLE",
  "REPORT_TEMP_CREATE_FAILED",
  "REPORT_WRITE_FAILED",
  "REPORT_PUBLISH_FAILED",
]);

type SaveFile = {
  createWritable: () => Promise<{
    write: (value: Blob) => Promise<void>;
    close: () => Promise<void>;
  }>;
};

async function saveBlob(
  blob: Blob,
  filename: string,
  description: string,
  mimeType: string,
  extension: string,
) {
  const picker = (
    window as typeof window & {
      showSaveFilePicker?: (options: {
        suggestedName: string;
        types: { description: string; accept: Record<string, string[]> }[];
      }) => Promise<SaveFile>;
    }
  ).showSaveFilePicker;
  if (picker) {
    const handle = await picker({
      suggestedName: filename,
      types: [{ description, accept: { [mimeType]: [extension] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function SettingsEntry({
  href,
  icon,
  title,
  description,
  className = "",
}: {
  href: string;
  icon: ReactNode;
  title: string;
  description: string;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`settings-entry ${settingsEntryStyles.entry} ${settingsEntryStyles.dashboardLink} dashboard-action-link ${className}`.trim()}
    >
      <span
        className={`settings-entry-icon ${settingsEntryStyles.icon}`}
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className={`settings-entry-copy ${settingsEntryStyles.copy}`}>
        <strong className={`settings-entry-label ${settingsEntryStyles.label}`}>
          <span>{title}</span>
        </strong>
        <small>{description}</small>
      </span>
      <ChevronRight size={20} aria-hidden="true" />
    </Link>
  );
}

export function SettingsOverview({
  testToolsEnabled,
}: {
  testToolsEnabled: boolean;
}) {
  const it = useMessages();
  return (
    <div className={settingsEntryStyles.overview}>
      <section className={settingsEntryStyles.group}>
        <h2>{it.settingsGroupInterface}</h2>
        <div className={settingsEntryStyles.rows}>
          <SettingsEntry
            href="/settings/language"
            icon={<Languages size={19} />}
            title={it.language}
            description={it.languageSettingsHelp}
          />
          <SettingsEntry
            href="/settings/interface-motion"
            icon={<Sparkles size={19} />}
            title={it.interfaceMotion}
            description={it.interfaceMotionHelp}
          />
        </div>
      </section>
      <section className={settingsEntryStyles.group}>
        <h2>{it.settingsGroupBusiness}</h2>
        <div className={settingsEntryStyles.rows}>
          <SettingsEntry
            href="/settings/business-date"
            icon={<CalendarDays size={19} />}
            title={it.businessDate}
            description={it.businessDateHelp}
          />
          <SettingsEntry
            href="/settings/quick-services"
            icon={<Wrench size={19} />}
            title={it.quickService.title}
            description={it.quickService.description}
          />
          <SettingsEntry
            href="/settings/device-models"
            icon={<Smartphone size={19} />}
            title={it.modelCatalog.title}
            description={it.modelCatalog.description}
          />
          <SettingsEntry
            href="/settings/fault-catalog"
            icon={<CircleAlert size={19} />}
            title={it.faultCatalog}
            description={it.faultCatalogDescription}
          />
        </div>
      </section>
      <section className={settingsEntryStyles.group}>
        <h2>{it.settingsGroupData}</h2>
        <div className={settingsEntryStyles.rows}>
          <SettingsEntry
            href="/settings/data"
            icon={<DatabaseBackup size={19} />}
            title={it.dataManagement}
            description={it.dataManagementHelp}
          />
        </div>
      </section>
      {testToolsEnabled && (
        <section className={settingsEntryStyles.group}>
          <h2>{it.settingsGroupTesting}</h2>
          <div className={settingsEntryStyles.rows}>
            <SettingsEntry
              href="/settings/test-tools"
              icon={<FlaskConical size={19} />}
              title={it.testTools}
              description={it.testToolsHelp}
            />
          </div>
        </section>
      )}
    </div>
  );
}

export function LanguageSettings() {
  const it = useMessages();
  return (
    <section
      className={`panel padded settings-card ${settingsCardStyles.card}`}
    >
      <div className={`settings-card-title ${settingsCardStyles.title}`}>
        <Languages size={19} aria-hidden="true" />
        <h2>{it.language}</h2>
      </div>
      <LanguageSwitch />
    </section>
  );
}

export function MotionSettings() {
  const it = useMessages();
  const [alwaysMotion, setAlwaysMotion] = useState(false);
  const [followOrderMotion, setFollowOrderMotion] = useState(true);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setAlwaysMotion(isAlwaysMotionEnabled());
      setFollowOrderMotion(readOrderViewportFollow());
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  function changeMotionPreference(enabled: boolean) {
    setAlwaysMotionEnabled(enabled);
    setAlwaysMotion(enabled);
  }

  function changeOrderMotionFollow(enabled: boolean) {
    writeOrderViewportFollow(enabled);
    setFollowOrderMotion(enabled);
  }

  return (
    <section
      className={`panel padded settings-card ${settingsCardStyles.card} motion-settings`}
    >
      <div className={`settings-card-title ${settingsCardStyles.title}`}>
        <Sparkles size={19} aria-hidden="true" />
        <h2>{it.interfaceMotion}</h2>
      </div>
      <div className={`settings-action ${settingsActionStyles.action}`}>
        <div>
          <strong>{it.alwaysPlayMotion}</strong>
          <p>{it.motionPreferenceHelp}</p>
        </div>
        <div
          className={`motion-setting-control ${motionSettingControlStyles.control}`}
        >
          <span>{alwaysMotion ? it.motionAlways : it.motionSystem}</span>
          <button
            type="button"
            className={`motion-switch ${motionSwitchStyles.switch}`}
            role="switch"
            aria-checked={alwaysMotion}
            aria-label={it.alwaysPlayMotion}
            onClick={() => changeMotionPreference(!alwaysMotion)}
          >
            <span aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className={`settings-action ${settingsActionStyles.action}`}>
        <div>
          <strong>{it.followRepairRowMotion}</strong>
          <p>{it.followRepairRowMotionHelp}</p>
        </div>
        <div
          className={`motion-setting-control ${motionSettingControlStyles.control}`}
        >
          <span>
            {followOrderMotion ? it.motionFollowOn : it.motionFollowOff}
          </span>
          <button
            type="button"
            className={`motion-switch ${motionSwitchStyles.switch}`}
            role="switch"
            aria-checked={followOrderMotion}
            aria-label={it.followRepairRowMotion}
            onClick={() => changeOrderMotionFollow(!followOrderMotion)}
          >
            <span aria-hidden="true" />
          </button>
        </div>
      </div>
    </section>
  );
}

export function BusinessDateSettings({
  clock,
  today,
}: {
  clock: { mode: "SYSTEM" | "MANUAL"; manualDate: string };
  today: string;
}) {
  const it = useMessages();
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [clockPending, setClockPending] = useState(false);
  const [dateMode, setDateMode] = useState(clock.mode);
  const [manualDate, setManualDate] = useState(clock.manualDate || today);
  const [savedClock, setSavedClock] = useState({
    mode: clock.mode,
    manualDate: clock.manualDate || today,
  });
  const clockChanged =
    dateMode !== savedClock.mode ||
    (dateMode === "MANUAL" && manualDate !== savedClock.manualDate);

  async function saveClock() {
    if (clockPending || !clockChanged) return;
    setClockPending(true);
    setMessage("");
    setError("");
    const result = await updateBusinessClockAction({
      mode: dateMode,
      manualDate,
    });
    if (!result.ok) {
      setClockPending(false);
      return setError(result.error);
    }
    setSavedClock({ mode: dateMode, manualDate });
    setMessage(it.businessDateSaved);
    router.refresh();
    setClockPending(false);
  }

  return (
    <section
      className={`panel padded settings-card ${settingsCardStyles.card} business-date-settings ${businessDateStyles.card}`}
    >
      <div className={`settings-card-title ${settingsCardStyles.title}`}>
        <CalendarDays size={19} aria-hidden="true" />
        <h2>{it.businessDate}</h2>
      </div>
      <p>{it.businessDateHelp}</p>
      <div className={`settings-date-form ${businessDateStyles.form}`}>
        <Field label={it.dateMode}>
          <SimpleSelect
            value={dateMode}
            onChange={(value) =>
              setDateMode(value === "MANUAL" ? "MANUAL" : "SYSTEM")
            }
            ariaLabel={it.dateMode}
            placeholder={it.systemDate}
            options={[
              { value: "SYSTEM", label: it.systemDate },
              { value: "MANUAL", label: it.manualDate },
            ]}
          />
        </Field>
        {dateMode === "MANUAL" && (
          <Field label={it.manualDate}>
            <DatePicker
              value={manualDate}
              onChange={(event) => setManualDate(event.target.value)}
            />
          </Field>
        )}
        <div className={`business-date-current ${businessDateStyles.current}`}>
          <span>{it.currentBusinessDate}</span>
          <strong>{today.split("-").reverse().join("/")}</strong>
        </div>
        <Button
          type="button"
          className={`settings-date-save ${businessDateStyles.save}`}
          disabled={
            clockPending ||
            !clockChanged ||
            (dateMode === "MANUAL" && !manualDate)
          }
          onClick={() => void saveClock()}
        >
          {it.save}
        </Button>
      </div>
      {message && (
        <p className="message success" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function QuickServiceSettings({ items }: { items: QuickServiceView[] }) {
  return (
    <section
      className={`panel padded settings-card ${settingsCardStyles.card}`}
    >
      <QuickServiceManager items={items} />
    </section>
  );
}

export function DeviceModelSettings({ items }: { items: SavedModelView[] }) {
  return (
    <section
      className={`panel padded settings-card ${settingsCardStyles.card}`}
    >
      <DeviceModelManager items={items} />
    </section>
  );
}

export function FaultCatalogSettings({ items }: { items: FaultCatalogItem[] }) {
  return (
    <section
      className={`panel padded settings-card ${settingsCardStyles.card}`}
    >
      <FaultCatalogManager items={items} embedded />
    </section>
  );
}

export function DataSettings() {
  const it = useMessages();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const sampleRequestId = useRef<string | null>(null);
  const sampleRequestAccepted = useRef(false);
  const reportPathInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [sampleStatus, setSampleStatus] = useState<{
    requestId: string;
    taskId?: string | null;
    phase: string;
    elapsedSeconds: number;
    recordedSamples: number;
    completeSamples: number;
    incompleteSamples: number;
    missedSamples: number;
    reportPath?: string | null;
    expectedReportPath?: string | null;
    reportAvailability?: "available" | "moved" | "unavailable";
    errorCode?: string | null;
  } | null>(null);
  const [sampleError, setSampleError] = useState("");
  const [sampleMessage, setSampleMessage] = useState("");
  const [sampleStarting, setSampleStarting] = useState(false);
  const [retryRequestId, setRetryRequestId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refreshMemorySample = useCallback(
    async (requestId?: string) => {
      const query = new URLSearchParams({ mode: "memory-sample" });
      if (requestId) query.set("requestId", requestId);
      const response = await fetch(`/api/diagnostics/export?${query}`, {
        cache: "no-store",
      });
      if (response.status === 404) {
        if (!requestId) setSampleStatus(null);
        else if (sampleRequestAccepted.current) {
          sampleRequestAccepted.current = false;
          setSampleStatus(null);
          setRetryRequestId(null);
          setSampleError(it.memorySampleExpired);
        }
        return false;
      }
      if (!response.ok) throw new Error("memory_sample_status_unavailable");
      const result = (await response.json()) as {
        status?: typeof sampleStatus;
      };
      if (!result.status) throw new Error("memory_sample_status_invalid");
      setSampleStatus(result.status);
      sampleRequestAccepted.current = true;
      setRetryRequestId(null);
      setSampleError("");
      sampleRequestId.current = requestId ?? result.status.requestId;
      return ["queued", "preparing", "warmup", "sampling", "saving"].includes(
        result.status.phase,
      );
    },
    [it.memorySampleExpired],
  );

  async function sendMemorySampleStart(requestId: string) {
    const response = await fetch("/api/diagnostics/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start-memory-sample", requestId }),
    });
    const result = (await response.json().catch(() => ({}))) as {
      errorCode?: string;
      status?: typeof sampleStatus;
    };
    if (!response.ok)
      throw new Error(result.errorCode ?? "memory_sample_start_failed");
    if (result.status) setSampleStatus(result.status);
    sampleRequestAccepted.current = true;
    setRetryRequestId(null);
    setSampleError("");
  }

  async function sendMemorySampleSaveRetry(requestId: string) {
    const response = await fetch("/api/diagnostics/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "retry-memory-sample-save", requestId }),
    });
    if (!response.ok) throw new Error("memory_sample_save_failed");
    const result = (await response.json()) as { status?: typeof sampleStatus };
    if (result.status) setSampleStatus(result.status);
    setRetryRequestId(null);
    setSampleError("");
  }

  async function startMemorySample() {
    const saveRetry =
      sampleStatus?.phase === "failed" &&
      memorySampleSaveRetryCodes.has(sampleStatus.errorCode ?? "");
    const requestId = saveRetry
      ? sampleStatus.requestId
      : (retryRequestId ?? crypto.randomUUID());
    sampleRequestId.current = requestId;
    sampleRequestAccepted.current = saveRetry || retryRequestId !== null;
    setSampleStarting(true);
    setSampleError("");
    setSampleMessage("");
    setSampleStatus((current) =>
      current?.requestId === requestId
        ? current
        : {
            requestId,
            phase: "preparing",
            elapsedSeconds: 0,
            recordedSamples: 0,
            completeSamples: 0,
            incompleteSamples: 0,
            missedSamples: 0,
          },
    );
    try {
      if (saveRetry) await sendMemorySampleSaveRetry(requestId);
      else await sendMemorySampleStart(requestId);
    } catch (cause) {
      const errorCode = cause instanceof Error ? cause.message : "";
      const documentsUnavailable =
        errorCode === "DOCUMENTS_NOT_WRITABLE" ||
        errorCode === "DOCUMENTS_FOLDER_UNAVAILABLE";
      const requestExpired = errorCode === "REQUEST_EXPIRED";
      setRetryRequestId(requestExpired ? null : requestId);
      if (requestExpired) {
        sampleRequestId.current = null;
        sampleRequestAccepted.current = false;
      }
      setSampleError(
        requestExpired
          ? it.memorySampleExpired
          : documentsUnavailable
            ? it.memorySampleDirectoryUnavailable
            : it.memorySampleStartFailed,
      );
      void refreshMemorySample(requestId)
        .then((active) => {
          if (!active && !sampleRequestAccepted.current)
            setSampleStatus((current) =>
              current?.requestId === requestId ? null : current,
            );
        })
        .catch(() => {
          if (!documentsUnavailable) setSampleError(it.memorySampleUnavailable);
        });
    } finally {
      setSampleStarting(false);
    }
  }

  async function copyMemorySamplePath() {
    const path = sampleStatus?.reportPath ?? sampleStatus?.expectedReportPath;
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      setSampleMessage(it.pathCopied);
    } catch {
      reportPathInput.current?.focus();
      reportPathInput.current?.select();
      setSampleMessage(it.copyPathFailed);
    }
  }

  const sampleActive =
    !!sampleStatus &&
    ["queued", "preparing", "warmup", "sampling", "saving"].includes(
      sampleStatus.phase,
    );
  const expectedReportPathVisible =
    sampleStatus?.phase === "failed" &&
    memorySampleSaveRetryCodes.has(sampleStatus.errorCode ?? "");
  const displayReportPath =
    sampleStatus?.reportPath ??
    (expectedReportPathVisible ? sampleStatus?.expectedReportPath : null);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      if (sampleRequestId.current && !sampleRequestAccepted.current) return;
      try {
        const active = await refreshMemorySample(
          sampleRequestId.current ?? undefined,
        );
        if (
          !disposed &&
          document.visibilityState === "visible" &&
          (active || sampleActive)
        )
          timer = setTimeout(poll, 2000);
      } catch {
        setSampleError(it.memorySampleUnavailable);
        if (!disposed && sampleActive) timer = setTimeout(poll, 2000);
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void poll();
      else if (timer) clearTimeout(timer);
    };
    void poll();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [
    it.memorySampleUnavailable,
    refreshMemorySample,
    sampleActive,
    sampleStatus?.phase,
    sampleStatus?.requestId,
  ]);

  async function exportFile() {
    setPending(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch("/api/data/export");
      if (!response.ok) throw new Error(it.connectionError);
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const filename =
        disposition.match(/filename="([^"]+)"/)?.[1] ?? "ngt-backup.json";
      await saveBlob(
        blob,
        filename,
        "Backup JSON",
        "application/json",
        ".json",
      );
      setMessage(it.exportData);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : it.connectionError);
    } finally {
      setPending(false);
    }
  }

  async function exportDiagnostics() {
    setPending(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch("/api/diagnostics/export");
      if (!response.ok) {
        const result = (await response.json().catch(() => ({}))) as {
          error?: string;
          diagnosticId?: string;
        };
        throw new Error(
          `${it.diagnosticsExportFailed}${result.diagnosticId ? ` ${it.diagnosticIdLabel}: ${result.diagnosticId}` : ""}`,
        );
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const filename =
        disposition.match(/filename="([^"]+)"/)?.[1] ??
        "NGTManager-diagnostics.txt";
      await saveBlob(
        blob,
        filename,
        "NGTManager diagnostics",
        "text/plain",
        ".txt",
      );
      setMessage(it.diagnosticsExported);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(
        cause instanceof Error ? cause.message : it.diagnosticsExportFailed,
      );
    } finally {
      setPending(false);
    }
  }

  async function reportClientFailure(
    diagnosticId: string,
    eventCode: "IMPORT_FILE_READ_FAILED" | "IMPORT_REQUEST_FAILED",
  ) {
    try {
      const response = await fetch("/api/diagnostics/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ diagnosticId, eventCode }),
      });
      if (!response.ok) return false;
      const result: unknown = await response.json();
      return (
        !!result &&
        typeof result === "object" &&
        "accepted" in result &&
        result.accepted === true
      );
    } catch {
      // The originating failure remains visible even if its report cannot be sent.
      return false;
    }
  }

  async function importFile(file: File) {
    setPending(true);
    setMessage("");
    setError("");
    try {
      let backupJson: string;
      try {
        backupJson = await file.text();
      } catch {
        const diagnosticId = crypto.randomUUID();
        const recorded = await reportClientFailure(
          diagnosticId,
          "IMPORT_FILE_READ_FAILED",
        );
        throw new Error(
          recorded
            ? `${it.backupReadFailed} ${it.diagnosticIdLabel}: ${diagnosticId}`
            : `${it.backupReadFailed} ${it.diagnosticNotRecorded}`,
        );
      }
      const requestDiagnosticId = crypto.randomUUID();
      let response: Response;
      try {
        response = await fetch("/api/data/import", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-NGT-Diagnostic-Id": requestDiagnosticId,
          },
          body: backupJson,
        });
      } catch {
        const recorded = await reportClientFailure(
          requestDiagnosticId,
          "IMPORT_REQUEST_FAILED",
        );
        throw new Error(
          recorded
            ? `${it.importRequestFailed} ${it.diagnosticIdLabel}: ${requestDiagnosticId}`
            : `${it.importRequestFailed} ${it.diagnosticNotRecorded}`,
        );
      }
      let result: {
        imported?: number;
        skipped?: number;
        error?: string;
        diagnosticId?: string;
      };
      try {
        const payload: unknown = await response.json();
        if (!payload || typeof payload !== "object" || Array.isArray(payload))
          throw new Error("invalid_response");
        result = payload as typeof result;
      } catch {
        const recorded = await reportClientFailure(
          requestDiagnosticId,
          "IMPORT_REQUEST_FAILED",
        );
        throw new Error(
          recorded
            ? `${it.importRequestFailed} ${it.diagnosticIdLabel}: ${requestDiagnosticId}`
            : `${it.importRequestFailed} ${it.diagnosticNotRecorded}`,
        );
      }
      if (!response.ok)
        throw new Error(
          `${result.error || it.connectionError}${result.diagnosticId ? ` (${it.diagnosticIdLabel}: ${result.diagnosticId})` : ""}`,
        );
      setMessage(
        `${it.importSuccess} ${String(result.imported ?? 0)} / ${String(result.skipped ?? 0)}`,
      );
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : it.connectionError);
    } finally {
      setPending(false);
      if (input.current) input.current.value = "";
    }
  }

  async function clearAll() {
    if (!window.confirm(it.clearDataConfirm)) return;
    setPending(true);
    setMessage("");
    setError("");
    try {
      const result = await clearDataAction();
      if (!result.ok) throw new Error(result.error);
      setMessage(it.clearDataSuccess);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : it.connectionError);
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      className={`panel padded settings-card ${settingsCardStyles.card}`}
    >
      <h2>{it.dataManagement}</h2>
      <div className={`settings-action ${settingsActionStyles.action}`}>
        <div>
          <strong>{it.exportData}</strong>
          <p>{it.exportHelp}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => void exportFile()}
        >
          <Download size={17} />
          {it.exportData}
        </Button>
      </div>
      <div className={`settings-action ${settingsActionStyles.action}`}>
        <div>
          <strong>{it.importData}</strong>
          <p>{it.importHelp}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => input.current?.click()}
        >
          <Upload size={17} />
          {it.chooseBackup}
        </Button>
        <input
          ref={input}
          className="sr-only"
          type="file"
          accept="application/json,.json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importFile(file);
          }}
        />
      </div>
      <div className={`settings-action ${settingsActionStyles.action}`}>
        <div>
          <strong>{it.exportDiagnostics}</strong>
          <p>{it.exportDiagnosticsHelp}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => void exportDiagnostics()}
        >
          <Download size={17} />
          {it.exportDiagnostics}
        </Button>
      </div>
      <div className={`settings-action ${settingsActionStyles.action}`}>
        <div>
          <strong>{it.sampleMemory}</strong>
          <p>{it.sampleMemoryHelp}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={sampleStarting || sampleActive}
          onClick={() => void startMemorySample()}
        >
          <Activity size={17} />
          {sampleStatus?.phase === "failed" &&
          memorySampleSaveRetryCodes.has(sampleStatus.errorCode ?? "")
            ? it.memorySampleRetrySave
            : retryRequestId
              ? it.memorySampleRetry
              : it.sampleMemory}
        </Button>
      </div>
      {sampleStatus && (
        <div
          className={settingsActionStyles.memorySampleResult}
          role="status"
          aria-live="polite"
        >
          <p>
            {sampleStatus.phase === "queued"
              ? it.memorySampleQueued
              : sampleStatus.phase === "preparing"
                ? it.memorySamplePreparing
                : sampleStatus.phase === "warmup"
                  ? `${it.memorySampleWarmup} ${Math.max(0, 120 - sampleStatus.elapsedSeconds)}s`
                  : sampleStatus.phase === "sampling"
                    ? `${it.memorySampleProgress} · ${sampleStatus.recordedSamples}/300`
                    : sampleStatus.phase === "saving"
                      ? it.memorySampleSaving
                      : sampleStatus.phase === "complete"
                        ? sampleStatus.completeSamples >= 270 &&
                          sampleStatus.incompleteSamples +
                            sampleStatus.missedSamples ===
                            0
                          ? it.memorySampleComplete
                          : it.memorySamplePartial
                        : sampleStatus.errorCode === "REQUEST_EXPIRED"
                          ? it.memorySampleExpired
                          : sampleStatus.errorCode === "NO_COMPLETE_SAMPLES"
                            ? it.memorySampleNoCompletePoints
                            : sampleStatus.errorCode ===
                                  "DOCUMENTS_NOT_WRITABLE" ||
                                sampleStatus.errorCode ===
                                  "DOCUMENTS_FOLDER_UNAVAILABLE"
                              ? it.memorySampleDirectoryUnavailable
                              : memorySampleSaveRetryCodes.has(
                                    sampleStatus.errorCode ?? "",
                                  )
                                ? it.memorySampleSaveFailed
                                : it.memorySampleFailed}
          </p>
          {sampleStatus.phase === "sampling" && (
            <p>
              {it.memorySampleCounts}: {sampleStatus.completeSamples} /{" "}
              {sampleStatus.incompleteSamples} / {sampleStatus.missedSamples}
            </p>
          )}
          {displayReportPath && (
            <div className={settingsActionStyles.memorySamplePath}>
              <label htmlFor="memory-sample-report-path">
                {sampleStatus.reportPath
                  ? it.memorySamplePath
                  : it.memorySampleExpectedPath}
              </label>
              <div>
                <input
                  ref={reportPathInput}
                  id="memory-sample-report-path"
                  type="text"
                  readOnly
                  value={displayReportPath}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void copyMemorySamplePath()}
                >
                  <Copy size={16} />
                  {it.copyPath}
                </Button>
              </div>
            </div>
          )}
          {sampleStatus.reportAvailability === "moved" && (
            <p>{it.memorySampleMoved}</p>
          )}
          {sampleStatus.reportAvailability === "unavailable" && (
            <p>{it.memorySampleDirectoryUnavailable}</p>
          )}
          {retryRequestId && <p>{it.memorySampleRetryHint}</p>}
          {sampleMessage && <p>{sampleMessage}</p>}
          {sampleError && (
            <p className="message error" role="alert">
              {sampleError}
            </p>
          )}
        </div>
      )}
      <div
        className={`settings-action danger-zone ${settingsActionStyles.action}`}
      >
        <div>
          <strong>{it.clearData}</strong>
          <p>{it.clearDataHelp}</p>
        </div>
        <Button
          type="button"
          variant="danger"
          disabled={pending}
          onClick={() => void clearAll()}
        >
          <Trash2 size={17} />
          {it.clearData}
        </Button>
      </div>
      {message && (
        <p className="message success" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
