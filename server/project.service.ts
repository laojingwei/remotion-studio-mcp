import type { Project } from "../shared/schema";
import { applyOps, type Op, type OpResult } from "../shared/ops";
import { deleteProjectDir, listProjectIds, listSnapshots, projectFileTimes, readProject, readSnapshot, writeLastProjectId, writeProject } from "./store";
import { assertTextureAssets } from "./texture-asset-check";
import { forgetArchived, pruneArchived, readArchive, setArchived } from "./archive.service";
import { frozenSnapshot, hasHook, runHook } from "./plugin/hooks";

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

/** 应用结果；`revMismatch` 只在软冲突时出现（说明这笔是基于旧 rev 改的） */
export type AppliedResult = OpResult & { revMismatch?: { expected: number; actual: number } };

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

  list(): { id: string; name: string; rev: number; scenes: number; createdAt: string; updatedAt: string; broken?: string; archivedAt?: string }[] {
    // 归档标记放在独立的 data/archive.json 里（见 archive.service）：不动工程文件，
    // 坏工程读不出来时也照样能归档。这里一次性读，避免每行都读一遍文件。
    const archive = readArchive();
    // 单个工程读坏了不能连累整个列表（否则健康检查与所有工程一起 500）
    return listProjectIds().map((id) => {
      try {
        const p = this.get(id);
        const row = { id: p.id, name: p.name, rev: p.rev, scenes: p.scenes.length, ...projectFileTimes(id) };
        const at = archive[id]?.at;
        return at ? { ...row, archivedAt: at } : row;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[projects] 读取失败 ${id}：${msg}`);
        const row = {
          id, name: `⚠️ ${id}（数据损坏）`, rev: -1, scenes: 0,
          createdAt: "", updatedAt: "", broken: msg,
        };
        const at = archive[id]?.at;
        return at ? { ...row, archivedAt: at } : row;
      }
    });
  }

  /** 归档 / 取消归档。只写 data/archive.json，不碰工程的任何文件 */
  archive(id: string, on: boolean, note?: string): { archivedAt: string | null } {
    if (!listProjectIds().includes(id)) {
      throw Object.assign(new Error(`工程不存在：${id}（list_projects 查 id）`), { status: 404 });
    }
    const entry = setArchived(id, on, note);
    return { archivedAt: entry?.at ?? null };
  }

  /** 清掉指向已不存在工程的归档项（手动删目录 / 导入失败留下的孤儿） */
  pruneArchive(): number {
    return pruneArchived(listProjectIds());
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
    forgetArchived(id);
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
  /**
   * 写请求幂等缓存：`${projectId}:${opId}` → 上一次的结果。
   *
   * 客户端超时后会重发同一批 ops（网络没响应 ≠ 没写进去）。没有这张表，
   * 重发就等于把 `add_element` 再执行一遍——用户会看到"拖了一个物体，冒出两个"。
   * 只留最近 300 条：够覆盖一次拥塞期间的重试，也不会随工程增长吃内存。
   */
  private opResults = new Map<string, OpResult>();

  apply(
    id: string,
    ops: Op[],
    opts: {
      expectedRev?: number;
      actor?: string;
      clientId?: string;
      opId?: string;
      /**
       * 软冲突：rev 对不上时不拒绝，照常合并，只在回执里说明"你基于旧版本改的"。
       *
       * 为什么需要两种语义：ops 是**语义化**的（update_scene 的 patch 应用到当前文档上
       * 通常仍然正确），硬拒会让人和 agent 交替编辑时频繁弹冲突；但完全不吭声又会
       * 静默覆盖——尤其 update_scene.props.elements 这类整数组替换的 op。
       * 前端要的是"合并且告知"，MCP 侧要的是"严格校验后重读"，所以由调用方选。
       */
      softRevCheck?: boolean;
    } = {},
  ): AppliedResult {
    const idemKey = opts.opId ? `${id}:${opts.opId}` : null;
    if (idemKey) {
      const hit = this.opResults.get(idemKey);
      // 命中 = 上一次其实已经写成功了，只是响应没回到客户端：原样返回，不重复执行
      if (hit) return hit;
    }
    const current = this.get(id);
    let revMismatch: { expected: number; actual: number } | undefined;
    if (opts.expectedRev !== undefined && opts.expectedRev !== current.rev) {
      if (!opts.softRevCheck) {
        const err = new Error(
          `版本冲突：期望 rev=${opts.expectedRev}，当前 rev=${current.rev}。请重新读取文档后再修改。`,
        );
        (err as Error & { status?: number }).status = 409;
        throw err;
      }
      revMismatch = { expected: opts.expectedRev, actual: current.rev };
    }

    // 贴图素材校验（存在性/格式/体积/尺寸）在写库前挡——渲染端加载失败只会静默回退，agent 看不到
    assertTextureAssets(ops);

    /*
     * 插件写入前把关（`ops:before`）：**只给否决权，不给改写权**。
     *
     * 三个必须守住的边界：
     *  1. 否决 = 抛错退出。此时 `applyOps` 还没跑，`current` 没被碰过，
     *     所以 rev 不涨、撤销栈干净、历史里没有这一笔 —— 不用回滚，因为什么都没发生
     *  2. 插件**不能改** op。能改就等于能在落盘前重写用户的工程，且撤销栈里看不出是谁干的
     *  3. 钩子自己抛异常**不拦**（`runHook` 内部已吞掉并记账）——一个坏插件不该让人存不了盘
     */
    let beforeWarnings: string[] = [];
    if (hasHook("ops:before")) {
      const v = runHook("ops:before", {
        before: frozenSnapshot(current) as unknown as Record<string, unknown>,
        ops: frozenSnapshot(ops) as unknown as Record<string, unknown>[],
      });
      if (v.blocking.length) {
        const err = Object.assign(
          new Error(
            `插件拒绝这批写入，工程**未改动**（rev 仍是 ${current.rev}，历史里没有这一笔）：\n` +
              v.blocking.map((x) => `· ${x}`).join("\n") +
              `\n不想被拦就停用对应插件（list_plugins 看是谁，toggle_plugin 关掉）。`,
          ),
          { status: 422 },
        );
        throw err;
      }
      beforeWarnings = v.warnings;
    }

    const result: AppliedResult = applyOps(current, ops);
    if (beforeWarnings.length) result.summary.unshift(...beforeWarnings);

    /*
     * 插件复盘（ops:review）：拿到写入前/后两份快照，只能往回调回执里加文字。
     *
     * 为什么这里只"复盘"不"拦截"：拦截是上面的 `ops:before`。两个钩子分工是硬的——
     * `ops:before` 说"这批别写"，`ops:review` 说"写完了，我看出来这些"。
     * 在这里返回 blocking 已经晚了一步（数据落盘了），所以只能降级成警示并标明"已写入"。
     *
     * 快照只在真有钩子时才拷（结构化克隆整份工程不便宜），没装插件时零开销。
     */
    if (hasHook("ops:review")) {
      const v = runHook("ops:review", {
        before: frozenSnapshot(current) as unknown as Record<string, unknown>,
        after: frozenSnapshot(result.project) as unknown as Record<string, unknown>,
        ops: frozenSnapshot(ops) as unknown as Record<string, unknown>[],
      });
      // blocking 已经被写进去了，无法回滚，只能降级成警示 —— 不假装它能拦
      const lines = [...v.blocking.map((x) => `⚠️ ${x}（已写入，需手动修）`), ...v.warnings];
      if (lines.length) result.summary.push(...lines);
    }
    if (revMismatch) {
      // 合并且告知：不打断用户，但要让回执里能看见"这笔是基于旧版本算的"
      result.summary.unshift(
        `⚠️ 并发修改：这笔操作基于 rev ${revMismatch.expected}，服务端已是 rev ${revMismatch.actual}，已按语义合并。` +
          `整数组替换类的修改（自由画布元素、场景图节点）可能覆盖 agent 刚做的调整，建议刷新后核对。`,
      );
      result.revMismatch = revMismatch;
    }
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

    if (idemKey) {
      this.opResults.set(idemKey, result);
      while (this.opResults.size > 300) {
        const oldest = this.opResults.keys().next().value;
        if (oldest === undefined) break;
        this.opResults.delete(oldest);
      }
    }
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
