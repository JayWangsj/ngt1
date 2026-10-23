"use client";

import { Check, ChevronDown, Plus, Search, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useMessages } from "./language";
import styles from "./business-select-panel.module.css";
import {
  ensureComfortableInteractionSpace,
  focusComfortably,
} from "@/lib/comfortable-scroll";

export type SelectOption = {
  value: string;
  label: string;
  ariaLabel?: string;
  secondary?: string;
  trailing?: ReactNode;
  icon?: ReactNode;
  keywords?: string;
};
export type SelectGroup = { label?: string; options: SelectOption[] };

function dropdownPosition(
  anchor: HTMLElement | null,
  panel: HTMLDivElement | null,
) {
  const rect = anchor?.getBoundingClientRect();
  if (!rect) return;
  const panelWidth = panel?.offsetWidth ?? rect.width;
  const panelHeight = panel?.offsetHeight ?? 0;
  const gap = 5;
  const edge = 12;
  const below = rect.bottom + gap;
  const fitsBelow = below + panelHeight <= window.innerHeight - edge;
  const fitsAbove = rect.top - gap - panelHeight >= edge;
  const top =
    !fitsBelow && fitsAbove
      ? rect.top - gap - panelHeight
      : Math.min(below, window.innerHeight - panelHeight - edge);
  const left = Math.min(
    Math.max(edge, rect.left),
    Math.max(edge, window.innerWidth - panelWidth - edge),
  );
  return { top: Math.max(edge, top), left, width: rect.width };
}

