# 3D 场景（scene3d）

真 3D：three.js 渲染，几何体 + 光照 + 相机运动。做 2D 给不了的空间感——行星公转、装置拆解、分子结构、球面网络。

**两条路，先选对**：

| 你想要 | 走哪条 |
|---|---|
| 抽象氛围：一个核心 + 卫星绕、粒子星云、网格地平线、波形柱阵 | **预设**：只传 `preset` / `look` / `spin` / `count`，一行搞定 |
| 具体的东西：太阳系、分子、机器零件、产品结构、任何"要像那个东西" | **场景图 `graph`**：自己写节点树 |

预设是六套**成品镜头**（另有 `blank` 空白默认值，什么都不画），不是模型库——它变不出"八大行星"。要具体物体只能写 `graph`。
给 `graph` 之后 `preset` / `spin` / `count` / `hue` 全部失效（见文末坑 1）。

**要先读哪一节**：写世界背景（深空/全景图/渐变）和运镜（推拉、换主体、长镜头）之前，
先读 **第六章「世界背景与运镜」** —— 那里的每一条都对应一个"看起来像渲染坏了"的成品问题。
只读这一节：`get_guide("scene3d", section:"运镜")`。

---

## 一、预设模式

```json
{ "type": "scene3d", "props": { "preset": "orbit-core", "look": "cyber", "spin": 14, "count": 5,
  "title": "一个核心，五个方向", "sub": "" } }
```

| `preset` | 画面 | `spin` 是什么 | `count` 是什么 |
|---|---|---|---|
| `blank` | **空白画布（默认）**：什么都不渲染，直接给 `graph` 从零搭 | — | — |
| `orbit-core` | 中心几何体自转 + 卫星环绕 | 自转 度/秒 | 卫星数（1–12） |
| `particle-field` | 粒子星云，中心有核 | 自转 度/秒 | 粒子倍率 |
| `grid-horizon` | 透视网格铺向远方 | 自转 度/秒 | 网格密度 |
| `explode-parts` | 环形零件炸开再合拢 | 自转 度/秒 | 零件数 |
| `waveform` | 一排柱子起伏成波 | 波动快慢 | 柱数 |
| `globe-arc` | 球面点阵 + 拱形连线 | 自转 度/秒 | 点阵密度与弧线数 |

`look`：`auto`（按预设自动挑）/ `studio` 明亮产品光 / `dramatic` 暗调暖主光 / `cyber` 冷色高对比 / `nature` 天光。
`hue`：主色取主题哪一路（`primary` / `accent` / `secondary` / `text`），**只管预设母题的主色**，不写死色值才能跟风格联动。
`title` / `sub`：画面下方 2D 叠层文字（不进 3D，见坑 4）。

---

## 二、场景图 `graph`

### 最小骨架

```json
{
  "type": "scene3d", "durationInFrames": 300,
  "props": {
    "look": "dramatic",
    "graph": {
      "camera": { "position": [0, 4, 12], "target": [0, 0, 0], "fov": 42 },
      "nodes": [
        { "id": "core", "geometry": { "type": "sphere", "radius": 1.2 },
          "material": { "color": "#FFB020", "emissive": "#FF8A00", "emissiveIntensity": 2.2, "body": false },
          "anim": [{ "at": [0, 299], "to": { "rotY": 360 }, "ease": "linear" }] }
      ],
      "lights": [
        { "type": "ambient", "color": "#26344d", "intensity": 0.2 },
        { "type": "point", "position": [0, 0, 0], "color": "#FFF1D6", "intensity": 6, "decay": 0 }
      ],
      "particles": { "count": 1200, "spread": [30, 20, 30], "size": 0.1, "color": "#FFFFFF" },
      "post": { "bloom": 1.2 }
    }
  }
}
```

坐标：右手系，**+Y 向上**，单位是"世界单位"（不是像素）。相机默认看向原点。
节点上限 **48 个**，每个节点动画最多 **8 段**，灯最多 **8 盏**，粒子最多 **6000**。

### camera

| 字段 | 说明 |
|---|---|
| `position` | 相机位置，默认 `[0,1.6,6]` |
| `target` | 看向哪里，默认原点 |
| `fov` | 10–120，默认 42 |
| `orbit.degPerSec` | 绕 target 匀速环绕（度/秒），只转相机不动物体 |
| `anim[]` | 运镜关键帧：`{at,from,to,ease,follow,lookAt}`，键是 `posX posY posZ targetX targetY targetZ fov` |
| `anim[].follow` | 钉在某个节点上：本段 pos/target 变成**相对该节点的偏移**——拍公转中的行星必须用它，否则几帧后主体就跑出画 |
| `anim[].lookAt` | **段内锁定看向某个节点**：target 每帧重算为该节点世界位置（`targetX/Y/Z` 在锁定段失效）。`lookAtOffset:[0,0.6,0]` 可以看向头顶 |
| `anim[].lookAt` 的退出 | 下一段不给 `lookAt`、也**不写 `from` 的 target** 时，起点自动落在"退出帧那一刻的锁定点"上，镜头不会甩；写了 `from.target` 就按写的坐标硬切 |
| `anim[].curve` | 运镜也可以走弧线（同节点 `curve`）：`{out,in}` 是相对直线的偏移，绕拍、甩镜用它，不写=直线。**看向点要单独弯时写 `targetOut`/`targetIn`**：不写会沿用位置的 out/in（老行为），而位置和看向点共用一条切线时，镜头方向会在段边界折角 = 播放时一抖一抖 |
| `follow` + `lookAt` | 可以同时给、也可以指向不同节点：`follow` 管"相机在哪"，`lookAt` 管"镜头朝哪"。两者同给时 target 只算一次（不会叠加两次偏移） |

`anim` 同 key 的多段必须首尾相接、不重叠（边界帧 `end = 下一段 start − 1`）。

> 运镜怎么设计才不抖、不平、不穿模，见 **第六章**（含公式与自检指标）。

**什么时候用 `lookAt` 而不是 key 帧 `target`**：目标自己在动（公转的行星、飘的物体、被旋转枢轴带动的子节点）
——用 `targetX/Y/Z` 写死坐标，几帧后目标就移开画面了；`lookAt` 是每帧求值，目标动到哪儿镜头跟到哪儿。
只想让镜头"看向某个固定位置"时仍然用 `targetX/Y/Z`（更便宜也更好改）。

