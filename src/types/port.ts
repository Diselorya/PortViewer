export type Protocol = "Tcp" | "Udp";
export type IpVersion = "V4" | "V6";
export type ConnectionState =
  | "Closed"
  | "Listen"
  | "SynSent"
  | "SynRcvd"
  | "Established"
  | "FinWait1"
  | "FinWait2"
  | "CloseWait"
  | "Closing"
  | "LastAck"
  | "TimeWait"
  | "DeleteTcb"
  | "Unknown";
export type ProcessStatus =
  | "Available"
  | "Partial"
  | "AccessDenied"
  | "Exited"
  | "System"
  | "Unavailable";
export type AttributionKind =
  | "DockerContainer"
  | "NginxSite"
  | "IisSite"
  | "IisAppPool"
  | "NssmService"
  | "WindowsService"
  | "NodeApplication"
  | "PythonApplication";
export type AttributionConfidence = "Exact" | "High" | "Medium";
export interface AttributionFact {
  label: string;
  value: string;
}
export interface ServiceAttribution {
  kind: AttributionKind;
  name: string;
  description: string | null;
  confidence: AttributionConfidence;
  source: string;
  facts: AttributionFact[];
}
export interface PortEntry {
  protocol: Protocol;
  ip_version: IpVersion;
  local_address: string;
  local_port: number;
  remote_address: string | null;
  remote_port: number | null;
  state: ConnectionState | null;
  pid: number;
  process_name: string | null;
  process_path: string | null;
  process_created_at: string | null;
  process_status: ProcessStatus;
  process_status_message: string | null;
  attributions: ServiceAttribution[];
}
export interface ScanScope {
  protocol: Protocol;
  ip_version: IpVersion;
  status: "Complete" | "Failed";
  entry_count: number;
  message: string | null;
}
export interface ScanWarning {
  code: "scope_failed";
  protocol: Protocol;
  ip_version: IpVersion;
  message: string;
}
export interface AttributionResolverReport {
  resolver: string;
  status: "Complete" | "Partial" | "Skipped" | "Failed";
  matched_count: number;
  message: string | null;
  elevation_may_help: boolean;
}
export interface ScanResult {
  entries: PortEntry[];
  total_count: number;
  timestamp: string;
  scan_duration_ms: number;
  is_partial: boolean;
  scopes: ScanScope[];
  warnings: ScanWarning[];
  attribution_reports: AttributionResolverReport[];
  attribution_deferred: boolean;
}
export interface AttributionResult {
  entries: PortEntry[];
  reports: AttributionResolverReport[];
  duration_ms: number;
}
export type PortColumnField =
  Exclude<keyof PortEntry, "attributions"> | "attribution";
export interface SortSpec {
  field: PortColumnField;
  order: 1 | -1;
}
export function entryKey(e: PortEntry): string {
  return [
    e.protocol,
    e.ip_version,
    e.local_address,
    e.local_port,
    e.remote_address ?? "",
    e.remote_port ?? "",
    e.pid,
    e.process_created_at ?? "",
  ].join("|");
}
