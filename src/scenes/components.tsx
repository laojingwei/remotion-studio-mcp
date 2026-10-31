import type React from "react";
import { TitleScene } from "./title/Title";
import { BulletsScene } from "./bullets/Bullets";
import { ChartScene } from "./chart/Chart";
import { QuoteScene } from "./quote/Quote";
import { ImageScene } from "./image/Image";
import { StepsScene } from "./steps/Steps";
import { OutroScene } from "./outro/Outro";
import { EmptyScene } from "./empty/Empty";
import { CaptionScene } from "./caption/Caption";
import { CompareScene } from "./compare/Compare";
import { StatsScene } from "./stats/Stats";
import { ShowcaseScene } from "./showcase/Showcase";
import { ListScene } from "./list/List";
import { TimelineScene } from "./timeline/Timeline";
import { PricingScene } from "./pricing/Pricing";
import { BigTextScene } from "./bigtext/BigText";
import { HeroScene } from "./hero/Hero";
import { SplitScene } from "./split/Split";
import { CardsScene } from "./cards/Cards";
import { RingScene } from "./ring/Ring";
import { ChatScene } from "./chat/Chat";
import { CountdownScene } from "./countdown/Countdown";
import { GalleryScene } from "./gallery/Gallery";
import { BarsScene } from "./bars/Bars";
import { VersusScene } from "./versus/Versus";
import { QrScene } from "./qr/Qr";
import { RatingScene } from "./rating/Rating";
import { TableScene } from "./table/Table";
import { TagsScene } from "./tags/Tags";
import { TeamScene } from "./team/Team";
import { AuroraScene } from "./aurora/Aurora";
import { NeonScene } from "./neon/Neon";
import { StarsScene } from "./stars/Stars";
import { FreeformScene } from "./freeform/Freeform";
import { GlowScene } from "./glow/Glow";
import { GrainScene } from "./grain/Grain";
import { LightLeakScene } from "./lightleak/LightLeak";
import { KineticScene } from "./kinetic/Kinetic";
import { MaskRevealScene } from "./maskreveal/MaskReveal";
import { TypewriterScene } from "./typewriter/Typewriter";
import { CounterScene } from "./counter/Counter";
import { GradientTextScene } from "./gradienttext/GradientText";
import { ScrambleScene } from "./scramble/Scramble";
import { BokehScene } from "./bokeh/Bokeh";
import { SparksScene } from "./sparks/Sparks";
import { VhsScene } from "./vhs/Vhs";
import { HighlightScene } from "./highlight/Highlight";
import { StompScene } from "./stomp/Stomp";
import { WipeScene } from "./wipe/Wipe";
import { MarqueeScene } from "./marquee/Marquee";
import { SpotlightScene } from "./spotlight/Spotlight";
import { GridflowScene } from "./gridflow/Gridflow";
import { RainScene } from "./rain/Rain";
import { LiquidScene } from "./liquid/Liquid";
import { GaugeScene } from "./gauge/Gauge";
import { RaceBarsScene } from "./racebars/RaceBars";
import { FunnelScene } from "./funnel/Funnel";
import { DeltaScene } from "./delta/Delta";
import { ConfettiScene } from "./confetti/Confetti";
import { SnowScene } from "./snow/Snow";
import { FireworksScene } from "./fireworks/Fireworks";
import { SmokeScene } from "./smoke/Smoke";
import { LineChartScene } from "./linechart/LineChart";
import { PieScene } from "./pie/Pie";

/**
 * 场景组件注册表：type → 渲染组件
 * 新增场景三步：写 shared/sceneMetas 的 meta、写组件、在这里登记。
 */
export const SCENE_COMPONENTS: Record<string, React.FC<any>> = {
  freeform: FreeformScene,
  title: TitleScene,
  bullets: BulletsScene,
  chart: ChartScene,
  quote: QuoteScene,
  image: ImageScene,
  steps: StepsScene,
  outro: OutroScene,
  empty: EmptyScene,
  caption: CaptionScene,
  compare: CompareScene,
  stats: StatsScene,
  life: ShowcaseScene,
  game: ShowcaseScene,
  tech: ShowcaseScene,
  edu: ShowcaseScene,
  live: ShowcaseScene,
  shop: ShowcaseScene,
  "game-stats": StatsScene,
  list: ListScene,
  timeline: TimelineScene,
  pricing: PricingScene,
  bigtext: BigTextScene,
  hero: HeroScene,
  split: SplitScene,
  cards: CardsScene,
  ring: RingScene,
  chat: ChatScene,
  countdown: CountdownScene,
  gallery: GalleryScene,
  bars: BarsScene,
  versus: VersusScene,
  qr: QrScene,
  rating: RatingScene,
  table: TableScene,
  tags: TagsScene,
  team: TeamScene,
  aurora: AuroraScene,
  neon: NeonScene,
  stars: StarsScene,
  // 动效场景（2026-10-31）：主体是运动本身，不参与版面密度审计
  glow: GlowScene,
  grain: GrainScene,
  lightleak: LightLeakScene,
  kinetic: KineticScene,
  maskreveal: MaskRevealScene,
  // 第二批（2026-10-31）：文字强调 + 背景氛围
  typewriter: TypewriterScene,
  counter: CounterScene,
  gradienttext: GradientTextScene,
  scramble: ScrambleScene,
  bokeh: BokehScene,
  sparks: SparksScene,
  vhs: VhsScene,
  // 第三批（2026-10-31）：文字强调 + 背景氛围
  highlight: HighlightScene,
  stomp: StompScene,
  wipe: WipeScene,
  marquee: MarqueeScene,
  spotlight: SpotlightScene,
  gridflow: GridflowScene,
  rain: RainScene,
  liquid: LiquidScene,
  // 第四批（2026-10-31）：数据
  gauge: GaugeScene,
  racebars: RaceBarsScene,
  funnel: FunnelScene,
  delta: DeltaScene,
  // 第五批（2026-10-31）：粒子氛围 + 数据图表
  confetti: ConfettiScene,
  snow: SnowScene,
  fireworks: FireworksScene,
  smoke: SmokeScene,
  linechart: LineChartScene,
  pie: PieScene,
};
