import { describe, expect, it } from "vitest";
import {
  backendText,
  processStatusLabel,
  resolveLocale,
  stateLabel,
  translate,
} from "..";

describe("i18n", () => {
  it("keeps backend state codes stable while translating labels", () => {
    expect(stateLabel("zh-CN", "Established")).toBe("已连接");
    expect(stateLabel("en-US", "Established")).toBe("Established");
  });

  it("interpolates relationship copy in both languages", () => {
    expect(translate("zh-CN", "matches", { count: 3 })).toBe("命中 3 条");
    expect(translate("en-US", "matches", { count: 3 })).toBe("3 matches");
  });

  it("resolves explicit locale independently of the operating system", () => {
    expect(resolveLocale("zh-CN")).toBe("zh-CN");
    expect(resolveLocale("en-US")).toBe("en-US");
  });

  it("localizes native attribution labels without leaking Chinese status details into English", () => {
    expect(backendText("en-US", "容器 ID")).toBe("Container ID");
    expect(backendText("en-US", "运行模式")).toBe("Run mode");
    expect(backendText("en-US", "项目路径")).toBe("Project path");
    expect(backendText("en-US", "单元文件")).toBe("Unit file");
    expect(backendText("en-US", "自动重载（--reload）；由 systemd 管理")).toBe(
      "Automatic reload (--reload); Managed by systemd",
    );
    expect(backendText("en-US", "Nginx 默认站点 :80")).toBe(
      "Nginx default site :80",
    );
    expect(processStatusLabel("en-US", "Partial", "无法读取进程路径")).toBe(
      "Partial information",
    );
  });
});
