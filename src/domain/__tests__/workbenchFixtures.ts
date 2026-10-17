import type { PortEntry } from "../../types/port";
import type { HostContext, ServiceProfile } from "../../types/knowledge";

export function port(patch: Partial<PortEntry> = {}): PortEntry {
  return {
    protocol: "Tcp",
    ip_version: "V4",
    local_address: "127.0.0.1",
    local_port: 3000,
    remote_address: null,
    remote_port: null,
    state: "Listen",
    pid: 42,
    process_name: "node.exe",
    process_path: "C:\\projects\\demo\\node.exe",
    process_created_at: "2026-10-17T00:00:00Z",
    process_status: "Available",
    process_status_message: null,
    attributions: [],
    ...patch,
  };
}
export function profile(patch: Partial<ServiceProfile> = {}): ServiceProfile {
  return {
    id: "workload",
    component_role: "workload",
    original_name: "demo",
    display_name_zh: "示例服务",
    summary: null,
    software_summary: null,
    identity_match: "confirmed",
    public_ids: [],
    sources: [],
    candidates: [],
    enrichment_status: "ready",
    updated_at: null,
    stale: false,
    message: null,
    ...patch,
  };
}
export function host(patch: Partial<HostContext> = {}): HostContext {
  return {
    address: "127.0.0.1",
    kind: "loopback",
    is_local: true,
    machine_name: "scanner",
    hostname: null,
    hostname_source: "system",
    dns_status: "ready",
    os: "Windows",
    observed_addresses: ["127.0.0.1"],
    resolved_at: null,
    ...patch,
  };
}
