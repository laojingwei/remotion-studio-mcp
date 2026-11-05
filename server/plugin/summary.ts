/**
 * 插件清单的文本输出（`list_plugins` 的返回值）。
 *
 * 为什么要单独一个文件：这句话是**这个子系统唯一的自解释入口**。
 * 用户装完插件第一件事是看这里；agent 想知道有什么能力也是看这里。
 * 它需要说清三件事——有什么、在哪、怎么加——所以不适合塞进 mcp-tools 的
 * 一个内联模板字符串里（那里已经 5800 行了）。
 */

import { IMPLEMENTED_PROVIDES, PROVIDE_LABEL, PLUGIN_API_VERSION } from "./manifest";
import {
  PROJECT_PLUGIN_DIR,
  USER_PLUGIN_DIR,
  pluginRoots,
  scanPlugins,
  type DiscoveredPlugin,
} from "./discovery";
import { describePermissions } from "./permissions";
import { HOOK_LABEL, hookKindsOf, hookStatus } from "./hooks";

const NL = String.fromCharCode(10);

/** 目录存在性：不存在时提示"目录还没建"比直接消失更有用 */
function rootLines(): string[] {
  return pluginRoots().map((r) => {
    const label = r.scope === "project" ? "项目内" : "用户级";
    const dir = r.scope === "project" ? PROJECT_PLUGIN_DIR : USER_PLUGIN_DIR;
    return `  ${label}  ${dir}${r.exists ? "" : "（目录不存在，放插件时会自动建）"}`;
  });
}

function pluginBlock(p: DiscoveredPlugin): string[] {
  const out: string[] = [];
  const flags: string[] = [];
  if (!p.enabled) flags.push("已停用");
  if (p.errors.length) flags.push("加载失败");
  const badge = flags.length ? `  [${flags.join(" / ")}]` : "";

  out.push(`■ ${p.id}  ${p.name}  v${p.version}  ${p.scope === "project" ? "项目内" : "用户级"}${badge}`);
  out.push(`   路径：${p.pathLabel}`);

  if (p.provides.length) {
    const items = p.provides.map((k) => {
      const label = PROVIDE_LABEL[k] ?? k;
      // 声明了但这一版还没接消费方 —— 必须标出来，否则用户会以为放进去就该生效
      return IMPLEMENTED_PROVIDES.includes(k) ? label : `${label}（本版本未接入，暂不生效）`;
    });
    out.push(`   提供：${items.join("、")}`);
  } else {
    out.push("   提供：（空——目录里没有可识别的文件，检查是不是放错了层级）");
  }

  // 只有代码插件才会声明权限；L0 插件这里会显示"不需要任何权限"
  out.push(`   权限：${describePermissions(p.manifest?.permissions ?? [])}`);

  /*
   * 钩子插件单独说一句它挂了哪几个钩子。
   * 光写"提供：流程钩子"等于没说——用户要知道它到底在哪个环节说话，
   * 否则「装了但没感觉」会被当成插件坏了（实际是它只做写入复盘，
   * 而用户一直在看自检结果）。
   */
  if (p.provides.includes("hooks")) {
    const st = hookStatus();
    const mine = st.errors.filter((e) => e.pluginId === p.id);
    const kinds = hookKindsOf(p.id);
    if (kinds.length) {
      out.push(`   钩子：${kinds.map((k) => HOOK_LABEL[k] ?? k).join("、")}`);
    } else if (p.enabled && !p.errors.length && !mine.length) {
      out.push(`   钩子：（未挂上——入口文件要叫 plugin.ts；示例插件需去掉 .example 后缀）`);
    }
    for (const e of mine) out.push(`   ✗ ${e.message}`);
  }

  for (const w of p.warnings) out.push(`   ⚠ ${w}`);
  for (const e of p.errors) out.push(`   ✗ ${e}`);
  return out;
}

const HOW_TO = [
  "## 怎么加一个插件",
  "在 plugins/ 下建一个文件夹（名字随意，中文也行），按你要加的东西放文件——**不需要写任何配置**：",
  "  skills/*.md          技能指南      → list_guides / get_guide 能读到",
  "  styles/*.md          风格规则      → list_styles 可见、get_style 可读、apply_style 可套",
  "  styles/presets.json  风格预设      → apply_style 一键落色板/字体/转场",
  "  brief/steps.json     问诊步骤      → intake / save_brief 按你的步骤走（可替换或追加）",
  "  scenes/<type>.json + <type>.tsx  场景组件 → 选择器里多一种画面（**必须放项目内**，要重新打包）",
  "  plugin.ts            流程钩子      → 自检时补检查项 / 写入后复盘 / 设计锁补规则（见下）",
  "放好就生效，不用重启。技能/风格/问诊/钩子改完立刻生效；场景组件要等一次自动重新打包（几十秒）。",
  "需要更细的控制（版本、作者、权限）时再加 manifest.json；规则与示例见 plugins/README.md。",
  "元素库、整片模板、3D 配方、转场、特效属于后续批次，现在放进去会被识别但不生效（上面会标「本版本未接入」）。",
].join(NL);

/** 一个插件都没有时的引导（首次使用最可能看到的就是这个） */
const EMPTY_HINT = [
  "插件目录里还是空的。",
  "",
  "最省事的开始方式：建 plugins/我的风格/styles/neo-noir.md，写一段风格描述（参考",
  "server/styles/_template.md），保存——它就会出现在 list_styles 里。",
  "想先看个完整例子：把 plugins/_example-content 整个拷一份改名即可。",
].join(NL);

export function pluginsToText(): string {
  const all = scanPlugins();
  const ok = all.filter((p) => p.enabled && !p.errors.length);
  const off = all.filter((p) => !p.enabled && !p.errors.length);
  const bad = all.filter((p) => p.errors.length);

  const hs = hookStatus();
  const head = [
    `插件（启用 ${ok.length} / 停用 ${off.length}${bad.length ? ` / 失败 ${bad.length}` : ""}）· 插件 API v${PLUGIN_API_VERSION}`,
    ...(hs.active ? [`钩子：${hs.count} 条已挂上（${hs.plugins.join("、")}）`] : []),
    "扫描目录：",
    ...rootLines(),
  ].join(NL);

  if (!all.length) return [head, "", EMPTY_HINT, "", HOW_TO].join(NL);

  const sections: string[] = [head];

  if (ok.length) sections.push(["", "## 已启用", ...ok.flatMap(pluginBlock)].join(NL));
  if (off.length) {
    sections.push(
      ["", "## 已停用（数据还在，只是不生效）", ...off.flatMap(pluginBlock)].join(NL),
    );
  }
  if (bad.length) {
    sections.push(
      [
        "",
        "## 加载失败（服务没坏，只是这些插件没进来）",
        ...bad.flatMap(pluginBlock),
        "修好后不用重启，再调一次 list_plugins 就会重新扫描。",
      ].join(NL),
    );
  }

  sections.push("", HOW_TO);
  return sections.join(NL);
}
