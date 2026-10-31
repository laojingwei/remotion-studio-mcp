import React, { useEffect, useMemo, useRef } from "react";
import { TRANSITION_OPTIONS, seamOverlaps } from "@shared/transitions";
import { sceneSpans, type Scene } from "@shared/schema";
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
  const project = useDoc((s) => s.project);
  const transitionIn = scene.transitionIn ?? { type: "none" as const, durationInFrames: 12 };
  const transitionOut = scene.transitionOut ?? { type: "none" as const, durationInFrames: 12 };

  /**
   * 本幕与**上一幕**的实际重叠帧数。
   *
   * 为什么要在面板里显示它：接缝不是独立参数，它是推导出来的
   * （= 本幕入场时长，再受前后幕长度夹取）。以前编辑器里既没有这个控件、
   * 也没有这个读数，于是"想调接缝"只能去猜、去试。
   * 显示"实际重叠"还能立刻暴露「你设了 24，但因为前幕太短只给了 12」这类情况。
   */
  const seamInfo = useMemo(() => {
    const scenes = (project?.scenes ?? []) as Scene[];
    const idx = scenes.findIndex((x) => x.id === scene.id);
    if (idx < 0) return { isFirst: true, isLast: true, in: 0, out: 0 };
    const overlaps = seamOverlaps(scenes as never, sceneSpans(scenes) as never);
    return {
      isFirst: idx === 0,
      isLast: idx === scenes.length - 1,
      /** 与上一幕的重叠（= 本幕入场时长推出来的） */
      in: idx > 0 ? (overlaps[idx - 1] ?? 0) : 0,
      /** 与下一幕的重叠（= 下一幕入场时长推出来的，本幕在这个区间里往外退） */
      out: overlaps[idx] ?? 0,
    };
  }, [project, scene.id]);

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
        <label title="接缝重叠长度就由这个时长决定：重叠期间上一幕会主动退场（不再定格），两幕短暂同屏。第一幕没有上一幕，是从背景色浮现">
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
        <>
          <div className="field">
            <label>
              转场时长 <span className="num">{transitionIn.durationInFrames} 帧</span>
            </label>
            <RangeInput
              min={4}
              /*
                上限 120 帧（= 4s @30fps），与 MCP 工具层的 max(120) 对齐。
                以前卡在 40 是因为"短视频用不到更长"，但接缝长度就等于这个值 ——
                想做大叠化（黑场过渡、情绪段落之间）40 帧根本不够。
                max 仍取 max(120, 当前值) 兜底：agent 若写了更大的值，滑块要能容纳，
                否则 thumb 停在上限、一拖就把真实值静默改小。
              */
              max={Math.max(120, transitionIn.durationInFrames)}
              step={1}
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
          {/*
            接缝没有独立控件，它就是上面这个时长 —— 所以这里直接把「实际重叠多少」算出来。
            少了这行，调接缝只能靠猜：设 24 帧但前幕只有 300 帧时实际可能只给到 12。
          */}
          <div className="hint" style={{ marginTop: -6, marginBottom: 8 }}>
            {(() => {
              const base = seamInfo.isFirst
                ? "第一幕没有接缝：从背景色浮现"
                : seamInfo.in === 0
                  ? "与上一幕不相接（中间有间隙），不会有重叠 —— 想让它们叠化，把上一幕拉长到紧挨本幕"
                  : seamInfo.in < transitionIn.durationInFrames
                    ? `实际只重叠 ${seamInfo.in} 帧（受前幕/本幕长度限制，你设的是 ${transitionIn.durationInFrames}）`
                    : `与上一幕重叠 ${seamInfo.in} 帧`;
              // 上限放开到 120 之后，很容易设出"接缝比幕还长" —— 那不是叠化，是这一幕几乎不存在
              const pct = Math.round((seamInfo.in / Math.max(1, scene.durationInFrames)) * 100);
              return seamInfo.in > 0 && pct >= 50 ? `${base}；已占本幕 ${pct}%` : base;
            })()}
          </div>
        </>
      ) : null}

      <div className="field">
        <label title="从本幕末尾往回退，任何情况下都会生效（不再受下一幕入场影响）。比接缝长时会提前开始退，速度不变；比接缝短时退完即保持透明">
          出场转场
        </label>
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
        <>
          <div className="field">
            <label>
              出场时长 <span className="num">{transitionOut.durationInFrames} 帧</span>
            </label>
            <RangeInput
              min={4}
              max={Math.max(120, transitionOut.durationInFrames)}
              step={1}
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
          {/* 出场是「从窗口末尾往回退」：比接缝长就提前启动，速度不变 —— 这里说清它落在哪 */}
          <div className="hint" style={{ marginTop: -6, marginBottom: 8 }}>
            {seamInfo.isLast
              ? "最后一幕没有下一幕：按这个时长在幕末退完"
              : seamInfo.out === 0
                ? "下一幕是硬切（没有接缝）：按这个时长在幕末退完"
                : transitionOut.durationInFrames > seamInfo.out
                  ? `比接缝（${seamInfo.out} 帧）长：会在接缝前 ${transitionOut.durationInFrames - seamInfo.out} 帧就开始退，速度不变`
                  : `在 ${seamInfo.out} 帧的接缝内退完`}
          </div>
        </>
      ) : null}
    </>
  );
};
