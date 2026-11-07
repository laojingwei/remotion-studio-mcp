import React, { useEffect, useMemo, useRef, useState } from "react";
import type { BuiltinStyleDetail, BuiltinStyleItem, StyleItem, StyleUseDef } from "@shared/style-library";
import {
  builtinStillUrl,
  fetchBuiltinStyle,
  fetchStyleLibrary,
  fetchStylePrompt,
  rebuildStyleLibrary,
  saveStyleOverride,
  saveStylePicks,
  styleStillUrl,
  type StyleLibraryResponse,
} from "../apiClient";

/**
 * 风格库面板：把 341 条外部风格提示词变成「能看、能筛、能勾」的地方。
 *
 * 为什么要有这个面板：这些提示词原来只是磁盘上的一个文件夹，agent 不会主动去翻，
 * 用户也不知道有什么。让 agent 在 341 条里检索 = 让它瞎猜（它看不见图，也判断不了审美）。
 * 正确的分工是：**用户用眼睛挑，agent 负责翻译和落地**。
 *
 * 两个分区是刻意的，别合并：
 *   上区「参考风格」341 条 —— 只有画风描述 + 静帧，**不能** apply_style；
 *   下区「内置风格」43 条 —— 有 palette/font 预设，能一键套。
 * 合并会让用户勾一个参考风格，然后发现"套不上"，而这恰恰是最容易发生的误会。
 */

type Props = { open: boolean; onClose: () => void };

const PAGE = 60;

/**
 * 内置风格的标题带 slug 后缀（"装饰艺术（art-deco）"），放在 112px 宽的卡片上
 * 会把中文名挤成 "装饰艺术 (art-d…"。卡片里去掉括号部分、title 里留全名。
 */
const shortName = (name: string): string => name.replace(/\s*[（(][^()（）]*[)）]\s*$/, "") || name;

