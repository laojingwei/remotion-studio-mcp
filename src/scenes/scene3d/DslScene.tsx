import React from "react";
import * as THREE from "three";
import type { Theme } from "../../../shared/schema";
import type { DslNode, Scene3DDsl } from "../../../shared/scene3dDsl";
import { ease, evalNode } from "../../../shared/scene3dAnim";
import { indexNodes, worldPointOf } from "../../../shared/scene3dTransform";
import { hasCurve, hasTargetCurve, pathAt, type Vec3 } from "../../../shared/scene3dPath";
import { explicitBody, glowTexture, hash01, metalBody, resolveColor, shade } from "./color";
import { Ground } from "./World";
import { useDslTexture } from "./texture";
import { seqSrcAt } from "../../../shared/seqFrame";

/**
 * 场景图 DSL 的渲染器（M2）。
 *
 * 它只做"把校验过的数据翻译成 three 元素"，不含任何创意决定 —— 画质下限靠
 * 材质默认值和 `body` 那条金属规则守住，剩下的交给 agent 写的数据。
 *
 * 三条约束与预设一致：
 * 1. 画面只由帧号决定（动画是 `frame` 的纯函数，随机走确定性哈希）；
 * 2. 不用 `useFrame`；
 * 3. 粒子永远用 `<points>`（一次 draw call）。
 */

/*
 * 缓动与逐帧求值从 `shared/scene3dAnim` 来：编辑器的「打关键帧」要用**同一份**求值，
 * 否则打完之后画面会跳（两份实现迟早漂）。
 */

/* ─────────────────────────── 相机 ─────────────────────────── */

export type DslCamera = {
  camPos: [number, number, number];
  fov: number;
  quat: [number, number, number, number];
  groupPos: [number, number, number];
  /**
   * 相机在世界里的位置 / 看向点（插值之后的）。
   *
   * 为什么单独给：`camPos` 是"相机固定在 +Z 时的局部坐标"，不是世界位置。
   * 编辑器要画运镜轨迹，必须拿到世界坐标逐帧采样——从 quat/groupPos 反算一遍
   * 等于把上面的数学抄第二份，迟早漂。
   */
  worldPos: [number, number, number];
  worldTarget: [number, number, number];
  /**
   * 当前帧锁定的目标节点 id（没有就是自由看向）。
   *
   * 编辑器靠它画"锁定虚线 / 目标靶环 / 面板状态"；成片渲染不读。
   * 在这里给出而不是让编辑器另算一遍：锁定判定和求值是同一件事，
   * 分开算必然出现"面板说锁着、画面却没锁"的分裂。
   */
  lockId?: string;
};

/**
 * 把"相机在 P、看向 T"翻译成"相机固定在 +Z、把内容搬过去"。
 *
 * 为什么不直接动相机：`ThreeCanvas` 的 camera 只在建立时生效，运行时改它的朝向要写
 * `lookAt`，而那属于"命令式改动"，在跳帧渲染下很容易漏帧。把变换压到内容的 group 上，
 * 就是纯函数：同一个 frame 永远同一个姿态，也和 `orbit`（相机绕 target 转）天然等价。
 */
