import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type { Scene, Theme } from "@shared/schema";
import type { Op } from "@shared/ops";
import type { DslNode, Scene3DDsl } from "@shared/scene3dDsl";
import { DslScene, dslCamera, type DslCamera } from "../../src/scenes/scene3d/DslScene";
import {
  LookLights,
  bloomFor,
  resolveLook,
  setupEnvironment,
  type LightSpec,
  type Scene3DLook,
  type Scene3DPreset,
} from "../../src/scenes/scene3d/Scene3D";
import { installBloom } from "../../src/scenes/scene3d/bloom";
import { evalNode, nodeBaseScale } from "@shared/scene3dAnim";
import {
  camAnimFromKeys,
  camKeyFrames,
  nodeAnimFromKeys,
  nodeKeyAt,
  nodeKeysOf,
  upsertKey,
  upsertKeyKeepingZero,
} from "@shared/scene3dKeys";
import { camKeysOf } from "./scene3dCamKeys";
import { useDoc } from "../store";
import { frameBus } from "../frameBus";
import { SCENE3D_SEED } from "./scene3dSeed";

/**
 * 3D 编辑视口（M2）。
 *
 * 它与成片**共用**的东西，是这个视口可信的唯一原因：
 * - 同一份渲染器 `DslScene`（几何/材质/贴图/粒子/自定义灯都在里面）；
 * - 同一套打光 `LookLights` + `resolveLook`；
 * - 同一套辉光 `bloomFor` + `installBloom`；
 * - 同一套环境贴图 `setupEnvironment`。
 * 各写一份的结局是"视口好看、成片颜色不对"，而这种偏差只能靠肉眼发现。
 *
 * 唯一的区别是**相机**：成片的相机被 `graph.camera` 钉死在构图里，这里用
 * OrbitControls 自由观察。所以 DslScene 拿到的是"单位相机组"——内容直接落在
 * 世界坐标里，相机想怎么转就怎么转。「对齐成片相机」把轨道相机摆回成片机位，
 * 用来核对构图（M2 的验收条件之一）。
 */

const IDENTITY_CAMERA: DslCamera = {
  camPos: [0, 0, 8],
  fov: 45,
  quat: [0, 0, 0, 1],
  groupPos: [0, 0, 0],
  worldPos: [0, 0, 8],
  worldTarget: [0, 0, 0],
};

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

/**
 * 场景尺度（粗略半径）。只用来定两件事：轨道相机的缩放上下限、远处裁切面。
 *
 * 为什么不遍历真实对象算 Box3：调用点在 `graph` 变化时，此时注册表可能还没更新；
 * 而且这里只需要"量级"——差一两倍不影响"能不能贴近看/能不能拉远"。
 */
const sceneExtentOf = (graph: Scene3DDsl): number => {
  const num = (o: Record<string, unknown>, k: string) => (typeof o[k] === "number" ? (o[k] as number) : 0);
  let maxR = 1;
  for (const n of graph.nodes ?? []) {
    const t = (n.transform ?? {}) as Record<string, unknown>;
    const p = (t.position as number[]) ?? [0, 0, 0];
    const s = typeof t.scale === "number" ? t.scale : 1;
    const g = ((n.geometry ?? {}) as unknown) as Record<string, unknown>;
    // 各种几何的"尺寸"字段名不同，取最大的那个当半径上限即可
    const r = Math.max(
      num(g, "radius"),
      num(g, "outerRadius"),
      num(g, "length"),
      num(g, "width"),
      num(g, "height"),
      num(g, "depth"),
    );
    maxR = Math.max(maxR, Math.hypot(p[0], p[1], p[2]) + Math.abs(r * s));
  }
  // 成片机位也算：机位在 60 单位外时，视野上限必须够得着它（否则「看相机」之后转不动）
  const cam = dslCamera(graph, 0, 30).worldPos;
  maxR = Math.max(maxR, Math.hypot(cam[0], cam[1], cam[2]));
  return maxR;
};

/** 弧度 → 度数，归一化到 (-180, 180]（否则拖几圈会写进 720 这种值） */
const degOf = (rad: number) => {
  const d = (rad * 180) / Math.PI;
  return Math.round((((d + 180) % 360 + 360) % 360 - 180) * 1e3) / 1e3;
};

/* ────────────────────────── 视口内的部件 ────────────────────────── */

/** 轨道相机 + 「对齐成片相机」入口 */
type ViewApi = {
  alignToFilm: () => void;
  /** 把观察镜头摆到成片相机斜后方（相机实体可能落在初始视野外，运镜前先看它） */
  focusShotCamera: () => void;
  /** 屏幕空间宽容拾取：返回 (clientX, clientY) 附近最值得选中的节点 id，没有则 null */
  pickAt: (clientX: number, clientY: number) => string | null;
};

