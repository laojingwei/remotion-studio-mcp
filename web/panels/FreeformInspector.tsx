import React, { useEffect, useRef, useState } from "react";
import type { Scene } from "@shared/schema";
import {
  animTouchesLayout,
  freeElementLabel,
  type FreeEl,
  type FreeformProps,
} from "@shared/freeform";
import { SceneBoxSection } from "./SceneBoxSection";
import { TransitionSection } from "./TransitionSection";
import { useDoc } from "../store";

/**
 * 自由画布的属性编辑：背景 + 元素列表（位置/大小/文字/颜色/透明度）。
 *
 * 两条约定：
 *  1. 面板和画布**双向联动** —— 点卡片 = 选中画面上的那个元素，画布上选中哪张卡片就高亮哪张。
 *     agent 生成一屏十几个元素时，靠"1 · 文字「…」"这种名字才认得出谁是谁。
 *  2. 数据直接回写 scene.props，画布即时刷新。写的时候用 `dirty` 挡住 props → draft 的回流，
 *     否则 350ms 防抖窗口里画布那边刚落库的拖动结果会被面板的旧草稿覆盖。
 */

/** 下拉框显示中文、存值仍用 schema 里的键 */
const BG_KINDS: [string, string][] = [
  ["solid", "纯色"],
  ["gradient", "渐变"],
  ["glow", "光晕"],
  ["noise", "噪点"],
  ["grid", "网格"],
  ["image", "图片"],
];

const FX_KINDS: [string, string][] = [
  ["glow", "光斑 glow"],
  ["grid", "网格 grid"],
  ["noise", "噪点 noise"],
  ["particles", "粒子 particles"],
  ["stars", "星点 stars"],
  ["scanlines", "扫描线 scanlines"],
  ["rings", "光环 rings"],
  ["beam", "光束 beam"],
  ["dust", "浮尘 dust"],
  ["wave", "波纹 wave"],
  ["meteor", "流星 meteor"],
];