**求值语义（节点 `anim` 和相机 `anim` 一致）**：段**开始前**不参与（用基础值 / 上一段的终值），
段**结束后保持终值**——最后一段的 `to` 一直生效到幕尾。想让物体"变完再弹回去"必须写两段
（去程 + 回程），不要指望段外自动复位。

### nodes

| 字段 | 说明 |
|---|---|
| `id` | 场景内唯一。子节点用 `parent` 引用它 |
| `parent` | 父节点 id。**子节点挂在父节点下，父节点的位移/旋转/缩放会带着子节点一起动**（做公转、卫星、机械臂全靠它） |
| `geometry` | 见下表。**省略 = 纯枢轴 `group`**（不渲染，只当"整组一起动"的父级） |
| `material` | 不写就是一层中性暗金属 |
| `transform.position / rotation / scale / scaleXYZ` | 基础变换，`rotation` 是**度** |
| `anim[]` | 关键帧，最多 8 段。段结束后**保持终值**（同相机 `anim` 的语义） |
| `anim[].curve` | 轨迹曲线：`{out:[x,y,z], in:[x,y,z]}`，两个都是**相对直线方向的偏移**（世界单位）。不写/全零 = 直线；`out` 和 `in` 给相同值 = 这一段朝那个方向鼓出去。物体位置和相机位置都生效 |

### 几何体白名单（14 种，写错 type 会直接报可用值）

| type | 字段（都有默认值） |
|---|---|
| `group` | 无字段。**纯枢轴**：不画任何东西，只提供可位移/旋转的父级。整列车、整台机器、机器人上半身靠它 |
| `sphere` | `radius` `segments`(4–96，越高越圆也越慢) |
| `box` | `width` `height` `depth` |
| `cylinder` | `radiusTop` `radiusBottom` `height` `segments` |
| `cone` | `radius` `height` `segments` |
| `torus` | `radius` `tube` `radialSegments` `tubularSegments` |
| `torusKnot` | `radius` `tube` `p` `q` |
| `plane` | `width` `height` |
| `capsule` | `radius` `length` |
| `icosahedron` / `dodecahedron` / `octahedron` | `radius` `detail`(0=保留棱角) |
| `ring` | `innerRadius`(0=实心圆盘) `outerRadius` |
| `dashRing` | `radius` `count`(8–400) `duty`(0.05–0.95) —— **虚线圆环，专门画轨道**；`width` 保留但不生效（线宽固定 1px） |

### 材质

```json
"material": { "type": "standard", "color": "#4FA3D1", "metalness": 0.1, "roughness": 0.7,
  "emissive": "#FF8A00", "emissiveIntensity": 2, "opacity": 1, "body": false }
```

| 字段 | 说明 |
|---|---|
| `type` | `standard` PBR（默认）/ `physical` 玻璃透射 / `basic` 不受光（线框 HUD、纯色剪影） |
| `color` | 主题语义色 `primary/accent/secondary/text/muted` 或 `#RRGGBB` |
| `metalness` `roughness` | standard 有效；`roughness` 越小高光越锐 |
| `emissive` `emissiveIntensity`(0–4) | 自发光。**太阳、指示灯、霓虹只靠它亮**；辉光（bloom）只吃够亮的部分 |
| `transmission` `thickness` `ior` | physical 有效（玻璃） |
| `wireframe` | basic 有效 |
| `side` | `front`（默认）/ `back` / `double`。**plane / ring 默认只朝 +Z，把它转成朝下会整片消失——地面光斑、贴地标线、土星环必须 `double`** |
| `flatShading` | 平面着色，多面体想棱角分明时开 |
| `opacity` | 0–1 |
| `body` | **默认 `true`**：自动降饱和 + 压到统一亮度（防"果冻球"）。要原始色值——真实星球、纯色剪影——必须 `false` |
| `map` | `{src, repeat, offset, rotation, center}` 基础色贴图；有 map 时 `color` 强制白色、`body` 失效。`src` 只能是 `/assets/xxx`（先 `upload_asset`）、`https://`、`data:`。**三个多面体不能贴图**（UV 是球面投影碎面，会硬报错） |

### 动画

和 freeform 同一套语法，键换成 3D 标量：

```json
"anim": [
  { "at": [0, 179], "from": { "posY": -2, "opacity": 0 }, "to": { "posY": 0, "opacity": 1 }, "ease": "easeOut" },
  { "at": [180, 359], "to": { "rotY": 720 }, "ease": "linear" }
]
```

- 键：`posX` `posY` `posZ` `rotX` `rotY` `rotZ`（度）`scale` `opacity`
- `from` / `to` 里的值是**绝对值**，不是偏移量；`from` 不写就取节点的基础值
- **只有 `from` 没有 `to` 的段等于没写**（服务端会直接点名）
- `at` 是幕内帧号，`end >= start`
- ⚠️ **动画区间要覆盖整幕**：帧号超出 `at` 区间后该段不再生效，节点会跳回基础值——转一整圈就写 `[0, 幕帧数-1]`

### lights

```json
"lights": [
  { "type": "ambient", "color": "#26344d", "intensity": 0.2 },
  { "type": "point", "position": [0,0,0], "color": "#FFF1D6", "intensity": 6, "decay": 0 }
]
```

| 字段 | 说明 |
|---|---|
| `type` | `ambient` 均匀环境光（没有方向，别当主光）/ `directional` 平行光 / `point` 点光 / `spot` 聚光 |
| `intensity` | 默认 6。**three 是物理单位**：point/spot 默认 `decay=2`，照度按 1/距离² 掉——距离 2 要 20 上下才亮；`directional`/`ambient` 不受距离影响，1–3 就够 |
| `position` `target` | point/spot 的位置、照向哪里 |
| `distance` `decay` | point/spot 的照射距离与衰减指数（`decay:0` = 不衰减，**调不亮时先试这个**） |
| `angle` `penumbra` | spot 的光锥半角与边缘软硬 |

⚠️ **给了 `lights`，`look` 的四盏方向光全部撤掉**，环境反射也只保留 55%，这一场的明暗完全由你给的灯决定。
这就是「太阳照亮地球」的正确做法：**point 光放在太阳位置**，行星转到哪儿就照到哪儿，明暗面永远对着太阳。

**给了灯就一定先算一遍环境光**（这条是最容易翻车的地方）：

