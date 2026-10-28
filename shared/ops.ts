import {
  audioClipSchema,
  DEFAULT_THEME,
  effectClipSchema,
  elementSchema,
  sceneSpans,
  subtitleStyleSchema,
  beatGridSchema,
  duckingSchema,
  gainCurveSchema,
  MAX_VOLUME,
  type AudioClip,
  type BeatGrid,
  type DuckingConfig,
  type EffectClip,
  type GainCurve,
  type OverlayElement,
  type Project,
  type Scene,
  type Theme,
  type Transform,
  type Transition,
} from "./schema";
import { describeSceneBox, normalizeSceneBox, type SceneBox } from "./sceneBox";
import { droppedProps, getMeta, MIN_SCENE_FRAMES, normalizeProps } from "./sceneMetas";
import { effectLabel, effectSummaryText } from "./effects";
import { freeElSchema } from "./freeform";

/* ────────────────────────────── 操作定义 ────────────────────────────── */

export type AudioTrack = {
  src: string;
  volume: number;
  /** 秒 */
  fadeIn: number;
  fadeOut: number;
  /** 从第几帧开始播 */
  from?: number;
  /** 播放长度（帧），不传=播到片尾 */
  durationInFrames?: number;
  /** 循环 */
  loop?: boolean;
  /** 人声避让：有人说话时把 BGM 压下去 */
  ducking?: DuckingConfig;
  /** 动态增益曲线（压缩结果），与 volume 相乘 */
  gainCurve?: GainCurve;
};

export type Op =
  | {
      op: "add_scene";
      type: string;
      props?: Record<string, unknown>;
      /** 插入到该场景之后；不传则追加到末尾 */
      afterSceneId?: string;
      name?: string;
      durationInFrames?: number;
      /** 前端生成 id：分割场景时要立刻用新 id 做后续定位 */
      id?: string;
      /** 新场景自带的自由元素（分割时把后半段元素带过去） */
      elements?: OverlayElement[];
      /** 是否带默认淡入（分割出来的后半段用硬切） */
      transitionIn?: Transition | null;
      /** 绝对起始帧；不传 = 接在同轨上一块之后 */
      start?: number;
      /** 轨道号，0 = 主轨；画中画场景传 1+ */
      track?: number;
    }
  | {
      op: "update_scene";
      sceneId: string;
      /**
       * 只认下表中的场景级字段；本版式的文案字段既可以放在 `props` 里，
       * 也可以直接写在 patch 顶层（会被收进 props）。两处都不认识的键直接报错。
       */
      patch: {
        props?: Record<string, unknown>;
        name?: string;
        /** 字幕文本，一行一句；导出 SRT/VTT 用 */
        subtitle?: string;
        durationInFrames?: number;
        transitionIn?: Transition | null;
        transitionOut?: Transition | null;
        /** 整表替换场景元素（分割场景时把后半段元素分出去） */
        elements?: OverlayElement[];
      };
    }
  | { op: "set_scene_timing"; sceneId: string; durationInFrames: number }
  /** 设置场景字幕（一行一句，按字数比例分配幕内时长） */
  | { op: "set_subtitle"; sceneId: string; text?: string; style?: Record<string, unknown> }
  /**
   * 换场景版式（type）。
   *
   * props 按**同名 key 迁移**：新类型认识的 key 保留，不认识的丢弃，
   * 新类型 required 但迁移后缺失的用该类型的 defaultProps 补。
   * 丢弃/补上的字段都会写进 summary，不静默。
   */
  | {
      op: "set_scene_type";
      sceneId: string;
      type: string;
      /** 迁移后再覆盖的字段（优先级最高） */
      props?: Record<string, unknown>;
      /** 换版式同时改时长（省一次 update_scene） */
      durationInFrames?: number;
    }
  | {
      /** 拖动 / 旋转 / 缩放某个元素；transform 传 null 表示复位到模板位置 */
      op: "set_transform";
      sceneId: string;
      target: string;
      transform: Partial<Transform> | null;
    }
  /** 往场景的自由元素层放一个元素（贴纸 / 图标 / 文字 / 图片 / 视频） */
  | {
      op: "add_element";
      sceneId: string;
      element: Partial<OverlayElement> & { kind: OverlayElement["kind"] };
    }
  | { op: "update_element"; sceneId: string; elementId: string; patch: Partial<OverlayElement> }
  | { op: "remove_element"; sceneId: string; elementId: string }
  /** 局部更新 freeform 场景里的一个元素（按 id 或 index；不用重发整个数组） */
  | {
      op: "update_freeform_element";
      sceneId: string;
      elementId?: string;
      index?: number;
      patch: Record<string, unknown>;
    }
  /**
   * 往 freeform 场景追加一个元素（svg / fx 氛围层 / 带 anim 关键帧的元素都走这里；
   * 这些只有 freeform 通道支持，`add_element` 的叠加层放不了）。
   * element 过 freeElSchema 校验：未知字段在这里报错，不静默。上限 40 个。
   */
  | { op: "add_freeform_element"; sceneId: string; element: Record<string, unknown> }
  /** 删 freeform 元素（按 id 或 index）；只剩最后一个时报错——freeform 至少要有一个元素 */
  | { op: "remove_freeform_element"; sceneId: string; elementId?: string; index?: number }
  | { op: "reorder_scenes"; sceneIds: string[] }
  /** 主轨恢复连续排布：清掉主轨上的自定义起点，按顺序首尾相接（重排后一定要跟着发） */
  | { op: "compact_main_track" }
  | { op: "remove_scene"; sceneId: string }
  | { op: "duplicate_scene"; sceneId: string }
  /**
   * 时间轴拖动：把这一幕钉到某个绝对帧 / 某条轨道上。
   * 不传 `track` = 保持原轨道；同轨与别的块重叠会**吸附到前一块末尾**（写进 summary，不静默改）。
   */
  | { op: "move_scene"; sceneId: string; start: number; track?: number }
  /** 场景级画面框（画中画）：传 `null` 恢复全屏 */
  | { op: "set_scene_box"; sceneId: string; box: Partial<SceneBox> | null }
  | {
      op: "set_theme";
      palette?: Partial<Theme["palette"]>;
      font?: Partial<Theme["font"]>;
      radius?: number;
      /** 动效强度 0=静态 / 1=标准 / 2=更强（不传则保持不变） */
      motion?: number;
    }
  | {
      op: "set_audio";
      audio: AudioTrack | null;
    }
  /** 节拍网格（卡点）：grid = null 表示清除 */
  | { op: "set_beat_grid"; grid: BeatGrid | null }
  /** 音效轨：叠加在背景音乐之上，各自有起点 */
  | { op: "add_audio_track"; clip: Partial<AudioClip> & { src: string } }
  | { op: "update_audio_track"; trackId: string; patch: Partial<AudioClip> & { gainCurve?: GainCurve | null } }
  | { op: "remove_audio_track"; trackId: string }
  /** 特效轨：区间叠加在整幅画面上（闪白/震动/冲击/模糊/暗角），可以横跨多幕 */
  | { op: "add_effect"; clip: Partial<EffectClip> & { kind: EffectClip["kind"] } }
  | { op: "update_effect"; effectId: string; patch: Partial<EffectClip> }
  | { op: "remove_effect"; effectId: string }
  | { op: "set_formats"; formats: { key: string; label: string; width: number; height: number }[] }
  | {
      op: "update_project";
      patch: { name?: string; fps?: number };
    }
  /** 撤销/重做用：整体回滚到某个快照（只回滚内容，不回滚 rev） */
  | {
      op: "restore";
      project: Pick<
        Project,
        "scenes" | "theme" | "name" | "audio" | "audioTracks" | "effects"
      >;
      /** 历史里显示的动作名，撤销/重做传不同值 */
      label?: string;
    };

export type OpResult = {
  project: Project;
  createdSceneIds: string[];
  summary: string[];
};

const uid = (prefix: string) =>
  `${prefix}_${Math.random().toString(36).slice(2, 8)}`;

