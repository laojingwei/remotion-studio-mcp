# 3D 场景（scene3d）

真 3D：three.js 渲染，几何体 + 光照 + 相机运动。做 2D 给不了的空间感——行星公转、装置拆解、分子结构、球面网络。

**两条路，先选对**：

| 你想要 | 走哪条 |
|---|---|
| 抽象氛围：一个核心 + 卫星绕、粒子星云、网格地平线、波形柱阵 | **预设**：只传 `preset` / `look` / `spin` / `count`，一行搞定 |
| 具体的东西：太阳系、分子、机器零件、产品结构、任何"要像那个东西" | **场景图 `graph`**：自己写节点树 |

预设是六套**成品镜头**，不是模型库——它变不出"八大行星"。要具体物体只能写 `graph`。
给 `graph` 之后 `preset` / `spin` / `count` / `hue` 全部失效（见文末坑 1）。

---

## 一、预设模式

```json
{ "type": "scene3d", "props": { "preset": "orbit-core", "look": "cyber", "spin": 14, "count": 5,
  "title": "一个核心，五个方向", "sub": "" } }
```

| `preset` | 画面 | `spin` 是什么 | `count` 是什么 |
|---|---|---|---|
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
| `anim[]` | 运镜关键帧：`{at,from,to,ease,follow}`，键是 `posX posY posZ targetX targetY targetZ fov` |
| `anim[].follow` | 钉在某个节点上：本段 pos/target 变成**相对该节点的偏移**——拍公转中的行星必须用它，否则几帧后主体就跑出画 |

`anim` 同 key 的多段必须首尾相接、不重叠（边界帧 `end = 下一段 start − 1`）。

### nodes

| 字段 | 说明 |
|---|---|
| `id` | 场景内唯一。子节点用 `parent` 引用它 |
| `parent` | 父节点 id。**子节点挂在父节点下，父节点的位移/旋转/缩放会带着子节点一起动**（做公转、卫星、机械臂全靠它） |
| `geometry` | 见下表（必填） |
| `material` | 不写就是一层中性暗金属 |
| `transform.position / rotation / scale / scaleXYZ` | 基础变换，`rotation` 是**度** |
| `anim[]` | 关键帧，最多 8 段 |

### 几何体白名单（13 种，写错 type 会直接报可用值）

| type | 字段（都有默认值） |
|---|---|
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

⚠️ **给了 `lights`，`look` 的四盏方向光全部撤掉**，只剩一点环境底光，这一场的明暗完全由你给的灯决定。
这就是「太阳照亮地球」的正确做法：**point 光放在太阳位置**，行星转到哪儿就照到哪儿，明暗面永远对着太阳。

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

`update_scene(sceneId, props:{graph})` 就是**整份替换**——`nodes` 是数组，传新数组等于全换，不会按 id 合并。
只是想改一颗行星的半径，也要把完整 graph 再传一遍。

**别用"删了重建"来迭代**：每次 remove + add 都涨 rev、都会让分镜表里的 sceneId 失联，还会丢掉你上一轮已经调好的其他节点。
真要小改就 `update_scene` 传完整 graph；要大改才重建。

---

## 六、坑（都在实跑撞过）

1. **`graph` 一给，`preset` / `spin` / `count` / `hue` 全部失效**——不是"没生效"，是设计如此。想回到预设：`update_scene(props:{graph:null})`。
2. **`look` 留 `auto` 会按 `preset` 取值**，而给 graph 时 preset 仍是默认的 `orbit-core` → 实际用的是 `cyber` 的冷色辉光基准。想要暖调/暗调就显式写 `look`。
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

---

## 七、建完必看

- [ ] 抽 2–3 帧：主体在画面里、没出框、没被 `title` 压住
- [ ] 关键动作那几帧位置**确实变了**（公转/拆解）——静帧看不出动，别只抽首帧
- [ ] 明暗面对不对（有 `lights` 时才有"朝向光源亮"）
- [ ] 没有纯黑区域（背光面留一点 `ambient`，全黑会被当成渲染失败）
- [ ] `graph` 里的节点总数 ≤ 48，动画段 ≤ 8/节点
