import React, { useEffect, useMemo, useRef, useState } from "react";
import type { BuiltinStyleDetail, BuiltinStyleItem } from "@shared/builtin-styles";
import type { PromptDetail, PromptGenre, PromptItem, PromptPick } from "@shared/prompt-library";
import { promptFidelityLabel } from "@shared/prompt-library";
import {
  builtinStillUrl,
  fetchBuiltinStyle,
  fetchBuiltinStyles,
  fetchPromptDetail,
  fetchPromptLibrary,
  fetchPromptPick,
  pickPrompt,
  promptStillUrl,
  saveStylePicks,
  type BuiltinStylesResponse,
  type PromptLibraryResponse,
} from "../apiClient";

/**
 * 风格库面板：两个分区，两种颗粒度。
 *
 *   内置风格 77 个 —— 带 palette/font 预设，勾了能 `apply_style` 一键套；
 *   提示词 179 条  —— 整片配方 153 + 单技法 26，一条就是一个骨架或一招，单选采纳。
 *
 * 为什么这两件事必须分区、不能合成一个列表：它们回答的问题不同。
 * 内置风格答"画面长什么样"（形容词），提示词答"这条片子怎么拍 / 这个效果怎么做"（动宾短语）。
 * 混在一起，用户会拿一套画风当分镜脚本用。
 *
 * 历史：原来还有第三个分区「参考风格」341 条（画风文字描述 + 静帧，只能参考不能套）。
 * 它和内置风格长期重复——同一批画法被整理了两遍，用户看不出差别。已经拆掉：
 * 能升级的并进内置风格（保证能 apply_style）与提示词库，其余删除。所以现在只剩两个分区，
 * 且**每个分区里的东西都是能直接用的**，不存在"勾了但用不上"。
 */

type Props = { open: boolean; onClose: () => void };

type Tab = "builtin" | "prompt";

const PAGE = 60;

/** 提示词卡片比风格卡片大：它要多放一行摘要和一排关键词，158px 太挤 */
const PROMPT_PAGE = 48;

/**
 * 内置风格的标题带 slug 后缀（"装饰艺术（art-deco）"），放在 112px 宽的卡片上
 * 会把中文名挤成 "装饰艺术 (art-d…"。卡片里去掉括号部分、title 里留全名。
 */
const shortName = (name: string): string => name.replace(/\s*[（(][^()（）]*[)）]\s*$/, "") || name;

/** 三种耦合度各一句话：标签悬停时给，不占版面 */
const PROMPT_FIDELITY_HINT: Record<PromptItem["fidelity"], string> = {
  free: "画风自由：换任何风格都不伤内容",
  partial: "画风部分：配色与字体跟着风格换，结构不动",
  bound: "绑在媒介上：只能换同媒介的风格，跨媒介会毁片",
};

