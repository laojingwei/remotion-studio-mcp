import React from "react";
import * as THREE from "three";
import type { Theme } from "../../../shared/schema";
import type { DslNode, Scene3DDsl } from "../../../shared/scene3dDsl";
import { glowTexture, hash01, metalBody, resolveColor, shade } from "./color";
import { useDslTexture } from "./texture";

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
  /** 渲染时用的三分量缩放：有 scaleXYZ 就用它，否则用 scale 铺成三轴 */
  scale: [number, number, number];
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
    scale: base?.scaleXYZ ? [...base.scaleXYZ] as [number, number, number] : [base?.scale ?? 1, base?.scale ?? 1, base?.scale ?? 1],
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
    // 动画的 scale 是"整体缩放"：乘到三轴上，不会破坏 scaleXYZ 的比例
    const k = pick("scale", 1);
    out.scale = [out.scale[0] * k, out.scale[1] * k, out.scale[2] * k];
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
export const dslCamera = (spec: Scene3DDsl, t: number, fps = 30): DslCamera => {
  const cam = spec.camera;
  const P = new THREE.Vector3(...(cam?.position ?? [0, 1.6, 6]));
  const T = new THREE.Vector3(...(cam?.target ?? [0, 0, 0]));
  let fov = cam?.fov ?? 42;

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
        }>;
      }
    | undefined)?.anim;
  if (camAnims?.length) {
    const frame = t * fps;
    /*
     * follow：把相机钉在某个节点上。
     * 需要一个"节点在世界里的位置"求值器 —— 沿 parent 链把变换乘起来，思路和
     * three 的 Object3D 一致（T * R * S，Euler 用默认 XYZ）。这样相机的相对偏移
     * 不会因为行星公转而漂掉。
     */
    const byId = new Map(spec.nodes.map((n) => [n.id, n]));
    const worldOf = (id: string): THREE.Vector3 => {
      const chain: DslNode[] = [];
      let cur: DslNode | undefined = byId.get(id);
      let guard = 0;
      while (cur && guard++ < 16) {
        chain.unshift(cur);
        cur = cur.parent ? byId.get(cur.parent) : undefined;
      }
      const m = new THREE.Matrix4();
      for (const n of chain) {
        const tr = evalNode(n, frame);
        m.multiply(
          new THREE.Matrix4().compose(
            new THREE.Vector3(...tr.pos),
            new THREE.Quaternion().setFromEuler(
              new THREE.Euler(
                (tr.rot[0] * Math.PI) / 180,
                (tr.rot[1] * Math.PI) / 180,
                (tr.rot[2] * Math.PI) / 180,
              ),
            ),
            new THREE.Vector3(...tr.scale),
          ),
        );
      }
      return new THREE.Vector3().setFromMatrixPosition(m);
    };
    let followId: string | undefined;
    for (const a of camAnims) {
      const [start, end] = a.at;
      if (frame < start || frame > end) continue;
      const p = ease(a.ease, end > start ? (frame - start) / (end - start) : 1);
      const lv = (key: string, cur: number) => {
        const to = a.to?.[key];
        if (typeof to !== "number") return cur;
        const fr = a.from?.[key];
        const from = typeof fr === "number" ? fr : cur;
        return from + (to - from) * p;
      };
      P.set(lv("posX", P.x), lv("posY", P.y), lv("posZ", P.z));
      T.set(lv("targetX", T.x), lv("targetY", T.y), lv("targetZ", T.z));
      fov = lv("fov", fov);
      // 每段都覆盖：system 段没有 follow，必须把上一段的跟随清掉，
      // 否则绝对坐标会被再叠加一次节点位置，镜头直接飞走
      followId = a.follow;
    }
    if (followId) {
      // 段内偏移是相对量，最后统一平移到节点当前的世界位置
      const w = worldOf(followId);
      P.add(w);
      T.add(w);
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
      return <ringGeometry args={[g.innerRadius, g.outerRadius, 64]} />;
    case "dashRing":
      // 由 NodeView 用 useMemo 烘成 geometry（每次 render 重建会掉帧）
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
 * transparent 在有 map 时放宽为 true：带 alpha 通道的 PNG（镂空 Logo、剪影）
 * 必须开 transparent 才不渲成实心块；对不透明的 JPG 无视觉影响，只是进了
 * 透明渲染队列——节点数 ≤48 的场景里排序开销可忽略。
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
  const color = hasMap ? "#ffffff" : m?.body === false ? raw : metalBody(raw, 0.3, 0.18);
  const emissive = m?.emissive ? resolveColor(m.emissive, theme) : undefined;
  const op = (m?.opacity ?? 1) * opacity;
  const transparent = op < 1 || hasMap;
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
        transmission={m.transmission}
        thickness={m.thickness}
        ior={m.ior}
        emissive={emissive}
        emissiveIntensity={m.emissiveIntensity}
        side={side}
        transparent
        opacity={op}
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
      emissive={emissive}
      emissiveIntensity={m?.emissiveIntensity ?? 1}
      side={side}
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
  // hook 必须无条件调用（不能挂在 if 上）：没配 map 时返回 null，材质走纯色
  const map = useDslTexture(node.material?.map);
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
  return (
    <group position={tr.pos} rotation={rotRad} scale={tr.scale}>
      {dashGeo ? (
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
        <mesh>
          {geometryOf(node.geometry)}
          {materialOf(node, theme, tr.opacity, map)}
        </mesh>
      )}
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

/* ─────────────────────────── 光源 ─────────────────────────── */

/**
 * 场景自定义光。
 *
 * 两个渲染细节值得记：
 *
 * 1. **灯必须挂在内容 group 外面**（见下面 DslScene 的 fragment）。
 *    `camera.orbit` 的实现是"反向旋转内容组"，如果灯跟着转，太阳就会绕着地球转 ——
 *    这正是要修的那个问题（光照方向不动）的另一半。
 * 2. directional/spot 的 `target` 必须**真的加进场景**才会生效。
 *    three 用 `light.target.matrixWorld` 定方向，一个没挂进场景的 Object3D
 *    matrixWorld 永远是单位矩阵，位置就当成原点 —— 表现是"灯照哪儿都是原点"。
 *    这里用 ref 回调（commit 阶段同步执行，早于 Remotion 截图），不用 useEffect。
 */
const bindTarget = (t: [number, number, number]) => (l: THREE.DirectionalLight | THREE.SpotLight | null) => {
  if (!l) return;
  l.target.position.set(t[0], t[1], t[2]);
  if (l.parent) l.parent.add(l.target);
};

const DslLights: React.FC<{ lights: NonNullable<Scene3DDsl["lights"]>; theme: Theme }> = ({
  lights,
  theme,
}) => (
  <>
    {lights.map((l, i) => {
      const color = resolveColor(l.color, theme);
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
    <>
      {/* 灯在世界坐标里，不进下面那个会被反向旋转的内容组 */}
      {spec.lights?.length ? <DslLights lights={spec.lights} theme={theme} /> : null}
      <group quaternion={camera.quat} position={camera.groupPos}>
        {spec.particles ? <Particles spec={spec.particles} theme={theme} t={t} /> : null}
        {roots.map((n) => (
          <NodeView key={n.id} node={n} childrenOf={childrenOf} frame={frame} theme={theme} />
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
