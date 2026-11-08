/**
 * 第三批：产品集锦（reel_product）29 条。
 *
 * 与宣传片的区别在这一族里被写清楚：目的是"展示广度"——每幕一个能力、时间均分，
 * 别让某一幕抢戏。差异段负责点名产品和它的素材来源。
 */
import type { Seed } from "./types.mts";

export const SEEDS: Seed[] = [
  { slug: "agonaliu-466a8f", name: "Trezio 应用集锦", family: "reel_product", theme: "Trezio 应用", note: "先摸清 Trezio 的真实界面与品牌色，再挑最常被用到的四个动作逐幕演示；不要发明截图里没有的功能。" },
  { slug: "ajith-io-ea7f2d", name: "Distilbook 动效集锦", family: "reel_product", theme: "Distilbook 阅读产品", note: "同一产品在站内被不同作者做了三次，这条偏「动效集锦」：节奏更密，幕间靠形变接力，少讲功能多讲手感。" },
  { slug: "amol909s-27533e", name: "Commotion 应用集锦", family: "reel_product", theme: "Commotion 应用", note: "重点展示平铺布局（tiling layout）和自动分类模型两件事，其余功能最多带一句。界面必须拆层，平铺的每一格要能单独动。" },
  { slug: "andginja-333d32", name: "工作室官网集锦", family: "reel_product", theme: "我的工作室官网", note: "产品位改成「把网址贴进来」——先抓真实站点的 logo、截图与文案，再按能力逐幕展示。没有素材就先问用户要，别凭空造页面。" },
  { slug: "arjunsh1607-93005d", name: "Pixelup Labs 集锦", family: "reel_product", theme: "@pixeluplabs 工作室", note: "工作室自述片：能力清单写三到四条（视觉、动效、开发），每条用一件作品代表，尾帧压品牌名。" },
  { slug: "astrodevil-3f2054", name: "Studio1 开场集锦", family: "reel_product", theme: "Studio1 工作室", note: "开场用案例研究里的真实作品切入：先给三张成品缩略，再逐幕拆它们的共同手法，收在「这就是我们的做法」。" },
  { slug: "devius-maximus-beab45", name: "Dubz Up 集锦", family: "reel_product", theme: "Dubz Up 项目", note: "项目自述：先一句话说清它解决什么，再用三幕演示核心流程。项目若还是早期状态，就诚实展示界面粗糙度，别做假精致。" },
  { slug: "elliot-garreffa-f334bc", name: "Muse 连接器追踪", family: "reel_product", theme: "Muse 连接器追踪器", note: "重点在「连接」这个动作：把不同来源的数据线拧成一股，是全程唯一贯穿物。不要逐个界面报菜名。" },
  { slug: "en-ra-81c6dd", name: "RedSeed AI 网站诊断", family: "reel_product", theme: "RedSeed AI 网站分析器", note: "演示「输入网址 → 出诊断」这条链路：输入框、扫描中、报告三幕，扫描过程要有可见的进度与颗粒感。" },
  { slug: "gonzalomacagno-2de1a9", name: "音乐节阵容预告", family: "reel_product", theme: "音乐节阵容", note: "素材用用户给的阵容信息：按天或按舞台分组，名字逐个砸在拍上，压轴阵容给最长定格。不要编造艺人。" },
  { slug: "heyiammallik-e72d17", name: "作品集运镜", family: "reel_product", theme: "我的作品集", note: "作品集片：每幕一件作品，幕内只留一个细节放大，其余留白。作品清单先定，别边做边补。" },
  { slug: "influencer-seo-ce8c33", name: "fal 动效集锦", family: "reel_product", theme: "@fal 平台", note: "开发者工具方向：展示「一次调用出一张图」的链路，画面偏技术感——等宽字体、网格、光标。别做成消费级 App 的花哨风。" },
  { slug: "ismailfahmi-557268", name: "Drone Emprit 集锦", family: "reel_product", theme: "Drone Emprit 媒体情报平台", note: "情报平台：用真实的仪表盘元素（趋势线、热度榜、地图点）做视觉，数据要像真的——量级、单位、时间轴都要对得上。" },
  { slug: "kangaroohere-b10f8d", name: "简报订阅集锦", family: "reel_product", theme: "我的 newsletter", note: "产品是 newsletter：说清楚「写什么」和「为什么订」。用邮件版式本身做视觉（标题、段落、订阅按钮），别用抽象的纸张概念。" },
  { slug: "kikelopezdesign-7cc9e8", name: "设计作品集影片", family: "reel_product", theme: "我的设计作品集", note: "贴网址抓真实作品；若拿不到，就让用户挑三件。每件作品给一个「设计决策」的一句话，比堆图有效。" },
  { slug: "macrohou-33959d", name: "Ren 上线影片", family: "reel_product", theme: "Ren 应用", note: "虽是集锦体，但目的是上线：开头三秒先给旧办法的笨拙，再让 Ren 接住。别一上来就报功能清单。" },
  { slug: "manuelogomigo-f33ca9", name: "Flowdrive 动效集锦", family: "reel_product", theme: "Flowdrive", note: "流程类产品：用一条管道当骨架，每个能力是管子上的一段。观众要能看出「东西从哪进、从哪出」。" },
  { slug: "maxalexweber-67688b", name: "ODATANO 卡片链集锦", family: "reel_product", theme: "ODATANO（Cardano 生态）", note: "加密项目：配色偏冷、金属感，节奏更快（hype 向）。数字与代币信息必须真实，宁可不说也不要编。" },
  { slug: "micheleharmonic-77628e", name: "GravityDEX 动漫集锦", family: "reel_product", theme: "GravityDEX × 五条悟", note: "要动漫配色与速度线，但**不能使用受版权保护的角色图像**：用「能量／咒术般的抽象光路」来代指，交给用户决定是否替换。" },
  { slug: "miskinho-443898", name: "Quetzal 社交应用集锦", family: "reel_product", theme: "Quetzal 社交应用", note: "社交产品：用消息气泡与人像块做形变接力，强调「人和人连上」的那一下。别展示真实用户照片，用占位色块。" },
  { slug: "prasad-pilla-2c0cba", name: "Alan 智能体平台", family: "reel_product", theme: "@tryAlanAI 智能体平台", note: "平台类：一条主线讲「接入 → 编排 → 上线」，三幕各给一个界面证据。术语别堆，一个概念一句话。" },
  { slug: "quickdesignio-dd93d0", name: "QuickDesign 品牌集锦", family: "reel_product", theme: "quickdesign", note: "品牌向：先用一支标志动效立住，再展示同一套元素在三种版式里的用法，证明「这是一套系统」而不是一个 logo。" },
  { slug: "reflex-cloud-72ffe5", name: "Reflex 品牌集锦", family: "reel_product", theme: "reflex. inc", note: "品牌片：几何与网格为主，颜色不超过三色。每一幕都要能单独拿出来当海报用——这是品牌集锦的隐性标准。" },
  { slug: "reyzostyle-b55864", name: "Chunku 产品推广", family: "reel_product", theme: "Chunku", note: "贴网址抓真实界面；产品定位若不清楚，先问用户一句「一句话它是什么」，再动分镜。" },
  { slug: "rneayan-474bcf", name: "Risograph 工作室开场", family: "reel_product", theme: "我的设计工作室（Risograph 风）", note: "整套视觉按 Risograph 来：两到三个专色、故意错版（misregistration）、颗粒与纸张纹理。**错版要一致**——同一个偏移量贯穿全片，才是印刷感，随机错就是脏。" },
  { slug: "rneayan-ea6129", name: "示波器风工作室片", family: "reel_product", theme: "我的设计工作室（示波器风）", note: "视觉按示波器来：黑底、绿色荧光线条、余辉拖尾。线条必须是单笔连续绘制感（像电子束扫描），不要用现成的折线图组件。" },
  { slug: "samuel-yostt-891f87", name: "ViralGrow 产品推广", family: "reel_product", theme: "viralgrow", note: "增长类工具：用一条上扬曲线当贯穿物，每幕演示一个增长动作。曲线要真实可信，别画成 45 度直线。" },
  { slug: "sudeepsd-1a3485", name: "Flexprice 动效集锦", family: "reel_product", theme: "@tryflexprice 计价平台", note: "计价产品：用「价格表怎么随规则变」做视觉，一次只改一个变量，让观众看见因果。" },
  { slug: "utopyaszx-1b2f94", name: "Bold Pilot SEO 推广", family: "reel_product", theme: "Bold Pilot", note: "SEO 工具：用搜索框、排名位次、流量曲线三个真实元素，演示「从第 20 名到第 1 名」。数据若没有就留空，不编造名次。" },
];
