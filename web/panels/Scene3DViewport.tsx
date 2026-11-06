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
import { installBloom, postExtrasOf } from "../../src/scenes/scene3d/bloom";
import { evalNode, nodeBaseScale } from "@shared/scene3dAnim";
import {
  NODE_KEY_MAX,
  camAnimFromKeys,
  camKeyFrames,
  nodeAnimFromKeys,
  nodeKeyAt,
  nodeKeyFrames,
  nodeKeysOf,
  upsertKey,
  upsertKeyKeepingZero,
} from "@shared/scene3dKeys";
import { indexNodes, worldPointOf } from "@shared/scene3dTransform";
import { hasCurve, mateHandle, pathControls, pathTangents, type Vec3 } from "@shared/scene3dPath";
import { camKeyWithPose, camKeysOf, camZeroKeyOf } from "./scene3dCamKeys";
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
  /**
   * 双击聚焦：把观察镜头推到指定节点/相机跟前，视线方向保持不变。
   * 大场景里"先找到它再放大"要滚好几下滚轮，双击一次到位。
   */
  focusOn: (id: string) => void;
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
  /**
   * 贝塞尔手柄正在被拖。
   *
   * pointerdown 是在 host 的 capture 阶段处理的，比手柄自己的 onPointerDown 更早，
   * 所以按下那一刻还不知道"这一拖是手柄"——只能等第一次 pointermove 时问一次，
   * 是手柄就把这一轮的转视角作废（此时相机还没动，清掉 drag 就什么都不发生）。
   */
  handBusy: () => boolean;
}> = ({ onApi, disabled, filmCamera, graphRef, objects, extent, pivotOf, gizmoBusy, handBusy }) => {
  const { camera, gl } = useThree();
  const controls = useMemo(() => new OrbitControls(camera, gl.domElement), [camera, gl]);
  /** 每次渲染刷新：effect 依赖里不放它们，免得选中变化就重装监听 */
  const live = useRef({ pivotOf, gizmoBusy, handBusy });
  live.current = { pivotOf, gizmoBusy, handBusy };

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
      // 贝塞尔手柄上一轮还没收尾（极少见）：别把这次当成转视角
      if (live.current.handBusy()) return;
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
      /**
       * 这一拖其实是贝塞尔手柄：第一次 move 时才看得出来（按下时手柄的 onPointerDown
       * 还没轮到执行）。此时相机一动没动，直接作废这次转视角即可。
       */
      if (live.current.handBusy()) {
        drag = null;
        return;
      }
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
            const t = node.geometry?.type ?? "group";
            if (t === "ring" || t === "dashRing") continue; // 环：丢弃，不向上冒认
            // 纯枢轴没有表面：只有它是"包围盒代理"时才命中不了，这里同样不当拾取结果
            if (t === "group") continue;
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
          const t = n.geometry?.type ?? "group";
          if (t === "ring" || t === "dashRing" || t === "group") continue; // 轨道线/纯枢轴不参与拾取：与 DslScene 的 pickable 口径一致，只从树里选
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
      focusOn: (id) => {
        /** 相机实体单独处理：它的 Box3 会把视锥线一起框进去，算出来的距离大得离谱 */
        if (id === SHOT_CAM) {
          const cam = filmCamera.current();
          const g = new THREE.Object3D();
          g.quaternion.fromArray(cam.quat);
          g.position.fromArray(cam.groupPos);
          g.updateMatrixWorld(true);
          const inv = new THREE.Matrix4().copy(g.matrixWorld).invert();
          const p = new THREE.Vector3(0, 0, cam.camPos[2]).applyMatrix4(inv);
          camera.position.copy(p.clone().add(new THREE.Vector3(1.6, 1.1, 1.6)));
          controls.target.copy(p);
          controls.update();
          return;
        }
        const obj = objects.current.get(id);
        if (!obj) return;
        /**
         * 半径按**几何体自身**算，不用 Box3.setFromObject：
         * 那个会把子节点（卫星、光晕）一起框进来，双击一颗行星会被拉到很远的地方。
         */
        const node = graphRef.current?.nodes.find((n) => n.id === id);
        const geo = node?.geometry as
          | { radius?: number; outerRadius?: number; width?: number; height?: number; depth?: number }
          | undefined;
        const half = geo
          ? (geo.radius ??
            geo.outerRadius ??
            Math.max(geo.width ?? 0, geo.height ?? 0, geo.depth ?? 0) / 2)
          : 0.5;
        obj.updateWorldMatrix(true, false);
        const ws = obj.getWorldScale(new THREE.Vector3());
        const r = Math.max(0.02, half * Math.max(Math.abs(ws.x), Math.abs(ws.y), Math.abs(ws.z)));
        const center = obj.getWorldPosition(new THREE.Vector3());
        const persp = camera as THREE.PerspectiveCamera;
        const fov = ((persp.fov || 45) * Math.PI) / 180;
        /** 留 1.4 倍余量：物体贴边时看不出"自己双击了哪个" */
        const dist = (r / Math.sin(Math.max(0.05, fov / 2))) * 1.4;
        const dir = camera.position.clone().sub(controls.target);
        if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
        dir.normalize();
        controls.target.copy(center);
        camera.position.copy(center).add(dir.multiplyScalar(Math.max(0.15, dist)));
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
 * 贝塞尔手柄的颜色。
 *
 * **不用主题色**：accent 是轨迹色、primary 是锁定环色、选中框是 #C6F24E（黄绿），
 * 语义色总共就这几个，手柄夹在中间必然撞色——实测 primary 和相机选中框几乎同色，
 * 深色背景上根本找不到手柄在哪。品红还能躲开 Gizmo 的红绿蓝三轴——青色会和蓝轴混成一根。
 */
const HANDLE_COLOR = "#FF4FA3";

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
  /** 当前帧锁定看向某个节点：看向线改虚线 + 目标处画靶环 */
  lock: boolean;
  /** 锁定提示色（主题 primary），和选中色分开 */
  lockColor: string;
  onObject: (o: THREE.Object3D | null) => void;
  /** 双击相机实体：把观察镜头推到它跟前 */
  onFocus?: () => void;
  /** 拖动中：看向点按手势语义实时推导（平移/旋转） */
  dragging: boolean;
  mode: "translate" | "rotate" | "scale";
  dragStart: React.RefObject<{ pos: THREE.Vector3; target: THREE.Vector3; dist: number } | null>;
}> = ({
  pos,
  quat,
  target,
  aspect,
  fov,
  selected,
  color,
  lock,
  lockColor,
  onObject,
  onFocus,
  dragging,
  mode,
  dragStart,
}) => {
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
  /**
   * 锁定中的看向线：**虚线**。
   * 用独立对象而不是换材质——换材质要在 effect 里 dispose/重建，还会和 useFrame 抢同一个
   * Line 的 geometry；两条线各画各的，成本是每帧两次 setFromPoints（两个点），可以忽略。
   */
  const aimLock = useMemo(
    () =>
      new THREE.Line(
        new THREE.BufferGeometry(),
        /**
         * 虚线参数：dash 0.3 / gap 0.18 是**世界单位**。
         * 太细密（0.1/0.05）在 4K 屏上会糊成一条实线，看不出"这是约束、不是自由看向"。
         */
        new THREE.LineDashedMaterial({ transparent: true, opacity: 1, dashSize: 0.3, gapSize: 0.18 }),
      ),
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
  /**
   * 锁定靶环：两个同心环，billboard 朝向观察相机、屏幕恒定大小。
   * 为什么不用"更大的球"：球会把被锁的物体糊住（历史上轨迹球就干过这事，被报过），
   * 环是空心的，正好框住目标又不遮它。
   */
  const lockRing = useMemo(() => {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const outer = new THREE.Mesh(new THREE.RingGeometry(0.66, 1, 44), mat);
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.16, 14), mat);
    g.add(outer, dot);
    g.renderOrder = 999;
    outer.raycast = () => {};
    dot.raycast = () => {};
    return g;
  }, []);

  useEffect(() => {
    // setColors 收的是 Color 对象（内部直接读 .r/.g/.b），传字符串会得到黑色
    const c = new THREE.Color(tint);
    helper.setColors(c, c, c, c, c);
    (aimObj.material as THREE.LineBasicMaterial).color.set(tint);
    (marker.material as THREE.MeshBasicMaterial).color.set(tint);
    (aimLock.material as THREE.LineDashedMaterial).color.set(lockColor);
    /** 靶环两个 mesh 共用同一个材质实例，设一次就够 */
    ((lockRing.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial).color.set(lockColor);
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
    aimLock.renderOrder = 997;
    helper.renderOrder = 996;
    // 视锥/线/小球都不能参与拾取，否则点空白会选中相机（尤其视锥线很长）
    helper.traverse((o) => {
      o.raycast = () => {};
    });
    aimObj.raycast = () => {};
    aimLock.raycast = () => {};
    marker.raycast = () => {};
  }, [helper, aimObj, aimLock, marker, lockRing, tint, lockColor, selected]);

  useEffect(
    () => () => {
      aimObj.geometry.dispose();
      (aimObj.material as THREE.Material).dispose();
      aimLock.geometry.dispose();
      (aimLock.material as THREE.Material).dispose();
      marker.geometry.dispose();
      (marker.material as THREE.Material).dispose();
      helper.geometry.dispose();
      (helper.material as THREE.Material).dispose();
      lockRing.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
      });
      ((lockRing.children[0] as THREE.Mesh).material as THREE.Material).dispose();
    },
    [aimObj, aimLock, marker, helper, lockRing],
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
     *
     * **锁定段例外**：target 由节点位置决定，拖动时也钉在它上面。
     * 否则拖动中看向点跟着手走、松手又弹回目标，画面会跳一下（而且拖的时候看不到真实构图）。
     */
    const snap = dragStart.current;
    if (dragging && snap && !lock) {
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

    /**
     * 看向线：锁定时走虚线 + 靶环，自由时走实线 + 小球。
     * 两条线各自持有 geometry，只更新当前生效的那条（另一条 visible=false，不参与绘制）。
     */
    const aim = lock ? aimLock : aimObj;
    aim.geometry.setFromPoints([p, t]);
    if (lock) (aim as THREE.Line).computeLineDistances();
    marker.position.copy(t);
    /**
     * 看向点小球：**屏幕恒定 3.5px**。
     * 原来按世界尺寸算（机位到目标的 1.2%），贴到目标跟前时它会胀成一颗大球把目标糊住
     * ——"点太大挡住元素"的另一个来源。目标点只是个标记，屏幕上几像素够了。
     */
    const camDist = orbitCam.position.distanceTo(t);
    const tanHalf = Math.tan((((orbitCam as THREE.PerspectiveCamera).fov || 45) * Math.PI) / 360);
    const worldPerPx = (2 * tanHalf * camDist) / Math.max(1, state.size.height);
    marker.scale.setScalar(Math.max(1e-5, 3.5 * worldPerPx));
    /**
     * 靶环：billboard 朝向观察相机 + 屏幕恒定 13px 半径。
     * 空心环正好框住目标而不遮它——球版标记在近景会把被锁物体整个糊掉（被报过）。
     */
    lockRing.position.copy(t);
    lockRing.quaternion.copy(orbitCam.quaternion);
    lockRing.scale.setScalar(Math.max(1e-5, 13 * worldPerPx));

    // 站进相机里时整体隐藏（否则拾取球会吃掉全屏点击）
    const hidden = orbitCam.position.distanceTo(p) < 1.0;
    o.visible = !hidden;
    helper.visible = !hidden;
    aimObj.visible = !hidden && !lock;
    aimLock.visible = !hidden && lock;
    marker.visible = !hidden && !lock;
    lockRing.visible = !hidden && lock;
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
        <mesh onDoubleClick={(e) => { e.stopPropagation(); onFocus?.(); }}>
          <sphereGeometry args={[0.4, 12, 10]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      </group>
      <primitive object={helper} />
      <primitive object={aimObj} />
      <primitive object={aimLock} />
      <primitive object={marker} />
      <primitive object={lockRing} />
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
   * 每个点对应的帧号（只有关键帧球传）。给了之后，**当前帧那一颗**改用实体的
   * 实时世界位置：拖动时物体跟手，球要是留在旧位上，看起来就是"球和物体分了家"。
   */
  frames?: number[];
  frameRef?: React.RefObject<number>;
  objects?: React.RefObject<Map<string, THREE.Object3D>>;
  /** 读实时位置用的注册表键（相机是 SHOT_CAM，节点是 node id） */
  objectId?: string;
  /** 点一颗球：给节点轨迹用（跳到该帧 + 选中物体），相机轨迹不传 */
  onPick?: (index: number) => void;
  /** 关掉深度测试：点被物体挡住时要还能点到（可编辑的点被遮住 = 用户以为不能点） */
  depthTest?: boolean;
}> = ({
  points,
  color,
  opacity,
  radiusPx,
  renderOrder,
  segments = 8,
  frames,
  frameRef,
  objects,
  objectId = SHOT_CAM,
  onPick,
  depthTest = true,
}) => {
  const grp = useRef<THREE.Group | null>(null);
  const geo = useMemo(
    () => new THREE.SphereGeometry(1, segments, Math.max(4, segments - 2)),
    [segments],
  );
  useEffect(() => () => geo.dispose(), [geo]);

  const livePos = useMemo(() => new THREE.Vector3(), []);
  /**
   * 让轨迹球的拾取**永远优先**。
   *
   * 起点那颗关键帧球的位置就是物体的位置（常常落在球体/方块内部），按 3D 距离排序时
   * 射线先命中物体表面，球永远点不到——实测点下去选中的是物体，看起来像"球不能点"。
   * 把命中距离压到百万分之一：球之间仍按真实远近排，但整体排在物体前面。
   */
  const forcePick = useCallback(
    (m: THREE.Mesh | null) => {
      if (!m || !onPick) return;
      m.raycast = function (this: THREE.Mesh, rc: THREE.Raycaster, out: THREE.Intersection[]) {
        const hits: THREE.Intersection[] = [];
        THREE.Mesh.prototype.raycast.call(this, rc, hits);
        for (const h of hits) {
          h.distance *= 1e-6;
          out.push(h);
        }
      };
    },
    [onPick],
  );  useFrame((state) => {
    const g = grp.current;
    if (!g) return;
    if (frames && frameRef && objects) {
      const obj = objects.current.get(objectId);
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
        <mesh
          key={i}
          ref={onPick ? forcePick : undefined}
          position={p}
          geometry={geo}
          renderOrder={renderOrder}
          onClick={
            onPick
              ? (e) => {
                  // 不冒泡：否则会同时选中它后面的物体，相机/浏览器还会再处理一次点击
                  e.stopPropagation();
                  onPick(i);
                }
              : undefined
          }
          onPointerOver={onPick ? () => (document.body.style.cursor = "pointer") : undefined}
          onPointerOut={onPick ? () => (document.body.style.cursor = "") : undefined}
        >
          <meshBasicMaterial
            color={color}
            transparent
            opacity={opacity}
            depthWrite={false}
            depthTest={depthTest}
          />
        </mesh>
      ))}
    </group>
  );
};

/**
 * 把"当前帧那一点"接到轨迹上（拖动中轨迹必须跟手）。
 *
 * 起因：用户调完机位截图报"轨迹线没连上"——轨迹是按时序采样的，实体在拖动中每帧都在动，
 * 采样点却没跟着，于是线和实体之间裂开一截。实体才是唯一真值（拖动中也是它最准，
 * 因为拖动不写库），所以直接读它：当前帧若已在采样集里就替换那一点，否则插进去。
 * 静止时结果和原来完全一致（同一份采样），不产生任何视觉漂移。
 *
 * 相机和物体共用：两者只差注册表里的键（SHOT_CAM / node id）。
 */
const useLiveTrackPoint = (
  line: THREE.Line,
  sampleFrames: number[],
  basePos: Float32Array,
  last: number,
  objectId: string,
  objects: React.RefObject<Map<string, THREE.Object3D>>,
  frameRef: React.RefObject<number>,
) => {
  const live = useMemo(() => new THREE.Vector3(), []);
  /**
   * 缓存键里**必须带 geometry**：图一变（改机位、打关键帧）memo 会新建几何体，
   * 新几何体里是一整片 0；只按"帧 + 位置"判断会命中缓存直接 return，那条线就永远停在原点
   * 附近（表现为"轨迹线没连上/不在原地"，实测踩过）。
   */
  const memoState = useRef({ geo: null as THREE.BufferGeometry | null, f: -1, x: NaN, y: NaN, z: NaN });
  useFrame(() => {
    const obj = objects.current.get(objectId);
    const geoNow = line.geometry as THREE.BufferGeometry;
    const f = Math.min(last, Math.max(0, Math.round(frameRef.current)));
    const st = memoState.current;
    /** 实体还没注册（首帧）时退回基础采样，别把一数组 0 画上去 */
    if (!obj) {
      if (st.geo === geoNow) return;
      memoState.current = { geo: geoNow, f: -2, x: NaN, y: NaN, z: NaN };
      const a0 = geoNow.getAttribute("position") as THREE.BufferAttribute;
      (a0.array as Float32Array).set(basePos);
      a0.needsUpdate = true;
      geoNow.setDrawRange(0, sampleFrames.length);
      return;
    }
    obj.getWorldPosition(live);
    if (st.geo === geoNow && st.f === f && st.x === live.x && st.y === live.y && st.z === live.z) {
      return;
    }
    memoState.current = { geo: geoNow, f, x: live.x, y: live.y, z: live.z };

    const attr = geoNow.getAttribute("position") as THREE.BufferAttribute;
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
    geoNow.setDrawRange(0, n / 3);
  });
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
  /** 点关键帧球：跳到该帧并选中相机（之后能拖贝塞尔手柄） */
  onPickKey?: (frame: number) => void;
}> = ({ graph, fps, durationInFrames, color, active, frameRef, objects, onPickKey }) => {
  const { line, frames: sampleFrames, basePos, last, keyPoints, keyFrames, pathDots } = useMemo(() => {
    const frames = camKeyFrames(graph.camera);
    const last = Math.max(1, durationInFrames - 1);
    /**
     * 采样密度：全片约 480 个点（≈4 帧一个）。
     *
     * 原来是 last/200（≈11 帧一个）—— 在整条轨迹缩到屏幕里看时，弧线被折线"抄近路"，
     * 再加上关键帧小球也是等距的，整条线看起来就是一串直线段（用户截图报过）。
     * 加密到 4 帧，肉眼就是连续曲线；计算量是 480 次采样 × 段数，仍是每帧几毫秒级。
     */
    const step = Math.max(1, Math.round(last / 480));
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
      keyFrames: frames,
      pathDots,
    };
  }, [graph, fps, durationInFrames]);

  /**
   * 每帧把"相机现在在哪"接到折线上（并把那个点画出来）。
   * 逻辑见 useLiveTrackPoint 的长注释：唯一真值是视口里那台相机实体。
   */
  useLiveTrackPoint(line, sampleFrames, basePos, last, SHOT_CAM, objects, frameRef);

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
        frames={keyFrames}
        frameRef={frameRef}
        objects={objects}
        color={color}
        opacity={active ? 0.95 : 0.62}
        /**
         * 逐帧烘焙的运镜有 200+ 个关键帧：4.5px 的球会把轨迹糊成一条"毛毛虫"，
         * 反而看不出曲线本身。点多了就自动收小，线才是主角。
         */
        radiusPx={keyPoints.length > 120 ? 1.8 : 4.5}
        renderOrder={991}
        segments={10}
        depthTest={false}
        onPick={onPickKey ? (i) => onPickKey(keyFrames[i]) : undefined}
      />
    </>
  );
};

