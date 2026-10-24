import type { ReactNode } from "react";
import { BackButton, PageHeader } from "./common";
import styles from "./settings-page-shell.module.css";

export function SettingsPageShell({
  title,
  description,
  backLabel,
  children,
}: {
  title: string;
  description: string;
  backLabel: string;
  children: ReactNode;
}) {
  return (
    <div className={`settings-detail-page ${styles.page}`}>
      <BackButton href="/settings" label={backLabel} />
      <PageHeader title={title} description={description} />
      {children}
    </div>
  );
}
