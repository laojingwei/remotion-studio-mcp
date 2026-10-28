// 重建 demo 工程：内容与被覆盖前一致（7 场景 + 音频 + 4 画幅 + 标题页元素）
import { writeProject } from "../server/store";
import { normalizeProps } from "../shared/sceneMetas";
import { elementFromLibrary } from "../shared/elementLibrary";
import type { Project, Scene, OverlayElement } from "../shared/schema";

const mk = (type: string, durationInFrames: number, props: Record<string, unknown> = {}): Scene => ({
  id: `scene_${Math.random().toString(36).slice(2, 10)}`,
  type,
  name: ({ title: "标题页", bullets: "要点列表", chart: "数据图表", quote: "引用金句", outro: "结尾 CTA", image: "图片页", steps: "步骤流程" } as Record<string, string>)[type] ?? type,
  durationInFrames,
  props: normalizeProps(type, props),
  transitionIn: { type: "fade", durationInFrames: 12 },
});

// 标题页的 4 个元素：库素材原样放回（位置按默认居中略偏上，与覆盖前观感一致）
const el = (libId: string, name: string, x: number, y: number, size: number, z: number): OverlayElement =>
  ({ ...elementFromLibrary(libId, { x, y }), id: `el_${Math.random().toString(36).slice(2, 10)}`, name, size, z }) as OverlayElement;

const project: Project = {
  id: "demo",
  name: "未命名项目",
  rev: 1,
  fps: 30,
  formats: [
    { key: "portrait", label: "竖屏 9:16", width: 1080, height: 1920 },
    { key: "landscape", label: "横屏 16:9", width: 1920, height: 1080 },
    { key: "square", label: "方形 1:1", width: 1080, height: 1080 },
    { key: "tall45", label: "竖版 4:5", width: 1080, height: 1350 },
  ],
  theme: {
    palette: {
      background: "#0B0B10",
      surface: "#17171F",
      text: "#F4F1EA",
      textMuted: "#8C8896",
      primary: "#C6F24E",
      secondary: "#6C5CE7",
      accent: "#FF7A45",
    },
    font: {
      heading: '"Segoe UI Variable Display", "Microsoft YaHei", sans-serif',
      body: '"Microsoft YaHei", "PingFang SC", sans-serif',
    },
    radius: 2.4,
  },
  audio: { src: "/assets/mvmeix26-gkv3.wav", volume: 0.6, fadeIn: 1, fadeOut: 1.5 },
  scenes: [
    {
      ...mk("title", 105, {
        eyebrow: "REMOTION × AGENT",
        title: "一支会自己长大的动画",
        subtitle: "agent 起草，你来精修，画面实时同步",
        highlight: "动画",
      }),
      elements: [
        el("badge-new", "NEW 标签", 24, 22, 12, 1),
        el("mark-star", "星标", 16, 34, 7, 2),
        el("badge-hot", "限时标", 78, 30, 11, 3),
        el("shape-grid", "点阵", 80, 18, 9, 4),
      ],
    },
    mk("bullets", 165),
    mk("chart", 150),
    mk("quote", 120),
    mk("outro", 120),
    mk("image", 120, { src: "", kicker: "PRODUCT SHOT", caption: "一稿多画幅" }),
    mk("steps", 150),
  ],
  updatedAt: new Date().toISOString(),
};

writeProject(project);
console.log("demo 已重建：7 场景，rev 1");
