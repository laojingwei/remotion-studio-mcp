import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { serveFiles } from "./static.service";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import fs from "node:fs";
import path from "node:path";
import { metaList } from "../shared/sceneMetas";
import type { Op } from "../shared/ops";
import { createSeedProject } from "../shared/ops";
import type { Project } from "../shared/schema";
import { buildFromTemplate, templateList } from "../shared/templates";
import { projects } from "./project.service";
import { templates } from "./template.service";
import { bundleService } from "./bundle.service";
import { cleanupOutputs, deleteOutputs, listOutputs, removeProjectOutputs } from "./outputs.service";
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
import { assetNameOf } from "../shared/customTemplate";
import { addMessage, listMessages, markUserMessagesRead } from "./agentBridge.service";
import { getTtsConfig, saveTtsConfig, synthesize } from "./tts.service";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { TOOLS, CORE_TOOL_NAMES, exposeAllTools, validateToolArgs } from "./mcp-tools";
import { library } from "./library.service";
import { readBrief, saveBrief } from "./brief.service";
import { readStoryboard, saveStoryboard } from "./storyboard.service";
import {
  bundleState,
  cancelTask,
  enqueueVideo,
  getServeUrl,
  getTask,
  listTasks,
  renderStills,
  resetBundle,
} from "./render.service";
import { probeMany } from "./media.service";
import { ensureSeed, PUBLIC_DIR, readLastProjectId, readUiPrefs, writeProject, writeUiPrefs } from "./store";
import { analyzeBeats } from "./audio-analysis.service";
import { measureLoudness } from "./loudness.service";
import { buildCompressCurve, summarizeCurve } from "../shared/audio";
import { MAX_VOLUME } from "../shared/schema";
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

const PORT = Number(process.env.PORT ?? 4380);
const app = new Hono();

const fail = (c: any, err: unknown) => {
  const status = (err as { status?: number })?.status ?? 400;
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: message }, status);
};

app.get("/api/health", (c) =>
  c.json({ ok: true, port: PORT, bundle: bundleState(), projects: projects.list().length }),
);

/* ────────────────────────────── 场景能力 ────────────────────────────── */

/** agent 的第一步：发现有哪些场景类型、每个字段是什么 */
app.get("/api/scene-types", (c) => c.json({ types: metaList() }));

/* ────────────────────────────── 工程 ────────────────────────────── */

app.get("/api/projects", (c) => c.json({ projects: projects.list() }));

/* ───────────── 文本转语音（TTS） ───────────── */

app.get("/api/tts/config", (c) => c.json({ config: getTtsConfig() }));

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
 */
app.post("/api/tts/check", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { deep?: boolean };
  const cfg = getTtsConfig();
  if (!cfg.endpoint) {
    return c.json({ ok: false, stage: "config", error: "还没配置语音服务地址（工具 set_tts_config 或编辑器「语音」→ 配置）" }, 400);
  }

  let origin: string;
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
  const reachMs = Date.now() - t0;

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
      { ok: false, stage: "synth", origin, reachMs, ms: Date.now() - t1, error: (err as Error).message },
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
        serverInfo: { name: "remotion-studio", version: "0.44.0" },
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
      try {
        const args = validateToolArgs(def, params?.arguments ?? {});
        const out = await def.run(args as never);
        return reply({
          content: [{ type: "text", text: String(out) }],
          isError: false,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
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
    c.header("Access-Control-Allow-Origin", "*");
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
  c.header("Access-Control-Allow-Origin", "*");
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

/** 删除工程 */
app.delete("/api/projects/:id", (c) => {
  const id = c.req.param("id");
  // 示例工程只允许重置，不允许删除（否则删掉就再也回不来了）
  if (id === "demo") {
    return c.json({ error: "demo 是示例工程，不能删除，只能用「重置 demo」恢复" }, 400);
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

/** 渲染产物：列表 / 按选择删除 */
app.get("/api/outputs", (c) => c.json({ files: listOutputs() }));

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

/** 唯一写入口：一批 op */
app.post("/api/projects/:id/ops", async (c) => {
  try {
    const body = (await c.req.json()) as {
      ops: Op[];
      expectedRev?: number;
      actor?: string;
      clientId?: string;
    };
    if (!Array.isArray(body.ops) || body.ops.length === 0) {
      return c.json({ error: "ops 不能为空" }, 400);
    }
    const result = projects.apply(c.req.param("id"), body.ops, {
      expectedRev: body.expectedRev,
      actor: body.actor ?? "user",
      clientId: body.clientId,
    });
    // agent 或用户刚改过这个工程 → 记为"最近在用"，重启后编辑器直接回到它
    projects.touch(result.project.id);
    return c.json({
      project: result.project,
      createdSceneIds: result.createdSceneIds,
      summary: result.summary,
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
    const url = writeProjectAsset(id, name, buffer);

    return c.json({ url, name: file.name, size: buffer.length });
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
    const body = (await c.req.json().catch(() => ({}))) as { dryRun?: boolean };
    return c.json(cleanupUnusedAssets({ dryRun: !!body.dryRun }));
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
    return c.json({ probes: await probeMany(srcs, fps) });
  } catch (err) {
    return fail(c, err);
  }
});

app.post("/api/projects/:id/stills", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      frame?: number;
      formats?: string[];
      tag?: string;
    };
    const project = projects.get(c.req.param("id"));
    const stills = await renderStills(project, body.frame, body.formats, body.tag);
    return c.json({ stills });
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
  app.use("/*", serveStatic({ root: WEB_DIST }));
  // SPA 兜底：非 API/静态资源路径一律交回前端路由
  app.get("*", (c) => c.html(fs.readFileSync(path.join(WEB_DIST, "index.html"), "utf8")));
} else {
  app.get("/", (c) =>
    c.json({
      name: "remotion-studio",
      hint: "前端尚未构建：执行 npm run build 后本地址即可直接打开编辑器；开发时用 npm run dev（vite，5173）",
    }),
  );
}

serve({ fetch: app.fetch, port: PORT }, (info) => {
  // 对外展示用 localhost（更好读）；内部探活仍走 127.0.0.1
  console.log(`\n  ▸ 服务已启动      http://localhost:${info.port}`);
  console.log(
    WEB_READY
      ? `  ▸ 编辑器          http://localhost:${info.port}  （已托管构建产物）\n`
      : `  ▸ 编辑器          未构建，先 npm run build；或 npm run dev 用 vite 热更新\n`,
  );
});
