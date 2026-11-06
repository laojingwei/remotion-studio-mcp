import * as THREE from "three";
import type { RootState } from "@react-three/fiber";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import type { Scene3DDsl } from "../../../shared/scene3dDsl";
import { allPassIds, passDefOf } from "../../../shared/scene3dPasses";

/**
 * 阈值辉光（UnrealBloomPass），走 three 自带后处理，不引第三方库。
 *
 * ## 为什么不用 `@react-three/postprocessing`
 *
 * 它用 priority 1 的 `useFrame` 接管渲染，而 `ThreeCanvas` 是 `frameloop="never"` +
 * 手动 `advance()`：Remotion 判"可以截屏"的时刻早于 composer 输出到默认帧缓冲，
 * 整帧是空的（实测调 frameBufferType / 关 MSAA 都不变一个像素）。
 *
 * ## 这里的做法：劫持 `gl.render`，而不是挂 useFrame
 *
 * R3F 每次 advance 都会调 `gl.render(scene, camera)`。把 `gl.render` 换成
 * "composer.render()"，后处理就发生在 **R3F 渲染的同一次同步调用里**，
 * 调用栈返回时像素已经在屏幕上，Remotion 什么时候截屏都赶得上 —— 这是绕开
 * 时序问题的唯一可靠位置。RenderPass 内部会再调一次 `renderer.render()`，
 * 用 `inside` 标志让它走回原始实现，否则无限递归。
 *
 * ## 为什么之前 CSS 全屏混合不够
 *
 * CSS 的 `blur + brightness + screen` 没有亮度阈值：它把**整个物体**都当成高光提亮，
 * 于是金属的锐利高光被抹平、物体整圈发白，观感从"金属"掉到"发光糖果"。
 * UnrealBloomPass 只取 `luminance > threshold` 的部分，才是"光溢出"而不是"整体提亮"。
 */

export type BloomOptions = {
  /** 强度：0–1，浅色主题要压到 0.2 附近，否则白底直接蒙一层雾 */
  strength: number;
  /** 扩散半径：0–1，越大光晕越散 */
  radius: number;
  /** 亮度阈值：线性空间亮度，只让超过它的像素发光 */
  threshold: number;
};

export type BloomHandle = {
  setSize: (cssWidth: number, cssHeight: number) => void;
  /**
   * 就地换参数：辉光改三个数值、收尾效果按需增删 pass。
   *
   * 为什么不是"改了参数就 dispose 重建"：`EffectComposer` 重建要重新分配
   * 半浮点渲染目标、重编三套 shader，拖一个滑块就是几十次分配（视口直接卡）。
   * 而这三类参数都能就地改：bloom 的三个值本来就是每帧读的字段，
   * 收尾 pass 只要"删掉再按固定顺序追加回队尾"就是新参数下的正确顺序。
   *
   * 渲染端不用它（参数一次定死，多余 pass 也不建）；编辑器视口用它做实时预览。
   */
  update: (opts: BloomOptions, extras?: PostExtras, plugins?: PostPlugins) => void;
  dispose: () => void;
};

/**
 * 装上辉光。必须在 `onCreated` 里调用（同步、早于首帧），
 * 放 `useEffect` 里会晚于 Remotion 截的第一帧 —— 这个坑和 envMap 那个是同一个。
 */
/* ─────────────────────── 收尾效果（vignette / chroma / grain） ─────────────────────── */

const FULLSCREEN_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * 暗角：按到中心的距离压暗，`smoothstep` 保证中心一片完全不压、边缘才落。
 * 用固定 inner/outer 而不是让强度调半径：强度只该改"压多狠"，
 * 改半径会让同一个数字在不同画幅下表现不一致（16:9 和 9:16 的角落不一样远）。
 */
