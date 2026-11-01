import { z } from "zod";
import { freeformPropsSchema } from "./freeform";

/**
 * 场景元信息（纯数据，不含 React）
 * 三处复用：Remotion 校验 / Agent 工具描述 / Web 属性面板
 */

/**
 * 场景最短时长（帧）。**唯一的来源**，时间轴手柄和 ops 层夹取都读它。
 *
 * 以前每个版式各写一个下限（30 / 45 / 60），而时间轴手柄允许拖到 15 帧：
 * 拖到 40 帧松手，落库时被 clamp 回 60 —— 表现出来就是"缩到某个长度会自己弹回去"。
 * 两端现在共用这个常量，手柄拖到哪，落库就是哪。
 */
export const MIN_SCENE_FRAMES = 15;

export type SceneMeta = {
  type: string;
  name: string;
  /** 选择器里的分组：开场 / 内容 / 数据 / 收尾 / 自定义 */
  category: string;
  summary: string;
  schema: z.ZodObject<z.ZodRawShape>;
  defaultProps: Record<string, unknown>;
  duration: { default: number; min: number; max: number };
  /**
   * 支持拖动/旋转/缩放的元素。
   * id 要和场景组件里 <Editable id="…"> 对齐；
   * 用 {n} 表示按数量展开（如 item{n} → item1、item2…）。
   */
  elements?: { id: string; label: string; /** 对应 props 字段（默认同 id） */ prop?: string }[];
};

export const titleMeta: SceneMeta = {
  type: "title",
  name: "标题页",
  summary: "开场/章节标题，一句主标题加一句副标题",
  category: "通用",
  schema: z.object({
    eyebrow: z.string().default("").describe("顶部小标签，可留空"),
    title: z.string().describe("主标题，建议 6-14 字"),
    subtitle: z.string().default("").describe("副标题，可留空"),
    highlight: z.string().default("").describe("主标题中需要高亮的词（会换强调色）"),
    align: z.enum(["left", "center"]).default("left").describe("对齐方式"),
  }),
  defaultProps: {
    eyebrow: "CHAPTER 01",
    title: "做一支会自己长大的动画",
    subtitle: "数据驱动 · 双画幅同源",
    highlight: "动画",
    align: "left",
  },
  duration: { default: 105, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "eyebrow", label: "顶部小标签" },{ id: "title", label: "主标题" },{ id: "subtitle", label: "副标题" }],
};

export const bulletsMeta: SceneMeta = {
  type: "bullets",
  name: "要点列表",
  summary: "2-5 条要点，逐条错峰入场",
  category: "通用",
  schema: z.object({
    heading: z.string().default("").describe("列表上方的标题，可留空"),
    items: z
      .array(
        z.object({
          text: z.string().describe("要点文字"),
          note: z.string().default("").describe("灰色补充说明，可留空"),
        }),
      )
      .min(1)
      .max(5)
      .describe("要点数组，1-5 条"),
  }),
  defaultProps: {
    heading: "三条原则",
    items: [
      { text: "数据与代码分离", note: "agent 只改 JSON，不碰组件" },
      { text: "一份 schema 三处用", note: "渲染 / 工具 / 表单" },
      { text: "编辑动作即事件", note: "可撤销、可广播、可审计" },
    ],
  },
  duration: { default: 150, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "heading", label: "小标题" },{ id: "item{n}", label: "每个要点行" }],
};

export const chartMeta: SceneMeta = {
  type: "chart",
  name: "数据图表",
  summary: "动态柱状图，柱子按高度依次长出",
  category: "通用",
  schema: z.object({
    heading: z.string().describe("图表标题"),
    unit: z.string().default("").describe("数值单位，如 %、万"),
    scale: z
      .enum(["linear", "log"])
      .default("linear")
      .describe(
        "纵轴口径：linear 线性 / log 对数。数据跨数量级（比如 3 和 6800 同屏）时用 log，" +
          "否则小值的柱子矮到看不见，像数据丢了；用 log 会在图上标「对数轴」",
      ),
    data: z
      .array(
        z.object({
          label: z.string().describe("X 轴标签"),
          value: z.number().describe("数值"),
          color: z
            .string()
            .optional()
            .describe("这根柱子的颜色（CSS 色值，如 #00FFCC）；不传用主题色"),
        }),
      )
      .min(2)
      .max(6)
      .describe("数据，2-6 项"),
  }),
  defaultProps: {
    heading: "一周产出对比",
    unit: "条",
    data: [
      { label: "手搓", value: 3 },
      { label: "模板", value: 12 },
      { label: "协同", value: 41 },
      { label: "全自动", value: 68 },
    ],
  },
  duration: { default: 150, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "heading", label: "图表标题" },{ id: "chart", label: "图表整体" }],
};

export const quoteMeta: SceneMeta = {
  type: "quote",
  name: "引用金句",
  summary: "大字号金句 + 出处，适合情绪停顿",
  category: "通用",
  schema: z.object({
    text: z.string().describe("金句内容"),
    author: z.string().default("").describe("出处/作者，可留空"),
    highlight: z.string().default("").describe("需要高亮的词"),
  }),
  defaultProps: {
    text: "让机器看见自己改的东西，它才敢独立交付。",
    author: "设计笔记",
    highlight: "看见",
  },
  duration: { default: 120, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "quote", label: "金句正文" },{ id: "author", label: "署名" }],
};

export const outroMeta: SceneMeta = {
  type: "outro",
  name: "结尾 CTA",
  summary: "收尾页，一行行动号召",
  category: "通用",
  schema: z.object({
    eyebrow: z.string().default("THE END").describe("顶部小标签（中文片可改，如「完」）"),
    title: z.string().describe("号召语"),
    action: z.string().default("").describe("次要说明"),
    handle: z.string().default("").describe("账号/链接，可留空（schema 默认就是空；模板里别写占位账号）"),
  }),
  defaultProps: {
    eyebrow: "THE END",
    title: "现在就开一支",
    action: "对着 agent 说一句话就行",
    handle: "@remotion-studio",
  },
  duration: { default: 120, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "eyebrow", label: "顶部小标签" },{ id: "title", label: "主标题" },{ id: "action", label: "行动号召" }],
};

export const imageMeta: SceneMeta = {
  type: "image",
  name: "图片页",
  summary: "全屏图片 + 压角标题，适合实拍、截图、产品图",
  category: "通用",
  schema: z.object({
    src: z.string().describe("图片地址：上传后自动填入，也可直接填公网 URL"),
    kicker: z.string().default("").describe("图片上方的小标签，可留空"),
    caption: z.string().default("").describe("压在图片左下角的标题，可留空"),
    fit: z.enum(["contain", "cover"]).default("contain").describe("contain 完整显示（留白处用模糊底），cover 满屏裁切"),
    scrim: z.number().min(0).max(1).default(0.55).describe("底部压暗强度 0-1"),
  }),
  defaultProps: { src: "", kicker: "", caption: "", fit: "contain", scrim: 0.45 },
  duration: { default: 120, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "kicker", label: "顶部小标签" },{ id: "caption", label: "图片标题" }],
};

export const stepsMeta: SceneMeta = {
  type: "steps",
  name: "步骤流程",
  summary: "2-4 步流程，竖屏纵向排列、横屏横向排列",
  category: "通用",
  schema: z.object({
    heading: z.string().default("").describe("上方标题，可留空"),
    items: z
      .array(
        z.object({
          title: z.string().describe("步骤名，建议 2-6 字"),
          desc: z.string().default("").describe("一句说明，可留空"),
        }),
      )
      .min(2)
      .max(4)
      .describe("步骤，2-4 个"),
  }),
  defaultProps: {
    heading: "怎么跑起来",
    items: [
      { title: "说需求", desc: "agent 读场景能力" },
      { title: "看效果", desc: "导关键帧自检" },
      { title: "交给你改", desc: "拖拽即可精修" },
    ],
  },
  duration: { default: 150, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "heading", label: "流程标题" },{ id: "step{n}", label: "每个步骤" }],
};


export const emptyMeta: SceneMeta = {
  type: "empty",
  name: "空白场景",
  category: "通用",
  summary: "只有背景，自己往上放元素/图片，做任意自定义页",
  schema: z.object({
    note: z.string().default("").describe("备注，不渲染，只给自己看"),
  }),
  defaultProps: { note: "" },
  duration: { default: 90, min: MIN_SCENE_FRAMES, max: 108000 },
};

export const captionMeta: SceneMeta = {
  type: "caption",
  name: "字幕",
  category: "通用",
  summary: "大号字幕 + 说话人，适合口播/解说",
  schema: z.object({
    text: z.string().describe("字幕内容，建议 10-24 字"),
    speaker: z.string().default("").describe("说话人/来源，可留空"),
    highlight: z.string().default("").describe("需要高亮的词，可留空"),
  }),
  defaultProps: {
    text: "这句话是口播字幕，agent 可以直接改",
    speaker: "发言人",
    highlight: "口播",
  },
  duration: { default: 90, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "speaker", label: "说话人" },{ id: "caption", label: "字幕" }],
};

