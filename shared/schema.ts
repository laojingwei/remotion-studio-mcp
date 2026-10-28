import { z } from "zod";
import { TRANSITION_TYPES } from "./transitions";
import { CUSTOM_EASES, EFFECT_CURVES, EFFECT_TYPES, effectParamDesc } from "./effects";
import { sceneBoxSchema } from "./sceneBox";

/* ────────────────────────────── 画幅 ────────────────────────────── */

export const formatSchema = z.object({
  key: z.string().describe("画幅标识，如 portrait / landscape"),
  label: z.string().describe("显示名，如 竖屏 9:16"),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type Format = z.infer<typeof formatSchema>;

/* ────────────────────────────── 主题 ────────────────────────────── */

export const paletteSchema = z.object({
  background: z.string().describe("背景色"),
  surface: z.string().describe("卡片/块面色"),
  text: z.string().describe("主文字色"),
  textMuted: z.string().describe("次要文字色"),
  primary: z.string().describe("主强调色"),
  secondary: z.string().describe("次强调色"),
  accent: z.string().describe("点缀色"),
});
export type Palette = z.infer<typeof paletteSchema>;

export const themeSchema = z.object({
  palette: paletteSchema,
  font: z.object({
    heading: z.string().describe("标题字体族"),
    body: z.string().describe("正文字体族"),
  }),
  radius: z.number().describe("圆角基准（unit 倍数）"),
  /**
   * 整体动效强度：0 = 完全静态（与加动效之前逐像素一致），1 = 标准，2 = 更明显。
   * 不填按 1 处理。只影响入场位移/回弹幅度与数字滚动，不改变版式与排版。
   */
  motion: z.number().min(0).max(2).optional().describe("动效强度 0=静态 / 1=标准 / 2=更强"),
});
export type Theme = z.infer<typeof themeSchema>;

/* ────────────────────────────── 音频 ────────────────────────────── */

/**
 * 音量上限（1 = 原音，>1 是数字放大）。
 *
 * 5 约等于 +14 dB —— 有些素材录得太小，只允许压到 1 就等于救不回来。
 * **上限收敛在这一个常量里**：schema 校验、ops 夹取、编辑器滑杆、MCP 参数都引用它，
 * 否则必然出现"UI 能拖到 5、落库夹回 1"这种自相矛盾。
 *
 * 放大器是线性的，源文件本身接近满刻度时放大就会削波 —— 削波判断需要读文件峰值，
 * 所以放在工具层做（`server/mcp-tools.ts`），ops 保持纯函数。
 */
export const MAX_VOLUME = 5;

/**
 * 动态增益曲线（压缩/配平的结果）：按 `stepMs` 采样的增益序列，渲染时线性插值。
 *
 * 存"增益"而不是存"响度"：渲染端不需要再分析一遍音频，直接乘上去即可。
 * 10 Hz（stepMs=100）足够跟上人耳感知的音量变化，3 分钟也只有 1800 个数。
 */
export const gainCurveSchema = z.object({
  stepMs: z.number().min(20).max(1000).default(100),
  values: z.array(z.number().min(0).max(MAX_VOLUME)),
  /** 生成这条曲线时用的目标响度（LUFS），便于回读与复算 */
  targetLufs: z.number().optional(),
  /** 压缩比：1 = 不压，越大越平（仅用于回读说明） */
  ratio: z.number().optional(),
});
export type GainCurve = z.infer<typeof gainCurveSchema>;

/**
 * 一条音效轨（叠加在背景音乐之上）。
 * 与 `Project.audio`（背景音乐，从头铺到尾）不同，音效有自己的起点，
 * 适合放转场音、提示音、口播点缀。
 */
export const audioClipSchema = z.object({
  id: z.string(),
  src: z.string().describe("音频地址，一般是 /assets/xxx"),
  name: z.string().default("音效"),
  /** 从第几帧开始（画面时间轴，不是音频内部时间） */
  from: z.number().int().min(0).default(0),
  volume: z.number().min(0).max(MAX_VOLUME).default(1).describe("音量，1 = 原音，可到 5（+14 dB）"),
  /** 开头淡入秒数 */
  fadeIn: z.number().min(0).default(0),
  /** 在时间轴上的长度（帧）；不传表示播放到素材结束 */
  durationInFrames: z.number().int().min(1).optional(),
  /** 动态增益曲线（compress_audio 生成），与 volume 相乘 */
  gainCurve: gainCurveSchema.optional(),
});
export type AudioClip = z.infer<typeof audioClipSchema>;

/**
 * 人声避让（ducking）配置：有人说话时把 BGM 压下去。
 * 存在 project.audio.ducking 上；不配 = 不避让。
 */
export const duckingSchema = z.object({
  enabled: z.boolean().default(true),
  /** 人声期间 BGM 降到原音量的倍数，0.3 = 降到 30% */
  depth: z.number().min(0).max(1).default(0.3),
  attackMs: z.number().min(0).max(2000).default(120).describe("压下去用多久（毫秒）"),
  releaseMs: z.number().min(0).max(3000).default(260).describe("升回来用多久（毫秒）"),
  padMs: z.number().min(0).max(1000).default(60).describe("人声区间前后各留的余量（毫秒）"),
});
export type DuckingConfig = z.infer<typeof duckingSchema>;

/**
 * 节拍网格：只存 BPM + 首拍偏移，拍点由 `shared/audio.ts#beatTimes` 现算。
 * 存死每一拍会带来两个问题：改 BPM 后对不齐、数据随片长膨胀。
 */
export const beatGridSchema = z.object({
  bpm: z.number().min(20).max(300),
  /** 第一拍相对片头的秒数，可为负（第一拍在片头之前） */
  offsetSec: z.number().default(0),
  source: z.enum(["auto", "manual"]).default("manual"),
  /** auto 时记录分析的是哪个音频 */
  src: z.string().optional(),
  /** auto 时的检测置信度（essentia，>2.5 可信） */
  confidence: z.number().optional(),
});
export type BeatGrid = z.infer<typeof beatGridSchema>;

/**
 * 自定义特效的一个关键帧。`p` 是区间内进度 0→1（不是帧号），换时长时动画自动拉伸。
 *
 * 所有通道都是可选的，缺省 = 中性值（位移 0、缩放 1、不透明度 1、滤镜 1/0）。
 * 数值范围故意留得比内置特效宽一些 —— agent 想做出更狠的效果不该被我们卡死，
 * 但也必须挡住 9999 这类会把画面彻底糊掉、或者让 CSS 变成非法的值。
 */
export const customKeySchema = z.object({
  p: z.number().min(0).max(1).describe("区间内进度 0→1"),
  ease: z.enum(CUSTOM_EASES).optional().describe("进入这个关键帧的缓动，默认 linear"),
  x: z.number().min(-200).max(200).optional().describe("横向位移，画面宽度的百分比"),
  y: z.number().min(-200).max(200).optional().describe("纵向位移，画面高度的百分比"),
  scale: z.number().min(0).max(8).optional().describe("缩放，1 = 原样"),
  rotate: z.number().min(-1080).max(1080).optional().describe("旋转角度"),
  skewX: z.number().min(-45).max(45).optional().describe("斜切角度"),
  opacity: z.number().min(0).max(1).optional().describe("整幅画面不透明度"),
  blur: z.number().min(0).max(120).optional().describe("模糊半径 px"),
  brightness: z.number().min(0).max(6).optional().describe("亮度，1 = 原样"),
  contrast: z.number().min(0).max(6).optional().describe("对比度，1 = 原样"),
  saturate: z.number().min(0).max(8).optional().describe("饱和度，1 = 原样"),
  grayscale: z.number().min(0).max(1).optional().describe("去色 0..1"),
  hueRotate: z.number().min(-360).max(360).optional().describe("色相旋转角度"),
  overlay: z.string().optional().describe("覆盖层颜色 hex；不写则沿用前一个关键帧的颜色"),
  overlayOpacity: z.number().min(0).max(1).optional().describe("覆盖层不透明度"),
  overlayBlend: z.string().max(40).optional().describe("覆盖层混合模式，如 screen/overlay/multiply"),
});

/** 自定义特效：一串关键帧（不必排序，求值时按 p 排好） */
export const customEffectSchema = z.object({
  keys: z.array(customKeySchema).min(1).max(32).describe("关键帧 1~32 个"),
  note: z.string().max(200).optional().describe("说明，给人和 agent 看，不参与渲染"),
});

/**
 * 一条特效轨（叠加在**整幅画面**上的区间特效）。
 * 定义与样式纯函数都在 `shared/effects.ts`；这里只做落库校验。
 */
export const effectClipSchema = z
  .object({
    id: z.string(),
    kind: z.enum(EFFECT_TYPES).describe("特效类型"),
    name: z.string().default("特效"),
    /** 从第几帧开始（画面时间轴） */
    from: z.number().int().min(0).default(0),
    durationInFrames: z.number().int().min(1).default(24),
    /** 0..1 强度 */
    intensity: z.number().min(0).max(1).default(1),
    /** 覆盖层颜色（仅闪白/扫光/暗角这类有覆盖层的类型有意义），hex */
    color: z.string().optional(),
    /**
     * 内置特效的可调参数（键见 `EFFECT_PARAMS`）。
     * **缺省 = 用该类型的默认值**，所以老工程不写这个字段时逐帧不变。
     * 不认识的键只当没写（渲染按默认值走）；但**值超范围直接报错**——
     * 悄悄夹到边界会让 agent 以为设置生效了，实际看到的却是另一个数。
     */
    params: z.record(z.number().min(-1000).max(1000)).optional(),
    /** 进度曲线（先快后慢之类），默认 linear */
    curve: z.enum(EFFECT_CURVES).optional(),
    /**
     * 循环播放：在 `durationInFrames` 区间内按「单次循环时长」反复播放效果。
     * 典型用法：给长片挂一条 durationInFrames 很大的暗角/呼吸，
     * loop 开着，单次循环 90 帧，loopStopAfterSeconds 30 —— 循环 30 秒后效果自动完全退出。
     */
    loop: z.boolean().optional(),
    /** 单次循环多少帧（不传 = 用该类型的 defaultDuration；下限 4 防止频闪失控） */
    loopDurationInFrames: z.number().int().min(4).max(3000).optional(),
    /** 循环到多少秒自动停止（停止后效果完全退出，不保留残影）；不传 = 循环到区间结束 */
    loopStopAfterSeconds: z.number().min(0.1).max(3600).optional(),
    /** 只有 kind === "custom" 时有效：agent 传进来的关键帧定义 */
    custom: customEffectSchema.optional(),
  })
  .superRefine((clip, ctx) => {
    // custom 没定义 = 一条什么都不做的特效，接口报成功但画面没反应，最难查
    if (clip.kind === "custom" && !clip.custom?.keys?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "自定义特效必须带 custom.keys（关键帧），否则不会有任何效果",
        path: ["custom"],
      });
    }
    // 参数范围不卡死整批 op，只在超出声明范围时忽略该键（渲染时按默认值走）
    for (const [k, v] of Object.entries(clip.params ?? {})) {
      const d = effectParamDesc(clip.kind, k);
      if (d && (v < d.min || v > d.max)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `参数 ${k}=${v} 超出范围（${d.min}~${d.max}），请改成合法值`,
          path: ["params", k],
        });
      }
    }
  });
