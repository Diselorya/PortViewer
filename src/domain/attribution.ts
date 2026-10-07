import type {
  AttributionConfidence,
  AttributionKind,
  PortEntry,
  ServiceAttribution,
} from "../types/port";
import type { AppLocale } from "../i18n";

const KIND_LABELS: Record<AttributionKind, string> = {
  DockerContainer: "Docker 容器",
  NginxSite: "Nginx 站点",
  IisSite: "IIS 站点",
  IisAppPool: "IIS 应用池",
  NssmService: "NSSM 服务",
  WindowsService: "Windows 服务",
  NodeApplication: "Node.js/npm",
  PythonApplication: "Python",
};

const CONFIDENCE_LABELS: Record<AttributionConfidence, string> = {
  Exact: "精确",
  High: "高可信",
  Medium: "推测",
};
const KIND_LABELS_EN: Record<AttributionKind, string> = {
  DockerContainer: "Docker container",
  NginxSite: "Nginx site",
  IisSite: "IIS site",
  IisAppPool: "IIS app pool",
  NssmService: "NSSM service",
  WindowsService: "Windows service",
  NodeApplication: "Node.js/npm",
  PythonApplication: "Python",
};
const CONFIDENCE_LABELS_EN: Record<AttributionConfidence, string> = {
  Exact: "Exact",
  High: "High",
  Medium: "Inferred",
};

export function primaryAttribution(
  entry: PortEntry,
): ServiceAttribution | null {
  return entry.attributions?.[0] ?? null;
}

export function attributionLabel(entry: PortEntry): string {
  const primary = primaryAttribution(entry);
  if (!primary) return "仅识别到进程";
  const extra = Math.max(0, (entry.attributions?.length ?? 0) - 1);
  return extra ? `${primary.name}  +${extra}` : primary.name;
}

export function attributionSearchText(entry: PortEntry): string {
  return (entry.attributions ?? [])
    .flatMap((item) => [
      item.name,
      item.description ?? "",
      item.source,
      kindLabel(item.kind),
      ...item.facts.flatMap((fact) => [fact.label, fact.value]),
    ])
    .join(" ")
    .toLowerCase();
}

export function kindLabel(
  kind: AttributionKind,
  locale: AppLocale = "zh-CN",
): string {
  return (locale === "zh-CN" ? KIND_LABELS : KIND_LABELS_EN)[kind];
}

export function confidenceLabel(
  confidence: AttributionConfidence,
  locale: AppLocale = "zh-CN",
): string {
  return (locale === "zh-CN" ? CONFIDENCE_LABELS : CONFIDENCE_LABELS_EN)[
    confidence
  ];
}
