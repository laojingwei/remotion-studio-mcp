import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Transform } from "@shared/schema";
import { editRegistry } from "../../src/scenes/ui";

export type Box = { id: string; left: number; top: number; width: number; height: number };
/** 吸附参考线：axis="x" 是竖线（x 坐标），"y" 是横线 */
export type Guide = { axis: "x" | "y"; pos: number };
type TargetMap = Record<string, Transform>;

type Props = {
  sceneId: string | null;
  /** 画布容器（未缩放的逻辑尺寸参照物） */
  canvasRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  canvasW: number;
  canvasH: number;
  transforms?: Record<string, Transform>;
  /** 已选中的元素 id，多选时长度 > 1 */
  selection: string[];
  /**
   * 「背景层」元素的 id：选框沉到其它元素下面。
   * 全屏特效（光斑/星点/粒子）的盒子会盖住整张画布，不沉下去就永远点不中它上面的人。
   */
  lowIds?: string[];
  /** 是否显示淡色轮廓；关掉就是「干净画面」 */
  showOutlines: boolean;
  /** 常显安全区辅助线 */
  showSafe: boolean;
  onSelectionChange: (ids: string[]) => void;
  /** 拖动过程中实时预览，不落库；一次可以带多个元素（多选整体缩放） */
  onPreview: (map: TargetMap) => void;
  /** 松手时一次性提交，保证一步撤销 */
  onCommit: (map: TargetMap) => void;
  /** 上报测量结果，外层做对齐/分布时要用 */
  onBoxes: (boxes: Box[]) => void;
};

const IDENTITY: Transform = { x: 0, y: 0, rotate: 0, scale: 1, z: 0 };

/**
 * 两次测量是否等价（0.5px 以内算没变）。
 *
 * 轮询每帧都会产出一个新数组，无条件 setState 等于每帧重渲染整层选框：
 * 静止时纯属白烧，和属性面板的输入框叠在一起就明显卡。
 * 返回同一个引用时 React 会直接跳过这次渲染。
 */
const sameBoxes = (a: Box[], b: Box[]) =>
  a.length === b.length &&
  a.every((x, i) => {
    const y = b[i];
    return (
      y &&
      x.id === y.id &&
      Math.abs(x.left - y.left) < 0.5 &&
      Math.abs(x.top - y.top) < 0.5 &&
      Math.abs(x.width - y.width) < 0.5 &&
      Math.abs(x.height - y.height) < 0.5
    );
  });

/** 安全区：按短边留 5%，短视频平台对四边的挤压大致就在这个量级 */
const SAFE_RATIO = 0.05;
/** 吸附半径（屏幕像素）；除以 zoom 后才是画布逻辑像素，缩放后手感一致 */
const SNAP_SCREEN_PX = 6;

const insetOf = (w: number, h: number) => Math.min(w, h) * SAFE_RATIO;

const isOutOfCanvas = (b: Box, w: number, h: number) =>
  b.left < -0.5 || b.top < -0.5 || b.left + b.width > w + 0.5 || b.top + b.height > h + 0.5;

const isUnsafe = (b: Box, w: number, h: number) => {
  const i = insetOf(w, h);
  return b.left < i - 0.5 || b.top < i - 0.5 || b.left + b.width > w - i + 0.5 || b.top + b.height > h - i + 0.5;
};

/**
 * 把元素边缘/中心吸附到「画布边线 / 安全区边线 / 画布中线 / 其他元素」。
 * 返回需要追加的位移和命中的参考线。
 */
