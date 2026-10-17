import { describe, expect, it, vi } from "vitest";
import {
  validateSettings,
  validateColorRules,
  validateFacetFilters,
  validateSortSpecs,
} from "../settings";
import {
  ALL_COLUMN_FIELDS,
  COLUMN_WIDTH_LIMITS,
  DEFAULT_COLUMN_ORDER,
  DEFAULT_SETTINGS,
  DEFAULT_VISIBLE_COLUMNS,
} from "../../types/settings";
import type { PortColorRule } from "../../types/settings";
import { cellColor, rowColor } from "../portColor";
import { calculateColumnWidths } from "../tableLayout";
import { queryEntries } from "../portQuery";
import { groupEntries } from "../portFacets";
import { displayEntry } from "../serviceKnowledge";
import { port, profile } from "./workbenchFixtures";

describe("workbench settings migration", () => {
  it.each([1, 2, 3, 4])(
    "should migrate schema %i once while preserving hidden unrelated fields",
    (schemaVersion) => {
      const migrated = validateSettings({
        schemaVersion,
        visibleColumns: ["local_port", "process_name", "remote_address"],
        columnOrder: ["pid", "local_port"],
      });
      expect(migrated.schemaVersion).toBe(5);
      expect(migrated.visibleColumns).not.toContain("protocol");
      expect(migrated.columnOrder.slice(0, 2)).toEqual(["pid", "local_port"]);
      expect(validateSettings(migrated)).toEqual(migrated);
    },
  );
  it("should respect deliberately hidden service columns in schema 4", () => {
    expect(
      validateSettings({ schemaVersion: 4, visibleColumns: ["process_name"] })
        .visibleColumns,
    ).toEqual(["process_name"]);
  });
  it.each([
    null,
    undefined,
    [],
    "broken",
    { schemaVersion: 6 },
    { schemaVersion: "4" },
    { schemaVersion: 3.5 },
  ])("should recover invalid settings envelope %o", (value) => {
    expect(validateSettings(value)).toEqual(DEFAULT_SETTINGS);
  });
  it("should use the fresh default order when no saved settings fields exist", () => {
    expect(validateSettings({})).toEqual(DEFAULT_SETTINGS);
  });
  it("should use the requested thirteen-field order for a fresh view", () => {
    const fields = [
      "service_name",
      "process_name",
      "attribution_kind",
      "attribution",
      "state",
      "protocol",
      "local_address",
      "local_port",
      "role",
      "remote_host",
      "remote_address",
      "remote_port",
      "service_description",
    ];
    expect(DEFAULT_VISIBLE_COLUMNS).toEqual(fields);
    expect(DEFAULT_COLUMN_ORDER.slice(0, fields.length)).toEqual(fields);
  });
  it("should migrate the old default layout while preserving deliberate custom visibility and order", () => {
    const old = validateSettings({
      schemaVersion: 4,
      visibleColumns: [
        "service_name",
        "service_description",
        "protocol",
        "local_address",
        "local_port",
        "role",
        "remote_address",
        "remote_host",
        "remote_port",
        "state",
        "service_manager",
        "attribution",
        "pid",
        "process_name",
      ],
      columnOrder: [
        "service_name",
        "service_description",
        "local_port",
        "local_address",
        "local_host",
        "protocol",
        "state",
        "role",
        "remote_host",
        "remote_address",
        "remote_port",
        "service_manager",
        "attribution",
        "pid",
        "process_name",
        "process_path",
        "ip_version",
        "attribution_kind",
        "attribution_confidence",
        "process_status",
        "process_created_at",
      ],
    });
    expect(old.visibleColumns).toEqual(DEFAULT_VISIBLE_COLUMNS);
    expect(old.columnOrder).toEqual(DEFAULT_COLUMN_ORDER);
    const custom = validateSettings({
      schemaVersion: 4,
      visibleColumns: ["pid", "local_port"],
      columnOrder: ["pid", "local_port"],
    });
    expect(custom.visibleColumns).toEqual(["pid", "local_port"]);
    expect(custom.columnOrder.slice(0, 2)).toEqual(["pid", "local_port"]);
  });
  it("should validate persisted condition modes and discard unknown fields", () => {
    expect(
      validateSettings({
        schemaVersion: 5,
        filterMode: "any",
        filterFieldModes: {
          protocol: "all",
          state: "invalid",
          arbitrary: "any",
        },
        query: "node",
        facetFilters: { protocol: ["Tcp"] },
        groupExpansion: {
          defaultExpanded: false,
          exceptions: ["one", "one", 42],
        },
      }),
    ).toMatchObject({
      filterMode: "any",
      filterFieldModes: { protocol: "all" },
      query: "node",
      facetFilters: { protocol: ["Tcp"] },
      groupExpansion: { defaultExpanded: false, exceptions: ["one"] },
    });
    expect(
      validateSettings({
        schemaVersion: 5,
        filterMode: "invalid",
        filterFieldModes: null,
        groupExpansion: "invalid",
      }),
    ).toMatchObject({
      filterMode: "all",
      filterFieldModes: {},
      groupExpansion: { defaultExpanded: true, exceptions: [] },
    });
  });
  it("should clamp manual widths and discard unrecognized columns and nonfinite numbers", () => {
    const result = validateSettings({
      schemaVersion: 4,
      columnOrder: ["pid", "pid", "retired", "local_port"],
      columnWidths: {
        pid: -100,
        service_description: 9999,
        local_port: 102.6,
        local_address: Infinity,
        retired: 100,
      },
    });
    expect(result.columnWidths).toEqual({
      pid: COLUMN_WIDTH_LIMITS.pid.min,
      service_description: COLUMN_WIDTH_LIMITS.service_description.max,
      local_port: 103,
    });
    expect(new Set(result.columnOrder).size).toBe(ALL_COLUMN_FIELDS.length);
    expect(result.columnOrder).not.toContain("retired");
  });
  it("should reject duplicate or invalid sort terms and cap user priorities", () => {
    expect(
      validateSortSpecs([
        { field: "pid", order: -1 },
        { field: "pid", order: 1 },
        { field: "retired", order: 1 },
        { field: "local_port", order: "1" },
        null,
      ]),
    ).toEqual([{ field: "pid", order: -1 }]);
    expect(
      validateSortSpecs(
        ALL_COLUMN_FIELDS.map((field) => ({ field, order: 1 })),
      ),
    ).toHaveLength(8);
  });
  it("should constrain filter values and ignore arbitrary field names", () => {
    expect(
      validateFacetFilters({
        protocol: ["Tcp", "Tcp", null, "x".repeat(513)],
        unknown: ["x"],
      }),
    ).toEqual({ protocol: ["Tcp"] });
    expect(
      validateFacetFilters({
        local_port: Array.from({ length: 300 }, (_, i) => String(i)),
      }).local_port,
    ).toHaveLength(256);
  });
  it("should validate coloring targets, identifiers, palette and duplicate priorities", () => {
    const valid = {
      id: "one",
      enabled: true,
      color: "blue",
      filters: { state: ["Listen"] },
      target: {
        kind: "columns",
        fields: ["local_port", "local_port", "retired"],
      },
    };
    expect(
      validateColorRules([
        valid,
        { ...valid },
        { ...valid, id: "bad-color", color: "pink" },
        { ...valid, id: "empty", target: { kind: "columns", fields: [] } },
        { ...valid, id: "row", target: { kind: "row" }, enabled: false },
      ]),
    ).toEqual([
      {
        ...valid,
        mode: "all",
        fieldModes: {},
        target: { kind: "columns", fields: ["local_port"] },
      },
      {
        id: "row",
        enabled: false,
        color: "blue",
        filters: { state: ["Listen"] },
        mode: "all",
        fieldModes: {},
        target: { kind: "row" },
      },
    ]);
    expect(
      validateColorRules(
        Array.from({ length: 25 }, (_, i) => ({ ...valid, id: String(i) })),
      ),
    ).toHaveLength(20);
  });
});

