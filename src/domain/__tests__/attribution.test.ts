import { describe, expect, it } from "vitest";
import {
  attributionContext,
  attributionDetails,
  kindLabel,
} from "../attribution";
import { backendText } from "../../i18n";
import type { ServiceAttribution } from "../../types/port";

const project: ServiceAttribution = {
  kind: "NodeApplication",
  name: "inventory",
  description: "Warehouse inventory API",
  confidence: "High",
  source: "/proc/42/cwd + package.json",
  facts: [
    { label: "工作目录", value: "/opt/inventory/server" },
    { label: "运行模式", value: "npm run dev" },
    { label: "项目路径", value: "/opt/inventory" },
  ],
};

describe("workload attribution presentation", () => {
  it("keeps a project root and run mode visible ahead of a nested working directory", () => {
    expect(attributionContext(project)).toBe("npm run dev · /opt/inventory");
  });

  it("uses a unit file for service location and does not invent a missing location", () => {
    expect(
      attributionContext({
        ...project,
        facts: [
          { label: "单元文件", value: "/etc/systemd/system/inventory.service" },
        ],
      }),
    ).toBe("/etc/systemd/system/inventory.service");
    expect(attributionContext({ ...project, facts: [] })).toBe("");
  });

  it("localizes system kinds and preserves the complete evidence in copied details", () => {
    expect(kindLabel("SystemdService")).toBe("systemd 服务");
    expect(kindLabel("SystemProcess", "en-US")).toBe("Program");
    const text = attributionDetails(project, "en-US", (value) =>
      backendText("en-US", value),
    );
    expect(text).toContain("Warehouse inventory API");
    expect(text).toContain("Project path: /opt/inventory");
    expect(text).toContain("Run mode: npm run dev");
    expect(text).toContain("Evidence: /proc/42/cwd + package.json");
    expect(text).toContain("Confidence: High");
  });
});