export const compareMeta: SceneMeta = {
  type: "compare",
  name: "前后对比",
  category: "通用",
  summary: "左右两栏对比：之前 / 之后",
  schema: z.object({
    heading: z.string().default("").describe("上方标题，可留空"),
    leftTitle: z.string().default("之前").describe("左栏标题"),
    leftText: z.string().describe("左栏内容"),
    rightTitle: z.string().default("之后").describe("右栏标题"),
    rightText: z.string().describe("右栏内容"),
  }),
  defaultProps: {
    heading: "改之前 vs 改之后",
    leftTitle: "之前",
    leftText: "手写每一帧",
    rightTitle: "之后",
    rightText: "模板 + agent 一句话",
  },
  duration: { default: 120, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [
    { id: "heading", label: "标题" },
    { id: "leftTitle", label: "左栏标题" },
    { id: "leftText", label: "左栏内容" },
    { id: "rightTitle", label: "右栏标题" },
    { id: "rightText", label: "右栏内容" },
  ],
};

export const statsMeta: SceneMeta = {
  type: "stats",
  name: "数据大字",
  category: "通用",
  summary: "2-4 个关键数字，突出成果",
  schema: z.object({
    heading: z.string().default("").describe("上方标题，可留空"),
    items: z
      .array(
        z.object({
          value: z.string().describe("数字/结果，如 3.2x、98%"),
          label: z.string().describe("说明，如 产出速度"),
        }),
      )
      .min(1)
      .max(4)
      .describe("数字项，1-4 个"),
  }),
  defaultProps: {
    heading: "一周成果",
    items: [
      { value: "3.2x", label: "产出速度" },
      { value: "0", label: "手动改帧" },
    ],
  },
  duration: { default: 120, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "heading", label: "标题" },{ id: "num{n}", label: "每个数字" }],
};


/** 题材场景的通用构造：多种题材共用同一个 Showcase 组件，只是默认文案/装饰不同 */
const showcaseMeta = (opts: {
  type: string;
  name: string;
  category: string;
  summary: string;
  defaults: Record<string, unknown>;
}): SceneMeta => ({
  type: opts.type,
  name: opts.name,
  category: opts.category,
  summary: opts.summary,
  schema: z.object({
    badge: z.string().default("").describe("顶部小标签，可留空"),
    title: z.string().describe("主标题"),
    subtitle: z.string().default("").describe("副标题/时间/价格，可留空"),
    items: z.array(z.string()).max(4).default([]).describe("标签，0-4 个"),
  }),
  defaultProps: { badge: "", subtitle: "", items: [], ...opts.defaults },
  duration: { default: 105, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [
    { id: "title", label: "主标题" },
    { id: "subtitle", label: "副标题" },
    { id: "item{n}", label: "标签" },
  ],
});

export const lifeMeta = showcaseMeta({
  type: "life",
  name: "生活 Vlog",
  category: "生活",
  summary: "日常/旅行/美食记录的开场封面",
  defaults: {
    badge: "VLOG",
    title: "周末去山里发呆",
    subtitle: "2026.10.25 · 晴",
    items: ["徒步", "咖啡", "晚霞"],
  },
});

export const gameMeta = showcaseMeta({
  type: "game",
  name: "游戏封面",
  category: "游戏",
  summary: "赛季/版本更新/游戏宣传封面",
  defaults: {
    badge: "GAME",
    title: "新赛季：暗夜突围",
    subtitle: "v2.4 更新",
    items: ["排位", "新地图", "限定皮肤"],
  },
});

export const techMeta = showcaseMeta({
  type: "tech",
  name: "科技发布",
  category: "科技",
  summary: "产品发布/技术亮点展示",
  defaults: {
    badge: "TECH",
    title: "新一代 AI 工作站",
    subtitle: "更快、更安静",
    items: ["48 核", "液冷", "零噪音"],
  },
});

export const eduMeta = showcaseMeta({
  type: "edu",
  name: "课程封面",
  category: "教学",
  summary: "课程/教程/公开课封面",
  defaults: {
    badge: "COURSE",
    title: "三小时学会用 agent 做动画",
    subtitle: "讲师：老王",
    items: ["零基础", "可回放", "作业点评"],
  },
});

export const liveMeta = showcaseMeta({
  type: "live",
  name: "直播预告",
  category: "直播",
  summary: "直播预告/开播提醒",
  defaults: {
    badge: "LIVE",
    title: "今晚 8 点：现场改你的片子",
    subtitle: "10 月 25 日 20:00",
    items: ["连麦", "抽奖", "回放"],
  },
});

export const shopMeta = showcaseMeta({
  type: "shop",
  name: "商品卡",
  category: "电商",
  summary: "商品展示/价格/卖点",
  defaults: {
    badge: "SHOP",
    title: "便携补光灯 Pro",
    subtitle: "¥199 起",
    items: ["三档色温", "续航 8h", "送支架"],
  },
});

export const gameStatsMeta: SceneMeta = {
  type: "game-stats",
  name: "游戏战绩",
  category: "游戏",
  summary: "KDA/胜率等关键数据",
  schema: z.object({
    heading: z.string().default("").describe("上方标题，可留空"),
    items: z
      .array(z.object({ value: z.string().describe("数值"), label: z.string().describe("说明") }))
      .min(1)
      .max(4)
      .describe("数据项，1-4 个"),
  }),
  defaultProps: {
    heading: "本赛季战绩",
    items: [
      { value: "5.8", label: "KDA" },
      { value: "72%", label: "胜率" },
      { value: "128", label: "场次" },
    ],
  },
  duration: { default: 120, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "heading", label: "标题" },{ id: "num{n}", label: "每个数字" }],
};


export const listMeta: SceneMeta = {
  type: "list",
  name: "榜单清单",
  category: "生活",
  summary: "带序号的榜单/清单，逐行入场",
  schema: z.object({
    heading: z.string().default("").describe("标题，可留空"),
    items: z.array(z.object({ title: z.string(), note: z.string().default("") })).min(1).max(5),
  }),
  defaultProps: {
    heading: "本周值得做的三件事",
    items: [
      { title: "把旧视频重剪一版", note: "素材别浪费" },
      { title: "整理素材库", note: "删掉没用的" },
      { title: "学一个转场", note: "十分钟就够" },
    ],
  },
  duration: { default: 120, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "heading", label: "标题" },{ id: "item{n}", label: "每个条目" }],
};

export const timelineMeta: SceneMeta = {
  type: "timeline",
  name: "时间线",
  category: "教学",
  summary: "竖向时间节点，适合教程/复盘",
  schema: z.object({
    heading: z.string().default("").describe("标题，可留空"),
    items: z.array(z.object({ time: z.string(), text: z.string() })).min(2).max(4),
  }),
  defaultProps: {
    heading: "三步跑起来",
    items: [
      { time: "STEP 01", text: "说清楚要做什么" },
      { time: "STEP 02", text: "agent 读场景、改文案" },
      { time: "STEP 03", text: "你拖一拖精修，出片" },
    ],
  },
  duration: { default: 150, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "heading", label: "标题" },{ id: "item{n}", label: "每个节点" }],
};

export const pricingMeta: SceneMeta = {
  type: "pricing",
  name: "价格表",
  category: "电商",
  summary: "2-3 档价格，中间档高亮",
  schema: z.object({
    heading: z.string().default("").describe("标题，可留空"),
    items: z.array(z.object({ name: z.string(), price: z.string(), note: z.string().default("") })).min(1).max(3),
  }),
  defaultProps: {
    heading: "选一个适合你的",
    items: [
      { name: "基础版", price: "¥0", note: "个人随便玩" },
      { name: "进阶版", price: "¥99/月", note: "团队协作" },
      { name: "企业版", price: "定制", note: "私有部署" },
    ],
  },
  duration: { default: 120, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "heading", label: "标题" },{ id: "item{n}", label: "每档价格" }],
};

export const bigtextMeta: SceneMeta = {
  type: "bigtext",
  name: "大字报",
  category: "情感",
  summary: "一句超大字，适合态度/情绪/金句",
  schema: z.object({
    text: z.string().describe("大字内容，建议 4-10 字"),
    sub: z.string().default("").describe("下方小字，可留空"),
    highlight: z.string().default("").describe("需要高亮的词，可留空"),
  }),
  defaultProps: {
    text: "别等了 现在就做",
    sub: "最好的时间是昨天，其次是现在",
    highlight: "现在就做",
  },
  duration: { default: 90, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "text", label: "大字" },{ id: "sub", label: "小字" }],
};


