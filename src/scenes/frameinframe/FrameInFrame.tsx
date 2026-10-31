import React from "react";
import type { Theme } from "../../../shared/schema";
import { withColorAlpha } from "../../../shared/color";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useEnter } from "../ui";

export type FrameInFrameProps = {
  theme: Theme;
  /** 截图 / 视频封面地址 */
  src: string;
  /** 画框类型：浏览器（顶部地址栏）/ 手机（顶部刘海） */
  frame: "浏览器" | "手机";
  /** 地址栏 / 状态栏上的文字，可留空 */
  barText: string;
  /** 框下方的说明，可留空 */
  caption: string;
};

/**
 * 画中画框：截图套一个"设备框"浮在渐变底上。
 *
 * 讲产品、讲功能、讲操作流程时，裸截图贴上去像 PPT 素材；
 * 套上浏览器/手机的壳，观感立刻是"演示"。
 * 没有 src 时浏览器框内画一张假网页（色块骨架），工程立起来就能看效果。
 */
export const FrameInFrameScene: React.FC<FrameInFrameProps> = ({
  theme,
  src = "",
  frame = "浏览器",
  barText = "",
  caption = "",
}) => {
  const { u, h, isPortrait } = useSceneLayout();
  const c = theme.palette;
  const enter = useEnter(0);

  const isBrowser = frame !== "手机";
  const barH = isBrowser ? u(4.2) : u(3.4);

  const fakePage = (
    <div style={{ position: "absolute", inset: 0, padding: u(2.4), display: "flex", flexDirection: "column", gap: u(1.6) }}>
      {/* 假网页骨架：色块 + 文字条 + 大图区，都从主题色出 */}
      <div style={{ height: u(2), width: "42%", borderRadius: 99, background: withColorAlpha(c.text, 0.3) }} />
      <div style={{ height: u(1.4), width: "68%", borderRadius: 99, background: withColorAlpha(c.text, 0.14) }} />
      <div style={{ flex: 1, borderRadius: u(1), background: `linear-gradient(135deg, ${c.primary}55, ${c.secondary}33)` }} />
    </div>
  );

  return (
    <SceneFrame theme={theme} align="center">
      <div
        style={{
          // 显式撑满：否则 shrink-to-fit，竖屏下画框缩成内容宽
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          flex: 1,
          justifyContent: "center",
          opacity: enter.opacity,
        }}
      >
        <Editable
          id="device"
          title="设备框"
          style={{
            width: isPortrait ? "100%" : "72%",
            maxWidth: u(96),
            borderRadius: u(1.8),
            overflow: "hidden",
            background: withColorAlpha(c.background, 0.92),
            border: `1px solid ${withColorAlpha(c.text, 0.14)}`,
            // 框的"厚度"：外阴影一层环境影 + 一层主题色反光
            boxShadow: `0 ${u(2.4)} ${u(6)} ${withColorAlpha("#000000", 0.35)}, 0 0 ${u(3)} ${withColorAlpha(
              c.primary,
              0.12,
            )}`,
          }}
        >
          {/* 顶栏 */}
          <div
            style={{
              height: barH,
              display: "flex",
              alignItems: "center",
              gap: u(1.2),
              padding: `0 ${u(1.6)}`,
              background: withColorAlpha(c.text, 0.07),
              borderBottom: `1px solid ${withColorAlpha(c.text, 0.08)}`,
            }}
          >
            {isBrowser ? (
              <>
                {["#FF5F57", "#FEBC2E", "#28C840"].map((dot) => (
                  <span key={dot} style={{ width: u(0.9), height: u(0.9), borderRadius: "50%", background: dot }} />
                ))}
                <span
                  style={{
                    marginLeft: u(1),
                    flex: 1,
                    height: barH * 0.52,
                    borderRadius: 99,
                    background: withColorAlpha(c.background, 0.75),
                    border: `1px solid ${withColorAlpha(c.text, 0.08)}`,
                    display: "flex",
                    alignItems: "center",
                    paddingLeft: u(1.2),
                    fontFamily: theme.font.body,
                    fontSize: h(1.7),
                    color: c.textMuted,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                  }}
                >
                  {barText || "https://live.example.com"}
                </span>
              </>
            ) : (
              <>
                <span style={{ flex: 1 }} />
                {/* 刘海：一颗摄像头点 */}
                <span style={{ width: u(1.1), height: u(1.1), borderRadius: "50%", background: withColorAlpha(c.text, 0.2) }} />
                <span style={{ flex: 1 }} />
              </>
            )}
          </div>
          {/* 屏幕内容：有图放图，没图放假骨架 */}
          <div style={{ position: "relative", height: isPortrait ? u(58) : u(42) }}>
            {src ? (
              <img src={src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
            ) : (
              fakePage
            )}
          </div>
        </Editable>

        {caption ? (
          <Editable
            id="caption"
            title="说明"
            style={{
              marginTop: u(3),
              fontFamily: theme.font.body,
              fontSize: h(isPortrait ? 2.4 : 2.1),
              color: c.textMuted,
              maxWidth: isPortrait ? u(76) : "60%",
            }}
          >
            {caption}
          </Editable>
        ) : null}
      </div>
    </SceneFrame>
  );
};