const colorRule = (patch: Partial<PortColorRule> = {}): PortColorRule => ({
  id: "first",
  enabled: true,
  color: "blue",
  filters: { state: ["Listen"] },
  target: { kind: "row" },
  ...patch,
});
describe("conditional coloring", () => {
  it("should use the same outer-any and inner-all condition semantics as the filtered list", () => {
    const rows = [
      port({ pid: 1 }),
      port({ pid: 2, state: "Established" }),
      port({ pid: 3, protocol: "Udp", state: null }),
    ];
    const filters = { protocol: ["Tcp", "Udp"], state: ["Listen"] };
    const rule = colorRule({
      filters,
      mode: "any",
      fieldModes: { protocol: "all" },
    });
    expect(
      queryEntries(rows, "", [], [], [], filters, undefined, {
        mode: "any",
        fieldModes: { protocol: "all" },
      }).map((row) => row.pid),
    ).toEqual([1]);
    expect(
      rows
        .filter((row) => rowColor(row, [rule]) === "blue")
        .map((row) => row.pid),
    ).toEqual([1]);
    expect(rows.map((row) => cellColor(row, "local_port", [rule]))).toEqual([
      "blue",
      null,
      null,
    ]);
  });
  it("should use the first matching rule per cell while keeping unrelated columns unchanged", () => {
    const rules = [
      colorRule({
        target: { kind: "columns", fields: ["local_port"] },
        color: "red",
      }),
      colorRule({ id: "fallback", color: "green" }),
    ];
    expect(cellColor(port(), "local_port", rules)).toBe("red");
    expect(cellColor(port(), "pid", rules)).toBe("green");
    expect(rowColor(port(), rules)).toBe("green");
  });
  it("should ignore disabled and nonmatching conditions", () => {
    expect(
      cellColor(port(), "pid", [
        colorRule({ enabled: false }),

        colorRule({ id: "miss", filters: { protocol: ["Udp"] } }),
      ]),
    ).toBeNull();
    expect(
      rowColor(port(), [
        colorRule({ target: { kind: "columns", fields: ["pid"] } }),
      ]),
    ).toBeNull();
  });
  it("should apply an explicitly configured empty condition to its selected target", () => {
    const rules = [
      colorRule({
        filters: {},
        target: { kind: "columns", fields: ["local_port"] },
        color: "purple",
      }),
    ];
    expect(cellColor(port(), "local_port", rules)).toBe("purple");
    expect(cellColor(port(), "pid", rules)).toBeNull();
    expect(rowColor(port(), rules)).toBeNull();
    expect(rowColor(port(), [colorRule({ filters: {} })])).toBe("blue");
  });
  it("should OR values in a field and AND different fields using display aliases", () => {
    const info = profile();
    const entry = port({ service_profile_ids: [info.id] });
    const display = (row: ReturnType<typeof port>) =>
      displayEntry(row, new Map([[info.id, info]]));
    const rule = colorRule({
      filters: { service_name: ["other", "示例服务"], protocol: ["Tcp"] },
    });
    expect(cellColor(entry, "service_name", [rule], display)).toBe("blue");
    expect(
      cellColor(
        { ...entry, protocol: "Udp", state: null },
        "service_name",
        [rule],
        display,
      ),
    ).toBeNull();
  });
});

