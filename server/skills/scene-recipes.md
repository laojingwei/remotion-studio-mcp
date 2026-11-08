# 版式配方（默认对 agent 开放的那批）

> **先读这一段**：`list_scene_types` 返回的才是默认能用的场景类型——
> `freeform`（自由画布）、`empty`（空白）、`scene3d`（3D）、`iso`（等轴测图解）、
> 动效类、氛围类，以及插件注册的场景。
>
> 内置固定版式（title / bullets / chart / stats 这类现成骨架）都带了 `agentVisible: false`
> 标签，**本篇不再列它们**。原因：拿现成骨架搭片子，画面会被锁进既有版式，
> 自由发挥反而没了——要独特画面就用 `freeform` 自己排（见 `get_guide("freeform")`）。
>
> 真要用某个版式时（用户点名「用标题页 / 用柱状图 / 就要这个版式」）：
> 1. `get_guide("scene-recipes-archive")` 找到对应 type —— 那是归档名录，**只在点名时读**；
> 2. `list_scene_types(type:"那个 type")` 查字段（会回一句"这是例外"的提示）。
>
> 编辑器里这些版式照常能选、老工程里照常能播，隐藏的只是 agent 的查询清单。

## 动效 / 氛围（27 种，画面主体是运动本身）

**这一类是默认可用的**，直接 `add_scene(type:"…")`。
这一类不参与「一屏字数 / 标题字号」审计（逐字动画天然几十个 span），但**转场审计照旧**。
选的时候看**语气**，不看内容：动效是「这幕要有节奏」，氛围是「这幕要有空气」。

| 类型 | 适用 | 要点 |
|---|---|---|
| glow | 情绪缓冲、开场底子 | 2–3 个大气氛光团 + 极淡网格 |
| grain | 做旧、纪实感 | 逐帧颗粒 + 暗角，压在别的画面上也能用 |
| lightleak | 转场补光、情绪高点 | 一束光带周期性划过，暖/冷 |
| bokeh | 夜景、回忆 | 十几二十个失焦光斑，有前后景深 |
| sparks | 强势开场、能量段 | 亮点向上飘，可只在下半屏 |
| vhs | 复古、故障、悬疑 | 扫描线 + 色差 + tracking 错位 |
| spotlight | 舞台感、强结论、榜单 | 光柱从顶上打下并缓慢摆动 |
| gridflow | 科技、数据段 | 透视网格向脚下流 + 地平线落日 |
| rain | 压在情绪上（困境/亏损/等待） | 斜雨 + 底部水汽；要压下去时用，别用来热闹 |
| liquid | 高级质感（美妆/汽车/SaaS） | 几团色块缓慢变形；要"贵"用这个，不要用 glow |
| confetti | 庆祝、开奖、成交播报 | 小纸片翻着落，主题四色轮转；和 sparks（向上）正好一对 |
| snow | 季节、节日、安静段落 | 柔边雪片慢落，大在前小在后 |
| fireworks | 跨年、庆典、战报高光 | 一轮一组齐放，periodSec 控节奏；氛围层支持「只放一轮」 |
| smoke | 悬疑、压情绪、转场缓冲 | 单色大团从底部升起；和 liquid 的区别是单色且向上走 |
| matrix | 黑客、终端、数据流 | 竖列字符下落 + 亮头渐隐尾；深色主题最出彩，rain 是情绪 matrix 是科技感 |
| typewriter | 要被逐字读完的一句 | 每秒 8–14 字最自然 |
| counter | 让人记住的量（金额/涨幅） | 从 0 滚到目标值 + 强调线 |
| gradienttext | 口号、章节标题 | 主题双色渐变并缓慢流动 |
| scramble | 科技感结论、数据揭示 | 乱码逐字解出 |
| kinetic | 口号、活泼开场 | 逐字弹入，自动折行 |
| maskreveal | 金句、结论（纵向） | 每行从裁切框升起 |
| highlight | 长句里抬一个词 | 荧光笔从左扫过关键词，字不动 |
| stomp | 必须被记住的那一句 | 整块大字砸下来 + 震屏 + 冲击线 |
| wipe | 清单、步骤、原因（横向） | 色带横向推开，比 maskreveal 更有速度 |
| marquee | 制造"信息很多"的体感 | 多行大字滚动（行数不限，行多自动缩小），行间方向可相反 |
| wave | 口号悬停、音乐节奏段 | 一行字持续起伏（律动，不是入场动画）；kinetic 是弹一次就停 |
| slot | 直播抽奖、开奖揭晓 | 三列依次减速停稳，停一列亮一列；result 必须在符号池里 |

