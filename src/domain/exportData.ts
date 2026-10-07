import type { PortEntry } from "../types/port";
import { attributionLabel, kindLabel } from "./attribution";
export type ExportColumn =
  Exclude<keyof PortEntry, "attributions"> | "attribution";
export const EXPORT_COLUMNS: ExportColumn[] = [
  "protocol",
  "ip_version",
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
const HEADERS: Record<string, string> = {
  protocol: "协议",
  ip_version: "IP 版本",
  local_address: "本地地址",
  local_port: "本地端口",
  remote_address: "远程地址",
  remote_port: "远程端口",
  state: "TCP 状态",
  attribution: "服务归属",
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
          e.protocol === "Udp" &&
          ["remote_address", "remote_port", "state"].includes(c)
        )
          return "—";
        if (c === "attribution")
          return escapeCsv(
            e.attributions?.length
              ? e.attributions
                  .map((item) => `${kindLabel(item.kind)}: ${item.name}`)
                  .join(" | ")
              : attributionLabel(e),
          );
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
  filters: { query: string; protocols: string[]; states: string[] };
  entryCount: number;
  truncated: boolean;
}
export function createJson(
  entries: PortEntry[],
  metadata: ExportMetadata,
): string {
  return JSON.stringify({ schemaVersion: 2, metadata, entries }, null, 2);
}
