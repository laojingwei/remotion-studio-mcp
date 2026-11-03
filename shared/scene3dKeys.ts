/**
 * 关键帧 ⇄ DSL 动画段 的双向翻译（编辑器用）。
 *
 * DSL 里没有"关键帧"这个概念，只有 `anim: [{ at:[起,止], from, to, ease }]` 的**段**。
 * agent 写段很自然（"淡入 0→30 帧"），但人在时间线上干活的心智是"在某一帧按一下，
 * 把它钉成现在这个样子"。两者是同一件事的两种写法：
 *
 *     关键帧 K0(f0) → K1(f1) → K2(f2)
 *     ⇔ 段 [{at:[f0,f1], from:K0, to:K1}, {at:[f1,f2], from:K1, to:K2}]
 *
 * 所以这里只做翻译，不改 DSL：编辑器永远写回合法的段，agent 那边看到的还是段。
 *
 * 两条实现要点：
 * 1. **反解靠采样**：给定段，端点帧全部采样一遍（用 `evalNode`，和渲染同一份求值），
 *    得到的就是"这些帧上的姿态"。这样无论 agent 用多奇怪的段组合，编辑器的显示都
 *    和画面一致；重建出来的段在采样点上逐位相同。
 * 2. **from/to 一律写全通道**：只写一部分通道时，缺的那个通道会落回"当前累计值"，
 *    重建后含义就变了。全写死，结果只由关键帧决定，基础变换改了也不影响。
 */
import type { DslNode } from "./scene3dDsl";
import { evalNode, nodeBaseScale, type EaseKind } from "./scene3dAnim";

/** 节点 anim 的段数上限（见 nodeSchema.anim 的 .max(8)），所以关键帧最多 9 个 */
export const NODE_ANIM_MAX = 8;
export const NODE_KEY_MAX = NODE_ANIM_MAX + 1;

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const r4v = (v: readonly number[]): [number, number, number] => [r4(v[0]), r4(v[1]), r4(v[2])];

export type NodeKey = {
  frame: number;
  pos: [number, number, number];
  rot: [number, number, number];
  /** 相对基础缩放的**倍率**（DSL 的 anim.scale 是乘在基础值上的，不是绝对值） */
  scale: number;
  opacity: number;
  /** 这一帧 → 下一帧之间用的缓动；最后一帧的 ease 不参与（没有下一段） */
  ease: EaseKind;
};

export type CamKey = {
  frame: number;
  pos: [number, number, number];
  target: [number, number, number];
  fov: number;
  ease: EaseKind;
  /**
   * 这一帧作为**段起点**时的约束。
   *
   * 为什么关键帧要带约束：重建段时 `camAnimFromKeys` 会把 from/to 全通道写死，
   * 一拖相机整段就变成"纯坐标"，原来挂在上面的 lookAt/follow 被悄悄抹掉——
   * 画面表现是"拖了一下，镜头突然不锁了"，而且撤销一次才能恢复。
   * 所以约束必须跟着关键帧走：采样时记下来，重建时按区间原样贴回去。
   */
  lookAt?: string;
  lookAtOffset?: [number, number, number];
  follow?: string;
};

/* ───────────────────────────── 排序 / 增删 ───────────────────────────── */

const sortKeys = <T extends { frame: number }>(keys: T[]): T[] =>
  [...keys].sort((a, b) => a.frame - b.frame);

/** 同一帧只留一个：新的顶掉旧的 */
const dedupeByFrame = <T extends { frame: number }>(keys: T[]): T[] => {
  const map = new Map<number, T>();
  for (const k of keys) map.set(Math.round(k.frame), k);
  return sortKeys([...map.values()]);
};

/** 在某个帧放一个关键帧：同帧覆盖，否则按帧号插入 */
export const upsertKey = <T extends { frame: number }>(keys: T[], key: T): T[] =>
  dedupeByFrame([...keys, key]);

export const removeKeyAt = <T extends { frame: number }>(keys: T[], frame: number): T[] =>
  keys.filter((k) => Math.round(k.frame) !== Math.round(frame));

/** 整段平移：所有关键帧帧号 +delta。会把负数钳到 0，再重新去重（钳完可能撞在一起） */
export const shiftKeys = <T extends { frame: number }>(keys: T[], delta: number): T[] =>
  dedupeByFrame(
    keys.map((k) => ({ ...k, frame: Math.max(0, Math.round(k.frame + delta)) })),
  );

/**
 * 整段拉伸：以**第一个关键帧**为锚点按比例缩放帧号。
 * 以首帧为锚而不是 0：节奏整体前移/后移过之后，拉伸不该把它拽回 0。
 */
