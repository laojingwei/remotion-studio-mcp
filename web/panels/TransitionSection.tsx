import React, { useEffect, useRef } from "react";
import { TRANSITION_OPTIONS } from "@shared/transitions";
import type { Scene } from "@shared/schema";
import { useDoc } from "../store";
import { RangeInput } from "../RangeInput";

/**
 * 入场 / 出场转场（**场景级**属性，与版式无关）。
 *
 * 为什么抽成组件：自由画布场景会整栏接管右栏（`FreeformInspector`），
 * 转场控件原先只写在普通版式的 `Inspector` 里，于是自由画布"没有转场入口"——
 * 但渲染端对所有版式一视同仁（`SceneWrap` 包住整个场景），
 * 所以这功能一直是能用的，只是面板里点不到。两处共用这一份。
 */
export const TransitionSection: React.FC<{ scene: Scene }> = ({ scene }) => {
  const apply = useDoc((s) => s.apply);
  const transitionIn = scene.transitionIn ?? { type: "none" as const, durationInFrames: 12 };
  const transitionOut = scene.transitionOut ?? { type: "none" as const, durationInFrames: 12 };

  /** 8 种转场在窄面板里放不下，横向滚动而不是溢出 */
  const segScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = segScrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // 横向手势（触控板左右滑）交给浏览器处理
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return;
      // 已经滚到两端就放行，让页面正常滚动（否则会"卡住"页面）
      const atStart = el.scrollLeft <= 0 && e.deltaY < 0;
      const atEnd = el.scrollLeft >= max - 1 && e.deltaY > 0;
      if (atStart || atEnd) return;
      // React 的 onWheel 是 passive 的，必须用原生监听才能 preventDefault
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scene.id]);

  return (
    <>
      <div className="field">
        <label title="接缝转场：转场期间上一幕还在（定格在最后一帧），两幕同时可见。第一幕则是从背景色浮现">
          入场转场
        </label>
        <div className="seg seg-scroll" ref={segScrollRef}>
          {TRANSITION_OPTIONS.map((t) => (
            <button
              key={t.key}
              className={`seg-item ${transitionIn.type === t.key ? "is-on" : ""}`}
              onClick={() =>
                void apply([
                  {
                    op: "update_scene",
                    sceneId: scene.id,
                    patch: {
                      transitionIn:
                        t.key === "none"
                          ? null
                          : { type: t.key, durationInFrames: transitionIn.durationInFrames || 12 },
                    },
                  },
                ])
              }
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {transitionIn.type !== "none" ? (
        <div className="field">
          <label>
            转场时长 <span className="num">{transitionIn.durationInFrames} 帧</span>
          </label>
          <RangeInput
            min={4}
            max={40}
            step={2}
            value={transitionIn.durationInFrames}
            delay={160}
            onChange={(durationInFrames) =>
              void apply([
                {
                  op: "update_scene",
                  sceneId: scene.id,
                  patch: { transitionIn: { type: transitionIn.type, durationInFrames } },
                },
              ])
            }
          />
        </div>
      ) : null}

      <div className="field">
        <label title="只有下一幕的入场是硬切时才生效：把本幕淡出到背景色">出场转场</label>
        <div className="seg seg-scroll">
          {TRANSITION_OPTIONS.map((t) => (
            <button
              key={t.key}
              className={`seg-item ${transitionOut.type === t.key ? "is-on" : ""}`}
              onClick={() =>
                void apply([
                  {
                    op: "update_scene",
                    sceneId: scene.id,
                    patch: {
                      transitionOut:
                        t.key === "none"
                          ? null
                          : {
                              type: t.key,
                              durationInFrames: transitionOut.durationInFrames || 12,
                            },
                    },
                  },
                ])
              }
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {transitionOut.type !== "none" ? (
        <div className="field">
          <label>
            出场时长 <span className="num">{transitionOut.durationInFrames} 帧</span>
          </label>
          <RangeInput
            min={4}
            max={40}
            step={2}
            value={transitionOut.durationInFrames}
            delay={160}
            onChange={(durationInFrames) =>
              void apply([
                {
                  op: "update_scene",
                  sceneId: scene.id,
                  patch: { transitionOut: { type: transitionOut.type, durationInFrames } },
                },
              ])
            }
          />
        </div>
      ) : null}
    </>
  );
};
