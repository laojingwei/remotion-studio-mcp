import React, { useEffect, useRef, useState } from "react";
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
import { cancelRender, fetchHistory, fetchTask, requestRender, requestStills, resetDemoProject, type HistoryEntry } from "./apiClient";
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
  }, [projectMenu]);

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
              setProjectMenu((v) => {
                if (!v) void loadTemplates();
                return !v;
              });
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
              <div className="menu-group">项目 · {projects.length}</div>
              <div className="menu-projects">
                {projects.map((p) => (
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
                      <span className="menu-proj-time">{fmtTime(p.createdAt)}</span>
                    </span>
                    <span className="menu-meta">
                      rev{p.rev} · {p.scenes} 场景
                    </span>
                  </button>
                ))}
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