export type EffectClip = z.infer<typeof effectClipSchema>;

/* ────────────────────────────── 场景 ────────────────────────────── */

export const transitionSchema = z.object({
  type: z.enum(TRANSITION_TYPES),
  durationInFrames: z.number().int().min(0),
});
export type Transition = z.infer<typeof transitionSchema>;

/**
 * 元素相对模板基线的偏移。
 *
 * 刻意**不用绝对坐标**：模板是自动排版的（flex + 安全区 + 朝向分支），
 * 一旦把元素钉死成 px，竖屏调好的位置到横屏就全错，多画幅同源当场失效。
 * 所以只记偏移量，而且 x / y 用**画面尺寸的百分比**，换画幅时同比例缩放。
 */
export const transformSchema = z.object({
  x: z.number().default(0).describe("水平偏移，画面宽度的百分比"),
  y: z.number().default(0).describe("垂直偏移，画面高度的百分比"),
  rotate: z.number().default(0).describe("旋转角度（度）"),
  scale: z.number().default(1).describe("缩放倍数"),
  /**
   * 图层顺序。0 为模板默认层，数字越大越靠上。
   * 只影响同一场景内元素相互遮挡时的绘制顺序，不影响模板排版。
   */
  z: z.number().default(0).describe("图层顺序，越大越靠前"),
});
export type Transform = z.infer<typeof transformSchema>;

