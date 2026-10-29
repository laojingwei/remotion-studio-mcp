/**
 * 字幕导出单测（纯函数，不碰磁盘、不起服务）。
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { buildCues, renderSubtitles, sceneSubtitleText } from "../server/subtitle.service";
import { subtitleMaxChars } from "../shared/subtitle";
import { cleanSubtitleText, normalizeSubtitle } from "../shared/subtitleText";
import type { Project, Scene } from "../shared/schema";

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

const scene = (partial: Partial<Scene> & { id: string; durationInFrames: number }): Scene =>
  ({
    type: "title",
    name: partial.id,
    props: {},
    ...partial,
  }) as Scene;

const project = (scenes: Scene[], fps = 30): Project =>
  ({
    id: "p_test",
    name: "字幕测试",
    rev: 1,
    fps,
    formats: [{ key: "landscape", width: 1920, height: 1080 }],
    theme: {} as any,
    scenes,
  }) as unknown as Project;

/* ────────────────────────────── 用例 ────────────────────────────── */

console.log("[subtitle] 字幕导出");

test("没写 subtitle 的场景不产生字幕", () => {
  const cues = buildCues(
    project([scene({ id: "s1", durationInFrames: 90, type: "title", props: { title: "标题" } })]),
  );
  assert.equal(cues.length, 0);
});

test("caption 版式自动用正文当字幕", () => {
  const cues = buildCues(
    project([scene({ id: "s1", durationInFrames: 90, type: "caption", props: { text: "这是一句口播" } })]),
  );
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "这是一句口播");
});

test("显式 subtitle 优先于 caption 版式的正文", () => {
  const cues = buildCues(
    project([
      scene({
        id: "s1",
        durationInFrames: 90,
        type: "caption",
        props: { text: "版式正文" },
        subtitle: "真正的字幕",
      }),
    ]),
  );
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "真正的字幕");
});

test("时间码从全局帧号累计：第二幕的字幕起点接在第一幕之后", () => {
  const cues = buildCues(
    project([
      scene({ id: "s1", durationInFrames: 90, subtitle: "第一幕" }),
      scene({ id: "s2", durationInFrames: 60, subtitle: "第二幕" }),
    ]),
  );
  assert.equal(cues.length, 2);
  assert.equal(cues[0].startFrame, 0);
  assert.equal(cues[0].endFrame, 90);
  assert.equal(cues[1].startFrame, 90);
  assert.equal(cues[1].endFrame, 150);
});

test("一幕多句：按字数比例分配时长（长句占更多时间）", () => {
  const cues = buildCues(
    project([
      scene({ id: "s1", durationInFrames: 120, subtitle: "短\n这是一句很长的旁白用来占更多时间" }),
    ]),
  );
  assert.equal(cues.length, 2);
  const shortDur = cues[0].endFrame - cues[0].startFrame;
  const longDur = cues[1].endFrame - cues[1].startFrame;
  assert.ok(longDur > shortDur * 3, `长句应明显更长：${shortDur} vs ${longDur}`);
  assert.equal(cues[1].endFrame, 120, "最后一句必须到幕尾");
});

test("SRT 格式：序号 + 时间码 + 文本", () => {
  const cues = buildCues(project([scene({ id: "s1", durationInFrames: 90, subtitle: "你好" })]));
  const srt = renderSubtitles(cues, 30, "srt");
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:03,000\n你好\n/);
});

test("VTT 格式：WEBVTT 头 + 点分隔毫秒", () => {
  const cues = buildCues(project([scene({ id: "s1", durationInFrames: 90, subtitle: "你好" })]));
  const vtt = renderSubtitles(cues, 30, "vtt");
  assert.match(vtt, /^WEBVTT\n\n00:00:00\.000 --> 00:00:03\.000\n你好\n/);
});

test("时长按 fps 换算（25fps 下 90 帧 = 3.6 秒）", () => {
  const cues = buildCues(
    project([scene({ id: "s1", durationInFrames: 90, subtitle: "你好" })], 25),
  );
  const srt = renderSubtitles(cues, 25, "srt");
  assert.match(srt, /00:00:03,600/);
});

test("空字幕不会产生零时长条目", () => {
  const cues = buildCues(project([scene({ id: "s1", durationInFrames: 90, subtitle: "  \n  " })]));
  assert.equal(cues.length, 0);
});

test("多行字幕：每行独立成条且首尾相接", () => {
  const cues = buildCues(
    project([scene({ id: "s1", durationInFrames: 90, subtitle: "第一句\n第二句\n第三句" })]),
  );
  assert.equal(cues.length, 3);
  assert.equal(cues[0].startFrame, 0);
  assert.equal(cues[1].startFrame, cues[0].endFrame);
  assert.equal(cues[2].endFrame, 90);
});

