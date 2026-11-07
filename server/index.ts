import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { serveStatic } from "@hono/node-server/serve-static";
import { cleanupLegacyBundles } from "./bundle-cache";
import { mimeOf, serveFiles } from "./static.service";
import { getPluginConfig, savePluginConfig } from "./plugin-config.service";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import fs from "node:fs";
import path from "node:path";
import { metaList } from "../shared/sceneMetas";
import { ensurePluginScenes, pluginSceneTypes } from "./plugin/scene-meta";
import {
  ensurePluginEntryFresh,
  syncPluginElements,
  syncPluginGraphPresets,
  syncPluginLooks,
  syncPluginPasses,
  syncPluginTransitions,
  syncPluginTemplates,
  syncPluginWorldSkies,
} from "./plugin/content-sync";
import { ensurePluginHooks } from "./plugin/hooks";
import { ensurePluginTools } from "./plugin/plugin-tools";
import {
  PROJECT_PLUGIN_DIR,
  PLUGIN_TRASH_DIR,
  cancelJob,
  cleanupPluginStaging,
  detectSourceKind,
  ensureTtsProviders,
  getJob,
  guessTargetName,
  listJobs,
  hasExampleEntry,
  hookKindsOf,
  pluginRoots,
  pluginToolNamesOf,
  readPackageJson,
  removePlugin,
  scanOrphanDirs,
  removeOrphanDir,
  resolvePluginEntry,
  scanPlugins,
  setPluginEnabled,
  seedExamplePluginsDisabled,
  startInstall,
  startRepair,
  ttsProviderCatalog,
  declaresCodeEntry,
  getRegistry,
  setRegistry,
  REGISTRY_PRESETS,
  DEFAULT_REGISTRY,
} from "./plugin";
import type { Op } from "../shared/ops";
import { createSeedProject } from "../shared/ops";
import type { Project } from "../shared/schema";
import { buildFromTemplate, templateList } from "../shared/templates";
import { projects } from "./project.service";
import type { OpResult } from "../shared/ops";
import { templates } from "./template.service";
import { bundleService } from "./bundle.service";
import { cleanupOutputs, deleteOutputs, listOutputs, removeProjectOutputs, setOutputLock } from "./outputs.service";
import {
  absAssetPath,
  cleanupUnusedAssets,
  listProjectAssets,
  organizeAssets,
  PROJECTS_REL,
  projectAssetRel,
  reclaimAssetFiles,
  referencedAssetFiles,
  removeProjectAssets,
  writeProjectAsset,
} from "./assets.service";
import { ingestAsset, reprocessProjectAssets } from "./asset-pipeline.service";
import {
  RESOURCE_CATEGORIES,
  browseCategory,
  pickDir,
  readResourceDirs,
  searchCategory,
  serveResourceFile,
  clearResourceDir,
  setResourceDir,
} from "./resources.service";
import { assetNameOf } from "../shared/customTemplate";
import { addMessage, listMessages, markUserMessagesRead } from "./agentBridge.service";
import {
  addAnnotation,
  deleteAnnotation,
  listAnnotations,
  resolveAnnotations,
} from "./annotation.service";
import { readToolCalls, toolStats } from "./tool-log.service";
import { getTtsConfig, saveTtsConfig, synthesize } from "./tts.service";
import { BUILTIN_TTS_PROVIDER_ID, getTtsProvider } from "./plugin/tts-providers";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { TOOLS, CORE_TOOL_NAMES, exposeAllTools, validateToolArgs } from "./mcp-tools";
import { library } from "./library.service";
import {
  buildIndex,
  builtinStillAbsOf,
  isLibraryEmpty,
  listBuiltinStyles,
  listLibrary,
  readBuiltinStyle,
  readPicks,
  readPrompt,
  stillAbsOf,
  writeOverride,
  writePicks,
} from "./styleLibrary.service";
import { STYLE_MOODS, STYLE_USES, type StyleMood, type StyleUse } from "../shared/style-library";
import { readBrief, saveBrief } from "./brief.service";
import { markNarrationHeard, readTiming, saveTiming } from "./narration-timing.service";
import { appendDecision, readDecisions, type DecisionKind } from "./decision-log.service";
import { readStoryboard, saveStoryboard } from "./storyboard.service";
import { readDesignCard } from "./design.service";
import {
  activeRenderTask,
  bundleState,
  cancelTask,
  enqueueVideo,
  getServeUrl,
  getTask,
  listTasks,
  renderStills,
  renderPreviewClip,
  resetBundle,
} from "./render.service";
import { probeMany } from "./media.service";
import { DATA_DIR, ensureSeed, orphanOutputProjects, PUBLIC_DIR, readLastProjectId, readUiPrefs, writeProject, writeUiPrefs } from "./store";
import { ensureDemo3D, hasDemo3DSeed, installDemo3D, isDemo3D } from "./demo3d.service";
import { analyzeBeats } from "./audio-analysis.service";
import { measureLoudness } from "./loudness.service";
import { buildCompressCurve, summarizeCurve } from "../shared/audio";
import { MAX_VOLUME } from "../shared/schema";
import { checkRequest, corsAllowOrigin, hostnameOf, isLoopbackAddress } from "./security";
import { VERSION } from "./version";
import { installRuntimeGuards } from "./runtime";
import { logToolCall, pruneToolLogs } from "./tool-log.service";
import {
  buildCues,
  renderSubtitles,
  subtitleExt,
  writeSubtitleFile,
  type SubtitleFormat,
} from "./subtitle.service";
import {
  getWorkspaceStatus,
  listDirs,
  relocateWorkspace,
  repairWorkspace,
  resetWorkspace,
} from "./workspace.service";

// 先修链接再建目录：data/public/out 可能是迁到别的盘上的链接，断链时 ensureDirs 会建出实体目录
for (const w of repairWorkspace()) console.warn(`[workspace] ${w}`);
ensureSeed();
ensureDemo3D();

// 对账：out/ 里有、data/ 里没有的工程 —— 通常是另一个实例/另一份数据目录写出来的。
// 不说话的话，agent 会以为工程被删了，或者对着错误的工程继续改（复盘问题 18）
{
  const orphans = orphanOutputProjects();
  if (orphans.length) {
    console.warn(
      `[store] out/projects 里有 ${orphans.length} 个工程不在当前数据目录（${orphans.slice(0, 5).join("、")}${orphans.length > 5 ? "…" : ""}）：` +
        `可能是另一个实例在用别的数据目录。当前数据目录：${DATA_DIR}`,
    );
  }
}

const PORT = Number(process.env.PORT ?? 4380);

/**
 * 监听地址：默认只给本机。
 *
 * 以前 `serve({ fetch, port })` 没传 hostname，Node 会监听 `::`/`0.0.0.0`——
 * 同一局域网里任何人都能打开这个能删文件、能起渲染的编辑器。对外共享必须显式：
 *   HOST=0.0.0.0 npm start
 */
const HOST = process.env.HOST?.trim() || "127.0.0.1";
const ALLOW_LAN = !["127.0.0.1", "localhost", "::1"].includes(HOST.toLowerCase());

const app = new Hono();

/** 插件问题只报一次，避免每个请求刷屏 */
let ensuredOnce = false;
/** 已上报过的 content-sync issue：改坏 → 修好 → 再改坏，每一轮**新增**都要能看见 */
let reportedContentIssues = new Set<string>();
let hooksReported = false;
let toolsReported = false;

/**
 * 插件场景同步：**每个请求进来先做一次**。
 *
 * 为什么放在全局中间件而不是逐个端点加：用到场景表的地方远比想象中多——
 * `/api/scene-types`（选择器）、`/api/projects/:id/ops`（add_scene 要 `getMeta`）、
 * 渲染前校验、密度审计……漏一处的表现是「选择器里有、加进来报未知类型」，
 * 而且只在装了插件时复现。放这里只需要想一次。
 *
 * 成本可控：`ensurePluginScenes` 带指纹缓存，插件没变时只是十几次 stat。
 * 插件算崩了也不该挡住请求，所以吞掉异常、只在日志里留痕。
 */
app.use("*", async (_c, next) => {
  try {
    const res = ensurePluginScenes();
    /*
     * 内容型贡献项（3D 天空配方 / 整片模板）也在这里同步一次。
     * 它们和场景一样"改了要立刻生效"，但判据不同：场景看 scenes/*.json，
     * 内容看各自的 JSON 文件——所以 content-sync 自己算指纹，没变时只是几个 stat。
     */
    const sky = syncPluginWorldSkies();
    const tpl = syncPluginTemplates();
    const els = syncPluginElements();
    const looks = syncPluginLooks();
    const passes = syncPluginPasses();
    const trans = syncPluginTransitions();
    const gpreset = syncPluginGraphPresets();
    /*
     * 元素/场景要落到 `src/_plugins.generated.ts` 才能被编辑器看见（web 是独立 bundle）。
     * 这一步保证了"装完插件打开面板就有"，而不是"等下次渲染才生效"。
     */
    const entry = ensurePluginEntryFresh();
    const contentIssues = [
      ...sky.issues,
      ...tpl.issues,
      ...els.issues,
      ...looks.issues,
      ...passes.issues,
      ...trans.issues,
      ...gpreset.issues,
      ...entry.issues,
    ];
    /*
     * 按 diff 上报：以前是"整个进程只报一次"——作者修好再改坏，第二轮的新 issue
     * 永远沉默，表现就是"天空/元素突然消失，日志一个字没有"。现在只报没报过的新条目。
     */
    const fresh = contentIssues.filter((i) => !reportedContentIssues.has(i));
    if (fresh.length) {
      for (const i of fresh) {
        reportedContentIssues.add(i);
        console.warn(`[plugin] ${i}`);
      }
    }
    if (res.issues.length && !ensuredOnce) {
      // 只在第一次报，避免每个请求刷屏
      ensuredOnce = true;
      for (const i of res.issues) console.warn(`[plugin] ${i}`);
    }
  } catch (err) {
    console.warn("[plugin] 场景同步失败（不影响请求）：", err);
  }
  await next();
});

/**
 * 插件钩子加载：跟场景同步同一个位置、同一个理由。
 *
 * 钩子的调用点（自检 / 写工程 / 设计锁）全是同步函数，等不了异步加载，
 * 所以必须在请求进来之前就把插件 import 完。放在这里而不是启动时一次，
 * 是因为改了 `plugin.ts` 也要能立刻生效——指纹变了就重新 import。
 *
 * `ensurePluginHooks` 自己带 fingerprint 与 in-flight 去重，并发请求不会重复加载；
 * 插件加载失败只记错误、不挡请求（一个坏插件不该让编辑器打不开）。
 */
app.use("*", async (_c, next) => {
  try {
    const st = await ensurePluginHooks();
    if (st.errors.length && !hooksReported) {
      hooksReported = true;
      for (const e of st.errors) console.warn(`[plugin] ${e.pluginId}：${e.message}`);
    }
  } catch (err) {
    console.warn("[plugin] 钩子加载失败（不影响请求）：", err);
  }
  /*
   * 插件工具与钩子读同一个入口文件，放在同一处加载。
   * 分开加载不会出错（共享 esbuild 产物缓存），只是分开写两段 init 更容易漏掉一处。
   */
  try {
    const ts = await ensurePluginTools();
    if (ts.errors.length && !toolsReported) {
      toolsReported = true;
      for (const e of ts.errors) console.warn(`[plugin] ${e.pluginId}：${e.message}`);
    }
  } catch (err) {
    console.warn("[plugin] 工具加载失败（不影响请求）：", err);
  }
  await next();
});

/**
 * 写请求的安全闸：Host 必须是本机名（防 DNS rebinding），Origin 若存在也必须是本机。
 * 详见 server/security.ts 顶部注释——"没设 CORS" 挡不住 `text/plain` 的简单请求。
 */
app.use("*", async (c, next) => {
  const decision = checkRequest({
    method: c.req.method,
    host: c.req.header("host"),
    origin: c.req.header("origin"),
    allowLan: ALLOW_LAN,
  });
  if (!decision.ok) {
    return c.json({ error: decision.reason }, decision.status);
  }
  /**
   * JSON-RPC 请求体上限。
   *
   * 工具参数都是短文本/路径，正常远小于 1MB；给个 4MB 上限是为了挡住"超大集合"把
   * zod 校验或 JSON.parse 撑爆内存（zod 3 有一条已知的超大集合放大问题，
   * 迁移 zod 4 需要单独验证 MCP SDK 兼容性，先用上限兜住）。
   * 素材上传走 /api/projects/:id/assets 的 multipart，不受这里限制。
   */
  if (c.req.path === "/mcp") {
    const len = Number(c.req.header("content-length") ?? 0);
    if (Number.isFinite(len) && len > 4 * 1024 * 1024) {
      return c.json({ error: "请求体超过 4MB 上限：工具参数不该有这么大，检查是否误把文件内容塞进 args" }, 413);
    }
  }
  return next();
});

