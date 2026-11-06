import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { DATA_ROOT } from "./paths";
import path from "node:path";
import { assetUrlOf } from "../shared/customTemplate";
import { escapeForTts } from "../shared/ttsText";
import { PREVIEW_DIR, PREVIEW_REL, projectAssetDir, projectAssetRel } from "./assets.service";
import { ffmpegPath } from "./ffmpeg";
import { BUILTIN_TTS_PROVIDER_ID, getTtsProvider } from "./plugin/tts-providers";

/**
 * 文本转语音（TTS）。
 *
 * 本地模型还没部署好，所以做成**可配置的 HTTP 调用**：
 *  - 默认按 OpenAI 兼容协议：POST {endpoint}，body { model, input, voice, speed, response_format }
 *  - 非标准接口可以填 customBody 模板（{{text}} / {{voice}} / {{speed}} 占位）
 *  - 响应支持：音频二进制、JSON 里的 url / base64 / audio 字段
 *
 * 配置存在 data/tts-config.json（本机，不进 git）。
 */
export type TtsConfig = {
  /**
   * 用哪个 provider。
   *  - `openai`（默认）：内置的 OpenAI 兼容实现，下面那些 endpoint/model/... 就是它的配置
   *  - 其它：插件提供的 provider（`plugin.ts` 里 `export const ttsProviders = {...}`），
   *    它自己的配置在 `providers[id]` 里（每家字段都不一样，宿主不猜）
   */
  provider: string;
  /** 各插件 provider 的自由配置：{ "volc-tts": { appid, token } } */
  providers: Record<string, Record<string, string>>;
  endpoint: string;
  apiKey: string;
  model: string;
  voice: string;
  format: "mp3" | "wav" | "ogg";
  speed: number;
  /** 默认风格指令（Qwen3-TTS 的 instruct，如"用特别愤怒的语气说"） */
  instruct: string;
  /** 语言：Chinese / English / Japanese / Korean */
  language: string;
  customBody: string;
};

const DEFAULTS: TtsConfig = {
  provider: BUILTIN_TTS_PROVIDER_ID,
  providers: {},
  endpoint: "http://127.0.0.1:8091/v1/audio/speech",
  apiKey: "",
  model: "",
  voice: "default",
  format: "wav",
  speed: 1,
  instruct: "",
  language: "Chinese",
  customBody: "",
};

const DATA_DIR = DATA_ROOT;
const FILE = path.join(DATA_DIR, "tts-config.json");

