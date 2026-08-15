import { defineConfig } from "vite";

// Dev: proxy the API to the local control plane. Prod (Pages): the console reads the API base URL
// from `?api=` / localStorage / VITE_API_BASE_URL.
export default defineConfig({
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": { target: "http://127.0.0.1:8080", changeOrigin: true },
      "/healthz": "http://127.0.0.1:8080",
      "/readyz": "http://127.0.0.1:8080",
      "/docs": "http://127.0.0.1:8080",
    },
  },
  build: { target: "es2022", sourcemap: true },
});
