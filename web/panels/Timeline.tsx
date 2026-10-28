import React, { useEffect, useMemo, useRef, useState } from "react";
import type { PlayerRef } from "@remotion/player";
import type { Project, Scene } from "@shared/schema";
import { sceneSpans, totalDuration } from "@shared/schema";
import { useDoc } from "../store";
import { setLocalPref } from "../uiPrefs";
import { uploadAsset } from "../apiClient";
import { PX_PER_FRAME } from "./SceneTimeline";
import { SceneTimeline } from "./SceneTimeline";
import { askConfirm } from "../ui";
import type { Op } from "@shared/ops";
import { EyeOffIcon, EyeOnIcon, SoundOffIcon, SoundOnIcon } from "./tlIcons";
import { Wave } from "./Waveform";
import { CtxMenu } from "./CtxMenu";
import { elementFromLibrary } from "@shared/elementLibrary";
import { assetIdOf, assetToElement, isAssetLibraryId } from "@shared/assetLibrary";
import { MIN_SCENE_FRAMES } from "@shared/sceneMetas";
import {
  EFFECT_CREATABLE,
  effectDefaults,
  effectLabel,
  type EffectType,
} from "@shared/effects";

type Props = {
  playerRef: React.RefObject<PlayerRef | null>;
};

/** 左侧轨道头宽度 / 顶部标尺高度 / 单条轨道高度 */
const HEAD_W = 100;
const RULER_H = 22;
const LANE_H = 34;
/**
 * 场景最短时长。**和 ops 层共用同一个常量**（`MIN_SCENE_FRAMES`）——
 * 以前这里写 15、ops 按版式的 min（30/45/60）夹，拖短了松手就被弹回去。
 */
const MIN_SCENE_DUR = MIN_SCENE_FRAMES;

/**
 * 多轨时间轴（朝剪映那种用法靠）：
 *  - 场景轨：拖拽排序、右边缘拉伸改时长、点选
 *  - 音乐轨：整条背景音乐，轨道头可清除
 *  - 音效轨：每条一个轨道，块可拖动改起点、右边缘拉伸改时长、轨道头删除
 *  - 横向滚动 + 缩放（Ctrl/Alt + 滚轮，或右上角加减）
 *  - 播放头：点轨道区 / 拖播放头 seek
 */
