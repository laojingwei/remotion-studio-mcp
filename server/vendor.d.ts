/**
 * 没有自带 TypeScript 类型的第三方依赖，在这里补最小声明。
 * 只用 `any`：这些库的 API 面很大（essentia 有 400+ 算法），我们只调其中两个，
 * 自己写一份精确类型反而容易和实际实现漂移。
 */

declare module "essentia.js" {
  export const Essentia: any;
  export const EssentiaWASM: any;
  export const EssentiaExtractor: any;
  export const EssentiaModel: any;
  const _default: any;
  export default _default;
}
