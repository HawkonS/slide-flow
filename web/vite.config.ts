import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { offlineShellPlugin } from "./pwa/build-plugin";

const configDir = path.dirname(fileURLToPath(import.meta.url));

const backend = process.env.SLIDE_FLOW_BACKEND || "http://127.0.0.1:8088";
// dev server 端口：优先读取 run.sh 从 slide_flow.properties 解析后注入的
// SLIDE_FLOW_WEB_PORT，手动 npm run dev 时缺省回退 5173
const webPort = Number(process.env.SLIDE_FLOW_WEB_PORT) || 5173;
// 通过环境变量控制是否启用 HTTPS（缺省 false，与后端保持统一）
// 开启方式：SLIDE_FLOW_HTTPS=true npm run dev（支持 true/1/yes/on）
// 开启后可满足 File System Access API 在局域网 IP 下的使用需求
const enableHttps = ["true", "1", "yes", "on"].includes(
  (process.env.SLIDE_FLOW_HTTPS ?? "").toLowerCase()
);

// 通过环境变量配置允许的访问域名（解决通过域名访问 Vite 开发服务器被拦截的问题）
// 多个域名用逗号分隔，例如：slide-flow.example.com,example.org
const allowedHostRaw = process.env.SLIDE_FLOW_ALLOWED_HOST || "";
const allowedHosts = allowedHostRaw
  ? allowedHostRaw.split(",").map(h => {
      const value = h.trim();
      if (value.includes("://")) {
        try { return new URL(value).hostname; } catch { return ""; }
      }
      return value;
    }).filter(h => h && h !== "*")
  : [];

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), ...(enableHttps ? [basicSsl()] : []), offlineShellPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(configDir, "./src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: webPort,
    https: enableHttps ? {} : undefined,
    allowedHosts,
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
    outDir: path.resolve(configDir, "../app/static/dist"),
    // 保留旧 hash 资源，让升级前已打开的页面仍能完成懒加载。
    // 新入口只引用新 hash；历史文件可由运维按保留周期异步清理。
    emptyOutDir: false,
    assetsDir: "assets",
    sourcemap: false,
    rollupOptions: {
      output: {
        // vendor 拆分：按依赖分组打包，提升缓存命中率、避免单一巨型 chunk
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|react-router-dom|react-router|@remix-run|scheduler|loose-envify|js-tokens|object-assign)[\\/]/.test(id)) {
            return "vendor-react";
          }
          if (/[\\/]node_modules[\\/]@tanstack[\\/]/.test(id)) {
            return "vendor-query";
          }
          if (/[\\/]node_modules[\\/](zod|react-hook-form|@hookform)[\\/]/.test(id)) {
            return "vendor-form";
          }
          if (/[\\/]node_modules[\\/](@radix-ui|@floating-ui|cmdk|react-remove-scroll|react-remove-scroll-bar|react-style-singleton|use-callback-ref|use-sidecar)[\\/]/.test(id)) {
            return "vendor-ui";
          }
          if (/[\\/]node_modules[\\/]lucide-react[\\/]/.test(id)) {
            return "vendor-icons";
          }
          return "vendor";
        },
      },
    },
  },
});
