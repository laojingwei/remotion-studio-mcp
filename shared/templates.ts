import { createSeedProject } from "./ops";
import { getMeta } from "./sceneMetas";
import type { Project } from "./schema";

/**
 * 模板市场 —— 「整片模板」。
 *
 * 本质是 Project 的**场景清单快照**：只描述"有哪些场景、各多少帧、props 是什么"，
 * 不写 id / rev / updatedAt（那些是实例的事）。套用时复用 createSeedProject 的
 * mk() 思路：normalizeProps 兜底校验，保证模板数据永远是合法工程。
 *
 * 为什么不做"任意 Project 存为模板"：整片快照会把演示数据、素材引用一起带走，
 * 素材一换机器就 404。内置模板手写内容，比"克隆上次的工程"更接近"模板"的本意。
 * （用户模板留到之后：存的时候把 image src 抽成占位符即可，见设计方案 §14。）
 */
export type TemplateSceneSpec = {
  type: string;
  durationInFrames?: number;
  props?: Record<string, unknown>;
};

export type ProjectTemplate = {
  key: string;
  name: string;
  description: string;
  tags: string[];
  scenes: TemplateSceneSpec[];
};

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    key: "blank",
    name: "空白工程",
    description: "只有开场和结尾，中间全靠你和 agent 现场发挥",
    tags: ["自由发挥"],
    scenes: [
      { type: "title", props: { eyebrow: "", title: "新工程", subtitle: "", highlight: "" } },
      { type: "outro", props: { title: "谢谢观看", action: "", handle: "" } },
    ],
  },
  {
    key: "pitch",
    name: "口播带货",
    description: "产品名开场 → 三大卖点 → 使用步骤 → 用户口碑 → 下单引导",
    tags: ["带货", "转化"],
    scenes: [
      {
        type: "title",
        durationInFrames: 105,
        props: {
          eyebrow: "今日推荐",
          title: "把复杂的事变简单",
          subtitle: "一支视频讲清它值不值",
          highlight: "简单",
        },
      },
      {
        type: "bullets",
        durationInFrames: 165,
        props: {
          heading: "为什么选它",
          items: [
            { text: "开箱即用", note: "不用配置，到手就能跑" },
            { text: "省一半时间", note: "自动化替代重复操作" },
            { text: "全程可回退", note: "改错了随时撤销" },
          ],
        },
      },
      {
        type: "steps",
        durationInFrames: 150,
        props: {
          heading: "三步上手",
          items: [
            { title: "拆盒", desc: "连接电源即启动" },
            { title: "配对", desc: "手机扫码一键绑定" },
            { title: "开跑", desc: "选个模式就行" },
          ],
        },
      },
      {
        type: "quote",
        durationInFrames: 120,
        props: {
          text: "用了两周，回不去了。",
          author: "首批用户评价",
          highlight: "回不去",
        },
      },
      {
        type: "outro",
        durationInFrames: 120,
        props: { title: "点击下方链接", action: "前 100 名送配件包", handle: "@官方旗舰店" },
      },
    ],
  },
  {
    key: "data",
    name: "数据复盘",
    description: "标题抛问题 → 柱状图看对比 → 拆解原因 → 金句收束",
    tags: ["周报", "复盘"],
    scenes: [
      {
        type: "title",
        durationInFrames: 105,
        props: {
          eyebrow: "WEEKLY REPORT",
          title: "这周产出翻了一倍",
          subtitle: "怎么回事，用数据说话",
          highlight: "翻了一倍",
        },
      },
      {
        type: "chart",
        durationInFrames: 165,
        props: {
          heading: "近四周产出",
          unit: "条",
          data: [
            { label: "W1", value: 14 },
            { label: "W2", value: 19 },
            { label: "W3", value: 33 },
            { label: "W4", value: 41 },
          ],
        },
      },
      {
        type: "bullets",
        durationInFrames: 165,
        props: {
          heading: "涨在哪",
          items: [
            { text: "模板复用率 60%", note: "同样的片头不再重做" },
            { text: "agent 起草初稿", note: "人只做审校和精修" },
            { text: "一稿多画幅", note: "竖屏横屏一次出" },
          ],
        },
      },
      {
        type: "quote",
        durationInFrames: 120,
        props: {
          text: "产能的天花板，是流程而不是人数。",
          author: "本周复盘",
          highlight: "流程",
        },
      },
      {
        type: "outro",
        durationInFrames: 105,
        props: { title: "下周继续", action: "目标是 50 条", handle: "" },
      },
    ],
  },
  {
    key: "launch",
    name: "产品发布",
    description: "悬念开场 → 产品大图 → 核心特性 → 一句话态度 → 预约引导",
    tags: ["发布会", "品牌"],
    scenes: [
      {
        type: "title",
        durationInFrames: 105,
        props: {
          eyebrow: "NEW ARRIVAL",
          title: "今天，交个新朋友",
          subtitle: "它已经等了 247 天",
          highlight: "新朋友",
        },
      },
      {
        type: "image",
        durationInFrames: 135,
        props: {
          src: "",
          kicker: "THE PRODUCT",
          caption: "轻了 30%，强了一倍",
          fit: "contain",
          scrim: 0.45,
        },
      },
      {
        type: "bullets",
        durationInFrames: 165,
        props: {
          heading: "这次带来了",
          items: [
            { text: "全新引擎", note: "快，且安静" },
            { text: "一体化设计", note: "没有一个多余的开孔" },
            { text: "持久续航", note: "两天一充" },
          ],
        },
      },
      {
        type: "quote",
        durationInFrames: 120,
        props: {
          text: "我们不做参数的堆砌，只做体验的减法。",
          author: "产品团队",
          highlight: "减法",
        },
      },
      {
        type: "outro",
        durationInFrames: 120,
        props: { title: "现在预约", action: "首发日 0 点开抢", handle: "@官方商城" },
      },
    ],
  },
];

export const getTemplate = (key: string): ProjectTemplate | undefined =>
  PROJECT_TEMPLATES.find((t) => t.key === key);

/** 套模板生成工程实例：id/rev/updatedAt 全部新生成，模板本身不可变 */
export function buildFromTemplate(templateKey: string, name?: string, id?: string): Project {
  const tpl = getTemplate(templateKey);
  if (!tpl) throw new Error(`没有模板「${templateKey}」，见 list_templates`);
  const seed = createSeedProject(id);
  seed.name = name ?? tpl.name;
  seed.scenes = tpl.scenes.map((spec) => {
    const meta = getMeta(spec.type);
    if (!meta) throw new Error(`模板 ${tpl.key} 引用了未知场景类型 ${spec.type}`);
    return {
      id: `scene_${Math.random().toString(36).slice(2, 10)}`,
      type: spec.type,
      name: meta.name,
      durationInFrames: spec.durationInFrames ?? meta.duration.default,
      props: meta.schema.parse({ ...meta.defaultProps, ...spec.props }),
      transitionIn: { type: "fade", durationInFrames: 12 },
    };
  });
  return seed;
}

/** 模板列表（给 Web / MCP 看的精简形态） */
export function templateList() {
  return PROJECT_TEMPLATES.map((t) => ({
    key: t.key,
    name: t.name,
    description: t.description,
    tags: t.tags,
    sceneCount: t.scenes.length,
    durationInFrames: t.scenes.reduce(
      (sum, s) => sum + (s.durationInFrames ?? getMeta(s.type)?.duration.default ?? 0),
      0,
    ),
    sceneTypes: t.scenes.map((s) => s.type),
  }));
}
