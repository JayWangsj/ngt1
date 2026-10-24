"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { ChevronDown, Plus, Trash2 } from "lucide-react";
import {
  deleteQuickServiceAction,
  renameDeviceModelAction,
  saveQuickServiceAction,
} from "@/app/actions";
import { modelKey, normalizeDeviceModel } from "@/lib/catalog";
import { cents, decimal } from "@/lib/domain";
import { useMessages } from "./language";
import { Button } from "./ui/button";
import { ToggleSwitch } from "./ui/toggle-switch";
import {
  DialogBody,
  DialogFooter,
  DialogForm,
  Field,
  FormDialog,
} from "./forms";
import { RecordIcon } from "./ui/record-icon";
import settingsInlineManagerStyles from "./settings-inline-manager.module.css";

export type QuickServiceView = {
  id: string;
  name: string;
  defaultPrice: number;
  notes: string;
  enabled: boolean;
};

export type SavedModelView = {
  category: string;
  brand: string;
  model: string;
};

export function QuickServiceEditor({
  item,
  onSaved,
  onCancel,
}: {
  item?: QuickServiceView;
  onSaved: (item: QuickServiceView) => void;
  onCancel: () => void;
}) {
  const it = useMessages();
  const [draft, setDraft] = useState<QuickServiceView>(
    item ?? {
      id: "",
      name: "",
      defaultPrice: 0,
      notes: "",
      enabled: true,
    },
  );
  const [priceDraft, setPriceDraft] = useState(
    decimal(item?.defaultPrice ?? 0),
  );
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const unchanged =
    item !== undefined &&
    draft.name === item.name &&
    priceDraft === decimal(item.defaultPrice) &&
    draft.notes === item.notes;

  function save() {
    if (unchanged || pending) return;
    startTransition(async () => {
      const result = await saveQuickServiceAction(draft.id || null, {
        name: draft.name,
        defaultPrice: priceDraft,
        notes: draft.notes,
        enabled: draft.enabled,
      });
      if (!result.ok || !result.id)
        return setError(result.ok ? it.connectionError : result.error);
      onSaved({
        ...draft,
        id: result.id,
        defaultPrice: cents(priceDraft),
      });
    });
  }

  return (
    <DialogForm
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <DialogBody>
        <Field label={it.quickService.name}>
          <input
            value={draft.name}
            maxLength={120}
            required
            onChange={(event) =>
              setDraft({ ...draft, name: event.target.value })
            }
          />
        </Field>
        <Field label={it.quickService.defaultPrice}>
          <input
            value={priceDraft}
            inputMode="decimal"
            required
            onChange={(event) => setPriceDraft(event.target.value)}
          />
        </Field>
        <Field label={it.quickService.notes}>
          <textarea
            value={draft.notes}
            maxLength={2000}
            onChange={(event) =>
              setDraft({ ...draft, notes: event.target.value })
            }
          />
        </Field>
        {error && <p className="message error">{error}</p>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="cancel" onClick={onCancel}>
          {it.cancel}
        </Button>
        <Button disabled={pending || unchanged}>{it.save}</Button>
      </DialogFooter>
    </DialogForm>
  );
}

export function QuickServiceManager({ items }: { items: QuickServiceView[] }) {
  const it = useMessages();
  const [drafts, setDrafts] = useState(items);
  const [editing, setEditing] = useState<QuickServiceView | null>(null);
  const [deleting, setDeleting] = useState<QuickServiceView | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  function editor(item?: QuickServiceView) {
    setEditing(
      item ?? {
        id: "",
        name: "",
        defaultPrice: 0,
        notes: "",
        enabled: true,
      },
    );
  }

  async function toggle(item: QuickServiceView) {
    if (pending) return;
    const previous = drafts;
    const next = drafts.map((candidate) =>
      candidate.id === item.id
        ? { ...candidate, enabled: !candidate.enabled }
        : candidate,
    );
    setDrafts(next);
    setPending(true);
    setError("");
    const result = await saveQuickServiceAction(item.id, {
      name: item.name,
      defaultPrice: decimal(item.defaultPrice),
      notes: item.notes,
      enabled: !item.enabled,
    });
    setPending(false);
    if (!result.ok) {
      setDrafts(previous);
      setError(result.error);
    }
  }

  async function remove() {
    if (!deleting || pending) return;
    setPending(true);
    setError("");
    const result = await deleteQuickServiceAction(deleting.id);
    setPending(false);
    if (!result.ok) return setError(result.error);
    setDrafts((current) => current.filter((item) => item.id !== deleting.id));
    setDeleting(null);
  }

  return (
    <>
      <div
        className={`catalog-manager settings-inline-manager ${settingsInlineManagerStyles.manager}`}
      >
        {drafts.length ? (
          <div className="catalog-manager-list">
            {drafts.map((item) => (
              <div
                className="catalog-manager-row business-list-row"
                key={item.id}
                onClick={() => editor(item)}
              >
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.notes || "—"}</small>
                </span>
                <span>{decimal(item.defaultPrice)}</span>
                <span onClick={(event) => event.stopPropagation()}>
                  <ToggleSwitch
                    checked={item.enabled}
                    disabled={pending}
                    onToggle={() => toggle(item)}
                    enabledLabel={it.enabledState}
                    disabledLabel={it.disabledState}
                  />
                </span>
                <span className="record-actions">
                  <RecordIcon
                    kind="edit"
                    label={`${it.edit} ${item.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      editor(item);
                    }}
                  />
                  <RecordIcon
                    kind="delete"
                    label={`${it.quickService.delete} ${item.name}`}
                    disabled={pending}
                    onClick={(event) => {
                      event.stopPropagation();
                      setError("");
                      setDeleting(item);
                    }}
                  />
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">{it.quickService.noServices}</p>
        )}
        <button
          type="button"
          className="quick-service-service-add"
          onClick={() => editor()}
        >
          <Plus size={18} /> {it.quickService.new}
        </button>
        {error && !deleting && (
          <p className="message error" role="alert">
            {error}
          </p>
        )}
      </div>
      {editing && (
        <FormDialog
          title={editing.id ? it.edit : it.quickService.new}
          onClose={() => setEditing(null)}
        >
          <QuickServiceEditor
            item={editing}
            onCancel={() => setEditing(null)}
            onSaved={(saved) => {
              setDrafts((current) =>
                [
                  ...current.filter((entry) => entry.id !== saved.id),
                  saved,
                ].sort((a, b) => a.name.localeCompare(b.name)),
              );
              setEditing(null);
            }}
          />
        </FormDialog>
      )}
      {deleting && (
        <FormDialog
          title={it.quickService.delete}
          onClose={() => {
            if (!pending) {
              setError("");
              setDeleting(null);
            }
          }}
        >
          <DialogBody className="confirm-delete-dialog" aria-busy={pending}>
            <div className="confirm-delete-icon" aria-hidden="true">
              <Trash2 size={22} />
            </div>
            <p>{it.quickService.deleteConfirm}</p>
            {error && (
              <p className="message error" role="alert">
                {error}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="cancel"
              disabled={pending}
              onClick={() => {
                setError("");
                setDeleting(null);
              }}
            >
              {it.cancel}
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={pending}
              onClick={remove}
            >
              {it.quickService.delete}
            </Button>
          </DialogFooter>
        </FormDialog>
      )}
    </>
  );
}

export function DeviceModelManager({ items }: { items: SavedModelView[] }) {
  const it = useMessages();
  const [drafts, setDrafts] = useState(items);
  const [editing, setEditing] = useState<SavedModelView | null>(null);
  const [replacement, setReplacement] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const editingInput = useRef<HTMLInputElement>(null);
  const cancelling = useRef(false);
  const groups = useMemo(() => {
    const grouped = new Map<string, SavedModelView[]>();
    for (const item of drafts) {
      const key = `${item.brand}\u0000${item.category}`;
      grouped.set(key, [...(grouped.get(key) ?? []), item]);
    }
    return [...grouped.entries()]
      .map(([key, groupItems]) => ({
        key,
        brand: groupItems[0].brand,
        category: groupItems[0].category,
        items: groupItems.sort((a, b) =>
          a.model.localeCompare(b.model, undefined, { numeric: true }),
        ),
      }))
      .sort((a, b) =>
        `${a.brand} ${a.category}`.localeCompare(`${b.brand} ${b.category}`),
      );
  }, [drafts]);

  useEffect(() => {
    if (!editing) return;
    const frame = requestAnimationFrame(() => {
      editingInput.current?.focus();
      editingInput.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [editing]);

  function save() {
    if (cancelling.current) {
      cancelling.current = false;
      return;
    }
    if (!editing || !replacement.trim()) return;
    const nextModel = normalizeDeviceModel(editing.brand, replacement);
    const duplicate = drafts.some(
      (item) =>
        item !== editing &&
        item.category === editing.category &&
        item.brand.toLocaleLowerCase("it") ===
          editing.brand.toLocaleLowerCase("it") &&
        modelKey(item.model) === modelKey(nextModel),
    );
    if (duplicate) {
      setError(it.modelCatalog.duplicate);
      return;
    }
    if (nextModel === editing.model) {
      setEditing(null);
      return;
    }
    startTransition(async () => {
      const result = await renameDeviceModelAction({
        ...editing,
        from: editing.model,
        to: nextModel,
      });
      if (!result.ok) return setError(result.error);
      setDrafts((current) =>
        current.map((item) =>
          item.category === editing.category &&
          item.brand === editing.brand &&
          item.model === editing.model
            ? { ...item, model: nextModel }
            : item,
        ),
      );
      setEditing(null);
      setReplacement("");
    });
  }

  return (
    <div
      className={`model-manager settings-inline-manager ${settingsInlineManagerStyles.manager}`}
    >
      {groups.map((group) => (
        <section key={group.key}>
          <button
            type="button"
            className="model-group-heading"
            aria-expanded={!collapsed.has(group.key)}
            onClick={() =>
              setCollapsed((current) => {
                const next = new Set(current);
                if (next.has(group.key)) next.delete(group.key);
                else next.add(group.key);
                return next;
              })
            }
          >
            <span>
              <strong>{group.brand}</strong>
            </span>
            <ChevronDown size={17} aria-hidden="true" />
          </button>
          {!collapsed.has(group.key) && (
            <div className="model-group-items">
              {group.items.map((item) =>
                editing === item ? (
                  <input
                    ref={editingInput}
                    className="model-inline-name"
                    key={`${item.category}:${item.model}`}
                    value={replacement}
                    disabled={pending}
                    aria-label={it.modelCatalog.replacement}
                    onChange={(event) => {
                      setReplacement(event.target.value);
                      setError("");
                    }}
                    onBlur={save}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        cancelling.current = true;
                        setEditing(null);
                        setError("");
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="model-name-button"
                    key={`${item.category}:${item.model}`}
                    onClick={() => {
                      cancelling.current = false;
                      setEditing(item);
                      setReplacement(item.model);
                      setError("");
                    }}
                  >
                    {item.model}
                  </button>
                ),
              )}
            </div>
          )}
        </section>
      ))}
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