| 场景 | ambient 给多少 | 为什么 |
|---|---|---|
| 产品 / 载具 / 机械（`metalness` 0.6–0.9） | **1.2–2.0** + 2–3 盏 directional（各 1.5–3） | 金属的亮部几乎全来自环境反射；环境被压到 55% 后，ambient 低就直接渲成剪影（蒸汽机车首版 ambient 0.55 → 车体近黑，抬到 1.6 才救回来） |
| 天文 / 夜景（要昼夜面） | **0.1–0.35** | 夜面就是要黑；ambient 一高，昼夜对比全没了 |
| 玻璃 / 大气 / 纯自发光 | 0.3–0.8 | 主要靠 transmission 与 emissive，光只负责轮廓 |

### 序列帧贴图（特效叠层）

`material.map.src` 带 `{frame}` 占位符就是序列帧贴图——每一帧换一张图，爆炸/烟雾/光效叠在 3D 物体上。
**不要自己拼 src**：`search_local_assets(fx)` 的序列帧结果直接给 `pattern`（带 `{frame}` 的完整 URL）、
`seqFrom` / `seqTo` / `frameDigits`，原样抄进来即可（真实帧名常带前缀，写成 `<文件夹url>/{frame}.png` 会 404）：

```json
"material": { "map": { "src": "<结果里的 pattern>",
                        "seqFrom": 1, "seqTo": 240, "frameDigits": 4, "seqFps": 30 } }
```

- 结果里的 `continuous: false` 表示中间跳号，别按「首帧 + N」盲推帧名，先用 keyword 核对实际文件
- 透明自动开（PNG 的 alpha 生效，透明区域透出背景）；静态镂空 Logo 用 `material.transparent: true` 显式开
- **默认播完停末帧**（爆炸/破碎这类一次性特效）；循环烟雾/流动岩浆才加 `map.loop: true`
- `seqFps` 控制快慢（工程 30fps + seqFps 30 = 1:1）
- 序列帧在**2D 场景**里用 `add_element { imageSeqSrc: "<结果里的 pattern>", seqFrom, seqTo, frameDigits }`，
  一样是透明叠层、默认停末帧，x/y/size 照常给；忘写 `{frame}` 或 `seqTo` 会被直接报错，不会静默静止

漏写 `ambient` 时内置兜底只有 0.35（只是"别纯黑"），写图回执会提示——**别等抽帧才发现车是黑的**。

### world（世界背景）

```json
"world": { "mode": "auto", "haze": 0.35, "vignette": 0.3 }
```

**背景不是主题色**。主题的 `background` 是排版的纸（暗色主题必然近黑），当世界用就等于把模型摆在黑棚里：
物体边缘融进背景、没有地平线、没有空气感 —— 这就是「背景乌漆麻黑」的来源。

| 字段 | 说明 |
|---|---|
| `preset` | 世界预设 id（`list_world_skies` 查）。**op 层展开成整组参数后不落盘**，见下面「世界预设」 |
| `mode` | `auto`（默认，按主题明暗挑中性色）/ `gradient`（自己给 `top`/`bottom`/`glow`）/ `color`（纯色）/ `image`（全景图）/ `space`（深空：黑底 + 星点 + 银河 + 星云） |
| `stars` | `mode:space`：星点密度与亮度倍数，默认 1（0 = 没有星，2 = 密集天区） |
| `milkyWay` | `mode:space`：银河带强度，默认 0.5（0 = 关）。**天文/宇宙/悬浮主体用它**，别用 `gradient` 手调 |
| `nebula` | `mode:space`：星云浓淡，默认 0.35（0 = 关） |
| `spaceTint` | `mode:space`：星云主色调，默认冷蓝 `#42558A`，偏紫可给 `#7A5C93` |
| `image` | 等距柱状全景图（2:1），站内 `/assets/…` 或 http。**优先 `.hdr`**：JPG 只有 0–1 的亮度，当照明时没有太阳那种高动态 |
| `imageLighting` | 同一张图同时当 IBL，默认 true。**这是"像真的"的最大一步**：太阳方位、天光颜色、地面反光全来自照片 |
| `imageRotation` | 背景绕 Y 轴转（度），把太阳挪到想要的方位 |
| `imageIntensity` | 背景亮度倍数，默认 1。**主体偏暗先降它（0.7–0.85），别降 exposure** —— 曝光一降，辛苦打的光一起没了 |
| `envIntensity` | 全景图当照明时的环境强度，默认 1。**城市夜景/室内这种「画面本身就很亮」的图给 0.2–0.4**：HDR 里灯箱和玻璃幕墙是几千尼特的实测值，全强度照进来整张画面直接过曝 |
| `top` `bottom` `glow` | 天顶色、地平线色、地平线漫射光带的颜色（`mode:gradient` 生效）；`image` 模式下 `bottom` 兼作**雾色** |
| `haze` | 空气透视（雾）浓度 0–1，默认 0.35。**真实感的一大半在这**：远处必须淡进背景。星空/天文给 0 |
| `vignette` | 四角压暗 0–1，默认 0.32，0 = 关 |

`auto` 的暗色版本是「深蓝灰的夜」而不是黑：天顶 `#0A0D14` → 地平线 `#2B3342`。
想要别的气氛就写 `gradient`，两个端点都建议**低饱和**（彩色天空一眼假）。

#### 深空（天文题材的唯一正确选择）

```json
"world": { "mode": "space", "stars": 1, "milkyWay": 0.5, "nebula": 0.35, "haze": 0, "vignette": 0.42 }
```

`gradient` 永远做不出深空：天空 shader 在地平线附近固定加一道亮带（那是大气散射），
放在太空里就成了"太空中的地平线"，这也是太阳系示例原来最假的地方。`space` 把这道光带关掉，
换成星点壳 + 逐像素的银河/星云（几何星点负责亮度颗粒，银河在天空 shader 里算噪声）。

- **`haze` 必须 0**：雾不会把深空洗成灰，而是把星点一层层吃掉，远处银河直接消失
- 亮星只占 6%：真实星等是幂律分布，全是亮星会像"圣诞灯"
- 银河是一条斜穿画面的弥散带（尘埃暗带 + 云块），不是均匀光柱 —— 觉得像极光就把 `milkyWay` 降到 0.2
- 星点会在行星背后被遮挡（深度测试开着），摇镜时星天跟着镜头转，不是贴死的背景板

#### 世界预设（换背景的首选路径）

```json
set_graph_scene { "sceneId": "scene_x", "worldPreset": "golden-hour" }
```

一次把**背景图 + 起始档位 + 补光 + 地面 + 后期**都配好，省得从零填十几个数。
同时给 `world` 时，里面的字段覆盖预设（比如 `world: { envIntensity: 0.9 }`）。

