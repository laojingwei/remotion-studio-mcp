import React from "react";
import * as THREE from "three";
import type { Theme } from "../../../shared/schema";
import type { Scene3DDsl } from "../../../shared/scene3dDsl";
import { luminance, resolveColor } from "./color";
import { skyShader } from "./env";

/**
 * 「世界」：渐变天空 + 地面。
 *
 * ## 为什么不能用主题底色
 *
 * 主题的 `background` 是**排版用的纸**，不是**环境**。它要保证 2D 文字的可读性，
 * 所以暗色主题一定是近黑（本项目默认 `#0B0B10`）。把它当 3D 的世界，
 * 等于把模型摆在黑摄影棚里、还不开背景灯：物体边缘直接溶进背景，
 * 没有地平线、没有空气、没有远景 —— 就是「乌漆麻黑、看不清」。
 *
 * 真实作品的背景永远是**独立的**：Blender 的 world、C4D 的背景对象、Unreal 的 SkyAtmosphere，
 * 都和 UI 主题无关。它们的共同点是"天顶偏暗、地平线偏亮、中间一道漫射光带"，
 * 因为那才是眼睛熟悉的样子（大气散射）。
 *
 * `world.mode = "auto"` 时只借主题的**明暗**（暗主题给夜、浅主题给天光），
 * 色相固定为中性冷灰 —— 不跟主题色走，避免"绿主题配绿天"这种一眼假的画面。
 */

export type WorldColors = { top: string; bottom: string; glow: string };

/** 暗主题：深蓝灰的夜，地平线稍亮，带一点冷调漫射 */
const NIGHT: WorldColors = { top: "#0A0D14", bottom: "#2B3342", glow: "#22304A" };
/** 浅主题：冷白的天光，越靠地平线越亮 */
const DAY: WorldColors = { top: "#B9C3D3", bottom: "#EDEFF3", glow: "#FFFFFF" };

export const resolveWorld = (graph: Scene3DDsl | undefined, theme: Theme): WorldColors => {
  const w = graph?.world;
  if (w?.mode === "color" && w.color) {
    const c = resolveColor(w.color, theme);
    return { top: c, bottom: c, glow: "#000000" };
  }
  if (w?.mode === "gradient") {
    return {
      top: w.top ? resolveColor(w.top, theme) : NIGHT.top,
      bottom: w.bottom ? resolveColor(w.bottom, theme) : NIGHT.bottom,
      glow: w.glow ? resolveColor(w.glow, theme) : NIGHT.glow,
    };
  }
  return luminance(theme.palette.background) < 0.32 ? NIGHT : DAY;
};

/**
 * 天空球。
 *
 * 半径 3000：相机的 far 是 12000（太阳系那种一镜到底要拉很远），
 * 天空必须在这个范围里，否则会被裁掉变成"什么都没有"（背景一片死黑）。
 *
 * **不跟着内容的刚体变换走**：天空是无限远的，平移它没有视觉意义；
 * 而且它在渲染原点就够大了，内容的位移量（几十到几百）在 3000 的半径下可忽略。
 */
export const SkyDome: React.FC<{ colors: WorldColors }> = ({ colors }) => {
  const uniforms = React.useMemo(
    () => ({
      topColor: { value: new THREE.Color(colors.top) },
      bottomColor: { value: new THREE.Color(colors.bottom) },
      glowColor: { value: new THREE.Color(colors.glow).multiplyScalar(0.55) },
    }),
    [colors.top, colors.bottom, colors.glow],
  );
  return (
    <mesh renderOrder={-1000} frustumCulled={false}>
      <sphereGeometry args={[3000, 32, 24]} />
      <shaderMaterial
        uniforms={uniforms}
        vertexShader={skyShader.vertex}
        fragmentShader={skyShader.fragment}
        side={THREE.BackSide}
        depthWrite={false}
        // 天空不参与雾：它就是"雾的尽头"，再被雾洗一遍就成了纯色
        fog={false}
      />
    </mesh>
  );
};

/**
 * 自动地面高度：所有实体节点里**最低的那个**再往下一丁点。
 *
 * 为什么要算而不是默认 0：原点在哪儿完全取决于作者的习惯 ——
 * 蒸汽机车的轮子在 y=-0.16、枕木在 -0.56，地面放 0 会横穿车体；
 * 而太阳系示例的行星都在 y=0 上，地面放 0 又正好。写死哪个都错。
 */
const autoGroundY = (graph: Scene3DDsl): number => {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const worldY = (id: string): number => {
    const n = byId.get(id);
    if (!n) return 0;
    const own = n.transform?.position?.[1] ?? 0;
    // 父链最多走 16 层：数据里已经校验过不成环，这里只是防呆
    let hops = 0;
    let cur = n.parent ? byId.get(n.parent) : undefined;
    let acc = own;
    while (cur && hops++ < 16) {
      acc += cur.transform?.position?.[1] ?? 0;
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
    return acc;
  };
  const ys = graph.nodes
    .filter((n) => n.geometry && n.geometry.type !== "group" && !n.hidden)
    .map((n) => worldY(n.id));
  return ys.length ? Math.min(...ys) - 0.02 : 0;
};

export const groundYOf = (graph: Scene3DDsl): number => graph.ground?.y ?? autoGroundY(graph);

/**
 * 地面。
 *
 * **必须渲染在内容的刚体 group 里**（DslScene 内），不能放在场景根上：
 * DSL 的相机是通过"把内容搬到渲染原点"实现的（见 DslScene.dslCamera），
 * 地面留在世界坐标里就会和物体脱开 —— 表现是"地面斜着插进车里"。
 */
export const Ground: React.FC<{ graph: Scene3DDsl; theme: Theme }> = ({ graph, theme }) => {
  const spec = graph.ground;
  if (!spec) return null;
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, groundYOf(graph), 0]} receiveShadow={spec.shadow}>
      <planeGeometry args={[spec.size, spec.size]} />
      <meshStandardMaterial
        color={resolveColor(spec.color, theme)}
        roughness={spec.roughness}
        metalness={spec.metalness}
        // 地面不发光，但要吃一点环境反射，否则是一块死平的灰
        envMapIntensity={0.8}
        dithering
      />
    </mesh>
  );
};

/**
 * 空气透视的距离：
 *
 * 雾太近会把主体洗掉，太远等于没有。按场景的自动取景距离推：
 * 主体在 1 倍距离处、雾从 1.6 倍开始 —— 也就是"主体全清晰，远处地面淡出"。
 * 天文场景（autoDist 几十上百）自然得到很大的雾距，等于不开。
 *
 * `haze` 只压"雾的终点"：0 = 关（调用方直接不挂 fog），1 = 终点收到 1.4 倍距离。
 * 不动起点是有意的——起点一近，主体自己就开始发灰，那是最常见的"雾用过头"。
 */
export const fogRange = (autoDist: number, haze = 0.35): [number, number] => {
  const near = Math.max(6, autoDist * 1.6);
  const far = Math.max(near * 1.6, Math.max(40, autoDist * 7) * (1 - haze * 0.6));
  return [near, far];
};
