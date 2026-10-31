import React, { useMemo } from "react";
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

  return (
    <>
      <div className="field">
        <label title="接缝重叠长度就由这个时长决定：重叠期间上一幕会主动退场（不再定格），两幕短暂同屏。第一幕没有上一幕，是从背景色浮现">
          入场转场
        </label>
        {/*
          12 种转场用下拉框：按钮条在 8 种时就已经要靠横向滚动才能看到全部，
          扩到 12 种之后一半选项藏在滚动区外，等于不存在。hint 顺势写进选项文字，
          比原来只在 hover 时出现的 title 提示更容易被看到。
        */}
        <select
          value={transitionIn.type}
          onChange={(e) => {
            const t = TRANSITION_OPTIONS.find((o) => o.key === e.target.value)!;
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
            ]);
          }}
        >
          {TRANSITION_OPTIONS.map((t) => (
            <option key={t.key} value={t.key} title={t.hint}>
              {t.label} · {t.hint}
            </option>
          ))}
        </select>
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
        <select
          value={transitionOut.type}
          onChange={(e) => {
            const t = TRANSITION_OPTIONS.find((o) => o.key === e.target.value)!;
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
            ]);
          }}
        >
          {TRANSITION_OPTIONS.map((t) => (
            <option key={t.key} value={t.key} title={t.hint}>
              {t.label} · {t.hint}
            </option>
          ))}
        </select>
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
