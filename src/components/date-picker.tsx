"use client";

import {
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Trash2,
} from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ChangeEventHandler,
  type CSSProperties,
  type FocusEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  addDays,
  dateParts,
  dateTimeSerial,
  daysInMonth,
  formatMonthValue,
  formatRomeDateTimeLocal,
  hasAllowedDateTimeOnDay,
  isoDate,
  isoMonth,
  isAllowedYear,
  isAllowedValue,
  isCompleteValue,
  monthParts,
  shiftMonth,
  weekday,
  type DateParts,
  type DatePickerRules,
  type DatePickerType,
} from "@/lib/date-picker";
import { useBusinessDay, useBusinessDayMode } from "./business-date";
import { useLanguage, useMessages } from "./language";

export type DatePickerProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "onChange" | "step"
> & {
  type?: DatePickerType;
  step?: number | "any";
  onChange?: ChangeEventHandler<HTMLInputElement>;
  onCommit?: (value: string) => void | Promise<void>;
  quickDays?: number[];
  quickTimes?: string[];
};

type PanelMode = "calendar" | "months" | "years";

function utcDate(year: number, month: number, day = 1) {
  const date = new Date(0);
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

function pickerPosition(anchor: HTMLElement, panel: HTMLDivElement) {
  const viewport = window.visualViewport;
  const visibleTop = viewport?.offsetTop ?? 0;
  const visibleLeft = viewport?.offsetLeft ?? 0;
  const visibleWidth = viewport?.width ?? window.innerWidth;
  const visibleHeight = viewport?.height ?? window.innerHeight;
  const rect = anchor.getBoundingClientRect();
  const panelWidth = panel.offsetWidth;
  const panelHeight = panel.offsetHeight;
  const edge = 12;
  const below = rect.bottom + 5;
  const above = rect.top - panelHeight - 5;
  const top =
    below + panelHeight <= visibleTop + visibleHeight - edge
      ? below
      : above >= visibleTop + edge
        ? above
        : Math.max(
            visibleTop + edge,
            visibleTop + visibleHeight - panelHeight - edge,
          );
  const left = Math.min(
    Math.max(visibleLeft + edge, rect.left),
    Math.max(
      visibleLeft + edge,
      visibleLeft + visibleWidth - panelWidth - edge,
    ),
  );
  return {
    top,
    left,
    maxHeight: Math.max(180, visibleHeight - edge * 2),
  };
}

function yearGroupStart(year: number) {
  return 1 + Math.floor((year - 1) / 12) * 12;
}

function timePart(value: string, fallback = "09:00") {
  if (/^\d{4}-\d{2}-\d{2}T$/.test(value)) return "";
  const match = /^\d{4}-\d{2}-\d{2}T(.+)$/.exec(value);
  return match?.[1] || fallback;
}

function monthHasValue(year: number, month: number, rules: DatePickerRules) {
  if (rules.type === "month")
    return isAllowedValue(isoMonth(year, month), rules);
  for (let day = 1; day <= daysInMonth(year, month); day++) {
    if (hasAllowedDateTimeOnDay({ year, month, day }, rules)) return true;
  }
  return false;
}

function compareToBounds(value: string, rules: DatePickerRules) {
  if (rules.type === "datetime-local") {
    const parsed = dateTimeSerial(value);
    const minimum = dateTimeSerial(rules.min ?? "");
    const maximum = dateTimeSerial(rules.max ?? "");
    return (
      parsed !== null &&
      (minimum === null || parsed >= minimum) &&
      (maximum === null || parsed <= maximum)
    );
  }
  const candidate = value;
  const minimum = rules.type === "date" ? rules.min : rules.min?.slice(0, 7);
  const maximum = rules.type === "date" ? rules.max : rules.max?.slice(0, 7);
  return (
    (!minimum || candidate >= minimum) && (!maximum || candidate <= maximum)
  );
}

export const DatePicker = forwardRef<HTMLInputElement, DatePickerProps>(
  function DatePicker(props, forwardedRef) {
    const {
      className = "",
      defaultValue,
      disabled = false,
      max,
      min,
      onBlur,
      onChange,
      onClick,
      onCommit,
      onFocus,
      onKeyDown,
      onPointerDown,
      quickDays = [0],
      quickTimes = [],
      readOnly = false,
      required = false,
      step,
      type = "date",
      value,
      "aria-describedby": describedBy,
      "aria-invalid": ariaInvalid,
      ...rest
    } = props;
    const pickerType = type as DatePickerType;
    const locale = useLanguage().locale;
    const messages = useMessages().datePicker;
    const businessDay = useBusinessDay();
    const businessDayMode = useBusinessDayMode();
    const initialValue = String(defaultValue ?? "");
    const stepBaseValue = useRef(String(value ?? defaultValue ?? ""));
    const [internalValue, setInternalValue] = useState(initialValue);
    const controlled = value !== undefined;
    const committedValue = String(controlled ? value : internalValue);
    const [draftValue, setDraftValue] = useState(committedValue);
    const [hasDraft, setHasDraft] = useState(false);
    const [open, setOpen] = useState(false);
    const [panelMode, setPanelMode] = useState<PanelMode>(
      pickerType === "month" ? "months" : "calendar",
    );
    const [view, setView] = useState(() => {
      const date =
        dateParts(committedValue.slice(0, 10)) ?? dateParts(businessDay)!;
      return { year: date.year, month: date.month };
    });
    const [activeDate, setActiveDate] = useState("");
    const [activeMonth, setActiveMonth] = useState("");
    const [activeYear, setActiveYear] = useState(0);
    const [yearInput, setYearInput] = useState("");
    const [error, setError] = useState("");
    const [position, setPosition] = useState({
      top: 0,
      left: 0,
      maxHeight: 600,
    });
    const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
    const componentId = useId().replaceAll(":", "");
    const panelId = `${componentId}-calendar`;
    const yearInputId = `${componentId}-year`;
    const errorId = `${componentId}-error`;
    const root = useRef<HTMLDivElement>(null);
    const input = useRef<HTMLInputElement>(null);
    const panel = useRef<HTMLDivElement>(null);
    const openRef = useRef(false);
    const dispatchingCommit = useRef(false);
    const suppressBlurCommit = useRef(false);
    const suppressBlurTimer = useRef<number | null>(null);
    const pendingInputValue = useRef<string | null>(null);
    const lastCommit = useRef(committedValue);
    const effectiveValue =
      pickerType === "datetime-local" && (open || hasDraft)
        ? draftValue
        : committedValue;
    const rules: DatePickerRules = {
      type: pickerType,
      min: typeof min === "string" ? min : undefined,
      max: typeof max === "string" ? max : undefined,
      step,
      stepBase: stepBaseValue.current,
    };
    const businessDate = dateParts(businessDay) ?? {
      year: 1970,
      month: 1,
      day: 1,
    };
    const selectedDate = dateParts(committedValue.slice(0, 10));
    const selectedMonth =
      pickerType === "month"
        ? monthParts(committedValue)
        : selectedDate
          ? { year: selectedDate.year, month: selectedDate.month }
          : null;
    const language = locale === "zh" ? "zh-CN" : "it-IT";
    const monthLabel = new Intl.DateTimeFormat(language, {
      month: "long",
    }).format(utcDate(view.year, view.month));
    const weekdays = Array.from({ length: 7 }, (_, index) =>
      new Intl.DateTimeFormat(language, { weekday: "narrow" }).format(
        utcDate(2024, 1, index + 1),
      ),
    );
    const monthLabels = Array.from({ length: 12 }, (_, index) =>
      new Intl.DateTimeFormat(language, { month: "long" }).format(
        utcDate(view.year, index + 1),
      ),
    );
    const monthValueLabel =
      pickerType === "month" ? formatMonthValue(effectiveValue, language) : "";

    function validationError(next: string) {
      if (!next) return required ? messages.required : "";
      if (!isCompleteValue(next, pickerType))
        return pickerType === "datetime-local" && next.endsWith("T")
          ? messages.timeRequired
          : messages.invalidValue;
      if (!compareToBounds(next, rules)) return messages.outsideRange;
      if (!isAllowedValue(next, rules)) return messages.stepMismatch;
      return "";
    }

    function updateError(next: string) {
      const message = validationError(next);
      setError(message);
      input.current?.setCustomValidity(message);
      return message;
    }

    function commit(next: string, dispatchChange: boolean, close = true) {
      if (disabled || readOnly) return false;
      const message = validationError(next);
      if (message) {
        setError(message);
        input.current?.setCustomValidity(message);
        return false;
      }
      setError("");
      input.current?.setCustomValidity("");
      if (next !== committedValue && !controlled) setInternalValue(next);
      if (pickerType === "datetime-local") {
        setDraftValue(next);
        setHasDraft(false);
      }
      if (dispatchChange && next !== committedValue && input.current) {
        const element = input.current;
        const trackedInput = element as HTMLInputElement & {
          _valueTracker?: { setValue: (value: string) => void };
        };
        trackedInput._valueTracker?.setValue(committedValue);
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(element, next);
        dispatchingCommit.current = true;
        try {
          element.dispatchEvent(new Event("input", { bubbles: true }));
        } finally {
          dispatchingCommit.current = false;
        }
      }
      let saveFailed = false;
      if (next !== lastCommit.current) {
        lastCommit.current = next;
        try {
          const result = onCommit?.(next);
          if (result && typeof result.then === "function")
            void result.catch(() => setError(messages.saveFailed));
        } catch {
          saveFailed = true;
        }
      }
      if (close) closePicker(true, false);
      if (saveFailed) setError(messages.saveFailed);
      return true;
    }

    function commitInput() {
      if (input.current?.validity.badInput) {
        setError(messages.invalidValue);
        input.current.setCustomValidity(messages.invalidValue);
        return false;
      }
      const next = input.current?.value ?? committedValue;
      return commit(next, pickerType === "datetime-local", true);
    }

    function selectedCalendarDate() {
      const date = dateParts(committedValue.slice(0, 10)) ?? businessDate;
      if (date.year >= 1 && date.year <= 9999) return date;
      return businessDate;
    }

    function openPicker() {
      if (disabled || readOnly) return;
      const draftDate =
        pickerType === "datetime-local" && hasDraft
          ? dateParts(draftValue.slice(0, 10))
          : null;
      const initial = draftDate ?? selectedCalendarDate();
      setView({ year: initial.year, month: initial.month });
      setActiveDate(isoDate(initial));
      setActiveMonth(isoMonth(initial.year, initial.month));
      setActiveYear(initial.year);
      setYearInput(String(initial.year).padStart(4, "0"));
      const preserveDraft = pickerType === "datetime-local" && hasDraft;
      if (!preserveDraft) setDraftValue(committedValue);
      const openingError = preserveDraft ? validationError(draftValue) : "";
      setError(openingError);
      input.current?.setCustomValidity(openingError);
      setPanelMode(pickerType === "month" ? "months" : "calendar");
      setPortalTarget(
        input.current?.closest<HTMLElement>("[role=dialog], dialog") ??
          document.body,
      );
      openRef.current = true;
      setOpen(true);
    }

    const closePicker = useCallback(
      (restoreFocus: boolean, discardDraft = true) => {
        if (suppressBlurTimer.current !== null) {
          window.clearTimeout(suppressBlurTimer.current);
          suppressBlurTimer.current = null;
        }
        suppressBlurCommit.current = !restoreFocus;
        if (!restoreFocus)
          suppressBlurTimer.current = window.setTimeout(() => {
            suppressBlurCommit.current = false;
            suppressBlurTimer.current = null;
          }, 0);
        openRef.current = false;
        setOpen(false);
        setError("");
        input.current?.setCustomValidity("");
        if (pickerType === "datetime-local" && discardDraft) {
          setDraftValue(committedValue);
          setHasDraft(false);
        }
        if (restoreFocus) input.current?.focus({ preventScroll: true });
      },
      [committedValue, pickerType],
    );

    function togglePicker() {
      if (open) closePicker(true);
      else openPicker();
    }

    function setViewToDate(date: DateParts) {
      setView({ year: date.year, month: date.month });
      setActiveDate(isoDate(date));
    }

    function setDraftDate(date: DateParts) {
      const time = timePart(draftValue || committedValue);
      const next = `${isoDate(date)}T${time}`;
      setDraftValue(next);
      setViewToDate(date);
      updateError(next);
    }

    function jumpToYear(year: number) {
      if (!isAllowedYear(year, rules)) {
        setError(
          year >= 1 && year <= 9999
            ? messages.noAvailableValue
            : messages.yearRange,
        );
        return false;
      }
      setView((current) => ({ year, month: current.month }));
      setActiveYear(year);
      setYearInput(String(year).padStart(4, "0"));
      setActiveMonth(isoMonth(year, view.month));
      if (pickerType !== "month")
        setActiveDate(isoDate({ year, month: view.month, day: 1 }));
      setError("");
      setPanelMode(pickerType === "month" ? "months" : "calendar");
      return true;
    }

    useEffect(() => {
      if (disabled || readOnly) closePicker(false);
    }, [disabled, readOnly, closePicker]);

    useEffect(() => {
      const form = input.current?.form;
      if (!form) return;
      const reset = () => {
        if (!controlled) setInternalValue(initialValue);
        if (!controlled) lastCommit.current = initialValue;
        setDraftValue(initialValue);
        setError("");
        input.current?.setCustomValidity("");
        closePicker(false);
      };
      form.addEventListener("reset", reset);
      return () => form.removeEventListener("reset", reset);
    }, [controlled, initialValue, closePicker]);

    useEffect(
      () => () => {
        if (suppressBlurTimer.current !== null)
          window.clearTimeout(suppressBlurTimer.current);
      },
      [],
    );

    useEffect(() => {
      if (!open) return;
      function outside(event: PointerEvent) {
        if (!(event.target instanceof Node)) return;
        if (
          root.current?.contains(event.target) ||
          panel.current?.contains(event.target)
        )
          return;
        closePicker(false);
      }
      document.addEventListener("pointerdown", outside);
      return () => document.removeEventListener("pointerdown", outside);
    }, [open, closePicker]);

    useLayoutEffect(() => {
      if (!open || !input.current || !panel.current) return;
      const update = () => {
        if (!input.current || !panel.current) return;
        setPosition(pickerPosition(input.current, panel.current));
      };
      update();
      const observer = new ResizeObserver(update);
      observer.observe(panel.current);
      window.addEventListener("resize", update);
      window.addEventListener("scroll", update, true);
      window.visualViewport?.addEventListener("resize", update);
      window.visualViewport?.addEventListener("scroll", update);
      return () => {
        observer.disconnect();
        window.removeEventListener("resize", update);
        window.removeEventListener("scroll", update, true);
        window.visualViewport?.removeEventListener("resize", update);
        window.visualViewport?.removeEventListener("scroll", update);
      };
    }, [open, panelMode, view.year, view.month, draftValue]);

    useLayoutEffect(() => {
      if (!open || !panel.current) return;
      let selector = "";
      if (panelMode === "years")
        selector = `[data-year="${activeYear || view.year}"]`;
      else if (panelMode === "months")
        selector = `[data-month="${activeMonth || isoMonth(view.year, view.month)}"]`;
      else
        selector = `[data-date="${activeDate || isoDate({ year: view.year, month: view.month, day: 1 })}"]`;
      const target = panel.current.querySelector<HTMLElement>(selector);
      const fallback = panel.current.querySelector<HTMLElement>(
        panelMode === "years"
          ? ".date-picker-year-input, .date-picker-years button:not(:disabled)"
          : panelMode === "months"
            ? ".date-picker-months button:not(:disabled)"
            : ".date-picker-days button:not(:disabled), .date-picker-header button:not(:disabled)",
      );
      (target && !target.matches(":disabled") ? target : fallback)?.focus({
        preventScroll: true,
      });
    }, [
      open,
      panelMode,
      view.year,
      view.month,
      activeDate,
      activeMonth,
      activeYear,
    ]);

    useEffect(() => {
      if (!controlled || !open || pickerType !== "datetime-local") return;
      setDraftValue(committedValue);
      const actualDate = dateParts(committedValue.slice(0, 10));
      if (actualDate)
        setView({ year: actualDate.year, month: actualDate.month });
    }, [committedValue, controlled, open, pickerType]);

    useEffect(() => {
      if (!controlled) return;
      if (pendingInputValue.current === committedValue) {
        pendingInputValue.current = null;
        return;
      }
      lastCommit.current = committedValue;
      if (pickerType === "datetime-local") {
        setDraftValue(committedValue);
        setHasDraft(false);
      }
      const date =
        dateParts(committedValue.slice(0, 10)) ?? monthParts(committedValue);
      if (date) setView({ year: date.year, month: date.month });
    }, [committedValue, controlled, pickerType]);

    function setInputRef(element: HTMLInputElement | null) {
      input.current = element;
      if (typeof forwardedRef === "function") forwardedRef(element);
      else if (forwardedRef) forwardedRef.current = element;
    }

    function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
      const next = event.currentTarget.value;
      if (event.currentTarget.validity.badInput) {
        setError(messages.invalidValue);
        input.current?.setCustomValidity(messages.invalidValue);
        return;
      }
      if (pickerType === "datetime-local" && !dispatchingCommit.current) {
        setDraftValue(next);
        setHasDraft(true);
        updateError(next);
        return;
      }
      pendingInputValue.current = next;
      if (!controlled) setInternalValue(next);
      onChange?.(event);
      if (pickerType === "datetime-local" && open) {
        setDraftValue(next);
        setHasDraft(false);
        updateError(next);
      } else if (next && isCompleteValue(next, pickerType)) updateError(next);
      else {
        setError("");
        input.current?.setCustomValidity("");
      }
    }

    function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
      onKeyDown?.(event);
      if (event.defaultPrevented) return;
      if (event.key === "Escape" && open) {
        event.preventDefault();
        event.stopPropagation();
        closePicker(true);
      } else if (event.key === "ArrowDown" && !open && !disabled && !readOnly) {
        event.preventDefault();
        openPicker();
      } else if (event.key === "Enter") {
        if (pickerType === "datetime-local" || !open) {
          event.preventDefault();
          commitInput();
        }
      }
    }

    function handleInputBlur(event: FocusEvent<HTMLInputElement>) {
      onBlur?.(event);
      if (suppressBlurCommit.current) return;
      if (event.currentTarget.validity.badInput) {
        setError(messages.invalidValue);
        event.currentTarget.setCustomValidity(messages.invalidValue);
        return;
      }
      const next = event.relatedTarget;
      if (
        next instanceof Node &&
        (root.current?.contains(next) || panel.current?.contains(next))
      )
        return;
      if (!openRef.current) {
        queueMicrotask(() => {
          if (
            document.activeElement &&
            (root.current?.contains(document.activeElement) ||
              panel.current?.contains(document.activeElement))
          )
            return;
          if (input.current?.validity.badInput) {
            setError(messages.invalidValue);
            input.current.setCustomValidity(messages.invalidValue);
            return;
          }
          const nextValue = input.current?.value ?? "";
          if (nextValue === committedValue && nextValue === lastCommit.current)
            return;
          if (!validationError(nextValue))
            commit(nextValue, pickerType === "datetime-local", false);
          else if (nextValue || required) updateError(nextValue);
        });
      }
    }

    function navigateDate(date: DateParts) {
      setView({ year: date.year, month: date.month });
      setActiveDate(isoDate(date));
    }

    function handlePanelKeyDown(event: KeyboardEvent<HTMLDivElement>) {
      if (disabled || readOnly) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closePicker(true);
        return;
      }
      const target = event.target as HTMLElement;
      if (target.dataset.date) {
        const current = dateParts(target.dataset.date);
        if (!current) return;
        let next: DateParts | null = null;
        if (event.key === "ArrowLeft") next = addDays(current, -1);
        if (event.key === "ArrowRight") next = addDays(current, 1);
        if (event.key === "ArrowUp") next = addDays(current, -7);
        if (event.key === "ArrowDown") next = addDays(current, 7);
        if (event.key === "PageUp" || event.key === "PageDown") {
          const shifted = shiftMonth(
            current.year,
            current.month,
            event.key === "PageUp" ? -1 : 1,
          );
          next = {
            ...shifted,
            day: Math.min(
              current.day,
              daysInMonth(shifted.year, shifted.month),
            ),
          };
        }
        if (
          next &&
          (pickerType === "datetime-local"
            ? hasAllowedDateTimeOnDay(next, rules)
            : isAllowedValue(isoDate(next), rules))
        ) {
          event.preventDefault();
          navigateDate(next);
        }
      } else if (target.dataset.month) {
        const current = monthParts(target.dataset.month);
        if (!current) return;
        let delta = 0;
        if (event.key === "ArrowLeft") delta = -1;
        if (event.key === "ArrowRight") delta = 1;
        if (event.key === "ArrowUp") delta = -3;
        if (event.key === "ArrowDown") delta = 3;
        if (event.key === "PageUp") delta = -12;
        if (event.key === "PageDown") delta = 12;
        const next = shiftMonth(current.year, current.month, delta);
        if (delta && monthHasValue(next.year, next.month, rules)) {
          event.preventDefault();
          setView(next);
          setActiveMonth(isoMonth(next.year, next.month));
        }
      } else if (target.dataset.year) {
        let next = Number(target.dataset.year);
        if (event.key === "ArrowLeft") next -= 1;
        if (event.key === "ArrowRight") next += 1;
        if (event.key === "ArrowUp") next -= 3;
        if (event.key === "ArrowDown") next += 3;
        if (event.key === "PageUp") next -= 12;
        if (event.key === "PageDown") next += 12;
        if (
          next !== Number(target.dataset.year) &&
          isAllowedYear(next, rules)
        ) {
          event.preventDefault();
          setActiveYear(next);
        }
      }
    }

    function chooseDate(date: DateParts) {
      const next = isoDate(date);
      if (pickerType === "datetime-local") {
        setDraftDate(date);
        return;
      }
      commit(next, true);
    }

    function chooseMonth(month: number) {
      const key = isoMonth(view.year, month);
      setActiveMonth(key);
      if (pickerType === "month") {
        commit(key, true);
      } else {
        setView((current) => ({ ...current, month }));
        setActiveDate(isoDate({ year: view.year, month, day: 1 }));
        setPanelMode("calendar");
      }
    }

    function changeYearFromPanel(year: number) {
      jumpToYear(year);
    }

    function changeView(delta: number) {
      if (panelMode === "years") {
        const nextStart = yearStart + delta * 12;
        if (nextStart < 1 || nextStart > 9999) return;
        const years = Array.from(
          { length: Math.min(12, 10000 - nextStart) },
          (_, index) => nextStart + index,
        ).filter((year) => isAllowedYear(year, rules));
        if (!years.length) return;
        const offset = view.year - yearStart;
        const nextYear = years.includes(nextStart + offset)
          ? nextStart + offset
          : years[0];
        setView((current) => ({ ...current, year: nextYear }));
        setActiveYear(nextYear);
        setYearInput(String(nextYear).padStart(4, "0"));
        return;
      }
      if (panelMode === "months" || pickerType === "month") {
        const year = view.year + delta;
        if (year < 1 || year > 9999 || !isAllowedYear(year, rules)) return;
        setView((current) => ({ ...current, year }));
        setActiveYear(year);
        setActiveMonth(isoMonth(year, view.month));
        return;
      }
      const next = shiftMonth(view.year, view.month, delta);
      if (
        next.year < 1 ||
        next.year > 9999 ||
        !monthHasValue(next.year, next.month, rules)
      )
        return;
      setView(next);
      setActiveDate(isoDate({ year: next.year, month: next.month, day: 1 }));
    }

    function clearValue() {
      commit("", true);
    }

    function dateTimeValue(date: string, time: string) {
      const next = `${date}T${time}`;
      setDraftValue(next);
      updateError(next);
    }

    function visibleCalendarDays() {
      const first = { year: view.year, month: view.month, day: 1 };
      const offset = (weekday(first) + 6) % 7;
      const start = addDays(first, -offset);
      return Array.from({ length: 42 }, (_, index) => addDays(start, index));
    }

    const yearStart = yearGroupStart(view.year);
    const yearOptions = Array.from(
      { length: 12 },
      (_, index) => yearStart + index,
    ).filter((year) => year <= 9999);
    const draftDate = dateParts(draftValue.slice(0, 10));
    const draftTime = timePart(draftValue, "09:00");
    const nowValue = formatRomeDateTimeLocal();
    const draftError =
      pickerType === "datetime-local" ? validationError(draftValue) : "";
    const calendarDays = visibleCalendarDays();
    const hasSelectableCalendarDate = calendarDays.some(
      (day) =>
        day.month === view.month &&
        (pickerType === "datetime-local"
          ? hasAllowedDateTimeOnDay(day, rules)
          : isAllowedValue(isoDate(day), rules)),
    );
    const yearGroupHasPrevious =
      yearStart > 1 &&
      Array.from({ length: 12 }, (_, index) =>
        isAllowedYear(yearStart - 12 + index, rules),
      ).some(Boolean);
    const yearGroupHasNext =
      yearStart + 12 <= 9999 &&
      Array.from({ length: 12 }, (_, index) =>
        isAllowedYear(yearStart + 12 + index, rules),
      ).some(Boolean);
    const previousAvailable =
      panelMode === "years"
        ? yearGroupHasPrevious
        : panelMode === "months" || pickerType === "month"
          ? view.year > 1 && isAllowedYear(view.year - 1, rules)
          : view.month === 1
            ? view.year > 1 && monthHasValue(view.year - 1, 12, rules)
            : monthHasValue(view.year, view.month - 1, rules);
    const nextAvailable =
      panelMode === "years"
        ? yearGroupHasNext
        : panelMode === "months" || pickerType === "month"
          ? view.year < 9999 && isAllowedYear(view.year + 1, rules)
          : view.month === 12
            ? view.year < 9999 && monthHasValue(view.year + 1, 1, rules)
            : monthHasValue(view.year, view.month + 1, rules);

    return (
      <div
        ref={root}
        className={`date-picker ${className}${open ? " is-open" : ""}${disabled ? " is-disabled" : ""}${readOnly ? " is-readonly" : ""}`.trim()}
        onBlurCapture={(event) => {
          if (suppressBlurCommit.current) return;
          const next = event.relatedTarget;
          if (
            next instanceof Node &&
            (root.current?.contains(next) || panel.current?.contains(next))
          )
            return;
          if (openRef.current) {
            closePicker(false);
            return;
          }
          queueMicrotask(() => {
            if (
              document.activeElement &&
              (root.current?.contains(document.activeElement) ||
                panel.current?.contains(document.activeElement))
            )
              return;
            if (input.current?.validity.badInput) {
              setError(messages.invalidValue);
              input.current.setCustomValidity(messages.invalidValue);
              return;
            }
            const nextValue = input.current?.value ?? "";
            if (nextValue === lastCommit.current) return;
            if (!validationError(nextValue))
              commit(nextValue, pickerType === "datetime-local", false);
            else if (nextValue || required) updateError(nextValue);
          });
        }}
      >
        <CalendarDays
          className="date-picker-leading-icon"
          size={17}
          aria-hidden="true"
        />
        <input
          {...rest}
          ref={setInputRef}
          className={`date-picker-input${monthValueLabel ? " has-localized-month-value" : ""}`}
          type={pickerType}
          lang={language}
          value={effectiveValue}
          disabled={disabled}
          readOnly={readOnly}
          min={min}
          max={max}
          step={step}
          required={required}
          aria-invalid={Boolean(error) || ariaInvalid || undefined}
          aria-describedby={
            [describedBy, error ? errorId : ""].filter(Boolean).join(" ") ||
            undefined
          }
          onChange={handleInputChange}
          onFocus={onFocus}
          onBlur={handleInputBlur}
          onClick={(event) => {
            onClick?.(event);
            if (!event.defaultPrevented && !disabled && !readOnly) {
              event.preventDefault();
              togglePicker();
            }
          }}
          onKeyDown={handleInputKeyDown}
          onPointerDown={(event) => {
            onPointerDown?.(event);
            if (!event.defaultPrevented && !disabled && !readOnly)
              event.preventDefault();
          }}
        />
        {monthValueLabel && (
          <span className="date-picker-month-value" aria-hidden="true">
            {monthValueLabel}
          </span>
        )}
        <button
          type="button"
          className="date-picker-toggle"
          aria-label={
            pickerType === "month" ? messages.chooseMonth : messages.chooseDate
          }
          aria-expanded={open}
          aria-controls={panelId}
          disabled={disabled || readOnly}
          onClick={togglePicker}
        >
          <ChevronDown size={16} aria-hidden="true" />
        </button>
        {open &&
          portalTarget &&
          createPortal(
            <div
              ref={panel}
              id={panelId}
              className={`date-picker-popover${pickerType === "datetime-local" ? " is-datetime" : ""}`}
              role="dialog"
              aria-label={
                pickerType === "month"
                  ? messages.chooseMonth
                  : messages.chooseDate
              }
              style={
                {
                  top: position.top,
                  left: position.left,
                  "--date-picker-max-height": `${position.maxHeight}px`,
                } as CSSProperties
              }
              inert={disabled || readOnly}
              data-prevent-card-autosave
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={handlePanelKeyDown}
              onBlurCapture={(event) => {
                if (suppressBlurCommit.current) return;
                const next = event.relatedTarget;
                if (
                  next instanceof Node &&
                  (panel.current?.contains(next) ||
                    root.current?.contains(next))
                )
                  return;
                if (openRef.current) closePicker(false);
              }}
            >
              <header className="date-picker-header">
                <button
                  type="button"
                  aria-label={
                    panelMode === "years"
                      ? messages.previousYearGroup
                      : pickerType === "month" || panelMode === "months"
                        ? messages.previousYear
                        : messages.previousMonth
                  }
                  disabled={!previousAvailable || disabled || readOnly}
                  onClick={() => changeView(-1)}
                >
                  <ChevronLeft size={18} aria-hidden="true" />
                </button>
                <div className="date-picker-heading" aria-live="polite">
                  {panelMode === "years" ? (
                    <button
                      type="button"
                      className="date-picker-heading-button"
                      aria-label={messages.chooseYear}
                      aria-expanded={true}
                      aria-controls={panelId}
                      disabled={disabled || readOnly}
                      onClick={() =>
                        setPanelMode(
                          pickerType === "month" ? "months" : "calendar",
                        )
                      }
                    >
                      {messages.yearGroup
                        .replace("{start}", String(yearStart))
                        .replace(
                          "{end}",
                          String(Math.min(yearStart + 11, 9999)),
                        )}
                    </button>
                  ) : pickerType === "month" ? (
                    <button
                      type="button"
                      className="date-picker-heading-button"
                      aria-label={messages.chooseYear}
                      aria-expanded={false}
                      aria-controls={panelId}
                      disabled={disabled || readOnly}
                      onClick={() => {
                        setPanelMode("years");
                        setActiveYear(view.year);
                        setYearInput(String(view.year).padStart(4, "0"));
                      }}
                    >
                      {view.year}
                      {messages.yearSuffix}
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="date-picker-heading-button"
                        aria-label={messages.chooseYear}
                        aria-expanded={false}
                        aria-controls={panelId}
                        disabled={disabled || readOnly}
                        onClick={() => {
                          setPanelMode("years");
                          setActiveYear(view.year);
                          setYearInput(String(view.year).padStart(4, "0"));
                        }}
                      >
                        {view.year}
                        {messages.yearSuffix}
                      </button>
                      <button
                        type="button"
                        className="date-picker-heading-button"
                        aria-label={messages.chooseMonth}
                        aria-expanded={panelMode === "months"}
                        aria-controls={panelId}
                        disabled={disabled || readOnly}
                        onClick={() => {
                          setPanelMode("months");
                          setActiveMonth(isoMonth(view.year, view.month));
                        }}
                      >
                        {monthLabel}
                      </button>
                    </>
                  )}
                </div>
                <button
                  type="button"
                  aria-label={
                    panelMode === "years"
                      ? messages.nextYearGroup
                      : pickerType === "month" || panelMode === "months"
                        ? messages.nextYear
                        : messages.nextMonth
                  }
                  disabled={!nextAvailable || disabled || readOnly}
                  onClick={() => changeView(1)}
                >
                  <ChevronRight size={18} aria-hidden="true" />
                </button>
              </header>

              {businessDayMode === "MANUAL" && (
                <p className="date-picker-business-day" role="note">
                  {messages.manualBusinessDay.replace("{date}", businessDay)}
                </p>
              )}

              {panelMode === "years" && (
                <>
                  <label
                    className="date-picker-year-jump"
                    htmlFor={yearInputId}
                  >
                    <span>{messages.goToYear}</span>
                    <input
                      id={yearInputId}
                      className="date-picker-year-input"
                      type="text"
                      inputMode="numeric"
                      maxLength={4}
                      value={yearInput}
                      aria-describedby={error ? errorId : undefined}
                      onChange={(event) => {
                        const raw = event.target.value;
                        const next = raw.replace(/\D/g, "").slice(0, 4);
                        setYearInput(next);
                        if (/\D/.test(raw) || raw.length > 4) {
                          setError(messages.invalidYear);
                          return;
                        }
                        if (next.length === 4) jumpToYear(Number(next));
                        else setError("");
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          if (yearInput.length === 4)
                            jumpToYear(Number(yearInput));
                          else setError(messages.invalidYear);
                        }
                      }}
                      onBlur={() => {
                        if (yearInput && yearInput.length !== 4)
                          setError(messages.invalidYear);
                      }}
                    />
                    <button
                      type="button"
                      disabled={disabled || readOnly}
                      onClick={() =>
                        yearInput.length === 4
                          ? jumpToYear(Number(yearInput))
                          : setError(messages.invalidYear)
                      }
                    >
                      {messages.go}
                    </button>
                  </label>
                  <div
                    className="date-picker-years"
                    role="grid"
                    aria-label={messages.yearGroup
                      .replace("{start}", String(yearStart))
                      .replace("{end}", String(Math.min(yearStart + 11, 9999)))}
                  >
                    {Array.from(
                      { length: Math.ceil(yearOptions.length / 3) },
                      (_, index) => yearOptions.slice(index * 3, index * 3 + 3),
                    ).map((years, row) => (
                      <div
                        role="row"
                        className="date-picker-grid-row"
                        key={row}
                      >
                        {years.map((year) => {
                          const available = isAllowedYear(year, rules);
                          const selected = selectedMonth?.year === year;
                          const current = businessDate.year === year;
                          return (
                            <button
                              type="button"
                              role="gridcell"
                              key={year}
                              data-year={year}
                              tabIndex={year === activeYear ? 0 : -1}
                              aria-label={`${year}${current ? `, ${messages.currentYear}` : ""}${selected ? `, ${messages.selectedYear}` : ""}${available ? "" : `, ${messages.unavailable}`}`}
                              aria-current={current ? "date" : undefined}
                              aria-selected={selected}
                              className={`${selected ? "is-selected" : ""}${current ? " is-current" : ""}`.trim()}
                              disabled={!available || disabled || readOnly}
                              onClick={() => changeYearFromPanel(year)}
                            >
                              {year}
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                  {!yearOptions.some((year) => isAllowedYear(year, rules)) && (
                    <p className="date-picker-empty">
                      {messages.noAvailableValue}
                    </p>
                  )}
                </>
              )}

              {panelMode === "months" && (
                <div
                  className="date-picker-months"
                  role="grid"
                  aria-label={`${view.year}${messages.yearSuffix}`}
                >
                  {Array.from({ length: 4 }, (_, row) =>
                    monthLabels.slice(row * 3, row * 3 + 3),
                  ).map((months, row) => (
                    <div role="row" className="date-picker-grid-row" key={row}>
                      {months.map((label, index) => {
                        const month = row * 3 + index + 1;
                        const key = isoMonth(view.year, month);
                        const selected =
                          selectedMonth?.year === view.year &&
                          selectedMonth.month === month;
                        const current =
                          businessDate.year === view.year &&
                          businessDate.month === month;
                        const available = monthHasValue(
                          view.year,
                          month,
                          rules,
                        );
                        return (
                          <button
                            type="button"
                            role="gridcell"
                            key={key}
                            data-month={key}
                            tabIndex={key === activeMonth ? 0 : -1}
                            aria-label={`${label}${selected ? `, ${messages.selectedMonth}` : ""}${current ? `, ${messages.currentMonth}` : ""}${available ? "" : `, ${messages.unavailable}`}`}
                            aria-selected={selected}
                            className={`${selected ? "is-selected" : ""}${current ? " is-current" : ""}`.trim()}
                            disabled={!available || disabled || readOnly}
                            onClick={() => chooseMonth(month)}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
              {panelMode === "months" &&
                !monthLabels.some((_, index) =>
                  monthHasValue(view.year, index + 1, rules),
                ) && (
                  <p className="date-picker-empty">
                    {messages.noAvailableValue}
                  </p>
                )}

              {panelMode === "calendar" && pickerType !== "month" && (
                <div className="date-picker-scroll">
                  <div className="date-picker-weekdays" aria-hidden="true">
                    {weekdays.map((label, index) => (
                      <span key={`${label}-${index}`}>{label}</span>
                    ))}
                  </div>
                  <div
                    className="date-picker-days"
                    role="grid"
                    aria-label={`${monthLabel} ${view.year}`}
                  >
                    {Array.from({ length: 6 }, (_, row) =>
                      calendarDays.slice(row * 7, row * 7 + 7),
                    ).map((days, row) => (
                      <div
                        role="row"
                        className="date-picker-grid-row"
                        key={row}
                      >
                        {days.map((day) => {
                          const key = isoDate(day);
                          const inMonth = day.month === view.month;
                          const selected = selectedDate
                            ? key === isoDate(selectedDate)
                            : false;
                          const draftSelected =
                            pickerType === "datetime-local" && draftDate
                              ? key === isoDate(draftDate)
                              : false;
                          const current = key === businessDay;
                          const available =
                            pickerType === "datetime-local"
                              ? hasAllowedDateTimeOnDay(day, rules)
                              : isAllowedValue(key, rules);
                          const fullDate = new Intl.DateTimeFormat(language, {
                            dateStyle: "full",
                          }).format(utcDate(day.year, day.month, day.day));
                          return (
                            <button
                              type="button"
                              role="gridcell"
                              key={key}
                              data-date={key}
                              tabIndex={
                                key === activeDate && available ? 0 : -1
                              }
                              aria-label={`${fullDate}${current ? `, ${messages.today}` : ""}${selected ? `, ${messages.selectedDate}` : ""}${draftSelected && !selected ? `, ${messages.pendingDate}` : ""}${available ? "" : `, ${messages.unavailable}`}`}
                              aria-current={current ? "date" : undefined}
                              aria-selected={selected || draftSelected}
                              className={`${inMonth ? "" : "is-outside"}${selected ? " is-selected" : ""}${draftSelected && !selected ? " is-draft" : ""}${current ? " is-today" : ""}`.trim()}
                              disabled={!available || disabled || readOnly}
                              onClick={() => {
                                if (!inMonth)
                                  setView({ year: day.year, month: day.month });
                                chooseDate(day);
                              }}
                            >
                              {day.day}
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                  {!hasSelectableCalendarDate && (
                    <p className="date-picker-empty">
                      {messages.noAvailableValue}
                    </p>
                  )}
                  {pickerType === "datetime-local" && (
                    <label className="date-picker-time">
                      <span>{messages.time}</span>
                      <input
                        type="time"
                        lang={language}
                        value={draftTime}
                        min={
                          draftDate &&
                          typeof min === "string" &&
                          min.slice(0, 10) === isoDate(draftDate)
                            ? min.slice(11)
                            : undefined
                        }
                        max={
                          draftDate &&
                          typeof max === "string" &&
                          max.slice(0, 10) === isoDate(draftDate)
                            ? max.slice(11)
                            : undefined
                        }
                        step={step ?? 60}
                        disabled={disabled || readOnly || !draftDate}
                        aria-invalid={Boolean(draftError) || undefined}
                        onChange={(event) => {
                          if (!draftDate) return;
                          if (!event.target.value) {
                            setDraftValue(`${isoDate(draftDate)}T`);
                            setError(messages.timeRequired);
                            return;
                          }
                          dateTimeValue(isoDate(draftDate), event.target.value);
                        }}
                      />
                    </label>
                  )}
                </div>
              )}

              {error && (
                <p className="date-picker-error" role="alert">
                  {error}
                </p>
              )}
              <footer className="date-picker-footer">
                {pickerType !== "datetime-local" && !required && (
                  <button
                    type="button"
                    className="date-picker-clear"
                    disabled={disabled || readOnly}
                    onClick={clearValue}
                  >
                    <Trash2 size={15} aria-hidden="true" /> {messages.clear}
                  </button>
                )}
                {pickerType === "datetime-local" && !required && (
                  <button
                    type="button"
                    className="date-picker-clear"
                    disabled={disabled || readOnly}
                    onClick={clearValue}
                  >
                    <Trash2 size={15} aria-hidden="true" />{" "}
                    {messages.clearDateTime}
                  </button>
                )}
                {pickerType === "date" &&
                  quickDays.map((offset) => {
                    const target = isoDate(addDays(businessDate, offset));
                    const label =
                      offset === 0
                        ? messages.today
                        : offset === 1
                          ? messages.tomorrow
                          : messages.daysAfter.replace(
                              "{days}",
                              String(offset),
                            );
                    return (
                      <button
                        type="button"
                        className={
                          offset === 0 ? "date-picker-today" : undefined
                        }
                        key={offset}
                        disabled={
                          !isAllowedValue(target, rules) || disabled || readOnly
                        }
                        onClick={() => commit(target, true)}
                      >
                        {label}
                      </button>
                    );
                  })}
                {pickerType === "month" && (
                  <>
                    <button
                      type="button"
                      className="date-picker-today"
                      disabled={
                        !isAllowedValue(
                          isoMonth(businessDate.year, businessDate.month),
                          rules,
                        ) ||
                        disabled ||
                        readOnly
                      }
                      onClick={() =>
                        commit(
                          isoMonth(businessDate.year, businessDate.month),
                          true,
                        )
                      }
                    >
                      {messages.thisMonth}
                    </button>
                    {(() => {
                      const previous = shiftMonth(
                        businessDate.year,
                        businessDate.month,
                        -1,
                      );
                      const value = isoMonth(previous.year, previous.month);
                      return (
                        <button
                          type="button"
                          disabled={
                            !isAllowedValue(value, rules) ||
                            disabled ||
                            readOnly
                          }
                          onClick={() => commit(value, true)}
                        >
                          {messages.previousMonthShortcut}
                        </button>
                      );
                    })()}
                  </>
                )}
                {pickerType === "datetime-local" &&
                  quickTimes.map((time) => {
                    const targetDate = draftDate
                      ? isoDate(draftDate)
                      : businessDay;
                    const target = `${targetDate}T${time}`;
                    return (
                      <button
                        type="button"
                        key={time}
                        disabled={
                          !isAllowedValue(target, rules) ||
                          disabled ||
                          readOnly ||
                          !draftDate
                        }
                        onClick={() => dateTimeValue(targetDate, time)}
                      >
                        {time}
                      </button>
                    );
                  })}
                {pickerType === "datetime-local" && (
                  <>
                    <button
                      type="button"
                      disabled={
                        disabled ||
                        readOnly ||
                        !hasAllowedDateTimeOnDay(businessDate, rules)
                      }
                      onClick={() => {
                        const date = isoDate(businessDate);
                        setDraftDate(businessDate);
                        setActiveDate(date);
                      }}
                    >
                      {messages.today}
                    </button>
                    <button
                      type="button"
                      disabled={
                        disabled || readOnly || !isAllowedValue(nowValue, rules)
                      }
                      onClick={() => {
                        setDraftValue(nowValue);
                        setHasDraft(true);
                        const date = dateParts(nowValue);
                        if (date) {
                          setViewToDate(date);
                          setPanelMode("calendar");
                        }
                        updateError(nowValue);
                      }}
                    >
                      {messages.now}
                    </button>
                    <span className="date-picker-footer-spacer" />
                    <button
                      type="button"
                      disabled={disabled || readOnly}
                      onClick={() => closePicker(true)}
                    >
                      {messages.cancel}
                    </button>
                    <button
                      type="button"
                      className="date-picker-confirm"
                      disabled={disabled || readOnly || Boolean(draftError)}
                      onClick={() => commit(draftValue, true)}
                    >
                      {messages.confirm}
                    </button>
                  </>
                )}
              </footer>
            </div>,
            portalTarget,
          )}
        {error && (
          <span id={errorId} className="sr-only" aria-live="polite">
            {error}
          </span>
        )}
      </div>
    );
  },
);
