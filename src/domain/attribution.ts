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
  SystemdService: "systemd 服务",
  SystemProcess: "程序身份",
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
  SystemdService: "systemd service",
  SystemProcess: "Program",
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
  if (!primary)
    return entry.pid === 0 && entry.process_status !== "System"
      ? "归属未知"
      : "仅识别到进程";
  const extra = Math.max(0, (entry.attributions?.length ?? 0) - 1);
  return extra ? `${primary.name}  +${extra}` : primary.name;
}

/** Keep the workload's mode and location visible without exposing command lines. */
export function attributionContext(
  item: ServiceAttribution,
  localize: (value: string) => string = (value) => value,
): string {
  const mode = item.facts.find((fact) =>
    /^(运行模式|运行方式|模式|npm script|Runtime mode|Run mode|Mode)$/i.test(
      fact.label,
    ),
  )?.value;
  const pathFacts = item.facts.filter((fact) =>
    /路径|目录|挂载|单元文件|配置文件|mount|path|directory|working dir|unit file/i.test(
      fact.label,
    ),
  );
  const location = (
    pathFacts.find((fact) => /项目路径|project path/i.test(fact.label)) ??
    pathFacts[0]
  )?.value;
  return [mode ? localize(mode) : null, location].filter(Boolean).join(" · ");
}

export function attributionDetails(
  item: ServiceAttribution,
  locale: AppLocale = "zh-CN",
  localize: (value: string) => string = (value) => value,
): string {
  return [
    `${kindLabel(item.kind, locale)}: ${localize(item.name)}`,
    item.description ? localize(item.description) : null,
    ...item.facts.map(
      (fact) => `${localize(fact.label)}: ${localize(fact.value)}`,
    ),
    `${locale === "zh-CN" ? "证据" : "Evidence"}: ${localize(item.source)}`,
    `${locale === "zh-CN" ? "可信度" : "Confidence"}: ${confidenceLabel(item.confidence, locale)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function attributionSearchText(entry: PortEntry): string {
  return (entry.attributions ?? [])
    .flatMap((item) => [
      item.name,
      item.description ?? "",
      item.source,
      kindLabel(item.kind),
      kindLabel(item.kind, "en-US"),
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
