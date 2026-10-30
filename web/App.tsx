import React, { useEffect, useMemo, useRef, useState } from "react";
import type { PlayerRef } from "@remotion/player";
import { totalDuration } from "@shared/schema";
import { useDoc } from "./store";
import { Preview } from "./panels/Preview";
import { LeftPanel } from "./panels/LeftPanel";
import { Inspector } from "./panels/Inspector";
import { Timeline } from "./panels/Timeline";
import { ConfirmDialog } from "./ConfirmDialog";
import { GlobalDropZone } from "./GlobalDropZone";
// 暂时隐藏右下角「给 agent 留言」浮窗（留言改走 DSH 会话），代码保留，恢复时打开这两处注释
// import { AgentChat } from "./panels/AgentChat";
import { useUi } from "./ui";
import { setLocalPref } from "./uiPrefs";
import { cancelRender, fetchHistory, fetchTask, fetchTasks, requestRender, requestStills, resetDemoProject, type HistoryEntry, type ProjectSummary, type RenderTaskLite } from "./apiClient";
import { PROJ_SORT_DEFAULT, filterProjects, nextSort, readProjSort, timeOf, type ProjSort, type ProjSortKey } from "./projectFilter";
import { OutputsDialog } from "./panels/OutputsDialog";
import { RenderDialog, type RenderFormat, type RenderQuality } from "./panels/RenderDialog";
import { TtsDialog } from "./panels/TtsDialog";
import { WorkspaceDialog } from "./panels/WorkspaceDialog";

type RenderState = {
  id: string;
  status: string;
  progress: number;
  outputs: { format: string; url: string }[];
  error?: string;
};

const FORMAT_PRESETS = [
  { key: "portrait", label: "竖屏 9:16", width: 1080, height: 1920 },
  { key: "landscape", label: "横屏 16:9", width: 1920, height: 1080 },
  { key: "square", label: "方形 1:1", width: 1080, height: 1080 },
  { key: "tall45", label: "竖版 4:5", width: 1080, height: 1350 },
];

/** 画幅 key → 人话（渲染横幅里用，任务本身只带 key） */
const formatLabel = (key: string | undefined): string =>
  key ? (FORMAT_PRESETS.find((f) => f.key === key)?.label ?? key) : "";

/** 渲染横幅的一句话状态：多画幅是逐个渲的，光看百分比会以为卡住/重启 */
function renderPhase(t: RenderTaskLite): string {
  if (t.status === "queued") return "排队中";
  if (t.status === "bundling") return "打包中（准备渲染环境）";
  const i = t.formats.indexOf(t.currentFormat ?? "");
  const step = i >= 0 ? ` ${i + 1}/${t.formats.length}` : "";
  return `渲染${formatLabel(t.currentFormat)}${step} · ${Math.round(t.progress)}%`;
}

const elapsedSec = (t: RenderTaskLite) => Math.max(0, Math.round((Date.now() - t.createdAt) / 1000));

/**
 * 项目列表里的时间戳。
 * 同年只写 `MM-DD HH:mm`（省空间），跨年补年份；full 用于 title 提示，带秒。
 */
function fmtTime(iso: string | undefined, full = false): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const date = full || !sameYear
    ? `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    : `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return full ? `${date} ${time}:${p(d.getSeconds())}` : `${date} ${time}`;
}

/** 顶栏「收起/展开侧栏」按钮的极简图标 */
function IconSidebar({ side }: { side: "left" | "right" }) {
  const x = side === "left" ? 5.6 : 10.4;
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="2.2" stroke="currentColor" strokeWidth="1.2" />
      <path d={`M${x} 2.9V13.1`} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** 顶栏「收起/展开时间轴」按钮的图标 */
function IconTimeline() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="2.2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2 10.4h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/* ─────────── 项目面板的排序图标（按创建 / 按修改 / 按名称） ───────────
   三个排序条件如果写文字（"创建时间""最后修改时间""名称"）一行放不下，
   面板窄的时候会被挤成两行或直接溢出，所以只用图标 + title 说明。 */

/** 创建时间：日历 + 加号（"新建"的语义） */
function IconSortCreated() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2.2" y="3.6" width="11.6" height="9.4" rx="2" stroke="currentColor" strokeWidth="1.25" />
      <path d="M5.4 1.9v2.5M10.6 1.9v2.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <path d="M8 6.6v3.8M6.1 8.5h3.8" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" />
    </svg>
  );
}

/** 最后修改时间：时钟（"改到几点"的语义） */
function IconSortUpdated() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="5.9" stroke="currentColor" strokeWidth="1.25" />
      <path d="M8 4.6V8l2.6 1.6" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 名称：AZ（字母序是全世界通用的写法，比"三横线"更能区分于时间排序） */
function IconSortName() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <text
        x="1"
        y="11.6"
        fill="currentColor"
        fontSize="8.4"
        fontWeight="600"
        fontFamily="Segoe UI, system-ui, sans-serif"
        letterSpacing="0.2"
      >
        AZ
      </text>
    </svg>
  );
}

