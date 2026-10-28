import React from "react";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useEnter } from "../ui";

export type TeamProps = {
  theme: Theme;
  heading: string;
  members: { name: string; role: string }[];
};

/** 团队/成员：头像圈 + 名字 + 角色 */
export const TeamScene: React.FC<TeamProps> = ({ theme, heading, members }) => {
  const { u, h } = useSceneLayout();
  const enter = useEnter(0);
  const c = theme.palette;

  return (
    <SceneFrame theme={theme} justify="center">
      <div style={{ display: "flex", flexDirection: "column", gap: u(3), opacity: enter.opacity, transform: `translateY(${enter.y * u(1)}px)` }}>
        {heading ? (
          <Editable id="heading" title="标题">
            <div style={{ fontFamily: theme.font.heading, fontSize: h(4), fontWeight: 800, color: c.text }}>
              {heading}
            </div>
          </Editable>
        ) : null}

        <div style={{ display: "flex", flexWrap: "wrap", gap: u(2.4) }}>
          {members.slice(0, 4).map((m, i) => (
            <div key={`${m.name}-${i}`} style={{ display: "flex", alignItems: "center", gap: u(1.2) }}>
              <div
                style={{
                  width: u(8),
                  height: u(8),
                  borderRadius: "50%",
                  display: "grid",
                  placeItems: "center",
                  background: `${c.primary}22`,
                  border: `1px solid ${c.primary}`,
                  color: c.primary,
                  fontFamily: theme.font.heading,
                  fontSize: h(2.6),
                  fontWeight: 800,
                }}
              >
                {m.name.slice(0, 1)}
              </div>
              <div style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontFamily: theme.font.heading, fontSize: h(2.1), fontWeight: 700, color: c.text }}>
                  {m.name}
                </span>
                <span style={{ fontFamily: theme.font.body, fontSize: h(1.6), color: c.textMuted }}>
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
