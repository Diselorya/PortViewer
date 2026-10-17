import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  base: "./",
  plugins: [vue()],
  clearScreen: false,
  build: {
    target: "edge98",
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Keep Vue and PrimeVue initialization together; size splits can create component-registration cycles.
          groups: [
            {
              name: "vendor",
              test: /node_modules/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  envPrefix: ["VITE_"],
});
