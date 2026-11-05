import React from "react";
import { useSceneLayout, SceneFrame, useEnter, withColorAlpha, type Theme } from "@studio/sdk";

/**
 * 插件示例场景：评分卡。
 *
 * 演示一个插件场景的最小可用形态：
 *   - 默认导出就是渲染组件（生成文件靠 `default` 找它）
 *   - props 由同名 json 的 `fields` 推导，`theme` 由宿主注入
 *   - 只 import `@studio/sdk`，不碰宿主内部的相对路径
 *
 * 三条硬规矩（违反了换画幅就会崩、换主题就会脏）：
 *  1. **禁止写 px**：尺寸一律 `u(n)`（短边百分比）或 `h(n)`（字号百分比），
 *     竖屏 1080×1920 与横屏 1920×1080 下文字物理大小才一致。
 *  2. 颜色从 `theme.palette` 取，不要写死色值。
 *  3. 入场动画用 `useEnter(delay)`，它已经处理了「动效强度=0」的降级。
 */
type Props = {
  theme: Theme;
  title: string;
  score: number;
  verdict: string;
  tags: string[];
  tone: "克制" | "热烈";
};

export default function ExampleRating({ theme, title, score, verdict, tags, tone }: Props) {
  const { u, h } = useSceneLayout();
  const enter = useEnter(0);
  const tagEnter = useEnter(12);

  // 「热烈」只换强调色，不换版式：插件可调项越少，用户越容易一次调对
  const accent = tone === "热烈" ? theme.palette.accent : theme.palette.primary;

  return (
    <SceneFrame theme={theme} align="left" justify="center">
      <div style={{ opacity: enter.opacity, transform: `translateY(${(enter.y ?? 0) * u(0.8)}px)` }}>
        <div
          style={{
            fontFamily: theme.font.body,
            fontSize: h(2.4),
            letterSpacing: "0.22em",
            color: theme.palette.textMuted,
          }}
        >
          {title || "综合评分"}
        </div>

        <div style={{ display: "flex", alignItems: "baseline", gap: u(2), marginTop: u(1.6) }}>
          <span
            style={{
              fontFamily: theme.font.heading,
              fontSize: h(16),
              fontWeight: 800,
              lineHeight: 0.88,
              color: accent,
            }}
          >
            {Number(score ?? 0).toFixed(1)}
          </span>
          <span style={{ fontFamily: theme.font.body, fontSize: h(3), color: theme.palette.textMuted }}>
            / 10
          </span>
        </div>

        <div
          style={{
            marginTop: u(3),
            width: u(48),
            height: u(0.35),
            background: withColorAlpha(theme.palette.textMuted, 0.25),
          }}
        />

        <div
          style={{
            marginTop: u(3),
            fontFamily: theme.font.heading,
            fontSize: h(4),
            fontWeight: 700,
            color: theme.palette.text,
          }}
        >
          {verdict}
        </div>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: u(1.5),
            marginTop: u(3.4),
            opacity: tagEnter.opacity,
            transform: `translateY(${(tagEnter.y ?? 0) * u(0.6)}px)`,
          }}
        >
          {(tags ?? []).map((t, i) => (
            <span
              key={`${t}-${i}`}
              style={{
                fontFamily: theme.font.body,
                fontSize: h(2.3),
                color: theme.palette.text,
                padding: `${u(0.8)}px ${u(1.9)}px`,
                borderRadius: u(0.7),
                border: `1px solid ${withColorAlpha(theme.palette.textMuted, 0.35)}`,
              }}
            >
              {t}
            </span>
          ))}
        </div>
      </div>
    </SceneFrame>
  );
}