const VIGNETTE_SHADER = {
  uniforms: { tDiffuse: { value: null }, amount: { value: 0 } },
  vertexShader: FULLSCREEN_VERT,
  fragmentShader: `
uniform sampler2D tDiffuse;
uniform float amount;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  float d = distance(vUv, vec2(0.5));
  float v = smoothstep(0.28, 0.78, d) * amount * 1.15;
  gl_FragColor = vec4(c.rgb * (1.0 - clamp(v, 0.0, 0.92)), c.a);
}
`,
};

/**
 * 色差：R/B 通道向相反方向偏移，中心为 0、边缘最强（模拟镜头）。
 * 只错开一点点就够——多了文字立刻发花，所以上限在 schema 里压到 1，
 * 而 1 对应的实际位移也只有 3 像素（按 uv 归一化）。
 */
const CHROMA_SHADER = {
  uniforms: { tDiffuse: { value: null }, amount: { value: 0 } },
  vertexShader: FULLSCREEN_VERT,
  fragmentShader: `
uniform sampler2D tDiffuse;
uniform float amount;
varying vec2 vUv;
void main() {
  vec2 dir = vUv - vec2(0.5);
  float k = amount * 0.03 * dot(dir, dir) * 4.0;
  float r = texture2D(tDiffuse, vUv + dir * k).r;
  float g = texture2D(tDiffuse, vUv).g;
  float b = texture2D(tDiffuse, vUv - dir * k).b;
  gl_FragColor = vec4(r, g, b, texture2D(tDiffuse, vUv).a);
}
`,
};

/**
 * 胶片颗粒：一个便宜的 hash 噪声，**静止**（不逐帧变化）。
 *
 * 为什么不做动态：`installBloom` 在 `onCreated` 里跑一次，拿不到帧号；
 * 要做逐帧就得每帧 `uniforms.seed.value = frame`。而颗粒的主要用途是
 * "打散深色渐变的色带"，静止颗粒同样有效，且不会在压缩后变成蠕动的噪点。
 * 真要动态颗粒时再加帧号，别现在为它引入一条每帧写 uniform 的路径。
 */
const GRAIN_SHADER = {
  uniforms: { tDiffuse: { value: null }, amount: { value: 0 } },
  vertexShader: FULLSCREEN_VERT,
  fragmentShader: `
uniform sampler2D tDiffuse;
uniform float amount;
varying vec2 vUv;
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  // 三个不同频率叠一下，避免规则的网格感
  float n = hash(vUv * 1024.0) + hash(vUv * 613.0 + 7.3) + hash(vUv * 337.0 + 2.1);
  n = n / 3.0 - 0.5;
  gl_FragColor = vec4(c.rgb + n * amount * 0.18, c.a);
}
`,
};

export type PostExtras = { vignette?: number; chroma?: number; grain?: number };

/** 从 graph.post 里取三个收尾参数（没给就是关） */
export const postExtrasOf = (graph?: Scene3DDsl): PostExtras => {
  const p = (graph as { post?: PostExtras } | undefined)?.post;
  return {
    vignette: typeof p?.vignette === "number" ? p.vignette : 0,
    chroma: typeof p?.chroma === "number" ? p.chroma : 0,
    grain: typeof p?.grain === "number" ? p.grain : 0,
  };
};

/* ─────────────────── 插件后期 pass（受控 GLSL） ─────────────────── */

/** 一条 `post.passes` 引用 */
export type PluginPassUse = { id: string; intensity?: number; params?: Record<string, number> };

export type PostPlugins = {
  /** 要用哪些插件 pass，按顺序 */
  uses?: PluginPassUse[];
  /** 当前帧号（每帧读一次，喂给 uFrame）。不给就是 0 */
  frame?: () => number;
  fps?: number;
};

/**
 * 预检用的顶点着色器。
 *
 * 和 `FULLSCREEN_VERT` 等价，但**把 three 会注入的声明写全**
 * （`attribute position/uv`、`modelViewMatrix`、`projectionMatrix`）。
 * 不写全的话，我们自己的 `gl.compileShader` 会因为"用了没声明的 uniform"失败，
 * 把一段完全正常的 shader 判成坏的。
 */
