import fs from "node:fs";
import path from "node:path";
import { PROJECTS_ROOT } from "./paths";
import {
  absAssetPath,
  assetKindOfFile,
  projectAssetDir,
  projectAssetRel,
  writeProjectAsset,
} from "./assets.service";
import {
  hasMediaProcessor,
  mediaStepsToNote,
  runMediaPipeline,
  type MediaKind,
  type MediaStep,
} from "./plugin/hooks";
import { activePlugins } from "./plugin/discovery";

/**
 * 素材处理管道：上传的图/音/视频先过一遍插件，再落库。
 *
 * ## 一条硬规矩：只能产出新文件，不能覆盖输入
 *
 * 工程里存的是 `/assets/projects/<id>/xxx.png`。如果插件原地覆盖它，会出现两件
 * 都很难解释的事：
 *
 *  1. 所有引用这张图的场景一起变，包括用户没打算改的
 *  2. **已经导出的成片不会变** —— 用户看到"编辑器和成片不一致"，而且原文件没了，
 *     想回退只能重传
 *
 * 所以处理结果一定写成一个**新文件名**（`abc@<指纹>.png`），工程引用新文件。
 * 回滚 = 把 URL 改回 `abc.png`，原文件始终还在。
 *
 * ## 指纹里带什么
 *
 * 处理器集合（插件 id + manifest.version，排序后哈希）。这样：
 *  - 同一套插件重跑 → 同名 → **幂等**，不会每次上传都堆一个新文件
 *  - 换了插件或改了 version → 新名字 → 新旧并存，可对比、可回退
 *  - 停用插件 → 新上传不再加后缀，**已处理的文件不受影响**（否则删个插件工程就花了）
 */

/* ─────────────────────────── 溯源 ─────────────────────────── */

export type ProvenanceEntry = {
  /** 原始文件名（不带目录） */
  origin: string;
  /** 参与处理的插件（按执行顺序） */
  plugins: string[];
  /** 处理器集合指纹，也是文件名后缀 */
  fingerprint: string;
  at: string;
};

type ProvenanceFile = Record<string, ProvenanceEntry>;

const provenanceFile = (projectId: string): string =>
  path.join(PROJECTS_ROOT, projectId, "asset-provenance.json");

export function readProvenance(projectId: string): ProvenanceFile {
  try {
    return JSON.parse(fs.readFileSync(provenanceFile(projectId), "utf8")) as ProvenanceFile;
  } catch {
    return {};
  }
}

function writeProvenance(projectId: string, data: ProvenanceFile): void {
  const file = provenanceFile(projectId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  } catch {
    /* 溯源写不进去不该让上传失败——它是记录，不是主流程 */
  }
}

/* ─────────────────────────── 指纹 ─────────────────────────── */

/** FNV-1a → base36 五位：够短、稳定、不需要依赖 */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(5, "0").slice(0, 5);
}

/**
 * 当前启用的媒体处理器集合 → 短指纹。
 *
 * 带 `manifest.version` 是刻意的：插件改了参数却没升 version，重跑会覆盖同名文件，
 * 用户会觉得"处理没生效"。升 version 就换名字，这是唯一能让人自查的办法。
 */
export function processorFingerprint(): string {
  const ids = activePlugins()
    .filter((p) => p.provides.includes("hooks"))
    .map((p) => `${p.id}@${p.manifest?.version ?? "0"}`)
    .sort();
  return shortHash(ids.join("|") || "none");
}

/**
 * 处理产物的文件名：`abc.png` + 插件给的 `clean.jpg` → `abc@x1y2z.jpg`。
 *
 * **名字的 base 一定取原文件，只采纳插件给的扩展名。** 这条不是风格问题：
 * 插件返回的 `fileName` 常常是固定值（示例里就是 `clean.jpg`），
 * 如果照它命名，一个工程里所有图都会叫 `clean@<fp>.jpg`，第二张直接覆盖第一张，
 * 而且用户完全看不出来（引用都指向同一个 URL）。
 *
 * 已有 `@指纹` 后缀的先剥掉再拼，重复处理不会变成 `abc@a@b.png`。
 */