const fail = (c: any, err: unknown) => {
  const status = (err as { status?: number })?.status ?? 400;
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: message }, status);
};

/**
 * 编辑器产物是否落后于源码。
 *
 * 为什么要有这个：**渲染和编辑器是两条链**。Remotion 每次渲染都会自己重新打包 src，
 * 所以改了代码立刻出片是对的；但编辑器吃的是 `dist/web`，只有 `npm run build`（或
 * `npm start`）才会更新。于是出现"成片是对的、编辑器里还是旧画面"——而且**没有任何提示**。
 * 2026-11-01 就这么踩了一次：DSL 的角度单位修好之后，成片的地轴是斜的、编辑器里还是横的，
 * 看起来像渲染 bug，实际是产物旧了 3 分钟。
 */
function frontendStale(): { stale: boolean; builtAt: number; sourceAt: number } {
  const distDir = path.resolve("dist/web/static");
  const roots = ["web", "shared", "src"].map((d) => path.resolve(d));
  let builtAt = 0;
  try {
    for (const f of fs.readdirSync(distDir)) {
      builtAt = Math.max(builtAt, fs.statSync(path.join(distDir, f)).mtimeMs);
    }
  } catch {
    return { stale: true, builtAt: 0, sourceAt: Date.now() };
  }
  let sourceAt = 0;
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else sourceAt = Math.max(sourceAt, fs.statSync(p).mtimeMs);
    }
  };
  for (const r of roots) walk(r);
  return { stale: builtAt < sourceAt, builtAt, sourceAt };
}

app.get("/api/health", (c) => {
  const fe = frontendStale();
  return c.json({
    ok: true,
    version: VERSION,
    port: PORT,
    /** 仅本机 / 已对外：排障时先确认这个，比猜"为什么别人连不上"快 */
    host: HOST,
    lan: ALLOW_LAN,
    bundle: bundleState(),
    projects: projects.list().length,
    /** true = 编辑器产物比源码旧，需要 npm run build 再刷新（成片渲染不受影响） */
    frontendStale: fe.stale,
  });
});

/* ────────────────────────────── 场景能力 ────────────────────────────── */

/** agent 的第一步：发现有哪些场景类型、每个字段是什么 */
/**
 * 场景类型清单（编辑器选择器 + 属性面板用）。
 *
 * 插件场景已由上面的全局中间件同步过，这里直接用即可。
 */
app.get("/api/scene-types", (c) =>
  c.json({ types: metaList(), pluginSceneCount: pluginSceneTypes().length }),
);

/* ────────────────────────────── 工程 ────────────────────────────── */

app.get("/api/projects", (c) => c.json({ projects: projects.list() }));

/** 对账：out/ 里有、data/ 里没有的工程（多实例/多数据目录的信号） */
app.get("/api/orphans", (c) => {
  try {
    return c.json({ dataDir: DATA_DIR, ids: orphanOutputProjects() });
  } catch (err) {
    return fail(c, err);
  }
});

/* ───────────── 文本转语音（TTS） ───────────── */

app.get("/api/tts/config", (c) => c.json({ config: getTtsConfig() }));

/**
 * 可用的语音 provider：内置 openai + 插件贡献的。
 *
 * 返回 `configFields` 是为了让面板/工具能**按各家自己的字段**渲染表单——
 * 每家鉴权方式都不一样，宿主猜不出来，只能由插件声明。
 */
app.get("/api/tts/providers", async (c) => {
  try {
    const { ttsProviderCatalog } = await import("./plugin/tts-providers");
    const cat = await ttsProviderCatalog();
    return c.json({ builtin: "openai", ...cat });
  } catch (err) {
    return fail(c, err);
  }
});

app.post("/api/tts/config", async (c) => {
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    return c.json({ config: saveTtsConfig(body) });
  } catch (err) {
    return fail(c, err);
  }
});

app.post("/api/tts/synthesize", async (c) => {
  try {
    const body = (await c.req.json()) as {
      text?: string;
      voice?: string;
      speed?: number;
      format?: string;
      instruct?: string;
      escape?: boolean;
      /** 给了就存进这个工程的素材目录（删工程连带清）；不传视为试听 */
      projectId?: string;
    };
    return c.json(await synthesize(String(body.text ?? ""), body));
  } catch (err) {
    return fail(c, err);
  }
});

/** 音色列表：把 endpoint 的 /tts 去掉换成 /speakers（Qwen3-TTS 等本地服务的约定） */
app.get("/api/tts/speakers", async (c) => {
  try {
    const cfg = getTtsConfig();
    /*
     * 音色表按来源分流：插件来源取插件**声明的** voices（静态数据，不碰厂商、不探活），
     * 面板只做映射——和 formats 同一个原则。?provider= 显式指定（面板切来源时用），
     * 不传则跟随当前配置的来源。
     */
    const providerId =
      String(c.req.query("provider") ?? "").trim() ||
      String(cfg.provider ?? "").trim() ||
      BUILTIN_TTS_PROVIDER_ID;
    const plugin = providerId !== BUILTIN_TTS_PROVIDER_ID ? await getTtsProvider(providerId).catch(() => undefined) : undefined;
    if (plugin) {
      if (typeof plugin.mod.voices !== "function") {
        return c.json({ error: `插件 provider「${providerId}」没有声明音色列表（voices）` }, 400);
      }
      /*
       * voices 契约允许 async（插件在 voices 里 fetch 厂商接口很常见）——
       * 没有护栏的话它挂死，挂死的是整个 /api/tts/speakers。check 15s、synthesize 60s
       * 都有兜底，voices 也得有；抛错带上插件名，报错才有归属。
       */
      let raceTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const voices = await Promise.race([
          Promise.resolve(plugin.mod.voices(cfg.providers?.[providerId] ?? {})),
          new Promise<never>((_, rej) => {
            raceTimer = setTimeout(() => rej(new Error(`voices 超过 15 秒没有返回（插件「${plugin.pluginId}」）`)), 15_000);
          }),
        ]);
        return c.json({
          speakers: Object.fromEntries((voices ?? []).map((v) => [v.id, v.label ?? v.language ?? ""])),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ error: `读取插件「${plugin.pluginId}」的音色列表失败：${msg}` }, 400);
      } finally {
        if (raceTimer) clearTimeout(raceTimer);
      }
    }
    const openai = /\/v1\/audio\/speech\/?$/.test(cfg.endpoint);
    const base = cfg.endpoint
      .replace(/\/v1\/audio\/speech\/?$/, "")
      .replace(/\/tts\/?$/, "")
      .replace(/\/$/, "");
    if (!base) return c.json({ error: "还没配置语音服务地址" }, 400);
    const res = await fetch(`${base}${openai ? "/v1/audio/voices" : "/speakers"}`, {
      headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return c.json({ error: `音色接口返回 ${res.status}` }, 400);
    const data = (await res.json()) as { voices?: string[]; speakers?: Record<string, string> };
    // OpenAI/vLLM 返回 { voices: ["vivian", ...] }；旧服务返回 { speakers: { name: desc } }
    if (Array.isArray(data.voices)) {
      return c.json({ speakers: Object.fromEntries(data.voices.map((v) => [v, ""])) });
    }
    return c.json(data);
  } catch (err) {
    return fail(c, err);
  }
});

/** 测试连接：合成一句固定短文本 */
app.post("/api/tts/test", async (c) => {
  try {
    return c.json({ ok: true, ...(await synthesize("这是一句测试语音。")) });
  } catch (err) {
    return fail(c, err);
  }
});

/**
 * 语音服务预检：两段式。
 * ① 连通性（HEAD 源站）——快，能把「服务没启动」和「配置写错」区分开；
 * ② deep=true 时再真合成一句极短文本，验证 key/model/voice/format 全对。
 * 预检产物是垃圾文件，合成完立刻删。
 *
 * 注意①只对**内置** provider 有意义：endpoint 是内置实现的字段，插件 provider 自己
 * 直连厂商（可能根本没有 endpoint）。以前这里不分情况一律拿 endpoint 探测，插件
 * provider 明明可用、只要本地那个服务没起，预检就报「连不上」——然后人跑去查本机端口。
 */
/** 插件自检（check）的超时：探测要便宜，给不到合成那么长的预算 */
const PLUGIN_CHECK_TIMEOUT_MS = 15_000;

app.post("/api/tts/check", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { deep?: boolean };
  const cfg = getTtsConfig();
  const providerId = String(cfg.provider ?? "").trim() || BUILTIN_TTS_PROVIDER_ID;
  const byPlugin = providerId !== BUILTIN_TTS_PROVIDER_ID;

  if (!byPlugin && !cfg.endpoint) {
    return c.json({ ok: false, stage: "config", error: "还没配置语音服务地址（工具 set_tts_config 或编辑器「语音」→ 配置）" }, 400);
  }

  // 只有内置 provider 才有这两项；插件 provider 直连厂商，宿主不知道也不该假装知道
  let origin = "";
  let reachMs = 0;

  if (byPlugin) {
    /*
     * 插件 provider 的浅层探测：插件自己提供了 check 方法就直接跑它——
     * 这回答的才是 agent 真正要的"现在能不能用"（key 有效/余额够），
     * 而不是"用的哪家"。check 是插件声明的廉价探测（如 2 字最小合成），
     * 同样套超时兜底；没提供 check 的才退回"只报名字 + 建议 deep"。
     */
    const provider = await getTtsProvider(providerId).catch(() => undefined);
    if (provider?.mod.check) {
      const t0 = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PLUGIN_CHECK_TIMEOUT_MS);
      try {
        const r = await Promise.race([
          Promise.resolve(
            provider.mod.check({ config: cfg.providers?.[providerId] ?? {}, signal: ctrl.signal }),
          ),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error(`插件自检超过 ${PLUGIN_CHECK_TIMEOUT_MS / 1000} 秒没返回`)), PLUGIN_CHECK_TIMEOUT_MS + 3_000),
          ),
        ]);
        const out = (r ?? {}) as { ok?: boolean; detail?: string; error?: string };
        if (out.ok === false) {
          return c.json(
            { ok: false, stage: "check", provider: providerId, ms: Date.now() - t0, error: out.error ?? "插件自检未通过" },
            400,
          );
        }
        return c.json({
          ok: true,
          stage: "provider",
          provider: providerId,
          ms: Date.now() - t0,
          detail: `插件自检通过${out.detail ? `：${out.detail}` : ""}`,
        });
      } catch (err) {
        return c.json(
          { ok: false, stage: "check", provider: providerId, ms: Date.now() - t0, error: (err as Error).message },
          400,
        );
      } finally {
        clearTimeout(timer);
      }
    }
    if (!body?.deep) {
      return c.json({
        ok: true,
        stage: "provider",
        provider: providerId,
        detail:
          `当前用的是插件 provider「${providerId}」，它直连厂商、不走本机地址探测。` +
          `它没提供自检方法（check），要确认整条链路就加 deep=true 真合成一句（会真的调一次厂商接口）。`,
      });
    }
  } else {
    try {
      origin = new URL(cfg.endpoint).origin;
    } catch {
      return c.json({ ok: false, stage: "config", error: `语音服务地址不是合法 URL：${cfg.endpoint}` }, 400);
    }

    const t0 = Date.now();
    let reachStatus = 0;
    try {
      const res = await fetch(origin, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(3000) });
      reachStatus = res.status;
    } catch (err: any) {
      const code = err?.cause?.code ?? err?.code ?? "";
      const why =
        err?.name === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT"
          ? "3 秒无响应"
          : code === "ECONNREFUSED"
            ? "连接被拒绝（端口没在监听）"
            : code === "ENOTFOUND"
              ? "域名解析失败"
              : (err?.message ?? "连接失败");
      return c.json({ ok: false, stage: "reach", origin, ms: Date.now() - t0, error: `${origin} 连不上：${why}` }, 400);
    }
    reachMs = Date.now() - t0;

    if (!body?.deep) {
      return c.json({
        ok: true,
        stage: "reach",
        origin,
        reachMs,
        status: reachStatus,
        detail: `服务可达（HEAD ${reachStatus}）。这只证明「有东西在监听」，配置是否正确要加 deep=true 才知道`,
      });
    }
  }

  const t1 = Date.now();
  try {
    const r = await synthesize("嗯。");
    // 预检不该在素材目录留垃圾
    try {
      fs.rmSync(path.join(PUBLIC_DIR, r.url.replace(/^\/+/, "")), { force: true });
    } catch {
      /* 删不掉也不影响结论 */
    }
    return c.json({
      ok: true,
      stage: "deep",
      provider: providerId,
      origin,
      reachMs,
      synthMs: Date.now() - t1,
      bytes: r.bytes,
      format: r.format,
      voice: cfg.voice,
      model: cfg.model,
    });
  } catch (err) {
    return c.json(
      { ok: false, stage: "synth", provider: providerId, origin, reachMs, ms: Date.now() - t1, error: (err as Error).message },
      400,
    );
  }
});

