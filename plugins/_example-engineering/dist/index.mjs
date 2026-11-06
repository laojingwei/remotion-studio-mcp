// src/index.ts
var MIN_SEC = 1.2;
var MAX_EMPTY_SEC = 6;
var label = (s, i) => s.name || s.id || `\u7B2C ${i + 1} \u5E55`;
var index_default = {
  "audit:rules": (ctx) => {
    const scenes = ctx.project?.scenes ?? [];
    const fps = ctx.project?.fps || 30;
    if (!scenes.length) return { warnings: ["\u8FD8\u6CA1\u6709\u5E55\uFF0C\u5148 add_scene"] };
    const warnings = [];
    const passed = [];
    const tooShort = scenes.map((s, i) => ({ s, i, sec: (s.durationInFrames ?? 0) / fps })).filter((x) => x.sec > 0 && x.sec < MIN_SEC);
    if (tooShort.length) {
      warnings.push(
        tooShort.slice(0, 4).map((x) => `${label(x.s, x.i)} \u53EA\u6709 ${x.sec.toFixed(2)}s\uFF08\u5EFA\u8BAE \u2265 ${MIN_SEC}s\uFF09`).join("\uFF1B")
      );
    }
    const emptyLong = scenes.map((s, i) => ({ s, i, sec: (s.durationInFrames ?? 0) / fps })).filter((x) => x.sec > MAX_EMPTY_SEC && !String(x.s.subtitle ?? "").trim());
    if (emptyLong.length) {
      warnings.push(
        `${emptyLong.length} \u5E55\u8D85\u8FC7 ${MAX_EMPTY_SEC}s \u4E14\u6CA1\u6709\u5B57\u5E55\uFF1A${emptyLong.slice(0, 3).map((x) => label(x.s, x.i)).join("\u3001")}`
      );
    }
    const total = scenes.reduce((n, s) => n + (s.durationInFrames ?? 0), 0);
    if (total > 0) {
      const max = Math.max(...scenes.map((s) => s.durationInFrames ?? 0));
      const share = max / total;
      if (share > 0.5 && scenes.length >= 3) {
        warnings.push(`\u6700\u957F\u7684\u4E00\u5E55\u5360\u5168\u7247 ${Math.round(share * 100)}%\uFF0C\u8282\u594F\u4F1A\u663E\u5F97\u62D6`);
      } else {
        passed.push(`\u65F6\u957F\u5206\u5E03\uFF1A\u6700\u957F\u4E00\u5E55\u5360 ${Math.round(share * 100)}%\uFF0C\u8FD8\u884C`);
      }
    }
    return { warnings, passed };
  }
};
export {
  index_default as default
};
