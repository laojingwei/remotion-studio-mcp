/**
 * 插件工具的入参声明 → zod。
 *
 * ## 为什么不让插件直接写 zod
 *
 * 直觉写法是插件 `import { z } from "zod"` 然后给 `shape`。但插件是被 esbuild **打包**成
 * 单文件再执行的，它会带进**自己那份 zod 实例**；而宿主的 `mcp-tool 注册`（MCP SDK 内部）
 * 与 `validateToolArgs` 认的是宿主这份。两份 zod 的 `instanceof` 对不上，
 * 结果是 schema 转不出来 / 参数校验静默失效 —— 最难查的那类问题。
 *
 * 所以沿用插件场景的做法（`shared/pluginSceneMeta.ts`）：**插件只声明数据**，
 * 宿主用自己那份 zod 建 schema。代价是不支持 refine / union 这类复杂校验，
 * 工具参数本来就该是标量 + 数组，这笔账划算。
 */

import { z } from "zod";

export const PARAM_TYPES = ["string", "number", "boolean", "enum", "stringArray"] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

export type ParamSpec = {
  type: ParamType;
  /** 给 agent 看的说明。**不写等于让 agent 猜**，实测参数错误一半来自这里 */
  desc?: string;
  /** 必填。缺省 = 可选（比"必填但没写"安全：宁可少填也不要 zod 当场拒） */
  required?: boolean;
  default?: string | number | boolean | string[];
  /** type=enum 时的候选值 */
  values?: string[];
  min?: number;
  max?: number;
};

/**
 * 参数名的规则：字母开头，只含字母/数字/下划线。
 *
 * **必须允许驼峰**（`projectId` / `dryRun`）——宿主自己的工具有一半是这么写的，
 * 插件作者第一反应就是照抄；拦掉它等于让每个插件作者先撞一次墙。
 */
const PARAM_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const MAX_PARAMS = 20;

/**
 * 把一组参数声明转成 zod shape。
 *
 * 返回 `{ shape, issues }`：**issues 非空就不该注册这个工具**。
 * 不让它"尽量注册"是因为参数错误的工具比没有这个工具更糟——
 * agent 会一直试，每次报错都长得像它自己写错了。
 */
export function buildParamShape(params: unknown): {
  shape: Record<string, z.ZodTypeAny>;
  issues: string[];
} {
  const issues: string[] = [];
  const shape: Record<string, z.ZodTypeAny> = {};
  if (params === undefined || params === null) return { shape, issues };
  if (typeof params !== "object" || Array.isArray(params)) {
    return { shape, issues: ["params 必须是对象：{ 参数名: { type, desc, ... } }"] };
  }

  const entries = Object.entries(params as Record<string, unknown>);
  if (entries.length > MAX_PARAMS) {
    issues.push(`参数 ${entries.length} 个，超过上限 ${MAX_PARAMS} —— 参数太多的工具 agent 学不会，拆成两个`);
  }

  for (const [key, raw] of entries.slice(0, MAX_PARAMS)) {
    if (!PARAM_NAME_RE.test(key)) {
      issues.push(`参数名「${key}」不合法：要字母开头，只含字母/数字/下划线（驼峰可以，如 projectId）`);
      continue;
    }
    if (!raw || typeof raw !== "object") {
      issues.push(`参数「${key}」的声明必须是对象（如 { type: "string", desc: "..." }）`);
      continue;
    }
    const spec = raw as ParamSpec;
    if (!(PARAM_TYPES as readonly string[]).includes(String(spec.type))) {
      issues.push(`参数「${key}」的 type 不支持：${String(spec.type)}（可用：${PARAM_TYPES.join(" / ")}）`);
      continue;
    }

    let base: z.ZodTypeAny;
    switch (spec.type) {
      case "string":
        base = z.string();
        break;
      case "number": {
        let n = z.number();
        if (typeof spec.min === "number") n = n.min(spec.min);
        if (typeof spec.max === "number") n = n.max(spec.max);
        base = n;
        break;
      }
      case "boolean":
        base = z.boolean();
        break;
      case "stringArray":
        base = z.array(z.string());
        break;
      case "enum": {
        const values = (spec.values ?? []).filter((v): v is string => typeof v === "string" && !!v.trim());
        if (values.length < 2) {
          issues.push(`参数「${key}」是 enum，但 values 少于两个 —— 一选一的枚举该写成 boolean 或 string`);
          continue;
        }
        base = z.enum(values as [string, ...string[]]);
        break;
      }
      default:
        continue;
    }

    // `.strict()` 由宿主注册时统一加（见 mcp-tools 的 z.object(def.shape).strict()）
    if (spec.desc) base = base.describe(spec.desc);
    if (spec.default !== undefined) {
      base = base.default(spec.default as never);
    } else if (!spec.required) {
      base = base.optional();
    }
    shape[key] = base;
  }

  return { shape, issues };
}
