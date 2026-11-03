/**
 * scene3d 的节点动画求值（缓动 + 逐帧变换）。
 *
 * 为什么单独抽出来：编辑器要「在某一帧打关键帧」，就必须先回答「这一帧现在长什么样」，
 * 而这个答案必须和渲染**完全一致**——否则用户打完关键帧，画面会当场跳一下。
 * 这段逻辑原来埋在 `DslScene.tsx` 里，编辑器只能另写一份，两份迟早漂。
 *
 * 不依赖 three：纯数组运算，server 端也能 import（web / src / server 共用 shared）。
 */
import type { DslNode } from "./scene3dDsl";
import { hasCurve, pathAt, type Vec3 } from "./scene3dPath";

export type EaseKind = "linear" | "easeInOut" | "easeOut" | "easeIn";

export const EASE_KINDS: EaseKind[] = ["easeInOut", "easeIn", "easeOut", "linear"];

export const ease = (kind: string | undefined, x: number): number => {
  const v = Math.max(0, Math.min(1, x));
  switch (kind) {
    case "linear":
      return v;
    case "easeIn":
      return v * v * v;
    case "easeOut":
      return 1 - Math.pow(1 - v, 3);
    default:
      return v < 0.5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2;
  }
};

export type Tr = {
  pos: [number, number, number];
  rot: [number, number, number];
  /** 渲染时用的三分量缩放：有 scaleXYZ 就用它，否则用 scale 铺成三轴 */
  scale: [number, number, number];
  opacity: number;
};

/** 节点的基础缩放（没有 `scaleXYZ` 时的单一倍数），关键帧里的 `scale` 是乘在它上面的 */
export const nodeBaseScale = (node: DslNode): number => {
  const t = node.transform;
  if (t?.scaleXYZ) return t.scaleXYZ[0];
  return t?.scale ?? 1;
};

/**
 * 求一个节点在当前帧的变换。
 *
 * **关键帧里的值是绝对值**，`from` 不写就取当前累计值，`to` 必须有值才动手
 * （只有 from 的那段等于没写，schema 阶段已经报出来了）。
 *
 * **段结束后保持终值（hold）**，这是所有动画系统的默认行为（Blender 的 F-Curve、
 * AE 的属性关键帧、Unity 的 AnimationClip 都是"最后一颗之后保持不变"）。
 * 原来段外直接跳过 = 回到基础值，于是"打完关键帧，最后一颗之后又弹回原位"；
 * 编辑器里这就是"我明明在第 60 帧定好了，后面怎么又回 0 了"（实测被报上来过）。
 * 想让物体"变完再弹回去"，本来就应该写两段（去程 + 回程），而不是依赖隐式回弹。
 */
export const evalNode = (node: DslNode, frame: number): Tr => {
  const base = node.transform;
  const out: Tr = {
    pos: [...(base?.position ?? [0, 0, 0])] as [number, number, number],
    rot: [...(base?.rotation ?? [0, 0, 0])] as [number, number, number],
    scale: base?.scaleXYZ
      ? ([...base.scaleXYZ] as [number, number, number])
      : [base?.scale ?? 1, base?.scale ?? 1, base?.scale ?? 1],
    opacity: 1,
  };
  for (const a of node.anim ?? []) {
    const [start, end] = a.at;
    // 段还没开始：这一段不参与（保持基础值 / 上一段的终值）
    if (frame < start) continue;
    // 段已结束：按终值持续生效（hold），而不是跳回基础值
    const p = frame >= end ? 1 : ease(a.ease, end > start ? (frame - start) / (end - start) : 1);
    const pick = (k: keyof NonNullable<typeof a.to>, cur: number) => {
      const to = a.to?.[k];
      if (typeof to !== "number") return cur;
      const fromRaw = a.from?.[k];
      const from = typeof fromRaw === "number" ? fromRaw : cur;
      return from + (to - from) * p;
    };
    /*
     * 位置：这一段被拉弯了就走空间曲线（Hermite），否则仍是逐通道线性插值。
     *
     * `hasCurve` 全零即 false，所以没配 curve 的段走的还是原来那三行 pick，
     * 老数据逐位不变（这是"加功能不改旧片"的底线）。
     * 曲线段里缺省的通道用起点补：曲线是**整个 3D 点**在走，不能三个轴各弯各的。
     */
    if (hasCurve(a.curve) && a.curve) {
      const curve = a.curve;
      const p0: Vec3 = [
        typeof a.from?.posX === "number" ? a.from.posX : out.pos[0],
        typeof a.from?.posY === "number" ? a.from.posY : out.pos[1],
        typeof a.from?.posZ === "number" ? a.from.posZ : out.pos[2],
      ];
      const p1: Vec3 = [
        typeof a.to?.posX === "number" ? a.to.posX : p0[0],
        typeof a.to?.posY === "number" ? a.to.posY : p0[1],
        typeof a.to?.posZ === "number" ? a.to.posZ : p0[2],
      ];
      out.pos = pathAt(
        p0,
        p1,
        [curve.out?.[0] ?? 0, curve.out?.[1] ?? 0, curve.out?.[2] ?? 0],
        [curve.in?.[0] ?? 0, curve.in?.[1] ?? 0, curve.in?.[2] ?? 0],
        p,
      );
    } else {
      out.pos = [pick("posX", out.pos[0]), pick("posY", out.pos[1]), pick("posZ", out.pos[2])];
    }
    out.rot = [pick("rotX", out.rot[0]), pick("rotY", out.rot[1]), pick("rotZ", out.rot[2])];
    // 动画的 scale 是"整体缩放"：乘到三轴上，不会破坏 scaleXYZ 的比例
    const k = pick("scale", 1);
    out.scale = [out.scale[0] * k, out.scale[1] * k, out.scale[2] * k];
    out.opacity = pick("opacity", out.opacity);
  }
  return out;
};
