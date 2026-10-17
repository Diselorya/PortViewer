import { FACET_FIELDS, type FacetFilters } from "./portFacets";
import type { PortColumnField, SortSpec } from "../types/port";
import {
  ALL_COLUMN_FIELDS,
  COLUMN_WIDTH_LIMITS,
  DEFAULT_SETTINGS,
  PORT_COLORS,
  type AppSettings,
  type PortColorRule,
} from "../types/settings";

const allowed = new Set<string>(ALL_COLUMN_FIELDS);
function columns(value: unknown): PortColumnField[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value.filter(
            (field): field is PortColumnField =>
              typeof field === "string" && allowed.has(field),
          ),
        ),
      ]
    : [];
}
export function validateSortSpecs(value: unknown): SortSpec[] {
  if (!Array.isArray(value)) return [];
  const fields = new Set<string>();
  return value
    .filter((spec): spec is SortSpec => {
      if (
        !spec ||
        typeof spec !== "object" ||
        !allowed.has(spec.field) ||
        ![1, -1].includes(spec.order) ||
        fields.has(spec.field)
      )
        return false;
      fields.add(spec.field);
      return true;
    })
    .slice(0, 8)
    .map((spec) => ({ field: spec.field, order: spec.order }));
}
export function validateFacetFilters(value: unknown): FacetFilters {
  if (!value || typeof value !== "object") return {};
  const result: FacetFilters = {};
  for (const field of FACET_FIELDS) {
    const values = (value as Record<string, unknown>)[field];
    if (Array.isArray(values)) {
      const selected = [
        ...new Set(
          values.filter(
            (item): item is string =>
              typeof item === "string" && item.length <= 512,
          ),
        ),
      ].slice(0, 256);
      if (selected.length) result[field] = selected;
    }
  }
  return result;
}
export function validateColorRules(value: unknown): PortColorRule[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  const result: PortColorRule[] = [];
  for (const rule of value.slice(0, 20)) {
    if (
      !rule ||
      typeof rule !== "object" ||
      typeof rule.id !== "string" ||
      !rule.id ||
      rule.id.length > 128 ||
      ids.has(rule.id) ||
      !PORT_COLORS.includes(rule.color)
    )
      continue;
    const fields = columns(rule.target?.fields);
    if (
      rule.target?.kind !== "row" &&
      (rule.target?.kind !== "columns" || !fields.length)
    )
      continue;
    ids.add(rule.id);
    result.push({
      id: rule.id,
      enabled: rule.enabled !== false,
      color: rule.color,
      filters: validateFacetFilters(rule.filters),
      target:
        rule.target.kind === "row"
          ? { kind: "row" }
          : { kind: "columns", fields },
    });
  }
  return result;
}
export function validateSettings(value: unknown): AppSettings {
  if (!value || typeof value !== "object")
    return structuredClone(DEFAULT_SETTINGS);
  const r = value as Record<string, unknown>;
  if (
    r.schemaVersion !== undefined &&
    ![1, 2, 3, 4].includes(Number(r.schemaVersion))
  )
    return structuredClone(DEFAULT_SETTINGS);
  // Reject string/fractional schema tags rather than interpreting future data.
  if (r.schemaVersion !== undefined && typeof r.schemaVersion !== "number")
    return structuredClone(DEFAULT_SETTINGS);
  let visible = Array.isArray(r.visibleColumns)
    ? columns(r.visibleColumns)
    : [...DEFAULT_SETTINGS.visibleColumns];
  if (r.schemaVersion === 1 && !visible.includes("attribution"))
    visible.splice(
      Math.max(0, visible.indexOf("process_name")),
      0,
      "attribution",
    );
  if (r.schemaVersion === 1 || r.schemaVersion === 2) {
    if (visible.includes("local_port") && !visible.includes("role"))
      visible.splice(visible.indexOf("local_port") + 1, 0, "role");
    if (visible.includes("attribution") && !visible.includes("service_manager"))
      visible.splice(visible.indexOf("attribution"), 0, "service_manager");
  }
  if (
    r.schemaVersion !== 4 &&
    (visible.includes("attribution") || visible.includes("process_name"))
  ) {
    visible = [
      ...new Set<PortColumnField>([
        "service_name",
        "service_description",
        ...visible,
      ]),
    ];
    if (visible.includes("remote_address") && !visible.includes("remote_host"))
      visible.splice(visible.indexOf("remote_address"), 0, "remote_host");
  }
  const order = columns(r.columnOrder);
  const columnOrder = [
    ...order,
    ...DEFAULT_SETTINGS.columnOrder.filter((field) => !order.includes(field)),
  ];
  const widths: AppSettings["columnWidths"] = {};
  if (r.columnWidths && typeof r.columnWidths === "object")
    for (const field of ALL_COLUMN_FIELDS) {
      const width = (r.columnWidths as Record<string, unknown>)[field];
      if (typeof width === "number" && Number.isFinite(width))
        widths[field] = Math.round(
          Math.max(
            COLUMN_WIDTH_LIMITS[field].min,
            Math.min(COLUMN_WIDTH_LIMITS[field].max, width),
          ),
        );
    }
  return {
    schemaVersion: 4,
    refreshIntervalMs: (typeof r.refreshIntervalMs === "number" &&
    [0, 1000, 2000, 5000, 10000, 30000, 60000].includes(r.refreshIntervalMs)
      ? r.refreshIntervalMs
      : 5000) as AppSettings["refreshIntervalMs"],
    theme: (["light", "dark", "system"].includes(String(r.theme))
      ? r.theme
      : "system") as AppSettings["theme"],
    language: (["zh-CN", "en-US", "system"].includes(String(r.language))
      ? r.language
      : "system") as AppSettings["language"],
    maxEntries: (typeof r.maxEntries === "number" &&
    [1000, 10000, 50000, 100000].includes(r.maxEntries)
      ? r.maxEntries
      : 50000) as AppSettings["maxEntries"],
    scanOnStartup:
      typeof r.scanOnStartup === "boolean" ? r.scanOnStartup : true,
    density: (["compact", "standard", "comfortable"].includes(String(r.density))
      ? r.density
      : "compact") as AppSettings["density"],
    visibleColumns: visible.length
      ? visible
      : [...DEFAULT_SETTINGS.visibleColumns],
    columnOrder,
    columnWidths: widths,
    columnSizing: r.columnSizing === "manual" ? "manual" : "auto",
    sortSpecs: validateSortSpecs(r.sortSpecs),
    groupBy: FACET_FIELDS.includes(r.groupBy as never)
      ? (r.groupBy as AppSettings["groupBy"])
      : null,
    colorRules: validateColorRules(r.colorRules),
  };
}