export const heroMeta: SceneMeta = {
  type: "hero",
  name: "视觉封面",
  category: "通用",
  summary: "渐变光斑 + 超大标题，开场/发布会有冲击力",
  schema: z.object({
    badge: z.string().default("").describe("小标签，可留空"),
    title: z.string().describe("主标题，建议 4-10 字"),
    subtitle: z.string().default("").describe("副标题，可留空"),
    highlight: z.string().default("").describe("需要高亮的词，可留空"),
  }),
  defaultProps: {
    badge: "COMING SOON",
    title: "重新定义剪辑",
    subtitle: "一句话出片，剩下的交给时间轴",
    highlight: "重新定义",
  },
  duration: { default: 105, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "badge", label: "小标签" },{ id: "title", label: "主标题" },{ id: "subtitle", label: "副标题" }],
};

export const splitMeta: SceneMeta = {
  type: "split",
  name: "图文分栏",
  category: "通用",
  summary: "左文右图（竖屏上图下文），适合产品/教程",
  schema: z.object({
    title: z.string().describe("标题"),
    text: z.string().describe("正文"),
    imageSrc: z.string().default("").describe("图片地址，可留空（留空显示渐变占位）"),
  }),
  defaultProps: {
    title: "把时间花在创意上",
    text: "排版、动效、多画幅都交给模板，你只负责想清楚要说什么。",
    imageSrc: "",
  },
  duration: { default: 120, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "title", label: "标题" },{ id: "text", label: "正文" }],
};

export const cardsMeta: SceneMeta = {
  type: "cards",
  name: "卡片网格",
  category: "通用",
  summary: "2-4 张带序号的卡片，功能/亮点展示",
  schema: z.object({
    heading: z.string().default("").describe("标题，可留空"),
    items: z.array(z.object({ title: z.string(), desc: z.string().default("") })).min(2).max(4),
  }),
  defaultProps: {
    heading: "四个能力，一个工作流",
    items: [
      { title: "模板起步", desc: "挑一个直接改" },
      { title: "agent 改稿", desc: "说一句就改" },
      { title: "时间轴精修", desc: "拖到满意为止" },
      { title: "一键出片", desc: "竖屏横屏同步" },
    ],
  },
  duration: { default: 135, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "heading", label: "标题" },{ id: "item{n}", label: "每张卡片" }],
};

export const ringMeta: SceneMeta = {
  type: "ring",
  name: "环形数据",
  category: "数据",
  summary: "大圆环展示百分比，成果/进度",
  schema: z.object({
    heading: z.string().default("").describe("标题，可留空"),
    percent: z.string().describe("百分比数字，如 72（写成 72% 也可以，渲染时会去掉多余的百分号）"),
    label: z.string().describe("说明，如 完成率"),
    sub: z.string().default("").describe("补充说明，可留空"),
  }),
  defaultProps: {
    heading: "本周进度",
    percent: "72",
    label: "完成率",
    sub: "比上周快了 1.8 倍",
  },
  duration: { default: 120, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "heading", label: "标题" },{ id: "percent", label: "百分比" },{ id: "label", label: "说明" }],
};

export const chatMeta: SceneMeta = {
  type: "chat",
  name: "对话气泡",
  category: "教学",
  summary: "像聊天记录，适合答疑/案例/生活",
  schema: z.object({
    heading: z.string().default("").describe("标题，可留空"),
    messages: z
      .array(z.object({ side: z.enum(["left", "right"]), text: z.string() }))
      .min(2)
      .max(4),
  }),
  defaultProps: {
    heading: "真实对话",
    messages: [
      { side: "left", text: "这个场景能改文案吗？" },
      { side: "right", text: "能，选中直接改，实时同步。" },
      { side: "left", text: "那我能自己加元素吗？" },
      { side: "right", text: "可以，拖进来就行。" },
    ],
  },
  duration: { default: 135, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "heading", label: "标题" },{ id: "msg{n}", label: "每条消息" }],
};

export const countdownMeta: SceneMeta = {
  type: "countdown",
  name: "倒计时",
  category: "电商",
  summary: "超大数字 + 说明，直播/促销",
  schema: z.object({
    value: z.string().describe("大数字，如 08:00、¥99"),
    title: z.string().describe("标题"),
    subtitle: z.string().default("").describe("说明，可留空"),
  }),
  defaultProps: {
    value: "08:00",
    title: "距离开播还有",
    subtitle: "10 月 25 日 20:00 · 不见不散",
  },
  duration: { default: 90, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "value", label: "大数字" },{ id: "title", label: "标题" },{ id: "subtitle", label: "说明" }],
};


export const galleryMeta: SceneMeta = {
  type: "gallery",
  name: "多图网格",
  category: "通用",
  summary: "2-4 张图拼成网格，产品/旅行/美食",
  schema: z.object({
    heading: z.string().default("").describe("标题，可留空"),
    images: z.array(z.string()).max(4).default([]).describe("图片地址，留空用渐变占位"),
  }),
  defaultProps: { heading: "最近的几张", images: [] },
  duration: { default: 120, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "heading", label: "标题" }],
};

export const barsMeta: SceneMeta = {
  type: "bars",
  name: "进度条组",
  category: "数据",
  summary: "2-4 条进度，技能/完成度",
  schema: z.object({
    heading: z.string().default("").describe("标题，可留空"),
    items: z.array(z.object({ label: z.string(), percent: z.number().min(0).max(100) })).min(1).max(4),
  }),
  defaultProps: {
    heading: "能力分布",
    items: [
      { label: "脚本", percent: 82 },
      { label: "拍摄", percent: 64 },
      { label: "剪辑", percent: 91 },
    ],
  },
  duration: { default: 120, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "heading", label: "标题" },{ id: "label{n}", label: "每行标签" }],
};

export const versusMeta: SceneMeta = {
  type: "versus",
  name: "VS 对战",
  category: "游戏",
  summary: "左右两强对比，中间 VS 徽标",
  schema: z.object({
    heading: z.string().default("").describe("顶部标题，可留空"),
    leftTitle: z.string().default("我的队伍"),
    leftText: z.string().describe("左侧说明"),
    rightTitle: z.string().default("对面"),
    rightText: z.string().describe("右侧说明"),
  }),
  defaultProps: {
    leftTitle: "夜行者",
    leftText: "高机动、爆发强，适合打野",
    rightTitle: "铁壁",
    rightText: "高防御、持续输出，适合守线",
  },
  duration: { default: 120, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [
    { id: "leftTitle", label: "左标题" },
    { id: "leftText", label: "左说明" },
    { id: "rightTitle", label: "右标题" },
    { id: "rightText", label: "右说明" },
  ],
};

export const qrMeta: SceneMeta = {
  type: "qr",
  name: "关注二维码",
  category: "通用",
  summary: "二维码占位 + 引导文案，收尾引流",
  schema: z.object({
    heading: z.string().default("扫码关注"),
    sub: z.string().default(""),
    qrText: z.string().default(""),
  }),
  defaultProps: { heading: "扫码关注", sub: "回复「模板」领取同款工程", qrText: "ID: remotion-studio" },
  duration: { default: 105, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "heading", label: "标题" },{ id: "sub", label: "说明" },{ id: "qrText", label: "底部小字" }],
};

export const ratingMeta: SceneMeta = {
  type: "rating",
  name: "星级评价",
  category: "电商",
  summary: "五星 + 用户原话，口碑展示",
  schema: z.object({
    heading: z.string().default(""),
    quote: z.string().describe("用户评价"),
    author: z.string().default(""),
    stars: z.number().min(1).max(5).default(5).describe("星级 1-5"),
  }),
  defaultProps: {
    heading: "他们怎么说",
    quote: "原来要剪一下午的片子，现在十分钟就出片了。",
    author: "小红书 @某某",
    stars: 5,
  },
  duration: { default: 120, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "heading", label: "标题" },{ id: "quote", label: "评价" },{ id: "author", label: "署名" }],
};

export const tableMeta: SceneMeta = {
  type: "table",
  name: "数据表格",
  category: "数据",
  summary: "3 列 2-3 行对比表，参数/套餐",
  schema: z.object({
    heading: z.string().default(""),
    // 表头可配：早先写死「项目/基础版/进阶版」，换个场景就不合身了
    columns: z
      .array(z.string())
      .max(3)
      .default(["项目", "基础版", "进阶版"])
      .describe("三列表头，留空数组则用默认表头"),
    rows: z.array(z.object({ a: z.string(), b: z.string(), c: z.string() })).min(2).max(3),
  }),
  defaultProps: {
    heading: "版本对比",
    columns: ["项目", "基础版", "进阶版"],
    rows: [
      { a: "导出画幅", b: "2 种", c: "不限" },
      { a: "协作成员", b: "1 人", c: "10 人" },
      { a: "私有部署", b: "—", c: "支持" },
    ],
  },
  duration: { default: 135, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "heading", label: "标题" }],
};