export function getTtsConfig(): TtsConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8")) as Partial<TtsConfig>;
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveTtsConfig(patch: Partial<TtsConfig>): TtsConfig {
  const prev = getTtsConfig();
  const next: TtsConfig = {
    ...prev,
    ...patch,
    provider: String(patch.provider ?? prev.provider ?? BUILTIN_TTS_PROVIDER_ID).trim() || BUILTIN_TTS_PROVIDER_ID,
    // 逐 provider 合并，而不是整体替换：面板一次只改一家，不该把别家的密钥清掉
    providers: {
      ...(prev.providers ?? {}),
      ...Object.fromEntries(
        Object.entries(patch.providers ?? {}).map(([id, v]) => [
          String(id),
          Object.fromEntries(Object.entries(v ?? {}).map(([k, x]) => [String(k), String(x ?? "")])),
        ]),
      ),
    },
    format: (["mp3", "wav", "ogg"] as const).includes(patch.format as TtsConfig["format"])
      ? (patch.format as TtsConfig["format"])
      : getTtsConfig().format,
    speed: Math.max(0.25, Math.min(4, Number(patch.speed ?? getTtsConfig().speed) || 1)),
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}

const extOf = (contentType: string, fallback: string): string => {
  const ct = contentType.toLowerCase();
  if (ct.includes("wav")) return "wav";
  if (ct.includes("mpeg") || ct.includes("mp3")) return "mp3";
  if (ct.includes("ogg") || ct.includes("opus")) return "ogg";
  if (ct.includes("aac")) return "aac";
  return fallback;
};

export type TtsResult = {
  url: string;
  file: string;
  bytes: number;
  format: string;
};

/**
 * 调本地 TTS 服务合成语音，返回站内地址。
 *
 * 落盘位置按归属分（v0.99）：
 *  - 传 projectId → `public/assets/projects/<工程id>/`（只属于这支片子，删工程连带清）
 *  - 不传（试听 / 连接预检）→ `public/assets/_preview/`，可被「清理未引用」收掉
 * 以前一律写 public/assets 根下，工程一多就分不清是谁的配音。
 */
export async function synthesize(
  text: string,
  opts: {
    voice?: string;
    speed?: number;
    format?: string;
    instruct?: string;
    language?: string;
    /** 默认 true：自动把数字/百分比/日期/常见符号转成中文读法 */
    escape?: boolean;
    /** 归属工程：给了就存进该工程素材目录，不给视为试听（_preview） */
    projectId?: string;
  } = {},
): Promise<TtsResult> {
  const clean = String(text ?? "").trim();
  if (!clean) throw new Error("文本不能为空");
  if (clean.length > 2000) throw new Error("文本太长（最多 2000 字），建议分段生成");

  // 默认转义：agent 直接写 90% / 2026-10-25 也能读对
  const speakText = opts.escape === false ? clean : escapeForTts(clean);

  const cfg = getTtsConfig();
  if (!cfg.endpoint) throw new Error("还没配置语音服务地址（编辑器里「语音」→ 配置）");

  const voice = opts.voice ?? cfg.voice;
  const speed = Math.max(0.25, Math.min(4, Number(opts.speed ?? cfg.speed) || 1));
  const instruct = String(opts.instruct ?? cfg.instruct ?? "").trim();
  const language = String(opts.language ?? cfg.language ?? "Chinese").trim() || "Chinese";
  const format = (opts.format ?? cfg.format) as TtsConfig["format"];

  /*
   * 插件 provider：把"文字 → 音频"整段交给插件，宿主只管落盘与校验。
   * 内置 openai 那条路一个字节都没动（下面是原逻辑）。
   */
  const providerId = String(cfg.provider ?? "").trim() || BUILTIN_TTS_PROVIDER_ID;
  if (providerId !== BUILTIN_TTS_PROVIDER_ID) {
    return synthesizeWithPlugin(providerId, speakText, { voice, speed, format, instruct, language, config: cfg.providers?.[providerId] ?? {}, projectId: opts.projectId });
  }

  let body: Record<string, unknown>;
  if (cfg.customBody?.trim()) {
    const tpl = cfg.customBody
      .replace(/\{\{\s*text\s*\}\}/g, JSON.stringify(speakText).slice(1, -1))
      .replace(/\{\{\s*instruct\s*\}\}/g, JSON.stringify(instruct).slice(1, -1))
      .replace(/\{\{\s*voice\s*\}\}/g, voice)
      .replace(/\{\{\s*speed\s*\}\}/g, String(speed));
    body = JSON.parse(tpl) as Record<string, unknown>;
  } else {
    // OpenAI 兼容（vLLM）：input / voice / instructions / language / response_format / speed
    body = {
      model: cfg.model || undefined,
      input: speakText,
      voice,
      speed,
      language,
      ...(instruct ? { instructions: instruct } : {}),
      response_format: format,
    };
  }

  const res = await fetch(cfg.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const msg = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`语音服务返回 ${res.status}${msg ? `：${msg}` : ""}`);
  }

  const ct = res.headers.get("content-type") ?? "";
  let buf: Buffer;
  let ext: string = format;

  if (ct.includes("application/json")) {
    const data = (await res.json()) as Record<string, any>;
    const b64 = data.audio ?? data.base64 ?? data.b64 ?? data.data?.audio;
    if (typeof b64 === "string") {
      buf = Buffer.from(b64.replace(/^data:audio\/[\w+]+;base64,/, ""), "base64");
      ext = extOf(ct, format) === format ? format : extOf(ct, format);
    } else if (typeof data.url === "string") {
      const audio = await fetch(data.url);
      if (!audio.ok) throw new Error(`下载语音失败：${audio.status}`);
      buf = Buffer.from(await audio.arrayBuffer());
      ext = extOf(audio.headers.get("content-type") ?? "", format);
    } else {
      throw new Error("语音服务返回了 JSON，但没找到 audio/url 字段");
    }
  } else {
    buf = Buffer.from(await res.arrayBuffer());
    ext = extOf(ct, format);
  }

  if (!buf.length) throw new Error("语音服务返回了空音频");

  return persistAudio(buf, ext, opts);
}