`list_world_skies` 会列出全部 id 和题材，并**标出本机有没有那张图**（✅ / ⛔ + 下载地址）。
当前 12 组，覆盖：春（绿野）、夏（正午蓝天）、秋（枯黄丘陵）、冬（雪坡）、晨（日出 / 薄雾）、
阴天（万能柔光）、黄昏（草原夕照）、夜（城市灯火 / 银河）、室内（工业厂房 / 居家大窗）。

> 预设里的数字是**这类图该往哪个方向压**，不是保证值。雪地要压背景、夜景要压环境、
> 银河要提环境并关雾 —— 但每张图的实际亮度只有渲染出来才知道。套完必须抽帧看。

**用全景图当世界**（最省事也最真）：

```json
"world": { "mode": "image", "image": "/assets/library/world/belfast_sunset_2k.hdr", "imageLighting": true, "imageRotation": 0, "haze": 0.15 }
```

- **素材不在仓库里，别假设它存在。** `public/` 整块不进版本库（可能是软链到外部工作空间），
  换机器、换工作空间、清过缓存之后这个目录就是空的。用 `list_world_skies` 看本机到底有哪些
  （它会真的去扫目录，✅ 有 / ⛔ 没有，缺的给下载地址）。缺失的表现是**背景静默退回渐变天空**，
  不报错——所以别跳过这一步
- 素材来源：Poly Haven（CC0，可商用，免署名）。挑 `.hdr`，别用 JPG（JPG 最亮只有 1，
  当照明没有太阳那种高动态，金属会发闷）。一张 2k 的（2048×1024）约 5–7MB：

```bash
# 想放哪张就换资产名。资产名在 polyhaven.com 的 URL 里（t=hdris 分类）
curl -L -o "public/assets/library/world/<资产名>_2k.hdr" \
  "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/<资产名>_2k.hdr"
```

  没有网络权限时，让用户帮忙下载放进 `public/assets/library/world/`，或先 `upload_asset` 再引用
- **最省事的路径是预设**：`set_graph_scene { sceneId, worldPreset: "golden-hour" }`，
  一次把背景图 + 起始档位 + 补光 + 地面 + 后期都配好（`list_world_skies` 列全部 id）。
  但**预设只是起点**：全景图亮度差几十倍，套完必须抽帧，看背景有没有过曝、主体还读不读得出来、
  影子方向和照片里的太阳对不对，再自己调
- 开了 `imageLighting` 就把 `lights` 调少：照片本身已经是主光。留一盏 ambient 补暗部 + 一两盏 directional 补轮廓
- **城市夜景/室内全景要压环境强度**：`envIntensity: 0.2–0.4`、`imageIntensity: 0.3–0.4`、`bloom: 0.12–0.2`。
  不压的话整张画面直接白掉（玻璃幕墙在 HDR 里是几千尼特）
- **`imageRotation` 同时转背景和 IBL**：转背景不转光，会出现"窗在右、光从左边来"。夜景里一眼能看出来
- 转一圈找一个**没有巨大灯箱在画面正中**的方位：全景图里的强光点落在主体背后会糊成一团白
- **地面用 `"ground": { "mode": "shadow" }`**：照片自己有地面，只让影子落上去，别铺实体平面
- 机位要低（相机 y ≈ 1.2–1.6）：照片是站在地面上拍的，机位一高，地平线就跑到画面顶上去了
- **金属度别给太高**：真实载具是"漆面"（metalness 0.2–0.35、roughness 0.5 上下），
  给 0.7+ 就变成"暗铬"，在黄昏的 HDRI 下直接渲成剪影——这是"看不清"最常见的自找原因
- 雾色和背景地平线不一致最扎眼：用 `bottom` 指定一个贴近日出的暖灰，或者 `haze:0.1` 压低它


### ground（自动地面）

```json
"ground": { "y": -0.62, "color": "#20242B", "roughness": 0.62, "metalness": 0.06 }
```

接触阴影是「落地感」的全部来源：没有地面，零件之间没有遮挡分界、物体像悬在虚空里。

| 字段 | 说明 |
|---|---|
| `y` | 地面高度，**不写就自动取所有实体节点的最低点**（再往下 0.02）。别硬写 0：原点在哪儿取决于你的建模习惯 |
| `mode` | `solid`（默认，实体地面）/ `shadow`（**只接阴影，透明**）。用全景图当世界时必须用 `shadow`：照片里本来就有地面，再铺实体平面等于盖了块塑料布 |
| `color` `roughness` `metalness` | 默认 `#191C22` / 0.72 / 0.06（哑光水泥），仅 `solid` 生效 |
| `shadowOpacity` | `shadow` 模式的阴影浓度，默认 0.55，太黑会显脏 |
| `size` | 边长，默认 160，要让边缘出画 |
| `shadow` | 是否接收投影，默认 true |

⚠️ 地面只接投影，**不会自己变出影子**：影子来自灯。`lights` 里的第一盏 `directional`/`spot` 会自动开投影；
若用的是 `look` 的默认灯，主光（key）已经投。没有任何 directional/spot 的场景（纯 ambient）不会有一点影子。

### post（后期）

```json
"post": { "bloom": 0.5, "tonemap": "aces", "exposure": 1.25 }
```

| 字段 | 说明 |
|---|---|
| `bloom` | 辉光倍数，1 = look 默认值，0 = 关 |
| `tonemap` | `aces`（默认，电影感滚降）/ `none`（逐像素还原，要和 2D 精确对色时才用） |
| `exposure` | 曝光，仅 `aces` 生效，默认 1.25（补偿 ACES 对中灰的压缩） |
| `vignette` | 暗角 0–1，默认关。0.3 轻微、0.6 明显。收视线、压四角杂物；**深浅色背景都吃**，别在已经很暗的画面上再加 |
| `chroma` | 色差 0–1，默认关。0.15 轻微、0.3 明显。科技/故障感用；**超过 0.35 文字会花**，有字幕时慎用 |
| `grain` | 胶片颗粒 0–1，默认关。0.2 轻微质感。主要用途是打散深色渐变的色带；**静止颗粒**，不逐帧变化 |
| `passes` | 插件提供的后期效果（`list_plugin_passes` 查）。数组、最多 6 个，例如 `[{ id: "vhs", intensity: 0.6 }]`；**不写就不生效** |

三个都是"口味"不是"审美升级"：默认全关。要电影感就 `vignette 0.3 + grain 0.2`，
要故障感加 `chroma 0.2`；三者叠满会糊成一片，先各开一半看抽帧。

