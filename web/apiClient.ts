import type { Op } from "@shared/ops";
import type { Project } from "@shared/schema";
import type { CustomAsset } from "@shared/assetLibrary";

export type OpResponse = {
  project: Project;
  createdSceneIds: string[];
  summary: string[];
  /** 软冲突：这笔是基于旧 rev 算的，服务端已按语义合并（见 store.apply 的提示） */
  revMismatch?: { expected: number; actual: number };
};

/**
 * 统一超时 + GET 自动重试。
 *
 * 浏览器对同一 host 的 HTTP/1.1 连接上限只有 6 条，且整个浏览器（所有标签页）共享。
 * SSE、视频/音频元素、预览素材都是长连接：旧标签页开得多时连接池会被占满，此时
 * 新的 fetch 不报错也不超时，**无限排队** —— 界面上就是「模板加载中」永远不结束、
 * 点哪儿都没反应、刷新也要抢连接。所以所有请求必须带超时：最多 15 秒就当失败处理，
 * GET 隔 800ms 自动重试一次，服务端一恢复页面就自愈，不用用户反复刷新。
 */
async function jfetch(
  url: string,
  init: RequestInit = {},
  { timeout = 15000, retries = 0 } = {},
): Promise<Response> {
  const isGet = !init.method || init.method === "GET";
  const maxTries = isGet ? 1 + retries : 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxTries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 800));
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export type ProjectSummary = {
  id: string;
  name: string;
  rev: number;
  scenes: number;
  /** 文件创建时间（ISO），列表里用来按时间找工程 */
  createdAt?: string;
  /** 最后一次被改的时间（ISO） */
  updatedAt?: string;
  /**
   * 归档时间（ISO）：有值 = 已归档，默认不出现在切换面板的主列表里。
   * 归档只写 data/archive.json，**不动工程文件**，所以 rev / 内容都不变。
   */
  archivedAt?: string;
};

export async function fetchProjects(): Promise<ProjectSummary[]> {
  const res = await jfetch("/api/projects", {}, { retries: 2 });
  const data = await res.json();
  return data.projects ?? [];
}

/** 上次打开 / 被 agent 编辑过的工程 id；没有或接口失败都返回 null */
export async function fetchLastProject(): Promise<string | null> {
  try {
    const res = await jfetch("/api/last-project", {}, { retries: 2 });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.id === "string" && data.id ? data.id : null;
  } catch {
    return null;
  }
}

export async function fetchProject(id: string): Promise<Project> {
  const res = await jfetch(`/api/projects/${id}`, {}, { retries: 2 });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "读取工程失败");
  return data.project;
}

/** 每个浏览器标签页一个 id：用来让服务端回显的广播区分"自己的操作" */
export const CLIENT_ID =
  (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).slice(0, 12);

let opSeq = 0;
/** "没等到响应"（超时/被中断）——只有这类错误值得重试，4xx/5xx 是明确答复 */
const isNoResponse = (err: unknown) =>
  err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError");

export async function postOps(
  projectId: string,
  ops: Op[],
  actor: "user" | "agent" = "user",
  /**
   * 客户端算这批 ops 时看到的 rev。
   *
   * 带上它 + softRev，服务端就能发现"agent 在这期间改过"，并在回执里说明，
   * 而不是让后写的一方静默覆盖。注意只是**告知**：ops 是语义化的，照常合并。
   */
  expectedRev?: number,
): Promise<OpResponse> {
  /**
   * 幂等键：一次逻辑写入 = 一个 opId，重试时不变。
   *
   * 为什么要它才能重试：超时有两种情况——请求根本没到，或者**到了、也写库了，但响应没回来**。
   * 后者若是简单地重发一次，`add_element` 就会变成两个元素、`add_keyframe` 会覆盖成两次。
   * 服务端按 opId 去重之后，重发是安全的。
   */
  const opId = `${CLIENT_ID}:${++opSeq}`;
  const body = JSON.stringify({
    ops,
    actor,
    clientId: CLIENT_ID,
    opId,
    ...(expectedRev === undefined ? {} : { expectedRev, softRev: true }),
  });
  /**
   * 超时 8 秒、最多试 3 次。本地写盘通常 <100ms，8 秒还没响应基本是连接被占满
   * （同 host 6 条连接被 SSE/预览占着）或服务端在跑重活。重试能自愈掉绝大多数瞬时拥塞，
   * 而 20 秒一次、失败就报红，用户只能看到一句看不懂的 "signal timed out"。
   */
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 1200));
    try {
      const res = await fetch(`/api/projects/${projectId}/ops`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        // 必须有超时：写请求在客户端是**串行排队**的，一个永不返回的请求会把后面所有编辑
        // 一起卡住（服务端事件循环被挂死时就是这样）。超时后 apply 会报错并放行队列。
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "操作失败");
      return data;
    } catch (err) {
      lastErr = err;
      if (!isNoResponse(err)) throw err;
    }
  }
  const e = new Error("保存超时：服务端 8 秒没有响应（已自动重试 3 次）");
  (e as Error & { cause?: unknown }).cause = lastErr;
  throw e;
}

