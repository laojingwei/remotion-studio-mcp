import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  browseResources,
  clearResourceDir,
  fetchResourcesConfig,
  pickResourceDir,
  resourceThumbUrl,
  saveResourceDir,
  type ResourceBrowse,
  type ResourceCategory,
} from "../apiClient";

/**
 * 资源库浮框：用户把本地素材文件夹按类别登记进来，在这里浏览确认素材都在。
 *
 * 定位要分清：**人是登记人，agent 是使用人** —— 用户只管把文件夹配好；
 * agent 找素材走 search_local_assets 自己搜、自己拿引用地址，不需要人挑文件再「复制引用」递过去。
 * 所以这里没有选中/复制这类操作，文件列表纯展示（悬停可看引用地址）。
 *
 * 设计原则（与「导入素材库」的根本区别）：**文件不复制**。
 * 引用是本机 server 的 /resources/… 地址，预览同源可看、渲染按地址拉取，
 * 磁盘上永远只有一份素材。机制与安全边界见 server/resources.service.ts 顶部。
 *
 * 「浏览」为什么不是系统文件选择器：浏览器拿不到本机绝对路径
 * （webkitdirectory 只给相对路径，showDirectoryPicker 的句柄也不带路径），
 * 而 server 列目录需要绝对路径 —— 所以由 server 代劳：从盘符逐级往下点，
 * 走到目标文件夹后「使用此目录」。手填路径保留给知道确切位置的人。
 */

type PickState = { path: string; parent: string | null; entries: { name: string; dir: true; path: string }[] };

const fmtSize = (bytes?: number) => {
  if (!bytes) return "—";
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "svg"]);

const extOf = (name: string) => (name.split(".").pop() ?? "").toLowerCase();

