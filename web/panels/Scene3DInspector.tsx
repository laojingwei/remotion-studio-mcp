import React, { useEffect, useMemo, useRef, useState } from "react";
import { sceneOffsets, type Scene } from "@shared/schema";
import type { Op } from "@shared/ops";
import type { DslNode, Scene3DDsl } from "@shared/scene3dDsl";
import { GEOMETRY_VARIANTS, MATERIAL_FIELDS, geometryFieldsOf } from "@shared/sceneMetas";
import { type EaseKind, EASE_KINDS, evalNode, nodeBaseScale } from "@shared/scene3dAnim";
import {
  NODE_KEY_MAX,
  type CamKey,
  type NodeKey,
  camAnimFromKeys,
  camHasFollow,
  camKeyFrames,
  camKeySummary,
  camLookAtSpans,
  nodeAnimFromKeys,
  nodeKeyAt,
  nodeKeyFrames,
  nodeKeySummary,
  nodeKeysOf,
  removeKeyAt,
  shiftKeys,
  stretchKeys,
  upsertKey,
  upsertKeyKeepingZero,
} from "@shared/scene3dKeys";
import { dslCamera } from "../../src/scenes/scene3d/DslScene";
import { smoothAtKey, smoothTangents } from "@shared/scene3dPath";
import { camKeyWithPose, camKeysOf, camZeroKeyOf, withCamLookAt } from "./scene3dCamKeys";
import { frameBus } from "../frameBus";
import { SceneBoxSection } from "./SceneBoxSection";
import { BackdropSection } from "./BackdropSection";
import { TransitionSection } from "./TransitionSection";
import { EyeOffIcon, EyeOnIcon } from "./tlIcons";
import { useDoc } from "../store";
import { SCENE3D_SEED } from "./scene3dSeed";

/**
 * 3D 场景图的属性编辑（scene3d 的 `graph`）。
 *
 * 这个面板解决的是「3D 幕只能看不能改」：以前 graph 在右栏是一个 JSON 文本框，
 * 想改一颗行星的颜色得读几千行 JSON、还得小心别把别的节点写坏。
 *
 * 四条约定：
 *  1. **按节点写回**，一条 op 只改一个字段（`update_graph_node`）。整份替换
 *     props.graph 会抹掉这段时间里 agent 或另一个窗口刚做的改动。
 *  2. **字段表从 schema 现算**（GEOMETRY_VARIANTS / MATERIAL_FIELDS）：
 *     加一个几何体、加一个材质参数不用改这里的代码，也不会漏。
 *  3. 数值输入走本地草稿 + 节流提交（`NumInput`），否则拖一次滑杆会发出几十条 op。
 *  4. 关键帧**只读展示**：节点的 anim 在区间内会覆盖基础变换，面板必须主动说出来，
 *     否则"拖了没反应"会被当成编辑器坏了（这一期不做关键帧编辑）。
 */

/* ────────────────────────── 小控件 ────────────────────────── */

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

/** 数值输入：本地草稿 + 240ms 节流 + 失焦立刻提交（负号、清空这类中间态要能打得出来） */
const NumInput: React.FC<{
  value: number;
  onCommit: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  title?: string;
  disabled?: boolean;
}> = ({ value, onCommit, step = 0.1, min, max, title, disabled }) => {
  const [text, setText] = useState(fmt(value));
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!focused.current) setText(fmt(value));
  }, [value]);

  const fire = (t: string) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const n = Number(t);
      if (t.trim() !== "" && Number.isFinite(n)) onCommit(n);
    }, 240);
  };
  const flushNow = () => {
    clearTimeout(timer.current);
    const n = Number(text);
    if (text.trim() !== "" && Number.isFinite(n)) onCommit(n);
    else setText(fmt(value));
  };

  return (
    <input
      type="number"
      className="s3d-input"
      value={text}
      step={step}
      min={min}
      max={max}
      title={title}
      disabled={disabled}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(e) => {
        setText(e.target.value);
        fire(e.target.value);
      }}
      onBlur={() => {
        focused.current = false;
        flushNow();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
      }}
    />
  );
};

/** 一行三个数（位置 / 旋转 / 缩放） */
const XYZ: React.FC<{
  label: string;
  value: number[];
  onChange: (next: number[]) => void;
  step?: number;
  title?: string;
}> = ({ label, value, onChange, step = 0.1, title }) => (
  <div className="s3d-row" title={title}>
    <span>{label}</span>
    {[0, 1, 2].map((i) => (
      <NumInput
        key={i}
        value={Number(value[i] ?? 0)}
        step={step}
        onCommit={(v) => {
          const next = [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0];
          next[i] = v;
          onChange(next);
        }}
      />
    ))}
  </div>
);

const THEME_TOKENS = ["primary", "accent", "secondary", "text", "muted"];

/**
 * 颜色：主题语义名或 #RRGGBB。
 *
 * 语义名是这个产品"跟整体风格联动"的关键（写死色值，换主题就不跟着变），
 * 所以色盘旁边永远摆着 5 个 token 按钮——只给色盘，用户必然把整片 3D 写成死色。
 */
