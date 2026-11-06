/**
 * 3D「母题配方」—— 插件用 `scene3d/presets.json` 提供一份可复用的场景图（graph）。
 *
 * ## 为什么不做"代码插件"
 *
 * 内置的 6 个母题（orbit-core / particle-field / …）各自是一段手写组件，
 * 对应 `Scene3D.tsx` 里一条三元链。要让插件也这样加，就得把整条 3D 组合改造成
 * 可注册组件——那是这一层最高风险的动作，换来的只是"多一种内置画面的写法"。
 *
 * 而 M2 的 `graph`（场景图 DSL）本来就是「任意几何 + 材质 + 灯光 + 相机」的正规扩展面：
 * 纯数据、服务端已校验、编辑器和渲染端共用同一条渲染路径。所以这里把"母题"重新定义为
 * **一份 JSON 配方**：套用 = 把这份 graph 写进场景，之后它就是普通 graph，
 * 能继续用节点工具改。
 *
 * 一句话：插件给的不是代码，是**起点**。
 *
 * ## 为什么不进 `_plugins.generated.ts`
 *
 * 配方只在"套用那一刻"被读一次，写进工程后就与插件无关了（删了插件，画面还在）。
 * 渲染端从来不需要知道"这份 graph 来自哪个配方"，所以不必进 bundle——
 * 这比元素/风格简单，只有服务端一条通道。
 */

import { dslIssues, dslSchema, type Scene3DDsl } from "./scene3dDsl";

export type GraphPreset = {
  id: string;
  label: string;
  /** 一句话：这套图形适合讲什么（agent 靠它选） */
  summary: string;
  graph: Scene3DDsl;
  /** 来源插件 id（诊断用；内置配方为空） */
  from?: string;
};

const EXTRA = new Map<string, GraphPreset>();

const PRESET_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * 校验并登记一份配方。
 *
 * 用**和用户写入完全相同的**校验路径（`dslSchema` + `dslIssues`）：
 * 配方写错必须在这里就被拦住，而不是等 agent 套用之后渲染出半张黑屏——
 * 那时候现场已经离"哪里写错了"很远了。
 */
export function registerGraphPreset(item: unknown, source = ""): { ok: boolean; reason?: string } {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return { ok: false, reason: "配方要是一个对象 { id, label, summary, graph }" };
  }
  const p = item as Partial<GraphPreset>;
  const id = typeof p.id === "string" ? p.id.trim() : "";
  if (!PRESET_ID_RE.test(id)) {
    return { ok: false, reason: `id「${id || "(空)"}」不合法：只能小写字母、数字、短横线` };
  }
  if (!p.label || typeof p.label !== "string") return { ok: false, reason: `「${id}」缺 label` };
  if (!p.graph || typeof p.graph !== "object" || Array.isArray(p.graph)) {
    return { ok: false, reason: `「${id}」缺 graph（场景图 DSL）` };
  }

  const parsed = dslSchema.safeParse(p.graph);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path?.length ? `${first.path.join(".")}: ` : "";
    return { ok: false, reason: `「${id}」的 graph 不合 DSL：${where}${first?.message ?? "校验失败"}` };
  }
  const issues = dslIssues(parsed.data);
  if (issues.length) {
    // 只报前两条：配方作者需要知道"哪不对"，不需要一次看二十行
    return { ok: false, reason: `「${id}」的 graph 有结构问题：${issues.slice(0, 2).join("；")}` };
  }

  EXTRA.set(id, {
    id,
    label: p.label,
    summary: typeof p.summary === "string" ? p.summary : "",
    graph: parsed.data,
    ...(source ? { from: source } : {}),
  });
  return { ok: true };
}

/** 注销一份配方（插件停用/删除时用） */
export function unregisterGraphPreset(id: string): boolean {
  return EXTRA.delete(String(id ?? "").trim());
}

/** 全部配方（按 id 排序，列表稳定） */
export const allGraphPresets = (): GraphPreset[] =>
  [...EXTRA.values()].sort((a, b) => a.id.localeCompare(b.id));

export const graphPresetOf = (id: string): GraphPreset | undefined => EXTRA.get(String(id ?? "").trim());
