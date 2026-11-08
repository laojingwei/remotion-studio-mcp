/**
 * 插件场景的元信息：**用 JSON 声明字段，宿主转成 zod schema**。
 *
 * ## 为什么不让插件直接写 `SceneMeta`（TS 对象）
 *
 * `SceneMeta` 里的 `schema` 是 zod 实例，它要同时被三个消费方拿到：
 *
 *   服务端（agent 工具描述、参数校验）   —— tsx 可以动态 import TS
 *   编辑器（属性面板自动生成）           —— vite，需要静态
 *   渲染端（Remotion）                   —— webpack，需要静态
 *
 * 如果 meta 是 TS，服务端要么同步读不了（Node 没有同步 ESM），
 * 要么把 `shared/` 反向依赖到 `src/`（方向错了）。而 JSON 三端都能读：
 * 服务端 `readFileSync`，编辑器与渲染端用生成文件里的静态 import。
 *
 * 代价是插件不能自定义 zod 里那些刁钻的校验（正则、superRefine、联合类型）。
 * 这个代价是划算的：**场景 props 本来就该是"一堆标量 + 数组"**，
 * 需要复杂校验的场景很少；真需要就走内置场景。
 */

import { z } from "zod";
import type { SceneMeta } from "./sceneMetas";

/** 字段类型。第一版只支持这些——不够用再加，别一次性做全（做全了没人验证） */
export const PLUGIN_FIELD_TYPES = [
  "text", //        z.string()            单行/多行文本
  "number", //      z.number()            可带 min/max/int
  "boolean", //     z.boolean()           开关
  "enum", //        z.enum(options)       分段按钮
  "stringArray", // z.array(z.string())   字符串列表（标签、条目）
  "objectArray", // z.array(z.object())   结构化列表（表格行、明细）
] as const;

export type PluginFieldType = (typeof PLUGIN_FIELD_TYPES)[number];

export type PluginField = {
  key: string;
  type: PluginFieldType;
  /** 面板上的标签；不写就用 key（key 是英文，面板上会很难看，建议写） */
  label?: string;
  /** 默认值。**除了 optional 字段，每个字段都必须给**——否则新建场景时 props 缺字段，zod 会拒 */
  default?: unknown;
  optional?: boolean;
  /** number 用 */
  min?: number;
  max?: number;
  int?: boolean;
  /** enum 用 */
  options?: string[];
  /** stringArray 的条数上下限 */
  minItems?: number;
  maxItems?: number;
  /** objectArray 的子字段（只允许 text / number） */
  items?: PluginField[];
};

export type PluginSceneJson = {
  /** 场景 key，写进 `Scene.type`。建议 `<插件名>-<用途>`，避免和内置或别的插件撞 */
  type: string;
  name: string;
  category?: string;
  summary?: string;
  duration?: { default?: number; min?: number; max?: number };
  /** 可拖动元素（对应组件里 `<Editable id="…">`） */
  elements?: { id: string; label: string; prop?: string }[];
  /**
   * 标签：要不要让 agent 在 `list_scene_types` 里查到这个场景。
   * 插件场景**默认可见**（和内置固定版式相反）；写 false 可主动藏起来。
   */
  agentVisible?: boolean;
  fields: PluginField[];
};

export type PluginMetaParse = {
  meta: SceneMeta | null;
  issues: string[];
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** 套上 `.default()`；`optional` 的字段套 `.optional()` 且不进 defaultProps */
function withDefault(schema: z.ZodTypeAny, f: PluginField, issues: string[], where: string): z.ZodTypeAny {
  const label = f.label ?? f.key;
  // `.default()` 在 zod 里是重载方法，联合类型上 TS 认为"没有共同签名"，
  // 这里本来就是动态构建 schema，收窄没有意义，直接断言
  if (f.default !== undefined) return (schema as any).default(f.default) as z.ZodTypeAny;
  if (f.optional) return (schema as any).optional() as z.ZodTypeAny;
  issues.push(
    `${where}字段「${label}」既没有 default 也没标 optional —— ` +
      `新建这种场景时 props 会缺这个字段，zod 当场拒。请二选一`,
  );
  return schema;
}

function fieldSchema(f: PluginField, issues: string[], where: string): z.ZodTypeAny | null {
  const label = f.label ?? f.key;
  const at = `${where}字段「${label}」`;

  switch (f.type) {
    case "text":
      return withDefault(z.string().describe(label), f, issues, where);

    case "number": {
      let n = z.number();
      if (f.int) n = n.int();
      if (typeof f.min === "number") n = n.min(f.min);
      if (typeof f.max === "number") n = n.max(f.max);
      // describe 要在 checks 之后（zod 的 describe 是 ZodType 方法，位置不影响，但读起来顺）
      return withDefault(n.describe(label), f, issues, where);
    }

    case "boolean":
      return withDefault(z.boolean().describe(label), f, issues, where);

    case "enum": {
      const opts = (f.options ?? []).filter((o): o is string => typeof o === "string" && !!o);
      if (opts.length < 2) {
        issues.push(`${at}是 enum，但 options 少于 2 项（至少要能二选一）`);
        return null;
      }
      // zod 的 z.enum 要非空元组类型，运行时给数组没问题，类型上转一下
      return withDefault(z.enum(opts as [string, ...string[]]).describe(label), f, issues, where);
    }

    case "stringArray": {
      let arr = z.array(z.string());
      if (typeof f.minItems === "number") arr = arr.min(f.minItems);
      if (typeof f.maxItems === "number") arr = arr.max(f.maxItems);
      return withDefault(arr.describe(label), f, issues, where);
    }

    case "objectArray": {
      const items = f.items ?? [];
      if (!items.length) {
        issues.push(`${at}是 objectArray，但没写 items（子字段表是空的，编辑器加不出行）`);
        return null;
      }
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const sub of items) {
        if (sub.type !== "text" && sub.type !== "number" && sub.type !== "boolean") {
          issues.push(`${at} 的子字段「${sub.label ?? sub.key}」只能是 text / number / boolean，已忽略`);
          continue;
        }
        const subLabel = sub.label ?? sub.key;
        const base =
          sub.type === "number"
            ? z.number().describe(subLabel)
            : sub.type === "boolean"
              ? z.boolean().describe(subLabel)
              : z.string().describe(subLabel);
        // 子字段默认值必须给：编辑器「添加一项」会推一个空对象进去
        shape[sub.key] = sub.default !== undefined ? ((base as any).default(sub.default) as z.ZodTypeAny) : base;
      }
      let arr = z.array(z.object(shape));
      if (typeof f.minItems === "number") arr = arr.min(f.minItems);
      if (typeof f.maxItems === "number") arr = arr.max(f.maxItems);
      return withDefault(arr.describe(label), f, issues, where);
    }

    default:
      issues.push(`${at}的类型「${String(f.type)}」不支持（可用：${PLUGIN_FIELD_TYPES.join(" / ")}）`);
      return null;
  }
}