/* ────────────────────────────── 自由元素 ────────────────────────────── */

/**
 * 场景之上的一层自由元素（贴纸 / 图标 / 文字标签 / 图片）。
 *
 * 与模板元素的差别：
 *  - 模板元素"跟着排版走"，只记偏移；自由元素是**绝对定位**，坐标直接是百分比
 *  - 所以它天然支持任意画幅（x/y/size 都是相对量），也能跨模板复用
 */
export const elementSchema = z.object({
  id: z.string(),
  kind: z.enum(["svg", "text", "image", "video", "audio"]),
  name: z.string().describe("图层名，方便人和 agent 指认"),
  /** 中心点位置，按画面宽高百分比 */
  x: z.number().default(50),
  y: z.number().default(50),
  /** svg/image 是宽度，text 是字号；都按**短边**百分比，换画幅不会变形 */
  size: z.number().default(10),
  rotate: z.number().default(0),
  scale: z.number().default(1),
  opacity: z.number().min(0).max(1).default(1),
  z: z.number().int().min(0).default(0).describe("场景内层级，越大越靠前；自由元素整体位于模板之上"),
  fill: z.string().default("#F4F1EA"),

  /* svg */
  svg: z.string().optional().describe('SVG 内部标记，如 <path d="…"/>'),
  viewBox: z.string().default("0 0 24 24"),
  stroke: z.boolean().default(false).describe("true 用描边画（线稿图标），false 用填充"),
  strokeWidth: z.number().default(2),

  /* text */
  text: z.string().optional(),
  weight: z.number().int().min(100).max(900).default(700),
  bg: z.string().optional().describe("文字底色，做胶囊标签用（也可传 linear-gradient(...)）"),

  /* ── 通用外观（所有元素可用，按短边百分比） ── */
  radius: z.number().min(0).optional().describe("圆角（短边百分比，如 2 = 短边 2%）"),
  border: z.number().min(0).optional().describe("边框宽度（短边百分比）"),
  borderColor: z.string().optional().describe("边框颜色，默认用 fill"),
  shadow: z.string().optional().describe("CSS box-shadow，如 0 8px 30px rgba(0,0,0,.4)"),
  filter: z.string().optional().describe("CSS filter，如 blur(2px) brightness(1.1)"),
  blendMode: z.string().optional().describe("mix-blend-mode：normal/multiply/screen/overlay/difference…"),
  clipPath: z.string().optional().describe("CSS clip-path，做异形裁切，如 circle(50%)"),
  fit: z.enum(["cover", "contain", "fill"]).optional().describe("图片/视频填充方式，默认 cover"),

  /* ── 文字排版 ── */
  fontFamily: z.string().optional().describe("字体族，默认雅黑"),
  lineHeight: z.number().optional().describe("行高倍数，默认 1.15"),
  letterSpacing: z.number().optional().describe("字间距（em），默认 0.02"),
  textAlign: z.enum(["left", "center", "right"]).optional().describe("文字对齐"),
  fontStyle: z.enum(["normal", "italic"]).optional().describe("斜体"),
  underline: z.boolean().optional().describe("下划线"),
  maxWidth: z.number().optional().describe("文字最大宽度（短边百分比），自动换行"),
  strokeLinecap: z.enum(["butt", "round", "square"]).optional(),
  strokeLinejoin: z.enum(["miter", "round", "bevel"]).optional(),
  /** 任意 CSS 内联样式（camelCase 键），最后应用，可覆盖上面所有预设 */
  style: z
    .record(z.union([z.string(), z.number()]))
    .optional()
    .describe("自定义内联样式（camelCase），如 { textShadow: '0 0 20px #0ff', transform: 'skew(-8deg)' }"),

  /* image / video */
  src: z.string().optional(),
  /* video */
  /**
   * 是否静音。**按类型给默认值**（见 ops.withElementDefaults）：
   * 视频默认静音（避免和背景音乐打架），音频默认出声。
   * 早先这里写死 default(true)，结果所有音频元素都被静音成 0——
   * 渲染出来连音轨都不生成，而且零报错。
   */
  muted: z.boolean().default(false).describe("是否静音；视频创建时默认 true，音频默认 false"),
  loop: z.boolean().default(true),
  startFrom: z.number().int().min(0).default(0).describe("从素材第几帧开始播（视频/音频通用：跳过文件开头，如旁白前的空白）"),
  /** 场景内音频元素（如 TTS 语音）的音量 */
  audioVolume: z.number().min(0).max(MAX_VOLUME).default(1).describe("音频元素音量，1 = 原音，可到 5"),
  /** 时间轴上的"小眼睛"：隐藏后画面里不显示（可再点开） */
  hidden: z.boolean().default(false).describe("是否隐藏"),
  aspect: z.number().positive().optional().describe("视频宽高比 w/h，用来算高度"),

  libraryId: z.string().optional().describe("来源素材 id，便于追溯"),

  /** 入场特效（元素开始后 durationInFrames 帧内播放） */
  enter: transitionSchema.optional(),
  /** 出场特效（在元素结束前 durationInFrames 帧内反向播放） */
  exit: transitionSchema.optional(),
  /** 在**所属场景**时间轴上的起点（帧，相对场景开头） */
  from: z.number().int().min(0).default(0).describe("场景内起点（帧）"),
  /** 在场景时间轴上的时长（帧）；不传表示到场景结尾 */
  durationInFrames: z
    .number()
    .int()
    .refine((n) => n === -1 || n >= 1, { message: "时长至少 1 帧；传 -1 表示撑到场景结尾" })
    .optional()
    .describe("场景内时长（帧）；-1 = 撑到场景结尾"),
});
export type OverlayElement = z.infer<typeof elementSchema>;

