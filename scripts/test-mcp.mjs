#!/usr/bin/env node
/**
 * MCP 工具冒烟测试（走真实 stdio JSON-RPC，不是直接调 HTTP）。
 *
 *   npm run test:mcp          # 需要本地服务在跑（脚本会自己确认）
 *
 * 覆盖：初始化、工具清单、export_project / import_project 往返。
 * 导入出来的工程会在结束时删掉，导出的 zip 也清理。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const ROOT = path.resolve(import.meta.dirname, "..");
const API = (process.env.SERVER_URL ?? "http://127.0.0.1:4380").replace(/\/$/, "");
const TSX = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

let passed = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ""}`);
  }
};

const child = spawn(process.execPath, [TSX, path.join(ROOT, "server", "mcp-proxy.ts")], {
  cwd: ROOT,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, SERVER_URL: API },
});

let seq = 0;
const pending = new Map();
const rl = readline.createInterface({ input: child.stdout });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message ?? "MCP error"));
    else resolve(msg.result);
  }
});
child.stderr.on("data", () => {
  /* 代理的日志都走 stderr，忽略 */
});

const CORE_TOOLS = new Set(["start_guide", "get_guide", "tool_search", "tool_call"]);
const call = (method, params) => {
  // 门面模式：非核心工具统一经 tool_call 路由（与真实 agent 的用法一致）
  if (method === "tools/call" && params?.name && !CORE_TOOLS.has(params.name)) {
    params = { name: "tool_call", arguments: { name: params.name, args: params.arguments } };
  }
  return rawCall(method, params);
};
const rawCall = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`MCP 超时: ${method}`));
      }
    }, 30000);
  });

const notify = (method, params) =>
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);

const textOf = (result) => result?.content?.[0]?.text ?? "";

