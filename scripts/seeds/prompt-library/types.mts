/**
 * 提示词库种子条目的类型。
 *
 * 为什么种子和 md 分开：md 里有大量由源站自动带出的元信息（作者、原贴、槽位默认值、
 * 时长画幅、源 slug），这些手抄 207 遍必错；而正文（中文改写）只能人写。
 * 所以这里只写"人要写的那部分"，元信息由 scripts/build-prompt-library.mts 从
 * data/prompt-motion/source.json 合并进来，格式一次定死。
 */

/**
 * 类型轴：定义在 `shared/prompt-library.ts`，前后端与构建脚本共用同一份。
 *
 * 为什么不在这个文件里再写一遍：文件夹名就是索引的分类依据，构建脚本按它建目录、
 * 服务端按它读目录、面板按它筛选；三处各写一遍，改一次名就会有一处漏。
 */
export type { PromptGenre } from "../../../shared/prompt-library";
import type { PromptGenre } from "../../../shared/prompt-library";

export type Seed = {
  /** 对应 data/prompt-motion/source.json 里的 slug，必须唯一且存在 */
  slug: string;
  /**
   * 家族 id（见 families.mts）。给了就用家族的正文/适合/关键词/摘要模板，
   * 本条只写差异段 `note`；不给就必须自带 `body`（结构独一份的那几条）。
   */
  family?: string;
  /** 中文主题短语（≤14 字），家族摘要模板里的 `{t}` 就是它。用家族时必填 */
  theme?: string;
  /** 中文名（标签页卡片标题）。同一批里不能重名 */
  name: string;
  /** 不给就用家族的 */
  genre?: PromptGenre;
  /** 长什么样：不给就由家族的 lookTpl + theme 生成 */
  look?: string;
  /** 适合：不给就用家族的 */
  fit?: string;
  /** 关键词：不给就用家族的 */
  tags?: string[];
  /**
   * 槽位默认值的中文改写（可选）。键同源站 slot key（product / brand / ending / theme…）。
   *
   * 为什么要有：源站默认值常是英文描述句（"its own colors and typeface"、
   * "a one-line call to action"），原样落进中文库，标签页里就像没翻译完。
   * 产品名、数字、URL 这类不需要改的就不用写。
   */
  slotCn?: Record<string, string>;
  /**
   * `## 提示词` 正文（中文）。
   *
   * 写法约定：
   * · 用 `**小标题**：…` 分段，**不要用 `##`**——索引取正文是"取到下一个 ## 为止"，
   *   正文里出现 ## 会把后半段截断
   * · 讲「要证明什么 / 贯穿物 / 结构 / 动效铁律 / 禁止 / 出片前怎么验」，不写工具调用流水账
   * · 源站的 `<build>`（Playwright / window.seek / Web Audio）一律换成我们的栈，
   *   校验脚本会挡这几个词
   */
  body?: string;
  /**
   * 差异段：这一条和同族其他条的区别——拍什么、有什么特殊约束。
   * 会渲染成正文开头的一行「**这一条**：…」，后面接家族骨架。
   */
  note?: string;
};

/**
 * 单技法种子（TK 段）。
 *
 * 和 `Seed` 的差别不只是字段少——**语义不同**：`Seed` 是一部片子的骨架，
 * 这里是一个几十秒的效果。所以没有槽位继承、没有家族共享（技法之间不共享骨架，
 * 共享了就成了"同类复制件"，正是配方库当初被砍掉的那批）。
 *
 * 编号由声明顺序决定（TK001 起），不手写：手写一定会出现改序后的重号，
 * 而重号在面板上表现为"两条不同技法同一个号"，是那种不会报错只会让人困惑的错。
 */
export type TechniqueSeed = {
  /** 原条目 id（A1 / B3 / G2…）。只用于「出处」行与归档回溯，不参与编号 */
  sourceId: string;
  /** 中文名。同一批里不能重名 */
  name: string;
  /** 长什么样：一句 20–90 字，写画面不写方法 */
  look: string;
  /** 适合：什么片子/什么情绪该用它，8–60 字 */
  fit: string;
  /** 关键词：3–6 个 */
  tags: string[];
  /** 时长：这个效果的合理长度（如「4–8 秒」）。留空就写「按内容定」 */
  dur?: string;
  /**
   * `## 提示词` 正文（中文）。
   *
   * 与 `Seed.body` 同一套写法约定（`**小标题**：…` 分段、不出现 `##`、不写源站技术栈）。
   * 内容上要答这四件事，缺一件这条技法就没法用：
   * 1. **什么时候用**（讲什么内容时它才成立，不是万能的）
   * 2. **怎么在我们工具里做**（元素 / 幕 / 缓动 / 逐帧确定性，不是 Canvas 绘制函数）
   * 3. **参数**（数量、速度、透明度、频率——从原文代码里读出来的具体数字）
   * 4. **验收怎么看一眼**（preview_frames / render_preview_clip 该看到什么）
   */
  body: string;
};