function decoratedName(originName: string, pluginName: string, fp: string): string {
  const originExt = path.extname(originName);
  const base = path.basename(originName, originExt).replace(/@[a-z0-9]{3,8}$/, "");
  const ext = path.extname(pluginName) || originExt;
  return `${base}@${fp}${ext}`;
}

/* ─────────────────────────── 串行队列 ─────────────────────────── */

/**
 * 并发 1。
 *
 * 媒体处理吃 CPU（ffmpeg 会吃满核），一次拖 10 个文件同时上传会把服务卡到
 * 预览都转不动。排队让总耗时差不多，但每一步都还能响应。
 * 队列是**进程内**的，多实例部署各排各的——这项目本来就是单机单体，够用。
 */
let tail: Promise<unknown> = Promise.resolve();

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = tail.then(job, job);
  // 吞掉错误只为把链续上；调用方拿到的仍是原始 Promise
  tail = run.catch(() => undefined);
  return run;
}

/* ─────────────────────────── 主流程 ─────────────────────────── */

export type ProcessOutcome = {
  /** 工程引用的 URL */
  url: string;
  /** 落库的文件名（可能是处理后的新名字） */
  name: string;
  /** 原始文件名 */
  originName: string;
  bytes: number;
  processed: boolean;
  steps: MediaStep[];
  warnings: string[];
  /** 一句话说明（回执直接用） */
  note: string;
};

/**
 * 上传一个素材：落原文件 → 过一遍插件 → 有改动就写新文件。
 *
 * 没装处理器时开销为零——`hasMediaProcessor()` 只是一次数组判断，连文件都不读。
 */
export function ingestAsset(projectId: string, fileName: string, buffer: Buffer): Promise<ProcessOutcome> {
  return enqueue(async () => {
    // 原文件一定要先落：插件挂了、超时了、服务重启了，用户的素材都还在
    const originUrl = writeProjectAsset(projectId, fileName, buffer);
    const base: ProcessOutcome = {
      url: originUrl,
      name: fileName,
      originName: fileName,
      bytes: buffer.length,
      processed: false,
      steps: [],
      warnings: [],
      note: "",
    };

    if (!hasMediaProcessor()) return base;

    const kind: MediaKind = assetKindOfFile(fileName);
    const abs = absAssetPath(projectAssetRel(projectId, fileName));
    const r = await runMediaPipeline({ file: abs, fileName, kind, projectId });
    const warnings = r.warnings;

    if (!r.changed) {
      return { ...base, warnings, note: warnings.length ? "插件看过但没改" : "" };
    }

    const fp = processorFingerprint();
    const outName = decoratedName(fileName, r.fileName, fp);
    let outUrl: string;
    try {
      outUrl = writeProjectAsset(projectId, outName, r.buffer);
    } catch (err) {
      // 写不进去就退回原文件——素材能传上去比"处理成功"重要
      return {
        ...base,
        warnings: [...warnings, `处理结果写不进去（${String(err)}），已保留原文件`],
        note: "",
      };
    }

    const prov = readProvenance(projectId);
    prov[outName] = {
      origin: fileName,
      plugins: r.steps.map((s) => s.pluginId),
      fingerprint: fp,
      at: new Date().toISOString(),
    };
    writeProvenance(projectId, prov);

    return {
      url: outUrl,
      name: outName,
      originName: fileName,
      bytes: r.buffer.length,
      processed: true,
      steps: r.steps,
      warnings,
      note: mediaStepsToNote(r),
    };
  });
}

/* ─────────────────────────── 批量重处理 ─────────────────────────── */

export type ReprocessItem = {
  name: string;
  action: "reuse" | "process" | "skip";
  note: string;
  newUrl?: string;
};

export type ReprocessResult = {
  items: ReprocessItem[];
  processed: number;
  warnings: string[];
};

/**
 * 把处理器套到**已有**素材上。
 *
 * 为什么单独一个流程而不是"上传时自动跑"：用户装完插件，工 assets 里已经有几十张图了，
 * 这些不会自己变。所以需要一个显式的批量入口。
 *
 * 幂等靠文件名：已经有 `@<当前指纹>` 的文件直接跳过——重复跑不会堆出一堆副本。
 */
