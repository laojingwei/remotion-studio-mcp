/**
 * 旁白音频指纹。
 *
 * 这组测试要钉住两件相反的事：
 *  1. **该敏感的**：换文件 / 挪位置 / 改长度 → 必须算新一版，要求重听
 *  2. **不该敏感的**：只是重建场景（elementId 变了）但音频没动 → 不能要求重听
 *
 * 第 2 条如果不测，`build_film(replace)` 之后每次都要用户重听一遍。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../server/root";
import { listNarrationClips, narrationFingerprint, voiceHeardState } from "../server/narration-voice.service";

let pass = 0;
let fail = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 造一个最小工程：2 幕，各 300 帧；旁白挂在场景内 */
function proj(opts?: {
  scenes?: { id: string; dur: number; els: Record<string, unknown>[] }[];
}) {
  const scenes =
    opts?.scenes ??
    [
      { id: "s1", dur: 300, els: [{ id: "a1", kind: "audio", narration: true, src: "/assets/v1.mp3", from: 0, durationInFrames: 120 }] },
      { id: "s2", dur: 300, els: [{ id: "a2", kind: "audio", narration: true, src: "/assets/v2.mp3", from: 10, durationInFrames: 90 }] },
    ];
  return {
    fps: 30,
    scenes: scenes.map((s) => ({
      id: s.id,
      durationInFrames: s.dur,
      elements: s.els,
    })),
  } as never;
}

/* ═════════ 只统计「旁白」，音效不算 ═════════ */

test("只认 narration:true 的音频 —— 音效不能混进来", () => {
  const p = proj({
    scenes: [
      {
        id: "s1",
        dur: 300,
        els: [
          { id: "a1", kind: "audio", narration: true, src: "/assets/voice.mp3", from: 0, durationInFrames: 100 },
          { id: "fx1", kind: "audio", src: "/assets/boom.wav", from: 50, durationInFrames: 20 },
        ],
      },
    ],
  });
  const clips = listNarrationClips(p);
  assert.equal(clips.length, 1, JSON.stringify(clips.map((c) => c.src)));
  assert.equal(clips[0].src, "/assets/voice.mp3");
});

test("没有旁白标记 → 空列表（纯图文片不该被闸口挡）", () => {
  const p = proj({
    scenes: [{ id: "s1", dur: 300, els: [{ id: "fx", kind: "audio", src: "/assets/x.wav" }] }],
  });
  assert.deepEqual(listNarrationClips(p), []);
});

/* ═════════ 绝对位置要算对（跨幕时靠它） ═════════ */

test("绝对起始帧 = 前序幕时长之和 + 场景内 from", () => {
  const clips = listNarrationClips(proj());
  assert.equal(clips[0].absStart, 0, "第 1 幕 from=0 → 绝对 0");
  assert.equal(clips[1].absStart, 300 + 10, "第 2 幕起点 300 + from 10");
});

test("多条旁白按绝对位置排序（不按数组顺序）", () => {
  const p = proj({
    scenes: [
      {
        id: "s1",
        dur: 300,
        els: [
          { id: "late", kind: "audio", narration: true, src: "/assets/b.mp3", from: 200, durationInFrames: 50 },
          { id: "early", kind: "audio", narration: true, src: "/assets/a.mp3", from: 0, durationInFrames: 50 },
        ],
      },
    ],
  });
  const clips = listNarrationClips(p);
  assert.equal(clips[0].src, "/assets/a.mp3", "按时间排，不按写入顺序");
  assert.equal(clips[1].src, "/assets/b.mp3");
});

/* ═════════ 指纹：该敏感的 ═════════ */

test("换音频文件 → 指纹变", () => {
  const a = narrationFingerprint(listNarrationClips(proj()));
  const b = narrationFingerprint(
    listNarrationClips(
      proj({
        scenes: [
          { id: "s1", dur: 300, els: [{ id: "a1", kind: "audio", narration: true, src: "/assets/NEW.mp3", from: 0, durationInFrames: 120 }] },
        ],
      }),
    ),
  );
  assert.notEqual(a, b);
});

test("挪位置（from 变）→ 指纹变", () => {
  const a = narrationFingerprint(listNarrationClips(proj()));
  const b = narrationFingerprint(
    listNarrationClips(
      proj({
        scenes: [
          { id: "s1", dur: 300, els: [{ id: "a1", kind: "audio", narration: true, src: "/assets/v1.mp3", from: 40, durationInFrames: 120 }] },
        ],
      }),
    ),
  );
  assert.notEqual(a, b);
});

test("改播放长度（durationInFrames 变）→ 指纹变", () => {
  const a = narrationFingerprint(listNarrationClips(proj()));
  const b = narrationFingerprint(
    listNarrationClips(
      proj({
        scenes: [
          { id: "s1", dur: 300, els: [{ id: "a1", kind: "audio", narration: true, src: "/assets/v1.mp3", from: 0, durationInFrames: 200 }] },
        ],
      }),
    ),
  );
  assert.notEqual(a, b);
});

