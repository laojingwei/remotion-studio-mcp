/**
 * 本地资源库 + 序列帧的纯逻辑回归（2026-11-05 代码审查后补）。
 *
 * 刻意不碰 ui-prefs、不启服务、不读用户素材盘：只测能纯函数验证的部分。
 * 覆盖的四类坑：
 *   1. 帧号换算（seqFps ÷ 工程fps、loop 回绕、停末帧）
 *   2. 序列帧识别（真实素材名带前缀/大写、跳号、不足 8 张）
 *   3. 2D imageSeq 的静默失败（忘 {frame} / 忘 seqTo / loop 默认）
 *   4. 权限判定（Host 可伪造，必须按连接来源）与引用 URL 编码
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { seqFrameIndex, seqFrameSrc, seqSrcAt } from "../shared/seqFrame";
import { imageSeqIssues } from "../shared/schema";
import { applyOps, createSeedProject } from "../shared/ops";
import { checkRequest, isLoopbackAddress } from "../server/security";
import { detectSequenceFromEntries, resourceRelUrl } from "../server/resources.service";

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(`${name}：${err instanceof Error ? err.message : String(err)}`);
    console.log(`  ✗ ${name}`);
  }
}

const dirent = (name: string, isFile = true): fs.Dirent =>
  ({ name, isFile: () => isFile, isDirectory: () => !isFile }) as unknown as fs.Dirent;

/* ── ① 帧号 ── */

test("1:1 逐帧 + loop=false 停末帧", () => {
  const t = { seqFrom: 1, seqTo: 4, seqFps: 30, loop: false };
  assert.deepEqual([0, 1, 2, 3, 4, 9].map((f) => seqFrameIndex(t, f, 30)), [1, 2, 3, 4, 4, 4]);
});

test("seqFps 是工程 fps 的两倍时每帧进两号", () => {
  const t = { seqFrom: 1, seqTo: 4, seqFps: 60, loop: true };
  assert.deepEqual([0, 1, 2, 3].map((f) => seqFrameIndex(t, f, 30)), [1, 3, 1, 3]);
});

test("loop 回绕支持非 1 起点，负帧按 0 处理", () => {
  const t = { seqFrom: 10, seqTo: 12, seqFps: 30, loop: true };
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((f) => seqFrameIndex(t, f, 30)), [10, 11, 12, 10, 11, 12]);
  assert.equal(seqFrameIndex(t, -5, 30), 10);
});

test("compFps 为 0 时按 30 兜底，不产出 NaN", () => {
  assert.equal(seqFrameIndex({ seqFrom: 1, seqTo: 4, seqFps: 30, loop: false }, 2, 0), 3);
});

test("seqFrameSrc 补零且替换所有 {frame}", () => {
  assert.equal(seqFrameSrc("a/{frame}/b_{frame}.png", 7, 4), "a/0007/b_0007.png");
  assert.equal(seqFrameSrc("x/{frame}.png", 12, 2), "x/12.png");
});

test("seqSrcAt 三处共用：默认起点 1、默认停末帧", () => {
  assert.equal(seqSrcAt("x/{frame}.png", undefined, 0, 30), "x/0001.png");
  assert.equal(
    seqSrcAt("x/{frame}.png", { seqFrom: 1, seqTo: 3, seqFps: 30, loop: false }, 99, 30, 4),
    "x/0003.png",
  );
});

/* ── ② 序列帧识别 ── */

test("识别前缀+编号组，保留原始大小写并给可粘贴的模式串", () => {
  const list = Array.from({ length: 10 }, (_, i) => dirent(`Explosion_${String(i + 1).padStart(4, "0")}.png`));
  const seq = detectSequenceFromEntries(list)!;
  assert.equal(seq.pattern, "Explosion_{frame}.png");
  assert.equal(seq.frameDigits, 4);
  assert.deepEqual([seq.seqFrom, seq.seqTo, seq.frames, seq.continuous], [1, 10, 10, true]);
  assert.equal(seq.firstFrame, "Explosion_0001.png");
  assert.equal(seq.lastFrame, "Explosion_0010.png");
});

test("跳号序列标 continuous=false，但首末帧仍是真实存在的文件", () => {
  const nums = [1, 2, 3, 5, 6, 7, 8, 9];
  const list = nums.map((n) => dirent(`碎石_${String(n).padStart(4, "0")}.png`));
  const seq = detectSequenceFromEntries(list)!;
  assert.equal(seq.continuous, false);
  assert.equal(seq.frames, 8);
  assert.deepEqual([seq.seqFrom, seq.seqTo], [1, 9]);
  assert.equal(seq.firstFrame, "碎石_0001.png");
  assert.equal(seq.lastFrame, "碎石_0009.png");
});

