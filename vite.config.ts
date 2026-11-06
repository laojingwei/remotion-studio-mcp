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
      /*
       * 插件 SDK 的别名。插件组件写在 `plugins/` 下，用它自己的相对路径
       * 去 import 宿主的 `src/` 会随目录深度变化而失效，所以必须有稳定的别名。
       * 渲染端（webpack）有一份等价的配置，见 server/render.service.ts 的 webpackOverride。
       */
      "@studio/sdk": path.resolve(__dirname, "src", "sdk.ts"),
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
    /**
     * 拆包：之前所有东西挤成一个 2.33MB（gzip 675KB）的 chunk，
     * 用户只想改个字幕也要先下载 three.js + Remotion Player，而且改任何代码都让整包缓存失效。
     *
     * 分三类静态依赖：three（含 @react-three）、remotion、react 运行时。
     * 这些库的版本变化频率远低于业务代码，拆开后能长期命中浏览器缓存。
     */
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          // three 必须在 react 之前判断：@react-three 也含 "react" 字样
          if (id.includes("three")) return "three";
          if (id.includes("@remotion") || id.includes("remotion")) return "remotion";
          // vendor 不能单独拆：它和 react 互相引用会成环（vendor -> react -> vendor）。
          // 环上的模块初始化顺序不定，实测 React 直接抛
          // "Cannot set properties of undefined (setting 'Activity')"，整页黑屏 ——
          // 1.1.1 发出去的包就是这么挂的（vite 构建时也会打 Circular chunk 警告）。
          // 并进 react 这一块，环就没了；three/remotion 只单向依赖 react，拆出去是安全的。
          return "react";
        },
      },
    },
  },
});
