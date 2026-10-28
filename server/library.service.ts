import fs from "node:fs";
import { ROOT as PROJECT_ROOT } from "./root";
import path from "node:path";
import { type CustomAsset } from "../shared/assetLibrary";
import { PUBLIC_DIR } from "./store";

/**
 * 「我的素材」索引。
 *
 * 放在 `data/library.json` 而不是某个工程里 —— 素材的价值就是**跨场景、跨工程复用**，
 * 挂在工程下面的话，复制工程会带走一堆用不上的图，换工程又什么都看不到。
 *
 * 文件本体仍在 `public/assets/`（Remotion 的 `staticFile()` 只认 public），
 * 索引只记 url + 尺寸 + 名字。
 */
const LIB_FILE = path.join(PROJECT_ROOT, "data", "library.json");
const ASSET_DIR = path.join(PUBLIC_DIR, "assets");
/** 库文件单独一个目录：跨工程复用，删工程不动它（v0.98 起） */
const LIB_DIR = path.join(ASSET_DIR, "library");

type LibFile = { items: CustomAsset[] };

function ensureDir() {
  fs.mkdirSync(path.dirname(LIB_FILE), { recursive: true });
  fs.mkdirSync(LIB_DIR, { recursive: true });
}

function read(): LibFile {
  if (!fs.existsSync(LIB_FILE)) return { items: [] };
  // 解析失败直接抛错：宁可这次操作失败，也不要把空库写回去覆盖用户素材
  const raw = JSON.parse(fs.readFileSync(LIB_FILE, "utf8")) as LibFile;
  return { items: Array.isArray(raw.items) ? raw.items : [] };
}

/** 先写临时文件再 rename：写一半被杀掉也不会留下半个 JSON */
function write(lib: LibFile) {
  ensureDir();
  const tmp = `${LIB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lib, null, 2), "utf8");
  fs.renameSync(tmp, LIB_FILE);
}

const newId = () => `as_${Math.random().toString(36).slice(2, 10)}`;

/** 视频扩展名：决定入库后是图片素材还是视频素材 */
const AUDIO_EXT = new Set([".wav", ".mp3", ".ogg", ".m4a", ".aac", ".flac", ".opus"]);
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".m4v", ".ogv"]);

const safeName = (name: string) => name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);

export type AddInput = {
  /** 有 buffer 就是新文件；没有就必须给 url（指向 public/assets 里已有的文件） */
  buffer?: Buffer;
  filename?: string;
  url?: string;
  name?: string;
  w?: number;
  h?: number;
  /** 音频/视频真实时长（秒） */
  duration?: number;
  /** 浏览器生成的列表缩略图（webp），只用于素材面板展示 */
  thumbBuffer?: Buffer;
};

export const library = {
  list(): CustomAsset[] {
    // 新的在前：刚上传的应该立刻能看到
    return read().items.slice().sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  },

  get(id: string): CustomAsset | undefined {
    return read().items.find((i) => i.id === id);
  },

  add(input: AddInput): CustomAsset {
    ensureDir();
    let url = input.url;
    let bytes: number | undefined;
    let thumbUrl: string | undefined;
    let kind: CustomAsset["kind"];

    if (input.buffer) {
      const ext = (path.extname(input.filename ?? "") || ".png").toLowerCase();
      const file = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}${ext}`;
      // 库文件进 library/：它属于「跨工程复用」，不属于任何单个工程
      fs.writeFileSync(path.join(LIB_DIR, file), input.buffer);
      url = `/assets/library/${file}`;
      bytes = input.buffer.length;
      if (VIDEO_EXT.has(ext)) kind = "video";
      if (AUDIO_EXT.has(ext)) kind = "audio";

      // 缩略图和原图放一起，名字用「原文件名.thumb.webp」，回收时按同一套规则处理
      if (input.thumbBuffer?.length) {
        const thumbFile = `${file}.thumb.webp`;
        fs.writeFileSync(path.join(LIB_DIR, thumbFile), input.thumbBuffer);
        thumbUrl = `/assets/library/${thumbFile}`;
      }
    }

    if (!url || !url.startsWith("/assets/")) {
      throw new Error("素材地址必须是本站 /assets/ 路径（远程图请先下载再上传）");
    }
    // 直接登记已有文件（agent 生成的 TTS / 上传的素材）：按扩展名补 kind
    if (!kind) {
      const ext = path.extname(url).toLowerCase();
      if (VIDEO_EXT.has(ext)) kind = "video";
      else if (AUDIO_EXT.has(ext)) kind = "audio";
    }
    // 索引里允许同一个文件被登记多次（不同名字），但只要文件不在就是脏数据
    if (!fs.existsSync(path.join(PUBLIC_DIR, url.replace(/^\/+/, "")))) {
      throw new Error(`文件不存在：${url}`);
    }

    const item: CustomAsset = {
      id: newId(),
      name: safeName(input.name?.trim() || path.basename(url)),
      url,
      thumbUrl,
      ...(kind ? { kind } : {}),
      w: input.w && input.w > 0 ? Math.round(input.w) : undefined,
      h: input.h && input.h > 0 ? Math.round(input.h) : undefined,
      duration: input.duration && input.duration > 0 ? input.duration : undefined,
      bytes,
      at: new Date().toISOString(),
    };

    const lib = read();
    lib.items.unshift(item);
    write(lib);
    return item;
  },

  /** 批量补素材时长（一次读一次写，避免逐条写中间出错把库写坏） */
  setDurations(durations: Record<string, number>): void {
    const keys = Object.keys(durations);
    if (!keys.length) return;
    const lib = read();
    let changed = false;
    for (const item of lib.items) {
      const d = durations[item.id];
      if (Number.isFinite(d) && d > 0) {
        item.duration = d;
        changed = true;
      }
    }
    if (changed) write(lib);
  },

  rename(id: string, name: string): CustomAsset {
    const lib = read();
    const item = lib.items.find((i) => i.id === id);
    if (!item) throw new Error(`素材库里没有 ${id}`);
    item.name = safeName(name.trim() || item.name);
    write(lib);
    return item;
  },

  /** 改地址（整理老文件把文件搬到新目录时用）：只动索引，不动文件 */
  setUrl(id: string, next: { url: string; thumbUrl?: string }): CustomAsset {
    const lib = read();
    const item = lib.items.find((i) => i.id === id);
    if (!item) throw new Error(`素材库里没有 ${id}`);
    item.url = next.url;
    if (next.thumbUrl === undefined) delete item.thumbUrl;
    else item.thumbUrl = next.thumbUrl;
    write(lib);
    return item;
  },

  /**
   * 只摘索引，**不删文件**：同一张图可能已经被拖进多个场景，
   * 删文件会让那些画面变成裂图。真要清磁盘另做一个"清理未引用素材"。
   */
  remove(id: string): CustomAsset {
    const lib = read();
    const idx = lib.items.findIndex((i) => i.id === id);
    if (idx < 0) throw new Error(`素材库里没有 ${id}`);
    const [item] = lib.items.splice(idx, 1);
    write(lib);
    return item;
  },
};