/**
 * 物体运动辅助线。
 *
 * 和相机轨迹同一套画法（线 + 路径点 + 关键帧点 + 当前帧跟手），差别有两点：
 *
 * 1. **采样按段来**：节点动画是段式插值（段内直线 + 缓动），每段 8 个点就够看出走向。
 *    相机那套 200 点等距采样对物体是浪费，还会让"线穿过不穿过关键帧球"变成运气。
 * 2. **关键帧点就是可拖的点**（P1）：它对应段端点，拖它等于改那一帧的位置。
 *    路径采样点只做视觉引导，不参与拾取——否则满屏都是能拖的小球，点中什么都靠猜。
 */
const NodeTrack: React.FC<{
  nodes: DslNode[];
  nodeId: string;
  durationInFrames: number;
  color: string;
  active: boolean;
  frameRef: React.RefObject<number>;
  objects: React.RefObject<Map<string, THREE.Object3D>>;
  /** 点关键帧点：跳到该帧并选中物体（之后拖三轴手柄就是改这一帧的位置） */
  onPickKey?: (frame: number) => void;
}> = ({ nodes, nodeId, durationInFrames, color, active, frameRef, objects, onPickKey }) => {
  const { line, sampleFrames, basePos, last, keyPoints, keyFrames, pathDots } = useMemo(() => {
    const node = nodes.find((n) => n.id === nodeId);
    const last = Math.max(1, durationInFrames - 1);
    const set = new Set<number>([0, last]);
    const kfs = nodeKeyFrames(node ?? ({ id: nodeId } as DslNode));
    for (const f of kfs) set.add(Math.min(last, Math.max(0, Math.round(f))));
    for (const a of node?.anim ?? []) {
      const [s, e] = a.at;
      /** 曲线段要多撒点：8 个点画一条贝塞尔会把弧顶削成折角 */
      const n = hasCurve(a.curve) ? 24 : 8;
      for (let i = 1; i < n; i++) set.add(Math.round(s + ((e - s) * i) / n));
    }
    const sampleFrames = [...set].filter((f) => f >= 0 && f <= last).sort((a, b) => a - b);
    const index = indexNodes(nodes);
    const at = (f: number) => worldPointOf(index, nodeId, f) ?? [0, 0, 0];

    const basePos = new Float32Array(sampleFrames.length * 3);
    const pts: THREE.Vector3[] = sampleFrames.map((f, i) => {
      const w = at(f);
      basePos[i * 3] = w[0];
      basePos[i * 3 + 1] = w[1];
      basePos[i * 3 + 2] = w[2];
      return new THREE.Vector3(w[0], w[1], w[2]);
    });

    /** 预留一个位置给"当前帧的实时位置"（同相机轨迹） */
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array((sampleFrames.length + 1) * 3), 3));
    geo.setDrawRange(0, sampleFrames.length);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ transparent: true, opacity: 0.55 }));
    line.raycast = () => {};
    line.renderOrder = 990;

    const every = Math.max(1, Math.round(pts.length / 36));
    const pathDots = pts.filter((_, i) => i > 0 && i < pts.length - 1 && i % every === 0);
    return {
      line,
      sampleFrames,
      basePos,
      last,
      keyPoints: kfs.map((f) => new THREE.Vector3(...at(Math.min(last, Math.max(0, Math.round(f)))))),
      keyFrames: kfs,
      pathDots,
    };
  }, [nodes, nodeId, durationInFrames]);

  useLiveTrackPoint(line, sampleFrames, basePos, last, nodeId, objects, frameRef);

  useEffect(() => {
    const m = line.material as THREE.LineBasicMaterial;
    m.color.set(color);
    m.opacity = active ? 0.9 : 0.5;
  }, [line, color, active]);

  useEffect(
    () => () => {
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    },
    [line],
  );

  // 没有关键帧 = 物体不动，画一个点没有意义，直接不画（也避免"每个物体都挂一根线"）
  if (!keyPoints.length) return null;
  return (
    <>
      <primitive object={line} />
      <TrackDots
        points={pathDots}
        color={color}
        opacity={active ? 0.6 : 0.3}
        radiusPx={1.8}
        renderOrder={990}
        segments={6}
      />
      <TrackDots
        points={keyPoints}
        frames={keyFrames}
        frameRef={frameRef}
        objects={objects}
        objectId={nodeId}
        color={color}
        opacity={active ? 0.95 : 0.55}
        radiusPx={4}
        renderOrder={991}
        segments={10}
        depthTest={false}
        onPick={active && onPickKey ? (i) => onPickKey(keyFrames[i]) : undefined}
      />
    </>
  );
};

