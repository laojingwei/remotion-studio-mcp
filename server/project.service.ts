import type { Project } from "../shared/schema";
import { applyOps, type Op, type OpResult } from "../shared/ops";
import { deleteProjectDir, listProjectIds, listSnapshots, projectFileTimes, readProject, readSnapshot, writeLastProjectId, writeProject } from "./store";

type Listener = (event: BroadcastEvent) => void;

export type BroadcastEvent =
  | {
      type: "project:patched";
      projectId: string;
      rev: number;
      ops: Op[];
      sceneIds?: string[];
      summary: string[];
      /** 操作来源，前端用来区分"我改的"与"agent 改的" */
      actor: string;
      /** 发起操作的客户端 id，用来只忽略自己那一次回声 */
      clientId?: string;
      project: Project;
    }
  | {
      /** 工程被删除，前端应关闭订阅并切走 */
      type: "project:deleted";
      projectId: string;
    };

export type HistoryEntry = {
  rev: number;
  at: string;
  actor: string;
  summary: string[];
  ops: string[];
  sceneIds?: string[];
  /** 磁盘上是否还有这个 rev 的快照（有才能回滚） */
  snapshot?: boolean;
};

/**
 * 唯一写入口。
 * Web 编辑器、MCP 代理、渲染服务都只能通过这里改文档，
 * 保证内存状态、磁盘、广播三者一致。
 */
class ProjectService {
  private cache = new Map<string, Project>();
  private listeners = new Map<string, Set<Listener>>();
  private logs = new Map<string, HistoryEntry[]>();

  list(): { id: string; name: string; rev: number; scenes: number; createdAt: string; updatedAt: string; broken?: string }[] {
    // 单个工程读坏了不能连累整个列表（否则健康检查与所有工程一起 500）
    return listProjectIds().map((id) => {
      try {
        const p = this.get(id);
        return { id: p.id, name: p.name, rev: p.rev, scenes: p.scenes.length, ...projectFileTimes(id) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[projects] 读取失败 ${id}：${msg}`);
        return {
          id, name: `⚠️ ${id}（数据损坏）`, rev: -1, scenes: 0,
          createdAt: "", updatedAt: "", broken: msg,
        };
      }
    });
  }

  /**
   * 记住"最近在用的工程"。
   * 打开工程、被 agent 改过都会走到这里，所以重启后能直接回到上次看到的那个。
   */
  touch(id: string): void {
    writeLastProjectId(id);
  }

  get(id: string): Project {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const loaded = readProject(id);
    this.cache.set(id, loaded);
    return loaded;
  }

  /** 删除工程：磁盘目录、内存缓存、历史、广播订阅一起清掉 */
  /** 用一份新文档整体替换（重置 demo 用）：写盘 + 更新缓存 */
  replace(project: Project): Project {
    writeProject(project);
    this.cache.set(project.id, project);
    return project;
  }

  remove(id: string): void {
    if (!listProjectIds().includes(id)) {
      throw Object.assign(new Error("工程不存在"), { status: 404 });
    }
    deleteProjectDir(id);
    this.cache.delete(id);
    this.logs.delete(id);
    const set = this.listeners.get(id);
    if (set) {
      for (const fn of set) {
        try {
          fn({ type: "project:deleted", projectId: id });
        } catch {
          /* 订阅方已断开 */
        }
      }
      this.listeners.delete(id);
    }
  }

  /** 复制工程：内容整份拷贝，新 id、新名字，rev 归零重排 */
  duplicate(id: string, name?: string): Project {
    const src = this.get(id);
    const newId = `p_${Math.random().toString(36).slice(2, 8)}`;
    const copy: Project = {
      ...structuredClone(src),
      id: newId,
      name: name?.trim() || `${src.name} 副本`,
      rev: 1,
      updatedAt: new Date().toISOString(),
    };
    writeProject(copy);
    this.cache.set(newId, copy);
    return copy;
  }

  /** 应用一批操作，返回新文档；rev 冲突时抛 ConflictError */
  apply(
    id: string,
    ops: Op[],
    opts: { expectedRev?: number; actor?: string; clientId?: string } = {},
  ): OpResult {
    const current = this.get(id);
    if (opts.expectedRev !== undefined && opts.expectedRev !== current.rev) {
      const err = new Error(
        `版本冲突：期望 rev=${opts.expectedRev}，当前 rev=${current.rev}。请重新读取文档后再修改。`,
      );
      (err as Error & { status?: number }).status = 409;
      throw err;
    }

    const result = applyOps(current, ops);
    this.cache.set(id, result.project);
    writeProject(result.project);

    const entry: HistoryEntry = {
      rev: result.project.rev,
      at: result.project.updatedAt,
      actor: opts.actor ?? "user",
      summary: result.summary,
      ops: ops.map((o) => o.op),
      sceneIds: result.createdSceneIds,
    };
    const log = this.logs.get(id) ?? [];
    log.unshift(entry);
    this.logs.set(id, log.slice(0, 60));

    this.emit(id, {
      type: "project:patched",
      projectId: id,
      rev: result.project.rev,
      ops,
      sceneIds: result.createdSceneIds,
      summary: result.summary,
      actor: opts.actor ?? "user",
      clientId: opts.clientId,
      project: result.project,
    });

    return result;
  }

  history(id: string): HistoryEntry[] {
    const revs = new Set(listSnapshots(id));
    const entries: HistoryEntry[] = (this.logs.get(id) ?? []).map((log) => ({
      ...log,
      snapshot: revs.has(log.rev),
    }));
    // 服务重启后内存日志没了，但磁盘快照还在：补出来，标成只有快照
    const known = new Set(entries.map((e) => e.rev));
    for (const rev of revs) {
      if (known.has(rev)) continue;
      entries.push({ rev, at: "", actor: "system", summary: ["（只有快照，没有操作记录）"], ops: [], snapshot: true });
    }
    return entries.sort((a, b) => b.rev - a.rev);
  }

  /** 回滚到某个 rev：读磁盘快照，走同一条写入口（会广播给 Web、也能再回滚） */
  restoreRevision(id: string, rev: number): OpResult {
    const snap = readSnapshot(id, rev);
    if (!snap) {
      throw Object.assign(new Error(`找不到 rev ${rev} 的快照（可能已被清理）`), { status: 404 });
    }
    return this.apply(
      id,
      [{ op: "restore", project: snap, label: `回滚到 rev ${rev}` }],
      { actor: "user" },
    );
  }

  subscribe(id: string, listener: Listener): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(listener);
    return () => set!.delete(listener);
  }

  private emit(id: string, event: BroadcastEvent) {
    const set = this.listeners.get(id);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(event);
      } catch {
        /* 单个订阅者异常不影响其他订阅者 */
      }
    }
  }
}

export const projects = new ProjectService();
