import type { Op } from "@shared/ops";
import type { Project } from "@shared/schema";
import type { CustomAsset } from "@shared/assetLibrary";

export type OpResponse = {
  project: Project;
  createdSceneIds: string[];
  summary: string[];
};

export type ProjectSummary = {
  id: string;
  name: string;
  rev: number;
  scenes: number;
  /** 文件创建时间（ISO），列表里用来按时间找工程 */
  createdAt?: string;
  /** 最后一次被改的时间（ISO） */
  updatedAt?: string;
};

export async function fetchProjects(): Promise<ProjectSummary[]> {
  const res = await fetch("/api/projects");
  const data = await res.json();
  return data.projects ?? [];
}

/** 上次打开 / 被 agent 编辑过的工程 id；没有或接口失败都返回 null */
export async function fetchLastProject(): Promise<string | null> {
  try {
    const res = await fetch("/api/last-project");
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.id === "string" && data.id ? data.id : null;
  } catch {
    return null;
  }
}

export async function fetchProject(id: string): Promise<Project> {
  const res = await fetch(`/api/projects/${id}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "读取工程失败");
  return data.project;
}

/** 每个浏览器标签页一个 id：用来让服务端回显的广播区分"自己的操作" */
export const CLIENT_ID =
  (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).slice(0, 12);

export async function postOps(
  projectId: string,
  ops: Op[],
  actor: "user" | "agent" = "user",
): Promise<OpResponse> {
  const res = await fetch(`/api/projects/${projectId}/ops`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ops, actor, clientId: CLIENT_ID }),
    // 必须有超时：写请求在客户端是**串行排队**的，一个永不返回的请求会把后面所有编辑
    // 一起卡住（服务端事件循环被挂死时就是这样）。超时后 apply 会报错并放行队列。
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "操作失败");
  return data;
}

export async function fetchSceneTypes() {
  const res = await fetch("/api/scene-types");
  return (await res.json()).types as {
    type: string;
    name: string;
    category?: string;
    summary: string;
    duration: { default: number; min: number; max: number };
    fields: any[];
  }[];
}

export async function requestStills(projectId: string, frame: number, formats?: string[]) {
  const res = await fetch(`/api/projects/${projectId}/stills`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ frame, formats }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "截图失败");
  return data.stills as { format: string; url: string; frame: number }[];
}

export async function requestRender(
  projectId: string,
  formats?: string[],
  quality?: "low" | "standard" | "high",
  format?: "mp4" | "gif" | "webm",
) {
  const res = await fetch(`/api/projects/${projectId}/render`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ formats, quality, format }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "提交渲染失败");
  return data.task as { id: string; status: string; progress: number };
}

export async function fetchTask(taskId: string) {
  const res = await fetch(`/api/tasks/${taskId}`);
  const data = await res.json();
  return data.task;
}

export async function cancelRender(taskId: string): Promise<void> {
  const res = await fetch(`/api/tasks/${taskId}/cancel`, { method: "POST" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "取消失败");
}

export async function deleteProject(id: string): Promise<void> {
  const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "删除失败");
}

export async function duplicateProject(id: string, name?: string): Promise<Project> {
  const res = await fetch(`/api/projects/${id}/duplicate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "复制失败");
  return data.project;
}

export async function createProject(name: string): Promise<{ id: string }> {
  const res = await fetch("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "新建失败");
  return data.project;
}

export async function uploadAsset(projectId: string, file: File): Promise<{ url: string }> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`/api/projects/${projectId}/assets`, { method: "POST", body: form });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "上传失败");
  return data;
}

export type HistoryEntry = {
  rev: number;
  at: string;
  actor: string;
  summary: string[];
  ops: string[];
  /** 磁盘上还有这个 rev 的快照，前端才显示「回滚」 */
  snapshot?: boolean;
};

