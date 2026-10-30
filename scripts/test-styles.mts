/**
 * 风格库 / 预设一致性单测（纯 Node，不需要起服务、不需要浏览器）。
 *
 *   npm test
 *
 * 为什么要有：`presets.json` 是**数据**，代码不会替你校验它。
 * 之前 crt-vhs 写着 `"transition": { "type": "glitch" }` —— 而 TRANSITION_TYPES 里没有 glitch，
 * 于是 apply_style("crt-vhs") 把 update_scene 塞进整批原子 ops → zod 拒 → 整个风格套不上，
 * 而 list_styles 还在标【可一键套用】。这类错误只有跑一遍才看得见。
 *
 * 盯六件事：
 *  1. 每个风格 md 都有预设，每个预设都有 md（不许孤儿）
 *  2. palette 七个键齐全、色值合法、正文与底色对比度够（不然深色风会瞎）
 *  3. transition.type 必须是 TRANSITION_TYPES 里的
 *  4. sceneBias 必须是真实存在的版式 key
 *  5. 字体栈有兜底（sans-serif / serif / monospace）
 *  6. **真跑一遍 applyOps**：set_theme + 每个场景的 transitionIn，任何一条被 schema 拒都算失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applyOps, createSeedProject } from "../shared/ops";
import { SCENE_METAS } from "../shared/sceneMetas";
import { TRANSITION_TYPES } from "../shared/transitions";
import { STYLE_DIR, listStyles, presetOf } from "../server/styles.service";

let passed = 0;
const failures: string[] = [];
const test = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  [ok] ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  [fail] ${name}`);
    const detail = err instanceof Error ? err.message : String(err);
    for (const line of detail.split("\n")) console.error(`    ${line}`);
  }
};

const styles = listStyles();
const slugs = styles.map((s) => s.slug);
const presetSlugs = Object.keys(
  JSON.parse(fs.readFileSync(path.join(STYLE_DIR, "presets.json"), "utf8")) as Record<string, unknown>,
);

const PALETTE_KEYS = ["background", "surface", "text", "textMuted", "primary", "secondary", "accent"];
const SCENE_TYPES = new Set(SCENE_METAS.map((m) => m.type));

/** WCAG 相对亮度 → 对比度 */
const luminance = (hex: string): number => {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(full.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

/* ────────────────────────── 覆盖关系 ────────────────────────── */

test(`每个风格都有预设（${slugs.length} 个风格 / ${presetSlugs.length} 条预设）`, () => {
  const missing = slugs.filter((s) => !presetOf(s));
  assert.equal(missing.length, 0, `这些风格还没有预设：${missing.join("、")}`);
});

test("没有孤儿预设（有 preset 却没有对应 md）", () => {
  const orphan = presetSlugs.filter((s) => !slugs.includes(s));
  assert.equal(orphan.length, 0, `这些预设找不到 md：${orphan.join("、")}`);
});

/* ────────────────────────── 字段合法性 ────────────────────────── */

test("palette：七个键齐全且都是合法色值", () => {
  for (const slug of presetSlugs) {
    const p = presetOf(slug)!;
    for (const k of PALETTE_KEYS) {
      const v = (p.palette as Record<string, string>)[k];
      assert.ok(v, `${slug} 缺 palette.${k}`);
      assert.match(v, /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, `${slug} 的 ${k} 不是色值：${v}`);
    }
  }
});

test("palette：正文与底色对比度 ≥ 3（深色风最容易糊）", () => {
  const bad: string[] = [];
  for (const slug of presetSlugs) {
    const p = presetOf(slug)!;
    const c = contrast(p.palette.text, p.palette.background);
    if (c < 3) bad.push(`${slug} text/background = ${c.toFixed(2)}（${p.palette.text} on ${p.palette.background}）`);
  }
  assert.equal(bad.length, 0, bad.join("\n"));
});

test("palette：强调色不要太贴近底色（否则「强调」等于没强调）", () => {
  const bad: string[] = [];
  for (const slug of presetSlugs) {
    const p = presetOf(slug)!;
    const c = contrast(p.palette.primary, p.palette.background);
    if (c < 1.6) bad.push(`${slug} primary/background = ${c.toFixed(2)}`);
  }
  assert.equal(bad.length, 0, bad.join("\n"));
});

test("font：标题与正文都有兜底字族", () => {
  for (const slug of presetSlugs) {
    const f = presetOf(slug)!.font;
    for (const [k, v] of Object.entries(f)) {
      assert.ok(v && v.trim(), `${slug} 缺 font.${k}`);
      assert.match(v, /(sans-serif|serif|monospace|system-ui)\s*$/i, `${slug} 的 font.${k} 没有兜底：${v}`);
    }
  }
});

test("font：同一个字体栈里不许重复字族（拼出错时看不出，只会白占字数）", () => {
  const bad: string[] = [];
  for (const slug of presetSlugs) {
    const f = presetOf(slug)!.font;
    for (const [k, v] of Object.entries(f)) {
      const fams = v
        .split(",")
        .map((x) => x.trim().replace(/^["']|["']$/g, "").toLowerCase())
        .filter(Boolean);
      const dup = fams.filter((x, i) => fams.indexOf(x) !== i);
      if (dup.length) bad.push(`${slug}.${k}：${dup.join("、")} 重复（${v}）`);
    }
  }
  assert.equal(bad.length, 0, bad.join("\n"));
});

test("radius：0–6 的整数", () => {
  for (const slug of presetSlugs) {
    const r = presetOf(slug)!.radius;
    assert.ok(Number.isInteger(r) && r >= 0 && r <= 6, `${slug} 的 radius 不合法：${r}`);
  }
});

test("transition.type 必须在 TRANSITION_TYPES 里", () => {
  const allowed = new Set<string>(TRANSITION_TYPES);
  const bad = presetSlugs.filter((s) => !allowed.has(presetOf(s)!.transition.type));
  assert.equal(
    bad.length,
    0,
    bad.map((s) => `${s} → ${presetOf(s)!.transition.type}（合法值：${TRANSITION_TYPES.join("/")}）`).join("\n"),
  );
});

test("transition.durationInFrames：0–60 的整数，none 必须 0", () => {
  for (const slug of presetSlugs) {
    const t = presetOf(slug)!.transition;
    assert.ok(Number.isInteger(t.durationInFrames) && t.durationInFrames >= 0 && t.durationInFrames <= 60, `${slug} 时长不合法：${t.durationInFrames}`);
    if (t.type === "none") assert.equal(t.durationInFrames, 0, `${slug} 是硬切却给了 ${t.durationInFrames} 帧`);
  }
});

test("sceneBias 里的版式都是真实存在的 scene type", () => {
  const bad = presetSlugs.flatMap((s) =>
    presetOf(s)!.sceneBias.filter((t) => !SCENE_TYPES.has(t)).map((t) => `${s} → ${t}`),
  );
  assert.equal(bad.length, 0, `不存在的版式：${bad.join("、")}`);
});

test("motion 与 forbidden 不能是空壳（预设要能当约束用）", () => {
  for (const slug of presetSlugs) {
    const p = presetOf(slug)!;
    assert.ok(p.motion && p.motion.trim().length >= 8, `${slug} 的 motion 太短`);
    assert.ok(p.forbidden.length >= 2, `${slug} 只列了 ${p.forbidden.length} 条禁止项`);
  }
});

/* ────────────────────────── 真跑一遍 ────────────────────────── */

test("apply_style 的 ops 对每个预设都能过 schema（整批原子，一条不合就全废）", () => {
  for (const slug of presetSlugs) {
    const preset = presetOf(slug)!;
    const seed = createSeedProject("t_style");
    const ops: Parameters<typeof applyOps>[1] = [
      { op: "set_theme", palette: preset.palette, font: preset.font, radius: preset.radius },
    ];
    const t =
      preset.transition.type === "none"
        ? null
        : { type: preset.transition.type as never, durationInFrames: preset.transition.durationInFrames };
    for (const sc of seed.scenes) ops.push({ op: "update_scene", sceneId: sc.id, patch: { transitionIn: t } });
    let out;
    try {
      out = applyOps(seed, ops);
    } catch (err) {
      assert.fail(`${slug}：apply_style 的 ops 被拒 —— ${err instanceof Error ? err.message : String(err)}`);
    }
    assert.equal(out.project.theme.palette.background, preset.palette.background, `${slug} 主题没落库`);
  }
});

console.log(`\n${failures.length ? "FAILED" : "全部通过"}：${passed} 个用例`);
if (failures.length) {
  console.error(`失败：${failures.join("、")}`);
  process.exit(1);
}
