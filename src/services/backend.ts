import { invoke as tauriInvoke } from "@tauri-apps/api/core";

type InvokeArgs = Record<string, unknown> | undefined;

export function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

export function isWebRuntime(): boolean {
  return !isTauriRuntime() && import.meta.env.MODE !== "test";
}

async function api<T>(
  path: string,
  method = "GET",
  payload?: unknown,
): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(new URL(path, document.baseURI).href, {
      method,
      headers:
        payload === undefined
          ? undefined
          : { "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      let detail = body || response.statusText;
      try {
        const parsed = JSON.parse(body) as { error?: string };
        detail = parsed.error ?? detail;
      } catch {
        // Keep the bounded plain-text response.
      }
      throw new Error(`WebGUI API ${response.status}: ${detail.slice(0, 500)}`);
    }
    return JSON.parse(body) as T;
  } finally {
    window.clearTimeout(timeout);
  }
}

function browserExport(args: InvokeArgs): string {
  const suggestedName = String(args?.suggestedName ?? "PortViewer.json");
  const contents = String(args?.contents ?? "");
  const format = args?.format === "csv" ? "csv" : "json";
  const blob = new Blob([contents], {
    type:
      format === "csv"
        ? "text/csv;charset=utf-8"
        : "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = suggestedName;
  link.rel = "noopener";
  link.click();
  URL.revokeObjectURL(url);
  return suggestedName;
}

export async function invokeWeb<T>(
  command: string,
  args?: InvokeArgs,
): Promise<T> {
  switch (command) {
    case "get_service_profiles":
      return api<T>("api/v1/knowledge/profiles", "POST", {
        profile_ids: args?.profileIds,
        public_ids: args?.publicIds,
        refresh: args?.refresh === true,
      });
    case "get_host_context":
      return api<T>(
        `api/v1/knowledge/host${typeof args?.address === "string" ? `?address=${encodeURIComponent(args.address)}` : ""}`,
      );
    case "get_knowledge_settings":
      return api<T>("api/v1/knowledge/settings");
    case "set_knowledge_settings":
      return api<T>("api/v1/knowledge/settings", "PUT", args?.settings);
    case "get_build_identity":
      return api<T>("api/v1/build-identity");
    case "scan_all_ports":
      return api<T>("api/v1/scan");
    case "get_privilege_status":
      return {
        is_elevated: false,
        elevation_type: "WebReadOnly",
        integrity_level: "Service",
        can_elevate: false,
        elevation_reason: "WebGuiReadOnly",
      } as T;
    case "save_export":
      return browserExport(args) as T;
    case "restart_elevated":
    case "kill_process":
    case "enrich_ports":
      throw new Error(
        "WebGUI 当前为只读模式；进程终止和提权操作只在 Windows 桌面版提供。",
      );
    default:
      throw new Error(`WebGUI 不支持后端命令：${command}`);
  }
}

export async function invoke<T>(
  command: string,
  args?: InvokeArgs,
): Promise<T> {
  if (isWebRuntime()) return invokeWeb<T>(command, args);
  return args === undefined
    ? tauriInvoke<T>(command)
    : tauriInvoke<T>(command, args);
}

/** Open only validated web URLs; the native handler repeats the validation. */
export async function openExternalUrl(value: string): Promise<void> {
  if (value.length > 2048 || [...value].some((char) => char.charCodeAt(0) < 32))
    throw new Error("链接无效");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("链接无效");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !url.hostname
  )
    throw new Error("仅支持无凭据的 HTTP/HTTPS 链接");
  if (isWebRuntime()) {
    window.open(url.href, "_blank", "noopener,noreferrer");
    return;
  }
  await invoke("open_external_url", { url: url.href });
}
