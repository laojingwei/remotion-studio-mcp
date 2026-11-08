/**
 * 第四批：产品宣传（product_promo）37 条。
 *
 * 这是整库占比最大的一族，骨架完全相同（贯穿物 + 三幕 + 界面矢量分层），
 * 差异全在"卖的是什么、素材从哪来、结尾说什么"。同一产品出现多次的，靠差异段区分。
 */
import type { Seed } from "./types.mts";

export const SEEDS: Seed[] = [
  { slug: "ai-baymax-0ef9dd", name: "FigPad 产品宣传", family: "product_promo", theme: "FigPad", note: "产品位是「this product」，等于要你自己去查：先确认它是什么、给谁用，再定贯穿物。查不到就直接问用户，别编。" },
  { slug: "ajith-io-4c248f", name: "Distilbook 宣传集锦", family: "product_promo", theme: "Distilbook", note: "偏「集锦」：节奏快、幕数多，每个能力只给一个动作。适合时长被压到 10 秒以内的场合。" },
  { slug: "ajith-io-c52e09", name: "Distilbook 产品影片", family: "product_promo", theme: "Distilbook", note: "偏「影片」：幕数少、每幕停留久，允许一个镜头里讲完一件事。同一产品要做得比集锦版更沉。" },
  { slug: "anas0ra-e57aea", name: "heeya.fr 吉祥物宣传", family: "product_promo", theme: "heeya.fr 客服机器人", note: "有吉祥物就用吉祥物当贯穿物：它先在客服气泡里出现，再逐幕变成不同角色（答疑、下单、售后），最后回到 logo。" },
  { slug: "bizibeast-10f264", name: "Bento.surf 产品影片", family: "product_promo", theme: "Bento.surf", note: "Bento 式版式本身就是卖点：用分格布局当视觉母体，每一格填入一个能力，最后格子合成 logo。" },
  { slug: "bogdandragomir-35e024", name: "跟着音乐走的产品介绍", family: "product_promo", theme: "我的产品（网址待填）", note: "与音乐同步是硬约束：先定 BPM 与段落，再让每次界面变化落在重拍上。音乐不是背景，是时间轴。" },
  { slug: "cansincengiz-me-cf68dd", name: "Lidlezz 应用宣传", family: "product_promo", theme: "Lidlezz 应用", note: "产品位待填：先要到网址或截图。没有真实界面就别硬做界面演示，改成图标与手势的可视化。" },
  { slug: "ceowinkz-7c776b", name: "亚马逊批发招商片", family: "product_promo", theme: "Winkz Enterprises 亚马逊批发", note: "观众是品牌方，不是消费者：论点要落在「把货交给我们卖，你省什么、赚什么」。用数字说话，别用形容词。" },
  { slug: "charlesmendez-73b6e4", name: "Datagran 广告投放解说", family: "product_promo", theme: "Datagran 的 ChatGPT 广告功能", note: "按「一个用户的旅程」组织：建广告 → 连指标 → 看懂结果。三段必须是同一双手的操作，光标不能跳。" },
  { slug: "davidmarcus-a28a60", name: "Lightspark 社交短片", family: "product_promo", theme: "Lightspark（@lightspark）", note: "社交投放版：前 1.5 秒必须给出钩子，字幕可读性优先于画面精致度——手机上要看得清。" },
  { slug: "ddryo-loos-300829", name: "Lism CSS 1.0 发布片", family: "product_promo", theme: "Lism CSS 1.0", note: "开发者受众：用代码与布局本身做视觉（栅格、变量、断点），别做成消费级产品的花哨片。版本号要压得重。" },
  { slug: "ezshine-c90d73", name: "AI Arena 产品宣传", family: "product_promo", theme: "AI Arena", note: "focus 是「每个功能」——那就要列清单、均分时间；功能超过五个就分批做两条，别挤。" },
  { slug: "gautam-mer1-2ae354", name: "Matra 字幕应用宣传", family: "product_promo", theme: "Matra 字幕应用", note: "做字幕工具，画面里的字幕自己就得无可挑剔：断句、字号、对比度都按成品标准，否则是自曝其短。" },
  { slug: "ho-ba-f3f0e9", name: "mdfor.dev 产品介绍", family: "product_promo", theme: "mdfor.dev", note: "产品位待填网址；开发者工具方向，用 Markdown 渲染前后的对比当核心视觉。" },
  { slug: "imthatcarlos-e04bfe", name: "Sherwood 对冲基金解说", family: "product_promo", theme: "Sherwood Protocol", note: "讲的是「智能体如何管理基金」这种抽象机制：先用一张极简流程图立住，再动。别一上来就炫界面。" },
  { slug: "jayscambler-3f8889", name: "FundMyCompute 平台概览", family: "product_promo", theme: "fundmycompute", note: "概览类：一条主线走完「提交需求 → 匹配算力 → 结算」，每段一个界面证据，别报功能清单。" },
  { slug: "jazzen-chen-4542ae", name: "AgentHud 项目影片", family: "product_promo", theme: "AgentHud", note: "项目自述：先一句话说清它替谁省了什么，再用三幕演示。项目早期就诚实展示，别做假精致。" },
  { slug: "justincooperman-e7bbc4", name: "Tented 图像生成影片", family: "product_promo", theme: "Tented", note: "核心是「描述一句话 → 图出现在内容里」：把生成结果直接贴进版面的那一刻做成全片最强的一拍。" },
  { slug: "kmasiff-cc72cb", name: "邮箱验证工具宣传", family: "product_promo", theme: "我们的邮箱验证工具", note: "focus 是「所有用例」：用一组并行的小场景（注册、活动报名、CRM 清洗）展示，别做成一部长片。" },
  { slug: "lester-tyy-f897f7", name: "CloudJoi 搜索展示", family: "product_promo", theme: "CloudJoi", note: "产品位待填；核心是搜索：输入 → 结果涌现 → 筛选取舍，三幕都要有真实的结果条目，别用灰条占位。" },
  { slug: "madebyjmayala-b9204d", name: "Gene Spectra 宣传", family: "product_promo", theme: "Gene Spectra", note: "基因类产品：视觉用点阵与序列（ATCG 的排布），不要用通用 DNA 双螺旋库存图——那张图谁都在用。" },
  { slug: "majin-appsheet-2d3c1a", name: "Shin Majin-shiki 宣传", family: "product_promo", theme: "Shin Majin-shiki", note: "只有产品名没有网址：先问用户要一句话定位与一张截图，否则贯穿物无从谈起。" },
  { slug: "majorbaguette-fb11d7", name: "Brieform 产品演示", family: "product_promo", theme: "Brieform", note: "演示型：把一个真实任务从头做到尾（不是功能罗列），观众看完能复述那三步。" },
  { slug: "marklaunches-3b9492", name: "Step 跑步应用宣传", family: "product_promo", theme: "我们的跑步应用", note: "focus 是「用户的感觉」：用呼吸、步频、晨光这类感官元素，别做数据仪表盘——这次卖情绪不卖功能。" },
  { slug: "oliahmed205-3e31c4", name: "修图应用宣传", family: "product_promo", theme: "我们的修图应用", note: "修图产品的说服力在前后对比：同一张图、同一个裁切，只让处理效果变化。对比滑块的动要慢、要停得住。" },
  { slug: "paulo-kombucha-96431c", name: "吉祥物推荐计划宣传", family: "product_promo", theme: "我们的推荐计划", note: "讲清「怎么推、得什么」：用两个节点（你、朋友）和一条连线做骨架，奖励出现在连线中点，别画抽象爆炸。" },
  { slug: "rammanq-f5a90f", name: "AllInvestView 宣传", family: "product_promo", theme: "AllInvestView", note: "投资类产品：数据与图表是主角，但**不能承诺收益**。用界面与信息密度做说服力，避开任何收益曲线。" },
  { slug: "robvjourney-ce3e1a", name: "Nohandslabs 品牌宣传", family: "product_promo", theme: "Nohandslabs（网址待填）", note: "品牌向：先立标志与字体，再展示同一套元素在三种场景（网页、包装、社媒）的用法。" },
  { slug: "slvdev-64c45a", name: "Claude 自我推广", family: "product_promo", theme: "我自己和我在做的事", note: "产品是「你自己」：挑三件能证明能力的事，用作品截图说话。别写成自传，尾帧只留一句邀请。" },
  { slug: "spearwtf-3c1fd1", name: "Chain.wtf 路演片", family: "product_promo", theme: "@chaindotwtf", note: "路演型：观众是投资人，只要三件事——痛点、凭什么、现在到哪一步。别展示完整功能。" },
  { slug: "steventey-0d20e4", name: "Dub 宣传片", family: "product_promo", theme: "Dub（dub.co）", note: "链接管理产品：用「一条短链」当贯穿物，它被复制、被粘贴、被点开，最后变成数据。全片就靠这一条链。" },
  { slug: "sudo-kiran-4f8b59", name: "DistilBook 产品解说 A", family: "product_promo", theme: "Distilbook", note: "解说路线的第一版：偏「讲清一个概念」，节奏舒缓，允许旁白。" },
  { slug: "sudo-kiran-6609ed", name: "DistilBook 产品解说 B", family: "product_promo", theme: "你的产品（链接待填）", note: "同一骨架的通用版：产品位留空，适合当模板改。先用一句话定位，再决定贯穿物。" },
  { slug: "theviableedge-9065be", name: "第二大脑课程宣传", family: "product_promo", theme: "我的课程", note: "卖课程：论点落在「学完你能做什么」，用课程内容本身（笔记、标签、回顾）当视觉，别用励志空镜。" },
  { slug: "thilina-a-891c09", name: "sweetRegret 版本更新", family: "product_promo", theme: "sweetRegret 1.3 与 1.4", note: "更新片：把版本号做成章节，每个新功能一幕，旧界面对新界面用同一机位切换，观众才看得出「变了什么」。" },
  { slug: "tstfully-0aa6b4", name: "油管逐字稿工具广告", family: "product_promo", theme: "粘贴 YouTube 链接出逐字稿", note: "卖点就一句「粘贴视频，拿到每个字」：全片围绕这一句，别扩展成功能清单。" },
  { slug: "visheshbaghell-3aba37", name: "Tally 产品演示", family: "product_promo", theme: "Tally（网址待填）", note: "focus 是「每个功能」，但演示型不需要均匀——挑三条主流程做透，其余用一屏总览带过。" },
];
