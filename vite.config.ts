import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [cloudflare()],
  server: { port: 5287, host: true },
  worker: { format: "es" },
  build: { target: "es2023", chunkSizeWarningLimit: 1200 },
});
