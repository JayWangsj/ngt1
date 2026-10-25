"use client";
import { useMessages } from "./language";
import { uniqueOptions } from "@/lib/options";
import { SearchableCombobox } from "./business-select";
import { Trash2 } from "lucide-react";
import styles from "./editable-select.module.css";
export function EditableSelect({
  label,
  value,
  onChange,
  options,
  required = false,
  readOnly = false,
  name,
  maxLength = 120,
  normalize,
  createLabel,
  deletableValues = [],
  onDelete,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: (string | { value: string; label: string })[];
  required?: boolean;
  readOnly?: boolean;
  name?: string;
  maxLength?: number;
  normalize?: (value: string) => string;
  createLabel?: string;
  deletableValues?: string[];
  onDelete?: (value: string) => void | Promise<void>;
}) {
  const it = useMessages();
  const normalized = options.map((o) =>
    typeof o === "string" ? { value: o, label: o } : o,
  );
  const unique = uniqueOptions(normalized.map((o) => o.value));
  const choices = unique.map((option) => ({
    value: option,
    label:
      normalized.find(
        (item) => item.value.toLowerCase() === option.toLowerCase(),
      )?.label ?? option,
    trailing: deletableValues.some((value) => value === option) ? (
      <button
        type="button"
        className="option-delete"
        aria-label={`${it.remove} ${option}`}
        onPointerDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.stopPropagation();
          void onDelete?.(option);
        }}
      >
        <Trash2 size={14} />
      </button>
    ) : undefined,
  }));
  if (value && !choices.some((option) => option.value === value))
    choices.unshift({ value, label: value, trailing: undefined });
  return (
    <div className={`${styles.editableField} editable-field`}>
      <label>{label}</label>
      <SearchableCombobox
        name={name}
        value={value}
        onChange={(next) => onChange(normalize ? normalize(next) : next)}
        groups={[{ options: choices }]}
        disabled={readOnly}
        placeholder={it.manualEntry}
        ariaLabel={label}
        searchPlaceholder={it.manualEntry}
        emptyText={it.noMatches}
        customLabel={createLabel ?? it.newValue}
        creationControls="no-match"
        onCustom={(next) => {
          if (!required || next) {
            const trimmed = next.slice(0, maxLength);
            onChange(normalize ? normalize(trimmed) : trimmed);
          }
        }}
      />
    </div>
  );
}