const PRECHECK_VERT = `
attribute vec3 position;
attribute vec2 uv;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * three 会给每个 fragment 加 `precision` 前缀，所以这里必须补同样的声明——
 * 否则"作者没写 precision"这种完全正常的代码会被判成编译失败。
 *
 * 代价是报错里的行号比作者的文件多 1（这一行）。文案里说明了，别让作者对着
 * `ERROR: 0:62` 去数自己的第 62 行。
 */
const PRECISION_PREFIX = "precision highp float;\n";

/**
 * 装之前自己编一次。
 *
 * ## 为什么非做不可（实测结论）
 *
 * three 0.187 里，一段编不过的 GLSL **不抛异常**：只在 console 打一条
 * `VALIDATE_STATUS false`，`composer.render()` 正常返回，而画面是**整帧全黑**
 * —— 不是"跳过这个 pass"，前面 RenderPass 的内容也一起丢了。
 *
 * 也就是说 `try/catch` 在这里毫无用处。唯一能在事故之前拦住的地方，就是
 * 装 pass 之前用同一个 GL 上下文编一遍。
 *
 * 必须用**渲染时那个 renderer 的上下文**，不能另建一个：软件渲染（swiftshader）
 * 能过、真 GPU 过不了的 shader 是存在的，换个上下文检查等于骗自己。
 */
function compileCheck(gl: WebGLRenderingContext | WebGL2RenderingContext, fragment: string): { ok: boolean; log: string } {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return { ok: false, log: "无法创建 shader 对象（GL 上下文不可用）" };
  try {
    gl.shaderSource(vs, PRECISION_PREFIX + PRECHECK_VERT);
    gl.compileShader(vs);
    gl.shaderSource(fs, PRECISION_PREFIX + fragment);
    gl.compileShader(fs);
    const vsOk = Boolean(gl.getShaderParameter(vs, gl.COMPILE_STATUS));
    const fsOk = Boolean(gl.getShaderParameter(fs, gl.COMPILE_STATUS));
    if (vsOk && fsOk) {
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (gl.getProgramParameter(prog, gl.LINK_STATUS)) return { ok: true, log: "" };
      return { ok: false, log: (gl.getProgramInfoLog(prog) ?? "").trim() || "链接失败（没有 infoLog）" };
    }
    const parts = [
      vsOk ? "" : `vertex: ${(gl.getShaderInfoLog(vs) ?? "").trim()}`,
      fsOk ? "" : `fragment: ${(gl.getShaderInfoLog(fs) ?? "").trim()}`,
    ];
    return { ok: false, log: parts.filter(Boolean).join(" | ") || "编译失败（没有 infoLog）" };
  } finally {
    gl.deleteProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
  }
}

/** 统一的告警前缀：`onBrowserLog` 靠它把消息捞回服务端（见 render.service.ts） */
const PASS_TAG = "[plugin-pass]";

export function installBloom(
  state: Pick<RootState, "gl" | "scene" | "camera" | "size">,
  opts: BloomOptions,
  extras: PostExtras = {},
  plugins: PostPlugins = {},
): BloomHandle {
  const { gl, scene, camera, size } = state;
  const dpr = gl.getPixelRatio();
  const px = (v: number) => Math.max(1, Math.round(v * dpr));

  /**
   * 自建渲染目标而不是让 EffectComposer 自己建：
   * 上下文上的 `antialias: true` 在"渲染到 RT"时是无效的（它只作用于默认帧缓冲），
   * 不走 RT 的 samples 的话，接管渲染后画面的边缘会比原来明显更糙。
   */
  const target = new THREE.WebGLRenderTarget(px(size.width), px(size.height), {
    type: THREE.HalfFloatType,
    samples: 4,
  });

  const composer = new EffectComposer(gl, target);
  composer.setPixelRatio(dpr);

  const renderPass = new RenderPass(scene, camera);
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(px(size.width), px(size.height)),
    opts.strength,
    opts.radius,
    opts.threshold,
  );
  // OutputPass 负责 linear → sRGB（以及 tone mapping）：
  // 少了它，composer 把**线性**结果直接贴到屏幕上，画面会明显发灰发亮
  const output = new OutputPass();
  composer.addPass(renderPass);
  composer.addPass(bloom);
  composer.addPass(output);
  /*
   * 三个收尾效果放在 OutputPass **之后**：那时已经在 sRGB 空间，
   * 乘系数 / 偏移通道就是眼睛看到的效果，不用反推线性空间。
   * `amount` 为 0 的直接不加 pass —— 省一次全屏采样，也保证"没开时一个像素都不变"。
   */
  let extraPasses: ShaderPass[] = [];

  /**
   * 按固定顺序重建收尾 pass。
   *
   * 顺序必须固定（暗角 → 色差 → 颗粒），否则"改了某个参数导致 pass 增删"会得到
   * 不同的叠加顺序，画面无端变一次。它们都在 OutputPass 之后、也就是 composer
   * 队列末尾，所以"全删 + 按序追加"就等于"正确顺序"，不需要 insertPass。
   */
  const applyExtras = (next: PostExtras) => {
    for (const pass of extraPasses) {
      composer.removePass(pass);
      pass.dispose();
    }
    extraPasses = [];
    const push = (shader: typeof VIGNETTE_SHADER, amount: number | undefined) => {
      if (typeof amount !== "number" || amount <= 0) return;
      const pass = new ShaderPass(shader as never);
      (pass.uniforms as Record<string, { value: number }>).amount.value = amount;
      composer.addPass(pass);
      extraPasses.push(pass);
    };
    push(VIGNETTE_SHADER, next.vignette);
    push(CHROMA_SHADER, next.chroma);
    push(GRAIN_SHADER, next.grain);
  };
  applyExtras(extras);
  composer.setSize(size.width, size.height);

  /* ── 插件后期 pass：装之前先自检编译，编不过就不装 ── */
  let pluginPasses: ShaderPass[] = [];
  let pluginKey = "";
  let frameGetter = plugins.frame;

  const warnPass = (msg: string) => console.warn(`${PASS_TAG} ${msg}`);

  /**
   * 重建插件 pass 链。
   *
   * `insertPass` 而不是 `addPass`：内置的暗角/色差/颗粒靠"删了再加回队尾"维持顺序，
   * 插件 pass 必须是"sRGB 之后、镜头效果之前"——用 addPass 会被后来的内置效果挤到前面去。
   *
   * `intensity` 不写就当 1（全量）。作者若想让"默认温和"由自己的 shader 决定，
   * 那是他该在源码里乘系数的事，宿主不该替他猜。
   */
  const applyPlugins = (next: PostPlugins) => {
    const uses = (next.uses ?? []).filter((u) => u && typeof u.id === "string");
    const key = JSON.stringify(uses);
    if (key === pluginKey) return; // 每帧都会被调用，没变就别重建
    for (const pass of pluginPasses) {
      composer.removePass(pass);
      pass.dispose();
    }
    pluginPasses = [];
    pluginKey = key;
    frameGetter = next.frame ?? frameGetter;
    if (!uses.length) return;

    // output 之后 = 内置收尾之前
    const base = composer.passes.indexOf(output) + 1;
    for (const use of uses) {
      const def = passDefOf(use.id);
      if (!def) {
        const ids = allPassIds();
        warnPass(
          `跳过「${use.id}」：没有这个 pass。` +
            (ids.length ? `可用：${ids.join("、")}` : "当前没有插件提供后期 pass（plugins/<名>/scene3d/passes.json）"),
        );
        continue;
      }
      const check = compileCheck(gl.getContext(), def.fragment);
      if (!check.ok) {
        warnPass(
          `跳过「${def.id}」（来自 ${def.from ?? "内置"}）：着色器编译不过，这个效果不会出现在画面里。` +
            `报错行号比你的文件多 1 行（宿主补了一条 precision 声明）。${check.log.slice(0, 600)}`,
        );
        continue;
      }
      const uniforms: Record<string, { value: unknown }> = {
        tDiffuse: { value: null },
        uResolution: { value: new THREE.Vector2(px(size.width), px(size.height)) },
        uFrame: { value: 0 },
        uFps: { value: next.fps ?? 30 },
        uAmount: { value: typeof use.intensity === "number" ? use.intensity : 1 },
      };
      for (const [name, spec] of Object.entries(def.params)) {
        const raw = use.params?.[name];
        const v =
          typeof raw === "number" && Number.isFinite(raw)
            ? Math.min(spec.max, Math.max(spec.min, raw))
            : spec.default;
        uniforms[name] = { value: v };
      }
      const pass = new ShaderPass({ uniforms, vertexShader: FULLSCREEN_VERT, fragmentShader: def.fragment });
      composer.insertPass(pass, base + pluginPasses.length);
      pluginPasses.push(pass);
    }
  };
  applyPlugins(plugins);

  const original = gl.render.bind(gl);
  let inside = false;

  gl.render = ((s: THREE.Object3D, c: THREE.Camera) => {
    if (inside) {
      // composer 的 RenderPass 内部回调：走原始渲染，否则无限递归
      original(s as THREE.Scene, c);
      return;
    }
    // 相机/场景可能在 props 变化后被替换，每次接管前同步一次
    renderPass.scene = s as THREE.Scene;
    renderPass.camera = c;
    inside = true;
    /*
     * `uFrame` 每帧写一次：插件的动画（扫描线滚动之类）必须跟着 Remotion 的帧号走。
     * 绝不能用 `performance.now()` —— 同一帧渲两次会得到不同结果，Remotion 的
     * 抽帧/并发渲染就全乱了（这是"确定性"的硬要求，不是洁癖）。
     */
    const now = frameGetter?.() ?? 0;
    for (const pass of pluginPasses) {
      const u = (pass as unknown as { uniforms?: Record<string, { value: unknown }> }).uniforms;
      if (u?.uFrame) u.uFrame.value = now;
    }
    try {
      composer.render();
    } finally {
      inside = false;
    }
  }) as typeof gl.render;

  return {
    setSize: (cssWidth, cssHeight) => {
      composer.setPixelRatio(dpr);
      composer.setSize(cssWidth, cssHeight);
      bloom.setSize(px(cssWidth), px(cssHeight));
      // 插件的 shader 常按 uv 算像素偏移，分辨率变了必须同步，否则视口缩放后效果会变形
      for (const pass of pluginPasses) {
        const u = (pass as unknown as { uniforms?: Record<string, { value: unknown }> }).uniforms;
        if (u?.uResolution) (u.uResolution.value as THREE.Vector2).set(px(cssWidth), px(cssHeight));
      }
    },
    update: (nextOpts, nextExtras, nextPlugins) => {
      // UnrealBloomPass 的三个值是每帧读的字段，改了立刻生效，不用重建
      bloom.strength = nextOpts.strength;
      bloom.radius = nextOpts.radius;
      bloom.threshold = nextOpts.threshold;
      applyExtras(nextExtras ?? {});
      if (nextPlugins) applyPlugins(nextPlugins);
    },
    dispose: () => {
      gl.render = original as typeof gl.render;
      for (const pass of pluginPasses) pass.dispose();
      for (const pass of extraPasses) pass.dispose();
      bloom.dispose();
      output.dispose();
      renderPass.dispose?.();
      composer.dispose();
      target.dispose();
    },
  };
}
