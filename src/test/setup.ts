import { vi } from "vitest";
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
});
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: vi.fn() },
});
Object.defineProperty(navigator, "language", {
  configurable: true,
  value: "zh-CN",
});
Object.defineProperty(URL, "createObjectURL", {
  value: vi.fn(() => "blob:test"),
});
Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn() });
