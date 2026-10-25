"use client";

import { useState } from "react";
import { Check, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { ruleAction } from "@/app/actions";
import { categories, modelKey } from "@/lib/catalog";
import { uniqueOptions } from "@/lib/options";
import { useLanguage, useMessages } from "./language";
import { EditableSelect } from "./editable-select";
import { SimpleSelect } from "./business-select";
import { DialogBody, DialogFooter, FormDialog } from "./forms";
import priceOptionCardStyles from "./price-option-card.module.css";
import compatibilityAddEditorStyles from "./compatibility-add-editor.module.css";
import { Button } from "./ui/button";
import quickServiceActionStyles from "./quick-service-actions.module.css";
import type {
  DeviceCatalogDeletionView,
  ProductCompatibilityDraft,
} from "./forms";

export type CompatibilityDeviceDraft = {
  category: string;
  brand: string;
  model: string;
  projects: string[];
};

export function CompatibilityAddEditor({
  value,
  onChange,
  options,
  associated = [],
  defaultCost = "",
  deletions = [],
}: {
  value: CompatibilityDeviceDraft;
  onChange: (value: CompatibilityDeviceDraft) => void;
  options: ProductCompatibilityDraft[];
  associated?: ProductCompatibilityDraft[];
  defaultCost?: string;
  deletions?: DeviceCatalogDeletionView[];
}) {
  const it = useMessages();
  const { locale } = useLanguage();
  const router = useRouter();
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [newProject, setNewProject] = useState("");
  const [newPrice, setNewPrice] = useState("");
  const [newCost, setNewCost] = useState("");
  const [extraProjects, setExtraProjects] = useState<
    ProductCompatibilityDraft[]
  >([]);
  const [pickerProjects, setPickerProjects] = useState<string[]>([]);
  const [savingProject, setSavingProject] = useState(false);
  const [projectError, setProjectError] = useState("");
  const hidden = (kind: "BRAND" | "MODEL", candidate: string) =>
    deletions.some(
      (entry) =>
        entry.category === value.category &&
        entry.kind === kind &&
        (kind === "BRAND" ||
          entry.brand.toLocaleLowerCase("it") ===
            value.brand.toLocaleLowerCase("it")) &&
        entry.value.toLocaleLowerCase("it") ===
          candidate.toLocaleLowerCase("it"),
    );
  const brandOptions = uniqueOptions(
    options
      .filter((option) => option.category === value.category)
      .map((option) => option.brand),
  ).filter((brand) => brand && !hidden("BRAND", brand));
  const modelOptions = uniqueOptions(
    options
      .filter(
        (option) =>
          option.category === value.category &&
          option.brand.toLocaleLowerCase("it") ===
            value.brand.toLocaleLowerCase("it"),
      )
      .map((option) => option.model),
  ).filter((model) => model && !hidden("MODEL", model));
  const projectOptions = uniqueOptions(
    [...options, ...extraProjects]
      .filter(
        (option) =>
          option.category === value.category &&
          option.brand.toLocaleLowerCase("it") ===
            value.brand.toLocaleLowerCase("it") &&
          modelKey(option.model) === modelKey(value.model),
      )
      .map((option) => option.project),
  ).filter(Boolean);
  const unselectedProjects = projectOptions.filter(
    (project) => !value.projects.includes(project),
  );

  return (
    <div
      className={`${compatibilityAddEditorStyles.editor} compatibility-add-editor`}
    >
      <div
        className={`${compatibilityAddEditorStyles.deviceFields} compatibility-device-fields`}
      >
        <label>
          <span>{it.deviceType}</span>
          <SimpleSelect
            value={value.category}
            onChange={(category) =>
              onChange({ category, brand: "", model: "", projects: [] })
            }
            placeholder={it.deviceType}
            ariaLabel={it.deviceType}
            options={Object.entries(categories).map(([category, labels]) => ({
              value: category,
              label: labels[locale === "zh" ? 1 : 0],
            }))}
          />
        </label>
        <EditableSelect
          label={it.brand}
          value={value.brand}
          options={brandOptions}
          onChange={(brand) =>
            onChange({ ...value, brand, model: "", projects: [] })
          }
        />
        <EditableSelect
          label={it.model}
          value={value.model}
          options={modelOptions}
          readOnly={!value.brand}
          onChange={(model) =>
            onChange({
              ...value,
              model,
              projects: uniqueOptions(
                associated
                  .filter(
                    (option) =>
                      option.category === value.category &&
                      option.brand.toLocaleLowerCase("it") ===
                        value.brand.toLocaleLowerCase("it") &&
                      modelKey(option.model) === modelKey(model),
                  )
                  .map((option) => option.project),
              ).filter(Boolean),
            })
          }
        />
      </div>
      <section
        className={`${compatibilityAddEditorStyles.projectField} compatibility-project-field`}
      >
        <header>
          <strong>{it.project}</strong>
          <small>{it.inventory.compatibilityProjectsHelp}</small>
        </header>
        <div
          className={`${compatibilityAddEditorStyles.projectSelector} compatibility-project-selector`}
        >
          {value.projects.map((project) => (
            <span
              className={`${compatibilityAddEditorStyles.projectChip} compatibility-project-chip`}
              key={project}
            >
              {project}
              <button
                type="button"
                aria-label={`${it.remove} ${project}`}
                onClick={() =>
                  onChange({
                    ...value,
                    projects: value.projects.filter((item) => item !== project),
                  })
                }
              >
                <X size={13} />
              </button>
            </span>
          ))}
          <button
            type="button"
            className={`quick-service-picker-add ${quickServiceActionStyles.pickerAdd} ${compatibilityAddEditorStyles.projectAdd} compatibility-project-add`}
            disabled={!value.model}
            onClick={() => {
              setPickerProjects([]);
              setProjectPickerOpen(true);
            }}
          >
            <Plus size={16} /> {it.addProject}
          </button>
        </div>
      </section>
      {projectPickerOpen && (
        <FormDialog
          title={it.selectRepairProjects}
          onClose={() => {
            setProjectPickerOpen(false);
            setCreatingProject(false);
            setProjectError("");
          }}
        >
          <DialogBody
            className={`${compatibilityAddEditorStyles.projectPicker} compatibility-project-picker`}
          >
            <div
              className={`${compatibilityAddEditorStyles.projectChoices} compatibility-project-choices`}
            >
              {unselectedProjects.length ? (
                unselectedProjects.map((project) => (
                  <button
                    type="button"
                    key={project}
                    className={`${priceOptionCardStyles.card} price-option-card ${priceOptionCardStyles.choice} price-option-choice business-list-row${pickerProjects.includes(project) ? ` is-selected ${priceOptionCardStyles.selected}` : ""}`}
                    onClick={() => {
                      setPickerProjects((current) =>
                        current.includes(project)
                          ? current.filter((item) => item !== project)
                          : [...current, project],
                      );
                    }}
                  >
                    <strong>{project}</strong>
                    {pickerProjects.includes(project) && <Check size={18} />}
                  </button>
                ))
              ) : (
                <p className="empty">{it.noMatches}</p>
              )}
            </div>
            <button
              type="button"
              className={`quick-service-picker-add ${quickServiceActionStyles.pickerAdd}`}
              onClick={() => {
                setNewProject("");
                setNewPrice("");
                setNewCost(
                  Number(defaultCost.replace(",", ".")) > 0 ? defaultCost : "",
                );
                setCreatingProject(true);
              }}
            >
              <Plus size={16} /> {it.newRepairProject}
            </button>
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="cancel"
              onClick={() => setProjectPickerOpen(false)}
            >
              {it.cancel}
            </Button>
            <Button
              type="button"
              onClick={() => {
                onChange({
                  ...value,
                  projects: [...value.projects, ...pickerProjects],
                });
                setProjectPickerOpen(false);
              }}
            >
              {it.confirmSelection}
            </Button>
          </DialogFooter>
        </FormDialog>
      )}
      {creatingProject && (
        <FormDialog
          title={it.newRepairProject}
          size="narrow"
          onClose={() => {
            setCreatingProject(false);
            setProjectError("");
          }}
        >
          <DialogBody className="compatibility-new-project-dialog">
            <div
              className={`${compatibilityAddEditorStyles.newProject} compatibility-new-project`}
            >
              <label>
                {it.project}
                <input
                  value={newProject}
                  onChange={(event) => setNewProject(event.target.value)}
                  maxLength={120}
                />
              </label>
              <label>
                {it.suggested} (€)
                <input
                  value={newPrice}
                  onChange={(event) => setNewPrice(event.target.value)}
                  inputMode="decimal"
                />
              </label>
              <label>
                {it.cost}
                <input
                  value={newCost}
                  onChange={(event) => setNewCost(event.target.value)}
                  inputMode="decimal"
                />
              </label>
              {projectError && (
                <p role="alert" className="message error">
                  {projectError}
                </p>
              )}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="cancel"
              onClick={() => setCreatingProject(false)}
            >
              {it.cancel}
            </Button>
            <Button
              type="button"
              disabled={savingProject || !newProject.trim() || !newPrice.trim()}
              onClick={async () => {
                setSavingProject(true);
                setProjectError("");
                try {
                  const result = await ruleAction(null, {
                    category: value.category,
                    brand: value.brand,
                    model: value.model,
                    series: "",
                    project: newProject,
                    suggested: newPrice,
                    cost: newCost,
                    notes: "",
                    requiredProductId: "",
                    requiredQuantity: 1,
                    minutes: 60,
                    enabled: true,
                  });
                  if (!result.ok) {
                    setProjectError(result.error ?? "Errore");
                    return;
                  }
                  setExtraProjects((current) => [
                    ...current,
                    { ...value, project: newProject },
                  ]);
                  setPickerProjects((current) => [...current, newProject]);
                  setCreatingProject(false);
                  setNewProject("");
                  setNewPrice("");
                  setNewCost("");
                  router.refresh();
                } catch {
                  setProjectError(it.connectionError);
                } finally {
                  setSavingProject(false);
                }
              }}
            >
              {savingProject ? it.saving : it.save}
            </Button>
          </DialogFooter>
        </FormDialog>
      )}
    </div>
  );
}
