import React, { useEffect, useMemo, useRef, useState } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import { Video } from "../../src/Video";
import { totalDuration, sceneOffsets, sceneSpans, type OverlayElement, type Transform } from "@shared/schema";
import { normalizeSceneBox, type SceneBox } from "@shared/sceneBox";
import type { Op } from "@shared/ops";
import { useDoc } from "../store";
import { setLocalPref } from "../uiPrefs";
import { getMeta } from "@shared/sceneMetas";
import { elementFromLibrary } from "@shared/elementLibrary";
import {
  assetIdOf,
  assetToElement,
  isAssetLibraryId,
  type CustomAsset,
} from "@shared/assetLibrary";
import { EditOverlay, type Box } from "./EditOverlay";
import { SceneBoxOverlay } from "./SceneBoxOverlay";
import { editRegistry } from "../../src/scenes/ui";
import { framesForAsset } from "../assetDuration";
import {
  freeElementLabel,
  isBackdropElement,
  reorderFreeElements,
  transformFreeElement,
  type FreeEl,
  type FreeformProps,
} from "@shared/freeform";

type Props = {
  playerRef: React.RefObject<PlayerRef | null>;
};

const ZOOM_MIN = 0.2;
const ZOOM_MAX = 5;

const IDENTITY: Transform = { x: 0, y: 0, rotate: 0, scale: 1, z: 0 };

/**
 * 两次变换是否等价（浮点容差）。
 * 用于「提交成功后只摘掉自己那一份草稿」：如果期间用户又拖了一次，
 * 草稿里的值已经变了，就不能按 id 无脑删除，否则会把新的拖动预览也抹掉。
 */
const sameTransform = (a: Transform | undefined, b: Transform | undefined) =>
  !!a &&
  !!b &&
  Math.abs(a.x - b.x) < 0.005 &&
  Math.abs(a.y - b.y) < 0.005 &&
  Math.abs(a.rotate - b.rotate) < 0.005 &&
  Math.abs(a.scale - b.scale) < 0.0005;

/** 自由画布的元素：x/y/rotate/scale 与 Transform 同语义，可以直接进同一套手势 */
const freeElsOf = (scene: { type?: string; props?: unknown } | undefined): FreeEl[] =>
  scene?.type === "freeform"
    ? (((scene.props as FreeformProps | undefined)?.elements ?? []) as FreeEl[])
    : [];

/** 对齐/分布的图标：一条基准线 + 若干块 */
const ALIGN_ICONS: Record<string, string[]> = {
  left: ["M2 2v12", "M4 4h9M4 9h6"],
  centerX: ["M8 2v12", "M3 4h10M4.5 9h7"],
  right: ["M14 2v12", "M3 4h9M6 9h6"],
  top: ["M2 2h12", "M4 4v9M9 4v6"],
  centerY: ["M2 8h12", "M4 3v10M9 4.5v7"],
  bottom: ["M2 14h12", "M4 3v9M9 6v6"],
  distributeX: ["M2 3v10M14 3v10", "M5 5v6M10 5v6"],
  distributeY: ["M3 2h10M3 14h10", "M5 5h6M5 10h6"],
  front: ["M2 2h12", "M8 12.5V5M4.5 8.5L8 5l3.5 3.5"],
  forward: ["M8 13V4M4.5 7.5L8 4l3.5 3.5"],
  backward: ["M8 3v9M4.5 8.5L8 12l3.5-3.5"],
  back: ["M2 14h12", "M8 3.5V11M4.5 7.5L8 11l3.5-3.5"],
  trash: ["M3.5 6h13", "M6.5 6l.8 10.5h5.4L13.5 6", "M6 6V3.8h6V6"],
  duplicate: ["M4.5 2.5h6.5v6.5", "M6.5 11v-3h-4v6h6v-3", "M11 2.5h4.5v9H11"],
};

const IconBtn: React.FC<{
  paths: string[];
  label: string;
  onClick: () => void;
  accent?: boolean;
  disabled?: boolean;
}> = ({ paths, label, onClick, accent, disabled }) => (
  <button
    className={`arrange-btn ${accent ? "is-accent" : ""}`}
    title={disabled ? `${label}（先选中元素）` : label}
    aria-label={label}
    disabled={disabled}
    onClick={onClick}
  >
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round">
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  </button>
);

/**
 * 预览画布。
 *
 * 两层坐标要分清：
 *  - 外层 stage：视口，负责缩放/平移，不改画面本身
 *  - 内层 canvas：画布逻辑尺寸（fmt.width × fmt.height），编辑层的坐标系以它为准
 * 缩放用 CSS transform 实现，浏览器会正确映射指针坐标，所以控件点击不会错位。
 */
