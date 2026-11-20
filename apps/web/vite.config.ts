import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
  build: {
    // Default: served by the Lead Desk server. Static hosts (Cloudflare Pages): WEB_OUT_DIR=dist
    outDir: process.env["WEB_OUT_DIR"] || "../server/public",
    emptyOutDir: true,
  },
});