### 材质：envMapIntensity

`material.envMapIntensity`（0–4，默认 1）是**金属亮度最直接的旋钮**：金属几乎不反射直射光，亮部全来自环境反射。
金属发黑先抬它（1.4–2.0），想要哑光压到 0.4 —— 比反复加灯有效。

环境贴图是内置的程序化「棚拍」环境：天空梯度 + 主光柔光箱 + 冷色侧板 + 顶光 + 地面反弹。
它给的是**有形状的亮部**（金属上那条渐变高光），不是一圈均匀灰 —— 这是"像真的"和"像塑料"的分界。

### particles

```json
"particles": { "count": 3000, "spread": [70, 50, 70], "size": 0.16, "color": "#FFFFFF", "drift": 0.04, "opacity": 0.85 }
```

`spread` 是三轴分布半径（椭球）；`size` 世界单位；`drift` 是整层缓慢**自转**（0=静止）；粒子是加法混合的光点，天然发光。
星空：`count` 2000–3000 + `spread` 大 + `size` 0.1–0.2 + `drift` 0.03–0.08。

### post

`{ "bloom": 1.3 }` —— 辉光**倍数**（1 = 当前 look 的默认值，0 = 关）。只想让太阳发光就调高 `bloom` + 给 `threshold`（0–1，越高只有更亮的部分发光）。

---

## 三、三个必会的套路

### 1. 公转 / 卫星：用一个可旋转的父节点当枢轴

不要给行星的 `posX/posZ` 手写一圈关键帧（段数有上限，且算不对）。**挂到一个绕 Y 轴转的父节点下**：

```json
{ "id": "orbit-earth", "geometry": { "type": "dashRing", "radius": 5.6, "count": 96, "duty": 0.35 },
  "material": { "color": "accent", "opacity": 0.16 },
  "anim": [{ "at": [0, 359], "to": { "rotY": 540 }, "ease": "linear" }] },

{ "id": "earth", "parent": "orbit-earth", "geometry": { "type": "sphere", "radius": 0.26, "segments": 32 },
  "transform": { "position": [5.6, 0, 0] },
  "material": { "color": "#2E6FA8", "body": false, "roughness": 0.8 },
  "anim": [{ "at": [0, 359], "to": { "rotY": 720 }, "ease": "linear" }] }
```

**`dashRing` 当枢轴是一石二鸟**：它本身就是轨道虚线，转起来看不出来（圆对称）；行星挂在它下面，倾角自动跟着父节点走。
半径不会自己带过去，`dashRing.radius` 和行星 `position[0]` 写同一个数就行。
行星自己的 `rotY` 是自转；要地轴倾角就在 `transform.rotation` 里写 `[0,0,23.5]`（自转动画只覆盖 `rotY`，`rotZ` 会保留）。
轨道倾角：给枢轴节点 `transform.rotation: [倾角, 0, 0]`，环和行星一起倾斜。

### 2. 太阳 + 昼夜面

太阳：`sphere` + `emissive` + `emissiveIntensity` 2–3 + `body:false`，再放一盏同位置 `point` 光（`decay:0` 或 `intensity` 抬高）。
行星：`body:false` 保住真实颜色，`roughness` 0.7–0.9（星球是石头不是金属，`metalness` 压到 0.1 以下）。

### 3. 土星环 / 地面光斑

`ring` 几何默认躺在 XY 平面、朝 +Z。要让它平躺（绕太阳的水平环、地面光圈）：

```json
{ "id": "saturn-ring", "parent": "saturn",
  "geometry": { "type": "ring", "innerRadius": 0.7, "outerRadius": 1.25 },
  "transform": { "rotation": [-75, 0, 0] },
  "material": { "color": "#C9B48A", "side": "double", "opacity": 0.5, "roughness": 0.9 } }
```

**`side:"double"` 不能省**——否则从背面看整片环直接消失。

### 4. 整组一起动：用 `group` 纯枢轴，别用隐形方块凑

做车、船、机器人这种「一整坨往前开、零件各自还在动」的东西，**先建一个 `group` 父节点**，所有零件 `parent` 到它下面，动它一个就带着全车走：

```json
{ "id": "train", "label": "整列车", "geometry": { "type": "group" },
  "anim": [{ "at": [0, 199], "from": { "posX": -8 }, "to": { "posX": 4 }, "ease": "linear" }] },

{ "id": "body",  "parent": "train", "geometry": { "type": "box", "width": 3, "height": 1, "depth": 1 } },
{ "id": "wheel", "parent": "train", "geometry": { "type": "cylinder", "radius": 0.34, "height": 0.14 },
  "transform": { "position": [0, -0.16, 0.52], "rotation": [90, 0, 0] },
  "anim": [{ "at": [0, 199], "to": { "rotZ": 720 }, "ease": "linear" }] }
```

- `geometry` **可以整个省略**，等价于 `{"type":"group"}`：不渲染、不进拾取、不占材质
- 别再用 `box: 0.001 + opacity 0` 的隐形实体凑枢轴——它会参与拾取，在编辑器里被当成一个方盒子选中
- `group` 自己**没有表面**：给它 `material` 会报错，空 `group`（没有子节点）回执会提示"看不见它"
- 相机 `follow`/`lookAt` 可以直接指向 `group`（跟拍整列车比跟某一节车厢稳）

---

## 四、完整示例：太阳系（可直接改数字）

