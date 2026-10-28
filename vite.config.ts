import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const API = process.env.SERVER_URL ?? "http://127.0.0.1:4380";

export default defineConfig({
  root: "web",
  publicDir: false,
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "shared"),
    },
  },
  server: {
    port: 5173,
    fs: {
      // 编辑器要直接 import 项目根目录下的 src/ 场景组件
      allow: [path.resolve(__dirname)],
    },
    proxy: {
      // 用正则只匹配 /api/ 前缀，否则 /apiClient.ts 这类模块名会被误转发
      "^/api/": { target: API, changeOrigin: true },
      "^/out/": { target: API, changeOrigin: true },
      "^/assets/": { target: API, changeOrigin: true },
    },
  },
  build: {
    outDir: path.resolve(__dirname, "dist/web"),
    emptyOutDir: true,
    // 不能叫 assets：/assets/* 已被「上传素材」路由占用，会截走前端 js/css 导致 404
    assetsDir: "static",
  },
});
