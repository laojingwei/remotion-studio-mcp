import fs from "node:fs";
import { ROOT as PROJECT_ROOT } from "./root";
import path from "node:path";
import { assetUrlOf } from "../shared/customTemplate";
import { escapeForTts } from "../shared/ttsText";
import { PREVIEW_DIR, PREVIEW_REL, projectAssetDir, projectAssetRel } from "./assets.service";

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
  endpoint: "http://127.0.0.1:9880/v1/audio/speech",
  apiKey: "",
  model: "",
  voice: "default",
  format: "wav",
  speed: 1,
  instruct: "",
  language: "Chinese",
  customBody: "",
};

const DATA_DIR = path.join(PROJECT_ROOT, "data");
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
  const next: TtsConfig = {
    ...getTtsConfig(),
    ...patch,
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
  return { url, file, bytes: buf.length, format: ext };
}
