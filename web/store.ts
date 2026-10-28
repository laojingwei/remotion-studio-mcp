import { create } from "zustand";
import type { Project } from "@shared/schema";
import type { Op } from "@shared/ops";
import type { CustomAsset } from "@shared/assetLibrary";
import type { TemplateInfo } from "./apiClient";
import {
  CLIENT_ID,
  cleanupAssets as apiCleanupAssets,
  cleanupOutputs as apiCleanupOutputs,
  createProject,
  createProjectFromTemplate,
  deleteLibraryAsset,
  deleteLibraryAssets,
  deleteProject,
  deleteProjectAssets,
  deleteTemplate as apiDeleteTemplate,
  downloadProjectBundle,
  downloadSubtitles,
  duplicateProject,
  fetchLibrary,
  fetchLastProject,
  fetchProject,
  fetchProjectAssets,
  fetchProjects,
  fetchTemplates,
  importProjectBundle as apiImportProjectBundle,
  postOps,
  renameLibraryAsset,
  renameTemplate as apiRenameTemplate,
  restoreRevision as apiRestoreRevision,
  saveTemplate as apiSaveTemplate,
  deleteProjectAsset,
  uploadLibraryAsset,
  uploadProjectAsset,
  type ProjectAsset,
} from "./apiClient";

type Snapshot = Pick<
  Project,
  "scenes" | "theme" | "name" | "audio" | "audioTracks" | "effects"
>;

type ProjectSummary = {
  id: string;
  name: string;
  rev: number;
  scenes: number;
  /** 工程文件的创建时间（ISO），列表里用来按时间找 */
  createdAt?: string;
  /** 最后一次修改时间（ISO） */
  updatedAt?: string;
};

type State = {
  project: Project | null;
  projects: ProjectSummary[];
  selectedId: string | null;
  /** 画布上选中的元素：模板元素 id，或自由元素的 "ov:<id>" */
  selection: string[];
  /** 时间轴上选中的特效区间 id：右栏切成「特效属性」 */
  selectedEffect: string | null;
  /** 「我的素材」：跨工程复用的图片，存在服务端 data/library.json */
  assets: CustomAsset[];
  /** 本工程素材目录（public/assets/projects/<id>/）：删工程一起清 */
  projectAssets: ProjectAsset[];
  /** 整片模板清单（模板市场） */
  templates: TemplateInfo[];
  formatKey: string;
  past: Snapshot[];
  future: Snapshot[];
  toast: string | null;
  flashId: string | null;
  agentActive: boolean;
  error: string | null;
  loading: boolean;

  load: () => Promise<void>;
  loadProject: (id: string) => Promise<void>;
  createNewProject: (name?: string) => Promise<void>;
  createFromTemplate: (tpl: TemplateInfo, name?: string) => Promise<void>;
  /** 把当前工程存成「我的模板」 */
  saveCurrentAsTemplate: (name: string, description?: string) => Promise<void>;
  removeTemplate: (id: string) => Promise<void>;
  /** 重命名「我的模板」 */
  renameTemplate: (id: string, name: string) => Promise<void>;
  loadTemplates: () => Promise<void>;
  deleteCurrentProject: () => Promise<void>;
  duplicateCurrentProject: () => Promise<void>;
  /** 导出当前工程为 .zip 并下载 */
  exportCurrentProject: () => Promise<void>;
  /** 导出字幕（srt / vtt）并下载 */
  exportSubtitles: (format: "srt" | "vtt") => Promise<void>;
  /** 导入 .zip 工程包，成功后切到新工程 */
  importProjectBundle: (file: File) => Promise<void>;
  /** 清理 out/ 里的旧渲染产物 */
  cleanupOutputs: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  loadAssets: () => Promise<void>;
  uploadAsset: (file: File) => Promise<CustomAsset | null>;
  removeAsset: (id: string) => Promise<void>;
  /** 批量删「我的素材」条目 */
  removeAssets: (ids: string[]) => Promise<void>;
  renameAsset: (id: string, name: string) => Promise<void>;
  /** 清理 public/assets 里没有任何引用的文件 */
  cleanupAssets: () => Promise<void>;
  /** 读本工程素材目录 */
  loadProjectAssets: () => Promise<void>;
  /** 上传到本工程目录（不进「我的素材」库，删工程会一起清） */
  uploadToProject: (file: File) => Promise<string | null>;
  removeProjectAsset: (a: { url?: string; name?: string }) => Promise<void>;
  /** 批量删本工程素材文件（按文件名） */
  removeProjectAssets: (names: string[]) => Promise<void>;
  connect: () => void;
  select: (id: string | null) => void;
  setSelection: (ids: string[]) => void;
  /** 选中一条特效（null = 回到场景属性） */
  selectEffect: (id: string | null) => void;
  setFormat: (key: string) => void;
  apply: (ops: Op[], opts?: { snapshot?: boolean }) => Promise<void>;
  /** 回滚到某个 rev（服务端从磁盘快照恢复） */
  restoreRevision: (rev: number) => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  notify: (msg: string) => void;
  clearError: () => void;
};