export async function reprocessProjectAssets(
  projectId: string,
  opts: { onlyNames?: string[]; dryRun?: boolean } = {},
): Promise<ReprocessResult> {
  const dir = projectAssetDir(projectId);
  const fp = processorFingerprint();
  const items: ReprocessItem[] = [];
  const warnings: string[] = [];

  if (!hasMediaProcessor()) {
    return { items, processed: 0, warnings: ["没有装文件处理插件，这条链是空的"] };
  }

  let names: string[] = [];
  try {
    names = fs
      .readdirSync(dir)
      .filter((f) => fs.statSync(path.join(dir, f)).isFile())
      .sort();
  } catch {
    return { items, processed: 0, warnings: ["工程素材目录还不存在"] };
  }

  const targets = opts.onlyNames?.length ? names.filter((n) => opts.onlyNames!.includes(n)) : names;
  const prov = readProvenance(projectId);
  let processed = 0;

  /*
   * 哪些原文件已经由**当前这套处理器**处理过了（从溯源反查）。
   *
   * 为什么不能只靠"产物名是否已存在"判断：插件可能改扩展名（png → jpg），
   * 宿主在跑之前并不知道成果会叫什么。而 provenance 里记了 origin + fingerprint，
   * 正好能回答"这个原文件被当前处理器加工过没有"。
   *
   * 不这么做的话，原文件一直在，每次 reprocess 都会把它重新跑一遍：
   * 输出同名（不产生垃圾，看着无害），但白烧 CPU，而且计数会让用户以为又处理了一批。
   * **幂等的正确定义是"不重跑"，不是"重跑但结果一样"。**
   */
  const alreadyDone = new Set(
    Object.values(prov)
      .filter((e) => e.fingerprint === fp)
      .map((e) => e.origin),
  );

  for (const name of targets) {
    const kind = assetKindOfFile(name);
    if (kind === "file") {
      items.push({ name, action: "skip", note: "不是图片/音频/视频，插件链不处理" });
      continue;
    }
    // 已经是当前指纹的产物：直接跳过，避免重复跑出副本
    if (name.includes(`@${fp}.`)) {
      items.push({ name, action: "skip", note: `已经是当前处理器的结果（@${fp}）` });
      continue;
    }
    if (alreadyDone.has(name)) {
      items.push({ name, action: "skip", note: "已由当前这套处理器处理过（见溯源），不重跑" });
      continue;
    }
    // 另一个指纹的产物：不再加工（否则会 @a@b 叠名字，且语义混乱）
    if (/@[a-z0-9]{5}\./.test(name)) {
      items.push({ name, action: "skip", note: "已是某个处理器版本的产物，不重复加工" });
      continue;
    }

    const abs = absAssetPath(projectAssetRel(projectId, name));
    const r = await runMediaPipeline({ file: abs, fileName: name, kind, projectId });
    warnings.push(...r.warnings);
    if (!r.changed) {
      items.push({ name, action: "skip", note: "插件看过，不需要改" });
      continue;
    }

    const outName = decoratedName(name, r.fileName, fp);
    if (opts.dryRun !== false) {
      items.push({ name, action: "process", note: `将产出 ${outName}（dryRun，未写入）` });
      processed++;
      continue;
    }

    const outUrl = writeProjectAsset(projectId, outName, r.buffer);
    prov[outName] = {
      origin: prov[name]?.origin ?? name,
      plugins: r.steps.map((s) => s.pluginId),
      fingerprint: fp,
      at: new Date().toISOString(),
    };
    items.push({ name, action: "process", note: `${outName}（${mediaStepsToNote(r)}）`, newUrl: outUrl });
    alreadyDone.add(prov[name]?.origin ?? name);
    processed++;
  }

  if (opts.dryRun === false && processed) writeProvenance(projectId, prov);
  return { items, processed, warnings };
}

/** 某个素材是哪个插件、从哪个原文件加工来的（`list_plugins` / 排查用） */
export function provenanceOf(projectId: string, name: string): ProvenanceEntry | null {
  return readProvenance(projectId)[name] ?? null;
}
