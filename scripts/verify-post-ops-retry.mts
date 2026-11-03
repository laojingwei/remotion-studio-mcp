/**
 * 写请求"超时自动重试"的验证（`web/apiClient.postOps`）。
 *
 * 验三件事，缺一条都会让重试变成隐患：
 * 1. 超时确实重试，且**三次用的是同一个 opId**（否则服务端无法去重，等于重复写）；
 * 2. 服务端给了明确答复（4xx/业务错误）就不重试——重试只会让用户多等；
 * 3. 全部超时后抛的是一句人话（不是浏览器原生的 "signal timed out"）。
 *
 * 跑法：npx tsx scripts/verify-post-ops-retry.mts
 */
import assert from "node:assert/strict";

const realFetch = globalThis.fetch;
const realWarn = console.warn;
console.warn = () => {}; // 退避期间不需要噪音

const timeoutErr = () => new DOMException("signal timed out", "TimeoutError");

/** 收集每次请求 body 里的 opId */
const installFetch = (handler: (n: number) => Promise<unknown>) => {
  const seen: string[] = [];
  globalThis.fetch = (async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    seen.push(body.opId);
    return handler(seen.length);
  }) as unknown as typeof fetch;
  return seen;
};

const okResponse = () =>
  Promise.resolve({
    ok: true,
    json: async () => ({ project: { id: "p" }, createdSceneIds: [], summary: ["ok"] }),
  });

let pass = 0;
let fail = 0;
const ok = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    pass++;
    console.log("  ✓", name);
  } catch (e) {
    fail++;
    console.log("  ✗", name, "\n    ", (e as Error).message);
  }
};

const { postOps } = await import("../web/apiClient");

await ok("超时后重试，且三次 opId 相同（服务端才能去重）", async () => {
  const seen = installFetch((n) => (n < 3 ? Promise.reject(timeoutErr()) : okResponse()));
  const r = await postOps("p_x", [{ op: "nope" } as never]);
  assert.equal((r as { summary: string[] }).summary[0], "ok");
  assert.equal(seen.length, 3, `应尝试 3 次，实得 ${seen.length}`);
  assert.equal(new Set(seen).size, 1, `三次必须是同一个 opId，实得 ${JSON.stringify(seen)}`);
});

await ok("业务错误（4xx）不重试", async () => {
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    return { ok: false, json: async () => ({ error: "版本冲突：期望 rev=1，当前 rev=2" }) };
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => postOps("p_x", [{ op: "nope" } as never]),
    /版本冲突/,
    "应原样抛出服务端错误",
  );
  assert.equal(n, 1, `明确答复不该重试，实得 ${n} 次`);
});

await ok("全部超时：抛出可读提示（不是 signal timed out）", async () => {
  installFetch(() => Promise.reject(timeoutErr()));
  await assert.rejects(
    () => postOps("p_x", [{ op: "nope" } as never]),
    (err: Error) => {
      assert.ok(!/signal timed out/i.test(err.message), `不该把原生错误直接抛给用户：${err.message}`);
      assert.ok(err.message.includes("保存超时"), err.message);
      return true;
    },
  );
});

globalThis.fetch = realFetch;
console.warn = realWarn;

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