/** 回滚到某个 rev（服务端从磁盘快照恢复） */
export async function restoreRevision(projectId: string, rev: number): Promise<Project> {
  const res = await fetch(`/api/projects/${projectId}/restore/${rev}`, { method: "POST" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "回滚失败");
  return data.project;
}

/* ────────────────────────── 我的素材 ────────────────────────── */

export async function fetchLibrary(): Promise<CustomAsset[]> {
  const res = await fetch("/api/library");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "读取素材库失败");
  return data.items ?? [];
}

/** 上传前先在浏览器里量出像素尺寸：服务端不引图片解析库，索引里也要有 w/h 才能算默认摆放尺寸 */
async function measure(
  file: File,
): Promise<{ w?: number; h?: number; duration?: number }> {
  if (file.type.startsWith("video/") || file.type.startsWith("audio/")) {
    return await new Promise((resolve) => {
      const isAudio = file.type.startsWith("audio/");
      const video = document.createElement(isAudio ? "audio" : "video") as HTMLVideoElement;
      const url = URL.createObjectURL(file);
      let settled = false;
      const done = (out: { w?: number; h?: number; duration?: number }) => {
        if (settled) return;
        settled = true;
        URL.revokeObjectURL(url);
        video.src = "";
        resolve(out);
      };
      video.preload = "metadata";
      video.onloadedmetadata = () =>
        done({
          w: video.videoWidth || undefined,
          h: video.videoHeight || undefined,
          duration: Number.isFinite(video.duration) ? video.duration : undefined,
        });
      video.onerror = () => done({});
      video.src = url;
      setTimeout(() => done({}), 4000);
    });
  }
  try {
    const bmp = await createImageBitmap(file);
    const out = { w: bmp.width, h: bmp.height };
    bmp.close?.();
    return out;
  } catch {
    return {};
  }
}

/**
 * 生成列表缩略图（长边 320px，webp）。
 * 大图直接当缩略图会让素材面板加载一堆 4K 原图；浏览器里缩好比服务端省事（不引 sharp）。
 * 失败就返回 null，退回用原图，不阻塞上传。
 */
async function makeThumb(file: File, max = 320): Promise<Blob | null> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bmp.close?.();
      return null;
    }
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
  } catch {
    return null;
  }
}

export async function uploadLibraryAsset(file: File, name?: string): Promise<CustomAsset> {
  const [dims, thumb] = await Promise.all([measure(file), makeThumb(file)]);
  const form = new FormData();
  form.append("file", file);
  if (thumb) form.append("thumb", thumb, "thumb.webp");
  if (name) form.append("name", name);
  if (dims.w) form.append("w", String(dims.w));
  if (dims.h) form.append("h", String(dims.h));
  if (dims.duration) form.append("duration", String(dims.duration));
  const res = await fetch("/api/library", { method: "POST", body: form });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "上传失败");
  return data.item;
}

export async function renameLibraryAsset(id: string, name: string): Promise<CustomAsset> {
  const res = await fetch(`/api/library/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "重命名失败");
  return data.item;
}

export async function deleteLibraryAsset(id: string): Promise<void> {
  const res = await fetch(`/api/library/${id}`, { method: "DELETE" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "删除失败");
}

/* ────────────────────────────── 工作空间 ────────────────────────────── */

export type WorkspaceDirStatus = {
  name: "data" | "public" | "out";
  /** 代码用的路径（工程目录里） */
  path: string;
  /** 真实落盘位置 */
  real: string;
  /** 是否已迁出去（原位置是链接） */
  linked: boolean;
  files: number;
  bytes: number;
  problem?: string;
};

export type WorkspaceStatus = {
  root: string;
  workspaceDir: string | null;
  dirs: WorkspaceDirStatus[];
  totalBytes: number;
  rootFree: number;
  workspaceFree: number;
};

export type RelocatePlanItem = {
  name: "data" | "public" | "out";
  from: string;
  to: string;
  files: number;
  bytes: number;
  skip: boolean;
  skipReason?: string;
};

export type RelocateResult = {
  dryRun: boolean;
  target: string;
  plan: RelocatePlanItem[];
  moved: { name: string; files: number; bytes: number }[];
  targetFreeBefore: number;
  targetFreeAfter: number;
  warnings: string[];
};

/** 目录浏览（只读）：path 不传 = 盘符列表 */
export type DirListing = {
  path: string | null;
  parent: string | null;
  entries: { name: string; path: string }[];
  free: number;
};

export async function fetchDirs(path?: string): Promise<DirListing> {
  const q = path ? `?path=${encodeURIComponent(path)}` : "";
  const res = await fetch(`/api/fs/dirs${q}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "读取目录失败");
  return data;
}