const clampDuration = (type: string, n: number) => {
  const meta = getMeta(type);
  // 下限走共享常量：时间轴手柄的下限就是它，两边一致才不会"拖到这里又被弹回去"
  const { min, max } = meta?.duration ?? { min: MIN_SCENE_FRAMES, max: 108000 };
  return Math.max(min, Math.min(max, Math.round(n)));
};

/** 夹取并告知：静默夹取会让 agent 以为设置生效（黑盒验证 N-13） */
function clampDurationWithNote(type: string, n: number, summary: string[]): number {
  const actual = clampDuration(type, n);
  if (actual !== Math.round(n)) {
    summary.push(`⚠️ 时长 ${n} 帧超出该版式允许范围，已夹到 ${actual} 帧`);
  }
  return actual;
}

/**
 * 元素默认值：**静音要按类型给**。
 *
 * 视频默认静音（避免和背景音乐打架），音频默认出声。
 * 早先 schema 里 `muted` 一律 default(true)，结果音频元素不显式传 `muted:false`
 * 就被静音成 0 —— 渲染出来连音轨都不生成，而且零报错（实测 mean_volume -90dB）。
 */
export const withElementDefaults = <T extends { kind: OverlayElement["kind"]; muted?: boolean }>(
  raw: T,
): T & { muted: boolean } => ({
  ...raw,
  muted: raw.muted ?? raw.kind === "video",
});

/* ────────────────────────────── Reducer（纯函数）────────────────────────────── */

/**
 * 同轨禁止重叠：按数组顺序扫一遍，把**钉死起点**又压到前一块身上的场景推到前一块末尾。
 *
 * 为什么只动"钉死起点"的：没写 `start` 的场景起点由前序累加得出，天然不会重叠，
 * 而且跟着前一块一起移动正是旧版（顺序播放）的行为——旧工程因此一个字节都不用改。
 * 被挤开的一定写进 summary，不允许静默改数据。
 */
const enforceTrackOrder = (scenes: Scene[], summary: string[]) => {
  const spans = sceneSpans(scenes);
  /** 轨道 → 按**时间先后**排好的块 */
  const byTrack = new Map<number, { scene: Scene; span: (typeof spans)[number] }[]>();
  scenes.forEach((scene, i) => {
    const span = spans[i];
    const list = byTrack.get(span.track) ?? [];
    list.push({ scene, span });
    byTrack.set(span.track, list);
  });
  for (const list of byTrack.values()) {
    // 按时间排，不按数组顺序：数组顺序只管"没写起点的块接在谁后面"，
    // 判重叠必须看真实时间，否则把后一块拖到前面会莫名其妙把前一块推走
    list.sort((a, b) => a.span.start - b.span.start);
    let cursor = 0;
    for (const { scene, span } of list) {
      if (scene.start !== undefined && span.start < cursor) {
        scene.start = cursor;
        summary.push(`「${scene.name}」同轨不能重叠：起点从 ${span.start} 帧吸附到 ${cursor} 帧`);
      }
      cursor = Math.max(cursor, (scene.start ?? span.start) + span.dur);
    }
  }
};

/** 把 op 内抛出的错误翻译成「第 N 个操作（op 名）：字段级原因」 */
/**
 * patch 里被 schema 剥掉的 key 必须 ⚠ 报出来 —— zod 默认 strip 未知字段，
 * 不说就是「报了成功但数据没进去」，这是最难查的一类 bug（踩坑清单第 2 轮 §1.1）。
 */
function warnDroppedKeys(
  patch: Record<string, unknown>,
  keptKeys: Set<string>,
  summary: string[],
  what: string,
): void {
  const dropped = Object.keys(patch).filter((k) => !keptKeys.has(k));
  if (dropped.length) {
    summary.push(
      `⚠ ${what}的以下字段被丢弃（不是这类元素的字段）：${dropped.join("、")}。` +
        `注意两套通道：叠加层元素（scene.elements / add_element）不支持 anim 和 fx；` +
        `它们只属于 freeform（props.elements / add_freeform_element）`,
    );
  }
}

function opFailure(err: unknown, ops: Op[], index: number): Error {
  const op = ops[index] as { op?: string };
  const name = op?.op ?? "未知";
  // 不带"失败"两个字：MCP 宿主会自己加「失败：」前缀，两边都加就成了「失败：…失败：…」
  const head = ops.length > 1 ? `第 ${index + 1}/${ops.length} 个操作（${name}）` : `操作（${name}）`;

  // ZodError：原样吐 JSON 对 agent 毫无用处（现实教训：agent 只能靠试错猜）
  const issues = (err as { issues?: unknown }).issues;
  if (Array.isArray(issues) && issues.length) {
    const lines = issues.slice(0, 4).map((raw) => describeIssue(raw as Record<string, unknown>));
    const more = issues.length > 4 ? `（另有 ${issues.length - 4} 处）` : "";
    return new Error(`${head}：${lines.join("；")}${more}`);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`${head}：${message}`);
}

/** 单条 zod issue → 人话 */
function describeIssue(issue: Record<string, unknown>): string {
  const path = Array.isArray(issue.path) ? issue.path.join(".") : "";
  const field = path || "参数";
  const code = String(issue.code ?? "");
  const received = issue.received;
  switch (code) {
    case "invalid_type":
      return received === "undefined"
        ? `缺少必填字段 ${field}`
        : `${field} 类型不对（应为 ${String(issue.expected)}，实际 ${String(received)}）`;
    case "too_big":
      return `${field} 超出范围：必须 ≤ ${String(issue.maximum)}`;
    case "too_small":
      return `${field} 超出范围：必须 ≥ ${String(issue.minimum)}`;
    case "invalid_enum_value":
    case "invalid_value":
      return `${field} 取值不合法（可选：${JSON.stringify(issue.options ?? [])}）`;
    case "invalid_union":
      return `${field} 不符合任何允许的结构`;
    default:
      return `${field}：${String(issue.message ?? code)}`;
  }
}

/**
 * 字幕样式归一 + 校验。
 *
 * `bold` 实际是**数字字重**（100–900，渲染端 `fontWeight: bold ?? 600`）：
 * 先兼容布尔（true→700 / false→400）与字符串数字，再夹到 100–900；
 * `fontWeight`（CSS 叫法）作为别名。
 * 为什么要在这里拦：样式是直接 merge 进工程数据的，写进布尔值后
 * **导出工程包成功、导入时 schema 才报错**——备份直接变砖（黑盒验证 N-02）。
 */
function normalizeSubtitleStyle(
  style: Record<string, unknown>,
  warn: (key: string) => void,
): Record<string, unknown> {
  const raw: Record<string, unknown> = { ...style };
  if (raw.fontWeight !== undefined && raw.bold === undefined) raw.bold = raw.fontWeight;
  delete raw.fontWeight;
  if (typeof raw.bold === "boolean") raw.bold = raw.bold ? 700 : 400;
  if (typeof raw.bold === "string" && /^\d+$/.test(raw.bold)) raw.bold = Number(raw.bold);
  if (typeof raw.bold === "number") raw.bold = Math.min(900, Math.max(100, Math.round(raw.bold)));
  const parsed = subtitleStyleSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(根)"}：${i.message}`)
      .join("；");
    throw new Error(`字幕样式不合法：${detail}`);
  }
  const kept = parsed.data as Record<string, unknown>;
  for (const k of Object.keys(raw)) {
    if (!(k in kept)) warn(k);
  }
  return kept;
}

/**
 * 每个 op 允许的字段白名单（与上方 `Op` 类型一一对应，新增字段时两边要同步）。
 *
 * 为什么在 reducer 入口做这道检查：TS 类型只约束编译期，运行时来自 agent / HTTP 的
 * op 是裸 JSON —— 写错的字段（如 `volume2`）以前会被**静默忽略**，agent 以为改了，
 * 实际没生效（测试清单 C1 实锤）；更糟的是字段拼错还可能让 case 里读到 undefined 崩掉
 * （`{op:"set_audio", volume2:2}` 崩在 `op.audio.ducking`）。
 * 在这里直接拒绝，报「第 N 个操作（op 名）」+ 字段名。
 */
