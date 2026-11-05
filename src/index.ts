import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";
/*
 * 插件场景的注册。
 *
 * 必须是**模块顶层副作用**且早于 registerRoot：生成文件在被 import 时
 * 就调用了 registerSceneMeta / registerSceneComponent，而 ESM 的 import 求值
 * 早于本文件正文，所以写一行 import 顺序就自然正确。
 *
 * 没装插件时它是个空占位（只导出一个空数组），不影响编译与运行。
 */
import "./_plugins.generated";

registerRoot(RemotionRoot);