/**
 * 音频分析（BPM / 拍点）。放在常驻服务里算：
 * essentia 的 WASM 只加载这一次，stdio 代理保持轻量；结果也缓存在服务侧。
 */
app.post("/api/audio/analyze", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      src?: string;
      maxSeconds?: number;
      fps?: number;
      force?: boolean;
    };
    if (!body?.src) return c.json({ error: "需要 src（/assets/xxx.mp3 或 wav）" }, 400);
    const result = await analyzeBeats(body.src, {
      maxSeconds: body.maxSeconds,
      fps: body.fps,
      force: body.force,
    });
    return c.json({ result });
  } catch (err) {
    return fail(c, err);
  }
});

/** 响度测量（配平/压缩的依据）：LUFS、峰值、短时曲线 */
app.post("/api/audio/loudness", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { src?: string; force?: boolean };
    if (!body?.src) return c.json({ error: "需要 src（/assets/xxx.mp3 或 wav）" }, 400);
    const result = await measureLoudness(body.src, { force: body.force });
    return c.json({ result });
  } catch (err) {
    return fail(c, err);
  }
});

/**
 * 生成压缩增益曲线（编辑器按钮与 MCP 的 compress_audio 共用这一个实现）。
 * 曲线算法是纯函数，但**测响度要读文件**，所以必须走服务端，浏览器端不重复实现一份。
 */
app.post("/api/audio/compress", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      src?: string;
      targetLufs?: number;
      ratio?: number;
      maxGainDb?: number;
      maxCutDb?: number;
      force?: boolean;
    };
    if (!body?.src) return c.json({ error: "需要 src（/assets/xxx.mp3 或 wav）" }, 400);
    const info = await measureLoudness(body.src, { force: body.force });
    const built = buildCompressCurve(info.curve, {
      targetLufs: body.targetLufs ?? -23,
      ratio: body.ratio ?? 3,
      maxGainDb: body.maxGainDb,
      maxCutDb: body.maxCutDb,
      maxGain: MAX_VOLUME,
      // 逐点峰值限幅：不管它，响段被抬到 >0dBFS 也不会有人知道
      peakDbCurve: info.peakCurve,
    });
    const values = built.values;
    return c.json({
      result: {
        curve: {
          stepMs: info.stepMs,
          values,
          targetLufs: body.targetLufs ?? -23,
          ratio: body.ratio ?? 3,
        },
        measured: { lufs: info.lufs, peakDb: info.peakDb, rmsDb: info.rmsDb },
        stats: {
          ...summarizeCurve(values),
          peakLimited: built.peakLimited,
          cutLimited: built.cutLimited,
          gainLimited: built.gainLimited,
        },
      },
    });
  } catch (err) {
    return fail(c, err);
  }
});

/* ───────────── MCP over HTTP（Streamable HTTP 简化实现） ───────────── */
// 工具清单是静态的，启动时转一次 JSON Schema 即可。
// 门面模式：tools/list 只返回核心入口（其余经 tool_search/tool_call），MCP_EXPOSE=all 恢复全量
const mcpToolList = TOOLS.filter((def) => exposeAllTools() || CORE_TOOL_NAMES.has(def.name)).map((def) => {
  const schema = zodToJsonSchema(z.object(def.shape), {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  delete (schema as { $schema?: unknown }).$schema;
  return { name: def.name, description: def.description, inputSchema: schema };
});

async function handleMcpMessage(msg: any): Promise<any | null> {
  const { id, method, params } = msg ?? {};
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const error = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "remotion-studio", version: VERSION },
      });
    case "notifications/initialized":
    case "notifications/cancelled":
    case "notifications/progress":
      return null;
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: mcpToolList });
    case "tools/call": {
      const name = params?.name;
      const def = TOOLS.find((t) => t.name === name);
      if (!def) return error(-32602, `未知工具: ${name}`);
      /**
       * 日志里记**真实工具名**：门面模式下所有调用都走 tool_call，
       * 只记 "tool_call" 的话统计出来全是同一个名字，等于没记。
       */
      const inner = name === "tool_call" ? String(params?.arguments?.name ?? "") : "";
      const logAs = inner || name;
      const startedAt = performance.now();
      try {
        const args = validateToolArgs(def, params?.arguments ?? {});
        const out = await def.run(args as never);
        logToolCall({ tool: logAs, args: inner ? params?.arguments?.args : args, startedAt, ok: true });
        return reply({
          content: [{ type: "text", text: String(out) }],
          isError: false,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logToolCall({ tool: logAs, args: params?.arguments, startedAt, ok: false, error: err });
        return reply({
          content: [{ type: "text", text: `失败：${message}` }],
          isError: true,
        });
      }
    }
    default:
      return error(-32601, `未知方法: ${method}`);
  }
}

app.post("/mcp", async (c) => {
  try {
    const body = (await c.req.json()) as any;
    const batch = Array.isArray(body) ? body : [body];
    const responses: any[] = [];
    for (const msg of batch) {
      const res = await handleMcpMessage(msg);
      if (res) responses.push(res);
    }
    // 只回本机来源：以前是 `*`，等于允许任意网页跨站调用 tool_call 改工程
    const origin = corsAllowOrigin(c.req.header("origin"));
    if (origin) c.header("Access-Control-Allow-Origin", origin);
    if (!responses.length) return c.body(null, 202);
    return c.json(Array.isArray(body) ? responses : responses[0]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message } },
      400,
    );
  }
});

// 不提供 server→client 的 SSE 推送流；GET 明确拒绝，避免客户端挂起
app.get("/mcp", (c) => c.body(null, 405));
app.options("/mcp", (c) => {
  const origin = corsAllowOrigin(c.req.header("origin"));
  if (origin) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
  }
  c.header("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id");
  return c.body(null, 204);
});

/* ───────────── 编辑页 ↔ agent 桥接（留言板） ───────────── */

app.get("/api/agent/messages", (c) => c.json({ messages: listMessages() }));

app.post("/api/agent/messages", async (c) => {
  try {
    const body = (await c.req.json()) as { text?: string };
    const msg = addMessage("user", String(body.text ?? ""));
    return c.json({ ok: true, message: msg });
  } catch (err) {
    return fail(c, err);
  }
});

app.post("/api/agent/reply", async (c) => {
  try {
    const body = (await c.req.json()) as { text?: string };
    const msg = addMessage("agent", String(body.text ?? ""));
    return c.json({ ok: true, message: msg });
  } catch (err) {
    return fail(c, err);
  }
});

app.post("/api/agent/read", (c) => c.json({ ok: true, read: markUserMessagesRead() }));

/* ───────────── 时间码批注（编辑器逐帧留言 → agent 用 get_annotations 读） ───────────── */

app.get("/api/projects/:id/annotations", (c) => {
  try {
    return c.json({ annotations: listAnnotations(c.req.param("id")) });
  } catch (err) {
    return fail(c, err);
  }
});

app.post("/api/projects/:id/annotations", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      sceneId?: string;
      frameInScene?: number;
      text?: string;
      frameAtCreate?: number;
    };
    const item = addAnnotation(c.req.param("id"), {
      sceneId: String(body.sceneId ?? ""),
      frameInScene: Number(body.frameInScene ?? 0),
      text: String(body.text ?? ""),
      actor: "user",
      frameAtCreate: Number(body.frameAtCreate ?? 0),
    });
    return c.json({ ok: true, annotation: item });
  } catch (err) {
    return fail(c, err);
  }
});

app.post("/api/projects/:id/annotations/resolve", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { ids?: string[]; resolved?: boolean };
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    if (!ids.length) return c.json({ error: "缺少 ids" }, 400);
    return c.json({ ok: true, ...resolveAnnotations(c.req.param("id"), ids, body.resolved !== false) });
  } catch (err) {
    return fail(c, err);
  }
});

app.delete("/api/projects/:id/annotations/:aid", (c) => {
  try {
    const ok = deleteAnnotation(c.req.param("id"), c.req.param("aid"));
    return ok ? c.json({ ok: true }) : c.json({ error: "没有这条批注" }, 404);
  } catch (err) {
    return fail(c, err);
  }
});

/* ───────────── 运行日志（编辑器抽屉；agent 侧对应 tool_stats） ───────────── */

app.get("/api/tool-log", (c) => {
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 150) || 150));
  const days = Math.min(7, Math.max(1, Number(c.req.query("days") ?? 1) || 1));
  const all = readToolCalls(days);
  return c.json({
    calls: all.slice(-limit).reverse(),
    total: all.length,
    stats: toolStats(days),
  });
});

app.post("/api/projects", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    const seed = createSeedProject();
    if (body.name) seed.name = body.name;
    writeProject(seed);
    return c.json({ project: projects.get(seed.id) });
  } catch (err) {
    return fail(c, err);
  }
});

/* ────────────────────────────── 模板市场 ────────────────────────────── */

/** 内置模板 + 用户自定义模板，统一成同一种卡片形态（kind 区分来源） */
app.get("/api/templates", (c) =>
  c.json({
    templates: [
      ...templateList().map((t) => ({ ...t, kind: "builtin" as const })),
      ...templates.cards(),
    ],
  }),
);

/** 把当前工程存成「我的模板」（场景 / 主题 / 画幅 / 音频 + 引用到的素材一起打包） */
app.post("/api/templates", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      projectId?: string;
      name?: string;
      description?: string;
      tags?: string[];
    };
    if (!body.projectId) return c.json({ error: "缺少 projectId" }, 400);
    const tpl = templates.save(body.projectId, body.name ?? "", body.description ?? "");
    return c.json({
      template: templates.cards().find((t) => t.key === tpl.id) ?? null,
      templates: templates.cards(),
    });
  } catch (err) {
    return fail(c, err);
  }
});

app.delete("/api/templates/:id", (c) => {
  try {
    templates.remove(c.req.param("id"));
    return c.json({ ok: true });
  } catch (err) {
    return fail(c, err);
  }
});

/** 重命名模板：只改名字，不动内容 */
app.patch("/api/templates/:id", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    const tpl = templates.rename(c.req.param("id"), String(body.name ?? ""));
    return c.json({ template: templates.cards().find((t) => t.key === tpl.id) ?? null, templates: templates.cards() });
  } catch (err) {
    return fail(c, err);
  }
});

app.post("/api/projects/from-template", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      templateKey?: string;
      templateId?: string;
      name?: string;
    };
    // templateId 走自定义模板（整份工程快照），否则走内置模板（场景清单）
    const project: Project = body.templateId
      ? templates.instantiate(body.templateId, body.name)
      : buildFromTemplate(body.templateKey ?? "blank", body.name);
    writeProject(project);
    return c.json({ project: projects.get(project.id) });
  } catch (err) {
    return fail(c, err);
  }
});

app.get("/api/projects/:id", (c) => {
  try {
    const id = c.req.param("id");
    const project = projects.get(id);
    // 打开即记住：重启后编辑器优先回到这里
    projects.touch(id);
    return c.json({ project });
  } catch {
    return c.json({ error: "工程不存在" }, 404);
  }
});

/** 最近打开 / 被 agent 编辑过的工程 id（没有就返回 null，前端退回列表第一个） */
app.get("/api/last-project", (c) => c.json({ id: readLastProjectId() }));

/**
 * UI 偏好：面板宽度、折叠状态、时间轴高度、选框/安全区开关。
 * 存服务端是为了换浏览器、换端口、清缓存之后布局还在。
 */
app.get("/api/ui-prefs", (c) => c.json(readUiPrefs()));

app.put("/api/ui-prefs", async (c) => {
  const body = (await c.req.json().catch(() => null)) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "需要一个字符串键值对象" }, 400);
  }
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    // 只收 rms:* 的字符串值，单条限长，挡住脏数据和误写
    if (!key.startsWith("rms:") || typeof value !== "string" || value.length > 4096) continue;
    clean[key] = value;
  }
  writeUiPrefs(clean);
  return c.json({ ok: true, count: Object.keys(clean).length });
});

/* ───────────── 本地资源库（详见 resources.service.ts 顶部的设计说明） ───────────── */

/** 本机连接的判定收敛在 security.isLoopbackAddress（纯函数、可单测） */

/**
 * 资源库管理面（能枚举磁盘、能改根目录配置）只认**连接来源**，不认 Host 头。
 *
 * Host 是客户端随手可伪造的（`curl -H 'Host: localhost'`）；而 LAN 模式下全局闸
 * 会跳过 Host/Origin 校验（用户显式选了对外），只靠 Host 等于没挡 —— 同网段设备
 * 能把资源根目录改成任意路径，再借 /resources/ 流出（带 ACAO:*）读走文件。
 * socket 的来源地址伪造不了。拿不到 conninfo（非标准适配器/单测）时才退回 Host 名兜底。
 */
