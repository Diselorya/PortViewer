import { describe, expect, it } from "vitest";
import { displayEntry, displayField } from "../serviceKnowledge";
import { host, port, profile } from "./workbenchFixtures";

describe("service knowledge presentation", () => {
  it("should prefer actual local workload purpose over public software documentation", () => {
    const workload = profile({
      summary: "本机订单接口",
      software_summary: "通用框架",
    });
    expect(
      displayEntry(
        port({ service_profile_ids: [workload.id] }),
        new Map([[workload.id, workload]]),
      ),
    ).toMatchObject({
      serviceName: "示例服务",
      serviceDescription: "本机订单接口",
      softwareSummary: "通用框架",
    });
  });
  it("should explicitly label public workload documentation as software information", () => {
    const workload = profile({ software_summary: "开源看板工具" });
    const entry = port({ service_profile_ids: [workload.id] });
    const profiles = new Map([[workload.id, workload]]);
    expect(displayEntry(entry, profiles).serviceDescription).toBe(
      "软件说明：开源看板工具",
    );
    expect(
      displayEntry(entry, profiles, new Map(), "en-US").serviceDescription,
    ).toBe("Software: 开源看板工具");
  });
  it("should never borrow runtime documentation as an unknown workload's purpose", () => {
    const workload = profile({
      identity_match: "unresolved",
      original_name: "private-project",
    });
    const runtime = profile({
      id: "node",
      component_role: "runtime",
      original_name: "Node.js",
      software_summary: "JavaScript 运行环境",
    });
    const result = displayEntry(
      port({ service_profile_ids: [runtime.id, workload.id] }),
      new Map([
        [runtime.id, runtime],
        [workload.id, workload],
      ]),
    );
    expect(result.serviceDescription).toBe("");
    expect(result.softwareSummary).toBe("JavaScript 运行环境");
    expect(result.profiles.map((p) => p.id)).toEqual(["workload", "node"]);
  });
  it.each(["candidate", "unresolved"] as const)(
    "should not elevate %s public text or Chinese aliases into confirmed identity",
    (identity_match) => {
      const candidate = profile({
        identity_match,
        software_summary: "搜索候选简介",
        candidates: [
          {
            name: "someone/demo",
            description: "候选",
            url: "https://github.com/someone/demo",
            source_id: "github-search",
          },
        ],
      });
      expect(
        displayEntry(
          port({ service_profile_ids: [candidate.id] }),
          new Map([[candidate.id, candidate]]),
        ),
      ).toMatchObject({
        serviceName:
          identity_match === "candidate" ? "候选：应用：demo" : "应用：demo",
        serviceDescription: "",
      });
    },
  );
  it("should order profiles by workload, launcher, runtime, manager, and system", () => {
    const roles = [
      "system",
      "manager",
      "runtime",
      "launcher",
      "workload",
    ] as const;
    const values = roles.map((role) =>
      profile({ id: role, component_role: role }),
    );
    const result = displayEntry(
      port({ service_profile_ids: ["missing", ...roles] }),
      new Map(values.map((p) => [p.id, p])),
    );
    expect(result.profiles.map((p) => p.component_role)).toEqual(
      [...roles].reverse(),
    );
  });
  it("should use local attribution information before process fallback", () => {
    const entry = port({
      attributions: [
        {
          kind: "SystemdService",
          name: "orders.service",
          description: "订单服务",
          confidence: "Exact",
          source: "systemctl",
          facts: [],
        },
      ],
    });
    expect(displayEntry(entry)).toMatchObject({
      serviceName: "系统服务：orders.service",
      serviceDescription: "订单服务",
    });
  });
  it("should not display nonexistent peer hostnames on a listener", () => {
    const hosts = new Map([
      ["", host({ hostname: "scanner.example" })],
      ["10.0.0.8", host({ hostname: "peer.example" })],
    ]);
    expect(
      displayEntry(
        port({ remote_address: "10.0.0.8", remote_port: 443 }),
        new Map(),
        hosts,
      ),
    ).toMatchObject({ localHost: "scanner.example", remoteHost: "" });
    expect(
      displayEntry(
        port({
          state: "Established",
          remote_address: "10.0.0.8",
          remote_port: 443,
        }),
        new Map(),
        hosts,
      ).remoteHost,
    ).toBe("peer.example");
  });
  it("should prefer resolved hostnames and fall back to machine names", () => {
    const hosts = new Map([
      ["127.0.0.1", host({ machine_name: "local-machine" })],
      [
        "10.0.0.8",
        host({ hostname: "peer.example", machine_name: "fallback" }),
      ],
    ]);
    expect(
      displayEntry(
        port({
          state: "Established",
          remote_address: "10.0.0.8",
          remote_port: 443,
        }),
        new Map(),
        hosts,
      ),
    ).toMatchObject({ localHost: "local-machine", remoteHost: "peer.example" });
  });
  it("should deduplicate repeated software summaries", () => {
    const a = profile({ id: "a", software_summary: "共享软件简介" }),
      b = profile({
        id: "b",
        component_role: "runtime",
        software_summary: "共享软件简介",
      });
    expect(
      displayEntry(
        port({ service_profile_ids: ["a", "b"] }),
        new Map([
          ["a", a],
          ["b", b],
        ]),
      ).softwareSummary,
    ).toBe("共享软件简介");
  });
  it("should return locale-aware unknown names and only handle display fields", () => {
    const entry = port({ process_name: null });
    expect(displayEntry(entry).serviceName).toBe("归属未知");
    expect(displayEntry(entry, new Map(), new Map(), "en-US").serviceName).toBe(
      "Unknown service",
    );
    expect(displayField(entry, "pid")).toBeUndefined();
    expect(displayField(port(), "service_name")).toBe("进程：node.exe");
  });
  it("should expose curated Chinese aliases as candidates without upgrading their identity", () => {
    const candidate = profile({
      identity_match: "candidate",
      software_summary: "JavaScript runtime",
      sources: [
        {
          id: "catalog:node",
          kind: "catalog",
          title: "内置对照",
          url: null,
          fetched_at: null,
        },
      ],
    });
    const entry = port({ service_profile_ids: [candidate.id] });
    const profiles = new Map([[candidate.id, candidate]]);
    expect(displayEntry(entry, profiles)).toMatchObject({
      serviceName: "候选：示例服务",
      serviceDescription: "候选软件说明：JavaScript runtime",
    });
    expect(
      displayEntry(entry, profiles, new Map(), "en-US").serviceDescription,
    ).toBe("Candidate software: JavaScript runtime");
    expect(candidate.identity_match).toBe("candidate");
  });
  it("should retain an actual Chinese project name instead of replacing it with a translated runtime name", () => {
    const runtime = profile({
      id: "node",
      component_role: "runtime",
      original_name: "Node.js",
      display_name_zh: "JavaScript 运行时",
    });
    const entry = port({
      service_profile_ids: [runtime.id],
      attributions: [
        {
          kind: "NodeApplication",
          name: "订单接口",
          description: "订单查询",
          confidence: "High",
          source: "package.json",
          facts: [],
        },
      ],
    });
    expect(displayEntry(entry, new Map([[runtime.id, runtime]]))).toMatchObject(
      { serviceName: "订单接口", serviceDescription: "订单查询" },
    );
  });
  it("should preserve an English project identity behind a neutral Chinese category", () => {
    const entry = port({
      attributions: [
        {
          kind: "PythonApplication",
          name: "inventory-api",
          description: null,
          confidence: "High",
          source: "pyproject.toml",
          facts: [],
        },
      ],
    });
    expect(displayEntry(entry).serviceName).toBe("项目：inventory-api");
    expect(displayEntry(entry, new Map(), new Map(), "en-US").serviceName).toBe(
      "inventory-api",
    );
  });
  it("should preserve an existing Chinese original name even if a different alias is available", () => {
    const item = profile({
      original_name: "本机订单接口",
      display_name_zh: "其他名称",
    });
    expect(
      displayEntry(
        port({ service_profile_ids: [item.id] }),
        new Map([[item.id, item]]),
      ).serviceName,
    ).toBe("本机订单接口");
  });
  it("should describe unknown process names without inventing a purpose", () => {
    const result = displayEntry(
      port({ process_name: "private-custom-binary" }),
    );
    expect(result.serviceName).toBe("进程：private-custom-binary");
    expect(result.serviceDescription).toBe("");
    expect(result.profiles).toEqual([]);
  });
  it("should show the scanner machine name when a wildcard host record has no hostname", () => {
    const hosts = new Map([
      [
        "",
        host({
          address: "local",
          machine_name: "actual-scanner",
          hostname: "actual-scanner",
        }),
      ],
      [
        "0.0.0.0",
        host({
          address: "0.0.0.0",
          kind: "wildcard",
          hostname: null,
          machine_name: null,
        }),
      ],
    ]);
    expect(
      displayEntry(port({ local_address: "0.0.0.0" }), new Map(), hosts)
        .localHost,
    ).toBe("actual-scanner");
  });
});
