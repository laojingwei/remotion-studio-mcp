import React, { useMemo, useRef, useState } from "react";
import {
  ELEMENT_LIBRARY,
  LIBRARY_CATS,
  elementFromLibrary,
  type ElementCategory,
  type LibraryItem,
} from "@shared/elementLibrary";
import { assetLibraryId, assetToElement, type CustomAsset } from "@shared/assetLibrary";
import { useDoc } from "../store";
import type { ProjectAsset } from "../apiClient";
import { askConfirm } from "../ui";
import { ElementPreview, type PreviewTarget } from "./ElementPreview";

/** 素材缩略图：直接用和画布一致的方式画，避免"库里好看、放进去不一样" */
const Thumb: React.FC<{ item: LibraryItem }> = ({ item }) =>
  item.kind === "text" ? (
    <span
      className="lib-text"
      style={{
        background: item.bg,
        color: item.fill ?? "var(--text)",
        fontWeight: item.weight ?? 700,
      }}
    >
      {item.text}
    </span>
  ) : (
    <svg
      viewBox={item.viewBox ?? "0 0 24 24"}
      width="22"
      height="22"
      fill={item.stroke ? "none" : "currentColor"}
      stroke={item.stroke ? "currentColor" : "none"}
      strokeWidth={item.strokeWidth ?? 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      dangerouslySetInnerHTML={{ __html: item.svg ?? "" }}
    />
  );

/** 悬停预览用的大号图标 */
const BigThumb: React.FC<{ item: LibraryItem }> = ({ item }) =>
  item.kind === "text" ? (
    <span
      className="lib-text"
      style={{
        background: item.bg,
        color: item.fill ?? "var(--text)",
        fontWeight: item.weight ?? 700,
        fontSize: 20,
        padding: "4px 10px",
      }}
    >
      {item.text}
    </span>
  ) : (
    <svg
      viewBox={item.viewBox ?? "0 0 24 24"}
      width="64"
      height="64"
      fill={item.stroke ? "none" : "currentColor"}
      stroke={item.stroke ? "currentColor" : "none"}
      strokeWidth={item.strokeWidth ?? 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      dangerouslySetInnerHTML={{ __html: item.svg ?? "" }}
    />
  );

type Source = "builtin" | "mine" | "project";

/**
 * 元素素材库。
 *
 * 两种放入方式：
 *  - 拖到画面上：落点就是元素中心（HTML5 拖放，跨面板最省事）
 *  - 点一下：放到画面中心，适合"先放再调"
 * 放进去之后它就是一个普通的自由元素，能拖能转能删，agent 也能改。
 *
 * 「我的」里放的是上传/agent 生成的图片：跨工程复用，重命名、删除都在这里。
 */
export const ElementLibrary: React.FC = () => {
  const project = useDoc((s) => s.project);
  const selectedId = useDoc((s) => s.selectedId);
  const apply = useDoc((s) => s.apply);
  const setSelection = useDoc((s) => s.setSelection);
  const notify = useDoc((s) => s.notify);
  const assets = useDoc((s) => s.assets);
  const uploadAsset = useDoc((s) => s.uploadAsset);
  const removeAsset = useDoc((s) => s.removeAsset);
  const removeAssets = useDoc((s) => s.removeAssets);
  const renameAsset = useDoc((s) => s.renameAsset);
  const projectAssets = useDoc((s) => s.projectAssets);
  const loadProjectAssets = useDoc((s) => s.loadProjectAssets);
  const uploadToProject = useDoc((s) => s.uploadToProject);
  const removeProjectAsset = useDoc((s) => s.removeProjectAsset);
  const removeProjectAssets = useDoc((s) => s.removeProjectAssets);

  const [source, setSource] = useState<Source>("builtin");
  const [hoverEl, setHoverEl] = useState<{ item: LibraryItem; x: number; y: number } | null>(null);
  const [cat, setCat] = useState<ElementCategory | "全部">("全部");
  const [q, setQ] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [projDragOver, setProjDragOver] = useState(false);
  /** 点击卡片时先看的大图（拖动仍然直接落画布） */
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  /** 批量删除：多选开关与已选集合（键：我的用 asset id，本工程用文件名） */
  const [multi, setMulti] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);
  const projFileRef = useRef<HTMLInputElement>(null);

  const items = useMemo(
    () =>
      ELEMENT_LIBRARY.filter(
        (it) =>
          (cat === "全部" || it.cat === cat) &&
          (!q.trim() || it.name.includes(q.trim()) || it.id.includes(q.trim().toLowerCase())),
      ),
    [cat, q],
  );

  const myItems = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return kw ? assets.filter((a) => a.name.toLowerCase().includes(kw)) : assets;
  }, [assets, q]);

  /** 本工程目录里的文件（按搜索词过滤） */
  const projItems = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return kw ? projectAssets.filter((a) => a.name.toLowerCase().includes(kw)) : projectAssets;
  }, [projectAssets, q]);

  const scene = project?.scenes.find((s) => s.id === selectedId);

  /** 统一的落库出口：内置素材走这里 */
  const addBuiltin = async (item: LibraryItem) => {
    if (!selectedId) {
      notify("先选一个场景，元素会放进那个场景");
      return;
    }
    const id = `el_${(globalThis.crypto?.randomUUID?.() ?? String(Math.random())).slice(0, 8)}`;
    await apply([
      {
        op: "add_element",
        sceneId: selectedId,
        element: { ...elementFromLibrary(item.id, { x: 50, y: 52 }), id },
      },
    ]);
    setSelection([`ov:${id}`]);
    notify(`已放入「${item.name}」`);
  };

  const addMine = (a: CustomAsset, at?: { x: number; y: number }) => {
    if (!selectedId) {
      notify("先选一个场景，元素会放进那个场景");
      return;
    }
    const id = `el_${(globalThis.crypto?.randomUUID?.() ?? String(Math.random())).slice(0, 8)}`;
    void apply([
      {
        op: "add_element",
        sceneId: selectedId,
        element: { ...assetToElement(a, at, useDoc.getState().project?.fps ?? 30), id },
      },
    ]);
    setSelection([`ov:${id}`]);
    notify(`已放入「${a.name}」`);
  };

  /** 直接把磁盘上的图片 / 视频拖进来：先入库，再放上画面 */
  const onDropFiles = async (files: FileList) => {
    const media = [...files].filter(
      (f) =>
        f.type.startsWith("image/") ||
        f.type.startsWith("video/") ||
        f.type.startsWith("audio/"),
    );
    if (!media.length) {
      notify("只支持图片 / 视频 / 音频文件");
      return;
    }
    for (const f of media.slice(0, 6)) {
      const item = await uploadAsset(f);
      if (item) addMine(item);
    }
  };

  /* ───────────────── 多选与预览 ───────────────── */

  const resetSelect = () => {
    setMulti(false);
    setSel(new Set());
  };

  const toggleOne = (key: string) =>
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const allChecked = (keys: string[]) => keys.length > 0 && keys.every((k) => sel.has(k));
  const toggleAllKeys = (keys: string[]) =>
    setSel(allChecked(keys) ? new Set() : new Set(keys));

  /** 批量删「我的素材」：条目删掉，文件按引用集合回收（工程还在用的会留在磁盘上） */
  const deleteSelectedAssets = () => {
    const ids = [...sel];
    if (!ids.length) return;
    askConfirm({
      title: `删除 ${ids.length} 个素材？`,
      message:
        "会从「我的素材」里移除这些条目。仍被工程引用的文件会保留在磁盘上（画面不受影响），其余文件一并回收。",
      confirmLabel: `删除 ${ids.length} 个`,
      onConfirm: () => {
        setSel(new Set());
        void removeAssets(ids);
      },
    });
  };

  /** 批量删本工程文件：会回报"其中多少个仍被引用" */
  const deleteSelectedProjectAssets = () => {
    const names = [...sel];
    if (!names.length) return;
    const used = projItems.filter((a) => sel.has(a.name) && a.referenced).length;
    askConfirm({
      title: `删除 ${names.length} 个文件？`,
      message:
        used > 0
          ? `⚠ 其中 ${used} 个仍被工程引用，删除后画面会裂图（引用不会自动清掉）。文件不进回收站。`
          : "只删磁盘上的文件，不进回收站。",
      confirmLabel: `删除 ${names.length} 个`,
      onConfirm: () => {
        setSel(new Set());
        void removeProjectAssets(names);
      },
    });
  };

  /** 本工程素材 → 画面元素（不走 libraryId：它不属于素材库） */
  const addProjectItem = (a: ProjectAsset) => {
    if (!selectedId) {
      notify("先选一个场景，元素会放进那个场景");
      return;
    }
    const id = `el_${(globalThis.crypto?.randomUUID?.() ?? String(Math.random())).slice(0, 8)}`;
    const kind = a.kind === "image" || a.kind === "video" || a.kind === "audio" ? a.kind : "image";
    const el = assetToElement(
      { id: a.name, name: a.name, url: a.url, kind, bytes: a.bytes },
      undefined,
      useDoc.getState().project?.fps ?? 30,
    );
    // libraryId 是「我的素材」的 id 空间，本工程文件不该带
    delete (el as { libraryId?: string }).libraryId;
    void apply([{ op: "add_element", sceneId: selectedId, element: { ...el, id } as never }]);
    setSelection([`ov:${id}`]);
    notify(`已放入「${a.name}」`);
  };

  /** 拖文件到「本工程」区：写进 assets/projects/<id>/，不进共用库 */
  const onDropProjectFiles = async (files: FileList) => {
    const media = [...files].filter(
      (f) =>
        f.type.startsWith("image/") ||
        f.type.startsWith("video/") ||
        f.type.startsWith("audio/"),
    );
    if (!media.length) {
      notify("只支持图片 / 视频 / 音频文件");
      return;
    }
    for (const f of media.slice(0, 6)) await uploadToProject(f);
  };

  return (
    <>
      <div className="panel-head">
        <span>元素素材</span>
        <span className="hint">
          {source === "builtin"
            ? ELEMENT_LIBRARY.length
            : source === "project"
              ? projItems.length
              : myItems.length}{" "}
          个
        </span>
      </div>

      <div className="lib-source">
        <button
          className={`lib-src ${source === "builtin" ? "is-active" : ""}`}
          onClick={() => {
            setSource("builtin");
            resetSelect();
          }}
        >
          内置
        </button>
        <button
          className={`lib-src ${source === "mine" ? "is-active" : ""}`}
          onClick={() => {
            setSource("mine");
            resetSelect();
          }}
        >
          我的{assets.length ? ` (${assets.length})` : ""}
        </button>
        <button
          className={`lib-src ${source === "project" ? "is-active" : ""}`}
          title="本工程自己的素材目录（删工程会一起清掉）"
          onClick={() => {
            setSource("project");
            resetSelect();
            void loadProjectAssets();
          }}
        >
          本工程{projectAssets.length ? ` (${projectAssets.length})` : ""}
        </button>
      </div>

      <div className="lib-search">
        <input
          placeholder={
            source === "builtin"
              ? "搜素材，如 箭头 / 星标"
              : source === "project"
                ? "搜本工程素材"
                : "搜我的素材"
          }
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {source === "builtin" ? (
        <>
          <div className="lib-cats">
            {(["全部", ...LIBRARY_CATS] as const).map((c) => (
              <button
                key={c}
                className={`lib-cat ${cat === c ? "is-active" : ""}`}
                onClick={() => setCat(c as ElementCategory | "全部")}
              >
                {c}
              </button>
            ))}
          </div>

          <div className="lib-grid">
            {items.map((it) => (
              <button
                key={it.id}
                className="lib-item"
                draggable
                title={`${it.name} · 点击看详情，拖到画面里直接放入`}
                onMouseEnter={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  const x = r.right + 10 + 160 > window.innerWidth ? r.left - 170 : r.right + 10;
                  setHoverEl({ item: it, x, y: Math.max(8, r.top) });
                }}
                onMouseLeave={() => setHoverEl(null)}
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/x-element", it.id);
                  // 兼容：某些环境只让读 text/plain
                  e.dataTransfer.setData("text/plain", it.id);
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onClick={() => {
                  setHoverEl(null);
                  setPreview({ kind: "builtin", item: it });
                }}
              >
                <span className="lib-thumb">
                  <Thumb item={it} />
                </span>
                <span className="lib-name">{it.name}</span>
              </button>
            ))}
            {!items.length ? <div className="empty">没有匹配的素材</div> : null}
          </div>

          {hoverEl ? (
            <div className="picker-preview" style={{ left: hoverEl.x, top: hoverEl.y }}>
              <div className="element-preview-thumb">
                <BigThumb item={hoverEl.item} />
              </div>
              <div className="picker-preview-name">{hoverEl.item.name}</div>
              <div className="picker-preview-desc">{hoverEl.item.cat}</div>
            </div>
          ) : null}
        </>
      ) : source === "mine" ? (
        <>
          <div className="lib-mine-head">
            <span className="hint">{assets.length ? `${assets.length} 张素材` : "还没有素材"}</span>
            <div className="lib-head-ops">
              {assets.length ? (
                <button
                  className={`mini ${multi ? "is-on" : ""}`}
                  title="多选后可以一次删掉多个"
                  onClick={() => {
                    setMulti((v) => !v);
                    setSel(new Set());
                  }}
                >
                  {multi ? "退出多选" : "多选"}
                </button>
              ) : null}
              <button
                className="mini"
                title="只删除既不在素材库、也没被任何工程引用的文件"
                onClick={() =>
                  askConfirm({
                    title: "清理未引用的素材文件？",
                    message: "只删除既不在素材库里、也没有被任何工程引用的文件，删掉后不可恢复。",
                    confirmLabel: "清理",
                    onConfirm: () => void useDoc.getState().cleanupAssets(),
                  })
                }
              >
                清理未引用
              </button>
            </div>
          </div>
          {multi ? (
            <div className="lib-multi-bar">
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={allChecked(myItems.map((a) => a.id))}
                  onChange={() => toggleAllKeys(myItems.map((a) => a.id))}
                />
                全选
              </label>
              <span className="hint">已选 {sel.size}</span>
              <button
                className="mini danger"
                disabled={!sel.size}
                onClick={deleteSelectedAssets}
              >
                删除选中{sel.size ? `（${sel.size}）` : ""}
              </button>
            </div>
          ) : null}
          <div
            className={`lib-drop ${dragOver ? "is-over" : ""}`}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (e.dataTransfer.files?.length) void onDropFiles(e.dataTransfer.files);
            }}
          >
            <span className="lib-drop-plus">＋</span>
            <span>点这里，或把图片 / 视频 / 音频拖进来</span>
            <span className="hint">图片 / 视频 / 音频，可复用</span>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*,video/*,audio/*"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) void onDropFiles(e.target.files);
              e.target.value = "";
            }}
          />

          <div className="lib-grid lib-grid-mine">
            {myItems.map((a) => (
              <div
                key={a.id}
                className="lib-item lib-item-mine"
                draggable
                title={`${a.name} · 点击看详情，拖到画面里直接放入`}
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/x-element", assetLibraryId(a.id));
                  e.dataTransfer.setData("text/plain", assetLibraryId(a.id));
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onClick={() => {
                  if (multi) toggleOne(a.id);
                  else setPreview({ kind: "mine", item: a });
                }}
              >
                {multi ? (
                  <span className={`lib-check ${sel.has(a.id) ? "is-on" : ""}`}>
                    {sel.has(a.id) ? "✓" : ""}
                  </span>
                ) : null}
                <span className="lib-thumb">
                  {a.kind === "audio" ? (
                    <span className="lib-video-mark" title="音频素材">♪</span>
                  ) : a.kind === "video" && !a.thumbUrl ? (
                    <span className="lib-video-mark" title="视频素材">▶</span>
                  ) : (
                    <img src={a.thumbUrl ?? a.url} alt={a.name} loading="lazy" draggable={false} />
                  )}
                </span>
                {renamingId === a.id ? (
                  <input
                    className="lib-rename"
                    autoFocus
                    value={draftName}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setDraftName(e.target.value)}
                    onBlur={() => {
                      void renameAsset(a.id, draftName);
                      setRenamingId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") setRenamingId(null);
                      e.stopPropagation();
                    }}
                  />
                ) : (
                  <span className="lib-name">{a.name}</span>
                )}
                <span className="lib-mine-ops">
                  <button
                    title="重命名"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenamingId(a.id);
                      setDraftName(a.name);
                    }}
                  >
                    ✎
                  </button>
                  <button
                    title="删除"
                    onClick={(e) => {
                      e.stopPropagation();
                      askConfirm({
                        title: `删除素材「${a.name}」？`,
                        message: "会从「我的素材」里移除；已经放到画面上的元素仍然正常显示。",
                        confirmLabel: "删除素材",
                        onConfirm: () => void removeAsset(a.id),
                      });
                    }}
                  >
                    ×
                  </button>
                </span>
              </div>
            ))}
            {!myItems.length ? (
              <div className="empty">{assets.length ? "没有匹配的素材" : "还没有素材，先传一张"}</div>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <div className="lib-mine-head">
            <span className="hint">
              {projectAssets.length
                ? `${projectAssets.length} 个文件 · 只属于本工程`
                : "这个工程还没有自己的素材"}
            </span>
            <div className="lib-head-ops">
              {projectAssets.length ? (
                <button
                  className={`mini ${multi ? "is-on" : ""}`}
                  onClick={() => {
                    setMulti((v) => !v);
                    setSel(new Set());
                  }}
                >
                  {multi ? "退出多选" : "多选"}
                </button>
              ) : null}
              <span className="hint" title={`public/assets/projects/${project?.id ?? "…"}/`}>
                目录
              </span>
            </div>
          </div>
          {multi ? (
            <div className="lib-multi-bar">
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={allChecked(projItems.map((a) => a.name))}
                  onChange={() => toggleAllKeys(projItems.map((a) => a.name))}
                />
                全选
              </label>
              <span className="hint">已选 {sel.size}</span>
              <button
                className="mini danger"
                disabled={!sel.size}
                onClick={deleteSelectedProjectAssets}
              >
                删除选中{sel.size ? `（${sel.size}）` : ""}
              </button>
            </div>
          ) : null}
          <div
            className={`lib-drop ${projDragOver ? "is-over" : ""}`}
            onClick={() => projFileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setProjDragOver(true);
            }}
            onDragLeave={() => setProjDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setProjDragOver(false);
              if (e.dataTransfer.files?.length) void onDropProjectFiles(e.dataTransfer.files);
            }}
          >
            <span className="lib-drop-plus">＋</span>
            <span>拖进来只给这一支片子用</span>
            <span className="hint">存进 assets/projects/&lt;工程id&gt;/，删工程一起清</span>
          </div>
          <input
            ref={projFileRef}
            type="file"
            accept="image/*,video/*,audio/*"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) void onDropProjectFiles(e.target.files);
              e.target.value = "";
            }}
          />

          <div className="lib-grid lib-grid-mine">
            {projItems.map((a) => (
              <div
                key={a.rel}
                className="lib-item lib-item-mine"
                draggable
                title={`${a.name} · 点击看详情，拖到画面里直接放入（${Math.max(1, Math.round(a.bytes / 1024))}KB${
                  a.referenced ? " · 工程正在用" : ""
                }）`}
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/x-project-asset", a.url);
                  e.dataTransfer.setData("text/plain", a.url);
                  e.dataTransfer.setData("text/x-element", a.url);
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onClick={() => {
                  if (multi) toggleOne(a.name);
                  else setPreview({ kind: "project", item: a });
                }}
              >
                {multi ? (
                  <span className={`lib-check ${sel.has(a.name) ? "is-on" : ""}`}>
                    {sel.has(a.name) ? "✓" : ""}
                  </span>
                ) : null}
                <span className="lib-thumb">
                  {a.kind === "image" ? (
                    <img src={a.url} alt={a.name} loading="lazy" draggable={false} />
                  ) : (
                    <span className="lib-video-mark" title={a.kind}>
                      {a.kind === "audio" ? "♪" : a.kind === "video" ? "▶" : "?"}
                    </span>
                  )}
                </span>
                <span className="lib-name">{a.name}</span>
                <span className="lib-mine-ops">
                  <button
                    title={a.referenced ? "工程仍引用它：删了会裂图" : "删除文件"}
                    onClick={(e) => {
                      e.stopPropagation();
                      askConfirm({
                        title: `删除文件「${a.name}」？`,
                        message: a.referenced
                          ? "⚠ 工程里仍有元素引用这个文件，删除后画面会裂图（引用不会自动清掉）。"
                          : "只删磁盘上的文件，不进回收站。",
                        confirmLabel: "删除",
                        onConfirm: () => void removeProjectAsset({ name: a.name }),
                      });
                    }}
                  >
                    ×
                  </button>
                </span>
                {a.referenced ? <span className="lib-placed-kind">用</span> : null}
              </div>
            ))}
            {!projItems.length ? (
              <div className="empty">
                {projectAssets.length ? "没有匹配的文件" : "还没有文件：把要用的图/音/视频拖进来"}
              </div>
            ) : null}
          </div>
        </>
      )}

      {scene?.elements?.length ? (
        <div className="lib-placed">
          <div className="lib-placed-head">本场景已放 {scene.elements.length} 个</div>
          <div className="lib-placed-list">
            {scene.elements.map((el) => (
              <div
                key={el.id}
                className="lib-placed-row"
                onClick={() => setSelection([`ov:${el.id}`])}
                title="点选；× 删除"
              >
                <span className="lib-placed-name">{el.name}</span>
                <span className="lib-placed-kind">{el.kind}</span>
                <button
                  className="lib-placed-del"
                  onClick={(e) => {
                    e.stopPropagation();
                    // 删元素是可撤销的高频操作，不弹确认
                    void apply([{ op: "remove_element", sceneId: selectedId!, elementId: el.id }]);
                  }}
                  title="删除"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="panel-foot">
        <span className="hint">{scene ? `放入「${scene.name}」` : "先选场景"}</span>
        <span className="hint">拖入画面 · 点开详情</span>
      </div>

      {preview ? (
        <ElementPreview
          target={preview}
          onClose={() => setPreview(null)}
          onAdd={() => {
            const t = preview;
            setPreview(null);
            if (t.kind === "builtin") void addBuiltin(t.item);
            else if (t.kind === "mine") addMine(t.item);
            else addProjectItem(t.item);
          }}
          onRemove={
            preview.kind === "builtin"
              ? undefined
              : () => {
                  const t = preview;
                  setPreview(null);
                  if (t.kind === "mine") {
                    askConfirm({
                      title: `删除素材「${t.item.name}」？`,
                      message: "会从「我的素材」里移除；已经放到画面上的元素仍然正常显示。",
                      confirmLabel: "删除素材",
                      onConfirm: () => void removeAsset(t.item.id),
                    });
                  } else if (t.kind === "project") {
                    askConfirm({
                      title: `删除文件「${t.item.name}」？`,
                      message: t.item.referenced
                        ? "⚠ 工程里仍有元素引用这个文件，删除后画面会裂图（引用不会自动清掉）。"
                        : "只删磁盘上的文件，不进回收站。",
                      confirmLabel: "删除",
                      onConfirm: () => void removeProjectAsset({ name: t.item.name }),
                    });
                  }
                }
          }
        />
      ) : null}
    </>
  );
};