const OrbitRig: React.FC<{
  onApi: (api: ViewApi | null) => void;
  disabled: boolean;
  /** 用 ref 传：每帧都变，放进 deps 会让 effect 每帧重装一次 */
  filmCamera: React.RefObject<() => DslCamera>;
  /** 宽容拾取要查节点几何与对象注册表，同样用 ref 传避免每帧重装 */
  graphRef: React.RefObject<Scene3DDsl | null>;
  objects: React.RefObject<Map<string, THREE.Object3D>>;
  /** 场景尺度（见 sceneExtentOf）：缩放上下限与裁切面按它换算 */
  extent: number;
  /** 转视角的基准点：选中的东西（多个取重心），没有选中返回 null = 世界原点 */
  pivotOf: () => THREE.Vector3 | null;
  /** 手柄正被鼠标指着（tc.axis 非空）时为 true：那种拖动归操纵器，不能抢成转视角 */
  gizmoBusy: () => boolean;
}> = ({ onApi, disabled, filmCamera, graphRef, objects, extent, pivotOf, gizmoBusy }) => {
  const { camera, gl } = useThree();
  const controls = useMemo(() => new OrbitControls(camera, gl.domElement), [camera, gl]);
  /** 每次渲染刷新：effect 依赖里不放它们，免得选中变化就重装监听 */
  const live = useRef({ pivotOf, gizmoBusy });
  live.current = { pivotOf, gizmoBusy };

  /**
   * dispose 单独放一个 effect，且只依赖 controls 本身。
   *
   * 曾经写在"配置"那个 effect 里，而配置的依赖里有 extent——图一变（加节点、拖完写回、
   * 打关键帧都会改图）effect 就重跑，cleanup 把 controls 给 dispose 了。dispose 会摘掉
   * 全部事件监听（wheel / pointer），于是**画布还在、但再也缩放不动、也转不了视角**。
   */
  useEffect(() => () => controls.dispose(), [controls]);

  /** 视角中心只在创建时归位一次：跟着 extent 一起重置的话，拖完物体画面会跳回原点。 */
  useEffect(() => {
    controls.target.set(0, 0, 0);
    controls.update();
  }, [controls]);

  useEffect(() => {
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    /**
     * 能贴多近和场景大小**无关**：只看够不够到物体表面。所以下限是个很小的常数，
     * 不跟 extent 挂钩——否则"远处有个大星球"的场景会把下限抬到 0.45，
     * 画面中心那颗半径 0.02 的小东西就再也贴不近了（实测踩过）。
     */
    controls.minDistance = 0.005;
    /** 能看多远跟场景大小有关：上百单位的星系要能拉到框住全场，固定 240 不够。 */
    controls.maxDistance = Math.max(80, extent * 14);
    /**
     * 默认 1.0 每格只有 1.05x，从默认机位拉到能装下整个太阳系要滚四十多格
     * （"缩放太慢"的体感来源）。3.0 约 1.19x/格，二十多格走完同样的范围，
     * 还能保持"一格一格微调"的余地。
     */
    controls.zoomSpeed = 3;
    /** 朝鼠标位置缩放（Blender/Unity 场景视图的习惯）：想看清角落里那颗小行星，不用先把它转到中心。 */
    controls.zoomToCursor = true;
    // 范围变了要把当前距离夹回新范围（update 里就是做这件事）
    controls.update();
  }, [controls, extent]);

  /**
   * 近/远裁切面跟着观察距离走。
   * near 固定 0.05 时，贴到小物体跟前（< 0.05）画面整个消失；far 固定 400 时，
   * 拉远后内容被裁掉（看起来像"缩不出去"）。按距离等比换还有一个好处：
   * 深度缓冲的有效精度基本恒定，不会一拉远就出现 z-fighting。
   */
  useEffect(() => {
    const persp = camera as THREE.PerspectiveCamera;
    const apply = () => {
      const d = camera.position.distanceTo(controls.target);
      const near = Math.max(0.001, Math.min(0.05, d * 0.008));
      const far = Math.max(400, d * 10 + extent * 8);
      if (Math.abs(persp.near - near) > 1e-7 || Math.abs(persp.far - far) > 1e-3) {
        persp.near = near;
        persp.far = far;
        persp.updateProjectionMatrix();
      }
    };
    apply();
    controls.addEventListener("change", apply);
    return () => controls.removeEventListener("change", apply);
  }, [camera, controls, extent]);

  useEffect(() => {
    controls.enabled = !disabled;
  }, [controls, disabled]);

  /**
   * e2e 钩子：`web/vp-test.html` 要读「这次转视角的基准点落在哪」才验得了
   * "以选中物体为中心"这条规则。只在 dev 构建里挂，生产包会被整段摇掉。
   */
  if (import.meta.env.DEV) {
    (globalThis as Record<string, unknown>).__vpProbe = { controls, camera };
  }

  /**
   * 左键旋转由下面自己实现（绕基准点的刚体旋转），OrbitControls 只保留
   * 右键平移 / 中键推拉 / 滚轮缩放 / 双指手势。不关掉它的话，同一次拖动会被转两遍。
   */
  useEffect(() => {
    controls.mouseButtons.LEFT = null as unknown as THREE.MOUSE;
    controls.touches.ONE = null as unknown as THREE.TOUCH;
  }, [controls]);

  /**
   * **转视角 = 绕基准点做刚体旋转**：相机和"看向点"一起绕基准转，基准点本身在画面里
   * 一动不动，其余东西围着它转。
   *
   * 为什么不用 OrbitControls 的旋转：它绕的是 `target`，而 `target` 同时是 lookAt 点——
   * 把 target 换成"选中的物体"的那一下，镜头会立刻甩过去对准它（"跳镜头"）。
   * 刚体旋转只改"绕哪个点转"，一帧都不跳；想换成它说的"选中就换基准"，也就自然成立了：
   * 基准是**按下那一刻现取的**，选中变化本身绝不动镜头。
   *
   * 顺带还解决了另一个老问题：以前绕 target 转，target 又被右键平移改过，
   * 想以世界原点为基准转是做不到的；刚体旋转可以。
   *
   * 垂直方向钳在 (0.08, π−0.08)：越过极点相机会翻面，数学上转得动，观感是天旋地转。
   */
  useEffect(() => {
    const canvas = gl.domElement;
    /** 挂在 canvas 的父级 + capture：稳定抢在 OrbitControls 的 canvas 监听之前 */
    const host = canvas.parentElement ?? canvas;
    let drag: {
      id: number;
      x0: number;
      y0: number;
      pivot: THREE.Vector3;
      sph0: THREE.Spherical;
      /** 当前 offset（相机 − pivot），每次移动后刷新 */
      off: THREE.Vector3;
      /** 当前 target offset（target − pivot），跟着同一个刚体转 */
      tgt: THREE.Vector3;
    } | null = null;

    const onDown = (e: PointerEvent) => {
      // 双指：这一组手势交回 OrbitControls（缩放/平移），我们不插手
      if (drag && drag.id !== e.pointerId) {
        drag = null;
        return;
      }
      if (e.button !== 0 || !controls.enabled) return;
      // 鼠标正指着手柄：这次按下属操纵器
      if (live.current.gizmoBusy()) return;
      const pivot = (live.current.pivotOf() ?? new THREE.Vector3()).clone();
      const off = camera.position.clone().sub(pivot);
      if (off.lengthSq() < 1e-9) return;
      drag = {
        id: e.pointerId,
        x0: e.clientX,
        y0: e.clientY,
        pivot,
        sph0: new THREE.Spherical().setFromVector3(off),
        off,
        tgt: controls.target.clone().sub(pivot),
      };
    };

    const onMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      // 拖满一屏高约转 160°：比 OrbitControls 默认的 360° 稳，也不至于要拖三屏才转半圈
      const speed = (Math.PI * 1.6) / Math.max(240, canvas.clientHeight);
      const dx = e.clientX - drag.x0;
      const dy = e.clientY - drag.y0;
      const phi = Math.min(Math.PI - 0.08, Math.max(0.08, drag.sph0.phi - dy * speed));
      const theta = drag.sph0.theta - dx * speed;
      const s = drag.sph0;
      const next = new THREE.Vector3().setFromSphericalCoords(s.radius, phi, theta);
      if (next.distanceToSquared(drag.off) < 1e-12) return;
      /**
       * 增量旋转：把"当前偏移方向 → 新偏移方向"的最短弧当成刚体转角，
       * target 用同一个 dq 转过去。这样画面里是"世界绕基准点转"，没有朝向跳变；
       * 用增量而不是"初始 → 当前"一次性算，是为了避免转过大角度时最短弧选错轴。
       */
      const dq = new THREE.Quaternion().setFromUnitVectors(
        drag.off.clone().normalize(),
        next.clone().normalize(),
      );
      drag.tgt.applyQuaternion(dq);
      drag.off.copy(next);
      camera.position.copy(drag.pivot).add(drag.off);
      controls.target.copy(drag.pivot).add(drag.tgt);
      controls.update();
    };

    const onUp = (e: PointerEvent) => {
      if (drag && e.pointerId === drag.id) drag = null;
    };

    host.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      host.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [camera, controls, gl]);


  useEffect(() => {
    /**
     * 成片的相机不是真的动了相机：它把**内容**按 `quat/groupPos` 反着转，相机始终在 (0,0,dist)。
     * 所以世界坐标下的机位 = 内容组的逆矩阵 × (0,0,dist)——直接抄 camPos 会丢掉全部旋转量，
     * 得到的是"从 +Z 正对着看"的假机位，和成片构图对不上。
     */
    onApi({
      /**
       * 两遍式拾取：先精确射线（见上），点不中再按"屏幕距离 - 投影像素半径"打分，
       * 取 14px 内最好的候选。0.01 的隐形枢轴球投影后接近 0，竞争不过真行星。
       */
      pickAt: (clientX, clientY) => {
        const g = graphRef.current;
        if (!g) return null;
        const rect = gl.domElement.getBoundingClientRect();
        const px = clientX - rect.left;
        const py = clientY - rect.top;
        const persp = camera as THREE.PerspectiveCamera;
        const reg = objects.current;

        /**
         * 第一遍：精确射线。**必须自管**，不能用 R3F 的 onClick——
         * R3F 的射线是对"挂了 handler 的对象"递归打的，环网格自己没有 handler，
         * 命中后事件沿父链归给挂 handler 的枢轴祖先，于是点环选中的是 piv_*（实测
         * 太阳系扫点 15 次全选成 piv_mercury）。这里逐命中向上找归属节点，
         * 环/dashRing 的命中**整条丢弃**，不许冒认到任何人。
         */
        if (reg && reg.size) {
          const ray = new THREE.Raycaster();
          ray.setFromCamera(
            new THREE.Vector2((px / rect.width) * 2 - 1, -(py / rect.height) * 2 + 1),
            camera,
          );
          const ownerOf = new Map<THREE.Object3D, string>();
          for (const [id, o] of reg) ownerOf.set(o, id);
          const hits = ray.intersectObjects([...reg.values()], true);
          for (const h of hits) {
            let cur: THREE.Object3D | null = h.object;
            let owner: string | null = null;
            while (cur) {
              const found = ownerOf.get(cur);
              if (found) {
                owner = found;
                break;
              }
              cur = cur.parent;
            }
            if (!owner) continue;
            // 相机实体不是节点：命中它直接返回特殊键（画面上要能点中它才能运镜）。
            // 站在相机里时（观察相机与实体距离 <1）不参与拾取：否则那颗拾取球会吃掉所有点击
            if (owner === SHOT_CAM) {
              const camObj = reg.get(SHOT_CAM);
              if (!camObj) continue;
              const wp = camObj.getWorldPosition(new THREE.Vector3());
              if (wp.distanceTo(persp.position) < 1.0) continue;
              return SHOT_CAM;
            }
            const node = g.nodes.find((n) => n.id === owner);
            if (!node || node.hidden) continue;
            const t = node.geometry.type;
            if (t === "ring" || t === "dashRing") continue; // 环：丢弃，不向上冒认
            return owner;
          }
        }

        // 第二遍：屏幕空间宽容拾取（行星在画面上只有几个像素，精确射线点不中是常态）
        const pxPerWorld = persp.fov ? gl.domElement.clientHeight / (2 * Math.tan((persp.fov * Math.PI) / 360)) : 0;
        const v = new THREE.Vector3();
        const world = new THREE.Vector3();
        let best: string | null = null;
        let bestScore = 14;
        for (const n of g.nodes) {
          const t = n.geometry.type;
          if (t === "ring" || t === "dashRing") continue; // 轨道线不当拾取目标：与 DslScene 的 pickable 口径一致，环只从树选
          const obj = objects.current?.get(n.id);
          if (!obj || !obj.visible) continue;
          obj.getWorldPosition(world);
          const camDist = world.distanceTo(camera.position);
          if (camDist < 1e-3) continue;
          v.copy(world).project(camera);
          if (v.z < -1 || v.z > 1) continue; // 相机身后
          const sx = ((v.x + 1) / 2) * rect.width;
          const sy = ((1 - v.y) / 2) * rect.height;
          const rWorld =
            (n.geometry as { radius?: number }).radius ??
            (Math.max(
              (n.geometry as { width?: number }).width ?? 0,
              (n.geometry as { height?: number }).height ?? 0,
              (n.geometry as { depth?: number }).depth ?? 0,
            ) / 2);
          const rPx = Math.min(24, (rWorld / camDist) * pxPerWorld);
          const score = Math.hypot(sx - px, sy - py) - rPx;
          if (score < bestScore) {
            bestScore = score;
            best = n.id;
          }
        }
        return best;
      },
      alignToFilm: () => {
        const cam = filmCamera.current();
        const g = new THREE.Object3D();
        g.quaternion.fromArray(cam.quat);
        g.position.fromArray(cam.groupPos);
        g.updateMatrixWorld(true);
        const inv = new THREE.Matrix4().copy(g.matrixWorld).invert();
        const p = new THREE.Vector3(0, 0, cam.camPos[2]).applyMatrix4(inv);
        /**
         * 看向点也要反变换。渲染坐标里的原点 = 成片的 `camera.target`，不是世界原点；
         * 直接 `target.set(0,0,0)` 会让视角对着世界中心（太阳系里就是太阳），
         * 而不是成片实际拍的 planet——之前这么写，核对构图时看到的画面和成片完全不是一回事。
         */
        const t = new THREE.Vector3(0, 0, 0).applyMatrix4(inv);
        camera.position.copy(p);
        controls.target.copy(t);
        controls.update();
      },
      focusShotCamera: () => {
        // 机位解回世界坐标；观察相机摆到它斜后方 2.6 单位看住它（太近会触发实体自隐藏）
        const cam = filmCamera.current();
        const g = new THREE.Object3D();
        g.quaternion.fromArray(cam.quat);
        g.position.fromArray(cam.groupPos);
        g.updateMatrixWorld(true);
        const inv = new THREE.Matrix4().copy(g.matrixWorld).invert();
        const p = new THREE.Vector3(0, 0, cam.camPos[2]).applyMatrix4(inv);
        const t = new THREE.Vector3(0, 0, 0).applyMatrix4(inv);
        const dir = p.clone().sub(t);
        if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
        dir.normalize();
        camera.position.copy(p.clone().add(dir.multiplyScalar(2.6)).add(new THREE.Vector3(0, 0.9, 0)));
        controls.target.copy(p);
        controls.update();
      },
    });
    return () => onApi(null);
  }, [camera, controls, filmCamera, onApi]);

  useFrame(() => controls.update());
  return null;
};

