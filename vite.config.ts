// Vite serves the UI (ui/) on port 5173 and proxies the server's routes to port 8787 (SPEC §7.5).
import { defineConfig } from "vite";

const server = process.env.RATCHET_SERVER ?? "http://localhost:8787";
const proxied = ["/events", "/api", "/evidence", "/game", "/dist"];

export default defineConfig({
  root: "ui",
  server: {
    port: 5173,
    strictPort: true,
    proxy: Object.fromEntries(proxied.map((p) => [p, { target: server, changeOrigin: true }])),
  },
  build: { outDir: "../dist/ui", emptyOutDir: true, target: "es2022" },
});
