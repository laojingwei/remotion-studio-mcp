/**
 * 安全边界 / 版本一致性 / 原子写 / 调用日志 的回归。
 *
 *   npx tsx scripts/test-security.mts
 *
 * 这几条都是"出问题时不报错、只是悄悄失守"的类型，必须挡住：
 *  - Host/Origin 校验漏一个分支 → 任意网页或同网段设备能改工程
 *  - 版本号再次漂移 → MCP 宿主显示 1.1.0、npm 上是 1.0.8
 *  - 原子写退化成直接覆盖 → 断电后工程打不开
 *  - 调用日志写坏 → 复盘时又没有数据
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkRequest, corsAllowOrigin, hostnameOf } from "../server/security";
import { VERSION } from "../server/version";
import { logToolCall, pruneToolLogs, readToolCalls, toolStats } from "../server/tool-log.service";
import { DATA_DIR, writeProject } from "../server/store";
import { createSeedProject } from "../shared/ops";

/** 探针条目写临时目录：别把测试数据混进真实的 data/logs，否则 tool_stats 全是噪音 */
const TMP_LOG = fs.mkdtempSync(path.join(os.tmpdir(), "studio-tool-log-"));
process.env.STUDIO_LOG_DIR = TMP_LOG;

let passed = 0;
const failures: string[] = [];
const test = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  [ok] ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  [fail] ${name}`);
    console.error(`         ${err instanceof Error ? err.message : String(err)}`);
  }
};

/* ────────────────────────── Host / Origin ────────────────────────── */

test("hostnameOf 去掉端口、保留 IPv6 方括号", () => {
  assert.equal(hostnameOf("localhost:4380"), "localhost");
  assert.equal(hostnameOf("127.0.0.1:4380"), "127.0.0.1");
  assert.equal(hostnameOf("[::1]:4380"), "[::1]");
  assert.equal(hostnameOf("http://localhost:5173"), "localhost");
  assert.equal(hostnameOf(""), "");
});

test("读请求一律放行（GET/HEAD/OPTIONS 不校验来源）", () => {
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    assert.equal(checkRequest({ method, host: "evil.example.com", origin: "https://evil.example.com", allowLan: false }).ok, true);
  }
});

test("写请求：本机 Host + 无 Origin（curl/MCP 代理）放行", () => {
  assert.equal(checkRequest({ method: "POST", host: "127.0.0.1:4380", allowLan: false }).ok, true);
  assert.equal(checkRequest({ method: "POST", host: "localhost:4380", allowLan: false }).ok, true);
});

test("写请求：Host 不是本机名 → 421（挡 DNS rebinding）", () => {
  const d = checkRequest({ method: "POST", host: "attacker.example.com:4380", allowLan: false });
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.status, 421);
});

test("写请求：Origin 是外站 → 403（挡浏览器跨站调 tool_call）", () => {
  const d = checkRequest({
    method: "POST",
    host: "127.0.0.1:4380",
    origin: "https://evil.example.com",
    allowLan: false,
  });
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.status, 403);
});

test("写请求：Origin: null（沙箱 iframe / file://）→ 403", () => {
  const d = checkRequest({ method: "POST", host: "localhost:4380", origin: "null", allowLan: false });
  assert.equal(d.ok, false);
});

test("写请求：本机不同端口的 Origin 放行（vite dev 5173 → 4380）", () => {
  const d = checkRequest({
    method: "POST",
    host: "localhost:4380",
    origin: "http://localhost:5173",
    allowLan: false,
  });
  assert.equal(d.ok, true);
});

test("HOST=0.0.0.0（allowLan）时不再校验，用户已显式开放", () => {
  assert.equal(
    checkRequest({ method: "POST", host: "192.168.1.9:4380", origin: "http://192.168.1.9:4380", allowLan: true }).ok,
    true,
  );
});

test("CORS 只回本机来源，不再回 *", () => {
  assert.equal(corsAllowOrigin("http://localhost:5173"), "http://localhost:5173");
  assert.equal(corsAllowOrigin("https://evil.example.com"), null);
  assert.equal(corsAllowOrigin("null"), null);
  assert.equal(corsAllowOrigin(undefined), null);
});

/* ────────────────────────── 版本唯一来源 ────────────────────────── */

test("VERSION 与 package.json 一致（防止再次三处漂移）", () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8")) as {
    version: string;
  };
  assert.equal(VERSION, pkg.version);
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
});

/* ────────────────────────── 调用日志 ────────────────────────── */

test("logToolCall 落盘后可被读回，且参数被截断", () => {
  const marker = `probe_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  logToolCall({
    tool: marker,
    args: { text: "x".repeat(2000) },
    startedAt: performance.now() - 12,
    ok: true,
  });
  const entries = readToolCalls(1).filter((e) => e.tool === marker);
  assert.equal(entries.length, 1);
  assert.ok(entries[0].args.length < 600, `参数摘要过长：${entries[0].args.length}`);
  assert.ok(entries[0].ms >= 0);
});

test("失败调用带 error 首行，并能被 toolStats 汇总", () => {
  const marker = `probe_fail_${Date.now()}`;
  logToolCall({ tool: marker, args: {}, startedAt: performance.now(), ok: false, error: new Error("第一行\n第二行") });
  const stats = toolStats(1);
  const row = stats.byTool.find((t) => t.tool === marker);
  assert.ok(row, "统计里没有这次失败调用");
  assert.equal(row.failed, 1);
  const err = stats.topErrors.find((e) => e.tool === marker);
  assert.ok(err, "高频失败里没有这条");
  assert.equal(err.error, "第一行");
});

test("日志保留 7 天内的文件，更老的被清掉", () => {
  const dir = TMP_LOG;
  fs.mkdirSync(dir, { recursive: true });
  const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const stamp = `${old.getFullYear()}-${String(old.getMonth() + 1).padStart(2, "0")}-${String(old.getDate()).padStart(2, "0")}`;
  const stale = path.join(dir, `tool-calls-${stamp}.jsonl`);
  fs.writeFileSync(stale, "{}\n");
  pruneToolLogs();
  assert.equal(fs.existsSync(stale), false, "超期日志没有被清理");
});

/* ────────────────────────── 原子写 ────────────────────────── */

test("writeProject 落盘后没有残留 .tmp，且内容可读", () => {
  const id = `probe_atomic_${Date.now().toString(36)}`;
  const project = createSeedProject(id);
  try {
    writeProject(project);
    const file = path.join(DATA_DIR, id, "project.json");
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.existsSync(`${file}.tmp`), false, "留下了 .tmp 临时文件");
    const back = JSON.parse(fs.readFileSync(file, "utf8")) as { id: string };
    assert.equal(back.id, id);
  } finally {
    fs.rmSync(path.join(DATA_DIR, id), { recursive: true, force: true });
  }
});

/* ────────────────────────── 汇总 ────────────────────────── */

try {
  fs.rmSync(TMP_LOG, { recursive: true, force: true });
} catch {
  /* 临时目录清不掉不影响结论 */
}

console.log("");
if (failures.length) {
  console.error(`\x1b[31m${failures.length} 个用例失败\x1b[0m（通过 ${passed} 个）`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\x1b[32m安全/版本/日志：全部通过\x1b[0m（${passed} 个用例）`);
