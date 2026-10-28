import { useEffect, useRef, useState } from "react";

/**
 * 滑杆 / 小数字框这类**高频**属性输入的通用出口：界面立刻跟手，写库节流。
 *
 * 为什么非要有这个东西：`<input type="range">` 的 `onChange` 在拖动时每帧都触发，
 * 而每条 op 的成本都是「全量工程往返 + 服务端改盘 + 整棵 Remotion 树重渲染」。
 * 实测拖一次「圆角基准」滑杆 1.5 秒会发出 **82 条** op —— 工程一大就请求堆积，
 * 表现就是"调一下属性页面卡死"。这里把提交压到 ~8 次/秒（尾部一定补发最后一次）。
 *
 * 三个约束：
 *  1. **必须本地先跟手**（`value` 返回本地值），否则滑杆会滞后到松手才动；
 *  2. **外部回写不能覆盖拖动中的值** —— 拖动时本地值才是用户想要的，
 *     等提交回来、pending 清空后才重新跟随外部值；
 *  3. **尾部补发** —— 只做节流不做 debounce，松手后最后那个值一定会落库。
 */
export function useLiveNumber(value: number, commit: (v: number) => void, delay = 120) {
  const [live, setLive] = useState(value);
  const pending = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 回调每次渲染都是新的，放 ref 里，免得 effect 依赖它反复重建
  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(() => {
    if (pending.current === null) setLive(value);
  }, [value]);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
      // 组件卸载时还没落库的那一下也要发出去，否则拖完马上切场景会丢改动
      const p = pending.current;
      if (p !== null) commitRef.current(p);
    },
    [],
  );

  const onChange = (v: number) => {
    if (!Number.isFinite(v)) return;
    setLive(v);
    pending.current = v;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const p = pending.current;
      pending.current = null;
      if (p !== null) commitRef.current(p);
    }, delay);
  };

  /** 立刻提交（回车 / 失焦时用，比等节流更跟手） */
  const flush = () => {
    clearTimeout(timer.current);
    const p = pending.current;
    pending.current = null;
    if (p !== null) commitRef.current(p);
  };

  return { value: live, onChange, flush };
}
