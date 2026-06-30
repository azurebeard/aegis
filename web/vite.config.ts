import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
  },
  server: {
    port: 4280,
    proxy: {
      // During `swa start`, SWA CLI handles /api and /.auth. In plain `vite dev`
      // (contributor without SWA CLI) these paths 404 — acceptable for dev.
    },
  },
});
