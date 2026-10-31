/**
 * 场景元素归一化：审计眼里「这一幕有哪些元素」只应该有一个答案。
 *
 * 为什么必须有这一层：
 * 自由画布（freeform）的元素存在 `scene.props.elements` 里，叠加层元素存在 `scene.elements` 里。
 * 而契约体检（brief-audit）与设计锁（designLock.lockViolations）历史上一律只读后者 ——
 * 结果是**自由画布工程的文本体检、字号/元素数体检全部空转**：
 * p_4l45u9 的 8 幕共 95 个元素全在 props 里，顶层只有 1 个 fx，
 * 于是「画面里明明写着 370」被判漏字，「巨字太大」也永远没人报。
 *
 * 归一口径：props 里的先（它们才是画面主体），叠加层在后（贴纸/画中画压在上面）。
 */

/** 审计与设计锁共用的最小元素视图（字段名沿用 LooseElement 的叫法） */
export type AuditElement = {
  /** 归一化类型：text / svg / shape / image / video / fx（叠加层元素自带 kind） */
  kind?: string;
  type?: string;
  name?: string;
  /** 短边百分比：文字是字号，形状/图片是宽度 —— 与设计锁的 titleSizePct 同一单位 */
  size?: number;
  text?: string;
};

const KIND_OF_TYPE: Record<string, string> = {
  text: "text",
  svg: "svg",
  shape: "shape",
  image: "image",
  video: "video",
  fx: "fx",
};

/** 把单个元素映射成审计视图；拿不到类型就返回 null（不猜） */
function toAuditElement(el: unknown): AuditElement | null {
  if (!el || typeof el !== "object") return null;
  const e = el as Record<string, unknown>;
  const rawType = typeof e.type === "string" ? e.type : undefined;
  const rawKind = typeof e.kind === "string" ? e.kind : undefined;
  const kind = rawKind ?? (rawType ? KIND_OF_TYPE[rawType] : undefined);
  const text = typeof e.text === "string" ? e.text : undefined;
  const size = typeof e.size === "number" ? e.size : undefined;
  const name =
    (typeof e.name === "string" && e.name) ||
    (typeof e.id === "string" && e.id) ||
    // freeform 元素常常没名字：用文本首段当名字，装饰层判定（isDecorative）也靠它
    (text ? text.slice(0, 12) : undefined);
  return { kind, type: rawType ?? rawKind, name, size, text };
}

export type SceneLike = {
  id?: string;
  name?: string;
  type?: string;
  durationInFrames?: number;
  subtitle?: string;
  transitionIn?: { type?: string; durationInFrames?: number } | null;
  transitionOut?: { type?: string; durationInFrames?: number } | null;
  props?: { elements?: unknown } | null;
  elements?: unknown;
};

/** 这一幕的审计元素：props.elements（自由画布）+ elements（叠加层），顺序固定 */
export function sceneAuditElements(scene: SceneLike): AuditElement[] {
  const out: AuditElement[] = [];
  const propsEls = scene.props && Array.isArray(scene.props.elements) ? scene.props.elements : [];
  for (const el of propsEls) {
    const a = toAuditElement(el);
    if (a) out.push(a);
  }
  const overlay = Array.isArray(scene.elements) ? scene.elements : [];
  for (const el of overlay) {
    const a = toAuditElement(el);
    if (a) out.push(a);
  }
  return out;
}

/** 规范化后的场景视图：设计锁与契约体检都吃这一份 */
export function sceneAuditView(scene: SceneLike) {
  return {
    id: scene.id,
    name: scene.name,
    type: scene.type,
    durationInFrames: scene.durationInFrames,
    subtitle: scene.subtitle,
    transitionIn: scene.transitionIn ?? null,
    transitionOut: scene.transitionOut ?? null,
    elements: sceneAuditElements(scene),
  };
}
