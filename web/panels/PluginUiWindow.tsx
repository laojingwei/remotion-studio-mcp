import React, { useEffect, useRef, useState } from "react";

/**
 * 插件自带界面的浮窗。
 *
 * 为什么是浮窗而不是嵌在「插件」对话框里：
 *  1. 插件界面的高度不可控。内嵌时得给它一个固定高度再套一层内部滚动，用户想看的
 *     内容和想点的按钮永远在一小块可视区里翻。
 *  2. 一个插件开着界面，别的插件条目就被挤到看不见；想对照两个 TTS 插件的配置，
 *     只能来回收起展开。
 *  3. 配置类界面常常要「一边开着设置、一边在编辑器里试效果」——浮窗可以拖到角落，
 *     嵌在对话框里则必须先把对话框关掉（界面也跟着没了）。
 *
 * 宿主仍然只做容器：拖拽、缩放、置顶、重载、把主题变量递进去，页面里的一切归插件。
 */

export type UiWin = {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 叠放层级，点击任意位置即提到最前 */
  z: number;
  /** 最大化：只是铺满视口，还原时回到原来的 x/y/w/h */
  max: boolean;
};

const MIN_W = 360;
const MIN_H = 240;
const DEFAULT_W = 720;
const DEFAULT_H = 540;
/** 标题栏至少留这么多在视口里，否则窗口拖丢了就再也抓不回来 */
const KEEP_X = 140;
const KEEP_Y = 44;

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * 第 n 个打开的窗口：比正中央偏右下一点，并按序号错开。
 *
 * 不用正中央是因为下面还压着「插件」对话框——完全对齐的话，点开界面第一眼就是
 * 一大块浮窗盖住整个列表，看不出下面还有什么。偏一点，左侧能露出对话框的标题和条目。
 */
export function initialUiWin(seq: number): UiWin {
  const vw = typeof window === "undefined" ? 1280 : window.innerWidth;
  const vh = typeof window === "undefined" ? 800 : window.innerHeight;
  const w = clamp(DEFAULT_W, MIN_W, Math.max(MIN_W, vw - 120));
  const h = clamp(DEFAULT_H, MIN_H, Math.max(MIN_H, vh - 140));
  const off = (seq % 5) * 26;
  const x = clamp(Math.round((vw - w) / 2) + 44 + off, 8, Math.max(8, vw - w - 8));
  const y = clamp(Math.round((vh - h) / 2) - 36 + off, 8, Math.max(8, vh - h - 8));
  return { x, y, w, h, z: 0, max: false };
}

const THEME_KEYS = ["--bg", "--panel", "--panel-2", "--line", "--text", "--muted", "--accent", "--danger", "--radius"];

