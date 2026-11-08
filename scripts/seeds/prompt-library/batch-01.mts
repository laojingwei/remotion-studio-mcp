/**
 * 第一批：三条黄金样例（已迁移到家族形态，正文由 families.mts 提供）。
 *
 * 三条分别落在三种结构最不同的家族：产品宣传（贯穿物驱动）/ 动效集锦（技法接力）/
 * 单图解说（一张图推拉）。它们同时是"家族骨架 + 差异段"这套写法的样板。
 */
import type { Seed } from "./types.mts";

export const SEEDS: Seed[] = [
  {
    slug: "0xfemyn-e114d3",
    name: "AIsa 贯穿物宣传片",
    family: "product_promo",
    theme: "AIsa 的 API Key",
    note: "贯穿物就用这枚 Key 本身：它在界面里被插进输入框，逐幕变成调用状态、变成返回结果里的那条线，最后一帧立成 logo。全片的论点只有一个——它能被直接调用，不是又一个控制台截图。品牌沿用产品自己的配色与字体，强调色只给它和关键词。",
    slotCn: {
      product: "AIsa（API 中转服务）",
      brand: "沿用产品自己的配色与字体",
      ending: "一行行动号召",
    },
  },
  {
    slug: "1littlecoder-9fef89",
    name: "Claude 自介运镜集锦",
    family: "reel_world",
    theme: "Opus 5.5 的自我介绍",
    note: "概念定为「同一条线在五段里换身份」：先是字的一笔，再是形状，再立进空间，然后变成图表里的曲线，最后收成片名。自介要显得克制而不是自夸——不要出现产品截图或界面，全部靠形变证明手上功夫。",
    slotCn: {
      theme: "你作为 Opus 5.5 是谁",
      palette: "最多三色加黑白",
    },
  },
  {
    slug: "1stnoel-c20a89",
    name: "Sotto 单图解说",
    family: "explainer_diagram",
    theme: "Sotto 阅读应用",
    note: "图版按「书 → 拆页 → 重排 → 读完」一次性搭好，推近讲的是每一层怎么落到阅读这件事上。口播用清晰的合成音、语速偏慢，配中文字幕；不要给界面做完整演示，界面只作为图上的一个局部出现。",
    slotCn: {
      topic: "Sotto（https://readsotto.app）：它是什么、怎么用",
      audience: "第一次听说它的人",
      style: "干净的产品动效，直接用它的真实界面",
      voice: "清晰的合成音色，语速偏慢",
      length: "1 分钟",
    },
  },
];
