import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5287, host: true },
  worker: { format: "es" },
  build: { target: "es2023", chunkSizeWarningLimit: 1200 },
});
