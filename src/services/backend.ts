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

async function api<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(path, {
      method: "GET",
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
    case "get_build_identity":
      return api<T>("/api/v1/build-identity");
    case "scan_all_ports":
      return api<T>("/api/v1/scan");
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
