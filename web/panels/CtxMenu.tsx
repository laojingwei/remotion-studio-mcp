import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export type CtxMenuItem = {
  label: string;
  /** 第二行小字说明（可选）。给"选项很多"的菜单用，比如特效库 */
  hint?: string;
  onClick: () => void;
};

/** 菜单离视口边缘至少留这么多，贴边太死会显得像被裁了一半 */
const EDGE = 8;

/**
 * 右键功能栏：在鼠标位置弹出，点空白处 / Esc 关闭。
 * 时间轴上的场景块、元素块共用。
 *
 * **位置必须按实际尺寸夹一次**：菜单是固定定位，直接 `left/top = 鼠标位置` 时，
 * 在窗口底部右键就会把最后几项画到视口外面（截图里"移到轨道 2"就是这么没的）。
 * 规则：右/下放不下就先翻到指针另一侧，翻过去还放不下就贴边，
 * 再配合 CSS 的 `max-height` 让菜单自己滚动 —— 任何窗口尺寸下都能看全。
 */
export const CtxMenu: React.FC<{
  x: number;
  y: number;
  items: CtxMenuItem[];
  onClose: () => void;
}> = ({ x, y, items, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  /** 量一次菜单尺寸，算一个不越界的落点（window resize 时也重算） */
  const place = useCallback(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left =
      x + width > vw - EDGE ? Math.max(EDGE, Math.min(x - width, vw - width - EDGE)) : x;
    const top =
      y + height > vh - EDGE ? Math.max(EDGE, Math.min(y - height, vh - height - EDGE)) : y;
    // 值没变就别 setState（同一个 pos 反复渲染没意义）
    setPos((p) => (p.left === left && p.top === top ? p : { left, top }));
  }, [x, y]);

  // 绘制前就算好，避免先闪一下越界的位置。
  // 后面两条兜底是因为菜单是"内容撑开"的：第一次量到的尺寸可能偏小（字体/换行还没稳定），
  // 尺寸一变就重算，保证任何情况下右/下边都留得出 EDGE 的余量。
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    place();
    const raf = requestAnimationFrame(place);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => place());
      ro.observe(el);
    }
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [place, items.length]);

  useEffect(() => {
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [place]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      // 点在菜单内部不关闭（否则捕获阶段先关掉，click 根本到不了菜单项）
      if (menuRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="ctx-menu"
      style={{ left: pos.left, top: pos.top }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          className={`ctx-menu-item ${item.hint ? "has-hint" : ""}`}
          onClick={() => {
            item.onClick();
            onClose();
          }}
        >
          <span className="ctx-menu-label">{item.label}</span>
          {item.hint ? <span className="ctx-menu-hint">{item.hint}</span> : null}
        </button>
      ))}
    </div>
  );
};
