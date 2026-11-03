/**
 * 挡掉 three r183+ 的 Clock 弃用警告。
 *
 * `three@0.187` 的 `Clock` 构造函数里无条件 `console.warn('Clock: This module has been
 * deprecated. Please use THREE.Timer instead.')`，而 `@react-three/fiber` 9.8.2（当前
 * 最新稳定版，10.x 还在 canary）内部仍然是 `new THREE.Clock()`——上游还没跟进 Timer。
 *
 * 也就是说这条警告来自依赖、和本项目代码无关，而且每次进 3D 视口都会打一条，
 * 把真正的报错淹掉。**只挡这一条**，其余警告原样输出。
 *
 * R3F 改用 Timer 之后（能删掉这个文件时）记得把它删了。
 */
let installed = false;

export const quietThreeClockWarn = (): void => {
  if (installed) return;
  installed = true;
  const raw = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    const first = args[0];
    // 实测文案是 "THREE.Clock: This module has been deprecated. ..."（带命名空间前缀），
    // 所以按**包含**匹配而不是 startsWith，否则放过一条、还漏一条。
    if (typeof first === "string" && first.includes("Clock: This module has been deprecated")) return;
    raw(...args);
  };
};
