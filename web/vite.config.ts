import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import path from "node:path";

const backend = process.env.SLIDE_FLOW_BACKEND || "http://127.0.0.1:8088";
// 通过环境变量控制是否启用 HTTPS（默认开启，便于 File System Access API 在局域网 IP 下使用）
// 关闭方式：SLIDE_FLOW_HTTPS=false npm run dev
const enableHttps = (process.env.SLIDE_FLOW_HTTPS ?? "true").toLowerCase() !== "false";

// 通过环境变量配置允许的访问域名（解决通过域名访问 Vite 开发服务器被拦截的问题）
// 多个域名用逗号分隔，例如：slide-flow.example.com,example.com
const allowedHostRaw = process.env.SLIDE_FLOW_ALLOWED_HOST || "";
const allowedHosts = allowedHostRaw
  ? allowedHostRaw.split(",").map(h => h.trim()).filter(h => h)
  : [];

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
    allowedHosts: allowedHosts.length > 0 ? allowedHosts : true,
    proxy: {
      "/api": {
        target: backend,
        changeOrigin: true,
        ws: false,
        // API 请求超时：60 秒（兼顾 PPT 生成等耗时操作）
        timeout: 60000,
        proxyTimeout: 60000,
      },
      // WebSocket 代理：将前端的 /ws/* 升级请求转发到后端 FastAPI
      // ws: true 是关键，启用 WebSocket Upgrade 转发；secure: false 允许后端为 http 时也能从 https 前端转发
      // WebSocket 不设超时，保持长连接
      "/ws": {
        target: backend,
        changeOrigin: true,
        ws: true,
        secure: false,
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
