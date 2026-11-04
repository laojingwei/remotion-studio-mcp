import React, { useEffect, useMemo, useRef, useState } from "react";
import { fetchToolLog, type ToolCallLog } from "../apiClient";

type Props = {
  open: boolean;
  onClose: () => void;
};

/**
 * 运行日志抽屉：agent 到底调了什么、哪一步慢、哪个工具在报错。
 *
 * 为什么放编辑器里：这些信息以前只有 agent 自己能看（tool_stats），
 * 用户遇到"怎么半天没动静""为什么又失败了"只能凭猜。
 *
 * 只读不改：日志是 append-only 的 jsonl，这里不做任何写入。
 */
export function LogDrawer({ open, onClose }: Props) {
  const [data, setData] = useState<ToolCallLog | null>(null);
  const [err, setErr] = useState("");
  const [query, setQuery] = useState("");
  const [onlyFails, setOnlyFails] = useState(false);
  const [days, setDays] = useState(1);
  const [paused, setPaused] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const tick = () => {
      if (!alive) return;
      void fetchToolLog(200, days)
        .then((d) => {
          if (!alive) return;
          setData(d);
          setErr("");
        })
        .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)));
    };
    tick();
    // 2.5s 轮询：agent 连续调工具时，用户盯着这里能看到它正在做什么
    timer.current = window.setInterval(() => {
      if (!paused) tick();
    }, 2500);
    return () => {
      alive = false;
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [open, days, paused]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const rows = useMemo(() => {
    const all = data?.calls ?? [];
    const q = query.trim().toLowerCase();
    return all.filter(
      (c) =>
        (!onlyFails || !c.ok) &&
        (!q || c.tool.toLowerCase().includes(q) || c.args.toLowerCase().includes(q)),
    );
  }, [data, query, onlyFails]);

  if (!open) return null;

  const total = data?.stats?.total ?? 0;
  const failed = data?.stats?.failed ?? 0;
  // 失败集中在哪个工具：只报"3 次失败"用户还得自己翻，直接点名更省事
  const worst = (data?.stats?.byTool ?? []).filter((t) => t.failed > 0).sort((a, b) => b.failed - a.failed)[0];

  const clock = (iso: string) => {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  };

  return (
    <>
      <div className="log-drawer-mask" onClick={onClose} />
      <aside className="log-drawer" role="dialog" aria-label="运行日志">
        <header className="log-head">
          <span className="log-title">运行日志</span>
          <span className="log-sub">
            {total} 次调用{failed ? ` · ${failed} 次失败` : ""}
            {worst ? `（多在 ${worst.tool}）` : ""}
          </span>
          <button className="ghost log-close" onClick={onClose} title="关闭（Esc）">
            ✕
          </button>
        </header>

        <div className="log-tools">
          <input
            className="log-search"
            value={query}
            placeholder="搜工具名或参数…"
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            className="log-range"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            title="时间范围"
          >
            <option value={1}>今天</option>
            <option value={3}>近 3 天</option>
            <option value={7}>近 7 天</option>
          </select>
          <label className="log-check">
            <input type="checkbox" checked={onlyFails} onChange={(e) => setOnlyFails(e.target.checked)} />
            只看失败
          </label>
          <label className="log-check" title="暂停刷新，方便看清某一条">
            <input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} />
            暂停
          </label>
        </div>

        <div className="log-body">
          {err ? <div className="log-empty">读取失败：{err}</div> : null}
          {!err && !rows.length ? (
            <div className="log-empty">
              还没有调用记录。
              <br />
              agent 开始干活后这里会实时滚出它调用的每个工具、耗时和报错。
            </div>
          ) : null}
          {rows.map((c, i) => (
            <div key={`${c.ts}-${i}`} className={`log-row ${c.ok ? "" : "is-fail"}`}>
              <span className="log-time">{clock(c.ts)}</span>
              <span className={`log-dot ${c.ok ? "" : "is-fail"}`} />
              <span className="log-tool">{c.tool}</span>
              {/* 6ms 显示成 "0.01s" 没法看：快到 1 秒以内就按毫秒报 */}
              <span className="log-ms">{c.ms < 1000 ? `${c.ms}ms` : `${(c.ms / 1000).toFixed(1)}s`}</span>
              {c.args ? <div className="log-args">{c.args}</div> : null}
              {c.error ? <div className="log-err">{c.error}</div> : null}
            </div>
          ))}
        </div>

        <footer className="log-foot">
          日志存在 <code>data/logs/</code>（按天轮转，保留 7 天）· agent 侧对应 <code>tool_stats</code>
        </footer>
      </aside>
    </>
  );
}
