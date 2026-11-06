import { create } from "zustand";

/**
 * 全局「确认」弹窗的状态。
 *
 * 所有删除操作都走这里，而不是 window.confirm：
 *  - 原生 confirm 是阻塞式弹窗，在自动化脚本里会卡住页面
 *  - 自绘的确认框能显示更多上下文（删的是什么、能不能撤销）和危险色
 */
/**
 * 确认框里的一个"处理方式"选项。
 *
 * 用于同一次操作有**多档后果**的场景（如卸载插件：进回收站 vs 永久删除）。
 * 每个选项自带一行说明，让用户在点之前就知道后果——
 * 比"点确认 → 再弹一个更吓人的确认"少一层打断，后果又看得更清。
 */
export type ConfirmChoice = {
  /** 选项标题（按钮文字） */
  label: string;
  /** 这一行是"温馨提示"：说清后果（能不能恢复） */
  desc?: string;
  /** 危险选项（永久删除这类不可逆动作）：红色强调，视觉上和推荐项分开 */
  danger?: boolean;
  onChoose: () => void;
};

export type ConfirmRequest = {
  title: string;
  message?: string;
  /** 确认按钮文案，默认「删除」（仅在单确认模式下生效） */
  confirmLabel?: string;
  /** 说明"这个操作可以撤销"，减少用户的紧张感 */
  hint?: string;
  /** 单确认模式的动作（没传 choices 时用） */
  onConfirm?: () => void;
  /**
   * 多选一模式：给了 choices 就渲染成一列"选项卡"（每项带说明）+ 取消，
   * 不再渲染单个确认按钮。与 onConfirm 互斥。
   */
  choices?: ConfirmChoice[];
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