/** 字幕样式（单拎出来：ops 写入时要按它校验，导出前也要能单独验） */
export const subtitleStyleSchema = z.object({
  fontSize: z.number().optional().describe("字号（短边百分比，默认 2.6）"),
  color: z.string().optional().describe("文字颜色"),
  bg: z.string().optional().describe("字幕底色（CSS 色值/渐变，默认 #000）"),
  bgOpacity: z.number().min(0).max(1).optional().describe("底色透明度，默认 0.55"),
  bottom: z.number().optional().describe("距底部（短边百分比，默认 6.5）"),
  bold: z.number().optional().describe("字重 100-900，默认 600（注意：不是布尔）"),
  stroke: z.number().optional().describe("描边宽度（短边百分比）"),
  strokeColor: z.string().optional().describe("描边颜色"),
  shadow: z.string().optional().describe("文字阴影 CSS"),
  lineHeight: z.number().optional(),
  letterSpacing: z.number().optional().describe("字间距 em"),
  align: z.enum(["left", "center", "right"]).optional(),
  maxWidth: z.number().optional().describe("最大宽度（画面%），默认 86"),
  css: z
    .record(z.union([z.string(), z.number()]))
    .optional()
    .describe("自定义内联样式（camelCase），最后应用"),
});

export const sceneSchema = z.object({
  id: z.string(),
  type: z.string().describe("场景类型 key"),
  name: z.string().describe("时间轴上显示的名字"),
  durationInFrames: z.number().int().min(1).describe("停留时长（帧）"),
  /**
   * 绝对起始帧。**不填 = 接在同轨上一块之后**（等价旧版的时长累加），
   * 填了才把这一幕钉在这个时间点 —— 这是画中画 / 并置 / 留白的唯一来源。
   */
  start: z.number().int().min(0).optional().describe("绝对起始帧；不填=接在上一块后面"),
  /** 轨道号，0 = 主轨。多条轨道可以同时出现（画中画、并置） */
  track: z.number().int().min(0).optional().describe("轨道号，0=主轨"),
  /** 画面框：缩成小窗摆放（画中画）；不填 = 全屏 */
  box: sceneBoxSchema.optional().describe("画面框（画中画）：位置/缩放/圆角"),
  /**
   * 字幕文本（可选）。一行一句，导出 SRT 时按字数比例分配这一幕内的时长。
   * 留空则导出时用 caption 场景的正文。
   */
  subtitle: z.string().optional().describe("字幕文本，一行一句"),
  transitionIn: transitionSchema.optional(),
  /** 出场转场：在场景结束前反向播放 */
  transitionOut: transitionSchema.optional(),
  /** 元素 id → 偏移量；没有条目就走模板原始排版 */
  transforms: z.record(transformSchema).optional(),
  /** 场景之上的自由元素层（贴纸 / 图标 / 标签 / 图片 / 视频），各有场景内起点/时长 */
  elements: z.array(elementSchema).optional(),
  props: z.record(z.any()).describe("场景业务数据，由场景 schema 约束"),
  /** 字幕样式（按场景覆盖；不传用默认：底部居中黑底白字） */
  subtitleStyle: subtitleStyleSchema.optional(),
});


