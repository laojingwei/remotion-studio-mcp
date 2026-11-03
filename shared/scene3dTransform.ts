import type { DslNode } from "./scene3dDsl";

/**
 * 3D 节点变换的小型数学库：**只为「换父级但位置不跳」这一件事服务**。
 *
 * 为什么不用 three 的 Matrix4：`shared/` 现在没有任何文件依赖 three，而它们会被
 * 服务端（MCP 进程）直接 import —— 一旦这里 `import "three"`，每起一个 MCP 进程
 * 都要多解析 1MB+ 的引擎，为了几行矩阵乘法不值。所以这里手写 4×4，
 * 顺序与 three 的 `Euler('XYZ')` + `Matrix4.compose` 完全一致（有测试逐项对齐）。
 *
 * 列主序，和 `THREE.Matrix4.elements` 同一套下标：平移在 m[12..14]。
 */
export type Mat4 = number[];

export type Trs = {
  /** 世界/局部位置 */
  position: [number, number, number];
  /** 欧拉角（**度**，与 DSL 一致；内部再转弧度） */
  rotation: [number, number, number];
  /** 三轴缩放（已把 `scale` 与 `scaleXYZ` 合并成一份） */
  scale: [number, number, number];
};

const D = Math.PI / 180;
const R = 180 / Math.PI;

export const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** 节点 → TRS。`scaleXYZ` 优先于 `scale`（渲染层也是这个规则，两边必须一致） */
export function trsOfNode(node: {
  transform?: {
    position?: readonly number[];
    rotation?: readonly number[];
    scale?: number;
    scaleXYZ?: readonly number[];
  };
}): Trs {
  const t = node.transform;
  const p = t?.position ?? [0, 0, 0];
  const r = t?.rotation ?? [0, 0, 0];
  const s = t?.scale ?? 1;
  const sxyz = t?.scaleXYZ;
  return {
    position: [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0],
    rotation: [r[0] ?? 0, r[1] ?? 0, r[2] ?? 0],
    scale: sxyz ? [sxyz[0], sxyz[1], sxyz[2]] : [s, s, s],
  };
}

/** R·S + T，欧拉顺序 XYZ（与 three 的 makeRotationFromEuler 一致） */
export function composeTrs(t: Trs): Mat4 {
  const [x, y, z] = t.rotation.map((d) => d * D) as [number, number, number];
  const c1 = Math.cos(x);
  const s1 = Math.sin(x);
  const c2 = Math.cos(y);
  const s2 = Math.sin(y);
  const c3 = Math.cos(z);
  const s3 = Math.sin(z);
  // 行主序先算出来，再按列塞进列主序数组（下标错一位就是"转了但方向不对"，所以对照 three 抄）
  const m11 = c2 * c3;
  const m12 = -c2 * s3;
  const m13 = s2;
  const m21 = c1 * s3 + s1 * s2 * c3;
  const m22 = c1 * c3 - s1 * s2 * s3;
  const m23 = -s1 * c2;
  const m31 = s1 * s3 - c1 * s2 * c3;
  const m32 = s1 * c3 + c1 * s2 * s3;
  const m33 = c1 * c2;
  const [sx, sy, sz] = t.scale;
  return [
    m11 * sx, m21 * sx, m31 * sx, 0,
    m12 * sy, m22 * sy, m32 * sy, 0,
    m13 * sz, m23 * sz, m33 * sz, 0,
    t.position[0], t.position[1], t.position[2], 1,
  ];
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out: number[] = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

/** 一般 4×4 求逆（余子式展开，与 three 的实现同源） */
export function invert(m: Mat4): Mat4 {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return IDENTITY.slice();
  const id = 1 / det;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * id,
    (a02 * b10 - a01 * b11 - a03 * b09) * id,
    (a31 * b05 - a32 * b04 + a33 * b03) * id,
    (a22 * b04 - a21 * b05 - a23 * b03) * id,
    (a12 * b08 - a10 * b11 - a13 * b07) * id,
    (a00 * b11 - a02 * b08 + a03 * b07) * id,
    (a32 * b02 - a30 * b05 - a33 * b01) * id,
    (a20 * b05 - a22 * b02 + a23 * b01) * id,
    (a10 * b10 - a11 * b08 + a13 * b06) * id,
    (a01 * b08 - a00 * b10 - a03 * b06) * id,
    (a30 * b04 - a31 * b02 + a33 * b00) * id,
    (a21 * b02 - a20 * b04 - a23 * b00) * id,
    (a11 * b07 - a10 * b09 - a12 * b06) * id,
    (a00 * b09 - a01 * b07 + a02 * b06) * id,
    (a31 * b01 - a30 * b03 - a32 * b00) * id,
    (a20 * b03 - a21 * b01 + a22 * b00) * id,
  ];
}

