/**
 * TTS 文本转义工具：把不适合朗读的符号/日期/年份转成读法，或直接屏蔽。
 * 纯函数，按钮点一下就地改写输入框内容。
 */
export type TtsEscapeKind = "date" | "symbols" | "strip" | "year";

const CN_DIGIT = "零一二三四五六七八九";

/** 阿拉伯数字 → 中文读法（支持小数；"一十"开头简化为"十"） */
export function numToCn(input: string | number): string {
  const raw = String(input).trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) return raw;
  const [intPart, frac] = raw.split(".");

  const groups: string[] = [];
  let s = intPart;
  while (s.length) {
    groups.unshift(s.slice(-4));
    s = s.slice(0, -4);
  }
  const BIG = ["", "万", "亿", "万亿"];
  const parts: string[] = [];
  const addZero = () => {
    if (parts.length && !parts[parts.length - 1].endsWith("零")) parts.push("零");
  };

  groups.forEach((g, gi) => {
    const big = BIG[groups.length - 1 - gi] ?? "";
    const digits = g.split("").map(Number);
    const groupNum = Number(g);

    if (groupNum === 0) {
      if (parts.length) addZero();
      return;
    }
    if (parts.length && groupNum < 1000) addZero();

    let part = "";
    let zero = false;
    digits.forEach((d, i) => {
      const pos = digits.length - 1 - i;
      if (d === 0) {
        zero = true;
        return;
      }
      if (zero && part) part += "零";
      zero = false;
      part += CN_DIGIT[d] + (["", "十", "百", "千"][pos] ?? "");
    });
    part = part.replace(/^一十/, "十");
    parts.push(part + big);
  });

  let out = parts.join("").replace(/零+$/, "") || "零";
  if (frac) {
    out += "点" + frac.split("").map((d) => CN_DIGIT[Number(d)] ?? d).join("");
  }
  return out;
}

export function escapeTtsText(text: string, kind: TtsEscapeKind): string {
  switch (kind) {
    case "date":
      return text
        .replace(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})日?/g, "$1年$2月$3日")
        .replace(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*月?(?![\d])/g, "$1年$2月");
    case "symbols":
      // 先处理 "50%" → "百分之五十"，再兜底单独的 % → 百分之
      return text
        .replace(/(\d+(?:\.\d+)?)\s*[%％]/g, (_, n) => `百分之${numToCn(n)}`)
        .replace(/[%％]/g, "百分之")
        .replace(/→/g, "到")
        .replace(/←/g, "来自")
        .replace(/&/g, "和")
        .replace(/\+/g, "加")
        .replace(/×/g, "乘")
        .replace(/÷/g, "除以")
        .replace(/=/g, "等于")
        .replace(/#/g, "号")
        .replace(/@/g, "艾特")
        .replace(/~/g, "到");
    case "strip":
      return text.replace(/[*_~^|\\`]/g, "").replace(/[ \t]{2,}/g, " ");
    case "year":
      return text.replace(/\b(19|20)\d{2}\b/g, (m) =>
        m
          .split("")
          .map((d) => CN_DIGIT[Number(d)] ?? d)
          .join(""),
      );
  }
}

export const TTS_ESCAPE_TOOLS: { key: TtsEscapeKind; label: string; hint: string }[] = [
  { key: "date", label: "日期", hint: "2026-10-25 → 2026年10月25日" },
  { key: "symbols", label: "符号读法", hint: "% → 百分之，→ → 到，& → 和" },
  { key: "strip", label: "去符号", hint: "删掉 * _ ~ ^ | \\ ` 这类不朗读的符号" },
  { key: "year", label: "年份读法", hint: "2026 → 二零二六" },
];

/** TTS 前的自动转义：日期 + 数字/百分比 + 常见符号读法（不做删除，避免误删内容） */
export function escapeForTts(text: string): string {
  const dated = escapeTtsText(text, "date");
  return escapeTtsText(dated, "symbols");
}
