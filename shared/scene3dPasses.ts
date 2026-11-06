/**
 * 插件贡献的 3D 后期 pass（受控 GLSL）。
 *
 * ## 为什么最后决定开放 GLSL
 *
 * 原来的结论是「不给插件塞 GLSL」，理由是"效果好坏无法自动验证"。这个理由站不住：
 * 工具该管的是**能不能用、会不会崩**，不是好不好看。而且不开放也挡不住——插件场景组件
 * 是 `.tsx`，工程内可以直接 `import three` 自己搭一套 composer，只是变成野路子：
 * 没有校验、没有统一开关、出问题更难查。堵不如疏，疏的那条路我们能加护栏。
 *
 * ## 实测得到的两条硬事实（决定了这里的形状）
 *
 * three 0.187 里，一段编不过的 GLSL **不抛异常**：只在 console 打一条
 * `VALIDATE_STATUS false`，`composer.render()` 正常返回。而画面是**整帧全黑**
 * （不是"跳过这个 pass"，前面 RenderPass 渲的内容也一起丢了）。
 *
 * 所以 `try/catch` 毫无用处，隔离必须**前置**：装 pass 之前自己编一次，编不过就不装。
 * 这件事只能在渲染端做（要真 GL 上下文），见 `src/scenes/scene3d/bloom.ts` 的
 * `compileCheck`。这一侧（服务端 / 共享）只能做**文本级**校验，也就是下面这些规则。
 *
 * ## 作者能写什么
 *
 * 只写 fragment。vertex 是固定的全屏三角形/四边形顶点着色器，可用的 uniform 见
 * `RESERVED_UNIFORMS`。不给自定义 vertex 是有意的：能干的（裁剪、几何错位）超出
 * "后期"的语义，也更容易把画面搞成空白——那种需求应该写插件场景组件。
 */

export type PassParam = {
  /** 面板/文档用的中文说明，可省 */
  label?: string;
  min: number;
  max: number;
  default: number;
};

export type PassDef = {
  /** 在 `post.passes[].id` 里写这个 */
  id: string;
  label: string;
  summary: string;
  /** GLSL 片段着色器源码（GLSL ES 1.0 风格，three 会转换） */
  fragment: string;
  /** 作者自己声明的 float uniform：名字 → 取值范围 */
  params: Record<string, PassParam>;
  /** 来自哪个插件；内置为 undefined */
  from?: string;
};

/** 所有 pass 都能拿到的 uniform（作者要在自己源码里声明才用得上） */
export const RESERVED_UNIFORMS = ["tDiffuse", "uResolution", "uFrame", "uFps", "uAmount"] as const;

/** 单条 `post.passes` 能引用几个 pass 的上限 */
export const MAX_PASSES = 6;

/** 单段 fragment 源码上限（字符）。8KB 足够写扫描线/水波/像素化这类效果 */
export const MAX_FRAGMENT_LEN = 8192;

const PASS_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const IDENT_RE = /^[A-Za-z_]\w*$/;

const EXTRA_PASSES = new Map<string, PassDef>();

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const trimmed = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * 校验并登记一个 pass 定义。
 *
 * 卡的都是"装了就会出事"的，不卡风格：
 *  - 只声明 `tDiffuse` 一个 sampler —— 作者能自己开 `sampler2D` 就意味着能引用任意纹理单元，
 *    而宿主没有给纹理的通道，那种代码只会渲成黑的
 *  - 禁 `#version` / `#extension` —— 版本和扩展由 three 决定，作者改了就和宿主不一致
 *  - 必须有 `gl_FragColor` —— 没有输出的 fragment 100% 是写错了（而且它会静默输出黑帧）
 */