/**
 * 操纵器：改的是节点的**局部**变换（和面板里那三个输入框是同一件事）。
 *
 * 只在松手时写一条 op（不在 objectChange 里写）：一是"一次手势 = 一步撤销"，
 * 二是拖动中如果跟着写库，服务端回来的 props 会和手上拖的对象打架。
 */
const Gizmo: React.FC<{
  targetId: string | null;
  /** 注册表：节点对象由 DslScene 的 ref 回调塞进来 */
  objects: React.RefObject<Map<string, THREE.Object3D>>;
  /** 对象换了（新建/重建）时 +1，用来重挂 */
  rev: number;
  mode: "translate" | "rotate" | "scale";
  onDragging: (dragging: boolean) => void;
  onCommit: () => void;
  /** 把操纵器实例交出去：转视角要看 tc.axis 判断鼠标是不是指着手柄 */
  tcOut: React.RefObject<TransformControls | null>;
}> = ({ targetId, objects, rev, mode, onDragging, onCommit, tcOut }) => {
  const { camera, gl, scene } = useThree();
  const tc = useMemo(() => new TransformControls(camera, gl.domElement), [camera, gl]);
  const cb = useRef({ onDragging, onCommit });
  cb.current = { onDragging, onCommit };
  tcOut.current = tc;

  useEffect(() => {
    const helper = tc.getHelper();
    // 操纵器要压在物体上方，不能被物体挡掉
    helper.renderOrder = 999;
    scene.add(helper);
    return () => {
      scene.remove(helper);
      tc.detach();
      tc.dispose();
    };
  }, [tc, scene]);

  useEffect(() => {
    tc.setMode(mode);
    tc.setSize(0.85);
  }, [tc, mode]);

  useEffect(() => {
    const obj = targetId ? objects.current?.get(targetId) : null;
    if (obj) tc.attach(obj);
    else tc.detach();
  }, [tc, targetId, rev, objects]);

  useEffect(() => {
    const onDrag = (e: { value?: unknown }) => cb.current.onDragging(Boolean(e.value));
    const onUp = () => cb.current.onCommit();
    tc.addEventListener("dragging-changed", onDrag as never);
    tc.addEventListener("mouseUp", onUp as never);
    return () => {
      tc.removeEventListener("dragging-changed", onDrag as never);
      tc.removeEventListener("mouseUp", onUp as never);
    };
  }, [tc]);

  return null;
};

/** 成片相机实体在注册表里的键（不是节点 id，选中的 token 是 "cam"） */
const SHOT_CAM = "__cam";

/**
 * 成片相机实体。
 *
 * 位置/朝向由 `dslCamera` 的内容反变换解回世界坐标（成片是把内容搬过去、相机钉在 +Z，
 * 直接抄 graph.camera.position 是错的——和「对齐成片相机」同一套数学）。
 *
 * 两条设计约定，都是踩过坑换来的：
 * 1. **完全命令式驱动**：位置/朝向只在 props 真的变化时写一次，其余时间以 three 对象自身
 *    为准（TransformControls 拖动时改的就是它）。以前把 position/quaternion 当 JSX prop，
 *    React 一重渲染就把正在拖的位置打回旧值，模型和看向线自然对不上。
 * 2. **每帧在 useFrame 里重算看向线/视锥**：拖动中不写库，但线要实时跟手。
 *    平移手势下 target 跟着位移走、旋转手势下 target 落在朝前方向 × 原距离上——
 *    和松手后 commitCamera 的写回语义完全一致，松手不会"跳一下"。
 */