export const OP_FIELDS: Record<string, readonly string[]> = {
  add_scene: ["op", "type", "props", "afterSceneId", "name", "durationInFrames", "id", "elements", "transitionIn", "start", "track"],
  update_scene: ["op", "sceneId", "patch"],
  set_scene_timing: ["op", "sceneId", "durationInFrames"],
  set_subtitle: ["op", "sceneId", "text", "style"],
  set_scene_type: ["op", "sceneId", "type", "props", "durationInFrames"],
  set_transform: ["op", "sceneId", "target", "transform"],
  add_element: ["op", "sceneId", "element"],
  update_element: ["op", "sceneId", "elementId", "patch"],
  remove_element: ["op", "sceneId", "elementId"],
  update_freeform_element: ["op", "sceneId", "elementId", "index", "patch"],
  add_freeform_element: ["op", "sceneId", "element"],
  remove_freeform_element: ["op", "sceneId", "elementId", "index"],
  reorder_scenes: ["op", "sceneIds"],
  compact_main_track: ["op"],
  remove_scene: ["op", "sceneId"],
  duplicate_scene: ["op", "sceneId"],
  move_scene: ["op", "sceneId", "start", "track"],
  set_scene_box: ["op", "sceneId", "box"],
  set_theme: ["op", "palette", "font", "radius", "motion"],
  set_audio: ["op", "audio"],
  set_beat_grid: ["op", "grid"],
  add_audio_track: ["op", "clip"],
  update_audio_track: ["op", "trackId", "patch"],
  remove_audio_track: ["op", "trackId"],
  add_effect: ["op", "clip"],
  update_effect: ["op", "effectId", "patch"],
  remove_effect: ["op", "effectId"],
  set_formats: ["op", "formats"],
  update_project: ["op", "patch"],
  restore: ["op", "project", "label"],
};

/** 「你是不是想写 X」：字段拼错是 agent 最常见的错法，报错带上建议能省一轮试错 */
export function closestKey(key: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = editDistance(key.toLowerCase(), c.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  // 差 1~2 个字符才提建议；差太多等于瞎猜
  return best && bestDist <= 2 ? best : undefined;
}

function editDistance(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = tmp;
    }
  }
  return prev[b.length];
}

/**
 * 未知字段报错的统一写法：说清「哪些不认识 / 为什么拒绝 / 能写什么」。
 * 只丢一句「unrecognized key」对 agent 毫无用处（它只能靠试错猜）。
 */
function unknownFieldError(
  what: string,
  unknown: string[],
  allowed: readonly string[],
  hint?: string,
): Error {
  const suggestions = unknown
    .map((k) => {
      const near = closestKey(k, allowed);
      return near ? `${k}（是不是想写 ${near}？）` : k;
    })
    .join("、");
  return new Error(
    `${what}里有不认识的字段：${suggestions}。` +
      `未知字段会被静默丢弃导致「报成功但没生效」，所以直接拒绝。` +
      (hint ? `${hint}` : `可用字段：${allowed.join("、")}`),
  );
}

/** update_scene 的 patch 里允许的「场景级」字段（其余同名 props 走 props） */
const UPDATE_SCENE_KEYS = [
  "props",
  "name",
  "subtitle",
  "durationInFrames",
  "transitionIn",
  "transitionOut",
  "elements",
] as const;

/** set_audio 的 audio 对象允许的字段（与项目 schema 的 audio 一致） */
const AUDIO_KEYS = [
  "src",
  "volume",
  "fadeIn",
  "fadeOut",
  "from",
  "durationInFrames",
  "loop",
  "ducking",
  "gainCurve",
] as const;

/** 叠加层元素的字段清单（从 schema 现取，加字段不用改这里） */
const ELEMENT_KEYS = Object.keys(elementSchema.shape);

/** 逐条检查 op 的字段是否都在白名单里；未知 op 名放行（由 switch 的 default 报错） */
function assertKnownOpFields(ops: Op[]): void {
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] as { op?: string };
    const name = op.op;
    if (!name) continue;
    const allow: readonly string[] | undefined = OP_FIELDS[name];
    if (!allow) continue;
    const unknown = Object.keys(op).filter((k) => !allow.includes(k));
    if (unknown.length) {
      const head = ops.length > 1 ? `第 ${i + 1}/${ops.length} 个操作（${op.op}）` : `操作（${op.op}）`;
      throw new Error(
        `${head}有未知字段：${unknown.join("、")}。` +
          `未知字段会被静默丢弃导致「报成功但没生效」，所以直接拒绝；` +
          `该操作允许的字段：${allow.filter((f: string) => f !== "op").join("、")}`,
      );
    }
  }
}