const isLocalRequest = (c: Context): boolean => {
  try {
    const addr = getConnInfo(c).remote.address ?? "";
    if (addr) return isLoopbackAddress(addr);
  } catch {
    // 适配器不提供 conninfo，走下面的兜底
  }
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostnameOf(c.req.header("host") ?? ""));
};

/** 管理面统一回执：LAN 那头访问时给一句能看懂的话，别只丢 403 */
const localOnly = (c: Context, what: string): Response | null => {
  if (isLocalRequest(c)) return null;
  return c.json({ error: `${what}只允许在本机操作（LAN 模式下请回到装服务的那台机器上配）` }, 403);
};

app.get("/api/resources/config", (c) => {
  const blocked = localOnly(c, "读取资源库配置");
  if (blocked) return blocked;
  const dirs = readResourceDirs();
  return c.json({
    origin: `http://127.0.0.1:${PORT}`,
    categories: RESOURCE_CATEGORIES.map((cat) => ({
      id: cat.id,
      label: cat.label,
      exts: cat.exts,
      dir: dirs[cat.id] ?? null,
    })),
  });
});

app.put("/api/resources/config", async (c) => {
  const blocked = localOnly(c, "修改资源库配置");
  if (blocked) return blocked;
  const body = (await c.req.json().catch(() => null)) as { category?: string; dir?: string | null } | null;
  if (!body?.category) return c.json({ error: "需要 category" }, 400);
  // dir 为空/null = 清除该类的目录配置（配错了或不想用了）
  if (body.dir == null || body.dir === "") {
    try {
      clearResourceDir(body.category);
      return c.json({ ok: true, category: body.category, dir: null });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  }
  try {
    const dir = setResourceDir(body.category, body.dir);
    return c.json({ ok: true, category: body.category, dir });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.post("/api/resources/browse", async (c) => {
  const blocked = localOnly(c, "资源浏览");
  if (blocked) return blocked;
  const body = (await c.req.json().catch(() => ({}))) as { category?: string; sub?: string };
  if (!body.category) return c.json({ error: "需要 category" }, 400);
  try {
    return c.json(browseCategory(body.category, body.sub ?? ""));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

/** 目录选择器：从盘符逐级往下走，给「浏览…」按钮用。能枚举磁盘 → 只对本机开放 */
app.post("/api/resources/pick", async (c) => {
  const blocked = localOnly(c, "目录选择");
  if (blocked) return blocked;
  const body = (await c.req.json().catch(() => ({}))) as { path?: string };
  try {
    return c.json(pickDir(body.path ?? ""));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.post("/api/resources/search", async (c) => {
  const blocked = localOnly(c, "资源搜索");
  if (blocked) return blocked;
  const body = (await c.req.json().catch(() => ({}))) as {
    category?: string;
    keyword?: string;
    ext?: string[];
    limit?: number;
  };
  if (!body.category) return c.json({ error: "需要 category" }, 400);
  try {
    return c.json(
      searchCategory(body.category, { keyword: body.keyword, ext: body.ext, limit: body.limit }),
    );
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

/** M1 直接流出原图当缩略图（编解码依赖太重，真缩略图是 M2）；p 是站内 /resources/… 引用 */
app.get("/api/resources/thumb", (c) => {
  const blocked = localOnly(c, "缩略图");
  if (blocked) return blocked;
  const raw = c.req.query("p") ?? "";
  let p: string;
  try {
    p = decodeURIComponent(raw);
  } catch {
    p = raw;
  }
  const m = /^\/resources\/([a-z]+)\/(.+)$/.exec(p.replace(/^https?:\/\/[^/]+/, ""));
  if (!m) return c.json({ error: "p 要是 /resources/<类>/<路径> 形式" }, 400);
  // 引用 URL 的路径段是 encodeURIComponent 过的（中文/空格/#），这里按段解回来，
  // 和 /resources/:category/* 流出路由的处理保持一致，否则带中文的路径会 404
  const rel = m[2]
    .split("/")
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join("/");
  return serveResourceFile(c, m[1], rel);
});

// 文件流出：编辑器预览（同源）和渲染（按 URL 拉取）都走这里。
// 有意不做 loopback 限制——LAN 模式下别的机器的编辑器页面也要能显示素材；
// 但拉文件必须知道精确路径，且**管理面（config/browse/search/pick/thumb）按连接来源
// 限本机**，同网段设备改不了根目录、也枚举不了目录，所以拿不到"精确路径"。
app.get("/resources/:category/*", (c) => {
  const catId = c.req.param("category");
  const rel = c.req.path
    .replace(/^\/resources\/[a-z]+\/?/, "")
    .split("/")
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join("/");
  return serveResourceFile(c, catId, rel);
});

/**
 * 风格库（341 条外部风格提示词）——编辑器「风格库」面板的数据面。
 *
 * 和 `list_styles` / `apply_style` 那 43 个内置风格**是两套东西**：
 * 这里是「画风文字描述 + 一张静帧」，只能当视觉参考；内置风格才有 palette/font 预设。
 * 面板因此分两个分区显示，接口也分两个字段返回，别合并。
 *
 * 静帧走 `/api/style-library/still/:id` 而不是 `/assets/`：库在 `server/skills/` 下，
 * 不在 public 里，也不该被复制进 public（341 张图会跟着 bundle 打包）。
 */
app.get("/api/style-library", (c) => {
  const q = c.req.query();
  const use = q.use as StyleUse | "all" | undefined;
  const mood = q.mood as StyleMood | "all" | undefined;
  const { items, total, withStill } = listLibrary({
    q: q.q,
    use,
    mood,
    withStill: q.withStill === "1" || q.withStill === "true",
  });
  return c.json({
    items,
    total,
    withStill,
    empty: isLibraryEmpty(),
    uses: STYLE_USES,
    moods: STYLE_MOODS,
    builtin: listBuiltinStyles(),
    picks: readPicks(),
  });
});

app.post("/api/style-library/rebuild", (c) => {
  const blocked = localOnly(c, "重建风格库索引");
  if (blocked) return blocked;
  const idx = buildIndex(true);
  return c.json({ ok: true, total: idx.total, withStill: idx.withStill, builtAt: idx.builtAt });
});

/** 单条提示词全文：面板抽屉里显示，也是「复制给 agent」的来源 */
app.get("/api/style-library/prompt/:id", (c) => {
  const id = c.req.param("id");
  const prompt = readPrompt(id);
  if (prompt === null) return c.json({ error: `库里没有「${id}」这一条` }, 404);
  return c.json({ id, prompt });
});

/** 顺带把 webp 流出去。缓存 7 天：库更新靠 rebuild，不靠浏览器过期 */
function serveWebp(c: Context, abs: string): Response {
  try {
    const stat = fs.statSync(abs);
    const etag = `W/"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;
    if (c.req.header("if-none-match") === etag) return c.body(null, 304);
    return c.body(new Uint8Array(fs.readFileSync(abs)), 200, {
      "content-type": "image/webp",
      "cache-control": "public, max-age=604800",
      etag,
    });
  } catch {
    return c.json({ error: "读不到静帧文件" }, 404);
  }
}

app.get("/api/style-library/still/:id", (c) => {
  const abs = stillAbsOf(c.req.param("id"));
  if (!abs) return c.json({ error: "这一条没有静帧" }, 404);
  return serveWebp(c, abs);
});

/** 内置 43 风格的静帧：约定放在 server/styles/stills/<slug>.webp，没有就 404 由前端画占位 */
app.get("/api/style-library/builtin-still/:slug", (c) => {
  const abs = builtinStillAbsOf(c.req.param("slug"));
  if (!abs) return c.json({ error: "这个内置风格还没有样张" }, 404);
  return serveWebp(c, abs);
});

/** 内置风格的规则正文 + 结构化预设：面板右抽屉里给用户看「这风格到底是什么」 */
app.get("/api/style-library/builtin/:slug", (c) => {
  const detail = readBuiltinStyle(c.req.param("slug"));
  if (!detail) return c.json({ error: "没有这个内置风格" }, 404);
  return c.json(detail);
});

app.get("/api/style-library/picks", (c) => c.json({ picks: readPicks() }));

/**
 * 勾选写盘 + 顺手给 agent 留一条言。
 *
 * 为什么要留言而不是只落盘：agent 只在"被调用"时才知道发生了什么。用户点完「告诉 agent」
 * 就切回对话窗口，如果只写了 picks.json，agent 不会主动去读——它会等用户打字。
 * 两个通道一起走，用户就不用再把选好的编号手打一遍。
 */
app.post("/api/style-library/picks", async (c) => {
  const blocked = localOnly(c, "保存风格勾选");
  if (blocked) return blocked;
  const body = (await c.req.json().catch(() => ({}))) as {
    ids?: unknown;
    builtinSlugs?: unknown;
    note?: unknown;
    projectId?: unknown;
    notify?: unknown;
  };
  const ids = Array.isArray(body.ids) ? body.ids.map((x) => String(x)) : [];
  const builtinSlugs = Array.isArray(body.builtinSlugs) ? body.builtinSlugs.map((x) => String(x)) : [];
  const note = typeof body.note === "string" ? body.note : undefined;
  const projectId = typeof body.projectId === "string" ? body.projectId : undefined;
  const { picks, dropped } = writePicks({ ids, builtinSlugs, note, projectId });

  let notified = false;
  const pickedSlugs = picks.builtinSlugs ?? [];
  if (body.notify && (picks.ids.length || pickedSlugs.length)) {
    // 留言分两段：内置和参考对 agent 是两种动作，混成一句话它就会拿画风描述去 apply_style
    const lib = listLibrary().items;
    const refNames = picks.ids.map((id) => {
      const it = lib.find((x) => x.id === id);
      return it ? `${it.id} ${it.name}` : id;
    });
    const all = listBuiltinStyles();
    const builtinNames = pickedSlugs.map((slug) => {
      const b = all.find((x) => x.slug === slug);
      return b ? `${slug}（${b.name}）` : slug;
    });
    const parts: string[] = [];
    if (builtinNames.length) parts.push(`内置我选了 ${builtinNames.join("、")}，这些直接套`);
    if (refNames.length) parts.push(`参考我选了 ${refNames.join("、")}，这些给我出参考图`);
    addMessage(
      "user",
      `风格我选好了：${parts.join("；")}。${note ? `（备注：${note}）` : ""}我看过图再往下做。`,
    );
    notified = true;
  }
  return c.json({ picks, dropped, notified });
});

/** 人工改气质/用途：面板里点一下就存，只存 diff（没有 diff 就删掉那条） */
app.post("/api/style-library/override", async (c) => {
  const blocked = localOnly(c, "修改风格标注");
  if (blocked) return blocked;
  const body = (await c.req.json().catch(() => ({}))) as { id?: unknown; moods?: unknown; use?: unknown };
  const id = String(body.id ?? "");
  if (!id) return c.json({ error: "缺少 id" }, 400);
  const moods = Array.isArray(body.moods)
    ? (body.moods.filter((m) => (STYLE_MOODS as readonly string[]).includes(String(m))) as StyleMood[])
    : undefined;
  const use = STYLE_USES.some((u) => u.id === body.use) ? (body.use as StyleUse) : undefined;
  writeOverride(id, { moods, use });
  return c.json({ ok: true });
});

/**
 * 归档 / 取消归档工程。
 *
 * 归档 = 从默认列表里收起来，**不删任何文件**：仍能打开、渲染、导出，
 * 只是不再挤占 list_projects 和切换面板（测试工程最容易堆成这种噪音）。
 * 挂在独立文件 data/archive.json 上，不写 project.json —— 归档不该改 rev、进历史。
 */
app.post("/api/projects/:id/archive", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { archived?: unknown; note?: unknown };
  const on = body.archived === undefined ? true : Boolean(body.archived);
  const note = typeof body.note === "string" ? body.note : undefined;
  try {
    const { archivedAt } = projects.archive(id, on, note);
    return c.json({ ok: true, id, archived: Boolean(archivedAt), archivedAt });
  } catch (err) {
    return fail(c, err);
  }
});

/** 删除工程 */
app.delete("/api/projects/:id", (c) => {
  const id = c.req.param("id");
  // 示例工程只允许重置，不允许删除（否则删掉就再也回不来了）
  if (id === "demo" || isDemo3D(id)) {
    return c.json({ error: `${id} 是示例工程，不能删除，只能用「重置」恢复` }, 400);
  }
  try {
    projects.remove(id);
    // 工程数据删掉之后再清它的素材目录（此时它已不在引用集合里，剩下的都是别人还在用的）
    const assets = removeProjectAssets(id);
    // 产物目录整块删：成片/关键帧/字幕只属于这个工程，没有"别人还在用"的情况
    const renders = removeProjectOutputs(id);
    return c.json({ ok: true, assets, renders });
  } catch (err) {
    return fail(c, err);
  }
});

/** 重置示例工程（恢复成 seed 内容） */
app.post("/api/projects/demo/reset", (c) => {
  try {
    const seed = createSeedProject("demo");
    const project = projects.replace(seed);
    return c.json({ project });
  } catch (err) {
    return fail(c, err);
  }
});

/**
 * 重置 3D 示例。素材也要一起铺回去：只恢复 project.json 的话，
 * 用户删掉 public/assets 里的贴图后重置出来还是一堆黑球。
 */
app.post("/api/projects/demo3d/reset", (c) => {
  try {
    if (!hasDemo3DSeed()) {
      return c.json({ error: "3D 示例的种子素材缺失（scripts/seeds/demo3d）" }, 400);
    }
    const project = projects.replace(installDemo3D());
    return c.json({ project });
  } catch (err) {
    return fail(c, err);
  }
});

/* ────────────────────────────── 工作空间 ────────────────────────────── */

/** 当前工作空间：三块目录的真实位置、占用、两边磁盘剩余 */
app.get("/api/workspace", (c) => {
  try {
    return c.json(getWorkspaceStatus());
  } catch (err) {
    return fail(c, err);
  }
});

/** 目录浏览（只读）：给「浏览…」按钮一层层点着选路径，不用系统原生对话框 */
app.get("/api/fs/dirs", (c) => {
  try {
    return c.json(listDirs(c.req.query("path")));
  } catch (err) {
    return fail(c, err);
  }
});

/**
 * 迁移 data/public/out 到指定目录。
 * dryRun=true 只出方案（搬多少、够不够空间），**界面上先看方案再动手**。
 */
app.post("/api/workspace/relocate", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { dir?: string; dryRun?: boolean };
    return c.json(relocateWorkspace(String(body.dir ?? ""), { dryRun: !!body.dryRun }));
  } catch (err) {
    return fail(c, err);
  }
});

/** 搬回工程目录（去掉链接） */
app.post("/api/workspace/reset", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { dryRun?: boolean };
    return c.json(resetWorkspace({ dryRun: !!body.dryRun }));
  } catch (err) {
    return fail(c, err);
  }
});

/* ─────────────────────────── 插件管理 ───────────────────────────
 *
 * 为什么插件要有 HTTP 接口，而不是"自己把文件夹拷进 plugins/"：
 * 一个真实插件是「clone → npm install → npm run build」三步，把这三步留给用户，
 * 等于把装插件变成开发者专属操作。这里收敛成一个动作，前端只负责显示进度。
 *
 * 唯一的红线：**只有显式点「安装 / 重建」才会起子进程**。扫描目录时永远不执行任何东西。
 */

/** 插件清单（编辑器插件面板用）：在 scanPlugins 的结果上补"为什么不能跑" */
app.get("/api/plugins", async (c) => {
  try {
    /*
     * 面板要说的是"**它真的做了什么**"，不是"它的清单声称做什么"。
     *
     * 这六个示例插件里有一半只有 `plugin.ts.example` 模板（还没改名成 plugin.ts），
     * 清单里却写着 provides:["hooks"]。只读清单的话，界面上它们和真生效的插件长得一模一样——
     * 用户会以为已经生效，出了问题时永远查不到"其实一个钩子都没注册"。
     * 所以这里等一次钩子加载（幂等且便宜），把**实际注册到的钩子**一并返回。
     */
    await ensurePluginHooks().catch(() => {
      /* 加载失败会体现在 hookStatus().errors 里，不影响列表本身 */
    });
    /*
     * 钩子不是代码插件唯一的生效渠道：工具（tool_search/tool_call）与语音 provider
     * 走各自的注册表。面板要判断"它到底生效没有"就得拿到**全部渠道的实际状态**——
     * 否则一个只导出 ttsProviders 的插件会被误判成"未生效"。
     * 两个 ensure 都幂等且便宜（指纹没变只是 stat）。
     */
    await ensurePluginTools().catch(() => {});
    await ensureTtsProviders().catch(() => {});
    const ttsByPlugin = new Set((await ttsProviderCatalog().catch(() => ({ providers: [] as { pluginId: string }[] }))).providers.map((x) => x.pluginId));
    const plugins = scanPlugins().map((p) => {
      const entry = resolvePluginEntry(p.dir);
      const pkg = readPackageJson(p.dir);
      const depCount =
        Object.keys(pkg?.dependencies ?? {}).length + Object.keys(pkg?.devDependencies ?? {}).length;
      return {
        ...p,
        entry,
        hasPackage: !!pkg,
        /*
         * 只有「声明了代码入口但产物不在」才算"未构建"。
         * 纯内容插件（只有 skills/styles，没有 package.json）也会返回 unbuilt ——
         * 那是正常形态，不是错误，界面上不能给它挂个⚠。
         */
        needsBuild: entry.kind === "unbuilt" && !!pkg && declaresCodeEntry(pkg),
        buildScript: typeof pkg?.scripts?.build === "string" ? pkg.scripts.build : null,
        depCount,
        // 有依赖或 build 脚本才值得提供"重建"按钮
        canRepair: !!pkg?.scripts?.build || depCount > 0,
        /** 实际注册到的钩子（不是清单声明的） */
        hooks: hookKindsOf(p.id),
        /** 实际注册到的插件工具名（tool_search 能搜到的；没有就空数组） */
        tools: pluginToolNamesOf(p.id),
        /** 是否注册了语音 provider（tts_synthesize / tts_narration 走它） */
        tts: ttsByPlugin.has(p.id),
        /**
         * 目录里只有 `plugin.ts.example` 这种模板 —— 示例插件的"未启用"形态，
         * 不是错误，但必须让用户看见"它现在什么都没干"。
         */
        templateOnly: hasExampleEntry(p.dir),
        /**
         * 有没有自带界面（`plugins/<名>/ui/index.html`）。
         *
         * 每次都扫一遍而不是缓存：装完插件刷新面板就要看得见，
         * 而一次 existsSync 的代价可以忽略。
         */
        hasUi: fs.existsSync(path.join(p.dir, "ui", "index.html")),
      };
    });
    return c.json({ plugins, roots: pluginRoots(), trashDir: PLUGIN_TRASH_DIR, orphans: scanOrphanDirs() });
  } catch (err) {
    return fail(c, err);
  }
});

/* ─────────────────── 插件自制界面：静态服务 + 配置存储 ─────────────────── */

/**
 * `plugins/<名>/ui/` 当静态目录服务。
 *
 * ## 为什么是 iframe + 静态文件，而不是把 React 组件打进编辑器
 *
 * 编辑器吃的是预构建产物 `dist/web`，只有 `npm run build` 才更新。插件 UI 若走
 * 静态 import，用户装完插件在编辑器里**什么也看不到**，还得会跑 vite build——这对插件
 * 生态是硬伤。静态文件则由本服务直接读盘，改完刷新即生效。
 *
 * 附带好处：插件可以用任意技术栈（甚至不用框架）、自带依赖、样式互不污染、
 * 没有 React 版本冲突。
 *
 * ## 安全边界
 *
 * 只映射到该插件的 `ui` 目录，`..` 与解码后的穿越一律拒。同源 iframe 理论上能碰父窗口，
 * 但插件本来就能在服务端跑任意代码——这不是新增的攻击面，文档里写明"插件 UI 视为可信代码"。
 */
app.use("/plugin-ui/:id/*", async (c) => {
  const id = c.req.param("id");
  const plugin = scanPlugins().find((p) => p.id === id);
  if (!plugin) return c.notFound();

  const uiDir = path.resolve(plugin.dir, "ui");
  if (!fs.existsSync(uiDir)) return c.notFound();

  const prefix = `/plugin-ui/${id}`;
  let rel = c.req.path.slice(prefix.length) || "/";
  try {
    rel = decodeURIComponent(rel);
  } catch {
    return c.notFound();
  }
  if (rel.endsWith("/")) rel += "index.html";
  // 先按段判穿越再 resolve：两道都要，`%2e%2e` 解码后才现形
  if (rel.split("/").includes("..")) return c.notFound();

  const full = path.resolve(uiDir, `.${rel.startsWith("/") ? rel : `/${rel}`}`);
  if (full !== uiDir && !full.startsWith(uiDir + path.sep)) return c.notFound();

  let stat: fs.Stats;
  try {
    stat = fs.statSync(full);
  } catch {
    return c.notFound();
  }
  if (!stat.isFile()) return c.notFound();

  /*
   * 不缓存：插件作者改完页面一刷新就要看到效果。
   * 这类文件都很小，省这点带宽不值当"改了没反应"的困惑。
   */
  return c.body(fs.readFileSync(full), 200, {
    "content-type": mimeOf(full),
    "cache-control": "no-store",
  });
});

/** 读某个插件的配置（插件页面自己 fetch，宿主不代理） */
app.get("/api/plugin-config/:id", (c) => {
  const id = c.req.param("id");
  return c.json({ config: getPluginConfig(id) });
});

/** 写某个插件的配置：一层合并，返回合并后的完整配置 */
app.put("/api/plugin-config/:id", async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    const res = savePluginConfig(c.req.param("id"), body);
    if (!res.ok) return c.json({ error: res.error }, 400);
    return c.json({ config: res.config });
  } catch (err) {
    return fail(c, err);
  }
});

/**
 * 安装设置：目前只有 npm 源。
 *
 * 默认给国内镜像，因为插件安装动辄几十个包，连官方源基本等于默认失败；
 * 需要官方源或私有 registry 的，在这里改一次即可（对所有后续安装生效）。
 */
app.get("/api/plugins/settings", (c) =>
  c.json({ registry: getRegistry(), presets: REGISTRY_PRESETS, defaultRegistry: DEFAULT_REGISTRY }),
);

app.put("/api/plugins/settings", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { registry?: string };
    return c.json({ registry: setRegistry(String(body.registry ?? "")) });
  } catch (err) {
    return fail(c, err);
  }
});

/**
 * 来源预检：用户一边输入一边告诉他会装成什么。
 * 不下载、不执行，只做字符串判定 + 目录占用检查。
 */
app.get("/api/plugins/detect", (c) => {
  const source = String(c.req.query("source") ?? "");
  if (!source.trim()) return c.json({ kind: null, reason: "还没有输入" });
  const kind = detectSourceKind(source);
  if (!kind) {
    return c.json({
      kind: null,
      reason: "认不出这个来源：需要 git 地址（https://… 或 用户/仓库）、npm 包名（@scope/名字），或一个已存在的本地目录",
    });
  }
  const name = guessTargetName(kind, source);
  const dir = path.join(PROJECT_PLUGIN_DIR, name);
  return c.json({ kind, name, dir, exists: fs.existsSync(dir) });
});

/** 安装：git / npm / 本地目录 → 装依赖 → 构建 → 校验。返回 job，前端轮询进度 */
app.post("/api/plugins/install", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      source?: string;
      name?: string;
      registry?: string;
      force?: boolean;
    };
    const job = startInstall({
      source: String(body.source ?? ""),
      name: body.name || undefined,
      registry: body.registry || undefined,
      force: !!body.force,
    });
    return c.json({ job });
  } catch (err) {
    return fail(c, err);
  }
});

/** 最近的任务（含已完成）：面板重新打开时能接上正在跑的那个 */
app.get("/api/plugins/jobs", (c) => c.json({ jobs: listJobs() }));

app.get("/api/plugins/jobs/:id", (c) => {
  const job = getJob(c.req.param("id"));
  if (!job) return c.json({ error: "没有这个安装任务（服务重启过？）" }, 404);
  return c.json({ job });
});

app.post("/api/plugins/jobs/:id/cancel", (c) => {
  const ok = cancelJob(c.req.param("id"));
  return ok ? c.json({ ok }) : c.json({ error: "这个任务已经结束了，取消不了" }, 400);
});

/** 原地重建：作者更新了源码、或当初是手动拷进来还没构建 */
app.post("/api/plugins/:id/repair", (c) => {
  try {
    return c.json({ job: startRepair(c.req.param("id")) });
  } catch (err) {
    return fail(c, err);
  }
});

/** 启用 / 停用（文件不动） */
app.post("/api/plugins/:id/toggle", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: boolean };
    const id = c.req.param("id");
    const target = scanPlugins().find((p) => p.id === id);
    if (!target) return c.json({ error: `没有 id 为「${id}」的插件` }, 404);
    setPluginEnabled(id, !!body.enabled);
    // 回读确认：只回"已设置"会在 data/ 只读时给出与事实相反的答复
    const after = scanPlugins().find((p) => p.id === id);
    const actual = after?.enabled ?? false;
    if (actual !== !!body.enabled) {
      return c.json({ error: `设置没生效（期望 ${!!body.enabled}，实际 ${actual}）。检查 data/plugins.json 是否可写` }, 500);
    }
    return c.json({ ok: true, enabled: actual });
  } catch (err) {
    return fail(c, err);
  }
});

/**
 * 删除"未识别的目录"：装错了、装坏了留下的残骸。
 *
 * 必须排在 `/:id/remove` **前面**，否则 `/api/plugins/orphans/remove` 会被当成
 * id 为 "orphans" 的插件去卸载。
 */
app.post("/api/plugins/orphans/remove", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { dir?: string };
    if (!body.dir) return c.json({ error: "缺少 dir" }, 400);
    return c.json(removeOrphanDir(String(body.dir)));
  } catch (err) {
    return fail(c, err);
  }
});

/**
 * 卸载插件。默认挪到 data/.plugin-trash/（可恢复）；
 * body 带 { purge: true } 时彻底删除——这个分支只服务于前端确认框里
 * 用户显式选了「永久删除」，平时不要主动传它。
 */
app.post("/api/plugins/:id/remove", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { purge?: boolean };
    return c.json(removePlugin(c.req.param("id"), { purge: body.purge === true }));
  } catch (err) {
    return fail(c, err);
  }
});

/**
 * 渲染产物：列表 / 锁定 / 按选择删除。
 * `projectId` 只返回那个工程的产物（编辑器顶栏浮框用）——不传是全库（清理弹窗用）。
 */
app.get("/api/outputs", (c) => {
  const projectId = c.req.query("projectId") || undefined;
  return c.json({ files: listOutputs({ projectId }) });
});

/** 锁定/解锁一条产物：锁定的文件不会被自动清理删掉（手动删仍然可以） */
app.post("/api/outputs/lock", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { path?: string; locked?: boolean };
    if (!body.path) return c.json({ error: "缺少 path" }, 400);
    return c.json(setOutputLock(String(body.path), body.locked !== false));
  } catch (err) {
    return fail(c, err);
  }
});

app.post("/api/outputs/delete", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { paths?: string[]; names?: string[] };
    // paths = 相对 out/ 的路径（projects/<id>/videos/x.mp4）；names 是旧字段，仅兼容
    const list = Array.isArray(body.paths) ? body.paths : body.names;
    if (!Array.isArray(list) || !list.length) {
      return c.json({ error: "没有选择要删除的文件" }, 400);
    }
    return c.json(deleteOutputs(list));
  } catch (err) {
    return fail(c, err);
  }
});

/** 复制工程 */
app.post("/api/projects/:id/duplicate", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    return c.json({ project: projects.duplicate(c.req.param("id"), body.name) });
  } catch (err) {
    return fail(c, err);
  }
});

/* ────────────────────────────── 工程包（zip） ────────────────────────────── */

/** 导出：project.json + assets/ + manifest.json，整包下载 */
app.get("/api/projects/:id/export", (c) => {
  try {
    const { filename, data } = bundleService.exportProject(c.req.param("id"));
    // 用 ArrayBuffer 而不是 Uint8Array：TS 的 BodyInit 只接受 ArrayBuffer 视图
    const body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    return new Response(body, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "content-length": String(data.byteLength),
      },
    });
  } catch (err) {
    return fail(c, err);
  }
});

/**
 * 导出字幕（SRT / WebVTT）。
 *
 * GET  直接返回文本（浏览器会按附件下载；也方便 agent 用 curl 取）
 * POST 写到 out/projects/<工程id>/subtitles/ 并返回本地路径
 */
app.get("/api/projects/:id/subtitles", (c) => {
  try {
    const id = c.req.param("id");
    const format = (c.req.query("format") === "vtt" ? "vtt" : "srt") as SubtitleFormat;
    const project = projects.get(id);
    const cues = buildCues(project);
    const content = renderSubtitles(cues, project.fps || 30, format);
    const filename = `${(project.name || id).replace(/[\\/:*?"<>|]/g, "_").slice(0, 40)}${subtitleExt(format)}`;
    return new Response(content, {
      headers: {
        "content-type": format === "vtt" ? "text/vtt; charset=utf-8" : "application/x-subrip; charset=utf-8",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      },
    });
  } catch (err) {
    return fail(c, err);
  }
});

/** 字幕条目（结构化，给前端做字幕轨道用） */
app.get("/api/projects/:id/subtitle-cues", (c) => {
  try {
    const project = projects.get(c.req.param("id"));
    const cues = buildCues(project);
    return c.json({
      cues: cues.map((x) => ({
        index: x.index,
        startFrame: x.startFrame,
        endFrame: x.endFrame,
        text: x.text,
        sceneId: x.sceneId,
        sceneName: x.sceneName,
      })),
      fps: project.fps || 30,
    });
  } catch (err) {
    return fail(c, err);
  }
});

/** 字幕落盘 */
app.post("/api/projects/:id/subtitles", async (c) => {
  try {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { format?: string };
    const format = (body.format === "vtt" ? "vtt" : "srt") as SubtitleFormat;
    const project = projects.get(id);
    const cues = buildCues(project);
    const content = renderSubtitles(cues, project.fps || 30, format);
    if (!cues.length) {
      return c.json(
        { error: "工程里还没有字幕：给场景写 subtitle，或用 caption 版式" },
        400,
      );
    }
    const saved = writeSubtitleFile(id, project.name, content, format);
    return c.json({
      file: saved.file,
      filename: saved.filename,
      bytes: saved.bytes,
      cues: cues.length,
      format,
    });
  } catch (err) {
    return fail(c, err);
  }
});

/** 导入：multipart file，生成新工程（id / rev 重生成，不覆盖本机工程） */
app.post("/api/projects/import", async (c) => {
  try {
    const form = await c.req.parseBody();
    const file = form["file"];
    if (!(file instanceof File)) return c.json({ error: "缺少 file 上传字段" }, 400);
    const buf = new Uint8Array(await file.arrayBuffer());
    if (buf.length > 60 * 1024 * 1024) return c.json({ error: "压缩包超过 60MB" }, 400);
    const result = bundleService.importProject(buf);
    return c.json({
      project: result.project,
      assets: result.assetCount,
      warnings: result.warnings,
    });
  } catch (err) {
    return fail(c, err);
  }
});

/**
 * 写请求幂等：客户端超时会重发同一批 ops（网络没响应 ≠ 没写进去），
 * 去重表在 `ProjectService` 里按 opId 维护，路由只负责把 opId 传下去。
 */
app.post("/api/projects/:id/ops", async (c) => {
  try {
    const body = (await c.req.json()) as {
      ops: Op[];
      expectedRev?: number;
      /** 前端用：rev 对不上时按语义合并并回执说明，不整批拒绝（见 project.service 注释） */
      softRev?: boolean;
      actor?: string;
      clientId?: string;
      opId?: string;
    };
    if (!Array.isArray(body.ops) || body.ops.length === 0) {
      return c.json({ error: "ops 不能为空" }, 400);
    }
    const result = projects.apply(c.req.param("id"), body.ops, {
      expectedRev: body.expectedRev,
      softRevCheck: !!body.softRev,
      actor: body.actor ?? "user",
      clientId: body.clientId,
      opId: body.opId,
    });
    // agent 或用户刚改过这个工程 → 记为"最近在用"，重启后编辑器直接回到它
    projects.touch(result.project.id);
    return c.json({
      project: result.project,
      createdSceneIds: result.createdSceneIds,
      createdIds: result.createdIds,
      summary: result.summary,
      /** 只有软冲突时才有：前端据此提示"已合并 agent 的并发修改" */
      revMismatch: result.revMismatch,
    });
  } catch (err) {
    return fail(c, err);
  }
});

/** 回滚到某个 rev（读磁盘快照；快照保留最近 50 个） */
app.post("/api/projects/:id/restore/:rev", (c) => {
  try {
    const rev = Number(c.req.param("rev"));
    if (!Number.isInteger(rev) || rev < 1) return c.json({ error: "rev 必须是正整数" }, 400);
    const result = projects.restoreRevision(c.req.param("id"), rev);
    return c.json({ project: result.project, summary: result.summary });
  } catch (err) {
    return fail(c, err);
  }
});

/** SSE：agent 的修改实时推到用户界面 */
app.get("/api/projects/:id/events", (c) => {
  const id = c.req.param("id");
  /**
   * 项目不存在就直接 404。
   * 之前没有这一步：流内部 `projects.get(id)` 抛 ENOENT，Hono 打一整段堆栈，
   * 浏览器 EventSource 再重连、再抛 —— 换工程目录或换个数据盘之后，
   * 旧标签页会一直刷这段错误，把日志淹掉。
   */
  try {
    projects.get(id);
  } catch {
    return c.json({ error: "工程不存在" }, 404);
  }
  return streamSSE(c, async (stream) => {
    const unsub = projects.subscribe(id, (event) => {
      void stream.writeSSE({ event: "patch", data: JSON.stringify(event) });
    });
    const ping = setInterval(() => {
      void stream.writeSSE({ event: "ping", data: String(Date.now()) });
    }, 15000);

    await stream.writeSSE({
      event: "ready",
      data: JSON.stringify({ rev: projects.get(id).rev }),
    });

    await new Promise<void>((resolve) => {
      stream.onAbort(() => resolve());
    });

    clearInterval(ping);
    unsub();
  });
});

/**
 * 工程素材：public/assets/projects/<工程id>/ —— 只属于这个工程，删工程一起清。
 * GET  列表（面板「本工程素材」用）
 * POST 上传（写进工程目录，不再散到 assets 根下）
 * DELETE 删一个文件（?url=/assets/projects/<id>/x.png，或用 ?name=x.png）
 */
app.get("/api/projects/:id/assets", (c) => {
  try {
    const id = c.req.param("id");
    return c.json({ items: listProjectAssets(id) });
  } catch (err) {
    return fail(c, err);
  }
});

app.post("/api/projects/:id/assets", async (c) => {
  try {
    const id = c.req.param("id");
    const form = await c.req.parseBody();
    const file = form["file"];
    if (!(file instanceof File)) return c.json({ error: "缺少 file 上传字段" }, 400);

    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length > 40 * 1024 * 1024) return c.json({ error: "文件超过 40MB" }, 400);

    const ext = path.extname(file.name || "").toLowerCase() || ".bin";
    const name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}${ext}`;

    /*
     * 走处理管道而不是直接落盘：插件可以在素材入库前改它（压缩、剥元数据、
     * 转格式、加响度）。没装插件时这个调用只是一次数组判断 + 一次 writeFileSync，
     * 和原来的 `writeProjectAsset` 开销一样。
     */
    const r = await ingestAsset(id, name, buffer);

    return c.json({
      url: r.url,
      // `name` 保持原语义（用户选的那个文件名），前端/agent 一直在用它
      name: file.name,
      size: r.bytes,
      // 处理过才带这几个字段：没装插件时回执保持和以前一模一样
      ...(r.processed
        ? { fileName: r.name, processed: true, processorNote: r.note, processorWarnings: r.warnings }
        : {}),
    });
  } catch (err) {
    return fail(c, err);
  }
});

/**
 * 把已装的文件处理插件套到**已有素材**上。
 *
 * 为什么需要独立端点：插件的自动处理只对**新上传**生效。用户装完插件，
 * 工程里那几十张图不会自己变，这个入口就是补这件事。
 *
 * `dryRun` 默认 true —— 给用户先看一眼会产出什么，再决定写不写。
 */
app.post("/api/projects/:id/assets/reprocess", async (c) => {
  try {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { names?: string[]; dryRun?: boolean };
    const r = await reprocessProjectAssets(id, { onlyNames: body.names, dryRun: body.dryRun !== false });
    return c.json(r);
  } catch (err) {
    return fail(c, err);
  }
});

app.delete("/api/projects/:id/assets", (c) => {
  try {
    const id = c.req.param("id");
    const url = c.req.query("url");
    const name = c.req.query("name");
    const rel = url
      ? assetNameOf(url)
      : name
        ? projectAssetRel(id, name)
        : null;
    if (!rel) return c.json({ error: "给 url=/assets/… 或 name=<文件名>" }, 400);
    // 只允许删本工程目录里的文件：别让一个工程的手滑操作删掉别人的素材
    const prefix = `${PROJECTS_REL}/${id}/`;
    if (!rel.startsWith(prefix) || rel.slice(prefix.length).includes("/")) {
      return c.json({ error: `只能删本工程目录（${prefix}）里的素材：${rel}` }, 400);
    }
    const full = absAssetPath(rel);
    if (!fs.existsSync(full)) return c.json({ error: `文件不存在：${rel}` }, 404);
    const wasReferenced = referencedAssetFiles().has(rel);
    fs.unlinkSync(full);
    return c.json({ ok: true, rel, wasReferenced });
  } catch (err) {
    return fail(c, err);
  }
});

/**
 * 批量删工程素材（面板多选）。
 * 逐个文件走和单删一样的校验：必须在**本工程目录**里，被引用的照删但回报数量。
 */
app.post("/api/projects/:id/assets/delete", async (c) => {
  try {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { names?: string[] };
    const names = Array.isArray(body.names) ? body.names : [];
    if (!names.length) return c.json({ error: "没有选择要删除的文件" }, 400);

    const referenced = referencedAssetFiles();
    const prefix = `${PROJECTS_REL}/${id}/`;
    let deleted = 0;
    let wasReferenced = 0;
    let freedBytes = 0;
    const missing: string[] = [];

    for (const name of names) {
      let rel: string;
      try {
        rel = projectAssetRel(id, String(name));
      } catch {
        missing.push(String(name));
        continue;
      }
      if (!rel.startsWith(prefix) || rel.slice(prefix.length).includes("/")) {
        missing.push(String(name));
        continue;
      }
      const full = absAssetPath(rel);
      if (!fs.existsSync(full)) {
        missing.push(String(name));
        continue;
      }
      const size = fs.statSync(full).size;
      if (referenced.has(rel)) wasReferenced++;
      try {
        fs.unlinkSync(full);
        deleted++;
        freedBytes += size;
      } catch {
        missing.push(String(name));
      }
    }
    return c.json({ deleted, wasReferenced, freedBytes, missing });
  } catch (err) {
    return fail(c, err);
  }
});

/** 操作历史：谁在什么时候改了什么（agent 与用户混排） */
app.get("/api/projects/:id/history", (c) => c.json({ entries: projects.history(c.req.param("id")) }));

/* ────────────────────────── 我的素材（跨工程的素材库索引） ────────────────────────── */

/** 创作需求 brief：开工前存、创作中随时对照 */
/** 分镜表：brief 之后、搭场景之前的中间计划 */
app.get("/api/projects/:id/storyboard", (c) => {
  try {
    return c.json({ storyboard: readStoryboard(c.req.param("id")) });
  } catch (err) {
    return fail(c, err);
  }
});

app.put("/api/projects/:id/storyboard", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { shots?: unknown };
    return c.json({ storyboard: saveStoryboard(c.req.param("id"), body as never) });
  } catch (err) {
    return fail(c, err);
  }
});

app.get("/api/projects/:id/brief", (c) => {
  try {
    return c.json({ brief: readBrief(c.req.param("id")) });
  } catch (err) {
    return fail(c, err);
  }
});

/**
 * 设计稿（export_design 写入的 design.md）。
 *
 * 单独一条只读路由，是因为它和 storyboard 的用途正相反：storyboard 是给 agent 的
 * 结构化计划，设计稿是给人读的一篇文章。编辑器面板只需要后者，不该为了看一段文字
 * 去拉整份 JSON 再自己排版。
 */
app.get("/api/projects/:id/design", (c) => {
  try {
    const markdown = readDesignCard(c.req.param("id"));
    return c.json({ markdown, empty: !markdown });
  } catch (err) {
    return fail(c, err);
  }
});

/**
 * 旁白时长骨架：TTS 实测出来的每段帧数。
 * 单独一个文件而不是塞进 brief —— 它是"实测产物"，会随稿子重配而变，
 * 和"用户拍板的需求"混在一起，改稿就会把需求覆盖掉。
 */
app.get("/api/projects/:id/narration-timing", (c) => {
  try {
    return c.json({ timing: readTiming(c.req.param("id")) });
  } catch (err) {
    return fail(c, err);
  }
});

app.put("/api/projects/:id/narration-timing", async (c) => {
  try {
    const body = (await c.req.json()) as {
      fps?: number;
      totalSec?: number;
      segments?: { text: string; frames: number; suggested: number; durationSec: number; sceneId?: string }[];
    };
    const segments = (body.segments ?? []).map((x, i) => ({ ...x, index: i + 1 }));
    if (!segments.length) throw new Error("segments 不能为空");
    const fps = Number(body.fps) > 0 ? Number(body.fps) : 30;
    const totalSec =
      Number(body.totalSec) > 0
        ? Number(body.totalSec)
        : segments.reduce((n, x) => n + Number(x.suggested || 0), 0) / fps;
    const timing = saveTiming(c.req.param("id"), { fps, totalSec, segments });
    return c.json({ timing });
  } catch (err) {
    return fail(c, err);
  }
});

/**
 * 记录「用户听过这一版配音」。
 *
 * 为什么不是 PUT .../narration-timing 的一个布尔字段：
 * 布尔记不下"用户到底说了什么"，而事故里翻车的正是**用户的话被理解错**
 * （「可以，先合成配音试听」被当成「稿子确认完毕，可以往下走」）。
 * 这里要求带原话，并在 decisions.jsonl 留痕。
 */
/**
 * 决策审计：记录「agent 声称用户在某个闸口点了头」以及用户的原话。
 * 工具验证不了真伪，但能保证「哪句话被当成了授权」留得下来。
 */
app.post("/api/projects/:id/decisions", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      kind?: DecisionKind;
      userQuote?: string;
      note?: string;
      meta?: Record<string, unknown>;
    };
    if (!body.kind) throw new Error("缺 kind");
    const rec = appendDecision(c.req.param("id"), {
      kind: body.kind,
      userQuote: String(body.userQuote ?? "").trim(),
      note: body.note,
      meta: body.meta,
    });
    return c.json({ decision: rec });
  } catch (err) {
    return fail(c, err);
  }
});

app.get("/api/projects/:id/decisions", (c) => {
  try {
    return c.json({ decisions: readDecisions(c.req.param("id")) });
  } catch (err) {
    return fail(c, err);
  }
});

app.post("/api/projects/:id/narration-heard", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { userSaid?: string };
    const said = String(body.userSaid ?? "").trim();
    if (said.length < 5) {
      throw new Error(
        `要带用户原话（至少 5 字），不是「用户同意了」。收到的是「${said}」——` +
          `把他说过的那句话原样贴进来，事后才查得出他到底同意了什么`,
      );
    }
    const timing = markNarrationHeard(c.req.param("id"), said);
    return c.json({ timing });
  } catch (err) {
    return fail(c, err);
  }
});

app.put("/api/projects/:id/brief", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return c.json({ brief: saveBrief(c.req.param("id"), body as never) });
  } catch (err) {
    return fail(c, err);
  }
});

app.get("/api/library", async (c) => {
  // 旧素材可能没有时长：音视频首次列出来时探测一次并回填（之后就有值，不再探测）
  let items = library.list();
  const missing = items.filter(
    (i) => !i.duration && (i.kind === "audio" || i.kind === "video"),
  );
  if (missing.length) {
    const probes = await probeMany(
      missing.map((i) => i.url),
      30,
    );
    const durations: Record<string, number> = {};
    probes.forEach((p, idx) => {
      if (!p.error && p.durationInSeconds > 0) {
        durations[missing[idx].id] = p.durationInSeconds;
      }
    });
    library.setDurations(durations);
    items = library.list();
  }
  return c.json({ items });
});

/**
 * 两种入库方式，同一个出口：
 *  - multipart：新文件（用户在素材面板上传，前端顺便量好 w/h）
 *  - JSON：登记 public/assets 里已有的文件（agent 生成图片后走这条路，避免二进制再传一遍）
 */
app.post("/api/library", async (c) => {
  try {
    const type = c.req.header("content-type") ?? "";
    if (type.includes("multipart/form-data")) {
      const form = await c.req.parseBody();
      const file = form["file"];
      if (!(file instanceof File)) return c.json({ error: "缺少 file 上传字段" }, 400);
      const buffer = Buffer.from(await file.arrayBuffer());
      if (buffer.length > 40 * 1024 * 1024) return c.json({ error: "文件超过 40MB" }, 400);
      // 浏览器顺带生成的缩略图（可能没有：agent 走 JSON 登记时就没有）
      const thumb = form["thumb"];
      const thumbBuffer =
        thumb instanceof File && thumb.size ? Buffer.from(await thumb.arrayBuffer()) : undefined;
      const item = library.add({
        buffer,
        filename: file.name,
        name: String(form["name"] ?? "") || file.name,
        w: Number(form["w"]) || undefined,
        h: Number(form["h"]) || undefined,
        duration: Number(form["duration"]) || undefined,
        thumbBuffer,
      });
      return c.json({ item });
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      url?: string;
      name?: string;
      w?: number;
      h?: number;
      duration?: number;
    };
    return c.json({ item: library.add(body) });
  } catch (err) {
    return fail(c, err);
  }
});

app.patch("/api/library/:id", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    return c.json({ item: library.rename(c.req.param("id"), String(body.name ?? "")) });
  } catch (err) {
    return fail(c, err);
  }
});

app.delete("/api/library/:id", (c) => {
  try {
    const removed = library.remove(c.req.param("id"));
    // 删条目后回收文件：别的库条目或任何工程还在用就保留（原图 + 缩略图一起处理）
    const reclaimed = reclaimAssetFiles([removed.url, removed.thumbUrl]);
    return c.json({ removed, reclaimed });
  } catch (err) {
    return fail(c, err);
  }
});

/** 批量删「我的素材」条目（面板多选）：条目删掉，文件按引用集合回收 */
app.post("/api/library/delete", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { ids?: string[] };
    const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === "string") : [];
    if (!ids.length) return c.json({ error: "没有选择要删除的素材" }, 400);

    const urls: (string | undefined)[] = [];
    let deleted = 0;
    const missing: string[] = [];
    for (const id of ids) {
      try {
        const removed = library.remove(id);
        urls.push(removed.url, removed.thumbUrl);
        deleted++;
      } catch {
        missing.push(id);
      }
    }
    const reclaimed = reclaimAssetFiles(urls);
    return c.json({ deleted, reclaimed, missing });
  } catch (err) {
    return fail(c, err);
  }
});

/** 清理 public/assets 里没有任何引用的文件（工程和素材库都不认它） */
app.post("/api/assets/cleanup", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      dryRun?: boolean;
      includeLibrary?: boolean;
      scope?: "root" | "all";
    };
    return c.json(
      cleanupUnusedAssets({
        dryRun: !!body.dryRun,
        includeLibrary: !!body.includeLibrary,
        scope: body.scope === "all" ? "all" : "root",
      }),
    );
  } catch (err) {
    return fail(c, err);
  }
});

/**
 * 一次性整理：把旧版散在 assets/ 根下的文件按「谁在用」搬进工程目录或 library/，
 * 并改写 project.json / 素材库索引里的 URL。dryRun=true 只出方案（默认就是 dryRun）。
 */
app.post("/api/assets/organize", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { dryRun?: boolean };
    const dryRun = body.dryRun !== false;
    const result = organizeAssets({ dryRun });
    // 写盘交给工程服务：缓存与写盘必须同一个入口（v0.98 起整理会改 rev）
    if (!dryRun) {
      for (const r of result.rewrites) projects.replace(r.project);
    }
    return c.json({ result });
  } catch (err) {
    return fail(c, err);
  }
});

/* ────────────────────────────── 渲染 ────────────────────────────── */

/**
 * 重建渲染用打包快照。平时不需要——每次渲染前都会把 public/ 的增量素材同步进快照；
 * 只有改了打包配置、或怀疑快照坏了才手动重建（会阻塞十几秒）。
 */
app.post("/api/bundle/refresh", async (c) => {
  try {
    resetBundle();
    const serveUrl = await getServeUrl();
    return c.json({ ok: true, serveUrl, bundle: bundleState() });
  } catch (err) {
    return fail(c, err);
  }
});

/** 量素材时长：/api/assets/probe?src=/assets/a.wav&src=/assets/b.wav */
app.get("/api/assets/probe", async (c) => {
  try {
    const srcs = c.req.queries("src") ?? [];
    if (!srcs.length) return c.json({ error: "至少传一个 src" }, 400);
    if (srcs.length > 50) return c.json({ error: "一次最多量 50 个" }, 400);
    const fps = Number(c.req.query("fps") ?? 30) || 30;
    // breath：幕尾呼吸位（秒），默认 0.7；长片嫌拖可以传 0.3
    const breathRaw = c.req.query("breath");
    const breath = breathRaw === undefined ? undefined : Number(breathRaw);
    return c.json({ probes: await probeMany(srcs, fps, Number.isFinite(breath as number) ? (breath as number) : undefined) });
  } catch (err) {
    return fail(c, err);
  }
});

/**
 * 渲染互斥检查：视频渲染与抽帧复用同一个浏览器实例，渲染中抽帧会撞 28s delayRender 超时，
 * 而旧回执里一个字都不提「正在渲染」——调用方只能靠猜（那次 render_cover 就是这么失败的）。
 */
function busyRender(c: any) {
  const t = activeRenderTask();
  if (!t) return null;
  const elapsed = Math.round((Date.now() - (t.startedAt ?? t.createdAt)) / 1000);
  const msg =
    `正在渲染「${t.projectName ?? t.projectId}」（taskId=${t.id}，${t.status} ${t.progress}%，已跑 ${elapsed}s）。` +
    `渲染与抽帧共用同一个浏览器实例，渲染期间抽帧会超时（delayRender 28s）。` +
    `要么等它结束（get_render_status(taskId="${t.id}")），要么先 cancel_render(taskId="${t.id}") 再抽帧。`;
  return c.json({ error: msg, taskId: t.id, progress: t.progress, status: t.status }, 409);
}

app.post("/api/projects/:id/stills", async (c) => {
  try {
    const busy = busyRender(c);
    if (busy) return busy;
    const body = (await c.req.json().catch(() => ({}))) as {
      frame?: number;
      formats?: string[];
      tag?: string;
      /** "cover" = 封面候选，落 covers/；不传是关键帧，落 stills/ */
      purpose?: "cover";
    };
    const project = projects.get(c.req.param("id"));
    const { stills, warnings } = await renderStills(project, body.frame, body.formats, body.tag, body.purpose);
    // warnings 是"某个插件后期 pass 编不过、已跳过"这类话。不返回的话画面会少一层效果而没人知道原因
    return c.json({ stills, ...(warnings.length ? { warnings } : {}) });
  } catch (err) {
    return fail(c, err);
  }
});

/**
 * 6 秒预览片段：把「看见动态」的成本从整片 12 分钟压到几十秒。
 * 参数用帧而不是秒——调用方（agent）手上本来就是帧（sceneSpans / 分镜），
 * 中途换算一次就会错一次。
 */
app.post("/api/projects/:id/preview-clip", async (c) => {
  try {
    const busy = busyRender(c);
    if (busy) return busy;
    const body = (await c.req.json().catch(() => ({}))) as {
      startFrame?: number;
      endFrame?: number;
      format?: string;
      scale?: number;
      audio?: boolean;
      tag?: string;
    };
    if (!Number.isFinite(Number(body.startFrame)) || !Number.isFinite(Number(body.endFrame))) {
      throw new Error("要给 startFrame / endFrame（帧号，不是秒）");
    }
    const project = projects.get(c.req.param("id"));
    const clip = await renderPreviewClip(project, {
      startFrame: Number(body.startFrame),
      endFrame: Number(body.endFrame),
      formatKey: body.format,
      scale: body.scale,
      withAudio: body.audio,
      tag: body.tag,
    });
    return c.json({ clip });
  } catch (err) {
    return fail(c, err);
  }
});

app.post("/api/projects/:id/render", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      formats?: string[];
      quality?: "low" | "standard" | "high";
      format?: "mp4" | "gif" | "webm";
      /** 自定义文件名前缀；不传用工程名 */
      fileName?: string;
    };
    const project = projects.get(c.req.param("id"));
    const task = enqueueVideo(project, body.formats, body.quality, body.format, body.fileName);
    return c.json({ task });
  } catch (err) {
    return fail(c, err);
  }
});

app.get("/api/tasks", (c) => c.json({ tasks: listTasks() }));
app.get("/api/tasks/:id", (c) => {
  const task = getTask(c.req.param("id"));
  if (!task) return c.json({ error: "任务不存在" }, 404);
  return c.json({ task });
});

/** 取消渲染：已结束的任务返回 409 */
app.post("/api/tasks/:id/cancel", (c) => {
  const id = c.req.param("id");
  const task = getTask(id);
  if (!task) return c.json({ error: "任务不存在" }, 404);
  if (!cancelTask(id)) return c.json({ error: `任务已结束（${task.status}）` }, 409);
  return c.json({ ok: true, task });
});

/* ────────────────────────────── 产物清理 ────────────────────────────── */

/**
 * 清理 out/：每个工程保留最近 N 个成片、关键帧按天数清。
 * 传 projectId 只清一个工程；dryRun 只统计不删。
 */
app.post("/api/outputs/cleanup", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      projectId?: string;
      keepVideos?: number;
      stillsDays?: number;
      dryRun?: boolean;
    };
    return c.json(cleanupOutputs(body));
  } catch (err) {
    return fail(c, err);
  }
});

/* ────────────────────────────── 静态产物 ────────────────────────────── */

// 素材与产物走自己的静态服务：hono 的 serveStatic 给 wav/mp3 回 octet-stream，
// 浏览器直接拒绝解码（"详情面板里点播放没反应"），且不支持 Range（拖不了进度条）
app.use("/out/*", serveFiles(path.resolve(process.cwd()), { cache: "public, max-age=300" }));
app.use("/assets/*", serveFiles(path.join(process.cwd(), "public"), { cache: "public, max-age=600" }));

/**
 * 编辑器前端托管。
 * 构建过（dist/web 存在）就直接由本服务提供，一个端口就是完整应用：
 * MCP 拉起服务后用户不必再单独开 vite。
 * 开发时仍用 npm run dev 走 vite 的 HMR，此时未构建也不影响。
 */
const WEB_DIST = path.resolve(process.cwd(), "dist", "web");
const WEB_READY = fs.existsSync(path.join(WEB_DIST, "index.html"));

if (WEB_READY) {
  /*
   * 缓存策略是「index.html 永不缓存、带 hash 的资源随便缓存」。
   *
   * 为什么 index.html 不能缓存：vite 产物的 JS 文件名带内容 hash，每次构建都会换；
   * 但引用它的 index.html 文件名不变。index.html 一旦被浏览器缓存，就会继续引用
   * 上一版的 hash —— 用户普通刷新永远拿不到新包，症状是"改了功能但页面没变化"。
   * 这不是理论风险：上线的第一晚就发生过（新场景类型上了、用户侧全是黑屏），
   * 所以这条 no-cache 不是可"优化"掉的多余配置。
   *
   * hash 资源反倒是越缓存越好：文件名即版本，内容变了名字一定变。
   */
  app.use("*", async (c, next) => {
    await next();
    const url = new URL(c.req.url);
    const isHtml =
      url.pathname === "/" ||
      url.pathname.endsWith(".html") ||
      // SPA 兜底路径（没有扩展名的都交回 index.html）
      !path.extname(url.pathname);
    if (isHtml && c.res) {
      c.res.headers.set("Cache-Control", "no-cache, must-revalidate");
    }
  });
  app.use("/*", serveStatic({ root: WEB_DIST }));
  // SPA 兜底：非 API/静态资源路径一律交回前端路由
  app.get("*", (c) => {
    c.header("Cache-Control", "no-cache, must-revalidate");
    return c.html(fs.readFileSync(path.join(WEB_DIST, "index.html"), "utf8"));
  });
} else {
  app.get("/", (c) =>
    c.json({
      name: "remotion-studio",
      hint: "前端尚未构建：执行 npm run build 后本地址即可直接打开编辑器；开发时用 npm run dev（vite，5173）",
    }),
  );
}

// 服务一起来就清一次 Temp 里的旧版打包目录（remotion-webpack-bundle-*）。
// bundle 现在固定打到项目内的 .remotion-bundle，这些随机目录不会再产生新的一份，
// 留着只有占盘一个作用。放到这里而不是 render.service 的模块顶层：
// 模块顶层在 import 时就执行，测试导入它会连带触发清理，副作用太隐蔽。
try {
  cleanupLegacyBundles(undefined, (msg) => console.log(`  ▸ ${msg}`));
} catch (err) {
  console.error("[bundle] 清理旧打包目录失败（不影响服务）：", err);
}

/*
 * dist/web 过期提醒。
 *
 * 编辑器预览用的是 @remotion/player —— 雨幕/转场这些场景组件**也打进 web 前端
 * bundle**。改了 src/ 或 web/ 的代码之后，如果只重启服务，serveStatic 读的还是
 * 旧 dist，用户会看到"改了没生效"（雨幕方向修复当晚就踩了一次：修复在 build
 * 之后提交，重启后预览仍旧朝向）。
 *
 * 只提醒不代劳：自动 build 会拖慢启动，而且 dev 模式（vite dev server）根本
 * 不走 dist，警告是误报 —— 所以只看"dist 存在且比源码旧"这一种情况。
 */
const warnStaleWebBuild = () => {
  const distHtml = path.join(process.cwd(), "dist", "web", "index.html");
  if (!fs.existsSync(distHtml)) return; // 从没构建过 = 一直是 dev 模式，不用管
  let newest = fs.statSync(distHtml).mtimeMs;
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx?|css)$/.test(e.name)) newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  };
  walk(path.join(process.cwd(), "web"));
  walk(path.join(process.cwd(), "src"));
  walk(path.join(process.cwd(), "shared"));
  if (newest > fs.statSync(distHtml).mtimeMs + 1000) {
    console.warn(
      "  ⚠ web/src 代码比 dist/web 新：编辑器预览还在用旧组件。跑一次 npm run build 再强刷浏览器（Ctrl+Shift+R）",
    );
  }
};
try {
  warnStaleWebBuild();
} catch {
  /* 提醒失败不影响启动 */
}

/*
 * 启动时预热插件钩子（不阻塞监听）。
 *
 * 不做的话，第一个请求要等 esbuild 打包插件（实测 240ms 左右），
 * 用户看到的是"刚打开编辑器那一下特别慢"。放到这里，这几十上百毫秒
 * 混在启动过程里，谁也感觉不到。失败也不影响启动——请求中间件还会再试。
 */
/*
 * 全新环境（data/plugins.json 还不存在）时，把仓库自带的 _example-* 示例
 * 预先停用——否则示例技能/风格/场景/审计会混进真实项目。一次性动作：
 * 用户表达过任何意愿（文件存在）之后就不再介入。
 */
try {
  const seeded = seedExamplePluginsDisabled();
  if (seeded.length) console.log(`  ▸ 已停用 ${seeded.length} 个示例插件（面板里可一键启用）`);
} catch {
  /* 种子失败不影响启动：最坏情况只是示例多启用一次 */
}
void ensurePluginHooks().catch(() => {
  /* 中间件里有正式的日志与兜底 */
});
void ensurePluginTools().catch(() => {
  /* 同上 */
});
// 上次崩溃/断电可能留下半装完的插件暂存目录（plugins/.staging/*），启动清一次
try {
  const cleaned = cleanupPluginStaging();
  if (cleaned.length) console.log(`  ▸ 已清理插件暂存目录 ${cleaned.length} 个`);
} catch {
  /* 清理失败不影响启动 */
}

const httpServer = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  // 对外展示用 localhost（更好读）；内部探活仍走 127.0.0.1
  const shown = ALLOW_LAN ? `http://${HOST}:${info.port}` : `http://localhost:${info.port}`;
  console.log(`\n  ▸ 服务已启动      ${shown}`);
  console.log(
    ALLOW_LAN
      ? `  ▸ 监听            ${HOST}:${info.port}  ⚠️ 已对外网开放（同网段设备可访问；不需要时去掉 HOST 重启）`
      : `  ▸ 监听            127.0.0.1:${info.port}（仅本机；需要局域网访问用 HOST=0.0.0.0 启动）`,
  );
  // 数据目录单独打一行：同一台机器上多份 data/（不同 cwd 启动）时，
  // 「工程怎么不见了」只能靠这行路径判断，不打印就完全无从下手
  console.log(`  ▸ 数据目录        ${DATA_DIR}`);
  console.log(
    WEB_READY
      ? `  ▸ 编辑器          http://localhost:${info.port}  （已托管构建产物）\n`
      : `  ▸ 编辑器          未构建，先 npm run build；或 npm run dev 用 vite 热更新\n`,
  );
  /**
   * 启动方式自检。
   *
   * 本机宿主会给 Node 注入 safe-delete 拦截器（按每轮删文件数设阈值）。用
   * `npm run dev:server` 直接起时没有 `CODEBUDDY_SAFE_DELETE_ENABLED=0`，
   * 一旦遇到需要连续删除的操作（删除工程、清理旧快照），整个进程可能被卡住——
   * 症状是"界面突然改不动、所有请求超时"。这条警告是为了让人一眼看到该换启动方式。
   */
  if (process.env.CODEBUDDY_SAFE_DELETE_ENABLED !== "0") {
    console.log(
      "  ▸ 提示            CODEBUDDY_SAFE_DELETE_ENABLED 未设为 0：删除类操作可能被宿主拦截并卡住进程。" +
        "建议用 npm start 或「启动编辑器.bat」启动。\n",
    );
  }
});

/* ────────────────────────── 进程级兜底与优雅退出 ────────────────────────── */

pruneToolLogs();

installRuntimeGuards({
  onShutdown: () => {
    // 渲染子进程不取消的话，任务会永远停在 rendering，下次打开编辑器进度条卡住
    for (const t of listTasks()) {
      if (t.status === "queued" || t.status === "bundling" || t.status === "rendering") {
        cancelTask(t.id);
      }
    }
    httpServer.close();
  },
});