export async function fetchWorkspace(): Promise<WorkspaceStatus> {
  const res = await fetch("/api/workspace");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "读取工作空间失败");
  return data;
}

/** 迁移 data/public/out；dryRun 只出方案 */
export async function relocateWorkspace(dir: string, dryRun = false): Promise<RelocateResult> {
  const res = await fetch("/api/workspace/relocate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir, dryRun }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "迁移失败");
  return data;
}

/** 搬回工程目录 */
export async function resetWorkspace(dryRun = false): Promise<RelocateResult> {
  const res = await fetch("/api/workspace/reset", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dryRun }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "搬回失败");
  return data;
}

export type AssetCleanupResult = {
  scanned: number;
  removed: number;
  freedBytes: number;
  dryRun: boolean;
  removedDirs: string[];
};

/** 清理 public/assets 里没有任何引用的文件 */
export async function cleanupAssets(opts: { dryRun?: boolean } = {}): Promise<AssetCleanupResult> {
  const res = await fetch("/api/assets/cleanup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "清理素材失败");
  return data;
}

/* ────────────────────── 本工程素材（assets/projects/<id>/）────────────────────── */

export type ProjectAsset = {
  name: string;
  url: string;
  rel: string;
  kind: "image" | "video" | "audio" | "file";
  bytes: number;
  at: number;
  /** 是否仍被本工程 project.json 引用 */
  referenced: boolean;
};

export async function fetchProjectAssets(projectId: string): Promise<ProjectAsset[]> {
  const res = await fetch(`/api/projects/${projectId}/assets`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "读取工程素材失败");
  return data.items ?? [];
}

/** 上传到**本工程目录**（与「我的素材」库分开：删工程会一起清掉） */
export async function uploadProjectAsset(projectId: string, file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`/api/projects/${projectId}/assets`, { method: "POST", body: form });
  const data = await res.json();
  if (!res.ok || !data.url) throw new Error(data.error ?? "上传失败");
  return data.url as string;
}

