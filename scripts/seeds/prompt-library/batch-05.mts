/**
 * 第五批：上线片（launch）14 条 + 单图解说（explainer_diagram）13 条。
 *
 * 上线片的骨架比宣传片更窄：只讲"这一件新东西"，开头必须立旧世界。
 * 解说族已核实过：源站每一条都写着"整篇一张连续图"，所以风格差异（白板、像素、
 * 广播图示）本该落在差异段里，而不是改骨架。
 */
import type { Seed } from "./types.mts";

export const SEEDS: Seed[] = [
  { slug: "deifosv-04e4d3", name: "网球游戏上线片", family: "launch", theme: "toptennisgame 上线", note: "旧世界是「看比分靠刷网页」，新东西是直播数据：把实时比分、桌面与手机同屏、多套主题这三件事各给一幕。球场线条是最好的贯穿物。" },
  { slug: "fractadev-149adc", name: "语音智能体 SaaS 上线", family: "launch", theme: "我的语音智能体 SaaS", note: "产品位待填。语音类产品必须让人「听见」——画面里要出现波形与转写文字，静音播放时也能看出在说话。" },
  { slug: "francoxavier33-d2dfd2", name: "育儿应用造势片", family: "launch", theme: "@momwiseai 育儿应用", note: "hype 向：节奏更快、字更少、情绪更足。旧世界用「半夜抱娃查手机」一幕就够，别铺垫太久。" },
  { slug: "hqmank-7c61f1", name: "浏览器自动化技能上线", family: "launch", theme: "jev-browser-skill", note: "它的口号本身就是文案：「给一个网站，写一个目标，Jev 自己去点。」三幕按这句话拆——给站、写目标、它点完。" },
  { slug: "iammxfschr-d68f90", name: "数据库客户端上线", family: "launch", theme: "我们的推理服务发布", note: "开发者受众：开场用一次真实的查询往返（输 SQL → 出结果）当旧世界的对照，新东西要在一屏之内证明「更快或更省事」。" },
  { slug: "jhylee95-e1152f", name: "Supademo 上线片", family: "launch", theme: "Supademo", note: "产品是「做产品演示的工具」——用它的产品形态（录制、热点、分享）来演示它自己，是本片最有力的做法。" },
  { slug: "listudio-820c7b", name: "GenVizu 产品上线", family: "launch", theme: "GenVizu（网址待填）", note: "产品位待填网址；先看真实界面再定贯穿物，别先想特效。" },
  { slug: "mehul4795-4a7007", name: "ocrX 安卓应用上线", family: "launch", theme: "ocrX 安卓版", note: "OCR 的说服力在「拍一下 → 字出来」：实拍画面用素材或模拟，但识别结果必须准确、排版要像真的。" },
  { slug: "ratheejaisal-1f4538", name: "founder.page 上线片", family: "launch", theme: "founder.page", note: "focus 是「所有关键功能、快节奏」：用快切但不许乱——每一幕只留一个功能，靠同一个贯穿形状串起来。" },
  { slug: "robj3d3-b18fad", name: "SuperX 新功能预告", family: "launch", theme: "路线图上的下一个功能", note: "读路线图，挑「下一个」而不是最亮的那个——预告片的时间感来自「马上就来」，最后压一句上线时间。" },
  { slug: "sachaarbonel-8f14f4", name: "Norilu 产品上线", family: "launch", theme: "我们的产品", note: "产品位待填。上线片最容易犯的错是讲功能，这条先把「哪一步变简单了」写成一句人话再开工。" },
  { slug: "techyoutbe-945b56", name: "视觉指南库上线", family: "launch", theme: "一个知名 SaaS 的视觉指南库", note: "产品位让你自己选一个知名 SaaS——选你能拿到真实界面的那个。做「指南」类，版式本身要像一本规范手册。" },
  { slug: "viktoroddy-98c1d8", name: "百万访问量里程碑", family: "launch", theme: "MotionSites AI 百万月访", note: "里程碑片的核心是那个数字：把「100 万」做成可数、可信的视觉（计数器从 0 冲到 100 万，八个月的时间轴在旁边）。" },
  { slug: "wozu-co-242285", name: "Supasito 上线片", family: "launch", theme: "supasito.com", note: "先抓真实站点素材；域名型产品通常界面单薄，那就把「从网址到成品」的转化过程做成主线。" },

  { slug: "0xnfrith-5be616", name: "Celld 归属权解说", family: "explainer_diagram", theme: "为什么 celld 值得用", note: "观众正在犹豫要不要用：图版就把「你的活归你」这条机制画清楚——任务进来、谁做的、怎么结算，一条线走完。" },
  { slug: "amitsingha89-150378", name: "手工织物品牌解说", family: "explainer_diagram", theme: "Anuprerna 手工织物", note: "风格用站点自己的影像：把织机、线、成衣三层叠在一张图上，推近讲一道工序，拉远看它在整块布上的位置。别做成电商轮播。" },
  { slug: "blueoctopusai-dd17bd", name: "橄榄球黄线原理", family: "explainer_diagram", theme: "美式橄榄球转播里的黄线怎么画出来", note: "风格走转播图示：3D 球场、摄像机机位、叠加线。讲清「机位标定 → 场线拟合 → 实时合成」这条链，观众下次看球会想起来。" },
  { slug: "buildfastwithai-53234e", name: "印度文明史", family: "explainer_diagram", theme: "印度文明：从印度河流域到今天", note: "仍是一张连续图，但每一段用那个年代自己的图像语言（印章、壁画、细密画、现代照片）。年代与史实必须可查，宁少勿错。" },
  { slug: "gigabit-million-16b3a0", name: "Steam 新游速览", family: "explainer_diagram", theme: "9 月 25–26 日 Steam 新游", note: "快节奏新闻回顾：一款游戏一张卡，卡在图上排成网格，镜头一张张推近。每款只说「好玩在哪」，别列配置与价格。" },
  { slug: "henkvaness-0e06af", name: "提示词错误图解", family: "explainer_diagram", theme: "一篇讲提示词常见错误的文章", note: "素材是用户给的文章：先把错误归纳成三到四类，每类用同一张图上的一个局部演示「错在哪、改成什么」。不要照抄原文段落。" },
  { slug: "lemomo-ai-0d9cff", name: "白板技能教程", family: "explainer_diagram", theme: "用技能一句话出片", note: "风格是手绘白板：一支笔逐笔画出每张图，画完再说话。笔迹要有轻微抖动，太干净就成了矢量图。" },
  { slug: "mdaman010-e7226a", name: "AI 数据中心剖面", family: "explainer_diagram", theme: "AI 数据中心内部发生了什么", note: "等距剖面图，镜头从供电一路推进到芯片、再到散热回路。观众零基础：每个部件只给一个比喻，比喻要准确。" },
  { slug: "parkerrex-1a54fe", name: "令牌桶限流原理", family: "explainer_diagram", theme: "令牌桶限流怎么工作", note: "观众是开发者：图上就三样东西——桶、滴进来的令牌、取走令牌的请求。参数（速率、容量）要标在图上，别只写在字幕里。" },
  { slug: "pluginplay-3d4006", name: "像素风 LLM 简史", family: "explainer_diagram", theme: "LLM 简史，最后走向自我改进", note: "像素严格锁网格，字体用像素字。前半讲事实，后半放开成玩笑——节奏就在「越来越离谱」的加速上。" },
  { slug: "tak3sh8-be5012", name: "复本对称破缺白板课", family: "explainer_diagram", theme: "SK 模型里的复本对称破缺", note: "观众是物理学生：白板手绘，公式要写对、符号要统一。宁可少讲一个结论，也不要写错一个下标。" },
  { slug: "triglyceee-bd5b08", name: "摩洛哥政治史时间线", family: "explainer_diagram", theme: "摩洛哥独立以来的政治变迁", note: "仍是一张连续图，但形态是时间线：镜头沿一条线走，每站给地图与档案照片。年份与人物必须核对，不许编引语。" },
  { slug: "yunn260414-60d996", name: "Git 到底在做什么", family: "explainer_diagram", theme: "Git 是什么、常用命令在干嘛", note: "观众零计算机背景：用文件、快照、分支三样东西搭一张图，命令出现时图上必须有对应的可见变化。别用命令行截图。" },
];
