/**
 * TTS provider 插件：让插件去适配各家厂商。
 *
 * ## 为什么必须开放
 *
 * 内置实现只有一条路：OpenAI 兼容协议 + 一个 `customBody` 模板占位。
 * 现实里每家的鉴权、请求体、响应体、分片规则都不一样（有的要签名、有的要先换 token、
 * 有的把音频塞进 JSON 的 base64、有的要轮询任务）。**靠模板拼是拼不出来的**，
 * 拼到最后就是"支持某一家、其它家都不行"。
 *
 * 所以把"文字 → 音频"这一步整个交给插件，宿主只保留它该管的部分：
 * 落盘、格式校验、响度归一到 -16 LUFS、时长探测、字幕时间轴对齐。
 *
 * ## 契约（插件入口导出 `ttsProviders`）
 *
 * ```ts
 * export const ttsProviders = {
 *   "volc-tts": {
 *     meta: {
 *       label: "火山引擎",
 *       configFields: [{ key: "appid", required: true }, { key: "token", secret: true, required: true }],
 *     },
 *     voices: (config) => [{ id: "zh_female_1", label: "晓晓" }],
 *     synthesize: async ({ text, voice, speed, format, config, signal }) => {
 *       // 任意协议、任意鉴权都行——适配厂商是插件的事
 *       return { audio: new Uint8Array(await res.arrayBuffer()), contentType: "audio/mpeg" };
 *     },
 *   },
 * };
 * ```
 *
 * 也可以返回 `{ file: "/abs/path.mp3" }`（插件自己落盘，比如 CLI 型 TTS）。
 *
 * ## 宿主兜的三件事（都不限制表达力）
 *
 * 1. **超时**（`signal` 会给到插件，另外宿主自己还有一道 race 兜底——插件忽略 signal 也杀得掉）
 * 2. **产物校验**：大小上限 + 按 magic bytes 认真是音频，不是 HTML 错误页
 * 3. **不静默回退**：插件报错就报错。悄悄换回内置 provider 会让"配错了但出片了"
 *    变成最难查的坑。
 */

import fs from "node:fs";
import { activePlugins } from "./discovery";
import { loadPluginEntry, resolvePluginEntry } from "./entry";

export type TtsConfigField = {
  key: string;
  label?: string;
  /** 密钥类：写进日志/回执时要打码 */
  secret?: boolean;
  required?: boolean;
  hint?: string;
};

export type TtsProviderMeta = {
  label?: string;
  hint?: string;
  /** 这个 provider 需要哪些配置项（编辑器/工具据此渲染表单） */
  configFields?: TtsConfigField[];
};

export type TtsProviderVoice = { id: string; label?: string; language?: string };

export type TtsSynthRequest = {
  text: string;
  voice: string;
  speed: number;
  format: string;
  instruct?: string;
  language?: string;
  /** 该 provider 自己的配置（来自 tts-config.json 的 providers[id]） */
  config: Record<string, string>;
  /** 宿主会在超时/取消时 abort 它——请透传给 fetch */
  signal: AbortSignal;
};

export type TtsProviderModule = {
  meta?: TtsProviderMeta;
  voices?: (config: Record<string, string>) => Promise<TtsProviderVoice[]> | TtsProviderVoice[];
  synthesize: (
    req: TtsSynthRequest,
  ) => Promise<{ audio: Uint8Array | ArrayBuffer; contentType?: string } | { file: string }>;
};

export type LoadedTtsProvider = {
  id: string;
  pluginId: string;
  label: string;
  meta: TtsProviderMeta;
  mod: TtsProviderModule;
};

/** 内置 provider 的 id（不走插件，opencode 路径在 tts.service 里） */
export const BUILTIN_TTS_PROVIDER_ID = "openai";

let providers = new Map<string, LoadedTtsProvider>();
let errors: string[] = [];
let fp = "";
let loading: Promise<void> | null = null;

/**
 * 指纹：插件集合 + 入口文件 mtime。
 *
 * 用入口文件的 mtime 而不是"加载过一次就算"——作者改一行 provider 代码，
 * 不该要求重启整个服务（TTS 最容易边调边改）。
 */
