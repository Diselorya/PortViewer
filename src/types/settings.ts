import type { PortColumnField, SortSpec } from "./port";
import type {
  FacetField,
  FacetFilters,
  ConditionMode,
  FacetFieldModes,
} from "../domain/portFacets";
export type ThemeOption = "light" | "dark" | "system";
export type LanguageOption = "system" | "zh-CN" | "en-US";
export type TableDensity = "compact" | "standard" | "comfortable";
export const PORT_COLORS = [
  "blue",
  "green",
  "amber",
  "red",
  "purple",
  "gray",
] as const;
export type PortColor = (typeof PORT_COLORS)[number];
export interface PortColorRule {
  id: string;
  enabled: boolean;
  filters: FacetFilters;
  mode?: ConditionMode;
  fieldModes?: FacetFieldModes;
  target: { kind: "row" } | { kind: "columns"; fields: PortColumnField[] };
  color: PortColor;
}
export interface AppSettings {
  schemaVersion: 5;
  query: string;
  facetFilters: FacetFilters;
  filterMode: ConditionMode;
  filterFieldModes: FacetFieldModes;
  groupExpansion: { defaultExpanded: boolean; exceptions: string[] };
  refreshIntervalMs: 0 | 1000 | 2000 | 5000 | 10000 | 30000 | 60000;
  theme: ThemeOption;
  language: LanguageOption;
  scanOnStartup: boolean;
  density: TableDensity;
  visibleColumns: PortColumnField[];
  columnOrder: PortColumnField[];
  columnWidths: Partial<Record<PortColumnField, number>>;
  columnSizing: "auto" | "manual";
  sortSpecs: SortSpec[];
  groupBy: FacetField | null;
  colorRules: PortColorRule[];
}
export const ALL_COLUMN_FIELDS: ReadonlyArray<PortColumnField> = [
  "service_name",
  "service_description",
  "local_host",
  "remote_host",
  "protocol",
  "ip_version",
  "local_address",
  "local_port",
  "role",
  "remote_address",
  "remote_port",
  "state",
  "service_manager",
  "attribution",
  "attribution_kind",
  "attribution_confidence",
  "process_status",
  "pid",
  "process_name",
  "process_path",
  "process_created_at",
];
export const LEGACY_V4_VISIBLE_COLUMNS: PortColumnField[] = [
  "service_name",
  "service_description",
  "protocol",
  "local_address",
  "local_port",
  "role",
  "remote_address",
  "remote_host",
  "remote_port",
  "state",
  "service_manager",
  "attribution",
  "pid",
  "process_name",
];
export const LEGACY_V4_COLUMN_ORDER: PortColumnField[] = [
  "service_name",
  "service_description",
  "local_port",
  "local_address",
  "local_host",
  "protocol",
  "state",
  "role",
  "remote_host",
  "remote_address",
  "remote_port",
  "service_manager",
  "attribution",
  "pid",
  "process_name",
  "process_path",
  "ip_version",
  "attribution_kind",
  "attribution_confidence",
  "process_status",
  "process_created_at",
];
export const DEFAULT_VISIBLE_COLUMNS: PortColumnField[] = [
  "service_name",
  "process_name",
  "attribution_kind",
  "attribution",
  "state",
  "protocol",
  "local_address",
  "local_port",
  "role",
  "remote_host",
  "remote_address",
  "remote_port",
  "service_description",
];
export const DEFAULT_COLUMN_ORDER: PortColumnField[] = [
  ...DEFAULT_VISIBLE_COLUMNS,
  ...ALL_COLUMN_FIELDS.filter(
    (field) => !DEFAULT_VISIBLE_COLUMNS.includes(field),
  ),
];
export const COLUMN_WIDTH_LIMITS: Record<
  PortColumnField,
  { min: number; max: number }
> = Object.fromEntries(
  [...ALL_COLUMN_FIELDS, "process_status_message"].map((field) => [
    field,
    field === "service_description"
      ? { min: 160, max: 360 }
      : ["attribution", "process_path"].includes(field)
        ? { min: 140, max: 320 }
        : ["local_address", "remote_address"].includes(field)
          ? { min: 110, max: 280 }
          : [
                "service_name",
                "local_host",
                "remote_host",
                "process_name",
              ].includes(field)
            ? { min: 100, max: 240 }
            : field === "process_created_at"
              ? { min: 150, max: 210 }
              : { min: 70, max: 180 },
  ]),
) as Record<PortColumnField, { min: number; max: number }>;
export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: 5,
  query: "",
  facetFilters: {},
  filterMode: "all",
  filterFieldModes: {},
  groupExpansion: { defaultExpanded: true, exceptions: [] },
  refreshIntervalMs: 5000,
  theme: "system",
  language: "system",
  scanOnStartup: true,
  density: "compact",
  visibleColumns: [...DEFAULT_VISIBLE_COLUMNS],
  columnOrder: [...DEFAULT_COLUMN_ORDER],
  columnWidths: {},
  columnSizing: "auto",
  sortSpecs: [],
  groupBy: null,
  colorRules: [],
};