/** 批量删工程素材（面板多选）。被引用的也会删，但会回报数量（画面会裂图） */
export async function deleteProjectAssets(
  projectId: string,
  names: string[],
): Promise<{ deleted: number; wasReferenced: number; freedBytes: number; missing: string[] }> {
  const res = await fetch(`/api/projects/${projectId}/assets/delete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ names }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "批量删除失败");
  return data;
}

/** 批量删「我的素材」条目 */
export async function deleteLibraryAssets(
  ids: string[],
): Promise<{ deleted: number; reclaimed: number; missing: string[] }> {
  const res = await fetch("/api/library/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "批量删除失败");
  return data;
}

export async function deleteProjectAsset(
  projectId: string,
  target: { url?: string; name?: string },
): Promise<{ wasReferenced: boolean }> {
  const q = target.url
    ? `url=${encodeURIComponent(target.url)}`
    : `name=${encodeURIComponent(target.name ?? "")}`;
  const res = await fetch(`/api/projects/${projectId}/assets?${q}`, { method: "DELETE" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "删除失败");
  return { wasReferenced: !!data.wasReferenced };
}

/* ────────────────────────────── 模板市场 ────────────────────────────── */

export type TemplateInfo = {
  key: string;
  name: string;
  description: string;
  tags: string[];
  sceneCount: number;
  durationInFrames: number;
  sceneTypes: string[];
  /** builtin = 内置手写模板；custom = 用户存的「我的模板」 */
  kind: "builtin" | "custom";
};

export async function fetchTemplates(): Promise<TemplateInfo[]> {
  const res = await fetch("/api/templates");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "读取模板失败");
  return data.templates ?? [];
}

/** 套用模板：内置传 templateKey，自定义传 templateId */
export async function createProjectFromTemplate(
  tpl: Pick<TemplateInfo, "key" | "kind">,
  name?: string,
): Promise<Project> {
  const body =
    tpl.kind === "custom" ? { templateId: tpl.key, name } : { templateKey: tpl.key, name };
  const res = await fetch("/api/projects/from-template", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "套用模板失败");
  return data.project;
}

/** 把工程存成「我的模板」，返回最新的模板列表 */
export async function saveTemplate(
  projectId: string,
  name: string,
  description?: string,
): Promise<TemplateInfo[]> {
  const res = await fetch("/api/templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, name, description }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "保存模板失败");
  return data.templates ?? [];
}

export async function deleteTemplate(id: string): Promise<void> {
  const res = await fetch(`/api/templates/${id}`, { method: "DELETE" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "删除模板失败");
}

/** 重命名「我的模板」，返回最新模板列表 */
export async function renameTemplate(id: string, name: string): Promise<TemplateInfo[]> {
  const res = await fetch(`/api/templates/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "重命名模板失败");
  return data.templates ?? [];
}

/* ────────────────────────────── 字幕 ────────────────────────────── */

