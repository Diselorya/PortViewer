import type { HostContext, ServiceProfile } from "../types/knowledge";
import type { PortEntry } from "../types/port";
import type { AppLocale } from "../i18n";

export interface EntryDisplay {
  serviceName: string;
  serviceDescription: string;
  softwareSummary: string;
  localHost: string;
  remoteHost: string;
  profiles: ServiceProfile[];
}
export type EntryDisplayResolver = (entry: PortEntry) => EntryDisplay;
const roles = ["workload", "launcher", "runtime", "manager", "system"];
const EMPTY_PROFILES: ReadonlyMap<string, ServiceProfile> = new Map();
const EMPTY_HOSTS: ReadonlyMap<string, HostContext> = new Map();

/** Keep local workload purpose separate from public documentation of its runtime. */
export function displayEntry(
  entry: PortEntry,
  profiles: ReadonlyMap<string, ServiceProfile> = EMPTY_PROFILES,
  hosts: ReadonlyMap<string, HostContext> = EMPTY_HOSTS,
  locale: AppLocale = "zh-CN",
): EntryDisplay {
  const details = (entry.service_profile_ids ?? [])
    .map((id) => profiles.get(id))
    .filter((profile): profile is ServiceProfile => Boolean(profile))
    .sort(
      (a, b) =>
        roles.indexOf(a.component_role) - roles.indexOf(b.component_role),
    );
  const primary = details[0];
  const catalogCandidate =
    primary?.identity_match === "candidate" &&
    primary.sources.some((source) => source.kind === "catalog");
  const localEvidence = entry.attributions?.[0];
  const local = hosts.get("") ?? hosts.get(entry.local_address);
  const remote = entry.remote_address ? hosts.get(entry.remote_address) : null;
  return {
    serviceName:
      (locale === "zh-CN" &&
      primary?.display_name_zh &&
      (primary.identity_match === "confirmed" || catalogCandidate)
        ? (catalogCandidate ? "候选：" : "") + primary.display_name_zh
        : null) ||
      primary?.original_name ||
      localEvidence?.name ||
      entry.process_name ||
      (locale === "zh-CN" ? "归属未知" : "Unknown service"),
    serviceDescription:
      primary?.summary ||
      (primary?.identity_match === "confirmed" && primary.software_summary
        ? (primary.component_role === "workload"
            ? locale === "zh-CN"
              ? "软件说明："
              : "Software: "
            : "") + primary.software_summary
        : null) ||
      (catalogCandidate && primary?.software_summary
        ? (locale === "zh-CN" ? "候选软件说明：" : "Candidate software: ") +
          primary.software_summary
        : null) ||
      (!primary ? localEvidence?.description : null) ||
      "",
    softwareSummary: details
      .map((profile) => profile.software_summary)
      .filter(Boolean)
      .filter((text, index, values) => values.indexOf(text) === index)
      .join(" · "),
    localHost: local?.hostname || local?.machine_name || "",
    remoteHost:
      entry.state !== "Listen" && entry.remote_port
        ? remote?.hostname || remote?.machine_name || ""
        : "",
    profiles: details,
  };
}

export function displayField(
  entry: PortEntry,
  field: string,
  resolve?: EntryDisplayResolver,
): string | undefined {
  if (
    ![
      "service_name",
      "service_description",
      "local_host",
      "remote_host",
    ].includes(field)
  )
    return undefined;
  const display = resolve ? resolve(entry) : displayEntry(entry);
  switch (field) {
    case "service_name":
      return display.serviceName;
    case "service_description":
      return display.serviceDescription;
    case "local_host":
      return display.localHost;
    case "remote_host":
      return display.remoteHost;
  }
}