export type Scene = z.infer<typeof sceneSchema>;

/* ────────────────────────────── 工程 ────────────────────────────── */

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  rev: z.number().int().describe("乐观锁 + 增量同步锚点"),
  fps: z.number().int().default(30),
  formats: z.array(formatSchema).min(1),
  theme: themeSchema,
  audio: z
    .object({
      src: z.string(),
      volume: z.number().min(0).max(MAX_VOLUME).default(1).describe("音量，1 = 原音，可到 5"),
      fadeIn: z.number().min(0).default(0),
      fadeOut: z.number().min(0).default(0),
      /** 从第几帧开始播（画面时间轴），默认 0 */
      from: z.number().int().min(0).default(0),
      /** 播放长度（帧）；不传表示从 from 一直播到片尾 */
      durationInFrames: z.number().int().min(1).optional(),
      /** 播到素材结尾后循环 */
      loop: z.boolean().default(false),
      /**
       * 人声避让：有人说话时把 BGM 压下去。
       * 默认深度 0.3（人声期间 BGM 30%）、attack 120ms / release 260ms。
       * 不配 = 不避让（旧工程行为逐像素不变）。
       */
      ducking: duckingSchema.optional(),
      /** 动态增益曲线（compress_audio 生成），与 volume 相乘 */
      gainCurve: gainCurveSchema.optional(),
    })
    .optional(),
  /** 音效轨（叠加在背景音乐之上，各自有起点） */
  audioTracks: z.array(audioClipSchema).optional(),
  /**
   * 节拍网格：由 analyze_audio（自动测）或 set_beat_grid（用户给 BPM）写入。
   * 存 BPM + 偏移而不是存死每一拍 —— 改 BPM 后卡点线自动跟着变，数据也小。
   * 纯数据，渲染端不读它（对齐动作由 agent 落到转场/特效上）。
   */
  beatGrid: beatGridSchema.optional(),
  /** 特效轨：区间叠加在整幅画面上（闪白/震动/冲击/模糊/暗角） */
  effects: z.array(effectClipSchema).optional(),
  /**
   * @deprecated 仅用于读取 v0.23 的旧数据；读到后由 migrateOverlaysToScenes 迁回 scene.elements。
   * 新写入永远不再产生这个字段。
   */
  overlays: z.array(elementSchema).optional(),
  scenes: z.array(sceneSchema),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof projectSchema>;