/** 导出字幕并触发浏览器下载 */
export async function downloadSubtitles(
  id: string,
  filename: string,
  format: "srt" | "vtt" = "srt",
): Promise<number> {
  const res = await fetch(`/api/projects/${id}/subtitles?format=${format}`);
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? "导出字幕失败");
  }
  const text = await res.text();
  // 服务端返回的是文本附件；这里判断内容是不是真的为空
  if (!text.trim() || text.trim() === "WEBVTT") {
    throw new Error("工程里还没有字幕：给场景写 subtitle，或用 caption 版式");
  }
  const blob = new Blob([text], {
    type: format === "vtt" ? "text/vtt;charset=utf-8" : "application/x-subrip;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(format) ? filename : `${filename}.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  const count = (text.match(/-->/g) ?? []).length;
  return count;
}

/* ────────────────────────────── 工程包（zip） ────────────────────────────── */

/** 导出整包并触发浏览器下载 */
export async function downloadProjectBundle(id: string, filename: string): Promise<void> {
  const res = await fetch(`/api/projects/${id}/export`);
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? "导出失败");
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".zip") ? filename : `${filename}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function importProjectBundle(file: File): Promise<Project> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/projects/import", { method: "POST", body: form });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "导入失败");
  return data.project;
}

/* ────────────────────────────── 产物清理 ────────────────────────────── */

export type CleanupResult = {
  scanned: number;
  removedVideos: number;
  removedStills: number;
  removedFiles: number;
  freedBytes: number;
  keptVideos: number;
  dryRun: boolean;
};

export async function cleanupOutputs(
  opts: { keepVideos?: number; stillsDays?: number; projectId?: string } = {},
): Promise<CleanupResult> {
  const res = await fetch("/api/outputs/cleanup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "清理失败");
  return data;
}

export async function fetchHistory(projectId: string): Promise<HistoryEntry[]> {
  const res = await fetch(`/api/projects/${projectId}/history`);
  const data = await res.json();
  return data.entries ?? [];
}

/* ───────────── 渲染产物（多选删除） ───────────── */

export type OutputEntry = {
  /** 相对 out/ 的路径（projects/<工程id>/videos/x.mp4），删除时用它 */
  path: string;
  name: string;
  url: string;
  kind: "video" | "still" | "subtitle";
  size: number;
  mtimeMs: number;
  projectId: string;
  /** 工程还在 → 名字；工程已删 → null（孤儿产物） */
  projectName: string | null;
};

export async function fetchOutputs(): Promise<OutputEntry[]> {
  const res = await fetch("/api/outputs");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "读取产物失败");
  return data.files ?? [];
}

export async function deleteOutputFiles(
  paths: string[],
): Promise<{ deleted: number; freedBytes: number; missing: number }> {
  const res = await fetch("/api/outputs/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "删除失败");
  return data;
}

/** 重置示例工程（demo 不允许删除） */
export async function resetDemoProject(): Promise<Project> {
  const res = await fetch("/api/projects/demo/reset", { method: "POST" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "重置失败");
  return data.project;
}

/* ───────────── 文本转语音（TTS） ───────────── */

export type TtsConfig = {
  endpoint: string;
  apiKey: string;
  model: string;
  voice: string;
  format: "mp3" | "wav" | "ogg";
  speed: number;
  instruct: string;
  language: string;
  customBody: string;
};

export async function fetchTtsConfig(): Promise<TtsConfig> {
  const res = await fetch("/api/tts/config");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "读取语音配置失败");
  return data.config;
}

export async function saveTtsConfig(patch: Partial<TtsConfig>): Promise<TtsConfig> {
  const res = await fetch("/api/tts/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "保存语音配置失败");
  return data.config;
}

export async function ttsSynthesize(
  text: string,
  opts: { voice?: string; speed?: number; instruct?: string; projectId?: string } = {},
): Promise<{ url: string; bytes: number; format: string }> {
  const res = await fetch("/api/tts/synthesize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text,
      voice: opts.voice,
      speed: opts.speed,
      instruct: opts.instruct,
      // 给了工程就落进 assets/projects/<id>/；试听不传 → _preview
      projectId: opts.projectId,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "语音合成失败");
  return data;
}

/** 音色列表（Qwen3-TTS 等本地服务的 /speakers） */
export async function fetchTtsSpeakers(): Promise<Record<string, string>> {
  const res = await fetch("/api/tts/speakers");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "获取音色失败");
  return (data.speakers ?? {}) as Record<string, string>;
}

export async function ttsTest(): Promise<{ ok: boolean; url: string; bytes: number }> {
  const res = await fetch("/api/tts/test", { method: "POST" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "连接测试失败");
  return data;
}

/* ───────────── 音频响度 / 动态压缩（编辑器按钮用，与 MCP 同一套服务端实现） ───────────── */

export type LoudnessResult = {
  src: string;
  durationSec: number;
  lufs: number;
  peakDb: number;
  rmsDb: number;
  curve: number[];
  stepMs: number;
  cached: boolean;
};

/** 测一段素材的 LUFS / 峰值（服务端有缓存，重复调基本是 0ms） */
export async function fetchLoudness(src: string, opts: { force?: boolean } = {}): Promise<LoudnessResult> {
  const res = await fetch("/api/audio/loudness", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ src, force: opts.force }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "响度测量失败");
  return data.result as LoudnessResult;
}

export type CompressResult = {
  curve: { stepMs: number; values: number[]; targetLufs: number; ratio: number };
  measured: { lufs: number; peakDb: number; rmsDb: number };
  stats: { min: number; max: number; avg: number };
};

/** 生成压缩增益曲线（服务端算，浏览器只负责把曲线写进工程） */
export async function fetchCompressCurve(
  src: string,
  opts: { targetLufs?: number; ratio?: number; maxGainDb?: number; maxCutDb?: number } = {},
): Promise<CompressResult> {
  const res = await fetch("/api/audio/compress", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ src, ...opts }),
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "生成压缩曲线失败");
  return data.result as CompressResult;
}
