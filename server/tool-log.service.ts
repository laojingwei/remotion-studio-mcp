/**
 * 工具调用日志（本地可观测性）。
 *
 * 为什么需要：agent 为什么盲试、哪个工具失败最多、哪个参数最常写错 —— 这些问题
 * 以前只能靠宿主侧导出调用记录（上次的 `preview_frames` 帧号 bug 就是这么才定位到的）。
 * 服务端自己留一份 jsonl，复盘时不用再麻烦用户去翻聊天记录。
 *
 * 设计取舍：
 *  - 只记**摘要**（args 序列化后截断 400 字），不记完整返回值，避免日志爆炸。
 *  - 同步 append：每次只写一行（<1KB），比异步队列简单且不会丢。失败不影响调用。
 *  - 按天轮转文件名 `tool-calls-YYYY-MM-DD.jsonl`，保留 7 天，超期在启动时清。
 *  - 日志本身写坏了（磁盘满/权限）绝不能影响工具调用，全部 try/catch 吞掉。
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./root";
import { DATA_ROOT } from "./paths";

/**
 * 日志目录：默认 data/logs；`STUDIO_LOG_DIR` 可覆盖（测试用临时目录，避免探针条目
 * 混进真实统计里；也方便把日志放到别的盘）。
 */
const logDir = () =>
  process.env.STUDIO_LOG_DIR ? path.resolve(process.env.STUDIO_LOG_DIR) : path.join(DATA_ROOT, "logs");
const KEEP_DAYS = 7;
const MAX_ARG_CHARS = 400;

const dayOf = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const fileOfDay = (day: string) => path.join(logDir(), `tool-calls-${day}.jsonl`);

/** 只留最近 KEEP_DAYS 天；启动时调一次即可（删自己产生的文件，不碰用户数据） */
export function pruneToolLogs(now = new Date()): void {
  try {
    const dir = logDir();
    if (!fs.existsSync(dir)) return;
    const cutoff = now.getTime() - KEEP_DAYS * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(dir)) {
      const m = /^tool-calls-(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(f);
      if (!m) continue;
      const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
      if (t < cutoff) fs.unlinkSync(path.join(dir, f));
    }
  } catch {
    /* 清理失败不影响服务 */
  }
}

export type ToolCallEntry = {
  ts: string;
  tool: string;
  /** 参数摘要（截断） */
  args: string;
  /** 耗时毫秒 */
  ms: number;
  ok: boolean;
  /** 失败时的错误首行（截断 200 字） */
  error?: string;
};

/** 摘要化：长字符串（base64、整段文案）只留头，避免日志被一行 50KB 撑爆 */
function digest(args: unknown): string {
  if (args === undefined || args === null) return "";
  let text: string;
  try {
    text = JSON.stringify(args);
  } catch {
    return "(无法序列化)";
  }
  if (!text) return "";
  return text.length > MAX_ARG_CHARS ? `${text.slice(0, MAX_ARG_CHARS)}…(${text.length}字)` : text;
}

export function logToolCall(entry: {
  tool: string;
  args?: unknown;
  startedAt: number;
  ok: boolean;
  error?: unknown;
}): void {
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    const errText =
      entry.ok || entry.error === undefined
        ? undefined
        : (entry.error instanceof Error ? entry.error.message : String(entry.error))
            .split("\n")[0]
            .slice(0, 200);
    const line: ToolCallEntry = {
      ts: new Date().toISOString(),
      tool: entry.tool,
      args: digest(entry.args),
      ms: Math.round(performance.now() - entry.startedAt),
      ok: entry.ok,
      ...(errText ? { error: errText } : {}),
    };
    fs.appendFileSync(fileOfDay(dayOf()), `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    /* 日志写不进去不影响工具 */
  }
}

export function readToolCalls(days = 1, now = new Date()): ToolCallEntry[] {
  const out: ToolCallEntry[] = [];
  for (let i = 0; i < Math.max(1, Math.min(days, KEEP_DAYS)); i++) {
    const d = new Date(now.getTime() - i * 24 * 3600 * 1000);
    const file = fileOfDay(dayOf(d));
    if (!fs.existsSync(file)) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as ToolCallEntry);
      } catch {
        /* 半行（进程被杀时）跳过 */
      }
    }
  }
  return out;
}

export type ToolStats = {
  days: number;
  total: number;
  failed: number;
  /** 按调用次数降序 */
  byTool: { tool: string; calls: number; failed: number; avgMs: number; p95Ms: number }[];
  /** 按失败次数降序 */
  topErrors: { tool: string; error: string; count: number }[];
};

export function toolStats(days = 1, now = new Date()): ToolStats {
  const entries = readToolCalls(days, now);
  const byTool = new Map<string, { calls: number; failed: number; ms: number[] }>();
  const errs = new Map<string, { tool: string; error: string; count: number }>();

  for (const e of entries) {
    const t = byTool.get(e.tool) ?? { calls: 0, failed: 0, ms: [] };
    t.calls++;
    t.ms.push(e.ms);
    if (!e.ok) {
      t.failed++;
      if (e.error) {
        const key = `${e.tool}\u0000${e.error}`;
        const hit = errs.get(key) ?? { tool: e.tool, error: e.error, count: 0 };
        hit.count++;
        errs.set(key, hit);
      }
    }
    byTool.set(e.tool, t);
  }

  const p95 = (arr: number[]) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
  };

  return {
    days,
    total: entries.length,
    failed: entries.filter((e) => !e.ok).length,
    byTool: [...byTool.entries()]
      .map(([tool, v]) => ({
        tool,
        calls: v.calls,
        failed: v.failed,
        avgMs: Math.round(v.ms.reduce((a, b) => a + b, 0) / v.calls),
        p95Ms: p95(v.ms),
      }))
      .sort((a, b) => b.calls - a.calls),
    topErrors: [...errs.values()].sort((a, b) => b.count - a.count).slice(0, 10),
  };
}

/** 给 tool_stats 工具用的可读报告 */
export function toolStatsToText(s: ToolStats): string {
  const nl = String.fromCharCode(10);
  if (!s.total) {
    return `最近 ${s.days} 天没有工具调用记录（日志在 data/logs/，跑几次工具后再看）。`;
  }
  const lines = [`最近 ${s.days} 天：${s.total} 次调用，失败 ${s.failed} 次（${((s.failed / s.total) * 100).toFixed(1)}%）`];
  lines.push("", "调用最多：");
  for (const t of s.byTool.slice(0, 10)) {
    lines.push(`  ${t.tool.padEnd(26)} ${String(t.calls).padStart(4)} 次  失败 ${t.failed}  平均 ${t.avgMs}ms  p95 ${t.p95Ms}ms`);
  }
  if (s.topErrors.length) {
    lines.push("", "高频失败（按次数）：");
    for (const e of s.topErrors) lines.push(`  ${e.tool} × ${e.count}：${e.error}`);
  }
  return lines.join(nl);
}