/**
 * JSON → `SceneMeta`。**永不抛错**：坏插件只该让这一个场景失效，
 * 不该让 `list_scene_types` 整个挂掉（那样用户看不到任何场景，也查不出是哪个插件坏的）。
 */
export function jsonToSceneMeta(raw: unknown, sourceId: string): PluginMetaParse {
  const issues: string[] = [];

  if (!isObj(raw)) return { meta: null, issues: ["场景定义不是 JSON 对象"] };

  const type = typeof raw.type === "string" ? raw.type.trim() : "";
  if (!type) return { meta: null, issues: ["缺 type（场景 key）"] };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(type)) {
    return { meta: null, issues: [`type「${type}」不合法：只能小写字母、数字、短横线`] };
  }

  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : type;
  const fields = Array.isArray(raw.fields) ? (raw.fields as unknown[]) : [];
  if (!fields.length) {
    return { meta: null, issues: [`「${name}」没有 fields：没有可编辑字段的场景等于一张固定图片`] };
  }

  const shape: Record<string, z.ZodTypeAny> = {};
  const defaultProps: Record<string, unknown> = {};
  const seen = new Set<string>();

  for (const rawField of fields) {
    if (!isObj(rawField)) {
      issues.push(`「${name}」的 fields 里有一项不是对象，已跳过`);
      continue;
    }
    const f = rawField as unknown as PluginField;
    if (typeof f.key !== "string" || !f.key.trim()) {
      issues.push(`「${name}」有一个字段缺 key，已跳过`);
      continue;
    }
    if (seen.has(f.key)) {
      issues.push(`「${name}」字段 key「${f.key}」重复，后一个已忽略`);
      continue;
    }
    seen.add(f.key);

    const schema = fieldSchema(f, issues, `「${name}」`);
    if (!schema) continue;
    shape[f.key] = schema;
    if (f.default !== undefined) defaultProps[f.key] = f.default;
  }

  if (!Object.keys(shape).length) {
    return { meta: null, issues: [...issues, `「${name}」没有一个合法字段`] };
  }

  const d = isObj(raw.duration) ? raw.duration : {};
  const durDefault = typeof d.default === "number" && d.default > 0 ? d.default : 120;
  const durMin = typeof d.min === "number" && d.min > 0 ? d.min : MIN_PLUGIN_FRAMES;
  const durMax = typeof d.max === "number" && d.max >= durMin ? d.max : Math.max(durDefault * 4, 600);

  const elements = Array.isArray(raw.elements)
    ? (raw.elements as unknown[])
        .filter(isObj)
        .map((e) => ({
          id: String(e.id ?? ""),
          label: String(e.label ?? e.id ?? ""),
          ...(typeof e.prop === "string" ? { prop: e.prop } : {}),
        }))
        .filter((e) => e.id)
    : undefined;

  return {
    meta: {
      type,
      name,
      category: typeof raw.category === "string" && raw.category.trim() ? raw.category.trim() : "插件",
      // 插件默认让 agent 查到；显式 false 才藏
      agentVisible: typeof raw.agentVisible === "boolean" ? raw.agentVisible : true,
      summary: typeof raw.summary === "string" ? raw.summary : `插件场景（${sourceId}）`,
      schema: z.object(shape),
      defaultProps,
      duration: { default: durDefault, min: durMin, max: durMax },
      ...(elements?.length ? { elements } : {}),
    },
    issues,
  };
}

/**
 * 插件场景的最短时长。
 *
 * 定成 15 而不是照搬内置的 `MIN_SCENE_FRAMES`：那个常量是**时间轴手柄的下限**，
 * 内置场景普遍需要 30+ 帧才看得出东西；插件场景可能就是一个数字淡入，
 * 卡在 30 帧会让"想做个 0.5 秒的字卡"变成不可能。
 */
export const MIN_PLUGIN_FRAMES = 15;