let toastTimer: ReturnType<typeof setTimeout> | undefined;
let flashTimer: ReturnType<typeof setTimeout> | undefined;
let agentTimer: ReturnType<typeof setTimeout> | undefined;
let es: EventSource | null = null;
/** 写请求串行队列（见 apply 里的说明）：保证同一工程同一时刻只有一笔 op 在飞 */
let applyChain: Promise<void> = Promise.resolve();

const formatBytes = (n: number) => {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(0, Math.round(n / 1024))} KB`;
};

/**
 * 撤销快照。
 *
 * **只存引用，不做深拷贝**：`applyOps` 第一件事就是 `structuredClone(project)`，
 * 任何一次编辑返回的都是全新对象，旧对象从此只读 —— 所以快照共享引用是安全的。
 *
 * 早先这里每个字段都 `structuredClone`：每按一次键就全量克隆一遍 scenes，
 * 再乘上 40 步撤销栈，场景/元素一多就是每次编辑几十毫秒 + 几十 MB 常驻内存。
 * 如果以后有人就地修改 project（`p.scenes[0].name = x`），这条约定就破了 ——
 * 改数据一律走 op。
 */
const snapshotOf = (p: Project): Snapshot => ({
  scenes: p.scenes,
  theme: p.theme,
  name: p.name,
  audio: p.audio,
  audioTracks: p.audioTracks,
  // 归一成数组：`undefined` 在 ops 层表示"老客户端的快照，不知道有没有特效"，
  // 会保留当前特效；这里给 []，撤销才知道"那时候确实一条都没有"
  effects: p.effects ?? [],
});

export const useDoc = create<State>((set, get) => ({
  project: null,
  projects: [],
  selectedId: null,
  selection: [],
  selectedEffect: null,
  assets: [],
  projectAssets: [],
  templates: [],
  formatKey: "landscape",
  past: [],
  future: [],
  toast: null,
  flashId: null,
  agentActive: false,
  error: null,
  loading: true,

  load: async () => {
    set({ loading: true });
    try {
      const [list, lastId] = await Promise.all([fetchProjects(), fetchLastProject()]);
      if (!list.length) {
        const created = await createProject("新项目");
        await get().refreshProjects();
        return get().loadProject(created.id);
      }
      set({ projects: list });
      // 优先回到上次打开/被 agent 改过的工程；它被删了就退回列表第一个
      const target = lastId && list.some((p) => p.id === lastId) ? lastId : list[0].id;
      await get().loadProject(target);
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : "加载失败" });
    }
  },

  loadProject: async (id: string) => {
    try {
      const project = await fetchProject(id);
      set({
        project,
        loading: false,
        selectedId: project.scenes[0]?.id ?? null,
        formatKey: project.formats[0]?.key ?? "landscape",
        past: [],
        future: [],
      });
      get().connect();
      // 工程素材目录跟着工程走：换工程必须重读，否则会显示上一个工程的文件
      void get().loadProjectAssets();
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : "读取工程失败" });
    }
  },

  createNewProject: async (name) => {
    try {
      const created = await createProject(name ?? "新项目");
      await get().refreshProjects();
      await get().loadProject(created.id);
      get().notify("已新建项目");
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "新建失败" });
    }
  },

  createFromTemplate: async (tpl, name) => {
    try {
      const created = await createProjectFromTemplate(tpl, name);
      await get().refreshProjects();
      await get().loadProject(created.id);
      get().notify(`已从模板创建「${created.name}」`);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "套用模板失败" });
    }
  },

  /** 把当前工程存成「我的模板」（整份快照 + 素材打包） */
  saveCurrentAsTemplate: async (name, description) => {
    const project = get().project;
    if (!project) return;
    try {
      const list = await apiSaveTemplate(project.id, name, description);
      set({ templates: list });
      get().notify(`已存为模板「${name}」`);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "保存模板失败" });
    }
  },

  removeTemplate: async (id) => {
    try {
      await apiDeleteTemplate(id);
      await get().loadTemplates();
      get().notify("模板已删除");
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "删除模板失败" });
    }
  },

  renameTemplate: async (id, name) => {
    try {
      const list = await apiRenameTemplate(id, name);
      set({ templates: list });
      get().notify(`模板已改名为「${name}」`);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "重命名模板失败" });
    }
  },

  loadTemplates: async () => {
    try {
      set({ templates: await fetchTemplates() });
    } catch {
      /* 模板读不到不阻塞，只是菜单里少一节 */
    }
  },

  deleteCurrentProject: async () => {
    const project = get().project;
    if (!project) return;
    try {
      if (es) {
        es.close();
        es = null;
      }
      await deleteProject(project.id);
      const list = await fetchProjects();
      // 不在这里把 project 置空：那会让界面闪一下「正在连接本地服务…」。
      // 旧工程先留在画面上，等 loadProject 拿到新工程再整体替换（通常只有几百毫秒）。
      set({ projects: list });
      if (list.length) {
        await get().loadProject(list[0].id);
        get().notify("工程已删除");
      } else {
        // 删到空的时候就顺势建一个，免得界面停在空状态
        const created = await createProject("新项目");
        await get().refreshProjects();
        await get().loadProject(created.id);
        get().notify("工程已删除，已新建空工程");
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "删除失败" });
    }
  },

  duplicateCurrentProject: async () => {
    const project = get().project;
    if (!project) return;
    try {
      const copy = await duplicateProject(project.id);
      await get().refreshProjects();
      await get().loadProject(copy.id);
      get().notify(`已复制为「${copy.name}」`);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "复制失败" });
    }
  },

  exportCurrentProject: async () => {
    const project = get().project;
    if (!project) return;
    try {
      await downloadProjectBundle(project.id, project.name);
      get().notify("工程包已导出（含素材）");
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "导出失败" });
    }
  },

  exportSubtitles: async (format) => {
    const project = get().project;
    if (!project) return;
    try {
      const count = await downloadSubtitles(project.id, project.name, format);
      get().notify(`字幕已导出（${count} 条 · ${format.toUpperCase()}）`);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "导出字幕失败" });
    }
  },

  importProjectBundle: async (file) => {
    try {
      const created = await apiImportProjectBundle(file);
      await get().refreshProjects();
      await get().loadProject(created.id);
      get().notify(`已导入「${created.name}」`);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "导入失败" });
    }
  },

  cleanupOutputs: async () => {
    try {
      const r = await apiCleanupOutputs();
      get().notify(`已清理 ${r.removedFiles} 个旧产物，释放 ${formatBytes(r.freedBytes)}`);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "清理失败" });
    }
  },

  refreshProjects: async () => {
    try {
      set({ projects: await fetchProjects() });
    } catch {
      /* 忽略 */
    }
  },

  loadAssets: async () => {
    try {
      set({ assets: await fetchLibrary() });
    } catch {
      /* 素材库读不到不阻塞主界面：内置 38 个素材照样能用 */
    }
  },

  uploadAsset: async (file: File) => {
    try {
      const item = await uploadLibraryAsset(file);
      set({ assets: await fetchLibrary() });
      get().notify(`「${item.name}」已入库`);
      return item;
    } catch (err) {
      get().notify(err instanceof Error ? err.message : "上传失败");
      return null;
    }
  },

  removeAsset: async (id: string) => {
    try {
      await deleteLibraryAsset(id);
      set({ assets: await fetchLibrary() });
      get().notify("素材已删除");
    } catch (err) {
      get().notify(err instanceof Error ? err.message : "删除失败");
    }
  },

  removeAssets: async (ids) => {
    if (!ids.length) return;
    try {
      const r = await deleteLibraryAssets(ids);
      set({ assets: await fetchLibrary() });
      get().notify(
        `已删除 ${r.deleted} 个素材` +
          (r.reclaimed ? `（回收 ${r.reclaimed} 个文件）` : "") +
          (r.missing.length ? `，${r.missing.length} 个没找到` : ""),
      );
    } catch (err) {
      get().notify(err instanceof Error ? err.message : "批量删除失败");
    }
  },

  cleanupAssets: async () => {
    try {
      const r = await apiCleanupAssets();
      set({ assets: await fetchLibrary() });
      get().notify(
        r.removed
          ? `已清理 ${r.removed} 个未引用文件，释放 ${formatBytes(r.freedBytes)}`
          : "没有可清理的未引用文件",
      );
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "清理素材失败" });
    }
  },

  renameAsset: async (id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const updated = await renameLibraryAsset(id, trimmed);
      set({ assets: get().assets.map((a) => (a.id === updated.id ? updated : a)) });
    } catch (err) {
      get().notify(err instanceof Error ? err.message : "重命名失败");
    }
  },

  loadProjectAssets: async () => {
    const project = get().project;
    if (!project) return;
    try {
      set({ projectAssets: await fetchProjectAssets(project.id) });
    } catch {
      /* 读不到就当空：不影响主界面 */
    }
  },

  uploadToProject: async (file: File) => {
    const project = get().project;
    if (!project) return null;
    try {
      const url = await uploadProjectAsset(project.id, file);
      await get().loadProjectAssets();
      get().notify(`已放进本工程素材目录`);
      return url;
    } catch (err) {
      get().notify(err instanceof Error ? err.message : "上传失败");
      return null;
    }
  },

  removeProjectAsset: async (target) => {
    const project = get().project;
    if (!project) return;
    try {
      const { wasReferenced } = await deleteProjectAsset(project.id, target);
      await get().loadProjectAssets();
      get().notify(
        wasReferenced
          ? "文件已删除，但它**仍被工程引用**——画面里用到它的元素会裂图"
          : "文件已删除",
      );
    } catch (err) {
      get().notify(err instanceof Error ? err.message : "删除失败");
    }
  },

  removeProjectAssets: async (names) => {
    const project = get().project;
    if (!project || !names.length) return;
    try {
      const r = await deleteProjectAssets(project.id, names);
      await get().loadProjectAssets();
      get().notify(
        `已删除 ${r.deleted} 个文件` +
          (r.wasReferenced ? `，其中 ${r.wasReferenced} 个仍被工程引用（画面会裂图）` : "") +
          (r.missing.length ? `，${r.missing.length} 个没找到` : ""),
      );
    } catch (err) {
      get().notify(err instanceof Error ? err.message : "批量删除失败");
    }
  },

  connect: () => {
    const project = get().project;
    if (!project) return;
    if (es) es.close();
    es = new EventSource(`/api/projects/${project.id}/events`);

    es.addEventListener("patch", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as {
          project: Project;
          actor: string;
          clientId?: string;
          summary: string[];
          sceneIds?: string[];
        };
        // 自己的操作已经用 REST 返回值更新过，只忽略自己这次的回声；
        // 别的窗口/agent 的改动一律应用（否则多开标签页会各改各的）
        if (data.actor === "user" && data.clientId === CLIENT_ID) return;

        const flashId = data.sceneIds?.[0] ?? null;
        set({
          project: data.project,
          flashId,
          toast: data.summary?.join("，") ?? "agent 更新了工程",
          agentActive: true,
        });
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => set({ flashId: null }), 1100);
        clearTimeout(agentTimer);
        agentTimer = setTimeout(() => set({ agentActive: false }), 2600);
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => set({ toast: null }), 4200);
      } catch {
        /* ignore malformed */
      }
    });
  },

  select: (id) => set({ selectedId: id, selection: [], selectedEffect: null }),

  // 选了画面上的元素 = 不再编辑特效；清空选择（点空白）时保留特效选中，
  // 否则点一下画布就把右栏弹回场景属性，改特效参数时很烦
  setSelection: (ids) =>
    set(ids.length ? { selection: ids, selectedEffect: null } : { selection: ids }),

  // 选中特效时把画面元素的选择清掉：否则按 Delete 会删掉那个"看不见被选中"的元素
  selectEffect: (id) =>
    set(id ? { selectedEffect: id, selection: [] } : { selectedEffect: null }),

  setFormat: (key) => set({ formatKey: key }),

  apply: async (ops, opts) => {
    /**
     * **写请求必须串行**（排队执行，不并发）。
     *
     * ops 是按「客户端当时的 project」算出来的，两个请求同时在飞会出两种错：
     *  ① 服务端按到达顺序落库，后到的那批带着旧假设 —— 自由画布的
     *     `update_scene.props.elements` 是**整数组替换**，会把这个时间窗里
     *     刚被另一笔请求改过的元素写回旧位置；
     *  ② 响应乱序回来时 `set({ project: res.project })` 会用更旧的状态覆盖更新的状态。
     * 典型症状就是「动一个元素，另一个退回原处」。本机延迟只有几毫秒，排队几乎无感。
     */
    const projectIdAtCall = get().project?.id;
    const run = async () => {
      const project = get().project;
      // 排队期间可能已经切换工程：这批 ops 是按老工程算的，绝不能写到新工程上
      if (!project || project.id !== projectIdAtCall) return;
      try {
        const res = await postOps(project.id, ops, "user");
        // snapshot:false 是撤销/重做自己发出的回滚，不能污染历史
        const record = opts?.snapshot !== false;
        set({
          project: res.project,
          past: record ? [...get().past, snapshotOf(project)].slice(-40) : get().past,
          // 新的编辑动作会截断重做链，和所有编辑器的惯例一致
          future: record ? [] : get().future,
          selectedId: res.createdSceneIds[0] ?? get().selectedId,
        });
      } catch (err) {
        set({ error: err instanceof Error ? err.message : "操作失败" });
      }
    };
    // 排队：前一笔（成功或失败）结束才发下一笔。catch 兜住链上已处理的拒绝，避免断链
    const queued = applyChain.then(run, run);
    applyChain = queued.catch(() => {});
    return queued;
  },

  restoreRevision: async (rev) => {
    const project = get().project;
    if (!project) return;
    try {
      const next = await apiRestoreRevision(project.id, rev);
      // 回滚是"跳到另一版"，和逐条撤销不是一回事：清空撤销/重做栈，避免状态对不上
      set({ project: next, past: [], future: [], selection: [] });
      get().notify(`已回滚到 rev ${rev}`);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "回滚失败" });
    }
  },

  undo: async () => {
    const { past, future, project } = get();
    if (!past.length || !project) return;
    const prev = past[past.length - 1];
    set({
      past: past.slice(0, -1),
      // 当前状态进重做栈，才能 Ctrl+Shift+Z 回来
      future: [...future, snapshotOf(project)].slice(-40),
    });
    await get().apply([{ op: "restore", project: prev, label: "撤销了上一步修改" }], {
      snapshot: false,
    });
  },

  redo: async () => {
    const { past, future, project } = get();
    if (!future.length || !project) return;
    const next = future[future.length - 1];
    set({
      future: future.slice(0, -1),
      past: [...past, snapshotOf(project)].slice(-40),
    });
    await get().apply([{ op: "restore", project: next, label: "重做了一步修改" }], {
      snapshot: false,
    });
  },

  notify: (msg) => {
    set({ toast: msg });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => set({ toast: null }), 3200);
  },

  clearError: () => set({ error: null }),
}));
