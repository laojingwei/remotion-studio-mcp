/**
 * 相机关键帧的采样 + 锁定操作（web 层）。
 *
 * 为什么不在 `shared/scene3dKeys.ts` 里：相机求值要算 `follow`/`lookAt` 跟随的节点世界位置，
 * 那需要矩阵运算；shared 不能引 three（server 也要 import 它）。所以数据翻译放 shared，
 * 采样与"在某一帧锁定/退出"放这里，用渲染器**同一个** `dslCamera` ——
 * 编辑器的数值和画面必须一致。
 */
import type { Scene3DDsl } from "@shared/scene3dDsl";
import type { EaseKind } from "@shared/scene3dAnim";
import { type CamKey, camKeyFrames } from "@shared/scene3dKeys";
import { dslCamera } from "../../src/scenes/scene3d/DslScene";

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

type CamSegment = NonNullable<NonNullable<Scene3DDsl["camera"]>["anim"]>[number];

/** 相机运镜的关键帧列表（端点帧逐个采样成世界坐标，并把该段的约束带上） */
export const camKeysOf = (graph: Scene3DDsl, fps: number): CamKey[] => {
  const frames = camKeyFrames(graph.camera);
  if (!frames.length) return [];
  const anims = graph.camera?.anim ?? [];
  /**
   * 这颗关键帧代表哪一段的约束：优先"以它为起点"的段（段的约束归起点），
   * 否则"包含它"的段——段终点常常不是下一段起点（中间有间隙），退回包含关系才不会丢约束。
   */
  const segOf = (frame: number) =>
    anims.find((a) => Math.round(a.at[0]) === frame) ??
    anims.find((a) => frame >= a.at[0] && frame <= a.at[1]);

  return frames.map((frame) => {
    const c = dslCamera(graph, frame / fps, fps);
    const seg = segOf(frame);
    let ease: EaseKind = "easeInOut";
    for (const a of anims) {
      if (frame >= a.at[0] && frame < a.at[1]) {
        ease = (a.ease ?? "easeInOut") as EaseKind;
        break;
      }
    }
    return {
      frame,
      pos: [r4(c.worldPos[0]), r4(c.worldPos[1]), r4(c.worldPos[2])],
      target: [r4(c.worldTarget[0]), r4(c.worldTarget[1]), r4(c.worldTarget[2])],
      fov: r4(c.fov),
      ease,
      ...(seg?.follow ? { follow: seg.follow } : {}),
      ...(seg?.lookAt
        ? {
            lookAt: seg.lookAt,
            ...(seg.lookAtOffset
              ? { lookAtOffset: [...seg.lookAtOffset] as [number, number, number] }
              : {}),
          }
        : {}),
    };
  });
};

/**
 * 某一帧**实际生效**那一段的约束（follow / lookAt）。
 *
 * 打关键帧会把一段切成两段，切出来的后半段由"新关键帧"当起点——如果新关键帧不带约束，
 * 后半段就变成了自由看向：用户只是在锁定段里打了个关键帧，镜头突然不锁了。
 * 所以任何"新建关键帧"的操作都必须先继承它所在段的约束。
 */
export type CamConstraint = {
  follow?: string;
  lookAt?: string;
  lookAtOffset?: [number, number, number];
};

export const camConstraintAt = (graph: Scene3DDsl, frame: number): CamConstraint => {
  const anims = [...(graph.camera?.anim ?? [])].sort((a, b) => a.at[0] - b.at[0]);
  let cur: (typeof anims)[number] | undefined;
  for (const a of anims) if (a.at[0] <= frame) cur = a;
  if (!cur) return {};
  return {
    ...(cur.follow ? { follow: cur.follow } : {}),
    ...(cur.lookAt ? { lookAt: cur.lookAt } : {}),
    ...(cur.lookAt && cur.lookAtOffset
      ? { lookAtOffset: [...cur.lookAtOffset] as [number, number, number] }
      : {}),
  };
};

