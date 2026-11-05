/**
 * 示例插件源码：节奏检查（工程化写法）。
 *
 * 这个文件**不会**被宿主加载——宿主编译的是 `dist/index.mjs`（`npm run build` 的产物）。
 * 它在这里是为了让人看到"一个真实插件该怎么写"：
 *
 * ```
 * plugins/_example-engineering/
 *   package.json      name / version / exports / scripts.build / remotionStudio
 *   src/index.ts      源码（你在这里写，可以 import 任何 npm 包）
 *   dist/index.mjs    构建产物（宿主读这个）
 * ```
 *
 * **和单文件插件的区别**：单文件那种是宿主用 esbuild 现场编译的，所以不能有依赖、
 * 不能有原生模块、不能用你的 tsconfig 路径别名。工程化以后这些都不是问题——
 * 你自己构建，产物长什么样宿主不管，只按 `exports` 去 import。
 */

/** 幕短于这个秒数基本看不出内容，观众只会觉得"闪了一下" */
const MIN_SEC = 1.2;
/** 超过这个秒数、又没有字幕的幕，观众会以为卡住了 */
const MAX_EMPTY_SEC = 6;

type SceneLike = { name?: string; id?: string; type?: string; durationInFrames?: number; subtitle?: string };
type ProjectLike = { fps?: number; scenes?: SceneLike[] };

const label = (s: SceneLike, i: number) => s.name || s.id || `第 ${i + 1} 幕`;

export default {
  "audit:rules": (ctx: { project: ProjectLike }) => {
    const scenes = ctx.project?.scenes ?? [];
    const fps = ctx.project?.fps || 30;
    if (!scenes.length) return { warnings: ["还没有幕，先 add_scene"] };

    const warnings: string[] = [];
    const passed: string[] = [];

    /* 1. 太短的幕：一闪而过，观众读不完任何东西 */
    const tooShort = scenes
      .map((s, i) => ({ s, i, sec: (s.durationInFrames ?? 0) / fps }))
      .filter((x) => x.sec > 0 && x.sec < MIN_SEC);
    if (tooShort.length) {
      warnings.push(
        tooShort
          .slice(0, 4)
          .map((x) => `${label(x.s, x.i)} 只有 ${x.sec.toFixed(2)}s（建议 ≥ ${MIN_SEC}s）`)
          .join("；"),
      );
    }

    /* 2. 又长又空的幕：没有字幕也没有画面变化，观感像卡死 */
    const emptyLong = scenes
      .map((s, i) => ({ s, i, sec: (s.durationInFrames ?? 0) / fps }))
      .filter((x) => x.sec > MAX_EMPTY_SEC && !String(x.s.subtitle ?? "").trim());
    if (emptyLong.length) {
      warnings.push(
        `${emptyLong.length} 幕超过 ${MAX_EMPTY_SEC}s 且没有字幕：${emptyLong
          .slice(0, 3)
          .map((x) => label(x.s, x.i))
          .join("、")}`,
      );
    }

    /* 3. 时长分布：全片如果被一幕吃掉一半，节奏就是"一坨" */
    const total = scenes.reduce((n, s) => n + (s.durationInFrames ?? 0), 0);
    if (total > 0) {
      const max = Math.max(...scenes.map((s) => s.durationInFrames ?? 0));
      const share = max / total;
      if (share > 0.5 && scenes.length >= 3) {
        warnings.push(`最长的一幕占全片 ${Math.round(share * 100)}%，节奏会显得拖`);
      } else {
        passed.push(`时长分布：最长一幕占 ${Math.round(share * 100)}%，还行`);
      }
    }

    return { warnings, passed };
  },
};