export const StyleLibraryDialog: React.FC<Props> = ({ open, onClose }) => {
  const [data, setData] = useState<StyleLibraryResponse | null>(null);
  const [q, setQ] = useState("");
  const [use, setUse] = useState("all");
  const [mood, setMood] = useState("all");
  const [onlyStill, setOnlyStill] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  // 内置风格单独一份状态：它和参考风格对 agent 是两种动作（直接套 vs 先翻译），存一起会串味
  const [pickedBuiltin, setPickedBuiltin] = useState<string[]>([]);
  /**
   * 两个分区做成标签页而不是上下两段：341 条参考滚到底才看得见内置 43 个，
   * 用户为了勾两个内置要先滑过三百多张图。标签页把"往下找"变成"点一下"。
   */
  const [tab, setTab] = useState<"ref" | "builtin">("ref");
  const [detail, setDetail] = useState<StyleItem | null>(null);
  const [prompt, setPrompt] = useState("");
  /**
   * 内置风格的抽屉单独一份：它的内容和参考风格完全不同（规则正文 + 结构化预设，
   * 没有 prompt 可以"翻译"）。塞进同一个 state 会让抽屉里一半字段是空的。
   */
  const [builtinDetail, setBuiltinDetail] = useState<BuiltinStyleItem | null>(null);
  const [builtinData, setBuiltinData] = useState<BuiltinStyleDetail | null>(null);
  /** 放大看细节：缩略图长边只有 720/960，网格里看不清贴图细节 */
  const [zoom, setZoom] = useState<{ src: string; title: string; sub?: string } | null>(null);
  const [note, setNote] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);

  const useMap = useMemo(() => {
    const m = new Map<string, StyleUseDef>();
    for (const u of data?.uses ?? []) m.set(u.id, u);
    return m;
  }, [data]);

  const load = async (silent = false) => {
    if (!silent) setBusy(true);
    try {
      const d = await fetchStyleLibrary({ q, use, mood, withStill: onlyStill });
      setData(d);
      setPicked((prev) => (prev.length ? prev : (d.picks?.ids ?? [])));
      setPickedBuiltin((prev) => (prev.length ? prev : (d.picks?.builtinSlugs ?? [])));
      if (d.picks?.note && !note) setNote(d.picks.note);
      setShown(PAGE);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      if (!silent) setBusy(false);
    }
  };

  // 打开时拉一次；筛选/搜索变化时防抖重拉（341 条在服务端过滤，别在前端做两套）
  useEffect(() => {
    if (!open) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void load(), q || use !== "all" || mood !== "all" ? 220 : 0);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, q, use, mood, onlyStill]);

  // 打开详情时拉那一份提示词全文
  useEffect(() => {
    if (!detail) return;
    setPrompt("");
    void fetchStylePrompt(detail.id)
      .then(setPrompt)
      .catch((err) => setPrompt(`（读不到提示词：${err instanceof Error ? err.message : String(err)}）`));
  }, [detail]);

  // 打开内置抽屉时拉规则 + 预设
  useEffect(() => {
    if (!builtinDetail) return;
    setBuiltinData(null);
    void fetchBuiltinStyle(builtinDetail.slug)
      .then(setBuiltinData)
      .catch(() => setBuiltinData(null));
  }, [builtinDetail]);

  // Esc 逐层退出：先关放大图，再关抽屉，最后关面板。用户按 Esc 时想关的一定是最上面那层
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (zoom) setZoom(null);
      else if (detail) setDetail(null);
      else if (builtinDetail) setBuiltinDetail(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, zoom, detail, builtinDetail, onClose]);

  const toggle = (id: string) => {
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    setMsg("");
  };

  const toggleBuiltin = (slug: string) => {
    setPickedBuiltin((prev) => (prev.includes(slug) ? prev.filter((x) => x !== slug) : [...prev, slug]));
    setMsg("");
  };

  const items = data?.items ?? [];
  const builtinAll = data?.builtin ?? [];

  /**
   * 内置只有 43 个，搜索在前端过滤就够；参考走服务端过滤（341 条要连 md 关键词一起搜）。
   * 两条路径不同是刻意的：内置没有"关键词/适合"字段可搜，只有名称与 slug。
   */
  const builtinList = useMemo(() => {
    const kw = q.trim().toLowerCase();
    const all = data?.builtin ?? [];
    if (!kw) return all;
    return all.filter((b) => b.name.toLowerCase().includes(kw) || b.slug.includes(kw));
  }, [data, q]);

  const switchTab = (next: "ref" | "builtin") => {
    if (next === tab) return;
    setTab(next);
    setShown(PAGE);
    setMsg("");
    scrollRef.current?.scrollTo({ top: 0 });
  };

  const pickedItems = picked
    .map((id) => data?.items.find((i) => i.id === id))
    .filter((x): x is StyleItem => !!x);

  const pickedBuiltinItems = pickedBuiltin
    .map((slug) => builtinAll.find((b) => b.slug === slug))
    .filter((x): x is BuiltinStyleItem => !!x);

  const totalPicked = picked.length + pickedBuiltin.length;

  const tellAgent = async () => {
    if (!totalPicked) return;
    setBusy(true);
    try {
      const r = await saveStylePicks({ ids: picked, builtinSlugs: pickedBuiltin, note, notify: true });
      setMsg(
        r.notified
          ? `已告诉 agent：内置 ${pickedBuiltin.length} 个（直接套）+ 参考 ${picked.length} 条（要翻译）${
              r.dropped.length ? `；${r.dropped.join("、")} 已不存在，已跳过` : ""
            }。回到对话窗口继续就行。`
          : "已保存，但没发出留言（可能不在本机打开）。",
      );
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const copyList = async () => {
    const parts: string[] = [];
    if (pickedBuiltinItems.length) parts.push(`内置（可直接套）：${pickedBuiltinItems.map((b) => b.slug).join("、")}`);
    if (pickedItems.length) parts.push(`参考（要翻译）：${pickedItems.map((i) => `${i.id} ${i.name}`).join("、")}`);
    try {
      await navigator.clipboard.writeText(parts.join("\n"));
      setMsg("清单已复制，粘到对话里也行。");
    } catch {
      setMsg("复制失败，请手动选中下方清单。");
    }
  };

  const patchMood = async (item: StyleItem, m: string) => {
    const has = item.moods.includes(m as never);
    const next = has ? item.moods.filter((x) => x !== m) : [...item.moods, m];
    // 乐观更新：点标签要立刻有反馈，失败再回滚（覆盖写盘是毫秒级，失败极少）
    setDetail({ ...item, moods: next as never });
    try {
      await saveStyleOverride(item.id, { moods: next });
      setData((d) =>
        d ? { ...d, items: d.items.map((x) => (x.id === item.id ? { ...x, moods: next as never } : x)) } : d,
      );
    } catch (err) {
      setDetail(item);
      setMsg(err instanceof Error ? err.message : String(err));
    }
  };

  if (!open) return null;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="sl-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="sl-head">
          <span className="sl-title">风格库</span>
          {/* 头部只报当前分区：标签上已有总数，这里再说一遍"参考 341 · 内置 43"就是重复 */}
          <span className="sl-count">
            {!data
              ? "读取中…"
              : tab === "ref"
                ? `参考 ${data.total} 条 · ${data.withStill} 条有静帧`
                : `内置 ${data.builtin.length} 个 · ${data.builtin.filter((b) => b.still).length} 个有样张`}
          </span>
          <span className="sl-spacer" />
          <button className="ghost" onClick={() => void load().then(() => setMsg("已刷新"))} disabled={busy}>
            {busy ? "读取中…" : "刷新"}
          </button>
          <button className="ghost" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="sl-filters">
          <div className="sl-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={tab === "ref"}
              className={`sl-tab ${tab === "ref" ? "is-on" : ""}`}
              onClick={() => switchTab("ref")}
            >
              参考风格
              <em>{data?.total ?? 0}</em>
            </button>
            <button
              role="tab"
              aria-selected={tab === "builtin"}
              className={`sl-tab ${tab === "builtin" ? "is-on" : ""}`}
              onClick={() => switchTab("builtin")}
            >
              内置风格
              <em>{builtinAll.length}</em>
            </button>
            <span className="sl-hint sl-tabs-hint">
              {tab === "ref"
                ? "画风参考：勾了 agent 会翻译成本片配色与版式"
                : "带 palette/font 预设：勾了 agent 直接 apply_style，不用翻译"}
            </span>
          </div>
          <input
            className="sl-search"
            placeholder={tab === "ref" ? "搜编号 / 名称 / 关键词 / 适合" : "搜内置风格名称或 slug"}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
          {tab === "ref" ? (
            <>
              <div className="sl-chips">
                <button className={`sl-chip ${use === "all" ? "is-on" : ""}`} onClick={() => setUse("all")}>
                  全部用途
                </button>
                {(data?.uses ?? []).map((u) => (
                  <button
                    key={u.id}
                    className={`sl-chip ${use === u.id ? "is-on" : ""}`}
                    title={u.hint}
                    onClick={() => setUse(u.id)}
                  >
                    {u.label}
                  </button>
                ))}
              </div>
              <div className="sl-chips">
                <button className={`sl-chip ${mood === "all" ? "is-on" : ""}`} onClick={() => setMood("all")}>
                  全部气质
                </button>
                {(data?.moods ?? []).map((m) => (
                  <button key={m} className={`sl-chip ${mood === m ? "is-on" : ""}`} onClick={() => setMood(m)}>
                    {m}
                  </button>
                ))}
                <label className="sl-check-still">
                  <input type="checkbox" checked={onlyStill} onChange={(e) => setOnlyStill(e.target.checked)} />
                  只看有静帧
                </label>
              </div>
            </>
          ) : null}
        </div>

        {data?.empty ? (
          <div className="sl-empty">
            库里还没有任何风格。在工程根跑一次 <code>npm run style:all</code> 把源库导入进来。
          </div>
        ) : null}

        <div className="sl-body">
          <div
            className="sl-grid-wrap"
            ref={scrollRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              // 滚到底再放下一批：341 张图一次性铺开在低配机器上会卡在解码
              if (el.scrollTop + el.clientHeight > el.scrollHeight - 320 && shown < items.length) {
                setShown((n) => n + PAGE);
              }
            }}
          >
            {tab === "ref" ? (
              <>
                <div className="sl-section-title">
                  参考风格 · 只能当视觉目标，不能一键套用
                  <span className="sl-hint">勾完点右下「告诉 agent」，它会翻译成本片的配色与版式</span>
                </div>
                <div className="sl-grid">
                  {items.slice(0, shown).map((it) => {
                    const on = picked.includes(it.id);
                    const broken = failed.has(it.id);
                    const hue = useMap.get(it.use)?.hue ?? 220;
                    return (
                      <div
                        key={it.id}
                        className={`sl-card ${on ? "is-on" : ""}`}
                        onClick={() => toggle(it.id)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") toggle(it.id);
                        }}
                      >
                        <div className="sl-thumb">
                          {it.still && !broken ? (
                            <img
                              src={styleStillUrl(it.id)}
                              alt=""
                              loading="lazy"
                              decoding="async"
                              onError={() => setFailed((s) => new Set(s).add(it.id))}
                            />
                          ) : (
                            <div
                              className="sl-ph"
                              style={{
                                background: `linear-gradient(150deg, hsl(${hue} 42% 22%), hsl(${hue} 30% 12%))`,
                              }}
                            >
                              <b>{it.id}</b>
                              <span>{it.name}</span>
                              {it.summary ? <i>{it.summary}</i> : null}
                            </div>
                          )}
                          <span className="sl-badge">{useMap.get(it.use)?.label ?? it.use}</span>
                          {it.still && !broken ? (
                            <button
                              className="sl-zoom"
                              title="放大看细节"
                              onClick={(e) => {
                                e.stopPropagation();
                                setZoom({
                                  src: styleStillUrl(it.id),
                                  title: `${it.id} ${it.name}`,
                                  sub: it.summary,
                                });
                              }}
                            >
                              ⤢
                            </button>
                          ) : null}
                          {it.still ? null : <span className="sl-no-still">无样张</span>}
                        </div>
                        <div className="sl-meta">
                          <span className="sl-id">{it.id}</span>
                          <span className="sl-name" title={it.name}>
                            {it.name}
                          </span>
                          <button
                            className="sl-info"
                            title="看提示词 / 改气质"
                            onClick={(e) => {
                              e.stopPropagation();
                              setBuiltinDetail(null);
                              setDetail(it);
                            }}
                          >
                            ⓘ
                          </button>
                        </div>
                        {on ? <span className="sl-check">✓</span> : null}
                      </div>
                    );
                  })}
                </div>
                {!items.length && !busy ? (
                  <div className="sl-empty">这个筛选下没有匹配，换个气质或清空搜索。</div>
                ) : null}
                {items.length > shown ? (
                  <div className="sl-more">继续下滑加载…（还有 {items.length - shown} 条）</div>
                ) : null}
              </>
            ) : (
              <>
                <div className="sl-section-title">
                  内置风格 · 有配色/字体预设，能直接套用
                  <span className="sl-hint">勾上后 agent 直接用 apply_style 落字段，不需要翻译</span>
                </div>
                {/* 卡片复用参考区的 .sl-card：两个区看着一样大、点哪儿都在勾选，用户不用学两套交互 */}
                <div className="sl-grid">
                  {builtinList.map((b) => {
                    const on = pickedBuiltin.includes(b.slug);
                    return (
                      <div
                        key={b.slug}
                        className={`sl-card ${on ? "is-on" : ""}`}
                        title={b.hasPreset ? `可一键套用：apply_style("${b.slug}")` : "只有规则，要手动套"}
                        onClick={() => toggleBuiltin(b.slug)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") toggleBuiltin(b.slug);
                        }}
                      >
                        <div className="sl-thumb">
                          {b.still ? (
                            /* 内置只有 43 张（约 900KB），不用 lazy：切过来要立刻有图，
                               lazy 会让首屏先黑一下再慢慢浮出来 */
                            <img src={builtinStillUrl(b.slug)} alt="" decoding="async" />
                          ) : (
                            <div
                              className="sl-ph"
                              style={{
                                background: "linear-gradient(150deg, hsl(246 40% 22%), hsl(246 28% 12%))",
                              }}
                            >
                              <b>{shortName(b.name)}</b>
                              <span>{b.slug}</span>
                            </div>
                          )}
                          <span className="sl-badge">{b.hasPreset ? "可套用" : "仅规则"}</span>
                          {b.still ? (
                            <button
                              className="sl-zoom"
                              title="放大看细节"
                              onClick={(e) => {
                                e.stopPropagation();
                                setZoom({
                                  src: builtinStillUrl(b.slug),
                                  title: b.name,
                                  sub: `内置风格 · ${b.hasPreset ? "可直接 apply_style" : "只有规则"}`,
                                });
                              }}
                            >
                              ⤢
                            </button>
                          ) : (
                            <span className="sl-no-still">无样张</span>
                          )}
                        </div>
                        <div className="sl-meta">
                          <span className="sl-name" title={`${b.name} · ${b.slug}`}>
                            {shortName(b.name)}
                          </span>
                          <button
                            className="sl-info"
                            title="看规则与配色预设"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDetail(null);
                              setBuiltinDetail(b);
                            }}
                          >
                            ⓘ
                          </button>
                        </div>
                        {on ? <span className="sl-check">✓</span> : null}
                      </div>
                    );
                  })}
                </div>
                {!builtinList.length ? (
                  <div className="sl-empty">
                    {q ? `内置风格里没有匹配「${q}」的。` : "没有读到内置风格，检查 server/styles/ 是否有 .md。"}
                  </div>
                ) : null}
              </>
            )}
          </div>

          {detail ? (
            <div className="sl-detail">
              <div className="sl-detail-head">
                <b>
                  {detail.id} {detail.name}
                </b>
                <button className="ghost" onClick={() => setDetail(null)}>
                  收起
                </button>
              </div>
              {detail.still && !failed.has(detail.id) ? (
                <img
                  className="sl-detail-img sl-clickable"
                  src={styleStillUrl(detail.id)}
                  alt=""
                  title="点击放大"
                  onClick={() =>
                    setZoom({ src: styleStillUrl(detail.id), title: `${detail.id} ${detail.name}`, sub: detail.summary })
                  }
                />
              ) : (
                <div className="sl-detail-nostill">这一条还没有静帧（可以自己补一张 .jpg 再跑 npm run style:webp）</div>
              )}
              {detail.summary ? <p className="sl-detail-sum">{detail.summary}</p> : null}
              {detail.fit ? (
                <p className="sl-detail-fit">
                  <i>适合</i> {detail.fit}
                </p>
              ) : null}
              <div className="sl-detail-moods">
                <div className="sl-detail-label">气质（点一下改，存进本地覆盖）</div>
                <div className="sl-chips">
                  {(data?.moods ?? []).map((m) => (
                    <button
                      key={m}
                      className={`sl-chip ${detail.moods.includes(m as never) ? "is-on" : ""}`}
                      onClick={() => void patchMood(detail, m)}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
              <div className="sl-detail-label">风格提示词</div>
              {detail.promptChars === 0 ? (
                <div className="sl-detail-nostill">
                  这一条在源库里还是空的（只有编号和分类，没有正文）。补上内容后点右上「刷新」就会出现在这里。
                </div>
              ) : (
                <pre className="sl-prompt">{prompt || "读取中…"}</pre>
              )}
            </div>
          ) : builtinDetail ? (
            /* 内置抽屉：内容与参考完全不同——没有"提示词"可读，只有规则正文 + 结构化预设。
               放在同一个分支里靠 detail.kind 区分会让一半字段常年是空的，所以写成并列分支。 */
            <div className="sl-detail">
              <div className="sl-detail-head">
                <b>{builtinDetail.name}</b>
                <button className="ghost" onClick={() => setBuiltinDetail(null)}>
                  收起
                </button>
              </div>
              {builtinDetail.still ? (
                <img
                  className="sl-detail-img sl-clickable"
                  src={builtinStillUrl(builtinDetail.slug)}
                  alt=""
                  title="点击放大"
                  onClick={() =>
                    setZoom({
                      src: builtinStillUrl(builtinDetail.slug),
                      title: builtinDetail.name,
                      sub: `内置风格 · ${builtinDetail.hasPreset ? "可直接 apply_style" : "只有规则"}`,
                    })
                  }
                />
              ) : (
                <div className="sl-detail-nostill">这一条还没有样张</div>
              )}
              <div className="sl-tags">
                <span className="sl-tag">{builtinDetail.slug}</span>
                <span className={`sl-tag ${builtinDetail.hasPreset ? "is-ok" : ""}`}>
                  {builtinDetail.hasPreset ? "有预设，能一键套" : "只有规则，要手动套"}
                </span>
              </div>
              {builtinData === null ? (
                <div className="sl-hint">读取规则中…</div>
              ) : (
                <>
                  {builtinData.preset ? (
                    <>
                      <div className="sl-detail-label">配色（apply_style 会落这些字段）</div>
                      <div className="sl-swatches">
                        {Object.entries(builtinData.preset.palette).map(([k, v]) => (
                          <span key={k} className="sl-swatch" style={{ background: v }} title={`${k} ${v}`} />
                        ))}
                      </div>
                      <div className="sl-detail-label">字体 / 圆角</div>
                      <div className="sl-mono">
                        {builtinData.preset.font.heading} · {builtinData.preset.font.body} · radius{" "}
                        {builtinData.preset.radius}
                      </div>
                      {builtinData.preset.motion ? (
                        <div className="sl-mono">motion：{builtinData.preset.motion}</div>
                      ) : null}
                      {builtinData.preset.forbidden?.length ? (
                        <div className="sl-mono">禁用：{builtinData.preset.forbidden.join("、")}</div>
                      ) : null}
                    </>
                  ) : (
                    <div className="sl-detail-nostill">
                      这个风格没有结构化预设，agent 只能照着下面的规则手动设 theme。
                    </div>
                  )}
                  <div className="sl-detail-label">风格规则</div>
                  <pre className="sl-prompt">{builtinData.rules || "（没有规则正文）"}</pre>
                </>
              )}
            </div>
          ) : null}
        </div>

        <div className="sl-foot">
          <div className="sl-picked">
            {totalPicked ? (
              <>
                <b>已选 {totalPicked}</b>
                <span className="sl-picked-list">
                  {[
                    pickedBuiltinItems.length ? `内置：${pickedBuiltinItems.map((b) => b.name).join("、")}` : "",
                    pickedItems.length ? `参考：${pickedItems.map((i) => `${i.id} ${i.name}`).join("、")}` : "",
                  ]
                    .filter(Boolean)
                    .join(" ｜ ")}
                </span>
              </>
            ) : (
              <span className="sl-picked-empty">还没选。上区挑参考画风、下区勾能直接套的风格，选完点右边「告诉 agent」。</span>
            )}
          </div>
          <input
            className="sl-note"
            placeholder="补一句想要的感觉（可选，会一起发给 agent）"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
          {msg ? <span className="sl-msg">{msg}</span> : null}
          <button className="ghost" onClick={() => void copyList()} disabled={!totalPicked}>
            复制清单
          </button>
          <button className="sl-primary" onClick={() => void tellAgent()} disabled={!totalPicked || busy}>
            告诉 agent
          </button>
        </div>

        {/* 放大看细节：网格里的缩略图只有 158px 宽，看不清贴图与字重。
            点任意处关闭（Esc 也行），图片本身 stopPropagation 方便右键另存。 */}
        {zoom ? (
          <div className="sl-lightbox" onClick={() => setZoom(null)}>
            <img src={zoom.src} alt="" onClick={(e) => e.stopPropagation()} />
            <div className="sl-lightbox-cap">
              <b>{zoom.title}</b>
              {zoom.sub ? <span>{zoom.sub}</span> : null}
              <span className="sl-hint">点任意处或按 Esc 关闭</span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};
