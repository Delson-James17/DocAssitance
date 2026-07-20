import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: Vite serves the React app on 5173 and proxies API calls to the
// Express backend on 3000. Prod: `vite build` emits to dist/, which the
// backend serves.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
  build: {
    outDir: "dist",
  },
});
