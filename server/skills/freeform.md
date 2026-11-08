# 自由画布（freeform）

内置固定版式是"快速版式"，而且**默认不对 agent 开放**（`list_scene_types` 里看不到它们，用户点名时才能用）；想要独特画面时，用 `freeform` **自己排版**——写数据，不写代码。这也是默认清单里最该先考虑的类型。

```json
{
  "op": "add_scene", "type": "freeform", "durationInFrames": 150,
  "props": {
    "background": { "kind": "glow", "colors": ["#05060A", "#1B3A6B"], "blur": 70 },
    "elements": [
      { "type": "text", "text": "好片子\n不是渲出来的", "x": 50, "y": 40, "size": 11,
        "fill": "#F5F5F7", "weight": 800, "lineHeight": 1.15,
        "anim": [{ "at": [0, 18], "from": { "opacity": 0, "y": 48 }, "to": { "opacity": 1, "y": 40 }, "ease": "spring" }] },
      { "type": "shape", "shape": "line", "x": 50, "y": 60, "size": 28, "fill": "#5AC8FA",
        "anim": [{ "at": [12, 36], "from": { "scale": 0 }, "to": { "scale": 1 }, "ease": "easeInOut" }] },
      { "type": "fx", "kind": "stars", "x": 50, "y": 50, "size": 110, "density": 50, "color": "#9FD8FF" }
    ]
  }
}
```

## 背景 `background`

| 字段 | 说明 |
|---|---|
| `kind` | `solid` / `gradient` / `glow` / `grid` / `noise` / `image` |
| `colors` | solid: `[底]`；gradient: `[起, 止]`；glow: `[底, 光]` |
| `image` | kind=image 时的素材（`/assets/xxx` 或 URL） |
| `blur` | glow 的柔光模糊（默认 40） |
| `opacity` | 背景整体透明度 |

## 元素（`elements[]`）

通用字段：

| 字段 | 说明 |
|---|---|
| `type` | `text` / `shape` / `image` / `video` / `svg` / `fx` |
| `x` `y` | 中心位置（画面百分比） |
| `size` | 短边百分比：文字=字号，形状/图片=宽度 |
| `rotate` `scale` `opacity` | 旋转 / 缩放 / 透明度 |
| `radius` | 圆角（短边百分比） |
| `style` | 任意内联 CSS（camelCase），最后应用 |
| `from` `durationInFrames` | 场景内出现时段 |

类型专用：

- `text`：`text`（支持 `\n`）、`fontFamily`、`weight`、`lineHeight`、`letterSpacing`、`textAlign`、`maxWidth`（短边%）、`fill`
- `shape`：`shape`（rect/circle/line/triangle）、`fill`
  **线宽用 `strokeWidth`（短边百分比），不要靠 size 猜**：不传时粗细 = 高度的 3%（约 19px），
  想细就显式 `strokeWidth:0.15`（≈1.6px）；`size` 只管线有多长
- `image`/`video`：`src`（先 upload_asset）
- `svg`：`svg` + `viewBox` + `fill`/`stroke`/`strokeWidth`。
  **半透明两种写法都行**：元素级 `opacity:0.22` 会乘进 fill/stroke 的 alpha；也可直接写 `fill:"rgba(90,200,250,0.22)"`。
  **⚠️ 内容里别再写 `fill`**：外层 `fill` 只是「继承值」，svg 内容自带的 `fill="#xxx"` 会盖掉它——
  这时改外层 `fill` 完全没反应（像 bug，其实是继承被覆盖）。要能改色就写 `<circle cx="12" cy="12" r="10"/>`，
  颜色交给外层 `fill`；确实要写死颜色的，透明度就只能靠元素级 `opacity`。
  **⚠️ 改 svg 时必须同时传 viewBox**：默认 `0 0 24 24`，内容不是 24×24 图标就会被压成一个看不见的点，而且不报错
- `fx`：`kind`（glow/grid/noise/particles/stars/scanlines/rings/beam/dust/wave/meteor）、`color`、`density`、`speed`。
  **fx 容器是 `size`×短边 的正方形**：要铺满 16:9 全屏请 `size ≥ 200`，否则四周露硬边。
  `noise` 默认已是细腻颗粒（想更浓直接调元素 `opacity`，1 = 最浓）。
  **`stars` 的点径用 `dotSize`（元素宽度的百分比，默认 1.2）**：它不随 `size` 放大——
  铺满全屏（`size:210`）时默认仍是小星点；`size` 只决定星星撒开多大范围

### 背景色 / 边框（不用写内联 CSS）

- `bg`：元素背景色（CSS 色值/渐变）
- `border`：边框宽度（短边百分比）、`borderColor`：边框颜色

### 元素增删与局部更新（重要）

给元素加 `id`，之后可以**只操作一个元素**，不用重发整个 elements 数组：

- `add_freeform_element(sceneId, element)`：追加一个元素（返回分配的 id，如 `f5`）。
  **svg 图形、fx 氛围层、带 anim 关键帧的元素只能走这里**——`add_element` 的叠加层通道不支持这些
- `update_freeform_element(sceneId, elementId, patch)`：只改一个元素，patch 不认识的字段会直接报错
- `remove_freeform_element(sceneId, elementId)`：删一个（至少要保留一个元素）

```json
{ "type": "shape", "id": "card-01", "shape": "rect", "bg": "#0A0A0A", "size": 12, "x": 20, "y": 40 }
```

```json
update_freeform_element(sceneId, elementId="card-01", patch={ "bg": "#FFFFFF", "border": 0.3 })
```

没有 id 时也可以 `index`（从 0 开始）定位。

### 两套元素通道，别混

