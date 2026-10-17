import { describe, expect, it } from "vitest";
import { endpointLink } from "../endpointLink";
import { port } from "./workbenchFixtures";
import type { PortEntry } from "../../types/port";
const desktop = { runtime: "desktop" } as const;
function protocolEvidence(value: string): PortEntry["attributions"] {
  return [
    {
      kind: "NodeApplication",
      name: "demo",
      description: null,
      confidence: "High",
      source: "config",
      facts: [{ label: "protocol", value }],
    },
  ];
}

describe("endpoint links", () => {
  it("should choose loopback for a desktop wildcard without using Tauri's hostname", () => {
    expect(
      endpointLink(port({ local_address: "0.0.0.0" }), "local", {
        ...desktop,
        browserHost: "tauri.localhost",
      }),
    ).toMatchObject({ url: "http://127.0.0.1:3000/", confidence: "candidate" });
  });
  it.each(["0.0.0.0", "::", "*"])(
    "should map WebGUI wildcard %s to the scanner reachable host",
    (address) => {
      expect(
        endpointLink(port({ local_address: address }), "local", {
          runtime: "web",
          scanHost: "192.168.1.50",
          browserHost: "192.168.1.50",
        }).url,
      ).toBe("http://192.168.1.50:3000/");
    },
  );
  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])(
    "should refuse remote WebGUI loopback %s",
    (address) => {
      expect(
        endpointLink(port({ local_address: address }), "local", {
          runtime: "web",
          scanHost: "192.168.1.50",
        }),
      ).toMatchObject({ url: null, kind: "local-only" });
    },
  );
  it("should allow a loopback scanner hosted in a local browser", () => {
    expect(
      endpointLink(port(), "local", { runtime: "web", scanHost: "localhost" })
        .url,
    ).toBe("http://127.0.0.1:3000/");
  });
  it("should bracket a global IPv6 address", () => {
    expect(
      endpointLink(
        port({ ip_version: "V6", local_address: "2001:4860:4860::8888" }),
        "local",
        desktop,
      ).url,
    ).toBe("http://[2001:4860:4860::8888]:3000/");
  });
  it.each(["fe80::1%12", "fe80::1", "2001:4860::1%eth0"])(
    "should preserve scoped address %s for copying rather than fabricate a browser link",
    (address) => {
      const entry = port({ ip_version: "V6", local_address: address });
      expect(endpointLink(entry, "local", desktop)).toMatchObject({
        url: null,
        kind: "local-only",
      });
      expect(entry.local_address).toBe(address);
    },
  );
  it("should honor a confirmed HTTPS protocol on a nonstandard non-Web port", () => {
    expect(
      endpointLink(
        port({ local_port: 5432, attributions: protocolEvidence("https") }),
        "local",
        desktop,
      ),
    ).toMatchObject({
      url: "https://127.0.0.1:5432/",
      kind: "web",
      confidence: "confirmed",
    });
  });
  it("should use an exact binding URL as HTTPS evidence", () => {
    const entry = port({
      local_port: 8123,
      attributions: [
        {
          kind: "IisSite",
          name: "demo",
          description: null,
          confidence: "Exact",
          source: "applicationHost.config",
          facts: [{ label: "binding", value: "https://example.test:8123/" }],
        },
      ],
    });
    expect(endpointLink(entry, "local", desktop)).toMatchObject({
      url: "https://127.0.0.1:8123/",
      confidence: "confirmed",
    });
  });
  it("should not borrow protocol evidence from a different binding port", () => {
    const entry = port({
      local_port: 8123,
      attributions: [
        {
          kind: "NodeApplication",
          name: "demo",
          description: null,
          confidence: "High",
          source: "config",
          facts: [{ label: "URL", value: "https://example.test:8443/" }],
        },
      ],
    });
    expect(endpointLink(entry, "local", desktop).url).toBeNull();
  });
  it("should honor the user's protocol choice as an unconfirmed trial", () => {
    expect(
      endpointLink(port({ local_port: 8123 }), "local", {
        ...desktop,
        scheme: "https",
      }),
    ).toMatchObject({
      url: "https://127.0.0.1:8123/",
      confidence: "candidate",
    });
  });
  it("should let the user override an HTTPS binding without presenting HTTP as confirmed", () => {
    expect(
      endpointLink(
        port({ local_port: 8123, attributions: protocolEvidence("https") }),
        "local",
        { ...desktop, scheme: "http" },
      ),
    ).toMatchObject({ url: "http://127.0.0.1:8123/", confidence: "candidate" });
  });
  it.each([22, 5432, 65535])(
    "should require an explicit protocol for an unknown TCP service at %i",
    (local_port) => {
      expect(
        endpointLink(port({ local_port }), "local", desktop).url,
      ).toBeNull();
      expect(
        endpointLink(port({ local_port }), "local", {
          ...desktop,
          scheme: "http",
        }).confidence,
      ).toBe("candidate");
    },
  );
  it("should not label SSH as Web merely because it uses a common Web port", () => {
    expect(
      endpointLink(
        port({ process_name: "sshd", local_port: 8080 }),
        "local",
        desktop,
      ).url,
    ).toBeNull();
  });
  it.each([0, -1, 65536, 1.5, Number.NaN])(
    "should reject invalid port %s",
    (local_port) => {
      expect(
        endpointLink(port({ local_port }), "local", {
          ...desktop,
          scheme: "http",
        }).url,
      ).toBeNull();
    },
  );
  it.each([
    "bad host",
    "user@example.test",
    "example.test/path",
    "example.test?x=1",
    "https://example.test",
  ])("should reject host injection %s", (local_address) => {
    expect(
      endpointLink(port({ local_address }), "local", desktop).url,
    ).toBeNull();
  });
  it("should reject UDP even when the user explicitly selects HTTP", () => {
    expect(
      endpointLink(port({ protocol: "Udp", state: null }), "local", {
        ...desktop,
        scheme: "http",
      }).url,
    ).toBeNull();
  });
  it("should reject a local ephemeral connection endpoint", () => {
    expect(
      endpointLink(port({ state: "Established" }), "local", {
        ...desktop,
        scheme: "http",
      }).url,
    ).toBeNull();
  });
  it("should link a concrete remote endpoint without borrowing local HTTPS evidence", () => {
    expect(
      endpointLink(
        port({
          state: "Established",
          remote_address: "203.0.113.9",
          remote_port: 8080,
          attributions: protocolEvidence("https"),
        }),
        "remote",
        desktop,
      ),
    ).toMatchObject({
      url: "http://203.0.113.9:8080/",
      confidence: "candidate",
    });
  });
  it.each([
    { remote_address: null, remote_port: 80 },
    { remote_address: "1.1.1.1", remote_port: 0 },
    { remote_address: "1.1.1.1", remote_port: null },
  ])("should reject an incomplete peer %o", (patch) => {
    expect(
      endpointLink(port({ state: "Established", ...patch }), "remote", desktop)
        .url,
    ).toBeNull();
  });
});
