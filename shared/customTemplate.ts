import { totalDuration, type Format, type Project, type Scene, type Theme } from "./schema";

/**
 * 用户自定义模板 —— 把「当前工程」存成可复用的整片模板。
 *
 * 与内置模板的区别：内置模板只描述场景清单（type + props），
 * 自定义模板存的是**完整工程快照**：画幅、主题、音频、场景里的
 * transforms / 自由元素全部保留，所以套用出来和存的时候长得一样。
 *
 * 素材处理：工程里引用的 /assets/xxx 会随模板一起打包进模板目录，
 * 套用时再复制回 public/assets。这样删掉原工程、或把 data/ 拷到另一台机器，
 * 模板里的图片/音频也还在（不依赖原工程目录）。
 */
export type TemplatePayload = {
  fps: number;
  formats: Format[];
  theme: Theme;
  audio?: Project["audio"];
  scenes: Scene[];
};

export type CustomTemplate = {
  id: string;
  name: string;
  description: string;
  /** 2-4 个关键词（如 口播 / 数据 / 快节奏），便于检索复用 */
  tags?: string[];
  createdAt: string;
  payload: TemplatePayload;
};

/** 模板卡片（内置与自定义统一成同一种形态，前端只按 kind 分派） */
export type TemplateCard = {
  key: string;
  name: string;
  description: string;
  tags: string[];
  sceneCount: number;
  durationInFrames: number;
  sceneTypes: string[];
  kind: "builtin" | "custom";
};

const rid = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

/** 工程 → 模板快照：丢掉实例身份（id / rev / updatedAt / 名称），其余整份保留 */
export function snapshotProject(project: Project): TemplatePayload {
  return structuredClone({
    fps: project.fps,
    formats: project.formats,
    theme: project.theme,
    audio: project.audio,
    scenes: project.scenes,
  });
}

/** 模板快照 → 新工程：新 id、rev 1、每个场景 id 重新生成（深拷贝，改新工程不影响模板） */
export function instantiateTemplate(
  tpl: CustomTemplate,
  opts: { name?: string; id?: string } = {},
): Project {
  const used = new Set<string>();
  const scenes = tpl.payload.scenes.map((s) => {
    let id = rid("scene");
    while (used.has(id)) id = rid("scene");
    used.add(id);
    return { ...structuredClone(s), id };
  });

  const project: Project = {
    id: opts.id ?? rid("p"),
    name: opts.name ?? tpl.name,
    rev: 1,
    fps: tpl.payload.fps,
    formats: structuredClone(tpl.payload.formats),
    theme: structuredClone(tpl.payload.theme),
    scenes,
    updatedAt: new Date().toISOString(),
  };
  if (tpl.payload.audio) project.audio = structuredClone(tpl.payload.audio);
  return project;
}

export function summarizeCustomTemplate(tpl: CustomTemplate): TemplateCard {
  const scenes = tpl.payload.scenes;
  return {
    key: tpl.id,
    name: tpl.name,
    description: tpl.description,
    tags: tpl.tags?.length ? tpl.tags : ["我的模板"],
    sceneCount: scenes.length,
    // 模板可能是多轨工程存的：总时长取最靠后的一帧
    durationInFrames: totalDuration({ scenes }),
    sceneTypes: scenes.map((s) => s.type),
    kind: "custom",
  };
}

/**
 * 素材相对路径是否安全。**这是文件系统路径的来源**，所以每一段都要挡：
 * 空段、`..`、反斜杠、隐藏文件、非常规字符。
 *
 * v0.98 起素材分层存放（`projects/<工程id>/` 与 `library/`），所以允许子目录；
 * 但"允许子目录"绝不等于"允许穿越"。
 */
export function isSafeAssetRel(rel: string): boolean {
  if (!rel || rel.includes("\\") || rel.includes("//")) return false;
  return rel
    .split("/")
    .every((seg) => seg !== "." && seg !== ".." && !seg.startsWith(".") && /^[\w.-]+$/.test(seg));
}

/** `/assets/projects/p_x/a.png` → `projects/p_x/a.png`；不合法返回 null */
export function assetNameOf(src: string): string | null {
  if (typeof src !== "string" || !src.startsWith("/assets/")) return null;
  const rel = src.slice("/assets/".length);
  return isSafeAssetRel(rel) ? rel : null;
}

/** 站内素材地址（含子目录），不合法的当普通字符串放过 */
export const isAssetSrc = (v: unknown): v is string => typeof v === "string" && !!assetNameOf(v);

/** 相对路径 → 站内地址 */
export const assetUrlOf = (rel: string): string => `/assets/${rel}`;

/**
 * 收集工程里引用的本地素材。
 *
 * 覆盖：自由元素 src、场景 props.src（image 场景）、**自由画布 props.elements[].src**、
 * 背景音乐、**音效轨 audioTracks[].src**。
 * 后两项早先漏了 —— 漏收集的后果不是"少导一张图"，而是删工程时把别的工程还在用的文件删掉、
 * 或导出包里缺音效（v0.98 一并补上）。
 */
export function collectAssetRefs(
  project: Pick<Project, "scenes" | "audio"> & {
    overlays?: Project["overlays"];
    audioTracks?: Project["audioTracks"];
  },
): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (isAssetSrc(v)) out.add(v);
  };
  for (const el of project.overlays ?? []) add(el.src);
  for (const scene of project.scenes) {
    // 兼容迁移前的旧数据
    for (const el of scene.elements ?? []) add(el.src);
    const props = scene.props as Record<string, unknown> | undefined;
    if (!props) continue;
    add(props.src);
    // 自由画布的元素都在 props.elements 里，每个都有自己的 src / imageSrc / videoSrc / audioSrc
    const fcs = Array.isArray(props.elements) ? props.elements : [];
    for (const el of fcs as Record<string, unknown>[]) {
      add(el?.src);
      add(el?.imageSrc);
      add(el?.videoSrc);
      add(el?.audioSrc);
    }
  }
  add(project.audio?.src);
  for (const track of project.audioTracks ?? []) add(track.src);
  return [...out];
}

/**
 * zip 条目名 → 安全素材相对路径；不合法返回 null。
 * 接受 `assets/<rel>`（rel 可带子目录），但每段都要过硬校验，挡掉 ../ 与隐藏文件。
 */
export function assetFileFromEntry(entryName: string): string | null {
  const m = /^assets\/(.+)$/.exec(entryName);
  if (!m) return null;
  return isSafeAssetRel(m[1]) ? m[1] : null;
}
