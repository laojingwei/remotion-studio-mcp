import fs from "node:fs";
import { ROOT as PROJECT_ROOT } from "./root";
import path from "node:path";
import { pluginFiles } from "./plugin";

/**
 * 技能/指南：放在 `server/skills/*.md`，通过 MCP 工具 `get_guide` 按需读取。
 *
 * 为什么不是常驻在工具描述里：agent 每次会话都带着几十条工具描述已经够重了，
 * 指南只在真要干活时读一次，还能只读某一节。
 *
 * ## 插件能往这里加东西（2026-11-05）
 *
 * `plugins/<任意名>/skills/*.md` 与本目录平权，**同名时内置优先**。
 * 内置优先不是为了限制插件，是因为内置技能被 `start_guide` 的流程引用
 * （"先读 manual"/"读 delivery"），被插件顶掉会让整条引导断线。
 * 插件要新增能力就往新名字写，别覆盖内置的。
 */
export const SKILL_DIR = path.join(PROJECT_ROOT, "server", "skills");

export type SkillInfo = {
  name: string;
  title: string;
  chars: number;
  /** 来源：内置 / 插件（`list_guides` 会显示，让人能确认自己的插件生效了） */
  source: "builtin" | "plugin";
};

const NAME_RE = /^[a-z0-9-]+$/;

type SkillSource = { name: string; file: string; source: "builtin" | "plugin" };

/**
 * 全部技能文件（内置 + 插件），**每次现算**。
 *
 * 不做缓存是刻意的：插件的卖点是"放进去就生效"，一旦缓存就变成
 * "放进去没反应，重启一下试试"——那和没有插件机制没区别。
 */
function skillSources(): SkillSource[] {
  const builtin: SkillSource[] = [];
  if (fs.existsSync(SKILL_DIR)) {
    for (const f of fs.readdirSync(SKILL_DIR)) {
      if (!f.endsWith(".md")) continue;
      builtin.push({ name: f.replace(/\.md$/, ""), file: path.join(SKILL_DIR, f), source: "builtin" });
    }
  }

  const taken = new Set(builtin.map((s) => s.name));
  const fromPlugins: SkillSource[] = [];
  for (const { file } of pluginFiles("skill", ".md")) {
    const name = path.basename(file, ".md");
    // 同名插件技能让位给内置（见文件头注释）
    if (taken.has(name)) continue;
    taken.add(name);
    fromPlugins.push({ name, file, source: "plugin" });
  }

  return [...builtin, ...fromPlugins];
}

/** 技能名 → 文件路径；不存在返回 null（`readSkill` 用它区分"没这篇"和"读不出来"） */
function skillFileOf(name: string): string | null {
  return skillSources().find((s) => s.name === name)?.file ?? null;
}