describe("compact automatic widths", () => {
  it("should give an empty table bounded header widths", () => {
    const widths = calculateColumnWidths([], ALL_COLUMN_FIELDS, "zh-CN");
    for (const field of ALL_COLUMN_FIELDS) {
      expect(widths[field]).toBeGreaterThanOrEqual(
        COLUMN_WIDTH_LIMITS[field].min,
      );
      expect(widths[field]).toBeLessThanOrEqual(COLUMN_WIDTH_LIMITS[field].max);
    }
  });
  it("should sample at most 80 entries per field in a 100000 row scan", () => {
    const measure = vi.fn(() => 1);
    const entries = Array.from({ length: 100000 }, (_, pid) => port({ pid }));
    calculateColumnWidths(entries, ["pid"], "zh-CN", undefined, measure);
    expect(measure).toHaveBeenCalledTimes(81);
  });
  it("should cap oversized display text and return finite widths for a broken measuring surface", () => {
    expect(
      calculateColumnWidths([port()], ["service_description"], "zh-CN", () => ({
        ...displayEntry(port()),
        serviceDescription: "文".repeat(10000),
      })).service_description,
    ).toBe(COLUMN_WIDTH_LIMITS.service_description.max);
    expect(
      calculateColumnWidths(
        [port()],
        ["pid"],
        "zh-CN",
        undefined,
        () => Number.NaN,
      ).pid,
    ).toBe(COLUMN_WIDTH_LIMITS.pid.min);
  });
});

describe("multi-sort and grouped workbench data", () => {
  it("should apply prioritized sorts and preserve input order for complete ties", () => {
    const entries = [
      port({ pid: 1, local_port: 80, service_manager: "Systemd" }),
      port({ pid: 2, local_port: 443, service_manager: "Docker" }),
      port({ pid: 3, local_port: 80, service_manager: "Docker" }),
      port({ pid: 4, local_port: 80, service_manager: "Docker" }),
    ];
    const result = queryEntries(
      entries,
      "",
      [],
      [],
      [
        { field: "service_manager", order: 1 },
        { field: "local_port", order: -1 },
      ],
    );
    expect(result.map((e) => e.pid)).toEqual([2, 3, 4, 1]);
    expect(
      groupEntries(result, "service_manager")
        .flatMap((group) => group.entries)
        .map((e) => e.pid),
    ).toEqual([2, 3, 4, 1]);
    expect(entries.map((e) => e.pid)).toEqual([1, 2, 3, 4]);
  });
  it("should filter, group, and sort using resolved service names", () => {
    const a = port({ pid: 1 }),
      b = port({ pid: 2 }),
      display = (entry: ReturnType<typeof port>) => ({
        ...displayEntry(entry),
        serviceName: entry.pid === 1 ? "Alpha" : "Beta",
      });
    expect(
      queryEntries(
        [b, a],
        "",
        [],
        [],
        [{ field: "service_name", order: 1 }],
        {},
        display,
      ).map((e) => e.pid),
    ).toEqual([1, 2]);
    expect(
      queryEntries(
        [a, b],
        "service:alpha",
        [],
        [],
        [],
        { service_name: ["Alpha"] },
        display,
      ),
    ).toEqual([a]);
    expect(
      groupEntries([a, b], "service_name", display).map(
        (group) => group.values,
      ),
    ).toEqual([["Alpha"], ["Beta"]]);
  });
});