/**
 * 在某一帧用指定机位造一颗相机关键帧（**自动继承该帧所在段的约束**）。
 *
 * 为什么要收成一个函数：构造关键帧的地方有三处（视口拖手柄松手、面板打关键帧、
 * 面板改数值），每一处都"顺手写一遍 {frame,pos,target,fov,ease}"。少写一次继承，
 * 那条路径上的锁定就没了——实测就是这么被报上来的：拖一下相机，锁定静默失效。
 * 现在三处都走这里，以后加通道也只改一个地方。
 */
export const camKeyWithPose = (
  graph: Scene3DDsl,
  frameInput: number,
  pose: { pos: [number, number, number]; target: [number, number, number]; fov: number },
): CamKey => {
  const frame = Math.round(frameInput);
  return {
    frame,
    pos: pose.pos,
    target: pose.target,
    fov: pose.fov,
    ease: "easeInOut",
    ...camConstraintAt(graph, frame),
  };
};

/** 第 0 帧锚点：起始机位那一颗（同样继承 0 帧所在段的约束） */
export const camZeroKeyOf = (graph: Scene3DDsl, fps: number): CamKey => {
  const c = dslCamera(graph, 0, fps);
  return camKeyWithPose(graph, 0, { pos: c.worldPos, target: c.worldTarget, fov: c.fov });
};

/**
 * 在某一帧「锁定 / 退出锁定」看向某个节点。
 *
 * 这是本功能唯一会**改动段结构**的操作，三个坑都在这里处理：
 *
 * 1. **段中间的锁定不能直接"对半切"**：段内是 ease 曲线，[0,60] 的 easeInOut 切成
 *    [0,30]+[30,60] 后，前半段用同一条 ease 曲线走完原来一半的路程——位置在 30 帧是对的，
 *    但 0–29 帧的整条运镜轨迹全变了（镜头会先慢慢磨、再冲出去）。
 *    所以这里把原段**按线性子段重采样**（最多 12 段，用 dslCamera 逐点取值）：
 *    轨迹是原曲线的折线逼近，误差 ≤ 1%，锁定前后除了"看向"没有别的变化。
 * 2. **follow 段拒绝切**：那一段的 pos 是"相对节点的偏移"，采样回来的是世界坐标，
 *    写回去会双重偏移，镜头直接飞走。宁可拒绝并说清楚。
 * 3. **退出要把 from 的 target 拿掉**：渲染端的"退出衔接"只在这个标记存在时生效。
 *
 * 重采样的代价是段数变多（60 帧的段 → 约 12 段），相机段上限 240，正常镜头够用；
 * 关键帧列表里会看到这一串点，它们是"保持原轨迹"的采样点，删掉任何一个都会改轨迹。
 *
 * 返回 `{ anim }` 是**整组段**（调用方用 set_graph_camera 整体替换）；
 * 返回 `{ error }` 时调用方只提示、不写库。
 */
