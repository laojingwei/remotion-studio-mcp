# 插件开发指南（PLUGIN-GUIDE）

> 目标读者：想给 Remotion Studio 写插件的开发者（或 agent）。
> 本文档自包含：**不需要读宿主源码**就能写出一个合规的插件。
> 示例索引见 §13；格式速查见 §14。宿主插件 API 版本：**v1**（`PLUGIN_API_VERSION = 1`）。

---

## 目录

1. [插件是什么、放哪里](#1-插件是什么放哪里)
2. [五分钟做出第一个插件](#2-五分钟做出第一个插件)
3. [发现规则：id、启用状态、热更新](#3-发现规则id启用状态热更新)
4. [manifest.json 与 package.json](#4-manifestjson-与-packagejson)
5. [内容贡献项（不写代码的插件）](#5-内容贡献项不写代码的插件)
6. [代码插件：入口与加载模式](#6-代码插件入口与加载模式)
7. [流程钩子（audit:rules / ops:before / ops:review / brief:derive）](#7-流程钩子)
8. [文本处理（text:transform）](#8-文本处理texttransform)
9. [文件处理（media:process）](#9-文件处理mediaprocess)
10. [工具插件（给 agent 加 MCP 工具）](#10-工具插件)
11. [语音合成 provider（ttsProviders）](#11-语音合成-providerttsproviders)
12. [场景组件（scenes/）](#12-场景组件scenes)
13. [自带界面（ui/）](#13-自带界面ui)
14. [安装、分发与工程化插件](#14-安装分发与工程化插件)
15. [排障与错误行为对照表](#15-排障与错误行为对照表)
16. [发布前自检清单](#16-发布前自检清单)
17. [示例插件索引](#17-示例插件索引)
18. [格式速查表](#18-格式速查表)

---

## 1. 插件是什么、放哪里

插件就是一个文件夹，放在**唯一的**插件目录里：

```
<安装目录>/plugins/<你的插件名>/
```

- **放进去即生效，删掉即消失，不用重启。** 宿主每次请求都重新扫描目录（刻意不缓存），这是热更新的实现方式。
- 插件目录本身不入库（`.gitignore` 已排除），你的东西不会被 `git pull` 覆盖。
- 所有工程共用同一份安装的 `plugins/`（它是"安装级"目录，不是某个工程私有的）。
- 目录名可以用中文——宿主会把它归一化成合法 id（见 §3）；但**建议直接用小写英文短横线**，`list_plugins` 里的 id 会更好看、更稳定。
- `_example-*` 开头的是仓库自带示例，全新环境首次启动时会被自动停用（避免混进真实项目），想看在编辑器「插件」面板一键启用。
- 隐藏目录（`.` 开头）和 `node_modules` 会被扫描跳过。

一个插件可以同时提供多种东西（技能 + 风格 + 钩子 + 工具……），按目录结构摆文件即可，全部可叠加。

### 插件能提供什么（总表）

| 你想加什么 | 放哪里 | 生效方式 | agent/用户从哪用到 |
|---|---|---|---|
| 技能指南 | `skills/*.md` | 即时 | `list_guides` / `get_guide` |
| 风格规则 | `styles/*.md` | 即时 | `list_styles` / `get_style` / `apply_style` |
| 风格预设 | `styles/presets.json` | 即时 | `apply_style` 一键落字段 |
| 问诊步骤 | `brief/steps.json` | 即时 | `intake` / `save_brief` |
| 整片模板 | `templates/*.json` | 即时 | 模板市场 / `create_from_template` |
| 元素素材 | `elements/*.json` | 需重新打包 | 元素面板 / `list_element_library` |
| 3D 天空配方 | `scene3d/skies.json` | 即时 | `list_world_skies` / `set_graph_scene { worldPreset }` |
| 3D 光线风格 | `scene3d/looks.json` | 需重新打包 | 3D 场景 `look` 下拉 |
| 3D 图形配方 | `scene3d/presets.json` | 即时 | `list_graph_presets` / `set_graph_scene { graphPreset }` |
| 3D 后期效果 | `scene3d/passes.json` | 需重新打包 | `list_plugin_passes`，写进 `post.passes` 才上镜 |
| 转场 | `transitions/<id>.ts` | 需重新打包 | 转场下拉 |
| 流程钩子 | `plugin.ts`（或工程入口） | 即时 | 自检/写入/设计锁时自动触发 |
| 文本处理 | `plugin.ts` | 即时 | `set_subtitle` / `save_script` 前自动过链 |
| 文件处理 | `plugin.ts` | 即时 | 新上传素材自动过链；`reprocess_assets` 补历史 |
| MCP 工具 | `plugin.ts` | 即时 | `tool_search` / `tool_call` |
| 语音 provider | `plugin.ts` | 即时 | `list_tts_providers` / `set_tts_config` / `tts_synthesize` |
| 场景组件 | `scenes/<type>.json` + 同名 `.tsx` | 需重新打包 | 场景选择器 |
| 自带界面 | `ui/index.html` | 即时（改完刷新浮窗） | 「插件」对话框的「打开界面」按钮 |

"需重新打包"的项（元素/looks/passes/转场/场景组件）由服务端在检测到变化后自动生成代码并重打渲染 bundle（几十秒），编辑器侧则要等一次 `npm run build` 或重启 `npm start`（详见 §12 结尾的说明）。

---

## 2. 五分钟做出第一个插件

**加一份风格规则**（最短路径）：

```
plugins/我的风格/
  styles/neo-noir.md      ← 随便起名的 .md
```

md 里写清风格规则（配色、字体气质、转场偏好、禁忌）。保存，`list_styles` 里立刻能看到。

**加一份技能指南**：

```
plugins/我的玩法/
  skills/how-to-intro.md
```

**加一条画质守门规则**（钩子）：看 §7，把 `plugins/_example-audit/plugin.ts.example` 改名成 `plugin.ts` 就是一个能跑的最小样板。

**不需要 manifest.json。** 宿主按目录结构推断你提供了什么（`skills/` 里有 `.md` 就是技能、`scene3d/skies.json` 存在就是 3D 天空……）。只有当你需要声明权限（§10）或版本信息时才写 manifest。

---

## 3. 发现规则：id、启用状态、热更新

### 3.1 id

- 默认 id = 目录名归一化：转小写、非 `[a-z0-9-]` 字符替换为 `-`、去首尾 `-`。
- **纯中文/非 ASCII 目录名**归一化后会得到空串，宿主用 FNV-1a 短哈希兜底生成 `p<base36>` 形态的 id。稳定（同一目录永远同一 id），但不可读——所以再强调一次：目录名用英文。
- manifest 里写了 `id` 就以 manifest 为准；两个插件 id 撞车时，先扫到的加载，后扫到的被标"加载失败：id 冲突"。

### 3.2 启用状态

- **黑名单机制**：新插件默认启用；停用列表存在 `data/plugins.json` 的 `disabled` 数组里。
- 停用只记 id，**文件不动**；重新启用立刻全部恢复。
- 停用一个插件会同时撤掉它提供的所有东西（技能、风格、钩子、工具……），不会出现"风格没了技能还在"。

### 3.3 热更新语义

| 你做了什么 | 生效时机 |
|---|---|
| 新建/修改/删除 `skills` `styles` `brief` `templates` `scene3d/skies.json` `scene3d/presets.json` | 下一次相关请求（即时） |
| 修改 `plugin.ts`（钩子/工具/TTS/处理链） | 即时：宿主按入口**及其同目录源码**（script 模式扫两层，改 helper 也算）的指纹变化重新加载模块 |
| 新装/修改场景组件、元素、looks、passes、转场 | 服务端渲染前自动重新生成入口并重打包；编辑器侧要等一次构建（§12） |
| 停用/启用插件 | 即时 |

**工程化插件的注意点**：宿主盯的是**构建产物**（`dist/`），不是你的 `src/`。改了源码必须重新 `npm run build`（或在面板点「重建」），否则指纹不变、不会重载。

---

## 4. manifest.json 与 package.json

两种清单任选其一，**都不写也能用**（按目录推断）。需要声明版本/权限/描述时再写。

### 4.1 manifest.json（推荐给单文件插件）

```json
{
  "id": "my-brand-guard",
  "name": "品牌口径守门员",
  "version": "1.0.0",
  "apiVersion": 1,
  "description": "强制品牌词表与语气禁区",
  "author": "your-team",
  "provides": ["hooks"],
  "permissions": ["project:read"]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 否 | 缺省用目录名。小写字母/数字/短横线，**不能改**（改了等于换了插件，启用状态丢失） |
| `name` | 否 | 展示名，缺省用 id |
| `version` | 否 | 缺省 `0.0.0`。建议给，`list_plugins` 显示且用于升级判断 |
| `apiVersion` | 否 | 插件针对的宿主 API 版本。**高于宿主 = 拒绝加载**（致命错误）；低于 = 警告。当前为 1 |
| `provides` | 否 | 声明贡献项白名单。可写值（13 项，当前**全部已接通**）：`skill` / `style` / `template` / `elements` / `scene3d.sky` / `scene3d.preset` / `scene3d.look` / `scene3d.pass` / `transition` / `tts` / `brief.steps` / `scene` / `hooks`。写未知值会被忽略并警告。**建议写**：目录推断和声明取并集，写清楚让 `list_plugins` 更准确 |
| `permissions` | 否 | 目前只有两条有真实 API：`project:read`（读工程）、`project:write`（改工程）。其它值会被忽略并警告。L0 内容插件一条都不需要 |
| `render` | 否 | ⚠ 目前只被解析存储，**宿主没有任何消费点**，写了也不生效——不要照它实现功能 |
| `description` / `author` | 否 | 展示用 |

### 4.2 package.json 就是清单（工程化插件用）

插件专属字段放进 `remotionStudio` 命名空间，`id` 取**目录名**（npm 包名可能带 `@scope/`，不能当启用状态的键）：

```json
{
  "name": "@team/rhythm-check",
  "version": "1.0.0",
  "type": "module",
  "main": "./dist/index.mjs",
  "exports": { ".": "./dist/index.mjs" },
  "scripts": { "build": "esbuild src/index.ts --bundle --format=esm --platform=node --outfile=dist/index.mjs" },
  "remotionStudio": { "apiVersion": 1, "provides": ["hooks"], "permissions": ["project:read"] }
}
```

宿主会做的检查（`list_plugins` 里的警告）：
- `react` / `react-dom` / `remotion` / `@remotion/*` 出现在 `dependencies`/`devDependencies` → **警告**。它们必须走 `peerDependencies` 由宿主提供，否则插件自带另一版本 React，组件进渲染端就是 `Invalid hook call`，报错点还查不到插件头上。
- 缺 `version` → 警告。
- `package.json` 存在但 JSON 解析失败 → 加载失败，并提示"修好它或删掉它改用单文件 plugin.ts"。

### 4.3 一个有 package.json 的目录何时被当成插件

满足任一即认：
1. 写了 `remotionStudio` 字段；
2. 能解析出可用代码入口（已构建）；
3. 声明了 `main`/`module`/`exports` 但产物还没构建（显示"⚠ 入口不可用 + 该跑什么命令"，不会凭空消失）。

都不满足的目录（比如随手拷进来的 npm 包）会被静默跳过——不报错，因为那可能只是你放了个别的东西。

---

## 5. 内容贡献项（不写代码的插件）

这一节全是"摆文件 + 写 JSON/MD"，零代码。所有 JSON 文件都接受两种形态：**包一层键**（推荐，如 `{"skies":[...]}`）或**裸数组**（`[...]`）；元素和模板还接受单个对象。

**重名冲突规则**（全部贡献项统一）：与**内置**重名 → 内置优先，你的不生效；与**另一个插件**重名 → **先注册的持有，后来者注册被拒**并在 `list_plugins` 的「内容问题」里报「已被插件 X 占用」（注册顺序 = 插件 id 字母序）。两个品牌包都想要 `id: "logo"` 时，后装的那个要换 id。同插件内改文件重注册不受此限（那是正常的更新）。

### 5.1 技能指南 `skills/*.md`

普通 markdown。同名时**内置优先**（插件同名不生效，换个文件名即可）。

### 5.2 风格规则 `styles/*.md` 与预设 `styles/presets.json`

- md：风格规则文本，`list_styles` 可见、`get_style` 可读、`apply_style` 可套。
- presets.json：色板/字体/转场的一键落字段预设。格式参考内置 `server/styles/` 下的预设结构。每个 slug 要是 `{ name, palette(色值表), font{heading,body}, radius }`——结构不对或 JSON 坏会在 `list_styles` 末尾的「插件预设问题」里报出来（不会静默消失）。

### 5.3 问诊步骤 `brief/steps.json`

替换或追加内置问诊流程：

```json
{
  "mode": "replace",              // "replace" = 整套替换；"append" = 接在内置步骤后，编号自动顺延
  "steps": [
    {
      "title": "先搞清这门生意",
      "required": [               // 这一步必须收集到的字段：[字段名, 人话解释]
        ["goal", "这支片子要达成什么"],
        ["x.competitor", "主要竞品是谁"]
      ],
      "questions": ["你们靠什么赚钱？", "市场上谁是你最直接的对手？"]
    }
  ]
}
```

**`x.` 前缀是扩展字段**：问诊问出来、宿主不认识，但会原样存进 brief。想让它产生实际约束，配套写一个 `brief:derive` 钩子把它翻成设计锁规则（见 §7 与 `_example-audit` 示例）。

步骤还可以带 `"core": true`——标记为**核心步骤**，`save_brief` 确认后会单独把它排在最前（内置流程的"先搞清这门生意"就是 core 步骤）。

### 5.4 整片模板 `templates/*.json`

```json
{
  "templates": [
    {
      "key": "my-launch",           // 小写字母/数字/_/-；与内置模板重名会被拒（内置优先）
      "name": "新品发布 30s",
      "description": "悬念开场 → 卖点三连 → 行动号召",
      "tags": ["发布", "快节奏"],
      "scenes": [                    // 非空数组；每项必须有 type（内置场景 type 或某个插件场景的 type）
        { "type": "heading", "props": { "heading": "今天，换个活法" }, "durationInFrames": 90 },
        { "type": "features", "props": { "items": ["更轻", "更久", "更亮"] } }
      ]
    }
  ]
}
```

注意：`scenes[].type` 的校验发生在**套用时刻**（`create_from_template`），不是注册时——因为插件场景的注册可能晚于模板。type 打错字的模板能通过注册、`list_templates` 可见，用户点「使用」才报「引用了未知场景类型」。所以写完模板务必套用一次验证。

### 5.5 元素素材 `elements/*.json`

```json
{
  "elements": [
    { "id": "badge-hot", "name": "爆款角标", "cat": "标签", "kind": "svg", "size": 12,
      "svg": "<svg ...></svg>" },
    { "id": "tag-new", "name": "NEW", "cat": "标签", "kind": "text", "size": 6, "text": "NEW" }
  ]
}
```

校验规则（不过就整条跳过并在生成文件里留注释）：
- `id`：小写字母/数字/短横线，**不能与内置元素重名**（内置优先）。
- `name`、`cat` 必填；`cat` 是自由分类，随便起会自动变成面板筛选项。
- `kind` 只能 `svg` 或 `text`；`size` 是 0–100 的数字（短边百分比）。
- `kind:"svg"` 时必须有 `svg` 字段，且**内容里禁止 `script` / `onload` / `onclick`**（安全过滤，命中即拒）。
- `kind:"text"` 时必须有 `text` 字段。

### 5.6 3D 天空配方 `scene3d/skies.json`

```json
{
  "skies": [
    {
      "id": "dusk-harbor",          // 小写字母/数字/短横线；不与内置重名
      "label": "黄昏港湾",
      "asset": "dusk_harbor_2k",    // 全景图资产 id（文件名与下载地址由它拼）
      "category": "time",           // 只能 season / time / night / indoor
      "world": { "imageIntensity": 1.0, "envIntensity": 0.6, "haze": 0.2, "vignette": 0.25 }   // 起始档位
    }
  ]
}
```

`world` 里 **4 个必填数字键**：`imageIntensity`（全景图亮度）/ `envIntensity`（环境光强度）/ `haze`（雾感）/ `vignette`（暗角），可选 `imageRotation`（全景图旋转弧度）。写别的键名（如 `fogDensity`）注册时会报「world.xxx 必须是数字」。

`world.*` 的值**必须是数字**——写错类型渲染端不报错、只发黑。写完用 `set_graph_scene { worldPreset: "<id>" }` + 抽帧验证。

### 5.7 3D 光线风格 `scene3d/looks.json`

换"光的性格"（灯位/强度/颜色/辉光），不换配色：

```json
{
  "looks": [
    {
      "id": "warm-window",          // 不能是 "auto"（保留字），不能与内置重名
      "spec": {
        "label": "暖窗光",
        "ambient": 0.4,             // 0–10
        "env": 0.5,                 // 0–5（环境贴图强度，金属质感主要由它决定）
        "key":   { "pos": [4.5, 6, 5],  "intensity": 2.6, "color": "#FFE2B8" },
        "rimA":  { "pos": [-5, 2.5, -6], "intensity": 0.8, "color": "core" },
        "rimB":  { "pos": [5, -2, -5],  "intensity": 0.5, "color": "dot" },
        "fill":  { "pos": [-3, 1.5, 4], "intensity": 1.1, "color": "#FFFFFF" },
        "bloom": { "strength": 0.26, "radius": 0.4, "threshold": 0.92 },
        "summary": "暖色窗光，适合家居/食品（写进场景描述给 agent 看）"
      }
    }
  ]
}
```

- `rimB` / `fill` 可为 `null`（不上这两盏灯）；`color` 可以是色值，也可以是主题语义色（`"core"` / `"dot"` 等，随主题联动）。
- 每盏灯可带 `"hemisphere": true`——表示这盏灯按**半球光**算（从下方/环境补光，内置 `nature` 就这么用）；默认false=普通点光。
- **最稳的写法：抄内置四套（`studio` / `dramatic` 等）的结构改数值**，别从零发明字段。

### 5.8 3D 图形配方 `scene3d/presets.json`

一份 3D DSL 的 graph JSON 当"起手图"：`set_graph_scene { graphPreset: "<id>" }` 整套换上，之后当普通 graph 继续改。

```json
{
  "presets": [
    { "id": "my-compare", "label": "对比台", "summary": "两块展台左右对峙，适合 A/B 对比",
      "graph": { "objects": [ ... ] } }
  ]
}
```

`graph` 的结构与用户手写走**同一条校验**（`dslSchema` + `dslIssues`）——写错在注册时就被拒，不会等到套用时才黑屏。字段含义见 3D DSL 的工具描述（`list_graph_presets` 返回的内置配方就是最好的参照）。

### 5.9 3D 后期效果 `scene3d/passes.json`

自己写一段 GLSL fragment（详见 `plugins/README.md` 的「3D 后期效果」一节，那里有完整示例与 uniform 表）。要点：

- 只写 fragment；GLSL ES 1.0 风格（`varying` / `texture2D` / `gl_FragColor`）。
- 可用 uniform：`tDiffuse`（上一段结果，**唯一**允许声明的 sampler）、`uResolution`、`uFrame`、`uFps`、`uAmount`，以及你在 `params` 里声明的自定义 float。
- **默认不上镜**：必须在工程的 `post.passes` 里显式写出来才生效（一个工程最多 6 个，按数组顺序叠加）。
- 位置在 OutputPass 之后（sRGB 空间）；编译不过会被跳过并回报 `[plugin-pass]` 消息，**不会黑屏整片**。
- 禁止 `performance.now()`；逐帧确定性是硬要求（同一帧必须算出同一结果）。
- `discard`、常量黑输出这类"能编但全黑"的代码没有错误信号——**写完必须 `set_graph_scene` + `render_stills` 抽帧看**。

### 5.10 转场 `transitions/<id>.ts`

**文件名就是转场 id**（小写字母/数字/短横线）：

```ts
export const meta = {
  label: "液体荡开",
  hint: "从中心晕开，带一点模糊",
  params: [{ key: "amp", label: "幅度", min: 0, max: 3, default: 1 }],
};

/** p: 0 → 1（0 = 还没开始，1 = 完全就位） */
export default (p: number, ctx: { phase: "in" | "out"; frame: number; params: Record<string, string | number> }) => ({
  clipPath: `circle(${p * 70}% at 50% 50%)`,
  filter: `blur(${(1 - p) * 10}px)`,
});
```

硬规则：
- **只写"入场"方向**。出场 = 宿主拿 `1-p` 再调一次同一函数。想做不对称就按 `ctx.phase` 分支，但绝大多数不需要。
- 返回值只认**视觉属性白名单**：`transform` / `transformOrigin` / `opacity` / `filter` / `backdropFilter` / `clipPath` / `maskImage` / `WebkitMaskImage` / `maskSize` / `maskPosition` / `background` / `backgroundColor` / `boxShadow` / `mixBlendMode` / `borderRadius`。写布局属性（`position`/`width`…）会被丢弃并告警——转场样式和版式共用一个 style，混进去表现是"版面错"而不是"转场怪"。
- `url(...)` 会被丢弃（渲染端抓不到外部资源）。
- **禁用 `Math.random()` / `Date.now()`**：逐帧渲染每帧独立调用，必须确定性。要"抖动"用 `ctx.frame` 算 hash。
- 写崩了（抛错/返回非法值）退回淡入淡出 + 告警，**整片照出**；工程里引用了已删插件的转场 id 也只是退回淡入。
- 转场函数每帧每幕都要算，必须**轻**：只算数值，不 new 大对象。

---

## 6. 代码插件：入口与加载模式

`plugin.ts`（或工程化插件的构建产物）是一个默认导出对象，三种内容可叠加：

```ts
export default {
  "audit:rules": (ctx) => ({ ... }),     // 钩子（§7）
  "ops:review": (ctx) => ({ ... }),      // 钩子
  "text:transform": (ctx) => "...",      // 文本处理（§8）
  "media:process": async (ctx) => ...,   // 文件处理（§9）
  tools: [ /* MCP 工具（§10） */ ],
  // ttsProviders 单独具名导出也可以（§11）
};

export const ttsProviders = { /* ... */ };
```

宿主读取顺序：`export default` 对象（或 `hooks` 具名导出）里的钩子键 + `tools`；`ttsProviders` 从具名导出或 default 里取。

### 6.1 单文件模式 vs 工程模式

| | 单文件 `plugin.ts` | 完整工程（有 package.json） |
|---|---|---|
| 谁编译 | 宿主用 esbuild 现场打包 | **你自己**（`npm run build`） |
| npm 依赖 | ⚠ 会被打包内联 | ✅ 从插件自己的 `node_modules` 解析 |
| 原生模块（sharp 等） | ❌ | ✅ |
| `import.meta.url` 读自带资源 | ❌（产物在临时目录，相对路径断） | ✅ |
| 改完代码 | 直接生效 | 重新构建后生效 |

单文件入口候选（按顺序找）：`plugin.ts` / `plugin.mts` / `plugin.mjs` / `plugin.js` / `index.ts` / `index.mjs`。
工程入口解析顺序：`exports["."]`（import 条件优先）→ `module` → `main` → 约定路径（`dist/index.mjs` 等）。入口指向 `.js/.mjs/.cjs` 直接 `import()`；指向 `.ts` 退回宿主编译（等于单文件模式的限制）。

### 6.2 嵌入 zod 是禁止的（最重要的坑）

**不要在插件里 `import { z } from "zod"` 然后把 schema 交给宿主**（工具参数、场景字段都不行）。插件被打包执行时带进的是**自己那份 zod 实例**，与宿主那份 `instanceof` 对不上，校验会**静默失效**。正确姿势：只声明**纯数据**（见 §10 的 `params`、§12 的 `fields`），宿主用自己的 zod 构建 schema。

### 6.3 失败隔离

- 加载失败的插件只会让自己失效，`list_plugins` 单独标红并给原因，其余插件与内置功能照常。
- 修好后不用重启，下一次 `list_plugins` / 相关请求就会重新扫描。
- 运行期连续抛错 3 次的钩子会被**自动摘除**（日志防刷屏），`list_plugins` 里能看到摘除原因。

---

## 7. 流程钩子

语义：**只读入参 → 同步返回文字意见**。不改数据、不发网络、不读大文件。

| 钩子 | 触发时机 | ctx 内容 |
|---|---|---|
| `audit:rules` | `audit_project` 体检时 | `{ brief, project, lock }`（lock 没定形态时为 null） |
| `ops:before` | **写入之前**、落库前（唯一调用点） | `{ before, ops }` |
| `ops:review` | 每次写入工程**之后** | `{ before, after, ops }` |
| `brief:derive` | 推导设计锁时 | `{ brief, lock }` |

### 返回值

```ts
{ blocking?: string[]; warnings?: string[]; passed?: string[]; lockRules?: string[] }
```

全部可选、都是字符串数组。宿主自动给每条加 `[你的插件id]` 前缀——用户必须看得出这条意见来自插件。单条超 300 字截断、每类最多 20 条。

### 四条硬约束

1. **同步**。钩子跑在保存工程/自检的同步路径上：不能 `await`、不能发网络请求。超过 30ms 会被记"太慢"。
2. **只读**。入参是深冻结快照，改它直接抛错。想让数据变，做成 MCP 工具（§10）。
3. **`ops:before` 的 `blocking` 是否决**：非空 → 这一批 op 整批失败，工程一个字不动（rev 不涨、撤销栈干净）。`ops:review` 里返回 `blocking` **拦不住**（已经写进去了），只会变成"已写入需手动修"的提醒。要拦用 before，要事后提醒用 review。
4. **出错就让它抛**。吞错返回空对象会让你的钩子"看起来在跑其实没说话"；抛错会被记录且连续 3 次才摘除。

### 权限

钩子插件**不需要声明任何权限**——宿主只交数据，不交 fs/fetch/子进程。但要说清：**这不是沙箱**。`plugin.ts` 是被 `import()` 执行的任意代码，顶层就能 `import fs`。"只读"是 API 约定，不是隔离。装代码插件 = 装程序，只装信得过的。

---

## 8. 文本处理（text:transform）

在字幕/稿件**写进工程之前**改写它：

```ts
export default {
  "text:transform": (ctx: { text: string; kind: "subtitle" | "script" | "brief";
                            projectId: string | null; sceneId: string | null }) => ctx.text,
};
```

| ctx.kind | 触发点 | 建议 |
|---|---|---|
| `subtitle` | `set_subtitle` 写字幕时（**拆分之前**） | 处理；此时改字才不会打乱每屏字数 |
| `script` | `save_script` 写稿件时（`sourceText` 用户原话不动） | 处理 |
| `brief` | 需求契约 | **多数插件应跳过**（brief 里的字是用户/agent 对齐用的） |

### 三条铁律

1. **必须幂等**：处理两次的结果 = 处理一次。反例 `text.replace("视频", "短视频")` 第二次变"短短视频"。写替换表时保证"替换后的词不再命中左侧规则"；"循环删到删不动"是处理句首口头禅的正确姿势（见 `_example-text`）。
2. **只改字，不改结构**：不加换行、不拆句、不加序号——断句是宿主的活，你插一手每屏字数就错了。
3. **宁可少改不猜**：这段代码在用户每次保存时都跑。

### 宿主护栏

- 多个插件按 id 顺序串成链，上一个的输出是下一个的输入。
- 返回空字符串 → **拒收**（防一句话清空字幕）；输出暴涨（> 输入 ×3 + 200 字）→ **拒收**；抛错 → 跳过该插件继续。
- 文本超过 20000 字整条跳过（它在保存路径上）。
- 被改动时回执会写「插件处理：「x」22→16 字」——用户必须知道字被谁改了。
- 已有工程补处理：调 `transform_project_text`（默认 dryRun 只预览）。

---

## 9. 文件处理（media:process）

新上传的图/音/视频先过一遍你的处理器（压缩、剥元数据、统一响度……）：

```ts
export default {
  "media:process": async (ctx: {
    file: string;        // 原文件绝对路径，**只读**
    buffer: Buffer;      // 文件内容（原地改无效，必须放进返回值）
    fileName: string;    // 带扩展名的原始文件名
    kind: "image" | "audio" | "video" | "file";
    projectId: string | null;
    tmpDir: string;      // 可写临时目录，宿主处理完自动清
    ffmpeg: string | null; // Remotion 自带的 ffmpeg；null = 这台机器没处理能力
    log: (msg: string) => void;
  }) => {
    if (ctx.kind !== "image") return null;   // 不管的不动手
    if (!ctx.ffmpeg) return null;            // 没能力是正常情况，原样入库，不是错误
    // ... spawn ffmpeg 输出到 ctx.tmpDir ...
    return { file: outPath, fileName: "clean.jpg", note: "限宽 1920、去元数据" };
    // 或 return { buffer: newBuf, note: "..." }
  },
};
```

### 契约要点

- **返回 `null`/`undefined` = "看过但不动手"**，不是错误。抛错才记失败。
- **`ctx.file` 只读**。产物放 `ctx.tmpDir`，用 `{ file }` 或 `{ buffer }` 返回。写原文件会破坏"原文件永远在"的回滚保证。
- **原文件永远不动**：落库时原文件保留，处理产物写成 `原名@指纹.jpg` 新文件（指纹 = 启用的处理器 + 各自版本）。同一套插件重跑同名不产生垃圾；换插件/升版本换新名；停用插件不影响已处理的文件。
- **只对新上传自动生效**。补历史素材用 `reprocess_assets`（默认 dryRun；只产新文件，不自动改工程引用）。
- **预算**：单次处理链总超时 60 秒、并发 1（跑在上传请求里）。注意 `Promise.race` 只能救 async 卡住；插件里写 `while(true){}` 会卡死整个进程，宿主救不了——别写同步死循环。
- **体积护栏**：输出 0 字节拒收；超过输入 ×4（且 >200MB 拒收）拒收——"插件把 2MB 图变成 200MB"这种事宿主替用户挡了。
- **ffmpeg 缺失返回 null 而不是报错**。参考 `_example-media`：太小的文件不动、PNG 不动、处理完反而更大就放弃——**每个处理器都该有自己的门槛**。
- 视频转码是分钟级，别放在上传的同步等待里，做成你自己的 MCP 工具（§10）。

---

## 10. 工具插件

给 agent 加一个可 `tool_search` 到、可 `tool_call` 的 MCP 工具：

```ts
export default {
  tools: [
    {
      name: "my_brand_check_terms",             // ① 见下方命名规则
      description: "逐幕检查文案是否出现禁用词。只读，不改数据。",  // ② agent 靠它决定调不调
      params: {                                  // ③ 纯数据声明，宿主建 schema（禁 zod！）
        projectId: { type: "string", required: true, desc: "工程 id（list_projects 查）" },
        dryRun:    { type: "boolean", default: true, desc: "true=只预览（默认）" },
      },
      async run(args, ctx) {
        const p = ctx.readProject(args.projectId);   // 需要 project:read
        return `发现 ${n} 处禁用词`;
      },
    },
  ],
};
```

### 工具名 `name`

- 规则：`/^[a-z][a-z0-9_]{2,40}$/`（小写字母开头，3–41 位，字母/数字/下划线）。
- **必须带插件前缀**（如 `my_brand_xxx`）：与内置工具或别的插件工具重名会被**拒绝注册**。
- 缺 `description` 会被拒绝注册——agent 全靠它决定要不要调、什么时候调。写清"做什么 + 什么时候用 + 是否只读"。

### 参数 `params`

| 字段 | 说明 |
|---|---|
| `type` | `string` / `number` / `boolean` / `enum` / `stringArray` |
| `desc` | 给 agent 看的说明。**不写等于让 agent 猜**（实测参数错误一半来自这里） |
| `required` | 缺省 = 可选 |
| `default` | 给了就套 `.default()` |
| `values` | `enum` 的候选值，至少 2 个 |
| `min` / `max` | `number` 的范围 |

- 参数名：字母开头，字母/数字/下划线，**驼峰可以**（`projectId`/`dryRun`）。上限 20 个——参数太多的工具 agent 学不会，拆成两个。
- **再次强调：不要 import zod**（§6.2）。

### `run(args, ctx)` 的能力

| 方法 | 需要的权限 | 说明 |
|---|---|---|
| `ctx.listProjects()` | `project:read` | 所有工程 id |
| `ctx.readProject(id)` | `project:read` | 工程快照 |
| `ctx.applyOps(id, ops)` | `project:write` | 走正常 op 流程；历史里 actor 记为 `plugin:<你的id>` |
| `ctx.log(msg)` | 无 | 进服务端 stdout（截断 500 字） |

没声明权限就调 → 抛 `PermissionDenied`，报错里写清缺哪条、加在哪。

### 三条硬规矩

1. **名字带前缀**（撞名直接拒）。
2. **写入类工具必须有 `dryRun` 且默认 `true`**——"agent 试了一下数据就变了"是插件能造成的最大伤害。预览返回要写清"确认后传 dryRun=false 执行"。
3. **出错就抛**。吞错返回空字符串会让 agent 以为成功了。

返回值：字符串原样给 agent；对象会被 `JSON.stringify(…, 2)`；返回 `undefined` 会变成"（插件工具没有返回内容）"。

### 权限的边界（必读）

权限**不是沙箱**。`plugin.ts` 是任意代码，`import fs` 就绕过全部检查。权限声明的真实作用是**知情同意**：用户 `list_plugins` 能看到"这个插件要读写我的工程"再决定装不装；它挡的是"通过宿主 API 的顺手越权"，挡不住恶意代码。声明**宁少勿多**——不确定要不要 `project:write` 就先别给，插件只是没这个能力，不会因此坏掉。

---

## 11. 语音合成 provider（ttsProviders）

内置只有 OpenAI 兼容协议一条路。各家厂商（签名/换 token/base64 音频/异步轮询）靠模板拼不出来，所以"文字 → 音频字节"整个交给插件：

```ts
export const ttsProviders = {
  "volc-tts": {                                   // id：小写字母/数字/短横线；不能叫 "openai"（内置保留）
    meta: {
      label: "火山引擎",
      hint: "需要在控制台开通语音合成",
      configFields: [                              // 编辑器/工具据此渲染配置表单
        { key: "appid", label: "AppID", required: true },
        { key: "token", label: "Access Token", secret: true, required: true },
      ],
    },
    voices: (config) => [{ id: "zh_female_1", label: "晓晓", language: "zh" }],  // 可选
    synthesize: async ({ text, voice, speed, format, config, signal }) => {
      const res = await fetch("https://...", { method: "POST", signal /* ← 必须透传！ */, ... });
      if (!res.ok) throw new Error(`厂商返回 ${res.status}`);
      return { audio: new Uint8Array(await res.arrayBuffer()), contentType: "audio/mpeg" };
      // 或 return { file: "/abs/path.mp3" }   ← CLI 型 TTS 自己落盘
    },
  },
};
```

### 宿主负责（你不用管）

落盘（按工程归属）、响度归一 -16 LUFS、时长探测、字幕时间轴对齐、`assets` 登记。

### 宿主兜底（不限制你怎么调厂商）

1. **60 秒超时**：`signal` 会传给你（宿主超时/取消时 abort）；即使你忘了透传，宿主还有一道 race 能杀掉。
2. **产物校验**：20MB 上限 + 按 magic bytes 认真是音频（厂商报错常返 200 + HTML，不认就会把错误页写成音频）。
3. **不静默回退内置**：你报错就报错——悄悄换回内置会让"配错了但出片了"变成最难查的坑。

`configFields` 里 `required: true` 的字段宿主在调用**前**就检查，缺了直接告诉用户缺哪个。

### 配置存哪（自带界面的 TTS 插件必读）

配置在 `data/tts-config.json` 的 `providers[id]`，按 provider 合并。你的界面要写 **`POST /api/tts/config`**，body 形如
`{ "provider": "你的id", "providers": { "你的id": { "appid": "...", "token": "..." } } }`。
**不要**写进 `PUT /api/plugin-config/<id>`——那是通用插件配置存储，宿主合成时读的是 tts-config，写错地方用户会看到「还缺 appid」但明明已经填了。

调用链不变：`list_tts_providers` → `set_tts_config` → `tts_synthesize` / `tts_narration`。

---

## 12. 场景组件（scenes/）

给编辑器加一种新画面：

```
plugins/我的场景/
  scenes/
    rating-card.json     ← 字段声明（编辑器据此自动生成属性面板）
    rating-card.tsx      ← React 组件（默认导出）
```

**json 与组件同名配对**（`.json` 配 `.tsx`/`.jsx`/`.ts`），只放 json 没有组件会在生成时报"没有同名组件文件"。

### 12.1 字段声明 json

```json
{
  "type": "my-rating",              // 场景 key，写进 Scene.type。小写字母/数字/短横线；建议 <插件名>-<用途> 防撞
  "name": "评分卡",
  "category": "数据",
  "summary": "一句话说明适合什么内容",
  "duration": { "default": 120, "min": 45, "max": 600 },
  "elements": [                     // 可选：可拖动元素（对应组件里的 <Editable id="…">）
    { "id": "badge", "label": "角标", "prop": "badgeText" }
  ],
  "fields": [
    { "key": "title",  "type": "text",   "label": "标题", "default": "综合评分" },
    { "key": "score",  "type": "number", "label": "分数", "default": 8.6, "min": 0, "max": 10 },
    { "key": "tone",   "type": "enum",   "label": "语气", "options": ["克制", "热烈"], "default": "克制" },
    { "key": "tags",   "type": "stringArray", "label": "亮点标签", "default": ["手感扎实"], "maxItems": 5 },
    { "key": "rows",   "type": "objectArray", "label": "明细", "default": [],
      "items": [ { "key": "name", "type": "text", "label": "项目", "default": "" },
                 { "key": "val",  "type": "number", "label": "数值", "default": 0 } ] }
  ]
}
```

字段类型只有 6 种：`text` / `number`（可 `min`/`max`/`int`）/ `boolean` / `enum`（`options` ≥2）/ `stringArray`（可 `minItems`/`maxItems`）/ `objectArray`（`items` 子字段只允许 text/number/boolean，且**每个子字段必须给 default**——编辑器"添加一项"推的是空对象）。

**核心规则：除 `optional: true` 的字段，每个字段都必须给 `default`。** 没有默认值的新建场景 props 缺字段，zod 当场拒。字段声明不合法只让这一个场景失效，不影响其它。

### 12.2 组件

```tsx
import { useSceneLayout, SceneFrame, useEnter, withColorAlpha, type Theme } from "@studio/sdk";

type Props = { theme: Theme; title: string; score: number; tone: string };

export default function MyRating({ theme, title, score }: Props) {
  const { u, h } = useSceneLayout();     // u(n)=短边百分比（尺寸/间距），h(n)=字号单位
  const enter = useEnter(0);             // 入场动画（已处理「动效强度=0」的降级）
  return (
    <SceneFrame theme={theme}>
      <div style={{ opacity: enter.opacity, fontSize: h(4), color: theme.palette.text }}>{score}</div>
    </SceneFrame>
  );
}
```

`@studio/sdk` 全部导出（就这些，别 import 宿主内部相对路径）：
`useSceneLayout` / `Editable` / `SceneFrame` / `useEnter` / `useCountUp` / `useFadeOut` / `useMotion` / `useBare` / `useBackdropFx` / `withColorAlpha` / 类型 `Theme`、`Orientation`。

**三条硬规矩（违反了换画幅就崩、换主题就脏）**：
1. **禁止写 px**：尺寸一律 `u(n)`（短边百分比）、字号 `h(n)`——竖屏 1080×1920 与横屏下物理大小才一致。
2. **颜色从 `theme.palette` 取**，不写死色值（需要透明度用 `withColorAlpha`）。
3. **入场动画用 `useEnter(delay)`**，不要手写 spring/interpolate 一套。

插件场景最短 15 帧（比内置场景的 30 帧下限宽——允许做 0.5 秒的字卡）。

### 12.3 重新打包的时机（重要）

场景组件要靠生成的代码文件静态 import 才能进渲染 bundle（webpack 静态分析，运行时路径打不进去）。所以：

- **渲染端**：服务端在渲染前检测到插件场景变化会自动重新生成 + 重打包（几十秒，日志有"检测到场景源码变更"）。
- **编辑器**：是另一个预构建 bundle，**必须等一次 `npm run build`（或重启 `npm start`，它会自己重建）**才能在画布上看到。否则会出现"服务端能选、渲染能出、编辑器画布全黑"。
- 技能/风格/问诊/钩子/工具改完**不用**等这些。

---

## 13. 自带界面（ui/）

```
plugins/我的插件/
  ui/
    index.html          ← 入口（必需）
    app.js / style.css  ← 同目录其它文件都能取
```

编辑器「插件」对话框里会出现「打开界面」按钮，点开一个**独立浮窗**（可拖动/缩放/最大化，可同时开多个）。浮窗只是容器（标题栏 + iframe），里面的布局、宽度、配色、按钮**全归你**——原生 HTML/JS、Vue、构建产物、图表库都行。改完点「重载」立即生效，不用重启。

### 页面里最常用的四件事

```js
// pluginId 别写死，从 URL 取（同一页面可能被复制成另一个插件）：
const pluginId = decodeURIComponent(location.pathname.split("/")[2]);

// 1. 读自己的配置（存 data/plugin-config.json，不进工程、不随工程分享）
const { config } = await (await fetch(`/api/plugin-config/${pluginId}`)).json();

// 2. 存配置（一层 key 合并，单插件上限 64KB）
await fetch(`/api/plugin-config/${pluginId}`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ endpoint, token }),
});

// 3. 调宿主任何 API（同源直接 fetch），例如：
const providers = await (await fetch("/api/tts/providers")).json();

// 4. 跟随宿主配色（宿主在 onload 后 postMessage 一次）：
window.addEventListener("message", (ev) => {
  if (ev.data?.type !== "studio:init") return;
  for (const [k, v] of Object.entries(ev.data.tokens))
    document.documentElement.style.setProperty(k, v);
});
// tokens: --bg --panel --panel-2 --line --text --muted --accent --danger --radius
```

可选的两条控制消息（宿主支持，不支持也不会坏）：

```js
parent.postMessage({ type: "studio:resize", height: 720 }, "*");  // 请宿主调高浮窗（240 ~ 屏高）
parent.postMessage({ type: "studio:close" }, "*");                // 用户保存后顺手关窗
```

边界：iframe 带 `allow-same-origin`（因为要 fetch `/api/*`）。**这意味着插件页与编辑器同源**——它可以触达编辑器的 DOM、localStorage 与 cookie，沙箱并不构成安全边界；把 ui/ 页面当成"同一份代码库里的前端"来对待。但**没有** `allow-top-navigation`——你的页面不能把整个编辑器导航走。主题变量：宿主在页面 load 后 `postMessage { type: "studio:init", tokens }` 发一次；如果你的页面用异步框架初始化（监听建得晚），建好监听后随手 `parent.postMessage({ type: "studio:hello" }, "*")`，宿主会立刻补发一次 init。完整例子：`plugins/_example-ui/`。

---

## 14. 安装、分发与工程化插件

### 14.1 编辑器面板安装（推荐给最终用户）

顶栏「插件」→ 粘 git 地址 / npm 包名 / 选本地目录 → 宿主自动完成「识别 → 下载 → npm install → build → 就位」：

- **先判断再下载**（npm 只读清单、git 只取目录树），判断不过就停，不留文件。
- 失败的安装不留半个插件：先在 `plugins/.staging/` 装好构建好，成功才整体改名。
- npm 源默认国内镜像，可在面板改。
- 日志：`data/plugin-installs/<job>.log`。
- 预检只能看声明看不到代码——什么都没声明的包会被误判，面板有「仍然安装」按钮。
- 列表里可**停用/启用**（文件不动）、**重建**（重跑 install+build）、**卸载**——确认框二选一：**放入插件回收站**（默认，挪到 `data/.plugin-trash/`，可恢复）或**永久删除**（不可恢复，需在确认框显式选择）。

### 14.2 手动安装

把文件夹放进 `plugins/`，自己解决依赖与构建：

```bash
cd plugins/我的插件 && npm install && npm run build
```

宿主扫描目录时**不会**偷偷执行任何东西——只有明确点「安装/重建」才起子进程。没构建时 `list_plugins` 会显示「⚠ 入口不可用」和该跑的命令。

### 14.3 发布成 npm 包 / git 仓库的建议

- `keywords` 加 `"remotion-studio"` 和 `"plugin"`（安装面板的预检会认）。
- 构建产物（`dist/`）提交进仓库或发进 npm 包——用户装完不用本地构建。
- `files` 字段只带 `dist`，别把 `src` 发出去增大体积。
- 框架依赖（react/remotion）一律 `peerDependencies`（+ `peerDependenciesMeta.optional`），见 §4.2。

---

## 15. 排障与错误行为对照表

第一入口永远是 **`list_plugins`**（MCP 工具）：显示每个插件 id/版本/路径/入口状态/提供项/权限/钩子挂载点/加载失败原因。修好后不用重启，再调一次就重新扫描。编辑器「插件」面板是同一份数据的可视化。

| 现象 | 大概率原因 |
|---|---|
| 放了插件没反应 | 目录放错层级；文件名/扩展名不对（如 skies.json 拼错）；目录里没有任何可识别结构（会被静默跳过） |
| `list_plugins` 标红 | manifest 坏 / apiVersion 过高 / id 冲突 / package.json 解析失败 / 入口未构建 |
| 入口显示"⚠ 不可用" | 工程化插件没 build。按提示在插件目录跑 `npm install && npm run build` |
| 场景装了编辑器看不到 | 编辑器 bundle 没重建——`npm run build` 或重启 `npm start`（§12.3） |
| 钩子"感觉没生效" | 它只挂了某个环节（如只在 `ops:review` 说话，而你一直看自检结果）；`list_plugins` 会显示挂载点 |
| 停用了还出现 | 检查 `data/plugins.json` 是否被多实例/只读问题挡住；`toggle_plugin` 会回读验证 |
| 中文目录名的 id 很怪 | 非正常现象但属预期（哈希兜底）；改英文目录名即可 |

**写坏了会怎样（总原则）**：坏插件只让自己失效，不拖垮服务。钩子连续抛错 3 次被摘除；文本链空输出/暴涨拒收；媒体链空文件/体积异常拒收；转场写崩退回淡入；3D pass 编不过跳过。每种情况都有告警或 `list_plugins` 记录，不会静默吃掉——如果什么提示都没有，先怀疑文件没被当成插件（放错位置）。

---

## 16. 发布前自检清单

- [ ] 目录名是小写英文短横线（或 manifest 明确写了合法 id）
- [ ] `manifest.json`/`package.json` 里 `apiVersion` 没超过 1；`provides` 写了实际提供的项
- [ ] 每个场景字段的 `default` 都给了（或标了 `optional`）；`objectArray` 子字段也有 default
- [ ] 工具名带插件前缀、有 `description`、参数都有 `desc`；写入类工具有 `dryRun` 且默认 true
- [ ] 没有在任何地方 `import { z } from "zod"` 交给宿主
- [ ] 框架依赖（react/remotion）在 `peerDependencies` 里
- [ ] 钩子是同步的、纯读的、<30ms；`text:transform` 幂等；`media:process` 有门槛、返回 null 而不是乱抛错
- [ ] 转场没用 `Math.random()`/`Date.now()`/`url()`，只返回白名单属性
- [ ] 3D pass 抽帧看过实际效果；skies 的 `world.*` 全是数字
- [ ] TTS 插件的界面写的是 `POST /api/tts/config` 而不是 `PUT /api/plugin-config/<id>`
- [ ] 跑了 `list_plugins` 确认：无红字、提供项齐全、钩子/工具都列出来了

---

## 17. 示例插件索引

`plugins/_example-*`，全部默认停用，面板一键启用；把 `.example` 后缀去掉即变成真实文件。七份都可整删。

| 示例 | 演示什么 |
|---|---|
| `_example-content` | 技能 md + 风格 md（最短路径上手） |
| `_example-brief` | 问诊步骤（replace/append、`x.` 扩展字段） |
| `_example-audit` | 三个同步钩子的完整写法（`audit:rules`/`ops:review`/`brief:derive`） |
| `_example-tool` | 只读工具 + 写入工具（dryRun 模式）+ 权限声明 |
| `_example-text` | `text:transform`：幂等替换表、句首口头禅循环删除 |
| `_example-media` | `media:process`：ffmpeg 限宽/去元数据/统一响度，示范"什么时候该返回 null" |
| `_example-engineering` | 完整工程化插件（package.json + src + dist，唯一开箱即用的示例） |
| `_example-scene` | 场景组件（json 字段声明 + tsx 组件 + SDK 用法） |
| `_example-ui` | 自带界面（读/写配置、调宿主 API、跟随配色） |

---

## 18. 格式速查表

**manifest.json**：`id`(小写-数字-) / `name` / `version` / `apiVersion`(=1) / `provides`(13 种白名单) / `permissions`(project:read|project:write) / `description` / `author`

**钩子返回值**：`{ blocking[], warnings[], passed[], lockRules[] }`（全可选，字符串数组，单条≤300 字，每类≤20 条）

**工具**：`{ name, description, params: { <参数名>: { type, desc, required?, default?, values?, min?, max? } }, run(args, ctx) }`

**场景 json**：`{ type, name, category?, summary?, duration{default,min,max}?, elements?, fields[] }`
**字段**：`{ key, type: text|number|boolean|enum|stringArray|objectArray, label?, default, optional?, min?, max?, int?, options?, minItems?, maxItems?, items? }`

**转场**：`meta = { label, hint?, params[{key,label,min,max,default}] }`；`default(p, ctx{phase,frame,params}) => <白名单 CSS 属性>`

**TTS**：`ttsProviders[id] = { meta{label,hint,formats?,instruct?,configFields[{key,label,secret,required,hint}]}, voices?(config), check?({config,signal}), synthesize({text,voice,speed,format,instruct?,language?,config,signal}) }` → `{ audio, contentType? } | { file }`
其中 `meta.formats`（如 `["wav"]`）是**输出格式声明**：面板把它映射成"输出格式"选项，选中值经 `format` 原样传回 `synthesize`，产出对应格式是插件的事（宿主不代转码）。注意宿主配置字段的合法集合是 mp3/wav/ogg，声明其它值会被保存时滤掉。
其中 `voices(config)` 返回 `[{ id, label?, language? }]` 是**音色声明**（静态数据，不碰厂商）：编辑器"音色"下拉直接映射它；不提供 voices 时面板退回文本输入，留空 = 插件自己的默认音色。
`meta.instruct: true` 表示 synthesize 真的消费风格指令（instruct）——**不声明面板就不显示"风格指令"输入框**，避免用户填了没效果。
`check` 是**探测方法**：agent 的 `tts_check`（浅层）会调它回答"现在能不能用"。要求便宜——验 key 或最小请求（如 2 字合成）都行，别做完整合成；返回 `{ ok, detail? }` 或 `{ ok:false, error }`，抛错也算失败，error 原文会回到 agent。没提供 check 的 provider，浅层 tts_check 只能报名字，agent 要验就得 deep=true 真合成。

**media:process 返回**：`{ buffer, fileName?, note? } | { file, note? } | null`

**关键路径**：插件目录 `<repo>/plugins/` · 启用状态 `data/plugins.json` · 插件配置 `data/plugin-config.json` · TTS 配置 `data/tts-config.json` · 回收站 `data/.plugin-trash/` · 安装日志 `data/plugin-installs/` · 渲染端生成文件 `src/_plugins.generated.ts`（构建产物，勿手改）
