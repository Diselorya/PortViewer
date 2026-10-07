import type { PortColumnField } from "./port";
export type ThemeOption = "light" | "dark" | "system";
export type LanguageOption = "system" | "zh-CN" | "en-US";
export type TableDensity = "compact" | "standard" | "comfortable";
export interface AppSettings {
  schemaVersion: 2;
  refreshIntervalMs: 0 | 1000 | 2000 | 5000 | 10000 | 30000 | 60000;
  theme: ThemeOption;
  language: LanguageOption;
  maxEntries: 1000 | 10000 | 50000 | 100000;
  scanOnStartup: boolean;
  density: TableDensity;
  visibleColumns: PortColumnField[];
}
export const ALL_COLUMN_FIELDS: ReadonlyArray<PortColumnField> = [
  "protocol",
  "local_address",
  "local_port",
  "remote_address",
  "remote_port",
  "state",
  "attribution",
  "pid",
  "process_name",
  "process_path",
  "process_created_at",
];
export const DEFAULT_VISIBLE_COLUMNS: PortColumnField[] = [
  "protocol",
  "local_address",
  "local_port",
  "remote_address",
  "remote_port",
  "state",
  "attribution",
  "pid",
  "process_name",
];
export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: 2,
  refreshIntervalMs: 5000,
  theme: "system",
  language: "system",
  maxEntries: 50000,
  scanOnStartup: true,
  density: "standard",
  visibleColumns: [...DEFAULT_VISIBLE_COLUMNS],
};
