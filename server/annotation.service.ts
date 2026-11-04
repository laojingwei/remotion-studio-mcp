/**
 * 时间码批注：用户在编辑器里对**某一帧**留的意见。
 *
 * 为什么需要：`request_review` 原来只能收一整段文字（"第 3 幕有点怪"），
 * agent 得自己去猜是哪一帧、是转场还是字幕。复盘里"同一个转场改了 4 轮"
 * 就是这种模糊反馈的代价。批注把「哪一幕 + 第几帧 + 原话」钉死，agent 拿着
 * `preview_frames(sceneId, frames=[N])` 就能直接看到用户说的那一帧。
 *
 * 存储取舍：
 *  - 落 `data/projects/<id>/annotations.json`，不塞 project.json —— 批注是
 *    工作过程中的对话，不是工程内容，不该跟着工程导出/回滚，也不该让每次
 *    保存工程都重写一遍。
 *  - 记**幕内帧**而不是全局帧：别的幕改了时长，全局帧会整体错位，幕内帧不会。
 *    另存一份 `createdAt` 时的全局帧只用于排序参考，定位一律以幕内帧为准。
 *  - 上限 200 条：再多说明这轮该重做了，留着也读不完。
 */
import fs from "node:fs";
import path from "node:path";
import { PROJECTS_ROOT } from "./paths";
import { writeJsonAtomic } from "./store";

export type Annotation = {
  id: string;
  /** 幕 id：定位用，比"第 3 幕"可靠（幕可能被重排） */
  sceneId: string;
  /** 幕内帧（0 起）。跨幕改动不影响它 */
  frameInScene: number;
  /** 留批注那一刻的全局帧，仅作参考/排序 */
  frameAtCreate: number;
  text: string;
  actor: "user" | "agent";
  at: string;
  resolved: boolean;
  resolvedAt?: string;
};

type Store = { annotations: Annotation[] };

const MAX = 200;

/** 工程 id 只可能是这种东西；挡掉 `../` 之类的路径穿越 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const fileOf = (projectId: string) => {
  if (!SAFE_ID.test(projectId)) throw new Error(`工程 id 不合法：${projectId}`);
  return path.join(PROJECTS_ROOT, projectId, "annotations.json");
};

function readStore(projectId: string): Store {
  // 先校验 id：放在 try 里面会被后面的 catch 吞掉，"路径穿越"就变成"读到空批注"了
  const file = fileOf(projectId);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Store>;
    return { annotations: Array.isArray(parsed.annotations) ? parsed.annotations : [] };
  } catch {
    // 没有文件 / 文件坏了都当空——批注丢了不该让编辑器打不开
    return { annotations: [] };
  }
}

function writeStore(projectId: string, store: Store): void {
  const file = fileOf(projectId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, store);
}

const newId = () => `an_${Math.random().toString(36).slice(2, 10)}`;

export function listAnnotations(projectId: string): Annotation[] {
  // 按幕内帧排序会让跨幕顺序变乱（服务层不知道幕顺序），所以保持写入顺序，
  // 由调用方（MCP 工具/前端）按工程的实际幕序重排
  return readStore(projectId).annotations.slice();
}

export function openAnnotationCount(projectId: string): number {
  return readStore(projectId).annotations.filter((a) => !a.resolved).length;
}

export function addAnnotation(
  projectId: string,
  input: {
    sceneId: string;
    frameInScene: number;
    text: string;
    actor?: "user" | "agent";
    frameAtCreate?: number;
  },
): Annotation {
  const text = String(input.text ?? "").trim().slice(0, 1000);
  if (!text) throw new Error("批注内容不能为空");
  if (!input.sceneId) throw new Error("缺少 sceneId（这条批注要挂在某一幕上）");

  const store = readStore(projectId);
  const item: Annotation = {
    id: newId(),
    sceneId: String(input.sceneId),
    frameInScene: Math.max(0, Math.round(Number(input.frameInScene) || 0)),
    frameAtCreate: Math.max(0, Math.round(Number(input.frameAtCreate) || 0)),
    text,
    actor: input.actor === "agent" ? "agent" : "user",
    at: new Date().toISOString(),
    resolved: false,
  };
  // 超出上限时先丢最老的**已解决**条目，还满才丢最老的一条
  let list = store.annotations.concat(item);
  while (list.length > MAX) {
    const idx = list.findIndex((a) => a.resolved);
    list = list.filter((_, i) => i !== (idx >= 0 ? idx : 0));
  }
  writeStore(projectId, { annotations: list });
  return item;
}

export function resolveAnnotations(
  projectId: string,
  ids: string[],
  resolved = true,
): { changed: number; remaining: number } {
  const want = new Set(ids.filter(Boolean));
  const store = readStore(projectId);
  let changed = 0;
  for (const a of store.annotations) {
    if (!want.has(a.id)) continue;
    if (a.resolved === resolved) continue;
    a.resolved = resolved;
    if (resolved) a.resolvedAt = new Date().toISOString();
    else delete a.resolvedAt;
    changed++;
  }
  if (changed) writeStore(projectId, store);
  return { changed, remaining: store.annotations.filter((a) => !a.resolved).length };
}

export function deleteAnnotation(projectId: string, id: string): boolean {
  const store = readStore(projectId);
  const next = store.annotations.filter((a) => a.id !== id);
  if (next.length === store.annotations.length) return false;
  writeStore(projectId, { annotations: next });
  return true;
}

/** 工程被删时顺手清掉批注文件（调用方已在删整个目录则可忽略） */
export function removeProjectAnnotations(projectId: string): void {
  try {
    fs.unlinkSync(fileOf(projectId));
  } catch {
    /* 本来就没有 */
  }
}