const computeSnap = (
  moved: Box,
  w: number,
  h: number,
  others: Box[],
  zoom: number,
): { dx: number; dy: number; guides: Guide[] } => {
  const thresh = SNAP_SCREEN_PX / Math.max(zoom, 0.01);
  const inset = insetOf(w, h);

  const targetXs = [moved.left, moved.left + moved.width / 2, moved.left + moved.width];
  const targetYs = [moved.top, moved.top + moved.height / 2, moved.top + moved.height];
  const candXs = [
    0,
    inset,
    w / 2,
    w - inset,
    w,
    ...others.flatMap((b) => [b.left, b.left + b.width / 2, b.left + b.width]),
  ];
  const candYs = [
    0,
    inset,
    h / 2,
    h - inset,
    h,
    ...others.flatMap((b) => [b.top, b.top + b.height / 2, b.top + b.height]),
  ];

  let bestX: { diff: number; line: number } | null = null;
  for (const c of candXs) {
    for (const t of targetXs) {
      const diff = c - t;
      if (Math.abs(diff) <= thresh && (!bestX || Math.abs(diff) < Math.abs(bestX.diff))) {
        bestX = { diff, line: c };
      }
    }
  }
  let bestY: { diff: number; line: number } | null = null;
  for (const c of candYs) {
    for (const t of targetYs) {
      const diff = c - t;
      if (Math.abs(diff) <= thresh && (!bestY || Math.abs(diff) < Math.abs(bestY.diff))) {
        bestY = { diff, line: c };
      }
    }
  }

  const guides: Guide[] = [];
  if (bestX) guides.push({ axis: "x", pos: bestX.line });
  if (bestY) guides.push({ axis: "y", pos: bestY.line });
  return { dx: bestX?.diff ?? 0, dy: bestY?.diff ?? 0, guides };
};

type GestureMove = {
  kind: "move";
  id: string;
  startX: number;
  startY: number;
  /** 手势开始那一刻的 DOM 盒子（逻辑像素），吸附与越界都基于它推算 */
  box: Box;
  base: Transform;
};

type GestureRotate = { kind: "rotate"; id: string; cx: number; cy: number; startAngle: number; base: Transform };
type GestureScale = { kind: "scale"; id: string; cx: number; cy: number; startDist: number; base: Transform };

/** 多选整体编辑：以整体包围盒中心为锚点，把一次手势映射到每个成员 */
type GroupMember = { id: string; dx: number; dy: number; base: Transform };
type GroupBox = { left: number; top: number; width: number; height: number };

/** 整体移动：所有成员共享同一个位移（百分比换算后） */
type GestureGroupMove = {
  kind: "group-move";
  startX: number;
  startY: number;
  box: GroupBox;
  members: GroupMember[];
};
/** 整体旋转：成员各自 rotate += delta，位置绕整体中心旋转 */
type GestureGroupRotate = {
  kind: "group-rotate";
  cx: number;
  cy: number;
  startAngle: number;
  members: GroupMember[];
};
/** 整体缩放：成员位置按同一 k 映射，scale 各自相乘 */
type GestureGroupScale = {
  kind: "group-scale";
  cx: number;
  cy: number;
  startDist: number;
  members: GroupMember[];
};

type AnyGesture =
  | GestureMove
  | GestureRotate
  | GestureScale
  | GestureGroupMove
  | GestureGroupRotate
  | GestureGroupScale;

/** 整体手势的 dragState 用一个不可能撞上元素 id 的值 */
const GROUP_DRAG_ID = "__group__";

type DragState = { id: string; out: boolean; unsafe: boolean };

const rectOf = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
  left: Math.min(a.x, b.x),
  top: Math.min(a.y, b.y),
  width: Math.abs(a.x - b.x),
  height: Math.abs(a.y - b.y),
});

const unionBox = (bs: Box[]): GroupBox | null => {
  if (!bs.length) return null;
  const left = Math.min(...bs.map((b) => b.left));
  const top = Math.min(...bs.map((b) => b.top));
  const right = Math.max(...bs.map((b) => b.left + b.width));
  const bottom = Math.max(...bs.map((b) => b.top + b.height));
  return { left, top, width: right - left, height: bottom - top };
};

const asBox = (gb: GroupBox, id = GROUP_DRAG_ID): Box => ({ id, ...gb });

const round2 = (n: number) => Number(n.toFixed(2));

/**
 * 元素编辑层：盖在 Player 之上，负责选中框、拖拽手势和框选。
 *
 * 坐标一律走「画布逻辑像素」再换算百分比，
 * 所以无论预览缩放多少、换哪种画幅，拖动的手感都一致。
 *
 * 交互分工很重要：
 *  - 元素上的指针事件由盒子自己处理（阻止冒泡）
 *  - 画布空白处的指针事件用**捕获阶段监听**接管，不铺一层遮罩，
 *    否则会把 Remotion 自带的播放控件挡死
 *  - 播放控件在 `.__remotion-player` 之外，所以用 closest 就能区分开
 */