export const dslCamera = (spec: Scene3DDsl, t: number, fps = 30): DslCamera => {
  const cam = spec.camera;
  const P = new THREE.Vector3(...(cam?.position ?? [0, 1.6, 6]));
  const T = new THREE.Vector3(...(cam?.target ?? [0, 0, 0]));
  let fov = cam?.fov ?? 42;
  /** 当前帧生效的锁定目标（编辑器要画锁线/靶环，成片忽略） */
  let lockId: string | undefined;

  /*
   * 相机关键帧（可选）：position / target / fov 随时间插值，实现推拉、摇移、飞向某颗行星。
   * 与节点动画同一套语义：from 不写就取当前值，to 必须有值才动手；同 key 多段不要重叠。
   */
  const camAnims = (cam as
    | {
        anim?: Array<{
          at: [number, number];
          from?: Record<string, number>;
          to?: Record<string, number>;
          ease?: string;
          follow?: string;
          lookAt?: string;
          lookAtOffset?: [number, number, number];
          curve?: { out?: number[]; in?: number[]; targetOut?: number[]; targetIn?: number[] };
        }>;
      }
    | undefined)?.anim;
  if (camAnims?.length) {
    const frame = t * fps;
    /*
     * follow / lookAt 都要"节点在世界里的位置"：沿 parent 链把**含关键帧**的变换乘起来。
     * 用 shared 里那一份（worldPointOf），因为编辑器画轨迹、面板显示锁定状态读的是同一份；
     * 各写一份就会出现"线在 A、镜头看 B"的漂移，动态画面里几乎指认不出来。
     */
    const index = indexNodes(spec.nodes);
    const worldOf = (id: string, atFrame: number): THREE.Vector3 | null => {
      const p = worldPointOf(index, id, atFrame);
      return p ? new THREE.Vector3(p[0], p[1], p[2]) : null;
    };
    let followId: string | undefined;
    /**
     * 上一段的锁定目标。退出锁定段要靠它把"退出那一刻的看向点"接上：
     * 不接的话，锁定段最后一帧看的是行星，下一段第一帧却回到旧 target，镜头当场甩出去。
     */
    let prevLock: { id: string; off: [number, number, number] } | undefined;
    /** 当前生效的锁定（循环里最后处理的段说了算 = hold 语义） */
    let lock: { id: string; off: [number, number, number] } | undefined;

    for (const a of camAnims) {
      const [start, end] = a.at;
      /**
       * 和节点同一套 hold 语义：段没开始不参与，段结束后按终值持续生效。
       * 否则"运镜到第 60 帧"之后镜头会瞬移回起始机位（最后一颗关键帧像没打过）。
       */
      if (frame < start) continue;
      const p = frame >= end ? 1 : ease(a.ease, end > start ? (frame - start) / (end - start) : 1);
      const lv = (key: string, cur: number) => {
        const to = a.to?.[key];
        if (typeof to !== "number") return cur;
        const fr = a.from?.[key];
        const from = typeof fr === "number" ? fr : cur;
        return from + (to - from) * p;
      };

      /**
       * 退出衔接：本段不锁定、上一段锁着、且**本段没有显式写 from.target** 时，
       * 起点落在"本段起始帧那一刻上一段锁定的点"上。位置连续，之后正常插值飞走。
       * 显式写了 from.target 就尊重作者意图，不插手。
       */
      const fromHasTarget =
        typeof a.from?.targetX === "number" ||
        typeof a.from?.targetY === "number" ||
        typeof a.from?.targetZ === "number";
      if (!a.lookAt && prevLock && !fromHasTarget) {
        const at = worldOf(prevLock.id, start);
        if (at) T.set(at.x + prevLock.off[0], at.y + prevLock.off[1], at.z + prevLock.off[2]);
      }

      /**
       * 位置：这一段被拉弯了就走空间曲线，否则仍是逐通道线性插值（老数据逐位不变）。
       * 相机走曲线=运镜绕弧线，这跟物体走曲线是同一份数学，所以共用 pathAt。
       */
      if (hasCurve(a.curve) && a.curve) {
        const curve = a.curve;
        const p0: Vec3 = [
          typeof a.from?.posX === "number" ? a.from.posX : P.x,
          typeof a.from?.posY === "number" ? a.from.posY : P.y,
          typeof a.from?.posZ === "number" ? a.from.posZ : P.z,
        ];
        const p1: Vec3 = [
          typeof a.to?.posX === "number" ? a.to.posX : p0[0],
          typeof a.to?.posY === "number" ? a.to.posY : p0[1],
          typeof a.to?.posZ === "number" ? a.to.posZ : p0[2],
        ];
        const q = pathAt(
          p0,
          p1,
          [curve.out?.[0] ?? 0, curve.out?.[1] ?? 0, curve.out?.[2] ?? 0],
          [curve.in?.[0] ?? 0, curve.in?.[1] ?? 0, curve.in?.[2] ?? 0],
          p,
        );
        P.set(q[0], q[1], q[2]);
      } else {
        P.set(lv("posX", P.x), lv("posY", P.y), lv("posZ", P.z));
      }
      /**
       * 看向点走**同一条曲线的切线**，不是线性插值。
       *
       * 只给位置加曲线时，机位是光滑的、镜头方向却在每段边界上折一下 ——
       * 逐帧看就是「一抖一抖」（段长 12 帧 = 每 0.4 秒抖一次）。
       * pathAt 的 out/in 描述的是"轨迹怎么弯"，看向点跟着同一条弯才是一台机器拍的。
       */
      const curveSpec = a.curve;
      if (curveSpec && (hasCurve(curveSpec) || hasTargetCurve(curveSpec))) {
        const t0: Vec3 = [
          typeof a.from?.targetX === "number" ? a.from.targetX : T.x,
          typeof a.from?.targetY === "number" ? a.from.targetY : T.y,
          typeof a.from?.targetZ === "number" ? a.from.targetZ : T.z,
        ];
        const t1: Vec3 = [
          typeof a.to?.targetX === "number" ? a.to.targetX : T.x,
          typeof a.to?.targetY === "number" ? a.to.targetY : T.y,
          typeof a.to?.targetZ === "number" ? a.to.targetZ : T.z,
        ];
        /**
         * 看向点优先用**自己的**切线。只有老数据（没写 targetOut/targetIn）
         * 才回落到位置曲线 —— 那份回落是历史行为，保留是为了别让既有工程变形。
         */
        const tOut = (hasTargetCurve(curveSpec) ? curveSpec.targetOut : curveSpec.out) ?? [0, 0, 0];
        const tIn = (hasTargetCurve(curveSpec) ? curveSpec.targetIn : curveSpec.in) ?? [0, 0, 0];
        const tq = pathAt(
          t0,
          t1,
          [tOut[0] ?? 0, tOut[1] ?? 0, tOut[2] ?? 0],
          [tIn[0] ?? 0, tIn[1] ?? 0, tIn[2] ?? 0],
          p,
        );
        T.set(tq[0], tq[1], tq[2]);
      } else {
        T.set(lv("targetX", T.x), lv("targetY", T.y), lv("targetZ", T.z));
      }
      fov = lv("fov", fov);
      // 每段都覆盖：system 段没有 follow，必须把上一段的跟随清掉，
      // 否则绝对坐标会被再叠加一次节点位置，镜头直接飞走
      followId = a.follow;
      prevLock = a.lookAt
        ? { id: a.lookAt, off: (a.lookAtOffset ?? [0, 0, 0]) as [number, number, number] }
        : undefined;
      lock = prevLock;
    }

    /**
     * 锁定：target 每帧重算成节点当前世界位置 + 偏移。
     * 放在循环外做，是因为它要覆盖掉本段里 target 通道的插值结果（targetX/Y/Z 在锁定段失效），
     * 而 follow 的平移必须知道"T 是否已经是世界坐标"——两者顺序不能反。
     */
    if (lock) {
      const at = worldOf(lock.id, frame);
      if (at) T.set(at.x + lock.off[0], at.y + lock.off[1], at.z + lock.off[2]);
      lockId = lock.id;
    }
    if (followId) {
      // 段内偏移是相对量，最后统一平移到节点当前的世界位置
      const w = worldOf(followId, frame);
      if (w) {
        P.add(w);
        /**
         * 锁定时 T 已经是世界坐标，**绝不能再叠加一次 follow 偏移**：会双倍平移，
         * 镜头直接飞出场景。没有锁定时 T 才是"相对跟随节点"的偏移。
         */
        if (!lock) T.add(w);
      }
    }
  }

  const dir = P.clone().sub(T);
  let dist = dir.length();
  if (dist < 0.05) {
    // 相机和 target 重合时给个兜底距离，否则 quaternion 会退化、画面直接空白
    dir.set(0, 0.2, 1);
    dist = 6;
  }
  const q = new THREE.Quaternion().setFromUnitVectors(
    dir.clone().normalize(),
    new THREE.Vector3(0, 0, 1),
  );
  const orbitRad = (((cam?.orbit?.degPerSec ?? 0) * t) * Math.PI) / 180;
  if (orbitRad) {
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), orbitRad));
  }
  const gp = T.clone().negate().applyQuaternion(q);
  return {
    camPos: [0, 0, dist],
    fov,
    quat: [q.x, q.y, q.z, q.w],
    groupPos: [gp.x, gp.y, gp.z],
    worldPos: [P.x, P.y, P.z],
    worldTarget: [T.x, T.y, T.z],
    lockId,
  };
};

