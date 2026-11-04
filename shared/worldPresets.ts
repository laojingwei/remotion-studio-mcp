/**
 * 世界全景图「配方表」。
 *
 * ⚠️ **这里说的不是「项目里已经有的素材」。**
 * `public/` 整块不进版本库（可能是软链到外部工作空间），所以任何一张全景图都可能不在本机。
 * 想确认某个文件到底在不在，用 `list_world_skies` —— 它会真的去扫目录，把「有 / 没有」标出来，
 * 而不是照着这张表想当然。
 *
 * 表里给的是两样东西：
 *
 * 1. **素材推荐**：Poly Haven 的 CC0 全景图（可商用），按题材分好类，`asset` 就是它的资产 id。
 *    下载地址 = `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/{asset}_2k.hdr`
 * 2. **起始档位**：这类图的常见参数（背景亮度 / 环境强度 / 雾 / 暗角 / 补光 / 地面）。
 *
 * 第 2 条只是**起点，不是保证值**。全景图的绝对亮度差几十倍（雪地反光、正午太阳、室内灯箱、
 * 银河几乎是黑的），这些数字是「大致该往哪个方向压」，套完必须抽帧看：
 * 背景有没有过曝、主体还读不读得出来、影子方向和照片里的太阳对不对。
 * 真实的微调永远是在项目里、对着那一帧做的 —— 三张图一个好参数，换一张就不成立。
 */

export interface WorldSkyPreset {
  id: string;
  /** 中文名 */
  label: string;
  /** Poly Haven 资产 id（下载地址与文件名都由它拼出来） */
  asset: string;
  category: "season" | "time" | "night" | "indoor";
  /** 一句话：什么题材用得上 */
  note: string;
  /** 起始档位（不是保证值，套完要抽帧微调） */
  world: {
    imageIntensity: number;
    envIntensity: number;
    haze: number;
    vignette: number;
    imageRotation?: number;
  };
  /** 建议的补光：全景图已经是主光，这些只补暗部和轮廓 */
  lights?: Record<string, unknown>[];
  post?: { bloom?: number; exposure?: number };
  ground?: { mode: "shadow" | "solid"; shadowOpacity?: number };
}

export const WORLD_DIR = "/assets/library/world";

/** 站内相对目录（public 下），列目录用 */
export const WORLD_DIR_REL = "assets/library/world";

export const hdriFileName = (asset: string): string => `${asset}_2k.hdr`;

/** 站内路径（写进 world.image） */
export const hdriPath = (asset: string): string => `${WORLD_DIR}/${hdriFileName(asset)}`;

/** Poly Haven 原始下载地址（CC0，可商用；2k 约 5–7MB） */
export const hdriDownloadUrl = (asset: string): string =>
  `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/${hdriFileName(asset)}`;