export const ResourcesPopover: React.FC<{
  open: boolean;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
}> = ({ open, onClose, anchorRef }) => {
  const [cats, setCats] = useState<ResourceCategory[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [browse, setBrowse] = useState<ResourceBrowse | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** 目录选择器（server 端逐级浏览）：picking=true 时面板主体换成选目录视图 */
  const [picking, setPicking] = useState(false);
  const [pick, setPick] = useState<PickState | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const active = cats.find((c) => c.id === activeId) ?? null;

  const openCat = useCallback(async (id: string, dir: string | null) => {
    setErr(null);
    if (!dir) {
      setBrowse(null);
      return;
    }
    setLoading(true);
    try {
      setBrowse(await browseResources(id));
    } catch (e) {
      setBrowse(null);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // 打开时拉一次配置；切类别不重新拉（配置只有在保存路径时才会变）
  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const cfg = await fetchResourcesConfig();
        if (!alive) return;
        setCats(cfg.categories);
        const first = cfg.categories.find((c) => c.dir) ?? cfg.categories[0];
        if (first) {
          setActiveId(first.id);
          await openCat(first.id, first.dir);
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 点外面 / Esc 关闭：与「产物」浮框同一套（按钮自己要排除在"外面"之外）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (boxRef.current?.contains(t)) return;
      if (anchorRef?.current?.contains(t)) return;
      onClose();
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
  }, [open, onClose, anchorRef]);

  /** 把选择器里选中的目录存为该类配置并打开。dir 由调用方保证非空（来自 pick.path） */
  const saveAndOpen = async (dir: string) => {
    if (!activeId || !dir.trim()) return;
    setSaving(true);
    setErr(null);
    setPicking(false);
    try {
      const saved = await saveResourceDir(activeId, dir);
      setCats((prev) => prev.map((c) => (c.id === activeId ? { ...c, dir: saved.dir } : c)));
      await openCat(activeId, saved.dir);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  /** 目录选择器：path 空 = 盘符层 */
  const openPicker = async (p?: string) => {
    setPicking(true);
    setErr(null);
    try {
      setPick(await pickResourceDir(p ?? pick?.path ?? ""));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  /** 清除该类的目录配置：回到「还没配置」状态，之后重新浏览选择即可 */
  const clearDir = async () => {
    if (!activeId) return;
    setSaving(true);
    setErr(null);
    setPicking(false);
    try {
      await clearResourceDir(activeId);
      setCats((prev) => prev.map((c) => (c.id === activeId ? { ...c, dir: null } : c)));
      setBrowse(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const goto = async (sub: string) => {
    if (!activeId) return;
    setLoading(true);
    setErr(null);
    try {
      setBrowse(await browseResources(activeId, sub));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  /**
   * 进入当前目录下的某个子目录。**必须拼上当前路径**：
   * browse 的 entries.name 只是当前层的名字，直接把「草地」当 sub 传，
   * 服务端会去根目录下找「草地」，而不是「背景/草地」——二层的文件夹全部点进去就报 ENOENT。
   */
  const gotoChild = (name: string) => {
    void goto(browse?.path ? `${browse.path}/${name}` : name);
  };

  if (!open) return null;

  return (
    <div className="res-pop" ref={boxRef} role="dialog" aria-label="资源库">
      <div className="out-pop-head">
        <div className="out-pop-title">
          资源库<span className="out-pop-sub">本地素材目录 · 引用不复制</span>
        </div>
        <button className="ghost" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </div>

      <div className="res-tabs">
        {cats.map((c) => (
          <button
            key={c.id}
            className={`res-tab ${c.id === activeId ? "is-on" : ""}`}
            onClick={() => {
              setActiveId(c.id);
              setPicking(false);
              setErr(null);
              void openCat(c.id, c.dir);
            }}
            title={c.dir ? c.dir : "还没配置目录"}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="res-path-row">
        {/*
          只读展示当前配置：改路径走「浏览…」（逐级选），删配置走「清除」。
          以前这里可编辑 + 「打开」按钮，但路径粘贴容易错层（草地在二层，
          手填一层就报不存在），且和选择器完全重复 —— 砍掉。
        */}
        <input
          value={active?.dir ?? ""}
          readOnly
          placeholder="还没配置目录 —— 点「浏览…」选择一个文件夹"
          spellCheck={false}
          title={active?.dir ?? ""}
        />
        <button className="ghost" onClick={() => void openPicker()}>
          浏览…
        </button>
        {active?.dir ? (
          <button className="ghost" onClick={() => void clearDir()} title={`取消 ${active.dir} 的配置`}>
            清除
          </button>
        ) : null}
      </div>

      {err ? <div className="res-error">{err}</div> : null}

      <div className="res-body">
        {picking ? (
          pick ? (
            <>
              <div className="res-crumb">
                {pick.parent !== null ? (
                  <button className="ghost" onClick={() => void openPicker(pick.parent ?? "")}>
                    ← 上一级
                  </button>
                ) : null}
                <span className="res-crumb-root">{pick.path || "此电脑（选一个盘）"}</span>
                {pick.path ? (
                  <button
                    className="ghost res-pick-use"
                    onClick={() => void saveAndOpen(pick.path)}
                    disabled={saving}
                  >
                    ✓ 使用此目录
                  </button>
                ) : null}
              </div>
              <div className="res-grid">
                {pick.entries.map((ent) => (
                  <button
                    key={ent.path}
                    className="res-cell res-cell-dir"
                    onClick={() => void openPicker(ent.path)}
                    title={ent.path}
                  >
                    <span className="res-dir-icon" aria-hidden>
                      ▸
                    </span>
                    <span className="res-name">{ent.name}</span>
                  </button>
                ))}
                {!pick.entries.length ? <div className="res-hint">这个目录下没有子文件夹。</div> : null}
              </div>
            </>
          ) : (
            <div className="res-hint">读取中…</div>
          )
        ) : loading ? (
          <div className="res-hint">读取中…</div>
        ) : !browse ? (
          <div className="res-hint">
            给「{active?.label ?? "这一类"}」指定一个本机文件夹，agent 就能在里面搜索并直接引用这里的文件（不复制）。
          </div>
        ) : (
          <>
            <div className="res-crumb">
              {browse.parent !== null ? (
                <button className="ghost" onClick={() => void goto(browse.parent ?? "")}>
                  ← 上一级
                </button>
              ) : (
                <span className="res-crumb-root">{browse.root}</span>
              )}
              <span className="res-crumb-sub">{browse.path ? `${browse.path} · ` : ""}{browse.entries.length} 项</span>
            </div>
            {browse.sequence ? (
              <>
                <div className="res-hint">
                  序列帧文件夹：{browse.sequence.frames} 帧（{browse.sequence.firstFrame} … {browse.sequence.lastFrame}）
                  {browse.sequence.continuous ? "" : "，编号有跳号"}。
                  agent 用 search_local_assets(fx) 直接拿模式串引用，不用逐张挑；下面只预览前 8 帧。
                </div>
                <div className="res-grid">
                  {browse.preview?.map((u) => (
                    <span key={u} className="res-cell">
                      <span className="res-thumb">
                        <img src={resourceThumbUrl(u)} alt="" loading="lazy" />
                      </span>
                    </span>
                  ))}
                </div>
              </>
            ) : null}
            <div className="res-grid">
              {browse.entries.map((ent) =>
                ent.dir ? (
                  <button key={`d-${ent.name}`} className="res-cell res-cell-dir" onClick={() => gotoChild(ent.name)}>
                    <span className="res-dir-icon" aria-hidden>
                      ▸
                    </span>
                    <span className="res-name">{ent.name}</span>
                  </button>
                ) : (
                  <button
                    key={`f-${ent.name}`}
                    className="res-cell"
                    /** 引用地址悬停可看；agent 用它时走 search_local_assets，不需要人来复制 */
                    title={ent.url}
                  >
                    <span className="res-thumb">
                      {isImageExt(ent.name) ? (
                        <img src={resourceThumbUrl(ent.url ?? "")} alt="" loading="lazy" />
                      ) : (
                        <span className="res-ext">{extOf(ent.name) || "?"}</span>
                      )}
                    </span>
                    <span className="res-name">{ent.name}</span>
                    <span className="res-size">{fmtSize(ent.size)}</span>
                  </button>
                ),
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

const isImageExt = (name: string) => IMAGE_EXTS.has(extOf(name));
