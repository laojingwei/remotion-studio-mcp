import { create } from "zustand";

/**
 * 全局「确认」弹窗的状态。
 *
 * 所有删除操作都走这里，而不是 window.confirm：
 *  - 原生 confirm 是阻塞式弹窗，在自动化脚本里会卡住页面
 *  - 自绘的确认框能显示更多上下文（删的是什么、能不能撤销）和危险色
 */
export type ConfirmRequest = {
  title: string;
  message?: string;
  /** 确认按钮文案，默认「删除」 */
  confirmLabel?: string;
  /** 说明"这个操作可以撤销"，减少用户的紧张感 */
  hint?: string;
  onConfirm: () => void;
};

type UiState = {
  confirm: ConfirmRequest | null;
  askConfirm: (req: ConfirmRequest) => void;
  closeConfirm: () => void;
};

export const useUi = create<UiState>((set) => ({
  confirm: null,
  askConfirm: (req) => set({ confirm: req }),
  closeConfirm: () => set({ confirm: null }),
}));

/** 组件里没挂 hooks 时的快捷入口 */
export const askConfirm = (req: ConfirmRequest) => useUi.getState().askConfirm(req);
