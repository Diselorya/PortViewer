import type { AppLocale, TranslationKey } from "../i18n";
import { translate } from "../i18n";
import type { PortEntry } from "../types/port";

export type ConnectionRole =
  | "listen"
  | "outbound"
  | "inbound"
  | "loopback"
  | "udp-bind"
  | "udp-peer"
  | "unknown";
export type RelationConfidence = "exact" | "high" | "medium" | "low";

export interface ConnectionRelation {
  role: ConnectionRole;
  confidence: RelationConfidence;
  titleKey: TranslationKey;
  sentenceKey: TranslationKey;
  evidenceKey: TranslationKey;
  initiatorKey: TranslationKey;
  providerKey: TranslationKey;
  arrow: "→" | "←" | "↔" | "•" | "?";
  service: string;
}

const SERVICE_PORTS: Record<number, string> = {
  22: "SSH",
  25: "SMTP",
  53: "DNS",
  80: "HTTP",
  443: "HTTPS",
  3306: "MySQL",
  5432: "PostgreSQL",
  6379: "Redis",
};

export function formatEndpoint(
  address: string,
  port: number,
  version: PortEntry["ip_version"],
): string {
  return `${version === "V6" ? `[${address}]` : address}:${port}`;
}

export function localEndpoint(entry: PortEntry): string {
  return formatEndpoint(
    entry.local_address,
    entry.local_port,
    entry.ip_version,
  );
}

export function remoteEndpoint(entry: PortEntry): string {
  return entry.state !== "Listen" &&
    entry.remote_address &&
    entry.remote_port !== null &&
    entry.remote_port !== 0
    ? formatEndpoint(entry.remote_address, entry.remote_port, entry.ip_version)
    : "—";
}

function isLoopback(address: string | null): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();
  return (
    normalized === "::1" ||
    normalized.startsWith("127.") ||
    normalized === "0:0:0:0:0:0:0:1"
  );
}

function isLikelyEphemeral(port: number | null): boolean {
  return port !== null && port >= 49152;
}

function serviceName(entry: PortEntry): string {
  const port =
    entry.state === "Listen" ||
    entry.state === "SynRcvd" ||
    (!isLikelyEphemeral(entry.local_port) &&
      isLikelyEphemeral(entry.remote_port))
      ? entry.local_port
      : (entry.remote_port ?? entry.local_port);
  return SERVICE_PORTS[port] ?? "network";
}

export function analyzeConnection(entry: PortEntry): ConnectionRelation {
  const service = serviceName(entry);
  if (entry.protocol === "Udp") {
    return entry.remote_address && entry.remote_port !== null
      ? {
          role: "udp-peer",
          confidence: "medium",
          titleKey: "udpPeer",
          sentenceKey: "udpPeerSentence",
          evidenceKey: "evidenceUdpPeer",
          initiatorKey: "unknown",
          providerKey: "peerToPeer",
          arrow: "↔",
          service,
        }
      : {
          role: "udp-bind",
          confidence: "exact",
          titleKey: "udpBind",
          sentenceKey: "udpBindSentence",
          evidenceKey: "evidenceUdpBind",
          initiatorKey: "unknown",
          providerKey: "noFixedPeer",
          arrow: "•",
          service,
        };
  }
  if (
    entry.state === "Listen" ||
    !entry.remote_address ||
    entry.remote_port === null
  ) {
    return {
      role: "listen",
      confidence: "exact",
      titleKey: "listening",
      sentenceKey: "listenSentence",
      evidenceKey: "evidenceListen",
      initiatorKey: "remote",
      providerKey: "localProvides",
      arrow: "←",
      service,
    };
  }
  if (isLoopback(entry.local_address) && isLoopback(entry.remote_address)) {
    return {
      role: "loopback",
      confidence: "exact",
      titleKey: "loopback",
      sentenceKey: "loopbackSentence",
      evidenceKey: "evidenceLoopback",
      initiatorKey: "sameMachine",
      providerKey: "sameMachine",
      arrow: "↔",
      service,
    };
  }
  if (entry.state === "SynSent") {
    return {
      role: "outbound",
      confidence: "exact",
      titleKey: "outbound",
      sentenceKey: "outboundSentence",
      evidenceKey: "evidenceSynSent",
      initiatorKey: "local",
      providerKey: "remoteProvides",
      arrow: "→",
      service,
    };
  }
  if (entry.state === "SynRcvd") {
    return {
      role: "inbound",
      confidence: "exact",
      titleKey: "inbound",
      sentenceKey: "inboundSentence",
      evidenceKey: "evidenceSynRcvd",
      initiatorKey: "remote",
      providerKey: "localProvides",
      arrow: "←",
      service,
    };
  }
  if (
    isLikelyEphemeral(entry.local_port) &&
    !isLikelyEphemeral(entry.remote_port)
  ) {
    return {
      role: "outbound",
      confidence: "high",
      titleKey: "outbound",
      sentenceKey: "outboundSentence",
      evidenceKey: "evidenceOutboundPort",
      initiatorKey: "local",
      providerKey: "remoteProvides",
      arrow: "→",
      service,
    };
  }
  if (
    !isLikelyEphemeral(entry.local_port) &&
    isLikelyEphemeral(entry.remote_port)
  ) {
    return {
      role: "inbound",
      confidence: "high",
      titleKey: "inbound",
      sentenceKey: "inboundSentence",
      evidenceKey: "evidenceInboundPort",
      initiatorKey: "remote",
      providerKey: "localProvides",
      arrow: "←",
      service,
    };
  }
  return {
    role: "unknown",
    confidence: "low",
    titleKey: "unknownRole",
    sentenceKey: "unknownSentence",
    evidenceKey: "evidenceUnknown",
    initiatorKey: "unknown",
    providerKey: "unknown",
    arrow: "?",
    service,
  };
}

export function relationSentence(entry: PortEntry, locale: AppLocale): string {
  const relation = analyzeConnection(entry);
  return translate(locale, relation.sentenceKey, {
    process:
      entry.process_name ?? (locale === "zh-CN" ? "该进程" : "The process"),
    local: localEndpoint(entry),
    remote: remoteEndpoint(entry),
    service: relation.service,
  });
}