/**
 * 贝塞尔手柄：点中轨迹上的关键帧球后，显示该帧前后两段的控制点。
 *
 * 为什么不用 TransformControls 拖手柄：TC 会在手柄位置长出一套三轴箭头，
 * 而手柄本来就贴在轨迹上——三根箭头直接把整条曲线盖住，而且小球的命中区被箭头抢走。
 * 这里自己做"过手柄点、正对相机的平面"拖拽：屏幕上指哪拖哪，合乎直觉，
 * 也不会和 Gizmo 抢 targetId（拖物体的状态机保持原样）。
 *
 * 数据源无关：段列表、端点世界坐标、提交回调都由调用方给——节点轨迹读 `evalNode` 链，
 * 相机轨迹读 `dslCamera`，两边数学不同但手柄的交互方式必须一样（否则用户要学两套）。
 */
/**
 * 一个可拖的贝塞尔控制点。
 *
 * `side` 是它**属于段的哪一端**（out = 起点侧 c1，in = 终点侧 c2），不是"往哪个方向"。
 * `a` 是它挂着的那个端点（世界坐标），连线就从这里画出去。
 */
type BezierHandle = {
  side: "out" | "in";
  seg: number;
  c: Vec3;
  a: Vec3;
};

/** 松手写库时的改动项：一次手势可能同时动两段（相切联动的对侧属于相邻段） */
type BezierChange = { seg: number; side: "out" | "in"; world: Vec3 };