export const tagsMeta: SceneMeta = {
  type: "tags",
  name: "标签云",
  category: "生活",
  summary: "大小交错的标签，关键词/话题",
  schema: z.object({
    heading: z.string().default(""),
    items: z.array(z.string()).min(2).max(8),
  }),
  defaultProps: {
    heading: "本周关键词",
    items: ["剪辑", "agent", "时间轴", "出片", "转场", "模板"],
  },
  duration: { default: 105, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "heading", label: "标题" }],
};

export const teamMeta: SceneMeta = {
  type: "team",
  name: "团队成员",
  category: "通用",
  summary: "2-4 位成员头像 + 角色",
  schema: z.object({
    heading: z.string().default(""),
    members: z.array(z.object({ name: z.string(), role: z.string().default("") })).min(1).max(4),
  }),
  defaultProps: {
    heading: "做这支片子的人",
    members: [
      { name: "老王", role: "导演" },
      { name: "小李", role: "剪辑" },
      { name: "阿May", role: "配音" },
    ],
  },
  duration: { default: 120, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "heading", label: "标题" }],
};


export const auroraMeta: SceneMeta = {
  type: "aurora",
  name: "极光封面",
  category: "通用",
  summary: "多层霓虹光斑铺底，氛围感最强的开场",
  schema: z.object({
    badge: z.string().default("").describe("小标签，可留空"),
    title: z.string().describe("主标题"),
    subtitle: z.string().default("").describe("副标题，可留空"),
    highlight: z.string().default("").describe("需要高亮的词，可留空"),
  }),
  defaultProps: {
    badge: "NEXT LEVEL",
    title: "把画面做成光",
    subtitle: "光斑、霓虹、粒子，一页一个氛围",
    highlight: "光",
  },
  duration: { default: 105, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "badge", label: "小标签" },{ id: "title", label: "主标题" },{ id: "subtitle", label: "副标题" }],
};

export const neonMeta: SceneMeta = {
  type: "neon",
  name: "霓虹标题",
  category: "科技",
  summary: "网格 + 发光描边大字，赛博感",
  schema: z.object({
    text: z.string().describe("霓虹字，建议 4-8 字"),
    sub: z.string().default("").describe("下方小字，可留空"),
  }),
  defaultProps: { text: "赛博 2026", sub: "NEON / GRID / GLOW" },
  duration: { default: 90, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "text", label: "霓虹字" },{ id: "sub", label: "小字" }],
};

export const starsMeta: SceneMeta = {
  type: "stars",
  name: "星光页",
  category: "情感",
  summary: "散布星点 + 光晕，适合结尾/品牌",
  schema: z.object({
    title: z.string().describe("标题"),
    sub: z.string().default("").describe("副标题，可留空"),
  }),
  defaultProps: { title: "让每一帧都发光", sub: "REMOTION STUDIO" },
  duration: { default: 105, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "title", label: "标题" },{ id: "sub", label: "副标题" }],
};

export const freeformMeta: SceneMeta = {
  type: "freeform",
  name: "自由画布",
  category: "通用",
  summary: "用数据描述任意画面：背景 + 元素 + 关键帧动画，模型自己排版（不受固定版式限制）",
  schema: freeformPropsSchema,
  defaultProps: {
    background: { kind: "glow", colors: ["#07070A", "#0B1033"], blur: 60 },
    elements: [
      {
        type: "text",
        text: "自由画布",
        x: 50,
        y: 44,
        size: 9,
        fill: "#F5F5F7",
        weight: 800,
        anim: [{ at: [0, 20], from: { opacity: 0, y: 52 }, to: { opacity: 1, y: 44 }, ease: "spring" }],
      },
      {
        type: "fx",
        kind: "glow",
        x: 30,
        y: 30,
        size: 40,
        color: "#5AC8FA",
        opacity: 0.5,
      },
    ],
  },
  duration: { default: 120, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [],
};

/* ────────────────────────── 动效场景（2026-10-31 新增） ──────────────────────────
 * 这一组的主体是「运动本身」而不是版面：光晕、颗粒、漏光、逐字弹跳、遮罩上翻。
 * 它们的 type 登记在 shared/sceneKinds.ts 的 MOTION_SCENE_TYPES 里 ——
 * 设计锁对它们跳过「一屏文字元素 / 标题字号」检查（逐字动画天然几十个 span），
 * 但转场审计照旧。
 */

export const glowMeta: SceneMeta = {
  type: "glow",
  name: "光晕呼吸",
  category: "动效",
  summary: "整屏氛围光斑缓慢漂移，可叠一层极淡网格；适合开场、转场缓冲、情绪段落",
  schema: z.object({
    tone: z.enum(["双色", "主色", "次色"]).default("双色").describe("光斑配色：双色最热闹，单色更克制"),
    intensity: z.number().min(0).max(1).default(0.55).describe("光斑浓度 0–1"),
    drift: z.boolean().default(true).describe("缓慢漂移；false = 完全静止"),
    grid: z.boolean().default(true).describe("叠一层极淡网格，给画面一点结构"),
  }),
  defaultProps: { tone: "双色", intensity: 0.55, drift: true, grid: true },
  duration: { default: 120, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [],
};

export const grainMeta: SceneMeta = {
  type: "grain",
  name: "胶片颗粒",
  category: "动效",
  summary: "做旧质感：逐帧跳动的颗粒 + 暗角；压在画面上能压掉数码味",
  schema: z.object({
    intensity: z.number().min(0).max(1).default(0.5).describe("颗粒浓度 0–1"),
    vignette: z.number().min(0).max(0.9).default(0.55).describe("暗角强度 0–0.9"),
    flicker: z.boolean().default(true).describe("颗粒逐帧跳动；false = 静态颗粒"),
  }),
  defaultProps: { intensity: 0.5, vignette: 0.55, flicker: true },
  duration: { default: 120, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [],
};

export const lightleakMeta: SceneMeta = {
  type: "lightleak",
  name: "漏光扫过",
  category: "动效",
  summary: "一束光带周期性划过画面，暖金或青蓝；转场补光、情绪高点都能用",
  schema: z.object({
    tone: z.enum(["暖", "冷"]).default("暖").describe("暖（橙金）/ 冷（青蓝）"),
    periodSec: z.number().min(1.5).max(12).default(4).describe("扫过一次用几秒，推荐 3–6"),
    intensity: z.number().min(0).max(1).default(0.6).describe("光带强度 0–1"),
    angle: z.number().min(-60).max(60).default(18).describe("光带倾角，0 = 横向"),
  }),
  defaultProps: { tone: "暖", periodSec: 4, intensity: 0.6, angle: 18 },
  duration: { default: 120, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [],
};

export const kineticMeta: SceneMeta = {
  type: "kinetic",
  name: "弹跳字",
  category: "动效",
  summary: "逐字弹入并轻微摇摆；自动折行，竖屏长句也放得下",
  schema: z.object({
    text: z.string().describe("主文案，逐字入场；建议 6–20 字，超过会自动折行"),
    highlight: z.string().default("").describe("要高亮的词（换强调色），可留空"),
    sub: z.string().default("").describe("副标题，可留空"),
  }),
  defaultProps: {
    text: "好内容值得被认真对待",
    highlight: "认真",
    sub: "别把凑合当成风格",
  },
  duration: { default: 120, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "text", label: "主文案" }, { id: "sub", label: "副标题" }],
};

export const maskrevealMeta: SceneMeta = {
  type: "maskreveal",
  name: "遮罩上翻",
  category: "动效",
  summary: "每行文案从裁切框里升起，逐行错峰；适合金句与结论页",
  schema: z.object({
    kicker: z.string().default("").describe("顶部小标签，可留空"),
    lines: z.array(z.string()).min(1).describe("文案行，行数不限；行多时字号自动缩小排进画面"),
    accentLine: z.string().default("").describe("要高亮的那一行（换强调色），可留空"),
  }),
  defaultProps: {
    kicker: "结论",
    lines: ["先讲清楚", "再给证据", "最后给行动理由"],
    accentLine: "税最后再扣一层",
  },
  duration: { default: 120, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "kicker", label: "小标签" }, { id: "line{n}", label: "每一行" }],
};

/* ─────────── 第二批：文字强调（4 个） ─────────── */

export const typewriterMeta: SceneMeta = {
  type: "typewriter",
  name: "打字机",
  category: "动效",
  summary: "逐字打出 + 光标闪烁；适合要被读完的一句话（结论、条款、步骤）",
  schema: z.object({
    text: z.string().default("这句话值得一个字一个字读完").describe("主文案，支持 \\n 换行"),
    sub: z.string().default("").describe("副标题，打完字才出现，可留空"),
    speed: z.number().min(1).max(40).default(10).describe("每秒打几个字（中文 8–14 最自然）"),
    cursor: z.boolean().default(true).describe("显示闪烁光标"),
  }),
  defaultProps: { text: "这句话值得一个字一个字读完", sub: "", speed: 10, cursor: true },
  duration: { default: 120, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "text", label: "主文案" }, { id: "sub", label: "副标题" }],
};

export const counterMeta: SceneMeta = {
  type: "counter",
  name: "数字滚动",
  category: "动效",
  summary: "大数字从 0 弹到目标值 + 一条强调线；适合要让人记住的量（金额、涨幅、数量）",
  schema: z.object({
    value: z.number().default(370).describe("目标数字（可小数，如 1.2 表示 1.2 万）"),
    prefix: z
      .string()
      .default("¥")
      .describe("前缀，如 ¥ / +。**数字带单位（°/%/万）时请显式传 \"\"**——默认 ¥ 会直接上屏"),
    suffix: z.string().default("").describe("后缀，如 万 / 元 / %，可留空"),
    label: z.string().default("到手只剩这些").describe("数字下面的说明，可留空"),
    decimals: z.number().int().min(0).max(3).default(0).describe("小数位数"),
  }),
  defaultProps: { value: 370, prefix: "¥", suffix: "", label: "到手只剩这些", decimals: 0 },
  duration: { default: 110, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "value", label: "数字" }, { id: "label", label: "说明" }],
};

