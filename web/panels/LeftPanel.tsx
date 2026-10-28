import React, { useState } from "react";
import { SceneList } from "./SceneList";
import { ElementLibrary } from "./ElementLibrary";

/**
 * 左栏：场景 / 元素素材两个页签。
 * 两件事都发生在同一块区域里 —— 先选场景，再往这个场景上放元素。
 */
export const LeftPanel: React.FC = () => {
  const [tab, setTab] = useState<"scenes" | "elements">("scenes");

  return (
    <aside className="panel left">
      <div className="panel-tabs">
        <button
          className={`panel-tab ${tab === "scenes" ? "is-active" : ""}`}
          onClick={() => setTab("scenes")}
        >
          场景
        </button>
        <button
          className={`panel-tab ${tab === "elements" ? "is-active" : ""}`}
          onClick={() => setTab("elements")}
        >
          元素
        </button>
      </div>

      {tab === "scenes" ? <SceneList /> : <ElementLibrary />}
    </aside>
  );
};
