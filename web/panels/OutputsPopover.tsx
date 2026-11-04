import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchOutputs, setOutputLock, type OutputEntry } from "../apiClient";
import { useDoc } from "../store";

/**
 * 产物浮框：用户想「看看这条片子现在长什么样」时点开的地方。
 *
 * 和 OutputsDialog 的分工（别合并）：
 *   OutputsDialog  全库、按工程分组、勾选批量删 —— 那是**清磁盘**工具
 *   这里           当前工程、按类型分 tab、点开就能看 —— 这是**看片**的地方
 * 两者共用一个 /api/outputs，只是个参数差别。
 *
 * 为什么不是全屏弹窗：用户点它是"顺手看一眼"，不该打断手上的事。
 */

const KIND_LABEL: Record<OutputEntry["kind"], string> = {
  video: "成片",
  preview: "预览片段",
  still: "关键帧",
  cover: "封面",
  subtitle: "字幕",
};

/** 全部 tab 里的分组顺序：越"成品"越靠上 */
const KIND_ORDER: OutputEntry["kind"][] = ["video", "cover", "preview", "still", "subtitle"];

type Tab = "all" | OutputEntry["kind"];

const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "video", label: "成片" },
  { key: "preview", label: "预览" },
  { key: "still", label: "关键帧" },
  { key: "cover", label: "封面" },
  { key: "subtitle", label: "字幕" },
];

