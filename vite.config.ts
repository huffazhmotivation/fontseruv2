import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirrors the "@/*" -> "src/*" path mapping in tsconfig.app.json so
    // Vite resolves "@/..." imports at dev/build time.
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: false,
    allowedHosts: true,
  },
  preview: {
    host: "0.0.0.0",
    port: 3000,
  },
  build: {
    target: "es2020",
    sourcemap: true,
  },
});
