import React, { useEffect, useRef } from "react";
import { useUi } from "./ui";

/**
 * 删除/破坏性操作的统一确认框。
 *
 * 两种形态：
 *  - 单确认（choices 不传）：取消 + 一个确认按钮。适合"删/不删"二元选择。
 *  - 多选一（传了 choices）：一列带说明的选项卡 + 取消。适合同一次操作有多档后果——
 *    比如卸载插件（进回收站 / 永久删除），每档后果在点之前就写在选项里，
 *    用户不需要"先选一个、再被第二个弹窗吓一次"。
 *
 * 设计取舍（两种形态共用）：
 *  - 焦点默认落在**安全项**上（单确认 = 取消；多选一 = 第一个非危险选项），
 *    回车不会误删——回车被拦掉，要确认必须点按钮或 Tab 过去
 *  - Esc 取消，点遮罩也取消
 *  - 打开期间拦截键盘事件，避免 Delete / 空格穿透到画布
 */
export const ConfirmDialog: React.FC = () => {
  const request = useUi((s) => s.confirm);
  const close = useUi((s) => s.closeConfirm);
  const cancelRef = useRef<HTMLButtonElement>(null);
  /** 多选一模式下第一个"安全选项"（非 danger）；没有就退化到取消按钮 */
  const safeChoiceRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!request) return;
    (safeChoiceRef.current ?? cancelRef.current)?.focus();
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

  const chooseAndClose = (fn: () => void) => {
    close();
    fn();
  };

  const choices = request.choices ?? [];
  const hasChoices = choices.length > 0;
  /** 焦点默认落在第一个"安全选项"上（比如回收站），危险选项必须主动点 */
  const firstSafeIndex = choices.findIndex((c) => !c.danger);

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

        {hasChoices ? (
          <>
            <div className="confirm-choices" role="group">
              {choices.map((c, i) => (
                <button
                  key={i}
                  ref={i === firstSafeIndex ? safeChoiceRef : undefined}
                  className={`confirm-choice ${c.danger ? "is-danger" : ""}`}
                  onClick={() => chooseAndClose(c.onChoose)}
                >
                  <span className="confirm-choice-label">{c.label}</span>
                  {c.desc ? <span className="confirm-choice-desc">{c.desc}</span> : null}
                </button>
              ))}
            </div>
            <div className="confirm-actions">
              <button ref={cancelRef} className="confirm-btn" onClick={close}>
                取消
              </button>
            </div>
          </>
        ) : (
          <div className="confirm-actions">
            <button ref={cancelRef} className="confirm-btn" onClick={close}>
              取消
            </button>
            <button className="confirm-btn is-danger" onClick={() => request.onConfirm && chooseAndClose(request.onConfirm)}>
              {request.confirmLabel ?? "删除"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