export const FreeformInspector: React.FC<{ scene: Scene; fps: number }> = ({ scene }) => {
  const apply = useDoc((s) => s.apply);
  const selection = useDoc((s) => s.selection);
  const setSelection = useDoc((s) => s.setSelection);
  const [draft, setDraft] = useState<FreeformProps>(scene.props as FreeformProps);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** 面板自己正在写盘：这段时间不要被 props 回流打断输入 */
  const dirty = useRef(false);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    if (dirty.current) return;
    setDraft(scene.props as FreeformProps);
  }, [scene.id, scene.props]);

  // 画布上选中哪个元素，就把对应的卡片滚到眼前
  useEffect(() => {
    const id = selection.length === 1 ? selection[0] : null;
    if (!id || !id.startsWith("fc:")) return;
    const i = Number(id.slice(3));
    cardRefs.current[i]?.scrollIntoView({ block: "nearest" });
  }, [selection]);

  const commit = (next: FreeformProps) => {
    setDraft(next);
    dirty.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void apply([{ op: "update_scene", sceneId: scene.id, patch: { props: next as never } }]).finally(
        () => {
          dirty.current = false;
        },
      );
    }, 350);
  };

  const els = draft.elements ?? [];
  const setEl = (i: number, patch: Partial<FreeEl>) => {
    const next = els.map((el, idx) => (idx === i ? { ...el, ...patch } : el));
    commit({ ...draft, elements: next });
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= els.length) return;
    const next = [...els];
    [next[i], next[j]] = [next[j], next[i]];
    commit({ ...draft, elements: next });
    // 卡片顺序变了，选中集里的序号也要跟着换
    const sel = new Set(selection);
    if (sel.has(`fc:${i}`) || sel.has(`fc:${j}`)) setSelection([`fc:${j}`]);
  };
  const removeEl = (i: number) => {
    // schema 要求 elements 至少一个：删到空整条 op 会失败
    if (els.length <= 1) {
      useDoc.getState().notify("自由画布至少保留一个元素，先加一个再删这个");
      return;
    }
    commit({ ...draft, elements: els.filter((_, idx) => idx !== i) });
    setSelection([]);
  };
  const addEl = (type: FreeEl["type"]) => {
    if (els.length >= 40) {
      useDoc.getState().notify("一张自由画布最多 40 个元素");
      return;
    }
    const base: FreeEl = {
      type,
      x: 50,
      y: 50,
      size: type === "text" ? 8 : 20,
      rotate: 0,
      scale: 1,
      opacity: 1,
      from: 0,
      ...(type === "text" ? { text: "新文字", fill: "#F5F5F7" } : {}),
      ...(type === "shape" ? { shape: "circle" as const, fill: "#5AC8FA" } : {}),
      ...(type === "fx" ? { kind: "glow" as const, color: "#5AC8FA" } : {}),
    };
    commit({ ...draft, elements: [...els, base] });
    setSelection([`fc:${els.length}`]);
  };

  const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const selectedIdx = selection.length === 1 && selection[0].startsWith("fc:") ? Number(selection[0].slice(3)) : -1;

  return (
    <aside className="panel right">
      <div className="panel-head">
        <span>属性</span>
        <span className="tag">自由画布</span>
      </div>
      <div className="panel-scroll">
        {/* 画中画是"整幕"的属性，放最上面：自由画布自己的字段很长，藏到下面找不到 */}
        <SceneBoxSection scene={scene} />
        {/* 转场同样是"整幕"属性：自由画布面板整栏接管右栏，不在这里给就彻底没有入口 */}
        <TransitionSection scene={scene} />
        <div className="field">
          <label>背景</label>
          <select
            value={draft.background?.kind ?? "solid"}
            onChange={(e) =>
              commit({
                ...draft,
                background: {
                  ...(draft.background ?? {}),
                  kind: e.target.value as NonNullable<FreeformProps["background"]>["kind"],
                },
              })
            }
          >
            {BG_KINDS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>背景色 1 / 2</label>
          <div className="ff-colors">
            {[0, 1].map((i) => (
              <label className="ff-color" key={i}>
                <input
                  type="color"
                  value={draft.background?.colors?.[i] ?? (i === 0 ? "#07070A" : "#5AC8FA")}
                  onChange={(e) => {
                    const colors = [...(draft.background?.colors ?? [])];
                    colors[i] = e.target.value;
                    commit({ ...draft, background: { ...(draft.background ?? {}), colors } });
                  }}
                />
                <span>色 {i + 1}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="field">
          <label>元素（{els.length}）</label>
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            {(["text", "shape", "image", "fx"] as const).map((t) => (
              <button key={t} className="mini" onClick={() => addEl(t)}>
                + {t}
              </button>
            ))}
          </div>
          <p className="ff-hint">点卡片选中画面上的元素；也可以直接在画布上点它，再拖 / 拉角点缩放。</p>
          {els.map((el, i) => (
            <div
              key={i}
              ref={(n) => {
                cardRefs.current[i] = n;
              }}
              className={`field ff-card ${selectedIdx === i ? "is-selected" : ""}`}
              onClick={() => setSelection([`fc:${i}`])}
            >
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, gap: 6 }}>
                <span className="tag" title={freeElementLabel(el, i)}>
                  {freeElementLabel(el, i)}
                </span>
                <span style={{ display: "flex", gap: 4, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                  <button className="mini" onClick={() => move(i, -1)} title="上移一层">
                    ↑
                  </button>
                  <button className="mini" onClick={() => move(i, 1)} title="下移一层">
                    ↓
                  </button>
                  <button className="mini" onClick={() => removeEl(i)} title="删除这个元素">
                    ×
                  </button>
                </span>
              </div>

              {animTouchesLayout(el) ? (
                <p className="ff-hint">含位移动画：拖动会带着整段关键帧一起平移。</p>
              ) : null}
              {/* 有时间窗的元素只在幕内某一段出现：播放头不在窗口里时画布上没有它，也选不中 */}
              {(el.from ?? 0) > 0 || el.durationInFrames !== undefined ? (
                <p className="ff-hint">
                  只在第 {el.from ?? 0} – {(el.from ?? 0) + (el.durationInFrames ?? 0)} 帧出现
                </p>
              ) : null}

              {el.type === "text" ? (
                <textarea
                  rows={2}
                  value={el.text ?? ""}
                  onChange={(e) => setEl(i, { text: e.target.value })}
                  style={{ width: "100%", marginBottom: 6 }}
                />
              ) : null}
              {el.type === "fx" ? (
                <select
                  value={el.kind ?? "glow"}
                  onChange={(e) => setEl(i, { kind: e.target.value as FreeEl["kind"] })}
                  style={{ marginBottom: 6 }}
                >
                  {FX_KINDS.map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
              ) : null}

              <div className="ff-grid">
                {(
                  [
                    ["x", el.x, 0.5],
                    ["y", el.y, 0.5],
                    ["size", el.size, 0.5],
                    ["rotate", el.rotate, 1],
                    ["opacity", el.opacity, 0.05],
                  ] as const
                ).map(([k, v, step]) => (
                  <label key={k} className="ff-num">
                    {k}
                    <input
                      type="number"
                      step={step}
                      value={num(v)}
                      onChange={(e) => setEl(i, { [k]: Number(e.target.value) } as Partial<FreeEl>)}
                    />
                  </label>
                ))}
              </div>

              {el.type !== "fx" ? (
                <label className="ff-color">
                  <span>颜色</span>
                  <input
                    type="color"
                    value={el.fill ?? "#F5F5F7"}
                    onChange={(e) => setEl(i, { fill: e.target.value })}
                  />
                </label>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
};