export function registerPassDef(raw: unknown, from?: string): { ok: boolean; reason?: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "pass 定义要是对象" };
  const r = raw as Partial<PassDef> & { id?: unknown };

  const id = trimmed(r.id);
  if (!PASS_ID_RE.test(id) || id.length > 40) {
    return { ok: false, reason: `id「${id || "(空)"}」不合法：只能小写字母、数字、短横线，≤40 字` };
  }
  if (EXTRA_PASSES.has(id)) {
    return { ok: false, reason: `id「${id}」已被插件 ${EXTRA_PASSES.get(id)!.from ?? "(未知)"} 占用，换个 id` };
  }

  const fragment = typeof r.fragment === "string" ? r.fragment : "";
  if (!fragment.trim()) return { ok: false, reason: `「${id}」的 fragment 是空的` };
  if (fragment.length > MAX_FRAGMENT_LEN) {
    return { ok: false, reason: `「${id}」的 fragment 太长（${fragment.length} 字符 > ${MAX_FRAGMENT_LEN}）` };
  }
  if (/#\s*version\b/.test(fragment)) {
    return { ok: false, reason: `「${id}」里不能写 #version：版本由宿主决定，写死会和 three 的编译前缀冲突` };
  }
  if (/#\s*extension\b/.test(fragment)) {
    return { ok: false, reason: `「${id}」里不能写 #extension：扩展在宿主之间不一致，用不到就别申请` };
  }
  if (!/\bgl_FragColor\b/.test(fragment)) {
    return { ok: false, reason: `「${id}」的 fragment 里没有 gl_FragColor —— 没有输出的 shader 会静默渲成黑帧` };
  }

  // 只能声明 tDiffuse 一个 sampler：别的 sampler 宿主没有对应纹理通道，只会是黑的
  const samplers = [...fragment.matchAll(/uniform\s+(?:lowp\s+|mediump\s+|highp\s+)?sampler2D\s+(\w+)/g)].map((m) => m[1]);
  const badSampler = samplers.find((n) => n !== "tDiffuse");
  if (badSampler) {
    return {
      ok: false,
      reason: `「${id}」声明了 sampler2D ${badSampler} —— 只能声明 tDiffuse（上一段的画面），别的纹理宿主不会喂`,
    };
  }

  const paramsRaw = r.params;
  const params: Record<string, PassParam> = {};
  if (paramsRaw !== undefined && paramsRaw !== null) {
    if (typeof paramsRaw !== "object" || Array.isArray(paramsRaw)) {
      return { ok: false, reason: `「${id}」的 params 要是对象：{ 名字: { min, max, default } }` };
    }
    const entries = Object.entries(paramsRaw as Record<string, unknown>);
    if (entries.length > 8) return { ok: false, reason: `「${id}」的可调参数最多 8 个（现在 ${entries.length} 个）` };
    for (const [name, spec] of entries) {
      if (!IDENT_RE.test(name)) return { ok: false, reason: `「${id}」的参数名「${name}」不是合法的 GLSL 标识符` };
      if ((RESERVED_UNIFORMS as readonly string[]).includes(name)) {
        return { ok: false, reason: `「${id}」的参数名「${name}」和内置 uniform 重名，换一个` };
      }
      const s = spec as Partial<PassParam> | undefined;
      if (!s || typeof s !== "object") return { ok: false, reason: `「${id}」的参数 ${name} 要是 { min, max, default }` };
      if (!num(s.min) || !num(s.max) || !num(s.default)) {
        return { ok: false, reason: `「${id}」的参数 ${name} 的 min/max/default 都要是数字` };
      }
      if (s.min >= s.max) return { ok: false, reason: `「${id}」的参数 ${name} 的 min 要小于 max` };
      if (s.default < s.min || s.default > s.max) {
        return { ok: false, reason: `「${id}」的参数 ${name} 的 default 要落在 [${s.min}, ${s.max}] 内` };
      }
      params[name] = { min: s.min, max: s.max, default: s.default, ...(trimmed(s.label) ? { label: trimmed(s.label) } : {}) };
    }
  }

  EXTRA_PASSES.set(id, {
    id,
    label: trimmed(r.label) || id,
    summary: trimmed(r.summary),
    fragment,
    params,
    ...(from ? { from } : {}),
  });
  return { ok: true };
}

/** 注销（插件停用/删文件时用） */
export const unregisterPassDef = (id: string): boolean => EXTRA_PASSES.delete(String(id ?? "").trim());

/** 按 id 取定义；取不到返回 undefined（调用方决定降级方式：跳过并告警） */
export const passDefOf = (id: string): PassDef | undefined => EXTRA_PASSES.get(String(id ?? "").trim());

/** 全部可用的插件 pass（内置没有 pass，所以这就是全集） */
export const allPassDefs = (): PassDef[] => [...EXTRA_PASSES.values()];

/** 当前注册的 id 清单（错误文案里列"可用"用） */
export const allPassIds = (): string[] => [...EXTRA_PASSES.keys()];
