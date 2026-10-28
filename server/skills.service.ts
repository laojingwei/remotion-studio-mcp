import fs from "node:fs";
import { ROOT as PROJECT_ROOT } from "./root";
import path from "node:path";

/**
 * 技能/指南：放在 `server/skills/*.md`，通过 MCP 工具 `get_guide` 按需读取。
 *
 * 为什么不是常驻在工具描述里：agent 每次会话都带着几十条工具描述已经够重了，
 * 指南只在真要干活时读一次，还能只读某一节。
 */
export const SKILL_DIR = path.join(PROJECT_ROOT, "server", "skills");

export type SkillInfo = { name: string; title: string; chars: number };

const NAME_RE = /^[a-z0-9-]+$/;

export function listSkills(): SkillInfo[] {
  if (!fs.existsSync(SKILL_DIR)) return [];
  return fs
    .readdirSync(SKILL_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const file = path.join(SKILL_DIR, f);
      const text = fs.readFileSync(file, "utf8");
      const first = text.split("\n").find((l) => l.startsWith("# ")) ?? f;
      return {
        name: f.replace(/\.md$/, ""),
        title: first.replace(/^#\s*/, ""),
        chars: text.length,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 读技能全文；传 section 时只返回匹配 `## 标题` 的那一节 */
export function readSkill(name: string, section?: string): string {
  if (!NAME_RE.test(name)) throw new Error(`技能名不合法：${name}`);
  const file = path.join(SKILL_DIR, `${name}.md`);
  if (!fs.existsSync(file)) {
    const names = listSkills().map((s) => s.name).join("、");
    throw new Error(`没有技能「${name}」。可用：${names}`);
  }
  const text = fs.readFileSync(file, "utf8");
  if (!section) return text;

  const wanted = section.trim().toLowerCase();
  const lines = text.split("\n");
  const start = lines.findIndex(
    (l) => l.startsWith("## ") && l.slice(3).toLowerCase().includes(wanted),
  );
  if (start < 0) {
    const sections = lines
      .filter((l) => l.startsWith("## "))
      .map((l) => l.slice(3))
      .join("、");
    throw new Error(`「${name}」里没有包含「${section}」的小节。可用：${sections}`);
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