export async function fetchSceneTypes() {
  const res = await jfetch("/api/scene-types", {}, { retries: 2 });
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

/** 渲染任务（agent 起的也算）：编辑器用它显示「谁在渲哪个工程」 */
export type RenderTaskLite = {
  id: string;
  projectId: string;
  projectName?: string;
  status: "queued" | "bundling" | "rendering" | "done" | "error" | "cancelled";
  progress: number;
  formats: string[];
  currentFormat?: string;
  outputs: { format: string; url: string }[];
  error?: string;
  createdAt: number;
  updatedAt?: number;
};

export async function fetchTasks(): Promise<RenderTaskLite[]> {
  const res = await fetch("/api/tasks");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "读取渲染任务失败");
  return (data.tasks ?? []) as RenderTaskLite[];
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

/**
 * 归档 / 取消归档：**不删任何文件**，只是让它从切换面板的主列表里消失。
 * 和删除的区别要跟用户说清楚——归档可逆，删除不可逆。
 */
export async function archiveProject(id: string, archived = true, note?: string): Promise<void> {
  const res = await fetch(`/api/projects/${id}/archive`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ archived, note }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? (archived ? "归档失败" : "取消归档失败"));
}

export async function duplicateProject(id: string, name?: string): Promise<Project> {
  const res = await jfetch(
    `/api/projects/${id}/duplicate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    },
    { timeout: 30000 },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "复制失败");
  return data.project;
}

export async function createProject(name: string): Promise<{ id: string }> {
  const res = await jfetch(
    "/api/projects",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    },
    { timeout: 30000 },
  );
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
  const res = await jfetch("/api/templates", {}, { retries: 2 });
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
  const res = await jfetch(
    "/api/projects/from-template",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    { timeout: 30000 },
  );
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
  kind: "video" | "still" | "subtitle" | "preview" | "cover";
  size: number;
  mtimeMs: number;
  projectId: string;
  /** 工程还在 → 名字；工程已删 → null（孤儿产物） */
  projectName: string | null;
  /** 已锁定：自动清理跳过它（手动删仍然可以） */
  locked?: boolean;
};

/** 产物列表。传 projectId 只取那个工程的（顶栏浮框用）；不传是全库（清理弹窗用） */
export async function fetchOutputs(projectId?: string): Promise<OutputEntry[]> {
  const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  const res = await fetch(`/api/outputs${qs}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "读取产物失败");
  return data.files ?? [];
}

/** 锁定/解锁一条产物：锁定后自动清理会跳过它 */
export async function setOutputLock(path: string, locked: boolean): Promise<void> {
  const res = await fetch("/api/outputs/lock", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, locked }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error ?? "锁定失败");
  }
}

/* ───────────── 时间码批注 ───────────── */

export type Annotation = {
  id: string;
  sceneId: string;
  /** 幕内帧：全局帧会随别的幕改时长整体错位，这个不会 */
  frameInScene: number;
  frameAtCreate: number;
  text: string;
  actor: "user" | "agent";
  at: string;
  resolved: boolean;
  resolvedAt?: string;
};