test("场景之间的字幕不重叠", () => {
  const cues = buildCues(
    project([
      scene({ id: "s1", durationInFrames: 45, subtitle: "甲" }),
      scene({ id: "s2", durationInFrames: 45, subtitle: "乙" }),
    ]),
  );
  assert.ok(cues[0].endFrame <= cues[1].startFrame, "后一幕不能早于前一幕结束");
});

test("sceneSubtitleText：显式字幕优先，其次 caption 正文", () => {
  assert.equal(
    sceneSubtitleText(scene({ id: "s", durationInFrames: 10, type: "caption", props: { text: "正文" } })),
    "正文",
  );
  assert.equal(
    sceneSubtitleText(
      scene({ id: "s", durationInFrames: 10, type: "caption", props: { text: "正文" }, subtitle: "字幕" }),
    ),
    "字幕",
  );
  assert.equal(
    sceneSubtitleText(scene({ id: "s", durationInFrames: 10, type: "bullets", props: { heading: "X" } })),
    "",
  );
});


/* ────────────────────── 拆段（一屏一句、无标点） ────────────────────── */

console.log("[subtitle] 拆段规则");

test("长句被拆成多屏，每屏不超过上限", () => {
  const cues = buildCues(
    project([
      scene({
        id: "s1",
        durationInFrames: 150,
        subtitle: "今天我要给大家讲三个几乎不花钱但是效果特别明显的提升视频质感的方法",
      }),
    ]),
  );
  assert.ok(cues.length >= 3, `只拆出 ${cues.length} 条`);
  for (const c of cues) assert.ok([...c.text].length <= 18, `「${c.text}」${[...c.text].length} 字`);
});

test("上屏不带标点", () => {
  const cues = buildCues(
    project([
      scene({ id: "s1", durationInFrames: 120, subtitle: "第一，先别急着加特效；第二，把字号放大——这两点最关键！" }),
    ]),
  );
  for (const c of cues) assert.ok(!/[。，、；：！？…,;:!?]/.test(c.text), `「${c.text}」还有标点`);
});

test("拆段不丢字（只丢标点）", () => {
  const raw = "我们花了三个月，把完播率从18%做到了41%。";
  const cues = buildCues(project([scene({ id: "s1", durationInFrames: 150, subtitle: raw })]));
  const joined = cues.map((c) => c.text).join("").replace(/\s/g, "");
  assert.equal(joined, raw.replace(/[，。]/g, ""), `拼回去是「${joined}」`);
});

test("数字里的点与逗号不被当句号切掉", () => {
  const cues = buildCues(
    project([scene({ id: "s1", durationInFrames: 150, subtitle: "转化率从3.5%提升到12.8%一共1,200单" })]),
  );
  const all = cues.map((c) => c.text).join(" ");
  assert.ok(all.includes("3.5%"), `丢了 3.5%：${all}`);
  assert.ok(all.includes("12.8%"), `丢了 12.8%：${all}`);
  assert.ok(all.includes("1,200"), `丢了 1,200：${all}`);
});

test("换行是作者画的分屏，不跨段合并", () => {
  const cues = buildCues(project([scene({ id: "s1", durationInFrames: 90, subtitle: "第一句\n第二句\n第三句" })]));
  assert.equal(cues.length, 3, `跨段合并了：${JSON.stringify(cues.map((c) => c.text))}`);
});

test("字号越大一屏字数越少", () => {
  const small = subtitleMaxChars(scene({ id: "a", durationInFrames: 30, subtitleStyle: { fontSize: 2.6 } }));
  const big = subtitleMaxChars(scene({ id: "b", durationInFrames: 30, subtitleStyle: { fontSize: 6 } }));
  assert.ok(big < small, `大字 ${big} 应小于小字 ${small}`);
});

test("normalizeSubtitle 返回拆分预览与标点告警", () => {
  const r = normalizeSubtitle("今天讲三个方法，第一个几乎不花钱。");
  assert.ok(r.lines.length >= 2, `只拆出 ${r.lines.length} 屏`);
  assert.ok(r.changed);
  assert.ok(r.warnings.some((w) => w.includes("标点")), `没提示标点：${r.warnings.join("/")}`);
});

test("cleanSubtitleText 清标点但保留数字符号", () => {
  assert.equal(cleanSubtitleText("增长3.5%，共1,200单！"), "增长3.5% 共1,200单");
});

const ok = failures.length === 0;
console.log(`\n${ok ? "全部通过" : `失败 ${failures.length} 个`}：${passed} 个用例`);
if (!ok) process.exit(1);
