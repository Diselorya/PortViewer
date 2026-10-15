import { describe, expect, it } from "vitest";
import {
  FACET_FIELDS,
  NO_VALUE,
  UNIDENTIFIED,
  facetOptions,
  facetValues,
  groupEntries,
  matchesFacetFilters,
  type FacetField,
} from "../portFacets";
import { serviceManager, serviceManagerLabel } from "../attribution";
import type { PortEntry, ServiceAttribution } from "../../types/port";

function attribution(
  kind: ServiceAttribution["kind"],
  confidence: ServiceAttribution["confidence"] = "Exact",
): ServiceAttribution {
  return {
    kind,
    confidence,
    name: kind,
    description: null,
    source: "fixture",
    facts: [],
  };
}

function entry(patch: Partial<PortEntry> = {}): PortEntry {
  return {
    protocol: "Tcp",
    ip_version: "V4",
    local_address: "127.0.0.1",
    local_port: 8080,
    remote_address: null,
    remote_port: null,
    state: "Listen",
    pid: 42,
    process_name: "node",
    process_path: "/usr/bin/node",
    process_created_at: null,
    process_status: "Available",
    process_status_message: null,
    attributions: [],
    ...patch,
  };
}

describe("endpoint facets", () => {
  it.each<[FacetField, string[]]>([
    ["protocol", ["Tcp"]],
    ["ip_version", ["V4"]],
    ["local_address", ["127.0.0.1"]],
    ["local_port", ["8080"]],
    ["remote_address", [NO_VALUE]],
    ["remote_port", [NO_VALUE]],
    ["role", ["listen"]],
    ["state", ["Listen"]],
    ["service_manager", ["Unknown"]],
    ["process_status", ["Available"]],
    ["attribution_kind", [UNIDENTIFIED]],
    ["attribution_confidence", [UNIDENTIFIED]],
  ])("should expose a stable value for %s", (field, expected) => {
    expect(facetValues(entry(), field)).toEqual(expected);
  });

  it("should combine selected alternatives within one field and require every other field", () => {
    const docker = entry({ service_manager: "Docker" });
    const systemd = entry({ service_manager: "Systemd" });
    const ipv6 = entry({
      service_manager: "Docker",
      ip_version: "V6",
      local_address: "::1",
    });
    const filters = {
      service_manager: ["Docker", "Systemd"],
      ip_version: ["V4"],
    };
    expect(
      [docker, systemd, ipv6].filter((row) =>
        matchesFacetFilters(row, filters),
      ),
    ).toEqual([docker, systemd]);
  });

  it.each(FACET_FIELDS)(
    "should filter independently by %s and reject a non-matching selected value",
    (field) => {
      const row = entry();
      expect(
        matchesFacetFilters(row, { [field]: facetValues(row, field) }),
      ).toBe(true);
      expect(
        matchesFacetFilters(row, { [field]: ["absent-fixture-value"] }),
      ).toBe(false);
      expect(matchesFacetFilters(row, { [field]: [] })).toBe(true);
    },
  );

  it("should expose UDP state and a listener's synthetic peer as not applicable", () => {
    const listener = entry({ remote_address: "0.0.0.0", remote_port: 0 });
    expect(facetValues(listener, "remote_address")).toEqual([NO_VALUE]);
    expect(facetValues(listener, "remote_port")).toEqual([NO_VALUE]);
    expect(
      facetValues(entry({ protocol: "Udp", state: null }), "state"),
    ).toEqual([NO_VALUE]);
  });

  it("should keep real IPv6 peer addresses and maximum port values intact", () => {
    const row = entry({
      ip_version: "V6",
      local_address: "::",
      local_port: 0,
      remote_address: "2001:db8::1",
      remote_port: 65535,
      state: "Established",
    });
    expect(facetValues(row, "local_port")).toEqual(["0"]);
    expect(facetValues(row, "remote_address")).toEqual(["2001:db8::1"]);
    expect(facetValues(row, "remote_port")).toEqual(["65535"]);
  });

  it("should match any attribution candidate and count a repeated kind once per endpoint", () => {
    const row = entry({
      attributions: [
        attribution("NodeApplication", "High"),
        attribution("SystemdService"),
        attribution("NodeApplication", "Medium"),
      ],
    });
    expect(
      matchesFacetFilters(row, {
        attribution_kind: ["SystemdService"],
        attribution_confidence: ["Medium"],
      }),
    ).toBe(true);
    expect(
      facetOptions([row], "attribution_kind").find(
        (option) => option.value === "NodeApplication",
      ),
    ).toEqual({ value: "NodeApplication", count: 1 });
  });

  it("should retain selected addresses missing from a new scan with a zero count", () => {
    const options = facetOptions([entry()], "local_address", ["192.0.2.17"]);
    expect(options).toContainEqual({ value: "192.0.2.17", count: 0 });
    expect(options).toContainEqual({ value: "127.0.0.1", count: 1 });
    expect(
      matchesFacetFilters(entry(), { local_address: ["192.0.2.17"] }),
    ).toBe(false);
    expect(matchesFacetFilters(entry(), {})).toBe(true);
  });

  it("should offer finite protocol and manager choices even with no endpoints", () => {
    expect(facetOptions([], "protocol")).toEqual([
      { value: "Tcp", count: 0 },
      { value: "Udp", count: 0 },
    ]);
    expect(
      facetOptions([], "service_manager").map((option) => option.value),
    ).toEqual(
      expect.arrayContaining([
        "Docker",
        "Systemd",
        "WindowsService",
        "Nssm",
        "Iis",
        "Nginx",
        "Unknown",
      ]),
    );
  });

  it("should sort numeric port options numerically without changing the source", () => {
    const rows = [
      entry({ local_port: 65535 }),
      entry({ local_port: 80 }),
      entry({ local_port: 0 }),
      entry({ local_port: 443 }),
    ];
    expect(
      facetOptions(rows, "local_port").map((option) => option.value),
    ).toEqual(["0", "80", "443", "65535"]);
    expect(rows.map((row) => row.local_port)).toEqual([65535, 80, 0, 443]);
  });

  it.each(FACET_FIELDS)(
    "should group every endpoint exactly once by %s",
    (field) => {
      const rows = [
        entry({ pid: 1 }),
        entry({
          pid: 2,
          attributions: [
            attribution("DockerContainer"),
            attribution("NodeApplication", "High"),
          ],
        }),
        entry({ pid: 3, protocol: "Udp", state: null }),
      ];
      const flattened = groupEntries(rows, field).flatMap(
        (group) => group.entries,
      );
      expect(flattened).toHaveLength(rows.length);
      expect(new Set(flattened)).toEqual(new Set(rows));
    },
  );

  it("should group equivalent multi-candidate sets together and preserve row order within a group", () => {
    const first = entry({
      pid: 1,
      attributions: [
        attribution("NodeApplication"),
        attribution("DockerContainer"),
      ],
    });
    const second = entry({
      pid: 2,
      attributions: [
        attribution("DockerContainer"),
        attribution("NodeApplication"),
      ],
    });
    expect(groupEntries([first, second], "attribution_kind")).toEqual([
      {
        key: JSON.stringify(["DockerContainer", "NodeApplication"]),
        values: ["DockerContainer", "NodeApplication"],
        entries: [first, second],
      },
    ]);
    expect(groupEntries([], "local_port")).toEqual([]);
  });
});