export function listSkills(): SkillInfo[] {
  return skillSources()
    .map((s) => {
      let text = "";
      try {
        text = fs.readFileSync(s.file, "utf8");
      } catch {
        return null;
      }
      const first = text.split("\n").find((l) => l.startsWith("# ")) ?? s.name;
      return {
        name: s.name,
        title: first.replace(/^#\s*/, ""),
        chars: text.length,
        source: s.source,
      };
    })
    .filter((x): x is SkillInfo => !!x)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * agent 是按"能力"猜篇名的，不是按目录结构：它想找 3D 就会打 `3d` / `scene3d` / `three`，
 * 想找图解会打 `iso` / `anatomy`。**一次猜错就断线的话，它下一步一定是去翻源码**
 * （线上真发生过：get_guide("scene3d") 报错 → 去读了 3200 行 TS）。
 * 所以这里先把别名和标题模糊匹配吃掉，实在匹配不上再报错，并且报错要指路。
 */
const ALIASES: Record<string, string> = {
  // 参考风格翻译：这几个词进不来就会掉到 ROUTES 的"你可能想读 X"提示里，多一次往返
  参考风格: "style-translate",
  风格库: "style-translate",
  画风翻译: "style-translate",
  字雨: "style-translate",
  // 用户看完片的四种抱怨，直接进"意义→画面"，别让它掉进 formats/director 的宽词路由
  像ppt: "meaning",
  逐句贴卡: "meaning",
  太散: "meaning",
  没讲清: "meaning",
  故事没展开: "meaning",
  "3d": "scene3d",
  three: "scene3d",
  threejs: "scene3d",
  graph: "scene3d",
  场景图: "scene3d",
  三维: "scene3d",
  立体: "scene3d",
  iso: "external-tools",
  anatomy: "external-tools",
  图解: "external-tools",
  插图: "external-tools",
  等轴测: "external-tools",
  自由画布: "freeform",
  free: "freeform",
  canvas: "freeform",
  sub: "subtitle",
  subtitle: "subtitle",
  字幕: "subtitle",
  配音: "narration",
  tts: "narration",
  音乐: "sound",
  bgm: "sound",
  稿: "script",
  文档: "manual",
  全书: "manual",
  目录: "manual",
  索引: "manual",
};

/** 能力关键词 → 该读哪篇（别名和标题都没命中时，给一句人话的指路） */
const ROUTES: [RegExp, string, string][] = [
  // 放在最前面：下面是按"质感/节奏/镜头"这类宽词匹配的，参考风格那类问题会被它们截胡
  [/参考风格|画风翻译|翻风格|风格提示词|字雨|风格库|341/i, "style-translate", "把参考画风翻成 theme + 版式"],
  [/3d|三维|立体|太空|行星|球|装置|空间感/i, "scene3d", "3D 场景与 graph 场景图"],
  [/iso|anatomy|图解|插图|等轴|零件|剖面/i, "external-tools", "等轴测图解（anatomy）"],
  [/自由|排版|画布|freeform/i, "freeform", "自由画布全部写法"],
  [/字幕|subtitle|srt/i, "subtitle", "字幕写法"],
  [/声音|音频|bgm|音乐|混音/i, "sound", "声音设计"],
  [/配音|旁白|口播稿/i, "narration", "旁白配音"],
  [/质感|节奏|镜头|高级/i, "craft", "画面质感"],
  [/分镜|流程|接单|问诊/i, "director", "整片流程"],
  [/交付|渲染|导出/i, "delivery", "交付与渲染"],
  [/自检|体检|检查/i, "qa", "自检清单"],
];

/** 归一化：大小写、空格、括号、标点都不参与匹配（"3D 场景" vs "3d场景" 要能对上） */
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\s（）()【】\[\]·、,，。:：\-_/]/g, "")
    .trim();

/** 把 agent 写的名字解析成真实技能名；解析不出来返回建议 */
export function resolveSkillName(input: string): { name?: string; hint?: string } {
  const raw = String(input ?? "").trim().replace(/\.md$/i, "");
  if (!raw) return { hint: "名字是空的" };
  const key = norm(raw);
  const skills = listSkills();
  const exists = (n: string) => skills.some((s) => s.name === n);

  const alias = ALIASES[key];
  if (alias && exists(alias)) return { name: alias };

  const lower = raw.toLowerCase();
  if (NAME_RE.test(lower) && exists(lower)) return { name: lower };

  // 标题模糊匹配：「3D 场景」→ scene3d（标题是「3D 场景（scene3d）」）
  const byTitle = skills.find((s) => norm(s.title).includes(key) || key.includes(norm(s.title)));
  if (byTitle) return { name: byTitle.name };

  const route = ROUTES.find(([re]) => re.test(raw));
  if (route) return { hint: `按「${raw}」看，你要的应该是「${route[1]}」（${route[2]}）→ get_guide("${route[1]}")` };

  return { hint: "" };
}

/** 读技能全文；传 section 时只返回匹配 `## 标题` 的那一节 */
export function readSkill(name: string, section?: string): string {
  const skills = listSkills();
  const resolved = resolveSkillName(name);
  const file = resolved.name ? skillFileOf(resolved.name) : null;
  if (!resolved.name || !file) {
    const list = skills.map((s) => `${s.name}（${s.title}）`).join("、");
    throw new Error(
      `没有技能「${name}」。` +
        (resolved.hint ? `\n${resolved.hint}` : "") +
        `\n可用（名字 + 标题）：${list}` +
        `\n不带名字的调用方式：tool_call(name:"list_guides") 看全量清单；` +
        `不知道该读哪篇就先 start_guide 或 get_guide("manual")。`,
    );
  }
  const text = fs.readFileSync(file, "utf8");
  if (!section) return text;

  const wanted = norm(section);
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## ") && norm(l.slice(3)).includes(wanted));
  if (start < 0) {
    const sections = lines
      .filter((l) => l.startsWith("## "))
      .map((l) => l.slice(3).trim())
      .join("、");
    throw new Error(
      `「${resolved.name}」里没有包含「${section}」的小节。可用：${sections}` +
        `\n也可以不带 section 读全篇：get_guide("${resolved.name}")`,
    );
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trimEnd();
}
