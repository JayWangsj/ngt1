"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  LayoutDashboard,
  Wrench,
  Package,
  ShoppingBag,
  Users,
  Tags,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronRight,
  RefreshCw,
  CircleAlert,
  LoaderCircle,
} from "lucide-react";
import { X } from "lucide-react";
import { useMessages } from "./language";
import { BrandLogo } from "./brand-logo";
import { useUpdateState } from "./update-state";
import { SystemUpdate } from "./system-update";
import updatePopoverStyles from "./system-update-popover.module.css";
import {
  applySidebarPreference,
  clampSidebarWidth,
  readSidebarPreference,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  writeSidebarPreference,
} from "@/lib/sidebar-preference";

export function Sidebar() {
  const it = useMessages();
  const path = usePathname();
  const { currentVersion, check, info, task } = useUpdateState();
  const [width, setWidth] = useState(240);
  const [collapsed, setCollapsed] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [updateExpanded, setUpdateExpanded] = useState(false);
  const [updatePosition, setUpdatePosition] = useState({ left: 260, top: 12 });
  const updateEntry = useRef<HTMLButtonElement>(null);
  const updatePanel = useRef<HTMLElement>(null);
  const updateClose = useRef<HTMLButtonElement>(null);
  const links = [
    { href: "/", label: it.nav.dashboard, icon: LayoutDashboard },
    { href: "/orders", label: it.nav.orders, icon: Wrench },
    { href: "/retail", label: it.nav.retail, icon: ShoppingBag },
    { href: "/inventory", label: it.nav.inventory, icon: Package },
    { href: "/customers", label: it.nav.customers, icon: Users },
    { href: "/prices", label: it.nav.prices, icon: Tags },
  ];

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const preference = readSidebarPreference();
      setWidth(preference.width);
      setCollapsed(preference.collapsed);
      applySidebarPreference(preference.width, preference.collapsed);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const closeUpdatePanel = useCallback(() => {
    setUpdateOpen(false);
    setUpdateExpanded(false);
    window.requestAnimationFrame(() => updateEntry.current?.focus());
  }, []);

  const positionUpdatePanel = useCallback(() => {
    const button = updateEntry.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    if (window.matchMedia("(max-width: 900px)").matches) {
      setUpdatePosition({
        left: 12,
        top: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 300)),
      });
      return;
    }
    setUpdatePosition({
      left: Math.max(12, Math.min(rect.right + 12, window.innerWidth - 372)),
      top: Math.max(12, Math.min(rect.bottom - 250, window.innerHeight - 292)),
    });
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const url = new URL(window.location.href);
      if (url.searchParams.get("open-update") !== "1") return;
      setUpdateExpanded(true);
      setUpdateOpen(true);
      url.searchParams.delete("open-update");
      window.history.replaceState(
        window.history.state,
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!updateOpen) return;
    positionUpdatePanel();
    const frame = window.requestAnimationFrame(() =>
      updateClose.current?.focus(),
    );
    window.addEventListener("resize", positionUpdatePanel);
    window.addEventListener("scroll", positionUpdatePanel, true);
    const onPointerDown = (event: PointerEvent) => {
      if (updateExpanded) return;
      const target = event.target;
      if (
        target instanceof Node &&
        !updatePanel.current?.contains(target) &&
        !updateEntry.current?.contains(target)
      )
        closeUpdatePanel();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeUpdatePanel();
        return;
      }
      if (!updateExpanded || event.key !== "Tab") return;
      const focusable = updatePanel.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    const previousOverflow = document.body.style.overflow;
    if (updateExpanded) document.body.style.overflow = "hidden";
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", positionUpdatePanel);
      window.removeEventListener("scroll", positionUpdatePanel, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = previousOverflow;
    };
  }, [closeUpdatePanel, positionUpdatePanel, updateExpanded, updateOpen]);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    writeSidebarPreference(width, next);
  }

  function resize(nextWidth: number) {
    const safeWidth = clampSidebarWidth(nextWidth);
    setWidth(safeWidth);
    writeSidebarPreference(safeWidth, false);
  }

  function beginResize(event: React.PointerEvent<HTMLDivElement>) {
    if (collapsed || window.matchMedia("(max-width: 900px)").matches) return;
    const startX = event.clientX;
    const startWidth = width;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    document.documentElement.dataset.sidebarResizing = "true";
    const move = (moveEvent: PointerEvent) => {
      applySidebarPreference(startWidth + moveEvent.clientX - startX, false);
    };
    const finish = (upEvent: PointerEvent) => {
      target.releasePointerCapture(upEvent.pointerId);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", finish);
      target.removeEventListener("pointercancel", finish);
      delete document.documentElement.dataset.sidebarResizing;
      resize(startWidth + upEvent.clientX - startX);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", finish);
    target.addEventListener("pointercancel", finish);
  }

  function resizeFromKeyboard(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      resize(width + (event.key === "ArrowRight" ? 8 : -8));
    } else if (event.key === "Home") {
      event.preventDefault();
      resize(SIDEBAR_MIN_WIDTH);
    } else if (event.key === "End") {
      event.preventDefault();
      resize(SIDEBAR_MAX_WIDTH);
    }
  }

  const updateFailed = [
    "failed",
    "rollback-succeeded",
    "rollback-failed",
    "interrupted",
  ].includes(task.phase);
  const updateRunning = [
    "starting",
    "queued",
    "running",
    "reconnecting",
    "verifying",
    "rolling-back",
  ].includes(task.phase);
  const availableVersion = info?.updateAvailable
    ? info.latestVersion
    : undefined;
  const currentVersionLabel = `v${currentVersion.replace(/^v/i, "")}`;
  const availableVersionLabel = availableVersion
    ? `v${availableVersion.replace(/^v/i, "")}`
    : undefined;
  const sidebarStatus = it.sidebarUpdateStatus;
  const updateSummary = (() => {
    switch (task.phase) {
      case "starting":
      case "queued":
        return sidebarStatus.updateStarting;
      case "running":
        return task.status?.stage === "checking"
          ? sidebarStatus.checking
          : sidebarStatus.updating;
      case "reconnecting":
        return sidebarStatus.reconnecting;
      case "verifying":
        return sidebarStatus.verifying;
      case "rolling-back":
        return sidebarStatus.rollingBack;
      case "succeeded":
        return it.updateSuccess;
      case "superseded":
        return it.updateSuperseded;
      case "failed":
        return sidebarStatus.updateFailed;
      case "rollback-succeeded":
        return sidebarStatus.rollbackSucceeded;
      case "rollback-failed":
        return sidebarStatus.rollbackFailed;
      case "interrupted":
        return sidebarStatus.updateInterrupted;
      case "idle":
        break;
    }

    switch (check.phase) {
      case "not-checked":
        return sidebarStatus.notChecked;
      case "checking":
        return sidebarStatus.checking;
      case "up-to-date":
        return sidebarStatus.upToDate;
      case "available":
        return availableVersionLabel
          ? sidebarStatus.available.replace("{version}", availableVersionLabel)
          : sidebarStatus.unavailable;
      case "failed":
        return availableVersionLabel
          ? sidebarStatus.checkFailedStale.replace(
              "{version}",
              availableVersionLabel,
            )
          : sidebarStatus.checkFailed;
      case "not-installable":
      case "not-installed":
        return sidebarStatus.unavailable;
      case "auth-required":
        return sidebarStatus.authRequired;
      default:
        return sidebarStatus.notChecked;
    }
  })();
  const updateLabel = `${currentVersionLabel}: ${updateSummary}`;
  const UpdateIcon = updateFailed
    ? CircleAlert
    : updateRunning
      ? LoaderCircle
      : RefreshCw;

  return (
    <aside className="sidebar">
      <Link href="/" className="brand">
        <BrandLogo className="brand-logo brand-logo-full" priority />
        <BrandLogo variant="mark" className="brand-logo brand-logo-mark" />
      </Link>
      <button
        type="button"
        className="sidebar-toggle"
        aria-label={collapsed ? it.sidebarExpand : it.sidebarCollapse}
        title={collapsed ? it.sidebarExpand : it.sidebarCollapse}
        onClick={toggleCollapsed}
      >
        {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
      </button>
      <div className="sidebar-navigation">
        <div className="nav-label">{it.navigation}</div>
        <nav aria-label={it.navigation}>
          {links.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={
                (href === "/" ? path === href : path.startsWith(href))
                  ? "nav-item active"
                  : "nav-item"
              }
              data-tooltip={label}
              aria-label={label}
            >
              <Icon size={19} />
              <span className="nav-item-label">{label}</span>
            </Link>
          ))}
        </nav>
      </div>
      <div className="sidebar-utilities">
        <Link
          href="/settings"
          className={`sidebar-settings-entry${path.startsWith("/settings") ? " active" : ""}`}
          aria-label={it.nav.settings}
          title={it.nav.settings}
        >
          <Settings size={19} aria-hidden="true" />
          <span className="sidebar-settings-copy">{it.nav.settings}</span>
        </Link>
        <button
          ref={updateEntry}
          type="button"
          className={`sidebar-update-entry${updateOpen ? " active" : ""}`}
          aria-label={updateLabel}
          aria-expanded={updateOpen}
          aria-haspopup="dialog"
          title={updateLabel}
          onClick={() => {
            if (updateOpen) closeUpdatePanel();
            else {
              setUpdateOpen(true);
              positionUpdatePanel();
            }
          }}
        >
          <span className="sidebar-update-icon" aria-hidden="true">
            <UpdateIcon
              size={19}
              className={updateRunning ? "spin" : undefined}
            />
            {availableVersion && !updateRunning && !updateFailed && (
              <span className="sidebar-update-dot" />
            )}
            {updateFailed && (
              <span className="sidebar-update-alert-mark">!</span>
            )}
          </span>
          <span className="sidebar-update-copy">
            <strong>{currentVersionLabel}</strong>
            <small>{updateSummary}</small>
          </span>
          <ChevronRight
            className="sidebar-update-arrow"
            size={16}
            aria-hidden="true"
          />
        </button>
      </div>
      <div
        className="sidebar-resizer"
        role="separator"
        aria-label={it.sidebarResize}
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        aria-valuenow={width}
        tabIndex={collapsed ? -1 : 0}
        onPointerDown={beginResize}
        onKeyDown={resizeFromKeyboard}
      />
      {updateOpen &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className={
              updateExpanded ? updatePopoverStyles.backdrop : undefined
            }
          >
            <section
              ref={updatePanel}
              className={`${updatePopoverStyles.panel} ${updateExpanded ? updatePopoverStyles.expanded : updatePopoverStyles.compact}`}
              style={updateExpanded ? undefined : updatePosition}
              role="dialog"
              aria-modal={updateExpanded || undefined}
              aria-labelledby="sidebar-update-title"
            >
              <header className={updatePopoverStyles.header}>
                <div>
                  <h2 id="sidebar-update-title">{it.systemUpdate}</h2>
                  <span>{currentVersionLabel}</span>
                </div>
                <button
                  ref={updateClose}
                  type="button"
                  className={updatePopoverStyles.close}
                  aria-label={it.close}
                  onClick={closeUpdatePanel}
                >
                  <X size={18} />
                </button>
              </header>
              <SystemUpdate
                currentVersion={currentVersion}
                expanded={updateExpanded}
                onExpandedChange={setUpdateExpanded}
              />
            </section>
          </div>,
          document.body,
        )}
    </aside>
  );
}
