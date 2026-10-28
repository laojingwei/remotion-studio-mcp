/**
 * rev 快照保留策略单测（纯函数）。
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { pickSnapshotRevs } from "../server/store";

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

test("超过上限时保留最大的 keep 个 rev", () => {
  assert.deepEqual(pickSnapshotRevs([1, 2, 3, 4, 5], 3), [3, 4, 5]);
});

test("不足上限时全保留", () => {
  assert.deepEqual(pickSnapshotRevs([7, 3, 5], 10), [3, 5, 7]);
});

test("排序 + 去重", () => {
  assert.deepEqual(pickSnapshotRevs([5, 1, 5, 3, 3], 10), [1, 3, 5]);
});

test("过滤非法值（NaN / 空目录名）", () => {
  assert.deepEqual(pickSnapshotRevs([1, Number.NaN, 2], 10), [1, 2]);
});

test("空输入返回空数组", () => {
  assert.deepEqual(pickSnapshotRevs([], 3), []);
});

console.log("");
if (failures.length) {
  console.error(`${failures.length} 个用例失败（通过 ${passed} 个）`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`全部通过：${passed} 个用例`);
