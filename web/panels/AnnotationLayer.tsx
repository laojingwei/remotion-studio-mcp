import React, { useEffect, useMemo, useRef, useState } from "react";
import { sceneSpans } from "@shared/schema";
import {
  addAnnotation,
  deleteAnnotation,
  fetchAnnotations,
  resolveAnnotations,
  type Annotation,
} from "../apiClient";
import { frameBus } from "../frameBus";

type Props = {
  projectId: string;
  fps: number;
  scenes: { id: string; name: string }[];
  /** 当前选中的幕：批注挂在它上面 */
  selectedSceneId: string;
};

/**
 * 时间码批注。
 *
 * 为什么是「暂停在某一帧写一句」而不是在画面上画框：画框会和元素选中手势打架
 * （点一下到底是选元素还是标批注，用户分不清），而真正要知道的是「**第几帧**
 * 有问题」。所以做成：拖到那一帧 → 点「批注」→ 写一句 → 保存。
 *
 * 定位存的是**幕内帧**：别的幕改时长时，全局帧会整体错位，幕内帧不会。
 * agent 侧对应 get_annotations / resolve_annotation 两个工具。
 */
export function AnnotationLayer({ projectId, fps, scenes, selectedSceneId }: Props) {
  const [list, setList] = useState<Annotation[]>([]);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [err, setErr] = useState("");
  const [frame, setFrame] = useState(() => frameBus.get());
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => frameBus.subscribe(setFrame), []);

  const load = () => {
    if (!projectId) return;
    void fetchAnnotations(projectId)
      .then(setList)
      .catch(() => setList([]));
  };
  useEffect(load, [projectId]);

  // 点外面 / Esc 收起
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    // 捕获阶段：画布上有自己的 mousedown（拖选元素），冒泡阶段可能被吃掉
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const spans = useMemo(() => sceneSpans(scenes as never[]), [scenes]);
  const order = useMemo(() => new Map(spans.map((s, i) => [s.id, i])), [spans]);

  const idx = scenes.findIndex((s) => s.id === selectedSceneId);
  const span = idx >= 0 ? spans[idx] : null;
  const sceneFrame = span ? Math.max(0, Math.min(span.dur - 1, frame - span.start)) : 0;
  const sceneLabel =
    idx >= 0 ? `第 ${idx + 1} 幕「${scenes[idx].name}」` : "（先选一幕）";

  const tc = (f: number) => {
    const sec = f / (fps || 30);
    return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${(sec % 60).toFixed(1).padStart(4, "0")}`;
  };

  const openCount = list.filter((a) => !a.resolved).length;
  const visible = (showResolved ? list : list.filter((a) => !a.resolved))
    .slice()
    .sort(
      (a, b) =>
        (order.get(a.sceneId) ?? 999) - (order.get(b.sceneId) ?? 999) ||
        a.frameInScene - b.frameInScene,
    );

  const save = async () => {
    if (!text.trim() || !selectedSceneId) return;
    setBusy(true);
    setErr("");
    try {
      await addAnnotation(projectId, {
        sceneId: selectedSceneId,
        frameInScene: sceneFrame,
        text,
        frameAtCreate: frame,
      });
      setText("");
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const jump = (a: Annotation) => {
    const i = order.get(a.sceneId);
    const sp = i === undefined ? null : spans[i];
    if (sp) frameBus.seek(sp.start + a.frameInScene);
  };

  return (
    <div className="anno" ref={boxRef}>
      <button
        className={`anno-fab ${open ? "is-on" : ""} ${openCount ? "has-open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title="在出问题的那一帧留批注（agent 能读到精确到帧的定位）"
        aria-expanded={open}
      >
        批注{openCount ? <span className="anno-badge">{openCount}</span> : null}
      </button>

      {open ? (
        <div className="anno-pop" role="dialog" aria-label="时间码批注">
          <div className="anno-head">
            <span className="anno-head-title">批注</span>
            <span className="anno-head-where">
              {sceneLabel} · {tc(Math.max(0, frame))}
            </span>
          </div>

          <div className="anno-compose">
            <textarea
              className="anno-input"
              value={text}
              placeholder={`在 ${tc(Math.max(0, frame))} 这一帧看到什么？写原话就行，比如「这个转场太硬」「字幕来不及读完」`}
              rows={2}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // Ctrl/Cmd+Enter 保存：写批注时手不会离开键盘
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void save();
                }
              }}
            />
            <div className="anno-compose-foot">
              <span className="anno-hint">
                幕内第 {sceneFrame} 帧 · Ctrl/⌘+Enter 保存
              </span>
              <button className="primary anno-save" disabled={busy || !text.trim() || !selectedSceneId} onClick={() => void save()}>
                {busy ? "保存中…" : "保存"}
              </button>
            </div>
            {err ? <div className="anno-err">{err}</div> : null}
          </div>

          <div className="anno-list-head">
            <span>
              {openCount ? `${openCount} 条待处理` : "暂无待处理批注"}
              {list.length > openCount ? ` · 共 ${list.length} 条` : ""}
            </span>
            <label className="anno-filter">
              <input
                type="checkbox"
                checked={showResolved}
                onChange={(e) => setShowResolved(e.target.checked)}
              />
              显示已修
            </label>
          </div>

          <div className="anno-list">
            {visible.length === 0 ? (
              <div className="anno-empty">
                用户看片时停到出问题的那一帧，写一句，agent 就能精确改到那一帧，
                不用再靠「第 3 幕有点怪」猜。
              </div>
            ) : (
              visible.map((a) => {
                const i = order.get(a.sceneId);
                return (
                  <div key={a.id} className={`anno-item ${a.resolved ? "is-resolved" : ""}`}>
                    <button className="anno-item-where" onClick={() => jump(a)} title="跳到这一帧">
                      {i === undefined ? `幕 ${a.sceneId}` : `第 ${i + 1} 幕`} ·{" "}
                      {tc((i === undefined ? 0 : spans[i].start) + a.frameInScene)}
                    </button>
                    <div className="anno-item-text">{a.text}</div>
                    <div className="anno-item-acts">
                      <button
                        className="ghost"
                        onClick={() => {
                          void resolveAnnotations(projectId, [a.id], !a.resolved).then(load);
                        }}
                      >
                        {a.resolved ? "恢复" : "已修"}
                      </button>
                      <button
                        className="ghost"
                        onClick={() => {
                          void deleteAnnotation(projectId, a.id).then(load);
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <div className="anno-foot">
            agent 用 <code>get_annotations</code> 读；改完会标「已修」。
          </div>
        </div>
      ) : null}
    </div>
  );
}
