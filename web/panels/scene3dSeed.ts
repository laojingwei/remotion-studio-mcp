/**
 * 「换成可编辑场景图」的最小种子：一颗主体球 + 点光/环境光 + 星尘 + 辉光。
 *
 * 面板（预置场景的入口）和 3D 视口的空态共用这一份——两处写两份，
 * 将来改种子必然只改一边。
 *
 * 注意它**不是**把预置母题翻译成节点树：预置画面由代码画，翻译不了。
 * 换完之后画面会变（变成这张最小图），文案里要说清这一点。
 */
export const SCENE3D_SEED: Record<string, unknown> = {
  camera: { position: [0, 2.2, 8], target: [0, 0, 0], fov: 42 },
  nodes: [
    {
      id: "core",
      label: "主体",
      geometry: { type: "sphere", radius: 1.4 },
      material: { color: "accent", emissive: "accent", emissiveIntensity: 0.55, metalness: 0.7, roughness: 0.25 },
    },
  ],
  lights: [
    { type: "point", position: [0, 0, 0], intensity: 18, color: "#ffffff" },
    { type: "ambient", intensity: 0.35 },
  ],
  particles: { count: 700, spread: [8, 5, 8], size: 0.05, color: "accent" },
  post: { bloom: 1.1 },
};