export async function fetchAnnotations(projectId: string): Promise<Annotation[]> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/annotations`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? "读取批注失败");
  return (data as { annotations?: Annotation[] }).annotations ?? [];
}

export async function addAnnotation(
  projectId: string,
  input: { sceneId: string; frameInScene: number; text: string; frameAtCreate: number },
): Promise<Annotation> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/annotations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? "保存批注失败");
  return (data as { annotation: Annotation }).annotation;
}

export async function resolveAnnotations(
  projectId: string,
  ids: string[],
  resolved = true,
): Promise<{ changed: number; remaining: number }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/annotations/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids, resolved }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? "更新批注失败");
  return data as { changed: number; remaining: number };
}

export async function deleteAnnotation(projectId: string, id: string): Promise<void> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/annotations/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error ?? "删除批注失败");
  }
}

/* ───────────── 运行日志（工具调用） ───────────── */

export type ToolCallEntry = {
  ts: string;
  tool: string;
  args: string;
  ms: number;
  ok: boolean;
  error?: string;
};

export type ToolCallLog = {
  calls: ToolCallEntry[];
  total: number;
  stats: {
    days: number;
    total: number;
    failed: number;
    /** 按调用次数降序 */
    byTool: { tool: string; calls: number; failed: number; avgMs: number; p95Ms: number }[];
    topErrors: { tool: string; error: string; count: number }[];
  };
};

export async function fetchToolLog(limit = 150, days = 1): Promise<ToolCallLog> {
  const res = await fetch(`/api/tool-log?limit=${limit}&days=${days}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? "读取运行日志失败");
  return data as ToolCallLog;
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

/** 重置示例工程（demo / demo3d 不允许删除） */
export async function resetDemoProject(projectId = "demo"): Promise<Project> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/reset`, { method: "POST" });
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

/* ───────────── 本地资源库（文件留在用户自己的目录，引用直出，不复制） ───────────── */

export type ResourceCategory = {
  id: string;
  label: string;
  exts: string[];
  dir: string | null;
};

export type ResourceEntry = {
  name: string;
  dir: boolean;
  size?: number;
  mtime?: number;
  url?: string;
};

export type ResourceBrowse = {
  root: string;
  path: string;
  parent: string | null;
  entries: ResourceEntry[];
};

export type ResourceHit = {
  name: string;
  rel: string;
  abs: string;
  size: number;
  mtime: number;
  url: string;
};

export async function fetchResourcesConfig(): Promise<{
  origin: string;
  categories: ResourceCategory[];
}> {
  const res = await jfetch("/api/resources/config");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "读不到资源库配置");
  return data;
}

export async function saveResourceDir(category: string, dir: string): Promise<{ ok: true; dir: string }> {
  const res = await jfetch("/api/resources/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ category, dir }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "保存失败");
  return data;
}

export async function browseResources(category: string, sub = ""): Promise<ResourceBrowse> {
  const res = await jfetch("/api/resources/browse", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ category, sub }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "浏览失败");
  return data;
}

export async function searchResources(
  category: string,
  opts: { keyword?: string; ext?: string[]; limit?: number } = {},
): Promise<{ root: string; total: number; truncated: boolean; hits: ResourceHit[] }> {
  const res = await jfetch("/api/resources/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ category, ...opts }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "搜索失败");
  return data;
}

/** 站内 /resources/… 引用 → 缩略图接口（M1 直接流原图） */
export const resourceThumbUrl = (url: string): string =>
  `/api/resources/thumb?p=${encodeURIComponent(url)}`;

/** 目录选择器：从盘符逐级往下走。path 为空 = 列盘符 */
export async function pickResourceDir(
  path = "",
): Promise<{ path: string; parent: string | null; entries: { name: string; dir: true; path: string }[] }> {
  const res = await jfetch("/api/resources/pick", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "浏览目录失败");
  return data;
}

/** 清除某类的目录配置（dir 传空即清除，幂等） */
export async function clearResourceDir(category: string): Promise<{ ok: true; dir: null }> {
  const res = await jfetch("/api/resources/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ category, dir: null }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "清除失败");
  return data;
}