**氛围层（backdrop）**：任意版式都能在属性面板垫一层 `glow / grain / lightleak / bokeh /
sparks / vhs / spotlight / gridflow / rain / liquid`（`set_scene_backdrop`）。
它**不占时长**、不压字（默认垫在版式下面），比"插一幕氛围版式"更省时间。
层次可选 `下 / 上 / 顶`，可设出现区间与两端柔化，`speed` 调快慢。
带正文的动效（typewriter / counter / gradienttext / scramble / highlight / stomp / wipe / marquee）
**不能**当氛围层——会同时出现两套字。

## 版式补位配方（freeform 画面看着空时用）

**先确认是不是真的空**：竖向单列排到 60–70% 高度、横向占到 75–90% 时，
缺的通常是**信息层次**而不是面积——这时补下面三层，不是换版式。

| 层 | 位置 | 参数示例 | 作用 |
|---|---|---|---|
| 背景氛围 | 满屏 | `fx / kind:"glow"` 或 SVG 径向光晕 `size 180 / x50 y50` | 给黑底一层纵深，别再是死黑 |
| 顶部 kicker | `y 15` | `size 2.8`，强调色，≤ 12 字 | 一句话说清这幕在讲什么 |
| 底部结论行 | `y 78` | `size 4.2`，另一种强调色 | 给这幕一个落点（数字/结论/下一步） |

- **全片一次铺完**：`apply_to_scenes(tool="add_element", applyToAll=true)`，不用逐幕加
- **别为了填满把整片改成手写栅格**——会丢掉场景自带的数字滚动和错峰入场，
  还要手写几十套坐标（实测教训：50 幕全改 freeform，最后又改回来）
- 三层是**可选项不是标配**：呼吸页、纯图页、已经有强视觉主体的幕都不需要补
- 已经铺满的画面上再加装饰是减法里说的「加法」，不要为了不空而填

## 元素外观（agent 可自由调）

`add_element` / `update_element` 里所有元素都支持这些参数（按短边百分比）：

- 版式：`radius` 圆角、`border`+`borderColor`、`shadow`（box-shadow）、`clipPath`（异形裁切）
- 效果：`filter`（blur/brightness/saturate…）、`blendMode`（mix-blend-mode）
- 文字：`fontFamily`、`lineHeight`、`letterSpacing`、`textAlign`、`fontStyle`、`underline`、`maxWidth`（自动换行）
- 图片/视频：`fit`（cover/contain/fill）
- SVG：`strokeLinecap` / `strokeLinejoin`
- 背景 `bg` 支持任意 CSS（含 `linear-gradient(...)`）
- `style` 参数可传任意内联 CSS（camelCase 键），最后应用、可覆盖上面所有预设（如 `{ textShadow: '0 0 20px #0ff', transform: 'skew(-8deg)' }`）

## 通用坑

- **`durationInFrames` 是"元素出现多久"，不是出场动画时长**：不传或传 -1 = 撑到场景结尾；写了正数就固定那么长，忘了改会导致中途消失
- 换 SVG 造型直接用 `update_element(svg=...)`，不用删了重加
- 固定版式的 props 坑（未知字段静默丢弃、items 形状、timeline 的 title）都在 `scene-recipes-archive` 里，本篇不再重复
