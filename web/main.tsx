import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { loadPrefs } from "./uiPrefs";
import { quietThreeClockWarn } from "./quietThreeClockWarn";
import "./styles.css";

/*
 * 插件场景注册 —— **编辑器这一份不能省**。
 *
 * 生成文件（`src/_plugins.generated.ts`）做三件事：import 插件的 .tsx、
 * `registerSceneMeta`（右侧属性面板靠它知道有哪些字段）、`registerSceneComponent`
 * （画布靠它找到渲染组件）。
 *
 * 渲染端由 `src/index.ts` 引入，但编辑器是**另一个 bundle**（web/ → Vite），
 * 不在这里引一次，编辑器端就一个注册都没有：场景被当成未知类型，
 * 画布静默渲染 null（全黑），属性面板退回通用选项。服务端却一切正常
 * （`/api/scene-types` 里有、`add_scene` 能选），所以特别难查。
 */
import "../src/_plugins.generated";

// 必须在第一次创建 Canvas 之前装好（R3F 在建 store 时就会 new THREE.Clock）
quietThreeClockWarn();

/**
 * 先同步 UI 偏好再渲染：面板宽度 / 折叠状态 / 时间轴高度这些值在组件里是
 * `useState(() => localStorage.getItem(...))` 同步初始化的，所以必须让
 * 服务端那份数据先回填进 localStorage，否则首帧会按旧值布局再跳一下。
 */
const root = createRoot(document.getElementById("root")!);

void loadPrefs()
  .catch(() => {
    /* 读不到就用本地那份 */
  })
  .finally(() => {
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  });