export const StyleLibraryDialog: React.FC<Props> = ({ open, onClose }) => {
  /* ── 内置风格 ─────────────────────────────────────────────────── */
  const [styleData, setStyleData] = useState<BuiltinStylesResponse | null>(null);
  const [styleBusy, setStyleBusy] = useState(false);
  const [q, setQ] = useState("");
  const [pickedBuiltin, setPickedBuiltin] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [styleMsg, setStyleMsg] = useState("");
  const [builtinDetail, setBuiltinDetail] = useState<BuiltinStyleItem | null>(null);
  const [builtinData, setBuiltinData] = useState<BuiltinStyleDetail | null>(null);

  /* ── 提示词（整片配方 + 单技法）────────────────────────────────── */
  /**
   * 状态全部独立于内置风格。
   *
   * 共用一份 q / detail 会串味：两边都叫"搜索"，但一边搜风格名与 slug、一边搜体裁与结构；
   * 抽屉字段更是完全不同（那边是配色与规则，这边是槽位与正文）。
   */
  const [promptData, setPromptData] = useState<PromptLibraryResponse | null>(null);
  const [promptQ, setPromptQ] = useState("");
  const [promptGenre, setPromptGenre] = useState<"all" | PromptGenre>("all");
  const [promptOnlyStill, setPromptOnlyStill] = useState(false);
  const [promptDetail, setPromptDetail] = useState<PromptDetail | null>(null);
  const [promptPick, setPromptPick] = useState<PromptPick | null>(null);
  const [promptShown, setPromptShown] = useState(PROMPT_PAGE);
  const [promptBusy, setPromptBusy] = useState(false);
  const [promptMsg, setPromptMsg] = useState("");
  const [promptNote, setPromptNote] = useState("");
  const [promptFailed, setPromptFailed] = useState<Set<string>>(new Set());
  const promptTimer = useRef<number | null>(null);
  /** 提示词库最后一次请求的筛选键，用于去重（详见下面那个 effect 的注释） */
  const promptReq = useRef("");

  /** 放大看细节：缩略图长边只有 720，网格里看不清贴图细节 */
  const [zoom, setZoom] = useState<{ src: string; title: string; sub?: string } | null>(null);
  const [tab, setTab] = useState<Tab>("builtin");
  const [shown, setShown] = useState(PAGE);
  const scrollRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  /** 配方正文排在槽位下方，给顶部留一个跳转锚，免得"点开一条配方看不到提示词" */
  const promptScrollRef = useRef<HTMLDivElement>(null);
  const promptBodyRef = useRef<HTMLPreElement>(null);
  const builtinScrollRef = useRef<HTMLDivElement>(null);

  const builtinAll = styleData?.items ?? [];
  const promptItems = promptData?.items ?? [];

  /**
   * 内置只有几十个，搜索在前端过滤就够；提示词走服务端过滤（要连正文关键词一起搜）。
   * 两条路径不同是刻意的：内置没有"关键词/适合"字段可搜，只有名称与 slug。
   */
  const builtinList = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return builtinAll;
    return builtinAll.filter(
      (b) => b.name.toLowerCase().includes(kw) || b.slug.includes(kw) || shortName(b.name).toLowerCase().includes(kw),
    );
  }, [builtinAll, q]);

  const pickedBuiltinItems = pickedBuiltin
    .map((slug) => builtinAll.find((b) => b.slug === slug))
    .filter((x): x is BuiltinStyleItem => !!x);

  const loadStyles = async (silent = false) => {
    if (!silent) setStyleBusy(true);
    try {
      const d = await fetchBuiltinStyles();
      setStyleData(d);
      setPickedBuiltin((prev) => (prev.length ? prev : (d.picks?.builtinSlugs ?? [])));
      if (d.picks?.note && !note) setNote(d.picks.note);
    } catch (err) {
      setStyleMsg(err instanceof Error ? err.message : String(err));
    } finally {
      if (!silent) setStyleBusy(false);
    }
  };

  const loadPrompts = async (silent = false) => {
    if (!silent) setPromptBusy(true);
    try {
      const d = await fetchPromptLibrary({ q: promptQ, genre: promptGenre, withStill: promptOnlyStill });
      setPromptData(d);
      setPromptShown(PROMPT_PAGE);
    } catch (err) {
      setPromptMsg(err instanceof Error ? err.message : String(err));
    } finally {
      if (!silent) setPromptBusy(false);
    }
  };

  /**
   * 打开面板就把两个分区的数字都拉回来。
   *
   * 为什么要提前拉提示词：标签上的数字得是真的（"提示词 179"）。让用户切进去才知道有多少，
   * 这个标签看起来就像是坏的。列表不带正文，整包几十 KB，比一屏缩略图便宜。
   */
  useEffect(() => {
    if (!open) return;
    void loadStyles(true);
    void fetchPromptPick()
      .then(setPromptPick)
      .catch(() => setPromptPick(null));
    promptReq.current = "||";
    void loadPrompts(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 内置风格的搜索防抖（前端过滤，只是为了不在每个按键上都重排 77 张卡片）
  useEffect(() => {
    if (!open) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setShown(PAGE), 180);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [open, q]);

  // 打开内置抽屉时拉规则 + 预设
  useEffect(() => {
    if (!builtinDetail) return;
    setBuiltinData(null);
    // 换一条风格时把滚动区归零：抽屉 DOM 是复用的，否则会停在上一篇规则的中段
    builtinScrollRef.current?.scrollTo({ top: 0 });
    void fetchBuiltinStyle(builtinDetail.slug)
      .then(setBuiltinData)
      .catch(() => setBuiltinData(null));
  }, [builtinDetail]);

  // 换一条配方同样归零；用 id 做依赖，详情正文异步回填时不会把用户刚滚到的位置弹回顶部
  useEffect(() => {
    if (promptDetail) promptScrollRef.current?.scrollTo({ top: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptDetail?.item.id]);

  /**
   * 筛选变化时重拉（仅提示词分区生效）。
   *
   * 用"请求键"去重而不是把 promptData 放进依赖：后者会在数据回来时再次触发 effect，
   * 然后又被判为"筛选变了"再请求一次，转成死循环。
   */
  useEffect(() => {
    if (!open || tab !== "prompt") return;
    const key = `${promptQ}|${promptGenre}|${promptOnlyStill}`;
    if (key === promptReq.current) return;
    promptReq.current = key;
    if (promptTimer.current) window.clearTimeout(promptTimer.current);
    promptTimer.current = window.setTimeout(() => void loadPrompts(), 220);
    return () => {
      if (promptTimer.current) window.clearTimeout(promptTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab, promptQ, promptGenre, promptOnlyStill]);

  // Esc 逐层退出：先关放大图，再关抽屉，最后关面板。用户按 Esc 时想关的一定是最上面那层
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (zoom) setZoom(null);
      else if (builtinDetail) setBuiltinDetail(null);
      else if (promptDetail) setPromptDetail(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, zoom, builtinDetail, promptDetail, onClose]);

  const toggleBuiltin = (slug: string) => {
    setPickedBuiltin((prev) => (prev.includes(slug) ? prev.filter((x) => x !== slug) : [...prev, slug]));
    setStyleMsg("");
  };

  const switchTab = (next: Tab) => {
    if (next === tab) return;
    setTab(next);
    setShown(PAGE);
    setPromptShown(PROMPT_PAGE);
    setStyleMsg("");
    setPromptMsg("");
    // 切分区就收起抽屉：抽屉里的字段是上一个分区的，留着会显示错的东西
    setBuiltinDetail(null);
    setPromptDetail(null);
    scrollRef.current?.scrollTo({ top: 0 });
  };

  /**
   * 提示词分区的头部文案。
   *
   * 筛过之后要报「筛出几条 / 全库几条」：只报全库总数，用户筛完体裁看到数字没变，
   * 第一反应是"筛选没生效"。
   */
  const promptHeadText = !promptData
    ? "读取中…"
    : (() => {
        const n = promptData.items.length;
        const sized = n === promptData.total ? `${n}` : `${n} / ${promptData.total}`;
        return `共 ${sized} 条 · ${promptData.withStill} 条有缩略图${promptPick ? ` · 已采纳 ${promptPick.id}` : ""}`;
      })();

  /**
   * 把勾选的内置风格发出去。
   *
   * 只发一组建模过的 slug：以前还有一组"参考编号（要翻译）"，两组的措辞不同；
   * 参考库删掉后只剩这一组，措辞也就收敛成一句"这些直接套"。
   */
  const tellStyleAgent = async () => {
    if (!pickedBuiltin.length) return;
    setStyleBusy(true);
    try {
      const r = await saveStylePicks({ builtinSlugs: pickedBuiltin, note, notify: true });
      setStyleMsg(
        r.notified
          ? `已告诉 agent：${pickedBuiltin.length} 个风格，直接套用${
              r.dropped.length ? `；${r.dropped.join("、")} 已不存在，已跳过` : ""
            }。回对话继续就行。`
          : "已保存，但没发出留言（可能不在本机打开）。",
      );
    } catch (err) {
      setStyleMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setStyleBusy(false);
    }
  };

  /**
   * 采纳一条配方。传 null 表示撤销。
   *
   * `notify` 分开控制，这一点很重要：卡片右下角的圆钮只**落盘**（等于"勾上了"），
   * 不往对话里发消息。否则用户翻列表时误点一下，agent 就收到"我选好了 PM0xx"开始干活。
   * 真正发消息只有两个明确动作：抽屉里的按钮、footer 的「告诉 agent」。
   */
  const adopt = async (item: PromptItem | null, notify = false) => {
    setPromptBusy(true);
    setPromptMsg("");
    try {
      const r = await pickPrompt(item ? { id: item.id, note: promptNote, notify } : { id: "" });
      setPromptPick(r.pick);
      setPromptMsg(
        item
          ? r.notified
            ? `已告诉 agent：${item.id.startsWith("TK") ? "把" : "按"} ${item.id} ${item.name}${
                item.id.startsWith("TK") ? " 加进片子" : " 拍"
              }。${item.fidelity === "bound" ? "它绑在媒介上，挑风格时别跨媒介。" : ""}回对话继续就行。`
            : `已勾选 ${item.id}（还没发给 agent，点右下「告诉 agent」）`
          : "已取消采纳。",
      );
      if (!item) setPromptNote("");
    } catch (err) {
      setPromptMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setPromptBusy(false);
    }
  };

  /** 把已采纳的配方发出去（带备注）。勾选与发送分两步，和风格分区保持同一套心智。 */
  const tellPromptAgent = async () => {
    if (!promptPick) return;
    setPromptBusy(true);
    setPromptMsg("");
    try {
      const r = await pickPrompt({ id: promptPick.id, note: promptNote, notify: true });
      setPromptPick(r.pick);
      setPromptMsg(
        r.notified
          ? `已告诉 agent：${promptPick.id} ${promptPick.name}。回对话继续就行。`
          : "已保存，但没发出留言（可能不在本机打开）。",
      );
    } catch (err) {
      setPromptMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setPromptBusy(false);
    }
  };

  /**
   * 打开配方抽屉。
   *
   * 先用列表项撑出抽屉、正文随后填：本地读一份 700 字 md 是毫秒级，但如果等请求回来才开，
   * 点击到出现之间的空白会让人以为没点到（尤其 179 张图里点错一张时）。
   */
  const openPrompt = async (id: string) => {
    const item = promptItems.find((x) => x.id === id);
    if (!item) return;
    setBuiltinDetail(null);
    setPromptMsg("");
    setPromptDetail({ item, slots: [], prompt: "" });
    try {
      setPromptDetail(await fetchPromptDetail(id));
    } catch (err) {
      setPromptMsg(err instanceof Error ? err.message : String(err));
    }
  };

  /** 滚到提示词正文：只滚抽屉内容区，不用 scrollIntoView（会把外层 modal 一起带着动） */
  const jumpToPromptBody = () => {
    const box = promptScrollRef.current;
    const body = promptBodyRef.current;
    if (!box || !body) return;
    const top = body.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 12;
    box.scrollTo({ top, behavior: "smooth" });
  };

  const copyBuiltinList = async () => {
    if (!pickedBuiltinItems.length) return;
    try {
      await navigator.clipboard.writeText(
        `风格（可直接 apply_style）：${pickedBuiltinItems.map((b) => `${b.slug}（${b.name}）`).join("、")}`,
      );
      setStyleMsg("清单已复制。");
    } catch {
      setStyleMsg(`复制失败，清单：${pickedBuiltinItems.map((b) => b.slug).join("、")}`);
    }
  };

  if (!open) return null;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="sl-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="sl-head">
          <span className="sl-title">风格库</span>
          {/* 头部只报当前分区：标签上已有总数，这里再说一遍"内置 77 · 提示词 179"就是重复 */}
          <span className="sl-count">
            {tab === "prompt"
              ? promptHeadText
              : !styleData
                ? "读取中…"
                : `内置 ${styleData.items.length} 个 · ${styleData.items.filter((b) => b.still).length} 个有样张`}
          </span>
          <span className="sl-spacer" />
          <button
            className="ghost"
            onClick={() =>
              void (tab === "prompt"
                ? loadPrompts().then(() => setPromptMsg("已刷新"))
                : loadStyles().then(() => setStyleMsg("已刷新")))
            }
            disabled={tab === "prompt" ? promptBusy : styleBusy}
          >
            {(tab === "prompt" ? promptBusy : styleBusy) ? "读取中…" : "刷新"}
          </button>
          <button className="ghost" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="sl-filters">
          <div className="sl-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={tab === "builtin"}
              className={`sl-tab ${tab === "builtin" ? "is-on" : ""}`}
              onClick={() => switchTab("builtin")}
            >
              内置风格
              <em>{builtinAll.length}</em>
            </button>
            <button
              role="tab"
              aria-selected={tab === "prompt"}
              className={`sl-tab ${tab === "prompt" ? "is-on" : ""}`}
              onClick={() => switchTab("prompt")}
            >
              提示词
              <em>{promptData?.total ?? 0}</em>
            </button>
            <span className="sl-hint sl-tabs-hint">
              {tab === "builtin"
                ? "带 palette/font 预设：勾了 agent 直接 apply_style，不用翻译"
                : "整片配方 + 单技法：配方照它拍一整条，技法加进某一幕"}
            </span>
          </div>
          <input
            className="sl-search"
            placeholder={
              tab === "builtin" ? "搜内置风格名称或 slug" : "搜编号 / 名称 / 摘要 / 关键词 / 作者"
            }
            value={tab === "prompt" ? promptQ : q}
            onChange={(e) => (tab === "prompt" ? setPromptQ(e.target.value) : setQ(e.target.value))}
            onKeyDown={(e) => e.stopPropagation()}
          />
          {tab === "prompt" ? (
            /* 提示词按"体裁"筛，不是按"气质"：用户这时候想的是"我要做宣传片还是解说片" */
            <div className="sl-chips">
              <button
                className={`sl-chip ${promptGenre === "all" ? "is-on" : ""}`}
                onClick={() => setPromptGenre("all")}
              >
                全部体裁
              </button>
              {(promptData?.genres ?? []).map((g) => (
                <button
                  key={g.id}
                  className={`sl-chip ${promptGenre === g.id ? "is-on" : ""}`}
                  title={g.hint}
                  onClick={() => setPromptGenre(g.id)}
                >
                  {g.label}
                  <em>{promptData?.counts?.[g.id] ?? 0}</em>
                </button>
              ))}
              <label className="sl-check-still">
                <input
                  type="checkbox"
                  checked={promptOnlyStill}
                  onChange={(e) => setPromptOnlyStill(e.target.checked)}
                />
                只看有缩略图
              </label>
            </div>
          ) : null}
        </div>

        <div className="sl-body">
          <div
            className="sl-grid-wrap"
            ref={scrollRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              // 滚到底再放下一批：一百多张图一次性铺开在低配机器上会卡在解码
              if (el.scrollTop + el.clientHeight > el.scrollHeight - 320) {
                if (tab === "prompt") {
                  if (promptShown < promptItems.length) setPromptShown((n) => n + PROMPT_PAGE);
                } else if (shown < builtinList.length) {
                  setShown((n) => n + PAGE);
                }
              }
            }}
          >
            {tab === "builtin" ? (
              <>
                <div className="sl-section-title">
                  内置风格 · 有配色/字体预设，能直接套用
                  <span className="sl-hint">
                    点图片看规则与配色，点右下角圆圈勾选；勾上后 agent 用 apply_style 落字段
                  </span>
                </div>
                {/* 卡片结构与提示词分区同一套交互：点图看详情、右下角勾选。
                    用户在两个标签之间来回切，交互必须一样，否则会一直点错。 */}
                <div className="sl-grid">
                  {builtinList.slice(0, shown).map((b) => {
                    const on = pickedBuiltin.includes(b.slug);
                    return (
                      <div
                        key={b.slug}
                        className={`sl-card ${on ? "is-on" : ""}`}
                        title={b.hasPreset ? `可一键套用：apply_style("${b.slug}")` : "只有规则，要手动套"}
                        onClick={() => setBuiltinDetail(b)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") setBuiltinDetail(b);
                        }}
                      >
                        <div className="sl-thumb">
                          {b.still ? (
                            <img src={builtinStillUrl(b.slug)} alt="" loading="lazy" decoding="async" />
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
                          <button
                            className={`sl-pick ${on ? "is-on" : ""}`}
                            title={on ? "已勾选（点一下取消）" : "勾选这个内置风格"}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleBuiltin(b.slug);
                            }}
                          ></button>
                        </div>
                        <div className="sl-meta">
                          <span className="sl-name" title={`${b.name} · ${b.slug}`}>
                            {shortName(b.name)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {!builtinList.length ? (
                  <div className="sl-empty">
                    {q ? `内置风格里没有匹配「${q}」的。` : "没有读到内置风格，检查 server/styles/ 是否有 .md。"}
                  </div>
                ) : null}
                {builtinList.length > shown ? (
                  <div className="sl-more">继续下滑加载…（还有 {builtinList.length - shown} 个）</div>
                ) : null}
              </>
            ) : (
              <>
                <div className="sl-section-title">
                  整片配方 153 · 单技法 26
                  <span className="sl-hint">
                    点图片读正文，点右下角圆圈直接采纳（单选，换一条会覆盖）
                  </span>
                </div>
                <div className="sl-grid is-prompt">
                  {promptItems.slice(0, promptShown).map((it) => {
                    const adopted = promptPick?.id === it.id;
                    const broken = promptFailed.has(it.id);
                    const genreDef = promptData?.genres.find((g) => g.id === it.genre);
                    return (
                      <div
                        key={it.id}
                        className={`sl-card sl-pcard ${adopted ? "is-on" : ""}`}
                        onClick={() => void openPrompt(it.id)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") void openPrompt(it.id);
                        }}
                        title={it.summary}
                      >
                        <div className="sl-thumb">
                          {it.still && !broken ? (
                            <img
                              src={promptStillUrl(it.id)}
                              alt=""
                              loading="lazy"
                              decoding="async"
                              onError={() => setPromptFailed((s) => new Set(s).add(it.id))}
                            />
                          ) : (
                            <div
                              className="sl-ph"
                              style={{
                                background: `linear-gradient(150deg, hsl(${genreDef?.hue ?? 220} 42% 22%), hsl(${
                                  genreDef?.hue ?? 220
                                } 30% 12%))`,
                              }}
                            >
                              <b>{it.id}</b>
                              <span>{it.name}</span>
                              {it.summary ? <i>{it.summary}</i> : null}
                            </div>
                          )}
                          <div className="sl-on-img">
                            <span className="sl-badge">{genreDef?.label ?? it.genre}</span>
                            {/* 图上只放秒数：完整串是「15 秒 · 1920×1080 · 120 BPM」，
                                208px 的卡片塞不下，会被挤成两行或截成「15 秒 · 1920×108…」。
                                全量留在 title 与详情抽屉里。 */}
                            {it.duration ? (
                              <span className="sl-dur" title={it.duration}>
                                {it.duration.split("·")[0].trim()}
                              </span>
                            ) : null}
                          </div>
                          {it.still && !broken ? (
                            <button
                              className="sl-zoom"
                              title="放大看这一帧"
                              onClick={(e) => {
                                e.stopPropagation();
                                setZoom({
                                  src: promptStillUrl(it.id),
                                  title: `${it.id} ${it.name}`,
                                  sub: it.summary,
                                });
                              }}
                            >
                              ⤢
                            </button>
                          ) : null}
                          {/* 配方是单选，所以这个圆钮是"就按这套拍"，不是多选勾——点它等于在列表里直接采纳 */}
                          <button
                            className={`sl-pick ${adopted ? "is-on" : ""}`}
                            title={
                              adopted
                                ? "已采纳（点一下取消）"
                                : it.id.startsWith("TK")
                                  ? "把这个技法加进片子"
                                  : "就按这套配方拍"
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              if (adopted) void adopt(null);
                              else void adopt(it);
                            }}
                          ></button>
                        </div>
                        <div className="sl-meta">
                          <span className="sl-id">{it.id}</span>
                          <span className="sl-name" title={it.name}>
                            {it.name}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {promptBusy && !promptItems.length ? <div className="sl-empty">读取中…</div> : null}
                {!promptBusy && !promptItems.length ? (
                  <div className="sl-empty">
                    {promptData?.empty
                      ? "库里还没有配方。在工程根跑一次 npm run prompt:build 生成。"
                      : promptQ || promptGenre !== "all"
                        ? "这个筛选下没有匹配，换个体裁或清空搜索。"
                        : "没有读到配方。"}
                  </div>
                ) : null}
                {promptItems.length > promptShown ? (
                  <div className="sl-more">继续下滑加载…（还有 {promptItems.length - promptShown} 条）</div>
                ) : null}
              </>
            )}
          </div>

          {builtinDetail ? (
            /* 内置风格抽屉：规则正文 + 结构化预设。
               为什么不和配方抽屉共用一个分支：字段完全不同（那边是槽位与正文），
               放在同一个分支里靠 kind 区分会让一半字段常年是空的，所以写成并列分支。 */
            <div className="sl-detail is-scroll">
              <div className="sl-detail-head">
                <b>{builtinDetail.name}</b>
                <button className="ghost" onClick={() => setBuiltinDetail(null)}>
                  收起
                </button>
              </div>
              {/* 和提示词抽屉同一套滚动：标题固定，下面的内容区一根滚动轴。
                  规则正文整段展开，不再套会被 flex 压扁、又自带滚动条的小框。 */}
              <div className="sl-detail-scroll" ref={builtinScrollRef}>
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
                {builtinData?.preset ? (
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
                ) : builtinData ? (
                  <div className="sl-detail-nostill">
                    这个风格没有结构化预设，agent 只能照着下面的规则手动设 theme。
                  </div>
                ) : null}
                <div className="sl-detail-label">风格规则</div>
                <pre className="sl-prompt">
                  {builtinData === null ? "读取规则中…" : builtinData.rules || "（没有规则正文）"}
                </pre>
              </div>
            </div>
          ) : promptDetail ? (
            /* 配方抽屉：和内置风格那个都不同——它有「槽位」这一层（可替换点），
               也有一个真正会改变 agent 行为的动作（采纳）。
               正文 700 字，操作区必须常驻底部：滚到一半想采纳、或读完才发现按钮在很远的地方，
               都会让人以为这一条"用不了"。所以拆成 内容滚动区 + 固定操作区。 */
            <div className="sl-detail is-prompt">
              <div className="sl-detail-head">
                <b>
                  {promptDetail.item.id} {promptDetail.item.name}
                </b>
                <button className="ghost" onClick={() => setPromptDetail(null)}>
                  收起
                </button>
              </div>
              <div className="sl-detail-scroll" ref={promptScrollRef}>
                {promptDetail.item.still && !promptFailed.has(promptDetail.item.id) ? (
                  <img
                    className="sl-detail-img sl-clickable"
                    src={promptStillUrl(promptDetail.item.id)}
                    alt=""
                    title="点击放大"
                    onClick={() =>
                      setZoom({
                        src: promptStillUrl(promptDetail.item.id),
                        title: `${promptDetail.item.id} ${promptDetail.item.name}`,
                        sub: promptDetail.item.summary,
                      })
                    }
                  />
                ) : (
                  <div className="sl-detail-nostill">这一条还没有缩略图</div>
                )}
                <div className="sl-tags">
                  <span className="sl-tag">
                    {promptData?.genres.find((g) => g.id === promptDetail.item.genre)?.label ?? promptDetail.item.genre}
                  </span>
                  {promptDetail.item.duration ? <span className="sl-tag">{promptDetail.item.duration}</span> : null}
                  {/* 画风耦合：用户下一步就是"去挑风格"，这里得先说清换风格会不会毁片 */}
                  <span
                    className={`sl-tag ${
                      promptDetail.item.fidelity === "bound"
                        ? "is-warn"
                        : promptDetail.item.fidelity === "free"
                          ? "is-ok"
                          : ""
                    }`}
                    title={PROMPT_FIDELITY_HINT[promptDetail.item.fidelity]}
                  >
                    {promptFidelityLabel(promptDetail.item.fidelity)}
                  </span>
                  {promptDetail.item.creator ? <span className="sl-tag">{promptDetail.item.creator}</span> : null}
                </div>
                {promptDetail.item.summary ? <p className="sl-detail-sum">{promptDetail.item.summary}</p> : null}
                {promptDetail.item.fit ? (
                  <p className="sl-detail-fit">
                    <i>适合</i> {promptDetail.item.fit}
                  </p>
                ) : null}
                {/* 顺序和源 md 一致：槽位（要替换什么）在前，提示词正文在后。
                    用户先看自己要填什么，再读整段怎么写；正文被推到槽位下方后，
                    槽位标题右侧给一个「跳到提示词」的锚，避免点开一条配方反而看不见正文。 */}
                {promptDetail.slots.length ? (
                  <>
                    <div className="sl-detail-label is-row">
                      <span>槽位（拍之前按你的实际情况替换）</span>
                      <button className="sl-jump" onClick={jumpToPromptBody}>
                        提示词正文 ↓
                      </button>
                    </div>
                    <div className="sl-slots">
                      {promptDetail.slots.map((s) => (
                        <div key={s.label} className="sl-slot">
                          <b>{s.label}</b>
                          <span>{s.value || "（未填）"}</span>
                          {s.hint ? <i>{s.hint}</i> : null}
                        </div>
                      ))}
                    </div>
                  </>
                ) : null}
                <div className="sl-detail-label">提示词</div>
                <pre className="sl-prompt" ref={promptBodyRef}>
                  {promptDetail.prompt || "读取中…"}
                </pre>
                {promptDetail.item.tags.length ? (
                  <div className="sl-chips sl-detail-chips">
                    {promptDetail.item.tags.map((t) => (
                      <span key={t} className="sl-chip is-static">
                        {t}
                      </span>
                    ))}
                  </div>
                ) : null}
                {promptDetail.item.dup ? <div className="sl-detail-dup">{promptDetail.item.dup}</div> : null}
                <div className="sl-detail-label">出处</div>
                <div className="sl-mono">
                  {promptDetail.item.creator}
                  {promptDetail.item.url ? (
                    <>
                      {" · "}
                      <a href={promptDetail.item.url} target="_blank" rel="noreferrer">
                        原贴
                      </a>
                    </>
                  ) : null}
                  {promptDetail.item.page ? (
                    <>
                      {" · "}
                      <a href={`https://${promptDetail.item.page}`} target="_blank" rel="noreferrer">
                        源页
                      </a>
                    </>
                  ) : null}
                </div>
              </div>
              <div className="sl-detail-foot">
                <input
                  className="sl-note"
                  placeholder="补一句你的实际情况（可选，会一起发给 agent）"
                  value={promptNote}
                  onChange={(e) => setPromptNote(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                />
                {promptPick?.id === promptDetail.item.id ? (
                  <button className="ghost" onClick={() => void adopt(null)} disabled={promptBusy}>
                    取消采纳
                  </button>
                ) : (
                  <button
                    className="sl-primary"
                    onClick={() => void adopt(promptDetail.item, true)}
                    disabled={promptBusy}
                  >
                    {promptBusy
                      ? "处理中…"
                      : promptDetail.item.id.startsWith("TK")
                        ? "把这个技法加进片子"
                        : "按这套配方拍"}
                  </button>
                )}
                {promptMsg ? <div className="sl-msg">{promptMsg}</div> : null}
              </div>
            </div>
          ) : null}
        </div>

        {tab === "prompt" ? (
          /* 配方是单选，footer 不做"清单"，只报当前那一条——否则用户会以为能勾好几套一起拍 */
          <div className="sl-foot">
            <div className="sl-picked">
              {promptPick ? (
                <>
                  <b>
                    {promptPick.id.startsWith("TK") ? "当前技法" : "当前配方"} {promptPick.id}
                  </b>
                  <span className="sl-picked-list">
                    {promptPick.name}
                    {promptPick.note ? ` ｜ 备注：${promptPick.note}` : ""}
                  </span>
                </>
              ) : (
                <span className="sl-picked-empty">
                  还没采纳。点任意卡片读正文，读完在抽屉里点「按这套配方拍」或「把这个技法加进片子」。
                </span>
              )}
            </div>
            {promptMsg && !promptDetail ? <span className="sl-msg">{promptMsg}</span> : null}
            <button className="ghost" onClick={() => switchTab("builtin")}>
              去挑风格
            </button>
            <button className="ghost" onClick={() => void adopt(null)} disabled={!promptPick || promptBusy}>
              取消采纳
            </button>
            <button
              className="sl-primary"
              onClick={() => void tellPromptAgent()}
              disabled={!promptPick || promptBusy}
              title={promptPick ? `让 agent 用 ${promptPick.id}` : "先在列表里选一条"}
            >
              告诉 agent
            </button>
          </div>
        ) : (
          <div className="sl-foot">
            <div className="sl-picked">
              {pickedBuiltin.length ? (
                <>
                  <b>已选 {pickedBuiltin.length}</b>
                  <span className="sl-picked-list">{pickedBuiltinItems.map((b) => b.name).join("、")}</span>
                </>
              ) : (
                <span className="sl-picked-empty">
                  还没选。点图片看规则、点右下角圆圈勾选，选完点右边「告诉 agent」——它会直接用 apply_style 套上。
                </span>
              )}
            </div>
            <input
              className="sl-note"
              placeholder="补一句想要的感觉（可选，会一起发给 agent）"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
            {styleMsg ? <span className="sl-msg">{styleMsg}</span> : null}
            <button className="ghost" onClick={() => void copyBuiltinList()} disabled={!pickedBuiltin.length}>
              复制清单
            </button>
            <button
              className="sl-primary"
              onClick={() => void tellStyleAgent()}
              disabled={!pickedBuiltin.length || styleBusy}
            >
              告诉 agent
            </button>
          </div>
        )}

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