/* ───────────────────── 插件 provider：适配任意厂商 ───────────────────── */

/** 单次合成的超时。多数云 TTS 在 10 秒内返回，60 秒还没回来说明网络或鉴权卡住了 */
const PLUGIN_TIMEOUT_MS = 60_000;
/** 产物上限：20MB 足够一段 2000 字的高码率音频，超过基本是插件把 HTML 错误页当音频返回了 */
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

/**
 * 按 magic bytes 认音频。
 *
 * 为什么不信 `contentType`：插件常常直接 `return { audio }` 不带类型；而厂商报错时
 * 返回的往往是 HTML/JSON（200 但内容是 "invalid api key"）。不认一下，
 * 这段字节会被当成音频写进工程，渲染时才在 ffmpeg 那里炸，且错误完全对不上源头。
 */
function sniffAudio(buf: Buffer): string | null {
  if (buf.length < 16) return null;
  const head = buf.subarray(0, 4).toString("latin1");
  if (head === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WAVE") return "wav";
  if (head === "OggS") return "ogg";
  if (head === "ID3") return "mp3";
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "mp3";
  if (buf.subarray(4, 8).toString("latin1") === "ftyp") return "m4a";
  if (head === "ADIF") return "aac";
  return null;
}

async function synthesizeWithPlugin(
  providerId: string,
  text: string,
  req: {
    voice: string;
    speed: number;
    format: string;
    instruct?: string;
    language?: string;
    config: Record<string, string>;
    projectId?: string;
  },
): Promise<TtsResult> {
  const provider = await getTtsProvider(providerId);
  if (!provider) {
    const { providers } = await import("./plugin/tts-providers").then((m) => m.ttsProviderCatalog());
    const ids = [`${BUILTIN_TTS_PROVIDER_ID}（内置）`, ...providers.map((p) => `${p.id}（${p.label}）`)];
    throw new Error(
      `没有这个语音 provider：「${providerId}」。可用：${ids.join(" / ")}。` +
        `插件提供的 provider 写在 plugin.ts 的 ttsProviders 里（用 list_tts_providers 查详情）`,
    );
  }

  // 必填项先查：缺 key 时让厂商返回 401，用户只会看到一句看不懂的英文
  const missing = (provider.meta.configFields ?? [])
    .filter((f) => f.required && !String(req.config[f.key] ?? "").trim())
    .map((f) => f.label ?? f.key);
  if (missing.length) {
    throw new Error(
      `provider「${provider.label}」还缺配置：${missing.join("、")}。` +
        `用 set_tts_config { provider: "${provider.id}", providers: { "${provider.id}": { ... } } } 填`,
    );
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PLUGIN_TIMEOUT_MS);
  let out: Awaited<ReturnType<typeof provider.mod.synthesize>>;
  try {
    out = await Promise.race([
      Promise.resolve(
        provider.mod.synthesize({
          text,
          voice: req.voice,
          speed: req.speed,
          format: req.format,
          instruct: req.instruct,
          language: req.language,
          config: req.config,
          signal: ctrl.signal,
        }),
      ),
      /*
       * 第二道闸：插件没透传 signal（很常见），只有 AbortController 杀不掉它。
       * 这里再 race 一个计时器，保证"插件永远不返回"不会把整个合成请求挂住。
       */
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`超过 ${PLUGIN_TIMEOUT_MS / 1000} 秒没有返回`)), PLUGIN_TIMEOUT_MS + 3_000),
      ),
    ]);
  } catch (err) {
    // 不静默回退内置：悄悄换 provider 会让"配错了但出片了"变成最难查的坑
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`provider「${provider.label}」（插件 ${provider.pluginId}）合成失败：${msg}`);
  } finally {
    clearTimeout(timer);
  }

  let buf: Buffer;
  if (out && typeof out === "object" && "file" in out && typeof out.file === "string") {
    if (!fs.existsSync(out.file)) {
      throw new Error(`provider「${provider.label}」返回的文件不存在：${out.file}`);
    }
    buf = fs.readFileSync(out.file);
  } else if (out && typeof out === "object" && "audio" in out) {
    const a = (out as { audio: Uint8Array | ArrayBuffer }).audio;
    buf = Buffer.isBuffer(a) ? a : Buffer.from(a instanceof ArrayBuffer ? new Uint8Array(a) : a);
  } else {
    throw new Error(`provider「${provider.label}」没有返回 { audio } 或 { file }`);
  }

  if (!buf.length) throw new Error(`provider「${provider.label}」返回了空音频`);
  if (buf.length > MAX_AUDIO_BYTES) {
    throw new Error(
      `provider「${provider.label}」返回了 ${(buf.length / 1024 / 1024).toFixed(1)}MB 音频，超过 ${MAX_AUDIO_BYTES / 1024 / 1024}MB 上限`,
    );
  }

  const ext = sniffAudio(buf);
  if (!ext) {
    throw new Error(
      `provider「${provider.label}」返回的不是音频（前 64 字节：${JSON.stringify(buf.subarray(0, 64).toString("utf8").slice(0, 80))}）。` +
        `多半是接口返回了错误页，检查它的鉴权与参数`,
    );
  }

  return persistAudio(buf, ext, { projectId: req.projectId });
}

