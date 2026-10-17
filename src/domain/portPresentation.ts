import { confidenceLabel, kindLabel, serviceManagerLabel } from "./attribution";
import { NO_VALUE, UNIDENTIFIED, type FacetField } from "./portFacets";
import {
  processStatusLabel,
  stateLabel,
  translate,
  type AppLocale,
  type TranslationKey,
} from "../i18n";
import type {
  AttributionConfidence,
  AttributionKind,
  ConnectionState,
  PortColumnField,
  ProcessStatus,
  ServiceManager,
} from "../types/port";

export const COLUMN_LABEL_KEYS: Partial<
  Record<PortColumnField, TranslationKey>
> = {
  service_name: "serviceName",
  service_description: "serviceDescription",
  local_host: "localHost",
  remote_host: "remoteHost",
  protocol: "protocol",
  ip_version: "ipVersion",
  local_address: "localAddress",
  local_port: "localPort",
  remote_address: "remoteAddress",
  remote_port: "remotePort",
  role: "directionRole",
  state: "state",
  service_manager: "serviceManager",
  attribution: "attributionName",
  attribution_kind: "attributionKind",
  attribution_confidence: "attributionConfidence",
  process_status: "processState",
  process_name: "processName",
  process_path: "processPath",
  process_created_at: "processCreated",
};

export function columnLabel(field: PortColumnField, locale: AppLocale): string {
  const key = COLUMN_LABEL_KEYS[field];
  return key ? translate(locale, key) : field === "pid" ? "PID" : field;
}

const ROLE_LABELS: Record<string, TranslationKey> = {
  listen: "listening",
  outbound: "outbound",
  inbound: "inbound",
  loopback: "loopback",
  "udp-bind": "udpBind",
  "udp-peer": "udpPeer",
  unknown: "unknownRole",
};

export function facetValueLabel(
  field: FacetField,
  value: string,
  locale: AppLocale,
): string {
  if (value === NO_VALUE)
    return translate(
      locale,
      field === "remote_address" || field === "remote_port"
        ? "noFixedPeer"
        : "notApplicable",
    );
  if (value === UNIDENTIFIED) return translate(locale, "unidentified");
  switch (field) {
    case "protocol":
      return value.toUpperCase();
    case "ip_version":
      return value === "V4" ? "IPv4" : value === "V6" ? "IPv6" : value;
    case "service_manager":
      return serviceManagerLabel(value as ServiceManager, locale) ?? value;
    case "state":
      return stateLabel(locale, value as ConnectionState) ?? value;
    case "role":
      return ROLE_LABELS[value] ? translate(locale, ROLE_LABELS[value]) : value;
    case "process_status":
      return processStatusLabel(locale, value as ProcessStatus) ?? value;
    case "attribution_kind":
      return kindLabel(value as AttributionKind, locale) ?? value;
    case "attribution_confidence":
      return confidenceLabel(value as AttributionConfidence, locale) ?? value;
    default:
      return value;
  }
}
