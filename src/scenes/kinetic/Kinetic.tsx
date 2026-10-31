import React from "react";
import { spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, Highlighted, SceneFrame, useMotion } from "../ui";

export type KineticProps = {
  theme: Theme;
  /** 主文案，逐字入场 */
  text: string;
  /** 需要强调的词（会换强调色），可留空 */
  highlight: string;
  /** 副标题，可留空 */
  sub: string;
};

/**
 * 弹跳字：逐字弹入 + 轻微摇摆。
 *
 * 竖屏适配的关键不是"缩小"，是**换行策略**：
 * 字号按短边百分比给、每个字 inline-block + flex-wrap，一行放不下自动折行。
 *
 * 但逐字折行有个坑：`一万音浪到手只有三百七` 会在「三 / 百七」之间断开，
 * 高亮词被劈成两行（第一版抽帧就是这个结果）。所以把高亮词包成一个
 * `inline-flex + nowrap` 的原子块 —— 词内不折行，词外照常折。
 */
export const KineticScene: React.FC<KineticProps> = ({ theme, text, highlight = "", sub = "" }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { u, h, isPortrait } = useSceneLayout();
  const m = useMotion();
  const c = theme.palette;

  const raw = [...String(text ?? "")];
  const fontSize = h(isPortrait ? 8.5 : 7.2);
  const gap = isPortrait ? 0.5 : 0.4;
  const stagger = isPortrait ? 1.4 : 2;

  // 高亮词作为原子块：词内不折行
  const hl = String(highlight ?? "");
  const at = hl ? String(text ?? "").indexOf(hl) : -1;
  type Tok = { chars: string[]; atomic: boolean };
  const tokens: Tok[] =
    at < 0
      ? raw.map((ch) => ({ chars: [ch], atomic: false }))
      : [
          ...raw.slice(0, at).map((ch) => ({ chars: [ch], atomic: false })),
          { chars: [...hl], atomic: true },
          ...raw.slice(at + hl.length).map((ch) => ({ chars: [ch], atomic: false })),
        ];

  let charIndex = 0;
  const renderChar = (ch: string, accent: boolean) => {
    const i = charIndex++;
    const p = spring({
      frame: frame - i * stagger,
      fps,
      config: { damping: 11, stiffness: 190, mass: 0.7 },
    });
    const mm = m === 0 ? 0 : m;
    const bounce = Math.sin((frame - i * stagger) * 0.14) * 4 * p * mm;
    const tilt = Math.sin((frame - i * stagger) * 0.09 + i) * 2.4 * p * mm;
    return (
      <span
        key={`k-${i}`}
        style={{
          display: "inline-block",
          fontFamily: theme.font.heading,
          fontSize,
          fontWeight: 800,
          lineHeight: 1.12,
          color: accent ? c.primary : c.text,
          transform: `translateY(${(1 - p) * u(9) + bounce}px) rotate(${tilt}deg) scale(${0.82 + p * 0.18})`,
          opacity: p,
          whiteSpace: ch === " " ? "pre" : undefined,
        }}
      >
        {ch}
      </span>
    );
  };

  return (
    <SceneFrame theme={theme} justify="center" align="center">
      <Editable id="text" title="主文案" style={{ maxWidth: u(86) }}>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "center",
            alignItems: "baseline",
            columnGap: u(gap),
            rowGap: u(0.8),
            maxWidth: u(86),
          }}
        >
          {tokens.map((t, ti) =>
            t.atomic ? (
              <span
                key={`t-${ti}`}
                style={{ display: "inline-flex", columnGap: u(gap), whiteSpace: "nowrap" }}
              >
                {t.chars.map((ch) => renderChar(ch, true))}
              </span>
            ) : (
              renderChar(t.chars[0], false)
            ),
          )}
        </div>
      </Editable>

      {sub ? (
        <Editable id="sub" title="副标题" style={{ marginTop: u(4) }}>
          <div
            style={{
              fontFamily: theme.font.body,
              fontSize: h(2.6),
              color: c.textMuted,
              letterSpacing: u(0.12),
              textAlign: "center",
              opacity: spring({ frame: frame - raw.length * stagger - 6, fps, config: { damping: 200 } }),
            }}
          >
            <Highlighted text={sub} highlight={hl} color={c.primary} />
          </div>
        </Editable>
      ) : null}
    </SceneFrame>
  );
};
