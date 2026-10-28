import React from "react";
import { useLiveNumber } from "./useLiveNumber";

/**
 * 会自己节流的 `<input type="range">`。
 *
 * 属性面板里所有滑杆都走它：直接绑 `onChange={() => apply(...)}` 的话，
 * 拖一秒就是几十条 op（全量往返 + 写盘 + 整棵树重渲染），工程一大就卡死。
 * 这里改成"本地立刻跟手、写库节流 ~8 次/秒、松手补最后一次"。
 */
export const RangeInput: React.FC<{
  value: number;
  min: number;
  max: number;
  step?: number;
  /** 提交间隔（ms），默认 120 */
  delay?: number;
  className?: string;
  title?: string;
  onChange: (v: number) => void;
}> = ({ value, min, max, step, delay, className, title, onChange }) => {
  const live = useLiveNumber(value, onChange, delay);
  return (
    <input
      type="range"
      className={className}
      title={title}
      min={min}
      max={max}
      step={step}
      value={live.value}
      onChange={(e) => live.onChange(Number(e.target.value))}
      onPointerUp={live.flush}
      onKeyUp={live.flush}
      onBlur={live.flush}
    />
  );
};
