/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    // Plotly (~1.1 MB) is its own lazy-loaded chunk, fetched only on /results.
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8000",
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    // Node 26 ships a global `localStorage` that shadows jsdom's; disable it.
    execArgv: ["--no-experimental-webstorage"],
  },
});
