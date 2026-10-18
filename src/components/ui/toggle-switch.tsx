"use client";

import { useState } from "react";

export function ToggleSwitch({
  checked,
  onToggle,
  enabledLabel,
  disabledLabel,
  ariaLabel,
  title,
  disabled,
  className = "",
  role,
}: {
  checked: boolean;
  onToggle: (checked: boolean) => void | boolean | Promise<void | boolean>;
  enabledLabel: string;
  disabledLabel: string;
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
  className?: string;
  role?: "switch";
}) {
  const [visualState, setVisualState] = useState({ checked, source: checked });
  if (visualState.source !== checked)
    setVisualState({ checked, source: checked });
  const visualChecked =
    visualState.source === checked ? visualState.checked : checked;

  return (
    <label className={`toggle-switch fault-enabled-switch ${className}`.trim()}>
      <input
        type="checkbox"
        role={role}
        checked={visualChecked}
        disabled={disabled}
        aria-label={ariaLabel}
        title={title}
        onChange={(event) => {
          const next = event.target.checked;
          setVisualState({ checked: next, source: checked });
          Promise.resolve(onToggle(next))
            .then((saved) => {
              if (saved === false) setVisualState({ checked, source: checked });
            })
            .catch(() => setVisualState({ checked, source: checked }));
        }}
      />
      <span className="toggle-switch-track" aria-hidden="true">
        <span className="toggle-switch-thumb" />
      </span>
      <span>{visualChecked ? enabledLabel : disabledLabel}</span>
    </label>
  );
}
