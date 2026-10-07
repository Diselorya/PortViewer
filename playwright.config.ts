import path from "node:path";
import { defineConfig } from "@playwright/test";

const port = 18789;
const binary = path.join(
  import.meta.dirname,
  "web-service",
  "target",
  "debug",
  process.platform === "win32" ? "portviewer-web.exe" : "portviewer-web",
);

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: `"${binary}" serve --listen 127.0.0.1:${port} --assets "${path.join(import.meta.dirname, "dist")}"`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