test("不足 8 张 / 文件名不以编号结尾 → 不当序列帧", () => {
  const few = Array.from({ length: 7 }, (_, i) => dirent(`p_${String(i + 1).padStart(4, "0")}.png`));
  assert.equal(detectSequenceFromEntries(few), null);
  const mixed = [
    dirent("草地 (0.10MB).png"),
    dirent("湖水.jpg"),
    ...Array.from({ length: 8 }, (_, i) => dirent(`photo ${i}.webp`)),
  ];
  assert.equal(detectSequenceFromEntries(mixed), null);
});

test("序列帧目录里的子文件夹不计入帧数", () => {
  const list = [
    ...Array.from({ length: 9 }, (_, i) => dirent(`f_${String(i + 1).padStart(3, "0")}.png`)),
    dirent("tex", false),
  ];
  const seq = detectSequenceFromEntries(list)!;
  assert.equal(seq.frames, 9);
  assert.equal(seq.frameDigits, 3);
});

/* ── ③ 2D imageSeq 防呆 ── */

test("imageSeqIssues 抓住两类静默失败，放过合规配置与非序列元素", () => {
  assert.ok(imageSeqIssues({ kind: "imageSeq", src: "x/0001.png" }).some((s) => s.includes("{frame}")));
  assert.ok(imageSeqIssues({ kind: "imageSeq", src: "x/{frame}.png" }).some((s) => s.includes("seqTo")));
  assert.deepEqual(imageSeqIssues({ kind: "imageSeq", src: "x/{frame}.png", seqFrom: 1, seqTo: 10 }), []);
  assert.deepEqual(imageSeqIssues({ kind: "image", src: "x/0001.png" }), []);
});

test("add_element 直接落 op 时缺参报错、合规时 loop 默认 false", () => {
  const p = createSeedProject("t-seq");
  const sceneId = p.scenes[0].id;
  assert.throws(
    () =>
      applyOps(p, [
        { op: "add_element", sceneId, element: { kind: "imageSeq", src: "x/{frame}.png" } } as never,
      ]),
    /seqTo/,
  );
  assert.throws(
    () =>
      applyOps(p, [
        {
          op: "add_element",
          sceneId,
          element: { kind: "imageSeq", src: "x/0001.png", seqTo: 10 },
        } as never,
      ]),
    /\{frame\}/,
  );
  const res = applyOps(p, [
    {
      op: "add_element",
      sceneId,
      element: { kind: "imageSeq", src: "x/{frame}.png", seqFrom: 1, seqTo: 10, frameDigits: 4 },
    } as never,
  ]);
  const el = res.project.scenes[0].elements?.[0];
  assert.equal(el?.kind, "imageSeq");
  assert.equal(el?.loop, false);
});

/* ── ④ 权限与 URL ── */

test("连接来源只认本机 IP，LAN 地址一律拒绝", () => {
  for (const ok of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "0:0:0:0:0:0:0:1"]) {
    assert.ok(isLoopbackAddress(ok), `${ok} 应判为本机`);
  }
  for (const bad of ["192.168.1.9", "10.0.0.2", "172.16.0.1", "::ffff:192.168.1.9", "", "localhost:4380"]) {
    assert.ok(!isLoopbackAddress(bad), `${bad} 不该判为本机`);
  }
});

test("LAN 模式全局闸放行写请求 → 管理面必须自己判来源", () => {
  assert.equal(
    checkRequest({ method: "PUT", host: "192.168.1.9:4380", origin: "http://evil.example", allowLan: true }).ok,
    true,
  );
  assert.equal(checkRequest({ method: "PUT", host: "evil.example", allowLan: false }).ok, false);
});

test("引用 URL 逐段编码，且 {frame} 占位符保持字面", () => {
  const rel = resourceRelUrl("fx", "爆炸 特效/Exp_{frame}.png");
  assert.equal(rel, "/resources/fx/%E7%88%86%E7%82%B8%20%E7%89%B9%E6%95%88/Exp_{frame}.png");
  assert.ok(rel.includes("{frame}"), "占位符不能被编码成 %7Bframe%7D");
  assert.ok(!rel.includes("%7B"));
});

console.log("");
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败：`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ test-resources：${passed} 项通过`);
