"use client";

import { X } from "lucide-react";
import { categories, modelKey } from "@/lib/catalog";
import { uniqueOptions } from "@/lib/options";
import { useLanguage, useMessages } from "./language";
import { EditableSelect } from "./editable-select";
import { SearchableCombobox, SimpleSelect } from "./business-select";
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
  deletions = [],
}: {
  value: CompatibilityDeviceDraft;
  onChange: (value: CompatibilityDeviceDraft) => void;
  options: ProductCompatibilityDraft[];
  deletions?: DeviceCatalogDeletionView[];
}) {
  const it = useMessages();
  const { locale } = useLanguage();
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
    options
      .filter(
        (option) =>
          option.category === value.category &&
          option.brand.toLocaleLowerCase("it") ===
            value.brand.toLocaleLowerCase("it") &&
          (!option.model || modelKey(option.model) === modelKey(value.model)),
      )
      .map((option) => option.project),
  ).filter((project) => project && !value.projects.includes(project));

  return (
    <div className="compatibility-add-editor">
      <div className="compatibility-device-fields">
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
          onChange={(model) => onChange({ ...value, model, projects: [] })}
        />
      </div>
      <section className="compatibility-project-field">
        <header>
          <strong>{it.project}</strong>
          <small>{it.inventory.compatibilityProjectsHelp}</small>
        </header>
        <div className="compatibility-project-selector">
          {value.projects.map((project) => (
            <span className="compatibility-project-chip" key={project}>
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
          <SearchableCombobox
            className="compatibility-project-search"
            value=""
            onChange={(project) => {
              if (project)
                onChange({ ...value, projects: [...value.projects, project] });
            }}
            groups={[
              {
                options: projectOptions.map((project) => ({
                  value: project,
                  label: project,
                })),
              },
            ]}
            disabled={!value.model}
            placeholder={it.selectRepairProjects}
            ariaLabel={it.project}
            searchPlaceholder={it.selectRepairProjects}
            emptyText={it.noMatches}
          />
        </div>
      </section>
    </div>
  );
}
