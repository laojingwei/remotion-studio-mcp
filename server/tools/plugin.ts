import { z } from "zod";
import type { ToolDef } from "./_shared";
import { scanPlugins, setPluginEnabled, pluginsToText } from "../plugin";
import { hasHook, runTextPipeline } from "../plugin/hooks";
import { api, resolveProject } from "./_shared";

/**
 * 插件管理工具。
 *
 * 为什么只有两个：插件"装"这件事已经收进了编辑器的插件面板（`/api/plugins/*`）——
 * 那是一条**用户在界面上明确点击**的路径，会跑 npm install / npm run build，
 * 也有确认与日志。MCP 这边刻意不暴露 `install_plugin(url)`：
 * 让 agent 自己决定下载并执行远程代码，和"用户点了安装"不是一回事。
 *
 * 所以这里只留**看**（装了什么、为什么没生效）和**拨开关**（临时停用）。
 */
export const PLUGIN_TOOLS: ToolDef[] = [
  {
    name: "list_plugins",
    description:
      "看装了哪些插件、各自提供什么、为什么没生效。插件是放在 `plugins/` 下的文件夹（就是这份安装目录里的 plugins/，所有工程共用），" +
      "放进去就生效，不需要重启或重新打包。\n" +
      "什么时候用：① 用户说「我装了个插件怎么没反应」；② 想知道某能力是内置的还是插件给的；③ 排查插件加载失败（会直接给原因）。\n" +
      "**不需要先调这个再调别的**——插件提供的技能/风格会自动出现在 list_guides / list_styles 里。这个工具只用于诊断与管理。",
    shape: {},
    run: async () => pluginsToText(),
  },
  {
    name: "toggle_plugin",
    description:
      "启用 / 停用一个插件。停用后它提供的内容（技能、风格等）立刻从所有清单里消失，但**文件不动**——重新启用就全回来。\n" +
      "什么时候用：插件提供的东西干扰了当前工作（比如同名风格抢了内置的、某个技能把 agent 带偏），临时关掉比删文件夹安全。\n" +
      "传 id 前先用 list_plugins 看准确 id。",
    shape: {
      id: z.string().describe("插件 id（list_plugins 里每行开头的那个名字）"),
      enabled: z.boolean().describe("true = 启用，false = 停用"),
    },
    run: async (a) => {
      const all = scanPlugins();
      const target = all.find((p) => p.id === a.id);
      if (!target) {
        const ids = all.map((p) => p.id).join("、") || "（一个插件都没有）";
        throw new Error(`没有 id 为「${a.id}」的插件。现有：${ids}。调 list_plugins 看详细清单`);
      }

      setPluginEnabled(target.id, a.enabled);
      // 立刻回读一次，确认状态真的落库了——只回一句"已设置"而不验证，
      // 会在 data/ 只读或磁盘满的时候给出与事实相反的答复
      const after = scanPlugins().find((p) => p.id === target.id);
      const actual = after?.enabled ?? false;
      if (actual !== a.enabled) {
        throw new Error(
          `设置没生效（期望 ${a.enabled ? "启用" : "停用"}，实际仍是 ${actual ? "启用" : "停用"}）。` +
            `检查 data/plugins.json 是否可写`,
        );
      }

      const what = target.provides.length
        ? `它提供的${target.provides.length}项内容（${target.provides.join("、")}）`
        : "它（没有可识别的贡献项）";
      return a.enabled
        ? `已启用「${target.name}」（${target.id}）。${what}现在可用了，不需要重启。`
        : `已停用「${target.name}」（${target.id}）。${what}已从清单移除，文件没动——要恢复就 enabled=true。`;
    },
  },
  {
    name: "transform_project_text",
    description:
      "把插件里注册的**文本处理规则**（术语表统一、品牌名、去口头禅…）套到整片已有字幕上。" +
      "只处理已经存在的字幕，不改幕结构、不重新断句。\n" +
      "什么时候用：用户装了文本插件后说「把之前的字幕也按我的规则过一遍」；或者改完术语表想让老工程跟上。\n" +
      "**默认 dryRun=true 只给预览**——文本改写是不可撤销的（历史能回退整次提交，但看不出改了哪个字），" +
      "先看一眼再落库。没有装任何文本插件时会直接告诉你。",
    shape: {
      projectId: z.string().optional().describe("要处理的工程 id，不传 = 当前默认工程（list_projects 查）"),
      sceneIds: z.array(z.string()).optional().describe("只处理这些幕；不传 = 全片所有有字幕的幕"),
      dryRun: z.boolean().optional().describe("只预览不写（默认 true）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const nl = String.fromCharCode(10);
      if (!hasHook("text:transform")) {
        return (
          "没有装文本处理插件，这条链是空的。" +
          `${nl}插件写法见 plugins/README.md 的「文本处理」，示例在 plugins/_example-text/`
        );
      }

      const targets = (p.scenes ?? []).filter(
        (sc: any) => (!a.sceneIds?.length || a.sceneIds.includes(sc.id)) && String(sc.subtitle ?? "").trim(),
      );
      if (!targets.length) return "没有需要处理的字幕（这些场景的 subtitle 是空的）";

      const ops: Record<string, unknown>[] = [];
      const previews: string[] = [];
      const warns: string[] = [];
      for (const sc of targets as any[]) {
        const r = runTextPipeline(String(sc.subtitle ?? ""), {
          kind: "subtitle",
          projectId: p.id,
          sceneId: sc.id,
        });
        warns.push(...r.warnings);
        if (!r.changed) continue;
        ops.push({ op: "set_subtitle", sceneId: sc.id, text: r.text });
        if (previews.length < 8) {
          previews.push(
            `  · ${sc.name || sc.id}：${r.steps.map((x) => `「${x.pluginId}」${x.before}→${x.after} 字`).join("、")}`,
          );
        }
      }

      const warnBlock = warns.length ? `${nl}⚠️ ${warns.join(`${nl}⚠️ `)}` : "";
      if (!ops.length) return `插件看过了，${targets.length} 幕字幕都不需要改。${warnBlock}`;

      if (a.dryRun !== false) {
        return (
          `预览：${ops.length}/${targets.length} 幕会被插件改写（dryRun=true，没有写入）${nl}${previews.join(nl)}` +
          `${ops.length > previews.length ? `${nl}  …还有 ${ops.length - previews.length} 幕` : ""}` +
          `${warnBlock}${nl}确认后传 dryRun=false 执行。`
        );
      }

      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops }),
      });
      return `已改写 ${ops.length} 幕字幕${nl}${previews.join(nl)}${warnBlock}${nl}${(res.summary ?? []).join(nl)}`;
    },
  },
  {
    name: "reprocess_assets",
    description:
      "把插件里注册的**文件处理规则**（压缩、剥元数据、转格式、统一响度…）套到工程里**已有**的素材上。" +
      "插件的自动处理只对**新上传**生效，这个工具是补历史素材用的。\n" +
      "什么时候用：用户装了文件处理插件后说「把我之前的图都压一下」；或者换了插件想重跑。\n" +
      "**默认 dryRun=true 只给预览**。处理结果会写成**新文件**（原名加 @指纹 后缀），原文件保留——" +
      "所以写错了不会毁素材，但要改工程引用得另调 set_* 或让用户手动换。\n" +
      "注意：调用只产出文件 + 溯源记录，**不会自动改工程里已引用的 URL**。要替换需按返回的新 URL 改场景。",
    shape: {
      projectId: z.string().optional().describe("工程 id，不传 = 当前默认工程（list_projects 查）"),
      names: z.array(z.string()).optional().describe("只处理这些文件名；不传 = 全工程素材"),
      dryRun: z.boolean().optional().describe("只预览不写（默认 true）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const nl = String.fromCharCode(10);
      const r = await api<any>(`/api/projects/${p.id}/assets/reprocess`, {
        method: "POST",
        body: JSON.stringify({ names: a.names, dryRun: a.dryRun !== false }),
      });

      if (r.error) return `处理失败：${r.error}`;
      const items = (r.items ?? []) as { name: string; action: string; note: string; newUrl?: string }[];
      if (!items.length) {
        return (r.warnings ?? []).join(nl) || "工程里没有可处理的素材（或没装文件处理插件）。";
      }

      const done = items.filter((i) => i.action === "process");
      const skipped = items.filter((i) => i.action !== "process");
      const dry = a.dryRun !== false;

      const lines = [
        dry
          ? `预览：${done.length}/${items.length} 个素材会被处理（dryRun=true，没有写入）`
          : `已处理 ${done.length}/${items.length} 个素材`,
        ...done.slice(0, 12).map((i) => `  · ${i.name} → ${i.note}`),
        ...(done.length > 12 ? [`  …还有 ${done.length - 12} 个`] : []),
      ];
      if (skipped.length) {
        lines.push(`跳过 ${skipped.length} 个：`);
        lines.push(...skipped.slice(0, 6).map((i) => `  · ${i.name}：${i.note}`));
        if (skipped.length > 6) lines.push(`  …还有 ${skipped.length - 6} 个`);
      }
      if ((r.warnings ?? []).length) lines.push(`⚠️ ${(r.warnings as string[]).join(`${nl}⚠️ `)}`);
      if (dry && done.length) lines.push("确认后传 dryRun=false 执行。");
      if (!dry && done.length) {
        lines.push(
          `处理产物是新文件，工程里的旧引用不会自动换。要换就按上面的新文件名改对应场景的 src。`,
        );
      }
      return lines.join(nl);
    },
  },
];
