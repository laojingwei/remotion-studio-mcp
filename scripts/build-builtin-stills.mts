#!/usr/bin/env node
/**
 * 给内置风格批量出样张，落到 `server/styles/stills/<slug>.webp`。
 *
 *   npx tsx scripts/build-builtin-stills.mts              # 缺哪张补哪张
 *   npx tsx scripts/build-builtin-stills.mts --force      # 全部重出
 *   npx tsx scripts/build-builtin-stills.mts --only=dark-keynote,swiss-editorial
 *   npx tsx scripts/build-builtin-stills.mts --showcase   # 只出有 showcase 配方的
 *
 * ── 为什么要单独一个脚本，而不是复用 probe_style ──
 * probe_style 是给「某一支片子的候选风格」出样张，要求 brief 已确认、还要动工程里的场景；
 * 这里是给风格库**一次性**配图，不该依赖任何用户的工程状态。所以自己造一个一次性工程
 * （名字固定「风格样张（自动）」），套完风格抽一帧就走。
 *
 * ── 样张长什么样，由 preset.showcase 决定 ──
 * 以前所有风格共用同一张 `list`（五行要点）场景，结果 77 个风格只差配色 ——
 * 用户原话是「千篇一律，不好区分」。现在每个风格按自己的 showcase 配方搭自由画布场景
 * （见 server/showcase.ts 的模板层）：数据实体化画两堆方块、木刻画黑块刻痕、点云铺点阵。
 *
 * 没有 showcase 的风格暂时退回旧的内容页，并在结尾列出待补清单 ——
 * 悄悄出一张"和别的风格一样"的图，比没有图更糟。
 *
 * 前置：需要一个**在跑的服务**（渲染和套风格都要经过它）：`npm run dev:server` 或 `npm start`。
 * 端口用 PORT 环境变量指定，默认 4380。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT as PROJECT_ROOT } from "../server/root";
import { listStyles, presetOf, stylePresetIssues } from "../server/styles.service";
import { buildShowcaseProps } from "../server/showcase";
import { refreshStillVersion } from "./still-version.mts";

const PORT = Number(process.env.PORT ?? 4380);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.join(PROJECT_ROOT, "server", "styles", "stills");
const PROJECT_NAME = "风格样张（自动）";
const STILL_EDGE = 960;

const argv = process.argv.slice(2);
const force = argv.includes("--force");
const showcaseOnly = argv.includes("--showcase");
const only = (() => {
  const hit = argv.find((a) => a.startsWith("--only="));
  return hit ? hit.slice(7).split(",").map((s) => s.trim()).filter(Boolean) : null;
})();

/** 没有 showcase 的风格退回这一张：不理想，但至少是"这个风格的配色做内容页"。 */
const LEGACY_LIST_PROPS = {
  heading: "这个风格做内容页的样子",
  items: [
    { title: "第一条要点", note: "说明文字" },
    { title: "第二条要点", note: "说明文字" },
    { title: "第三条要点", note: "说明文字" },
    { title: "第四条要点", note: "说明文字" },
    { title: "第五条要点", note: "说明文字" },
  ],
};

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

/** 找 ffmpeg 的方式和以前一致：认编码器，不认文件名（Remotion 自带的那份没有 libwebp） */
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

type ProjectLite = {
  id: string;
  name: string;
  formats?: { key: string; width: number; height: number }[];
  scenes: { id: string; type: string; name?: string; durationInFrames?: number }[];
};

async function ensureProject(): Promise<ProjectLite> {
  const { projects } = await api<{ projects: { id: string; name: string }[] }>("/api/projects");
  const hit = projects.find((p) => p.name === PROJECT_NAME);
  if (hit) return (await api<{ project: ProjectLite }>(`/api/projects/${hit.id}`)).project;
  const { project } = await api<{ project: ProjectLite }>("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: PROJECT_NAME }),
  });
  console.log(`▸ 建了临时工程 ${project.id}`);
  return project;
}

/**
 * 为某个风格重建唯一一幕，返回它的 id 与时长。
 *
 * 为什么每轮都清场：`renderStills(project, frame)` 收的是**整条时间轴的全局帧**。
 * 留着上一轮的场景，按"本幕中途"算出来的帧号会落到别的幕上——抽出来是一张
 * 和这个风格无关的图（实测过：43 张全是同一张 demo 封面）。清空后全局帧 = 本幕帧。
 */