export function decomposeTrs(m: Mat4): Trs {
  let sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  // 行列式为负 = 有轴被镜像过。把 x 轴翻回去，否则解出来的欧拉角会多转 180°
  const det =
    m[0] * (m[5] * m[10] - m[6] * m[9]) -
    m[4] * (m[1] * m[10] - m[2] * m[9]) +
    m[8] * (m[1] * m[6] - m[2] * m[5]);
  if (det < 0) sx = -sx;
  const inv = (v: number, s: number) => (s ? v / s : 0);
  const m11 = inv(m[0], sx);
  const m21 = inv(m[1], sx);
  const m31 = inv(m[2], sx);
  const m12 = inv(m[4], sy);
  const m22 = inv(m[5], sy);
  const m32 = inv(m[6], sy);
  const m13 = inv(m[8], sz);
  const m23 = inv(m[9], sz);
  const m33 = inv(m[10], sz);

  // 欧拉 XYZ 反解（three 的 Euler.setFromRotationMatrix 中 order==='XYZ' 分支）
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  const y = Math.asin(clamp(m13));
  let x: number;
  let z: number;
  if (Math.abs(m13) < 0.9999999) {
    x = Math.atan2(-m23, m33);
    z = Math.atan2(-m12, m11);
  } else {
    x = Math.atan2(m32, m22);
    z = 0;
  }
  return {
    position: [m[12], m[13], m[14]],
    rotation: [x * R, y * R, z * R],
    scale: [sx, sy, sz],
  };
}

/** 沿 parent 链把局部变换乘到根，得到世界矩阵（**只看基础 transform，不含关键帧**） */
export function worldMatrixOf(nodes: DslNode[], id: string): Mat4 | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (!byId.has(id)) return null;
  const chain: DslNode[] = [];
  let cur: DslNode | undefined = byId.get(id);
  let guard = 0;
  while (cur && guard++ <= nodes.length) {
    chain.unshift(cur);
    cur = cur.parent ? byId.get(cur.parent) : undefined;
  }
  if (guard > nodes.length + 1) return null; // 成环：交给 dslIssues 报，这里不死循环
  let m: Mat4 = IDENTITY.slice();
  for (const n of chain) m = multiply(m, composeTrs(trsOfNode(n)));
  return m;
}

/**
 * 把节点换到新父级下，并保持它**在世界里的位置/角度/大小不变**。
 *
 * 这是"把地球拖到月球那个枢轴底下"的关键：直接改 parent，局部坐标会被父级再乘一次，
 * 行星当场飞到轨道外面（用户第一反应是"编辑器把我东西弄坏了"）。
 * 返回的是新的局部 transform；父级存在非等比缩放时会有剪切，此时只能近似（调用方提示）。
 */
export function reparentLocalTrs(
  nodes: DslNode[],
  nodeId: string,
  newParentId: string | undefined,
): Trs | null {
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const world = worldMatrixOf(nodes, nodeId);
  if (!world) return null;
  const parentWorld = newParentId ? worldMatrixOf(nodes, newParentId) : IDENTITY.slice();
  if (!parentWorld) return null;
  return decomposeTrs(multiply(invert(parentWorld), world));
}

/** 节点自身或祖先链上有没有关键帧（有则不保证"换父级后画面完全不变"） */
export function hasAnimatedChain(nodes: DslNode[], id: string): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let cur: DslNode | undefined = byId.get(id);
  let guard = 0;
  while (cur && guard++ <= nodes.length) {
    if ((cur.anim ?? []).length) return true;
    cur = cur.parent ? byId.get(cur.parent) : undefined;
  }
  return false;
}
