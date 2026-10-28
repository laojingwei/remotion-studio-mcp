import React, { useEffect, useMemo, useRef, useState } from "react";
import { describeFields, getMeta, metaList, type FieldDesc } from "@shared/sceneMetas";
import { useDoc } from "../store";
import { askConfirm } from "../ui";
import { fetchSceneTypes } from "../apiClient";
import { SCENE_SKETCH } from "../sceneSketch";

/** 场景卡片上的小图标（用字符，避免 emoji 字体差异） */
const SCENE_ICON: Record<string, string> = {
  title: "Aa",
  bullets: "≡",
  chart: "▥",
  quote: "❝",
  image: "▢",
  steps: "⇢",
  outro: "★",
  empty: "＋",
  caption: "▬",
  compare: "⇄",
  stats: "＃",
  life: "☀",
  game: "▶",
  tech: "◈",
  edu: "✎",
  live: "●",
  shop: "◉",
  "game-stats": "◇",
  list: "☰",
  timeline: "⋮",
  pricing: "¥",
  bigtext: "大",
};

export const SceneList: React.FC = () => {
  const project = useDoc((s) => s.project);
  const selectedId = useDoc((s) => s.selectedId);
  const flashId = useDoc((s) => s.flashId);
  const select = useDoc((s) => s.select);
  const apply = useDoc((s) => s.apply);
  const [pickerOpen, setPickerOpen] = useState(false);
  /**
   * 列表拖动 = 调整**顺序**（= 主轨播放顺序）。
   * 时间轴上的拖动是"改时间/换轨道"，两件事分开：多轨之后它们已经不等价了。
   */
  const [dragId, setDragId] = useState<string | null>(null);
  const [activeCat, setActiveCat] = useState("全部");
  const [hover, setHover] = useState<{
    type: string;
    name: string;
    desc: string;
    x: number;
    y: number;
  } | null>(null);
  const [types, setTypes] = useState<{ type: string; name: string; summary: string; category?: string }[]>([]);

  useEffect(() => {
    fetchSceneTypes()
      .then(setTypes)
      .catch(() => setTypes(metaList().map((m) => ({ type: m.type, name: m.name, summary: m.summary }))));
  }, []);

  // 下拉收起时，悬停预览也必须一起隐藏
  useEffect(() => {
    if (!pickerOpen) setHover(null);
  }, [pickerOpen]);

  // 「新增场景」下拉：点区域外自动收回
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.closest(".picker") || t.closest("[data-add-scene]")) return;
      setPickerOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [pickerOpen]);

  const categories = useMemo(
    () => ["全部", ...Array.from(new Set(types.map((t) => t.category || "其他")))],
    [types],
  );
  const visibleTypes = useMemo(
    () => types.filter((t) => activeCat === "全部" || (t.category || "其他") === activeCat),
    [types, activeCat],
  );

  if (!project) return null;

  const add = async (type: string) => {
    setHover(null);
    setPickerOpen(false);
    await apply([
      { op: "add_scene", type, afterSceneId: selectedId ?? project.scenes[project.scenes.length - 1]?.id },
    ]);
  };

  const remove = async (sceneId: string) => {
    await apply([{ op: "remove_scene", sceneId }]);
    if (selectedId === sceneId) select(project.scenes.find((s) => s.id !== sceneId)?.id ?? null);
  };

  return (
    <>
      <div className="panel-head">
        <span>场景</span>
        <button className="icon-btn" data-add-scene onClick={() => setPickerOpen((v) => !v)} title="新增场景">
          ＋
        </button>
      </div>

      {pickerOpen ? (
        <div className="picker">
          <div className="picker-cats">
            {categories.map((cat) => (
              <button
                key={cat}
                className={`picker-cat ${activeCat === cat ? "is-on" : ""}`}
                onClick={() => setActiveCat(cat)}
              >
                {cat}
              </button>
            ))}
          </div>
          <div className="picker-list picker-grid">
            {visibleTypes.map((t) => (
              <button
                key={t.type}
                className="picker-card"
                onClick={() => add(t.type)}
                onMouseEnter={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  const x = r.right + 10 + 170 > window.innerWidth ? r.left - 178 : r.right + 10;
                  setHover({ type: t.type, name: t.name, desc: t.summary, x, y: Math.max(8, r.top) });
                }}
                onMouseLeave={() => setHover(null)}
              >
                <span className="picker-icon">{SCENE_ICON[t.type] ?? "▦"}</span>
                <span className="picker-name">{t.name}</span>
                <span className="picker-desc">{t.summary}</span>
              </button>
            ))}
            {!visibleTypes.length ? <div className="picker-empty">这个分类还没有场景</div> : null}
          </div>
        </div>
      ) : null}

      {hover && pickerOpen ? (
        <div className="picker-preview" style={{ left: hover.x, top: hover.y }}>
          <svg
            viewBox="0 0 120 200"
            className="sketch-svg"
            dangerouslySetInnerHTML={{ __html: SCENE_SKETCH[hover.type] ?? "" }}
          />
          <div className="picker-preview-name">{hover.name}</div>
          <div className="picker-preview-desc">{hover.desc}</div>
        </div>
      ) : null}

      <div className="scene-list">
        {project.scenes.map((s, i) => {
          const meta = getMeta(s.type);
          return (
            <div
              key={s.id}
              className={`scene-item ${selectedId === s.id ? "is-active" : ""} ${flashId === s.id ? "is-flash" : ""} ${dragId === s.id ? "is-dragging" : ""}`}
              data-scene-id={s.id}
              draggable
              onDragStart={() => setDragId(s.id)}
              onDragEnd={() => setDragId(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                const from = project.scenes.findIndex((x) => x.id === dragId);
                const to = project.scenes.findIndex((x) => x.id === s.id);
                setDragId(null);
                if (from < 0 || to < 0 || from === to) return;
                const ids = project.scenes.map((x) => x.id);
                ids.splice(to, 0, ids.splice(from, 1)[0]);
                void apply([{ op: "reorder_scenes", sceneIds: ids }]);
              }}
              onClick={() => select(s.id)}
              title="拖动可调整顺序（多轨之后列表顺序 = 主轨播放顺序）"
            >
              <span className="scene-idx">{String(i + 1).padStart(2, "0")}</span>
              <div className="scene-body">
                <div className="scene-name">{s.name}</div>
                <div className="scene-sub">
                  {meta && meta.name !== s.name ? `${meta.name} · ` : ""}
                  {(s.durationInFrames / project.fps).toFixed(1)}s
                  {/* 多轨之后"列表顺序"不再等于"播放顺序"，这两枚徽标专门用来消除误会 */}
                  {(s.track ?? 0) > 0 ? (
                    <span className="tl-scene-badge">轨 {s.track}</span>
                  ) : null}
                  {s.box ? <span className="tl-scene-badge">画中画</span> : null}
                </div>
              </div>
              <div className="scene-actions">
                <button
                  className="scene-act"
                  title="复制场景"
                  onClick={(e) => {
                    e.stopPropagation();
                    askConfirm({
                      title: `复制场景「${s.name}」？`,
                      message: "会在它后面插入一份完整副本（文案、元素、时长都会复制）。",
                      hint: "误点可以直接 Ctrl+Z 撤销",
                      confirmLabel: "复制场景",
                      onConfirm: () => void apply([{ op: "duplicate_scene", sceneId: s.id }]),
                    });
                  }}
                >
                  复制
                </button>
                <button
                  className="scene-act danger"
                  title="删除"
                  onClick={(e) => {
                    e.stopPropagation();
                    askConfirm({
                      title: `删除场景「${s.name}」？`,
                      message: "这一页的文案、元素和时长都会一起删掉。",
                      hint: "可以用 Ctrl+Z 撤销",
                      confirmLabel: "删除场景",
                      onConfirm: () => void remove(s.id),
                    });
                  }}
                >
                  ×
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="panel-foot">
        <div className="hint">rev {project.rev}</div>
        <div className="hint">{project.formats.length} 种画幅</div>
      </div>
    </>
  );
};