export const Preview: React.FC<Props> = ({ playerRef }) => {
  const project = useDoc((s) => s.project);
  const formatKey = useDoc((s) => s.formatKey);
  const selectedId = useDoc((s) => s.selectedId);
  const apply = useDoc((s) => s.apply);
  const [inlineEdit, setInlineEdit] = useState<{
    /** prop：模板元素的某个字符串字段；free：自由画布元素（elements 里的一项）的文案 */
    kind: "prop" | "free";
    sceneId: string;
    prop: string;
    index: number;
    original: string;
    text: string;
    rect: { left: number; top: number; width: number; height: number };
  } | null>(null);
  const assets = useDoc((s) => s.assets);
  const selectScene = useDoc((s) => s.select);
  const notify = useDoc((s) => s.notify);

  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  /* 自由画布元素的拖动已由 EditOverlay 统一接管（元素登记为 `sceneId::fc:<序号>`），
     这里原来那条"元素自己 onMouseDown → 全局回调 → 每 80ms 写一次盘"的通道已经删掉：
     它会把元素中心瞬移到指针、一次拖动产生几十步撤销，还挡掉了框选和平移。 */

  const [box, setBox] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  /** 拖动中的临时变换：实时预览，松手才落库。一次可带多个元素（多选整体缩放） */
  const [draft, setDraft] = useState<{ sceneId: string; map: Record<string, Transform> } | null>(null);
  /** 画中画框拖动中的草稿：只改预览，松手才发一条 set_scene_box */
  const [boxDraft, setBoxDraft] = useState<{ sceneId: string; box: Partial<SceneBox> } | null>(null);
  /** 已选中的元素放在全局 store，右侧属性面板也要读它 */
  const selection = useDoc((s) => s.selection);
  const setSelection = useDoc((s) => s.setSelection);
  const [playing, setPlaying] = useState(false);
  /** 淡色轮廓开关：关掉就是干净画面 */
  const [showOutlines, setShowOutlines] = useState(() => {
    try {
      return localStorage.getItem("rms:outlines") !== "0";
    } catch {
      return true;
    }
  });
  /** 安全区辅助线：常显开关，默认关；拖动时无论如何都会出现 */
  const [showSafe, setShowSafe] = useState(() => {
    try {
      return localStorage.getItem("rms:safe") === "1";
    } catch {
      return false;
    }
  });

  // 滚轮监听是原生的，读不到最新 state，只能靠 ref
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const boxesRef = useRef<Box[]>([]);

  zoomRef.current = zoom;
  panRef.current = pan;

  // 选中场景后跳到该场景动画中段，避免停在第 0 帧看到一片黑
  useEffect(() => {
    if (!project || !selectedId) return;
    const idx = project.scenes.findIndex((s) => s.id === selectedId);
    if (idx < 0) return;
    const offsets = sceneOffsets(project.scenes);
    const scene = project.scenes[idx];
    const target = offsets[idx] + Math.min(Math.round(scene.durationInFrames * 0.5), 40);
    const timer = setTimeout(() => playerRef.current?.seekTo(target), 60);
    return () => clearTimeout(timer);
  }, [selectedId, project?.id, playerRef]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  /**
   * 滚轮缩放，**以鼠标位置为锚点**。
   *
   * 画布由 grid 居中，所以它的中心 = stage 中心，translate 不受缩放影响：
   *   screen = stageCenter + pan + zoom * localPoint
   * 要让鼠标下的那个点不动，解出新的 pan 即可。
   */
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;

      const z0 = zoomRef.current;
      const p0 = panRef.current;
      const factor = Math.exp(-e.deltaY * 0.0016);
      const z1 = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z0 * factor));
      if (Math.abs(z1 - z0) < 1e-4) return;

      // 鼠标位置对应的画布本地坐标
      const lx = (e.clientX - cx - p0.x) / z0;
      const ly = (e.clientY - cy - p0.y) / z0;
      const nx = e.clientX - cx - z1 * lx;
      const ny = e.clientY - cy - z1 * ly;

      zoomRef.current = z1;
      panRef.current = { x: nx, y: ny };
      setZoom(z1);
      setPan({ x: nx, y: ny });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // 平移：中键 / Alt+左键 / 空白处左键直接拖（画布上或画布外的灰底都行）
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let drag: { x: number; y: number; px: number; py: number } | null = null;

    /**
     * 空白处：不是元素盒/手柄，也不是按钮、输入、滑块这类交互控件。
     *
     * 注意 Remotion 的播放控制条不是 `.__remotion-player` 的子节点，而是它的**兄弟**
     * （同一个 Fragment 里平级渲染），所以不能靠 `.__remotion-player` 定位。
     * 改成结构性判断：在 `.canvas-shell` 内、既不在视频层也不在编辑层的元素，都不是空白画布。
     */
    const isBlank = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return false;
      if (target.closest(".edit-box, .edit-handle, .edit-group, [data-group-box], .edit-warn")) return false;
      if (target.closest("button, input, select, textarea, [role='button'], [role='slider'], [contenteditable]")) return false;
      const canvas = target.closest(".canvas-shell");
      if (canvas && !target.closest(".__remotion-player") && !target.closest(".edit-layer")) return false;
      return true;
    };

    const down = (e: PointerEvent) => {
      // Shift / Ctrl / Cmd 拖动留给框选（EditOverlay），这里只认空白拖、Alt+左键和中键
      const blankLeft = e.button === 0 && !e.shiftKey && !e.metaKey && !e.ctrlKey && isBlank(e.target);
      if (e.button !== 1 && !(e.button === 0 && e.altKey) && !blankLeft) return;
      e.preventDefault();
      const p = panRef.current;
      drag = { x: e.clientX, y: e.clientY, px: p.x, py: p.y };
      el.classList.add("is-panning");
    };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      const next = { x: drag.px + (e.clientX - drag.x), y: drag.py + (e.clientY - drag.y) };
      panRef.current = next;
      setPan(next);
    };
    const up = () => {
      drag = null;
      el.classList.remove("is-panning");
    };

    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, []);

  // 空格播放/暂停：**全局唯一入口**（App 里原来也挂了一份，两边各 toggle 一次互相抵消，
  // 表现为"怎么按都没反应，直到焦点落在播放按钮上"）。
  // 焦点在输入框里时让给输入，其余情况一律接管 —— 包括焦点停在按钮上时，
  // 否则刚点过「渲染视频 / 隐藏选框」再按空格会误触那个按钮。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || e.isComposing) return;
      const t = e.target;
      if (t instanceof Element && t.closest("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      playerRef.current?.toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playerRef]);

  // 播放状态：控制条上的按钮、空格、播放器自身都会改它，统一订阅事件
  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    p.addEventListener("play", onPlay);
    p.addEventListener("pause", onPause);
    return () => {
      p.removeEventListener("play", onPlay);
      p.removeEventListener("pause", onPause);
    };
  }, [playerRef, project?.id]);

  /**
   * 元素级快捷键。播放/暂停的空格在下面单独一个 effect 里（只能有一个监听点，
   * 两处都 toggle 会互相抵消，见设计方案 §6.2）。
   *
   * Delete 删元素 · Ctrl/Cmd+D 复制 · 方向键微调（Shift 加速）
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // e.target 可能是 window / document（程序化派发或焦点丢失时），不是 Element 就没有 closest
      const t = e.target;
      if (t instanceof Element && t.closest("input, textarea, select, [contenteditable='true']")) return;
      const sel = useDoc.getState().selection;
      // 可删除的只有场景内自由元素和自由画布元素；模板元素跟着版式走，删了画面就塌了
      const hasDeletable = sel.some((id) => id.startsWith("ov:") || id.startsWith("fc:"));

      if (e.key === "Delete" || e.key === "Backspace") {
        if (!hasDeletable) return;
        e.preventDefault();
        removeSelection();
        return;
      }
      // Ctrl/Cmd + D：复制（浏览器默认是"加书签"，这里必须拦掉）
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        if (!hasDeletable) return;
        e.preventDefault();
        duplicateSelection();
        return;
      }
      // Ctrl/Cmd + C：复制选中的自由元素到跨工程剪贴板
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
        const ids = sel.filter((id) => id.startsWith("ov:")).map((id) => id.slice(3));
        const els = scene?.elements?.filter((el) => ids.includes(el.id)) ?? [];
        if (!els.length) return;
        e.preventDefault();
        localStorage.setItem(
          "rms:clipboard",
          JSON.stringify(els.map(({ id, ...rest }) => rest)),
        );
        useDoc.getState().notify(`已复制 ${els.length} 个元素（可粘贴到其他工程）`);
        return;
      }
      // Ctrl/Cmd + V：把剪贴板里的元素粘贴到当前场景（跨工程可用）
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") {
        if (!scene) return;
        let items: OverlayElement[] = [];
        try {
          const raw = JSON.parse(localStorage.getItem("rms:clipboard") ?? "[]") as OverlayElement[];
          items = Array.isArray(raw) ? raw.filter((el) => el && el.kind) : [];
        } catch {
          items = [];
        }
        if (!items.length) return;
        e.preventDefault();
        void apply(
          items.map((el) => ({ op: "add_element" as const, sceneId: scene.id, element: el })),
        );
        useDoc.getState().notify(`已粘贴 ${items.length} 个元素`);
        return;
      }
      // Ctrl/Cmd + A：全选当前场景的所有可编辑元素（模板元素 + 自由元素）
      // 不拦掉的话浏览器会把整个页面文字选蓝，拖框就废了
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        const ids = boxesRef.current.map((b) => b.id);
        if (!ids.length) return;
        e.preventDefault();
        setSelection(ids);
        return;
      }
      const step = e.shiftKey ? 10 : 1;
      const nudge: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const delta = nudge[e.key];
      if (delta) {
        if (!sel.length) return;
        e.preventDefault();
        nudgeSelection(delta[0], delta[1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // 切换场景/画幅时复位视图，否则会莫名其妙停留在上一张的缩放位置
  useEffect(() => {
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setDraft(null);
  }, [formatKey, project?.id]);

  // 换场景就清空选择，避免操作作用到上一个场景的元素
  useEffect(() => {
    setSelection([]);
  }, [selectedId]);

  // 元素被删掉（自己删、agent 删）之后，把失效的 id 从选中集里摘掉
  useEffect(() => {
    const st = useDoc.getState();
    const scene = st.project?.scenes.find((x) => x.id === st.selectedId);
    const alive = new Set((scene?.elements ?? []).map((e) => `ov:${e.id}`));
    // 自由画布的元素按序号定位：删掉一个后面的序号会整体前移，
    // 所以只能判断"序号还在不在范围内"，不做更细的对应
    const freeCount = scene?.type === "freeform" ? freeElsOf(scene).length : 0;
    const cur = st.selection;
    const next = cur.filter((id) => {
      if (id.startsWith("ov:")) return alive.has(id);
      if (id.startsWith("fc:")) return Number(id.slice(3)) < freeCount;
      return true;
    });
    if (next.length !== cur.length) st.setSelection(next);
  }, [project?.rev, selectedId]);

  const toggleOutlines = () => {
    setShowOutlines((v) => {
      const next = !v;
      setLocalPref("rms:outlines", next ? "1" : "0");
      return next;
    });
  };

  const toggleSafe = () => {
    setShowSafe((v) => {
      const next = !v;
      setLocalPref("rms:safe", next ? "1" : "0");
      return next;
    });
  };

  const fmt = useMemo(
    () => project?.formats.find((f) => f.key === formatKey) ?? project?.formats[0],
    [project, formatKey],
  );

  const inputProps = useMemo(() => {
    if (!project) return null;
    // 模板元素改 scene.transforms，自由元素改当前场景的 elements，
    // 自由画布的元素改 scene.props.elements —— 三套位置存法，出口只有一个
    const scenes = draft
      ? project.scenes.map((s) => {
          if (s.id !== draft.sceneId) return s;
          const nextTransforms = { ...(s.transforms ?? {}) };
          let nextElements = s.elements;
          let nextProps: Record<string, unknown> = s.props as Record<string, unknown>;
          let freeEls: FreeEl[] | null = null;
          for (const [id, t] of Object.entries(draft.map)) {
            if (id.startsWith("fc:")) {
              const i = Number(id.slice(3));
              if (!freeEls) freeEls = [...freeElsOf(s)];
              const cur = freeEls[i];
              if (!cur) continue;
              freeEls[i] = transformFreeElement(cur, t);
            } else if (id.startsWith("ov:")) {
              const eid = id.slice(3);
              nextElements = (nextElements ?? []).map((el) =>
                el.id === eid ? { ...el, x: t.x, y: t.y, rotate: t.rotate, scale: t.scale } : el,
              );
            } else {
              nextTransforms[id] = { ...IDENTITY, ...(s.transforms?.[id] ?? {}), ...t };
            }
          }
          if (freeEls) nextProps = { ...nextProps, elements: freeEls };
          return {
            ...s,
            props: nextProps as typeof s.props,
            ...(Object.keys(nextTransforms).length ? { transforms: nextTransforms } : {}),
            ...(nextElements ? { elements: nextElements } : {}),
          };
        })
      : project.scenes;
    // 画中画框拖动中的草稿：只覆盖这一幕的 box，其余原样
    const withBox = boxDraft
      ? scenes.map((s) =>
          s.id === boxDraft.sceneId ? { ...s, box: normalizeSceneBox({ ...(s.box ?? {}), ...boxDraft.box }) } : s,
        )
      : scenes;
    return { ...project, scenes: withBox, formatKey: fmt?.key ?? "portrait" };
  }, [project, fmt, draft, boxDraft]);

  if (!project || !fmt || !inputProps) {
    return <div className="stage" ref={stageRef} />;
  }

  // 与 .stage 的 padding 对应：左右各 24，上下分别是 48 / 24
  const padX = 48;
  const padY = 72;
  const availW = Math.max(120, box.w - padX);
  const availH = Math.max(120, box.h - padY);
  const fit = Math.min(availW / fmt.width, availH / fmt.height);
  const width = Math.round(fmt.width * fit);
  const height = Math.round(fmt.height * fit);

  const scene = project.scenes.find((s) => s.id === selectedId);
  const activeTarget = selection.length === 1 ? selection[0] : null;
  const isOverlay = (id: string) => id.startsWith("ov:");
  const overlayOf = (id: string) => scene?.elements?.find((e) => e.id === id.slice(3));

  /* ── 自由画布：元素没有 id，用数组下标定位（`fc:<序号>`） ── */
  const freeEls = freeElsOf(scene);
  const isFree = (id: string) => id.startsWith("fc:");
  const freeIndexOf = (id: string) => Number(id.slice(3));
  const freeElOf = (id: string) => freeEls[freeIndexOf(id)];
  /** 可拖动/可删除的元素：场景内自由元素 + 自由画布元素 */
  const isEditable = (id: string) => isOverlay(id) || isFree(id);

  /** 选中的可能是模板元素（走 transforms）、自由元素（走 elements）、自由画布元素（走 props） */
  const tf = (id: string): Transform => {
    if (isOverlay(id)) {
      const el = overlayOf(id);
      if (!el) return IDENTITY;
      return { x: el.x, y: el.y, rotate: el.rotate, scale: el.scale, z: el.z };
    }
    if (isFree(id)) {
      const el = freeElOf(id);
      if (!el) return IDENTITY;
      return { x: el.x ?? 50, y: el.y ?? 50, rotate: el.rotate ?? 0, scale: el.scale ?? 1, z: 0 };
    }
    return { ...IDENTITY, ...(scene?.transforms?.[id] ?? {}) };
  };

  /**
   * 编辑层用手势时要一个"当前变换"字典。
   * 模板元素在 scene.transforms、自由元素在 scene.elements、自由画布元素在 props.elements，
   * 合成一份供 EditOverlay 使用；后两者统一加前缀，和选中集的 key 保持一致。
   */
  const draftTransformMap = useMemo(() => {
    const s = project.scenes.find((x) => x.id === selectedId);
    const map: Record<string, Transform> = { ...(s?.transforms ?? {}) };
    for (const el of s?.elements ?? []) {
      map[`ov:${el.id}`] = { x: el.x, y: el.y, rotate: el.rotate, scale: el.scale, z: el.z };
    }
    freeElsOf(s).forEach((el, i) => {
      map[`fc:${i}`] = { x: el.x ?? 50, y: el.y ?? 50, rotate: el.rotate ?? 0, scale: el.scale ?? 1, z: 0 };
    });
    if (draft) Object.assign(map, draft.map);
    return map;
  }, [project, selectedId, draft]);

  /** 自由画布：背景层特效（全屏光斑/星点）的选框要沉下去，否则挡着文字点不中 */
  const lowIds: string[] = [];
  freeEls.forEach((el, i) => {
    if (isBackdropElement(el)) lowIds.push(`fc:${i}`);
  });

  /** 把一次变换写成对应的 op —— 三类元素写的是不同字段 */
  const writeTransform = (id: string, t: Partial<Transform>): Op => {
    if (isOverlay(id)) {
      const patch: Record<string, number> = {};
      for (const k of ["x", "y", "rotate", "scale", "z"] as const) {
        const v = t[k];
        if (v !== undefined) patch[k] = v;
      }
      return { op: "update_element", sceneId: selectedId!, elementId: id.slice(3), patch };
    }
    return { op: "set_transform", sceneId: selectedId!, target: id, transform: t };
  };

  /**
   * 一次手势 → op 列表。
   *
   * 自由画布的元素必须**合成一条 update_scene**：服务端按顺序打补丁，
   * 而 update_scene 的 props 是整体替换 elements 数组，
   * 分成多条的话后一条会基于旧数组把前一条的结果盖掉（多选整体移动会少动几个）。
   */
  /**
   * 自由画布"最新的一份元素数组" = 服务端状态 + 还没落库的本地草稿。
   *
   * `update_scene` 的 props 是**整体替换 elements 数组**，所以 op 必须基于最新那一份构建。
   * 只用 project 里的数组会出事：上一个元素刚拖完、请求还在路上时，它的新位置只存在于草稿里，
   * 这一条 op 就会把那个元素写回旧位置 —— 表现正是"动一个，另一个退回原处"。
   */
  const freeElsWithDraft = (): FreeEl[] => {
    const els = [...freeEls];
    if (draft && draft.sceneId === selectedId) {
      for (const [id, t] of Object.entries(draft.map)) {
        if (!id.startsWith("fc:")) continue;
        const i = Number(id.slice(3));
        if (els[i]) els[i] = transformFreeElement(els[i], t);
      }
    }
    return els;
  };

  const opsFromTransforms = (map: Record<string, Transform>): Op[] => {
    if (!selectedId) return [];
    const entries = Object.entries(map);
    const ops: Op[] = [];

    const fcEntries = entries.filter(([id]) => isFree(id));
    if (fcEntries.length && scene?.type === "freeform") {
      const els = freeElsWithDraft();
      for (const [id, t] of fcEntries) {
        const i = freeIndexOf(id);
        if (!els[i]) continue;
        els[i] = transformFreeElement(els[i], t);
      }
      ops.push({
        op: "update_scene",
        sceneId: selectedId,
        patch: { props: { elements: els } as never },
      });
    }

    for (const [id, t] of entries) {
      if (isFree(id)) continue;
      ops.push(writeTransform(id, t));
    }
    return ops;
  };

  /** 直接把自由画布的元素数组换成新的一份（删除 / 复制 / 调层级都走这里） */
  const opSetFreeEls = (els: FreeEl[]): Op | null =>
    selectedId ? { op: "update_scene", sceneId: selectedId, patch: { props: { elements: els } as never } } : null;

  /**
   * 拖动中的实时预览：**合并**进草稿，不是替换。
   *
   * 草稿同时承担两个职责：本次拖动的实时预览 + 上一笔还在路上的落库（pin）。
   * 如果这里整体替换，拖 B 的瞬间就把 A 的 pin 抹掉了 —— A 立刻跳回旧位置，
   * 等它的请求回来才跳回来，看起来就是"动一个，另一个回退"。
   */
  const preview = (map: Record<string, Transform>) => {
    if (!selectedId || !Object.keys(map).length) return;
    setDraft((cur) =>
      cur && cur.sceneId === selectedId
        ? { sceneId: selectedId, map: { ...cur.map, ...map } }
        : { sceneId: selectedId, map },
    );
  };

  const commit = (map: Record<string, Transform>) => {
    if (!selectedId) return;
    // 多选整体缩放会一次写多个元素：必须合成一个请求 = 一步撤销
    const ops = opsFromTransforms(map);
    if (!ops.length) {
      setDraft(null);
      return;
    }
    /**
     * **不能**在 apply 之前就 setDraft(null)。
     * apply 是异步的：先清预览会让画面立刻跳回旧位置，等 HTTP 回来才跳到新位置，
     * 用户看到的就是"松手又回到原处"（pin 缺失）。
     * 正确做法是保持这次拖动的预览，直到 project 追上；apply 失败时这里也会清掉
     * 草稿、落回旧值（store 会弹 error）。
     *
     * 只摘掉**本次提交**的那几个 id，且要求草稿里的值仍是这一笔的值：
     * ① 别的元素可能还钉在上面（上一笔请求没回来）；
     * ② 期间用户可能又拖了同一个元素，草稿里是新值，不能被这一笔的回调误清。
     */
    void apply(ops).then(() => {
      setDraft((cur) => {
        if (!cur || cur.sceneId !== selectedId) return cur;
        const next = { ...cur.map };
        let dropped = false;
        for (const [id, t] of Object.entries(map)) {
          if (next[id] && sameTransform(next[id], t)) {
            delete next[id];
            dropped = true;
          }
        }
        if (!dropped) return cur;
        return Object.keys(next).length ? { sceneId: cur.sceneId, map: next } : null;
      });
    });
  };

  const resetElement = () => {
    if (!selectedId || !activeTarget) return;
    if (isEditable(activeTarget)) {
      // 自由元素没有"模板原位"，复位只把旋转/缩放还原。
      // 必须走 opsFromTransforms：自由画布元素写的是 props.elements，
      // 走 writeTransform 会写成模板用的 scene.transforms（画面上毫无反应还留脏数据）
      const ops = opsFromTransforms({ [activeTarget]: { ...tf(activeTarget), rotate: 0, scale: 1 } });
      if (ops.length) void apply(ops);
      return;
    }
    void apply([{ op: "set_transform", sceneId: selectedId, target: activeTarget, transform: null }]);
  };

  const resetSelection = () => {
    if (!selectedId || !selection.length) return;
    const ops: Op[] = [];
    const map: Record<string, Transform> = {};
    for (const id of selection) {
      if (isEditable(id)) map[id] = { ...tf(id), rotate: 0, scale: 1 };
      else ops.push({ op: "set_transform" as const, sceneId: selectedId, target: id, transform: null });
    }
    void apply([...ops, ...opsFromTransforms(map)]);
  };

  /**
   * 自由元素可以被删掉（模板元素不行）。
   * 删除元素**不弹确认**：这是高频可撤销操作，弹窗只会打断编辑（Ctrl+Z 就能回来）。
   * 不可撤销的删除（工程 / 模板 / 素材 / 场景 / 清理产物）才走确认。
   */
  const removeSelection = () => {
    if (!selectedId) return;
    const ids = selection.filter(isOverlay).map((id) => id.slice(3));
    const fcIds = selection.filter(isFree).map(freeIndexOf).sort((a, b) => b - a);
    if (!ids.length && !fcIds.length) return;

    const ops: Op[] = ids.map((elementId) => ({ op: "remove_element" as const, sceneId: selectedId, elementId }));
    if (fcIds.length) {
      const next = freeEls.filter((_, i) => !fcIds.includes(i));
      // schema 要求至少留一个元素：删到空会整条 op 报错，这里先说清楚
      if (!next.length) {
        notify("自由画布至少保留一个元素，先加一个再删这个");
        return;
      }
      const op = opSetFreeEls(next);
      if (op) ops.push(op);
    }
    setSelection([]);
    void apply(ops);
  };

  /**
   * 复制选中的元素（Ctrl/Cmd + D）。
   * 新元素错开 3% 摆放，否则会严严实实盖在原图上，看不出复制成功了。
   */
  const duplicateSelection = () => {
    if (!selectedId) return;
    const els = selection.filter(isOverlay).map(overlayOf).filter((e): e is NonNullable<typeof e> => !!e);
    const fcIds = selection.filter(isFree).map(freeIndexOf).sort((a, b) => a - b);
    if (!els.length && !fcIds.length) return;
    const newIds: string[] = [];
    const ops: Op[] = els.map((el) => {
      const id = `el_${(globalThis.crypto?.randomUUID?.() ?? String(Math.random())).slice(0, 8)}`;
      newIds.push(`ov:${id}`);
      return {
        op: "add_element" as const,
        sceneId: selectedId,
        element: {
          ...el,
          id,
          name: `${el.name} 副本`,
          x: Math.min(96, el.x + 3),
          y: Math.min(96, el.y + 3),
          z: el.z + 1,
        },
      };
    });

    if (fcIds.length) {
      const next = [...freeEls];
      for (const i of fcIds) {
        const src = next[i];
        if (!src) continue;
        if (next.length >= 40) {
          notify("一张自由画布最多 40 个元素，复制不了更多了");
          break;
        }
        newIds.push(`fc:${next.length}`);
        next.push({
          ...src,
          x: Math.min(96, (src.x ?? 50) + 3),
          y: Math.min(96, (src.y ?? 50) + 3),
        });
      }
      const op = opSetFreeEls(next);
      if (op) ops.push(op);
    }

    if (!ops.length) return;
    void apply(ops).then(() => setSelection(newIds));
  };

  /** 方向键微调：1%，按住 Shift 走 10%（模板元素 / 自由元素 / 自由画布元素都支持） */
  const nudgeSelection = (dx: number, dy: number) => {
    if (!selectedId || !selection.length) return;
    const map: Record<string, Transform> = {};
    for (const id of selection) {
      const t = tf(id);
      map[id] = { ...t, x: Math.min(100, Math.max(0, t.x + dx)), y: Math.min(100, Math.max(0, t.y + dy)) };
    }
    const ops = opsFromTransforms(map);
    if (ops.length) void apply(ops);
  };

  /** 从素材库拖进来 / 点进来：在画布坐标处生成一个属于当前场景的元素 */
  const addElementAt = async (libraryId: string, x: number, y: number) => {
    if (!selectedId) return;
    const id = `el_${(globalThis.crypto?.randomUUID?.() ?? String(Math.random())).slice(0, 8)}`;
    const at = {
      x: Math.min(98, Math.max(2, x)),
      y: Math.min(98, Math.max(2, y)),
    };
    // 落点 = 当前播放头在这个场景里的位置；默认 3 秒，且不超出场景结尾
    const sceneIdx = project.scenes.findIndex((s) => s.id === selectedId);
    const sceneSpan = sceneIdx >= 0 ? sceneSpans(project.scenes)[sceneIdx] : undefined;
    const sceneDur = sceneSpan?.dur ?? 90;
    const sceneStart = sceneSpan?.start ?? 0;
    const globalFrame = Math.round(playerRef.current?.getCurrentFrame?.() ?? 0);
    const startAt = Math.min(Math.max(0, globalFrame - sceneStart), Math.max(0, sceneDur - 1));
    const duration = Math.min(90, Math.max(1, sceneDur - startAt));
    // 两条来源走同一个出口：内置矢量素材 或 我的图片素材
    if (isAssetLibraryId(libraryId)) {
      const asset = assets.find((a) => a.id === assetIdOf(libraryId));
      if (!asset) {
        notify("这张素材已不在库里");
        return;
      }
      // 音频/视频按素材真实时长；没有就现场探测；图片/其它用默认 3 秒
      const frames = await framesForAsset(asset.url, project.fps, asset.duration);
      const element = {
        ...assetToElement(asset, at, project.fps),
        id,
        from: startAt,
        ...(frames ? { durationInFrames: frames } : { durationInFrames: duration }),
      } as OverlayElement;
      void apply([{ op: "add_element", sceneId: selectedId, element }]);
      setSelection([`ov:${id}`]);
      notify(`已放入「${asset.name}」`);
      return;
    }
    // 本工程素材（/assets/projects/<id>/x.png）：不是素材库 id，但仍是站内素材，
    // 以前这里会掉进"这不是素材"的兜底，从「本工程」拖到画布完全没反应
    if (libraryId.startsWith("/assets/")) {
      const ext = (libraryId.split("?")[0].split(".").pop() ?? "").toLowerCase();
      const kind = ["mp4", "webm", "mov", "m4v", "ogv"].includes(ext)
        ? "video"
        : ["mp3", "wav", "ogg", "m4a", "aac", "flac", "opus"].includes(ext)
          ? "audio"
          : "image";
      const name = decodeURIComponent(libraryId.split("?")[0].split("/").pop() ?? "素材");
      const frames = await framesForAsset(libraryId, project.fps);
      const base = assetToElement({ id: libraryId, name, url: libraryId, kind }, at, project.fps);
      // libraryId 属于「我的素材」的 id 空间，本工程文件不该带
      delete (base as { libraryId?: string }).libraryId;
      const element = {
        ...base,
        id,
        from: startAt,
        ...(frames ? { durationInFrames: frames } : { durationInFrames: duration }),
      } as OverlayElement;
      void apply([{ op: "add_element", sceneId: selectedId, element }]);
      setSelection([`ov:${id}`]);
      notify(`已放入「${name}」`);
      return;
    }
    const base = elementFromLibrary(libraryId, at);
    if (!base) {
      // 拖进来的可能是图片 URL / 文件路径之类，不是素材 id
      notify("这个拖拽内容不是素材（试试从左侧素材面板拖）");
      return;
    }
    void apply([
      { op: "add_element", sceneId: selectedId, element: { ...base, id, from: startAt, durationInFrames: duration } },
    ]);
    setSelection([`ov:${id}`]);
  };

  /* ───────────────────── 对齐 / 分布 ───────────────────── */

  const selectedBoxes = () => boxesRef.current.filter((b) => selection.includes(b.id));

  const alignSelection = (mode: "left" | "centerX" | "right" | "top" | "centerY" | "bottom") => {
    if (!selectedId) return;
    const bs = selectedBoxes();
    if (bs.length < 2) return;

    const minL = Math.min(...bs.map((b) => b.left));
    const maxR = Math.max(...bs.map((b) => b.left + b.width));
    const minT = Math.min(...bs.map((b) => b.top));
    const maxB = Math.max(...bs.map((b) => b.top + b.height));
    const midX = (minL + maxR) / 2;
    const midY = (minT + maxB) / 2;

    const map: Record<string, Transform> = {};
    for (const b of bs) {
      let dx = 0;
      let dy = 0;
      if (mode === "left") dx = minL - b.left;
      if (mode === "centerX") dx = midX - (b.left + b.width / 2);
      if (mode === "right") dx = maxR - (b.left + b.width);
      if (mode === "top") dy = minT - b.top;
      if (mode === "centerY") dy = midY - (b.top + b.height / 2);
      if (mode === "bottom") dy = maxB - (b.top + b.height);
      const t = tf(b.id);
      // 偏移量是百分比，所以要把像素差换算回画面比例
      map[b.id] = { ...t, x: t.x + (dx / width) * 100, y: t.y + (dy / height) * 100 };
    }
    const ops = opsFromTransforms(map);
    if (ops.length) void apply(ops);
  };

  const distribute = (axis: "x" | "y") => {
    if (!selectedId) return;
    const bs = [...selectedBoxes()];
    if (bs.length < 3) return;

    const horizontal = axis === "x";
    bs.sort((a, b) => (horizontal ? a.left - b.left : a.top - b.top));

    const start = horizontal ? bs[0].left : bs[0].top;
    const last = bs[bs.length - 1];
    const end = horizontal ? last.left + last.width : last.top + last.height;
    const totalSize = bs.reduce((sum, b) => sum + (horizontal ? b.width : b.height), 0);
    const gap = (end - start - totalSize) / (bs.length - 1);

    const ops: Op[] = [];
    const map: Record<string, Transform> = {};
    let cursor = start + (horizontal ? bs[0].width : bs[0].height) + gap;
    for (let i = 1; i < bs.length - 1; i++) {
      const b = bs[i];
      const delta = cursor - (horizontal ? b.left : b.top);
      const t = tf(b.id);
      map[b.id] = horizontal
        ? { ...t, x: t.x + (delta / width) * 100, y: t.y }
        : { ...t, x: t.x, y: t.y + (delta / height) * 100 };
      cursor += (horizontal ? b.width : b.height) + gap;
    }
    ops.push(...opsFromTransforms(map));
    if (ops.length) void apply(ops);
  };

  /* ───────────────────── 图层顺序 ───────────────────── */

  /**
   * 图层顺序。
   *
   * 两个约束决定了实现方式：
   *  1. 层级值**不能为负** —— 负 z-index 会把元素画到场景背景之下，表现为"置底后整块消失"
   *  2. 「置底」必须真的落在其他元素下面，不能只是回到 0（0 表示"没有层级信息"，届时靠 DOM 顺序决定）
   * 所以「置底」先算到最低值以下，再把整组平移回非负区间。
   */
  const changeLayer = (mode: "front" | "forward" | "backward" | "back") => {
    if (!selectedId || !selection.length) return;

    const known = [
      ...new Set([
        ...boxesRef.current.map((b) => b.id),
        ...Object.keys(scene?.transforms ?? {}),
        ...(scene?.elements ?? []).map((e) => `ov:${e.id}`),
        ...freeEls.map((_, i) => `fc:${i}`),
      ]),
    ];
    if (!known.length) return;

    // 自由画布没有 z-index：图层顺序 = elements 数组顺序，整组重排后一次写回
    const fcSel = selection.filter(isFree).map(freeIndexOf);
    if (fcSel.length && scene?.type === "freeform") {
      const { elements, moved } = reorderFreeElements(freeEls, fcSel, mode);
      const op = opSetFreeEls(elements);
      if (op) {
        const others = selection.filter((id) => !isFree(id));
        void apply([op]).then(() => setSelection([...others, ...moved.map((i) => `fc:${i}`)]));
      }
    }

    // 模板元素和自由元素是两套层级空间（自由元素整体叠在模板之上），分开算
    const groups = [known.filter((id) => !isEditable(id)), known.filter(isOverlay)];
    const zOf = (id: string) => Math.max(0, Math.round(tf(id).z ?? 0));
    const ops: Op[] = [];

    for (const group of groups) {
      const sel = group.filter((id) => selection.includes(id));
      if (!sel.length) continue;

      const others = group.filter((id) => !sel.includes(id));
      const maxZ = Math.max(0, ...group.map(zOf));
      const targets = new Map<string, number>();

      if (mode === "front") sel.forEach((id, i) => targets.set(id, maxZ + 1 + i));
      else if (mode === "forward") sel.forEach((id) => targets.set(id, zOf(id) + 1));
      else if (mode === "backward") sel.forEach((id) => targets.set(id, Math.max(0, zOf(id) - 1)));
      else {
        const minOther = others.length ? Math.min(...others.map(zOf)) : 0;
        sel.forEach((id, i) => targets.set(id, minOther - sel.length + i));
      }

      // 出现负值就整组平移，顺序不变，但都回到非负区间
      const minAll = Math.min(...group.map((id) => targets.get(id) ?? zOf(id)));
      const shift = minAll < 0 ? -minAll : 0;

      for (const id of group) {
        const before = zOf(id);
        const after = (targets.get(id) ?? before) + shift;
        if (after !== before) ops.push(writeTransform(id, { z: after }));
      }
    }

    if (ops.length) void apply(ops);
  };

  // 选中元素的信息：给用户看得懂的数值，别让他靠眼睛猜旋转了多少度
  const cur = activeTarget ? tf(activeTarget) : null;
  const hasOffset =
    !!cur &&
    (Math.abs(cur.x) > 0.01 ||
      Math.abs(cur.y) > 0.01 ||
      Math.abs(cur.rotate) > 0.01 ||
      Math.abs(cur.scale - 1) > 0.01 ||
      Math.abs(cur.z ?? 0) > 0.01);

  const meta = scene ? getMeta(scene.type) : undefined;
  const labelOf = (id: string) => {
    if (isOverlay(id)) return overlayOf(id)?.name ?? "元素";
    if (isFree(id)) {
      const el = freeElOf(id);
      return el ? freeElementLabel(el, freeIndexOf(id)) : "元素";
    }
    const els = meta?.elements ?? [];
    const exact = els.find((e) => e.id === id);
    if (exact) return exact.label;
    const wild = els.find((e) => {
      if (!e.id.includes("{n}")) return false;
      return new RegExp(`^${e.id.replace("{n}", "\\d+")}$`).test(id);
    });
    return wild ? wild.label : id;
  };

  /**
   * 双击画面里的文案 → 就地编辑。
   *
   * 命中判定不能靠 `node.contains(target)`：编辑层的选框盖在元素之上，
   * 双击的 target 其实是那个 `.edit-box`，于是循环永远找不到节点，
   * 就地编辑等于失效。改为先读选框上的 data-box-id，再回查登记表。
   */
  const startInlineEdit = (e: React.MouseEvent) => {
    if (!scene) return;
    const target = e.target as HTMLElement;
    const boxNode = target.closest?.(".edit-box") as HTMLElement | null;
    const boxId = boxNode?.getAttribute("data-box-id") ?? null;

    // ① 自由画布的文字：直接改 elements[i].text
    if (boxId && boxId.startsWith("fc:")) {
      const i = Number(boxId.slice(3));
      const el = freeEls[i];
      if (el?.type !== "text") return;
      const node = editRegistry.get(`${scene.id}::fc:${i}`);
      const r = (node ?? boxNode)!.getBoundingClientRect();
      setInlineEdit({
        kind: "free",
        sceneId: scene.id,
        prop: "text",
        index: i,
        original: el.text ?? "",
        text: el.text ?? "",
        rect: {
          left: r.left,
          top: r.top,
          width: Math.max(160, r.width),
          height: Math.max(38, r.height),
        },
      });
      return;
    }

    // ② 模板元素的字符串字段（只支持直接字段，数组项暂不支持）
    const candidates: [string, HTMLElement][] = [];
    for (const [key, node] of editRegistry) {
      if (!key.startsWith(`${scene.id}::`)) continue;
      const editId = key.slice(scene.id.length + 2);
      if (boxId && boxId !== editId) continue;
      if (!boxId && !node.contains(target)) continue;
      candidates.push([editId, node]);
    }
    for (const [editId, node] of candidates) {
      const el = meta?.elements?.find((x) => x.id === editId);
      const prop = el?.prop ?? editId;
      const current = (scene.props as Record<string, unknown>)[prop];
      if (typeof current !== "string") continue;
      const r = node.getBoundingClientRect();
      setInlineEdit({
        kind: "prop",
        sceneId: scene.id,
        prop,
        index: -1,
        original: current,
        text: current,
        rect: {
          left: r.left,
          top: r.top,
          width: Math.max(160, r.width),
          height: Math.max(38, r.height),
        },
      });
      return;
    }
  };

  const commitInlineEdit = () => {
    if (!inlineEdit) return;
    const { text, original } = inlineEdit;
    if (text.trim() && text !== original) {
      if (inlineEdit.kind === "free") {
        const els = [...freeEls];
        const el = els[inlineEdit.index];
        if (el) {
          els[inlineEdit.index] = { ...el, text };
          const op = opSetFreeEls(els);
          if (op) void apply([op]);
        }
      } else {
        void apply([
          { op: "update_scene", sceneId: inlineEdit.sceneId, patch: { props: { [inlineEdit.prop]: text.trim() } } },
        ]);
      }
    }
    setInlineEdit(null);
  };

  const multi = selection.length > 1;
  /** 复制/删除只对自由元素（含自由画布元素）有意义 */
  const hasOverlaySelection = selection.some(isEditable);

  return (
    <div
      className="stage"
      ref={stageRef}
      onDoubleClick={startInlineEdit}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => {
        e.preventDefault();
        // 拖到画布外也接住：落点 clamp 到 2%–98%，比"拖偏了完全没反应"好
        const libId =
          e.dataTransfer.getData("text/x-element") ||
          e.dataTransfer.getData("text/x-project-asset") ||
          e.dataTransfer.getData("text/plain");
        if (!libId) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const r = canvas.getBoundingClientRect();
        const x = Math.min(98, Math.max(2, ((e.clientX - r.left) / r.width) * 100));
        const y = Math.min(98, Math.max(2, ((e.clientY - r.top) / r.height) * 100));
        void addElementAt(libId, x, y);
      }}
    >
      <div
        className="canvas-zoom"
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
      >
        <div className="canvas-shell" style={{ width, height }} ref={canvasRef}>
          <Player
            ref={playerRef}
            component={Video}
            inputProps={inputProps}
            durationInFrames={Math.max(1, totalDuration(project))}
            fps={project.fps}
            compositionWidth={fmt.width}
            compositionHeight={fmt.height}
            style={{ width: "100%", height: "100%" }}
            controls
            // 控制条在编辑器里要一直看得见：鼠标一停就淡出，用户会以为"按钮没了"。
            // 配合 styles.css 里那条 z-index 规则（否则会被元素选框盖住，点播放变成选中元素）
            alwaysShowControls
            loop
            // 关键：点画面不播放、双指误触不进全屏，只认控制条上的播放键和空格
            clickToPlay={false}
            spaceKeyToPlayOrPause={false}
            doubleClickToFullscreen={false}
            acknowledgeRemotionLicense
          />

          <EditOverlay
            sceneId={selectedId}
            canvasRef={canvasRef}
            zoom={zoom}
            canvasW={width}
            canvasH={height}
            transforms={draftTransformMap}
            selection={selection}
            lowIds={lowIds}
            showOutlines={showOutlines}
            showSafe={showSafe}
            onSelectionChange={setSelection}
            onPreview={preview}
            onCommit={commit}
            onBoxes={(b) => {
              boxesRef.current = b;
            }}
          />

          {/* 画中画框：整幕的缩放/位置，和元素选框是两套（一个写 element，一个写 scene.box） */}
          <SceneBoxOverlay
            canvasRef={canvasRef}
            zoom={zoom}
            canvasW={width}
            canvasH={height}
            selectedId={selectedId}
            playing={playing}
            onSelectScene={(id) => selectScene(id)}
            onPreview={(sceneId, box) =>
              setBoxDraft((prev) => ({
                sceneId,
                box: { ...(prev?.sceneId === sceneId ? prev.box : {}), ...box },
              }))
            }
            onCommit={(sceneId, box) => {
              setBoxDraft(null);
              void apply([{ op: "set_scene_box", sceneId, box }]);
            }}
          />
        </div>
      </div>

      {/* 排列条常驻：没选中时按钮置灰而不是整条消失，免得"找个功能还要先选中" */}
      <div className={`arrange-bar ${selection.length ? "" : "is-idle"}`}>
        <span className="arrange-label">
          {multi ? `已选 ${selection.length} 个` : activeTarget ? labelOf(activeTarget) : "未选中"}
        </span>
        <div className="arrange-group">
          <IconBtn
            paths={ALIGN_ICONS.front}
            label="置顶"
            disabled={!selection.length}
            onClick={() => changeLayer("front")}
          />
          <IconBtn
            paths={ALIGN_ICONS.forward}
            label="上移一层"
            disabled={!selection.length}
            onClick={() => changeLayer("forward")}
          />
          <IconBtn
            paths={ALIGN_ICONS.backward}
            label="下移一层"
            disabled={!selection.length}
            onClick={() => changeLayer("backward")}
          />
          <IconBtn
            paths={ALIGN_ICONS.back}
            label="置底"
            disabled={!selection.length}
            onClick={() => changeLayer("back")}
          />
          <IconBtn
            paths={ALIGN_ICONS.duplicate}
            label="复制元素（Ctrl+D）"
            disabled={!hasOverlaySelection}
            onClick={duplicateSelection}
          />
        </div>

        <span className="arrange-sep" />
        <div className="arrange-group">
          <IconBtn
            paths={ALIGN_ICONS.left}
            label="左对齐"
            disabled={!multi}
            onClick={() => alignSelection("left")}
          />
          <IconBtn
            paths={ALIGN_ICONS.centerX}
            label="水平居中对齐"
            disabled={!multi}
            onClick={() => alignSelection("centerX")}
          />
          <IconBtn
            paths={ALIGN_ICONS.right}
            label="右对齐"
            disabled={!multi}
            onClick={() => alignSelection("right")}
          />
          <IconBtn
            paths={ALIGN_ICONS.top}
            label="顶对齐"
            disabled={!multi}
            onClick={() => alignSelection("top")}
          />
          <IconBtn
            paths={ALIGN_ICONS.centerY}
            label="垂直居中对齐"
            disabled={!multi}
            onClick={() => alignSelection("centerY")}
          />
          <IconBtn
            paths={ALIGN_ICONS.bottom}
            label="底对齐"
            disabled={!multi}
            onClick={() => alignSelection("bottom")}
          />
        </div>

        {selection.length >= 3 ? (
          <>
            <span className="arrange-sep" />
            <div className="arrange-group">
              <IconBtn
                paths={ALIGN_ICONS.distributeX}
                label="水平等距分布"
                onClick={() => distribute("x")}
              />
              <IconBtn
                paths={ALIGN_ICONS.distributeY}
                label="垂直等距分布"
                onClick={() => distribute("y")}
              />
            </div>
          </>
        ) : null}

        <span className="arrange-sep" />
        <button
          className="arrange-text"
          disabled={!selection.length}
          onClick={multi ? resetSelection : resetElement}
        >
          {multi ? "全部复位" : selection[0] && isEditable(selection[0]) ? "重置变换" : "复位元素"}
        </button>
        <IconBtn
          paths={ALIGN_ICONS.trash}
          label="删除元素（Delete）"
          accent
          disabled={!hasOverlaySelection}
          onClick={removeSelection}
        />
      </div>

      <div className="zoom-bar">
        <button
          className="play-toggle"
          onClick={() => playerRef.current?.toggle()}
          title={playing ? "暂停（空格）" : "播放（空格）"}
          aria-label={playing ? "暂停" : "播放"}
        >
          {playing ? (
            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
              <rect x="3.5" y="2.5" width="3" height="11" rx="1" />
              <rect x="9.5" y="2.5" width="3" height="11" rx="1" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
              <path d="M4 2.6v10.8a.6.6 0 0 0 .92.5l8.4-5.4a.6.6 0 0 0 0-1L4.92 2.1A.6.6 0 0 0 4 2.6z" />
            </svg>
          )}
        </button>

        {selection.length === 1 && cur ? (
          <>
            <span className="zoom-target">{labelOf(selection[0])}</span>
            <span className="zoom-values">
              x {cur.x.toFixed(1)}% · y {cur.y.toFixed(1)}% · {cur.rotate.toFixed(0)}° ·{" "}
              {cur.scale.toFixed(2)}×{cur.z ? ` · 层 ${cur.z}` : ""}
            </span>
            {hasOffset ? (
              <button className="zoom-btn reset-el" onClick={resetElement}>
                复位元素
              </button>
            ) : null}
          </>
        ) : selection.length > 1 ? (
          <span className="zoom-hint">Shift 拖动框选 · Shift 点击加选</span>
        ) : (
          <span className="zoom-hint">滚轮缩放 · 空白处拖动平移 · Alt/中键平移</span>
        )}

        <span className="zoom-sep" />
        <span>{Math.round(zoom * 100)}%</span>
        <button
          className="zoom-btn"
          onClick={toggleSafe}
          title={showSafe ? "隐藏 5% 安全区辅助线" : "显示 5% 安全区辅助线"}
        >
          {showSafe ? "隐藏安全区" : "安全区"}
        </button>
        <button
          className="zoom-btn"
          onClick={toggleOutlines}
          title={showOutlines ? "隐藏选框，只看画面" : "显示选框"}
        >
          {showOutlines ? "隐藏选框" : "显示选框"}
        </button>
        <button
          className="zoom-btn"
          onClick={() => {
            zoomRef.current = 1;
            panRef.current = { x: 0, y: 0 };
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
          title="回到 100% 并居中"
        >
          重置视图
        </button>
      </div>
      {inlineEdit ? (
        <textarea
          className="inline-edit"
          autoFocus
          value={inlineEdit.text}
          style={{
            left: inlineEdit.rect.left,
            top: inlineEdit.rect.top,
            width: inlineEdit.rect.width,
            minHeight: inlineEdit.rect.height,
          }}
          onChange={(e) => setInlineEdit({ ...inlineEdit, text: e.target.value })}
          onBlur={commitInlineEdit}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setInlineEdit(null);
            } else if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              commitInlineEdit();
            }
          }}
        />
      ) : null}

    </div>
  );
};