const ColorField: React.FC<{
  label: string;
  value: string;
  onCommit: (v: string) => void;
  onClear?: () => void;
}> = ({ label, value, onCommit, onClear }) => {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  const hex = value.startsWith("#") ? value.slice(0, 7) : "#ffffff";
  return (
    <div className="field">
      <label>
        {label}
        {onClear ? (
          <button className="mini s3d-inline-btn" onClick={onClear} title="清掉这一项（回到不发光/不设色）">
            清除
          </button>
        ) : null}
      </label>
      <div className="s3d-color">
        <input
          type="color"
          value={hex}
          onChange={(e) => onCommit(e.target.value)}
          title="选一个具体色值（会写成 #RRGGBB，不再跟主题联动）"
        />
        <input
          className="s3d-input"
          value={text}
          placeholder="primary / #FFD27A"
          onFocus={() => {
            focused.current = true;
          }}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            focused.current = false;
            const t = text.trim();
            if (t && t !== value) onCommit(t);
            else setText(value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
          }}
        />
      </div>
      <div className="s3d-tokens">
        {THEME_TOKENS.map((t) => (
          <button
            key={t}
            className={`s3d-token ${value === t ? "is-on" : ""}`}
            onClick={() => onCommit(t)}
            title="跟随主题：换配色时它一起变"
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  );
};

const LockIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="4" y="10" width="16" height="11" rx="2" />
    <path d="M8 10V7a4 4 0 018 0v3" />
  </svg>
);

/* ────────────────────────── 关键帧编辑（M4） ────────────────────────── */

const EASE_LABEL: Record<EaseKind, string> = {
  easeInOut: "缓入出",
  easeIn: "缓入",
  easeOut: "缓出",
  linear: "线性",
};

export type KeyRow = { frame: number; text: string; ease: EaseKind };

/**
 * 关键帧列表。
 *
 * 交互取向：**帧号是主体，值只是旁证**。人在这里干的事是"跳到第 60 帧""这一颗不要了"
 * "整段往后挪 10 帧"，所以帧号放大、值压成灰色小字，跳帧用一个圆点，删用 ×。
 * 缓动做成"点一下换一个"的小标签：4 个选项做成下拉要两步，而这个动作会反复做。
 */
const KeyList: React.FC<{
  rows: KeyRow[];
  /** 当前幕内帧：高亮"我在这" */
  cur: number;
  /** 关键帧上限（节点受 anim.max(8) 限制，相机很宽松） */
  cap: number;
  onAdd: () => void;
  onSeek: (f: number) => void;
  onRemove: (f: number) => void;
  onCycleEase: (f: number) => void;
  onClear: () => void;
  onShift: (d: number) => void;
  onStretch: (k: number) => void;
  emptyHint: string;
  extraHint?: string;
}> = ({ rows, cur, cap, onAdd, onSeek, onRemove, onCycleEase, onClear, onShift, onStretch, emptyHint, extraHint }) => (
  <>
    <div className="section-title">
      关键帧
      <span className={`s3d-key-count ${rows.length >= cap ? "is-full" : ""}`}>
        {rows.length}/{cap}
      </span>
    </div>
    <div className="s3d-key-bar">
      <span>第 {cur} 帧</span>
      {/*
        手动打帧**不是主流程**：改数值、拖动物体都会自动打关键帧（见 writeTr / commitTransform）。
        这个按钮只解决自动打帧覆盖不到的一件事——"在某一帧把当前姿态钉住、什么都不改"
        （比如想让物体在 30–60 帧停住，再继续动）。成熟软件都有这条命令（Blender 的 I、
        AE 秒表旁的菱形），只是没人靠它从零做动画。
        同一帧再点 = 覆盖那一帧（以前是 disabled，想盖掉旧值却点不动）。
      */}
      {(() => {
        const here = rows.some((r) => r.frame === cur);
        /** 第 0 帧就是初始位置：没有关键帧时不存在"打帧"这回事，改值即为起点 */
        const zeroIdle = cur === 0 && rows.length === 0;
        return (
          <button
            className="mini s3d-key-add"
            onClick={onAdd}
            disabled={zeroIdle || (rows.length >= cap && !here)}
            title={
              zeroIdle
                ? "第 0 帧就是初始位置：在这里改数值/拖动物体，改动直接成为起点，不用打帧"
                : here
                  ? "用当前姿态覆盖这一帧的关键帧"
                  : "把当前姿态钉在这一帧（平时不用点：改数值、拖动物体会自动打帧）"
            }
          >
            {zeroIdle ? "第 0 帧即起点" : here ? "↻ 覆盖本帧" : "＋ 固定当前帧"}
          </button>
        );
      })()}
      {rows.length ? (
        <button className="mini" onClick={onClear} title="清空全部关键帧，回到静态">
          清空
        </button>
      ) : null}
    </div>
    <p className="s3d-hint s3d-autokey-hint">
      改数值、拖动物体会 <b>自动</b> 打关键帧，不用手动插；想让它停住不动时才用「固定当前帧」。
    </p>

    {rows.length ? (
      <div className="s3d-keys">
        {rows.map((r) => (
          <div key={r.frame} className={`s3d-key ${r.frame === cur ? "is-now" : ""}`}>
            <button
              className="s3d-key-dot"
              onClick={() => onSeek(r.frame)}
              title={`跳到第 ${r.frame} 帧`}
              aria-label={`跳到第 ${r.frame} 帧`}
            />
            <span className="s3d-key-frame">{r.frame}</span>
            <span className="s3d-key-val">{r.text}</span>
            <button
              className="s3d-key-ease"
              onClick={() => onCycleEase(r.frame)}
              title="到下一个关键帧之间的缓动（点一下换一个）"
            >
              {EASE_LABEL[r.ease]}
            </button>
            <button className="s3d-icon-btn" onClick={() => onRemove(r.frame)} title="删掉这个关键帧">
              ×
            </button>
          </div>
        ))}
      </div>
    ) : (
      <p className="s3d-hint">{emptyHint}</p>
    )}

    {rows.length >= 2 ? (
      <div className="s3d-key-bar s3d-key-tools">
        <span>整段</span>
        <button className="mini" onClick={() => onShift(-1)} title="所有关键帧往前挪 1 帧">
          ←1
        </button>
        <button className="mini" onClick={() => onShift(1)} title="所有关键帧往后挪 1 帧">
          →1
        </button>
        <button className="mini" onClick={() => onStretch(0.5)} title="以第一个关键帧为锚点，时长压缩一半">
          ×0.5
        </button>
        <button className="mini" onClick={() => onStretch(1.5)} title="以第一个关键帧为锚点，时长拉长 1.5 倍">
          ×1.5
        </button>
      </div>
    ) : null}
    {extraHint ? <p className="s3d-hint">{extraHint}</p> : null}
  </>
);

/* ────────────────────────── 主面板 ────────────────────────── */

type Tab = "nodes" | "camera" | "lights" | "atmo";

export const Scene3DInspector: React.FC<{ scene: Scene; fps: number }> = ({ scene, fps }) => {
  const apply = useDoc((s) => s.apply);
  const selection = useDoc((s) => s.selection);
  const setSelection = useDoc((s) => s.setSelection);
  const notify = useDoc((s) => s.notify);
  const [tab, setTab] = useState<Tab>("nodes");
  /** 拖拽换父级（M3）：正在拖的节点 id / 悬停中的目标 id */
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  /** shift 范围选择的锚点（上次单击的节点） */
  const anchorRef = useRef<string | null>(null);

  const graph = (scene.props as { graph?: Scene3DDsl }).graph;

  /**
   * 多选（M3）：selection 里所有 "g:<id>"。顺序**按大纲树排**——
   * 第一个是主选（属性面板编辑它、视口手柄挂它），后面是同行者。
   * 树排序而不是 selection 原序：ctrl 乱序点选后主选也稳定，不会跳。
   */
  const selectedIds = useMemo(() => {
    const picked = new Set(selection.filter((s) => s.startsWith("g:")).map((s) => s.slice(2)));
    if (!graph) return [...picked];
    return graph.nodes.filter((n) => picked.has(n.id)).map((n) => n.id);
  }, [selection, graph]);
  const selectedId = selectedIds[0] ?? null;
  const node = graph?.nodes.find((n) => n.id === selectedId) ?? null;

  // 选中的节点被删/被 agent 换掉之后，把失效的选中摘掉（否则面板空着但一直高亮）
  useEffect(() => {
    if (!selectedId || !graph) return;
    if (!graph.nodes.some((n) => n.id === selectedId)) setSelection([]);
  }, [graph, selectedId, setSelection]);

  // 从视口点中相机实体时，右栏直接切到相机页（否则停在节点页只显示"点一个节点开始编辑"）；
  // 从相机切回节点时也要切回节点页，不然树整块消失（页签跟着选择走）
  const camPicked = selection.includes("cam");
  const wasCam = useRef(false);
  useEffect(() => {
    if (camPicked && !wasCam.current) setTab("camera");
    else if (!camPicked && wasCam.current) setTab("nodes");
    wasCam.current = camPicked;
  }, [camPicked]);

  const write = (ops: Op[]) => void apply(ops);
  const patchNode = (nodeId: string, patch: Record<string, unknown>) =>
    write([{ op: "update_graph_node", sceneId: scene.id, nodeId, patch } as Op]);

  /* ────────────────────── 关键帧（M4） ────────────────────── */

  /** 当前帧（幕内）：关键帧列表要标出"我在这"，打关键帧也要知道打在哪 */
  const project = useDoc((s) => s.project);
  const sceneStart = useMemo(() => {
    if (!project) return 0;
    const i = project.scenes.findIndex((s) => s.id === scene.id);
    return i < 0 ? 0 : (sceneOffsets(project.scenes)[i] ?? 0);
  }, [project, scene.id]);
  const [globalFrame, setGlobalFrame] = useState(() => frameBus.get());
  useEffect(() => frameBus.subscribe(setGlobalFrame), []);
  const curFrame = Math.max(
    0,
    Math.min(Math.max(0, scene.durationInFrames - 1), Math.round(globalFrame - sceneStart)),
  );
  const seekTo = (f: number) => frameBus.seek(sceneStart + f);

  /**
   * 第一颗关键帧的"待定锚点"。
   *
   * DSL 里没有"单点关键帧"这种东西——段必须有起点和终点，`at:[f,f]` 只会在那一帧
   * 闪一下再弹回去。所以只有一颗时不写库，先记在这里等人打第二颗；打下去的那一刻
   * 一起落库成第一段。代价是刷新页面会丢（数据里确实还没有动画），可以接受。
   */
  const [pendingNodeKey, setPendingNodeKey] = useState<Record<string, NodeKey>>({});
  const [pendingCamKey, setPendingCamKey] = useState<CamKey | null>(null);

  /** 节点关键帧（数据里的端点帧 + 本地待定锚点，按帧号合并） */
  const nodeKeys = useMemo(() => {
    if (!node) return [] as NodeKey[];
    const base = nodeKeysOf(node);
    const p = pendingNodeKey[node.id];
    if (!p || base.some((k) => k.frame === p.frame)) return base;
    return [...base, p].sort((a, b) => a.frame - b.frame);
  }, [node, pendingNodeKey]);

  /** 统一出口：<2 颗就退化成"只记锚点"，≥2 颗才写库（一条 op = 一步撤销） */
  const commitNodeKeys = (next: NodeKey[], addedFrame?: number) => {
    if (!node) return;
    if (next.length < 2) {
      setPendingNodeKey((p) => ({ ...p, [node.id]: next[0] }));
      patchNode(node.id, { anim: null });
      if (next[0]) notify(`第 ${next[0].frame} 帧记为起点：换个帧再打一颗才会动起来`);
      return;
    }
    setPendingNodeKey((p) => {
      if (!(node.id in p)) return p;
      const q = { ...p };
      delete q[node.id];
      return q;
    });
    patchNode(node.id, { anim: nodeAnimFromKeys(next) });
    if (typeof addedFrame === "number") notify(`已在第 ${addedFrame} 帧打关键帧（共 ${next.length} 颗）`);
  };

  /** 打关键帧 = 把"这一帧现在的样子"钉住。用渲染同一份求值，所以打完画面不会跳 */
  const addNodeKey = () => {
    if (!node) return;
    if (nodeKeys.length >= NODE_KEY_MAX) {
      notify(`关键帧上限 ${NODE_KEY_MAX} 颗（DSL 一段动画要两头，最多 ${NODE_KEY_MAX - 1} 段），先删几颗`);
      return;
    }
    const tr = evalNode(node, curFrame);
    const base = nodeBaseScale(node);
    commitNodeKeys(
      // 关键帧不足两颗时自动补 0 帧锚点：第 0 帧永远是初始位置，不该等用户手动补
      upsertKeyKeepingZero(
        nodeKeys,
        {
          frame: curFrame,
          pos: tr.pos,
          rot: tr.rot,
          // anim 的 scale 是乘法：这里存倍率
          scale: base ? tr.scale[0] / base : 1,
          opacity: tr.opacity,
          ease: "easeInOut",
        },
        nodeKeyAt(node, 0),
      ),
      curFrame,
    );
  };
  const removeNodeKey = (f: number) => commitNodeKeys(removeKeyAt(nodeKeys, f));
  const shiftNodeKeys = (d: number) => commitNodeKeys(shiftKeys(nodeKeys, d));
  const stretchNodeKeys = (k: number) => commitNodeKeys(stretchKeys(nodeKeys, k));
  const cycleNodeEase = (f: number) =>
    commitNodeKeys(
      nodeKeys.map((k) =>
        k.frame === f
          ? { ...k, ease: EASE_KINDS[(EASE_KINDS.indexOf(k.ease) + 1) % EASE_KINDS.length] }
          : k,
      ),
    );
  const clearNodeKeys = () => {
    if (!node) return;
    setPendingNodeKey((p) => {
      const q = { ...p };
      delete q[node.id];
      return q;
    });
    patchNode(node.id, { anim: null });
    notify("关键帧已清空，节点回到静态");
  };

  /* ── 轨迹形状（直线 / 平滑 / 手动贝塞尔） ── */

  const r3 = (v: readonly number[]): [number, number, number] => [
    Math.round((v[0] ?? 0) * 1e4) / 1e4,
    Math.round((v[1] ?? 0) * 1e4) / 1e4,
    Math.round((v[2] ?? 0) * 1e4) / 1e4,
  ];

  /** 只改一段的一侧曲线，另一侧原样保留；两侧都归零就把 curve 整个删掉 */
  const withCurveSide = <T extends { curve?: { out?: number[]; in?: number[] } }>(
    seg: T,
    side: "out" | "in",
    v: [number, number, number] | null,
  ): T => {
    if (!v) return seg;
    const out = side === "out" ? v : (seg.curve?.out ?? [0, 0, 0]);
    const inn = side === "in" ? v : (seg.curve?.in ?? [0, 0, 0]);
    const flat = [...out, ...inn].every((x) => Math.abs(x) < 1e-4);
    return { ...seg, ...(flat ? { curve: undefined } : { curve: { out: r3(out), in: r3(inn) } }) };
  };

  /** 某一帧两侧的段（没有的那侧为 null）。节点和相机共用 */
  const sidesAt = <T extends { at: [number, number] }>(segs: T[], f: number) => ({
    prev: segs.find((a) => Math.round(a.at[1]) === f) ?? null,
    next: segs.find((a) => Math.round(a.at[0]) === f) ?? null,
  });

  const frameNow = Math.round(curFrame);

  /**
   * 只平滑**当前这一颗关键帧**两侧的线。
   *
   * 整条平滑会把其它关键帧已经调好的曲线一起重算——用户在某一颗点上点"平滑"，
   * 期望的只是"这个拐点变圆"，不是"整条轨迹重新洗一遍"。
   */
  const smoothNodeAtPoint = () => {
    if (!node?.anim?.length) return;
    const f = frameNow;
    const { prev, next } = sidesAt(node.anim, f);
    if (!prev && !next) {
      notify(`第 ${f} 帧不是关键帧：先点视口里轨迹上的关键帧球，再把播放头停在这一帧`);
      return;
    }
    const posAt = (fr: number) => evalNode(node, fr).pos as [number, number, number];
    const span = (a: [number, number, number], b: [number, number, number]) =>
      Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const P = prev ? posAt(Math.round(prev.at[0])) : null;
    const N = next ? posAt(Math.round(next.at[1])) : null;
    const { inPrev, outNext } = smoothAtKey(
      P,
      posAt(f),
      N,
      P ? span(P, posAt(f)) : 0,
      N ? span(posAt(f), N) : 0,
    );
    if (!inPrev && !outNext) {
      notify("这个点在轨迹两端（只有一侧有段），没有切线可平滑；要整条拉直用下面的「整条」");
      return;
    }
    patchNode(node.id, {
      anim: node.anim.map((a) => {
        if (prev && a === prev) return withCurveSide(a, "in", inPrev);
        if (next && a === next) return withCurveSide(a, "out", outNext);
        return a;
      }),
    });
    notify(`第 ${f} 帧两侧已平滑（只改这两段靠近该点的一端，其它关键帧不动）`);
  };

  /** 只拉直**当前这一颗关键帧**两侧的线（该点两侧切线归零），其它点不动 */
  const straightNodeAtPoint = () => {
    if (!node?.anim?.length) return;
    const f = frameNow;
    const { prev, next } = sidesAt(node.anim, f);
    if (!prev && !next) {
      notify(`第 ${f} 帧不是关键帧：先点视口里轨迹上的关键帧球`);
      return;
    }
    patchNode(node.id, {
      anim: node.anim.map((a) => {
        if (prev && a === prev) return withCurveSide(a, "in", [0, 0, 0]);
        if (next && a === next) return withCurveSide(a, "out", [0, 0, 0]);
        return a;
      }),
    });
    notify(`第 ${f} 帧两侧已拉直（其它关键帧不动）`);
  };

  /**
   * 一键平滑：每段两端各取"邻居差分的一半"当切线（Catmull-Rom）。
   * 相邻段在共享关键帧处算出同一条切线，所以接缝 C1 连续 —— 不会出现速度折角。
   * 邻居按端点帧在关键帧序列里的位置找；首末段没有邻居就自然退化为直线。
   */
  const smoothNodePath = () => {
    if (!node?.anim?.length) return;
    const frames = nodeKeyFrames(node);
    const posAt = (f: number) => evalNode(node, f).pos;
    const nextAnim = node.anim.map((a) => {
      const s = Math.round(a.at[0]);
      const e = Math.round(a.at[1]);
      const iS = frames.indexOf(s);
      const iE = frames.indexOf(e);
      const prev = iS > 0 ? frames[iS - 1] : null;
      const next = iE >= 0 && iE < frames.length - 1 ? frames[iE + 1] : null;
      const { out, inn } = smoothTangents(
        prev != null ? (posAt(prev) as [number, number, number]) : null,
        posAt(s) as [number, number, number],
        posAt(e) as [number, number, number],
        next != null ? (posAt(next) as [number, number, number]) : null,
      );
      /** 两侧都算成 0（端点的端点没有邻居）就不写 curve，别在 DSL 里留零值 */
      const flat = [...out, ...inn].every((v) => Math.abs(v) < 1e-4);
      return { ...a, ...(flat ? { curve: undefined } : { curve: { out: r3(out), in: r3(inn) } }) };
    });
    patchNode(node.id, { anim: nextAnim });
    notify("轨迹已平滑：相邻段在关键帧处相切，拐点变成圆角");
  };

  const straightNodePath = () => {
    if (!node?.anim?.length) return;
    patchNode(node.id, { anim: node.anim.map((a) => ({ ...a, curve: undefined })) });
    notify("轨迹已拉直：所有段恢复直线");
  };

  /**
   * 运镜路径一键平滑。相机的 pos 本来就是世界坐标，所以端点直接用 dslCamera 取；
   * follow 段例外（pos 是相对节点的偏移），整条运镜里有 follow 时不给按——
   * 拿世界邻点去算偏移会得到一条越飞越偏的曲线，比不按更糟。
   */
  const smoothCamPath = () => {
    if (!graph?.camera?.anim?.length) return;
    if (camHasFollow(graph.camera)) {
      notify("这条运镜里有 follow（相对跟随）段，路径平滑会算歪；先去掉跟随再平滑");
      return;
    }
    const frames = camKeyFrames(graph.camera);
    const posAt = (f: number) => dslCamera(graph, f / fps, fps).worldPos;
    const next = graph.camera.anim.map((a) => {
      const s = Math.round(a.at[0]);
      const e = Math.round(a.at[1]);
      const iS = frames.indexOf(s);
      const iE = frames.indexOf(e);
      const prev = iS > 0 ? frames[iS - 1] : null;
      const nextF = iE >= 0 && iE < frames.length - 1 ? frames[iE + 1] : null;
      const { out, inn } = smoothTangents(
        prev != null ? posAt(prev) : null,
        posAt(s),
        posAt(e),
        nextF != null ? posAt(nextF) : null,
      );
      const flatCam = [...out, ...inn].every((v) => Math.abs(v) < 1e-4);
      return { ...a, ...(flatCam ? { curve: undefined } : { curve: { out: r3(out), in: r3(inn) } }) };
    });
    write([{ op: "set_graph_camera", sceneId: scene.id, camera: { anim: next } } as Op]);
    notify("运镜已平滑：镜头会沿弧线绕过去，拐点不再打折");
  };

  const straightCamPath = () => {
    if (!graph?.camera?.anim?.length) return;
    write([
      {
        op: "set_graph_camera",
        sceneId: scene.id,
        camera: { anim: graph.camera.anim.map((a) => ({ ...a, curve: undefined })) },
      } as Op,
    ]);
    notify("运镜已拉直：所有段恢复直线");
  };

  /** 只平滑当前这一颗运镜关键帧两侧（其它机位点不动） */
  const smoothCamAtPoint = () => {
    if (!graph?.camera?.anim?.length) return;
    const f = frameNow;
    const { prev, next } = sidesAt(graph.camera.anim, f);
    if (!prev && !next) {
      notify(`第 ${f} 帧不是运镜关键帧：先点视口里运镜轨迹上的关键帧球`);
      return;
    }
    if ([prev, next].some((s) => s && (s as { follow?: string }).follow)) {
      notify("这一帧旁边是 follow（跟随）段，位置是相对偏移，按世界坐标算切线会算歪；先去掉跟随");
      return;
    }
    const posAt = (fr: number) => dslCamera(graph, fr / fps, fps).worldPos;
    const span = (a: [number, number, number], b: [number, number, number]) =>
      Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const P = prev ? posAt(Math.round(prev.at[0])) : null;
    const N = next ? posAt(Math.round(next.at[1])) : null;
    const { inPrev, outNext } = smoothAtKey(
      P,
      posAt(f),
      N,
      P ? span(P, posAt(f)) : 0,
      N ? span(posAt(f), N) : 0,
    );
    if (!inPrev && !outNext) {
      notify("这个点在运镜两端（只有一侧有段），没有切线可平滑；要整条拉直用「整条」");
      return;
    }
    write([
      {
        op: "set_graph_camera",
        sceneId: scene.id,
        camera: {
          anim: graph.camera.anim.map((a) => {
            if (prev && a === prev) return withCurveSide(a, "in", inPrev);
            if (next && a === next) return withCurveSide(a, "out", outNext);
            return a;
          }),
        },
      } as Op,
    ]);
    notify(`第 ${f} 帧两侧已平滑（其它机位点不动）`);
  };

  /** 只拉直当前这一颗运镜关键帧两侧 */
  const straightCamAtPoint = () => {
    if (!graph?.camera?.anim?.length) return;
    const f = frameNow;
    const { prev, next } = sidesAt(graph.camera.anim, f);
    if (!prev && !next) {
      notify(`第 ${f} 帧不是运镜关键帧：先点视口里运镜轨迹上的关键帧球`);
      return;
    }
    write([
      {
        op: "set_graph_camera",
        sceneId: scene.id,
        camera: {
          anim: graph.camera.anim.map((a) => {
            if (prev && a === prev) return withCurveSide(a, "in", [0, 0, 0]);
            if (next && a === next) return withCurveSide(a, "out", [0, 0, 0]);
            return a;
          }),
        },
      } as Op,
    ]);
    notify(`第 ${f} 帧两侧已拉直（其它机位点不动）`);
  };

  /* 相机运镜关键帧：值是世界坐标（和视口里那台相机实体看到的一致） */
  const isNodeKeyFrame = Boolean(
    node?.anim?.some((a) => Math.round(a.at[0]) === frameNow || Math.round(a.at[1]) === frameNow),
  );
  const isCamKeyFrame = Boolean(
    graph?.camera?.anim?.some((a) => Math.round(a.at[0]) === frameNow || Math.round(a.at[1]) === frameNow),
  );
  const camFollowLocked = Boolean(graph && camHasFollow(graph.camera));
  const camKeys = useMemo(() => {
    const base = !graph || camFollowLocked ? [] : camKeysOf(graph, fps);
    if (!pendingCamKey || base.some((k) => k.frame === pendingCamKey.frame)) return base;
    return [...base, pendingCamKey].sort((a, b) => a.frame - b.frame);
  }, [graph, fps, camFollowLocked, pendingCamKey]);

  const commitCamKeys = (next: CamKey[], addedFrame?: number) => {
    if (next.length < 2) {
      setPendingCamKey(next[0] ?? null);
      write([{ op: "set_graph_camera", sceneId: scene.id, camera: { anim: null } } as Op]);
      if (next[0]) notify(`第 ${next[0].frame} 帧记为运镜起点：换个帧再打一颗才会动起来`);
      return;
    }
    setPendingCamKey(null);
    write([
      { op: "set_graph_camera", sceneId: scene.id, camera: { anim: camAnimFromKeys(next) } } as Op,
    ]);
    if (typeof addedFrame === "number") notify(`已在第 ${addedFrame} 帧打运镜关键帧（共 ${next.length} 颗）`);
  };
  const addCamKey = () => {
    if (!graph) return;
    const c = dslCamera(graph, curFrame / fps, fps);
    commitCamKeys(
      // 同节点：不足两颗时补第 0 帧（起始机位）
      upsertKeyKeepingZero(
        camKeys,
        /**
         * 走 camKeyWithPose：它会继承当前段的 follow/lookAt。
         * 打关键帧等于把这一段切成两半，新关键帧是后半段的起点——不继承就等于
         * "打个关键帧把锁定弄丢了"。
         */
        camKeyWithPose(graph, curFrame, { pos: c.worldPos, target: c.worldTarget, fov: c.fov }),
        camZeroKeyOf(graph, fps),
      ),
      curFrame,
    );
  };
  const cycleCamEase = (f: number) =>
    commitCamKeys(
      camKeys.map((k) =>
        k.frame === f
          ? { ...k, ease: EASE_KINDS[(EASE_KINDS.indexOf(k.ease) + 1) % EASE_KINDS.length] }
          : k,
      ),
    );
  const clearCamKeys = () => {
    setPendingCamKey(null);
    write([{ op: "set_graph_camera", sceneId: scene.id, camera: { anim: null } } as Op]);
    notify(
      camLockSpans.length
        ? "运镜关键帧已清空，相机回到固定机位（其中的锁定段也一起清掉了）"
        : "运镜关键帧已清空，相机回到固定机位",
    );
  };

  /* ── 看向锁定：把"镜头死盯某个物体"写成段的 lookAt 约束 ── */

  const camLockSpans = useMemo(() => camLookAtSpans(graph?.camera), [graph]);
  /** 面板下拉的选择；不选就跟随"当前正在锁谁"，这样点「重新锁定」不会先要人再选一次 */
  const [camLockPick, setCamLockPick] = useState("");
  /**
   * 当前帧**实际生效**的那一段（所有 start ≤ 当前帧的段里，start 最大的那个）。
   * 不能"找包含该帧的段"：段是首尾相接的，边界帧会同时命中两段，
   * 命中前一段就会在"已经退出锁定"的帧上显示"锁定中"。
   */
  const camSegNow = useMemo(() => {
    const anims = [...(graph?.camera?.anim ?? [])].sort((a, b) => a.at[0] - b.at[0]);
    let cur: (typeof anims)[number] | null = null;
    for (const a of anims) if (a.at[0] <= curFrame) cur = a;
    return cur;
  }, [graph, curFrame]);
  const camLockNow = camSegNow?.lookAt
    ? { id: camSegNow.lookAt, start: Math.round(camSegNow.at[0]), end: Math.round(camSegNow.at[1]) }
    : null;
  const camLockSelect = camLockPick || camLockNow?.id || graph?.nodes[0]?.id || "";
  const labelOf = (id: string) => graph?.nodes.find((n) => n.id === id)?.label ?? id;

  /**
   * 锁定 / 退出。**只有这个操作会改段结构**（在目标帧切段），所以错误要原样抛给用户看：
   * follow 段不能切、段数有限，这些都是用户需要知道的约束，不是内部异常。
   */
  const applyCamLookAt = (nodeId: string | null, atFrame = curFrame) => {
    if (!graph) return;
    const r = withCamLookAt(graph, atFrame, nodeId, fps);
    if ("error" in r) {
      notify(r.error);
      return;
    }
    write([{ op: "set_graph_camera", sceneId: scene.id, camera: { anim: r.anim } } as Op]);
    notify(
      nodeId
        ? `已从第 ${atFrame} 帧起锁定「${labelOf(nodeId)}」：看向线变虚线，镜头每帧重新对准它`
        : `已从第 ${atFrame} 帧退出锁定：镜头从当时的锁定点继续飞`,
    );
  };

  /**
   * 相机在当前帧的**真实机位**（有运镜时是插值结果）。
   *
   * 面板必须显示它，不是 `graph.camera.position`：后者是基准值，运镜区间内根本不生效。
   * 之前显示基准值的后果很隐蔽——人以为改了机位，其实画面没动，接着打下的关键帧
   * 两颗一模一样，轨迹退化成两个重叠的点（实测就是这么被报上来的）。
   */
  const camNow = useMemo<{
    pos: [number, number, number];
    target: [number, number, number];
    fov: number;
  }>(() => {
    if (!graph) return { pos: [0, 1.6, 6], target: [0, 0, 0], fov: 42 };
    const c = dslCamera(graph, curFrame / fps, fps);
    return { pos: c.worldPos, target: c.worldTarget, fov: c.fov };
  }, [graph, curFrame, fps]);

  /**
   * 面板改机位。规则和节点完全一致：**第 0 帧 = 起始机位**，非 0 帧的改动只写关键帧。
   *
   * 以前是"运镜区间内写关键帧、区间外写基准机位"，于是"在 60 帧改机位、0 帧跟着变"，
   * 而且两颗关键帧的机位被改成了同一个（轨迹退化成两个重叠的点）。
   */
  const writeCam = (patch: { position?: number[]; target?: number[]; fov?: number }) => {
    if (!graph) return;
    /**
     * 锁定段里改"看向"是无效的：target 每帧被节点位置覆盖。
     * 静默忽略最伤信任（用户调半天画面不动），所以明说 + 不动数据。
     */
    if (patch.target && camLockNow) {
      notify(
        `第 ${curFrame} 帧正锁定「${labelOf(camLockNow.id)}」：看向点由目标位置每帧决定，改这里不会生效。` +
          `要手改看向，先点「退出锁定」`,
      );
      patch = { ...patch, target: undefined };
      if (!patch.position && patch.fov === undefined) return;
    }
    if (camFollowLocked) {
      // follow 段是相对节点的偏移，图形化改会把镜头带跑（见 camHasFollow 的注释）
      write([{ op: "set_graph_camera", sceneId: scene.id, camera: patch } as Op]);
      return;
    }

    if (curFrame === 0) {
      if (camKeys.length && camKeys[0].frame === 0) {
        const k0 = camKeys[0];
        const next = upsertKey(camKeys, {
          ...k0,
          pos: (patch.position ?? k0.pos) as [number, number, number],
          target: (patch.target ?? k0.target) as [number, number, number],
          fov: patch.fov ?? k0.fov,
        });
        write([
          { op: "set_graph_camera", sceneId: scene.id, camera: { anim: camAnimFromKeys(next) } } as Op,
        ]);
        notify("第 0 帧（起始机位）的运镜关键帧已更新");
        return;
      }
      write([{ op: "set_graph_camera", sceneId: scene.id, camera: patch } as Op]);
      return;
    }

    const key = camKeyWithPose(graph, curFrame, {
      pos: (patch.position ?? camNow.pos) as [number, number, number],
      target: (patch.target ?? camNow.target) as [number, number, number],
      fov: patch.fov ?? camNow.fov,
    });
    const zero = camZeroKeyOf(graph, fps);
    const next = upsertKeyKeepingZero(camKeys, key, zero);
    write([
      { op: "set_graph_camera", sceneId: scene.id, camera: { anim: camAnimFromKeys(next) } } as Op,
    ]);
    notify(
      next.length === 2 && next[0].frame === 0
        ? `已在第 ${curFrame} 帧打运镜关键帧（第 0 帧保持起始机位）`
        : `第 ${curFrame} 帧的运镜关键帧已更新`,
    );
  };


  /* ── 多选：单击单选、Ctrl/Cmd 切换、Shift 范围选 ── */
  const clickNode = (n: DslNode, e: React.MouseEvent) => {
    if (!graph) return;
    if (e.shiftKey && anchorRef.current && anchorRef.current !== n.id) {
      const ids = tree.map((t) => t.node.id);
      const i0 = ids.indexOf(anchorRef.current);
      const i1 = ids.indexOf(n.id);
      if (i0 >= 0 && i1 >= 0) {
        const [a, b] = i0 < i1 ? [i0, i1] : [i1, i0];
        setSelection(ids.slice(a, b + 1).map((x) => `g:${x}`));
        return;
      }
    }
    anchorRef.current = n.id;
    if (e.ctrlKey || e.metaKey) {
      const set = new Set(selectedIds);
      if (set.has(n.id)) set.delete(n.id);
      else set.add(n.id);
      if (!set.size) {
        setSelection([]);
        return;
      }
      setSelection(graph.nodes.filter((x) => set.has(x.id)).map((x) => `g:${x.id}`));
      return;
    }
    setSelection([`g:${n.id}`]);
  };

  /* ── 拖拽换父级：行上放下 = 挂到它下面，树的空白处放下 = 回根级。
       服务端会保持世界变换（画面不跳）并拒绝成环，这里只做前置提示 ── */
  const isDescendantOf = (ancestorId: string, id: string): boolean => {
    if (!graph) return false;
    let cur = graph.nodes.find((x) => x.id === id);
    while (cur?.parent) {
      if (cur.parent === ancestorId) return true;
      cur = graph.nodes.find((x) => x.id === cur!.parent);
    }
    return false;
  };
  const reparent = (fromId: string, parentId: string | null) => {
    if (!graph || fromId === parentId) return;
    if (parentId && isDescendantOf(fromId, parentId)) {
      notify(`「${parentId}」在「${fromId}」自己的子树里，不能挂到自己下面`);
      return;
    }
    const n = graph.nodes.find((x) => x.id === fromId);
    if (!n || (n.parent ?? null) === parentId) return;
    patchNode(fromId, { parent: parentId });
  };

  /* ── 复制节点：深拷贝整棵子树、重编 id，根节点往 X 推一点（不然和原件重叠，像"没复制"） ── */
  const duplicateNode = (target: DslNode) => {
    if (!graph) return;
    const subtree: DslNode[] = [target];
    for (let i = 0; i < subtree.length; i++) {
      for (const n of graph.nodes) if (n.parent === subtree[i].id) subtree.push(n);
    }
    if (graph.nodes.length + subtree.length > 48) {
      notify(`复制需要 ${subtree.length} 个新节点，超出 48 上限（现有 ${graph.nodes.length} 个）`);
      return;
    }
    const used = new Set(graph.nodes.map((n) => n.id));
    let seq = graph.nodes.length + 1;
    const nextId = () => {
      while (used.has(`n${seq}`)) seq++;
      return `n${seq++}`;
    };
    const idMap = new Map<string, string>();
    const ops = subtree.map((n, i) => {
      const id = nextId();
      idMap.set(n.id, id);
      // JSON 深拷贝：material/transform/anim 都是纯数据，结构化克隆反而要小心 WebGL 对象引用
      const clone = JSON.parse(JSON.stringify(n)) as Record<string, unknown>;
      delete clone.id;
      if (i === 0) {
        clone.label = `${n.label ?? n.id} 副本`;
        const tr = (clone.transform ?? {}) as Record<string, unknown>;
        const pos = (tr.position as number[] | undefined) ?? [0, 0, 0];
        clone.transform = {
          ...tr,
          position: [Math.round((pos[0] + 1.4) * 100) / 100, pos[1] ?? 0, pos[2] ?? 0],
        };
        if (n.parent) clone.parent = n.parent;
      } else {
        // 子节点保持原相对变换，挂到克隆出的新父级下
        clone.parent = idMap.get(n.parent ?? "");
      }
      return { op: "add_graph_node", sceneId: scene.id, node: clone } as unknown as Op;
    });
    write(ops);
    setSelection([`g:${idMap.get(target.id)!}`]);
    notify(
      `已复制「${target.label ?? target.id}」${subtree.length > 1 ? `（含 ${subtree.length - 1} 个子节点）` : ""}`,
    );
  };

  /* ── 批量操作：一条 apply = 一步撤销。删的时候只删"顶层选中"（子节点随父走，别发孤儿 op） ── */
  const deleteSelected = () => {
    if (!graph) return;
    const set = new Set(selectedIds);
    const tops = selectedIds.filter((id) => {
      let cur = graph.nodes.find((x) => x.id === id);
      while (cur?.parent) {
        if (set.has(cur.parent)) return false;
        cur = graph.nodes.find((x) => x.id === cur!.parent);
      }
      return true;
    });
    const locked = tops.filter((id) => graph.nodes.find((x) => x.id === id)?.locked);
    if (locked.length) {
      notify(`${locked.length} 个节点已锁定，先解锁再删`);
      return;
    }
    write(
      tops.map(
        (id) => ({ op: "remove_graph_node", sceneId: scene.id, nodeId: id, withChildren: true }) as Op,
      ),
    );
    setSelection([]);
  };
  const batchPatch = (patch: Record<string, unknown>) =>
    write(
      selectedIds.map(
        (id) => ({ op: "update_graph_node", sceneId: scene.id, nodeId: id, patch }) as Op,
      ),
    );

  /** 按父子关系排出的树（大纲顺序 = 数组顺序；父子只影响缩进） */
  const tree = useMemo(() => {
    if (!graph) return [] as { node: DslNode; depth: number }[];
    const byParent = new Map<string, DslNode[]>();
    for (const n of graph.nodes) {
      const k = n.parent ?? "";
      byParent.set(k, [...(byParent.get(k) ?? []), n]);
    }
    const out: { node: DslNode; depth: number }[] = [];
    const walk = (parent: string, depth: number) => {
      for (const n of byParent.get(parent) ?? []) {
        out.push({ node: n, depth });
        walk(n.id, depth + 1);
      }
    };
    walk("", 0);
    // 父级不存在的孤儿（理论上被校验挡住，这里兜底别让它从大纲里消失）
    for (const n of graph.nodes) if (!out.some((x) => x.node.id === n.id)) out.push({ node: n, depth: 0 });
    return out;
  }, [graph]);

  if (!graph) {
    return (
      <aside className="panel right">
        <div className="panel-head">
          <span>属性</span>
          <span className="tag">3D 场景</span>
        </div>
        <div className="panel-scroll">
          <SceneBoxSection scene={scene} />
          <BackdropSection scene={scene} />
          <TransitionSection scene={scene} />
          <p className="empty">这一幕没有场景图（用的是预置预设）</p>
        </div>
      </aside>
    );
  }

  const addNode = (type: string) => {
    const roots = graph.nodes.filter((n) => !n.parent);
    // 新节点别叠在原点（否则和主体重合，看起来像"没加上"）
    const x = Math.round(roots.length * 1.6 * 10) / 10;
    // id 要避开已有节点：n${length+1} 在删过节点之后会和现存的撞名
    const used = new Set(graph.nodes.map((n) => n.id));
    let seq = graph.nodes.length + 1;
    while (used.has(`n${seq}`)) seq++;
    const id = `n${seq}`;
    write([
      {
        op: "add_graph_node",
        sceneId: scene.id,
        node: {
          id,
          label: `新${type}`,
          geometry: { type },
          transform: { position: [x, 0, 0] },
        },
      } as Op,
    ]);
    setSelection([`g:${id}`]);
  };

  const removeNode = (target: DslNode) => {
    // 锁定就是防误删的：锁着还能一键删，这个开关就没有意义
    if (target.locked) {
      notify(`「${target.label ?? target.id}」已锁定，先解锁再删`);
      return;
    }
    const kids = graph.nodes.filter((n) => n.parent === target.id);
    write([
      { op: "remove_graph_node", sceneId: scene.id, nodeId: target.id, withChildren: true } as Op,
    ]);
    if (kids.length) notify(`已删除「${target.label ?? target.id}」及其 ${kids.length} 个子节点`);
    setSelection([]);
  };

  const geo = node?.geometry as Record<string, unknown> | undefined;
  const mat = (node?.material ?? {}) as Record<string, unknown>;
  const tr = (node?.transform ?? {}) as Record<string, unknown>;
  /**
   * 有关键帧时，面板显示的是**当前帧的求值结果**，不是基础变换。
   *
   * 以前这里读 base：第 0 帧明明在起点，面板却显示最后一帧的坐标——看起来像
   * "第一颗关键帧被改成了终点"，其实数据完全正确，只是数值来源错了。
   * 用 `evalNode` 显示，和画面必然一致（段外它会自动落回 base）。
   */
  const animTr = node && (node.anim ?? []).length ? evalNode(node, curFrame) : null;
  const pos = animTr ? animTr.pos : ((tr.position as number[]) ?? [0, 0, 0]);
  const rot = animTr ? animTr.rot : ((tr.rotation as number[]) ?? [0, 0, 0]);
  /** 有动画时不显示分轴：DSL 的 anim 只能整体缩放，分轴写不进去 */
  const scaleXYZ = animTr ? undefined : (tr.scaleXYZ as number[] | undefined);
  const uniform = animTr ? animTr.scale[0] : typeof tr.scale === "number" ? tr.scale : 1;
  const matType = String(mat.type ?? "standard");

  /**
   * 面板改变换：落在动画区间内就改**当前帧的关键帧**，否则改基础变换。
   *
   * 和视口拖动同一套规则（`commitTransform` 里那个分支）。不这样的话，区间内改数值
   * 就是"改了没反应"——值由关键帧决定，改 base 当然不动。
   */
  const writeTr = (patch: { position?: number[]; rotation?: number[]; scale?: number }) => {
    if (!node) return;
    const base = nodeBaseScale(node);
    const relScale = (abs: number) => (base ? abs / base : abs);

    /**
     * 第 0 帧 = **初始位置**，永远是别的帧的参照系。
     *
     * 0 帧有一颗自己的关键帧时改它（改基础变换不会动，段的 `from` 盖在上面）；
     * 没有就改基础变换——0 帧显示的就是基础值。
     */
    if (curFrame === 0) {
      if (nodeKeys.length && nodeKeys[0].frame === 0) {
        const k0 = nodeKeys[0];
        const next = upsertKey(nodeKeys, {
          ...k0,
          pos: (patch.position ?? k0.pos) as [number, number, number],
          rot: (patch.rotation ?? k0.rot) as [number, number, number],
          scale: patch.scale !== undefined ? relScale(patch.scale) : k0.scale,
        });
        patchNode(node.id, { anim: nodeAnimFromKeys(next) });
        notify("第 0 帧（初始位置）的关键帧已更新");
        return;
      }
      patchNode(node.id, { transform: patch });
      return;
    }

    /**
     * 非 0 帧：**只写关键帧，绝不碰基础变换**。
     *
     * 否则"在第 60 帧挪一下物体"会改到基础值上，而 0 帧显示的就是基础值——
     * 于是 0 帧跟着跑掉了（用户报的"0 帧变成最后一帧的位置"）。
     * 关键帧不足两颗时先补一颗 0 帧锚点（当时的初始姿态），保证 0 帧不动。
     */
    const cur = evalNode(node, curFrame);
    const key = {
      frame: curFrame,
      pos: (patch.position ?? cur.pos) as [number, number, number],
      rot: (patch.rotation ?? cur.rot) as [number, number, number],
      scale: patch.scale !== undefined ? relScale(patch.scale) : base ? cur.scale[0] / base : 1,
      opacity: cur.opacity,
      ease: "easeInOut" as const,
    };
    const next = upsertKeyKeepingZero(nodeKeys, key, nodeKeyAt(node, 0));
    patchNode(node.id, { anim: nodeAnimFromKeys(next) });
    notify(
      next.length === 2 && next[0].frame === 0
        ? `已在第 ${curFrame} 帧打关键帧（第 0 帧保持初始位置）`
        : `第 ${curFrame} 帧的关键帧已更新`,
    );
  };

  return (
    <aside className="panel right">
      <div className="panel-head">
        <span>属性</span>
        <span className="tag">3D 场景</span>
      </div>
      <div className="panel-scroll">
        {/* 整幕属性放最上面：3D 字段很长，藏到下面等于没有入口 */}
        <SceneBoxSection scene={scene} />
        <BackdropSection scene={scene} />
        <TransitionSection scene={scene} />

        <div className="panel-tabs s3d-tabs">
          {(
            [
              ["nodes", `节点 ${graph.nodes.length}`],
              ["camera", "相机"],
              ["lights", `灯光 ${graph.lights?.length ?? 0}`],
              ["atmo", "氛围"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} className={`panel-tab ${tab === k ? "is-active" : ""}`} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </div>

        {tab === "nodes" ? (
          <>
            <p className="s3d-hint" style={{ marginTop: 0 }}>
              构图完全由节点决定：预设（preset / spin / count / hue）在这张图上不会生效。
              每条改动都是一步撤销，和 agent 的改动互不覆盖。
            </p>
            <div
              className="s3d-tree"
              onDragOver={(e) => {
                if (dragId) e.preventDefault(); // 允许"放到空白处 = 回根级"
              }}
              onDrop={(e) => {
                if (!dragId) return;
                e.preventDefault();
                reparent(dragId, null);
                setDragId(null);
                setOverId(null);
              }}
            >
              <div
                className={`s3d-node ${selection.includes("cam") ? "is-selected" : ""}`}
                onClick={() => {
                  setSelection(["cam"]);
                  setTab("camera");
                }}
                onDragOver={(e) => e.stopPropagation()}
                onDrop={(e) => e.stopPropagation()}
                title="成片相机：视口里那个灰色相机框就是它，可以直接拖着手柄运镜"
              >
                <span className="s3d-node-name">成片相机</span>
                <span className="s3d-node-geo">camera</span>
              </div>
              {tree.map(({ node: n, depth }) => (
                <div
                  key={n.id}
                  className={`s3d-node ${selectedIds.includes(n.id) ? "is-selected" : ""} ${
                    n.hidden ? "is-hidden" : ""
                  } ${overId === n.id && dragId && dragId !== n.id ? "is-drop-target" : ""}`}
                  style={{ paddingLeft: 6 + depth * 13 }}
                  draggable
                  onDragStart={(e) => {
                    setDragId(n.id);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", n.id);
                  }}
                  onDragEnd={() => {
                    setDragId(null);
                    setOverId(null);
                  }}
                  onDragOver={(e) => {
                    if (!dragId || dragId === n.id) return;
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = "move";
                    if (overId !== n.id) setOverId(n.id);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (dragId) reparent(dragId, n.id);
                    setDragId(null);
                    setOverId(null);
                  }}
                  onClick={(e) => clickNode(n, e)}
                  title={`${n.id} · ${n.geometry.type} · 拖到其它节点上换父级，拖到空白处回根级`}
                >
                  <button
                    className="s3d-icon-btn"
                    title={n.hidden ? "显示（含子树）" : "临时隐藏（含子树，数据保留，不会进成片差异）"}
                    onClick={(e) => {
                      e.stopPropagation();
                      patchNode(n.id, { hidden: !n.hidden });
                    }}
                  >
                    {n.hidden ? <EyeOffIcon /> : <EyeOnIcon />}
                  </button>
                  <span className="s3d-node-name">{n.label ?? n.id}</span>
                  <span className="s3d-node-geo">{n.geometry.type}</span>
                  <button
                    className={`s3d-icon-btn ${n.locked ? "is-on" : ""}`}
                    title={n.locked ? "解锁" : "锁定（防误拖误删）"}
                    onClick={(e) => {
                      e.stopPropagation();
                      patchNode(n.id, { locked: !n.locked });
                    }}
                  >
                    <LockIcon />
                  </button>
                </div>
              ))}
              {!tree.length ? <p className="empty">场景图里还没有节点</p> : null}
            </div>

            {selectedIds.length > 1 ? (
              <div className="s3d-batch">
                <span>已选 {selectedIds.length} 个（主：{node?.label ?? selectedId}）</span>
                <button className="mini" onClick={() => batchPatch({ hidden: true })}>
                  隐藏
                </button>
                <button className="mini" onClick={() => batchPatch({ hidden: false })}>
                  显示
                </button>
                <button className="mini" onClick={() => batchPatch({ locked: true })}>
                  锁定
                </button>
                <button className="mini" onClick={() => batchPatch({ locked: false })}>
                  解锁
                </button>
                <button className="mini" onClick={deleteSelected}>
                  删除
                </button>
                <button className="mini" onClick={() => setSelection([])}>
                  取消
                </button>
              </div>
            ) : null}

            <div className="field">
              <label>
                加节点
                <span className="num">{graph.nodes.length}/48</span>
              </label>
              <select value="" onChange={(e) => e.target.value && addNode(e.target.value)}>
                <option value="">选择形状…</option>
                {GEOMETRY_VARIANTS.map((v) => (
                  <option key={v.label} value={v.label}>
                    {v.label}
                  </option>
                ))}
              </select>
              <p className="s3d-hint">
                画行星轨道用 <code>dashRing</code>（扁平虚线，挂在带倾角的枢轴下自动同倾角）；<code>torus</code> 是甜甜圈。
              </p>
            </div>

            {node ? (
              <>
                <div className="divider" />
                <div className="field">
                  <label>
                    显示名
                    <button
                      className="mini s3d-inline-btn"
                      onClick={() => duplicateNode(node)}
                      title="复制这个节点（连子树一起），往 X 偏移一点避免重叠"
                    >
                      复制节点
                    </button>
                    <button
                      className="mini s3d-inline-btn"
                      onClick={() => removeNode(node)}
                      title="删除这个节点（连子节点一起）"
                    >
                      删除节点
                    </button>
                  </label>
                  <input
                    key={`${node.id}-label`}
                    defaultValue={node.label ?? ""}
                    placeholder={node.id}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v === (node.label ?? "")) return;
                      patchNode(node.id, { label: v || null });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                    }}
                  />
                  <p className="s3d-hint">
                    id <code>{node.id}</code>（agent 用这个 id 改它，改 id 会断开关键帧与相机的跟随）
                  </p>
                </div>

                <div className="field">
                  <label>父级</label>
                  <select
                    value={node.parent ?? ""}
                    onChange={(e) => patchNode(node.id, { parent: e.target.value || null })}
                  >
                    <option value="">（根级，无父级）</option>
                    {graph.nodes
                      .filter((n) => n.id !== node.id)
                      .map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.label ?? n.id}
                        </option>
                      ))}
                  </select>
                  <p className="s3d-hint">
                    挂到某个节点下 = 跟着它公转/自转。换父级会**保持世界位置**，画面不跳。
                  </p>
                </div>

                {/* ── 变换 ── */}
                <div className="section-title">变换</div>
                <XYZ
                  label="位置"
                  value={pos}
                  onChange={(next) => writeTr({ position: next })}
                />
                <XYZ
                  label="旋转"
                  value={rot}
                  step={1}
                  title="角度（度）"
                  onChange={(next) => writeTr({ rotation: next })}
                />
                <div className="s3d-row">
                  <span>缩放</span>
                  {scaleXYZ ? (
                    [0, 1, 2].map((i) => (
                      <NumInput
                        key={i}
                        value={Number(scaleXYZ[i] ?? 1)}
                        step={0.05}
                        onCommit={(v) => {
                          const next = [...scaleXYZ];
                          next[i] = v;
                          patchNode(node.id, { transform: { scaleXYZ: next } });
                        }}
                      />
                    ))
                  ) : (
                    <>
                      <NumInput
                        value={uniform}
                        step={0.05}
                        onCommit={(v) => writeTr({ scale: v })}
                      />
                      <button
                        className="mini"
                        title="拆成三轴分别缩放（做椭圆光斑、压扁的行星环）"
                        onClick={() =>
                          patchNode(node.id, { transform: { scaleXYZ: [uniform, uniform, uniform] } })
                        }
                      >
                        分轴
                      </button>
                    </>
                  )}
                </div>
                {scaleXYZ ? (
                  <button
                    className="mini"
                    onClick={() => patchNode(node.id, { transform: { scaleXYZ: null } })}
                    title="恢复整体缩放"
                  >
                    恢复整体缩放
                  </button>
                ) : null}

                {/* ── 关键帧（M4）：把"这一帧的样子"钉住 ── */}
                <div className="divider" />
                <KeyList
                  rows={nodeKeys.map((k) => ({
                    frame: k.frame,
                    text: nodeKeySummary(k),
                    ease: k.ease,
                  }))}
                  cur={curFrame}
                  cap={NODE_KEY_MAX}
                  onAdd={addNodeKey}
                  onSeek={seekTo}
                  onRemove={removeNodeKey}
                  onCycleEase={cycleNodeEase}
                  onClear={clearNodeKeys}
                  onShift={shiftNodeKeys}
                  onStretch={stretchNodeKeys}
                  emptyHint="还没有关键帧：停到某一帧、把节点摆好，点「打关键帧」；再换个帧打第二颗，中间就动起来了。"
                  extraHint={
                    nodeKeys.length >= 2
                      ? "相邻两颗之间就是一段动画：区间内的基础变换不再生效（改了看不到变化就是这个原因）。"
                      : undefined
                  }
                />
                {nodeKeys.length >= 2 ? (
                  <>
                    <div className="s3d-row" data-scope="node" data-kind="point">
                      <span title="只改当前这一帧两侧的线">此点</span>
                      <button
                        className="mini"
                        onClick={smoothNodeAtPoint}
                        disabled={!isNodeKeyFrame}
                        title="只把当前这一帧两侧的线调成相切（其它关键帧的曲线不动）"
                      >
                        平滑
                      </button>
                      <button
                        className="mini"
                        onClick={straightNodeAtPoint}
                        disabled={!isNodeKeyFrame}
                        title="只把当前这一帧两侧拉直（其它关键帧的曲线不动）"
                      >
                        拉直
                      </button>
                    </div>
                    <div className="s3d-row" data-scope="node" data-kind="all">
                      <span title="改整条轨迹的所有段">整条</span>
                      <button className="mini" onClick={smoothNodePath} title="所有关键帧一起算相切（会重算整条轨迹）">
                        平滑
                      </button>
                      <button className="mini" onClick={straightNodePath} title="所有段恢复直线（删掉所有曲线）">
                        拉直
                      </button>
                    </div>
                    <p className="s3d-hint">
                      想精细调：在视口里点轨迹上的关键帧球，会出现贝塞尔手柄，直接拖；两侧默认相切联动（拖一个另一个跟着转），按住 <b>Shift</b> 只动这一侧；双击手柄拉直那一侧。
                    </p>
                  </>
                ) : null}

                {/* ── 几何体 ── */}
                <div className="divider" />
                <div className="section-title">几何体</div>
                <div className="field">
                  <label>形状</label>
                  <select
                    value={node.geometry.type}
                    onChange={(e) => patchNode(node.id, { geometry: { type: e.target.value } })}
                  >
                    {GEOMETRY_VARIANTS.map((v) => (
                      <option key={v.label} value={v.label}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                  <p className="s3d-hint">换形状会重置该形状的参数（旧形状的半径对新形状没意义）</p>
                </div>
                <div className="ff-grid">
                  {geometryFieldsOf(node.geometry.type).map((f) => (
                    <label className="ff-num" key={f.key} title={f.label}>
                      {f.key}
                      <NumInput
                        value={Number(geo?.[f.key] ?? f.default ?? 0)}
                        step={f.numInt ? 1 : f.key === "duty" ? 0.05 : 0.1}
                        min={f.numMin}
                        max={f.numMax}
                        onCommit={(v) => patchNode(node.id, { geometry: { [f.key]: v } })}
                      />
                    </label>
                  ))}
                </div>

                {/* ── 材质 ── */}
                <div className="divider" />
                <div className="section-title">材质</div>
                <div className="field">
                  <label>类型</label>
                  <div className="seg">
                    {[
                      ["standard", "金属/塑料"],
                      ["physical", "玻璃"],
                      ["basic", "不受光"],
                    ].map(([v, label]) => (
                      <button
                        key={v}
                        className={`seg-item ${matType === v ? "is-on" : ""}`}
                        onClick={() => patchNode(node.id, { material: { type: v } })}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <ColorField
                  label="颜色"
                  value={String(mat.color ?? "accent")}
                  onCommit={(v) => patchNode(node.id, { material: { color: v } })}
                />
                <ColorField
                  label="自发光"
                  value={String(mat.emissive ?? "")}
                  onCommit={(v) => patchNode(node.id, { material: { emissive: v } })}
                  onClear={() => patchNode(node.id, { material: { emissive: null } })}
                />
                {mat.emissive ? (
                  <div className="s3d-row">
                    <span>发光强度</span>
                    <NumInput
                      value={Number(mat.emissiveIntensity ?? 1)}
                      step={0.1}
                      onCommit={(v) => patchNode(node.id, { material: { emissiveIntensity: v } })}
                    />
                  </div>
                ) : null}

                <div className="s3d-row">
                  <span>透明度</span>
                  <NumInput
                    value={Number(mat.opacity ?? 1)}
                    step={0.05}
                    min={0}
                    max={1}
                    onCommit={(v) => patchNode(node.id, { material: { opacity: v } })}
                  />
                </div>

                {matType !== "basic" ? (
                  <>
                    <div className="s3d-row">
                      <span>金属度</span>
                      <NumInput
                        value={Number(mat.metalness ?? 0.4)}
                        step={0.05}
                        min={0}
                        max={1}
                        onCommit={(v) => patchNode(node.id, { material: { metalness: v } })}
                      />
                    </div>
                    <div className="s3d-row">
                      <span>粗糙度</span>
                      <NumInput
                        value={Number(mat.roughness ?? 0.35)}
                        step={0.05}
                        min={0}
                        max={1}
                        onCommit={(v) => patchNode(node.id, { material: { roughness: v } })}
                      />
                    </div>
                  </>
                ) : null}
                {matType === "physical" ? (
                  <>
                    <div className="s3d-row">
                      <span>透射</span>
                      <NumInput
                        value={Number(mat.transmission ?? 0.9)}
                        step={0.05}
                        min={0}
                        max={1}
                        onCommit={(v) => patchNode(node.id, { material: { transmission: v } })}
                      />
                    </div>
                    <div className="s3d-row">
                      <span>折射率</span>
                      <NumInput
                        value={Number(mat.ior ?? 1.5)}
                        step={0.05}
                        min={1}
                        max={2.5}
                        onCommit={(v) => patchNode(node.id, { material: { ior: v } })}
                      />
                    </div>
                  </>
                ) : null}
                {matType === "basic" ? (
                  <div className="field row">
                    <label>线框</label>
                    <button
                      className={`switch ${mat.wireframe ? "is-on" : ""}`}
                      onClick={() => patchNode(node.id, { material: { wireframe: !mat.wireframe } })}
                    >
                      <span />
                    </button>
                  </div>
                ) : null}
                {matType !== "basic" ? (
                  <div className="field row">
                    <label title="平面/圆盘只朝 +Z：转成朝下会整片消失，地面光斑必须开双面">
                      双面可见
                    </label>
                    <button
                      className={`switch ${mat.side === "double" ? "is-on" : ""}`}
                      onClick={() =>
                        patchNode(node.id, { material: { side: mat.side === "double" ? "front" : "double" } })
                      }
                    >
                      <span />
                    </button>
                  </div>
                ) : null}
                {(["sphere", "cylinder", "cone", "torus", "icosahedron"] as string[]).includes(
                  node.geometry.type,
                ) ? (
                  <div className="field row">
                    <label title="棱角分明：低多边形风格靠它">平面着色</label>
                    <button
                      className={`switch ${mat.flatShading ? "is-on" : ""}`}
                      onClick={() => patchNode(node.id, { material: { flatShading: !mat.flatShading } })}
                    >
                      <span />
                    </button>
                  </div>
                ) : null}

                {(() => {
                  const map = mat.map as { src?: string } | undefined;
                  const poly = ["icosahedron", "dodecahedron", "octahedron"].includes(node.geometry.type);
                  if (poly) {
                    return (
                      <p className="s3d-hint">
                        {node.geometry.type} 的 UV 是球面投影碎面，**不能贴图**；要低多边形风格用 sphere +
                        平面着色 + 低 segments。
                      </p>
                    );
                  }
                  return (
                    <div className="field">
                      <label>
                        贴图
                        {map?.src ? (
                          <button
                            className="mini s3d-inline-btn"
                            onClick={() => patchNode(node.id, { material: { map: null } })}
                          >
                            去掉
                          </button>
                        ) : null}
                      </label>
                      <input
                        key={`${node.id}-map`}
                        defaultValue={map?.src ?? ""}
                        placeholder="/assets/xxx.jpg 或 https://…"
                        onBlur={(e) => {
                          const src = e.target.value.trim();
                          if (src === (map?.src ?? "")) return;
                          patchNode(node.id, { material: { map: src ? { src } : null } });
                        }}
                      />
                      <p className="s3d-hint">
                        贴图会顶掉颜色（按白底 × 贴图算）。PNG 自带透明可做镂空；素材先 upload_asset。
                      </p>
                    </div>
                  );
                })()}
              </>
            ) : (
              <p className="empty">上面点一个节点开始编辑</p>
            )}
          </>
        ) : null}

        {tab === "camera" ? (
          <>
            <div className="section-title">编辑相机（成片的取景）</div>
            <XYZ label="位置" value={camNow.pos} onChange={(next) => writeCam({ position: next })} />
            <XYZ label="看向" value={camNow.target} onChange={(next) => writeCam({ target: next })} />
            <div className="s3d-row">
              <span>视场角</span>
              <NumInput value={camNow.fov} step={1} onCommit={(v) => writeCam({ fov: v })} />
            </div>
            <div className="s3d-row">
              <span>环绕</span>
              <NumInput
                value={graph.camera?.orbit?.degPerSec ?? 0}
                step={1}
                title="度/秒；0 = 静止。只转相机，不动物体"
                onCommit={(v) =>
                  write([
                    {
                      op: "set_graph_camera",
                      sceneId: scene.id,
                      camera: { orbit: v ? { degPerSec: v } : null },
                    } as Op,
                  ])
                }
              />
            </div>
            <div className="divider" />
            <div className="section-title">看向锁定</div>
            <p className="s3d-hint">
              锁定后这一段镜头每帧重新对准目标：摄像机怎么飞都对着它。退出后镜头从当时的锁定点继续飞，不会甩。
            </p>
            <div className="s3d-row">
              <span>目标</span>
              <select
                value={camLockSelect}
                onChange={(e) => setCamLockPick(e.target.value)}
                disabled={!graph.nodes.length}
                style={{ flex: 1, minWidth: 0 }}
              >
                {graph.nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.label ?? n.id}
                  </option>
                ))}
              </select>
            </div>
            {camLockNow ? (
              <div className="s3d-warn">
                当前帧（f{curFrame}）正锁定「{labelOf(camLockNow.id)}」
                {camLockNow.end > camLockNow.start ? `，本段 f${camLockNow.start}–f${camLockNow.end}` : ""}
                。旋转手柄已禁用，移动/推拉照常。
              </div>
            ) : null}
            <div style={{ display: "flex", gap: 6 }}>
              <button
                className="mini add"
                onClick={() => applyCamLookAt(camLockSelect || null)}
                disabled={!camLockSelect}
              >
                {camLockNow ? "改锁到目标" : `从 f${curFrame} 锁定`}
              </button>
              <button className="mini" onClick={() => applyCamLookAt(null)} disabled={!camLockNow}>
                退出锁定
              </button>
            </div>
            {camLockSpans.length ? (
              <>
                <p className="s3d-hint">锁定区间（× 解除，画面不跳）</p>
                {camLockSpans.map((s) => (
                  <div className="s3d-row" key={`${s.start}-${s.id}`}>
                    <span>
                      f{s.start}–{s.openEnded ? "片尾" : s.end} · {labelOf(s.id)}
                    </span>
                    <button className="mini" onClick={() => seekTo(s.start)} title="跳到这段的起点">
                      跳
                    </button>
                    <button
                      className="mini"
                      onClick={() => applyCamLookAt(null, s.start)}
                      title="解除这段锁定：目标点保持当时的锁定位置，画面不跳"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </>
            ) : null}
            <div className="divider" />
            {camFollowLocked ? (
              <div className="s3d-warn">
                这段运镜用了 <code>follow</code>（把相机钉在某个节点上跟随）。图形化编辑会把
                "相对节点的偏移"重新解释成世界坐标，镜头会跟着行星跑偏，所以这里保持只读。
                要改跟随镜头，让 agent 改 <code>graph.camera.anim[].follow</code>。
              </div>
            ) : (
              <KeyList
                rows={camKeys.map((k) => ({ frame: k.frame, text: camKeySummary(k), ease: k.ease }))}
                cur={curFrame}
                // 相机段上限 240，实际上限远大于人手工能管理的量，这里只做提示
                cap={240}
                onAdd={addCamKey}
                onSeek={seekTo}
                onRemove={(f) => commitCamKeys(camKeys.filter((k) => k.frame !== f))}
                onCycleEase={cycleCamEase}
                onClear={clearCamKeys}
                onShift={(d) => commitCamKeys(shiftKeys(camKeys, d))}
                onStretch={(k) => commitCamKeys(stretchKeys(camKeys, k))}
                emptyHint="还没有运镜：停到某一帧、把相机拖到位，点「打关键帧」；再跳到后面的帧换个机位再打一颗，中间就会飞过去。"
                extraHint={
                  camKeys.length >= 2
                    ? "运镜区间内上面这几项（位置/看向）是基准值，会被关键帧覆盖。视口里画出了这条运镜轨迹。"
                    : undefined
                }
              />
            )}
            {camKeys.length >= 2 ? (
              <>
                <div className="s3d-row" data-scope="cam" data-kind="point">
                  <span title="只改当前这一帧两侧的机位">此点</span>
                  <button
                    className="mini"
                    onClick={smoothCamAtPoint}
                    disabled={!isCamKeyFrame || camFollowLocked}
                    title="只把当前这一帧两侧的运镜调成相切（其它机位点不动）"
                  >
                    平滑
                  </button>
                  <button
                    className="mini"
                    onClick={straightCamAtPoint}
                    disabled={!isCamKeyFrame}
                    title="只把当前这一帧两侧拉直（其它机位点不动）"
                  >
                    拉直
                  </button>
                </div>
                <div className="s3d-row" data-scope="cam" data-kind="all">
                  <span title="改整条运镜的所有段">整条</span>
                  <button className="mini" onClick={smoothCamPath} disabled={camFollowLocked} title="所有机位点一起算相切（会重算整条运镜）">
                    平滑
                  </button>
                  <button className="mini" onClick={straightCamPath} title="所有段恢复直线">
                    拉直
                  </button>
                </div>
                <p className="s3d-hint">
                  精细调整：在视口里点运镜轨迹上的关键帧球，会出现贝塞尔手柄，直接拖；两侧默认相切联动，按住 <b>Shift</b> 只动这一侧；双击手柄拉直那一侧。
                </p>
              </>
            ) : null}
            <div className="divider" />
            <button
              className="mini"
              onClick={() => write([{ op: "set_graph_camera", sceneId: scene.id, camera: null } as Op])}
              title="按内容自动取一个能装下的距离"
            >
              重置为自动取景
            </button>
          </>
        ) : null}

        {tab === "lights" ? (
          <>
            <div className="section-title">光源</div>
            <p className="s3d-hint">
              不给自定义光源时，这一幕由 look 的四盏固定方向光照亮——所以「地球的明暗面」永远不对着太阳。
              要真实昼夜面，就在这里放一盏点光在太阳的位置。
            </p>
            {(graph.lights ?? []).map((l, i) => {
              const setLight = (patchL: Record<string, unknown>) => {
                const next = (graph.lights ?? []).map((x, j) => (j === i ? { ...x, ...patchL } : x));
                write([{ op: "set_graph_lights", sceneId: scene.id, lights: next } as Op]);
              };
              return (
                <div className="ff-card" key={i} style={{ cursor: "default" }}>
                  <div className="s3d-light-head">
                    <select value={l.type} onChange={(e) => setLight({ type: e.target.value })}>
                      {["point", "directional", "spot", "ambient"].map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                    <button
                      className="mini"
                      onClick={() =>
                        write([
                          {
                            op: "set_graph_lights",
                            sceneId: scene.id,
                            lights: (graph.lights ?? []).filter((_, j) => j !== i),
                          } as Op,
                        ])
                      }
                    >
                      ×
                    </button>
                  </div>
                  <ColorField
                    label="光色"
                    value={String(l.color ?? "text")}
                    onCommit={(v) => setLight({ color: v })}
                  />
                  <div className="s3d-row">
                    <span>强度</span>
                    <NumInput
                      value={l.intensity}
                      step={0.5}
                      title="point/spot 按 1/距离² 衰减：距离 2 时要 15–25 才亮；directional 1–3 就够"
                      onCommit={(v) => setLight({ intensity: v })}
                    />
                  </div>
                  {l.type !== "ambient" ? (
                    <XYZ label="位置" value={l.position} onChange={(next) => setLight({ position: next })} />
                  ) : null}
                  {l.type === "directional" || l.type === "spot" ? (
                    <XYZ label="照向" value={l.target} onChange={(next) => setLight({ target: next })} />
                  ) : null}
                  {l.type === "spot" ? (
                    <>
                      <div className="s3d-row">
                        <span>光锥</span>
                        <NumInput value={l.angle} step={1} onCommit={(v) => setLight({ angle: v })} />
                      </div>
                      <div className="s3d-row">
                        <span>软边</span>
                        <NumInput value={l.penumbra} step={0.05} onCommit={(v) => setLight({ penumbra: v })} />
                      </div>
                    </>
                  ) : null}
                  {l.type !== "ambient" && l.type !== "directional" ? (
                    <div className="s3d-row">
                      <span>衰减</span>
                      <NumInput
                        value={l.decay ?? 2}
                        step={1}
                        title="2 = 物理正确；调不好亮度时先试 0（无距离衰减）"
                        onCommit={(v) => setLight({ decay: v })}
                      />
                    </div>
                  ) : null}
                </div>
              );
            })}
            <div style={{ display: "flex", gap: 6 }}>
              <button
                className="mini add"
                onClick={() =>
                  write([
                    {
                      op: "set_graph_lights",
                      sceneId: scene.id,
                      lights: [...(graph.lights ?? []), { type: "point", intensity: 18, position: [0, 0, 0] }],
                    } as Op,
                  ])
                }
              >
                ＋ 点光（原点）
              </button>
              <button
                className="mini add"
                onClick={() =>
                  write([
                    {
                      op: "set_graph_lights",
                      sceneId: scene.id,
                      lights: [...(graph.lights ?? []), { type: "ambient", intensity: 0.3 }],
                    } as Op,
                  ])
                }
              >
                ＋ 环境光
              </button>
              {graph.lights?.length ? (
                <button
                  className="mini"
                  onClick={() => write([{ op: "set_graph_lights", sceneId: scene.id, lights: null } as Op])}
                  title="撤掉自定义光，回到预设打光"
                >
                  全部撤掉
                </button>
              ) : null}
            </div>
          </>
        ) : null}

        {tab === "atmo" ? (
          <>
            <div className="section-title">粒子（星空 / 尘埃）</div>
            {graph.particles ? (
              <>
                <div className="s3d-row">
                  <span>数量</span>
                  <NumInput
                    value={graph.particles.count}
                    step={50}
                    onCommit={(v) =>
                      write([{ op: "set_graph_particles", sceneId: scene.id, particles: { count: v } } as Op])
                    }
                  />
                </div>
                <XYZ
                  label="范围"
                  value={graph.particles.spread}
                  onChange={(next) =>
                    write([
                      { op: "set_graph_particles", sceneId: scene.id, particles: { spread: next } } as Op,
                    ])
                  }
                />
                <div className="s3d-row">
                  <span>大小</span>
                  <NumInput
                    value={graph.particles.size}
                    step={0.01}
                    onCommit={(v) =>
                      write([{ op: "set_graph_particles", sceneId: scene.id, particles: { size: v } } as Op])
                    }
                  />
                </div>
                <div className="s3d-row">
                  <span>漂移</span>
                  <NumInput
                    value={graph.particles.drift}
                    step={0.1}
                    title="0 = 完全静止"
                    onCommit={(v) =>
                      write([{ op: "set_graph_particles", sceneId: scene.id, particles: { drift: v } } as Op])
                    }
                  />
                </div>
                <ColorField
                  label="颜色"
                  value={String(graph.particles.color)}
                  onCommit={(v) =>
                    write([{ op: "set_graph_particles", sceneId: scene.id, particles: { color: v } } as Op])
                  }
                />
                <button
                  className="mini"
                  onClick={() => write([{ op: "set_graph_particles", sceneId: scene.id, particles: null } as Op])}
                >
                  关掉粒子
                </button>
              </>
            ) : (
              <button
                className="mini add"
                onClick={() =>
                  write([
                    {
                      op: "set_graph_particles",
                      sceneId: scene.id,
                      particles: { count: 800, spread: [8, 5, 8], size: 0.05 },
                    } as Op,
                  ])
                }
              >
                ＋ 加一层星尘
              </button>
            )}

            <div className="divider" />
            <div className="section-title">辉光</div>
            <div className="s3d-row">
              <span>强度</span>
              <NumInput
                value={graph.post?.bloom ?? 1}
                step={0.1}
                title="1 = 当前 look 的默认值；0 = 关掉"
                onCommit={(v) =>
                  write([{ op: "set_graph_post", sceneId: scene.id, post: { bloom: v } } as Op])
                }
              />
            </div>
            <p className="s3d-hint">
              辉光只吃够亮的部分：自发光（材质 → 自发光）才真的会发光，普通颜色只会被提亮一点。
            </p>
            {graph.post ? (
              <button
                className="mini"
                onClick={() => write([{ op: "set_graph_post", sceneId: scene.id, post: null } as Op])}
              >
                回到默认
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </aside>
  );
};

/* ────────────────────────── 预置 → 场景图 ────────────────────────── */

/**
 * 预置场景（没有 graph）的入口：把这一幕换成可逐节点编辑的场景图。
 *
 * 这里不假装能把预设完美转换：预设是几套写死的构图，转出来的图必然长得不一样，
 * 所以按钮文案直接说清"会替换掉预设画面"，而不是让人点了才发现画面变了。
 */
export const Scene3DSeed: React.FC<{ scene: Scene }> = ({ scene }) => {
  const apply = useDoc((s) => s.apply);
  return (
    <div className="s3d-seed">
      <div className="s3d-seed-title">这一幕用的是预置场景</div>
      <p className="s3d-hint" style={{ margin: "4px 0 8px" }}>
        预置画面由代码写死，改不了单个物体。换成场景图之后可以在右栏逐个节点改形状、颜色、位置、光照——
        换完画面会和现在的预置不一样（不是转换，是新建一张图）。
      </p>
      <button
        className="mini add"
        onClick={() =>
          void apply([
            { op: "update_scene", sceneId: scene.id, patch: { props: { graph: SCENE3D_SEED } } } as Op,
          ])
        }
      >
        换成可编辑场景图（球 + 点光 + 星尘）
      </button>
    </div>
  );
};
