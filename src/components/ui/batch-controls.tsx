"use client";

import { ListChecks, Trash2, X } from "lucide-react";
import { Button } from "./button";

export function BatchControls({
  active,
  pending,
  selectedCount,
  deleteDisabled = false,
  hasItems,
  manageLabel,
  selectedLabel,
  selectAllLabel,
  showSelectAll = true,
  deleteLabel,
  finishLabel,
  onStart,
  onSelectAll,
  onDelete,
  onFinish,
}: {
  active: boolean;
  pending: boolean;
  selectedCount: number;
  deleteDisabled?: boolean;
  hasItems: boolean;
  manageLabel: string;
  selectedLabel: string;
  selectAllLabel: string;
  showSelectAll?: boolean;
  deleteLabel: string;
  finishLabel: string;
  onStart: () => void;
  onSelectAll: () => void;
  onDelete: () => void;
  onFinish: () => void;
}) {
  if (!active)
    return (
      <Button
        variant="ghost"
        className="batch-control-button"
        aria-pressed="false"
        disabled={pending}
        onClick={onStart}
      >
        <ListChecks size={17} aria-hidden="true" />
        {manageLabel}
      </Button>
    );

  return (
    <>
      <span className="inventory-selected-count" role="status">
        {selectedLabel}
      </span>
      {showSelectAll && (
        <Button
          variant="ghost"
          className="batch-control-button"
          disabled={pending || !hasItems}
          onClick={onSelectAll}
        >
          {selectAllLabel}
        </Button>
      )}
      <Button
        variant="danger"
        className="batch-control-button batch-control-danger"
        disabled={!selectedCount || pending || deleteDisabled}
        onClick={onDelete}
      >
        <Trash2 size={17} aria-hidden="true" />
        {deleteLabel}
      </Button>
      <Button
        variant="ghost"
        className="batch-control-button batch-control-finish"
        disabled={pending}
        onClick={onFinish}
      >
        <X size={17} aria-hidden="true" />
        {finishLabel}
      </Button>
    </>
  );
}