const CameraEntity: React.FC<{
  pos: [number, number, number];
  quat: [number, number, number, number];
  target: [number, number, number];
  /** 成片画幅比例：视锥按它画，否则 16:9 的机位在 9:16 项目里会被画歪 */
  aspect: number;
  fov: number;
  selected: boolean;
  color: string;
  onObject: (o: THREE.Object3D | null) => void;
  /** 拖动中：看向点按手势语义实时推导（平移/旋转） */
  dragging: boolean;
  mode: "translate" | "rotate" | "scale";
  dragStart: React.RefObject<{ pos: THREE.Vector3; target: THREE.Vector3; dist: number } | null>;
}> = ({ pos, quat, target, aspect, fov, selected, color, onObject, dragging, mode, dragStart }) => {
  const grp = useRef<THREE.Group | null>(null);
  const { camera: orbitCam } = useThree();
  const tint = selected ? "#C6F24E" : color;

  /** 视锥：真正的 PerspectiveCamera + CameraHelper，FOV/画幅和成片一致才能看出"视角里有什么" */
  const innerCam = useMemo(() => new THREE.PerspectiveCamera(fov, aspect, 0.1, 100), []);
  const helper = useMemo(() => new THREE.CameraHelper(innerCam), [innerCam]);
  /** 看向线 + 看向点小球（线只有一条，看不出"看向哪"；有点才知道自己在瞄什么） */
  const aimObj = useMemo(
    () => new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ transparent: true, opacity: 0.55 })),
    [],
  );
  const marker = useMemo(
    () =>
      new THREE.Mesh(
        new THREE.SphereGeometry(1, 10, 8),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthTest: false }),
      ),
    [],
  );

  useEffect(() => {
    // setColors 收的是 Color 对象（内部直接读 .r/.g/.b），传字符串会得到黑色
    const c = new THREE.Color(tint);
    helper.setColors(c, c, c, c, c);
    (aimObj.material as THREE.LineBasicMaterial).color.set(tint);
    (marker.material as THREE.MeshBasicMaterial).color.set(tint);
    /**
     * 视锥不参与深度写入，透明度按选中态区分：
     * 未选中时只是"这台相机能看到什么"的淡提示（0.22），选中后加亮到 0.5。
     * 不调这个的话，近处相机的视锥会铺满整个屏幕，比被摄物体还显眼。
     */
    const hm = helper.material as THREE.LineBasicMaterial;
    hm.transparent = true;
    hm.opacity = selected ? 0.5 : 0.22;
    hm.depthWrite = false;
    marker.renderOrder = 998;
    aimObj.renderOrder = 997;
    helper.renderOrder = 996;
    // 视锥/线/小球都不能参与拾取，否则点空白会选中相机（尤其视锥线很长）
    helper.traverse((o) => {
      o.raycast = () => {};
    });
    aimObj.raycast = () => {};
    marker.raycast = () => {};
  }, [helper, aimObj, marker, tint, selected]);

  useEffect(
    () => () => {
      aimObj.geometry.dispose();
      (aimObj.material as THREE.Material).dispose();
      marker.geometry.dispose();
      (marker.material as THREE.Material).dispose();
      helper.geometry.dispose();
      (helper.material as THREE.Material).dispose();
    },
    [aimObj, marker, helper],
  );

  /** props → 对象：只在 props 真的变了时写（拖动中 props 不变，不打扰 TC） */
  useEffect(() => {
    const o = grp.current;
    if (!o) return;
    o.position.set(pos[0], pos[1], pos[2]);
    o.quaternion.fromArray(quat);
  }, [pos, quat]);

  // 复用的临时量：useFrame 每帧跑，别在里面 new
  const p = useMemo(() => new THREE.Vector3(), []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const t = useMemo(() => new THREE.Vector3(), []);
  const fwd = useMemo(() => new THREE.Vector3(), []);

  useFrame((state) => {
    const o = grp.current;
    if (!o) return;
    o.getWorldPosition(p);
    o.getWorldQuaternion(q);

    /**
     * 看向点：
     * - 拖动中按手势语义推导（平移 = 起点 target 同位移；旋转 = 机位 + 朝前 × 原距离）；
     * - 静止时用 DSL 里的 target（关键帧/环绕时它是当前帧的值）。
     * 两条路径在松手那一刻是连续的，所以不会"松手跳一下"。
     */
    const snap = dragStart.current;
    if (dragging && snap) {
      if (mode === "rotate") {
        fwd.set(0, 0, -1).applyQuaternion(q);
        t.copy(p).addScaledVector(fwd, snap.dist);
      } else {
        t.set(
          snap.target.x + (p.x - snap.pos.x),
          snap.target.y + (p.y - snap.pos.y),
          snap.target.z + (p.z - snap.pos.z),
        );
      }
    } else {
      t.set(target[0], target[1], target[2]);
    }

    // 视锥：位置/朝向跟随实体，远平面截在看向点上（"覆盖到的那块"就是取景范围）
    const dist = Math.max(0.3, p.distanceTo(t));
    innerCam.position.copy(p);
    innerCam.quaternion.copy(q);
    innerCam.fov = fov;
    innerCam.aspect = aspect;
    innerCam.near = Math.max(0.05, dist * 0.03);
    innerCam.far = dist;
    innerCam.updateProjectionMatrix();
    innerCam.updateMatrixWorld(true);
    helper.update();

    aimObj.geometry.setFromPoints([p, t]);
    marker.position.copy(t);
    /**
     * 看向点小球：**屏幕恒定 3.5px**。
     * 原来按世界尺寸算（机位到目标的 1.2%），贴到目标跟前时它会胀成一颗大球把目标糊住
     * ——"点太大挡住元素"的另一个来源。目标点只是个标记，屏幕上几像素够了。
     */
    const camDist = orbitCam.position.distanceTo(t);
    const tanHalf = Math.tan((((orbitCam as THREE.PerspectiveCamera).fov || 45) * Math.PI) / 360);
    marker.scale.setScalar(
      Math.max(1e-5, (3.5 / Math.max(1, state.size.height)) * 2 * tanHalf * camDist),
    );

    // 站进相机里时整体隐藏（否则拾取球会吃掉全屏点击）
    const hidden = orbitCam.position.distanceTo(p) < 1.0;
    o.visible = !hidden;
    helper.visible = !hidden;
    aimObj.visible = !hidden;
    marker.visible = !hidden;
  });

  const bind = useCallback(
    (o: THREE.Group | null) => {
      grp.current = o;
      if (o) {
        o.position.set(pos[0], pos[1], pos[2]);
        o.quaternion.fromArray(quat);
      }
      onObject(o);
    },
    // 只在挂载时用当时的机位初始化；后续变化走上面的 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onObject],
  );

  return (
    <>
      <group ref={bind}>
        {/* 机身 */}
        <mesh>
          <boxGeometry args={[0.34, 0.26, 0.42]} />
          <meshBasicMaterial color={tint} wireframe transparent opacity={0.95} />
        </mesh>
        {/* 镜头：四棱锥，尖端朝 -Z（画面上看得出朝哪看） */}
        <mesh position={[0, 0, -0.3]} rotation={[-Math.PI / 2, 0, 0]}>
          <coneGeometry args={[0.1, 0.22, 4]} />
          <meshBasicMaterial color={tint} wireframe transparent opacity={0.9} />
        </mesh>
        {/* 拾取兜底：实体在画面上很小，透明球扩大命中区（透明但可被射线命中） */}
        <mesh>
          <sphereGeometry args={[0.4, 12, 10]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      </group>
      <primitive object={helper} />
      <primitive object={aimObj} />
      <primitive object={marker} />
    </>
  );
};

/**
 * 相机运镜轨迹：把整条路径按帧采样画出来，关键帧处放一颗小球。
 *
 * 为什么必须有：只有一颗关键帧时画面里就是"一台相机"，人看不出镜头会往哪飞；
 * 轨迹一出来，"这一段是推近、还是绕过左面"一眼就懂，也才知道会不会撞上行星。
 *
 * 采样用渲染同一份 `dslCamera`，所以轨迹和成片里的实际运镜逐点一致。
 * 采样点数封顶 200：一条 900 帧的运镜没必要画 900 个点（帧间位移远小于像素）。
 */
/**
 * 轨迹上的点：**屏幕恒定大小**，不是世界恒定大小。
 *
 * 原来按世界尺度给半径（场景跨度的 0.6%，最大到 0.6 单位），结果是相机一拉近，
 * 关键帧小球就变成一颗大球把物体糊住（实测被报"点太大挡住元素"）；拉远又细成看不见。
 * 轨迹点只起标记作用，屏幕上 2–5px 就够认出位置，既看得见又不遮任何东西。
 *
 * 实现：几何体是单位球，每帧按透视投影反解出"屏幕上 radiusPx 对应的世界半径"再缩放。
 */
const TrackDots: React.FC<{
  points: THREE.Vector3[];
  color: string;
  opacity: number;
  /** 屏幕半径（CSS px） */
  radiusPx: number;
  renderOrder: number;
  segments?: number;
  /**
   * 每个点对应的帧号（只有关键帧球传）。给了之后，**当前帧那一颗**改用相机实体的
   * 实时世界位置：拖动相机时相机跟手，球要是留在旧位上，看起来就是"球和相机分了家"。
   */
  frames?: number[];
  frameRef?: React.RefObject<number>;
  objects?: React.RefObject<Map<string, THREE.Object3D>>;
}> = ({ points, color, opacity, radiusPx, renderOrder, segments = 8, frames, frameRef, objects }) => {
  const grp = useRef<THREE.Group | null>(null);
  const geo = useMemo(
    () => new THREE.SphereGeometry(1, segments, Math.max(4, segments - 2)),
    [segments],
  );
  useEffect(() => () => geo.dispose(), [geo]);

  const livePos = useMemo(() => new THREE.Vector3(), []);
  useFrame((state) => {
    const g = grp.current;
    if (!g) return;
    if (frames && frameRef && objects) {
      const obj = objects.current.get(SHOT_CAM);
      if (obj) {
        const f = Math.round(frameRef.current);
        obj.getWorldPosition(livePos);
        for (let i = 0; i < g.children.length; i++) {
          if (frames[i] === f) g.children[i].position.copy(livePos);
        }
      }
    }
    const cam = state.camera as THREE.PerspectiveCamera;
    const tan = Math.tan((cam.fov * Math.PI) / 360);
    const h = Math.max(1, state.size.height);
    for (const child of g.children) {
      const d = child.position.distanceTo(cam.position);
      // 屏幕 px → 世界半径：radiusPx / 屏高 * 2tan(fov/2) * 距离
      child.scale.setScalar(Math.max(1e-6, (radiusPx / h) * 2 * tan * d));
    }
  });

  return (
    <group ref={grp}>
      {points.map((p, i) => (
        <mesh key={i} position={p} geometry={geo} renderOrder={renderOrder}>
          <meshBasicMaterial color={color} transparent opacity={opacity} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
};

const CameraTrack: React.FC<{
  graph: Scene3DDsl;
  fps: number;
  durationInFrames: number;
  color: string;
  /** 选中相机时加亮，未选中时压暗免得抢画面 */
  active: boolean;
  /** 幕内当前帧（每帧都可能变，用 ref 传，别让组件跟着重渲染） */
  frameRef: React.RefObject<number>;
  /** 对象注册表：相机实体在 SHOT_CAM 键下，实时世界位置从它读 */
  objects: React.RefObject<Map<string, THREE.Object3D>>;
}> = ({ graph, fps, durationInFrames, color, active, frameRef, objects }) => {
  const { line, frames: sampleFrames, basePos, last, keyPoints, pathDots } = useMemo(() => {
    const frames = camKeyFrames(graph.camera);
    const last = Math.max(1, durationInFrames - 1);
    const step = Math.max(1, Math.round(last / 200));
    /**
     * 采样帧 = 等距采样 **∪ 每个关键帧帧号**。
     *
     * 只等距采样时，拐点（刚好落在两采样帧之间）会被折线"抄近路"切掉：关键帧小球明明
     * 在那里、相机也停在那里，可线在它旁边几像素处拐过去，看起来就是"调完位置轨迹没连上"
     * （用户截图报过）。关键帧位置本来就该是折线的顶点——它们是同一份 `dslCamera` 求出来的，
     * 加进来只多几个点，却保证"线一定穿过每一颗关键帧球"。
     */
    const sample = new Set<number>();
    for (let f = 0; f <= last; f += step) sample.add(f);
    sample.add(last);
    for (const f of frames) sample.add(Math.min(last, Math.max(0, f)));
    const sampleFrames = [...sample].sort((a, b) => a - b);
    /** 基础采样点（不含当前帧）；当前帧那一点每帧由相机实体现算，见下面的 useFrame */
    const basePos = new Float32Array(sampleFrames.length * 3);
    const pts: THREE.Vector3[] = sampleFrames.map((f, i) => {
      const w = dslCamera(graph, f / fps, fps).worldPos;
      basePos[i * 3] = w[0];
      basePos[i * 3 + 1] = w[1];
      basePos[i * 3 + 2] = w[2];
      return new THREE.Vector3(w[0], w[1], w[2]);
    });

    /**
     * 几何体预留一个位置：当前帧可能不在采样集里（等距采样间隔 6 帧），
     * 每帧把"相机现在的位置"插进去，线就永远穿过相机。
     */
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array((sampleFrames.length + 1) * 3), 3));
    geo.setDrawRange(0, sampleFrames.length);

    const mat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.5 });
    const line = new THREE.Line(geo, mat);
    line.raycast = () => {};
    line.renderOrder = 990;
    /**
     * 沿线撒点：LineBasicMaterial 的线宽被硬件钉死成 1px，长轨迹在 4K 屏上细得像没画。
     * 每隔一段放一颗小点，路径的"走向"立刻看得出来，也不用改渲染方式。
     */
    const every = Math.max(1, Math.round(pts.length / 36));
    const pathDots = pts.filter((_, i) => i > 0 && i < pts.length - 1 && i % every === 0);
    return {
      line,
      frames: sampleFrames,
      basePos,
      last,
      keyPoints: frames.map((f) => new THREE.Vector3(...dslCamera(graph, f / fps, fps).worldPos)),
      pathDots,
    };
  }, [graph, fps, durationInFrames]);

  /**
   * 每帧把"相机现在在哪"接到折线上（并把那个点画出来）。
   *
   * 起因：用户调完机位截图报"轨迹线没连上"——轨迹是按时序采样的，相机在拖动中每帧都在动，
   * 采样点却没跟着，于是线和相机之间裂开一截。相机实体才是唯一真值（拖动中也是它最准，
   * 因为拖动不写库），所以直接读它：当前帧若已在采样集里就替换那一点，否则插进去。
   * 静止时结果和原来完全一致（同一份 dslCamera），不产生任何视觉漂移。
   */
  const live = useMemo(() => new THREE.Vector3(), []);
  /**
   * 缓存键里**必须带 geometry**：图一变（改机位、打关键帧）memo 会新建几何体，
   * 新几何体里是一整片 0；只按"帧 + 位置"判断会命中缓存直接 return，那条线就永远停在原点
   * 附近（表现为"轨迹线没连上/不在原地"，实测踩过）。
   */
  const memoState = useRef({ geo: null as THREE.BufferGeometry | null, f: -1, x: NaN, y: NaN, z: NaN });
  useFrame(() => {
    const obj = objects.current.get(SHOT_CAM);
    const geoNow = line.geometry as THREE.BufferGeometry;
    const f = Math.min(last, Math.max(0, Math.round(frameRef.current)));
    const st = memoState.current;
    /** 相机实体还没注册（首帧）时退回基础采样，别把一数组 0 画上去 */
    if (!obj) {
      if (st.geo === geoNow) return;
      memoState.current = { geo: geoNow, f: -2, x: NaN, y: NaN, z: NaN };
      const g0 = geoNow;
      const a0 = g0.getAttribute("position") as THREE.BufferAttribute;
      (a0.array as Float32Array).set(basePos);
      a0.needsUpdate = true;
      g0.setDrawRange(0, sampleFrames.length);
      return;
    }
    obj.getWorldPosition(live);
    if (st.geo === geoNow && st.f === f && st.x === live.x && st.y === live.y && st.z === live.z) {
      return;
    }
    memoState.current = { geo: geoNow, f, x: live.x, y: live.y, z: live.z };

    const geo = geoNow;
    const attr = geo.getAttribute("position") as THREE.BufferAttribute;
    const out = attr.array as Float32Array;
    const src = basePos;
    let ins = sampleFrames.length;
    for (let i = 0; i < sampleFrames.length; i++) {
      if (sampleFrames[i] >= f) {
        ins = i;
        break;
      }
    }
    const exact = ins < sampleFrames.length && sampleFrames[ins] === f;
    let n = 0;
    for (let i = 0; i < ins; i++) {
      out[n++] = src[i * 3];
      out[n++] = src[i * 3 + 1];
      out[n++] = src[i * 3 + 2];
    }
    out[n++] = live.x;
    out[n++] = live.y;
    out[n++] = live.z;
    for (let i = exact ? ins + 1 : ins; i < sampleFrames.length; i++) {
      out[n++] = src[i * 3];
      out[n++] = src[i * 3 + 1];
      out[n++] = src[i * 3 + 2];
    }
    attr.needsUpdate = true;
    geo.setDrawRange(0, n / 3);
  });

  // 颜色/亮度走 effect：同一根线不重建几何，只改材质
  useEffect(() => {
    const m = line.material as THREE.LineBasicMaterial;
    m.color.set(color);
    /**
     * 未选中时也不能太淡：硬件把线宽固定成 1px，0.34 透明度在深背景上基本看不见，
     * 用户会以为"根本没画轨迹"（实测被这么报过）。0.55 是"在但不抢镜"的下限。
     */
    m.opacity = active ? 0.95 : 0.55;
    (line.geometry as THREE.BufferGeometry).attributes.position.needsUpdate = true;
  }, [line, color, active]);

  useEffect(
    () => () => {
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    },
    [line],
  );

  if (!keyPoints.length) return null;
  return (
    <>
      <primitive object={line} />
      {/* 路径点 2px、关键帧点 4.5px：比 1px 的线粗一点点，认得出来又不遮物体 */}
      <TrackDots
        points={pathDots}
        color={color}
        opacity={active ? 0.7 : 0.36}
        radiusPx={2}
        renderOrder={990}
        segments={6}
      />
      <TrackDots
        points={keyPoints}
        frames={sampleFrames}
        frameRef={frameRef}
        objects={objects}
        color={color}
        opacity={active ? 0.95 : 0.62}
        radiusPx={4.5}
        renderOrder={991}
        segments={10}
      />
    </>
  );
};

/** 辉光：和成片同一个 installBloom，只是在这里没有"截帧时序"要求，用 effect 装即可 */
const Bloom: React.FC<{ spec: LightSpec | unknown; theme: Theme; graph: Scene3DDsl; look: Scene3DLook }> = ({
  theme,
  graph,
  look,
}) => {
  const state = useThree();
  const handle = useRef<ReturnType<typeof installBloom> | null>(null);

  useEffect(() => {
    const opts = bloomFor({
      spec: resolveLook("orbit-core", look).spec,
      background: theme.palette.background,
      graph,
    });
    try {
      handle.current = installBloom(state, opts);
    } catch {
      // 环境不支持半浮点渲染目标时降级为无辉光：画面仍然可用，只是不那么亮
      handle.current = null;
    }
    return () => {
      handle.current?.dispose();
      handle.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    handle.current?.setSize(state.size.width, state.size.height);
  }, [state.size.width, state.size.height]);

  return null;
};

/* ────────────────────────── 视口本体 ────────────────────────── */

export const Scene3DViewport: React.FC<{
  scene: Scene;
  fps: number;
  /** 本幕在项目时间线上的起点帧：和 frameBus（项目帧）互转用 */
  sceneStart?: number;
  /** 成片画幅比例（宽/高）：相机视锥按它画，才是"成片里能看到的那块" */
  aspect?: number;
  onExit?: () => void;
}> = ({ scene, fps, sceneStart = 0, aspect = 16 / 9, onExit }) => {
  const apply = useDoc((s) => s.apply);
  const theme = useDoc((s) => s.project?.theme);
  const selection = useDoc((s) => s.selection);
  const setSelection = useDoc((s) => s.setSelection);
  const notify = useDoc((s) => s.notify);

  const graph = (scene.props as { graph?: Scene3DDsl }).graph;
  const props = scene.props as { preset?: Scene3DPreset; look?: Scene3DLook | "auto" };
  const resolved = resolveLook(props.preset ?? "orbit-core", props.look ?? "auto");

  const [frame, setFrame] = useState(0);
  /** 进编辑不自动播放：编辑器默认停住，让用户先看清构图再决定播不播 */
  const [playing, setPlaying] = useState(false);
  const [mode, setMode] = useState<"translate" | "rotate" | "scale">("translate");
  /** 编辑辅助（网格 + 坐标轴）显隐：有人嫌它挡画面，但没有它摆位会失去参照 */
  const [showGrid, setShowGrid] = useState(true);
  /** 运镜轨迹显隐：轨迹能看清镜头往哪飞，但长运镜横穿画面时会挡住物体 */
  const [showTrack, setShowTrack] = useState(true);
  const hasTrack = Boolean(graph?.camera?.anim?.length);
  /**
   * 场景尺度：定缩放上下限与裁切面。按 graph 缓存——只在图变了才重算，
   * 拖动手柄（每帧改对象、不改图）不会反复遍历节点。
   */
  const extent = useMemo(() => (graph ? sceneExtentOf(graph) : 8), [graph]);
  const [dragging, setDragging] = useState(false);
  const [objectsRev, setObjectsRev] = useState(0);
  const objects = useRef(new Map<string, THREE.Object3D>());
  /** 操纵器实例：转视角前要问一句"鼠标是不是正指着手柄" */
  const gizmoRef = useRef<TransformControls | null>(null);
  const api = useRef<ViewApi | null>(null);
  /** 宽容拾取用的当前图（渲染时刷新，pickAt 调用时读到的一定是新值） */
  const graphRef = useRef<Scene3DDsl | null>(null);
  graphRef.current = graph ?? null;
  /** pointerdown 落点：区分"原地点击"和"拖完视角的松手" */
  const downPos = useRef<{ x: number; y: number } | null>(null);

  /**
   * 多选（M3）：与面板同一份 selection。第一个 = 主选（手柄挂它、松手以它的世界位移为准）。
   * 顺序按 graph.nodes 排（不是 selection 原序），ctrl 乱序点选后主选不跳。
   */
  const gIds = useMemo(() => {
    const picked = new Set(selection.filter((s) => s.startsWith("g:")).map((s) => s.slice(2)));
    if (!graph) return [...picked];
    return graph.nodes.filter((n) => picked.has(n.id)).map((n) => n.id);
  }, [selection, graph]);
  const selectedId = gIds[0] ?? null;
  const node = graph?.nodes.find((n) => n.id === selectedId) ?? null;
  /** 选中的是成片相机（特殊 selection token "cam"，不是节点 id） */
  const camSelected = selection.includes("cam");
  /** 拖动相机时记下的起点：平移要按位移同步 target，旋转要按原距离重算 target */
  const camDragStart = useRef<{ pos: THREE.Vector3; target: THREE.Vector3; dist: number } | null>(null);
  /** 拖动起点时各选中节点的世界坐标：松手时按主选的位移把其它选中节点一起搬过去 */
  const dragStartWorld = useRef<{ primary: THREE.Vector3; others: Map<string, THREE.Vector3> } | null>(
    null,
  );

  /**
   * 转视角的基准点：选中节点的世界重心（多选取重心，画面里看到的就是"绕着它们转"），
   * 选中成片相机时取相机实体自己，什么都没选返回 null（视口按世界原点处理）。
   * 隐藏节点不参与：看不见的东西当基准，转起来会像"镜头绕着空气飘"。
   */
  const orbitPivot = useCallback((): THREE.Vector3 | null => {
    const sum = new THREE.Vector3();
    const v = new THREE.Vector3();
    let n = 0;
    for (const id of gIds) {
      const o = objects.current.get(id);
      if (!o || !o.visible) continue;
      sum.add(o.getWorldPosition(v));
      n++;
    }
    if (n) return sum.divideScalar(n);
    if (camSelected) {
      const camObj = objects.current.get(SHOT_CAM);
      if (camObj) return camObj.getWorldPosition(new THREE.Vector3());
    }
    return null;
  }, [gIds, camSelected]);

  /** 鼠标正指着手柄 = 这次按下归操纵器，别抢成转视角 */
  const gizmoBusy = useCallback(() => Boolean(gizmoRef.current?.axis), []);

  /** 幕内帧镜像：rAF 回调里要读当前帧，不能把 frame 放进 effect 依赖（每帧重挂） */
  const frameRef = useRef(0);
  frameRef.current = frame;
  /** 自己在驱动总线时的守卫：frameBus.set 是同步广播，别收到自己的回声 */
  const drivingRef = useRef(false);

  /**
   * 自己的播放循环：不渲染 2D Player 画面（省一份 GPU），只推进自己的幕内帧。
   * 推进的同时写 frameBus（项目帧 = sceneStart + 幕内帧），时间轴播放头跟着走。
   */
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const step = 1000 / Math.max(1, fps);
    const tick = (now: number) => {
      acc += now - last;
      last = now;
      if (acc >= step) {
        const adv = Math.floor(acc / step);
        acc -= adv * step;
        const next = (frameRef.current + adv) % Math.max(1, scene.durationInFrames);
        drivingRef.current = true;
        frameBus.set(next + sceneStart);
        drivingRef.current = false;
        setFrame(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, fps, scene.durationInFrames, sceneStart]);

  /**
   * 外部播放头（时间轴 seek / 时间轴播放，项目帧）→ 幕内帧，外部驱动时暂停自己的循环。
   * 于是：拖时间轴 3D 画面跟着走；在 3D 模式按时间轴播放，3D 动画同步演。
   */
  useEffect(() => {
    return frameBus.subscribe((gf) => {
      if (drivingRef.current) return;
      setPlaying(false);
      setFrame(Math.max(0, Math.min(scene.durationInFrames - 1, gf - sceneStart)));
    });
  }, [sceneStart, scene.durationInFrames]);

  // 换幕时对齐全局播放头对应的幕内帧（而不是无脑回 0）：这样进 3D 画面停在时间轴所在的位置
  useEffect(() => {
    objects.current.clear();
    setFrame(Math.max(0, Math.min(scene.durationInFrames - 1, frameBus.get() - sceneStart)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene.id]);

  const filmCamera = useRef(() => IDENTITY_CAMERA);
  filmCamera.current = () => (graph ? dslCamera(graph, frame / fps, fps) : IDENTITY_CAMERA);

  /** 当前帧成片相机的世界机位/朝向/看向点（和「对齐成片相机」同一套反变换） */
  const shotPose = useMemo(() => {
    const cam = graph ? dslCamera(graph, frame / fps, fps) : IDENTITY_CAMERA;
    const g = new THREE.Object3D();
    g.quaternion.fromArray(cam.quat);
    g.position.fromArray(cam.groupPos);
    g.updateMatrixWorld(true);
    const inv2 = new THREE.Matrix4().copy(g.matrixWorld).invert();
    const p = new THREE.Vector3(0, 0, cam.camPos[2]).applyMatrix4(inv2);
    const t = new THREE.Vector3(0, 0, 0).applyMatrix4(inv2);
    /**
     * 相机朝向 = film.quat 的**逆**。
     * film.quat 是"把内容转到相机空间"的旋转（把 (P−T) 转到 +Z），用它当相机朝向
     * 等于俯仰角翻倍——实测模型偏了 26°、和看向线不重合（0,1.6,7 看原点时）。
     */
    const qInv = new THREE.Quaternion().fromArray(cam.quat).invert();
    return {
      pos: [p.x, p.y, p.z] as [number, number, number],
      target: [t.x, t.y, t.z] as [number, number, number],
      quat: [qInv.x, qInv.y, qInv.z, qInv.w] as [number, number, number, number],
      fov: cam.fov,
    };
  }, [graph, frame, fps]);

  const onApi = useCallback((a: ViewApi | null) => {
    api.current = a;
  }, []);

  const onNodeObject = useCallback((id: string, obj: THREE.Object3D | null) => {
    /**
     * 按对象**身份**去重，而不是 has/delete：
     * React 每次提交都可能把函数 ref 撤了重挂（旧 ref(null) → 新 ref(obj)），
     * 同一个对象会被重复登记。用 has/delete 判定，重复登记会被当成"注册表变化"
     * 去 setState → 重渲染 → 再登记……无限渲染循环（实测每秒 2000+ 次，整页卡死）。
     */
    const prev = objects.current.get(id) ?? null;
    if (prev === obj) return;
    if (obj) objects.current.set(id, obj);
    else objects.current.delete(id);
    setObjectsRev((v) => v + 1);
  }, []);

  /** 相机实体也进同一张注册表（键 SHOT_CAM），手柄/拾取都靠它 */
  const onCameraObject = useCallback((obj: THREE.Object3D | null) => {
    const prev = objects.current.get(SHOT_CAM) ?? null;
    if (prev === obj) return;
    if (obj) objects.current.set(SHOT_CAM, obj);
    else objects.current.delete(SHOT_CAM);
    setObjectsRev((v) => v + 1);
  }, []);

  if (!theme) return <div className="vp3d-empty">加载中…</div>;
  if (!graph) {
    /**
     * 预置场景也能进 3D 编辑（否则"新增 3D 幕 → 没有 3D 编辑入口"）：
     * 预置画面由代码画、改不了单个物体，这里给一个明确的起点——
     * 换成最小可编辑图（不是转换，是新建），或者回成片画面在面板里换母题。
     */
    return (
      <div className="vp3d" style={{ background: theme.palette.background }}>
        <div className="vp3d-empty">
          <div className="vp3d-empty-title">预置 3D 场景</div>
          <p className="s3d-hint" style={{ maxWidth: 420, textAlign: "center" }}>
            这一幕用的是预置母题，画面由代码画死，没有可编辑的节点。
            换成可编辑场景图后就能逐节点搭（右栏的大纲树加物体、摆位置、打光）。
          </p>
          <button
            className="vp3d-btn"
            onClick={() =>
              void apply([
                { op: "update_scene", sceneId: scene.id, patch: { props: { graph: SCENE3D_SEED } } } as Op,
              ])
            }
          >
            换成可编辑场景图（球 + 点光 + 星尘）
          </button>
        </div>
      </div>
    );
  }

  /** 松手后写 op：一次手势 = 一步撤销（和面板、自由画布同一套约定） */
  const commitTransform = () => {
    if (!selectedId) return;
    const obj = objects.current.get(selectedId);
    const target = graph.nodes.find((n) => n.id === selectedId);
    if (!obj || !target) return;

    /**
     * 第 0 帧 = **初始位置**：非 0 帧的拖动只写关键帧，绝不碰基础变换。
     *
     * 基础变换就是 0 帧显示的值。以前只有"落在动画区间内"才写关键帧，区间外写基础值，
     * 于是在第 60 帧拖一下，0 帧也跟着跑了（这就是"0 帧变成最后一帧位置"的成因）。
     * 关键帧不足两颗时先补一颗 0 帧锚点（当时的初始姿态），0 帧因此永远不动。
     *
     * 0 帧本身有关键帧时，拖动改的是那颗（改基础值画面不会动，段的 from 盖在上面）。
     */
    const keys = nodeKeysOf(target);
    const useKeys = frame !== 0 || (keys.length > 0 && keys[0].frame === 0);

    /** 对象当前姿态 → 关键帧值（anim 的 scale 是乘在基础值上的倍率） */
    const keyOf = (
      nd: DslNode,
      pos: [number, number, number],
      rot: [number, number, number],
      absScale: number,
    ) => {
      const base = nodeBaseScale(nd);
      return {
        frame,
        pos,
        rot,
        scale: base ? absScale / base : 1,
        opacity: evalNode(nd, frame).opacity,
        ease: "easeInOut" as const,
      };
    };
    const animPatchOf = (nd: DslNode, k: ReturnType<typeof keyOf>) => ({
      anim: nodeAnimFromKeys(upsertKeyKeepingZero(nodeKeysOf(nd), k, nodeKeyAt(nd, 0))),
    });

    const ops: Op[] = [];
    if (useKeys) {
      ops.push({
        op: "update_graph_node",
        sceneId: scene.id,
        nodeId: selectedId,
        patch: animPatchOf(
          target,
          keyOf(
            target,
            [r4(obj.position.x), r4(obj.position.y), r4(obj.position.z)],
            [degOf(obj.rotation.x), degOf(obj.rotation.y), degOf(obj.rotation.z)],
            Math.abs(obj.scale.x),
          ),
        ),
      } as Op);
    } else {
      const wasXYZ = Boolean(target.transform?.scaleXYZ);
      const s = obj.scale;
      const uniform = Math.abs(s.x - s.y) < 1e-4 && Math.abs(s.y - s.z) < 1e-4;
      const transform: Record<string, unknown> = {
        position: [r4(obj.position.x), r4(obj.position.y), r4(obj.position.z)],
        rotation: [degOf(obj.rotation.x), degOf(obj.rotation.y), degOf(obj.rotation.z)],
        ...(wasXYZ || !uniform
          ? { scaleXYZ: [r4(Math.abs(s.x)), r4(Math.abs(s.y)), r4(Math.abs(s.z))] }
          : { scale: r4(Math.abs(s.x)) }),
      };
      ops.push({
        op: "update_graph_node",
        sceneId: scene.id,
        nodeId: selectedId,
        patch: { transform },
      } as Op);
    }

    /** 多选整体平移：其它选中节点保持与主选的相对关系，一起挪同样的**世界**位移。
     *  只在平移模式生效（旋转/缩放以谁为中心说不清，先只动主选）。
     *  世界 → 局部要过父级的逆矩阵：挂在枢轴下的节点（行星在 piv 下）直接抄
     *  世界位移会错一个旋转量。和主选同一套规则：非 0 帧写关键帧。 */
    const moved: string[] = [selectedId];
    const snap = dragStartWorld.current;
    if (mode === "translate" && snap && gIds.length > 1) {
      const now = obj.getWorldPosition(new THREE.Vector3());
      const delta = now.clone().sub(snap.primary);
      if (delta.lengthSq() > 1e-10) {
        for (const id of gIds) {
          if (id === selectedId) continue;
          const before = snap.others.get(id);
          const o = objects.current.get(id);
          const nd = graph.nodes.find((n) => n.id === id);
          if (!before || !o || !nd || nd.locked) continue;
          o.parent?.updateWorldMatrix(true, false);
          const inv = o.parent ? o.parent.matrixWorld.clone().invert() : new THREE.Matrix4();
          const local = before.clone().add(delta).applyMatrix4(inv);
          if (useKeys) {
            ops.push({
              op: "update_graph_node",
              sceneId: scene.id,
              nodeId: id,
              patch: animPatchOf(
                nd,
                keyOf(
                  nd,
                  [r4(local.x), r4(local.y), r4(local.z)],
                  [degOf(o.rotation.x), degOf(o.rotation.y), degOf(o.rotation.z)],
                  Math.abs(o.scale.x),
                ),
              ),
            } as Op);
          } else {
            ops.push({
              op: "update_graph_node",
              sceneId: scene.id,
              nodeId: id,
              patch: { transform: { position: [r4(local.x), r4(local.y), r4(local.z)] } },
            } as Op);
          }
          moved.push(id);
        }
      }
    }
    dragStartWorld.current = null;
    void apply(ops);

    if (useKeys) {
      notify(
        moved.length > 1
          ? `第 ${frame} 帧：${moved.length} 个节点已写关键帧（第 0 帧保持初始位置）`
          : `第 ${frame} 帧已写入关键帧（第 0 帧保持初始位置）`,
      );
    }
  };

  /**
   * 相机实体松手：把世界机位/朝向翻译回 graph.camera 的 position/target。
   *
   * - 平移：target 跟着同一个位移走（dolly/truck，构图朝向不变）；
   * - 旋转：target = 机位 + 朝前方向 × 原来的距离（摇/俯仰，距离不变）；
   * - 缩放对相机没意义（视口里根本不给挂手柄）。
   * 视口世界坐标 == 内容坐标，所以世界机位就是 graph.camera.position
   * （orbit 非零时是"当前帧机位"，回执里会说清楚）。
   */
  const commitCamera = () => {
    const o = objects.current.get(SHOT_CAM);
    const snap = camDragStart.current;
    camDragStart.current = null;
    if (!o || !snap || !graph) return;
    const pos = o.position.clone();
    let target: THREE.Vector3;
    if (mode === "rotate") {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(o.quaternion);
      target = pos.clone().add(fwd.multiplyScalar(snap.dist));
    } else {
      target = snap.target.clone().add(pos.clone().sub(snap.pos));
    }
    /**
     * 和节点同一套规则：**第 0 帧 = 起始机位**，非 0 帧的拖动只写运镜关键帧。
     *
     * 以前只有"落在运镜区间内"才写关键帧，区间外改基准机位——于是在第 60 帧拉一下镜头，
     * 0 帧也跟着变，两颗关键帧还会被改成同一个机位（轨迹退化成两个重叠的点）。
     * 关键帧不足两颗时先补一颗 0 帧锚点（起始机位），0 帧因此永远不动。
     */
    const cKeys = mode === "scale" ? [] : camKeysOf(graph, fps);
    const useKeys = cKeys.length > 0 || frame !== 0;
    if (useKeys) {
      const c0 = dslCamera(graph, 0, fps);
      const key = {
        frame,
        pos: [r4(pos.x), r4(pos.y), r4(pos.z)] as [number, number, number],
        target: [r4(target.x), r4(target.y), r4(target.z)] as [number, number, number],
        fov: shotPose.fov,
        ease: "easeInOut" as const,
      };
      const zero = {
        frame: 0,
        pos: c0.worldPos as [number, number, number],
        target: c0.worldTarget as [number, number, number],
        fov: c0.fov,
        ease: "easeInOut" as const,
      };
      const next = upsertKeyKeepingZero(cKeys, key, zero);
      void apply([
        {
          op: "set_graph_camera",
          sceneId: scene.id,
          camera: { anim: camAnimFromKeys(next) },
        } as Op,
      ]);
      notify(
        next.length === 2 && next[0].frame === 0
          ? `已在第 ${frame} 帧打运镜关键帧（第 0 帧保持起始机位）`
          : `第 ${frame} 帧的运镜关键帧已更新`,
      );
      return;
    }

    void apply([
      {
        op: "set_graph_camera",
        sceneId: scene.id,
        camera: {
          position: [r4(pos.x), r4(pos.y), r4(pos.z)],
          target: [r4(target.x), r4(target.y), r4(target.z)],
        },
      } as Op,
    ]);
    const warns: string[] = [];
    if ((graph.camera?.anim ?? []).length) warns.push("有运镜关键帧：区间内关键帧会覆盖这里改的机位");
    if ((graph.camera?.orbit?.degPerSec ?? 0) !== 0) warns.push("开了环绕：写入的是当前帧机位，环绕会从它继续转");
    if (warns.length) notify(`相机已更新（${warns.join("；")}）`);
  };

  return (
    <div className="vp3d">
      <Canvas
        dpr={[1, 1.5]}
        /**
         * 量布局尺寸而不是 getBoundingClientRect：舞台外壳带 scale(zoom) 时，
         * rect 量到的是缩放后的尺寸，且缩放变化不触发 ResizeObserver——
         * 画布会永远停在进 3D 模式那一刻的（缩过的）大小，铺不满外壳（实测踩过）。
         * offsetWidth 不受 transform 影响；舞台缩放交给 CSS 视觉缩放，和 Player 画面同款行为。
         */
        resize={{ offsetSize: true }}
        // 和成片一致：关掉 ACES，否则底色和 2D 场景对不上（原因见 Scene3D 里的长注释）
        gl={{ antialias: true, toneMapping: THREE.NoToneMapping }}
        camera={{ position: [0, 2.4, 9], fov: 45, near: 0.05, far: 400 }}
        onCreated={(state) => {
          setupEnvironment(state, graph.lights?.length ? resolved.spec.env * 0.25 : resolved.spec.env);
          /** e2e / 排查用：把 R3F 的根状态（scene、gl、材质）交出去，只在 dev 构建里挂 */
          if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__vpState = state;
        }}
        onPointerDownCapture={(e) => {
          downPos.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUpCapture={(e) => {
          /**
           * 画布点选自管：按下/松手位移 < 5px 才算点击（拖视角不算），
           * HUD 控件不参与拾取。不用 R3F onClick 的原因见 pickAt 里的注释。
           */
          const d = downPos.current;
          if (!d || e.button !== 0) return;
          if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
          if ((e.target as HTMLElement).closest("button, input, select, .vp3d-hud, .vp3d-tip")) return;
          const id = api.current?.pickAt(e.clientX, e.clientY) ?? null;
          if (id === SHOT_CAM) {
            setSelection(["cam"]);
            return;
          }
          // Ctrl/Cmd + 点击 = 加入/移出多选（和面板大纲同一套手势）
          if ((e.ctrlKey || e.metaKey) && id) {
            const set = new Set(gIds);
            if (set.has(id)) set.delete(id);
            else set.add(id);
            setSelection(graph.nodes.filter((n) => set.has(n.id)).map((n) => `g:${n.id}`));
          } else {
            setSelection(id ? [`g:${id}`] : []);
          }
        }}
      >
        <color attach="background" args={[theme.palette.background]} />
        {/* 和成片同一套灯；场景自带 lights 时 LookLights 会自动让位，DslScene 负责画那些灯 */}
        <LookLights
          spec={resolved.spec}
          core={theme.palette.primary}
          dot={theme.palette.accent}
          custom={Boolean(graph.lights?.length)}
        />
        <Bloom spec={null} theme={theme} graph={graph} look={resolved.name} />

        {/* 编辑辅助：网格与坐标轴只在视口里画，物理上不在成片合成里 */}
        {/*
          编辑辅助：网格与坐标轴只在视口里画，物理上不在成片合成里。
          透明度压到 0.22：满格实线（尤其浅色物体后面）会喧宾夺主，看久了眼晕。
        */}
        {showGrid ? (
          <>
            <gridHelper
              args={[40, 40, theme.palette.textMuted, theme.palette.textMuted]}
              position={[0, -0.002, 0]}
              material-transparent
              material-opacity={0.22}
            />
            <axesHelper args={[2.2]} />
          </>
        ) : null}

        <DslScene
          spec={graph}
          frame={frame}
          t={frame / fps}
          theme={theme}
          camera={IDENTITY_CAMERA}
          selectedId={selectedId}
          onNodeObject={onNodeObject}
        />

        {/* 成片相机实体：视锥 = 取景范围，看向线/朝向拖动中实时同步 */}
        <CameraEntity
          pos={shotPose.pos}
          quat={shotPose.quat}
          target={shotPose.target}
          fov={shotPose.fov}
          aspect={aspect}
          selected={camSelected}
          color={theme.palette.textMuted}
          onObject={onCameraObject}
          dragging={dragging}
          mode={mode}
          dragStart={camDragStart}
        />

        {/* 运镜轨迹：整条路径 + 每个关键帧一颗球（没有运镜关键帧时不画） */}
        {showTrack ? (
          <CameraTrack
            graph={graph}
            fps={fps}
            durationInFrames={scene.durationInFrames}
            color={theme.palette.accent}
            active={camSelected}
            frameRef={frameRef}
            objects={objects}
          />
        ) : null}

        <Gizmo
          targetId={
            camSelected
              ? mode === "scale"
                ? null // 相机没有缩放
                : SHOT_CAM
              : selectedId && !node?.locked
                ? selectedId
                : null
          }
          objects={objects}
          rev={objectsRev}
          mode={mode}
          onDragging={(d) => {
            setDragging(d);
            // 抓住手柄就自动暂停：拖动期间 frame 还在推进的话，DslScene 每帧重渲染
            // 会把 group 的变换重置回 DSL 值，松手写回的就是被冲掉的数（实测踩过：
            // 播放中拖 0.9 个单位，写回的 position 原封不动）。暂停后 frame 不再变化，
            // React 不重渲染，拖出的值才能活到 mouseUp。
            if (d) {
              setPlaying(false);
              // 相机：记下起点（平移要按位移同步 target，旋转要按原距离重算 target）
              if (camSelected) {
                const p = new THREE.Vector3(...shotPose.pos);
                const t = new THREE.Vector3(...shotPose.target);
                camDragStart.current = { pos: p, target: t, dist: p.distanceTo(t) };
              }
              // 抓手柄瞬间记下所有选中节点的世界坐标（播放已暂停，帧不再动）：
              // 松手时按主选的世界位移把其余选中节点一起搬走
              const p = selectedId ? objects.current.get(selectedId) : null;
              const others = new Map<string, THREE.Vector3>();
              const v = new THREE.Vector3();
              for (const id of gIds) {
                if (id === selectedId) continue;
                const o = objects.current.get(id);
                if (!o || !o.visible) continue;
                others.set(id, o.getWorldPosition(v).clone());
              }
              dragStartWorld.current = {
                primary: p ? p.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(),
                others,
              };
            }
          }}
          onCommit={() => {
            if (camSelected) commitCamera();
            else commitTransform();
          }}
          tcOut={gizmoRef}
        />
        <OrbitRig
          onApi={onApi}
          disabled={dragging}
          filmCamera={filmCamera}
          graphRef={graphRef}
          objects={objects}
          extent={extent}
          pivotOf={orbitPivot}
          gizmoBusy={gizmoBusy}
        />
      </Canvas>

      <div className="vp3d-hud">
        <button className="vp3d-btn" onClick={() => setPlaying((p) => !p)} title="播放/暂停（自己的播放头，不动成片时间轴）">
          {playing ? "暂停" : "播放"}
        </button>
        <input
          className="vp3d-range"
          type="range"
          min={0}
          max={Math.max(0, scene.durationInFrames - 1)}
          value={frame}
          onChange={(e) => {
            setPlaying(false);
            const v = Number(e.target.value);
            // 幕内拖动也要同步到全局播放头：时间轴的线跟着走
            drivingRef.current = true;
            frameBus.set(v + sceneStart);
            drivingRef.current = false;
            setFrame(v);
          }}
          title="拖动看动画"
        />
        <span className="vp3d-frame">
          {frame} / {scene.durationInFrames}
        </span>

        <span className="vp3d-sep" />

        <div className="seg">
          {(
            [
              ["translate", "移动"],
              ["rotate", "旋转"],
              ["scale", "缩放"],
            ] as const
          ).map(([m, label]) => (
            <button key={m} className={`seg-item ${mode === m ? "is-on" : ""}`} onClick={() => setMode(m)}>
              {label}
            </button>
          ))}
        </div>

        <span className="vp3d-sep" />
        <button
          className="vp3d-btn"
          onClick={() => {
            api.current?.focusShotCamera();
            setSelection(["cam"]);
          }}
          title="把视角摆到成片相机斜后方并选中它——直接在画面里拖着运镜"
        >
          看相机
        </button>
        <button className="vp3d-btn" onClick={() => api.current?.alignToFilm()} title="把视角摆到成片机位，核对构图">
          对齐成片相机
        </button>
        <button
          className={`vp3d-btn ${showGrid ? "" : "is-dim"}`}
          onClick={() => setShowGrid((v) => !v)}
          title="显示/隐藏网格与坐标轴（只在编辑视口里，不会进成片）"
        >
          {showGrid ? "隐藏网格" : "显示网格"}
        </button>
        {hasTrack ? (
          <button
            className={`vp3d-btn ${showTrack ? "" : "is-dim"}`}
            onClick={() => setShowTrack((v) => !v)}
            title="显示/隐藏相机运镜轨迹（有运镜关键帧时才有）"
          >
            {showTrack ? "隐藏轨迹" : "显示轨迹"}
          </button>
        ) : null}
        <button
          className="vp3d-btn"
          onClick={() => setSelection([])}
          disabled={!gIds.length && !camSelected}
        >
          取消选中
        </button>
        {onExit ? (
          <button className="vp3d-btn" onClick={onExit}>
            回到预览
          </button>
        ) : null}
      </div>

      <div className="vp3d-tip">
        {camSelected ? (
          <>
            已选 <b>成片相机</b> · 拖手柄平移/旋转运镜
            {mode === "scale" ? "（缩放对相机无意义，先切回移动或旋转）" : ""}
            {" · 线框锥 = 成片取景范围，线段端点 = 看向点 · FOV 在右栏「相机」页"}
          </>
        ) : selectedId ? (
          <>
            已选{" "}
            <b>{node?.label ?? selectedId}</b>
            {gIds.length > 1 ? ` 等 ${gIds.length} 个（拖手柄整体平移）` : ""}
            {node?.hidden ? "（已隐藏）" : ""}
            {node?.locked ? "（已锁定，解锁后才能拖）" : ""}
            {!node?.locked && !dragging ? " · 拖三轴手柄，或切到旋转/缩放" : ""}
            {dragging ? " · 拖动中" : ""}
          </>
        ) : (
          <>点画面上的物体选中它（灰色相机框 = 成片相机，点它运镜）；Ctrl+点选加选；左键转视角（绕着选中的物体转，没选中就绕世界原点）、右键平移、滚轮缩放</>
        )}
      </div>
    </div>
  );
};
