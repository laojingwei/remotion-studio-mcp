import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { Context } from "hono";

/**
 * 静态文件服务（素材 / 渲染产物）。
 *
 * 为什么不用 `@hono/node-server/serve-static`：
 *  1. 它的 MIME 表不含 wav / opus / flac 等，一律回 `application/octet-stream`。
 *     Chromium 拿到 octet-stream 的 `<audio>`/`<video>` 会**直接拒绝解码**——
 *     现象就是"详情面板里播放器在、但点播放没反应"，而 `<img>` 不校验 MIME，
 *     所以图片一直正常，特别容易误判成前端问题。
 *  2. 它不处理 Range：音视频没法拖进度条，Safari/Edge 上甚至拒绝开播。
 *
 * 这里自己按扩展名给 Content-Type，并实现单区间 Range（206）。
 */

const MIME: Record<string, string> = {
  // 图片
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  // 视频
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".ogv": "video/ogg",
  ".mkv": "video/x-matroska",
  // 音频
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
  ".weba": "audio/webm",
  // 文本与其它
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".srt": "text/plain; charset=utf-8",
  ".vtt": "text/vtt; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".zip": "application/zip",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

/** 扩展名 → Content-Type；认不出才回 octet-stream（回归点：wav/mp3 必须带自己的类型） */
export const mimeOf = (file: string): string =>
  MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";

/** `/assets/a/b.wav?t=123` → `assets/a/b.wav`；任何一段是 `..`/`.`/空 就返回 null */
function safeRelPath(urlPath: string): string | null {
  let raw: string;
  try {
    raw = decodeURIComponent(urlPath.split("?")[0]);
  } catch {
    return null; // 非法 %-encoding
  }
  const segs = raw.split("/").filter((s) => s !== "");
  if (!segs.length) return null;
  for (const s of segs) {
    if (s === "." || s === ".." || s.includes("\\") || s.includes("\0")) return null;
  }
  return segs.join("/");
}

type RangeSpan = { start: number; end: number };

/** 只认单区间 `bytes=a-b` / `bytes=a-` / `bytes=-n`；多区间一律忽略（回 200 全量） */
export function parseRange(header: string | undefined, size: number): RangeSpan | "invalid" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === "" && b === "") return "invalid";
  let start: number;
  let end: number;
  if (a === "") {
    // 最后 n 字节
    const n = Number(b);
    if (!Number.isFinite(n) || n <= 0) return "invalid";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Number(b);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return "invalid";
  }
  return { start, end: Math.min(end, size - 1) };
}

/**
 * 把 `urlPrefix`（如 `/assets`）映射到 `rootDir` 下的真实文件。
 * 只读、不列目录、挡路径穿越。
 */
export function serveFiles(rootDir: string, opts: { cache?: string } = {}) {
  const cache = opts.cache ?? "public, max-age=600";

  return async (c: Context) => {
    const rel = safeRelPath(c.req.path);
    if (!rel) return c.notFound();

    const full = path.resolve(rootDir, ...rel.split("/"));
    // 双保险：resolve 之后必须仍在 rootDir 内
    const rootAbs = path.resolve(rootDir);
    if (full !== rootAbs && !full.startsWith(rootAbs + path.sep)) return c.notFound();

    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      return c.notFound();
    }
    if (!stat.isFile()) return c.notFound();

    const type = mimeOf(full);
    const size = stat.size;
    const etag = `W/"${size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;
    const headers: Record<string, string> = {
      "content-type": type,
      "accept-ranges": "bytes",
      "cache-control": cache,
      etag,
      "last-modified": stat.mtime.toUTCString(),
    };

    // 条件请求：省一次全量传输
    const inm = c.req.header("if-none-match");
    if (inm && inm === etag) return c.body(null, 304, headers);

    const span = parseRange(c.req.header("range"), size);
    if (span === "invalid") {
      return c.body(null, 416, { ...headers, "content-range": `bytes */${size}` });
    }

    const start = span ? span.start : 0;
    const end = span ? span.end : size - 1;
    const length = size === 0 ? 0 : end - start + 1;

    headers["content-length"] = String(length);
    if (span) headers["content-range"] = `bytes ${start}-${end}/${size}`;

    if (c.req.method === "HEAD" || size === 0) {
      return c.body(null, span ? 206 : 200, headers);
    }

    // 流式返回，避免成片几百 MB 时整个读进内存
    const nodeStream = fs.createReadStream(full, { start, end });
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;
    return c.body(webStream, span ? 206 : 200, headers);
  };
}
