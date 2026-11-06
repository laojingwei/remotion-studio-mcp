import fs from "node:fs";
import { ROOT as PROJECT_ROOT } from "./root";
import path from "node:path";
import { pluginFiles } from "./plugin";

/**
 * 风格库：`server/styles/<slug>.md` 是风格规则（来自 garden-skills/motion-showreel 的风格库），
 * `presets.json` 是其中一部分风格的可直接落字段的预设（palette / 字体 / 转场 / 字幕 / 禁止项）。
 *
 * 为什么两者都要：
 *  - md 描述风格的本质与辨识信号，agent 读完能判断「怎么改造」；
 *  - preset 直接给 set_theme 用的值，一键套用，不用手搓色值。
 */
export const STYLE_DIR = path.join(PROJECT_ROOT, "server", "styles");
const PRESETS_FILE = path.join(STYLE_DIR, "presets.json");

export type StylePreset = {
  name: string;
  palette: Record<string, string>;
  font: { heading: string; body: string };
  radius: number;
  motion?: string;
  transition?: { type: string; durationInFrames: number };
  sceneBias?: string[];
  subtitle?: Record<string, unknown>;
  forbidden?: string[];
};

let presetsCache: { sig: string; data: Record<string, StylePreset> } | null = null;

/**
 * 内置预设 + 插件预设的文件清单。
 *
 * 插件的风格预设固定叫 `styles/presets.json`（和内置同名同格式），
 * 不另起一套——多一种格式就多一份文档、多一处出错。
 */
function presetFiles(): string[] {
  const pluginPresets = pluginFiles("style", ".json")
    .filter(({ file }) => path.basename(file).toLowerCase() === "presets.json")
    .map(({ file }) => file);
  return [PRESETS_FILE, ...pluginPresets];
}

/** 文件指纹：路径 + mtime。任一份变了就重读。 */
function presetsSignature(files: string[]): string {
  return files
    .map((f) => {
      try {
        return `${f}@${fs.statSync(f).mtimeMs}`;
      } catch {
        return `${f}@0`;
      }
    })
    .join("|");
}

/**
 * 预设表（内置 → 插件，插件同名不覆盖内置）。
 *
 * **以前这里是"读一次就永远不读"的模块级缓存**，后果是改了 presets.json
 * 必须重启进程才生效——在一个"插件放进去就用"的系统里，这一条足以毁掉
 * 全部体验。现在改成按 (路径 + mtime) 失效：没变就是一次 stat，变了就重读。
 *
 * 坏文件不再静默消失：解析失败 / 结构不对都记进 presetIssues（list_styles 回显）。
 */
let presetIssues: string[] = [];

function presetOk(slug: string, file: string, p: unknown): p is StylePreset {
  const o = p as StylePreset;
  if (!o || typeof o !== "object" || Array.isArray(o)) return false;
  if (typeof o.name !== "string" || !o.name.trim()) return false;
  if (!o.palette || typeof o.palette !== "object" || Array.isArray(o.palette)) return false;
  if (!o.font || typeof o.font.heading !== "string" || typeof o.font.body !== "string") return false;
  if (typeof o.radius !== "number" || !Number.isFinite(o.radius)) return false;
  return true;
}