const BezierHandles: React.FC<{
  /** 段列表（节点的 anim 或相机的 anim） */
  segs: Array<{ at: [number, number]; curve?: { out?: number[]; in?: number[] } }>;
  /** 某一帧端点的**世界坐标** */
  endpointAt: (frame: number) => Vec3;
  frame: number;
  color: string;
  /** 拖动中：暂停播放、别让重渲染把位置打回去 */
  onBusy: (busy: boolean) => void;
  onCommitWorld: (changes: BezierChange[]) => void;
  onReset: (segIndex: number, side: "out" | "in") => void;
  /** 该段是否允许拖（相机的 follow 段是相对偏移，拖世界坐标会打架） */
  editable?: (seg: { at: [number, number]; curve?: { out?: number[]; in?: number[] } }) => boolean;
}> = ({ segs, endpointAt, frame, color, onBusy, onCommitWorld, onReset, editable }) => {
  const { camera, gl, raycaster } = useThree();

  /**
   * 当前帧要显示哪些手柄。
   *
   * - **中间关键帧**：入侧取前段的 c2、出侧取后段的 c1 —— 一颗顶点、两条切线，
   *   几何上它们必须共线（相切），所以默认联动（见 beginDrag）。
   * - **首 / 末帧**：只有一侧相邻段，就补上**同一段的另一个控制点**。
   *   不补的话用户只看到一个球，会以为"平滑没生效/手柄丢了"（实际反馈）。
   *   补位手柄的锚点是段的另一端，和主手柄不共顶点，所以不参与联动。
   */
  const handles = useMemo<BezierHandle[]>(() => {
    if (!segs.length) return [];
    const ctrlOf = (a: { at: [number, number]; curve?: { out?: number[]; in?: number[] } }) => {
      const A = endpointAt(Math.round(a.at[0]));
      const B = endpointAt(Math.round(a.at[1]));
      const { c1, c2 } = pathControls(
        A,
        B,
        (a.curve?.out ?? [0, 0, 0]) as Vec3,
        (a.curve?.in ?? [0, 0, 0]) as Vec3,
      );
      return { A, B, c1, c2 };
    };
    /** 同一帧既可能是某段的 end、也可能是下一段的 start；分别取最后一个/第一个 */
    let inc = -1;
    let out = -1;
    segs.forEach((a, i) => {
      if (editable && !editable(a)) return;
      if (Math.round(a.at[1]) === frame) inc = i;
      if (Math.round(a.at[0]) === frame) out = i;
    });
    if (inc < 0 && out < 0) return [];
    if (inc >= 0 && out >= 0) {
      const ci = ctrlOf(segs[inc]);
      const co = ctrlOf(segs[out]);
      return [
        { side: "in", seg: inc, c: ci.c2, a: ci.B },
        { side: "out", seg: out, c: co.c1, a: co.A },
      ];
    }
    const only = out >= 0 ? out : inc;
    const c = ctrlOf(segs[only]);
    return [
      { side: "out", seg: only, c: c.c1, a: c.A },
      { side: "in", seg: only, c: c.c2, a: c.B },
    ];
  }, [segs, endpointAt, frame, editable]);

  const outGrp = useRef<THREE.Group | null>(null);
  const inGrp = useRef<THREE.Group | null>(null);
  const outMesh = useRef<THREE.Mesh | null>(null);
  const inMesh = useRef<THREE.Mesh | null>(null);
  /**
   * 连线单独建（不放进 handle 的 group）：group 会跟着拖动移动，
   * 线顶点用世界坐标就会以两倍速度跟着跑（坐标被叠加了两次）。
   */
  const lines = useMemo(
    () => ({
      out: new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ transparent: true, opacity: 0.55, depthTest: false, depthWrite: false })),
      in: new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ transparent: true, opacity: 0.55, depthTest: false, depthWrite: false })),
    }),
    [],
  );
  useEffect(() => {
    lines.out.raycast = () => {};
    lines.in.raycast = () => {};
    lines.out.renderOrder = 992;
    lines.in.renderOrder = 992;
    /**
     * 顶点每帧改写，但包围球只在第一次渲染时算一次——不关剔除的话，
     * 手柄拖远之后整条连线会被判定在视野外直接不画（实测：只看到两个球，没有线）。
     */
    lines.out.frustumCulled = false;
    lines.in.frustumCulled = false;
    (lines.out.material as THREE.LineBasicMaterial).color.set(color);
    (lines.in.material as THREE.LineBasicMaterial).color.set(color);
  }, [lines, color]);
  useEffect(
    () => () => {
      for (const l of [lines.out, lines.in]) {
        l.geometry.dispose();
        (l.material as THREE.Material).dispose();
      }
    },
    [lines],
  );
  /** 拖动状态：平面法线取按下瞬间的视线方向，拖动中相机不动，所以平面稳定 */
  const drag = useRef<{ side: "out" | "in"; plane: THREE.Plane } | null>(null);
  const tmp = useMemo(() => new THREE.Vector3(), []);
  const hit = useMemo(() => new THREE.Vector3(), []);
  const ndc = useMemo(() => new THREE.Vector2(), []);

  /** 拖动结束时摘掉监听（卸载时也摘，避免泄漏） */
  const stopListen = useRef<(() => void) | null>(null);
  useEffect(() => () => stopListen.current?.(), []);

  /**
   * 相切联动用的对侧信息。
   *
   * `moved` 必须记：用户按住 Shift 全程单独调时对侧没动过，松手就不能把它写进库里
   * （否则会把另一条本来完好的曲线"固化"成当前显示位置）。
   */
  const mateRef = useRef<{
    grp: React.RefObject<THREE.Group | null>;
    seg: number;
    side: "out" | "in";
    anchor: THREE.Vector3;
    len: number;
    moved: boolean;
  } | null>(null);

  /**
   * 按下手柄。
   *
   * 监听必须在**这里同步注册**，不能放 useEffect：一次 pointerdown 之后如果立即
   * 连续触发 pointermove/up（真实鼠标很快、自动化测试更是同一 tick 全部派发），
   * effect 还没来得及跑，事件就全丢了。同步 addEventListener 才收得到。
   */
  const beginDrag = (side: "out" | "in", segIndex: number, e: { pointerId: number; stopPropagation: () => void; shiftKey?: boolean }) => {
    const mesh = side === "out" ? outMesh.current : inMesh.current;
    if (!mesh) return;
    e.stopPropagation();
    mesh.getWorldPosition(tmp);
    const n = new THREE.Vector3();
    camera.getWorldDirection(n);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, tmp.clone());
    drag.current = { side, plane };
    /** 本侧锚点 / 原长：联动时用它们把对侧摆到"共线反向、等比例"的位置 */
    const self = handles.find((h) => h.side === side);
    const anchorV = new THREE.Vector3(...(self?.a ?? [tmp.x, tmp.y, tmp.z]));
    const origLen = self ? new THREE.Vector3(...self.c).distanceTo(anchorV) : 0;
    const other = handles.find((h) => h.side !== side);
    if (other) {
      const oa = new THREE.Vector3(...other.a);
      const oc = new THREE.Vector3(...other.c);
      /**
       * 只有"同一个顶点两侧"才联动（锚点重合）。首/末帧补位的那个手柄锚在段的另一端，
       * 属于另一段的两端，联动它等于强行把两个端点连成一条直线，没有意义。
       */
      mateRef.current =
        oa.distanceTo(anchorV) < 1e-4
          ? {
              grp: other.side === "out" ? outGrp : inGrp,
              seg: other.seg,
              side: other.side,
              anchor: oa,
              len: oc.distanceTo(oa),
              moved: false,
            }
          : null;
    } else {
      mateRef.current = null;
    }
    onBusy(true);
    try {
      gl.domElement.setPointerCapture(e.pointerId);
    } catch {
      /* 合成事件没有真实 pointer 时会抛，window 监听已经在兜底 */
    }

    const move = (ev: PointerEvent) => {
      const rect = gl.domElement.getBoundingClientRect();
      ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      if (!raycaster.ray.intersectPlane(plane, hit)) return;
      const m = side === "out" ? outMesh.current : inMesh.current;
      // 拖动中只动可视对象，不写库：写库会重建整条轨迹，手柄会跟着几何体一起重置
      m?.parent?.position.copy(hit);
      m?.parent?.updateMatrixWorld(true);

      /**
       * 相切联动：默认让对侧沿反方向跟着走（C1 连续，曲线过这个关键帧不打折）。
       * 按住 Shift = 只动这一侧，用来做"故意拐个角"的造型。
       */
      const mt = mateRef.current;
      if (mt && !ev.shiftKey) {
        const p = mateHandle(
          [anchorV.x, anchorV.y, anchorV.z],
          [hit.x, hit.y, hit.z],
          origLen,
          mt.len,
        );
        const g = mt.grp.current;
        if (g) {
          g.position.set(p[0], p[1], p[2]);
          g.updateMatrixWorld(true);
        }
        mt.moved = true;
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      stopListen.current = null;
      drag.current = null;
      const m = side === "out" ? outMesh.current : inMesh.current;
      const mt = mateRef.current;
      mateRef.current = null;
      const changes: BezierChange[] = [];
      if (m) {
        m.getWorldPosition(tmp);
        changes.push({ seg: segIndex, side, world: [tmp.x, tmp.y, tmp.z] });
      }
      if (mt?.moved) {
        const g = mt.grp.current;
        if (g) {
          g.getWorldPosition(tmp);
          changes.push({ seg: mt.seg, side: mt.side, world: [tmp.x, tmp.y, tmp.z] });
        }
      }
      /** 先写库再放开忙碌标记：反过来会让手柄先跳回旧位置再被新数据重置，闪一下 */
      if (changes.length) onCommitWorld(changes);
      onBusy(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    stopListen.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  };

  /** 手柄球屏幕恒定 9px（关键帧球才 4px，一倍多的差距才一眼分得清谁是谁）+ 连线每帧跟手 */
  useFrame((state) => {
    const cam = state.camera as THREE.PerspectiveCamera;
    const tan = Math.tan((cam.fov * Math.PI) / 360);
    const h = Math.max(1, state.size.height);
    for (const [grp, mesh, line] of [
      [outGrp, outMesh, lines.out],
      [inGrp, inMesh, lines.in],
    ] as const) {
      const g = grp.current;
      const m = mesh.current;
      const anchor = g?.userData.anchor as Vec3 | undefined;
      if (!g || !m || !anchor) {
        line.visible = false;
        continue;
      }
      line.visible = true;
      const d = g.position.distanceTo(cam.position);
      m.scale.setScalar(Math.max(1e-6, (9 / h) * 2 * tan * d));
      line.geometry.setFromPoints([new THREE.Vector3(...anchor), g.position]);
      line.geometry.computeBoundingSphere();
    }
  });

  const one = (
    side: "out" | "in",
    hd: BezierHandle | undefined,
    grp: React.RefObject<THREE.Group | null>,
    mesh: React.RefObject<THREE.Mesh | null>,
  ) => {
    if (!hd) return null;
    return (
      <group ref={grp} position={hd.c} userData={{ anchor: hd.a, side }}>
        <mesh
          ref={mesh}
          onPointerDown={(e) =>
            beginDrag(side, hd.seg, e as unknown as { pointerId: number; stopPropagation: () => void; shiftKey?: boolean })
          }
          onDoubleClick={(e) => {
            e.stopPropagation();
            onReset(hd.seg, side);
          }}
        >
          <sphereGeometry args={[1, 12, 10]} />
          <meshBasicMaterial color={color} transparent opacity={0.95} depthTest={false} depthWrite={false} />
        </mesh>
      </group>
    );
  };

  if (!handles.length) return null;
  return (
    <>
      <primitive object={lines.out} />
      <primitive object={lines.in} />
      {one("out", handles.find((h) => h.side === "out"), outGrp, outMesh)}
      {one("in", handles.find((h) => h.side === "in"), inGrp, inMesh)}
    </>
  );
};

/** 辉光：和成片同一个 installBloom，只是在这里没有"截帧时序"要求，用 effect 装即可 */
const Bloom: React.FC<{
  spec: LightSpec | unknown;
  theme: Theme;
  graph: Scene3DDsl;
  look: Scene3DLook;
  /** 幕内帧号：插件 pass 的 uFrame 靠它，每次读最新值（不能用闭包里的 frame） */
  frame?: React.RefObject<number>;
  fps?: number;
}> = ({ theme, graph, look, frame, fps }) => {
  const state = useThree();
  const handle = useRef<ReturnType<typeof installBloom> | null>(null);

  /*
   * 后期参数每帧重算（都是便宜运算），但**只装一次** composer。
   * 重建 EffectComposer 要重新分配半浮点 RT、重编三套 shader，拖滑块时会卡；
   * 所以下面第二个 effect 用 handle.update 就地改数值与 pass 组合。
   */
  const bloomOpts = bloomFor({
    spec: resolveLook("orbit-core", look).spec,
    background: theme.palette.background,
    graph,
  });
  const postExtras = postExtrasOf(graph);
  /** 数值指纹：对象引用每帧都新，用它当依赖才不会被当成"变了" */
  const postKey = [
    bloomOpts.strength,
    bloomOpts.radius,
    bloomOpts.threshold,
    postExtras.vignette,
    postExtras.chroma,
    postExtras.grain,
    // 插件 pass 也是后期的一部分：agent 改了 post.passes 要能在视口里立刻看到
    JSON.stringify(graph.post?.passes ?? []),
  ].join("|");
  const pluginPost = {
    uses: graph.post?.passes,
    frame: () => frame?.current ?? 0,
    fps: fps ?? 30,
  };

  useEffect(() => {
    try {
      handle.current = installBloom(state, bloomOpts, postExtras, pluginPost);
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
    handle.current?.update(bloomOpts, postExtras, pluginPost);
    // postKey 已涵盖所有数值；bloomOpts / postExtras 是每帧新对象，不能进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postKey]);

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
  /**
   * 运动辅助线显示：关 / 选中 / 全部。
   * 默认"选中"——一进场景就给所有会动的物体各挂一根线，等于没画（满屏都是线）。
   */
  const [trackMode, setTrackMode] = useState<"off" | "sel" | "all">("sel");
  const hasCamTrack = Boolean(graph?.camera?.anim?.length);
  const trackNodeIds = useMemo(
    () => (graph?.nodes ?? []).filter((n) => (n.anim ?? []).length > 0).map((n) => n.id),
    [graph],
  );
  const hasAnyTrack = hasCamTrack || trackNodeIds.length > 0;
  /**
   * 点开的关键帧（轨迹上的点）。点开后显示该帧的贝塞尔手柄；
   * 切到别的物体就收起——手柄一直挂在那儿会把轨迹和物体都挡住。
   */
  /** 贝塞尔手柄正在拖：要让 OrbitRig 别把这一拖当成转视角（见 OrbitRig.handBusy） */
  const handBusy = useRef(false);
  const [trackPick, setTrackPick] = useState<
    { kind: "node"; nodeId: string; frame: number } | { kind: "cam"; frame: number } | null
  >(null);
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
  /** 视口根节点：双击聚焦挂在它上面（见下面的 dblclick 监听） */
  const vpRef = useRef<HTMLDivElement | null>(null);  /** 宽容拾取用的当前图（渲染时刷新，pickAt 调用时读到的一定是新值） */
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
  /** 点开的手柄跟着选中走：选了别人/点了空白就收起，否则手柄会一直挡在画面上 */
  useEffect(() => {
    if (trackPick?.kind === "node" && trackPick.nodeId !== selectedId) setTrackPick(null);
  }, [selectedId, trackPick]);
  /** 拖动起点时各选中节点的世界坐标：松手时按主选的位移把其它选中节点一起搬过去 */
  const dragStartWorld = useRef<{ primary: THREE.Vector3; others: Map<string, THREE.Vector3> } | null>(
    null,
  );
  /**
   * 按下手柄瞬间对象的局部姿态。
   *
   * 用来识别"只是点了一下、没真的拖"：TransformControls 的 pointerdown 会和画布上
   * 其它可点对象（比如轨迹上的关键帧球）抢事件，抢到之后哪怕位移为 0 也会回调 mouseUp，
   * 于是"点一下轨迹球"就会凭空写一颗关键帧。有了这个快照，位移可忽略就什么都不写。
   */
  const dragStartLocal = useRef<{
    pos: THREE.Vector3;
    quat: THREE.Quaternion;
    scale: THREE.Vector3;
  } | null>(null);

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

  /** 跳到某一帧（同步全局播放头，和拖 HUD 滑杆同一套动作） */
  const seekToFrame = useCallback(
    (f: number) => {
      const v = Math.max(0, Math.min(scene.durationInFrames - 1, Math.round(f)));
      setPlaying(false);
      drivingRef.current = true;
      frameBus.set(v + sceneStart);
      drivingRef.current = false;
      setFrame(v);
    },
    [scene.durationInFrames, sceneStart],
  );

  /**
   * 点运动辅助线上的关键帧球：跳到那一帧 + 选中物体。
   *
   * 为什么不做"拖着球走"的代理对象：拖球的语义本来就是"改这一帧的位置"，而
   * commitTransform 已经完整实现了"非 0 帧拖动物体 = 写该帧关键帧"（含第 0 帧锚点、
   * 父级逆矩阵、多选整体平移）。跳过去再拖物体，是同一件事的最短路径；
   * 再造一个代理球只会多一套坐标换算和一套与 Gizmo 抢目标的逻辑。
   */
  const onPickNodeKey = useCallback(
    (nodeId: string, f: number) => {
      seekToFrame(f);
      setSelection([`g:${nodeId}`]);
      setTrackPick({ kind: "node", nodeId, frame: f });
      notify(`第 ${f} 帧：拖三轴手柄改位置；拖轨迹上的贝塞尔手柄把这个弯扳出来`);
    },
    [seekToFrame, setSelection, notify],
  );

  /**
   * 拖贝塞尔手柄松手：把世界坐标的控制点换算回**段的局部 out/in**。
   *
   * 为什么要过父级逆矩阵：curve 是在局部空间求值的（evalNode 输出局部 pos），
   * 节点挂在带旋转的枢轴下时，直接拿世界偏移当局部值会让曲线歪掉。
   * 另一半的控制点保持原值——只改用户拖的那一侧。
   */
  /**
   * 写回曲线控制点。
   *
   * 参数是**一组**改动而不是单个：拖手柄默认相切联动，对侧手柄属于相邻段，
   * 一次手势要同时改两段。分成两次写库会多一步撤销、还可能只写进去一半。
   */
  const commitBezier = useCallback(
    (changes: BezierChange[]) => {
      const pick = trackPick;
      if (pick?.kind !== "node" || !graph || !changes.length) return;
      const node = graph.nodes.find((n) => n.id === pick.nodeId);
      if (!node?.anim?.length) return;

      /** 世界 → 局部（父级用了当前帧的 matrixWorld，父级在动也不会错） */
      const obj = objects.current.get(pick.nodeId);
      obj?.parent?.updateWorldMatrix(true, false);
      const inv = obj?.parent ? obj.parent.matrixWorld.clone().invert() : new THREE.Matrix4();
      const toLocal = (w: Vec3): Vec3 => {
        const p = new THREE.Vector3(w[0], w[1], w[2]).applyMatrix4(inv);
        return [p.x, p.y, p.z];
      };

      /** 按段归并：同一段可能两侧都被改（首/末帧补位手柄就是这种情况） */
      const touched = new Map<number, { c1?: Vec3; c2?: Vec3 }>();
      for (const ch of changes) {
        if (!node.anim[ch.seg]) continue;
        const slot = touched.get(ch.seg) ?? {};
        if (ch.side === "out") slot.c1 = toLocal(ch.world);
        else slot.c2 = toLocal(ch.world);
        touched.set(ch.seg, slot);
      }

      const round3 = (v: Vec3): [number, number, number] => [r4(v[0]), r4(v[1]), r4(v[2])];
      const nextAnim = node.anim.map((a, k) => {
        const t = touched.get(k);
        if (!t) return a;
        const A = evalNode(node, Math.round(a.at[0])).pos;
        const B = evalNode(node, Math.round(a.at[1])).pos;
        const cur = pathControls(A, B, (a.curve?.out ?? [0, 0, 0]) as Vec3, (a.curve?.in ?? [0, 0, 0]) as Vec3);
        const { out, inn } = pathTangents(A, B, t.c1 ?? cur.c1, t.c2 ?? cur.c2);
        const o = round3(out);
        const i = round3(inn);
        /** 两侧都回到 0 就等于直线：把 curve 整个删掉，别留一堆零在 DSL 里 */
        const flat = o.every((x) => Math.abs(x) < 1e-4) && i.every((x) => Math.abs(x) < 1e-4);
        return { ...a, ...(flat ? { curve: undefined } : { curve: { out: o, in: i } }) };
      });
      void apply([{ op: "update_graph_node", sceneId: scene.id, nodeId: pick.nodeId, patch: { anim: nextAnim } } as Op]);
    },
    [trackPick, graph, objects, apply, scene.id],
  );

  /** 双击手柄 = 把这一侧拉直（另一侧保留） */
  const resetBezier = useCallback(
    (segIdx: number, side: "out" | "in") => {
      const pick = trackPick;
      if (pick?.kind !== "node" || !graph) return;
      const node = graph.nodes.find((n) => n.id === pick.nodeId);
      if (!node?.anim?.[segIdx]) return;
      const seg = node.anim[segIdx];
      const out = side === "out" ? [0, 0, 0] : (seg.curve?.out ?? [0, 0, 0]);
      const inn = side === "in" ? [0, 0, 0] : (seg.curve?.in ?? [0, 0, 0]);
      const flat = [...out, ...inn].every((x) => Math.abs(x) < 1e-4);
      const nextAnim = node.anim.map((a, k) =>
        k === segIdx ? { ...a, ...(flat ? { curve: undefined } : { curve: { out, in: inn } }) } : a,
      );
      void apply([{ op: "update_graph_node", sceneId: scene.id, nodeId: pick.nodeId, patch: { anim: nextAnim } } as Op]);
      notify(side === "out" ? "出手柄已拉直（这一段起手不再弯）" : "入手柄已拉直（这一段收尾不再弯）");
    },
    [trackPick, graph, apply, scene.id, notify],
  );

  /* ── 相机轨迹的曲线：机位本身就是世界坐标，不用过父级逆矩阵 ── */

  const commitCamBezier = useCallback(
    (changes: BezierChange[]) => {
      if (!graph || !changes.length) return;
      const anims = graph.camera?.anim ?? [];
      const round3 = (v: Vec3): [number, number, number] => [r4(v[0]), r4(v[1]), r4(v[2])];
      const touched = new Map<number, { c1?: Vec3; c2?: Vec3 }>();
      for (const ch of changes) {
        if (!anims[ch.seg]) continue;
        const slot = touched.get(ch.seg) ?? {};
        if (ch.side === "out") slot.c1 = ch.world;
        else slot.c2 = ch.world;
        touched.set(ch.seg, slot);
      }
      const next = anims.map((a, k) => {
        const t = touched.get(k);
        if (!t) return a;
        const A = dslCamera(graph, Math.round(a.at[0]) / fps, fps).worldPos;
        const B = dslCamera(graph, Math.round(a.at[1]) / fps, fps).worldPos;
        const cur = pathControls(A, B, (a.curve?.out ?? [0, 0, 0]) as Vec3, (a.curve?.in ?? [0, 0, 0]) as Vec3);
        const { out, inn } = pathTangents(A, B, t.c1 ?? cur.c1, t.c2 ?? cur.c2);
        const o = round3(out);
        const i = round3(inn);
        const flat = [...o, ...i].every((x) => Math.abs(x) < 1e-4);
        /**
         * 看向点自己的切线要**原样带回来**：拖机位手柄只该改机位的弯度。
         * 丢掉它，镜头方向的段间切线就断了 —— 画面立刻回到"一抖一抖"。
         */
        const keepT = { targetOut: a.curve?.targetOut, targetIn: a.curve?.targetIn };
        return {
          ...a,
          ...(flat
            ? { curve: keepT.targetOut || keepT.targetIn ? { ...keepT } : undefined }
            : { curve: { out: o, in: i, ...keepT } }),
        };
      });
      void apply([{ op: "set_graph_camera", sceneId: scene.id, camera: { anim: next } } as Op]);
    },
    [graph, fps, apply, scene.id],
  );

  const resetCamBezier = useCallback(
    (segIdx: number, side: "out" | "in") => {
      if (!graph) return;
      const anims = graph.camera?.anim ?? [];
      const seg = anims[segIdx];
      if (!seg) return;
      const out = side === "out" ? [0, 0, 0] : (seg.curve?.out ?? [0, 0, 0]);
      const inn = side === "in" ? [0, 0, 0] : (seg.curve?.in ?? [0, 0, 0]);
      const flat = [...out, ...inn].every((x) => Math.abs(x) < 1e-4);
      // 同上：只拉直机位这一侧，看向点的切线保持不变
      const keepT = { targetOut: seg.curve?.targetOut, targetIn: seg.curve?.targetIn };
      const next = anims.map((a, k) =>
        k === segIdx
          ? {
              ...a,
              ...(flat
                ? { curve: keepT.targetOut || keepT.targetIn ? { ...keepT } : undefined }
                : { curve: { out, in: inn, ...keepT } }),
            }
          : a,
      );
      void apply([{ op: "set_graph_camera", sceneId: scene.id, camera: { anim: next } } as Op]);
      notify(side === "out" ? "运镜出手柄已拉直" : "运镜入手柄已拉直");
    },
    [graph, apply, scene.id, notify],
  );

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
      /** 当前帧锁定的节点（画锁定虚线 / 目标锁框 / 面板状态都读它） */
      lockId: cam.lockId,
    };
  }, [graph, frame, fps]);

  /** 当前锁定目标的显示名（提示条用；节点被删/改名时退回 id） */
  const lockLabel = shotPose.lockId
    ? (graph?.nodes.find((n) => n.id === shotPose.lockId)?.label ?? shotPose.lockId)
    : null;

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

  /**
   * 双击物体/相机 → 镜头推到它跟前。
   *
   * 为什么不用 r3f 的 onDoubleClick：它依赖内部的 pointer 状态（上一次按下/抬起的位置），
   * 自动化里合成的 dblclick 拿不到那套状态，实测一次都不触发。这里直接听视口容器上的
   * 原生 dblclick，再用已有的**宽容拾取** `pickAt` 找对象——顺带解决了"物体只有几像素、
   * 双击总是擦边"的问题（精确射线点不中也能按屏幕距离兜住）。
   */
  useEffect(() => {
    const host = vpRef.current;
    if (!host) return;
    const onDbl = (e: MouseEvent) => {
      // 只认画布上的双击：HUD 按钮、提示条上的双击不该聚焦
      if ((e.target as HTMLElement | null)?.tagName !== "CANVAS") return;
      const id = api.current?.pickAt(e.clientX, e.clientY);
      if (!id) return;
      if (id === SHOT_CAM) {
        setSelection(["cam"]);
        api.current?.focusOn(SHOT_CAM);
      } else {
        setSelection([`g:${id}`]);
        api.current?.focusOn(id);
      }
    };
    host.addEventListener("dblclick", onDbl);
    return () => host.removeEventListener("dblclick", onDbl);
  }, [setSelection]);

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
    /**
     * 关键帧上限前移到这里拦：真正撞上限时 schema 会整条 op 拒绝写入，
     * 报错是一句 "关键帧最多 8 段"，用户看不懂是谁满了。这里直接点名节点 + 给下一步。
     */
    if (useKeys && !keys.some((k) => k.frame === frame) && keys.length >= NODE_KEY_MAX) {
      notify(
        `「${target.label ?? target.id}」关键帧已满（最多 ${NODE_KEY_MAX} 颗 = ${NODE_KEY_MAX - 1} 段）。` +
          `先在这一帧之外删掉一颗，或让 agent 合并中段`,
      );
      return;
    }

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
    if (shotPose.lockId) {
      /**
       * 锁定段：写入的 target 就用**锁定点**，不要用手势推导出来的那个。
       * 一来段内 target 本来就被 lookAt 覆盖（写别的也是废数据），二来这样"以后退出锁定"
       * 时看向点正好落在锁定位置，不会突然甩到别处。
       */
      target = new THREE.Vector3(...shotPose.target);
    } else if (mode === "rotate") {
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
      /**
       * 关键帧必须从 camKeyWithPose 造：它会带上当前段的 follow/lookAt。
       * 这里以前手写 {frame,pos,target,fov,ease}，于是**锁定中拖一下相机，锁定就没了**
       * ——因为新关键帧成为后半段的起点，而它不带 lookAt。
       */
      const key = camKeyWithPose(graph, frame, {
        pos: [r4(pos.x), r4(pos.y), r4(pos.z)],
        target: [r4(target.x), r4(target.y), r4(target.z)],
        fov: shotPose.fov,
      });
      const zero = camZeroKeyOf(graph, fps);
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
    <div className="vp3d" ref={vpRef}>
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
        camera={{ position: [0, 2.4, 9], fov: 45, near: 0.06, far: 12000 }}
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
        <Bloom spec={null} theme={theme} graph={graph} look={resolved.name} frame={frameRef} fps={fps} />

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
          fps={fps}
          theme={theme}
          camera={IDENTITY_CAMERA}
          selectedId={selectedId}
          lockedId={shotPose.lockId ?? null}
          onNodeObject={onNodeObject}
          onNodeDoubleClick={(id) => api.current?.focusOn(id)}
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
          lock={Boolean(shotPose.lockId)}
          lockColor={theme.palette.primary}
          onObject={onCameraObject}
          onFocus={() => api.current?.focusOn(SHOT_CAM)}
          dragging={dragging}
          mode={mode}
          dragStart={camDragStart}
        />

        {/* 运镜轨迹：整条路径 + 每个关键帧一颗球（没有运镜关键帧时不画） */}
        {trackMode !== "off" && hasCamTrack ? (
          <CameraTrack
            graph={graph}
            fps={fps}
            durationInFrames={scene.durationInFrames}
            color={theme.palette.accent}
            active={camSelected}
            frameRef={frameRef}
            objects={objects}
            onPickKey={(f) => {
              seekToFrame(f);
              setSelection(["cam"]);
              setTrackPick({ kind: "cam", frame: f });
              notify(`第 ${f} 帧机位：拖贝塞尔手柄让这一段运镜绕弧线（双击手柄拉直）`);
            }}
          />
        ) : null}

        {/*
          物体运动辅助线：
          - 选中模式：只画主选的那个（多选时画第一个）；
          - 全部模式：所有有动画的节点都画，非选中那条压暗——否则 48 根同亮度的线等于没画。
          - 相机轨迹不在这里重复：它有自己的开关语义（跟随成片相机，不是节点）。
        */}
        {trackMode !== "off"
          ? trackNodeIds
              .filter((id) => trackMode === "all" || id === selectedId)
              .map((id) => (
                <NodeTrack
                  key={id}
                  nodes={graph.nodes}
                  nodeId={id}
                  durationInFrames={scene.durationInFrames}
                  color={theme.palette.accent}
                  active={id === selectedId}
                  frameRef={frameRef}
                  objects={objects}
                  onPickKey={(f) => onPickNodeKey(id, f)}
                />
              ))
          : null}

        {/*
          贝塞尔手柄：点开的关键帧，前后两段的控制点。
          只在有轨迹显示时给——手柄是轨迹的编辑附件，轨迹都藏起来了还挂两个球会莫名其妙。
        */}
        {trackMode !== "off" && trackPick ? (
          <BezierHandles
            segs={
              trackPick.kind === "node"
                ? ((graph.nodes.find((n) => n.id === trackPick.nodeId)?.anim ?? []) as never)
                : ((graph.camera?.anim ?? []) as never)
            }
            endpointAt={
              trackPick.kind === "node"
                ? (f) => (worldPointOf(graph.nodes, trackPick.nodeId, f) ?? [0, 0, 0]) as Vec3
                : (f) => dslCamera(graph!, f / fps, fps).worldPos
            }
            frame={trackPick.frame}
            color={HANDLE_COLOR}
            /** 相机的 follow 段：pos 是相对节点的偏移，拖世界坐标会打架，直接不给手柄 */
            editable={
              trackPick.kind === "cam"
                ? (s) => !(s as { follow?: string }).follow
                : undefined
            }
            onBusy={(b) => {
              handBusy.current = b;
              setDragging(b);
              if (b) setPlaying(false);
            }}
            onCommitWorld={trackPick.kind === "node" ? commitBezier : commitCamBezier}
            onReset={trackPick.kind === "node" ? resetBezier : resetCamBezier}
          />
        ) : null}

        <Gizmo
          targetId={
            camSelected
              ? mode === "scale" || (shotPose.lockId && mode === "rotate")
                ? null // 相机没有缩放；锁定时旋转会被约束覆盖，手柄直接不给（拖了没反应更困惑）
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
              // "只是点了一下"的判定基准（见 dragStartLocal 的注释）
              const held = objects.current.get(camSelected ? SHOT_CAM : selectedId ?? "");
              dragStartLocal.current = held
                ? { pos: held.position.clone(), quat: held.quaternion.clone(), scale: held.scale.clone() }
                : null;
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
            /**
             * 先判"到底动没动"。TransformControls 在只点一下时也会回调 mouseUp，
             * 而画布上的轨迹关键帧球和它的手柄常常重叠——不判这一下，用户点轨迹球
             * 就会凭空打出一颗关键帧（实测在 e2e 里就复现了）。
             */
            const s = dragStartLocal.current;
            dragStartLocal.current = null;
            const held = objects.current.get(camSelected ? SHOT_CAM : selectedId ?? "");
            if (s && held) {
              const moved =
                held.position.distanceToSquared(s.pos) > 1e-8 ||
                held.quaternion.angleTo(s.quat) > 1e-4 ||
                Math.abs(held.scale.x - s.scale.x) > 1e-6;
              if (!moved) {
                // 顺手把拖拽起点清掉，否则下次真拖动会拿上一次的旧值算位移
                camDragStart.current = null;
                return;
              }
            }
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
          handBusy={() => handBusy.current}
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
          ).map(([m, label]) => {
            /** 锁定看向时旋转手柄会被约束覆盖，直接禁掉这个模式（拖了不动最伤信任） */
            const lockedRotate = camSelected && Boolean(shotPose.lockId) && m === "rotate";
            return (
              <button
                key={m}
                className={`seg-item ${mode === m ? "is-on" : ""}`}
                disabled={lockedRotate}
                title={lockedRotate ? "已锁定看向目标，旋转会被约束覆盖；要改朝向先退出锁定" : undefined}
                onClick={() => setMode(m)}
              >
                {label}
              </button>
            );
          })}
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
        {hasAnyTrack ? (
          <div className="seg" title="运动辅助线：关 / 只画选中的 / 全部显示（只在编辑视口里，不会进成片）">
            {(
              [
                ["off", "无轨迹"],
                ["sel", "选中轨迹"],
                ["all", "全部轨迹"],
              ] as const
            ).map(([m, label]) => (
              <button key={m} className={`seg-item ${trackMode === m ? "is-on" : ""}`} onClick={() => setTrackMode(m)}>
                {label}
              </button>
            ))}
          </div>
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
            {lockLabel ? ` · 镜头锁定「${lockLabel}」：整条看向线是虚线，旋转手柄暂时禁用` : ""}
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
        {/*
          锁定是**场景级状态**（镜头在拍谁），不随选中变化。
          只在选中相机时才显示的话，用户选了物体就不知道镜头还锁着，会以为"怎么转都不动"。
        */}
        {lockLabel && !camSelected ? <span> · 镜头锁定「{lockLabel}」</span> : null}
      </div>
    </div>
  );
};