test("改取片段起点（startFrom 变）→ 指纹变（整轨换切法要重听）", () => {
  const a = narrationFingerprint(
    listNarrationClips(
      proj({
        scenes: [{ id: "s1", dur: 300, els: [{ id: "a1", kind: "audio", narration: true, src: "/assets/full.wav", startFrom: 0, durationInFrames: 120 }] }],
      }),
    ),
  );
  const b = narrationFingerprint(
    listNarrationClips(
      proj({
        scenes: [{ id: "s1", dur: 300, els: [{ id: "a1", kind: "audio", narration: true, src: "/assets/full.wav", startFrom: 60, durationInFrames: 120 }] }],
      }),
    ),
  );
  assert.notEqual(a, b);
});

test("前面多了一幕（绝对位置整体后移）→ 指纹变", () => {
  const a = narrationFingerprint(listNarrationClips(proj()));
  const b = narrationFingerprint(
    listNarrationClips(
      proj({
        scenes: [
          { id: "s0", dur: 150, els: [] },
          { id: "s1", dur: 300, els: [{ id: "a1", kind: "audio", narration: true, src: "/assets/v1.mp3", from: 0, durationInFrames: 120 }] },
          { id: "s2", dur: 300, els: [{ id: "a2", kind: "audio", narration: true, src: "/assets/v2.mp3", from: 10, durationInFrames: 90 }] },
        ],
      }),
    ),
  );
  assert.notEqual(a, b, "整片重排导致音频绝对位置变了，用户听到的节奏就变了");
});

/* ═════════ 指纹：不该敏感的 ═════════ */

test("只是重建场景（elementId 变了）→ 指纹不变（否则每次 build_film 都要重听）", () => {
  const a = narrationFingerprint(listNarrationClips(proj()));
  const b = narrationFingerprint(
    listNarrationClips(
      proj({
        scenes: [
          { id: "scene_new1", dur: 300, els: [{ id: "el_zzz", kind: "audio", narration: true, src: "/assets/v1.mp3", from: 0, durationInFrames: 120 }] },
          { id: "scene_new2", dur: 300, els: [{ id: "el_yyy", kind: "audio", narration: true, src: "/assets/v2.mp3", from: 10, durationInFrames: 90 }] },
        ],
      }),
    ),
  );
  assert.equal(a, b, "音频一点没动，不该要求重听");
});

test("把第 2 幕的旁白挪进第 1 幕 → 指纹变（绝对位置才是事实）", () => {
  const a = narrationFingerprint(listNarrationClips(proj()));
  const b = narrationFingerprint(
    listNarrationClips(
      proj({
        scenes: [
          {
            id: "s1",
            dur: 300,
            els: [
              { id: "a2", kind: "audio", narration: true, src: "/assets/v2.mp3", from: 10, durationInFrames: 90 },
              { id: "a1", kind: "audio", narration: true, src: "/assets/v1.mp3", from: 0, durationInFrames: 120 },
            ],
          },
        ],
      }),
    ),
  );
  // 两条都进了 s1：原本 300+10 的那条现在落在 from=10，绝对位置变了 → 应当不同
  assert.notEqual(a, b, "换到别的幕 = 绝对位置变 = 应该重听");
});

/* ═════════ 三态 + 落盘 ═════════ */

const TMP = `p_voice_test_${process.pid}`;
const dir = path.join(ROOT, "data", "projects", TMP);
const stateFile = path.join(dir, "narration-voice.json");

test("没有旁白 → none（不能被闸口挡住）", () => {
  if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  const st = voiceHeardState(proj({ scenes: [{ id: "s1", dur: 300, els: [] }] }), TMP);
  assert.equal(st.state, "none");
});

test("有旁白但从没听过 → unheard，且回执要说清多少条多长", () => {
  if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  const st = voiceHeardState(proj(), TMP);
  assert.equal(st.state, "unheard");
  assert.ok(st.detail.includes("还没听过"), st.detail);
  assert.ok(st.detail.includes("2 条"), st.detail);
});

test("记录了听过（指纹一致）→ heard", () => {
  const fp = narrationFingerprint(listNarrationClips(proj()));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ fingerprint: fp, heardAt: "2026-10-31T07:00:00Z", heardOf: fp, heardUserSaid: "配音听过了，可以" }),
    "utf8",
  );
  const st = voiceHeardState(proj(), TMP);
  assert.equal(st.state, "heard");
  assert.ok(st.detail.includes("配音听过了"), st.detail);
});

test("音频改了（指纹对不上）→ 又变 unheard", () => {
  const fp = narrationFingerprint(listNarrationClips(proj()));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ fingerprint: fp, heardAt: "x", heardOf: "旧版本指纹", heardUserSaid: "听过了" }),
    "utf8",
  );
  const st = voiceHeardState(proj(), TMP);
  assert.equal(st.state, "unheard");
  assert.ok(st.detail.includes("旧一版"), st.detail);
});

// 清理
if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
if (fs.existsSync(dir)) fs.rmdirSync(dir);

console.log(`\n旁白指纹：${pass} 通过${fail ? `，${fail} 失败` : "，全部通过"}`);
if (fail) process.exit(1);