export const stretchKeys = <T extends { frame: number }>(keys: T[], factor: number): T[] => {
  if (!keys.length) return [];
  const first = sortKeys(keys)[0].frame;
  return dedupeByFrame(
    keys.map((k) => ({
      ...k,
      frame: Math.max(0, Math.round(first + (k.frame - first) * factor)),
    })),
  );
};

/* ───────────────────────────── 节点关键帧 ───────────────────────────── */

/** 节点 anim 所有段的端点帧（去重升序）——这些就是"有姿态被钉住的帧" */
export const nodeKeyFrames = (node: DslNode): number[] => {
  const set = new Set<number>();
  for (const a of node.anim ?? []) {
    set.add(Math.round(a.at[0]));
    set.add(Math.round(a.at[1]));
  }
  return [...set].sort((a, b) => a - b);
};

/** 某一帧用哪条的缓动：找"包含这一帧、且还没到终点"的段 */
const easeAtFrame = (node: DslNode, frame: number, fallback: EaseKind): EaseKind => {
  for (const a of node.anim ?? []) {
    const [s, e] = a.at;
    if (frame >= s && frame < e) return (a.ease ?? "easeInOut") as EaseKind;
  }
  return fallback;
};

/**
 * 把"某一帧当前的姿态"摘成一颗关键帧（用渲染同一份求值）。
 *
 * 除了给 `nodeKeysOf` 复用，还用于**自动补第 0 帧锚点**：编辑器的约定是
 * "第 0 帧永远是初始位置"，所以在非 0 帧动手时必须先确保 0 帧有一颗锚点，
 * 否则改动会落到基础变换上、把 0 帧一起改掉。
 */
export const nodeKeyAt = (node: DslNode, frame: number): NodeKey => {
  const base = nodeBaseScale(node);
  const tr = evalNode(node, frame);
  return {
    frame: Math.round(frame),
    pos: r4v(tr.pos),
    rot: r4v(tr.rot),
    // anim 的 scale 是乘法：反解成倍率，重建时再乘回去
    scale: r4(base === 0 ? 1 : tr.scale[0] / base),
    opacity: r4(tr.opacity),
    ease: easeAtFrame(node, frame, "easeInOut"),
  };
};

/**
 * 从节点反解出关键帧列表（采样端点帧）。没有 anim 就是空数组（= 没有动画）。
 * 只有 1 个端点帧（`at:[f,f]` 的单点段）也当作 1 个关键帧返回，UI 上照样能看见。
 */
export const nodeKeysOf = (node: DslNode): NodeKey[] => nodeKeyFrames(node).map((f) => nodeKeyAt(node, f));

const packNode = (k: NodeKey) => ({
  posX: r4(k.pos[0]),
  posY: r4(k.pos[1]),
  posZ: r4(k.pos[2]),
  rotX: r4(k.rot[0]),
  rotY: r4(k.rot[1]),
  rotZ: r4(k.rot[2]),
  scale: r4(k.scale),
  opacity: r4(k.opacity),
});

/**
 * 关键帧 → 段。少于 2 个关键帧返回 `null`（= 让调用方清空 anim）。
 *
 * 为什么 1 个关键帧不能成段：段是"从 A 变到 B"，只有一个点就没有变化，
 * 写 `at:[f,f]` 只会在那一帧闪一下再弹回去，不是用户想要的。
 * 编辑器把第一颗关键帧先记在本地（当锚点），第二颗打下来才落库。
 */
export const nodeAnimFromKeys = (keys: NodeKey[]): unknown[] | null => {
  const ks = dedupeByFrame(keys);
  if (ks.length < 2) return null;
  return ks.slice(0, -1).map((k, i) => {
    const next = ks[i + 1];
    return {
      at: [k.frame, next.frame],
      from: packNode(k),
      to: packNode(next),
      ease: k.ease,
    };
  });
};

/**
 * 在某一帧放关键帧，并维持"第 0 帧 = 初始位置"。
 *
 * 关键帧不足两颗时先补一颗 0 帧锚点（`zeroKey`，由调用方按当时的基础姿态构造）：
 * 不补的话第一颗落在哪，编辑就只能改基础变换——而基础变换是 0 帧显示的东西，
 * 于是"在 60 帧挪了物体，0 帧也跟着跑了"（实测被报上来过）。
 *
 * 已有段、或正好在第 0 帧操作时不动这个约定：0 帧那颗由 `upsertKey` 覆盖。
 */
export const upsertKeyKeepingZero = <T extends { frame: number }>(
  keys: T[],
  key: T,
  zeroKey: T,
): T[] => {
  const withZero = keys.length < 2 && Math.round(key.frame) !== 0 ? upsertKey(keys, zeroKey) : keys;
  return upsertKey(withZero, key);
};

/* ───────────────────────────── 相机关键帧 ───────────────────────────── */