async function rebuildScene(
  projectId: string,
  slug: string,
  canvas: { w: number; h: number },
): Promise<{ id: string; duration: number; usedShowcase: boolean }> {
  const { project } = await api<{ project: ProjectLite }>(`/api/projects/${projectId}`);
  if (project.scenes?.length) {
    await api(`/api/projects/${projectId}/ops`, {
      method: "POST",
      body: JSON.stringify({
        actor: "agent",
        ops: project.scenes.map((s) => ({ op: "remove_scene", sceneId: s.id })),
      }),
    });
  }

  const preset = presetOf(slug);
  const sc = preset?.showcase;
  const op = sc
    ? {
        op: "add_scene",
        type: "freeform",
        name: "样张",
        props: buildShowcaseProps(sc, preset!.palette, canvas),
      }
    : { op: "add_scene", type: "list", name: "样张", props: LEGACY_LIST_PROPS };

  const created = await api<{ createdSceneIds: string[] }>(`/api/projects/${projectId}/ops`, {
    method: "POST",
    body: JSON.stringify({ actor: "agent", ops: [op] }),
  });
  const id = created.createdSceneIds?.[0];
  if (!id) fail(`「${slug}」的场景建不出来（type=${sc ? "freeform" : "list"}）`);
  const fresh = await api<{ project: ProjectLite }>(`/api/projects/${projectId}`);
  const me = fresh.project.scenes.find((s) => s.id === id);
  return { id, duration: me?.durationInFrames ?? 120, usedShowcase: Boolean(sc) };
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
  if (showcaseOnly) targets = targets.filter((s) => Boolean(presetOf(s.slug)?.showcase));
  if (only) targets = targets.filter((s) => only.includes(s.slug));
  if (!targets.length) fail("没有可出的风格（都有图了？用 --force 重出，或 --only= 指定）");

  const todo = force ? targets : targets.filter((s) => !fs.existsSync(path.join(OUT_DIR, `${s.slug}.webp`)));
  if (!todo.length) {
    console.log(`全部 ${targets.length} 个风格都已有样张。要重出加 --force。`);
    return;
  }

  const project = await ensureProject();
  const canvas = {
    w: project.formats?.[0]?.width ?? 1920,
    h: project.formats?.[0]?.height ?? 1080,
  };
  console.log(`▸ 待出 ${todo.length} / ${targets.length} 个风格，画幅 ${canvas.w}×${canvas.h}，输出 ${path.relative(PROJECT_ROOT, OUT_DIR)}`);

  const applyTool = (await import("../server/mcp-tools")).TOOLS.find((d) => d.name === "apply_style");
  if (!applyTool) fail("找不到 apply_style 工具（mcp-tools 导出了吗）");

  let ok = 0;
  const failed: { slug: string; reason: string }[] = [];
  const noShowcase: string[] = [];

  for (const [i, s] of todo.entries()) {
    const label = `[${i + 1}/${todo.length}] ${s.slug}`;
    try {
      const scene = await rebuildScene(project.id, s.slug, canvas);
      if (!scene.usedShowcase) noShowcase.push(s.slug);
      await applyTool.run({ slug: s.slug, projectId: project.id } as never);
      // 取这一幕的中间偏后：避开入场动画（第一帧元素还没进来），也要等网点/点阵画完
      const frame = Math.max(1, Math.floor(scene.duration * 0.6));
      const r = await api<{ stills: { format: string; url: string }[] }>(
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
        [
          "-y", "-v", "error", "-i", src,
          "-vf", `scale='min(${STILL_EDGE},iw)':-2:flags=lanczos`,
          "-c:v", "libwebp", "-lossless", "0", "-q:v", "80", dst,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      ok++;
      console.log(`  ✓ ${label} ${s.name}${scene.usedShowcase ? "" : "（旧内容页）"}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failed.push({ slug: s.slug, reason });
      console.log(`  ✗ ${label}：${reason.split("\n")[0]}`);
    }
  }

  // 收尾清场：别把最后一个风格的场景留在工程里，下次跑会当成"已有"
  try {
    const { project: last } = await api<{ project: ProjectLite }>(`/api/projects/${project.id}`);
    if (last.scenes?.length) {
      await api(`/api/projects/${project.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: last.scenes.map((s) => ({ op: "remove_scene", sceneId: s.id })),
        }),
      });
    }
  } catch {
    /* 清不掉不影响出图 */
  }

  console.log(`\n完成：${ok} 张成功，${failed.length} 张失败。`);
  if (ok > 0) {
    const v = refreshStillVersion();
    if (v) console.log(`  静帧版本戳 ${v}（前端图片 URL 带 ?v=，自动绕过浏览器强缓存）`);
  }
  if (noShowcase.length) {
    console.log(
      `\n⚠ 这 ${noShowcase.length} 个风格还没有 showcase 配方，出的是旧内容页（和别的风格长得一样）：\n` +
        `  ${noShowcase.join("、")}\n` +
        `  补法：在 server/styles/presets.json 对应条目里加 "showcase"，见 server/showcase.ts 的模板说明。`,
    );
  }
  if (failed.length) {
    console.log("\n失败的（重跑会只补这些）：");
    for (const f of failed) console.log(`  - ${f.slug}：${f.reason.split("\n")[0]}`);
  }
}

await main();
process.exit(0);