export const Timeline: React.FC<Props> = ({ playerRef }) => {
  const project = useDoc((s) => s.project);
  const selectedId = useDoc((s) => s.selectedId);
  const select = useDoc((s) => s.select);
  const apply = useDoc((s) => s.apply);
  const notify = useDoc((s) => s.notify);
  const selectEffect = useDoc((s) => s.selectEffect);
  const selectedEffect = useDoc((s) => s.selectedEffect);
  /** 「＋ 特效」的类型选择菜单（点按钮弹出，选完直接建好并选中） */
  const [fxMenu, setFxMenu] = useState<{ x: number; y: number } | null>(null);

  const [frame, setFrame] = useState(0);
  const [ppf, setPpf] = useState(PX_PER_FRAME);
  /**
   * 场景块拉伸手柄：左右各一个。
   *  - 右边缘：改时长，起点不动（原来的行为）
   *  - 左边缘：起点跟着走、右端钉住 → 时长反向变化（等于「裁头 / 补头」）
   */
  const [resizeScene, setResizeScene] = useState<{
    id: string;
    edge: "left" | "right";
    startX: number;
    baseStart: number;
    baseDur: number;
    baseTrack: number;
  } | null>(null);
  const [scenePreview, setScenePreview] = useState<{ start: number; dur: number } | null>(null);
  /**
   * 松手之后的「钉住」：块先停在用户放下的位置，等文档追上（或超时）才交还给 project。
   * 没有它，松手那一瞬间 project 还是旧值 → 块跳回原位 → 服务端返回再跳回来，
   * 看起来就是「放开鼠标一闪一闪」。
   */
  const [scenePin, setScenePin] = useState<{
    id: string;
    start?: number;
    dur?: number;
    track?: number;
  } | null>(null);
  /**
   * 场景块拖动 = **改时间位置 / 换轨道**（不再是把块拖来拖去排序 —— 排序在左侧场景列表里做）。
   * 拖动过程只改本地预览，松手才发一条 move_scene = 一步撤销。
   */
  const [sceneDrag, setSceneDrag] = useState<{
    id: string;
    startX: number;
    startY: number;
    fromStart: number;
    fromTrack: number;
  } | null>(null);
  const [sceneDrop, setSceneDrop] = useState<{
    id: string;
    start: number;
    track: number;
    /** 吸附到的帧号（画参考线用），没吸附就是 null */
    snap: number | null;
  } | null>(null);
  const sceneDropRef = useRef<{ start: number; track: number } | null>(null);
  /**
   * 主轨内拖动 = **重排**（不是改绝对时间）。
   *
   * 主轨上的块本来就首尾相接，硬按"绝对时间"放，落点必然与某块重叠，
   * 而 op 层不允许同轨重叠 → 一路往后推，最后落点永远在最末尾（用户实测就是这个现象）。
   * 所以主轨拖动改成"按落点算插入位置、其他块让位"，松手发一条 reorder_scenes。
   */
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  /** 松手到 reorder 落库之间，用这份顺序顶住，否则整条轨道会闪一下 */
  const [orderPin, setOrderPin] = useState<string[] | null>(null);
  /** 拖动开始时的 lane 区 rect：每帧 getBoundingClientRect 会强制整树 layout，是卡顿主因 */
  const dragRectRef = useRef<DOMRect | null>(null);
  /**
   * 拖动的"活"数据。拖动 effect **只依赖 sceneDrag**，其余一律从这里读。
   * 原因：重排会改 spans → baseRows 每次都是新数组引用 → effect 被重建 → 闭包里的
   * lastOrder / 落点全部丢失，松手时就会"什么都没发生"（实测踩过）。
   */
  const dragLiveRef = useRef<{
    spans: { id: string; start: number; dur: number; end: number; track: number }[];
    baseRows: number[];
    project: Project | null;
    ppf: number;
    apply: (ops: Op[]) => Promise<unknown>;
  } | null>(null);
  const [sfxDrag, setSfxDrag] = useState<{
    id: string;
    mode: "move" | "resize";
    startX: number;
    startFrom: number;
    startDur: number;
  } | null>(null);
  const [sfxPreview, setSfxPreview] = useState<{ id: string; from: number; dur: number } | null>(null);
  /** 音效块松手后的钉住，和 scenePin 同理：不然松手那一瞬会跳回旧位置再跳回来 */
  const [sfxPin, setSfxPin] = useState<{ id: string; from: number; dur: number } | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [timelineH, setTimelineH] = useState(() => {
    const saved = Number(localStorage.getItem("rms:timelineH"));
    const max = Math.max(200, window.innerHeight - 320);
    return Number.isFinite(saved) && saved >= 120 ? Math.min(max, saved) : 240;
  });
  const [resizingTimeline, setResizingTimeline] = useState(false);
  const tlDragRef = useRef({ startY: 0, startH: 0 });
  const [sceneTlH, setSceneTlH] = useState(() => {
    const saved = Number(localStorage.getItem("rms:sceneTlH"));
    const max = Math.min(700, Math.max(80, window.innerHeight - 260));
    return Number.isFinite(saved) ? Math.min(max, Math.max(40, saved)) : 150;
  });
  const [splitDrag, setSplitDrag] = useState<{ startY: number; startH: number } | null>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [sceneSel, setSceneSel] = useState<string[]>([]);
  const [splitTarget, setSplitTarget] = useState<{ sceneId: string; at: number } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    sceneId?: string;
    frame?: number;
    /** 特效块的右键：kind = "fx" */
    kind?: "fx";
    effectId?: string;
    name?: string;
  } | null>(null);

  const lanesRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const scenePreviewRef = useRef<{ start: number; dur: number } | null>(null);
  const sfxPreviewRef = useRef<{ from: number; dur: number } | null>(null);

  /** 特效块：拖动 / 拉伸（与音效轨同一套手势机；apply 是异步的，松手先钉住再落库） */
  const [fxDrag, setFxDrag] = useState<{
    id: string;
    mode: "move" | "resize";
    startX: number;
    startFrom: number;
    startDur: number;
  } | null>(null);
  const [fxPreview, setFxPreview] = useState<{ id: string; from: number; dur: number } | null>(null);
  const [fxPin, setFxPin] = useState<{ id: string; from: number; dur: number } | null>(null);
  const fxPreviewRef = useRef<{ from: number; dur: number } | null>(null);
  const splitSceneRef = useRef<(() => void) | null>(null);
  /** 拖动时要读播放头，但不能把 frame 放进 effect 依赖（每帧重挂监听） */
  const frameRef = useRef(0);

  /**
   * 时间轴排布：**唯一来源是 sceneSpans**（和渲染同一份数学）。
   *
   * 本地覆盖有两个来源，优先级：拖动/拉伸中的预览 → 松手后的钉住。
   * 两者都只覆盖这一幕，后续场景照常按累加跟着让位（右拉时实时右移的手感就是它给的）。
   */
  const spans = useMemo(() => {
    if (!project) return [] as { id: string; start: number; dur: number; end: number; track: number }[];
    // 顺序覆盖：拖动重排 / 松手等 reorder 落库。主轨是"顺序即时间"，改顺序就等于改位置
    const order = dragOrder ?? orderPin;
    let base = project.scenes;
    if (order && order.length) {
      const byId = new Map(project.scenes.map((s) => [s.id, s]));
      const ordered: Scene[] = [];
      for (const id of order) {
        const hit = byId.get(id);
        if (hit) ordered.push(hit);
      }
      // 兜底：order 里没提到的（理论上不该有）按原顺序补在后面
      for (const s of project.scenes) if (!order.includes(s.id)) ordered.push(s);
      base = ordered;
    }
    const scenes = base.map((s) => {
      let next = s;
      // 重排预览时主轨要压实：主轨是"顺序即时间"，钉死的起点留着就会和邻居叠在一起
      if (order && (s.track ?? 0) === 0 && s.start !== undefined) {
        next = { ...next, start: undefined };
      }
      if (resizeScene && scenePreview && resizeScene.id === s.id) {
        next = { ...next, start: scenePreview.start, durationInFrames: scenePreview.dur };
      }
      if (scenePin && scenePin.id === s.id) {
        next = { ...next };
        if (scenePin.start != null) next.start = scenePin.start;
        if (scenePin.dur != null) next.durationInFrames = scenePin.dur;
        if (scenePin.track != null) next.track = scenePin.track;
      }
      return next;
    });
    return sceneSpans(scenes);
  }, [project, resizeScene, scenePreview, scenePin, dragOrder, orderPin]);

  // 总时长按「最靠后的一帧」算：左边缘拉伸会同时改起点和时长，累加已经不成立了
  const total = project ? Math.max(1, totalDuration(project), ...spans.map((s) => s.end)) : 1;
  const totalRef = useRef(total);
  totalRef.current = total;
  const fps = project?.fps ?? 30;
  const width = Math.max(260, Math.round(total * ppf));
  const offsets = useMemo(() => spans.map((s) => s.start), [spans]);
  /**
   * 按 id 查 span。
   *
   * **不要用 spans[i] 配 project.scenes[i]**：主轨重排时 spans 是按新顺序算的，
   * 两份数组的下标会错位 —— 表现为"拖动时所有块整体移位"（实测抓到过）。
   */
  const spanById = useMemo(() => new Map(spans.map((s) => [s.id, s])), [spans]);

  /** 已有的轨道号（升序）；拖到最下面空白处可以新建一条 */
  const baseRows = useMemo(() => {
    const set = new Set<number>([0]);
    for (const s of spans) set.add(s.track);
    return [...set].sort((a, b) => a - b);
  }, [spans]);
  /** 渲染用：正在拖过去的新轨道也要立刻画出来 */
  const rows = useMemo(
    () => (sceneDrop && !baseRows.includes(sceneDrop.track) ? [...baseRows, sceneDrop.track].sort((a, b) => a - b) : baseRows),
    [baseRows, sceneDrop],
  );

  /**
   * 钉住的放手时机：文档追上（start / dur / track 都对上）就交还给 project。
   * 万一同轨吸附把落点改了（op 层会推块），2 秒后强制放手 —— 否则块会永远停在错误位置。
   */
  useEffect(() => {
    if (!scenePin) return;
    const sc = project?.scenes.find((x) => x.id === scenePin.id);
    if (!sc) {
      setScenePin(null);
      return;
    }
    const matched =
      (scenePin.start == null || sc.start === scenePin.start) &&
      (scenePin.dur == null || sc.durationInFrames === scenePin.dur) &&
      (scenePin.track == null || (sc.track ?? 0) === scenePin.track);
    if (matched) {
      setScenePin(null);
      return;
    }
    const t = setTimeout(() => setScenePin(null), 2000);
    return () => clearTimeout(t);
  }, [project, scenePin]);

  /** 音效块钉住的放手时机（同上） */
  useEffect(() => {
    if (!sfxPin) return;
    const clip = project?.audioTracks?.find((x) => x.id === sfxPin.id);
    if (!clip) {
      setSfxPin(null);
      return;
    }
    const matched =
      clip.from === sfxPin.from &&
      (clip.durationInFrames == null || clip.durationInFrames === sfxPin.dur);
    if (matched) {
      setSfxPin(null);
      return;
    }
    const t = setTimeout(() => setSfxPin(null), 2000);
    return () => clearTimeout(t);
  }, [project, sfxPin]);

  /** 特效块钉住的放手时机（同上） */
  useEffect(() => {
    if (!fxPin) return;
    const clip = project?.effects?.find((x) => x.id === fxPin.id);
    if (!clip) {
      setFxPin(null);
      return;
    }
    if (clip.from === fxPin.from && clip.durationInFrames === fxPin.dur) {
      setFxPin(null);
      return;
    }
    const t = setTimeout(() => setFxPin(null), 2000);
    return () => clearTimeout(t);
  }, [project, fxPin]);

  /** 重排钉住：reorder_scenes 落库（顺序对上）就交还给 project */
  useEffect(() => {
    if (!orderPin) return;
    const now = project?.scenes.map((s) => s.id) ?? [];
    if (now.length === orderPin.length && now.every((id, i) => id === orderPin[i])) {
      setOrderPin(null);
      return;
    }
    const t = setTimeout(() => setOrderPin(null), 2000);
    return () => clearTimeout(t);
  }, [project, orderPin]);

  // 播放头跟随（rAF 直接问 player，不触发文档重渲染）
  // 时间轴高度：写到 CSS 变量，记在 localStorage + 服务端
  useEffect(() => {
    document.documentElement.style.setProperty("--timeline-h", `${timelineH}px`);
    setLocalPref("rms:timelineH", String(timelineH));
  }, [timelineH]);

  // 小/大时间轴之间的分隔条
  useEffect(() => {
    document.documentElement.style.setProperty("--scene-tl-h", `${sceneTlH}px`);
    setLocalPref("rms:sceneTlH", String(sceneTlH));
  }, [sceneTlH]);

  useEffect(() => {
    if (!splitDrag) return;
    const onMove = (e: MouseEvent) => {
      const max = Math.max(120, window.innerHeight - 260 - sceneTlH);
      const h = Math.min(max, Math.max(120, splitDrag.startH + (splitDrag.startY - e.clientY)));
      setTimelineH(Math.round(h));
    };
    const onUp = () => setSplitDrag(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [splitDrag, sceneTlH]);

  useEffect(() => {
    if (!resizingTimeline) return;
    const onMove = (e: MouseEvent) => {
      const max = Math.max(40, window.innerHeight - 260 - timelineH);
      const h = Math.min(max, Math.max(40, tlDragRef.current.startH - (e.clientY - tlDragRef.current.startY)));
      setSceneTlH(Math.round(h));
    };
    const onUp = () => setResizingTimeline(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [resizingTimeline, timelineH]);

  // 帧更新用 Player 的 frameupdate 事件（seek/播放都会派发）：
  // rAF 在页面不可见时会被浏览器暂停，时间轴就会停在 0 帧
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | null = null;
    const onFrame = (data: { detail: { frame: number } }) => {
      const f = data.detail?.frame;
      if (typeof f === "number") setFrame(f);
    };
    const bind = () => {
      if (disposed) return;
      const p = playerRef.current;
      if (!p) {
        setTimeout(bind, 120);
        return;
      }
      const now = p.getCurrentFrame?.();
      if (typeof now === "number") setFrame(now);
      p.addEventListener("frameupdate", onFrame);
      cleanup = () => p.removeEventListener("frameupdate", onFrame);
    };
    bind();
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [playerRef]);


  frameRef.current = frame;

  // 滚轮：Ctrl 缩放、Shift 左右滚动、普通滚轮上下滚动
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        const fit = el.clientWidth / Math.max(1, totalRef.current);
        const minPpf = Math.min(0.2, fit);
        setPpf((p) => Math.min(14, Math.max(minPpf, Number((p * factor).toFixed(3)))));
        return;
      }
      if (e.shiftKey) {
        const max = el.scrollWidth - el.clientWidth;
        if (max <= 0) return;
        e.preventDefault();
        el.scrollLeft = Math.max(0, Math.min(max, el.scrollLeft + e.deltaY));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // 场景拉伸
  useEffect(() => {
    if (!resizeScene) return;
    const onMove = (e: MouseEvent) => {
      const delta = Math.round((e.clientX - resizeScene.startX) / ppf);
      if (resizeScene.edge === "right") {
        const dur = Math.max(MIN_SCENE_DUR, resizeScene.baseDur + delta);
        scenePreviewRef.current = { start: resizeScene.baseStart, dur };
      } else {
        // 左边缘：右端钉住，起点跟着指针走 → 时长反向变化（裁头 / 补头）
        const end = resizeScene.baseStart + resizeScene.baseDur;
        const start = Math.min(
          end - MIN_SCENE_DUR,
          Math.max(0, resizeScene.baseStart + delta),
        );
        scenePreviewRef.current = { start, dur: end - start };
      }
      setScenePreview(scenePreviewRef.current);
    };
    const onUp = async () => {
      const pv = scenePreviewRef.current;
      const { id, baseStart, baseDur, baseTrack } = resizeScene;
      scenePreviewRef.current = null;
      setResizeScene(null);
      setScenePreview(null);
      if (!pv) return;
      const startChanged = pv.start !== baseStart;
      const durChanged = pv.dur !== baseDur;
      if (!startChanged && !durChanged) return;
      // 左边缘会同时动起点和时长：两个 op 放进同一批 = 一步撤销
      const ops: Op[] = [];
      if (startChanged) {
        ops.push({ op: "move_scene", sceneId: id, start: pv.start, track: baseTrack });
      }
      if (durChanged) {
        ops.push({ op: "set_scene_timing", sceneId: id, durationInFrames: pv.dur });
      }
      // 先钉住再落库，松手那一刻不跳回旧尺寸
      setScenePin({
        id,
        ...(startChanged ? { start: pv.start } : {}),
        ...(durChanged ? { dur: pv.dur } : {}),
      });
      await apply(ops);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [resizeScene, ppf, apply]);

  /**
   * 场景块拖动。
   *
   * 两种语义（按落点所在轨道分）：
   *  - **主轨内 = 重排**：主轨本来就首尾相接，"按绝对时间放"必然和邻居撞上，
   *    而 op 层不允许同轨重叠 → 一路往后推，落点永远在最末尾（用户实测就是这个）。
   *    所以主轨只算"插到第几个位置"，其余块让位，松手发一条 reorder_scenes。
   *  - **非主轨 = 自由定位**：像素换算成帧，带 8px 吸附，松手发 move_scene。
   *
   * 拖动卡的三成原因都在这里：
   *  1. lane 区的 rect **只在按下时量一次** —— 每帧 getBoundingClientRect 会强制整树 layout；
   *  2. mousemove 用 rAF 合帧，一帧最多算一次；
   *  3. 位置变化**直接写块的 style/dataset，不 setState** —— 每帧重渲染整条时间轴是另一半。
   *     只有「换轨道 / 吸附点变化 / 主轨插入位置变化」才让 React 出手。
   */
  dragLiveRef.current = { spans, baseRows, project, ppf, apply };

  useEffect(() => {
    if (!sceneDrag) return;
    const drag = sceneDrag;
    const lanes = lanesRef.current;
    if (!lanes) return;
    dragRectRef.current = lanes.getBoundingClientRect();

    /** 拖动开始时的快照：主轨算插入位置要用"原始排列"，不能用自己的预览结果 */
    const live = dragLiveRef.current;
    const projSnap = live?.project;
    if (!live || !projSnap) return;
    const { spans: baseline, baseRows: rowsSnap, ppf: ppfSnap } = live;
    let raf = 0;
    let last: MouseEvent | null = null;
    let lastTrack = drag.fromTrack;
    let lastSnap: number | null = null;
    let lastOrder: string[] | null = null;
    let freeDrop: { start: number; track: number } | null = null;

    const writeBlock = (id: string, start: number) => {
      const el = lanes.querySelector<HTMLElement>(`[data-scene-block="${id}"]`);
      if (!el) return;
      el.style.left = `${start * ppfSnap}px`;
      el.dataset.start = String(start);
    };

    const frame = () => {
      raf = 0;
      const e = last;
      const rect = dragRectRef.current;
      if (!e || !rect) return;
      const dragged = baseline.find((x) => x.id === drag.id);
      const dur = dragged?.dur ?? 1;

      // ── 目标轨道（lane 区顶部 + 标尺高 = 第 0 行）──
      const rowsTop = rect.top + RULER_H;
      const pos = (e.clientY - rowsTop) / LANE_H;
      let track: number;
      if (pos < 0) {
        track = rowsSnap[0];
      } else if (pos >= rowsSnap.length) {
        // 拖到最后一行下方 14px 以外 → 新建一条轨道（留缓冲，手抖不会多出一条）
        const overflow = e.clientY - (rowsTop + rowsSnap.length * LANE_H);
        const lastRow = rowsSnap[rowsSnap.length - 1];
        track = overflow > 14 ? lastRow + 1 : lastRow;
      } else {
        track = rowsSnap[Math.floor(pos)];
      }
      // 垂直死区：竖着几乎没动就保持原轨道，否则水平拖动会因行数变化来回抖
      if (Math.abs(e.clientY - drag.startY) < LANE_H * 0.6) track = drag.fromTrack;

      const raw = drag.fromStart + (e.clientX - drag.startX) / ppfSnap;

      // ── 主轨内：重排 ──
      if (track === 0 && drag.fromTrack === 0) {
        const others = baseline
          .filter((s) => s.track === 0 && s.id !== drag.id)
          .sort((a, b) => a.start - b.start);
        // 用"块中心"判断插到谁前面：鼠标过中点才换位，不会在边界上反复跳
        const center = raw + dur / 2;
        let k = others.length;
        for (let j = 0; j < others.length; j++) {
          if (center < others[j].start + others[j].dur / 2) {
            k = j;
            break;
          }
        }
        const restIds = projSnap.scenes.filter((s) => s.id !== drag.id).map((s) => s.id);
        const mainIds = projSnap.scenes
          .filter((s) => s.id !== drag.id && (s.track ?? 0) === 0)
          .map((s) => s.id);
        const insertAt =
          k < mainIds.length
            ? restIds.indexOf(mainIds[k])
            : mainIds.length
              ? restIds.indexOf(mainIds[mainIds.length - 1]) + 1
              : restIds.length;
        const nextOrder = [...restIds];
        nextOrder.splice(insertAt, 0, drag.id);
        if (!lastOrder || nextOrder.join() !== lastOrder.join()) {
          lastOrder = nextOrder;
          setDragOrder(nextOrder);
        }
        // 主轨模式下块就显示在"插入位置"（不跟鼠标）：
        // 直写 style.left 会和 React 的 left 打架 —— 松手时如果 React 认为样式没变，
        // 就不会把直写的值改回来，块会停在错误的横坐标上（实测出现 400px 重叠）。
        freeDrop = null;
        return;
      }

      // ── 非主轨：自由定位 ──
      if (lastOrder) {
        // 从主轨拖到别的轨：把重排预览撤掉，回到"绝对位置"
        lastOrder = null;
        setDragOrder(null);
      }
      const cands: number[] = [0, Math.round(frameRef.current)];
      for (const sp of baseline) {
        if (sp.id === drag.id || sp.track !== track) continue;
        cands.push(sp.start, sp.end);
      }
      let start = Math.max(0, Math.round(raw));
      let snap: number | null = null;
      let best = 8; // px
      for (const c of cands) {
        const v = Math.max(0, Math.round(c));
        const d = Math.abs(v - raw) * ppfSnap;
        if (d <= best) {
          best = d;
          snap = v;
        }
      }
      if (snap != null) start = snap;

      freeDrop = { start, track };
      sceneDropRef.current = { start, track };
      writeBlock(drag.id, start);
      // 换轨道 / 吸附点变化才走 React：块要换行、参考线要跟上
      if (track !== lastTrack || snap !== lastSnap) {
        lastTrack = track;
        lastSnap = snap;
        setSceneDrop({ id: drag.id, start, track, snap });
      }
    };

    const onMove = (e: MouseEvent) => {
      last = e;
      if (!raf) raf = requestAnimationFrame(frame);
    };

    const onUp = () => {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      const order = lastOrder;
      const drop = freeDrop;
      dragRectRef.current = null;
      sceneDropRef.current = null;
      setSceneDrag(null);
      setSceneDrop(null);
      setDragOrder(null);

      // ① 主轨重排：顺序没变就什么都不做（避免白记一步撤销）
      if (order) {
        const before = projSnap.scenes.map((s) => s.id);
        if (order.join() !== before.join()) {
          setOrderPin(order);
          void apply([
            { op: "reorder_scenes", sceneIds: order },
            // 主轨上可能有用「对齐到播放头」钉过起点的块，不压实就会和邻居重叠
            { op: "compact_main_track" },
          ]);
        }
        return;
      }

      // ② 自由定位
      if (!drop) return;
      const sp = baseline.find((x) => x.id === drag.id);
      const changed = !sp || drop.start !== sp.start || drop.track !== sp.track;
      if (!changed) return;
      // 先钉住再落库：松手 → 服务端返回这段时间里，块必须停在放下的位置
      setScenePin({ id: drag.id, start: drop.start, track: drop.track });
      void apply([
        { op: "move_scene", sceneId: drag.id, start: drop.start, track: drop.track },
      ]);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // 只依赖 sceneDrag：其余全部走 dragLiveRef，拖动中不重建（否则闭包状态会丢）
  }, [sceneDrag]);

  // 音效块拖动 / 拉伸
  useEffect(() => {
    if (!sfxDrag) return;
    const onMove = (e: MouseEvent) => {
      const delta = (e.clientX - sfxDrag.startX) / ppf;
      const next =
        sfxDrag.mode === "move"
          ? {
              from: Math.max(0, Math.min(total - 1, Math.round(sfxDrag.startFrom + delta))),
              dur: sfxDrag.startDur,
            }
          : {
              from: sfxDrag.startFrom,
              dur: Math.max(6, Math.round(sfxDrag.startDur + delta)),
            };
      sfxPreviewRef.current = next;
      setSfxPreview({ id: sfxDrag.id, ...next });
    };
    const onUp = async () => {
      const next = sfxPreviewRef.current;
      const id = sfxDrag.id;
      sfxPreviewRef.current = null;
      setSfxDrag(null);
      setSfxPreview(null);
      if (next) {
        // 先钉住再落库，松手那一刻不跳回旧位置
        setSfxPin({ id, ...next });
        await apply([
          {
            op: "update_audio_track",
            trackId: id,
            patch: { from: next.from, durationInFrames: next.dur },
          },
        ]);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [sfxDrag, ppf, total, apply]);

  // 特效块拖动 / 拉伸（与音效块同一套手势机，落库走 update_effect）
  useEffect(() => {
    if (!fxDrag) return;
    const onMove = (e: MouseEvent) => {
      const delta = (e.clientX - fxDrag.startX) / ppf;
      const next =
        fxDrag.mode === "move"
          ? {
              from: Math.max(0, Math.min(total - 1, Math.round(fxDrag.startFrom + delta))),
              dur: fxDrag.startDur,
            }
          : {
              from: fxDrag.startFrom,
              dur: Math.max(4, Math.round(fxDrag.startDur + delta)),
            };
      fxPreviewRef.current = next;
      setFxPreview({ id: fxDrag.id, ...next });
    };
    const onUp = async () => {
      const next = fxPreviewRef.current;
      const id = fxDrag.id;
      fxPreviewRef.current = null;
      setFxDrag(null);
      setFxPreview(null);
      if (next) {
        setFxPin({ id, ...next });
        await apply([
          { op: "update_effect", effectId: id, patch: { from: next.from, durationInFrames: next.dur } },
        ]);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [fxDrag, ppf, total, apply]);

  const seekAt = (clientX: number) => {    const el = lanesRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const f = Math.round(((clientX - r.left) / Math.max(1, width)) * (total - 1));
    playerRef.current?.seekTo(Math.max(0, Math.min(total - 1, f)));
  };

  // 拖播放头 seek
  useEffect(() => {
    if (!scrubbing) return;
    const onMove = (e: MouseEvent) => seekAt(e.clientX);
    const onUp = () => setScrubbing(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // seekAt 依赖 ref/width/total，这里按值重建即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrubbing, width, total]);


  const ticks = useMemo(() => {
    const step = ppf > 8 ? 15 : ppf > 4 ? 30 : 60;
    const out: number[] = [];
    for (let f = 0; f <= total; f += step) out.push(f);
    return out;
  }, [total]);

  if (!project) return null;

  const allElements = project.scenes.flatMap((sc) =>
    (sc.elements ?? []).map((el) => ({ sceneId: sc.id, el })),
  );
  const allElementsHidden =
    allElements.length > 0 && allElements.every(({ el }) => el.hidden);
  const audioElements = allElements.filter(({ el }) => el.kind === "audio");
  const audioMutedNow =
    (!project.audio || project.audio.volume === 0) &&
    (project.audioTracks ?? []).every((t) => t.volume === 0) &&
    audioElements.every(({ el }) => el.muted);
  const toggleAllElementsHidden = () => {
    const next = !allElementsHidden;
    if (!allElements.length) return;
    void apply(
      allElements.map(({ sceneId, el }) => ({
        op: "update_element" as const,
        sceneId,
        elementId: el.id,
        patch: { hidden: next },
      })),
    );
  };
  const toggleAllAudioMuted = () => {
    const next = !audioMutedNow;
    const ops: Op[] = [];
    if (project.audio) {
      ops.push({ op: "set_audio", audio: { ...project.audio, volume: next ? 0 : 1 } });
    }
    for (const t of project.audioTracks ?? []) {
      ops.push({ op: "update_audio_track", trackId: t.id, patch: { volume: next ? 0 : 1 } });
    }
    for (const { sceneId, el } of audioElements) {
      ops.push({ op: "update_element", sceneId, elementId: el.id, patch: { muted: next } });
    }
    if (ops.length) void apply(ops);
  };


  const tracks = project.audioTracks ?? [];
  const sceneTotal = totalDuration(project);

  /** 播放头所在的场景与场景内位置（分割用） */
  const idxNow = project.scenes.findIndex((x) => x.id === selectedId);
  const sceneNow = idxNow >= 0 ? project.scenes[idxNow] : null;
  const sceneOffsetNow = sceneNow ? (sceneSpans(project.scenes)[idxNow]?.start ?? 0) : 0;
  const localNow = sceneNow ? frame - sceneOffsetNow : 0;

  // S：在播放头处打开「分割框」（右键菜单里的分割同效）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "s" || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      if (sceneNow) {
        setSplitTarget({
          sceneId: sceneNow.id,
          at: Math.max(15, Math.min(sceneNow.durationInFrames - 15, Math.round(localNow))),
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sceneNow, localNow]);

  const canSplit = !!sceneNow && localNow >= 30 && sceneNow.durationInFrames - localNow >= 30;

  /** 在播放头处把当前场景切成两段（元素按起点归属前半/后半） */
  const duplicateSelectedScenes = () => {
    if (!project) return;
    const ids = project.scenes.filter((s) => sceneSel.includes(s.id)).map((s) => s.id);
    if (!ids.length) return;
    void apply(ids.map((id) => ({ op: "duplicate_scene" as const, sceneId: id })));
    setSceneSel([]);
  };

  const removeSelectedScenes = () => {
    if (!project) return;
    const ids = project.scenes.filter((s) => sceneSel.includes(s.id)).map((s) => s.id);
    if (!ids.length) return;
    askConfirm({
      title: `删除 ${ids.length} 个场景？`,
      message: "这些场景的文案、元素和时长都会一起删掉。",
      hint: "可以用 Ctrl+Z 撤销",
      confirmLabel: "删除场景",
      onConfirm: () => {
        void apply(ids.map((id) => ({ op: "remove_scene" as const, sceneId: id })));
        setSceneSel([]);
      },
    });
  };

  const startSplitLineDrag = (e: React.MouseEvent, idx: number) => {
    e.preventDefault();
    e.stopPropagation();
    const lanes = lanesRef.current;
    if (!lanes || !project) return;
    const rect = lanes.getBoundingClientRect();
    const scene = project.scenes[idx];
    if (!scene) return;
    const onMove = (ev: MouseEvent) => {
      const at = Math.round((ev.clientX - rect.left) / ppf) - offsets[idx];
      setSplitTarget({
        sceneId: scene.id,
        at: Math.max(15, Math.min(scene.durationInFrames - 15, at)),
      });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const splitSceneAt = (sceneId: string, at: number) => {
    if (!project) return;
    const scene = project.scenes.find((x) => x.id === sceneId);
    if (!scene) return;
    const dur = scene.durationInFrames;
    const cut = Math.round(at);
    if (cut < 15 || dur - cut < 15) {
      notify("分割点离场景边缘太近，拖到中间一点");
      return;
    }
    const newElId = () =>
      `el_${(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36)).slice(0, 8)}`;
    const els = scene.elements ?? [];
    const head = els
      .filter((e) => (e.from ?? 0) < cut)
      .map((e) => ({
        ...e,
        durationInFrames: Math.max(1, Math.min(e.durationInFrames ?? dur, cut - (e.from ?? 0))),
      }));
    const tail = els
      .filter((e) => (e.from ?? 0) >= cut)
      .map((e) => ({
        ...e,
        id: newElId(),
        from: (e.from ?? 0) - cut,
        durationInFrames: Math.max(
          1,
          Math.min(e.durationInFrames ?? dur, dur - cut - ((e.from ?? 0) - cut)),
        ),
      }));
    const newSceneId = `sc_${(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36)).slice(0, 8)}`;
    void apply([
      {
        op: "update_scene",
        sceneId: scene.id,
        patch: { durationInFrames: cut, elements: head },
      },
      {
        op: "add_scene",
        id: newSceneId,
        type: scene.type,
        name: `${scene.name} B`,
        props: structuredClone(scene.props),
        durationInFrames: dur - cut,
        afterSceneId: scene.id,
        transitionIn: null,
        elements: tail,
      },
    ]);
    notify(`已在 ${(cut / fps).toFixed(1)}s 处分割「${scene.name}」`);
    setSplitTarget(null);
  };


  const addSfx = async (file: File) => {
    setUploading(true);
    try {
      const { url } = await uploadAsset(project.id, file);
      await apply([
        {
          op: "add_audio_track",
          clip: {
            src: url,
            name: file.name.replace(/\.[^.]+$/, "").slice(0, 40) || "音效",
            from: 0,
            volume: 1,
            fadeIn: 0.2,
            durationInFrames: 90,
          },
        },
      ]);
      notify(`已添加音效「${file.name}」`);
    } catch (err) {
      notify(err instanceof Error ? err.message : "添加音效失败");
    } finally {
      setUploading(false);
    }
  };

  /**
   * 新建一条特效：默认落在播放头处，建完**自动选中**，
   * 右栏直接切成特效属性，用户不用再找"去哪改参数"。
   */
  const addEffect = (kind: EffectType) => {
    if (!project) return;
    const before = new Set((project.effects ?? []).map((e) => e.id));
    void apply([
      { op: "add_effect", clip: { ...effectDefaults(kind), from: Math.max(0, frame) } },
    ]).then(() => {
      const now = useDoc.getState().project;
      const created = (now?.effects ?? []).find((e) => !before.has(e.id));
      if (created) selectEffect(created.id);
    });
    notify(`加了「${effectLabel(kind)}」，右栏可以调参数`);
  };

  /**
   * 单个场景块。
   *
   * 交互分工（别再混在一起）：
   *  - 拖动块 = 改时间位置 / 换轨道（松手才落库）
   *  - 右边缘手柄 = 只改时长（起点不动）
   *  - 左边缘手柄 = 起点跟着走、右端钉住（时长反向变化，等于裁头 / 补头）
   *  - 素材库拖进来 = 往这一幕里加元素（HTML5 dnd，与上面不冲突）
   *  - Ctrl/Shift 点击 = 多选，不触发拖动
   */
  const renderSceneBlock = (scene: Scene, i: number) => {
    const sp = spanById.get(scene.id) ?? spans[i];
    const dragging = sceneDrag?.id === scene.id;
    // spans 已经吃掉了「拉伸预览 + 松手钉住 + 主轨重排」，这里直接用它的值。
    // 非主轨拖动中位置是直写 DOM 的（不 setState），重渲染时要从 ref 取最新落点，否则会跳回旧值。
    const dropStart = dragging ? sceneDropRef.current?.start : undefined;
    const start = dropStart ?? sp.start;
    const left = start * ppf;
    const dur = sp.dur;
    return (
      // 起点/时长写进 dataset：自动化验证与调试不用猜像素换算。
      // 注意写的是**当前显示值**（含拖动落点），不是文档里的旧值
      <div
        key={scene.id}
        data-scene-block={scene.id}
        data-track={sp.track}
        data-start={start}
        data-dur={dur}
        className={`tl-block ${selectedId === scene.id ? "is-active" : ""} ${
          sceneSel.length > 1 && sceneSel.includes(scene.id) ? "is-multi" : ""
        } ${dragging ? "is-dragging" : ""} ${sp.track > 0 ? "is-pip" : ""}`}
        style={{ left, width: Math.max(24, dur * ppf - 2), height: LANE_H - 6 }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          const libId =
            e.dataTransfer.getData("text/x-element") || e.dataTransfer.getData("text/plain");
          // 没带素材 id 的内部拖动已经不做了：块的拖动改成了"改时间"，排序在左侧场景列表
          if (!libId) return;
          e.preventDefault();
          e.stopPropagation();
          const lanes = lanesRef.current;
          if (!lanes) return;
          const r = lanes.getBoundingClientRect();
          const globalFrame = Math.max(
            0,
            Math.min(total - 1, Math.round((e.clientX - r.left) / ppf)),
          );
          // 音频素材 → 工程级音效轨（从落点开始）；其它 → 该场景的元素
          if (isAssetLibraryId(libId)) {
            const asset = useDoc.getState().assets.find((a) => a.id === assetIdOf(libId));
            if (!asset) return;
            if (asset.kind === "audio") {
              void apply([
                {
                  op: "add_audio_track",
                  clip: { src: asset.url, name: asset.name, from: globalFrame },
                },
              ]);
              useDoc.getState().notify(`已把「${asset.name}」放到音效轨`);
              return;
            }
            const id = `el_${(globalThis.crypto?.randomUUID?.() ?? String(Math.random())).slice(0, 8)}`;
            void apply([
              {
                op: "add_element",
                sceneId: scene.id,
                element: {
                  ...assetToElement(asset, { x: 50, y: 52 }, project.fps),
                  id,
                  from: Math.max(0, globalFrame - sp.start),
                },
              },
            ]);
            useDoc.getState().notify(`已把「${asset.name}」放进「${scene.name}」`);
            return;
          }
          const base = elementFromLibrary(libId, { x: 50, y: 52 });
          if (!base) return;
          const id = `el_${(globalThis.crypto?.randomUUID?.() ?? String(Math.random())).slice(0, 8)}`;
          void apply([
            {
              op: "add_element",
              sceneId: scene.id,
              element: { ...base, id, from: Math.max(0, globalFrame - sp.start) },
            },
          ]);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          select(scene.id);
          const lanes = lanesRef.current;
          if (!lanes) return;
          const rect = lanes.getBoundingClientRect();
          const globalFrame = Math.round((e.clientX - rect.left) / ppf);
          setCtxMenu({ x: e.clientX, y: e.clientY, sceneId: scene.id, frame: globalFrame });
        }}
        onMouseDown={(e) => {
          e.stopPropagation();
          if (e.button !== 0) return;
          select(scene.id);
          const multi = e.ctrlKey || e.metaKey;
          if (multi) {
            setSceneSel((prev) =>
              prev.includes(scene.id) ? prev.filter((x) => x !== scene.id) : [...prev, scene.id],
            );
          } else if (e.shiftKey && selectedId) {
            const ids = project.scenes.map((x) => x.id);
            const a = ids.indexOf(selectedId);
            const b = ids.indexOf(scene.id);
            setSceneSel(
              a >= 0 && b >= 0
                ? ids.slice(Math.min(a, b), Math.max(a, b) + 1)
                : [scene.id],
            );
          } else {
            setSceneSel([scene.id]);
            // 多选状态下的拖动先不做：一次只挪一块，语义清楚、也不容易误伤
            setSceneDrag({
              id: scene.id,
              startX: e.clientX,
              startY: e.clientY,
              fromStart: sp.start,
              fromTrack: sp.track,
            });
          }
        }}
        title={`${scene.name} · ${(dur / fps).toFixed(1)}s${
          sp.track > 0 ? ` · 轨道 ${sp.track}` : ""
        }（拖动改时间 / 上下拖换轨；左右边缘都能拉伸，左边=裁头）`}
      >
        <span className="tl-block-head">
          <span className="tl-index">{i + 1}</span>
          {sp.track > 0 ? <span className="tl-track-badge">轨 {sp.track}</span> : null}
        </span>
        <span className="tl-name">{scene.name}</span>
        {dur * ppf > 78 ? <span className="tl-dur">{(dur / fps).toFixed(1)}s</span> : null}
        <div
          className="tl-handle tl-handle-left"
          draggable={false}
          title="拖动左边缘：起点跟着走、右端不动（等于裁头 / 补头）"
          onDragStart={(e) => e.preventDefault()}
          onMouseDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
            setResizeScene({
              id: scene.id,
              edge: "left",
              startX: e.clientX,
              baseStart: sp.start,
              baseDur: sp.dur,
              baseTrack: sp.track,
            });
          }}
        />
        <div
          className="tl-handle tl-handle-right"
          draggable={false}
          title="拖动右边缘：只改时长，起点不动"
          onDragStart={(e) => e.preventDefault()}
          onMouseDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
            setResizeScene({
              id: scene.id,
              edge: "right",
              startX: e.clientX,
              baseStart: sp.start,
              baseDur: sp.dur,
              baseTrack: sp.track,
            });
          }}
        />
      </div>
    );
  };

  /**
   * 删除一条轨道。
   *
   * 轨道只是场景上的一个数字，没有独立实体可删 —— 所以这里做的是
   * 「把这条轨道上的场景按时间顺序并回主轨末尾」：轨道随之消失，内容一个不丢。
   * 并到末尾而不是原位：原位多半被主轨占着，硬塞会把主轨内容推得面目全非。
   * 顺带清掉画面框：轨道没了还留着 34% 的小窗，主轨上就是一块莫名其妙的小画面。
   */
  const mergeTrackToMain = (track: number) => {
    const list = project.scenes
      .map((s, i) => ({ scene: s, sp: spanById.get(s.id) ?? spans[i] }))
      .filter((x) => x.sp.track === track)
      .sort((a, b) => a.sp.start - b.sp.start);
    if (!list.length) return;
    let cursor = spans.filter((sp) => sp.track === 0).reduce((m, sp) => Math.max(m, sp.end), 0);
    const ops: Op[] = [];
    for (const { scene, sp } of list) {
      if (scene.box) ops.push({ op: "set_scene_box", sceneId: scene.id, box: null });
      ops.push({ op: "move_scene", sceneId: scene.id, start: cursor, track: 0 });
      cursor += sp.dur;
    }
    void apply(ops).then(() => {
      notify(`轨道 ${track} 已删除，${list.length} 幕并到主轨末尾（也恢复了全屏，Ctrl+Z 可撤销）`);
    });
  };

  const splitIdx = splitTarget
    ? project.scenes.findIndex((x) => x.id === splitTarget.sceneId)
    : -1;

  return (
    <div className="timeline">
      <div
        className="timeline-resize"
        onMouseDown={(e) => {
          e.preventDefault();
          tlDragRef.current = { startY: e.clientY, startH: sceneTlH };
          setResizingTimeline(true);
        }}
        title="拖动调整时间轴高度"
      />
      <div className="timeline-head">
        <span className="tl-title">时间轴</span>
        <span className="tl-meta">
          {project.scenes.length} 场景 · {(sceneTotal / fps).toFixed(1)}s · {(frame / fps).toFixed(2)}s / {frame}f
        </span>
<button
          className={`ghost tl-global ${allElementsHidden ? "is-off" : ""}`}
          onClick={toggleAllElementsHidden}
          disabled={!allElements.length}
          title={allElementsHidden ? "显示全部图层" : "隐藏全部图层"}
        >
          {allElementsHidden ? <EyeOffIcon /> : <EyeOnIcon />}
        </button>
        <button
          className={`ghost tl-global ${audioMutedNow ? "is-off" : ""}`}
          onClick={toggleAllAudioMuted}
          title={audioMutedNow ? "打开全部声音" : "静音全部声音"}
        >
          {audioMutedNow ? <SoundOffIcon /> : <SoundOnIcon />}
        </button>
        {splitTarget ? (
          <span className="split-bar">
            分割位置 {(splitTarget.at / fps).toFixed(2)}s
            <button
              className="split-bar-ok"
              onClick={() => splitSceneAt(splitTarget.sceneId, splitTarget.at)}
            >
              确认分割
            </button>
            <button className="split-bar-cancel" onClick={() => setSplitTarget(null)}>
              取消
            </button>
          </span>
        ) : null}
        <span className="tl-fixed-zoom">{ppf >= 1 ? ppf.toFixed(1) : ppf.toFixed(3)} px/帧 · Ctrl 缩放 · Shift 左右</span>
        {sceneSel.length > 1 ? (
          <div className="tl-multi">
            <span>已选 {sceneSel.length} 个场景</span>
            <button className="ghost" onClick={duplicateSelectedScenes}>
              复制
            </button>
            <button className="ghost danger" onClick={removeSelectedScenes}>
              删除
            </button>
            <button className="ghost" onClick={() => setSceneSel([])}>
              取消
            </button>
          </div>
        ) : null}
        <button
          className="ghost tl-add-sfx"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
          title="上传一段音效（放到独立音轨）"
        >
          {uploading ? "上传中…" : "＋ 音效"}
        </button>
        <button
          className="ghost tl-add-fx"
          onClick={(e) => {
            // 弹类型菜单（11 种），选完在播放头处建好并自动选中
            const r = e.currentTarget.getBoundingClientRect();
            setFxMenu((cur) => (cur ? null : { x: r.left, y: r.bottom + 4 }));
          }}
          title="在播放头处加一条特效（可选类型：闪白 / 震动 / 故障 / 暗角…）"
        >
          ✦ 特效
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.currentTarget.value = "";
            if (f) void addSfx(f);
          }}
        />
      </div>

      <SceneTimeline playerRef={playerRef} />

      <div
        className="tl-splitter"
        onMouseDown={(e) => {
          e.preventDefault();
          setSplitDrag({ startY: e.clientY, startH: timelineH });
        }}
        title="拖动调整上面这块场景时间轴的高度"
      />

      <div className="tl-viewport">
      <div
        className="tl-body"
        ref={bodyRef}
        onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
      >
        <div
          className="tl-heads"
          style={{ width: HEAD_W, minHeight: RULER_H + LANE_H * (rows.length + 1 + tracks.length + (project.effects ?? []).length) }}
        >
          <div className="tl-head tl-head-ruler" style={{ height: RULER_H }} />
          {rows.map((track) => {
            const count = spans.filter((sp) => sp.track === track).length;
            return (
              <div
                className={`tl-head tl-head-track ${track > 0 ? "is-pip" : ""}`}
                key={`h-${track}`}
                style={{ height: LANE_H }}
                title={
                  track === 0
                    ? "主轨（轨道 0）：成片按这里的先后播放，字幕也只烧这一轨"
                    : `轨道 ${track}：叠在主轨之上，配合「画面框」做画中画`
                }
              >
                <span>{track === 0 ? "场景" : `轨道 ${track}`}</span>
                <span className="tl-head-meta">{count}</span>
                {track > 0 && count > 0 ? (
                  <button
                    className="tl-head-x"
                    title={`删除轨道 ${track}：${count} 幕按时间顺序并回主轨末尾并恢复全屏（不删内容，可 Ctrl+Z 撤销）`}
                    onClick={(e) => {
                      e.stopPropagation();
                      mergeTrackToMain(track);
                    }}
                  >
                    ×
                  </button>
                ) : null}
              </div>
            );
          })}
          <div className="tl-head" style={{ height: LANE_H }}>
            <span>音乐</span>
            {project.audio ? (
              <button
                className="tl-head-x"
                title="清除背景音乐"
                onClick={() => void apply([{ op: "set_audio", audio: null }])}
              >
                ×
              </button>
            ) : null}
          </div>
          {tracks.map((t) => (
            <div className="tl-head" key={t.id} title={t.src} style={{ height: LANE_H }}>
              <span className="tl-head-name">{t.name}</span>
              <button
                className="tl-head-x"
                title="删除这条音效（可 Ctrl+Z 撤销）"
                onClick={() => void apply([{ op: "remove_audio_track", trackId: t.id }])}
              >
                ×
              </button>
            </div>
          ))}
          {(project.effects ?? []).map((t) => (
            <div
              className={`tl-head tl-head-fx ${selectedEffect === t.id ? "is-active" : ""}`}
              key={t.id}
              style={{ height: LANE_H }}
              title={`${effectLabel(t.kind)} · 点击可在右栏调参数`}
              onClick={() => selectEffect(selectedEffect === t.id ? null : t.id)}
            >
              <span className="tl-head-name">{t.name}</span>
              <button
                className="tl-head-x"
                title="删除这条特效（可 Ctrl+Z 撤销）"
                onClick={(e) => {
                  e.stopPropagation();
                  void apply([{ op: "remove_effect", effectId: t.id }]);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <div
          className="tl-lanes"
          ref={lanesRef}
          style={{ width, minHeight: RULER_H + LANE_H * (rows.length + 1 + tracks.length) }}
          onMouseDown={(e) => {
            if (e.button === 0) seekAt(e.clientX);
          }}
        >
          <div className="tl-ruler" style={{ height: RULER_H }}>
            {ticks.map((f) => (
              <span key={f} className="tl-tick" style={{ left: f * ppf }}>
                {(f / fps).toFixed(f % fps === 0 ? 0 : 1)}s
              </span>
            ))}
          </div>

          {rows.map((track) => (
            <div
              className={`tl-lane tl-lane-scene ${track > 0 ? "is-pip" : ""}`}
              key={`l-${track}`}
              data-track={track}
              style={{ height: LANE_H }}
            >
              {project.scenes.map((scene: Scene, i) => {
                // 拖动中的块要画在"预览轨道"上，否则从主轨拖到轨道 1 时它不动
                const t =
                  sceneDrop?.id === scene.id
                    ? sceneDrop.track
                    : (spanById.get(scene.id) ?? spans[i]).track;
                return t === track ? renderSceneBlock(scene, i) : null;
              })}
              {/* 空轨道给一句提示，否则新轨道看起来像画错了 */}
              {spans.every((sp) => sp.track !== track) ? (
                <span className="tl-lane-empty">
                  {track === 0
                    ? "把场景拖到这里"
                    : "拖一幕到这里 = 画中画（配合「画面框」缩成小窗）"}
                </span>
              ) : null}
              {splitTarget && splitIdx >= 0 && (spanById.get(splitTarget.sceneId) ?? spans[splitIdx]).track === track ? (
                <div
                  className="split-line"
                  style={{ left: ((spanById.get(splitTarget.sceneId)?.start ?? offsets[splitIdx]) + splitTarget.at) * ppf }}
                  title="拖动调整分割位置，点「分割」确认"
                  onMouseDown={(e) => startSplitLineDrag(e, splitIdx)}
                />
              ) : null}
            </div>
          ))}

          {/* 吸附参考线：拖动时对齐哪条边，就在哪一帧画一条 */}
          {sceneDrop?.snap != null ? (
            <div
              className="tl-snap-guide"
              style={{ left: sceneDrop.snap * ppf, height: rows.length * LANE_H }}
            />
          ) : null}

          <div className="tl-lane tl-lane-music" style={{ height: LANE_H }}>
            {project.audio ? (
              <div
                className="tl-music"
                style={{
                  left: (project.audio.from ?? 0) * ppf,
                  width: Math.max(
                    30,
                    (project.audio.durationInFrames ?? sceneTotal - (project.audio.from ?? 0)) * ppf,
                  ),
                }}
                title={project.audio.src}
              >
                <Wave src={project.audio.src} className="music-wave" />
                <span className="tl-music-label">♪ {project.audio.src.split("/").pop()}</span>
              </div>
            ) : (
              <span className="tl-lane-empty">无背景音乐（右侧属性面板可加）</span>
            )}
          </div>

          {tracks.map((t) => {
            const preview =
              sfxPreview?.id === t.id ? sfxPreview : sfxPin?.id === t.id ? sfxPin : null;
            const from = preview ? preview.from : t.from;
            const dur = preview
              ? preview.dur
              : t.durationInFrames ?? Math.max(30, Math.min(90, total - t.from));
            return (
              <div className="tl-lane tl-lane-sfx" key={t.id} style={{ height: LANE_H }}>
                <div
                  className="tl-sfx-block"
                  style={{ left: from * ppf, width: Math.max(20, dur * ppf) }}
                  title={`${t.name} · 起点 ${from}f · ${(dur / fps).toFixed(1)}s（拖动移动，右边缘拉伸）`}
                  onMouseDown={(e) => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    setSfxDrag({
                      id: t.id,
                      mode: "move",
                      startX: e.clientX,
                      startFrom: from,
                      startDur: dur,
                    });
                  }}
                >
                  <Wave src={t.src} className="sfx-wave" />
                  <span className="tl-sfx-name">{t.name}</span>
                  <div
                    className="tl-sfx-handle"
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      setSfxDrag({
                        id: t.id,
                        mode: "resize",
                        startX: e.clientX,
                        startFrom: from,
                        startDur: dur,
                      });
                    }}
                  />
                </div>
              </div>
            );
          })}

          {(project.effects ?? []).map((t) => {
            const preview =
              fxPreview?.id === t.id ? fxPreview : fxPin?.id === t.id ? fxPin : null;
            const from = preview ? preview.from : t.from;
            const dur = preview ? preview.dur : t.durationInFrames;
            return (
              <div className="tl-lane tl-lane-fx" key={t.id} style={{ height: LANE_H }}>
                <div
                  className={`tl-fx-block ${selectedEffect === t.id ? "is-active" : ""} is-fx-${t.kind}`}
                  style={{ left: from * ppf, width: Math.max(20, dur * ppf) }}
                  title={`${t.name}（${effectLabel(t.kind)}） · 起点 ${from}f · ${(dur / fps).toFixed(1)}s\n拖动移动 / 右边缘拉伸 / 点击在右栏改参数`}
                  onMouseDown={(e) => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    // 拖块的同时选中它：右栏切成特效属性，不用再去轨道头点一遍
                    selectEffect(t.id);
                    setFxDrag({
                      id: t.id,
                      mode: "move",
                      startX: e.clientX,
                      startFrom: from,
                      startDur: dur,
                    });
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setCtxMenu({
                      x: e.clientX,
                      y: e.clientY,
                      kind: "fx",
                      effectId: t.id,
                      name: t.name,
                    });
                  }}
                >
                  <span className="tl-fx-name">{t.name}</span>
                  <span className="tl-fx-meta">{Math.round((t.intensity ?? 1) * 100)}%</span>
                  <div
                    className="tl-fx-handle"
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      setFxDrag({
                        id: t.id,
                        mode: "resize",
                        startX: e.clientX,
                        startFrom: from,
                        startDur: dur,
                      });
                    }}
                  />
                </div>
              </div>
            );
          })}

        </div>
        </div>

        {/* 播放头固定在可视层，不随内容滚动 */}
        <div
          className="tl-playhead-overlay"
          style={{ left: HEAD_W + frame * ppf - scrollLeft }}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setScrubbing(true);
            seekAt(e.clientX);
          }}
          title="拖动定位"
        />
      </div>

      {ctxMenu ? (
        <CtxMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={(() => {
            // 特效块的右键：强度档位 + 删除（改起点/长度直接拖块）
            if (ctxMenu.kind === "fx" && ctxMenu.effectId) {
              const clip = (project.effects ?? []).find((x) => x.id === ctxMenu.effectId);
              if (!clip) return [];
              return [
                {
                  label: "编辑参数（右侧面板）",
                  hint: "类型 / 强度 / 颜色 / 时间",
                  onClick: () => selectEffect(clip.id),
                },
                ...([0.4, 0.7, 1] as const).map((v) => ({
                  label: `强度 ${Math.round(v * 100)}%${Math.round((clip.intensity ?? 1) * 100) === Math.round(v * 100) ? " ✓" : ""}`,
                  onClick: () =>
                    void apply([{ op: "update_effect", effectId: clip.id, patch: { intensity: v } }]),
                })),
                {
                  label: "删除特效",
                  onClick: () => void apply([{ op: "remove_effect", effectId: clip.id }]),
                },
              ];
            }
            // 这两个量在场景菜单分支里必然存在，先收窄成非可空，避免下面满屏的类型报错
            const menuSceneId = ctxMenu.sceneId as string;
            const menuFrame = ctxMenu.frame ?? 0;
            const idx = project.scenes.findIndex((x) => x.id === menuSceneId);
            const sc = idx >= 0 ? project.scenes[idx] : null;
            const sp = idx >= 0 ? spans[idx] : null;
            const items: { label: string; onClick: () => void }[] = [];
            // 多轨动作放在最上面：这几项是这次新增的，容易找不到
            if (sc && sp) {
              const track = sp.track;
              items.push({
                label: `对齐到播放头（第 ${Math.max(0, menuFrame)} 帧）`,
                onClick: () =>
                  void apply([
                    { op: "move_scene", sceneId: sc.id, start: Math.max(0, menuFrame), track },
                  ]),
              });
              if (track > 0) {
                items.push({
                  label: `移到轨道 ${track - 1}`,
                  onClick: () =>
                    void apply([
                      { op: "move_scene", sceneId: sc.id, start: sp.start, track: track - 1 },
                    ]),
                });
              }
              items.push({
                label: track === 0 ? "移到轨道 1（叠在上层）" : `移到轨道 ${track + 1}`,
                onClick: () =>
                  void apply([
                    { op: "move_scene", sceneId: sc.id, start: sp.start, track: track + 1 },
                  ]),
              });
              items.push(
                sc.box
                  ? {
                      label: "恢复全屏",
                      onClick: () =>
                        void apply([{ op: "set_scene_box", sceneId: sc.id, box: null }]),
                    }
                  : {
                      label: "设为画中画（右上小窗）",
                      onClick: () =>
                        void apply([
                          {
                            op: "move_scene",
                            sceneId: sc.id,
                            start: Math.max(0, menuFrame),
                            track: track > 0 ? track : 1,
                          },
                          {
                            op: "set_scene_box",
                            sceneId: sc.id,
                            box: { x: 72, y: 26, scale: 0.34, radius: 3 },
                          },
                        ]),
                    },
              );
            }
            // 顺序（= 主轨播放顺序）：块拖动已经改成"改时间"，排序单独给两个菜单项
            {
              const reorder = (delta: number) => {
                const ids = project.scenes.map((x) => x.id);
                const to = idx + delta;
                if (idx < 0 || to < 0 || to >= ids.length) return;
                ids.splice(to, 0, ids.splice(idx, 1)[0]);
                void apply([{ op: "reorder_scenes", sceneIds: ids }]);
              };
              if (idx > 0) items.push({ label: "顺序前移一位", onClick: () => reorder(-1) });
              if (idx >= 0 && idx < project.scenes.length - 1) {
                items.push({ label: "顺序后移一位", onClick: () => reorder(1) });
              }
            }
            items.push(
              {
                label: "分割",
                onClick: () => {
                  if (idx < 0) return;
                  const scene = project.scenes[idx];
                  const at = menuFrame - offsets[idx];
                  setSplitTarget({
                    sceneId: menuSceneId,
                    at: Math.max(15, Math.min(scene.durationInFrames - 15, at)),
                  });
                },
              },
              {
                label: "复制场景",
                onClick: () => void apply([{ op: "duplicate_scene", sceneId: menuSceneId }]),
              },
              {
                label: "删除场景",
                onClick: () => {
                  const target = project.scenes.find((x) => x.id === menuSceneId);
                  if (!target) return;
                  askConfirm({
                    title: `删除场景「${target.name}」？`,
                    message: "这一页的文案、元素和时长都会一起删掉。",
                    hint: "可以用 Ctrl+Z 撤销",
                    confirmLabel: "删除场景",
                    onConfirm: () =>
                      void apply([{ op: "remove_scene", sceneId: menuSceneId }]),
                  });
                },
              },
            );
            return items;
          })()}
          onClose={() => setCtxMenu(null)}
        />
      ) : null}

      {fxMenu ? (
        <CtxMenu
          x={fxMenu.x}
          y={fxMenu.y}
          items={EFFECT_CREATABLE.map((opt) => ({
            label: opt.label,
            hint: opt.hint,
            onClick: () => addEffect(opt.key),
          }))}
          onClose={() => setFxMenu(null)}
        />
      ) : null}

    </div>
  );
};
