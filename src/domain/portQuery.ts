import {
  primaryAttribution,
  attributionSearchText,
  serviceManager,
  serviceManagerLabel,
} from "./attribution";
import { analyzeConnection } from "./connectionRelation";
import {
  facetValues,
  hasRemoteEndpoint,
  type FacetFilters,
  createFacetMatcher,
  type FacetConditionOptions,
} from "./portFacets";
import type { PortColumnField, PortEntry, SortSpec } from "../types/port";
import { displayField, type EntryDisplayResolver } from "./serviceKnowledge";
export type QueryField =
  | "port"
  | "pid"
  | "process"
  | "attribution"
  | "ip"
  | "state"
  | "protocol"
  | "text";
export interface QueryToken {
  field: QueryField;
  value: string;
}
const aliases: Record<string, QueryField> = {
  port: "port",
  pid: "pid",
  process: "process",
  proc: "process",
  service: "attribution",
  owner: "attribution",
  workload: "attribution",
  container: "attribution",
  project: "attribution",
  mode: "attribution",
  ip: "ip",
  state: "state",
  protocol: "protocol",
  proto: "protocol",
};
export function parseQuery(query: string): QueryToken[] {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => {
      const i = raw.indexOf(":");
      if (i > 0) {
        const field = aliases[raw.slice(0, i).toLowerCase()],
          value = raw
            .slice(i + 1)
            .trim()
            .toLowerCase();
        if (field && value) return { field, value };
      }
      return { field: "text", value: raw.toLowerCase() };
    });
}
function matches(
  e: PortEntry,
  t: QueryToken,
  displayFor?: EntryDisplayResolver,
) {
  const display = displayFor?.(e);
  const lp = String(e.local_port),
    rp = e.remote_port === null ? "" : String(e.remote_port),
    pid = String(e.pid),
    name = (e.process_name ?? "").toLowerCase(),
    path = (e.process_path ?? "").toLowerCase(),
    attribution =
      `${attributionSearchText(e)} ${serviceManager(e)} ${serviceManagerLabel(serviceManager(e))} ${display?.serviceName ?? ""} ${display?.serviceDescription ?? ""} ${display?.softwareSummary ?? ""}`.toLowerCase(),
    ips =
      `${e.local_address} ${e.remote_address ?? ""} ${display?.localHost ?? ""} ${display?.remoteHost ?? ""}`.toLowerCase(),
    state = (e.state ?? "").toLowerCase(),
    protocol = e.protocol.toLowerCase();
  switch (t.field) {
    case "port":
      return lp === t.value || rp === t.value;
    case "pid":
      return pid === t.value;
    case "process":
      return name.includes(t.value) || path.includes(t.value);
    case "attribution":
      return attribution.includes(t.value);
    case "ip":
      return ips.includes(t.value);
    case "state":
      return e.protocol === "Tcp" && state.includes(t.value);
    case "protocol":
      return protocol.startsWith(t.value);
    case "text":
      return (
        (/^\d+$/.test(t.value) &&
          (lp === t.value || rp === t.value || pid === t.value)) ||
        [lp, rp, pid, name, path, attribution, ips, state, protocol].some((v) =>
          v.includes(t.value),
        )
      );
  }
}
function rank(e: PortEntry, tokens: QueryToken[]) {
  return tokens.reduce(
    (n, t) =>
      n +
      (String(e.local_port) === t.value ? 4 : 0) +
      (String(e.remote_port ?? "") === t.value ? 3 : 0) +
      (String(e.pid) === t.value ? 2 : 0) +
      ((e.process_name ?? "").toLowerCase() === t.value ? 3 : 0),
    0,
  );
}
const sortCollator = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base",
});
function compare(a: unknown, b: unknown) {
  return typeof a === "number" && typeof b === "number"
    ? a - b
    : sortCollator.compare(String(a ?? ""), String(b ?? ""));
}
export function fieldValue(
  entry: PortEntry,
  field: PortColumnField,
  displayFor?: EntryDisplayResolver,
): unknown {
  const displayValue = displayField(entry, field, displayFor);
  if (displayValue !== undefined) return displayValue;
  if (field === "attribution")
    return primaryAttribution(entry)?.name ?? entry.process_name ?? "";
  if (field === "service_manager") return serviceManager(entry);
  if (field === "role") return analyzeConnection(entry).role;
  if (
    (field === "remote_address" || field === "remote_port") &&
    !hasRemoteEndpoint(entry)
  )
    return null;
  if (field === "attribution_kind" || field === "attribution_confidence")
    return facetValues(entry, field).join(" + ");
  return (entry as unknown as Record<string, unknown>)[field];
}
export function queryEntries(
  entries: PortEntry[],
  query: string,
  protocols: string[],
  states: string[],
  sort: SortSpec[],
  facets: FacetFilters = {},
  displayFor?: EntryDisplayResolver,
  options: FacetConditionOptions = {},
): PortEntry[] {
  const tokens = parseQuery(query);
  const combined = { ...facets };
  if (protocols.length) combined.protocol = protocols;
  if (states.length) combined.state = states;
  const matchesFacets = createFacetMatcher(combined, displayFor, options);
  return entries
    .filter(
      (entry) =>
        matchesFacets(entry) &&
        tokens.every((token) => matches(entry, token, displayFor)),
    )
    .map((entry, index) => ({
      entry,
      index,
      rank: rank(entry, tokens),
      sortValues: sort.map((spec) => fieldValue(entry, spec.field, displayFor)),
    }))
    .sort((a, b) => {
      if (!sort.length && a.rank !== b.rank) return b.rank - a.rank;
      for (const [index, s] of sort.entries()) {
        const c = compare(a.sortValues[index], b.sortValues[index]);
        if (c) return c * s.order;
      }
      return a.index - b.index;
    })
    .map((x) => x.entry);
}