export const gradienttextMeta: SceneMeta = {
  type: "gradienttext",
  name: "渐变字",
  category: "动效",
  summary: "标题用主题双色渐变填充并缓慢流动；适合口号、金句、章节标题",
  schema: z.object({
    text: z.string().default("把复杂留给我们\n把简单留给你").describe("主文案，支持 \\n 换行"),
    sub: z.string().default("").describe("副标题，可留空"),
    direction: z.enum(["横向", "斜向"]).default("横向").describe("渐变方向"),
    flow: z.boolean().default(true).describe("渐变缓慢流动；false = 静态渐变"),
  }),
  defaultProps: { text: "把复杂留给我们\n把简单留给你", sub: "", direction: "横向", flow: true },
  duration: { default: 120, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "text", label: "主文案" }, { id: "sub", label: "副标题" }],
};

export const scrambleMeta: SceneMeta = {
  type: "scramble",
  name: "乱码解码",
  category: "动效",
  summary: "每个字先显示乱码再逐字解出真字；适合科技感结论、数据揭示",
  schema: z.object({
    text: z.string().default("账面流水不等于到手").describe("主文案"),
    sub: z.string().default("").describe("副标题，可留空"),
    revealFrames: z.number().int().min(4).max(40).default(14).describe("每个字解码所需帧数（越大越慢）"),
    stagger: z.number().int().min(1).max(6).default(2).describe("相邻字错开几帧"),
  }),
  defaultProps: { text: "账面流水不等于到手", sub: "", revealFrames: 14, stagger: 2 },
  duration: { default: 120, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "text", label: "主文案" }, { id: "sub", label: "副标题" }],
};

/* ─────────── 第二批：背景氛围（3 个） ─────────── */

export const bokehMeta: SceneMeta = {
  type: "bokeh",
  name: "散景光斑",
  category: "氛围",
  summary: "十几到二十几个失焦柔光圆缓慢漂浮，有前后景深；适合夜景、节日、回忆段落",
  schema: z.object({
    count: z.number().int().min(6).max(28).default(14).describe("光斑数量 6–28"),
    sizePct: z.number().min(4).max(18).default(9).describe("光斑尺寸（短边百分比）"),
    glow: z.number().min(0).max(1).default(0.5).describe("亮度 0–1"),
    drift: z.boolean().default(true).describe("缓慢漂浮；false = 静止"),
  }),
  defaultProps: { count: 14, sizePct: 9, glow: 0.5, drift: true },
  duration: { default: 150, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [],
};

export const sparksMeta: SceneMeta = {
  type: "sparks",
  name: "上升火花",
  category: "氛围",
  summary: "小亮点从底部升起，越往上越淡；适合强势开场、能量段落、转场缓冲",
  schema: z.object({
    count: z.number().int().min(20).max(160).default(60).describe("粒子数量 20–160"),
    speed: z.number().min(0.4).max(2.5).default(1).describe("上升速度倍率"),
    glow: z.number().min(0).max(1).default(0.55).describe("亮度 0–1"),
    ground: z.boolean().default(false).describe("只在下半屏飘（像地面扬起的火星）"),
  }),
  defaultProps: { count: 60, speed: 1, glow: 0.55, ground: false },
  duration: { default: 120, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [],
};

export const vhsMeta: SceneMeta = {
  type: "vhs",
  name: "磁带故障",
  category: "氛围",
  summary: "扫描线 + 红青色差 + 不定期 tracking 错位；适合复古、悬疑、故障感",
  schema: z.object({
    text: z.string().default("").describe("主文案，可留空（留空 = 纯氛围层）"),
    intensity: z.number().min(0).max(1).default(0.5).describe("故障强度 0–1"),
    lines: z.number().int().min(2).max(10).default(5).describe("扫描线密度（越大越密）"),
  }),
  defaultProps: { text: "", intensity: 0.5, lines: 5 },
  duration: { default: 120, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "text", label: "主文案" }],
};

/* ─────────── 第三批：文字强调（4 个） ─────────── */

export const highlightMeta: SceneMeta = {
  type: "highlight",
  name: "荧光扫亮",
  category: "动效",
  summary: "一句话里，某个词被一支笔从左扫亮；字不动、笔在动，适合抬起长句里的关键词",
  schema: z.object({
    text: z.string().describe("主文案，一句完整的话"),
    highlight: z.string().default("").describe("要扫亮的词，必须是 text 里的一段；留空 = 普通排版"),
    sub: z.string().default("").describe("副标题，扫完才出现，可留空"),
    mark: z.enum(["荧光笔", "色块", "下划线"]).default("荧光笔").describe("标记样式：荧光笔最柔和，色块最强调"),
  }),
  defaultProps: {
    text: "听完这场分享，我只记住了一句话",
    highlight: "一句话",
    sub: "别的都可以忘",
    mark: "荧光笔",
  },
  duration: { default: 120, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "text", label: "主文案" }, { id: "sub", label: "副标题" }],
};

export const stompMeta: SceneMeta = {
  type: "stomp",
  name: "冲击字",
  category: "动效",
  summary: "整块大字从近处砸下来，落地震一下、炸开一道横线；适合必须被记住的那一句",
  schema: z.object({
    text: z.string().describe("主文案，一行放得下最好；超过 8 字会自动缩小"),
    sub: z.string().default("").describe("副标题，砸完之后出现，可留空"),
    kicker: z.string().default("").describe("顶部小标签，可留空"),
  }),
  defaultProps: {
    text: "这钱不是你的",
    sub: "一句话说清，比十句话都管用",
    kicker: "先说结论",
  },
  duration: { default: 100, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "kicker", label: "小标签" }, { id: "text", label: "主文案" }, { id: "sub", label: "副标题" }],
};

export const wipeMeta: SceneMeta = {
  type: "wipe",
  name: "色带擦除",
  category: "动效",
  summary: "色带横向推开露出文案，逐行错峰；比遮罩上翻更有速度感，适合清单与步骤",
  schema: z.object({
    kicker: z.string().default("").describe("顶部小标签，可留空"),
    lines: z.array(z.string()).min(1).describe("文案行，行数不限；行多时字号自动缩小排进画面"),
    accentLine: z.string().default("").describe("要用主题色擦的那一行，可留空"),
  }),
  defaultProps: {
    kicker: "为什么会差这么多",
    lines: ["第一，讲清楚", "第二，给证据", "第三，给行动理由"],
    accentLine: "剩下的才轮到你",
  },
  duration: { default: 120, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "kicker", label: "小标签" }, { id: "line{n}", label: "每一行" }],
};

export const marqueeMeta: SceneMeta = {
  type: "marquee",
  name: "跑马灯",
  category: "动效",
  summary: "几行大字不停往一侧滚，行与行方向可相反；用来制造「信息很多」的体感",
  schema: z.object({
    rows: z.array(z.string()).min(1).describe("跑马灯内容，行数不限；行多时字号自动缩小排进画面"),
    speed: z.number().min(1).max(80).default(14).describe("每秒滚过一个文案宽度（10–30 最舒服）"),
    direction: z.enum(["左", "右", "交替"]).default("交替").describe("滚动方向；交替 = 相邻行反向"),
    separator: z.string().default(" · ").describe("文案之间的分隔符，可留空"),
  }),
  defaultProps: {
    rows: ["今日上新", "全场五折", "限时 24 小时"],
    speed: 14,
    direction: "交替",
    separator: " · ",
  },
  duration: { default: 150, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "row{n}", label: "每一行" }],
};

/* ─────────── 第三批：背景氛围（4 个） ─────────── */