```json
{
  "type": "scene3d", "name": "太阳系", "durationInFrames": 360,
  "props": {
    "look": "dramatic", "title": "太阳系", "sub": "八大行星 · The Solar System",
    "graph": {
      "camera": { "position": [0, 14, 46], "target": [0, 0, 0], "fov": 42, "orbit": { "degPerSec": 2 } },
      "nodes": [
        { "id": "sun", "geometry": { "type": "sphere", "radius": 2.2, "segments": 48 },
          "material": { "color": "#FFCC55", "emissive": "#FFB020", "emissiveIntensity": 2.4, "body": false },
          "anim": [{ "at": [0, 359], "to": { "rotY": 180 }, "ease": "linear" }] },

        { "id": "o-mercury", "geometry": { "type": "dashRing", "radius": 3.4, "count": 80, "duty": 0.3 },
          "material": { "color": "accent", "opacity": 0.12 },
          "anim": [{ "at": [0, 359], "to": { "rotY": 1080 }, "ease": "linear" }] },
        { "id": "mercury", "parent": "o-mercury", "geometry": { "type": "sphere", "radius": 0.17, "segments": 24 },
          "transform": { "position": [3.4, 0, 0] }, "material": { "color": "#8C8377", "body": false, "roughness": 0.9 } },

        { "id": "o-venus", "geometry": { "type": "dashRing", "radius": 4.6, "count": 88, "duty": 0.3 },
          "material": { "color": "accent", "opacity": 0.12 },
          "anim": [{ "at": [0, 359], "to": { "rotY": 720 }, "ease": "linear" }] },
        { "id": "venus", "parent": "o-venus", "geometry": { "type": "sphere", "radius": 0.25, "segments": 24 },
          "transform": { "position": [4.6, 0, 0] }, "material": { "color": "#D8B06A", "body": false, "roughness": 0.85 } },

        { "id": "o-earth", "geometry": { "type": "dashRing", "radius": 5.8, "count": 96, "duty": 0.32 },
          "material": { "color": "accent", "opacity": 0.14 },
          "anim": [{ "at": [0, 359], "to": { "rotY": 540 }, "ease": "linear" }] },
        { "id": "earth", "parent": "o-earth", "geometry": { "type": "sphere", "radius": 0.27, "segments": 32 },
          "transform": { "position": [5.8, 0, 0], "rotation": [0, 0, 23.5] },
          "material": { "color": "#2E6FA8", "body": false, "roughness": 0.8 },
          "anim": [{ "at": [0, 359], "to": { "rotY": 720 }, "ease": "linear" }] },

        { "id": "o-mars", "geometry": { "type": "dashRing", "radius": 7.0, "count": 96, "duty": 0.32 },
          "material": { "color": "accent", "opacity": 0.14 },
          "anim": [{ "at": [0, 359], "to": { "rotY": 420 }, "ease": "linear" }] },
        { "id": "mars", "parent": "o-mars", "geometry": { "type": "sphere", "radius": 0.21, "segments": 24 },
          "transform": { "position": [7.0, 0, 0] }, "material": { "color": "#B4553A", "body": false, "roughness": 0.9 } },

        { "id": "o-jupiter", "geometry": { "type": "dashRing", "radius": 9.4, "count": 110, "duty": 0.34 },
          "material": { "color": "accent", "opacity": 0.16 },
          "anim": [{ "at": [0, 359], "to": { "rotY": 240 }, "ease": "linear" }] },
        { "id": "jupiter", "parent": "o-jupiter", "geometry": { "type": "sphere", "radius": 0.62, "segments": 32 },
          "transform": { "position": [9.4, 0, 0] }, "material": { "color": "#C9A379", "body": false, "roughness": 0.85 },
          "anim": [{ "at": [0, 359], "to": { "rotY": 900 }, "ease": "linear" }] },

        { "id": "o-saturn", "geometry": { "type": "dashRing", "radius": 11.8, "count": 120, "duty": 0.34 },
          "material": { "color": "accent", "opacity": 0.16 },
          "anim": [{ "at": [0, 359], "to": { "rotY": 180 }, "ease": "linear" }] },
        { "id": "saturn", "parent": "o-saturn", "geometry": { "type": "sphere", "radius": 0.52, "segments": 32 },
          "transform": { "position": [11.8, 0, 0] }, "material": { "color": "#D6C08A", "body": false, "roughness": 0.85 } },
        { "id": "saturn-ring", "parent": "saturn", "geometry": { "type": "ring", "innerRadius": 0.72, "outerRadius": 1.3 },
          "transform": { "rotation": [-75, 0, 0] },
          "material": { "color": "#CBB489", "side": "double", "opacity": 0.55, "roughness": 0.9 } },

        { "id": "o-uranus", "geometry": { "type": "dashRing", "radius": 13.6, "count": 130, "duty": 0.34 },
          "material": { "color": "accent", "opacity": 0.16 },
          "anim": [{ "at": [0, 359], "to": { "rotY": 120 }, "ease": "linear" }] },
        { "id": "uranus", "parent": "o-uranus", "geometry": { "type": "sphere", "radius": 0.36, "segments": 24 },
          "transform": { "position": [13.6, 0, 0] }, "material": { "color": "#8FC6CE", "body": false, "roughness": 0.8 } },

        { "id": "o-neptune", "geometry": { "type": "dashRing", "radius": 15.2, "count": 140, "duty": 0.34 },
          "material": { "color": "accent", "opacity": 0.16 },
          "anim": [{ "at": [0, 359], "to": { "rotY": 90 }, "ease": "linear" }] },
        { "id": "neptune", "parent": "o-neptune", "geometry": { "type": "sphere", "radius": 0.34, "segments": 24 },
          "transform": { "position": [15.2, 0, 0] }, "material": { "color": "#3B62B0", "body": false, "roughness": 0.8 } }
      ],
      "lights": [
        { "type": "ambient", "color": "#26344d", "intensity": 0.18 },
        { "type": "point", "position": [0, 0, 0], "color": "#FFF1D6", "intensity": 6, "decay": 0 }
      ],
      "particles": { "count": 3000, "spread": [70, 50, 70], "size": 0.16, "color": "#FFFFFF", "drift": 0.04, "opacity": 0.85 },
      "post": { "bloom": 1.3 }
    }
  }
}
```

转一圈的帧数 = 幕长。行星角速度按 `to.rotY` 递减就是"由内向外越来越慢"，不必算真实开普勒值。
**别用真实比例**：太阳直径是地球的 109 倍，真按比例地球在画面里就是一个像素——半径按"看得清"排（上面 0.17→0.62），文案或字幕里再说明"尺寸未按比例"。

---

## 五、改已经建好的 3D 幕

**改一个节点用 `update_graph_node`，不要重发整张图。**

```
get_graph(sceneId)                                     # 先看节点 id / 形状 / 颜色 / 父级（很省 token）
update_graph_node(sceneId, "earth", {geometry:{radius:0.55}})   # 只改半径：segments 等其余参数原样保留
update_graph_node(sceneId, "earth", {material:{color:"accent"}})
update_graph_node(sceneId, "earth", {transform:{position:[4,0,0]}})
update_graph_node(sceneId, "moon",  {parent:"earth"})   # 换父级，**世界位置不跳**
add_graph_node(sceneId, {id:"moon", geometry:{type:"sphere",radius:0.15}, parent:"earth"})
remove_graph_node(sceneId, "moon")                      # 默认连子节点一起删
set_graph_scene(sceneId, {camera:{fov:50}, lights:[…], particles:{count:1200}, post:{bloom:1.4}})
```

合并语义（照"改一个控件"的直觉定的）：