function fingerprintOf(list: ReturnType<typeof activePlugins>): string {
  return list
    .map((p) => {
      const r = resolvePluginEntry(p.dir);
      let m = "";
      try {
        if (r.file) m = String(fs.statSync(r.file).mtimeMs);
      } catch {
        /* 文件刚好被删：当没变，下次扫会重新处理 */
      }
      return `${p.id}:${p.enabled}:${r.kind}:${r.file ?? ""}:${m}`;
    })
    .join("|");
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 加载所有代码插件里的 `ttsProviders`（懒加载 + 指纹缓存） */
export async function ensureTtsProviders(): Promise<{ count: number; errors: string[] }> {
  if (loading) {
    await loading;
    return { count: providers.size, errors: [...errors] };
  }
  const list = activePlugins();
  const next = fingerprintOf(list);
  if (next === fp) return { count: providers.size, errors: [...errors] };

  loading = (async () => {
    const map = new Map<string, LoadedTtsProvider>();
    const errs: string[] = [];

    for (const p of list) {
      if (!p.enabled || p.errors.length) continue;
      /*
       * 只挑"代码插件"：能解析出入口的才可能导出 ttsProviders。
       * 这里不看 `provides` —— 声明漏了也照常能跑，只是 list_plugins 里不显示
       * （"能声明但没生效"很伤人，反过来"没声明但能用"不伤人）。
       */
      const resolved = resolvePluginEntry(p.dir);
      if (resolved.kind === "unbuilt") continue;

      let mod: Record<string, unknown>;
      try {
        mod = (await loadPluginEntry(p.dir, p.id)).mod;
      } catch (err) {
        // 入口坏了不在这里报（hooks 那边会报），避免同一个错误出现两遍
        continue;
      }

      const table = (mod.ttsProviders ?? (mod.default as Record<string, unknown> | undefined)?.ttsProviders) as
        | Record<string, unknown>
        | undefined;
      if (!table || typeof table !== "object") continue;

      for (const [id, raw] of Object.entries(table)) {
        const key = String(id ?? "").trim();
        if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) {
          errs.push(`${p.id}：provider id「${key || "(空)"}」不合法（只允许小写字母、数字、短横线）`);
          continue;
        }
        if (key === BUILTIN_TTS_PROVIDER_ID) {
          errs.push(`${p.id}：provider id「${key}」与内置重名（内置优先，换个 id）`);
          continue;
        }
        if (map.has(key)) {
          errs.push(`provider「${key}」已被插件 ${map.get(key)!.pluginId} 占用，${p.id} 的这份被忽略`);
          continue;
        }
        const m = (raw ?? {}) as Partial<TtsProviderModule>;
        if (typeof m.synthesize !== "function") {
          errs.push(`${p.id}：provider「${key}」缺少 synthesize 函数`);
          continue;
        }
        const meta = (m.meta ?? {}) as TtsProviderMeta;
        map.set(key, {
          id: key,
          pluginId: p.id,
          label: String(meta.label ?? key),
          meta,
          mod: m as TtsProviderModule,
        });
      }
    }

    providers = map;
    errors = errs;
    fp = next;
  })();

  try {
    await loading;
  } finally {
    loading = null;
  }
  return { count: providers.size, errors: [...errors] };
}

/** 取一个 provider（会先确保加载过） */
export async function getTtsProvider(id: string): Promise<LoadedTtsProvider | undefined> {
  await ensureTtsProviders();
  return providers.get(String(id ?? "").trim());
}

/** 诊断/列表用：不带 mod（避免把插件对象漏到 HTTP 响应里） */
export async function ttsProviderCatalog(): Promise<{
  providers: {
    id: string;
    label: string;
    hint?: string;
    pluginId: string;
    configFields: TtsConfigField[];
    hasVoices: boolean;
  }[];
  errors: string[];
}> {
  await ensureTtsProviders();
  return {
    providers: [...providers.values()].map((p) => ({
      id: p.id,
      label: p.label,
      hint: p.meta.hint,
      pluginId: p.pluginId,
      configFields: Array.isArray(p.meta.configFields) ? p.meta.configFields : [],
      hasVoices: typeof p.mod.voices === "function",
    })),
    errors: [...errors],
  };
}

/** 测试用：清掉缓存，下次强制重新加载 */
export function resetTtsProviders(): void {
  providers = new Map();
  errors = [];
  fp = "";
}