export const PluginUiWindow: React.FC<{
  id: string;
  name: string;
  win: UiWin;
  onPatch: (patch: Partial<UiWin>) => void;
  onClose: () => void;
  /** 点击窗口任意位置时提到最前 */
  onFocus: () => void;
}> = ({ id, name, win, onPatch, onClose, onFocus }) => {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const drag = useRef<{ mode: "move" | "resize"; px: number; py: number; x: number; y: number; w: number; h: number } | null>(
    null,
  );
  /** 重载：改 key 让 iframe 重新挂载（插件改完 ui/ 里的文件后不必重启编辑器） */
  const [reload, setReload] = useState(0);

  /*
   * 消息监听用 ref 取最新的回调与几何：否则每次父组件重渲染都要重绑一次监听，
   * 而拖动时父组件每帧都在重渲染。
   */
  const live = useRef({ onClose, onPatch, win });
  live.current = { onClose, onPatch, win };

  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      // 只认自己这个 iframe 发来的消息，别让别的页面指挥这个窗口
      if (frame.current?.contentWindow !== ev.source) return;
      const d = ev.data as { type?: string; height?: number } | null;
      if (!d || typeof d !== "object") return;
      if (d.type === "studio:close") {
        live.current.onClose();
        return;
      }
      /*
       * studio:resize：插件知道自己内容多高，可以请求宿主把窗口调高。
       * 只做「变高/变矮」，宽度和位置由用户决定；也不能超过视口，否则标题栏被顶出去。
       */
      if (d.type === "studio:resize" && typeof d.height === "number" && Number.isFinite(d.height)) {
        const cur = live.current.win;
        const maxH = Math.max(MIN_H, window.innerHeight - cur.y - 8);
        live.current.onPatch({ h: clamp(Math.round(d.height), MIN_H, maxH) });
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const startDrag = (e: React.PointerEvent<HTMLElement>, mode: "move" | "resize") => {
    if (e.button !== 0) return;
    if (win.max) return;
    e.preventDefault();
    e.stopPropagation();
    onFocus();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    drag.current = { mode, px: e.clientX, py: e.clientY, x: win.x, y: win.y, w: win.w, h: win.h };
  };

  const onDragMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (d.mode === "move") {
      onPatch({
        x: clamp(d.x + dx, -(d.w - KEEP_X), window.innerWidth - KEEP_X),
        y: clamp(d.y + dy, 0, window.innerHeight - KEEP_Y),
      });
    } else {
      onPatch({
        w: clamp(d.w + dx, MIN_W, Math.max(MIN_W, window.innerWidth - d.x - 8)),
        h: clamp(d.h + dy, MIN_H, Math.max(MIN_H, window.innerHeight - d.y - 8)),
      });
    }
  };

  const endDrag = (e: React.PointerEvent<HTMLElement>) => {
    drag.current = null;
    const el = e.currentTarget;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  };

  const rect: React.CSSProperties = win.max
    ? { left: 8, top: 8, width: "calc(100vw - 16px)", height: "calc(100vh - 16px)", zIndex: win.z }
    : { left: win.x, top: win.y, width: win.w, height: win.h, zIndex: win.z };

  return (
    <div
      className={`ui-win ${win.max ? "is-max" : ""}`}
      style={rect}
      role="dialog"
      aria-label={`${name} 界面`}
      onPointerDown={onFocus}
      /* 浮窗在对话框之上但同属一个页面：点它不该关掉下面的插件列表 */
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="ui-win-head"
        onPointerDown={(e) => startDrag(e, "move")}
        onPointerMove={onDragMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => onPatch({ max: !win.max })}
        title={win.max ? "双击还原" : "拖动移动，双击最大化"}
      >
        <span className="ui-win-dot" />
        <b className="ui-win-name">{name}</b>
        <span className="ui-win-tag">插件自带界面</span>
        <span className="ui-win-spacer" />
        <div className="ui-win-actions" onPointerDown={(e) => e.stopPropagation()}>
          <button className="ui-win-btn" onClick={() => setReload((n) => n + 1)} title="重新加载这个页面（插件改完文件不必重启）">
            重载
          </button>
          <button className="ui-win-btn" onClick={() => onPatch({ max: !win.max })} title={win.max ? "还原大小" : "铺满屏幕"}>
            {win.max ? "还原" : "最大化"}
          </button>
          <button className="ui-win-btn is-close" onClick={onClose} title="关闭界面（不影响插件本身）">
            关闭
          </button>
        </div>
      </div>

      <div className="ui-win-body">
        <iframe
          key={reload}
          ref={frame}
          className="ui-win-frame"
          title={`${name} 界面`}
          src={`/plugin-ui/${encodeURIComponent(id)}/index.html`}
          /*
           * allow-same-origin 是必须的：插件页面要 fetch('/api/...') 读写自己的配置。
           * 不给 allow-top-navigation，防止插件把整个编辑器导航走。
           */
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
          onLoad={() => {
            /*
             * 把宿主的主题变量送进去：插件可以照着用（想要统一观感时），
             * 也可以完全无视。只发一次，之后由插件自己决定要不要再问。
             */
            const cs = getComputedStyle(document.documentElement);
            const tokens: Record<string, string> = {};
            for (const k of THEME_KEYS) tokens[k] = cs.getPropertyValue(k).trim();
            frame.current?.contentWindow?.postMessage({ type: "studio:init", pluginId: id, theme: "dark", tokens }, "*");
          }}
        />
      </div>

      {win.max ? null : (
        <div
          className="ui-win-grip"
          onPointerDown={(e) => startDrag(e, "resize")}
          onPointerMove={onDragMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          title="拖动调整大小"
        />
      )}
    </div>
  );
};
