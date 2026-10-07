import { describe, expect, it } from "vitest";
import {
  analyzeConnection,
  relationSentence,
  remoteEndpoint,
} from "../connectionRelation";
import type { PortEntry } from "../../types/port";

function entry(patch: Partial<PortEntry> = {}): PortEntry {
  return {
    protocol: "Tcp",
    ip_version: "V4",
    local_address: "10.0.0.5",
    local_port: 53000,
    remote_address: "1.1.1.1",
    remote_port: 443,
    state: "Established",
    pid: 42,
    process_name: "chrome.exe",
    process_path: null,
    process_created_at: null,
    process_status: "Partial",
    process_status_message: null,
    attributions: [],
    ...patch,
  };
}

describe("connection relation", () => {
  it("classifies listeners and handshake directions from authoritative TCP state", () => {
    const listener = entry({
      state: "Listen",
      local_port: 80,
      remote_address: "0.0.0.0",
      remote_port: 0,
    });
    expect(analyzeConnection(listener)).toMatchObject({
      role: "listen",
      service: "HTTP",
    });
    expect(remoteEndpoint(listener)).toBe("—");
    expect(analyzeConnection(entry({ state: "SynSent" })).role).toBe(
      "outbound",
    );
    expect(analyzeConnection(entry({ state: "SynRcvd" })).role).toBe("inbound");
  });

  it("uses the provider endpoint to infer inbound service", () => {
    expect(
      analyzeConnection(
        entry({ state: "SynRcvd", local_port: 443, remote_port: 53000 }),
      ).service,
    ).toBe("HTTPS");
  });

  it("classifies loopback before applying port heuristics", () => {
    expect(
      analyzeConnection(
        entry({ local_address: "127.0.0.1", remote_address: "127.0.0.1" }),
      ).role,
    ).toBe("loopback");
  });

  it("keeps UDP bindings and peer records distinct", () => {
    expect(
      analyzeConnection(
        entry({
          protocol: "Udp",
          state: null,
          remote_address: null,
          remote_port: null,
        }),
      ).role,
    ).toBe("udp-bind");
    expect(
      analyzeConnection(entry({ protocol: "Udp", state: null })).role,
    ).toBe("udp-peer");
  });

  it("explains outbound traffic in both languages", () => {
    expect(relationSentence(entry(), "zh-CN")).toContain("本机 10.0.0.5:53000");
    expect(relationSentence(entry(), "en-US")).toContain("peer provides");
  });
});
