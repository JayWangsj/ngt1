"use client";

import { Minus, Plus } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import styles from "./quantity-stepper.module.css";

type QuantityStepperProps = {
  name?: string;
  ariaLabel: string;
  buttonLabel?: string;
  value?: string | number;
  defaultValue?: string | number;
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  onValueChange?: (value: string) => void;
  onCommit?: (value: number) => void;
};

function decimalPlaces(value: number) {
  return value.toString().split(".")[1]?.length ?? 0;
}

export function QuantityStepper({
  name,
  ariaLabel,
  buttonLabel = ariaLabel,
  value,
  defaultValue = 0,
  min,
  max,
  step = 1,
  required = false,
  disabled = false,
  className = "",
  onValueChange,
  onCommit,
}: QuantityStepperProps) {
  const [internalValue, setInternalValue] = useState(String(defaultValue));
  const current = value === undefined ? internalValue : String(value);
  const parsed = Number(current);
  const currentNumber =
    current.trim() !== "" && Number.isFinite(parsed) ? parsed : null;

  function update(next: string) {
    if (value === undefined) setInternalValue(next);
    onValueChange?.(next);
  }

  function normalize(candidate: number) {
    const bounded = Math.min(
      max ?? Infinity,
      Math.max(min ?? -Infinity, candidate),
    );
    return Number(bounded.toFixed(decimalPlaces(step)));
  }

  function commit(fallback = min ?? 0) {
    const next = normalize(currentNumber ?? fallback);
    update(String(next));
    onCommit?.(next);
  }

  function adjust(direction: -1 | 1) {
    const base = currentNumber ?? min ?? 0;
    const next = normalize(base + direction * step);
    update(String(next));
    onCommit?.(next);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") commit();
  }

  const atMin =
    min !== undefined && currentNumber !== null && currentNumber <= min;
  const atMax =
    max !== undefined && currentNumber !== null && currentNumber >= max;

  return (
    <div className={`number-stepper ${className}`.trim()}>
      <button
        type="button"
        aria-label={`- ${buttonLabel}`}
        disabled={disabled || atMin}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => adjust(-1)}
      >
        <Minus size={16} aria-hidden="true" />
      </button>
      <input
        className={styles.input}
        name={name}
        aria-label={ariaLabel}
        type="number"
        inputMode={Number.isInteger(step) ? "numeric" : "decimal"}
        value={current}
        min={min}
        max={max}
        step={step}
        required={required}
        disabled={disabled}
        onChange={(event) => update(event.target.value)}
        onBlur={() => commit()}
        onKeyDown={handleKeyDown}
      />
      <button
        type="button"
        aria-label={`+ ${buttonLabel}`}
        disabled={disabled || atMax}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => adjust(1)}
      >
        <Plus size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
