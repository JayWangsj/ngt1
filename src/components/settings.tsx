"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CalendarDays,
  ChevronRight,
  CircleAlert,
  DatabaseBackup,
  Download,
  FlaskConical,
  Languages,
  RefreshCw,
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
import { useUpdateState } from "./update-state";
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
      className={`panel padded settings-card ${settingsCardStyles.card} settings-entry ${settingsEntryStyles.entry} ${settingsEntryStyles.dashboardLink} dashboard-action-link ${className}`.trim()}
    >
      <span
        className={`settings-entry-icon ${settingsEntryStyles.icon}`}
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className={`settings-entry-copy ${settingsEntryStyles.copy}`}>
        <strong className="dashboard-link-label">{title}</strong>
        <small>{description}</small>
      </span>
      <ChevronRight size={20} aria-hidden="true" />
    </Link>
  );
}

export function SettingsOverview({
  currentVersion,
  testToolsEnabled,
}: {
  currentVersion: string;
  testToolsEnabled: boolean;
}) {
  const it = useMessages();
  const update = useUpdateState();
  const updateDescription = update.info?.updateAvailable
    ? update.check.phase === "failed"
      ? it.updateCheckStale.replace(
          "{version}",
          update.info.latestVersion || "",
        )
      : it.updateAvailable.replace("{version}", update.info.latestVersion || "")
    : update.check.phase === "not-installable"
      ? it.updateNotInstallable
      : update.task.phase === "running" || update.task.phase === "rolling-back"
        ? it.updateInstalling
        : ["failed", "rollback-failed", "interrupted"].includes(
              update.task.phase,
            )
          ? it.updateFailed
          : `${it.currentVersion}: ${update.currentVersion || currentVersion}`;
  return (
    <div className="settings-grid settings-overview">
      <SettingsEntry
        href="/settings/language"
        icon={<Languages size={20} />}
        title={it.language}
        description={it.languageSettingsHelp}
      />
      <SettingsEntry
        href="/settings/interface-motion"
        icon={<Sparkles size={20} />}
        title={it.interfaceMotion}
        description={it.interfaceMotionHelp}
      />
      {testToolsEnabled && (
        <SettingsEntry
          href="/settings/test-tools"
          icon={<FlaskConical size={20} />}
          title={it.testTools}
          description={it.testToolsHelp}
        />
      )}
      <SettingsEntry
        href="/settings/business-date"
        icon={<CalendarDays size={20} />}
        title={it.businessDate}
        description={it.businessDateHelp}
      />
      <SettingsEntry
        href="/settings/system-update"
        icon={<RefreshCw size={20} />}
        title={it.systemUpdate}
        description={updateDescription}
        className="system-update-entry"
      />
      <SettingsEntry
        href="/settings/quick-services"
        icon={<Wrench size={20} />}
        title={it.quickService.title}
        description={it.quickService.description}
      />
      <SettingsEntry
        href="/settings/device-models"
        icon={<Smartphone size={20} />}
        title={it.modelCatalog.title}
        description={it.modelCatalog.description}
      />
      <SettingsEntry
        href="/settings/fault-catalog"
        icon={<CircleAlert size={20} />}
        title={it.faultCatalog}
        description={it.faultCatalogDescription}
      />
      <SettingsEntry
        href="/settings/data"
        icon={<DatabaseBackup size={20} />}
        title={it.dataManagement}
        description={it.dataManagementHelp}
      />
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
        <div className="motion-setting-control">
          <span>{alwaysMotion ? it.motionAlways : it.motionSystem}</span>
          <button
            type="button"
            className="motion-switch"
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
        <div className="motion-setting-control">
          <span>
            {followOrderMotion ? it.motionFollowOn : it.motionFollowOff}
          </span>
          <button
            type="button"
            className="motion-switch"
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
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

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
      const picker = (
        window as typeof window & {
          showSaveFilePicker?: (options: {
            suggestedName: string;
            types: { description: string; accept: Record<string, string[]> }[];
          }) => Promise<{
            createWritable: () => Promise<{
              write: (value: Blob) => Promise<void>;
              close: () => Promise<void>;
            }>;
          }>;
        }
      ).showSaveFilePicker;
      if (picker) {
        const handle = await picker({
          suggestedName: filename,
          types: [
            {
              description: "Backup JSON",
              accept: { "application/json": [".json"] },
            },
          ],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
      } else {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
      }
      setMessage(it.exportData);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : it.connectionError);
    } finally {
      setPending(false);
    }
  }

  async function importFile(file: File) {
    setPending(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch("/api/data/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: await file.text(),
      });
      const result = (await response.json()) as {
        imported?: number;
        skipped?: number;
        error?: string;
      };
      if (!response.ok) throw new Error(result.error || it.connectionError);
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