export const WORLD_SKIES: WorldSkyPreset[] = [
  /* ───────────────────────── 春 ───────────────────────── */
  {
    id: "spring-meadow",
    label: "春 · 绿野晴空",
    asset: "horn-koppe_spring",
    category: "season",
    note: "开阔草原 + 蓝天白云，适合新能源、农业、户外设备、成长类题材",
    world: { imageIntensity: 0.8, envIntensity: 0.5, haze: 0.3, vignette: 0.3 },
    lights: [
      { type: "ambient", color: "#8FA6C4", intensity: 1.4 },
      { type: "directional", color: "#FFF6E6", intensity: 1.8, position: [5, 4, 6] },
    ],
    post: { bloom: 0.3, exposure: 1.15 },
    ground: { mode: "shadow", shadowOpacity: 0.5 },
  },

  /* ───────────────────────── 夏 ───────────────────────── */
  {
    id: "summer-noon",
    label: "夏 · 正午蓝天",
    asset: "kloofendal_48d_partly_cloudy_puresky",
    category: "season",
    note: "硬顶光、影子最短最硬，适合强调体积与结构的机械/建筑主体",
    world: { imageIntensity: 0.7, envIntensity: 0.42, haze: 0.28, vignette: 0.3 },
    lights: [
      { type: "ambient", color: "#9BB4D6", intensity: 1.2 },
      // 顶着太阳拍，正面补一盏压住「锅盖顶光」，暗部才不会糊成一片
      { type: "directional", color: "#DCE9FF", intensity: 1.8, position: [-6, 3, 5] },
    ],
    post: { bloom: 0.25, exposure: 1.1 },
    ground: { mode: "shadow", shadowOpacity: 0.6 },
  },

  /* ───────────────────────── 秋 ───────────────────────── */
  {
    id: "autumn-hills",
    label: "秋 · 枯黄丘陵",
    asset: "autumn_hill_view",
    category: "season",
    note: "低角度暖阳 + 金黄草坡，适合怀旧、农业、纪实、老物件",
    world: { imageIntensity: 0.85, envIntensity: 0.5, haze: 0.32, vignette: 0.32 },
    lights: [
      { type: "ambient", color: "#9A8B78", intensity: 1.5 },
      { type: "directional", color: "#FFE8C4", intensity: 1.9, position: [-5, 3.4, 5] },
    ],
    post: { bloom: 0.3, exposure: 1.15 },
    ground: { mode: "shadow", shadowOpacity: 0.55 },
  },

  /* ───────────────────────── 冬 ───────────────────────── */
  {
    id: "winter-snow",
    label: "冬 · 雪坡阴天",
    asset: "snowy_hillside_02",
    category: "season",
    note: "雪面反光极强、天光偏冷蓝，适合冷链、取暖、冬季户外；背景要压，不然雪比主体亮",
    world: { imageIntensity: 0.55, envIntensity: 0.4, haze: 0.4, vignette: 0.34 },
    lights: [
      { type: "ambient", color: "#C3D4EA", intensity: 1.4 },
      { type: "directional", color: "#EAF2FF", intensity: 1.5, position: [4, 4.5, 5] },
    ],
    post: { bloom: 0.2, exposure: 1.0 },
    ground: { mode: "shadow", shadowOpacity: 0.4 },
  },

  /* ───────────────────── 早 / 中 / 黄昏 ───────────────────── */
  {
    id: "dawn-field",
    label: "晨 · 日出原野",
    asset: "bloem_field_sunrise",
    category: "time",
    note: "太阳刚出地平线，逆光长影 + 暖金轮廓，最适合开场镜头；对着太阳拍要补正面光，否则是剪影",
    world: { imageIntensity: 0.9, envIntensity: 0.42, haze: 0.38, vignette: 0.36 },
    lights: [
      { type: "ambient", color: "#8E9AB4", intensity: 1.3 },
      { type: "directional", color: "#FFE3C0", intensity: 1.9, position: [6, 2.5, 7] },
    ],
    post: { bloom: 0.5, exposure: 1.15 },
    ground: { mode: "shadow", shadowOpacity: 0.5 },
  },
  {
    id: "misty-morning",
    label: "晨 · 薄雾柔光",
    asset: "kloofendal_misty_morning_puresky",
    category: "time",
    note: "几乎无方向的极柔光，产品展示/材质特写最好用；想要干净大气就选它",
    world: { imageIntensity: 0.85, envIntensity: 0.65, haze: 0.45, vignette: 0.28 },
    lights: [
      { type: "ambient", color: "#C9D2DC", intensity: 1.6 },
      { type: "directional", color: "#F2F6FA", intensity: 1.2, position: [3, 5, 5] },
    ],
    post: { bloom: 0.15, exposure: 1.05 },
    ground: { mode: "shadow", shadowOpacity: 0.45 },
  },
  {
    id: "overcast",
    label: "阴天 · 均匀柔光",
    asset: "kloofendal_overcast_puresky",
    category: "time",
    note: "阴天灰云，最保险的万能背景：不抢主体、不出现过曝，有棚拍质感",
    world: { imageIntensity: 0.8, envIntensity: 0.6, haze: 0.4, vignette: 0.3 },
    lights: [
      { type: "ambient", color: "#B6C0CC", intensity: 1.6 },
      { type: "directional", color: "#F4F7FA", intensity: 1.3, position: [2, 5, 6] },
    ],
    post: { bloom: 0.15, exposure: 1.05 },
    ground: { mode: "shadow", shadowOpacity: 0.5 },
  },
  {
    id: "golden-hour",
    label: "黄昏 · 草原夕照",
    asset: "belfast_sunset",
    category: "time",
    note: "低角度暖阳、长影子，最有电影感；配金属和逆光轮廓最出彩",
    world: { imageIntensity: 0.78, envIntensity: 0.55, haze: 0.18, vignette: 0.3 },
    lights: [
      { type: "ambient", color: "#6A7488", intensity: 1.0 },
      { type: "directional", color: "#FFD2A0", intensity: 2.2, position: [-5, 3.2, -6] },
      { type: "directional", color: "#9FB6D8", intensity: 0.9, position: [6, 2.5, 6] },
    ],
    post: { bloom: 0.4, exposure: 1.2 },
    ground: { mode: "shadow", shadowOpacity: 0.6 },
  },

  /* ─────────────────────── 夜 / 宇宙 ─────────────────────── */
  {
    id: "city-night",
    label: "夜 · 城市灯火",
    asset: "modern_buildings_night",
    category: "night",
    note: "玻璃幕墙 + 楼宇灯火，适合科技、发布会、都市题材；幕墙是几千尼特，环境必须大压",
    world: { imageIntensity: 0.36, envIntensity: 0.22, haze: 0.1, vignette: 0.42 },
    lights: [
      { type: "ambient", color: "#65789E", intensity: 1.9 },
      { type: "directional", color: "#FFDBB0", intensity: 4.0, position: [-4, 3, 4.5] },
      { type: "directional", color: "#8FB4E8", intensity: 2.2, position: [5, 3, -6] },
    ],
    post: { bloom: 0.12, exposure: 1.0 },
    ground: { mode: "shadow", shadowOpacity: 0.7 },
  },
  {
    id: "milky-way",
    label: "夜 · 银河星河（宇宙）",
    asset: "dikhololo_night",
    category: "night",
    note: "银河拱桥 + 地平线光污染，做宇宙/星空/宏大叙事；haze 必须 0，否则银河被雾洗掉",
    world: { imageIntensity: 1.0, envIntensity: 1.6, haze: 0, vignette: 0.38 },
    lights: [
      // 星空几乎不提供照明，主体全靠这两盏冷月光；给少了就是一张纯黑剪影配星星
      { type: "ambient", color: "#2E3A55", intensity: 1.1 },
      { type: "directional", color: "#A9C2E8", intensity: 1.9, position: [-6, 4, -5] },
    ],
    post: { bloom: 0.5, exposure: 1.15 },
    ground: { mode: "shadow", shadowOpacity: 0.8 },
  },

  /* ───────────────────────── 室内 ───────────────────────── */
  {
    id: "warehouse",
    label: "室内 · 工业厂房",
    asset: "empty_warehouse_01",
    category: "indoor",
    note: "水泥地 + 顶部灯带 + 卷帘门，机械/机车/大型设备的天然舞台",
    world: { imageIntensity: 0.75, envIntensity: 0.5, haze: 0.12, vignette: 0.36 },
    lights: [
      { type: "ambient", color: "#AEB6C0", intensity: 1.5 },
      { type: "directional", color: "#FFF4E2", intensity: 1.8, position: [4, 6, 3] },
    ],
    post: { bloom: 0.35, exposure: 1.1 },
    ground: { mode: "shadow", shadowOpacity: 0.6 },
  },
  {
    id: "apartment",
    label: "室内 · 居家大窗",
    asset: "brown_photostudio_02",
    category: "indoor",
    note: "北欧风客厅 + 整面大窗的柔和自然光，适合生活方式、家电、消费电子",
    world: { imageIntensity: 0.8, envIntensity: 0.7, haze: 0.08, vignette: 0.3 },
    lights: [
      { type: "ambient", color: "#D8CFC2", intensity: 1.6 },
      { type: "directional", color: "#FFF8EE", intensity: 1.2, position: [6, 3, 4] },
    ],
    post: { bloom: 0.2, exposure: 1.05 },
    ground: { mode: "shadow", shadowOpacity: 0.45 },
  },
];

/** 按 id 找预设；也接受 Poly Haven 资产 id 或文件名（agent 常把路径和 id 混着给） */
export const findWorldSky = (id: string): WorldSkyPreset | undefined => {
  const key = id.trim();
  const bare = key.replace(/^.*\//, "").replace(/_2k\.hdr$/i, "");
  return (
    WORLD_SKIES.find((s) => s.id === key) ??
    WORLD_SKIES.find((s) => s.asset === key) ??
    WORLD_SKIES.find((s) => s.asset === bare)
  );
};