/* ─────────────────────────── 几何体 / 材质 ─────────────────────────── */

/**
 * 把一圈虚线烘成 LineSegments：每段只放两个端点。
 *
 * 为什么不用"扁四边形带宽度"：轨道线跨 16→160 单位的距离，用世界单位定宽度，
 * 近看是粗棒、远看直接消失（全景时一条都看不见）。LineSegments 的线宽由硬件固定
 * 为 1px，远近都在，正好是"轨道虚线"该有的样子。`width` 字段保留但不再参与。
 */
const buildDashRing = (g: {
  radius: number;
  width?: number;
  count: number;
  duty: number;
}): THREE.BufferGeometry => {
  const { radius: R, count, duty } = g;
  const positions = new Float32Array(count * 6);
  const step = (Math.PI * 2) / count;
  for (let i = 0; i < count; i++) {
    const a0 = i * step;
    const a1 = a0 + step * duty;
    const o = i * 6;
    positions[o] = R * Math.cos(a0);
    positions[o + 1] = 0;
    positions[o + 2] = R * Math.sin(a0);
    positions[o + 3] = R * Math.cos(a1);
    positions[o + 4] = 0;
    positions[o + 5] = R * Math.sin(a1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return geo;
};

const geometryOf = (g: DslNode["geometry"]): React.ReactElement | null => {
  switch (g.type) {
    case "box":
      return <boxGeometry args={[g.width, g.height, g.depth]} />;
    case "sphere":
      return <sphereGeometry args={[g.radius, g.segments, Math.max(4, Math.round(g.segments * 0.75))]} />;
    case "cylinder":
      return <cylinderGeometry args={[g.radiusTop, g.radiusBottom, g.height, g.segments]} />;
    case "cone":
      return <coneGeometry args={[g.radius, g.height, g.segments]} />;
    case "torus":
      return <torusGeometry args={[g.radius, g.tube, g.radialSegments, g.tubularSegments]} />;
    case "torusKnot":
      return <torusKnotGeometry args={[g.radius, g.tube, 180, 24, g.p, g.q]} />;
    case "plane":
      return <planeGeometry args={[g.width, g.height]} />;
    case "capsule":
      return <capsuleGeometry args={[g.radius, g.length, 8, 20]} />;
    case "icosahedron":
      return <icosahedronGeometry args={[g.radius, g.detail]} />;
    case "dodecahedron":
      return <dodecahedronGeometry args={[g.radius, g.detail]} />;
    case "octahedron":
      return <octahedronGeometry args={[g.radius, g.detail]} />;
    case "ring":
      /**
       * thetaStart/thetaLength 把环拆成扇区：土星环这种**套在球体外面的透明环**，
       * 整环是一个 mesh 时，它的中心和球同心，three 的透明排序分不出先后，
       * 背半环会整个透到球体前面。拆成两个半环后中心分居球体两侧，
       * 排序就必然"先远后近"，远半被球体深度正确挡住。
       */
      return g.thetaLength != null
        ? <ringGeometry args={[g.innerRadius, g.outerRadius, 64, 1, ((g.thetaStart ?? 0) * Math.PI) / 180, (g.thetaLength * Math.PI) / 180]} />
        : <ringGeometry args={[g.innerRadius, g.outerRadius, 64]} />;
    case "dashRing":
      // 由 NodeView 用 useMemo 烘成 geometry（每次 render 重建会掉帧）
      return null;
    case "group":
      /**
       * 纯枢轴：不画任何东西。
       *
       * 它存在的意义只是给子节点一个共同的父级（整列火车、整台机器）。
       * **不能**退化成"一个 0.001 的隐形 box"——那种做法会让它参与拾取、
       * 在编辑器里被当成实体选中，用户根本分不清哪个是操控点、哪个是零件。
       */
      return null;
  }
};

/**
 * 材质。
 *
 * `body`（默认 true）走 `metalBody()`：降饱和 + 压到统一亮度。
 * 这是整套东西的"画质下限"——不然 agent 写 `color: "primary"` + `metalness: 1`
 * 就必然得到一颗果冻球，而它没法从渲染结果里看出问题在哪。
 * 想要原始色值（自发光小球、纯色剪影）就传 `body: false`。
 *
 * **贴图规则**：map 存在时 color 强制白色、body 失效。three 里 map 与 color 是
 * 相乘关系，body 的降饱和压暗会把整张贴图染成脏色——这是果冻球问题的翻版。
 * metalness/roughness 照常生效（贴图金属是合理需求）。
 * transparent 按「实际不透明度」判断，静态贴图默认不进透明队列（曾因 `op<1 || hasMap`
 * 把土星塞进透明列表、被环的深度剔掉半张脸）。只有两种例外才开：序列帧贴图
 * （src 带 {frame}，PNG 的 alpha 必须生效）和显式 `material.transparent:true`（镂空 Logo）。
 */
const materialOf = (
  node: DslNode,
  theme: Theme,
  opacity: number,
  map?: THREE.Texture | null,
): React.ReactElement => {
  const m = node.material;
  const hasMap = Boolean(map);
  const raw = hasMap ? "#ffffff" : resolveColor(m?.color ?? "accent", theme);
  /**
   * 主题 token 和显式色值走**两套**处理：
   * - token（primary/accent…）不可控，必须归一到统一亮度，否则高饱和主色一定变糖果；
   * - 显式 `#hex` 是美术写的明暗设计，只降饱和 + 压过曝，**不再拉平**。
   *   以前两者都过 `metalBody`，结果 33 个零件亮度全一样，结构完全读不出来。
   */
  const isHex = raw.startsWith("#");
  const color = hasMap
    ? "#ffffff"
    : m?.body === false
      ? raw
      : isHex
        ? explicitBody(raw)
        : metalBody(raw, 0.3, 0.18);
  const emissive = m?.emissive ? resolveColor(m.emissive, theme) : undefined;
  const op = (m?.opacity ?? 1) * opacity;
  /**
   * transparent **只看实际不透明度**，不能把 hasMap 算进去。
   * 贴图本身不透明（行星纹理），op=1 时走 opaque 列表先画、写深度；
   * 曾经写成 `op < 1 || hasMap`，土星因此被塞进透明列表、排在不透明的环之后，
   * 被环写下的深度剔掉半张脸——背半环整个"透"过球体显示（太阳系示例实测）。
   *
   * 例外就是当年的"将来"：**序列帧贴图 = 特效叠层**（src 带 {frame}），alpha 必须生效，
   * 否则 PNG 的透明区域渲成黑块；agent 也可以用 material.transparent 显式开（静态镂空 Logo）。
   */
  const transparent =
    m?.transparent ?? (op < 1 || Boolean(hasMap && node.material?.map?.src?.includes("{frame}")));
  /**
   * 自发光也吃同一张贴图（three 的 emissiveMap）：自发光是**直接叠加**的纯色，
   * 有 map 却不给 emissiveMap 时，太阳这种"贴图 + 高强度自发光"的球会被那层纯色
   * 冲成一颗均匀的橙球——贴图明明在，眼睛看不到（太阳系示例实测）。
   * 有 emissive 才挂，纯色自发光物体（无贴图）完全不受影响。
   */
  const side =
    m?.side === "double" ? THREE.DoubleSide : m?.side === "back" ? THREE.BackSide : THREE.FrontSide;

  if (m?.type === "basic") {
    return (
      <meshBasicMaterial
        key={map ? "map" : "nomap"}
        color={raw}
        map={map ?? undefined}
        wireframe={m.wireframe}
        side={side}
        transparent={transparent}
        opacity={op}
        depthWrite={op >= 1 && !transparent}
      />
    );
  }
  if (m?.type === "physical") {
    return (
      <meshPhysicalMaterial
        key={map ? "map" : "nomap"}
        color={color}
        map={map ?? undefined}
        metalness={m.metalness}
        roughness={m.roughness}
        envMapIntensity={m.envMapIntensity ?? 1}
        transmission={m.transmission}
        thickness={m.thickness}
        ior={m.ior}
        emissive={emissive}
        emissiveMap={hasMap && emissive ? (map ?? undefined) : undefined}
        emissiveIntensity={m.emissiveIntensity}
        side={side}
        transparent
        opacity={op}
        depthWrite={false}
        flatShading={m.flatShading}
      />
    );
  }
  return (
    <meshStandardMaterial
      key={map ? "map" : "nomap"}
      color={color}
      map={map ?? undefined}
      metalness={m?.metalness ?? 0.4}
      roughness={m?.roughness ?? 0.35}
      envMapIntensity={m?.envMapIntensity ?? 1}
      emissive={emissive}
      emissiveMap={hasMap && emissive ? (map ?? undefined) : undefined}
      emissiveIntensity={m?.emissiveIntensity ?? 1}
      side={side}
      transparent={transparent}
      opacity={op}
      /**
       * depthWrite 看「实际不透明度 + 是否真透明材质」：
       * 不透明的贴图行星（transparent=false）必须写深度，否则土星环的背半会整个透出来；
       * 序列帧特效 / 镂空 Logo 虽然 transparent=true，透明像素却不该写深度挡住后面的物体，
       * 所以也关掉 depthWrite。depthTest 仍开着，前方物体照常遮挡它。
       */
      depthWrite={op >= 1 && !transparent}
      flatShading={m?.flatShading ?? false}
    />
  );
};

/* ─────────────────────────── 节点 / 粒子 ─────────────────────────── */

const NodeView: React.FC<{
  node: DslNode;
  childrenOf: Map<string, DslNode[]>;
  frame: number;
  /** 工程 fps：序列帧贴图按 seqFps / fps 换算进度（不传按 30） */
  fps?: number;
  theme: Theme;
  /** 编辑器交互（成片渲染时全都不传，行为与之前一致） */
  onPick?: (id: string) => void;
  /** 双击节点：编辑器据此把镜头推到它跟前（成片不传） */
  onNodeDoubleClick?: (id: string) => void;
  selectedId?: string | null;
  /** 相机当前锁定的节点：罩一层区别于选中色的线框（成片不传） */
  lockedId?: string | null;
  onNodeObject?: (id: string, obj: THREE.Object3D | null) => void;
}> = ({ node, childrenOf, frame, fps = 30, theme, onPick, selectedId, lockedId, onNodeObject, onNodeDoubleClick }) => {
  const tr = evalNode(node, frame);
  // hook 必须无条件调用（不能挂在 if 上）：没配 map 时返回 null，材质走纯色
  /**
   * 序列帧贴图：src 带 {frame} 时按当前帧算出具体地址，每帧换一张贴图。
   * 帧号计算在 shared/seqFrame.ts（2D imageSeq 同一份逻辑）；
   * loop 默认 false —— 与 2D 一致，爆炸/破碎这类一次性特效播完停末帧，
   * 循环烟雾/流动岩浆才由 agent 显式设 map.loop:true（过去硬编码 true 会把特效反复重播）。
   */
  const mapSpec = node.material?.map;
  const mapSrc =
    mapSpec?.src?.includes("{frame}")
      ? seqSrcAt(
          mapSpec.src,
          {
            seqFrom: mapSpec.seqFrom ?? 1,
            seqTo: mapSpec.seqTo ?? 1,
            seqFps: mapSpec.seqFps ?? 30,
            loop: mapSpec.loop ?? false,
          },
          frame,
          fps,
          mapSpec.frameDigits ?? 4,
        )
      : mapSpec?.src;
  const map = useDslTexture(mapSpec && mapSrc ? { ...mapSpec, src: mapSrc } : undefined);
  const kids = childrenOf.get(node.id) ?? [];
  /*
   * **弧度**：schema 里 rotX/rotY/rotZ 写的是度（人写"23.5 度"而不是"0.41 弧度"），
   * 但 three 的 `rotation` 属性吃的是弧度。第一版直接把度数传进去，于是"倾斜 23.5 度"
   * 变成了 23.5 弧度（≈1346°）——地轴几乎是竖的、55° 的斜光束渲成了水平线。
   * 静帧里这个错看起来只是"角度有点怪"，很容易被当成审美问题放过去。
   */
  const rotRad = tr.rot.map((d) => (d * Math.PI) / 180) as [number, number, number];
  const dashGeo = React.useMemo(
    () => (node.geometry.type === "dashRing" ? buildDashRing(node.geometry) : null),
    [node.geometry],
  );
  /**
   * ref 回调必须身份稳定：内联箭头每次渲染都是新函数，React 会先调旧 ref(null)
   * 再调新 ref(obj)。编辑器视口的 onNodeObject 把这当成"对象注册表变化"去 setState，
   * 于是渲染 → ref 撤挂重挂 → setState → 再渲染……实测每秒 2000+ 次渲染，整页卡死。
   * （成片路径不传 onNodeObject，本来就进不了这个分支。）
   */
  const bindRef = React.useCallback(
    (o: THREE.Group | null) => {
      onNodeObject?.(node.id, o);
    },
    [node.id, onNodeObject],
  );
  /**
   * 轨道环（ring/dashRing）不做画布点选：环是横贯全屏的大网格，行星又正好"坐"在环上，
   * 射线永远先命中环——太阳系这种图里表现为"怎么点都选不中行星"。
   * 环要从大纲树里选（它们是结构性的枢轴，很少直接改变换）。
   */
  /**
   * 纯枢轴（group / 没有几何体）：只留一个 `<group>` 承载变换和子节点。
   *
   * 拾取和环一样从**大纲**走：枢轴没有表面，视口里点不到它是对的——
   * 给隐形枢轴做一个可点的代理几何，用户就会在画面上点到"空气"。
   */
  const pivot = !node.geometry || node.geometry.type === "group";
  const pickable =
    Boolean(onPick) && !pivot && node.geometry.type !== "ring" && node.geometry.type !== "dashRing";
  /*
   * 隐藏节点：**连子树一起不渲染**（返回 null 而不是 visible={false}）。
   * 星空挡住行星时用户会临时藏掉它，藏一个父节点却露出子节点是最难理解的行为。
   * 两个 hook 都调过了才返回，保证 hook 顺序不随 hidden 变化。
   */
  if (node.hidden) return null;
  const selected = selectedId === node.id;
  const locked = lockedId === node.id;
  return (
    <group
      position={tr.pos}
      rotation={rotRad}
      scale={tr.scale}
      // 编辑器要拿它挂操纵器（TransformControls），成片路径不传这个回调
      ref={bindRef}
      onClick={
        pickable
          ? (e) => {
              // 不冒泡：点中内层卫星就不该同时选中外层枢轴
              e.stopPropagation();
              onPick!(node.id);
            }
          : undefined
      }
      onDoubleClick={
        pickable && onNodeDoubleClick
          ? (e) => {
              e.stopPropagation();
              onNodeDoubleClick(node.id);
            }
          : undefined
      }
    >
      {pivot ? null : dashGeo ? (
        <lineSegments>
          <primitive object={dashGeo} attach="geometry" />
          <lineBasicMaterial
            color={resolveColor(node.material?.color ?? "accent", theme)}
            transparent
            opacity={(node.material?.opacity ?? 1) * tr.opacity}
            depthWrite={false}
          />
        </lineSegments>
      ) : (
        /**
         * 投影与接收阴影：DSL 场景里每个实体节点都参与。
         *
         * 只对**有地面**的场景有肉眼可见的效果（Shadow 必须落在东西上才存在）；
         * 没有地面时它就是自阴影 —— 零件之间的遮挡关系也靠它，所以默认开着。
         */
        <mesh castShadow receiveShadow>
          {geometryOf(node.geometry)}
          {materialOf(node, theme, tr.opacity, map)}
        </mesh>
      )}
      {/*
        锁定高亮：相机当前正盯着它时罩一层 primary 线框。
        和选中线框必须分色（accent），否则"我选的是它"和"镜头锁的是它"混成一个状态——
        用户在调运镜时最需要一眼分清这两件事。
      */}
      {locked && !pivot && !dashGeo ? (
        <mesh scale={1.014}>
          {geometryOf(node.geometry)}
          <meshBasicMaterial
            color={resolveColor("primary", theme)}
            wireframe
            transparent
            opacity={0.34}
            depthTest={false}
            depthWrite={false}
          />
        </mesh>
      ) : null}
      {/*
        选中高亮：同一份几何体罩一层线框（depthTest 关掉，被挡在后面也看得见）。
        用线框而不是发光/变色，是因为高亮不能改变材质判断 —— 用户在挑的是"哪个物体"。
      */}
      {selected && !pivot ? (
        dashGeo ? (
          <lineSegments>
            <primitive object={dashGeo} attach="geometry" />
            <lineBasicMaterial color={resolveColor("accent", theme)} transparent opacity={0.95} depthWrite={false} />
          </lineSegments>
        ) : (
          <mesh scale={1.02}>
            {geometryOf(node.geometry)}
            <meshBasicMaterial
              color={resolveColor("accent", theme)}
              wireframe
              transparent
              opacity={0.55}
              depthTest={false}
              depthWrite={false}
            />
          </mesh>
        )
      ) : null}
      {kids.map((c) => (
        <NodeView
          key={c.id}
          node={c}
          childrenOf={childrenOf}
          frame={frame}
          fps={fps}
          theme={theme}
          onPick={onPick}
          selectedId={selectedId}
          lockedId={lockedId}
          onNodeObject={onNodeObject}
          onNodeDoubleClick={onNodeDoubleClick}
        />
      ))}
    </group>
  );
};

const Particles: React.FC<{
  spec: NonNullable<Scene3DDsl["particles"]>;
  theme: Theme;
  t: number;
}> = ({ spec, theme, t }) => {
  const glow = glowTexture();
  const N = Math.max(0, Math.round(spec.count));
  const positions = React.useMemo(() => {
    const arr = new Float32Array(N * 3);
    const [sx, sy, sz] = spec.spread;
    for (let i = 0; i < N; i++) {
      // 球内均匀：u^(1/3)。和预设里那种"往中心聚"的指数不同 ——
      // DSL 里的粒子是通用的尘埃/星点，不该默认带某种构图倾向
      const r = Math.cbrt(hash01(i, 1));
      const theta = 2 * Math.PI * hash01(i, 2);
      const phi = Math.acos(2 * hash01(i, 3) - 1);
      const sr = Math.sin(phi);
      arr[i * 3] = r * sr * Math.cos(theta) * sx;
      arr[i * 3 + 1] = r * Math.cos(phi) * sy;
      arr[i * 3 + 2] = r * sr * Math.sin(theta) * sz;
    }
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [N, spec.spread[0], spec.spread[1], spec.spread[2]]);

  if (!N) return null;
  const spin = (t * spec.drift * 0.35 * 180) / Math.PI;
  return (
    <points rotation={[0, spin, 0]} frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        size={spec.size}
        sizeAttenuation
        color={resolveColor(spec.color, theme)}
        map={glow ?? undefined}
        transparent
        opacity={spec.opacity}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
};

/* ─────────────────────────── 光源 ─────────────────────────── */

/**
 * 场景自定义光。
 *
 * **必须和场景内容一起被"相机搬运"**（挂在 DslScene 那个 `quaternion/position`
 * 的 group 里面），这是踩出来的：
 *
 * 成片渲染并没有真的把相机放到 `camera.position` 再 `lookAt(target)`，而是把相机
 * 钉在 +Z、把**整份内容**按 `quat` 转过去、按 `groupPos` 平移（见 dslCamera 的长注释）。
 * 既然内容被搬了，灯就必须跟着搬——灯是场景的一部分，`position` 写的是世界坐标，
 * 只搬物体不搬灯，光和物体的相对方位就会随相机机位漂。
 *
 * 实际翻车现场（太阳系示例第 0 帧）：相机 target 正好落在地球中心，于是地球被搬到
 * 渲染原点，而点光源（太阳，世界原点）没搬、也还留在原点——光源直接进了地球球心。
 * 从球内部照射，表面法线全部朝外，一点漫反射都收不到，成片里地球是一颗全黑的球；
 * 编辑器视口传的是单位相机（内容不搬），同一帧里地球却亮得很正常。用户看到的就是
 * "编辑器里是亮面、成片里是暗面"。
 *
 * 另一个渲染细节：directional/spot 的 `target` 必须**真的加进场景**才会生效。
 * three 用 `light.target.matrixWorld` 定方向，一个没挂进场景的 Object3D
 * matrixWorld 永远是单位矩阵，位置就当成原点 —— 表现是"灯照哪儿都是原点"。
 * 这里用 ref 回调（commit 阶段同步执行，早于 Remotion 截图），不用 useEffect；
 * 挂进 `l.parent`（即这个 group）后，target 也随内容一起被搬运，方向不会歪。
 */
const bindTarget = (t: [number, number, number]) => (l: THREE.DirectionalLight | THREE.SpotLight | null) => {
  if (!l) return;
  l.target.position.set(t[0], t[1], t[2]);
  if (l.parent) l.parent.add(l.target);
};

const DslLights: React.FC<{
  lights: NonNullable<Scene3DDsl["lights"]>;
  theme: Theme;
  /** 阴影相机半径，0 = 不投影（见 Scene3D 的 shadowRange 说明） */
  shadowRange?: number;
}> = ({ lights, theme, shadowRange = 0 }) => {
  /**
   * 只让**第一盏** directional/spot 投影。
   *
   * 每盏投影都是一次额外的全场景渲染（2048² 的深度图）。三盏一起投，
   * 单帧成本几乎翻三倍，而视觉上第二盏的影子会被第一盏盖住 —— 白花时间。
   * 需要"软影 + 硬影分层"时再谈，现在不值得。
   */
  const shadowIdx = shadowRange
    ? lights.findIndex((l) => l.type === "directional" || l.type === "spot")
    : -1;
  const shadowProps = {
    castShadow: true,
    "shadow-mapSize": [2048, 2048] as [number, number],
    "shadow-bias": -0.0005,
    "shadow-normalBias": Math.max(0.005, shadowRange * 0.004),
    "shadow-camera-left": -shadowRange,
    "shadow-camera-right": shadowRange,
    "shadow-camera-top": shadowRange,
    "shadow-camera-bottom": -shadowRange,
    "shadow-camera-near": 0.5,
    "shadow-camera-far": shadowRange * 4,
  };
  return (
    <>
      {lights.map((l, i) => {
        const color = resolveColor(l.color, theme);
        const casts = i === shadowIdx;
        if (l.type === "ambient") {
          return <ambientLight key={i} color={color} intensity={l.intensity} />;
        }
        if (l.type === "directional") {
          return (
            <directionalLight
              key={i}
              position={l.position}
              color={color}
              intensity={l.intensity}
              ref={bindTarget(l.target)}
              {...(casts ? shadowProps : {})}
            />
          );
        }
        if (l.type === "spot") {
          return (
            <spotLight
              key={i}
              position={l.position}
              color={color}
              intensity={l.intensity}
              angle={(l.angle * Math.PI) / 180}
              penumbra={l.penumbra}
              distance={l.distance}
              decay={l.decay}
              ref={bindTarget(l.target)}
              {...(casts ? shadowProps : {})}
            />
          );
        }
        return (
          <pointLight
            key={i}
            position={l.position}
            color={color}
            intensity={l.intensity}
            distance={l.distance}
            decay={l.decay}
          />
        );
      })}
    </>
  );
};

/* ─────────────────────────── 场景本体 ─────────────────────────── */

export const DslScene: React.FC<{
  spec: Scene3DDsl;
  frame: number;
  t: number;
  /** 工程 fps：序列帧贴图换算进度用（不传按 30） */
  fps?: number;
  theme: Theme;
  camera: DslCamera;
  /** 背景交给 Scene3D 画（它要区分"自己当底"和"叠在内容上"两种情况） */
  /** 编辑器：点选节点 / 高亮节点 / 交出节点对象（挂操纵器）。成片路径都不传 */
  onPick?: (id: string) => void;
  onNodeDoubleClick?: (id: string) => void;
  selectedId?: string | null;
  /** 相机当前锁定的节点（编辑器画锁框用，成片不传） */
  lockedId?: string | null;
  onNodeObject?: (id: string, obj: THREE.Object3D | null) => void;
  /** 阴影相机半径（世界单位）；0/不给 = 这幕不投影 */
  shadowRange?: number;
}> = ({
  spec,
  frame,
  t,
  fps = 30,
  theme,
  camera,
  onPick,
  selectedId,
  lockedId,
  onNodeObject,
  onNodeDoubleClick,
  shadowRange = 0,
}) => {
  const { childrenOf, roots } = React.useMemo(() => {
    const map = new Map<string, DslNode[]>();
    for (const n of spec.nodes) {
      if (!n.parent) continue;
      const list = map.get(n.parent) ?? [];
      list.push(n);
      map.set(n.parent, list);
    }
    return { childrenOf: map, roots: spec.nodes.filter((n) => !n.parent) };
  }, [spec.nodes]);

  return (
    <>
      {/*
       * 灯必须跟内容一起进这个 group（原因见 DslLights 顶上的注释）：
       * 这个 group 承载的是"相机在 P 看向 T"的刚体变换，灯不跟着搬，
       * 光和物体的相对方位就会随相机漂移——成片里太阳会跑到地球球心去。
       */}
      <group quaternion={camera.quat} position={camera.groupPos}>
        {/* 地面和物体同一个组：相机的刚体变换要一起搬，否则地面会斜插进模型里 */}
        <Ground graph={spec} theme={theme} />
        {spec.lights?.length ? (
          <DslLights lights={spec.lights} theme={theme} shadowRange={shadowRange} />
        ) : null}
        {spec.particles ? <Particles spec={spec.particles} theme={theme} t={t} /> : null}
        {roots.map((n) => (
          <NodeView
            key={n.id}
            node={n}
            childrenOf={childrenOf}
            frame={frame}
            fps={fps}
            theme={theme}
            onPick={onPick}
            selectedId={selectedId}
            lockedId={lockedId}
            onNodeObject={onNodeObject}
            onNodeDoubleClick={onNodeDoubleClick}
          />
        ))}
      </group>
    </>
  );
};

/* 供 Scene3D 复用的两个小工具：把 look 的辉光倍数套上去 */
export const applyBloomMultiplier = (
  spec: Scene3DDsl,
  base: { strength: number; radius: number; threshold: number },
) => {
  const mul = spec.post?.bloom ?? 1;
  return {
    strength: base.strength * mul,
    radius: base.radius,
    threshold: spec.post?.threshold ?? base.threshold,
  };
};

/** 没写 camera 时给一个能自动装下内容的距离（大致按节点最大半径估） */
export const dslAutoDistance = (spec: Scene3DDsl): number => {
  if (spec.camera) return 0;
  let r = 1.2;
  for (const n of spec.nodes) {
    // 纯枢轴本身没有尺寸，不该参与"相机要退多远"的计算（它的子节点会各自算）
    if (!n.geometry || n.geometry.type === "group") continue;
    const g = n.geometry as { radius?: number; width?: number; height?: number; outerRadius?: number };
    const ext = g.radius ?? g.outerRadius ?? Math.max(g.width ?? 1, g.height ?? 1) / 2;
    const p = n.transform?.position ?? [0, 0, 0];
    const d = Math.hypot(p[0], p[1], p[2]) + ext;
    r = Math.max(r, d);
  }
  if (spec.particles) {
    r = Math.max(r, Math.max(spec.particles.spread[0], spec.particles.spread[1]));
  }
  return r;
};

export { shade };