function presets(): Record<string, StylePreset> {
  const files = presetFiles();
  const sig = presetsSignature(files);
  if (presetsCache && presetsCache.sig === sig) return presetsCache.data;

  const data: Record<string, StylePreset> = {};
  const issues: string[] = [];
  for (const file of files) {
    const isPlugin = file !== PRESETS_FILE;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      if (isPlugin) {
        issues.push(
          `${path.relative(PROJECT_ROOT, file)} 解析失败（这份预设整个没进来）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      if (isPlugin) issues.push(`${path.relative(PROJECT_ROOT, file)} 的形态不对：要 { "slug": { 预设 }, ... }`);
      continue;
    }
    for (const [slug, preset] of Object.entries(parsed as Record<string, unknown>)) {
      if (!presetOk(slug, file, preset)) {
        if (isPlugin) {
          issues.push(
            `${path.relative(PROJECT_ROOT, file)} 的「${slug}」结构不对：要 { name, palette{色值表}, font{heading,body}, radius }`,
          );
        }
        continue;
      }
      // 先读到的赢：内置在前，所以内置永远不被插件顶掉
      if (!(slug in data)) data[slug] = preset;
    }
  }
  presetIssues = issues;
  presetsCache = { sig, data };
  return data;
}

/** 最近一次预设读取的问题（`list_styles` 回显；内置文件的问题不报——那是要提 issue 修宿主的） */
export function stylePresetIssues(): string[] {
  presets(); // 触发一次（带缓存，没变就是几次 stat）
  return [...presetIssues];
}

export type StyleInfo = { slug: string; name: string; hasPreset: boolean; source: "builtin" | "plugin" };

type StyleSource = { slug: string; file: string; source: "builtin" | "plugin" };

/**
 * 全部风格文件（内置 + 插件），每次现算（理由同 skills.service）。
 *
 * 插件风格放 `plugins/<名>/styles/*.md`，与内置平权；**同名时内置优先**。
 */
function styleSources(): StyleSource[] {
  const out: StyleSource[] = [];
  if (fs.existsSync(STYLE_DIR)) {
    for (const f of fs.readdirSync(STYLE_DIR)) {
      // INDEX 是目录页、_template 是模板，都不是风格本体
      if (!f.endsWith(".md") || f === "INDEX.md" || f === "_template.md") continue;
      out.push({ slug: f.replace(/\.md$/, ""), file: path.join(STYLE_DIR, f), source: "builtin" });
    }
  }

  const taken = new Set(out.map((s) => s.slug));
  for (const { file } of pluginFiles("style", ".md")) {
    const slug = path.basename(file, ".md");
    if (taken.has(slug)) continue;
    taken.add(slug);
    out.push({ slug, file, source: "plugin" });
  }
  return out;
}

/** 风格 slug → 文件；找不到返回 null */
export function styleFileOf(slug: string): string | null {
  return styleSources().find((s) => s.slug === slug)?.file ?? null;
}

export function listStyles(): StyleInfo[] {
  return styleSources()
    .map((s) => {
      let text = "";
      try {
        text = fs.readFileSync(s.file, "utf8");
      } catch {
        return null;
      }
      const first = text.split("\n").find((l) => l.startsWith("# ")) ?? s.slug;
      return {
        slug: s.slug,
        name: first.replace(/^#\s*/, ""),
        hasPreset: !!presets()[s.slug],
        source: s.source,
      };
    })
    .filter((x): x is StyleInfo => !!x)
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

export function readStyle(slug: string, section?: string): string {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`风格名不合法：${slug}`);
  const file = styleFileOf(slug);
  if (!file) {
    const names = listStyles().map((s) => s.slug).join("、");
    throw new Error(`没有风格「${slug}」。可用：${names}`);
  }
  const text = fs.readFileSync(file, "utf8");
  if (!section) return text;
  const wanted = section.trim().toLowerCase();
  const lines = text.split("\n");
  const start = lines.findIndex(
    (l) => l.startsWith("## ") && l.slice(3).toLowerCase().includes(wanted),
  );
  if (start < 0) {
    const sections = lines.filter((l) => l.startsWith("## ")).map((l) => l.slice(3)).join("、");
    throw new Error(`「${slug}」里没有包含「${section}」的小节。可用：${sections}`);
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

export function presetOf(slug: string): StylePreset | null {
  return presets()[slug] ?? null;
}

export function styleSummary(slug: string): string {
  const preset = presetOf(slug);
  if (!preset) {
    return `「${slug}」还没有结构化预设：先用 get_style 读规则，再用 set_theme / set_transition / 字幕样式手动套用。`;
  }
  const lines = [
    `风格：${preset.name}（${slug}）`,
    `配色：${Object.entries(preset.palette).map(([k, v]) => `${k}=${v}`).join(" ")}`,
    `字体：标题 ${preset.font.heading} / 正文 ${preset.font.body}`,
    `圆角：${preset.radius}`,
    ...(preset.motion ? [`运动：${preset.motion}`] : []),
    ...(preset.transition ? [`转场：${preset.transition.type} ${preset.transition.durationInFrames} 帧`] : []),
    ...(preset.sceneBias?.length ? [`推荐版式：${preset.sceneBias.join("、")}`] : []),
    ...(preset.forbidden?.length ? [`禁止：${preset.forbidden.join("、")}`] : []),
  ];
  return lines.join("\n");
}
