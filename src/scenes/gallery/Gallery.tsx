import React from "react";
import type { Theme } from "../../../shared/schema";
import { useSceneLayout } from "../../layout/useSceneLayout";
import { Editable, SceneFrame, useEnter } from "../ui";

export type GalleryProps = {
  theme: Theme;
  heading: string;
  images: string[];
};

/** 多图网格：2-4 张图，留空用渐变占位 */
export const GalleryScene: React.FC<GalleryProps> = ({ theme, heading, images }) => {
  const { u, h } = useSceneLayout();
  const enter = useEnter(0);
  const c = theme.palette;

  return (
    <SceneFrame theme={theme} justify="center">
      <div style={{ display: "flex", flexDirection: "column", gap: u(2.4), width: "100%", opacity: enter.opacity }}>
        {heading ? (
          <Editable id="heading" title="标题">
            <div style={{ fontFamily: theme.font.heading, fontSize: h(4.2), fontWeight: 800, color: c.text }}>
              {heading}
            </div>
          </Editable>
        ) : null}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: u(1.6) }}>
          {images.slice(0, 4).map((src, i) => (
            <div
              key={`${src}-${i}`}
              style={{
                aspectRatio: "1 / 1",
                borderRadius: u(1.4),
                overflow: "hidden",
                background: src ? undefined : `linear-gradient(135deg, ${c.primary}2b, ${c.secondary}1f)`,
                border: `1px solid ${c.surface}`,
                display: "grid",
                placeItems: "center",
              }}
            >
              {src ? (
                <img src={src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                <span style={{ fontFamily: theme.font.body, fontSize: h(1.6), color: c.textMuted }}>IMAGE</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </SceneFrame>
  );
};
