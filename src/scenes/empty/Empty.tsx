import React from "react";
import { AbsoluteFill } from "remotion";
import type { Theme } from "../../../shared/schema";

/** 空白场景：只有背景，自由元素自己往上放 */
export type EmptyProps = { theme: Theme };

export const EmptyScene: React.FC<EmptyProps> = ({ theme }) => (
  <AbsoluteFill style={{ backgroundColor: theme.palette.background }} />
);