describe("service manager compatibility", () => {
  it("should honor an explicit manager supplied by the backend", () => {
    expect(
      serviceManager(
        entry({
          service_manager: "Systemd",
          attributions: [attribution("NodeApplication")],
        }),
      ),
    ).toBe("Systemd");
  });

  it.each<[ServiceAttribution["kind"], string]>([
    ["DockerContainer", "Docker"],
    ["NssmService", "Nssm"],
    ["WindowsService", "WindowsService"],
    ["SystemdService", "Systemd"],
    ["IisSite", "Iis"],
    ["IisAppPool", "Iis"],
    ["NginxSite", "Nginx"],
  ])("should infer %s from legacy attribution evidence", (kind, expected) => {
    expect(
      serviceManager(
        entry({
          attributions: [attribution("NodeApplication"), attribution(kind)],
        }),
      ),
    ).toBe(expected);
  });

  it("should not infer a service manager merely from the process name", () => {
    expect(
      serviceManager(entry({ process_name: "docker-proxy", attributions: [] })),
    ).toBe("Unknown");
  });

  it("should translate manager labels while preserving stable enum values", () => {
    expect(serviceManagerLabel("WindowsService", "zh-CN")).toBe("Windows 服务");
    expect(serviceManagerLabel("WindowsService", "en-US")).toBe(
      "Windows Services",
    );
    expect(serviceManagerLabel("Unknown", "en-US")).toBe("Unidentified");
  });
});