/**
 * v0.23 的旧数据迁移：元素一度被提到 `project.overlays`（工程级、from 是全局帧）。
 * 现在归属回到场景，这里按 from 找到所属场景、换算成场景内时间再放回去。
 * 原地修改并返回是否有变化。
 */
export function migrateOverlaysToScenes(project: Project): boolean {
  const overlays = project.overlays;
  if (!overlays?.length) {
    if (overlays) delete project.overlays;
    return false;
  }
  const offsets = sceneOffsets(project.scenes);
  for (const el of [...overlays].sort((a, b) => (a.from ?? 0) - (b.from ?? 0))) {
    const from = el.from ?? 0;
    let idx = project.scenes.findIndex(
      (s, i) => from >= offsets[i] && from < offsets[i] + s.durationInFrames,
    );
    if (idx < 0) idx = project.scenes.length - 1;
    const scene = project.scenes[idx];
    if (!scene) continue;
    const localFrom = Math.min(
      Math.max(0, scene.durationInFrames - 1),
      Math.max(0, from - offsets[idx]),
    );
    const localDur = Math.max(
      1,
      Math.min(el.durationInFrames ?? scene.durationInFrames, scene.durationInFrames - localFrom),
    );
    scene.elements = [
      ...(scene.elements ?? []),
      { ...el, from: localFrom, durationInFrames: localDur },
    ];
  }
  delete project.overlays;
  return true;
}