const fmtSize = (bytes: number) =>
  bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const fmtWhen = (ms: number) => {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)} 小时前`;
  return `${Math.round(diff / 86400_000)} 天前`;
};

/** 新命名里的 `__工程id` 去掉，显示更像标题 */
const displayName = (name: string) => name.replace(/__[A-Za-z0-9_]+\.(mp4|png|webp|srt|vtt)$/i, ".$1");

const extOf = (name: string) => (name.split(".").pop() ?? "").toLowerCase();

/** 每类默认先显示几条：有的工程关键帧三百多张，全展开会卡 */
const PAGE = 8;

/**
 * 产物浮框。
 * `refreshKey` 变化时重拉（渲染完成 / 抽帧完成后由 App 递增）。
 */
export const OutputsPopover: React.FC<{
  open: boolean;
  projectId: string;
  projectName: string;
  refreshKey: number;
  onClose: () => void;
  onManage: () => void;
}> = ({ open, projectId, projectName, refreshKey, onClose, onManage }) => {
  const [files, setFiles] = useState<OutputEntry[]>([]);
  const [tab, setTab] = useState<Tab>("all");
  const [selected, setSelected] = useState<OutputEntry | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [textPreview, setTextPreview] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await fetchOutputs(projectId);
      setFiles(list);
      // 选中的那条可能已经被清理掉了，别让它停留在预览区里骗人
      setSelected((prev) => (prev ? (list.find((x) => x.path === prev.path) ?? null) : null));
    } catch {
      /* 读不到就保持原列表，不弹错——产物面板不值得打断用户 */
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (open) void load();
  }, [open, refreshKey, load]);

  // 点外面关闭（点弹层内部不算）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  // 字幕类产物要读文本才能预览（图片/视频/音频用原生标签就够）
  useEffect(() => {
    if (!selected) {
      setTextPreview(null);
      return;
    }
    const isText = ["srt", "vtt", "txt"].includes(extOf(selected.name));
    if (!isText) {
      setTextPreview(null);
      return;
    }
    let alive = true;
    void fetch(selected.url)
      .then((r) => (r.ok ? r.text() : ""))
      .then((t) => {
        if (alive) setTextPreview(t ? t.split("\n").slice(0, 80).join("\n") : "（空文件）");
      })
      .catch(() => {
        if (alive) setTextPreview("（读取失败）");
      });
    return () => {
      alive = false;
    };
  }, [selected]);

  const counts = useMemo(() => {
    const m = new Map<Tab, number>();
    m.set("all", files.length);
    for (const f of files) m.set(f.kind, (m.get(f.kind) ?? 0) + 1);
    return m;
  }, [files]);

  const totalBytes = useMemo(() => files.reduce((n, f) => n + f.size, 0), [files]);

  /** 当前 tab 下要显示的列表，按类型分组 */
  const groups = useMemo(() => {
    const visible = tab === "all" ? files : files.filter((f) => f.kind === tab);
    const byKind = new Map<OutputEntry["kind"], OutputEntry[]>();
    for (const f of visible) {
      const arr = byKind.get(f.kind);
      if (arr) arr.push(f);
      else byKind.set(f.kind, [f]);
    }
    return KIND_ORDER.filter((k) => byKind.has(k)).map((k) => ({ kind: k, items: byKind.get(k)! }));
  }, [files, tab]);

  const toggleLock = async (entry: OutputEntry) => {
    const next = !entry.locked;
    // 先改本地：锁是个轻动作，等一个来回会让人以为没点上
    setFiles((prev) => prev.map((x) => (x.path === entry.path ? { ...x, locked: next || undefined } : x)));
    setSelected((prev) => (prev && prev.path === entry.path ? { ...prev, locked: next || undefined } : prev));
    try {
      await setOutputLock(entry.path, next);
      useDoc.getState().notify(next ? "已锁定：自动清理会跳过它" : "已解锁");
    } catch {
      setFiles((prev) => prev.map((x) => (x.path === entry.path ? { ...x, locked: entry.locked } : x)));
      useDoc.getState().notify("锁定失败");
    }
  };

  if (!open) return null;

  const renderPreview = (entry: OutputEntry) => {
    const ext = extOf(entry.name);
    const kind = entry.kind;
    if (kind === "video" || ext === "mp4" || ext === "webm") {
      return <video className="out-preview-media" src={entry.url} controls autoPlay playsInline preload="metadata" />;
    }
    if (kind === "still" || kind === "cover" || ["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) {
      return <img className="out-preview-media" src={entry.url} alt={entry.name} />;
    }
    if (["mp3", "wav", "m4a", "aac", "flac"].includes(ext)) {
      return <audio className="out-preview-audio" src={entry.url} controls autoPlay />;
    }
    return <pre className="out-preview-text">{textPreview ?? "读取中…"}</pre>;
  };

  return (
    <div className="out-pop" ref={boxRef} role="dialog" aria-label="产物">
      <div className="out-pop-head">
        <div className="out-pop-title">
          产物<span className="out-pop-sub">{projectName}</span>
        </div>
        <button className="ghost out-pop-manage" onClick={onManage} title="批量清理产物">
          管理…
        </button>
      </div>

      <div className="out-pop-tabs" role="tablist">
        {TABS.map((t) => {
          const n = counts.get(t.key) ?? 0;
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={`out-tab ${tab === t.key ? "is-on" : ""}`}
              onClick={() => setTab(t.key)}
              disabled={t.key !== "all" && n === 0}
            >
              {t.label}
              {n > 0 ? <span className="out-tab-n">{n}</span> : null}
            </button>
          );
        })}
      </div>

      <div className="out-pop-body">
        {loading && !files.length ? (
          <div className="out-empty">读取中…</div>
        ) : !files.length ? (
          <div className="out-empty">
            这个工程还没有产物。
            <div className="out-empty-actions">
              <span>抽一帧看看（关键帧）或直接渲染，产物会出现在这里。</span>
            </div>
          </div>
        ) : (
          groups.map(({ kind, items }) => {
            const openGroup = expanded.has(kind);
            const shown = openGroup ? items : items.slice(0, PAGE);
            return (
              <div className="out-group" key={kind}>
                <div className="out-group-head">
                  {KIND_LABEL[kind]}
                  <span className="out-group-n">{items.length}</span>
                  {kind === "preview" ? <span className="out-group-note">临时，只保留最近 10 个</span> : null}
                </div>
                {shown.map((f) => (
                  <button
                    key={f.path}
                    className={`out-row ${selected?.path === f.path ? "is-on" : ""}`}
                    onClick={(e) => {
                      // 预览区一展开列表就会变矮，点中的那行可能正好被挤出去——
                      // 把它拉回可视区，否则用户会以为自己点错了
                      e.currentTarget.scrollIntoView({ block: "nearest" });
                      setSelected(selected?.path === f.path ? null : f);
                    }}
                    title={f.name}
                  >
                    <span className={`out-row-icon kind-${f.kind}`} aria-hidden>
                      {f.kind === "video" || f.kind === "preview" ? "▶" : f.kind === "subtitle" ? "字" : "▣"}
                    </span>
                    <span className="out-row-main">
                      <span className="out-row-name">{displayName(f.name)}</span>
                      <span className="out-row-meta">
                        {fmtSize(f.size)} · {fmtWhen(f.mtimeMs)}
                        {f.locked ? " · 已锁定" : ""}
                      </span>
                    </span>
                    <span
                      className={`out-row-lock ${f.locked ? "is-on" : ""}`}
                      role="button"
                      tabIndex={0}
                      title={f.locked ? "解锁（解锁后可能被自动清理）" : "锁定：自动清理跳过它"}
                      onClick={(e) => {
                        e.stopPropagation();
                        void toggleLock(f);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          e.stopPropagation();
                          void toggleLock(f);
                        }
                      }}
                    >
                      {f.locked ? "🔒" : "🔓"}
                    </span>
                  </button>
                ))}
                {items.length > PAGE ? (
                  <button
                    className="out-more"
                    onClick={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(kind)) next.delete(kind);
                        else next.add(kind);
                        return next;
                      })
                    }
                  >
                    {openGroup ? "收起" : `展开全部 ${items.length} 个`}
                  </button>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      {selected ? (
        <div className="out-preview">
          <div className="out-preview-head">
            <span className="out-preview-name" title={selected.name}>
              {displayName(selected.name)}
            </span>
            <span className="out-preview-actions">
              <a href={selected.url} target="_blank" rel="noreferrer">
                原始文件
              </a>
              <a href={selected.url} download>
                下载
              </a>
              <button className="ghost" onClick={() => setSelected(null)} title="收起预览">
                收起
              </button>
            </span>
          </div>
          {renderPreview(selected)}
        </div>
      ) : null}

      <div className="out-pop-foot">
        <span>
          {files.length} 个 · 共 {fmtSize(totalBytes)}
        </span>
        <span className="out-pop-foot-hint">点一行预览 · Esc 关闭</span>
      </div>
    </div>
  );
};
