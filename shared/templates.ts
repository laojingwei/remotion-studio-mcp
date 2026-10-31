import { createSeedProject } from "./ops";
import { getMeta } from "./sceneMetas";
import type { Project } from "./schema";
import type { TransitionType } from "./transitions";

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
 *
 * 每个场景还能带 backdrop（氛围层）和 transitionIn（入场转场）：
 * 模板好不好看，一半在氛围层和转场的节奏上 —— 纯场景堆叠是 PPT，不是片。
 */
export type TemplateSceneSpec = {
  type: string;
  durationInFrames?: number;
  props?: Record<string, unknown>;
  /** 氛围层（BACKDROP_TYPES 纯氛围类型，垫在版式底下）；不传就没有 */
  backdrop?: { type: string; opacity?: number };
  /** 入场转场；不传用淡入 12 帧 */
  transitionIn?: { type: TransitionType; durationInFrames?: number };
};

export type ProjectTemplate = {
  key: string;
  name: string;
  description: string;
  tags: string[];
  scenes: TemplateSceneSpec[];
};

/**
 * 内置模板的设计原则：
 *  - 题材回避直播带货：模板是公共示范，卖货类内容让用户自己組合（slot/countdown
 *    这些场景依然可用，只是不进内置模板）；
 *  - 开场 3 秒定生死：hero / kinetic / bigtext 这类大字版式 + 有分量的氛围层；
 *  - 中段节奏交替：数据版式和文字版式换着来，连着两张同构的图会腻；
 *  - 转场跟着情绪走：科技感用 glitch/flash，理性复盘用 slide/wipe，
 *    节庆热闹用 zoom/circle，安静收尾用 blur/fade；
 *  - 文案示范「结构」而不是绑死题材：用户拿去改字就能用。
 */
