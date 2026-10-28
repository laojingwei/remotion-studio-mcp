import React, { useEffect, useMemo, useState } from "react";
import { deleteOutputFiles, fetchOutputs, type OutputEntry } from "../apiClient";
import { askConfirm } from "../ui";

/** 把新命名里的 `__projectId` 去掉，显示更像"标题" */
const displayName = (name: string) =>
  name.replace(/__[A-Za-z0-9_]+\.(mp4|png|webp)$/i, ".$1");

const fmtSize = (bytes: number) =>
  bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const fmtTime = (ms: number) =>
  new Date(ms).toLocaleString("zh-CN", { hour12: false });

const KIND_LABEL: Record<OutputEntry["kind"], string> = {
  video: "成片",
  still: "关键帧",
  subtitle: "字幕",
};

type Group = {
  projectId: string;
  title: string;
  /** 工程已被删：这些产物没人认领，建议清掉 */
  orphan: boolean;
  files: OutputEntry[];
};

/**
 * 渲染产物：按工程分组列出（out/projects/<工程id>/ 下的成片、关键帧、字幕），
 * 用户自己勾选要删的。工程已删的产物单独归到"已删工程"组，一眼能看出该清。
 */
export const OutputsDialog: React.FC<{ open: boolean; onClose: () => void }> = ({
  open,
  onClose,
}) => {
  const [files, setFiles] = useState<OutputEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const list = await fetchOutputs();
      setFiles(list);
      setSelected(new Set());
    } catch {
      /* 忽略读取失败，保持列表 */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, Group>();
    for (const f of files) {
      const g = map.get(f.projectId) ?? {
        projectId: f.projectId,
        title: f.projectName ?? `已删工程（${f.projectId}）`,
        orphan: !f.projectName,
        files: [],
      };
      g.files.push(f);
      map.set(f.projectId, g);
    }
    // 还在的工程在前，孤儿产物垫底
    return [...map.values()].sort((a, b) => {
      if (a.orphan !== b.orphan) return a.orphan ? 1 : -1;
      return (b.files[0]?.mtimeMs ?? 0) - (a.files[0]?.mtimeMs ?? 0);
    });
  }, [files]);

  if (!open) return null;

  const allSelected = files.length > 0 && selected.size === files.length;
  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const toggleGroup = (group: Group) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const all = group.files.every((f) => next.has(f.path));
      for (const f of group.files) {
        if (all) next.delete(f.path);
        else next.add(f.path);
      }
      return next;
    });

  const removeSelected = async () => {
    if (!selected.size || deleting) return;
    setDeleting(true);
    try {
      await deleteOutputFiles([...selected]);
      await load();
    } finally {
      setDeleting(false);
    }
  };

  const totalSize = files.reduce((s, f) => s + f.size, 0);
  const orphans = files.filter((f) => !f.projectName);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="outputs-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="outputs-head">
          <span>渲染产物</span>
          <span className="outputs-sub">
            {groups.length} 个工程 · 共 {files.length} 个 · {fmtSize(totalSize)}
          </span>
          <button className="ghost" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="outputs-toolbar">
          <label className="check-row">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() =>
                setSelected(allSelected ? new Set() : new Set(files.map((f) => f.path)))
              }
            />
            全选
          </label>
          <span className="hint">已选 {selected.size} 个</span>
          {orphans.length ? (
            <button
              className="mini"
              onClick={() => setSelected(new Set(orphans.map((f) => f.path)))}
            >
              选中已删工程的 {orphans.length} 个
            </button>
          ) : null}
        </div>

        <div className="outputs-list">
          {groups.length ? (
            groups.map((g) => {
              const groupSize = g.files.reduce((s, f) => s + f.size, 0);
              const allIn = g.files.every((f) => selected.has(f.path));
              return (
                <div className="outputs-group" key={g.projectId}>
                  <label className={`outputs-group-head ${g.orphan ? "is-orphan" : ""}`}>
                    <input type="checkbox" checked={allIn} onChange={() => toggleGroup(g)} />
                    <span className="outputs-group-name" title={g.projectId}>
                      {g.title}
                    </span>
                    <span className="outputs-group-meta">
                      {g.files.length} 个 · {fmtSize(groupSize)}
                    </span>
                  </label>
                  {g.files.map((f) => (
                    <label
                      key={f.path}
                      className={`outputs-item ${selected.has(f.path) ? "is-selected" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(f.path)}
                        onChange={() => toggle(f.path)}
                      />
                      <span className="outputs-name" title={f.path}>
                        {displayName(f.name)}
                      </span>
                      <span className="outputs-meta">
                        {KIND_LABEL[f.kind]} · {fmtSize(f.size)} · {fmtTime(f.mtimeMs)}
                      </span>
                    </label>
                  ))}
                </div>
              );
            })
          ) : (
            <div className="outputs-empty">{loading ? "读取中…" : "还没有渲染产物"}</div>
          )}
        </div>

        <div className="outputs-foot">
          <span className="hint">删除后不可恢复</span>
          <button
            className="ghost danger"
            disabled={!selected.size || deleting}
            onClick={() =>
              askConfirm({
                title: `删除 ${selected.size} 个文件？`,
                message: "渲染产物删除后无法恢复，当前正在使用的预览图需要重新渲染。",
                confirmLabel: "删除",
                onConfirm: () => void removeSelected(),
              })
            }
          >
            {deleting ? "删除中…" : `删除选中（${selected.size}）`}
          </button>
        </div>
      </div>
    </div>
  );
};
