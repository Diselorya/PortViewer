import { SERVICE_MANAGERS, serviceManager } from "./attribution";
import { analyzeConnection } from "./connectionRelation";
import type { PortEntry } from "../types/port";
import { displayField, type EntryDisplayResolver } from "./serviceKnowledge";

export const FACET_FIELDS = [
  "service_name",
  "local_host",
  "remote_host",
  "protocol",
  "ip_version",
  "local_address",
  "local_port",
  "remote_address",
  "remote_port",
  "role",
  "state",
  "service_manager",
  "process_status",
  "attribution_kind",
  "attribution_confidence",
] as const;
export type FacetField = (typeof FACET_FIELDS)[number];
export type FacetFilters = Partial<Record<FacetField, string[]>>;
export const NO_VALUE = "__none__";
export const UNIDENTIFIED = "__unidentified__";

export const STABLE_FACET_VALUES: Partial<
  Record<FacetField, readonly string[]>
> = {
  protocol: ["Tcp", "Udp"],
  ip_version: ["V4", "V6"],
  role: [
    "listen",
    "outbound",
    "inbound",
    "loopback",
    "udp-bind",
    "udp-peer",
    "unknown",
  ],
  state: [
    "Closed",
    "Listen",
    "SynSent",
    "SynRcvd",
    "Established",
    "FinWait1",
    "FinWait2",
    "CloseWait",
    "Closing",
    "LastAck",
    "TimeWait",
    "DeleteTcb",
    "Unknown",
    NO_VALUE,
  ],
  service_manager: SERVICE_MANAGERS,
  process_status: [
    "Available",
    "Partial",
    "AccessDenied",
    "Exited",
    "System",
    "Unavailable",
  ],
  attribution_kind: [
    "DockerContainer",
    "NginxSite",
    "IisSite",
    "IisAppPool",
    "NssmService",
    "WindowsService",
    "SystemdService",
    "SystemProcess",
    "NodeApplication",
    "PythonApplication",
    UNIDENTIFIED,
  ],
  attribution_confidence: ["Exact", "High", "Medium", UNIDENTIFIED],
  remote_address: [NO_VALUE],
  remote_port: [NO_VALUE],
};

/** A peer is usable only when both address and port identify a real endpoint. */
export function hasRemoteEndpoint(entry: PortEntry): boolean {
  return (
    entry.state !== "Listen" &&
    Boolean(entry.remote_address) &&
    entry.remote_port !== null &&
    entry.remote_port !== 0
  );
}

export function facetValues(
  entry: PortEntry,
  field: FacetField,
  displayFor?: EntryDisplayResolver,
): string[] {
  switch (field) {
    case "service_name":
    case "local_host":
    case "remote_host":
      return [displayField(entry, field, displayFor) || UNIDENTIFIED];
    case "role":
      return [analyzeConnection(entry).role];
    case "service_manager":
      return [serviceManager(entry)];
    case "attribution_kind":
      return entry.attributions?.length
        ? [...new Set(entry.attributions.map((item) => item.kind))].sort()
        : [UNIDENTIFIED];
    case "attribution_confidence":
      return entry.attributions?.length
        ? [...new Set(entry.attributions.map((item) => item.confidence))].sort()
        : [UNIDENTIFIED];
    case "remote_address":
      return [hasRemoteEndpoint(entry) ? entry.remote_address! : NO_VALUE];
    case "remote_port":
      return [hasRemoteEndpoint(entry) ? String(entry.remote_port) : NO_VALUE];
    case "state":
      return [entry.protocol === "Tcp" && entry.state ? entry.state : NO_VALUE];
    default:
      return [String(entry[field])];
  }
}

const facetCollator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});
export function compareFacetValues(a: string, b: string): number {
  if (a === b) return 0;
  if (a.startsWith("__")) return 1;
  if (b.startsWith("__")) return -1;
  return facetCollator.compare(a, b);
}

export interface FacetOption {
  value: string;
  count: number;
}

/** Build a single field on demand, including selections absent from a fresh scan. */
export function facetOptions(
  entries: PortEntry[],
  field: FacetField,
  selected: string[] = [],
  displayFor?: EntryDisplayResolver,
): FacetOption[] {
  const counts = new Map<string, number>(
    [...(STABLE_FACET_VALUES[field] ?? []), ...selected].map((value) => [
      value,
      0,
    ]),
  );
  for (const entry of entries)
    for (const value of facetValues(entry, field, displayFor))
      counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .sort(([a], [b]) => compareFacetValues(a, b))
    .map(([value, count]) => ({ value, count }));
}

export function matchesFacetFilters(
  entry: PortEntry,
  filters: FacetFilters,
  displayFor?: EntryDisplayResolver,
): boolean {
  return FACET_FIELDS.every((field) => {
    const selected = filters[field];
    return (
      !selected?.length ||
      facetValues(entry, field, displayFor).some((value) =>
        selected.includes(value),
      )
    );
  });
}

/** Multi-valued evidence forms one set-valued group so endpoints never duplicate. */
export function facetGroupKey(
  entry: PortEntry,
  field: FacetField,
  displayFor?: EntryDisplayResolver,
): string {
  return JSON.stringify(facetValues(entry, field, displayFor));
}

export interface EntryGroup {
  key: string;
  values: string[];
  entries: PortEntry[];
}

export function groupEntries(
  entries: PortEntry[],
  field: FacetField,
  displayFor?: EntryDisplayResolver,
  order: 1 | -1 = 1,
): EntryGroup[] {
  const groups = new Map<string, EntryGroup>();
  for (const entry of entries) {
    const values = facetValues(entry, field, displayFor),
      key = JSON.stringify(values);
    let group = groups.get(key);
    if (!group) {
      group = { key, values, entries: [] };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }
  return [...groups.values()].sort(
    (a, b) =>
      order * compareFacetValues(a.values.join(" + "), b.values.join(" + ")),
  );
}
