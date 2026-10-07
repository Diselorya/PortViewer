import { describe, expect, it } from "vitest";
import { createCsv, createJson, escapeCsv } from "../exportData";
import type { PortEntry } from "../../types/port";

function entry(patch: Partial<PortEntry> = {}): PortEntry {
  return {
    protocol: "Udp",
    ip_version: "V6",
    local_address: "::",
    local_port: 53,
    remote_address: null,
    remote_port: null,
    state: null,
    pid: 9,
    process_name: "程序.exe",
    process_path: 'C:\\a,"b".exe',
    process_created_at: null,
    process_status: "Partial",
    process_status_message: "访问受限",
    attributions: [],
    ...patch,
  };
}

describe("exports", () => {
  it("adds BOM, represents UDP fields as not applicable and quotes RFC 4180 values", () => {
    const csv = createCsv([entry({ process_name: "程序,\n工具.exe" })]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('"程序,\n工具.exe"');
    expect(csv).toContain('"C:\\a,""b"".exe"');
    expect(csv.match(/—/g)).toHaveLength(3);
    expect(csv.split("\r\n")).toHaveLength(2);
  });

  it.each(["=1+1", "+cmd", "-2+3", "@SUM(A1)", "\ttab", "\rcarriage"])(
    "protects spreadsheet formula prefix %s",
    (value) => expect(escapeCsv(value)).toContain(`'${value}`),
  );

  it("does not modify safe numeric and ordinary text fields", () => {
    expect(escapeCsv(3000)).toBe("3000");
    expect(escapeCsv("node.exe")).toBe("node.exe");
  });

  it("exports an empty view as a BOM-prefixed header without a phantom row", () => {
    const csv = createCsv([], ["local_port", "pid"]);

    expect(csv).toBe("\uFEFF本地端口,PID");
  });

  it("preserves caller-selected column order", () => {
    const csv = createCsv([entry()], ["pid", "local_address", "protocol"]);

    expect(csv).toBe("\uFEFFPID,本地地址,协议\r\n9,::,Udp");
  });

  it("quotes a protected formula when the original field also contains a comma", () => {
    expect(escapeCsv("=SUM(A1,A2)")).toBe('"\'=SUM(A1,A2)"');
  });

  it("includes a stable metadata envelope and preserves null field types", () => {
    const metadata = {
      productVersion: "1.0.0",
      exportedAt: "2026-08-23T01:02:03Z",
      scannedAt: "2026-08-23T01:02:00Z",
      filters: { query: "53", protocols: ["Udp"], states: [] },
      entryCount: 1,
      truncated: true,
    };
    const json = JSON.parse(createJson([entry()], metadata));
    expect(json).toMatchObject({ schemaVersion: 2, metadata });
    expect(json.entries).toHaveLength(1);
    expect(json.entries[0]).toMatchObject({
      remote_address: null,
      remote_port: null,
      state: null,
    });
  });

  it("preserves the current-view entry order in JSON", () => {
    const metadata = {
      productVersion: "1.0.0",
      exportedAt: "2026-08-23T01:02:03Z",
      scannedAt: null,
      filters: { query: "", protocols: [], states: [] },
      entryCount: 2,
      truncated: false,
    };
    const json = JSON.parse(
      createJson([entry({ pid: 2 }), entry({ pid: 1 })], metadata),
    );

    expect(json.entries.map((item: PortEntry) => item.pid)).toEqual([2, 1]);
  });

  it("exports every attribution candidate to CSV and the structured evidence to JSON", () => {
    const attributed = entry({
      attributions: [
        {
          kind: "NginxSite",
          name: "api.example.test",
          description: "Nginx 虚拟主机",
          confidence: "High",
          source: "nginx.conf",
          facts: [{ label: "监听", value: "*:443" }],
        },
        {
          kind: "NssmService",
          name: "Gateway Service",
          description: "NSSM 托管的 Windows 服务",
          confidence: "High",
          source: "Win32_Service",
          facts: [{ label: "服务名", value: "gateway" }],
        },
      ],
    });
    const csv = createCsv([attributed], ["attribution"]);
    expect(csv).toContain("Nginx 站点: api.example.test");
    expect(csv).toContain("NSSM 服务: Gateway Service");

    const json = JSON.parse(
      createJson([attributed], {
        productVersion: "1.0.0",
        exportedAt: "2026-08-23T01:02:03Z",
        scannedAt: null,
        filters: { query: "", protocols: [], states: [] },
        entryCount: 1,
        truncated: false,
      }),
    );
    expect(json.schemaVersion).toBe(2);
    expect(json.entries[0].attributions).toHaveLength(2);
    expect(json.entries[0].attributions[0].facts[0]).toEqual({
      label: "监听",
      value: "*:443",
    });
  });
});