export function applyOps(project: Project, ops: Op[]): OpResult {
  assertKnownOpFields(ops);
  let next: Project = structuredClone(project);
  const createdSceneIds: string[] = [];
  const summary: string[] = [];

  for (let opIndex = 0; opIndex < ops.length; opIndex++) {
    const op = ops[opIndex];
    /** 写入前快照：用来断言「这条 op 真的改了东西」（见循环末尾） */
    let beforeJson = "";
    try {
    beforeJson = JSON.stringify(next);
    switch (op.op) {
      case "add_scene": {
        const meta = getMeta(op.type);
        if (!meta) throw new Error(`未知场景类型: ${op.type}`);
        const scene: Scene = {
          id: op.id ?? uid("scene"),
          type: op.type,
          name: op.name ?? meta.name,
          durationInFrames: clampDurationWithNote(op.type, op.durationInFrames ?? meta.duration.default, summary),
          props: normalizeProps(op.type, op.props ?? {}),
          ...(op.elements?.length ? { elements: op.elements } : {}),
          ...(op.transitionIn === null
            ? {}
            : { transitionIn: op.transitionIn ?? { type: "fade", durationInFrames: 12 } }),
          ...(op.start === undefined ? {} : { start: Math.max(0, Math.round(op.start)) }),
          ...(op.track === undefined || op.track <= 0 ? {} : { track: Math.round(op.track) }),
        };
        if (op.afterSceneId) {
          const idx = next.scenes.findIndex((s) => s.id === op.afterSceneId);
          if (idx === -1) throw new Error(`找不到场景: ${op.afterSceneId}`);
          next.scenes.splice(idx + 1, 0, scene);
        } else {
          next.scenes.push(scene);
        }
        createdSceneIds.push(scene.id);
        summary.push(`新增「${scene.name}」场景`);
        {
          const ignored = droppedProps(op.type, op.props ?? {});
          if (ignored.length) {
            summary.push(
              `⚠️「${meta.name}」不认识的 props 字段会被忽略：${ignored.join("、")}`,
            );
          }
        }
        break;
      }

      case "duplicate_scene": {
        const src = mustFind(next, op.sceneId);
        const copy: Scene = {
          ...structuredClone(src),
          id: uid("scene"),
          name: `${src.name} 副本`,
        };
        // 副本要跟在原块后面：继承 `start` 会和原块在时间轴上完全重合，
        // 同轨上等于"复制了个看不见的东西"。清掉让它自然接在原块末尾。
        delete copy.start;
        const idx = next.scenes.findIndex((s) => s.id === op.sceneId);
        next.scenes.splice(idx + 1, 0, copy);
        createdSceneIds.push(copy.id);
        summary.push(`复制了「${src.name}」`);
        break;
      }

      case "set_scene_type": {
        const scene = mustFind(next, op.sceneId);
        const meta = getMeta(op.type);
        if (!meta) throw new Error(`未知场景类型: ${op.type}`);
        if (scene.type === op.type) {
          // 同一类型：只做 props 覆盖，不做任何迁移
          if (op.props) {
            const ignored = droppedProps(op.type, { ...scene.props, ...op.props });
            if (ignored.length) {
              summary.push(
                `⚠️「${scene.name}」（${op.type}）不认识的 props 字段会被忽略：${ignored.join("、")}`,
              );
            }
            scene.props = normalizeProps(op.type, { ...scene.props, ...op.props });
          }
          if (op.durationInFrames !== undefined) {
            scene.durationInFrames = clampDurationWithNote(op.type, op.durationInFrames, summary);
          }
          summary.push(`「${scene.name}」的版式本来就是 ${op.type}`);
          break;
        }

        const oldType = scene.type;
        const oldProps = scene.props ?? {};
        const newShape = (meta.schema as unknown as { shape: Record<string, unknown> }).shape;
        const newKeys = new Set(Object.keys(newShape));

        // 同名 key 迁移：新类型不认识的字段会被丢弃，这里先记下来
        const dropped = Object.keys(oldProps).filter((k) => !newKeys.has(k));
        const migrated: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(oldProps)) {
          if (newKeys.has(k)) migrated[k] = v;
        }
        // 显式传入的 props 优先级最高；不认识的要告警（含数组/嵌套字段）
        if (op.props) {
          const ignored = droppedProps(op.type, { ...meta.defaultProps, ...op.props });
          if (ignored.length) {
            summary.push(
              `⚠️ ${op.type} 不认识的 props 字段会被忽略：${ignored.join("、")}`,
            );
          }
        }
        Object.assign(migrated, op.props ?? {});

        // 新类型 required 但迁移后缺失 → 用 defaultProps 兜底
        const filled: string[] = [];
        for (const [k, def] of Object.entries(meta.defaultProps)) {
          if (!(k in migrated)) {
            migrated[k] = def;
            filled.push(k);
          }
        }

        scene.type = op.type;
        scene.props = normalizeProps(op.type, migrated);
        // 时长：显式传了就用它，否则按新类型的上下限重新夹一次
        scene.durationInFrames = clampDurationWithNote(
          op.type,
          op.durationInFrames ?? scene.durationInFrames,
          summary,
        );

        summary.push(`「${scene.name}」的版式从 ${oldType} 改成 ${op.type}`);
        if (dropped.length) {
          summary.push(`⚠ ${oldType} 独有的字段被丢弃：${dropped.join("、")}（${op.type} 不认识这些 key）`);
        }
        if (filled.length) {
          summary.push(`ℹ ${op.type} 缺少的字段用默认值补上：${filled.join("、")}`);
        }
        break;
      }

      case "set_subtitle": {
        const scene = mustFind(next, op.sceneId);
        // 样式归一 + 校验：bold 是数字字重（100–900），曾因传 true/false 落库布尔值
        // → 工程包导出成功但导入时 schema 校验失败，备份变砖（黑盒验证 N-02）
        if (op.style) {
          const normalized = normalizeSubtitleStyle(op.style, (k) => {
            summary.push(`⚠️ 字幕样式丢弃了不认识的字段「${k}」`);
          });
          scene.subtitleStyle = { ...(scene.subtitleStyle ?? {}), ...normalized };
        }
        if (op.text === undefined) {
          summary.push(`更新了「${scene.name}」的字幕样式`);
          break;
        }
        const lines = op.text
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean);
        scene.subtitle = lines.join("\n");
        summary.push(
          lines.length
            ? op.style
              ? `给「${scene.name}」写了 ${lines.length} 句字幕并更新样式`
              : `给「${scene.name}」写了 ${lines.length} 句字幕`
            : `清空「${scene.name}」的字幕`,
        );
        break;
      }

      case "update_scene": {
        const scene = mustFind(next, op.sceneId);
        const meta = getMeta(scene.type);
        /** 本版式认识的 props 字段：写在 patch 顶层时自动收进 props（agent 最常这么写） */
        const propKeys = new Set(Object.keys(meta?.schema.shape ?? {}));
        const patch = (op.patch ?? {}) as Record<string, unknown>;
        const sceneLevel = UPDATE_SCENE_KEYS as readonly string[];

        /**
         * 白名单必须管到 patch 这一层（复验 N-A 的教训）：
         * `apply_ops([{op:"update_scene", patch:{title:"新标题"}}])` 以前报成功、rev 照涨、
         * 文案一个字没改；写 `patch:{subtitle}` 更糟 —— 字幕字段被当成顶层键塞进 scene。
         */
        const unknown = Object.keys(patch).filter((k) => !sceneLevel.includes(k) && !propKeys.has(k));
        if (unknown.length) {
          throw unknownFieldError("patch", unknown, [...sceneLevel, ...propKeys], 
            `「${meta?.name ?? scene.type}」的文案字段属于 props，要写 patch:{props:{…}}；` +
            `场景级字段：${sceneLevel.join("、")}；本版式 props：${[...propKeys].join("、")}。`);
        }

        const flatProps: Record<string, unknown> = {};
        for (const k of Object.keys(patch)) if (!sceneLevel.includes(k)) flatProps[k] = patch[k];
        const propsIn = patch.props;
        if (propsIn !== undefined && (typeof propsIn !== "object" || propsIn === null || Array.isArray(propsIn))) {
          throw new Error("patch.props 必须是对象（文案字段写成 patch:{props:{title:\"…\"}}）");
        }
        const propsPatch = { ...flatProps, ...((propsIn as Record<string, unknown>) ?? {}) };
        if (Object.keys(flatProps).length) {
          summary.push(
            `ℹ patch 里的 ${Object.keys(flatProps).join("、")} 按 props 处理（写进 scene.props，不是 scene 顶层）`,
          );
        }
        if ("subtitle" in patch && propKeys.has("subtitle")) {
          summary.push(
            `ℹ patch.subtitle 写的是**字幕**（scene.subtitle）；「${meta?.name}」自己的副标题文案在 props 里，` +
              `要改它请写 patch:{props:{subtitle:"…"}}`,
          );
        }
        if (Object.keys(propsPatch).length) {
          const ignored = droppedProps(scene.type, {
            ...scene.props,
            ...propsPatch,
          });
          if (ignored.length) {
            summary.push(
              `⚠️「${scene.name}」（${scene.type}）不认识的 props 字段会被忽略：${ignored.join("、")}`,
            );
          }
          scene.props = normalizeProps(scene.type, { ...scene.props, ...propsPatch });
        }
        if (patch.name !== undefined) scene.name = patch.name as string;
        if (patch.subtitle !== undefined) scene.subtitle = patch.subtitle as string;
        if (patch.durationInFrames !== undefined) {
          scene.durationInFrames = clampDurationWithNote(scene.type, patch.durationInFrames as number, summary);
        }
        if (patch.transitionIn !== undefined) {
          if (patch.transitionIn === null) delete scene.transitionIn;
          else scene.transitionIn = patch.transitionIn as Scene["transitionIn"];
        }
        if (patch.transitionOut !== undefined) {
          if (patch.transitionOut === null) delete scene.transitionOut;
          else scene.transitionOut = patch.transitionOut as Scene["transitionOut"];
        }
        if (patch.elements !== undefined) {
          const els = patch.elements as OverlayElement[];
          if (els.length) scene.elements = els;
          else delete scene.elements;
        }
        summary.push(`更新「${scene.name}」`);
        break;
      }

      case "set_transform": {
        const scene = mustFind(next, op.sceneId);
        // target 必须是真实存在的模板元素：写错参数名/传错 id 曾经静默落进 transforms["undefined"]
        if (typeof op.target !== "string" || !op.target.trim()) {
          throw new Error(
            `set_transform 缺少 target（元素 id）。模板元素 id 见该版式的可拖动元素清单；` +
              `叠加层自由元素请改用 update_element 设 x/y/scale/rotate`,
          );
        }
        if (scene.elements?.some((e) => e.id === op.target)) {
          throw new Error(
            `「${op.target}」是叠加层自由元素，不走 set_transform（那是给模板元素的）。` +
              `请用 update_element(elementId="${op.target}", ...) 设 x/y/scale/rotate`,
          );
        }
        if (scene.type === "freeform" && op.target.startsWith("fc:")) {
          throw new Error(
            `「${op.target}」是自由画布元素，不走 set_transform。请用 update_freeform_element 设 x/y/scale/rotate`,
          );
        }
        {
          const meta = getMeta(scene.type);
          const valid = new Set<string>();
          for (const el of meta?.elements ?? []) {
            if (el.id.includes("{n}")) {
              // 模式元素（如 item{n}）：item1、item2… 都合法
              const base = el.id.replace("{n}", "");
              for (let i = 1; i <= 12; i++) valid.add(`${base}${i}`);
            } else {
              valid.add(el.id);
            }
          }
          // 版式组件会给子元素注册更细的 Editable id（如 title.text），同样合法
          const known =
            valid.has(op.target) ||
            [...valid].some((v) => op.target.startsWith(`${v}.`));
          if (valid.size && !known) {
            throw new Error(
              `「${scene.name}」（${scene.type}）没有元素「${op.target}」。` +
                `可用的有：${[...valid].slice(0, 10).join("、")}（子元素写法如 ${[...valid][0] ?? "title"}.text）`,
            );
          }
        }
        if (op.transform === null) {
          // 传 null 表示"回到模板原位"
          if (scene.transforms) {
            delete scene.transforms[op.target];
            if (!Object.keys(scene.transforms).length) delete scene.transforms;
          }
          summary.push(`复位「${scene.name}」的元素`);
          break;
        }
        const prev = scene.transforms?.[op.target] ?? { x: 0, y: 0, rotate: 0, scale: 1, z: 0 };
        const merged = { ...prev, ...op.transform };
        // 全零等于没改，别在数据里留垃圾
        const isIdentity =
          Math.abs(merged.x) < 0.01 &&
          Math.abs(merged.y) < 0.01 &&
          Math.abs(merged.rotate) < 0.01 &&
          Math.abs(merged.scale - 1) < 0.01 &&
          Math.abs(merged.z ?? 0) < 0.01;
        if (isIdentity) {
          if (scene.transforms) {
            delete scene.transforms[op.target];
            if (!Object.keys(scene.transforms).length) delete scene.transforms;
          }
        } else {
          scene.transforms = { ...(scene.transforms ?? {}), [op.target]: merged };
        }
        summary.push(
          Object.keys(op.transform).length === 1 && "z" in op.transform
            ? `调整「${scene.name}」元素的图层顺序`
            : `调整「${scene.name}」元素的位移/旋转`,
        );
        break;
      }

      case "add_element": {
        const scene = mustFind(next, op.sceneId);
        const rawEl = op.element as unknown as Record<string, unknown>;
        /**
         * 元素对象也要校验（复验 N-C）：`{kind:"text", text:"探针", opacty:0.5}` 以前一路成功——
         * 拼错的键被 zod strip 掉，回执还显示放好了，agent 以为写进去了。
         */
        const unknownEl = Object.keys(rawEl).filter((k) => !ELEMENT_KEYS.includes(k));
        if (unknownEl.length) {
          throw unknownFieldError("element", unknownEl, ELEMENT_KEYS,
            `可用字段：${ELEMENT_KEYS.join("、")}；anim / fx 只属于 freeform，请用 add_freeform_element`);
        }
        /** 文字元素没起名就用文案本身当图层名，免得时间轴上全是「元素」 */
        const autoName =
          typeof rawEl.text === "string" && rawEl.text.trim()
            ? String(rawEl.text).trim().slice(0, 16)
            : "元素";
        const el = elementSchema.parse(
          withElementDefaults({
            from: 0,
            durationInFrames: scene.durationInFrames,
            ...op.element,
            id: op.element.id ?? uid("el"),
            name: op.element.name ?? autoName,
          }),
        );
        // 场景内时间：起点不能越界，时长不能超出场景结尾
        const from = Math.min(Math.max(0, el.from), Math.max(0, scene.durationInFrames - 1));
        // -1（或 "fill"）= 一直撑到场景结尾；不传也按场景结尾；正数才是"出现多久"
        const wantDur =
          el.durationInFrames === -1
            ? scene.durationInFrames - from
            : (el.durationInFrames ?? scene.durationInFrames);
        const duration = Math.max(1, Math.min(wantDur, scene.durationInFrames - from));
        scene.elements = [...(scene.elements ?? []), { ...el, from, durationInFrames: duration }];
        summary.push(`在「${scene.name}」放了${el.kind === "text" ? "文字" : "元素"}「${el.name}」`);
        // 截断必须说出来：否则接口报「成功」，回读却发现时长被改小，极难排查
        if (duration < wantDur) {
          summary.push(
            `⚠ 元素「${el.name}」时长被截断：${wantDur} → ${duration} 帧` +
              `（场景只有 ${scene.durationInFrames} 帧，起点 ${from}）。` +
              `先 set_scene_timing 定幕长再放元素，或拉长场景后重新设置时长`,
          );
        }
        break;
      }

      case "update_element": {
        const scene = mustFind(next, op.sceneId);
        const list = scene.elements ?? [];
        const idx = list.findIndex((e) => e.id === op.elementId);
        if (idx < 0) throw new Error(`找不到元素: ${op.elementId}`);
        // 逐字段合并后再过一遍 schema，保证范围（opacity 0-1、z 非负）不会越界
        const merged = elementSchema.parse({ ...list[idx], ...op.patch, id: list[idx].id });
        // 场景内时间：起点/时长不能超出场景边界
        const from = Math.min(Math.max(0, merged.from), Math.max(0, scene.durationInFrames - 1));
        const wantDur =
          merged.durationInFrames === -1
            ? scene.durationInFrames - from
            : (merged.durationInFrames ?? scene.durationInFrames);
        const duration = Math.max(1, Math.min(wantDur, scene.durationInFrames - from));
        list[idx] = { ...merged, from, durationInFrames: duration };
        scene.elements = list;
        const zOnly = Object.keys(op.patch).length === 1 && "z" in op.patch;
        summary.push(zOnly ? `调整「${merged.name}」的图层` : `调整元素「${merged.name}」`);
        // anim / kind=fx 这类塞给叠加层元素会被 zod 剥掉，必须说出来
        warnDroppedKeys(
          op.patch as Record<string, unknown>,
          new Set(Object.keys(merged)),
          summary,
          `元素「${merged.name}」`,
        );
        // 同上：截断要说出来。踩坑清单 §2.4 记的就是这条——报「成功」但不生效
        if (duration < wantDur) {
          summary.push(
            `⚠ 元素「${merged.name}」时长被截断：${wantDur} → ${duration} 帧` +
              `（场景只有 ${scene.durationInFrames} 帧，起点 ${from}）。` +
              `先 set_scene_timing 定幕长再改元素时长，或拉长场景后重新设置`,
          );
        }
        break;
      }

      case "update_freeform_element": {
        const scene = mustFind(next, op.sceneId);
        const props = (scene.props ?? {}) as { elements?: Record<string, unknown>[] };
        const list = Array.isArray(props.elements) ? props.elements : [];
        const idx =
          op.elementId !== undefined
            ? list.findIndex((e) => e["id"] === op.elementId)
            : (op.index ?? -1);
        if (idx < 0 || idx >= list.length) {
          throw new Error(
            op.elementId ? `freeform 里没有元素 ${op.elementId}` : `freeform 元素下标越界：${op.index}`,
          );
        }
        // patch 先过 strict partial：不认识的字段直接报错（改了个不生效的字段，
        // 比静默丢弃更糟——踩坑清单第 2 轮 §1.1 的教训）
        const checked = freeElSchema.strict().partial().safeParse(op.patch);
        if (!checked.success) {
          const issues = checked.error.issues as { code?: string; message: string }[];
          const unknownIssue = issues.find((i) => i.code === "unrecognized_keys");
          if (unknownIssue) {
            throw new Error(
              `update_freeform_element 的 patch 有不认识的字段：${unknownIssue.message}`,
            );
          }
          throw new Error(`update_freeform_element 的 patch 不合法：${describeIssue(issues[0] as never)}`);
        }
        list[idx] = { ...list[idx], ...checked.data };
        scene.props = { ...props, elements: list } as never;
        summary.push(`更新了「${scene.name}」的自由画布元素 #${idx + 1}`);
        break;
      }

      case "remove_element": {
        const scene = mustFind(next, op.sceneId);
        const list = scene.elements ?? [];
        const target = list.find((e) => e.id === op.elementId);
        if (!target) throw new Error(`找不到元素: ${op.elementId}`);
        const rest = list.filter((e) => e.id !== op.elementId);
        if (rest.length) scene.elements = rest;
        else delete scene.elements;
        summary.push(`删除了「${scene.name}」里的「${target.name}」`);
        break;
      }

      // 注意：这里曾有一个重复的 case "set_transform"（同名死代码，永不可达），已删除。
      // 改 set_transform 的行为请只改上面那个 case，并确认 switch 里没有重名。

      case "add_freeform_element": {
        const scene = mustFind(next, op.sceneId);
        if (scene.type !== "freeform") {
          throw new Error(
            `「${scene.name}」是 ${scene.type} 版式，只有 freeform 支持 props.elements。` +
              `先用 set_scene_type 换成 freeform，或者用 add_element 放叠加层元素`,
          );
        }
        const props = (scene.props ?? {}) as { elements?: Record<string, unknown>[] };
        const list = Array.isArray(props.elements) ? [...props.elements] : [];
        if (list.length >= 40) {
          throw new Error(`「${scene.name}」的 freeform 元素已到上限 40 个，删掉一些再加`);
        }
        // 过一遍 schema（strict）：未知字段在这里就报错，不静默、不落库
        const parsed = freeElSchema.strict().safeParse(op.element);
        if (!parsed.success) {
          const issues = parsed.error.issues as { code?: string; message: string }[];
          const unknownIssue = issues.find((i) => i.code === "unrecognized_keys");
          if (unknownIssue) {
            throw new Error(
              `add_freeform_element 的 element 有不认识的字段：${unknownIssue.message}` +
                `（可用字段见 freeElSchema：type/text/svg/viewBox/x/y/size/from/anim/kind…）`,
            );
          }
          throw new Error(
            `add_freeform_element 的 element 不合法：${describeIssue(issues[0] as never)}`,
          );
        }
        const el = parsed.data as { id?: string };
        // 不传 id 就自动编一个不冲突的 f0/f1/f2…
        if (!el.id) {
          const used = new Set(list.map((e) => String((e as { id?: string }).id ?? "")));
          let n = list.length;
          while (used.has(`f${n}`)) n++;
          el.id = `f${n}`;
        }
        if (list.some((e) => (e as { id?: string }).id === el.id)) {
          throw new Error(`freeform 里已有元素 ${el.id}，换一个 id 或用 update_freeform_element 改它`);
        }
        list.push(el as unknown as Record<string, unknown>);
        scene.props = { ...props, elements: list } as never;
        summary.push(`往「${scene.name}」加了 freeform 元素 ${el.id}`);
        break;
      }

      case "remove_freeform_element": {
        const scene = mustFind(next, op.sceneId);
        const props = (scene.props ?? {}) as { elements?: Record<string, unknown>[] };
        const list = Array.isArray(props.elements) ? props.elements : [];
        const idx =
          op.elementId !== undefined
            ? list.findIndex((e) => (e as { id?: string }).id === op.elementId)
            : (op.index ?? -1);
        if (idx < 0 || idx >= list.length) {
          throw new Error(
            op.elementId ? `freeform 里没有元素 ${op.elementId}` : `freeform 元素下标越界：${op.index}`,
          );
        }
        if (list.length <= 1) {
          throw new Error(
            `「${scene.name}」只剩最后一个 freeform 元素了（freeform 至少要有一个）。` +
              `要清空画面请用 set_scene_type 换成别的版式`,
          );
        }
        const [gone] = list.splice(idx, 1);
        scene.props = { ...props, elements: list } as never;
        summary.push(
          `删了「${scene.name}」的 freeform 元素 ${op.elementId ?? `#${idx + 1}`}` +
            `（剩余 ${list.length} 个）`,
        );
        void gone;
        break;
      }

      case "set_scene_timing": {
        const scene = mustFind(next, op.sceneId);
        const before = scene.durationInFrames;
        scene.durationInFrames = clampDurationWithNote(scene.type, op.durationInFrames, summary);
        summary.push(`「${scene.name}」时长改为 ${scene.durationInFrames} 帧`);
        // 变长后可能压到同轨后面那一块：自动起点会跟着走，钉死起点的要被推开
        if (scene.durationInFrames > before) enforceTrackOrder(next.scenes, summary);
        break;
      }

      case "move_scene": {
        const scene = mustFind(next, op.sceneId);
        const track = Math.max(0, Math.round(op.track ?? scene.track ?? 0));
        const want = Math.max(0, Math.round(op.start));
        const dur = scene.durationInFrames;

        /** 试算"把这一幕放到 v 帧"之后的整份排布 */
        const trial = (v: number) =>
          sceneSpans(next.scenes.map((s) => (s.id === scene.id ? { ...s, start: v, track } : s)));
        /** 任意轨道上有没有两块相交 */
        const overlapping = (v: number) => {
          const spans = trial(v);
          const byTrack = new Map<number, typeof spans>();
          for (const sp of spans) {
            const list = byTrack.get(sp.track) ?? [];
            list.push(sp);
            byTrack.set(sp.track, list);
          }
          for (const list of byTrack.values()) {
            list.sort((a, b) => a.start - b.start);
            for (let i = 1; i < list.length; i++) {
              if (list[i].start < list[i - 1].end) return true;
            }
          }
          return false;
        };

        // 同轨禁止重叠：被撞到就往后推，直到不撞（**推自己**，不是推别人 —— 拖的是它）
        let start = want;
        for (let guard = 0; guard < 64 && overlapping(start); guard++) {
          const spans = trial(start);
          const me = spans.find((s) => s.id === scene.id)!;
          const clash = spans.filter(
            (s) => s.id !== scene.id && s.track === track && s.start < me.start + dur && s.end > me.start,
          );
          const nextStart = clash.length ? Math.max(...clash.map((s) => s.end)) : start + 1;
          if (nextStart <= start) break;
          start = nextStart;
          if (start > 1e7) break;
        }

        scene.start = start;
        if (track > 0) scene.track = track;
        else delete scene.track;
        summary.push(
          `「${scene.name}」放到第 ${start} 帧${track > 0 ? `（轨道 ${track}）` : ""}` +
            (start === want
              ? ""
              : `；⚠️ 同轨不能重叠，原本要放的 ${want} 帧被吸附到 ${start} 帧`),
        );
        enforceTrackOrder(next.scenes, summary);
        break;
      }

      case "set_scene_box": {
        const scene = mustFind(next, op.sceneId);
        // 只有显式 null 才恢复全屏；缺字段不再静默当重置（批量 op 少写字段曾把画中画吃掉）
        if (op.box === undefined) {
          throw new Error(
            `set_scene_box 缺少 box（给 {x,y,scale,...} 设置画面框；恢复全屏请显式传 box:null）`,
          );
        }
        if (op.box === null) {
          delete scene.box;
          summary.push(`「${scene.name}」恢复全屏`);
          break;
        }
        if (!Object.keys(op.box).length) {
          throw new Error(`set_scene_box 的 box 是空对象：没有任何要改的字段（恢复全屏请传 box:null）`);
        }
        scene.box = normalizeSceneBox({ ...(scene.box ?? {}), ...op.box });
        // 夹取要告知（否则 agent 以为 2 倍缩放生效了）
        for (const [k, lo, hi] of [
          ["scale", 0.05, 1],
          ["x", 0, 100],
          ["y", 0, 100],
        ] as const) {
          const want = op.box[k];
          const got = scene.box[k];
          if (typeof want === "number" && typeof got === "number" && Math.abs(got - want) > 0.001) {
            summary.push(`⚠️ ${k} ${want} 超出 ${lo}–${hi}，已夹到 ${got}`);
          }
        }
        const desc = describeSceneBox(scene.box);
        summary.push(desc ? `「${scene.name}」画面框：${desc}` : `「${scene.name}」恢复全屏`);
        break;
      }

      case "compact_main_track": {
        let cleared = 0;
        for (const s of next.scenes) {
          if ((s.track ?? 0) === 0 && s.start !== undefined) {
            delete s.start;
            cleared++;
          }
        }
        summary.push(
          cleared
            ? `主轨恢复连续排布（${cleared} 幕的自定义起点被清掉，从第 0 帧开始）`
            : "主轨本来就是连续的",
        );
        break;
      }

      case "reorder_scenes": {
        const map = new Map(next.scenes.map((s) => [s.id, s]));
        const ordered = op.sceneIds.map((id) => {
          const s = map.get(id);
          if (!s) throw new Error(`找不到场景: ${id}`);
          map.delete(id);
          return s;
        });
        // 未列出的场景保持原顺序追加，避免误删
        next.scenes = [...ordered, ...next.scenes.filter((s) => map.has(s.id))];
        {
          // 顺序变了但时间不一定变：钉死起点的块停在原处，得说清楚，否则"拖了没反应"像 bug
          const pinned = next.scenes.filter((s) => s.start !== undefined).length;
          summary.push(
            pinned
              ? `调整了场景顺序（其中 ${pinned} 幕有自定义起点，时间位置不变；要挪时间用 move_scene）`
              : "调整了场景顺序",
          );
        }
        break;
      }

      case "remove_scene": {
        const scene = mustFind(next, op.sceneId);
        next.scenes = next.scenes.filter((s) => s.id !== op.sceneId);
        summary.push(`删除「${scene.name}」`);
        break;
      }

      case "set_theme": {
        next.theme = {
          palette: { ...next.theme.palette, ...(op.palette ?? {}) },
          font: { ...next.theme.font, ...(op.font ?? {}) },
          radius: op.radius ?? next.theme.radius,
          ...(op.motion === undefined ? { motion: next.theme.motion } : { motion: op.motion }),
        };
        // undefined 存进 JSON 会变成缺失，这里统一清掉，免得落盘出现 "motion": null
        if (next.theme.motion === undefined) delete next.theme.motion;
        summary.push(
          op.motion === undefined
            ? "更新了主题"
            : `更新了主题（动效强度 ${op.motion === 0 ? "关闭" : op.motion === 1 ? "标准" : "更强"}）`,
        );
        break;
      }

      case "set_audio": {
        if (op.audio === undefined) {
          // 以前这里会读 op.audio.ducking 直接崩（测试清单 C1：{op:"set_audio", volume2:2}）；
          // 现在缺字段显式报错——注意与 audio:null（清除）区分
          throw new Error(
            "缺少 audio 字段：设置背景音乐传 audio:{src, volume, ...}，清除传 audio:null",
          );
        }
        if (op.audio === null) {
          next.audio = undefined;
          summary.push("移除了音频");
        } else {
          const raw = op.audio as unknown as Record<string, unknown>;
          /**
           * audio 里的字段名也要校验（复验 N-B）：`{src, volume2:2}` 以前会一路静默下去——
           * volume 变成 NaN 落库成 null、gainCurve 被抹掉，回执还照打「已更新音频」。
           */
          const unknownKeys = Object.keys(raw).filter(
            (k) => !(AUDIO_KEYS as readonly string[]).includes(k),
          );
          if (unknownKeys.length) {
            throw unknownFieldError("audio", unknownKeys, AUDIO_KEYS,
              `可用字段：${AUDIO_KEYS.join("、")}（只传要改的字段即可，其余沿用现有配置；` +
                `想清掉避让/压缩曲线就显式传 ducking:null / gainCurve:null）`);
          }
          const prev = next.audio;
          const src = typeof raw.src === "string" && raw.src.trim() ? raw.src : prev?.src;
          if (!src) throw new Error("audio 缺少 src（背景音乐地址，如 /assets/bgm.mp3）");
          /** 只传要改的字段：其余沿用现有配置，避免「改音量顺手把避让和曲线打回默认」 */
          const num = (v: unknown, fallback: number): number =>
            typeof v === "number" && Number.isFinite(v) ? v : fallback;
          const srcChanged = !!prev && prev.src !== src;
          const duck =
            raw.ducking === null
              ? undefined
              : raw.ducking === undefined
                ? srcChanged
                  ? undefined
                  : prev?.ducking
                : duckingSchema.parse(raw.ducking);
          let curve: GainCurve | undefined;
          if (raw.gainCurve === null) curve = undefined;
          else if (raw.gainCurve === undefined) curve = srcChanged ? undefined : prev?.gainCurve;
          else curve = gainCurveSchema.parse(raw.gainCurve);
          const dur = raw.durationInFrames;
          next.audio = {
            src,
            // 上限走共享常量 MAX_VOLUME：>1 是放大，救特别小的素材全靠它
            volume: Math.max(0, Math.min(MAX_VOLUME, num(raw.volume, prev?.volume ?? 1))),
            fadeIn: Math.max(0, num(raw.fadeIn, prev?.fadeIn ?? 0)),
            fadeOut: Math.max(0, num(raw.fadeOut, prev?.fadeOut ?? 0)),
            from: Math.max(0, Math.round(num(raw.from, prev?.from ?? 0))),
            ...(dur === null
              ? // 显式 null = 清掉「只播一段」，回到「播到片尾」
                {}
              : typeof dur === "number" && Number.isFinite(dur) && Math.round(dur) >= 1
                ? { durationInFrames: Math.round(dur) }
                : !srcChanged && prev?.durationInFrames
                  ? { durationInFrames: prev.durationInFrames }
                  : {}),
            loop: raw.loop === undefined ? !!prev?.loop : !!raw.loop,
            ...(duck ? { ducking: duck } : {}),
            ...(curve ? { gainCurve: curve } : {}),
          };
          if (srcChanged && prev && (prev.gainCurve || prev.ducking)) {
            const lost = [prev.gainCurve ? "压缩曲线" : "", prev.ducking ? "人声避让" : ""].filter(Boolean);
            summary.push(
              `⚠ 换了音频文件，原有的${lost.join("、")}没有带过来（它们是按旧素材算的）；` +
                `需要就重新跑 compress_audio / set_audio 的 ducking`,
            );
          }
          const vol = next.audio.volume;
          const volNote = vol > 1.001 ? `放大到 ${Math.round(vol * 100)}%` : `音量 ${Math.round(vol * 100)}%`;
          summary.push(
            `更新了音频（${volNote}` +
              (duck ? `，人声避让${duck.enabled ? `降到 ${Math.round(duck.depth * 100)}%` : "已关闭"}` : "") +
              (curve ? `，动态增益 ${curve.values.length} 点` : "") +
              "）",
          );
        }
        break;
      }

      case "set_beat_grid": {
        if (!op.grid) {
          delete next.beatGrid;
          summary.push("清除了节拍网格");
          break;
        }
        const grid = beatGridSchema.parse(op.grid);
        next.beatGrid = grid;
        summary.push(
          `节拍网格：${grid.bpm} BPM（${grid.source === "auto" ? `自动检测，置信度 ${grid.confidence ?? "?"}` : "手动指定"}）` +
            `，首拍 ${grid.offsetSec.toFixed(2)}s`,
        );
        break;
      }

      case "add_audio_track": {
        const clip = audioClipSchema.parse({
          ...op.clip,
          id: op.clip.id ?? uid("au"),
        });
        next.audioTracks = [...(next.audioTracks ?? []), clip];
        summary.push(`新增音效「${clip.name}」`);
        break;
      }

      case "update_audio_track": {
        const list = next.audioTracks ?? [];
        const idx = list.findIndex((t) => t.id === op.trackId);
        if (idx < 0) throw new Error(`找不到音轨: ${op.trackId}`);
        // 合并后再过 schema，volume 0-5、from >= 0 这类约束不会被野值突破
        const { gainCurve: rawCurve, ...rest } = op.patch;
        const merged = audioClipSchema.parse({ ...list[idx], ...rest, id: list[idx].id });
        // 传 null = 显式清除曲线（清空动态压缩），与"没传=保持现状"区分开
        if (rawCurve === null) delete merged.gainCurve;
        else if (rawCurve) merged.gainCurve = gainCurveSchema.parse(rawCurve);
        list[idx] = merged;
        next.audioTracks = list;
        summary.push(`调整音效「${merged.name}」`);
        break;
      }

      case "remove_audio_track": {
        const list = next.audioTracks ?? [];
        const target = list.find((t) => t.id === op.trackId);
        if (!target) throw new Error(`找不到音轨: ${op.trackId}`);
        const rest = list.filter((t) => t.id !== op.trackId);
        if (rest.length) next.audioTracks = rest;
        else delete next.audioTracks;
        summary.push(`删除了音效「${target.name}」`);
        break;
      }

      case "add_effect": {
        const kind = op.clip.kind;
        const raw: Record<string, unknown> = {
          ...op.clip,
          name: op.clip.name ?? effectLabel(kind),
          id: op.clip.id ?? uid("fx"),
        };
        // 自定义关键帧只对 kind=custom 有意义；其它类型带着它 = 脏数据
        if (kind !== "custom") delete raw.custom;
        const clip = effectClipSchema.parse(raw);
        next.effects = [...(next.effects ?? []), clip];
        summary.push(`新增特效「${clip.name}」：${effectSummaryText(clip)}；第 ${clip.from} 帧起 ${clip.durationInFrames} 帧`);
        break;
      }

      case "update_effect": {
        const list = next.effects ?? [];
        const idx = list.findIndex((t) => t.id === op.effectId);
        if (idx < 0) throw new Error(`找不到特效: ${op.effectId}`);
        const prev = list[idx];
        const kindChanged = !!op.patch.kind && op.patch.kind !== prev.kind;
        const raw: Record<string, unknown> = { ...prev, ...op.patch, id: prev.id };
        /**
         * `params` 是**按键合并**，不是整体替换：
         * 面板一次只改一个滑杆，整体替换会把其它参数悄悄丢回默认值。
         * 想清空某个参数就显式传它的默认值（或 null 由调用方自己 remove）。
         */
        if (op.patch.params) {
          raw.params = { ...(prev.params ?? {}), ...op.patch.params };
        }
        // 切到内置类型时，自定义关键帧必须丢掉 —— 但**不能静默**（记忆里的铁律）：
        if (kindChanged && op.patch.kind !== "custom" && prev.kind === "custom") {
          delete raw.custom;
          summary.push("（换回内置类型，原自定义关键帧已丢弃）");
        }
        if (kindChanged && op.patch.kind !== "custom" && op.patch.custom) {
          delete raw.custom;
          summary.push("（内置类型不使用 custom 关键帧，已忽略）");
        }
        // 换类型时名字要跟着改（否则会出现"名字叫闪白、其实是震动"的旧数据）；
        // 但用户自己改过的名字要保留 —— 只有"名字等于旧类型默认名"才自动改名
        const merged = effectClipSchema.parse(raw);
        if (kindChanged && op.patch.name === undefined) {
          if (!merged.name || merged.name === effectLabel(prev.kind)) {
            merged.name = effectLabel(merged.kind);
          }
        }
        list[idx] = merged;
        next.effects = list;
        summary.push(
          kindChanged
            ? `特效改成「${merged.name}」（${effectSummaryText(merged)}）`
            : `调整特效「${merged.name}」：${effectSummaryText(merged)}`,
        );
        break;
      }

      case "remove_effect": {
        const list = next.effects ?? [];
        const target = list.find((t) => t.id === op.effectId);
        if (!target) throw new Error(`找不到特效: ${op.effectId}`);
        const rest = list.filter((t) => t.id !== op.effectId);
        if (rest.length) next.effects = rest;
        else delete next.effects;
        summary.push(`删除了特效「${target.name}」`);
        break;
      }

      case "set_formats": {
        if (!op.formats.length) throw new Error("至少保留一种画幅");
        const seen = new Set<string>();
        next.formats = op.formats
          .filter((f) => {
            if (seen.has(f.key)) return false;
            seen.add(f.key);
            return true;
          })
          .map((f) => ({
            key: f.key,
            label: f.label,
            width: Math.max(16, Math.round(f.width)),
            height: Math.max(16, Math.round(f.height)),
          }));
        summary.push(`画幅改为 ${next.formats.map((f) => f.key).join(" / ")}`);
        break;
      }

      case "update_project": {
        if (op.patch.name !== undefined) next.name = op.patch.name;
        if (op.patch.fps !== undefined) next.fps = Math.max(1, Math.round(op.patch.fps));
        summary.push("更新了工程信息");
        break;
      }

      case "restore": {
        next.scenes = structuredClone(op.project.scenes);
        next.theme = structuredClone(op.project.theme);
        next.name = op.project.name;
        next.audio = op.project.audio ? structuredClone(op.project.audio) : undefined;
        next.audioTracks = op.project.audioTracks ? structuredClone(op.project.audioTracks) : undefined;
        // 特效也要回滚：漏掉它的话「加特效 / 改参数」永远撤销不了。
        // 但 **没有 effects 字段 = 老版本客户端的内存快照**（它们不知道有特效这回事），
        // 这时候必须原样保留 —— 否则在老标签页里按一次 Ctrl+Z 就会把用户的特效删光。
        // 明确给了 effects: [] 才是"当时确实没有特效"。
        if (op.project.effects) {
          if (op.project.effects.length) next.effects = structuredClone(op.project.effects);
          else delete next.effects;
        }
        summary.push(op.label ?? "撤销了上一步修改");
        break;
      }

      default: {
        const _exhaustive: never = op;
        throw new Error(`不支持的操作: ${JSON.stringify(_exhaustive)}`);
      }
    }
    } catch (err) {
      // 整批原子：这里必须抛出去，调用方不会落盘（不会出现改了一半的工程）
      throw opFailure(err, ops, opIndex);
    }

    /**
     * 「报成功但没生效」做成一条可自动断言的性质（复验建议 5.2）：
     * 数据前后完全一致就说明这条 op 白跑了。逐个字段去测漏得太多——
     * update_scene 写错层级、add_element 字段拼错、值本来就等于目标，全都能被这一条抓住。
     * 不抛错（幂等重试本来就是合法的），但必须说出来，不能让它静默通过。
     */
    if (JSON.stringify(next) === beforeJson) {
      const head = ops.length > 1 ? `第 ${opIndex + 1}/${ops.length} 个操作（${op.op}）` : `操作（${op.op}）`;
      summary.push(
        `⚠️${head}没有产生任何数据变更：写入前后工程完全相同。` +
          `常见原因：字段名拼错、字段层级写错（文案在 props 里，不在 scene 顶层）、` +
          `或目标值本来就等于当前值（重试同一条 op 会这样）`,
      );
    }
  }

  next.rev = project.rev + 1;
  next.updatedAt = new Date().toISOString();
  return { project: next, createdSceneIds, summary };
}

