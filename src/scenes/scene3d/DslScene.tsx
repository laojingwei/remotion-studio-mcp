import React from "react";
import * as THREE from "three";
import type { Theme } from "../../../shared/schema";
import type { DslNode, Scene3DDsl } from "../../../shared/scene3dDsl";
import { glowTexture, hash01, metalBody, resolveColor, shade } from "./color";

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

const ease = (kind: string | undefined, x: number): number => {
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

type Tr = {
  pos: [number, number, number];
  rot: [number, number, number];
  scale: number;
  opacity: number;
};

/**
 * 求一个节点在当前帧的变换。
 *
 * 语义与 freeform 的 `evalAnim` 完全一致：**关键帧里的值是绝对值**，`from` 不写就取
 * 当前累计值，`to` 必须有值才动手（只有 from 的那段等于没写，schema 阶段已经报出来了）。
 */
const evalNode = (node: DslNode, frame: number): Tr => {
  const base = node.transform;
  const out: Tr = {
    pos: [...(base?.position ?? [0, 0, 0])] as [number, number, number],
    rot: [...(base?.rotation ?? [0, 0, 0])] as [number, number, number],
    scale: base?.scale ?? 1,
    opacity: 1,
  };
  for (const a of node.anim ?? []) {
    const [start, end] = a.at;
    if (frame < start || frame > end) continue;
    const p = ease(a.ease, end > start ? (frame - start) / (end - start) : 1);
    const pick = (k: keyof NonNullable<typeof a.to>, cur: number) => {
      const to = a.to?.[k];
      if (typeof to !== "number") return cur;
      const fromRaw = a.from?.[k];
      const from = typeof fromRaw === "number" ? fromRaw : cur;
      return from + (to - from) * p;
    };
    out.pos = [pick("posX", out.pos[0]), pick("posY", out.pos[1]), pick("posZ", out.pos[2])];
    out.rot = [pick("rotX", out.rot[0]), pick("rotY", out.rot[1]), pick("rotZ", out.rot[2])];
    out.scale = pick("scale", out.scale);
    out.opacity = pick("opacity", out.opacity);
  }
  return out;
};

/* ─────────────────────────── 相机 ─────────────────────────── */

export type DslCamera = {
  camPos: [number, number, number];
  fov: number;
  quat: [number, number, number, number];
  groupPos: [number, number, number];
};

/**
 * 把"相机在 P、看向 T"翻译成"相机固定在 +Z、把内容搬过去"。
 *
 * 为什么不直接动相机：`ThreeCanvas` 的 camera 只在建立时生效，运行时改它的朝向要写
 * `lookAt`，而那属于"命令式改动"，在跳帧渲染下很容易漏帧。把变换压到内容的 group 上，
 * 就是纯函数：同一个 frame 永远同一个姿态，也和 `orbit`（相机绕 target 转）天然等价。
 */
export const dslCamera = (spec: Scene3DDsl, t: number): DslCamera => {
  const cam = spec.camera;
  const P = new THREE.Vector3(...(cam?.position ?? [0, 1.6, 6]));
  const T = new THREE.Vector3(...(cam?.target ?? [0, 0, 0]));
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
    fov: cam?.fov ?? 42,
    quat: [q.x, q.y, q.z, q.w],
    groupPos: [gp.x, gp.y, gp.z],
  };
};

/* ─────────────────────────── 几何体 / 材质 ─────────────────────────── */

const geometryOf = (g: DslNode["geometry"]): React.ReactElement => {
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
      return <ringGeometry args={[g.innerRadius, g.outerRadius, 64]} />;
  }
};

/**
 * 材质。
 *
 * `body`（默认 true）走 `metalBody()`：降饱和 + 压到统一亮度。
 * 这是整套东西的"画质下限"——不然 agent 写 `color: "primary"` + `metalness: 1`
 * 就必然得到一颗果冻球，而它没法从渲染结果里看出问题在哪。
 * 想要原始色值（自发光小球、纯色剪影）就传 `body: false`。
 */
const materialOf = (
  node: DslNode,
  theme: Theme,
  opacity: number,
): React.ReactElement => {
  const m = node.material;
  const raw = resolveColor(m?.color ?? "accent", theme);
  const color = m?.body === false ? raw : metalBody(raw, 0.3, 0.18);
  const emissive = m?.emissive ? resolveColor(m.emissive, theme) : undefined;
  const op = (m?.opacity ?? 1) * opacity;
  const transparent = op < 1;

  if (m?.type === "basic") {
    return (
      <meshBasicMaterial color={raw} wireframe={m.wireframe} transparent={transparent} opacity={op} />
    );
  }
  if (m?.type === "physical") {
    return (
      <meshPhysicalMaterial
        color={color}
        metalness={m.metalness}
        roughness={m.roughness}
        transmission={m.transmission}
        thickness={m.thickness}
        ior={m.ior}
        emissive={emissive}
        emissiveIntensity={m.emissiveIntensity}
        transparent
        opacity={op}
        flatShading={m.flatShading}
      />
    );
  }
  return (
    <meshStandardMaterial
      color={color}
      metalness={m?.metalness ?? 0.4}
      roughness={m?.roughness ?? 0.35}
      emissive={emissive}
      emissiveIntensity={m?.emissiveIntensity ?? 1}
      transparent={transparent}
      opacity={op}
      flatShading={m?.flatShading ?? false}
    />
  );
};

/* ─────────────────────────── 节点 / 粒子 ─────────────────────────── */

const NodeView: React.FC<{
  node: DslNode;
  childrenOf: Map<string, DslNode[]>;
  frame: number;
  theme: Theme;
}> = ({ node, childrenOf, frame, theme }) => {
  const tr = evalNode(node, frame);
  const kids = childrenOf.get(node.id) ?? [];
  return (
    <group position={tr.pos} rotation={tr.rot} scale={tr.scale}>
      <mesh>
        {geometryOf(node.geometry)}
        {materialOf(node, theme, tr.opacity)}
      </mesh>
      {kids.map((c) => (
        <NodeView key={c.id} node={c} childrenOf={childrenOf} frame={frame} theme={theme} />
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

/* ─────────────────────────── 场景本体 ─────────────────────────── */

export const DslScene: React.FC<{
  spec: Scene3DDsl;
  frame: number;
  t: number;
  theme: Theme;
  camera: DslCamera;
  /** 背景交给 Scene3D 画（它要区分"自己当底"和"叠在内容上"两种情况） */
}> = ({ spec, frame, t, theme, camera }) => {
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
    <group quaternion={camera.quat} position={camera.groupPos}>
      {spec.particles ? <Particles spec={spec.particles} theme={theme} t={t} /> : null}
      {roots.map((n) => (
        <NodeView key={n.id} node={n} childrenOf={childrenOf} frame={frame} theme={theme} />
      ))}
    </group>
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
