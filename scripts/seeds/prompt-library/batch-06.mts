/**
 * 第六批：叙事短片 13 + 三维场景 5 + 配方 2 + 玩法 1 + 界面 1 + 音乐 1 = 24 条。
 *
 * 注意这里有意做了两处重新归族：
 * · 「Derivative concept explainer」原本被 3D 规则捞进来，但它是带旁白的数学课，
 *   结构是"一张连续图 + 镜头推拉"，归解说族才对
 * · 「机器演奏」「自由命题」「改版」「滚屏版式」结构各成一派，放进 bespoke 单独写
 */
import type { Seed } from "./types.mts";

export const SEEDS: Seed[] = [
  { slug: "abderrahmen-g-9e8ed0", name: "手绘动物活起来", family: "short", theme: "用手绘稿做的动物故事", note: "素材就是用户的手绘稿：动画必须保留笔触、纸纹和线的不稳，**不要矢量化**——一矢量化，「手绘」这个卖点就没了。" },
  { slug: "anilraok-eff262", name: "拼字牌小人", family: "short", theme: "拼字牌当角色的故事（软植入 Grid Genius）", note: "角色是拼字牌，字母就是表情：换一个字母换一种情绪。产品植入压在尾帧一句，正片别出现任何界面。" },
  { slug: "axtonliu-0b861d", name: "鹈鹕骑自行车", family: "short", theme: "一只鹈鹕骑自行车", note: "题目明确要求「最复杂、最详细、最好看」：鹈鹕的真实解剖、一辆真能骑的车、完整风景。目标就是炫，不要图省事。" },
  { slug: "davidshulmanfl-371638", name: "黏土音乐录像", family: "short", theme: "黏土定格风的音乐短片", note: "参照 Sledgehammer 那种黏土与拼贴：让不可能的东西变得理所当然。节奏跟着歌走，段落换材质就换材质。" },
  { slug: "faroukzy-9ff23e", name: "最后一束光", family: "short", theme: "一个能在结尾翻盘的设定", note: "题目是「一个让我震惊的点子」：必须有一个在最后几秒重写前情的转折，平铺直叙不行。给用户看的第一版就要有这个转折。" },
  { slug: "itsolelehmann-e47532", name: "火车窗的四季", family: "short", theme: "一扇车窗里的四季", note: "视觉参照布达佩斯大饭店：对称构图、粉彩色、平面化的戏剧纵深。同一扇窗固定机位，只让季节在窗外换。" },
  { slug: "kamstudiolabs-0b0824", name: "守塔人", family: "short", theme: "灯塔守夜人的沉默故事", note: "全片无对白，声音要讲一半的故事：风、灯、脚步。孤独感靠停顿与节奏，不靠脸。" },
  { slug: "kamstudiolabs-c9bb28", name: "不想被修好的虫子", family: "short", theme: "一只不想被修好的虫子", note: "角色用简单形状做出表情（二维皮克斯感）。「被修好」是它的恐惧，所以追逐戏的动机要让观众站在虫子这边。" },
  { slug: "kantamk-61f410", name: "逃出十二个圆环", family: "short", theme: "一颗球逃出十二个圆环", note: "传播向：第一秒必须给钩子，结尾要让人想转发。十二个环就是倒计时，每个环一个机制，最后一个环要出乎意料。" },
  { slug: "nikolajankovic-ce4ff4", name: "DeFi Saver 纸片自述", family: "short", theme: "DeFi Saver 用第一人称解释自己", note: "手绘定格：纸纹、会轻微抖动的铅笔线。产品自己当主角说话——第一人称旁白是这条的骨架，别改成第三人称讲解。" },
  { slug: "rebutonepress-810f78", name: "黑洞与时间", family: "short", theme: "一个关于时间的故事", note: "视觉从「这台机器自己的环境」里取：终端、主题色、字体。也就是用工具本身的视觉语言当美术设定，别另造一套世界观。" },
  { slug: "ryzoft-4f85bd", name: "太空卡通剧集", family: "short", theme: "一集太空冒险卡通", note: "八十年代星战 + 九十年代卡通风：粗描边、赛璐璐上色、星空与飞船。飞船可以用 scene3d 建，但上色要压成两三个色阶。" },
  { slug: "x4b47x-9cc84f", name: "影子戏里的家", family: "short", theme: "什么让一个地方像家", note: "纸偶影子戏：分层剪影、暖色背光、纸会随风轻颤。分层是关键——前景、中景、背景各走不同速度，纵深才出来。" },

  { slug: "allforbigfire-86ff3c", name: "三车合体成机器人", family: "threed", theme: "三辆载具变形合体成机器人", note: "变形顺序必须机械上说得通：每个零件都要有去处，不许用烟雾或快速切换遮掉重排过程——那正是观众要看的地方。" },
  { slug: "buildfastwithai-ed9447", name: "A-1H 天袭者模型", family: "threed", theme: "道格拉斯 A-1H 天袭者", note: "忠实比例模型：正确轮廓、星型发动机、四叶螺旋桨、海军灰配白、蒙皮铆钉。比例错一处，军迷立刻出戏。" },
  { slug: "gorden-sun-041f56", name: "跟着节拍弹的球", family: "threed", theme: "一颗球在场景里弹跳，每次落地触发一个音", note: "物理要真（重力、弹性、摩擦），幽默在节奏：先按物理弹，再让它开始不听话。音与落地帧必须严格对齐。" },
  { slug: "mandelduck-95fd08", name: "星夜寻猫", family: "threed", theme: "走进梵高的星夜找猫", note: "厚涂笔触做成三维表面：每个面都有漩涡状的笔触方向。找猫的乐趣靠「藏得有道理」——藏在笔触的旋涡里，不是随机塞。" },
  { slug: "nft-chen-5f8bb0", name: "红猪式黄昏空战", family: "threed", theme: "致敬吉卜力的海上黄昏空战", note: "手绘感的云、暖夕阳、海面反光。**不要复制受版权保护的角色形象**：做「同一时代与气质的架空飞行器」，交给用户决定替换。" },

  { slug: "kamstudiolabs-447565", name: "碰撞驱动的音乐机", family: "lab", theme: "球、铃、木钉与木琴条组成的演奏机", note: "视觉是暖木与黄铜、干净背景。每个音都必须能指到一个具体的碰撞——观众数得出来的因果，才是这条片子的全部乐趣。" },

  { slug: "bthreeagency-b9b8d9", name: "徽章解锁界面", family: "ui", theme: "设计稿里的徽章解锁屏", note: "一比一还原设计稿，只加动不改造型。徽章当实体（有质量、有阻尼地落定），庆祝只播一次，粒子是设计里允许的那种金色粒子。" },

  { slug: "rames-jusso-589f80", name: "ASCII 低频波形", family: "music", theme: "UK dubstep 的 ASCII 可视化", note: "先写曲（前奏、推进、drop），再让画面只由字符构成：字符密度随鼓点变化，drop 时整屏字符重排一次。别加任何图形元素。" },

  { slug: "ror-fly-9950f1", name: "尼格罗尼配方", family: "recipe", theme: "尼格罗尼（金酒、金巴利、味美思）", note: "等份三味、加冰搅拌、橙皮作装饰。刻度就写 1:1:1，别写得要暂停去算；杯型用古典杯。" },
  { slug: "sarut0bisasuke-cefa43", name: "白俄罗斯配方", family: "recipe", theme: "白俄罗斯（伏特加、咖啡利口酒、奶油）", note: "关键是奶油浮层的形成：先酒后奶油，奶油缓慢下沉再浮起的那一下是全片的高光，别一下倒完。" },

  { slug: "linearuncle-5d2bae", name: "导数可视化课", family: "explainer_diagram", theme: "导数是什么", note: "观众是零基础：曲线 → 切线 → 斜率 → 变化率，一条图走完，每一步只多一个元素。配中文旁白（zh-CN-XiaoxiaoNeural），字幕逐句对齐。" },
];