/** 排序方向：只有当前生效的那个按钮显示，升序朝上、降序朝下 */
function IconCaret({ up }: { up?: boolean }) {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden>
      <path
        d={up ? "M2.3 6.3 5 3.6l2.7 2.7" : "M2.3 3.7 5 6.4l2.7-2.7"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 面板上的三个排序按钮（顺序按用户说的：创建时间 / 最后修改时间 / 名称） */
const PROJ_SORT_BUTTONS: { key: ProjSortKey; label: string; Icon: () => React.ReactElement }[] = [
  { key: "created", label: "创建时间", Icon: IconSortCreated },
  { key: "updated", label: "最后修改时间", Icon: IconSortUpdated },
  { key: "name", label: "名称", Icon: IconSortName },
];

export default function App() {
  const { project, projects, load, loading, formatKey, setFormat, undo, redo, past, future, toast, agentActive, error, clearError, loadAssets, loadTemplates, templates, createFromTemplate } =
    useDoc();
  const playerRef = useRef<PlayerRef | null>(null);

  // 左右栏宽度：拖动分隔条调整，记在 localStorage
  const [leftW, setLeftW] = useState(() => {
    const saved = Number(localStorage.getItem("rms:leftW"));
    return Number.isFinite(saved) && saved >= 180 && saved <= 600 ? saved : 258;
  });
  const [rightW, setRightW] = useState(() => {
    const saved = Number(localStorage.getItem("rms:rightW"));
    return Number.isFinite(saved) && saved >= 240 && saved <= 700 ? saved : 322;
  });
  /** 三块区域各自的收起状态：左栏 / 右栏 / 时间轴，记在 localStorage */
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem("rms:collapsed") || "{}") as Record<string, unknown>;
      return { left: raw.left === true, right: raw.right === true, timeline: raw.timeline === true };
    } catch {
      return { left: false, right: false, timeline: false };
    }
  });
  /** 顶栏「⋯」低频操作菜单（声明必须早于下面读它的 effect） */
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const togglePanel = (key: "left" | "right" | "timeline") =>
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  const [panelDrag, setPanelDrag] = useState<null | {
    side: "left" | "right";
    startX: number;
    startW: number;
  }>(null);

  useEffect(() => {
    document.documentElement.style.setProperty("--left-w", `${leftW}px`);
    document.documentElement.style.setProperty("--right-w", `${rightW}px`);
    // 同步到服务端，换浏览器/换端口也能恢复布局
    setLocalPref("rms:leftW", String(leftW));
    setLocalPref("rms:rightW", String(rightW));
  }, [leftW, rightW]);

  useEffect(() => {
    setLocalPref("rms:collapsed", JSON.stringify(collapsed));
  }, [collapsed]);

  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (event: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(event.target as Node)) setMoreOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  useEffect(() => {
    if (!panelDrag) return;
    const onMove = (e: MouseEvent) => {
      const delta = e.clientX - panelDrag.startX;
      if (panelDrag.side === "left") {
        setLeftW(Math.min(600, Math.max(180, Math.round(panelDrag.startW + delta))));
      } else {
        setRightW(Math.min(700, Math.max(240, Math.round(panelDrag.startW - delta))));
      }
    };
    const onUp = () => setPanelDrag(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [panelDrag]);

  const bundleInputRef = useRef<HTMLInputElement>(null);
  const askConfirm = useUi((s) => s.askConfirm);
  const [render, setRender] = useState<RenderState | null>(null);
  const [stills, setStills] = useState<{ format: string; url: string }[] | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [projectMenu, setProjectMenu] = useState(false);
  /**
   * 项目面板的搜索词与排序。
   * 搜索词每次打开面板清空（上次筛掉的项目还在，会让人以为工程丢了）；
   * 排序记住（这是稳定偏好，反复重置反而烦），存 localStorage。
   */
  const [projQuery, setProjQuery] = useState("");
  const [projSort, setProjSort] = useState<ProjSort>(() => {
    try {
      return readProjSort(localStorage.getItem("rms:projSort"));
    } catch {
      return PROJ_SORT_DEFAULT;
    }
  });
  /** 面板里真正渲染的列表：先按搜索词筛、再按当前字段排 */
  const visibleProjects = useMemo(
    () => filterProjects(projects, projQuery, projSort),
    [projects, projQuery, projSort],
  );
  useEffect(() => {
    try {
      localStorage.setItem("rms:projSort", JSON.stringify(projSort));
    } catch {
      // 无痕模式写不了 localStorage：只用不存，不影响功能
    }
  }, [projSort]);
  const [outputsOpen, setOutputsOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [ttsOpen, setTtsOpen] = useState(false);
  const [showTpls, setShowTpls] = useState(false);
  const [formatMenu, setFormatMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [renderOpen, setRenderOpen] = useState(false);
  /** 自定义画幅的宽高输入 */
  const [customW, setCustomW] = useState("1080");
  const [customH, setCustomH] = useState("1920");
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  /**
   * agent 起的渲染：它跑在服务端，编辑器必须能看见「谁在渲哪个工程、渲到哪了」。
   * 本页自己点的渲染走 startRender 那条路（按钮上已经有百分比），这里用 localTasks 排掉，
   * 免得同一件事出现两根进度条。
   */
  const [tasks, setTasks] = useState<RenderTaskLite[]>([]);
  const localTasks = useRef<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (document.hidden) return; // 后台标签页不轮询，回来时补一次
      try {
        const list = await fetchTasks();
        if (alive) setTasks(list);
      } catch {
        /* 服务重启中：下一轮再试，不打扰用户 */
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 2000);
    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    void load();
    void loadAssets();
    return () => clearInterval(pollRef.current);
  }, [load, loadAssets]);

  // 项目菜单打开时把「当前工程」带进可视区：项目一多它可能藏在列表滚动区外面。
  // 只动列表自己的 scrollTop —— 用 scrollIntoView 可能连带把整条菜单也滚一下
  useEffect(() => {
    if (!projectMenu) return;
    const list = document.querySelector<HTMLElement>(".menu-projects");
    const el = list?.querySelector<HTMLElement>(".menu-item.is-on");
    if (!list || !el) return;
    const er = el.getBoundingClientRect();
    const lr = list.getBoundingClientRect();
    if (er.top < lr.top) list.scrollTop -= lr.top - er.top;
    else if (er.bottom > lr.bottom) list.scrollTop += er.bottom - lr.bottom;
  }, [projectMenu, projQuery, projSort]);

  // 快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        // Shift+Z 是重做；Ctrl+Y 也常被当重做用
        void (e.shiftKey ? redo() : undo());
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        void redo();
      }
      // 空格只由 Preview 一处处理 —— 两边都 toggle 会互相抵消（按下即播放、立刻被暂停）
      if (e.key === "Escape") {
        setStills(null);
        setHistory(null);
        setProjectMenu(false);
        setFormatMenu(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // 下拉菜单：点区域外自动收回（点在触发按钮/画幅条里时交给它们自己切换）
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.closest(".project-switch") || t.closest(".formats")) return;
      setProjectMenu(false);
      setShowTpls(false);
      setFormatMenu(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, []);

  const startRender = async (formats: string[], quality: RenderQuality, format: RenderFormat) => {
    if (!project || busy) return;
    setBusy(true);
    setRenderOpen(false);
    try {
      const task = await requestRender(project.id, formats, quality, format);
      localTasks.current.add(task.id); // 本页起的：横幅不重复显示（按钮上已有百分比）
      setRender({ id: task.id, status: task.status, progress: 0, outputs: [] });
      pollRef.current = setInterval(async () => {
        try {
          const t = await fetchTask(task.id);
          setRender({
            id: t.id,
            status: t.status,
            progress: t.progress,
            outputs: t.outputs ?? [],
            error: t.error,
          });
          if (t.status === "done" || t.status === "error" || t.status === "cancelled") {
            clearInterval(pollRef.current);
            setBusy(false);
          }
        } catch {
          clearInterval(pollRef.current);
          setBusy(false);
        }
      }, 1200);
    } catch (err) {
      useDoc.getState().notify(err instanceof Error ? err.message : "提交渲染失败");
      setBusy(false);
    }
  };

  const cancelRenderTask = async () => {
    if (!render?.id) return;
    try {
      await cancelRender(render.id);
      useDoc.getState().notify("已取消本次渲染");
    } catch (err) {
      useDoc.getState().notify(err instanceof Error ? err.message : "取消失败");
    } finally {
      clearInterval(pollRef.current);
      setBusy(false);
      setRender(null);
    }
  };

  /** 取消 agent 起的渲染（横幅上的按钮） */
  const cancelRemoteTask = async (id: string) => {
    try {
      await cancelRender(id);
      useDoc.getState().notify("已取消渲染");
      setTasks((list) => list.map((t) => (t.id === id ? { ...t, status: "cancelled", progress: 0 } : t)));
    } catch (err) {
      useDoc.getState().notify(err instanceof Error ? err.message : "取消失败");
    }
  };

  // 服务端的活动任务里，挑一个不是本页起的来显示（同一时刻最多一个在渲，其余排队）
  const activeTasks = tasks.filter(
    (t) => (t.status === "queued" || t.status === "bundling" || t.status === "rendering") && !localTasks.current.has(t.id),
  );
  const remoteTask = activeTasks[0] ?? null;
  const queuedBehind = Math.max(0, activeTasks.length - 1);
  // 任务里带了工程名快照；老服务没有这个字段时从工程列表补，别再退化成显示 id
  const projectNameOf = (t: RenderTaskLite) =>
    t.projectName ?? projects.find((x) => x.id === t.projectId)?.name ?? t.projectId;
  // 刚渲完的停留 10 秒：不点开也能知道「刚才那一下成功了」
  const justDone =
    !remoteTask && !busy
      ? (tasks.find(
          (t) =>
            t.status === "done" &&
            !localTasks.current.has(t.id) &&
            Date.now() - (t.updatedAt ?? t.createdAt) < 10000,
        ) ?? null)
      : null;

  const capture = async () => {    if (!project) return;
    const frame = Math.round(playerRef.current?.getCurrentFrame?.() ?? 0);
    useDoc.getState().notify("正在渲染关键帧…");
    try {
      setStills(await requestStills(project.id, frame));
    } catch (err) {
      useDoc.getState().notify(err instanceof Error ? err.message : "截图失败");
    }
  };

  const openHistory = async () => {
    if (!project) return;
    try {
      setHistory(await fetchHistory(project.id));
    } catch (err) {
      useDoc.getState().notify(err instanceof Error ? err.message : "读取历史失败");
    }
  };

  const toggleFormat = (preset: { key: string; label: string; width: number; height: number }) => {
    if (!project) return;
    const exists = project.formats.some((f) => f.key === preset.key);
    const next = exists
      ? project.formats.filter((f) => f.key !== preset.key)
      : [...project.formats, preset];
    if (!next.length) {
      useDoc.getState().notify("至少保留一种画幅");
      return;
    }
    void useDoc.getState().apply([{ op: "set_formats", formats: next }]).then(() => {
      if (!exists) setFormat(preset.key);
      // 删掉的正是当前画幅：切到剩下的第一个，别让 formatKey 悬空
      else if (formatKey === preset.key) setFormat(next[0].key);
    });
  };

  /** 自定义宽高：数据层本来就支持任意尺寸，这里只是补一个输入入口 */
  const addCustomFormat = () => {
    if (!project) return;
    const w = Math.round(Number(customW));
    const h = Math.round(Number(customH));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 16 || h < 16 || w > 7680 || h > 7680) {
      useDoc.getState().notify("宽高需在 16 – 7680 之间");
      return;
    }
    const key = `custom-${w}x${h}`;
    if (project.formats.some((f) => f.key === key)) {
      setFormat(key);
      setFormatMenu(false);
      return;
    }
    const next = [
      ...project.formats,
      { key, label: `自定义 ${w}×${h}`, width: w, height: h },
    ];
    void useDoc
      .getState()
      .apply([{ op: "set_formats", formats: next }])
      .then(() => setFormat(key));
    setFormatMenu(false);
  };

  if (!project) {
    // 首次启动才说「正在连接」；切换/删除工程的中间态不要吓唬人
    return <div className="boot">{loading ? "正在连接本地服务…" : "正在准备工程…"}</div>;
  }

  const total = Math.max(1, totalDuration(project));
  const myTemplates = templates.filter((t) => t.kind === "custom");
  const builtinTemplates = templates.filter((t) => t.kind !== "custom");

  return (
    <div
      className={[
        "app",
        collapsed.left ? "is-left-collapsed" : "",
        collapsed.right ? "is-right-collapsed" : "",
        collapsed.timeline ? "is-timeline-collapsed" : "",
      ].join(" ").trim()}
    >
      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" />
          <span className="brand-name">REMOTION STUDIO</span>
        </div>

        <div className="project-switch">
          <input
            className="project-name"
            value={project.name}
            onChange={(e) => {
              if (e.target.value === project.name) return;
              void useDoc.getState().apply(
                [{ op: "update_project", patch: { name: e.target.value } }],
                { snapshot: false },
              );
            }}
          />
          <button
            className="caret"
            onClick={() => {
              // 打开面板时清空搜索：上次筛掉的项目还在列表里，会让人以为工程丢了
              if (!projectMenu) {
                void loadTemplates();
                setProjQuery("");
              }
              setProjectMenu((v) => !v);
            }}
            title="切换项目"
          >
            ▾
          </button>
          {projectMenu ? (
            <div className="menu">
              {/*
                项目多的时候不能再让整条菜单无限往下长（会顶出视口，"删除工程"根本点不到）：
                项目列表单独一个限高滚动区，新建/模板/工程操作固定在它下面。
              */}
              <div className="menu-group">
                项目 · {visibleProjects.length}
                {visibleProjects.length !== projects.length ? ` / ${projects.length}` : ""}
              </div>
              {/*
                搜索 + 排序：工程一多（几十个）翻列表比打字慢得多。
                三个排序条件只给图标——"创建时间/最后修改时间/名称"一行文字放不下，
                面板窄的时候会折行或溢出，图标 + title 才稳。
              */}
              <div className="proj-tools">
                <span className="proj-search-wrap">
                  <input
                    className="proj-search"
                    value={projQuery}
                    placeholder="搜索项目名 / id"
                    spellCheck={false}
                    aria-label="搜索项目"
                    onChange={(e) => setProjQuery(e.target.value)}
                    onKeyDown={(e) => {
                      // 回车直接打开第一条：搜完不用再挪鼠标
                      if (e.key !== "Enter") return;
                      const first = visibleProjects[0];
                      if (!first) return;
                      setProjectMenu(false);
                      void useDoc.getState().loadProject(first.id);
                    }}
                  />
                  {projQuery ? (
                    <button
                      className="proj-clear"
                      title="清除搜索"
                      aria-label="清除搜索"
                      onClick={() => setProjQuery("")}
                    >
                      ×
                    </button>
                  ) : null}
                </span>
                <div className="proj-sorts" role="group" aria-label="排序方式">
                  {PROJ_SORT_BUTTONS.map(({ key, label, Icon }) => {
                    const on = projSort.key === key;
                    const dirText = projSort.dir === "asc" ? "升序" : "降序";
                    return (
                      <button
                        key={key}
                        className={`proj-sort${on ? " is-on" : ""}`}
                        title={`按${label}排序${on ? `（当前${dirText}，再点切换）` : ""}`}
                        aria-label={`按${label}排序`}
                        aria-pressed={on}
                        onClick={() => setProjSort((cur) => nextSort(cur, key))}
                      >
                        <Icon />
                        {on ? <IconCaret up={projSort.dir === "asc"} /> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="menu-projects">
                {visibleProjects.length ? (
                  visibleProjects.map((p) => (
                    <button
                      key={p.id}
                      className={`menu-item ${p.id === project.id ? "is-on" : ""}`}
                      title={`${p.name}\n创建：${fmtTime(p.createdAt, true)}\n最后修改：${fmtTime(p.updatedAt, true)}`}
                      onClick={() => {
                        setProjectMenu(false);
                        void useDoc.getState().loadProject(p.id);
                      }}
                    >
                      <span className="menu-proj">
                        <span className="menu-proj-name">{p.name}</span>
                        {/* 右侧时间跟排序字段一致：按"修改"排却显示创建时间，看着像乱序 */}
                        <span className="menu-proj-time">{fmtTime(timeOf(p, projSort.key))}</span>
                      </span>
                      <span className="menu-meta">
                        rev{p.rev} · {p.scenes} 场景
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="proj-empty">
                    <span>没有匹配「{projQuery.trim()}」的工程</span>
                    <button className="proj-empty-clear" onClick={() => setProjQuery("")}>
                      清除搜索
                    </button>
                  </div>
                )}
              </div>
              <button
                className={`menu-item accent ${showTpls ? "is-on" : ""}`}
                onClick={() => setShowTpls((v) => !v)}
              >
                ＋ 新建项目<span className="menu-meta">从模板开始</span>
              </button>
              {showTpls ? (
                <div className="menu-tpls">
                  {myTemplates.length ? (
                    <>
                      <div className="tpl-group">我的模板</div>
                      {myTemplates.map((t) => (
                        <div key={t.key} className="tpl-row">
                          <button
                            className="menu-item tpl"
                            onClick={() => {
                              setProjectMenu(false);
                              setShowTpls(false);
                              void createFromTemplate(t, t.name);
                            }}
                          >
                            <span>
                              {t.name}
                              <span className="menu-meta">
                                {" "}
                                · {t.sceneCount} 场景 · {(t.durationInFrames / 30).toFixed(0)}s
                              </span>
                            </span>
                            <span className="menu-meta">{t.description}</span>
                          </button>
                          <button
                            className="tpl-rename"
                            title="重命名模板"
                            aria-label={`重命名模板 ${t.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              const name = window.prompt("模板名称", t.name);
                              if (!name?.trim() || name.trim() === t.name) return;
                              void useDoc.getState().renameTemplate(t.key, name.trim());
                            }}
                          >
                            ✎
                          </button>
                          <button
                            className="tpl-del"
                            title="删除模板"
                            aria-label={`删除模板 ${t.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              askConfirm({
                                title: `删除模板「${t.name}」？`,
                                message: "模板目录和打包进去的素材会被移除；已经用这个模板建出来的工程不受影响。",
                                confirmLabel: "删除模板",
                                onConfirm: () => void useDoc.getState().removeTemplate(t.key),
                              });
                            }}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </>
                  ) : null}

                  <div className="tpl-group">内置模板</div>
                  {builtinTemplates.map((t) => (
                    <button
                      key={t.key}
                      className="menu-item tpl"
                      onClick={() => {
                        setProjectMenu(false);
                        setShowTpls(false);
                        void createFromTemplate(
                          t,
                          t.key === "blank" ? `项目 ${projects.length + 1}` : undefined,
                        );
                      }}
                    >
                      <span>
                        {t.name}
                        <span className="menu-meta">
                          {" "}
                          · {t.sceneCount} 场景 · {(t.durationInFrames / 30).toFixed(0)}s
                        </span>
                      </span>
                      <span className="menu-meta">{t.description}</span>
                    </button>
                  ))}

                </div>
              ) : null}

              {showTpls ? (
                <button
                  className="menu-item accent tpl-save"
                  title="把当前工程的场景、画幅、主题和素材一起存成模板"
                  onClick={() => {
                    const name = window.prompt("模板名称", project.name);
                    if (!name?.trim()) return;
                    setProjectMenu(false);
                    setShowTpls(false);
                    void useDoc.getState().saveCurrentAsTemplate(name.trim());
                  }}
                >
                  <span>＋ 把当前工程存成模板</span>
                  <span className="menu-meta">连素材一起打包</span>
                </button>
              ) : null}

              {!templates.length && showTpls ? (
                <div className="menu-meta" style={{ padding: "6px 12px" }}>
                  模板加载中…
                </div>
              ) : null}

              <div className="menu-sep" />

              <button
                className="menu-item"
                onClick={() => {
                  setProjectMenu(false);
                  void useDoc.getState().duplicateCurrentProject();
                }}
              >
                <span>复制当前工程</span>
                <span className="menu-meta">留一份备份再改</span>
              </button>

              <button
                className="menu-item"
                onClick={() => {
                  setProjectMenu(false);
                  void useDoc.getState().exportCurrentProject();
                }}
              >
                <span>导出工程包</span>
                <span className="menu-meta">.zip · 含素材</span>
              </button>

              <button
                className="menu-item"
                onClick={() => {
                  setProjectMenu(false);
                  void useDoc.getState().exportSubtitles("srt");
                }}
              >
                <span>导出字幕</span>
                <span className="menu-meta">.srt · 按场景字幕生成</span>
              </button>

              <button className="menu-item" onClick={() => bundleInputRef.current?.click()}>
                <span>导入工程包…</span>
                <span className="menu-meta">从 .zip 恢复</span>
              </button>
              <input
                ref={bundleInputRef}
                type="file"
                accept=".zip,application/zip"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.currentTarget.value = "";
                  if (!file) return;
                  setProjectMenu(false);
                  void useDoc.getState().importProjectBundle(file);
                }}
              />

              <button
                className="menu-item"
                onClick={() => {
                  setProjectMenu(false);
                  setOutputsOpen(true);
                }}
              >
                <span>渲染产物…</span>
                <span className="menu-meta">勾选要删的文件</span>
              </button>

              {project.id === "demo" ? (
                <button
                  className="menu-item"
                  onClick={() => {
                    askConfirm({
                      title: "重置 demo 工程？",
                      message: "示例工程会恢复成初始内容，当前对 demo 的修改会丢失（其他工程不受影响）。",
                      confirmLabel: "重置",
                      onConfirm: () => {
                        setProjectMenu(false);
                        void (async () => {
                          try {
                            await resetDemoProject();
                            await useDoc.getState().loadProject("demo");
                            useDoc.getState().notify("demo 已重置");
                          } catch (err) {
                            useDoc.getState().notify(
                              err instanceof Error ? err.message : "重置失败",
                            );
                          }
                        })();
                      },
                    });
                  }}
                >
                  <span>重置 demo 工程</span>
                  <span className="menu-meta">示例工程不可删除</span>
                </button>
              ) : (
                <button
                  className="menu-item danger"
                  onClick={() => {
                    askConfirm({
                      title: `删除「${project.name}」？`,
                      message: "工程的场景、历史和渲染产物都会移除，无法恢复。",
                      confirmLabel: "删除工程",
                      onConfirm: () => {
                        setProjectMenu(false);
                        void useDoc.getState().deleteCurrentProject();
                      },
                    });
                  }}
                >
                  <span>删除当前工程</span>
                  <span className="menu-meta">不可恢复</span>
                </button>
              )}
            </div>
          ) : null}
        </div>

        <div className="seg formats">
          {project.formats.map((f) => (
            <button
              key={f.key}
              className={`seg-item ${formatKey === f.key ? "is-on" : ""}`}
              onClick={() => setFormat(f.key)}
              title={`${f.width}×${f.height}`}
            >
              {f.label}
            </button>
          ))}
          <button className="seg-item add-format" onClick={() => setFormatMenu((v) => !v)} title="管理画幅">
            ＋
          </button>
          {formatMenu ? (
            <div className="menu inline">
              {project.formats.map((f) => (
                <button key={`on-${f.key}`} className="menu-item" onClick={() => toggleFormat(f)}>
                  <span>{f.label}</span>
                  <span className="menu-meta">已启用 · 点击移除</span>
                </button>
              ))}
              {FORMAT_PRESETS.filter((p) => !project.formats.some((f) => f.key === p.key)).map((p) => (
                <button key={p.key} className="menu-item" onClick={() => toggleFormat(p)}>
                  <span>{p.label}</span>
                  <span className="menu-meta">未启用 · 点击添加</span>
                </button>
              ))}
              <div className="menu-custom">
                <span className="menu-meta">自定义尺寸（16 – 7680）</span>
                <div className="menu-custom-row">
                  <input
                    type="number"
                    min={16}
                    max={7680}
                    value={customW}
                    aria-label="宽度"
                    onChange={(e) => setCustomW(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                  />
                  <span className="menu-meta">×</span>
                  <input
                    type="number"
                    min={16}
                    max={7680}
                    value={customH}
                    aria-label="高度"
                    onChange={(e) => setCustomH(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                  />
                  <button className="mini" onClick={addCustomFormat}>
                    添加
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <div className="spacer" />

        {/* 右侧动作组：整组靠右；窄屏放不下时整组换行，仍然靠右 */}
        <div className="topbar-actions">
        {/* 三块区域的最小化开关：收起后画面更清爽，再点一次回来 */}
        <div className="layout-toggles">
          <button
            className={`ghost layout-toggle ${collapsed.left ? "is-off" : ""}`}
            onClick={() => togglePanel("left")}
            title={collapsed.left ? "展开左栏（场景 / 元素）" : "收起左栏，放大画面"}
            aria-label={collapsed.left ? "展开左栏" : "收起左栏"}
            aria-pressed={!collapsed.left}
          >
            <IconSidebar side="left" />
          </button>
          <button
            className={`ghost layout-toggle ${collapsed.right ? "is-off" : ""}`}
            onClick={() => togglePanel("right")}
            title={collapsed.right ? "展开右栏（属性）" : "收起右栏，放大画面"}
            aria-label={collapsed.right ? "展开右栏" : "收起右栏"}
            aria-pressed={!collapsed.right}
          >
            <IconSidebar side="right" />
          </button>
          <button
            className={`ghost layout-toggle ${collapsed.timeline ? "is-off" : ""}`}
            onClick={() => togglePanel("timeline")}
            title={collapsed.timeline ? "展开时间轴" : "收起时间轴，放大预览"}
            aria-label={collapsed.timeline ? "展开时间轴" : "收起时间轴"}
            aria-pressed={!collapsed.timeline}
          >
            <IconTimeline />
          </button>
        </div>

        <div className="timecode">
          {project.scenes.length} 场景 · {(total / project.fps).toFixed(1)}s · rev {project.rev}
        </div>

        <span className={`agent-pill ${agentActive ? "is-live" : ""}`}>
          <span className="dot" />
          {agentActive ? "agent 正在编辑" : "agent 可连接"}
        </span>

        {/* 低频操作收进一个「⋯」菜单，顶栏只留折叠开关 + 渲染 */}
        <div className="topbar-more" ref={moreRef}>
          <button
            className={`ghost layout-toggle ${moreOpen ? "is-on" : ""}`}
            onClick={() => setMoreOpen((v) => !v)}
            title="更多操作"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
          >
            ⋯
          </button>
          {moreOpen ? (
            <div className="menu topbar-more-menu" role="menu">
              <button
                className="menu-item"
                role="menuitem"
                onClick={() => {
                  setMoreOpen(false);
                  setWorkspaceOpen(true);
                }}
              >
                <span>工作空间</span>
                <span className="menu-meta">换磁盘</span>
              </button>
              <button
                className="menu-item"
                role="menuitem"
                onClick={() => {
                  setMoreOpen(false);
                  void openHistory();
                }}
              >
                <span>历史</span>
                <span className="menu-meta">回滚到某一版</span>
              </button>
              <button
                className="menu-item"
                role="menuitem"
                disabled={!past.length}
                onClick={() => {
                  setMoreOpen(false);
                  void undo();
                }}
              >
                <span>撤销</span>
                <span className="menu-meta">Ctrl/Cmd + Z</span>
              </button>
              <button
                className="menu-item"
                role="menuitem"
                disabled={!future.length}
                onClick={() => {
                  setMoreOpen(false);
                  void redo();
                }}
              >
                <span>重做</span>
                <span className="menu-meta">Ctrl/Cmd + Shift + Z</span>
              </button>
              <button
                className="menu-item"
                role="menuitem"
                onClick={() => {
                  setMoreOpen(false);
                  void capture();
                }}
              >
                <span>关键帧</span>
                <span className="menu-meta">抽 2–3 帧看版式</span>
              </button>
              <button
                className="menu-item"
                role="menuitem"
                onClick={() => {
                  setMoreOpen(false);
                  setTtsOpen(true);
                }}
              >
                <span>语音</span>
                <span className="menu-meta">本地 TTS</span>
              </button>
            </div>
          ) : null}
        </div>
        <button className="primary" onClick={() => setRenderOpen(true)} disabled={busy}>
          {busy ? `渲染中 ${render?.progress ?? 0}%` : "渲染"}
        </button>
        {busy && render?.id ? (
          <button
            className="ghost danger"
            onClick={() => void cancelRenderTask()}
            title="放弃本次渲染"
          >
            取消
          </button>
        ) : null}
        {busy ? (
          <div className="render-progress" title={`渲染中 ${render?.progress ?? 0}%`}>
            <span style={{ width: `${Math.max(2, render?.progress ?? 0)}%` }} />
          </div>
        ) : null}

        {remoteTask ? (
          <div className="render-banner" role="status" aria-live="polite">
            <span className="rb-spark" aria-hidden />
            <div className="rb-body">
              <div className="rb-title">
                Agent 正在渲染「{projectNameOf(remoteTask)}」
                {queuedBehind ? <span className="rb-queue">还有 {queuedBehind} 个排队</span> : null}
              </div>
              <div className="rb-sub">
                {renderPhase(remoteTask)} · 已用 {elapsedSec(remoteTask)}s
              </div>
              <div
                className={`rb-bar ${remoteTask.status === "rendering" ? "" : "is-indeterminate"}`}
                aria-hidden
              >
                <span
                  style={{
                    width:
                      remoteTask.status === "rendering" ? `${Math.max(2, remoteTask.progress)}%` : undefined,
                  }}
                />
              </div>
            </div>
            {project && remoteTask.projectId !== project.id ? (
              <button className="ghost" onClick={() => void useDoc.getState().loadProject(remoteTask.projectId)}>
                去看看
              </button>
            ) : null}
            <button
              className="ghost danger"
              onClick={() => void cancelRemoteTask(remoteTask.id)}
              title="停掉这次渲染（agent 那边也会收到取消）"
            >
              取消
            </button>
          </div>
        ) : justDone ? (
          <div className="render-banner is-done" role="status" aria-live="polite">
            <span className="rb-spark is-done" aria-hidden />
            <div className="rb-body">
              <div className="rb-title">「{projectNameOf(justDone)}」渲染完成</div>
              <div className="rb-sub">
                {justDone.outputs.length
                  ? `生成 ${justDone.outputs.length} 个文件（${justDone.outputs.map((o) => formatLabel(o.format)).join(" / ")}）`
                  : "完成但没有产出文件——确认这个画幅还在工程里"}
              </div>
            </div>
            {justDone.outputs[0] ? (
              <a className="ghost" href={justDone.outputs[0].url} target="_blank" rel="noreferrer">
                打开
              </a>
            ) : null}
          </div>
        ) : null}
        </div>
      </header>

      <div
        className="panel-resizer is-left"
        style={{ left: "calc(var(--left-w, 258px) - 3px)" }}
        onMouseDown={(e) => {
          e.preventDefault();
          setPanelDrag({ side: "left", startX: e.clientX, startW: leftW });
        }}
        title="拖动调整左栏宽度"
      />
      <div
        className="panel-resizer is-right"
        style={{ right: "calc(var(--right-w, 322px) - 3px)" }}
        onMouseDown={(e) => {
          e.preventDefault();
          setPanelDrag({ side: "right", startX: e.clientX, startW: rightW });
        }}
        title="拖动调整右栏宽度"
      />

      <LeftPanel />
      <main className="center">
        <Preview playerRef={playerRef} />
        <Timeline playerRef={playerRef} />
      </main>
      <Inspector playerRef={playerRef} />

      {toast ? <div className="toast">{toast}</div> : null}

      {error ? (
        <div className="errorbar" onClick={clearError}>
          {error}（点击关闭）
        </div>
      ) : null}

      {stills ? (
        <div className="overlay" onClick={() => setStills(null)}>
          <div className="stills" onClick={(e) => e.stopPropagation()}>
            <div className="stills-head">
              <span>关键帧预览</span>
              <button className="ghost" onClick={() => setStills(null)}>
                关闭
              </button>
            </div>
            <div className="stills-body">
              {stills.map((s) => (
                <figure key={s.format}>
                  <img src={s.url} alt={s.format} />
                  <figcaption>{s.format}</figcaption>
                </figure>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {history ? (
        <div className="overlay" onClick={() => setHistory(null)}>
          <div className="history-panel" onClick={(e) => e.stopPropagation()}>
            <div className="stills-head">
              <span>编辑历史</span>
              <button className="ghost" onClick={() => setHistory(null)}>
                关闭
              </button>
            </div>
            {history.length ? (
              <div className="history-list">
                {history.map((h) => (
                  <div key={h.rev} className={`history-row ${h.actor}`}>
                    <span className="history-rev">rev{h.rev}</span>
                    <span className="history-actor">
                      {h.actor === "agent" ? "agent" : h.actor === "system" ? "系统" : "你"}
                    </span>
                    <span className="history-text">{h.summary.join("；") || h.ops.join(", ")}</span>
                    <span className="history-time">
                      {h.at ? new Date(h.at).toLocaleTimeString("zh-CN", { hour12: false }) : "—"}
                    </span>
                    {h.snapshot ? (
                      <button
                        className="history-rollback"
                        title={`回滚到 rev ${h.rev}`}
                        onClick={() =>
                          askConfirm({
                            title: `回滚到 rev ${h.rev}？`,
                            message: "当前内容会被这一版覆盖。回滚本身也会记一条历史，可以再回滚回来。",
                            confirmLabel: "回滚",
                            onConfirm: () => {
                              setHistory(null);
                              void useDoc.getState().restoreRevision(h.rev);
                            },
                          })
                        }
                      >
                        回滚
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty">启动服务后还没有编辑记录</div>
            )}
          </div>
        </div>
      ) : null}

      {render && render.status === "done" ? (
        <div className="render-card">
          <div className="rc-head">渲染完成</div>
          {render.outputs.map((o) => (
            <a key={o.format} href={o.url} target="_blank" rel="noreferrer">
              {o.format} · 下载 MP4
            </a>
          ))}
          <button className="mini" onClick={() => setRender(null)}>
            关闭
          </button>
        </div>
      ) : null}

      {render && render.status === "error" ? (
        <div className="render-card error">
          <div className="rc-head">渲染失败</div>
          <div className="rc-msg">{render.error}</div>
          <button className="mini" onClick={() => setRender(null)}>
            关闭
          </button>
        </div>
      ) : null}

      <ConfirmDialog />
      <GlobalDropZone />
      {/* 暂时隐藏右下角「给 agent 留言」浮窗；恢复时把顶部 import 也一起打开
      <AgentChat />
      */}
      <OutputsDialog open={outputsOpen} onClose={() => setOutputsOpen(false)} />
      <WorkspaceDialog open={workspaceOpen} onClose={() => setWorkspaceOpen(false)} />
      <TtsDialog open={ttsOpen} onClose={() => setTtsOpen(false)} />
      <RenderDialog
        open={renderOpen}
        project={project}
        busy={busy}
        onClose={() => setRenderOpen(false)}
        onStart={(formats, quality, format) => void startRender(formats, quality, format)}
      />
    </div>
  );
}
