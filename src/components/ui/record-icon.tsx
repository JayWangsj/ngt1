import { Pencil, Trash2 } from "lucide-react";
import { Button } from "./button";
import type { ComponentProps } from "react";
import styles from "./record-icon.module.css";
export function RecordIcon({
  kind,
  label,
  className = "",
  ...props
}: Omit<ComponentProps<typeof Button>, "children"> & {
  kind: "edit" | "delete";
  label: string;
}) {
  const Icon = kind === "edit" ? Pencil : Trash2;
  return (
    <Button
      type="button"
      variant="ghost"
      {...props}
      className={`${styles.icon} record-icon record-icon-${kind} ${className}`.trim()}
      aria-label={label}
      title={label}
    >
      <Icon size={18} aria-hidden="true" />
    </Button>
  );
}