async function main() {
  const health = await fetch(`${API}/api/health`).catch(() => null);
  if (!health?.ok) throw new Error(`服务没在跑：${API}（先 npm start）`);

  await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "dsh-verify", version: "1.0.0" },
  });
  notify("notifications/initialized");

  const tools = await call("tools/list");
  const names = (tools.tools ?? []).map((t) => t.name);
  const CORE = ["start_guide", "get_guide", "tool_search", "tool_call"];
  check(
    "工具门面：常驻列表 = 4 个核心入口",
    CORE.every((n) => names.includes(n)) && names.length === CORE.length,
    `实际 [${names.join(", ")}]`,
  );

  /* 全量目录（经 tool_search(all=true)）：能力注册完整性 */
  const catalog = JSON.parse(
    textOf(await call("tools/call", { name: "tool_search", arguments: { all: true } })),
  );
  const allNames = catalog.map((x) => x.name);
  check("目录含全部工具（≥ 74）", allNames.length >= 74, `实际 ${allNames.length}`);
  check("有 export_project", allNames.includes("export_project"));
  check("有 import_project", allNames.includes("import_project"));

  /* 新功能是否都进了 MCP 参数（背景色 / 入场出场特效 / 元素场景内时间 / 场景出场转场）
     参数文档经 tool_search(names=[...]) 取（params key 带可选 ? 后缀） */
  const docOf = async (...toolNames) => {
    const docs = JSON.parse(
      textOf(await call("tools/call", { name: "tool_search", arguments: { names: toolNames } })),
    );
    return Object.fromEntries(docs.map((d) => [d.name, d.params]));
  };
  const hasKey = (params, k) => Object.keys(params ?? {}).some((x) => x.replace("?", "") === k);
  const { add_element: addEl, update_element: updEl, set_transition: setTr } = await docOf(
    "add_element",
    "update_element",
    "set_transition",
  );
  check(
    "add_element 支持背景色与入场/出场特效",
    ["bg", "enter", "exit", "from", "durationInFrames", "muted", "loop"].every((k) => hasKey(addEl, k)),
    Object.keys(addEl ?? {}).join(","),
  );
  check(
    "update_element 支持特效与场景内时间",
    ["enter", "exit", "from", "durationInFrames", "bg", "muted", "loop"].every((k) => hasKey(updEl, k)),
    Object.keys(updEl ?? {}).join(","),
  );
  check("set_transition 支持出场方向", hasKey(setTr, "direction"), Object.keys(setTr ?? {}).join(","));
  check("有 set_formats", allNames.includes("set_formats"));
  /* 换版式 + 批量 ops（v0.85） */
  check("有 set_scene_type", allNames.includes("set_scene_type"));
  check("有 apply_ops", allNames.includes("apply_ops"));
  /* 字幕导出（v0.86） */
  check("有 export_subtitles", allNames.includes("export_subtitles"));
  check("有 set_subtitle", allNames.includes("set_subtitle"));

  /* 素材同步 / 素材时长 / 删工程 这几个补齐的能力 */
  check("有 refresh_bundle", allNames.includes("refresh_bundle"));
  check("有 get_asset_info", allNames.includes("get_asset_info"));
  check("有 delete_project", allNames.includes("delete_project"));
  check(
    "update_element 支持音频音源与音量",
    ["audioSrc", "audioVolume"].every((k) => hasKey(updEl, k)),
    Object.keys(updEl ?? {}).join(","),
  );

  /* 工具搜索质量（门面模式的关键路径） */
  const picSearch = JSON.parse(
    textOf(await call("tools/call", { name: "tool_search", arguments: { query: "画中画" } })),
  );
  const picNames = picSearch.map((x) => x.name);
  check(
    "tool_search('画中画') 命中 move_scene / set_scene_box",
    picNames.includes("move_scene") && picNames.includes("set_scene_box"),
    picNames.join(","),
  );
  const missSearch = textOf(
    await call("tools/call", { name: "tool_search", arguments: { query: "zzz不存在的意图" } }),
  );
  check("tool_search 无结果时给引导", /all=true|manual/.test(missSearch), missSearch.slice(0, 80));

  /* 工程上下文（验证报告 P0-01/02 + P1-08）：create_project 要切换默认工程 */
  const created = textOf(
    await call("tools/call", {
      name: "create_project",
      arguments: { templateKey: "blank", name: "门面验证-可删" },
    }),
  );
  const createdId = (created.match(/id=(p_[\w-]+)/) ?? [])[1];
  check("create_project 返回工程 id", !!createdId, created.slice(0, 120));
  if (createdId) {
    const cur = textOf(await call("tools/call", { name: "get_project", arguments: {} }));
    check(
      "create_project 后无参 get_project 指向新工程",
      cur.includes(`id=${createdId}`),
      cur.slice(0, 80),
    );
    const listed = textOf(await call("tools/call", { name: "list_projects", arguments: {} }));
    check(
      "list_projects 列出工程并标当前",
      listed.includes(createdId) && listed.split("\n").some((l) => l.startsWith("★")),
      listed.slice(0, 120),
    );
    const switched = textOf(
      await call("tools/call", { name: "switch_project", arguments: { projectId: "demo" } }),
    );
    check("switch_project 切回 demo", /切换为「/.test(switched), switched.slice(0, 80));
    await call("tools/call", {
      name: "delete_project",
      arguments: { projectId: createdId, confirm: true },
    });
  }

  /* 只读工具不得改写「当前工程」指针（复验结论 2026-10-28 P0）
     —— 曾经的写法让「看一眼别的工程」就把当前工程改掉，后续无参写操作落错地方 */
  const probe = textOf(
    await call("tools/call", {
      name: "create_project",
      arguments: { templateKey: "blank", name: "只读指针验证-可删" },
    }),
  );
  const probeId = (probe.match(/id=(p_[\w-]+)/) ?? [])[1];
  if (probeId) {
    const listed0 = textOf(await call("tools/call", { name: "list_projects", arguments: {} }));
    const otherId =[...listed0.matchAll(/id=(p_[\w-]+|demo)/g)].map((m) => m[1]).find((x) => x !== probeId);
    if (otherId) {
      // 四个纯读工具，各自显式指定「别人的工程」
      for (const tool of ["get_project", "get_brief", "check_project", "get_scene"]) {
        const args = tool === "get_scene" ? { projectId: otherId, sceneId: "nope" } : { projectId: otherId };
        await call("tools/call", { name: tool, arguments: args });
      }
      await call("tools/call", { name: "intake", arguments: { step: 1, projectId: otherId } });
      const listed1 = textOf(await call("tools/call", { name: "list_projects", arguments: {} }));
      const star = listed1.split("\n").find((l) => l.startsWith("★")) ?? "";
      check("只读工具带显式 projectId 不改当前工程指针", star.includes(probeId), star.slice(0, 100));

      // 伤害路径：无参写操作必须落在当前工程，而不是刚「看过」的那个
      await call("tools/call", { name: "add_scene", arguments: { type: "title" } });
      const cur = textOf(await call("tools/call", { name: "get_project", arguments: {} }));
      check("只读之后无参写操作仍落在当前工程", cur.includes(`id=${probeId}`), cur.slice(0, 100));
    }
    await call("tools/call", { name: "delete_project", arguments: { projectId: probeId, confirm: true } });
  }

  /* 指针指向已删工程时必须自愈并写回（N-04 残留） */
  const stateFile = path.join(ROOT, "data", "agent-state.json");
  const stateBak = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : null;
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ currentProjectId: "p_ghost_deleted" }), "utf8");
    const healed = textOf(await call("tools/call", { name: "list_projects", arguments: {} }));
    check(
      "指针指向已删工程时 list_projects 自愈并标 ★",
      healed.split("\n").some((l) => l.startsWith("★")),
      healed.slice(0, 120),
    );
    const wrote = JSON.parse(fs.readFileSync(stateFile, "utf8")).currentProjectId;
    check("自愈结果写回 agent-state.json", wrote !== "p_ghost_deleted" && !!wrote, String(wrote));
  } finally {
    if (stateBak === null) fs.rmSync(stateFile, { force: true });
    else fs.writeFileSync(stateFile, stateBak, "utf8");
  }

  /* 音频能力：BPM/拍点、手动网格、TTS 预检（v0.98） */
  check("有 analyze_audio", allNames.includes("analyze_audio"));
  check("有 set_beat_grid", allNames.includes("set_beat_grid"));
  check("有 tts_check", allNames.includes("tts_check"));

  const ttsCheck = textOf(await call("tools/call", { name: "tool_call", arguments: { name: "tts_check", args: {} } }));
  check("tts_check 能给出可达/不可达结论（不抛裸异常）", /服务可达|预检失败/.test(ttsCheck), ttsCheck.slice(0, 140));

  const badAudio = textOf(
    await call("tools/call", {
      name: "tool_call",
      arguments: { name: "analyze_audio", args: { src: "/assets/definitely-not-here.mp3" } },
    }),
  );
  check("analyze_audio 对不存在的文件给可读错误", /素材不存在|找不到音频文件/.test(badAudio), badAudio.slice(0, 140));

  /* 音量上限 5 / 配平 / 压缩（v0.99）：1 = 原音，>1 是放大；配平解决段间不齐，压缩解决段内起伏 */
  check("有 balance_audio", allNames.includes("balance_audio"));
  check("有 compress_audio", allNames.includes("compress_audio"));

  // 自造一段固定测试音频（0.8s / 440Hz / 峰值 -20dBFS），不依赖用户素材
  const volWav = "__mcp_vol_test__.wav";
  const volPath = path.join(ROOT, "public", "assets", volWav);
  {
    const SR = 44100;
    const n = Math.round(SR * 0.8);
    const buf = Buffer.alloc(44 + n * 2);
    buf.write("RIFF", 0);
    buf.writeUInt32LE(36 + n * 2, 4);
    buf.write("WAVE", 8);
    buf.write("fmt ", 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(SR, 24);
    buf.writeUInt32LE(SR * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write("data", 36);
    buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) {
      buf.writeInt16LE(Math.round(0.1 * Math.sin((2 * Math.PI * 440 * i) / SR) * 32767), 44 + i * 2);
    }
    fs.writeFileSync(volPath, buf);
  }
  let volId = null;
  try {
    const volProj = textOf(
      await call("tools/call", {
        name: "create_project",
        arguments: { templateKey: "blank", name: "音量验证-可删" },
      }),
    );
    volId = (volProj.match(/id=(p_[\w-]+)/) ?? [])[1];
    if (volId) {
      const set = textOf(
        await call("tools/call", {
          name: "tool_call",
          arguments: {
            name: "set_audio",
            args: { projectId: volId, src: `/assets/${volWav}`, volume: 3, fadeIn: 0, fadeOut: 0 },
          },
        }),
      );
      check("set_audio(volume=3) 不再被夹到 1", /放大到 300%/.test(set), set.slice(0, 120));

      const gp = textOf(await call("tools/call", { name: "get_project", arguments: { projectId: volId } }));
      check("get_project 回读音量 300%", /音量 300%/.test(gp), gp.split("\n").find((l) => l.includes("背景音乐")) ?? gp.slice(0, 120));

      // 峰值 -20dBFS × 3 倍 = -10.5dBFS，不该报削波；这条同时证明"读了真实峰值"
      check("set_audio 放大后会做削波检查（本次不该报）", !/削波提醒/.test(set), set.slice(0, 120));

      const dry = textOf(
        await call("tools/call", {
          name: "tool_call",
          arguments: { name: "balance_audio", args: { projectId: volId, dryRun: true } },
        }),
      );
      check("balance_audio dryRun 给出 LUFS 与目标增益且标注未落库", /LUFS/.test(dry) && /dryRun/.test(dry), dry.slice(0, 160));

      const comp = textOf(
        await call("tools/call", {
          name: "tool_call",
          arguments: { name: "compress_audio", args: { projectId: volId, ratio: 3 } },
        }),
      );
      check("compress_audio 生成增益曲线", /采样点/.test(comp), comp.slice(0, 160));

      // 清晰曲线：clear 之后参数还在（volume 不被清掉）
      const cleared = textOf(
        await call("tools/call", {
          name: "tool_call",
          arguments: { name: "compress_audio", args: { projectId: volId, clear: true } },
        }),
      );
      check("compress_audio(clear=true) 能清掉曲线", /已清除增益曲线/.test(cleared), cleared.slice(0, 120));
    }
  } finally {
    if (volId) {
      await call("tools/call", { name: "delete_project", arguments: { projectId: volId, confirm: true } });
    }
    fs.rmSync(volPath, { force: true });
  }

  /* 严格参数校验（验证报告 P1-04~07）：未知 key / 错枚举要在校验层报错 */
  const badKey = textOf(
    await call("tools/call", {
      name: "tool_call",
      arguments: { name: "set_subtitle", args: { sceneId: "x", subtitle: "hi" } },
    }),
  );
  check(
    "未知参数名被校验层拒绝（不再静默剥掉）",
    /不认识的参数：subtitle/.test(badKey),
    badKey.slice(0, 140),
  );
  const badEnum = textOf(
    await call("tools/call", {
      name: "tool_call",
      arguments: { name: "export_subtitles", args: { format: "txt" } },
    }),
  );
  check("非法枚举值被拒绝（不再静默降级）", /Invalid enum value|srt.*vtt/.test(badEnum), badEnum.slice(0, 140));
  const fmtStr = textOf(
    await call("tools/call", {
      name: "tool_call",
      arguments: { name: "render_video", args: { dryRun: true, formats: "portrait" } },
    }),
  );
  check("render_video formats 收单个字符串", /预检/.test(fmtStr), fmtStr.slice(0, 100));

  const wavFile = fs
    .readdirSync(path.join(ROOT, "public", "assets"))
    .find((f) => f.endsWith(".wav"));
  if (wavFile) {
    const info = await call("tools/call", {
      name: "get_asset_info",
      arguments: { src: `/assets/${wavFile}` },
    });
    const infoText = textOf(info);
    check(
      "get_asset_info 量出时长与建议幕长",
      /≈ \d+ 帧/.test(infoText) && /建议场景时长/.test(infoText),
      infoText.slice(0, 160),
    );
  }
  const refused = await call("tools/call", {
    name: "delete_project",
    arguments: { projectId: "demo", confirm: false },
  });
  check("delete_project 未确认会被拒", /confirm/.test(textOf(refused)), textOf(refused).slice(0, 120));

  const exportRes = await call("tools/call", {
    name: "export_project",
    arguments: {},
  });
  const exportText = textOf(exportRes);
  check("export_project 返回路径", /已导出.*\.zip/.test(exportText), exportText.slice(0, 160));
  const exportedPath = exportText.match(/到 (.+?\.zip)/)?.[1];
  check("导出文件真的存在", !!exportedPath && fs.existsSync(exportedPath));

  let importedId = null;
  if (exportedPath) {
    const importRes = await call("tools/call", {
      name: "import_project",
      arguments: { path: exportedPath, name: "mcp_导入验证" },
    });
    const importText = textOf(importRes);
    check("import_project 成功", /已导入工程/.test(importText), importText.slice(0, 160));
    importedId = importText.match(/id=([\w-]+)/)?.[1] ?? null;
    check("返回新工程 id", !!importedId);

    if (importedId) {
      const proj = await (await fetch(`${API}/api/projects/${importedId}`)).json();
      check("导入的工程能读出来", !!proj.project);
      check("导入工程 rev 正常（改名会 +1）", (proj.project?.rev ?? 0) >= 1, `rev=${proj.project?.rev}`);
      check("导入工程名称已改", proj.project?.name === "mcp_导入验证", proj.project?.name);
      check("导入工程场景数 > 0", (proj.project?.scenes?.length ?? 0) > 0);
      await fetch(`${API}/api/projects/${importedId}`, { method: "DELETE" });
    }
    try {
      fs.unlinkSync(exportedPath);
    } catch {
      /* ignore */
    }
  }

  /* 新字段真实落库：背景色 / 入场出场 / 场景内时间 / 场景出场转场 */
  const dup = await fetch(`${API}/api/projects/demo/duplicate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "mcp_field_test" }),
  });
  const fieldProj = (await dup.json()).project;
  if (fieldProj) {
    const sceneId = fieldProj.scenes[0].id;
    const readDoc = async () =>
      (await (await fetch(`${API}/api/projects/${fieldProj.id}`)).json()).project;

    const added = await call("tools/call", {
      name: "add_element",
      arguments: {
        projectId: fieldProj.id,
        sceneId,
        text: "mcp_test",
        enter: { type: "fade", durationInFrames: 10 },
        exit: { type: "slide", durationInFrames: 8 },
        from: 5,
        durationInFrames: 40,
        bg: "#ff000080",
        fill: "rgba(255, 0, 0, 0.5)",
      },
    });
    const elId = textOf(added).match(/元素 (el_[\w]+)/)?.[1];
    const doc1 = await readDoc();
    const el1 = doc1?.scenes?.[0]?.elements?.find((e) => e.id === elId);
    check(
      "add_element 写入 enter/exit/from/duration/bg",
      !!el1 &&
        el1.enter?.type === "fade" &&
        el1.exit?.type === "slide" &&
        el1.from === 5 &&
        el1.durationInFrames === 40 &&
        el1.bg === "#ff000080",
      JSON.stringify(el1 && { enter: el1.enter, exit: el1.exit, from: el1.from, dur: el1.durationInFrames, bg: el1.bg }),
    );
    check("add_element 支持 rgba 颜色", el1?.fill === "rgba(255, 0, 0, 0.5)", el1?.fill);

    // startFrom：音频/视频都能从素材中间开始播（v0.84 新增）
    check(
      "update_element 支持 startFrom",
      hasKey(updEl, "startFrom"),
      Object.keys(updEl ?? {}).join(","),
    );
    check(
      "add_element 支持 startFrom 与 audioSrc",
      hasKey(addEl, "startFrom") && hasKey(addEl, "audioSrc"),
      Object.keys(addEl ?? {}).join(","),
    );

    if (elId) {
      await call("tools/call", {
        name: "update_element",
        arguments: {
          projectId: fieldProj.id,
          sceneId,
          elementId: elId,
          startFrom: 30,
        },
      });
      const docSf = await readDoc();
      const elSf = docSf?.scenes?.[0]?.elements?.find((e) => e.id === elId);
      check("update_element 写入 startFrom", elSf?.startFrom === 30, String(elSf?.startFrom));
    }

    if (elId) {
      await call("tools/call", {
        name: "update_element",
        arguments: {
          projectId: fieldProj.id,
          sceneId,
          elementId: elId,
          exit: { type: "zoom", durationInFrames: 6 },
          from: 9,
        },
      });
      const doc2 = await readDoc();
      const el2 = doc2?.scenes?.[0]?.elements?.find((e) => e.id === elId);
      check(
        "update_element 改 exit/from",
        el2?.exit?.type === "zoom" && el2?.from === 9,
        JSON.stringify(el2 && { exit: el2.exit, from: el2.from }),
      );
    }

    await call("tools/call", {
      name: "set_transition",
      arguments: { projectId: fieldProj.id, sceneId, type: "fade", durationInFrames: 10, direction: "out" },
    });
    const doc3 = await readDoc();
    check(
      "set_transition direction=out 写 transitionOut",
      doc3?.scenes?.[0]?.transitionOut?.type === "fade",
      JSON.stringify(doc3?.scenes?.[0]?.transitionOut),
    );

    /* apply_ops：单工具形状归一化（扁平参数 / 批量转场 / 报错定位） */
    const flat = await call("tools/call", {
      name: "apply_ops",
      arguments: {
        projectId: fieldProj.id,
        ops: [
          { op: "add_element", sceneId, text: "扁平1", x: 30, y: 40, opacity: 0.6 },
          { op: "add_element", sceneId, text: "扁平2", x: 50, y: 50, filter: "blur(4px)" },
          { op: "add_element", sceneId, libraryId: "mark-star", x: 20, y: 20 },
        ],
      },
    });
    const docFlat = await readDoc();
    const elsFlat = docFlat?.scenes?.[0]?.elements ?? [];
    check(
      "apply_ops 扁平 add_element（含 libraryId 解析）",
      elsFlat.some((e) => e.x === 30) &&
        elsFlat.some((e) => e.filter === "blur(4px)") &&
        elsFlat.some((e) => e.libraryId === "mark-star"),
      textOf(flat).slice(0, 180),
    );

    const batchUpdate = await call("tools/call", {
      name: "apply_ops",
      arguments: {
        projectId: fieldProj.id,
        ops: elsFlat
          .slice(0, 2)
          .map((e, i) => ({ op: "update_element", sceneId, elementId: e.id, opacity: 0.2 + i * 0.1 })),
      },
    });
    const docBU = await readDoc();
    const opacFlat = (docBU?.scenes?.[0]?.elements ?? []).slice(0, 2).map((e) => e.opacity);
    check(
      "apply_ops 扁平 update_element（自动收进 patch）",
      opacFlat.every((v, i) => Math.abs(v - (0.2 + i * 0.1)) < 1e-9),
      JSON.stringify(opacFlat) + " | " + textOf(batchUpdate).slice(0, 120),
    );

    const trBatch = await call("tools/call", {
      name: "apply_ops",
      arguments: {
        projectId: fieldProj.id,
        ops: [
          { op: "set_transition", sceneId, type: "zoom", durationInFrames: 15 },
          { op: "set_transition", sceneId, type: "fade", direction: "out" },
        ],
      },
    });
    const docTr = await readDoc();
    check(
      "apply_ops 里 set_transition 当 op 名用也生效",
      docTr?.scenes?.[0]?.transitionIn?.type === "zoom" &&
        docTr?.scenes?.[0]?.transitionOut?.type === "fade",
      textOf(trBatch).slice(0, 180),
    );

    const bothTr = await call("tools/call", {
      name: "set_transitions",
      arguments: { projectId: fieldProj.id, type: "slide", durationInFrames: 10, direction: "both" },
    });
    const docBoth = await readDoc();
    check(
      "set_transitions 给全部场景套同一套转场",
      (docBoth?.scenes ?? []).every(
        (s) => s.transitionIn?.type === "slide" && s.transitionOut?.type === "slide",
      ),
      textOf(bothTr).slice(0, 180),
    );

    const badBatch = textOf(
      await call("tools/call", {
        name: "apply_ops",
        arguments: {
          projectId: fieldProj.id,
          ops: [
            { op: "add_element", sceneId, text: "ok" },
            { op: "add_element", sceneId, text: "坏", opacity: 99 },
          ],
        },
      }),
    );
    check(
      "批量失败报「第 N 个操作 + 字段名」",
      /第 2\/2 个操作（add_element）/.test(badBatch) && /opacity/.test(badBatch),
      badBatch.slice(0, 200),
    );

    const missScene = textOf(
      await call("tools/call", {
        name: "apply_ops",
        arguments: {
          projectId: fieldProj.id,
          ops: [{ op: "update_element", elementId: "el_x", opacity: 0.5 }],
        },
      }),
    );
    check("批量缺 sceneId 有中文定位", /缺少 sceneId/.test(missScene), missScene.slice(0, 160));

    /* ── 第 2 轮踩坑清单的修复：props/patch 都认 + freeform 增删 op ── */

    // 批量 update_scene 用单工具的 props 写法（以前报 Cannot read properties of undefined）
    const propsBatch = textOf(
      await call("tools/call", {
        name: "apply_ops",
        arguments: {
          projectId: fieldProj.id,
          ops: [{ op: "update_scene", sceneId, props: { subtitle: "props 写法也认" } }],
        },
      }),
    );
    check("批量 update_scene 认 props 写法", !/Cannot read|不认识|缺少/.test(propsBatch), propsBatch.slice(0, 160));
    check(
      "props 写法真的生效",
      JSON.stringify(await readDoc()).includes("props 写法也认"),
    );

    /* 复验 v2：嵌套对象也要校验（以前报成功但没生效 / 落 NaN） */
    const badScene = textOf(
      await call("tools/call", {
        name: "apply_ops",
        arguments: {
          projectId: fieldProj.id,
          ops: [{ op: "update_scene", sceneId, patch: { titel: "写错的字段" } }],
        },
      }),
    );
    check(
      "patch 里拼错的字段被拒绝且给建议",
      /不认识/.test(badScene) && /是不是想写 title/.test(badScene),
      badScene.slice(0, 160),
    );
    const badAudio = textOf(
      await call("tools/call", {
        name: "apply_ops",
        arguments: {
          projectId: fieldProj.id,
          ops: [{ op: "set_audio", audio: { src: "/assets/x.wav", volume2: 2 } }],
        },
      }),
    );
    check(
      "audio 字段拼错被拒绝（以前落 NaN/null）",
      /不认识/.test(badAudio) && /是不是想写 volume/.test(badAudio),
      badAudio.slice(0, 160),
    );
    const badEl = textOf(
      await call("tools/call", {
        name: "apply_ops",
        arguments: {
          projectId: fieldProj.id,
          ops: [{ op: "add_element", sceneId, element: { kind: "text", text: "探针", opacty: 0.5 } }],
        },
      }),
    );
    check(
      "element 字段拼错被拒绝且给建议",
      /不认识/.test(badEl) && /是不是想写 opacity/.test(badEl),
      badEl.slice(0, 160),
    );
    const noChange = textOf(
      await call("tools/call", {
        name: "apply_ops",
        arguments: {
          projectId: fieldProj.id,
          ops: [{ op: "update_project", patch: { name: fieldProj.name } }],
        },
      }),
    );
    check("写不进数据的 op 会 ⚠ 提示未产生变更", /没有产生任何数据变更/.test(noChange), noChange.slice(0, 160));

    // 批量 add_freeform_element：先换一个 freeform 场景再放元素（扁平字段自动包裹）
    const ff = textOf(
      await call("tools/call", {
        name: "apply_ops",
        arguments: {
          projectId: fieldProj.id,
          ops: [
            { op: "set_scene_type", sceneId, type: "freeform", props: { elements: [{ id: "f0", type: "text", text: "基" }] } },
            { op: "add_freeform_element", sceneId, type: "svg", svg: "<svg viewBox='0 0 920 420'></svg>", viewBox: "0 0 920 420", x: 50, y: 47 },
          ],
        },
      }),
    );
    check("批量 add_freeform_element 扁平写法成功", /加了 freeform 元素|f\d/.test(ff), ff.slice(0, 200));
    const ffDoc = JSON.stringify(await readDoc());
    check("freeform 元素真的落库", ffDoc.includes("0 0 920 420"));

    // 批量 update_freeform_element 扁平写法
    const ffUpd = textOf(
      await call("tools/call", {
        name: "apply_ops",
        arguments: {
          projectId: fieldProj.id,
          ops: [{ op: "update_freeform_element", sceneId, elementId: "f0", text: "扁平改的" }],
        },
      }),
    );
    check("批量 update_freeform_element 扁平写法成功", /更新了/.test(ffUpd), ffUpd.slice(0, 160));

    /* 本工程素材目录（v0.98）：上传 → 列 → 删，三步都要能对上 */
    // 自己造一个源文件：别复用前面会被清掉的临时 wav
    const privSrc = path.join(ROOT, "__mcp_priv_src__.png");
    fs.writeFileSync(
      privSrc,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    const upPrivate = textOf(
      await call("tools/call", {
        name: "upload_asset",
        arguments: { projectId: fieldProj.id, path: privSrc, registerToLibrary: false },
      }),
    );
    check(
      "upload_asset(registerToLibrary:false) 落在本工程目录",
      upPrivate.includes(`/assets/projects/${fieldProj.id}/`),
      upPrivate.slice(0, 200),
    );
    const privName = upPrivate.match(/\/assets\/projects\/[^\s（]+/)?.[0]?.split("/").pop() ?? "";
    const privList = textOf(
      await call("tools/call", {
        name: "list_project_assets",
        arguments: { projectId: fieldProj.id },
      }),
    );
    check("list_project_assets 能看到刚上传的文件", !!privName && privList.includes(privName), privList.slice(0, 200));
    const privDel = textOf(
      await call("tools/call", {
        name: "delete_project_asset",
        arguments: { projectId: fieldProj.id, name: privName },
      }),
    );
    check("delete_project_asset 能删掉它", /已删除/.test(privDel), privDel.slice(0, 200));
    const privGone = textOf(
      await call("tools/call", {
        name: "list_project_assets",
        arguments: { projectId: fieldProj.id },
      }),
    );
    check("删完之后目录里没有了", !!privName && !privGone.includes(privName), privGone.slice(0, 160));
    fs.rmSync(privSrc, { force: true });

    const orgPlan = textOf(
      await call("tools/call", { name: "organize_assets", arguments: {} }),
    );
    check("organize_assets 默认只出方案（dryRun）", /dryRun/.test(orgPlan), orgPlan.slice(0, 160));

    // 单工具 add_freeform_element / remove_freeform_element
    const singleAdd = textOf(
      await call("tools/call", {
        name: "add_freeform_element",
        arguments: { projectId: fieldProj.id, sceneId, element: { type: "fx", kind: "noise", size: 210 } },
      }),
    );
    const newFxId = singleAdd.match(/id=(f\d+|\?)/)?.[1];
    check("单工具 add_freeform_element 返回分配的 id", newFxId && newFxId !== "?", singleAdd.slice(0, 160));
    if (newFxId && newFxId !== "?") {
      const singleDel = textOf(
        await call("tools/call", {
          name: "remove_freeform_element",
          arguments: { projectId: fieldProj.id, sceneId, elementId: newFxId },
        }),
      );
      check("单工具 remove_freeform_element 成功", /剩余/.test(singleDel), singleDel.slice(0, 160));
    }

    // check_project 能查出 freeform 元素问题（给 f0 塞一个提前消失的时长）
    await fetch(`${API}/api/projects/${fieldProj.id}/ops`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: "test",
        ops: [{ op: "update_freeform_element", sceneId, elementId: "f0", patch: { from: 0, durationInFrames: 10 } }],
      }),
    });
    const diag = textOf(
      await call("tools/call", { name: "check_project", arguments: { projectId: fieldProj.id } }),
    );
    check(
      "check_project 报 freeform 元素提前消失",
      /提前消失/.test(diag),
      diag.slice(0, 200),
    );

    await fetch(`${API}/api/projects/${fieldProj.id}`, { method: "DELETE" });
  }

  /* 编辑页 ↔ agent 桥接 */
  await fetch(`${API}/api/agent/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "mcp_bridge_test" }),
  });
  const inbox = await call("tools/call", { name: "get_user_messages", arguments: {} });
  check("get_user_messages 读到用户留言", /mcp_bridge_test/.test(textOf(inbox)), textOf(inbox).slice(0, 120));
  const msgs1 = (await (await fetch(`${API}/api/agent/messages`)).json()).messages;
  check("读取后用户消息标记已读", msgs1.every((m) => m.role !== "user" || m.read));

  const replied = await call("tools/call", {
    name: "reply_user",
    arguments: { text: "已收到，正在处理" },
  });
  check("reply_user 成功", /已回复/.test(textOf(replied)));
  const msgs2 = (await (await fetch(`${API}/api/agent/messages`)).json()).messages;
  check(
    "回复出现在消息列表",
    msgs2.at(-1)?.role === "agent" && /已收到/.test(msgs2.at(-1)?.text ?? ""),
    JSON.stringify(msgs2.at(-1)).slice(0, 120),
  );

  /* HTTP 方式（/mcp） */
  const mcpPost = async (body) => {
    const res = await fetch(`${API}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    });
    return res.json();
  };
  const initRes = await mcpPost({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-mcp", version: "1" },
    },
  });
  check(
    "HTTP /mcp initialize 正常",
    !!initRes?.result?.protocolVersion,
    JSON.stringify(initRes).slice(0, 140),
  );
  const listRes = await mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const httpTools = listRes?.result?.tools ?? [];
  check(
    "HTTP /mcp 工具数 = 核心门面 4 个",
    httpTools.length === 4 && ["start_guide", "get_guide", "tool_search", "tool_call"].every((n) => httpTools.map((t) => t.name).includes(n)),
    String(httpTools.length),
  );
  const callRes = await mcpPost({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "get_project", arguments: {} },
  });
  check(
    "HTTP /mcp 能调用工具",
    /工程：/.test(callRes?.result?.content?.[0]?.text ?? ""),
    JSON.stringify(callRes).slice(0, 140),
  );
}

try {
  await main();
} catch (err) {
  failures.push("main");
  console.error(`\nMCP 测试中断：${err instanceof Error ? err.message : err}`);
} finally {
  const ok = failures.length === 0;
  console.log(`\n${ok ? "MCP TEST OK" : `MCP TEST FAILED (${failures.length})`}：${passed} 项通过`);
  // 平滑收尾：先结束 stdin 让 MCP transport 自己退出，超时才强杀。
  // 直接 kill + process.exit 在 Windows 上会触发 libuv 的 handle 断言。
  try {
    rl.close();
    child.stdin.end();
  } catch {
    /* ignore */
  }
  const finish = () => process.exit(ok ? 0 : 1);
  child.once("exit", finish);
  setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }, 800);
  setTimeout(finish, 2000);
}