function mustFind(p: Project, sceneId: string): Scene {
  const s = p.scenes.find((x) => x.id === sceneId);
  if (!s) throw new Error(`找不到场景: ${sceneId}`);
  return s;
}

/* ────────────────────────────── 种子工程 ────────────────────────────── */

export function createSeedProject(id?: string): Project {
  // 不传 id 就生成新的：默认值绝对不能是 "demo"，否则「新建项目」会静默覆盖示例工程
  // （真踩过：从模板建工程后 demo 被 660 帧的模板内容顶掉了）
  const projectId = id ?? `p_${Math.random().toString(36).slice(2, 8)}`;
  const mk = (
    type: string,
    durationInFrames?: number,
    props: Record<string, unknown> = {},
  ): Scene => {
    const meta = getMeta(type)!;
    return {
      id: uid("scene"),
      type,
      name: meta.name,
      durationInFrames: durationInFrames ?? meta.duration.default,
      props: normalizeProps(type, props),
      transitionIn: { type: "fade", durationInFrames: 12 },
    };
  };

  return {
    id: projectId,
    name: "未命名项目",
    rev: 1,
    fps: 30,
    formats: [
      // 新建工程默认只给横屏；竖屏/方形按需在「画幅 ＋」里加
      { key: "landscape", label: "横屏 16:9", width: 1920, height: 1080 },
    ],
    theme: DEFAULT_THEME,
    scenes: [
      mk("title", 105, {
        eyebrow: "REMOTION × AGENT",
        title: "一支会自己长大的动画",
        subtitle: "agent 起草，你来精修，画面实时同步",
        highlight: "动画",
      }),
      mk("bullets", 165),
      mk("chart", 150),
      mk("quote", 120),
      mk("outro", 120),
    ],
    updatedAt: new Date().toISOString(),
  };
}
