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
};
