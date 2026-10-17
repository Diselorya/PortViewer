/** Public software coordinates only; never include process arguments or local paths. */
export interface PublicServiceId {
  provider: "github" | "npm" | "pypi";
  name: string;
  version?: string;
}
export interface KnowledgeSource {
  id: string;
  kind: "local" | "catalog" | "registry" | "github" | "search" | "ai";
  title: string;
  url: string | null;
  fetched_at: string | null;
}
export interface ServiceCandidate {
  name: string;
  description: string | null;
  url: string;
  source_id: string;
}
export interface ServiceProfile {
  id: string;
  component_role: "workload" | "launcher" | "runtime" | "manager" | "system";
  original_name: string;
  display_name_zh: string | null;
  /** The actual local workload's declared purpose. Never sent to an AI provider. */
  summary: string | null;
  /** Curated/public software information; does not establish process ownership. */
  software_summary: string | null;
  identity_match: "confirmed" | "candidate" | "unresolved";
  public_ids: PublicServiceId[];
  sources: KnowledgeSource[];
  candidates: ServiceCandidate[];
  enrichment_status:
    | "ready"
    | "queued"
    | "offline"
    | "rate_limited"
    | "no_public_identifier"
    | "disabled"
    | "error";
  updated_at: string | null;
  stale: boolean;
  message: string | null;
}
export interface ServiceProfilesResult {
  profiles: ServiceProfile[];
  pending_count: number;
  online_enabled: boolean;
  ai_configured: boolean;
  ai_enabled: boolean;
}
export interface ServiceProfilesQuery {
  profile_ids?: string[];
  public_ids?: PublicServiceId[];
  refresh?: boolean;
}
export interface HostContext {
  address: string;
  kind:
    | "local"
    | "loopback"
    | "private"
    | "public"
    | "wildcard"
    | "link_local"
    | "multicast"
    | "unspecified";
  is_local: boolean;
  machine_name: string | null;
  hostname: string | null;
  hostname_source: "system" | "reverse_dns" | null;
  dns_status:
    | "ready"
    | "queued"
    | "not_found"
    | "timeout"
    | "disabled"
    | "not_applicable"
    | "error";
  os: string | null;
  /** Addresses observed in the scanner's sockets; not a complete interface inventory. */
  observed_addresses: string[];
  resolved_at: string | null;
}
export interface KnowledgeSettings {
  online_enabled: boolean;
  ai_enabled: boolean;
  reverse_dns_enabled: boolean;
}
export interface KnowledgeConfiguration extends KnowledgeSettings {
  ai_configured: boolean;
  ai_provider: string | null;
  ai_model: string | null;
  can_configure: boolean;
}
export interface ServiceCatalogEntry {
  id: string;
  display_name_zh: string;
  original_name: string;
  summary: string;
  component_role: ServiceProfile["component_role"];
  process_names: string[];
  service_names: string[];
  public_ids: PublicServiceId[];
  source_url: string;
}
export interface ServiceCatalog {
  schema_version: 1;
  entries: ServiceCatalogEntry[];
}
