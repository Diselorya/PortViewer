import type { HostContext, ServiceProfile } from "../types/knowledge";
import type { PortEntry, ServiceAttribution } from "../types/port";
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

const attributionCategories: Record<ServiceAttribution["kind"], string> = {
  DockerContainer: "容器",
  NginxSite: "网站",
  IisSite: "网站",
  IisAppPool: "应用池",
  NssmService: "系统服务",
  WindowsService: "Windows 服务",
  SystemdService: "系统服务",
  SystemProcess: "程序",
  NodeApplication: "项目",
  PythonApplication: "项目",
};
const profileCategories: Record<ServiceProfile["component_role"], string> = {
  workload: "应用",
  launcher: "启动程序",
  runtime: "运行时",
  manager: "服务管理器",
  system: "系统程序",
};
/** A category explains known evidence without inventing a translation or purpose. */
function serviceName(
  entry: PortEntry,
  profile: ServiceProfile | undefined,
  evidence: ServiceAttribution | undefined,
  catalogCandidate: boolean,
  locale: AppLocale,
): string {
  const original =
    profile?.original_name?.trim() ||
    evidence?.name?.trim() ||
    entry.process_name?.trim();
  if (!original) return locale === "zh-CN" ? "归属未知" : "Unknown service";
  if (locale !== "zh-CN") return original;
  const candidatePrefix =
    profile?.identity_match === "candidate" ? "候选：" : "";
  if (/\p{Script=Han}/u.test(original)) return candidatePrefix + original;
  if (
    profile?.display_name_zh?.trim() &&
    (profile.identity_match === "confirmed" || catalogCandidate)
  )
    return candidatePrefix + profile.display_name_zh.trim();
  const category = evidence
    ? attributionCategories[evidence.kind]
    : profile
      ? profileCategories[profile.component_role]
      : "进程";
  return candidatePrefix + category + "：" + original;
}

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
  const localEvidence =
    entry.attributions?.find((item) => item.kind !== "SystemProcess") ??
    entry.attributions?.[0];
  const localWorkload = localEvidence && localEvidence.kind !== "SystemProcess";
  const primary =
    details.find((profile) => profile.component_role === "workload") ??
    (localWorkload ? undefined : details[0]);
  const catalogCandidate =
    primary?.identity_match === "candidate" &&
    primary.sources.some((source) => source.kind === "catalog");
  const local = hosts.get("") ?? hosts.get(entry.local_address);
  const remote = entry.remote_address ? hosts.get(entry.remote_address) : null;
  return {
    serviceName: serviceName(
      entry,
      primary,
      localEvidence,
      Boolean(catalogCandidate),
      locale,
    ),
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
