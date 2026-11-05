/* eslint-disable */
/**
 * 这个文件由 server/plugin/gen-entry.ts 生成，**不要手改**。
 * 它把插件场景的组件与 meta 以静态 import 的方式引入 bundle ——
 * 渲染端是 webpack 静态分析，运行时加载任意路径会失败。
 *
 * 改了插件之后：服务端重新打包前会自动重新生成（见 render.service.ts）。
 */
import { jsonToSceneMeta } from "../shared/pluginSceneMeta";
import { registerSceneMeta } from "../shared/sceneMetas";
import { registerSceneComponent } from "./scenes/components";
import * as comp0 from "../plugins/_example-scene/scenes/example-rating";
import meta0 from "../plugins/_example-scene/scenes/example-rating.json";

const candidates: { meta: unknown; Component: any; from: string; file: string }[] = [
  { meta: meta0 as unknown, Component: (comp0 as any).default, from: "_example-scene", file: "example-rating.json" },
];

export const PLUGIN_SCENES = candidates;

/** 注册必须在模块顶层执行：生成文件被 src/index.ts 引入，早于任何渲染 */
for (const c of candidates) {
  const parsed = jsonToSceneMeta(c.meta, `${c.from}/${c.file}`);
  if (!parsed.meta) {
    console.warn('[plugin] 场景 ' + c.from + '/' + c.file + ' 定义不合法，已跳过：' + parsed.issues.join('; '));
    continue;
  }
  const reg = registerSceneMeta(parsed.meta);
  if (!reg.ok) {
    console.warn('[plugin] ' + reg.reason);
    continue;
  }
  if (typeof c.Component !== 'function') {
    console.warn('[plugin] 场景 ' + parsed.meta.type + ' 的组件文件没有 default export，画面会是空白');
  }
  registerSceneComponent(parsed.meta.type, c.Component);
}
