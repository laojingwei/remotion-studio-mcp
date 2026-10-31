import React from "react";
import { spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useMotion } from "../ui";

export type MaskRevealProps = {
  theme: Theme;
  /** 顶部小标签，可留空 */
  kicker: string;
  /** 逐行上翻的文案：一行一块，行数不限（行多时字号自动缩小） */
  lines: string[];
  /** 高亮其中的一句（换强调色），可留空 */
  accentLine: string;
};

/**
 * 遮罩上翻：每行文案从裁切框内升起，逐行错峰。
 *
 * 为什么用「行」而不是「字」：竖屏上真正的问题是"眼睛来不及跟"，
 * 逐字入场在 15 字以内很帅，超过就散。按行来，节奏可控，折行也不会打断动画。
 *
 * 遮罩用 overflow:hidden + 内层 translateY，不用 clip-path：
 * clip-path 在 Linux 无头渲染里对文字抗锯齿有影响（边缘发虚），overflow 更稳。
 */
export const MaskRevealScene: React.FC<MaskRevealProps> = ({
  theme,
  kicker = "",
  lines = [],
  accentLine = "",
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { u, h, isPortrait } = useSceneLayout();
  const m = useMotion();
  const c = theme.palette;

  const rows = lines.filter((x) => String(x ?? "").trim());
  // 横屏要显著放大：h() 是短边百分比，横屏短边 1080 而画面宽 1920，
  // 同样的字号在 16:9 里只占左侧三成宽，右边一片空（横屏抽帧实测）。
  // 行数不设上限：超过基准（4 行）按 4/N 缩小字号，多少行都排得进画面。
  const fontSize = h(isPortrait ? 9 : 10.4) * Math.min(1, 4 / Math.max(1, rows.length));
  const stagger = isPortrait ? 7 : 9;

  return (
    <SceneFrame theme={theme} justify="center" align="left">
      {kicker ? (
        <Editable id="kicker" title="小标签" style={{ marginBottom: u(2.6) }}>
          <div
            style={{
              fontFamily: theme.font.body,
              fontSize: h(1.7),
              letterSpacing: u(0.24),
              color: c.primary,
              fontWeight: 700,
              opacity: spring({ frame, fps, config: { damping: 200 } }),
            }}
          >
            {kicker}
          </div>
        </Editable>
      ) : null}

      {rows.map((line, i) => {
        const p = spring({
          frame: frame - 4 - i * stagger,
          fps,
          config: { damping: 16, stiffness: 120, mass: 0.9 },
        });
        // motion=0 时不位移（直接呈现），否则从 112% 升上来
        const shift = m === 0 ? 0 : (1 - p) * 112;
        const isAccent = accentLine && line.includes(accentLine);
        return (
          <Editable
            key={`line-${i}`}
            id={`line${i + 1}`}
            title={`第 ${i + 1} 行`}
            style={{ overflow: "hidden", display: "block", marginBottom: u(0.6) }}
          >
            <div
              style={{
                fontFamily: theme.font.heading,
                fontSize,
                lineHeight: 1.18,
                fontWeight: 800,
                color: isAccent ? c.primary : c.text,
                transform: `translateY(${shift}%)`,
                opacity: m === 0 ? 1 : 0.15 + p * 0.85,
                whiteSpace: "pre-wrap",
              }}
            >
              {line}
            </div>
          </Editable>
        );
      })}

      {rows.length === 0 ? (
        <div style={{ color: c.textMuted, fontFamily: theme.font.body, fontSize: h(2.6) }}>
          （还没写文案：在属性面板里填 lines）
        </div>
      ) : null}
    </SceneFrame>
  );
};
