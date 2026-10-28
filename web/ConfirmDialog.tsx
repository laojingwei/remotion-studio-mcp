import React, { useEffect, useRef } from "react";
import { useUi } from "./ui";

/**
 * 删除/破坏性操作的统一确认框。
 *
 * 设计取舍：
 *  - 焦点默认落在「取消」上（回车不会误删；要确认必须点按钮或 Tab 过去）
 *  - Esc 取消，点遮罩也取消
 *  - 打开期间拦截键盘事件，避免 Delete / 空格穿透到画布
 */
export const ConfirmDialog: React.FC = () => {
  const request = useUi((s) => s.confirm);
  const close = useUi((s) => s.closeConfirm);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!request) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      // 确认框打开期间吞掉所有按键：避免 Delete / 空格 / Ctrl+Z 穿透到画布
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "Enter") {
        // 不把回车映射成"确认"：误触风险比效率更重要
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [request, close]);

  if (!request) return null;

  const confirm = () => {
    const fn = request.onConfirm;
    close();
    fn();
  };

  return (
    <div
      className="confirm-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="confirm-card" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <div className="confirm-title" id="confirm-title">
          {request.title}
        </div>
        {request.message ? <div className="confirm-msg">{request.message}</div> : null}
        {request.hint ? <div className="confirm-hint">{request.hint}</div> : null}
        <div className="confirm-actions">
          <button ref={cancelRef} className="confirm-btn" onClick={close}>
            取消
          </button>
          <button className="confirm-btn is-danger" onClick={confirm}>
            {request.confirmLabel ?? "删除"}
          </button>
        </div>
      </div>
    </div>
  );
};
