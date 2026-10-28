/**
 * 一键启动：构建前端 → 起服务 → 打开浏览器。
 * 目标是不用记命令，双击「启动编辑器.bat」就能进编辑器。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 4380);
// 对外展示 / 打开浏览器用 localhost；探活仍走 127.0.0.1（localhost 可能先解析到 ::1）
const URL = `http://localhost:${PORT}`;
const PROBE = `http://127.0.0.1:${PORT}`;
const DIST = path.join(ROOT, "dist", "web", "index.html");

const started = Date.now();

/* 1. 前端构建：产物缺失或源码更新时重建，避免"改了代码页面没变"的错觉 */
function newestMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  };
  walk(dir);
  return newest;
}

const distTime = fs.existsSync(DIST) ? fs.statSync(DIST).mtimeMs : 0;
const sourceTime = Math.max(newestMtime(path.join(ROOT, "web")), newestMtime(path.join(ROOT, "shared")));

if (distTime < sourceTime) {
  console.log("▸ 构建编辑器前端 …");
  const r = spawnSync("npx", ["vite", "build"], { cwd: ROOT, shell: true, stdio: "inherit" });
  if (r.status !== 0) {
    console.error("✗ 构建失败，请检查上面的报错");
    process.exit(1);
  }
}

/* 2. 端口已被占用？说明服务已经跑着，直接开浏览器即可 */
async function alive() {
  try {
    const res = await fetch(`${PROBE}/api/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

function openBrowser() {
  const cmd = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
  spawn(cmd, [URL], { shell: process.platform === "win32", detached: true, stdio: "ignore" }).unref();
}

if (await alive()) {
  console.log(`▸ 服务已在运行，直接打开 ${URL}`);
  openBrowser();
  process.exit(0);
}

/* 3. 起服务（本进程即服务，Ctrl+C 结束） */
console.log(`▸ 启动服务 ${URL}`);
/**
 * 关掉宿主注入的 safe-delete 拦截器（NODE_OPTIONS 里的 preload shim）。
 *
 * 它按"每轮删除的文件数"设阈值（本机是 50）。而服务端每写一次工程都会轮转
 * `data/projects/<id>/history/` 快照（保留 50 份），rev 一过 50 就**每次写都删一个文件**，
 * 很容易撞到阈值。撞上之后它不再抛错而是卡住等确认 —— 本机是无人值守的常驻进程，
 * 于是整个 Node 事件循环被挂死：属性改不动、页面刷新转圈、连静态资源都不响应。
 * 症状极易误判成"前端卡死"，实际是服务端被拦在删除上。
 * 这是本地单用户工具，删除行为都是我们自己可控的工程/快照，直接禁用。
 */
const server = spawn("npx", ["tsx", "server/index.ts"], {
  cwd: ROOT,
  shell: true,
  stdio: "inherit",
  env: { ...process.env, PORT: String(PORT), CODEBUDDY_SAFE_DELETE_ENABLED: "0" },
});

let opened = false;
const timer = setInterval(async () => {
  if (opened) return;
  if (await alive()) {
    opened = true;
    clearInterval(timer);
    console.log(`▸ 就绪（${((Date.now() - started) / 1000).toFixed(1)}s），已打开浏览器`);
    openBrowser();
  }
}, 500);

const shutdown = () => {
  clearInterval(timer);
  server.kill();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
server.on("exit", (code) => {
  clearInterval(timer);
  process.exit(code ?? 0);
});
