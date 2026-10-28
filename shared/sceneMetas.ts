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
    handle: z.string().default("").describe("账号/链接，可留空"),
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
    speaker: "主播",
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
    percent: z.string().describe("百分比数字，如 72"),
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
      return { key, kind: "number", label: desc, required, default: def };
    }
    if (node instanceof z.ZodBoolean) {
      return { key, kind: "boolean", label: desc, required, default: def };
    }
    if (node instanceof z.ZodArray) {
      const inner = node.element as z.ZodTypeAny;
      return {
        key,
        kind: "array",
        label: desc,
        required,
        default: def,
        itemShape: inner instanceof z.ZodObject ? describeFields(inner as z.ZodObject<z.ZodRawShape>) : [],
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
