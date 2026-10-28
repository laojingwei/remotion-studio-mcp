import React from "react";
import { Composition, type CalculateMetadataFunction } from "remotion";
import type { Project } from "../shared/schema";
import { totalDuration } from "../shared/schema";
import { createSeedProject } from "../shared/ops";
import { Video, type VideoProps } from "./Video";

const preview: Project = createSeedProject("preview");

/**
 * 画幅由 props 决定，不靠注册多个 Composition。
 *
 * 早期写法是 `preview.formats.map(f => <Composition id={`Video-${f.key}`} …>)`，
 * 结果画幅列表被种子里那两个写死 —— 用户在编辑器里加 1:1 / 4:5 之后，
 * renderStill 会直接报 `Could not find composition with ID Video-square`。
 * 现在只注册一个 `Video`，宽高由 calculateMetadata 从 inputProps 推导，
 * 数据里声明什么画幅就能出什么画幅。
 */
const calcMeta: CalculateMetadataFunction<VideoProps> = ({ props }) => {
  const fmt = props.formats.find((f) => f.key === props.formatKey) ?? props.formats[0];
  return {
    durationInFrames: Math.max(1, totalDuration(props)),
    fps: props.fps,
    width: fmt?.width ?? 1080,
    height: fmt?.height ?? 1920,
  };
};

export const RemotionRoot: React.FC = () => {
  const first = preview.formats[0];
  return (
    <Composition
      id="Video"
      component={Video}
      durationInFrames={totalDuration(preview)}
      fps={preview.fps}
      width={first.width}
      height={first.height}
      defaultProps={{ ...preview, formatKey: first.key }}
      calculateMetadata={calcMeta}
    />
  );
};
