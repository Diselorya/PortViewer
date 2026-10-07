import { describe, expect, it } from "vitest";
import { parseQuery, queryEntries } from "../portQuery";
import type { PortEntry } from "../../types/port";

function entry(patch: Partial<PortEntry> = {}): PortEntry {
  return {
    protocol: "Tcp",
    ip_version: "V4",
    local_address: "127.0.0.1",
    local_port: 3000,
    remote_address: "10.0.0.8",
    remote_port: 443,
    state: "Listen",
    pid: 42,
    process_name: "node.exe",
    process_path: "C:\\Program Files\\Node\\node.exe",
    process_created_at: "2026-08-23T00:00:00Z",
    process_status: "Available",
    process_status_message: null,
    attributions: [],
    ...patch,
  };
}

describe("port query", () => {
  it("parses all supported field aliases and falls back to text", () => {
    expect(
      parseQuery(
        "port:3000 pid:42 process:node ip:::1 state:listen protocol:tcp unknown:value",
      ),
    ).toEqual([
      { field: "port", value: "3000" },
      { field: "pid", value: "42" },
      { field: "process", value: "node" },
      { field: "ip", value: "::1" },
      { field: "state", value: "listen" },
      { field: "protocol", value: "tcp" },
      { field: "text", value: "unknown:value" },
    ]);
  });

  it("combines query, protocol and TCP state with AND semantics", () => {
    const source = [entry(), entry({ protocol: "Udp", state: null })];
    expect(queryEntries(source, "port:3000", ["Tcp"], ["Listen"], [])).toEqual([
      source[0],
    ]);
    expect(queryEntries(source, "port:3000", ["Udp"], ["Listen"], [])).toEqual(
      [],
    );
  });

  it("matches PID, process path and IPv6 case-insensitively after trimming", () => {
    const ipv6 = entry({
      ip_version: "V6",
      local_address: "::1",
      process_name: "程序-NODE.EXE",
      process_path: "C:\\Long Path\\程序-NODE.EXE",
    });
    expect(queryEntries([ipv6], "  程序-node  ", [], [], [])).toHaveLength(1);
    expect(queryEntries([ipv6], "pid:42 ip:::1", [], [], [])).toHaveLength(1);
    expect(
      queryEntries([ipv6], "process:LONG protocol:TCP", [], [], []),
    ).toHaveLength(1);
  });

  it("does not crash when process identity and remote endpoint are unavailable", () => {
    const unavailable = entry({
      protocol: "Udp",
      remote_address: null,
      remote_port: null,
      state: null,
      process_name: null,
      process_path: null,
      process_status: "AccessDenied",
    });
    expect(queryEntries([unavailable], "udp", [], [], [])).toEqual([
      unavailable,
    ]);
    expect(queryEntries([unavailable], "process:node", [], [], [])).toEqual([]);
  });

  it("ranks exact local port ahead of remote port, PID and contains matches", () => {
    const local = entry({ local_port: 3000, pid: 1 });
    const remote = entry({ local_port: 80, remote_port: 3000, pid: 2 });
    const pid = entry({ local_port: 30, remote_port: 30, pid: 3000 });
    const contains = entry({ local_port: 13000, remote_port: 0, pid: 9 });
    expect(
      queryEntries([contains, pid, remote, local], "3000", [], [], []),
    ).toEqual([local, remote, pid, contains]);
  });

  it("sorts numeric and text fields and keeps equal rows stable", () => {
    const first = entry({ local_port: 3000, process_name: "zeta", pid: 1 });
    const second = entry({ local_port: 80, process_name: "Alpha", pid: 2 });
    const third = entry({ local_port: 80, process_name: "alpha", pid: 3 });
    expect(
      queryEntries(
        [first, second, third],
        "",
        [],
        [],
        [
          { field: "local_port", order: 1 },
          { field: "process_name", order: 1 },
        ],
      ).map((item) => item.pid),
    ).toEqual([2, 3, 1]);
    expect(
      queryEntries(
        [second, third],
        "",
        [],
        [],
        [{ field: "process_name", order: 1 }],
      ),
    ).toEqual([second, third]);
  });

  it("returns an empty result for an empty source", () => {
    expect(queryEntries([], "port:0", ["Tcp"], ["Listen"], [])).toEqual([]);
  });

  it("matches minimum and maximum port values exactly", () => {
    const minimum = entry({ local_port: 0, pid: 1 });
    const maximum = entry({ local_port: 65535, pid: 2 });

    expect(queryEntries([minimum, maximum], "port:0", [], [], [])).toEqual([
      minimum,
    ]);
    expect(queryEntries([minimum, maximum], "port:65535", [], [], [])).toEqual([
      maximum,
    ]);
  });

  it("requires every query token to match the same entry", () => {
    const node = entry({ process_name: "node.exe", local_port: 3000 });

    expect(queryEntries([node], "process:node port:4000", [], [], [])).toEqual(
      [],
    );
  });

  it("never matches UDP entries through a TCP state token", () => {
    const udp = entry({ protocol: "Udp", state: null });

    expect(queryEntries([udp], "state:listen", [], [], [])).toEqual([]);
  });

  it("searches precise workload names, kinds and evidence facts", () => {
    const docker = entry({
      process_name: "com.docker.backend.exe",
      attributions: [
        {
          kind: "DockerContainer",
          name: "api-1 · demo/api",
          description: "Docker 容器 · demo/api:1",
          confidence: "Exact",
          source: "本地 Docker Engine published port",
          facts: [
            { label: "镜像", value: "demo/api:1" },
            { label: "端口映射", value: "0.0.0.0:18000 → 8000/tcp" },
          ],
        },
      ],
    });

    expect(queryEntries([docker], "service:demo/api", [], [], [])).toEqual([
      docker,
    ]);
    expect(queryEntries([docker], "owner:docker", [], [], [])).toEqual([
      docker,
    ]);
    expect(queryEntries([docker], "workload:18000", [], [], [])).toEqual([
      docker,
    ]);
  });

  it("supports descending numeric sort without mutating the source", () => {
    const low = entry({ local_port: 1, pid: 1 });
    const high = entry({ local_port: 65535, pid: 2 });
    const source = [low, high];

    expect(
      queryEntries(source, "", [], [], [{ field: "local_port", order: -1 }]),
    ).toEqual([high, low]);
    expect(source).toEqual([low, high]);
  });
});
