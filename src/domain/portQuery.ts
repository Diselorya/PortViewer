import { attributionLabel, attributionSearchText } from "./attribution";
import type { PortColumnField, PortEntry, SortSpec } from "../types/port";
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
function matches(e: PortEntry, t: QueryToken) {
  const lp = String(e.local_port),
    rp = e.remote_port === null ? "" : String(e.remote_port),
    pid = String(e.pid),
    name = (e.process_name ?? "").toLowerCase(),
    path = (e.process_path ?? "").toLowerCase(),
    attribution = attributionSearchText(e),
    ips = `${e.local_address} ${e.remote_address ?? ""}`.toLowerCase(),
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
function compare(a: unknown, b: unknown) {
  return typeof a === "number" && typeof b === "number"
    ? a - b
    : String(a ?? "").localeCompare(String(b ?? ""), "zh-CN", {
        numeric: true,
        sensitivity: "base",
      });
}
function fieldValue(entry: PortEntry, field: PortColumnField): unknown {
  return field === "attribution" ? attributionLabel(entry) : entry[field];
}
export function queryEntries(
  entries: PortEntry[],
  query: string,
  protocols: string[],
  states: string[],
  sort: SortSpec[],
): PortEntry[] {
  const tokens = parseQuery(query),
    ps = new Set(protocols),
    ss = new Set(states);
  return entries
    .filter(
      (e) =>
        (!ps.size || ps.has(e.protocol)) &&
        (!ss.size ||
          (e.protocol === "Tcp" && e.state !== null && ss.has(e.state))) &&
        tokens.every((t) => matches(e, t)),
    )
    .map((entry, index) => ({ entry, index, rank: rank(entry, tokens) }))
    .sort((a, b) => {
      if (!sort.length && a.rank !== b.rank) return b.rank - a.rank;
      for (const s of sort) {
        const c = compare(
          fieldValue(a.entry, s.field),
          fieldValue(b.entry, s.field),
        );
        if (c) return c * s.order;
      }
      return a.index - b.index;
    })
    .map((x) => x.entry);
}