export const EditOverlay: React.FC<Props> = ({
  sceneId,
  canvasRef,
  zoom,
  canvasW,
  canvasH,
  transforms,
  selection,
  lowIds,
  showOutlines,
  showSafe,
  onSelectionChange,
  onPreview,
  onCommit,
  onBoxes,
}) => {
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(
    null,
  );
  const [guides, setGuides] = useState<Guide[]>([]);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const gesture = useRef<AnyGesture | null>(null);
  const lastPreview = useRef<TargetMap | null>(null);
  const raf = useRef<number>(0);

  // 原生监听里读最新的 props，避免每个回调都要重新绑定事件
  const boxesRef = useRef<Box[]>([]);
  const selectionRef = useRef<string[]>(selection);
  const onBoxesRef = useRef(onBoxes);
  const onSelectRef = useRef(onSelectionChange);
  selectionRef.current = selection;
  onBoxesRef.current = onBoxes;
  onSelectRef.current = onSelectionChange;
  /** 背景层（全屏特效）不参与吸附：它的边线常常在画布外，会把元素吸到看不见的地方 */
  const lowRef = useRef<string[]>([]);
  lowRef.current = lowIds ?? [];

  /** 元素位置来自真实 DOM，动画每帧都在动，只能轮询测量 */
  useEffect(() => {
    if (!sceneId) {
      setBoxes([]);
      boxesRef.current = [];
      return;
    }
    let alive = true;

    const tick = () => {
      if (!alive) return;
      const canvas = canvasRef.current;
      if (canvas) {
        const base = canvas.getBoundingClientRect();
        const next: Box[] = [];
        for (const [key, node] of editRegistry) {
          // 模板元素按场景登记（sceneId::id）；自由元素是工程级的（ov:id），全局可见
          let id: string | null = null;
          if (key.startsWith(`${sceneId}::`)) id = key.slice(sceneId.length + 2);
          else if (key.startsWith("ov:")) id = key;
          if (!id) continue;
          if (!node.isConnected) continue;
          const r = node.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          // 除以 zoom，把屏幕像素还原成画布逻辑像素
          next.push({
            id,
            left: (r.left - base.left) / zoom,
            top: (r.top - base.top) / zoom,
            width: r.width / zoom,
            height: r.height / zoom,
          });
        }
        boxesRef.current = next;
        onBoxesRef.current(next);
        // 位置没变就复用旧数组（同一个引用 React 不重渲染），静止画面的开销归零
        setBoxes((prev) => (sameBoxes(prev, next) ? prev : next));
      }
      raf.current = requestAnimationFrame(tick);
    };

    raf.current = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(raf.current);
    };
  }, [sceneId, canvasRef, zoom]);

  /* ─────────────── 画布空白处：点一下取消选中，拖一下框选 ─────────────── */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !sceneId) return;

    let pending:
      | { start: { x: number; y: number }; moved: boolean; additive: boolean; pointerId: number }
      | null = null;

    const toLogical = (clientX: number, clientY: number) => {
      const r = canvas.getBoundingClientRect();
      return { x: (clientX - r.left) / zoom, y: (clientY - r.top) / zoom };
    };

    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target;
      // 事件目标可能不是元素（例如在 window 上派发的合成事件）
      if (!(target instanceof Element)) return;
      // 元素盒子和它上面的手柄自己处理
      if (target.closest(".edit-box")) return;
      // 播放控件栏（进度条、播放键）在 __remotion-player 之外，交给它自己
      if (!target.closest(".__remotion-player")) return;

      /**
       * 背景层（全屏特效）的选框是 pointer-events:none，点它会穿过到元素本身。
       * 这里接住：选中该元素（选中后选框才可交互），但不进入手势 ——
       * 否则一次误拖会把整块背景挪走，比"点不中"更难受。
       * 框选也就此打住，否则整张画布都算在背景元素里，永远框不出东西。
       */
      const freeHit = target.closest("[data-edit-id^='fc:']")?.getAttribute("data-edit-id");
      if (freeHit && boxesRef.current.some((b) => b.id === freeHit)) {
        const cur = selectionRef.current;
        if (!(cur.length === 1 && cur[0] === freeHit)) onSelectRef.current([freeHit]);
        return;
      }

      pending = {
        start: toLogical(e.clientX, e.clientY),
        moved: false,
        additive: e.shiftKey || e.metaKey || e.ctrlKey,
        pointerId: e.pointerId,
      };
    };

    const move = (e: PointerEvent) => {
      if (!pending) return;
      const cur = toLogical(e.clientX, e.clientY);
      const dx = cur.x - pending.start.x;
      const dy = cur.y - pending.start.y;
      // 几个像素的抖动不算框选，否则「点一下取消选中」会失灵
      if (!pending.moved && Math.hypot(dx, dy) < 4 / zoom) return;
      pending.moved = true;
      // 空白处的普通拖动交给画布平移（Preview 那边处理）；框选只认 Shift / Ctrl / Cmd 拖动
      if (!pending.additive) return;
      setMarquee(rectOf(pending.start, cur));
    };

    const up = (e: PointerEvent) => {
      const p = pending;
      pending = null;
      setMarquee(null);
      if (!p) return;

      if (!p.moved) {
        // 空白处单击 = 取消选中（按着 Shift 则保留，方便逐个加选）
        if (!p.additive) onSelectRef.current([]);
        return;
      }

      // 普通拖动是画布平移，由 Preview 处理；只有 Shift / Ctrl / Cmd 拖动才结算框选
      if (!p.additive) return;

      const end = toLogical(e.clientX, e.clientY);
      const area = rectOf(p.start, end);
      const hit = boxesRef.current
        .filter(
          (b) =>
            b.left < area.left + area.width &&
            b.left + b.width > area.left &&
            b.top < area.top + area.height &&
            b.top + b.height > area.top,
        )
        .map((b) => b.id);

      if (p.additive) {
        onSelectRef.current([...new Set([...selectionRef.current, ...hit])]);
      } else {
        onSelectRef.current(hit);
      }
    };

    // 捕获阶段：先于元素自己的处理拿到事件，但不阻止默认行为
    canvas.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      canvas.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [canvasRef, sceneId, zoom]);

  const base = useCallback(
    (id: string): Transform => ({ ...IDENTITY, ...(transforms?.[id] ?? {}) }),
    [transforms],
  );

  /** 多选整体包围盒：工具条、整体手柄都基于它 */
  const groupBox = useMemo(() => {
    if (selection.length < 2) return null;
    const sel = new Set(selection);
    const bs = boxes.filter((b) => sel.has(b.id));
    if (bs.length < 2) return null;
    return unionBox(bs);
  }, [boxes, selection]);

  /** 手势开始时抓一份成员快照：相对整体中心的偏移 + 各自当前变换 */
  const membersFrom = (bs: Box[], gb: GroupBox): GroupMember[] => {
    const cx = gb.left + gb.width / 2;
    const cy = gb.top + gb.height / 2;
    return bs.map((b) => ({
      id: b.id,
      dx: b.left + b.width / 2 - cx,
      dy: b.top + b.height / 2 - cy,
      base: base(b.id),
    }));
  };

  const selectedBoxesNow = () => {
    const sel = new Set(selectionRef.current);
    return boxesRef.current.filter((b) => sel.has(b.id));
  };

  const capturePointer = (e: React.PointerEvent) => {
    try {
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {
      /* 忽略：自动化测试或被程序化触发时没有真实指针 */
    }
  };

  const startGroupMove = (e: React.PointerEvent) => {
    const bs = selectedBoxesNow();
    const gb = unionBox(bs);
    if (!gb || bs.length < 2) return false;
    gesture.current = {
      kind: "group-move",
      startX: e.clientX,
      startY: e.clientY,
      box: gb,
      members: membersFrom(bs, gb),
    };
    capturePointer(e);
    return true;
  };

  const startGroupScale = (e: React.PointerEvent, gb: GroupBox) => {
    e.stopPropagation();
    e.preventDefault();
    const bs = selectedBoxesNow();
    if (bs.length < 2) return;

    const cx = gb.left + gb.width / 2;
    const cy = gb.top + gb.height / 2;
    const rect = canvasRef.current?.getBoundingClientRect();
    const originX = (rect?.left ?? 0) + cx * zoom;
    const originY = (rect?.top ?? 0) + cy * zoom;
    const startDist = Math.hypot(e.clientX - originX, e.clientY - originY) || 1;

    gesture.current = {
      kind: "group-scale",
      cx,
      cy,
      startDist,
      members: membersFrom(bs, gb),
    };
    capturePointer(e);
  };

  const startGroupRotate = (e: React.PointerEvent, gb: GroupBox) => {
    e.stopPropagation();
    e.preventDefault();
    const bs = selectedBoxesNow();
    if (bs.length < 2) return;

    const cx = gb.left + gb.width / 2;
    const cy = gb.top + gb.height / 2;
    const rect = canvasRef.current?.getBoundingClientRect();
    const originX = (rect?.left ?? 0) + cx * zoom;
    const originY = (rect?.top ?? 0) + cy * zoom;
    const dx = e.clientX - originX;
    const dy = e.clientY - originY;

    gesture.current = {
      kind: "group-rotate",
      cx,
      cy,
      startAngle: (Math.atan2(dy, dx) * 180) / Math.PI,
      members: membersFrom(bs, gb),
    };
    capturePointer(e);
  };

  const onPointerDown = (e: React.PointerEvent, box: Box, kind: "move" | "rotate" | "scale") => {
    e.stopPropagation();
    e.preventDefault();

    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    if (additive) {
      // 加选 / 减选：只改选中集，不进入手势
      const has = selectionRef.current.includes(box.id);
      onSelectRef.current(
        has ? selectionRef.current.filter((id) => id !== box.id) : [...selectionRef.current, box.id],
      );
      return;
    }

    // 多选状态下按住**已选中**的元素 = 整体移动，不再收敛成单选
    if (
      kind === "move" &&
      selectionRef.current.length > 1 &&
      selectionRef.current.includes(box.id) &&
      startGroupMove(e)
    ) {
      return;
    }

    // 其余情况：点未选中的元素、或单选状态，收敛成单选
    if (selectionRef.current.length > 1) {
      onSelectRef.current([box.id]);
    } else if (!selectionRef.current.includes(box.id)) {
      onSelectRef.current([box.id]);
    }

    const t = base(box.id);
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;

    if (kind === "move") {
      gesture.current = {
        kind,
        id: box.id,
        startX: e.clientX,
        startY: e.clientY,
        box,
        base: t,
      };
    } else {
      const canvas = canvasRef.current;
      const rect = canvas?.getBoundingClientRect();
      const originX = (rect?.left ?? 0) + cx * zoom;
      const originY = (rect?.top ?? 0) + cy * zoom;
      const dx = e.clientX - originX;
      const dy = e.clientY - originY;
      if (kind === "rotate") {
        gesture.current = {
          kind,
          id: box.id,
          cx,
          cy,
          startAngle: (Math.atan2(dy, dx) * 180) / Math.PI,
          base: t,
        };
      } else {
        gesture.current = { kind, id: box.id, cx, cy, startDist: Math.hypot(dx, dy) || 1, base: t };
      }
    }
    // 指针捕获让拖动过程中鼠标移出元素也能继续跟手；合成事件下可能没有该 pointerId
    try {
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {
      /* 忽略：自动化测试或被程序化触发时没有真实指针 */
    }
  };

  useEffect(() => {
    const publish = (map: TargetMap) => {
      lastPreview.current = map;
      onPreview(map);
    };

    const applyMove = (e: PointerEvent) => {
      const g = gesture.current;
      if (!g) return;

      // 整体移动：整组当一个大盒子去吸附/判越界，再把同一个位移分给所有成员
      if (g.kind === "group-move") {
        const dxPx = (e.clientX - g.startX) / zoom;
        const dyPx = (e.clientY - g.startY) / zoom;
        const moved: GroupBox = { ...g.box, left: g.box.left + dxPx, top: g.box.top + dyPx };

        const memberIds = new Set(g.members.map((m) => m.id));
        const others = boxesRef.current.filter((b) => !memberIds.has(b.id) && !lowRef.current.includes(b.id));
        const snap = computeSnap(asBox(moved), canvasW, canvasH, others, zoom);
        const dx = dxPx + snap.dx;
        const dy = dyPx + snap.dy;
        const finalBox = asBox({ ...moved, left: moved.left + snap.dx, top: moved.top + snap.dy });

        setGuides(snap.guides);
        setDragState({
          id: GROUP_DRAG_ID,
          out: isOutOfCanvas(finalBox, canvasW, canvasH),
          unsafe: isUnsafe(finalBox, canvasW, canvasH),
        });

        const map: TargetMap = {};
        for (const m of g.members) {
          map[m.id] = {
            ...m.base,
            x: round2(m.base.x + (dx / canvasW) * 100),
            y: round2(m.base.y + (dy / canvasH) * 100),
          };
        }
        publish(map);
        return;
      }

      if (g.kind === "move") {
        const dxPx = (e.clientX - g.startX) / zoom;
        const dyPx = (e.clientY - g.startY) / zoom;
        const moved: Box = { ...g.box, left: g.box.left + dxPx, top: g.box.top + dyPx };

        // 吸附：其他元素 + 画布边线/中线/安全区。指针越靠近，越容易被"拉齐"
        const others = boxesRef.current.filter((b) => b.id !== g.id && !lowRef.current.includes(b.id));
        const snap = computeSnap(moved, canvasW, canvasH, others, zoom);
        const finalBox: Box = { ...moved, left: moved.left + snap.dx, top: moved.top + snap.dy };

        setGuides(snap.guides);
        setDragState({
          id: g.id,
          out: isOutOfCanvas(finalBox, canvasW, canvasH),
          unsafe: isUnsafe(finalBox, canvasW, canvasH),
        });

        const next = {
          ...g.base,
          x: round2(g.base.x + ((dxPx + snap.dx) / canvasW) * 100),
          y: round2(g.base.y + ((dyPx + snap.dy) / canvasH) * 100),
        };
        publish({ [g.id]: next });
        return;
      }

      const canvas = canvasRef.current;
      const rect = canvas?.getBoundingClientRect();
      const originX = (rect?.left ?? 0) + g.cx * zoom;
      const originY = (rect?.top ?? 0) + g.cy * zoom;
      const dx = e.clientX - originX;
      const dy = e.clientY - originY;

      if (g.kind === "rotate") {
        // Shift 吸附到 15 度，做整齐的斜切排版时很省事
        const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
        let rot = g.base.rotate + (angle - g.startAngle);
        if (e.shiftKey) rot = Math.round(rot / 15) * 15;
        publish({ [g.id]: { ...g.base, rotate: Number(rot.toFixed(2)) } });
        return;
      }

      if (g.kind === "scale") {
        const dist = Math.hypot(dx, dy) || 1;
        const scale = Math.min(4, Math.max(0.2, (g.base.scale * dist) / g.startDist));
        publish({ [g.id]: { ...g.base, scale: Number(scale.toFixed(3)) } });
        return;
      }

      if (g.kind === "group-rotate") {
        // 整体旋转：成员角度加同一个 delta，位置绕整体中心转同样的角度
        const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
        let delta = angle - g.startAngle;
        if (e.shiftKey) delta = Math.round(delta / 15) * 15;
        const rad = (delta * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);

        const map: TargetMap = {};
        for (const m of g.members) {
          const rx = m.dx * cos - m.dy * sin;
          const ry = m.dx * sin + m.dy * cos;
          map[m.id] = {
            ...m.base,
            x: round2(m.base.x + ((rx - m.dx) / canvasW) * 100),
            y: round2(m.base.y + ((ry - m.dy) / canvasH) * 100),
            rotate: round2(m.base.rotate + delta),
          };
        }
        publish(map);
        return;
      }

      // 多选整体等比缩放：位移按同一比例映射，尺寸按各自 clamp 后的倍数
      const dist = Math.hypot(dx, dy) || 1;
      const k = Math.min(8, Math.max(0.1, dist / g.startDist));
      const map: TargetMap = {};
      for (const m of g.members) {
        const scale = Math.min(4, Math.max(0.2, m.base.scale * k));
        map[m.id] = {
          ...m.base,
          x: round2(m.base.x + ((m.dx * k - m.dx) / canvasW) * 100),
          y: round2(m.base.y + ((m.dy * k - m.dy) / canvasH) * 100),
          scale: Number(scale.toFixed(3)),
        };
      }
      publish(map);
    };

    /**
     * 高频指针事件（鼠标常见 120~240Hz）如果每个都跑一遍
     * 「computeSnap → setGuides/setDragState → onPreview → setDraft → Player 全量重渲染」，
     * 会远超屏幕刷新率，手感就是"拖不动 / 慢半拍"（自由画布元素多时尤其明显）。
     * 这里按**动画帧**合帧：一帧内只取最新位置算一次，松手前再 flush 一次。
     */
    let pendingMove: PointerEvent | null = null;
    let rafId = 0;
    const schedule = (e: PointerEvent) => {
      pendingMove = e;
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        const ev = pendingMove;
        pendingMove = null;
        if (ev) applyMove(ev);
      });
    };
    const flushMove = () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      const ev = pendingMove;
      pendingMove = null;
      if (ev) applyMove(ev);
    };

    const onUp = () => {
      // 先把队列里最后一次移动落地，否则松手落点会比鼠标少一帧（视觉上"甩尾"）
      flushMove();
      const g = gesture.current;
      if (!g) return;
      gesture.current = null;
      setGuides([]);
      setDragState(null);
      // 松手时才落库：一次拖动 = 一步撤销
      const current = lastPreview.current;
      lastPreview.current = null;
      if (current) onCommit(current);
    };

    window.addEventListener("pointermove", schedule);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", schedule);
      window.removeEventListener("pointerup", onUp);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [zoom, canvasW, canvasH, canvasRef, onPreview, onCommit]);

  const selected = useMemo(() => new Set(selection), [selection]);

  if (!sceneId) return null;

  const single = selection.length === 1;
  const safeInset = insetOf(canvasW, canvasH);

  return (
    <div className="edit-layer">
      {/* 安全区辅助线：常显开关打开或正在拖动时出现 */}
      {showSafe || dragState ? (
        <div
          className="edit-safe"
          style={{
            left: safeInset,
            top: safeInset,
            width: Math.max(0, canvasW - safeInset * 2),
            height: Math.max(0, canvasH - safeInset * 2),
          }}
        />
      ) : null}

      {/* 横向/纵向吸附参考线 */}
      {guides.map((g, i) =>
        g.axis === "x" ? (
          <div key={`gx-${i}`} className="edit-guide is-v" style={{ left: g.pos }} />
        ) : (
          <div key={`gy-${i}`} className="edit-guide is-h" style={{ top: g.pos }} />
        ),
      )}

      {boxes.map((box) => {
        const isSelected = selected.has(box.id);
        const active = isSelected && single;
        const dragging = dragState?.id === box.id;
        const low = lowIds?.includes(box.id) ?? false;
        return (
          <div
            key={box.id}
            className={[
              "edit-box",
              isSelected ? "is-selected" : "",
              active ? "is-active" : "",
              low ? "is-low" : "",
              showOutlines ? "" : "is-hidden",
              dragging && dragState?.out ? "is-out" : "",
              dragging && !dragState?.out && dragState?.unsafe ? "is-unsafe" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
            data-box-id={box.id}
            onPointerDown={(e) => onPointerDown(e, box, "move")}
            title="拖动移动；Shift 点击加选；圆点旋转，角点缩放"
          >
            {active ? (
              <>
                <span
                  className="edit-handle rotate"
                  onPointerDown={(e) => onPointerDown(e, box, "rotate")}
                />
                <span className="edit-handle scale" onPointerDown={(e) => onPointerDown(e, box, "scale")} />
              </>
            ) : null}
          </div>
        );
      })}

      {/* 多选：整体包围盒 + 顶部整体旋转手柄 + 右下角整体缩放手柄；拖任一选中元素即整体移动 */}
      {groupBox && showOutlines ? (
        <div
          className={[
            "edit-group",
            dragState?.id === GROUP_DRAG_ID && dragState.out ? "is-out" : "",
            dragState?.id === GROUP_DRAG_ID && !dragState.out && dragState.unsafe ? "is-unsafe" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          style={{
            left: groupBox.left,
            top: groupBox.top,
            width: groupBox.width,
            height: groupBox.height,
          }}
          data-group-box
        >
          <span
            className="edit-handle group-rotate"
            title="拖动整体旋转（按住 Shift 吸附 15°）"
            data-group-rotate
            onPointerDown={(e) => startGroupRotate(e, groupBox)}
          />
          <span
            className="edit-handle group-scale"
            title="拖动整体等比缩放"
            data-group-scale
            onPointerDown={(e) => startGroupScale(e, groupBox)}
          />
        </div>
      ) : null}

      {marquee ? (
        <div
          className="edit-marquee"
          style={{
            left: marquee.left,
            top: marquee.top,
            width: marquee.width,
            height: marquee.height,
          }}
        />
      ) : null}

      {dragState?.out ? (
        <div className="edit-warn is-hard" data-warn="out">
          超出画面
        </div>
      ) : dragState?.unsafe ? (
        <div className="edit-warn" data-warn="unsafe">
          超出安全区
        </div>
      ) : null}
    </div>
  );
};