function useDropdown(open: boolean, anchor?: RefObject<HTMLElement | null>) {
  const trigger = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0 });
  useLayoutEffect(() => {
    if (!open) return;
    const next = dropdownPosition(
      anchor?.current ?? trigger.current,
      panel.current,
    );
    if (next) setPosition(next);
  }, [anchor, open]);
  useEffect(() => {
    if (!open) return;
    const reposition = () => {
      const next = dropdownPosition(
        anchor?.current ?? trigger.current,
        panel.current,
      );
      if (next) setPosition(next);
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [anchor, open]);
  return { trigger, panel, position };
}

export function SelectDropdown({
  value,
  defaultValue = "",
  onChange,
  groups,
  name,
  placeholder,
  ariaLabel,
  disabled = false,
  searchable = false,
  searchPlaceholder = "",
  emptyText = "",
  emptyCreateText,
  customLabel,
  onCustom,
  onCommit,
  onNoMatchEnter,
  onClose,
  onQueryChange,
  customDisabled = false,
  customValue = "",
  middleControl,
  creationControls = "always",
  preserveQueryOnClose = false,
  commitEmptyOnClose = false,
  clearable = false,
  loading = false,
  showEmptyPanel = true,
  autoFocusQuery,
  className = "",
}: {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  groups: SelectGroup[];
  name?: string;
  placeholder: string;
  ariaLabel: string;
  disabled?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyText?: string;
  emptyCreateText?: string;
  customLabel?: string;
  onCustom?: (query: string) => void;
  onCommit?: (query: string) => void;
  onNoMatchEnter?: (query: string) => void;
  onClose?: () => void;
  onQueryChange?: (query: string) => void;
  customDisabled?: boolean;
  customValue?: string;
  middleControl?: ReactNode;
  creationControls?: "always" | "no-match";
  preserveQueryOnClose?: boolean;
  commitEmptyOnClose?: boolean;
  clearable?: boolean;
  loading?: boolean;
  showEmptyPanel?: boolean;
  autoFocusQuery?: string;
  className?: string;
}) {
  const it = useMessages();
  const [open, setOpen] = useState(false);
  const [present, setPresent] = useState(false);
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const simpleTrigger = useRef<HTMLButtonElement>(null);
  const closingTimer = useRef<number | null>(null);
  const initialFocusApplied = useRef(false);
  const openFocusApplied = useRef(false);
  const id = useId();
  const optionId = (index: number) => `${id}-option-${index}`;
  const { trigger, panel, position } = useDropdown(present);
  const all = groups.flatMap((group) => group.options);
  const currentValue = value ?? internalValue;
  const selected = all.find((option) => option.value === currentValue);
  const displayValue = selected?.label ?? currentValue;
  const needle = query.trim().toLocaleLowerCase();
  const filtered = groups
    .map((group) => ({
      ...group,
      options: group.options.filter((option) =>
        [option.label, option.secondary, option.keywords]
          .filter(Boolean)
          .some((text) => text!.toLocaleLowerCase().includes(needle)),
      ),
    }))
    .filter((group) => group.options.length);
  const visible = filtered.flatMap((group) => group.options);
  const trimmedQuery = query.trim();
  const createValue = trimmedQuery || customValue.trim();
  const createNeedle = createValue.toLocaleLowerCase();
  const createMatches = all.some((option) =>
    [option.label, option.secondary, option.keywords]
      .filter(Boolean)
      .some((text) => text!.toLocaleLowerCase().includes(createNeedle)),
  );
  const canCreate =
    !!createValue && !loading && !createMatches && !customDisabled;
  const showCreationControls =
    creationControls === "always" ||
    (!!trimmedQuery && !loading && visible.length === 0);
  const estimatedPanelHeight = Math.min(
    340,
    Math.max(
      52,
      visible.length * 42 + filtered.filter((group) => group.label).length * 26,
    ),
  );

  const close = useCallback(
    ({
      focus = false,
      commit = true,
    }: { focus?: boolean; commit?: boolean } = {}) => {
      const currentQuery = search.current?.value ?? query;
      if (commit && searchable) {
        if (currentQuery.trim()) onCommit?.(currentQuery.trim());
        else if (commitEmptyOnClose && open) onChange?.("");
      }
      setOpen(false);
      if (!preserveQueryOnClose) setQuery("");
      setActive(0);
      onClose?.();
      if (closingTimer.current) window.clearTimeout(closingTimer.current);
      closingTimer.current = window.setTimeout(() => setPresent(false), 180);
      if (focus)
        requestAnimationFrame(() =>
          focusComfortably(searchable ? search.current : simpleTrigger.current),
        );
    },
    [
      commitEmptyOnClose,
      onChange,
      onClose,
      onCommit,
      open,
      preserveQueryOnClose,
      query,
      searchable,
    ],
  );
  function openDropdown() {
    const element = trigger.current;
    if (!element || disabled) return;
    ensureComfortableInteractionSpace(element, {
      spaceBelow: estimatedPanelHeight,
    });
    if (closingTimer.current) window.clearTimeout(closingTimer.current);
    setPortalTarget(element.closest("dialog") ?? document.body);
    setPresent(true);
    setOpen(true);
  }
  function choose(option: SelectOption) {
    setQuery("");
    onQueryChange?.("");
    setInternalValue(option.value);
    onChange?.(option.value);
    close({ commit: false });
    if (searchable) search.current?.blur();
    else requestAnimationFrame(() => focusComfortably(simpleTrigger.current));
  }
  function move(event: KeyboardEvent, delta: number) {
    event.preventDefault();
    if (!visible.length) return;
    setActive((current) => (current + delta + visible.length) % visible.length);
  }
  function keys(event: KeyboardEvent) {
    const currentQuery =
      event.currentTarget instanceof HTMLInputElement
        ? event.currentTarget.value
        : (search.current?.value ?? query);
    const currentTrimmedQuery = currentQuery.trim();
    if (
      searchable &&
      !open &&
      currentValue &&
      !commitEmptyOnClose &&
      (event.key === "Backspace" || event.key === "Delete")
    ) {
      event.preventDefault();
      setInternalValue("");
      setQuery("");
      onQueryChange?.("");
      onChange?.("");
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close({ focus: true, commit: !commitEmptyOnClose });
    } else if (event.key === "ArrowDown") move(event, 1);
    else if (event.key === "ArrowUp") move(event, -1);
    else if (
      event.key === "Enter" &&
      searchable &&
      !currentTrimmedQuery &&
      commitEmptyOnClose
    ) {
      onChange?.("");
      close({ commit: false });
    } else if (event.key === "Enter" && visible[active]) {
      choose(visible[active]);
    } else if (
      event.key === "Enter" &&
      searchable &&
      currentTrimmedQuery &&
      !visible.length &&
      onNoMatchEnter
    ) {
      onNoMatchEnter(currentTrimmedQuery);
    } else if (
      event.key === "Enter" &&
      searchable &&
      currentTrimmedQuery &&
      onCommit
    ) {
      close();
    } else if (
      event.key === "Enter" &&
      searchable &&
      currentTrimmedQuery &&
      onCustom &&
      canCreate
    ) {
      close({ commit: false });
      onCustom(currentTrimmedQuery);
    }
  }
  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      const target = event.target as Node;
      if (
        !trigger.current?.contains(target) &&
        !panel.current?.contains(target)
      )
        close();
    }
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [close, open, panel, trigger]);
  useEffect(() => {
    if (!open) {
      openFocusApplied.current = false;
      return;
    }
    if (!searchable || openFocusApplied.current) return;
    openFocusApplied.current = true;
    requestAnimationFrame(() =>
      focusComfortably(search.current, {
        spaceBelow: estimatedPanelHeight,
      }),
    );
  }, [estimatedPanelHeight, open, searchable]);
  useEffect(() => {
    if (
      !searchable ||
      autoFocusQuery === undefined ||
      initialFocusApplied.current
    )
      return;
    const frame = requestAnimationFrame(() => {
      if (initialFocusApplied.current) return;
      const element = trigger.current;
      if (!element || disabled) return;
      initialFocusApplied.current = true;
      openFocusApplied.current = true;
      if (closingTimer.current) window.clearTimeout(closingTimer.current);
      setPortalTarget(element.closest("dialog") ?? document.body);
      setQuery(autoFocusQuery);
      onQueryChange?.(autoFocusQuery);
      setActive(0);
      setPresent(true);
      setOpen(true);
      requestAnimationFrame(() => {
        focusComfortably(search.current, {
          spaceBelow: estimatedPanelHeight,
          select: true,
        });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [
    autoFocusQuery,
    disabled,
    estimatedPanelHeight,
    onQueryChange,
    searchable,
    trigger,
  ]);
  useEffect(
    () => () => {
      if (closingTimer.current) window.clearTimeout(closingTimer.current);
    },
    [],
  );

  const inputValue =
    open || (preserveQueryOnClose && query) ? query : displayValue;
  const canClear = !disabled && (open ? !!query : clearable && !!currentValue);
  const activeDescendant =
    open && visible[active] ? optionId(active) : undefined;

  return (
    <div
      ref={trigger}
      className={`business-select ${open ? "is-open" : ""} ${className}`}
      data-prevent-card-autosave
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {name && <input type="hidden" name={name} value={currentValue} />}
      {searchable ? (
        <div
          className={`business-combobox-control ${showCreationControls && onCustom && customLabel ? "has-create" : ""} ${showCreationControls && middleControl ? "has-middle" : ""}`}
        >
          <div className="business-combobox-input">
            <Search size={15} aria-hidden="true" />
            <input
              ref={search}
              type="text"
              role="combobox"
              value={inputValue}
              placeholder={searchPlaceholder || placeholder}
              aria-label={ariaLabel}
              aria-expanded={open}
              aria-haspopup="listbox"
              aria-controls={id}
              aria-autocomplete="list"
              aria-activedescendant={activeDescendant}
              data-comfortable-expansion={estimatedPanelHeight}
              disabled={disabled}
              onChange={(event) => {
                const next = event.target.value;
                initialFocusApplied.current = true;
                setQuery(next);
                setActive(0);
                onQueryChange?.(next);
                if (next.trim()) {
                  if (!open) openDropdown();
                } else if (commitEmptyOnClose && (open || currentValue)) {
                  if (!open) openDropdown();
                  setOpen(true);
                } else {
                  setInternalValue("");
                  setOpen(false);
                  setPresent(false);
                  onChange?.("");
                }
              }}
              onKeyDown={keys}
            />
            {canClear && (
              <button
                type="button"
                className="business-combobox-clear x-icon-button"
                aria-label={open ? it.clearSearch : it.clearSelection}
                onPointerDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.stopPropagation();
                  setQuery("");
                  setActive(0);
                  onQueryChange?.("");
                  if (commitEmptyOnClose && (open || currentValue)) {
                    if (!open) openDropdown();
                    requestAnimationFrame(() =>
                      focusComfortably(search.current),
                    );
                    return;
                  }
                  setInternalValue("");
                  setOpen(false);
                  setPresent(false);
                  onChange?.("");
                  requestAnimationFrame(() => focusComfortably(search.current));
                }}
              >
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </div>
          <button
            type="button"
            className="business-combobox-chevron"
            aria-label={open ? it.collapseOptions : it.expandOptions}
            aria-expanded={open}
            aria-controls={id}
            disabled={disabled}
            onPointerDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              if (open) close({ focus: true });
              else openDropdown();
            }}
          >
            <ChevronDown size={15} aria-hidden="true" />
          </button>
          {showCreationControls && middleControl}
          {showCreationControls && onCustom && customLabel && (
            <button
              type="button"
              className="business-select-create"
              aria-label={customLabel}
              disabled={disabled || !canCreate}
              onClick={(event) => {
                event.stopPropagation();
                setQuery("");
                onQueryChange?.("");
                close({ commit: false });
                onCustom(createValue);
              }}
            >
              <Plus size={14} aria-hidden="true" />
              <span>{customLabel}</span>
            </button>
          )}
        </div>
      ) : (
        <button
          ref={simpleTrigger}
          type="button"
          className="business-select-trigger"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={id}
          data-comfortable-expansion={estimatedPanelHeight}
          disabled={disabled}
          onClick={() => {
            if (open) close();
            else openDropdown();
          }}
          onKeyDown={(event) => {
            if (["Enter", " ", "ArrowDown"].includes(event.key)) {
              event.preventDefault();
              openDropdown();
            }
          }}
        >
          <span className={displayValue ? "" : "is-placeholder"}>
            {displayValue || placeholder}
          </span>
          <ChevronDown size={15} aria-hidden="true" />
        </button>
      )}
      {present &&
        (showEmptyPanel || loading || visible.length > 0) &&
        portalTarget &&
        createPortal(
          <div
            ref={panel}
            className={`business-select-panel ${open ? "is-entering" : "is-leaving"} ${styles.scope}`}
            data-prevent-card-autosave
            style={{
              top: position.top,
              left: position.left,
              width: position.width,
            }}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={keys}
          >
            <div
              id={id}
              className="business-select-options"
              role="listbox"
              aria-label={ariaLabel}
            >
              {loading && (
                <p className="business-select-empty">{it.searching}</p>
              )}
              {!loading &&
                filtered.map((group) => (
                  <div
                    className="business-select-group"
                    key={group.label ?? "_"}
                  >
                    {group.label && (
                      <div className="business-select-group-label">
                        {group.label}
                      </div>
                    )}
                    {group.options.map((option) => {
                      const index = visible.indexOf(option);
                      const checked = option.value === currentValue;
                      return (
                        <div
                          id={optionId(index)}
                          role="option"
                          aria-label={option.ariaLabel}
                          aria-selected={checked}
                          className={`business-select-option ${checked ? "is-selected" : ""} ${index === active ? "is-active" : ""}`}
                          key={option.value}
                          onMouseEnter={() => setActive(index)}
                          onClick={() => choose(option)}
                        >
                          {option.icon && (
                            <span className="business-select-option-icon">
                              {option.icon}
                            </span>
                          )}
                          <span className="business-select-option-copy">
                            <strong>{option.label}</strong>
                            {option.secondary && (
                              <small>{option.secondary}</small>
                            )}
                          </span>
                          {option.trailing && (
                            <span className="business-select-option-trailing">
                              {option.trailing}
                            </span>
                          )}
                          {checked && <Check size={15} aria-hidden="true" />}
                        </div>
                      );
                    })}
                  </div>
                ))}
              {!loading && !visible.length && (
                <div className="business-select-empty">
                  <strong>
                    {onCustom && customLabel
                      ? (emptyCreateText ??
                        it.noMatchesCreateHint.replace("{action}", customLabel))
                      : emptyText}
                  </strong>
                </div>
              )}
            </div>
          </div>,
          portalTarget,
        )}
    </div>
  );
}

export function SimpleSelect(
  props: Omit<Parameters<typeof SelectDropdown>[0], "groups" | "searchable"> & {
    options: SelectOption[];
  },
) {
  const { options, ...rest } = props;
  return <SelectDropdown {...rest} groups={[{ options }]} />;
}

export function SearchableCombobox(
  props: Omit<Parameters<typeof SelectDropdown>[0], "searchable">,
) {
  return <SelectDropdown {...props} searchable />;
}

export { DatePicker } from "./date-picker";
