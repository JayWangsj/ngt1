"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { DialogBody, FormDialog } from "./forms";

export function CustomerDetailDialog({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const [closing, setClosing] = useState(false);
  if (closing) return null;
  return (
    <FormDialog
      title={title}
      onClose={() => {
        setClosing(true);
        router.back();
      }}
    >
      <DialogBody className="customer-detail-dialog">{children}</DialogBody>
    </FormDialog>
  );
}