export const withCamLookAt = (
  graph: Scene3DDsl,
  frameInput: number,
  nodeId: string | null,
  fps: number,
): { anim: CamSegment[] } | { error: string } => {
  const frame = Math.round(frameInput);
  const anims: CamSegment[] = (graph.camera?.anim ?? []).map((a) => ({ ...a }));
  /** 某一帧的完整机位（世界坐标）。重采样与新建段都用它，保证"改动前后这一帧画面相同" */
  const poseAt = (f: number) => {
    const c = dslCamera(graph, f / fps, fps);
    return {
      posX: r4(c.worldPos[0]),
      posY: r4(c.worldPos[1]),
      posZ: r4(c.worldPos[2]),
      targetX: r4(c.worldTarget[0]),
      targetY: r4(c.worldTarget[1]),
      targetZ: r4(c.worldTarget[2]),
      fov: r4(c.fov),
    };
  };

  /**
   * 本轮要改约束的段范围（绝对下标，闭区间）。
   *
   * 重采样会把原段拆成十几个子段，如果只改"frame 那一小段"，锁定的作用域就从
   * "这一段的剩余部分"缩成了"接下来 5 帧"——用户点一次锁定，镜头锁 5 帧就松了。
   * 所以从 frame 起到**原段结束**的所有子段一起改，语义才是"从这一帧起锁定，直到原段边界"。
   */
  let applyFrom = 0;
  let applyTo = 0;

  /** 已经有以这一帧为起点的段就复用它 */
  let idx = anims.findIndex((a) => Math.round(a.at[0]) === frame);
  if (idx < 0) {
    const cover = anims.findIndex((a) => frame > a.at[0] && frame < a.at[1]);
    if (cover >= 0) {
      const a = anims[cover];
      if (a.follow) {
        return {
          error: `第 ${frame} 帧处在 follow（跟随）段里，位置是相对偏移，不能在这里切段。先在没有跟随的帧操作，或让 agent 改运镜`,
        };
      }
      const [s, e] = a.at;
      /**
       * 重采样：marks 一定包含 frame，这样"锁定生效的那一帧"正好落在子段边界上。
       * 步长按段长自适应，最多 12 段——再细就是无谓地吃段数上限。
       */
      const step = Math.max(2, Math.ceil((e - s) / 12));
      const marks = new Set<number>([s, e, frame]);
      for (let f = s + step; f < e; f += step) marks.add(f);
      const list = [...marks].sort((x, y) => x - y);
      const rebuilt: CamSegment[] = [];
      for (let i = 0; i < list.length - 1; i++) {
        const f0 = list[i];
        const f1 = list[i + 1];
        // 子段一律 linear：每段每段都加减速会把运镜抖成一跳一跳
        rebuilt.push({ ...a, at: [f0, f1] as [number, number], from: poseAt(f0), to: poseAt(f1), ease: "linear" });
      }
      anims.splice(cover, 1, ...rebuilt);
      const rel = rebuilt.findIndex((x) => Math.round(x.at[0]) === frame);
      if (rel < 0) return { error: `内部错误：切段没有落在第 ${frame} 帧上（marks=${list.join(",")}）` };
      idx = cover + rel;
      applyFrom = idx;
      applyTo = cover + rebuilt.length - 1;
    } else {
      /**
       * 这一帧没有任何段覆盖（没有运镜、或落在最后一段之后）：补一个单点段。
       * `at: [f, f]` 配 hold 语义 = 从这一帧起一直生效，不需要知道场景总长。
       */
      anims.push({
        at: [frame, frame],
        from: poseAt(frame),
        to: poseAt(frame),
        ease: "easeInOut",
      });
      idx = anims.length - 1;
      applyFrom = applyTo = idx;
    }
  } else {
    applyFrom = applyTo = idx;
  }

  for (let i = applyFrom; i <= applyTo; i++) {
    const seg: CamSegment = { ...anims[i] };
    if (nodeId) {
      seg.lookAt = nodeId;
      delete seg.lookAtOffset;
    } else {
      delete seg.lookAt;
      delete seg.lookAtOffset;
      /**
       * 退出锁定：只把**首段** from 里的 target 通道拿掉。
       * 渲染端的"退出衔接"只在 from 没写 target 时生效——它就靠这个标记把起点接到
       * 退出帧那一刻的锁定点上。后面那些子段的 from 是采样出来的世界坐标，必须留着，
       * 否则每一小段都要重新"衔接"一次，镜头会一段一段地顿。
       */
      if (i === applyFrom && seg.from) {
        const rest = { ...(seg.from as Record<string, number>) };
        delete rest.targetX;
        delete rest.targetY;
        delete rest.targetZ;
        seg.from = rest as CamSegment["from"];
      }
    }
    anims[i] = seg;
  }

  /** 段必须按起点排序：dslCamera 是按数组顺序逐段累积的，乱序会让后面的段覆盖前面的 */
  anims.sort((a, b) => a.at[0] - b.at[0]);
  return { anim: anims };
};