/* ────────────────────────────── 工具 ────────────────────────────── */

/** 一幕在时间轴上的位置（帧） */
export type SceneSpan = {
  id: string;
  start: number;
  dur: number;
  end: number;
  track: number;
};

/**
 * 时间轴数学的**唯一入口**（渲染 / 时间轴 / 出片时长 / 字幕导出都走它）。
 *
 * 规则只有三条：
 *  1. `scene.start` 有值就用它；没值 = 接在**同一轨道**上一块的末尾（旧工程全是这种，行为完全不变）。
 *  2. 轨道号缺省 0；轨道之间互不影响，所以画中画可以落在主轨的任意时间点上。
 *  3. 总时长 = 所有块 `end` 的最大值（不再等于时长之和）。
 *
 * 纯函数、不改入参：同轨重叠这类"非法状态"由 `shared/ops.ts` 负责吸附纠正，
 * 这里只如实报告当前排布，绝不偷偷改数据（否则渲染与落库会各说一套）。
 */
export const sceneSpans = (scenes: Scene[]): SceneSpan[] => {
  /** 每条轨道"下一块从哪开始"的水位线 */
  const cursor = new Map<number, number>();
  return scenes.map((s) => {
    const track = Math.max(0, Math.round(s.track ?? 0));
    const dur = Math.max(1, Math.round(s.durationInFrames));
    const auto = cursor.get(track) ?? 0;
    const start = Math.max(0, Math.round(s.start ?? auto));
    const end = start + dur;
    cursor.set(track, end);
    return { id: s.id, start, dur, end, track };
  });
};

/** 总时长：所有轨道上最靠后的那一帧（多轨之后不再等于时长之和） */
export const totalDuration = (p: Pick<Project, "scenes">) =>
  sceneSpans(p.scenes).reduce((max, s) => Math.max(max, s.end), 0);

/** 每个场景的起始帧（薄封装，30 处老调用点不用改） */
export const sceneOffsets = (scenes: Scene[]) => sceneSpans(scenes).map((s) => s.start);

export const DEFAULT_FORMATS: Format[] = [
  { key: "portrait", label: "竖屏 9:16", width: 1080, height: 1920 },
  { key: "landscape", label: "横屏 16:9", width: 1920, height: 1080 },
];

export const DEFAULT_THEME: Theme = {
  palette: {
    background: "#0B0B10",
    surface: "#17171F",
    text: "#F4F1EA",
    textMuted: "#8C8896",
    primary: "#C6F24E",
    secondary: "#6C5CE7",
    accent: "#FF7A45",
  },
  font: {
    heading: '"Segoe UI Variable Display", "Microsoft YaHei", sans-serif',
    body: '"Microsoft YaHei", "PingFang SC", sans-serif',
  },
  radius: 2.4,
};
