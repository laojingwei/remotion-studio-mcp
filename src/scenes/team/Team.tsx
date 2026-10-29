import React from "react";
import type { Theme } from "../../../shared/schema";
import { withColorAlpha } from "../../../shared/color";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useEnter } from "../ui";

export type TeamProps = {
  theme: Theme;
  heading: string;
  members: { name: string; role: string }[];
};

/** 团队/成员：头像圈 + 名字 + 角色 */
export const TeamScene: React.FC<TeamProps> = ({ theme, heading, members }) => {
  const { u, h, b, isPortrait } = useSceneLayout();
  const enter = useEnter(0);
  const c = theme.palette;
  const list = members.slice(0, 4);

  /**
   * 横屏排成等分列，竖屏保持「一行一个人名」的流式排列。
   *
   * 竖屏那套是头像在左、名字在右的横排成员卡，三个人加起来才 30% 宽，
   * 塞进 16:9 就是左上角一小撮。横屏把每个人立成一列（头像在上、名字在下），
   * 列间加发丝竖线，四个人的宽度就把画面撑满了 —— 也更像一张团队页。
   */
  const columns = !isPortrait && list.length > 1;

  return (
    <SceneFrame theme={theme} justify="center">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: u(3),
          width: columns ? "100%" : undefined,
          opacity: enter.opacity,
          transform: `translateY(${enter.y * u(1)}px)`,
        }}
      >
        {heading ? (
          <Editable id="heading" title="标题">
            <div style={{ fontFamily: theme.font.heading, fontSize: h(4), fontWeight: 800, color: c.text }}>
              {heading}
            </div>
          </Editable>
        ) : null}

        <div
          style={{
            display: "flex",
            flexWrap: columns ? "nowrap" : "wrap",
            alignItems: columns ? "stretch" : "center",
            gap: columns ? 0 : u(2.4),
            width: columns ? "100%" : undefined,
          }}
        >
          {list.map((m, i) => (
            <div
              key={`${m.name}-${i}`}
              style={{
                display: "flex",
                flexDirection: columns ? "column" : "row",
                // 列内居中：等分之后如果还左对齐，最后一列的字会贴在自己那格的左边，
                // 视觉上整块只到 70% 就断了（改版前就是这样）
                alignItems: "center",
                justifyContent: "center",
                textAlign: columns ? "center" : undefined,
                gap: columns ? u(2) : u(1.2),
                flex: columns ? 1 : undefined,
                minWidth: 0,
                paddingLeft: columns && i > 0 ? u(4) : 0,
                borderLeft:
                  columns && i > 0
                    ? `1px solid ${withColorAlpha(c.textMuted, 0.18)}`
                    : undefined,
              }}
            >
              <div
                style={{
                  width: u(columns ? 10 : 8),
                  height: u(columns ? 10 : 8),
                  flex: "0 0 auto",
                  borderRadius: "50%",
                  display: "grid",
                  placeItems: "center",
                  background: `${c.primary}22`,
                  border: `1px solid ${c.primary}`,
                  color: c.primary,
                  fontFamily: theme.font.heading,
                  fontSize: h(columns ? 3.2 : 2.6),
                  fontWeight: 800,
                }}
              >
                {m.name.slice(0, 1)}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: u(0.4), minWidth: 0 }}>
                <span
                  style={{
                    fontFamily: theme.font.heading,
                    fontSize: h(columns ? 2.8 : 2.1),
                    fontWeight: 700,
                    color: c.text,
                  }}
                >
                  {m.name}
                </span>
                <span style={{ fontFamily: theme.font.body, fontSize: b(columns ? 1.9 : 1.6), color: c.textMuted }}>
                  {m.role}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </SceneFrame>
  );
};