| 字段 | 语义 |
|---|---|
| `geometry` | 同 type **深合并**（改半径不动 `segments`）；`type` 变了则整份重来 |
| `material` / `transform` | 深合并；`map:null` / `scaleXYZ:null` / `emissive:null` = 清掉这一项 |
| `anim` | 整表替换；`null` 清空 |
| `label` / `hidden` / `locked` | 直接设；`label:null` 清掉显示名 |
| `parent` | 换父级并保持世界变换；父级链上有关键帧时只对齐基础变换（回执会警告） |

**为什么不能整份覆盖**：人在编辑器右栏里改的就是这批 op。你 `update_scene` 传一份完整 `graph`，
会把他刚拖好的位置/颜色一起抹掉，而他那边没有任何提示。整份替换只留给"整幕推倒重建"，
且重建前先 `get_graph` 拿当前状态再改。

**别用"删了重建"来迭代**：每次 remove + add 都涨 rev、分镜表里的 sceneId 会失联，上一轮调好的节点也白调了。

---

## 六、世界背景与运镜（相机怎么动才不抖）

这一章只解决两件事：背景别像黑棚，镜头别又平又抖。**每条都是实跑撞出来的，不是理论。**

### 6.1 背景先选模式，再谈参数

| 画面里有没有"地平线" | 用什么 | 一句话 |
|---|---|---|
| 没有（太空、宇宙、悬浮几何） | `mode:"space"` | 唯一正确选择，见 6.2 |
| 有真实环境（室内、街道、产品台） | `mode:"image"` + `imageLighting:true` | 优先 `.hdr`；夜景/室内把 `envIntensity` 压到 0.2–0.4 |
| 有抽象地平线（科技感、速度感） | `mode:"gradient"` | 两端都低饱和，`glow` ≤ 0.5，彩色天空一眼假 |
| 什么都没有（剪影、极简） | `mode:"color"` | 配 `vignette` 收边，否则是一块死板色 |

**主体出问题的顺序永远是：先调世界，再调灯，最后才动 exposure。**
主体偏暗 → 降 `imageIntensity`；主体边缘融进背景 → 加 `haze`（0.15–0.35）；星点抢主体 → 降 `stars` / 提 `vignette`。
曝光一降，辛苦打的灯全没了。

### 6.2 深空的四条硬规矩

```json
"world": { "mode": "space", "stars": 1, "milkyWay": 0.45, "nebula": 0.35, "haze": 0, "vignette": 0.42 }
```

1. **`haze` 必须 0**。雾不是把深空洗灰，是把星点一层层吃掉，远处银河整条消失。
2. **星点的光晕全靠 bloom**。太阳这种纯 emissive 球要 `post.bloom ≥ 1.6`、`threshold 0.7+`；
   阈值降到 0.5 以下，行星亮面会一起糊成一团白。
3. **`milkyWay` 0.2–0.5**。超过 0.6 就不再是银河，是一条彩色光柱（真实银河的亮度比大多数人的直觉低得多）。
4. **深空别开 `ground`**。自动地面会按"最低的实体节点"算出一条地平线 —— 太空中出现地平线，比没有背景更假。

### 6.3 这台相机到底是什么（不搞清这个，后面全是玄学）

**相机钉在 +Z，内容整体搬运。** 所以：

- `camPos = [0, 0, |P−T|]` —— **相机距离就是 P 到 T 的距离**，这是所有"镜头突然跳一下"的根源：
  `target` 一换节点，距离立刻变，画面像被猛推了一下。
- 你在 `anim` 里写的是**世界坐标**的 P（机位）和 T（看向点），不是"推拉摇移"四个抽象量。

选型：

| 要拍什么 | 写法 | 代价 |
|---|---|---|
| 主体不动 | `anim` 关键帧（绝对坐标） | 最好写，优先用 |
| 主体在动（公转、漂浮） | `follow` + `lookAt` | 每帧精确，**动的东西必须这样写** |
| 整幕缓慢环绕一个点 | `camera.orbit.degPerSec` | 最便宜，但只绕 target |
| 一个长镜头连拍多个主体 | 逐帧烘焙 + `curve` | 工作量大，见 6.5 |

### 6.4 五条不可违反的约束

1. **距离不能塌。** 视线角速度 = `|P′−T′| / |P−T|`。分母趋零时，一点点横向速度就是几百度/秒的甩镜。
   换主体之前**先退远**（offset 拉大），绝不在贴近时横移。
2. **会动的目标不要用绝对坐标。** 行星走弧、相机走弦，几帧后主体就滑出画面。用 `follow` / `lookAt`。
3. **看向点要单独给切线。** `curve.out/in` 会**同时**作用到机位和看向点，两条曲线的切线对不上 →
   段边界折角 → 播放时"一抖一抖"。必须写 `targetOut` / `targetIn`。
4. **任何混合量的窗函数，两端导数必须为 0。** `smoothstep`、`sin²(πu)` 可以；`sin(πu)` 不行
   （末端导数 −π，接缝速度硬拐）。加"额外抬升/偏移"时也要乘一个两端导数为 0 的窗。
5. **关键帧密度服从加速度。** `anim` 上限 240 段。等距分配在"速度突变"处必然过冲 ——
   三次曲线表示不了"一段之内速度翻 30 倍"，只能先往回甩再冲出去（就是轨迹上的尖角）。
   按逐帧加速度累计量分配：快的段 2–4 帧，慢的段 20+ 帧。

### 6.5 一段能用的运镜烘焙流程（demo3d 就是这么做的）

1. **位置从节点读，别手抄坐标**：`worldPointOf(nodeId, frame)`。
2. **机位写成"随动系"**：`offset = d · (径向·cosφ + 侧向·sinφ)`，再按 `el` 抬仰角。
   行星公转多少，机位跟着转多少 —— 相机和天体走同一条弧，主体稳、背景流。
   - `φ` 就是**受光相位**：`phase = 180 − φ`。实用区间 25°–150°：小于 25° 是死白的圆盘（没立体感），
     大于 150° 只剩剪影（看不清）。
   - 构图：`fill` = 天体直径 / 画幅高，`d = r / tan(fill · fov/2)`。`fill` 在 0.12–0.7 之间取值，
     别每颗都给 0.4（那就成了"目录照"）。
3. **换主体时，焦点走极坐标弧**（`r`、`θ` 各自 Hermite，端点角速度 = 行星真实角速度）。
   **不要走弦**：弦会穿过太阳，而且半径、角度的变化都不连续。
