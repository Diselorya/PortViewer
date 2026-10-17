import type { PortEntry } from "../types/port";
import { hasRemoteEndpoint } from "./portFacets";

export interface EndpointLinkContext {
  runtime: "desktop" | "web";
  scanHost?: string;
  browserHost?: string;
  /** Explicit user protocol choice, rather than the current page's protocol. */
  scheme?: "http" | "https";
}
export interface EndpointLinkDecision {
  url: string | null;
  kind: "web" | "possible-web" | "unsupported" | "local-only";
  reason: string;
  confidence: "confirmed" | "candidate" | "none";
}
const no = (
  kind: "unsupported" | "local-only",
  reason: string,
): EndpointLinkDecision => ({ url: null, kind, reason, confidence: "none" });
const securePorts = new Set([443, 4443, 8443, 9443]);
const webPorts = new Set([
  80, 81, 3000, 3001, 4173, 4200, 5000, 5173, 8000, 8001, 8080, 8081, 8888,
  9000, 9090,
]);
const nonWebPorts = new Set([
  20, 21, 22, 23, 25, 53, 110, 123, 135, 137, 138, 139, 143, 161, 162, 389, 445,
  465, 587, 636, 993, 995, 1433, 1521, 2375, 2376, 3306, 3389, 5432, 5672, 5900,
  6379, 11211, 27017,
]);
function stripBrackets(host: string): string {
  return host.replace(/^\[|\]$/g, "");
}
function loopback(host: string): boolean {
  return (
    /^127\./.test(host) ||
    /^::ffff:127\./i.test(host) ||
    ["::1", "localhost", "0:0:0:0:0:0:0:1"].includes(host.toLowerCase())
  );
}
function safeHost(host: string): boolean {
  return (
    Boolean(host) &&
    !/[\s/@?#\\]/.test(host) &&
    !host.includes("://") &&
    /^[\da-f:.%a-z_-]+$/i.test(host)
  );
}
function webEvidence(
  entry: PortEntry,
  port: number,
): { web: boolean; scheme?: "http" | "https" } {
  let web = false,
    scheme: "http" | "https" | undefined;
  for (const item of entry.attributions ?? []) {
    if (item.kind === "NginxSite" || item.kind === "IisSite") web = true;
    for (const fact of item.facts) {
      if (
        /^(protocol|协议)$/i.test(fact.label) &&
        /^https?$/i.test(fact.value.trim())
      ) {
        scheme = fact.value.trim().toLowerCase() as "http" | "https";
        web = true;
      } else if (/url|网址|地址|binding|绑定/i.test(fact.label)) {
        try {
          const url = new URL(fact.value);
          if (
            ["http:", "https:"].includes(url.protocol) &&
            Number(url.port || (url.protocol === "https:" ? 443 : 80)) === port
          ) {
            scheme = url.protocol === "https:" ? "https" : "http";
            web = true;
          }
        } catch {
          /* A path or non-URL fact is not protocol evidence. */
        }
      }
    }
  }
  return { web, scheme };
}
/** Only a protocol fact confirms a Web link. User-selected protocols remain a trial. */
export function endpointLink(
  entry: PortEntry,
  side: "local" | "remote",
  context: EndpointLinkContext,
): EndpointLinkDecision {
  if (entry.protocol !== "Tcp")
    return no("unsupported", "非 TCP 端点不提供网页链接");
  if (side === "remote" && !hasRemoteEndpoint(entry))
    return no("unsupported", "没有固定对端");
  const port = side === "local" ? entry.local_port : entry.remote_port;
  if (!port || !Number.isInteger(port) || port < 1 || port > 65535)
    return no("unsupported", "端口无效");
  if (side === "local" && entry.state !== "Listen")
    return no("unsupported", "本地连接端口不是监听服务");
  let host = stripBrackets(
    side === "local" ? entry.local_address : (entry.remote_address ?? ""),
  );
  const scanHost = stripBrackets(context.scanHost ?? ""),
    browserHost = stripBrackets(context.browserHost ?? "");
  const remoteScan =
    context.runtime === "web" &&
    Boolean(scanHost || browserHost) &&
    !loopback(scanHost || browserHost);
  if (["0.0.0.0", "::", "*"].includes(host))
    host =
      context.runtime === "desktop" ? "127.0.0.1" : scanHost || browserHost;
  else if (loopback(host) && remoteScan)
    return no("local-only", "仅扫描主机本机可访问");
  if (!safeHost(host) || host === "::" || host === "0.0.0.0")
    return no("unsupported", "无法确定可访问的主机地址");
  if (host.includes("%") || /^fe[89ab][\da-f]:/i.test(host))
    return no(
      "local-only",
      "IPv6 链路本地地址需要网卡作用域，请在详情复制原地址",
    );
  const evidence =
    side === "local"
      ? webEvidence(entry, port)
      : { web: false, scheme: undefined };
  const known = securePorts.has(port) || webPorts.has(port);
  if (!context.scheme && !evidence.web && (nonWebPorts.has(port) || !known))
    return no("unsupported", "尚无 Web 协议证据，可在详情选择协议尝试打开");
  if (
    !context.scheme &&
    !evidence.web &&
    /(sshd?|redis|postgres|mysqld?|mongod|rabbitmq|dnsmasq)/i.test(
      entry.process_name ?? "",
    )
  )
    return no("unsupported", "已识别为非 Web 程序");
  const scheme =
    context.scheme ??
    evidence.scheme ??
    (securePorts.has(port) ? "https" : "http");
  const confirmed = evidence.scheme === scheme;
  const authority = host.includes(":") ? "[" + host + "]" : host;
  try {
    const url = new URL(scheme + "://" + authority + ":" + port + "/");
    return {
      url: url.href,
      kind: confirmed ? "web" : "possible-web",
      confidence: confirmed ? "confirmed" : "candidate",
      reason: confirmed
        ? "服务配置明确此端点的 Web 协议"
        : context.scheme
          ? "按所选协议尝试打开，尚未确认"
          : evidence.web
            ? "服务配置表明此端点提供 Web 服务，协议尚未确认"
            : "常见 Web 端口，协议尚未确认",
    };
  } catch {
    return no("unsupported", "主机地址无效");
  }
}