export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    key: "blank",
    name: "空白工程",
    description: "只有开场和结尾，中间全靠你和 agent 现场发挥",
    tags: ["自由发挥"],
    scenes: [
      {
        type: "title",
        props: { eyebrow: "", title: "新工程", subtitle: "", highlight: "" },
      },
      { type: "outro", props: { title: "谢谢观看", action: "", handle: "" } },
    ],
  },
  {
    key: "launch",
    name: "新品上市",
    description: "悬念开场 → 三个数字 → 一句态度 → 了解更多",
    tags: ["发布会", "品牌"],
    scenes: [
      {
        type: "hero",
        durationInFrames: 120,
        props: {
          badge: "COMING SOON",
          title: "重新定义慢生活",
          subtitle: "它不快，但它把每件事都做对了",
          highlight: "重新定义",
        },
        backdrop: { type: "spotlight", opacity: 0.85 },
        transitionIn: { type: "zoom", durationInFrames: 16 },
      },
      {
        type: "kinetic",
        durationInFrames: 105,
        props: {
          text: "快，从来不是唯一答案",
          highlight: "唯一",
          sub: "这次我们把力气花在别处",
        },
        backdrop: { type: "glow", opacity: 0.7 },
        transitionIn: { type: "flash", durationInFrames: 14 },
      },
      {
        type: "stats",
        durationInFrames: 135,
        props: {
          heading: "三个数字，认识它",
          items: [
            { value: "48h", label: "超长续航" },
            { value: "-30%", label: "更轻的重量" },
            { value: "10min", label: "回血一半电量" },
          ],
        },
        backdrop: { type: "gridflow", opacity: 0.5 },
        transitionIn: { type: "wipe", durationInFrames: 14 },
      },
      {
        type: "quote",
        durationInFrames: 120,
        props: {
          text: "我们不做参数的堆砌，只做体验的减法。",
          author: "产品团队",
          highlight: "减法",
        },
        backdrop: { type: "bokeh", opacity: 0.55 },
        transitionIn: { type: "blur", durationInFrames: 14 },
      },
      {
        type: "outro",
        durationInFrames: 120,
        props: { title: "了解更多", action: "官网可申请试用", handle: "@官方主页" },
        backdrop: { type: "lightleak", opacity: 0.65 },
        transitionIn: { type: "circle", durationInFrames: 16 },
      },
    ],
  },
  {
    key: "data",
    name: "数据复盘",
    description: "抛出问题 → 趋势线 → 榜单对比 → 漏斗拆解 → 金句收束",
    tags: ["周报", "复盘"],
    scenes: [
      {
        type: "title",
        durationInFrames: 105,
        props: {
          eyebrow: "WEEKLY REPORT",
          title: "产出翻了一倍，靠的是什么",
          subtitle: "用数据说话",
          highlight: "一倍",
        },
        backdrop: { type: "gridflow", opacity: 0.45 },
        transitionIn: { type: "zoom", durationInFrames: 14 },
      },
      {
        type: "linechart",
        durationInFrames: 145,
        props: {
          heading: "近四周产出",
          unit: "条",
          data: [
            { label: "W1", value: 14, display: "14" },
            { label: "W2", value: 19, display: "19" },
            { label: "W3", value: 33, display: "33" },
            { label: "W4", value: 41, display: "41" },
          ],
          smooth: true,
          area: true,
        },
        transitionIn: { type: "slide", durationInFrames: 12 },
      },
      {
        type: "racebars",
        durationInFrames: 140,
        props: {
          heading: "时间都花在了哪",
          items: [
            { label: "模板复用", value: 46, display: "46%" },
            { label: "agent 起草", value: 32, display: "32%" },
            { label: "批量出片", value: 14, display: "14%" },
            { label: "人工精修", value: 8, display: "8%" },
          ],
          suffix: "%",
        },
        transitionIn: { type: "wipe", durationInFrames: 12 },
      },
      {
        type: "funnel",
        durationInFrames: 140,
        props: {
          heading: "从灵感到发布",
          stages: [
            { label: "灵感收集", value: 100, display: "100" },
            { label: "脚本成稿", value: 72, display: "72" },
            { label: "画面生成", value: 58, display: "58" },
            { label: "发布上线", value: 49, display: "49" },
          ],
        },
        transitionIn: { type: "blinds", durationInFrames: 14 },
      },
      {
        type: "quote",
        durationInFrames: 115,
        props: {
          text: "产能的天花板，是流程而不是人数。",
          author: "本周复盘",
          highlight: "流程",
        },
        backdrop: { type: "glow", opacity: 0.55 },
        transitionIn: { type: "blur", durationInFrames: 14 },
      },
      {
        type: "outro",
        durationInFrames: 105,
        props: { title: "下周继续", action: "目标是 50 条", handle: "" },
        transitionIn: { type: "fade", durationInFrames: 12 },
      },
    ],
  },
  {
    key: "tutorial",
    name: "上手指南",
    description: "提问开场 → 三步流程 → 关键提醒 → 模拟答疑 → 关注引导",
    tags: ["教学", "教程"],
    scenes: [
      {
        type: "kinetic",
        durationInFrames: 110,
        props: {
          text: "十分钟就能学会的事",
          highlight: "十分钟",
          sub: "别再被教程收藏夹吃灰",
        },
        backdrop: { type: "gridflow", opacity: 0.5 },
        transitionIn: { type: "glitch", durationInFrames: 14 },
      },
      {
        type: "steps",
        durationInFrames: 155,
        props: {
          heading: "三步上手",
          items: [
            { title: "准备", desc: "把要用的东西摆在手边" },
            { title: "照做", desc: "跟着提示一步一步来" },
            { title: "检查", desc: "对照最后一张清单确认" },
          ],
        },
        backdrop: { type: "glow", opacity: 0.5 },
        transitionIn: { type: "slide", durationInFrames: 12 },
      },
      {
        type: "wipe",
        durationInFrames: 130,
        props: {
          kicker: "容易踩的坑",
          lines: ["第一步别跳过", "工具提前备齐", "做完立刻复盘"],
          accentLine: "做完立刻复盘",
        },
        transitionIn: { type: "wipe", durationInFrames: 12 },
      },
      {
        type: "chat",
        durationInFrames: 140,
        props: {
          heading: "常见问题",
          messages: [
            { side: "left", text: "中途卡住了怎么办？" },
            { side: "right", text: "回到上一步重来，别硬撑。" },
            { side: "left", text: "需要买工具吗？" },
            { side: "right", text: "先用手边的，够了再升级。" },
          ],
        },
        transitionIn: { type: "fade", durationInFrames: 12 },
      },
      {
        type: "bigtext",
        durationInFrames: 100,
        props: {
          text: "动手才算学会",
          sub: "看完不动手，等于没看",
          highlight: "动手",
        },
        backdrop: { type: "liquid", opacity: 0.6 },
        transitionIn: { type: "zoom", durationInFrames: 14 },
      },
      {
        type: "qr",
        durationInFrames: 110,
        props: {
          heading: "扫码关注",
          sub: "回复「指南」领取完整清单",
          qrText: "每周三更新",
        },
        backdrop: { type: "bokeh", opacity: 0.5 },
        transitionIn: { type: "circle", durationInFrames: 14 },
      },
    ],
  },
  {
    key: "knowledge",
    name: "知识速递",
    description: "提问开场 → 逐层拆解 → 关键结论 → 模拟答疑 → 关注引导",
    tags: ["科普", "干货"],
    scenes: [
      {
        type: "kinetic",
        durationInFrames: 115,
        props: {
          text: "为什么你总是三分钟热度",
          highlight: "三分钟",
          sub: "不是你不行，是方法错了",
        },
        backdrop: { type: "smoke", opacity: 0.75 },
        transitionIn: { type: "glitch", durationInFrames: 14 },
      },
      {
        type: "maskreveal",
        durationInFrames: 150,
        props: {
          kicker: "拆开看",
          lines: ["先讲清楚", "再给证据", "最后给行动理由"],
          accentLine: "最后给行动理由",
        },
        transitionIn: { type: "slide", durationInFrames: 12 },
      },
      {
        type: "highlight",
        durationInFrames: 120,
        props: {
          text: "听完这场分享，我只记住了一句话",
          highlight: "一句话",
          sub: "别的都可以忘",
          mark: "荧光笔",
        },
        backdrop: { type: "glow", opacity: 0.5 },
        transitionIn: { type: "wipe", durationInFrames: 12 },
      },
      {
        type: "chat",
        durationInFrames: 140,
        props: {
          heading: "常见问题",
          messages: [
            { side: "left", text: "道理我都懂，从哪一步开始？" },
            { side: "right", text: "把目标砍到 5 分钟能做完的量。" },
            { side: "left", text: "就这么简单？" },
            { side: "right", text: "简单的事才做得下去。" },
          ],
        },
        transitionIn: { type: "fade", durationInFrames: 12 },
      },
      {
        type: "bigtext",
        durationInFrames: 100,
        props: {
          text: "先完成 再完美",
          sub: "完成是完美的前提",
          highlight: "先完成",
        },
        backdrop: { type: "liquid", opacity: 0.6 },
        transitionIn: { type: "zoom", durationInFrames: 14 },
      },
      {
        type: "qr",
        durationInFrames: 110,
        props: {
          heading: "扫码关注",
          sub: "回复「方法」领取完整清单",
          qrText: "每周三更新",
        },
        backdrop: { type: "bokeh", opacity: 0.5 },
        transitionIn: { type: "circle", durationInFrames: 14 },
      },
    ],
  },
  {
    key: "party",
    name: "节日祝福",
    description: "大字贺词 → 祝福滚动 → 心愿 → 金句 → 烟花收尾",
    tags: ["节日", "庆贺"],
    scenes: [
      {
        type: "bigtext",
        durationInFrames: 110,
        props: {
          text: "新年快乐",
          sub: "愿你所求皆如愿",
          highlight: "快乐",
        },
        backdrop: { type: "fireworks", opacity: 0.85 },
        transitionIn: { type: "flash", durationInFrames: 14 },
      },
      {
        type: "marquee",
        durationInFrames: 130,
        props: {
          rows: ["平安喜乐", "万事顺遂", "健康常在", "好运满满"],
          speed: 14,
          direction: "交替",
          separator: " · ",
        },
        transitionIn: { type: "slide", durationInFrames: 12 },
      },
      {
        type: "list",
        durationInFrames: 135,
        props: {
          heading: "新年的三个小心愿",
          items: [
            { title: "读完 12 本书", note: "一月一本就好" },
            { title: "坚持运动", note: "每周三次起步" },
            { title: "多陪家人", note: "常回家看看" },
          ],
        },
        backdrop: { type: "bokeh", opacity: 0.5 },
        transitionIn: { type: "wipe", durationInFrames: 12 },
      },
      {
        type: "quote",
        durationInFrames: 115,
        props: {
          text: "往后的日子都是崭新的，谁也别回头看了。",
          author: "写给新一年",
          highlight: "崭新",
        },
        backdrop: { type: "glow", opacity: 0.55 },
        transitionIn: { type: "blur", durationInFrames: 14 },
      },
      {
        type: "wave",
        durationInFrames: 110,
        props: {
          title: "新年新气象",
          amplitude: 30,
          waves: 0.8,
        },
        transitionIn: { type: "fade", durationInFrames: 12 },
      },
      {
        type: "outro",
        durationInFrames: 110,
        props: { title: "把祝福转给在意的人", action: "", handle: "" },
        backdrop: { type: "confetti", opacity: 0.75 },
        transitionIn: { type: "circle", durationInFrames: 14 },
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
      transitionIn: {
        type: spec.transitionIn?.type ?? "fade",
        durationInFrames: spec.transitionIn?.durationInFrames ?? 12,
      },
      ...(spec.backdrop
        ? {
            backdrop: {
              type: spec.backdrop.type,
              opacity: spec.backdrop.opacity ?? 0.8,
            },
          }
        : {}),
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
