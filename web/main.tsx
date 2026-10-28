import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { loadPrefs } from "./uiPrefs";
import "./styles.css";

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
