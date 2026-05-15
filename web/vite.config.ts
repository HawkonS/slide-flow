import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import path from "node:path";

const backend = process.env.SLIDE_FLOW_BACKEND || "http://127.0.0.1:8088";
// 通过环境变量控制是否启用 HTTPS（默认开启，便于 File System Access API 在局域网 IP 下使用）
// 关闭方式：SLIDE_FLOW_HTTPS=false npm run dev
const enableHttps = (process.env.SLIDE_FLOW_HTTPS ?? "true").toLowerCase() !== "false";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), ...(enableHttps ? [basicSsl()] : [])],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    https: enableHttps ? {} : undefined,
    proxy: {
      "/api": {
        target: backend,
        changeOrigin: true,
        ws: false,
        timeout: 0,
        proxyTimeout: 0,
      },
      "/static": { target: backend, changeOrigin: true },
      "/storage": { target: backend, changeOrigin: true },
    },
  },
  build: {
    outDir: path.resolve(__dirname, "../app/static/dist"),
    emptyOutDir: true,
    assetsDir: "assets",
    sourcemap: false,
  },
});