export const spotlightMeta: SceneMeta = {
  type: "spotlight",
  name: "聚光扫射",
  category: "氛围",
  summary: "光柱从顶上打下、缓慢左右摆，地面留一圈光斑；给画面一个舞台",
  schema: z.object({
    tone: z.enum(["暖", "冷"]).default("暖").describe("光色：暖（金）/ 冷（冰蓝）"),
    sway: z.number().min(0).max(1).default(0.7).describe("摆动幅度 0–1，0 = 定住"),
    intensity: z.number().min(0).max(1).default(0.6).describe("亮度 0–1"),
    beams: z.number().int().min(1).max(3).default(2).describe("光柱数量 1–3"),
  }),
  defaultProps: { tone: "暖", sway: 0.7, intensity: 0.6, beams: 2 },
  duration: { default: 150, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [],
};

export const gridflowMeta: SceneMeta = {
  type: "gridflow",
  name: "赛博网格",
  category: "氛围",
  summary: "透视网格向脚下流动，地平线一圈发光；科技感开场、数据段落的底子",
  schema: z.object({
    horizon: z.number().min(12).max(55).default(42).describe("地平线高度（画面高度百分比）"),
    cells: z.number().int().min(6).max(22).default(12).describe("每侧竖线数量 6–22"),
    glow: z.number().min(0).max(1).default(0.6).describe("亮度 0–1"),
    flow: z.number().min(0.3).max(3).default(1).describe("流动速度倍率"),
  }),
  defaultProps: { horizon: 42, cells: 12, glow: 0.6, flow: 1 },
  duration: { default: 150, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [],
};

export const rainMeta: SceneMeta = {
  type: "rain",
  name: "雨幕",
  category: "氛围",
  summary: "斜雨丝持续下落 + 底部水汽；压情绪的段落用，比如困境、亏损、等待",
  schema: z.object({
    count: z.number().int().min(40).max(220).default(90).describe("雨丝数量 40–220"),
    angle: z.number().min(-30).max(30).default(14).describe("倾斜角（度），正数往右下"),
    speed: z.number().min(0.4).max(2.5).default(1).describe("下落速度倍率"),
    fog: z.number().min(0).max(1).default(0.5).describe("底部水汽浓度 0–1"),
  }),
  defaultProps: { count: 90, angle: 14, speed: 1, fog: 0.5 },
  duration: { default: 150, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [],
};

export const liquidMeta: SceneMeta = {
  type: "liquid",
  name: "流体色块",
  category: "氛围",
  summary: "几团色块缓慢变形、互相挤压；要「高级质感」时用它，别用光晕",
  schema: z.object({
    blobs: z.number().int().min(3).max(7).default(4).describe("色块数量 3–7"),
    tone: z.enum(["双色", "主色", "次色"]).default("双色").describe("配色：双色最热闹，单色更克制"),
    soft: z.number().min(0).max(1).default(0.6).describe("边缘柔和度 0–1"),
    speed: z.number().min(0.3).max(2.5).default(1).describe("流动速度倍率"),
  }),
  defaultProps: { blobs: 4, tone: "双色", soft: 0.6, speed: 1 },
  duration: { default: 150, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [],
};

/* ─────────── 第四批：数据（4 个） ─────────── */

export const gaugeMeta: SceneMeta = {
  type: "gauge",
  name: "仪表盘",
  category: "数据",
  summary: "270° 圆弧从 0 扫到目标值，中间大数字跟着滚；适合完成度、达成率、占比",
  schema: z.object({
    heading: z.string().default("").describe("顶部标题，可留空"),
    value: z.number().min(0).max(100).default(78).describe("数值 0–100"),
    unit: z.string().default("%").describe("数值后的单位"),
    label: z.string().default("").describe("仪表下方的说明，可留空"),
  }),
  defaultProps: {
    heading: "任务完成度",
    value: 78,
    unit: "%",
    label: "距离本月目标还差 22 个百分点",
  },
  duration: { default: 110, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "heading", label: "标题" }, { id: "label", label: "说明" }],
};

export const racebarsMeta: SceneMeta = {
  type: "racebars",
  name: "竞速条形",
  category: "数据",
  summary: "横条按值从大到小自动排序，第一名最长最亮；适合榜单、排行、多账号对比",
  schema: z.object({
    heading: z.string().default("").describe("顶部标题，可留空"),
    items: z
      .array(
        z.object({
          label: z.string().describe("条目名"),
          value: z.number().describe("数值（决定条的长度与名次）"),
          display: z.string().default("").describe("显示文本，可留空（留空显示数值）"),
        }),
      )
      .min(2)
      .max(5)
      .describe("2–5 条，顺序随便传，会自动按值排序"),
    suffix: z.string().default("").describe("数字后缀，如 %、万"),
  }),
  defaultProps: {
    heading: "本周人气榜",
    items: [
      { label: "小雅严选", value: 128000, display: "¥128,000" },
      { label: "老王说车", value: 96000, display: "¥96,000" },
      { label: "朵朵家", value: 73000, display: "¥73,000" },
      { label: "阿凯优品", value: 41000, display: "¥41,000" },
    ],
    suffix: "",
  },
  duration: { default: 130, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "heading", label: "标题" }, { id: "row{n}", label: "每一行" }],
};

export const funnelMeta: SceneMeta = {
  type: "funnel",
  name: "转化漏斗",
  category: "数据",
  summary: "几层横条逐层收窄，层间标转化率；曝光→进播→下单这类流程用它",
  schema: z.object({
    heading: z.string().default("").describe("顶部标题，可留空"),
    stages: z
      .array(
        z.object({
          label: z.string().describe("流程节点名"),
          value: z.number().describe("数值（决定层的宽度）"),
          display: z.string().default("").describe("显示文本，可留空（留空显示数值）"),
        }),
      )
      .min(3)
      .max(5)
      .describe("3–5 层，按流程顺序传（第一层最大），不排序"),
    showConversion: z
      .boolean()
      .default(false)
      .describe("层间是否显示「↓xx%」转化率。默认关：没给转化数据时自动算=凭空造数，要显示再开启"),
  }),
  defaultProps: {
    heading: "本场转化",
    stages: [
      { label: "曝光", value: 120000, display: "12.0万" },
      { label: "进店", value: 38000, display: "3.8万" },
      { label: "点击商品", value: 9600, display: "9,600" },
      { label: "成交", value: 2400, display: "2,400" },
    ],
  },
  duration: { default: 130, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "heading", label: "标题" }, { id: "stage{n}", label: "每一层" }],
};

export const deltaMeta: SceneMeta = {
  type: "delta",
  name: "涨跌对比",
  category: "数据",
  summary: "一个数字从 before 到 after，箭头 + 涨跌幅；适合活动前后、规则前后对比",
  schema: z.object({
    label: z.string().default("").describe("顶部小标签，说明这两个数是什么"),
    prefix: z.string().default("").describe("数字前缀，如 ¥"),
    before: z.number().default(1000).describe("之前的值"),
    after: z.number().default(370).describe("之后的值"),
    suffix: z.string().default("").describe("数字后缀，如 万"),
    tone: z.enum(["涨", "跌"]).default("跌").describe("箭头方向"),
    note: z.string().default("").describe("底部一句话解释，可留空"),
  }),
  defaultProps: {
    label: "到手价",
    prefix: "¥",
    before: 1000,
    after: 370,
    suffix: "",
    tone: "跌",
    note: "叠满所有优惠之后",
  },
  duration: { default: 110, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [
    { id: "label", label: "小标签" },
    { id: "before", label: "之前的值" },
    { id: "after", label: "之后的值" },
    { id: "note", label: "说明" },
  ],
};

/* ─────────── 第五批：粒子氛围（4 个）+ 数据图表（2 个） ─────────── */

export const confettiMeta: SceneMeta = {
  type: "confetti",
  name: "五彩纸屑",
  category: "氛围",
  summary: "小纸片翻着跟头往下落，主题四色轮转；庆祝、开奖、成交播报",
  schema: z.object({
    count: z.number().int().min(30).max(160).default(90).describe("纸屑数量 30–160"),
    speed: z.number().min(0.4).max(2).default(1).describe("下落速度倍率"),
    sway: z.number().min(0).max(1).default(0.6).describe("左右飘摆幅度 0–1"),
  }),
  defaultProps: { count: 90, speed: 1, sway: 0.6 },
  duration: { default: 150, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [],
};

export const snowMeta: SceneMeta = {
  type: "snow",
  name: "下雪",
  category: "氛围",
  summary: "柔边雪花慢落，大的在前小的在后；季节、节日、安静段落",
  schema: z.object({
    count: z.number().int().min(40).max(200).default(120).describe("雪花数量 40–200"),
    speed: z.number().min(0.4).max(2).default(1).describe("下落速度倍率"),
    drift: z.number().min(0).max(1).default(0.6).describe("左右飘摆幅度 0–1"),
  }),
  defaultProps: { count: 120, speed: 1, drift: 0.6 },
  duration: { default: 150, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [],
};

export const fireworksMeta: SceneMeta = {
  type: "fireworks",
  name: "烟花",
  category: "氛围",
  summary: "一组一组地放，炸开、下坠、熄灭；跨年、庆典、战报高光",
  schema: z.object({
    periodSec: z.number().min(2).max(12).default(5).describe("一轮多长（秒），一轮 = 一组齐放"),
    bursts: z.number().int().min(1).max(3).default(2).describe("一轮齐放几发 1–3"),
    intensity: z.number().min(0).max(1).default(0.7).describe("亮度 0–1"),
  }),
  defaultProps: { periodSec: 5, bursts: 2, intensity: 0.7 },
  duration: { default: 150, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [],
};

export const smokeMeta: SceneMeta = {
  type: "smoke",
  name: "烟雾",
  category: "氛围",
  summary: "几大团柔雾从底部升起、膨胀、散开；悬疑、压情绪、转场缓冲",
  schema: z.object({
    blobs: z.number().int().min(3).max(8).default(5).describe("团数 3–8"),
    rise: z.number().min(0.3).max(2).default(0.8).describe("上升速度倍率"),
    intensity: z.number().min(0).max(1).default(0.5).describe("浓度 0–1"),
    tone: z.enum(["灰", "主色"]).default("灰").describe("烟色：灰（跟墨色）/ 主色（环境光染色）"),
  }),
  defaultProps: { blobs: 5, rise: 0.8, intensity: 0.5, tone: "灰" },
  duration: { default: 150, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [],
};

export const linechartMeta: SceneMeta = {
  type: "linechart",
  name: "折线图",
  category: "数据",
  summary: "线从左往右画出来，数据点跟着线头亮起；趋势、涨跌走势",
  schema: z.object({
    heading: z.string().default("").describe("顶部标题，可留空"),
    unit: z.string().default("").describe("数值单位（如 万、%），标在数据点上"),
    data: z
      .array(
        z.object({
          label: z.string().describe("x 轴标签，如 周一 / 1月"),
          value: z.number().describe("数值"),
          display: z.string().default("").describe("显示文本，可留空（留空显示数值）"),
        }),
      )
      .min(3)
      .max(8)
      .describe("3–8 个点，按 x 轴顺序传"),
    smooth: z.boolean().default(true).describe("平滑曲线；false = 直线折线"),
    area: z.boolean().default(true).describe("线下方铺渐变"),
  }),
  defaultProps: {
    heading: "近一周场观",
    unit: "",
    data: [
      { label: "周一", value: 12000, display: "1.2万" },
      { label: "周二", value: 15500, display: "1.6万" },
      { label: "周三", value: 13200, display: "1.3万" },
      { label: "周四", value: 21000, display: "2.1万" },
      { label: "周五", value: 26400, display: "2.6万" },
    ],
    smooth: true,
    area: true,
  },
  duration: { default: 130, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "heading", label: "标题" }],
};

export const pieMeta: SceneMeta = {
  type: "pie",
  name: "占比饼图",
  category: "数据",
  summary: "环形多切片逐块扫出，配图例与百分比；构成、来源分布（单值进度用环形数据 ring）",
  schema: z.object({
    heading: z.string().default("").describe("顶部标题，可留空"),
    data: z
      .array(
        z.object({
          label: z.string().describe("切片名"),
          value: z.number().describe("数值（决定扇区大小）"),
          display: z.string().default("").describe("显示文本，可留空（留空显示数值）"),
        }),
      )
      .min(2)
      .max(6)
      .describe("2–6 块"),
    centerLabel: z.string().default("").describe("圆心文字（如 总 GMV），可留空"),
  }),
  defaultProps: {
    heading: "成交来源",
    centerLabel: "总 GMV",
    data: [
      { label: "店铺", value: 52000, display: "¥5.2万" },
      { label: "短视频", value: 31000, display: "¥3.1万" },
      { label: "搜索", value: 18000, display: "¥1.8万" },
      { label: "其他", value: 9000, display: "¥0.9万" },
    ],
  },
  duration: { default: 130, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "heading", label: "标题" }, { id: "legend{n}", label: "图例行" }],
};

/* ─────────── 第六批：文字/抽奖/氛围 + 布局（6 个） ─────────── */

export const waveMeta: SceneMeta = {
  type: "wave",
  name: "波浪字",
  category: "动效",
  summary: "一行大字逐字起伏呼吸，持续律动不是入场动画；口号悬停、音乐节奏段",
  schema: z.object({
    title: z.string().min(1).max(24).describe("一行字，建议 4–12 字"),
    amplitude: z.number().min(0).max(60).default(30).describe("起伏幅度（字号的百分比 0–60）"),
    waves: z.number().min(0.2).max(2).default(0.8).describe("每秒波峰数 0.2–2"),
  }),
  defaultProps: { title: "下一件就是宝贝", amplitude: 30, waves: 0.8 },
  duration: { default: 120, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "title", label: "标题" }],
};

export const slotMeta: SceneMeta = {
  type: "slot",
  name: "老虎机",
  category: "动效",
  summary: "三列符号滚轮依次减速停稳，停一列亮一列；直播抽奖、开奖揭晓",
  schema: z.object({
    heading: z.string().default("").describe("顶部标题，可留空"),
    symbols: z.array(z.string().min(1).max(4)).min(2).max(8).describe("符号池 2–8 个（emoji 或单字）"),
    result: z.string().default("").describe("中奖符号（必须在符号池里；留空取第一个）"),
    note: z.string().default("").describe("底部说明，可留空"),
  }),
  defaultProps: {
    heading: "整点抽奖",
    symbols: ["🎁", "💎", "🔥", "⭐"],
    result: "💎",
    note: "三列依次停稳，停一列亮一列",
  },
  duration: { default: 110, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "heading", label: "标题" }, { id: "note", label: "说明" }],
};

export const matrixMeta: SceneMeta = {
  type: "matrix",
  name: "字符雨",
  category: "氛围",
  summary: "竖列字符持续下落 + 亮头渐隐尾；黑客、终端、数据流（深色主题最出彩）",
  schema: z.object({
    cols: z.number().int().min(10).max(36).default(22).describe("列数 10–36"),
    speed: z.number().min(0.4).max(2.5).default(1).describe("下落速度倍率"),
    glow: z.number().min(0).max(1).default(0.7).describe("亮头强度 0–1"),
  }),
  defaultProps: { cols: 22, speed: 1, glow: 0.7 },
  duration: { default: 150, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [],
};

export const diagonalsplitMeta: SceneMeta = {
  type: "diagonalsplit",
  name: "斜切分屏",
  category: "通用",
  summary: "一条斜线把画面分成两半各讲各的；对比、交锋、转折（直切分栏 split 的斜线版）",
  schema: z.object({
    titleA: z.string().default("").describe("第一块标题"),
    textA: z.string().default("").describe("第一块正文"),
    titleB: z.string().default("").describe("第二块标题"),
    textB: z.string().default("").describe("第二块正文"),
    imageSrcA: z.string().default("").describe("第一块配图地址，可留空（留空用渐变占位）"),
    imageSrcB: z.string().default("").describe("第二块配图地址，可留空"),
    slant: z.number().min(0).max(25).default(10).describe("斜切错位量（短边百分比 0–25，0=直切）"),
  }),
  defaultProps: {
    titleA: "讲规则前",
    textA: "口头讲三遍，观众记不住",
    titleB: "讲规则后",
    textB: "写上屏，边看边听",
    imageSrcA: "",
    imageSrcB: "",
    slant: 10,
  },
  duration: { default: 110, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [
    { id: "atitle", label: "第一块标题" },
    { id: "atext", label: "第一块正文" },
    { id: "btitle", label: "第二块标题" },
    { id: "btext", label: "第二块正文" },
  ],
};

export const frameinframeMeta: SceneMeta = {
  type: "frameinframe",
  name: "画中画框",
  category: "通用",
  summary: "截图套浏览器/手机壳浮在渐变底上；讲产品、演示操作（没图也有假网页骨架）",
  schema: z.object({
    src: z.string().default("").describe("截图地址，可留空（留空显示假网页骨架）"),
    frame: z.enum(["浏览器", "手机"]).default("浏览器").describe("画框类型"),
    barText: z.string().default("").describe("地址栏 / 状态栏文字，可留空"),
    caption: z.string().default("").describe("框下方说明，可留空"),
  }),
  defaultProps: {
    src: "",
    frame: "浏览器",
    barText: "https://live.example.com",
    caption: "真实的操作界面，不是概念图",
  },
  duration: { default: 110, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "caption", label: "说明" }],
};

export const layeredMeta: SceneMeta = {
  type: "layered",
  name: "层叠卡片",
  category: "通用",
  summary: "几张卡片错位叠放，最前一张讲重点；焦点式（并列平铺用卡片网格 cards）",
  schema: z.object({
    items: z
      .array(
        z.object({
          title: z.string().describe("卡片标题"),
          text: z.string().default("").describe("卡片正文"),
        }),
      )
      .min(1)
      .max(4)
      .describe("1–4 张，最后一张在最前面（重点写最后）"),
  }),
  defaultProps: {
    items: [
      { title: "上架前", text: "标题带卖点，封面九宫格" },
      { title: "开播前", text: "3 秒抛钩子，福利前置" },
      { title: "现在", text: "话术跟着节奏走，别念稿" },
    ],
  },
  duration: { default: 110, min: MIN_SCENE_FRAMES, max: 108000 },
  elements: [{ id: "card{n}-title", label: "卡片标题" }, { id: "card{n}-text", label: "卡片正文" }],
};

export const SCENE_METAS: SceneMeta[] = [
  freeformMeta,
  titleMeta,
  bulletsMeta,
  chartMeta,
  quoteMeta,
  imageMeta,
  stepsMeta,
  outroMeta,
  emptyMeta,
  captionMeta,
  compareMeta,
  statsMeta,
  lifeMeta,
  gameMeta,
  techMeta,
  eduMeta,
  liveMeta,
  shopMeta,
  gameStatsMeta,
  listMeta,
  timelineMeta,
  pricingMeta,
  bigtextMeta,
  heroMeta,
  splitMeta,
  cardsMeta,
  ringMeta,
  chatMeta,
  countdownMeta,
  galleryMeta,
  barsMeta,
  versusMeta,
  qrMeta,
  ratingMeta,
  tableMeta,
  tagsMeta,
  teamMeta,
  auroraMeta,
  neonMeta,
  starsMeta,
  glowMeta,
  grainMeta,
  lightleakMeta,
  kineticMeta,
  maskrevealMeta,
  typewriterMeta,
  counterMeta,
  gradienttextMeta,
  scrambleMeta,
  bokehMeta,
  sparksMeta,
  vhsMeta,
  highlightMeta,
  stompMeta,
  wipeMeta,
  marqueeMeta,
  spotlightMeta,
  gridflowMeta,
  rainMeta,
  liquidMeta,
  gaugeMeta,
  racebarsMeta,
  funnelMeta,
  deltaMeta,
  confettiMeta,
  snowMeta,
  fireworksMeta,
  smokeMeta,
  linechartMeta,
  pieMeta,
  waveMeta,
  slotMeta,
  matrixMeta,
  diagonalsplitMeta,
  frameinframeMeta,
  layeredMeta,
];

export const getMeta = (type: string): SceneMeta | undefined =>
  SCENE_METAS.find((m) => m.type === type);

export const metaList = () =>
  SCENE_METAS.map((m) => ({
    type: m.type,
    name: m.name,
    category: m.category,
    summary: m.summary,
    duration: m.duration,
    elements: m.elements ?? [],
    fields: describeFields(m.schema),
  }));

/** 把 zod object 拆成字段描述，供 agent 与属性面板共用 */
export type FieldDesc = {
  key: string;
  kind: "text" | "number" | "boolean" | "enum" | "array" | "object";
  label: string;
  required: boolean;
  default?: unknown;
  options?: string[];
  itemShape?: FieldDesc[];
  /** 数组元素的形态：字符串/数字数组没有 itemShape，编辑器按这个渲染单输入框 */
  itemKind?: "string" | "number";
  /** 数组条数上下限（来自 z.array().min()/.max()）：编辑器据此控制增删按钮 */
  minItems?: number;
  maxItems?: number;
  /** 数值字段的范围与形态（来自 z.number().min()/.max()/.int()）：编辑器据此渲染滑动条 */
  numMin?: number;
  numMax?: number;
  numInt?: boolean;
  /** 滑动条步进值：整数走 1，其余按范围宽度推导 */
  numStep?: number;
};

export function describeFields(schema: z.ZodObject<z.ZodRawShape>): FieldDesc[] {
  const shape = schema.shape;
  return Object.entries(shape).map(([key, raw]) => {
    let node = raw as z.ZodTypeAny;
    const required = !(node instanceof z.ZodOptional);
    let def: unknown = undefined;
    if (node instanceof z.ZodDefault) {
      def = node._def.defaultValue();
      node = node._def.innerType;
    }
    if (node instanceof z.ZodOptional) node = node._def.innerType;
    const desc = raw.description ?? node.description ?? key;

    if (node instanceof z.ZodEnum) {
      return { key, kind: "enum", label: desc, required, default: def, options: node.options as string[] };
    }
    if (node instanceof z.ZodNumber) {
      // 把 schema 里的 .min()/.max()/.int() 抽出来：面板按范围渲染滑动条，
      // 步进值跟随范围（团数 3–8 走 1，倍率 0.3–2 走 0.1，浓度 0–1 走 0.05）
      const checks = (node._def.checks ?? []) as Array<{ kind: string; value?: number }>;
      let numMin: number | undefined;
      let numMax: number | undefined;
      let numInt = false;
      for (const chk of checks) {
        if (chk.kind === "min") numMin = chk.value;
        else if (chk.kind === "max") numMax = chk.value;
        else if (chk.kind === "int") numInt = true;
      }
      let numStep: number | undefined;
      if (numInt) numStep = 1;
      else if (numMin != null && numMax != null) {
        const range = numMax - numMin;
        numStep = range <= 1 ? 0.05 : range <= 2.5 ? 0.1 : range <= 10 ? 0.5 : 1;
      }
      return {
        key,
        kind: "number",
        label: desc,
        required,
        default: def,
        numMin,
        numMax,
        numInt: numInt || undefined,
        numStep,
      };
    }
    if (node instanceof z.ZodBoolean) {
      return { key, kind: "boolean", label: desc, required, default: def };
    }
    if (node instanceof z.ZodArray) {
      const inner = node.element as z.ZodTypeAny;
      const innerUnwrapped =
        inner instanceof z.ZodDefault ? inner._def.innerType :
        inner instanceof z.ZodOptional ? inner._def.innerType : inner;
      // 字符串/数字数组没有 itemShape，必须给 itemKind —— 否则编辑器
      // 「添加一项」会推进空对象，zod 当场拒（rows.1 应为 string 实际 object）
      const itemKind: FieldDesc["itemKind"] =
        innerUnwrapped instanceof z.ZodString || innerUnwrapped instanceof z.ZodEnum
          ? "string"
          : innerUnwrapped instanceof z.ZodNumber
            ? "number"
            : undefined;
      return {
        key,
        kind: "array",
        label: desc,
        required,
        default: def,
        itemShape: inner instanceof z.ZodObject ? describeFields(inner as z.ZodObject<z.ZodRawShape>) : [],
        itemKind,
        // 跑马灯 rows 这类带 .min()/.max() 的数组：编辑器必须在边界收住增删按钮，
        // 否则加到第 4 条才被服务端 zod 拒，用户只看到一句「rows 超出范围」
        minItems: node._def.minLength?.value,
        maxItems: node._def.maxLength?.value,
      };
    }
    // 对象/记录/联合（如 freeform.background）：不能当文本——按字符串传会直接校验失败
    if (
      node instanceof z.ZodObject ||
      node instanceof z.ZodRecord ||
      node instanceof z.ZodUnion ||
      node instanceof z.ZodEffects ||
      node instanceof z.ZodAny
    ) {
      return { key, kind: "object", label: desc, required, default: def };
    }
    return { key, kind: "text", label: desc, required, default: def };
  });
}

/** 校验并补全某场景的 props */
/** props 里有哪些 key 是当前场景类型不认识的（会被 zod strip 掉，需要告警） */
export function unknownProps(type: string, props: Record<string, unknown>): string[] {
  const meta = getMeta(type);
  if (!meta) return [];
  const known = new Set(Object.keys(meta.schema.shape));
  return Object.keys(props).filter((k) => !known.has(k));
}

/** 递归对比：parse 前后的对象里，input 有、output 没有的 key（含嵌套，如 data[0].color） */
function collectDropped(
  input: unknown,
  output: unknown,
  path: string,
  out: string[],
): void {
  if (Array.isArray(input) && Array.isArray(output)) {
    input.forEach((v, i) => collectDropped(v, output[i], `${path}[${i}]`, out));
    return;
  }
  if (input && typeof input === "object" && output && typeof output === "object") {
    for (const k of Object.keys(input as Record<string, unknown>)) {
      const childPath = path ? `${path}.${k}` : k;
      if (!(k in (output as Record<string, unknown>))) {
        out.push(childPath);
        continue;
      }
      collectDropped(
        (input as Record<string, unknown>)[k],
        (output as Record<string, unknown>)[k],
        childPath,
        out,
      );
    }
  }
}

/** 递归检查 props 里会被 schema 丢弃的字段（含数组内/对象内） */
export function droppedProps(type: string, props: Record<string, unknown>): string[] {
  const meta = getMeta(type);
  if (!meta) return [];
  const parsed = meta.schema.parse({ ...meta.defaultProps, ...props });
  const out: string[] = [];
  collectDropped(props, parsed, "", out);
  return out;
}

export function normalizeProps(type: string, props: Record<string, unknown>) {
  const meta = getMeta(type);
  if (!meta) throw new Error(`未知场景类型: ${type}`);
  return meta.schema.parse({ ...meta.defaultProps, ...props });
}
