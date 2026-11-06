/**
 * 插件 SDK：场景组件能用的稳定入口。
 *
 * 插件组件写 `import { useSceneLayout, Editable } from "@studio/sdk"`，
 * 不要写 `../../shared/...` 这种相对路径 —— 插件在 `plugins/` 下，
 * 相对路径会随目录深度变化而失效，而且宿主一挪文件就崩。
 *
 * ## 这里放什么
 *
 * 只放**插件写场景真的需要、且我们愿意长期维护**的东西：
 * 布局单位、入场动画、可编辑元素包装、颜色工具、Theme 类型。
 *
 * 不放什么：`fx.ts` 里的具体特效函数、某个场景的私有实现、内部 registry。
 * 那些一改就会打断已发布的插件；插件要特殊效果就自己写内联样式，
 * 而不是依赖宿主内部函数（这也是为什么 SDK 这么小）。
 */

/* ── 布局：unit 制的唯一入口，禁止写 px ── */
export { useSceneLayout } from "./layout/useSceneLayout";
export type { Orientation } from "./layout/useSceneLayout";

/* ── 场景外壳与动效 ── */
export {
  Editable,
  SceneFrame,
  useEnter,
  useCountUp,
  useFadeOut,
  useMotion,
  useBare,
  useBackdropFx,
} from "./scenes/ui";

/* ── 颜色 ── */
export { withColorAlpha } from "../shared/color";

/* ── 类型 ── */
export type { Theme } from "../shared/schema";
