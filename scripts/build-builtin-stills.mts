#!/usr/bin/env node
/**
 * 给 43 个内置风格批量出静帧，落到 `server/styles/stills/<slug>.webp`。
 *
 *   npx tsx scripts/build-builtin-stills.mts            # 缺哪张补哪张
 *   npx tsx scripts/build-builtin-stills.mts --force    # 全部重出
 *   npx tsx scripts/build-builtin-stills.mts --only=dark-keynote,swiss-editorial
 *
 * 为什么要单独一个脚本，而不是复用 probe_style：
 *   probe_style 是给「某一支片子的候选风格」出样张，要求 brief 已确认、还要动工程里的场景；
 *   这里是给风格库**一次性**配图，不该依赖任何用户的工程状态。所以自己造一个一次性工程
 *   （名字固定「风格样张（自动）」），套完风格抽一帧就走。
 *
 * 前置：需要一个**在跑的服务**（渲染和套风格都要经过它）：`npm run dev:server` 或 `npm start`。
 * 端口用 PORT 环境变量指定，默认 4380。
 *
 * 为什么抽「内容页」而不是封面页：封面只有一行标题，看不出这个风格的密度、配色层次和排版；
 * 用户在面板里挑风格时看的是「这风格做内容页长什么样」。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT as PROJECT_ROOT } from "../server/root";
import { listStyles, stylePresetIssues } from "../server/styles.service";

const PORT = Number(process.env.PORT ?? 4380);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(PROJECT_ROOT, "server", "styles", "stills");
const PROJECT_NAME = "风格样张（自动）";
const STILL_EDGE = 960;

const argv = process.argv.slice(2);
const force = argv.includes("--force");
const only = (() => {
  const hit = argv.find((a) => a.startsWith("--only="));
  return hit ? hit.slice(7).split(",").map((s) => s.trim()).filter(Boolean) : null;
})();

function fail(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

async function api<T>(pathname: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${pathname}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

/** 找 ffmpeg 的方式和 style-library.mts 一致：认编码器，不认文件名 */
function findFfmpeg(): string {
  const candidates = [
    process.env.RMS_FFMPEG?.trim(),
    "G:/共享/自动化/FFmpeg/bin/ffmpeg.exe",
    ...(process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((d) => path.join(d, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg")),
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const enc = execFileSync(p, ["-hide_banner", "-encoders"], { encoding: "utf8" });
      if (/\blibwebp\b/.test(enc)) return p;
    } catch {
      /* 换下一个 */
    }
  }
  fail(
    "找不到能编 webp 的 ffmpeg（Remotion 自带的只有 mjpeg）。\n" +
      "设环境变量 RMS_FFMPEG，或把完整版 ffmpeg 加进 PATH 后重跑。",
  );
}

type ProjectLite = { id: string; name: string; scenes: { id: string; type: string; name?: string; durationInFrames?: number }[] };

async function ensureProject(): Promise<ProjectLite> {
  const { projects } = await api<{ projects: { id: string; name: string }[] }>("/api/projects");
  const hit = projects.find((p) => p.name === PROJECT_NAME);
  if (hit) {
    const { project } = await api<{ project: ProjectLite }>(`/api/projects/${hit.id}`);
    return project;
  }
  const { project } = await api<{ project: ProjectLite }>("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: PROJECT_NAME }),
  });
  console.log(`▸ 建了临时工程 ${project.id}`);
  return project;
}

/**
 * 保证工程里**只有一幕**内容页。
 *
 * 为什么要清场：新建工程会带一份 demo 内容（封面 + 几幕），而 `renderStills(project, frame)`
 * 收的是**整条时间轴的全局帧**。留着 demo，一个按"本幕中途"算出来的帧号会落在 demo 的
 * 封面幕上——抽出来是一张和这个风格无关的图（实测过：43 张全是同一张 demo 封面）。
 * 清空后全局帧 = 本幕帧，帧号怎么算都不会错。
 */
async function ensureContentScene(projectId: string): Promise<{ id: string; durationInFrames: number }> {
  const { project } = await api<{ project: ProjectLite }>(`/api/projects/${projectId}`);
  let scene = project.scenes.find((s) => s.name === "样张·内容");
  if (!scene) {
    const created = await api<{ createdSceneIds: string[] }>(`/api/projects/${projectId}/ops`, {
      method: "POST",
      body: JSON.stringify({
        actor: "agent",
        ops: [
          {
            op: "add_scene",
            type: "list",
            name: "样张·内容",
            props: {
              heading: "这个风格做内容页的样子",
              items: [
                { title: "第一条要点", note: "说明文字" },
                { title: "第二条要点", note: "说明文字" },
                { title: "第三条要点", note: "说明文字" },
                { title: "第四条要点", note: "说明文字" },
                { title: "第五条要点", note: "说明文字" },
              ],
            },
          },
        ],
      }),
    });
    const id = created.createdSceneIds?.[0];
    if (!id) fail("内容页创建失败：检查 list 版式是否可用");
    const again = await api<{ project: ProjectLite }>(`/api/projects/${projectId}`);
    scene = again.project.scenes.find((s) => s.id === id);
  }
  if (!scene) fail("内容页创建后读不回来");

  const others = project.scenes.filter((s) => s.id !== scene!.id);
  if (others.length) {
    await api(`/api/projects/${projectId}/ops`, {
      method: "POST",
      body: JSON.stringify({ actor: "agent", ops: others.map((s) => ({ op: "remove_scene", sceneId: s.id })) }),
    });
  }
  const final = await api<{ project: ProjectLite }>(`/api/projects/${projectId}`);
  const only = final.project.scenes.find((s) => s.name === "样张·内容") ?? final.project.scenes[0];
  return { id: only.id, durationInFrames: only.durationInFrames ?? 120 };
}

async function main(): Promise<void> {
  const health = await fetch(`${BASE}/api/health`).catch(() => null);
  if (!health?.ok) {
    fail(
      `服务没在跑（${BASE}）。\n` +
        `先起一个：npm run dev:server（或 npm start / 双击「启动编辑器.bat」），` +
        `端口不同就带 PORT=xxxx 再跑本脚本。`,
    );
  }

  const issues = stylePresetIssues();
  if (issues.length) {
    console.log(`⚠ 插件预设有问题（这些风格可能套不上）：\n${issues.map((i) => `  - ${i}`).join("\n")}`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const ffmpeg = findFfmpeg();

  let targets = listStyles().filter((s) => s.hasPreset);
  if (only) targets = targets.filter((s) => only.includes(s.slug));
  if (!targets.length) fail("没有可出的风格（都有图了？用 --force 重出，或 --only= 指定）");

  const todo = force
    ? targets
    : targets.filter((s) => !fs.existsSync(path.join(OUT_DIR, `${s.slug}.webp`)));
  if (!todo.length) {
    console.log(`全部 ${targets.length} 个风格都已有静帧。要重出加 --force。`);
    return;
  }
  console.log(`▸ 待出 ${todo.length} / ${targets.length} 个风格，输出 ${path.relative(PROJECT_ROOT, OUT_DIR)}`);

  const project = await ensureProject();
  const scene = await ensureContentScene(project.id);
  // 取这一幕的中间帧：避开入场动画（第一帧元素还没进来）也避开淡出
  const frame = Math.max(1, Math.floor(scene.durationInFrames * 0.55));

  const applyTool = (await import("../server/mcp-tools")).TOOLS.find((d) => d.name === "apply_style");
  if (!applyTool) fail("找不到 apply_style 工具（mcp-tools 导出了吗）");

  let ok = 0;
  const failed: { slug: string; reason: string }[] = [];
  for (const [i, s] of todo.entries()) {
    const label = `[${i + 1}/${todo.length}] ${s.slug}`;
    try {
      await applyTool.run({ slug: s.slug, projectId: project.id } as never);
      const r = await api<{ stills: { format: string; url: string; frame?: number }[] }>(
        `/api/projects/${project.id}/stills`,
        { method: "POST", body: JSON.stringify({ frame, tag: s.slug }) },
      );
      const still = r.stills?.[0];
      if (!still) throw new Error("没有返回静帧");
      // url 形如 /out/projects/<id>/stills/xxx.png?t=3 —— 尾部的 ?t= 是防缓存用的，不是文件名
      const clean = still.url.split("?")[0];
      const src = path.join(PROJECT_ROOT, "out", clean.replace(/^\/out\//, "").replace(/^\//, ""));
      if (!fs.existsSync(src)) throw new Error(`静帧没落盘：${src}`);
      const dst = path.join(OUT_DIR, `${s.slug}.webp`);
      execFileSync(
        ffmpeg,
        ["-y", "-v", "error", "-i", src, "-vf", `scale='min(${STILL_EDGE},iw)':-2:flags=lanczos`, "-c:v", "libwebp", "-lossless", "0", "-q:v", "80", dst],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      ok++;
      console.log(`  ✓ ${label} ${s.name}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failed.push({ slug: s.slug, reason });
      console.log(`  ✗ ${label}：${reason.split("\n")[0]}`);
    }
  }

  console.log(`\n完成：${ok} 张成功，${failed.length} 张失败。`);
  if (failed.length) {
    console.log("失败的（重跑会只补这些）：");
    for (const f of failed) console.log(`  - ${f.slug}：${f.reason.split("\n")[0]}`);
  }
  console.log(`\n下一步：npm run style:build（重建索引带上静帧标记），然后刷新编辑器「风格库」面板。`);
}

await main();
process.exit(0);
