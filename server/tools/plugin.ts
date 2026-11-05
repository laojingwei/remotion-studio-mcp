import { z } from "zod";
import type { ToolDef } from "./_shared";
import { scanPlugins, setPluginEnabled, pluginsToText } from "../plugin";

/**
 * 插件管理工具。
 *
 * 为什么只有两个：插件的"安装"就是把文件夹拷进 plugins/，不需要工具；
 * 需要工具的是**看**（装了什么、为什么没生效）和**拨开关**（临时停用）。
 * 多一个 `install_plugin(url)` 会很诱人，但那等于给这个服务加一条下载并执行
 * 远程代码的通道——远超"插件"该有的权限。
 */
export const PLUGIN_TOOLS: ToolDef[] = [
  {
    name: "list_plugins",
    description:
      "看装了哪些插件、各自提供什么、为什么没生效。插件是放在 `plugins/`（项目内）或 `~/.remotion-studio/plugins/`（用户级）下的文件夹，" +
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
];