4. **看向方向按单位向量 slerp**（角速度均匀、可控），距离单独插值，最后 `T = P + D·dist`。
5. **烘焙切线**：机位和看向点各自用"解析函数的中心差分"，相邻段在共享锚点上算出同一个数 → C1 连续。
6. **自检（必做，别靠肉眼）**：

```js
// 逐帧量三个东西
∠(视线[f], 视线[f+1])        // > 3°/帧（90°/s）= 甩镜，过渡要加长
∠(ΔP[f], ΔP[f+1])            // > 30°/帧 = 轨迹有折角
min |P|                      // < 太阳半径+2 = 穿星
```

参考实现：`scripts/bake-demo3d-camera.mts`（改 `BEATS` 就能重排分镜，自动同步种子）。

### 6.6 分镜节奏（八颗行星 72 秒的经验值）

| 段落 | 时长 | 备注 |
|---|---|---|
| 开场全景 | 2–3s | 交代尺度，太阳占 25–35% 画幅 |
| 单颗行星 | 3–5s | 少于 2.5s 观众记不住 |
| 主角 | 8–12s | 只有一颗给最长 |
| 过渡 | 2–3s | 少于 1.5s = 甩镜；超过 4s = 空镜 |
| 收尾 | 5–7s | 升起来 + 拉开，最后一个动作最大 |

**"单调"比"不好看"更致命。** 连着两颗用同样的运动方式，观众立刻觉得平。
可以换的维度：画幅占比（0.12–0.7）、仰角（−18°–+26°）、受光相位、运动方向（推 / 拉 / 掠过）。
掠过式（推到近景再退回来）靠 `fill` 给三个值：`[0.16, 0.6, 0.24]`。

### 6.7 症状 → 对症

| 症状 | 真正的原因 | 改法 |
|---|---|---|
| 定位到主体时抖一下 | 换 target 让机位到看向点的距离跳了；或焦点的 y 写死成 0（轨道有倾角时行星不在 y=0） | 换目标前先退远；高度跟着真实位置插值 |
| 轨迹是一段段直线 | 段太长 + 切线取了"弦方向" | 加 `curve`；切线用真实速度 |
| 播放每 0.3 秒抖一下 | 看向点套用了位置曲线 | 写 `targetOut` / `targetIn` |
| 甩镜、头晕 | 角速度 > 3°/帧 | 加长过渡，或先退远再转 |
| 主体偏在画面一侧 | 平滑的是**绝对位置**（相机落在几帧前的位置上） | 平滑**相对主体的偏移** `pos − target` |
| 相机穿进太阳/行星 | 过渡走弦；远景距离超过轨道半径 | 焦点走极坐标弧；远景距离 ≤ 轨道半径 55% |
| 画面里两颗行星一样大、分不清 | 机位方向正好撞上另一颗 | 方位角在 ±30°/±60° 里挑，按"天体张角"打分 |
| 整片平、没气势 | 每颗的尺寸/角度/运动方式都一样 | 按 6.6 换维度，至少三项不同 |

---

## 七、坑（都在实跑撞过）

1. **`graph` 一给，`preset` / `spin` / `count` / `hue` 全部失效**——不是"没生效"，是设计如此。想回到预设：`update_scene(props:{graph:null})`。
2. **`look` 留 `auto` 会按 `preset` 取值**（默认 blank → cyber 的冷色辉光基准）。想要暖调/暗调就显式写 `look`。
3. **`body` 默认 `true`，会降饱和 + 压暗**。真实星球色、纯色剪影必须 `body:false`，否则"地球是脏灰蓝"。
4. **中文不进 3D**。3D 里没有文字能力，`title` / `sub` 是 2D 叠层；行星名字标签只能另建一幕 2D（freeform），或者在字幕里念。
5. **多面体不能贴图**（UV 是碎面，服务端会硬报错）。要低多边形地球：`sphere` + `flatShading:true` + 低 `segments`。
6. **`plane` / `ring` 默认只朝 +Z**，转成朝下会整片消失。地面光斑、贴地标线、土星环都要 `side:"double"`。
7. **`dashRing.width` 不生效**（线宽固定 1px）。它跨几十单位也不会消失，这正是画轨道的理由；想要粗环用 `torus`。
8. **点光按 1/距离² 衰减**。太阳在原点、行星在 15 单位外，`decay:2` 会全黑——`decay:0`（不衰减）或者把 `intensity` 抬到 20 以上。
9. **动画区间不覆盖整幕 = 末端跳回基础值**。整幕旋转就写 `at:[0, 幕帧数-1]`。
10. **只有 `from` 没有 `to` 的段不会生效**，服务端会点名，别以为是缓动问题。
11. **颜色写语义名才能跟风格联动**（`primary` / `accent` / `secondary` / `text` / `muted`）。写死 `#RRGGBB` 之后换风格这幕不跟着变——真实物体（星球、木料、金属）该写死就写死，UI/HUD 类元素用语义名。
12. **3D 渲染慢**：单幕控制在 6–12 秒，别一上来就 `render_video`。先 `preview_frames` 抽 2–3 帧（起点/中段/结尾）看构图，再 `render_preview_clip` 看运动。
13. **没有 GPU 的环境会降级**（WebGL 不可用时后处理走 CSS 兜底，观感差一档）。抽帧发现辉光糊、边缘脏，先怀疑这个。
14. **改了 `transform` 但画面没动**：该节点有关键帧，区间内基础变换被关键帧覆盖（回执会警告）。要么改 `anim`，要么清空关键帧。
15. **`hidden:true` 会连子节点一起不渲染**（星空挡视线时藏它，但藏太阳连地球也没了）。它只是编辑器/数据层的开关，渲染直接跳过，适合"这一版先不要这个物体"。

---

## 八、建完必看

- [ ] 抽 2–3 帧：主体在画面里、没出框、没被 `title` 压住
- [ ] 关键动作那几帧位置**确实变了**（公转/拆解）——静帧看不出动，别只抽首帧
- [ ] 明暗面对不对（有 `lights` 时才有"朝向光源亮"）
- [ ] 没有纯黑区域（背光面留一点 `ambient`，全黑会被当成渲染失败）
- [ ] `graph` 里的节点总数 ≤ 48，动画段 ≤ 8/节点
- [ ] 运镜自检过：单帧转角 < 30°、峰值角速度 < 3°/帧、相机没穿进太阳
- [ ] 每颗主体至少有一项和上一颗不同（尺寸 / 仰角 / 受光 / 运动方向）