/** 相机运镜段的端点帧（和节点同一套读法） */
export const camKeyFrames = (camera: { anim?: Array<{ at: [number, number] }> } | undefined): number[] => {
  const set = new Set<number>();
  for (const a of camera?.anim ?? []) {
    set.add(Math.round(a.at[0]));
    set.add(Math.round(a.at[1]));
  }
  return [...set].sort((a, b) => a - b);
};

/**
 * 相机运镜里有 `follow`（钉在某颗行星上）时不能图形化编辑。
 *
 * 原因：follow 段的 pos/target 是**相对节点**的偏移，反解成世界坐标要算节点当时的
 * 世界位置；重建时又得把那一段还原成偏移。硬做会让镜头在行星公转时慢慢漂走。
 * 与其做个半对的东西，不如明确拦下来，让 agent 去改。
 */
export const camHasFollow = (camera: { anim?: Array<{ follow?: string }> } | undefined): boolean =>
  (camera?.anim ?? []).some((a) => Boolean(a.follow));

const packCam = (k: CamKey) => ({
  posX: r4(k.pos[0]),
  posY: r4(k.pos[1]),
  posZ: r4(k.pos[2]),
  targetX: r4(k.target[0]),
  targetY: r4(k.target[1]),
  targetZ: r4(k.target[2]),
  fov: r4(k.fov),
});

/** 相机关键帧 → 运镜段。少于 2 个返回 `null`（理由同节点） */
export const camAnimFromKeys = (keys: CamKey[]): unknown[] | null => {
  const ks = dedupeByFrame(keys);
  if (ks.length < 2) return null;
  return ks.slice(0, -1).map((k, i) => {
    const next = ks[i + 1];
    return {
      at: [k.frame, next.frame],
      from: packCam(k),
      to: packCam(next),
      ease: k.ease,
      /**
       * 约束按"段起点那颗关键帧"回填。段的约束天然属于起点：
       * 区间 [k, next] 的行为由 k 决定，next 的约束从下一段开始生效。
       */
      ...(k.follow ? { follow: k.follow } : {}),
      ...(k.lookAt
        ? { lookAt: k.lookAt, ...(k.lookAtOffset ? { lookAtOffset: k.lookAtOffset } : {}) }
        : {}),
    };
  });
};

/* ───────────────────────────── 相机锁定区间 ───────────────────────────── */

export type CamLockSpan = {
  start: number;
  end: number;
  id: string;
  /**
   * 是否是"最后一段"——最后一段的锁定按 hold 语义一直持续到片尾，
   * 面板上要显示成「f80 → 片尾」而不是「f80 → f80」（后者看起来像没生效）。
   */
  openEnded: boolean;
};

/**
 * 相机所有锁定区间（给面板列表用）。
 *
 * 直接从段读，不做任何合并：相邻两段锁同一个节点时仍是两个区间，
 * 因为用户可能是分两次锁的、中间还改过参数；合并会让他删不掉后一半。
 */
export const camLookAtSpans = (camera: { anim?: Array<{ at: [number, number]; lookAt?: string }> } | undefined): CamLockSpan[] => {
  const anims = camera?.anim ?? [];
  if (!anims.length) return [];
  let lastStart = -Infinity;
  for (const a of anims) lastStart = Math.max(lastStart, a.at[0]);
  return anims
    .filter((a) => Boolean(a.lookAt))
    .map((a) => ({
      start: Math.round(a.at[0]),
      end: Math.round(a.at[1]),
      id: a.lookAt!,
      openEnded: Math.round(a.at[0]) === Math.round(lastStart),
    }))
    .sort((a, b) => a.start - b.start);
};

/* ───────────────────────────── 提示文案 ───────────────────────────── */

/** 关键帧列表的摘要（面板里一行一句，扫一眼就知道这段在干什么） */
export const nodeKeySummary = (k: NodeKey): string => {
  const parts: string[] = [];
  if (k.pos.some((v) => v !== 0)) parts.push(`位 ${k.pos.map((v) => v.toFixed(1)).join(",")}`);
  if (k.rot.some((v) => v !== 0)) parts.push(`转 ${k.rot.map((v) => Math.round(v)).join(",")}°`);
  if (Math.abs(k.scale - 1) > 1e-4) parts.push(`缩 ×${k.scale.toFixed(2)}`);
  if (k.opacity < 0.999) parts.push(`透 ${k.opacity.toFixed(2)}`);
  return parts.length ? parts.join(" · ") : "与基础值相同";
};

export const camKeySummary = (k: CamKey): string =>
  `位 ${k.pos.map((v) => v.toFixed(1)).join(",")} → 看 ${k.target.map((v) => v.toFixed(1)).join(",")}`;
