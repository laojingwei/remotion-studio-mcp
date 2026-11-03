/**
 * 写请求延迟探针：连续保存 N 笔，看会不会越写越慢 / 卡死。
 *
 * 用途：验证"续编辑几十笔之后所有请求超时（signal timed out）"这个事故是否真的修好了。
 * 事故根因是每写一份快照就删一个旧文件，撞上宿主的 safe-delete 阈值后
 * **整个 Node 进程被卡住**——那种情况下这个脚本会直接超时或延迟一路飙升。
 *
 * 用法：先起服务（PORT=4399 npx tsx server/index.ts），再
 *   BASE=http://127.0.0.1:4399 node scripts/probe-ops-latency.mjs [笔数]
 *
 * 注意：会连续改某个工程第一个场景的名字，结束时恢复原名。
 */
const BASE = process.env.BASE ?? "http://127.0.0.1:4399";
const N = Number(process.argv[2] ?? 60);

const j = async (url, init) => {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} → ${res.status} ${await res.text()}`);
  return res.json();
};

const list = await j(`${BASE}/api/projects`);
const id = list.projects?.[0]?.id;
if (!id) throw new Error("没有工程，先让服务初始化一个 demo");

const { project } = await j(`${BASE}/api/projects/${id}`);
const sceneId = project.scenes[0].id;
const originalName = project.scenes[0].name ?? "";

const post = (ops, opId) =>
  j(`${BASE}/api/projects/${id}/ops`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ops, actor: "user", clientId: "latency-probe", opId }),
  });

const times = [];
for (let i = 0; i < N; i++) {
  const t0 = performance.now();
  await post([{ op: "update_scene", sceneId, patch: { name: `延迟探针 ${i}` } }], `probe:${process.pid}:${i}`);
  times.push(performance.now() - t0);
}

/** 幂等复查：用一个全新的 opId 连发两次，rev 只应该涨 1 次 */
const idemOpId = `probe:idem:${process.pid}:${Date.now()}`;
const beforeRev = (await j(`${BASE}/api/projects/${id}`)).project.rev;
await post([{ op: "update_scene", sceneId, patch: { name: "幂等复查" } }], idemOpId);
await post([{ op: "update_scene", sceneId, patch: { name: "幂等复查" } }], idemOpId);
const afterRev = (await j(`${BASE}/api/projects/${id}`)).project.rev;

await post([{ op: "update_scene", sceneId, patch: { name: originalName } }], `probe:restore:${process.pid}`);

const sorted = [...times].sort((a, b) => a - b);
const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(0);
const max = Math.max(...times).toFixed(0);
const first10 = times.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
const last10 = times.slice(-10).reduce((a, b) => a + b, 0) / 10;

console.log(`写入 ${N} 笔（工程 ${id}）`);
console.log(`  p50 ${at(0.5)}ms · p95 ${at(0.95)}ms · max ${max}ms`);
console.log(`  前 10 笔均值 ${first10.toFixed(0)}ms → 后 10 笔均值 ${last10.toFixed(0)}ms（差值＝是否越写越慢）`);
console.log(`  幂等复查：同 opId 连发两次，rev ${beforeRev} → ${afterRev}（应只 +1）`);
if (Number(max) > 5000) console.log("  ⚠️ 出现 5 秒以上写入：说明还有阻塞源");
