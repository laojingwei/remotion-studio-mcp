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
  scene3d: "◐",
};

/** 选择器条目：scene3d 会被展开成 6 个母题，各自带一份 props */
type PickerItem = {
  key: string;
  type: string;
  name: string;
  summary: string;
  category?: string;
  props?: Record<string, unknown>;
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
  /**
   * 两个搜索词，因为这里有两种"找东西"：
   * - `qScene`：找**已经加进片子**的一幕（按幕名 / 版式名 / 类型 / 字幕匹配）
   * - `qType`：找**准备新增**的版式类型（只在"新增场景"面板展开时出现）
   *
   * 共用一个输入框会出现"展开面板时把已有场景过滤没了"的怪事 —— 两个词分开存，
   * 切回来时各自的输入还在。
   */
  const [qScene, setQScene] = useState("");
  const [qType, setQType] = useState("");

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

  /**
   * 选择器条目。
   *
   * 3D 场景在这里只是**一个**卡片：换母题（环绕核心 / 粒子星云…）走右侧属性栏的
   * 预设那一排，不在这里分裂成 6 张 —— 选择器只解决"加什么类型的一幕"，
   * 不解决"这一幕画什么"。两件事混在一个面板里，列表会长得没法扫。
   */
  const pickerItems = useMemo<PickerItem[]>(
    () =>
      types.map((t) => ({
        key: t.type,
        type: t.type,
        name: t.name,
        summary: t.summary,
        category: t.category,
      })),
    [types],
  );

  const categories = useMemo(
    () => ["全部", ...Array.from(new Set(pickerItems.map((t) => t.category || "其他")))],
    [pickerItems],
  );
  const visibleTypes = useMemo(() => {
    const k = qType.trim().toLowerCase();
    // 有搜索词就跨分类找：否则用户搜"图表"却因为停在"开场"分类而被告知"没有"，很莫名其妙
    if (k) return pickerItems.filter((t) => `${t.name} ${t.summary} ${t.type}`.toLowerCase().includes(k));
    return pickerItems.filter((t) => activeCat === "全部" || (t.category || "其他") === activeCat);
  }, [pickerItems, activeCat, qType]);

  const keyword = qScene.trim().toLowerCase();
  const matched = useMemo(() => {
    const scenes = project?.scenes ?? [];
    if (!keyword) return scenes;
    return scenes.filter((s) => {
      const meta = getMeta(s.type);
      return [s.name, meta?.name ?? "", s.type, s.subtitle ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(keyword);
    });
  }, [project?.scenes, keyword]);

  if (!project) return null;

  const add = async (item: PickerItem) => {
    setHover(null);
    setPickerOpen(false);
    /*
     * 锚点必须先验明正身：selectedId 可能是陈旧的（场景刚被删、或切工程前的
     * 选中残留），空画布时 `scenes[len-1]?.id` 也是 undefined —— 把不存在的
     * id 发给服务端，之前会整批被拒（找不到场景）。服务端现在虽已降级为
     * 追加末尾，但 UI 侧不该发明知无效的锚点。
     */
    const exists = (id: string | undefined) => !!id && project.scenes.some((x) => x.id === id);
    const candidates: (string | undefined)[] = [
      selectedId ?? undefined,
      project.scenes[project.scenes.length - 1]?.id,
    ];
    const anchor = candidates.find(exists);
    await apply([
      {
        op: "add_scene",
        type: item.type,
        ...(item.props ? { props: item.props } : {}),
        ...(anchor ? { afterSceneId: anchor } : {}),
      },
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

      {pickerOpen ? null : (
        <div className="panel-search">
          <input
            value={qScene}
            placeholder="搜索场景：名字 / 版式 / 字幕…"
            onChange={(e) => setQScene(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQScene("");
              // 回车直接选中第一个匹配项，省一次点击
              if (e.key === "Enter" && matched.length) select(matched[0].id);
            }}
          />
        </div>
      )}

      {pickerOpen ? (
        <div className="picker">
          <div className="picker-search">
            <input
              autoFocus
              value={qType}
              placeholder="搜索要新增的类型…"
              onChange={(e) => setQType(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setQType("");
                // 回车直接加第一个匹配项：找"图表"然后回车，一气呵成
                if (e.key === "Enter" && visibleTypes.length) void add(visibleTypes[0]);
              }}
            />
          </div>
          <div className="picker-cats">
            {categories.map((cat) => (
              <button
                key={cat}
                className={`picker-cat ${activeCat === cat ? "is-on" : ""}`}
                onClick={() => {
                  setActiveCat(cat);
                  // 点分类 = "我要看这一类"，此时还挂着搜索词只会让人以为分类没生效
                  setQType("");
                }}
              >
                {cat}
              </button>
            ))}
          </div>
          <div className="picker-list picker-grid">
            {visibleTypes.map((t) => (
              <button
                key={t.key}
                className="picker-card"
                onClick={() => add(t)}
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
        {keyword && !matched.length ? <div className="hint" style={{ padding: "10px 4px" }}>没有匹配「{qScene}」的场景</div> : null}
        {matched.map((s) => {
          // 序号仍然按**全片顺序**显示：搜索只是过滤视图，不能让人以为第 2 幕变成了第 1 幕
          const i = project.scenes.findIndex((x) => x.id === s.id);
          const meta = getMeta(s.type);
          return (
            <div
              key={s.id}
              className={`scene-item ${selectedId === s.id ? "is-active" : ""} ${flashId === s.id ? "is-flash" : ""} ${dragId === s.id ? "is-dragging" : ""}`}
              data-scene-id={s.id}
              draggable={!keyword}
              onDragStart={() => {
                // 过滤视图里拖动会让人以为"拖到第 1 位"，实际落点是全片索引 —— 干脆关掉
                if (!keyword) setDragId(s.id);
              }}
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
