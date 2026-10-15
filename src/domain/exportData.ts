import type { PortColumnField, PortEntry, SortSpec } from "../types/port";
import {
  attributionDetails,
  attributionLabel,
  serviceManager,
} from "./attribution";
import { analyzeConnection } from "./connectionRelation";
import {
  facetValues,
  hasRemoteEndpoint,
  type FacetField,
  type FacetFilters,
} from "./portFacets";
export type ExportColumn = PortColumnField;
export const EXPORT_COLUMNS: ExportColumn[] = [
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
const HEADERS: Record<string, string> = {
  protocol: "协议",
  ip_version: "IP 版本",
  local_address: "本地地址",
  local_port: "本地端口",
  role: "方向/角色",
  remote_address: "远程地址",
  remote_port: "远程端口",
  state: "TCP 状态",
  service_manager: "上级服务",
  attribution: "服务归属",
  attribution_kind: "归属类型",
  attribution_confidence: "归属可信度",
  process_status: "进程状态",
  pid: "PID",
  process_name: "进程名",
  process_path: "进程路径",
  process_created_at: "进程创建时间",
};
export function escapeCsv(value: unknown): string {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
export function createCsv(
  entries: PortEntry[],
  columns = EXPORT_COLUMNS,
): string {
  const h = columns.map((c) => escapeCsv(HEADERS[c] ?? c)).join(",");
  const rows = entries.map((e) =>
    columns
      .map((c) => {
        if (
          (c === "state" && e.protocol === "Udp") ||
          (["remote_address", "remote_port"].includes(c) &&
            !hasRemoteEndpoint(e))
        )
          return "—";
        if (c === "attribution")
          return escapeCsv(
            e.attributions?.length
              ? e.attributions
                  .map((item) => attributionDetails(item))
                  .join("\n\n")
              : attributionLabel(e),
          );
        if (c === "service_manager") return escapeCsv(serviceManager(e));
        if (c === "role") return escapeCsv(analyzeConnection(e).role);
        if (c === "attribution_kind" || c === "attribution_confidence")
          return escapeCsv(facetValues(e, c).join(" + "));
        return escapeCsv(e[c]);
      })
      .join(","),
  );
  return `\uFEFF${[h, ...rows].join("\r\n")}`;
}
export interface ExportMetadata {
  productVersion: string;
  exportedAt: string;
  scannedAt: string | null;
  filters: {
    query: string;
    protocols: string[];
    states: string[];
    facets?: FacetFilters;
  };
  groupBy?: FacetField | null;
  sort?: SortSpec[];
  entryCount: number;
  truncated: boolean;
}
export function createJson(
  entries: PortEntry[],
  metadata: ExportMetadata,
): string {
  return JSON.stringify(
    {
      schemaVersion: 2,
      metadata,
      entries: entries.map((entry) => ({
        ...entry,
        service_manager: serviceManager(entry),
        role: analyzeConnection(entry).role,
        attribution_kind: facetValues(entry, "attribution_kind"),
        attribution_confidence: facetValues(entry, "attribution_confidence"),
      })),
    },
    null,
    2,
  );
}
