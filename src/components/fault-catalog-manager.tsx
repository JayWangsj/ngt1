"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, GripVertical, Plus, Search, Trash2 } from "lucide-react";
import {
  deleteFaultAction,
  reorderFaultsAction,
  saveFaultAction,
} from "@/app/actions";
import { categories, type Category } from "@/lib/catalog";
import { useLanguage, useMessages } from "./language";
import { DialogBody, DialogFooter, FormDialog } from "./forms";
import { SimpleSelect } from "./business-select";
import { Button } from "./ui/button";
import { ToggleSwitch } from "./ui/toggle-switch";
import { focusComfortably } from "@/lib/comfortable-scroll";

export type FaultCatalogItem = {
  id: string;
  category: string;
  name: string;
  note: string;
  hidden: boolean;
  sortOrder: number;
  usageCount: number;
};

function normalized(value: string) {
  return value.trim().toLocaleLowerCase("it");
}

function similarity(a: string, b: string) {
  const left = normalized(a);
  const right = normalized(b);
  if (!left || !right) return 0;
  const table = Array.from({ length: left.length + 1 }, (_, i) =>
    Array.from({ length: right.length + 1 }, (_, j) => (i ? (j ? 0 : i) : j)),
  );
  for (let i = 1; i <= left.length; i++)
    for (let j = 1; j <= right.length; j++)
      table[i][j] = Math.min(
        table[i - 1][j] + 1,
        table[i][j - 1] + 1,
        table[i - 1][j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
  return (
    1 - table[left.length][right.length] / Math.max(left.length, right.length)
  );
}

export function findSimilarFault(
  name: string,
  items: Pick<FaultCatalogItem, "id" | "name">[],
) {
  const exact = items.find(
    (item) => normalized(item.name) === normalized(name),
  );
  if (exact) return { kind: "exact" as const, item: exact };
  const similar = items
    .map((item) => ({ item, score: similarity(name, item.name) }))
    .sort((a, b) => b.score - a.score)[0];
  return similar && similar.score >= 0.72
    ? { kind: "similar" as const, item: similar.item }
    : null;
}

export function FaultCatalogManager({
  items,
  initialCategory = "PHONE",
  triggerLabel,
  onChanged,
  embedded = false,
}: {
  items: FaultCatalogItem[];
  initialCategory?: string;
  triggerLabel?: string;
  onChanged?: (items: FaultCatalogItem[]) => void;
  embedded?: boolean;
}) {
  const it = useMessages();
  const { locale } = useLanguage();
  const router = useRouter();
  const [category, setCategory] = useState(initialCategory);
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState(items);
  const [query, setQuery] = useState("");
  const [settledQuery, setSettledQuery] = useState("");
  const [editingId, setEditingId] = useState("");
  const [editingName, setEditingName] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [dragId, setDragId] = useState("");
  const savingName = useRef(false);
  const cancellingName = useRef(false);
  const editingInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editingId) return;
    const frame = requestAnimationFrame(() =>
      focusComfortably(editingInput.current, { select: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, [editingId]);
  const searchRequest = useRef(0);
  const scoped = useMemo(
    () =>
      drafts
        .filter((item) => item.category === category)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [category, drafts],
  );
  const visible = scoped.filter((item) =>
    item.name
      .toLocaleLowerCase("it")
      .includes(settledQuery.trim().toLocaleLowerCase("it")),
  );
  const [stableCanAdd, setStableCanAdd] = useState(false);
  const canAdd = stableCanAdd && !pending;

  function search(next: string) {
    setQuery(next);
    const request = ++searchRequest.current;
    if (!next.trim()) {
      setSettledQuery("");
      setStableCanAdd(false);
      return;
    }
    window.setTimeout(() => {
      if (request !== searchRequest.current) return;
      setSettledQuery(next);
      setStableCanAdd(
        !scoped.some((item) =>
          normalized(item.name).includes(normalized(next)),
        ),
      );
    }, 80);
  }

  function publish(next: FaultCatalogItem[]) {
    setDrafts(next);
    onChanged?.(next);
    router.refresh();
  }

  function openManager() {
    setDrafts(items);
    setQuery("");
    setSettledQuery("");
    searchRequest.current += 1;
    setStableCanAdd(false);
    setEditingId("");
    setError("");
    setOpen(true);
  }

  function closeManager() {
    searchRequest.current += 1;
    setEditingId("");
    setError("");
    setOpen(false);
  }

  async function createFault() {
    const name = query.trim();
    if (!name || pending) return;
    if (scoped.some((item) => normalized(item.name) === normalized(name))) {
      setError(it.faultAlreadyExists);
      return;
    }
    if (scoped.some((item) => normalized(item.name).includes(normalized(name))))
      return;
    setPending(true);
    setError("");
    const result = await saveFaultAction(null, {
      category,
      name,
      note: "",
      hidden: false,
    });
    setPending(false);
    if (!result.ok || !result.id)
      return setError(result.ok ? it.connectionError : result.error);
    const next = [
      ...drafts,
      {
        id: result.id,
        category,
        name,
        note: "",
        hidden: false,
        sortOrder: scoped.length,
        usageCount: 0,
      },
    ];
    setQuery("");
    setSettledQuery("");
    setStableCanAdd(false);
    searchRequest.current += 1;
    publish(next);
  }

  async function saveName(item: FaultCatalogItem) {
    if (cancellingName.current) {
      cancellingName.current = false;
      return;
    }
    if (savingName.current) return;
    const name = editingName.trim();
    if (!name) return setError(it.validationError);
    if (
      scoped.some(
        (candidate) =>
          candidate.id !== item.id &&
          normalized(candidate.name) === normalized(name),
      )
    )
      return setError(it.faultAlreadyExists);
    if (name === item.name) return setEditingId("");
    savingName.current = true;
    setPending(true);
    setError("");
    const result = await saveFaultAction(item.id, { ...item, name });
    savingName.current = false;
    setPending(false);
    if (!result.ok) return setError(result.error);
    setEditingId("");
    publish(
      drafts.map((candidate) =>
        candidate.id === item.id ? { ...candidate, name } : candidate,
      ),
    );
  }

  async function toggle(item: FaultCatalogItem) {
    if (pending) return;
    const previous = drafts;
    const next = drafts.map((candidate) =>
      candidate.id === item.id
        ? { ...candidate, hidden: !candidate.hidden }
        : candidate,
    );
    setDrafts(next);
    setPending(true);
    setError("");
    const result = await saveFaultAction(item.id, {
      ...item,
      hidden: !item.hidden,
    });
    setPending(false);
    if (!result.ok) {
      setDrafts(previous);
      setError(result.error);
      return;
    }
    onChanged?.(next);
    router.refresh();
  }

  async function remove(item: FaultCatalogItem) {
    if (pending) return;
    if (!window.confirm(it.permanentFaultDeleteConfirm)) return;
    setPending(true);
    setError("");
    const result = await deleteFaultAction(item.id);
    setPending(false);
    if (!result.ok) return setError(result.error);
    publish(drafts.filter((candidate) => candidate.id !== item.id));
  }

  async function move(id: string, targetId: string) {
    const from = scoped.findIndex((item) => item.id === id);
    const to = scoped.findIndex((item) => item.id === targetId);
    if (from < 0 || to < 0 || from === to) return;
    const reordered = [...scoped];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    const previous = drafts;
    const ordered = reordered.map((item, sortOrder) => ({
      ...item,
      sortOrder,
    }));
    const next = [
      ...drafts.filter((item) => item.category !== category),
      ...ordered,
    ];
    setDrafts(next);
    const result = await reorderFaultsAction(
      category,
      ordered.map((item) => item.id),
    );
    if (!result.ok) {
      setDrafts(previous);
      setError(result.error);
      return;
    }
    onChanged?.(next);
    router.refresh();
  }

  const managerContent = (
    <>
      {embedded && (
        <SimpleSelect
          value={category}
          onChange={(nextCategory) => {
            setCategory(nextCategory);
            setQuery("");
            setSettledQuery("");
            setEditingId("");
            setError("");
          }}
          placeholder={it.deviceType}
          ariaLabel={it.deviceType}
          options={Object.entries(categories).map(([value, labels]) => ({
            value,
            label: labels[locale === "zh" ? 1 : 0],
          }))}
        />
      )}
      <div className="catalog-toolbar fault-manager-toolbar">
        <label className="fault-search">
          <Search size={15} />
          <input
            value={query}
            placeholder={it.faultSearch}
            onChange={(event) => {
              search(event.target.value);
              setError("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void createFault();
              }
            }}
          />
        </label>
        <Button
          type="button"
          variant="outline"
          disabled={!canAdd}
          onClick={() => void createFault()}
        >
          <Plus size={16} /> {it.addFault}
        </Button>
      </div>
      <div className="fault-manager-list" role="table">
        <div className="fault-manager-header" role="row">
          <span aria-hidden="true" />
          <span>{it.faultName}</span>
          <span className="fault-manager-status">{it.statusLabel}</span>
          <span aria-hidden="true" />
        </div>
        {visible.map((item) => (
          <div
            className="fault-manager-row"
            key={item.id}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              void move(dragId, item.id);
              setDragId("");
            }}
          >
            <span
              className="fault-drag-handle"
              draggable
              onDragStart={() => setDragId(item.id)}
            >
              <GripVertical size={16} aria-hidden="true" />
            </span>
            {editingId === item.id ? (
              <input
                ref={editingInput}
                className="fault-inline-name"
                maxLength={120}
                value={editingName}
                onChange={(event) => setEditingName(event.target.value)}
                onBlur={() => void saveName(item)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void saveName(item);
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    cancellingName.current = true;
                    setEditingName(item.name);
                    setEditingId("");
                    setError("");
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className="fault-name-button"
                onClick={() => {
                  cancellingName.current = false;
                  setEditingId(item.id);
                  setEditingName(item.name);
                  setError("");
                }}
              >
                {item.name}
              </button>
            )}
            <ToggleSwitch
              checked={!item.hidden}
              onToggle={() => toggle(item)}
              enabledLabel={it.enabledState}
              disabledLabel={it.disabledState}
            />
            <button
              type="button"
              className="fault-delete-button"
              aria-label={`${it.remove} ${item.name}`}
              onClick={() => void remove(item)}
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>
      <p className="fault-drag-hint">{it.faultDragHint}</p>
      {error && <p className="message error">{error}</p>}
    </>
  );
  const manager = embedded ? (
    <div className="fault-manager settings-inline-manager">
      {managerContent}
    </div>
  ) : (
    <DialogBody className="fault-manager">{managerContent}</DialogBody>
  );

  return (
    <>
      {!embedded && (
        <button
          type="button"
          className="fault-manager-trigger"
          onClick={openManager}
        >
          <span>{triggerLabel ?? it.manageFaults}</span>
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      )}
      {embedded
        ? manager
        : open && (
            <FormDialog
              title={it.manageFaults}
              subtitle={it.manageFaultsFor.replace(
                "{device}",
                categories[category as Category]?.[locale === "zh" ? 1 : 0] ??
                  category,
              )}
              onClose={closeManager}
            >
              {manager}
              <DialogFooter>
                <Button type="button" variant="cancel" onClick={closeManager}>
                  {it.close}
                </Button>
              </DialogFooter>
            </FormDialog>
          )}
    </>
  );
}
