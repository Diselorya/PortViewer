import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    coverage: {
      provider: "v8",
      include: [
        "src/domain/**/*.ts",
        "src/i18n/**/*.ts",
        "src/services/**/*.ts",
        "src/stores/**/*.ts",
        "src/types/**/*.ts",
      ],
      exclude: ["src/**/__tests__/**", "src/generated/**"],
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 90,
        branches: 78,
        functions: 90,
        lines: 90,
      },
    },
  },
});