/** 音频落盘 + 响度归一，返回站内地址。内置与插件两条路共用 */
function persistAudio(buf: Buffer, ext: string, opts: { projectId?: string }): TtsResult {
  const file = `tts-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
  const pid = opts.projectId?.trim();
  let dir: string;
  let url: string;
  if (pid) {
    dir = projectAssetDir(pid);
    url = assetUrlOf(projectAssetRel(pid, file));
  } else {
    dir = PREVIEW_DIR;
    url = assetUrlOf(`${PREVIEW_REL}/${file}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), buf);
  normalizeLoudness(path.join(dir, file));
  return { url, file, bytes: buf.length, format: ext };
}

/* ───────────────────────── 响度归一（E1） ───────────────────────── */

/**
 * TTS 出来的旁白普遍 -25 ~ -27 LUFS、峰值 -8dBFS，配平时一抬就到峰值墙，
 * 用户第一反应永远是「声音太小」（复盘问题 16）。
 * 这里在合成后直接做一次单遍 loudnorm：拉到 -16 LUFS / 真峰 -1.5dBTP，
 * 后面 balance_audio 就不用硬顶着削波风险去放大人声。
 *
 * 失败一律**不阻断**（返回 false 只打日志）：TTS 能用比响度更重要。
 * 环境变量 TTS_NORMALIZE=0 可整体关掉。
 */
export function normalizeLoudness(file: string): boolean {
  if ((process.env.TTS_NORMALIZE ?? "").trim() === "0") return false;
  const bin = ffmpegPath();
  if (!bin) return false; // 没有 ffmpeg 就跳过，不是错误
  const tmp = `${file}.norm${path.extname(file)}`;
  try {
    const r = spawnSync(
      bin,
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        file,
        "-af",
        "loudnorm=I=-16:TP=-1.5:LRA=11",
        "-ar",
        "48000",
        tmp,
      ],
      { timeout: 120_000, windowsHide: true },
    );
    if (r.status !== 0 || !fs.existsSync(tmp) || fs.statSync(tmp).size === 0) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* 清理失败无所谓 */
      }
      return false;
    }
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    return false;
  }
}
