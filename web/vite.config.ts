import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const api = `http://127.0.0.1:${process.env.PORT ?? 8787}`;
export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: { alias: { "@shared": path.resolve(here, "../shared") } },
  server: { port: 5173, host: "127.0.0.1", proxy: { "/api": { target: api, changeOrigin: false }, "/media": api, "/fonts": api, "/mcp": api } },
  build: { outDir: path.resolve(here, "dist"), emptyOutDir: true, chunkSizeWarningLimit: 1200 },
});