| | 叠加层 `add_element`（scene.elements） | freeform（`add_freeform_element`，props.elements） |
|---|---|---|
| 关键帧 `anim` | ❌（塞了会被丢弃并在 summary 警告） | ✅ |
| 出入场 `enter`/`exit` | ✅ | ❌（用 anim 自己写） |
| `fx` 氛围层 | ❌ | ✅ |

同一元素上不可能同时有 `exit` 和 `anim`——它们属于两套通道。

### 大 SVG：写文件再引用（`svgSrcFile`）

手绘白板/复杂插画的 SVG 路径动辄几千字符——**不要内联进工具调用**（受单轮输出限制且极易抄错），
也不要指望自己读全文再拼（Read 对单行 >2000 字符会截断，6k 的 path 你根本读不全）。正确姿势：

1. **脚本把 SVG 落盘**（Windows 路径写 `D:/…`；Python 里同样用 `D:/`，别写 Git Bash 的 `/d/…`，那会被当成相对路径写去别处）
2. 元素里只给路径：

```json
{ "type": "svg", "svgSrcFile": "D:/tmp/s1.svg", "viewBox": "0 0 1920 1080", "x": 50, "y": 50, "size": 60 }
```

服务端在写库前读文件注入 `svg` 并剥掉路径键——落盘的工程里只有解析后的内容，不落盘路径。
3. 回执 summary 会确认「已从文件注入 svg：s1.svg（6423 字符）」，看到这行就不用再 get_project 反查。

护栏：只收 `.svg` / `.txt`、≤200KB、必须绝对路径；元素同时带内联 `svg` 和 `svgSrcFile` 会报错（意图不明）。
文件内容会进工程并被渲染，别指向敏感文件。第 3 幕那种 38k 的例子墙先降点密度再引用——200KB 上限是防误指，不是让你贴着用。

## 关键帧动画 `anim[]`

```json
// 元素本体 y=40，想让它从下方 48 滑到 40
{ "at": [0, 20], "from": { "opacity": 0, "y": 48 }, "to": { "opacity": 1, "y": 40 }, "ease": "spring" }
```

- `at`：起止帧（场景内）
- 可动画属性：`x` / `y` / `size` / `rotate` / `scale` / `opacity`
- `ease`：`linear` / `easeInOut` / `spring`
- 多个 `anim` 可以叠加（不同时间段做不同动作）

**⚠️ `from` / `to` 里的 x/y/rotate/scale 是绝对值，不是偏移量。**
写 `"to": { "y": 40 }` 就是"最后停在画面 40% 高度"，`"y": 8` 是"停在 8%"（几乎贴顶），不是"往上 8%"。
想从下方滑入就写 `from: { y: 元素 y + 8 }`、`to: { y: 元素 y }`。
**`to` 必须等于元素本体的 x/y**，否则动画窗口结束的那一帧会"啪"地跳回本体位置。
只做淡入时不要写 y：`{ "at": [0, 14], "from": { "opacity": 0 }, "to": { "opacity": 1 } }`。

## 竖屏排版经验值（1080×1920）

| 元素 | 建议 size（短边%） | 备注 |
|---|---|---|
| 超大标题（1–2 行） | 10–12 | 一行 ≤ 6 字；两行时给 `maxWidth: 80` 避免自动折行 |
| 章节标题 | 6–7 | |
| 正文/说明 | 3.4–4.6 | 一段 ≤ 16 字，超了主动换行 |
| 小标签/角标 | 2.6–3.2 | |
| 数字编号（01/02/03） | 11–13 | 等宽数字 |

留白：内容不要顶到边，左右留 ≥8%；标题区在 y 25–55，底部 12% 留给字幕。
折行问题：竖屏加粗大标题容易折行——**先定 maxWidth（60–85）再调 size**，比反复试 size 稳。

## 规则

- 元素 ≤ 40 个；`fx` 的 `density` ≤ 60（性能）
- 一切由帧决定：不要指望"随机"或"按时间流动"（解释器是确定性的）
- 大 `blur` 不要叠太多层（渲染会慢）
- 改完用 `preview_frames` 抽帧看：文字是否压到边缘、元素是否互相遮挡

## 什么时候用

- 第 4 步问诊里的 `layoutMode` 决定版式体系：**内置场景**（快）/ **自由画布**（独特）/ **混合**


- 内置版式"不够独特"或"文案塞不进模板"时
- 需要光效/氛围/巨字排版/自定义构图时
- 仍然可以用 `empty` 场景 + 自由元素层（那是"叠加层"，自由画布是"场景内的完整构图"）

### 尺寸怎么换算（全部以**短边**为 1）

| 你想画 | 怎么写 | 换算 |
|---|---|---|
| 一条横线，长度 = 屏幕宽 60% | `shape:"line", width:60, height:0, strokeWidth:0.2` | `width` 是短边%；线宽用 `strokeWidth` |
| 一个 3:2 矩形 | `shape:"rect", width:40, height:26.7` | 高度 = 宽度 × (2/3) × (短边/长边) 的比例自己算 |
| 贴在上一个元素右侧 2% | `x: 上一个.x + 上一个.width/2 + 2` | 全部是短边百分比，可直接加减 |
| svg 图标 24×24 想显示成 8% | `size:8, viewBox:"0 0 24 24"` | viewBox 与 size 无关，改 viewBox 不改大小 |
| 元素左边缘对齐 x=10% | `anchor:"left", x:10` | 默认 anchor:center（x 是中心） |

> 竖屏 1080×1920：1 单位 = 10.8px；横屏 1920×1080：1 单位 = 10.8px（短边都是 1080）。
