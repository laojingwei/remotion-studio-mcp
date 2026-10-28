import fs from "node:fs";
import { ROOT as PROJECT_ROOT } from "./root";
import path from "node:path";

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

let presetsCache: Record<string, StylePreset> | null = null;

function presets(): Record<string, StylePreset> {
  if (presetsCache) return presetsCache;
  try {
    presetsCache = JSON.parse(fs.readFileSync(PRESETS_FILE, "utf8")) as Record<string, StylePreset>;
  } catch {
    presetsCache = {};
  }
  return presetsCache;
}

export type StyleInfo = { slug: string; name: string; hasPreset: boolean };

export function listStyles(): StyleInfo[] {
  if (!fs.existsSync(STYLE_DIR)) return [];
  return fs
    .readdirSync(STYLE_DIR)
    .filter((f) => f.endsWith(".md") && f !== "INDEX.md" && f !== "_template.md")
    .map((f) => {
      const slug = f.replace(/\.md$/, "");
      const text = fs.readFileSync(path.join(STYLE_DIR, f), "utf8");
      const first = text.split("\n").find((l) => l.startsWith("# ")) ?? slug;
      return {
        slug,
        name: first.replace(/^#\s*/, ""),
        hasPreset: !!presets()[slug],
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

export function readStyle(slug: string, section?: string): string {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`风格名不合法：${slug}`);
  const file = path.join(STYLE_DIR, `${slug}.md`);
  if (!fs.existsSync(file)) {
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
