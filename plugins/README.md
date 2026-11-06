# plugins/ —— 放插件的地方

把文件夹丢进来就生效，不用重启。删掉就消失。这个目录本身不入库（示例插件除外），
所以你自己做的东西不会被 `git pull` 覆盖。

## 只有一个位置

`<安装目录>/plugins/`（就是这个目录）。

**没有"用户目录"了**（`~/.remotion-studio/plugins/` 已于 2026-11-06 删除）。原因：
它当初是为了"换个项目也能用"，但这个 `plugins/` 本来就是**整份安装共用**的——
同一份安装下的所有工程都读它，用户目录并不额外提供什么。反而因为它在工程根之外，
场景组件（要静态打包）装进去永远不生效，且宿主不报错。留一个"选错了就静默没用"的入口，
不如没有。

`_example-*` 开头的是仓库自带的演示插件。它们**默认是停用的**（全新环境首次启动时自动停用，
避免示例技能/风格/场景混进真实项目）——想看示例长什么样，在编辑器顶栏「插件」面板里一键启用即可。

## 一个插件长什么样

``` 
plugins/我的插件/
  skills/*.md            技能指南      → list_guides / get_guide
  styles/*.md            风格规则      → list_styles / get_style / apply_style
  styles/presets.json    风格预设      → apply_style 一键落字段
  brief/steps.json       问诊步骤      → intake / save_brief 按你的流程走
  templates/*.json       整片模板      → 模板市场里多一套，create_from_template 可套
  elements/*.json        元素素材      → 元素面板里多几个图标 / 标签（分类可自定义）
  scene3d/looks.json     3D 光线风格   → 3D 场景的 look 里多几套可选光（灯位/色温/辉光）
  scene3d/presets.json   3D 图形配方   → list_graph_presets 里多几套起手图，set_graph_scene 一套换上
  scene3d/skies.json     3D 天空配方   → list_world_skies 多几条，set_graph_scene 能套
  scenes/*.json + *.tsx  场景组件      → 选择器里多一种画面（必须放项目内）
  plugin.ts              钩子/工具/处理器 → 说意见、改字、洗素材，或加一个 MCP 工具
  package.json + dist/   同上，但做成**完整工程**（可以带自己的 dependencies）
  manifest.json          可选——需要声明权限/版本时才写
```

**没有 manifest 也能用**：宿主按目录结构推断。这是刻意的——想加一份指南的人
不该先读三页文档写 JSON。

## 现在支持什么

| 能加什么 | 说明 |
|---|---|
| 技能 | `skills/*.md`，同名时内置优先 |
| 风格 | `styles/*.md`，可以只写规则不写预设 |
| 风格预设 | `styles/presets.json`，可一键套色板/字体/转场 |
| 问诊步骤 | `brief/steps.json`，替换或追加内置 11 步；支持 `x.` 扩展字段 |
| **场景组件** | `scenes/<type>.json` + `scenes/<type>.tsx`，给编辑器加一种新画面 |
| **流程钩子** | `plugin.ts`，在自检/写入/设计锁三个环节说一句话；不改数据，只给意见 |
| **工具** | `plugin.ts` 的 `tools`，给 agent 加一个 MCP 工具；能读工程、改工程（要声明权限，配合 `dryRun`） |
| **文本处理** | `plugin.ts` 的 `text:transform`，在字幕/稿件写进工程之前改字（术语表、品牌名、口头禅） |
| **文件处理** | `plugin.ts` 的 `media:process`，新上传的图/音/视频先过一遍（压缩、剥元数据、统一响度）；补历史素材用 `reprocess_assets` |
| **整片模板** | `templates/*.json`，模板市场里多一套；`{ "templates": [...] }`、`[...]`、单个对象三种写法都收 |
| **3D 天空配方** | `scene3d/skies.json`，`list_world_skies` 里多几条（带「〔插件 xxx〕」标记），`set_graph_scene { worldPreset }` 直接套 |
| **元素素材** | `elements/*.json`，元素面板里多几个图标/标签；`cat` 随你定（会自动变成筛选项），也能被 `list_element_library` / `add_element { libraryId }` 用 |
| **3D 光线风格** | `scene3d/looks.json`，3D 场景的 `look` 下拉里多几套（灯位/强度/色温/辉光）；只换光的性格，不换配色 |
| **3D 图形配方** | `scene3d/presets.json`，一份 graph JSON 当「起手图」：`set_graph_scene { graphPreset }` 整套换上，之后当普通 graph 继续改。校验和用户手写同一条（`dslSchema` + `dslIssues`），写错在注册时就被拒 |

**上面这张表里的全部接通**（技能、风格、问诊、整片模板、3D 天空、3D 光线风格、3D 图形配方、元素、场景组件、钩子）。
转场 / 特效 / 3D 几何体（`scene3d/presets.json`）**不打算做**，理由见计划文档 9.3。
完整路线见 `docs/2026-11-05-插件化架构与实施计划.md`。

## 插件可以是一个完整工程

上面那种「一个 `plugin.ts`」适合几十行的小规则。但真实插件常常是一个 npm 包或 git 仓库：
有自己的依赖、构建脚本、测试，甚至原生模块。**这种也能直接用**。

```
plugins/我的插件/
  package.json      ← 宿主从这里读 name / version / 入口
  src/index.ts      ← 源码（你想怎么写就怎么写）
  dist/index.mjs    ← 构建产物（宿主真正加载的）
  node_modules/     ← 你自己的依赖，宿主不碰
```

```json
{
  "name": "@team/rhythm-check",
  "version": "1.0.0",
  "type": "module",
  "main": "./dist/index.mjs",
  "exports": { ".": "./dist/index.mjs" },
  "scripts": { "build": "esbuild src/index.ts --bundle --format=esm --platform=node --outfile=dist/index.mjs" },
  "remotionStudio": { "provides": ["hooks"] }
}
```

**不需要写 `manifest.json`**——`package.json` 就是清单。插件专属的字段放进 `remotionStudio`。

### 两种形态的差别

| | 单文件 `plugin.ts` | 完整工程 |
|---|---|---|
| 谁编译 | 宿主用 esbuild 现场编译 | **你自己**（`npm run build`） |
| 能用 npm 依赖 | ⚠ 会被内联，原生模块直接失败 | ✅ 从插件自己的 `node_modules` 解析 |
| 能用原生模块（sharp 等） | ❌ | ✅ |
| 插件自带的资源文件（`import.meta.url` 读 json） | ❌ 打包产物在缓存目录，相对路径会断 | ✅ |
| 改完要做什么 | 什么都不用做 | 重新构建（面板上点「重建」，或让他自己 build） |

只有一个文件就写单文件；一旦要 `npm i` 东西、或者要读自己的资源文件，就做成工程。

### 宿主怎么找入口

按顺序：`exports["."]` 的 `import` → `module` → `main` → 约定路径（`dist/index.mjs` 等）。

- 找到 `.js` / `.mjs` / `.cjs` → **直接 `import()`，不打包**
- 找到 `.ts` → 退回宿主编译（等于单文件模式）

**推荐让入口指向构建产物**，但不是必须的——指向 `.ts` 也能跑，只是要接受上表里那两条 ❌。

### 一条硬约定：框架依赖用 peerDependencies

`react` / `react-dom` / `remotion` / `@remotion/*` **不能**写进 `dependencies`。

它们必须由宿主提供。否则插件会自带一份另一个版本的 React，渲染时就是 `Invalid hook call`——
报错点在宿主代码里，查半天查不到插件头上。宿主会在加载时检查并警告。

### 装插件：编辑器里一个入口，不用碰终端

编辑器**顶栏右侧的「插件」按钮**（拼图图标，`⋯` 菜单里也有一个）。粘一个 git 地址、npm 包名，或者选一个本地目录，剩下的自动做完：

```
识别来源 → 下载/克隆 → npm install → npm run build → 放到 plugins/ → 确认宿主能识别
```

- **先判断，再下载**：npm 只读 registry 上那一个版本的清单（几 KB，不拉 tarball）；
  git 只取目录树（`--filter=blob:none`，几十 KB），确认真是插件才开始拉文件；
  本地目录直接看。判断不过就停——不装依赖、不构建、不留文件
- **有 build 脚本就替你跑**；没有就跳过（作者可能已经提交了产物，也可能是纯内容插件）
- **只装用得上的依赖**：有构建才装 devDependencies，否则只装运行时依赖
- **npm 源默认国内镜像**（`registry.npmmirror.com`），装依赖通常几秒；要官方源或私有源，
  在面板的 `npm 源` 一行改（会记住，对之后所有安装生效）
- 全过程有步骤条和实时日志，失败时能直接看到是哪条命令、报了什么错
- 失败的安装**不会留下半个插件**：先在 `plugins/.staging/` 里装好、构建好，成功后才整体改名就位
- 装完立刻生效，不用重启；此前被停用过的 id 会被重新启用
- 日志落盘在 `data/plugin-installs/<job>.log`
- 预检只能看**声明**（`remotionStudio` 字段、`main`/`exports`、keywords、根目录里的 `skills/`），
  看不到代码。作者什么都没写的话会被误判——面板上会多一个「仍然安装」按钮，确认后照装不误，
  装完它会出现在「未识别的目录」里，随时能删

列表里每个插件可以直接**停用 / 启用**（文件不动）、**重建**（改了源码时重跑 install + build）、
**卸载**（不删文件，挪到 `data/.plugin-trash/`，后悔了能捡回来）。

### 不想用面板？（或者面板里装失败了）

手动把文件夹放进来仍然有效，只是依赖和构建要自己解决：

```bash
cd plugins/我的插件
npm install && npm run build
```

宿主**不会**在扫描目录时偷偷执行任何东西——只有你明确点了「安装 / 重建」才会起子进程。

没构建的话，`list_plugins` 和面板都会明确告诉你缺什么：

```
入口：⚠ 不可用 —— package.json 把入口指向 dist/index.mjs，但这个文件不存在
      在该插件目录执行：npm install && npm run build
```

完整示例：`plugins/_example-engineering/`。

## 文件处理：原文件永远不动

`media:process` 跑在素材入库的那一刻。产出的东西写成**新文件**：

```
你上传           1712ab-cd.jpg
落库（原文件）   1712ab-cd.jpg               ← 一直保留，回滚全靠它
处理产物         1712ab-cd@x1y2z.jpg         ← 工程引用这个
```

`@` 后面是**处理器指纹**（启用了哪些插件 + 各自版本）。这带来三个性质：

| 场景 | 结果 |
|---|---|
| 同一套插件重复跑 | 同名，不产生垃圾 |
| 换了插件 / 升了 version | 换新名字，新旧可对比 |
| 停用插件 | 新上传不再处理，**已处理的文件不受影响**（否则删个插件工程就花了） |

```ts
// plugins/我的处理/plugin.ts
export default {
  "media:process": async (ctx) => {
    if (ctx.kind !== "image") return null;      // 不管的就不动手
    if (!ctx.ffmpeg) return null;               // 这台机器没处理能力，原样入库
    const out = `${ctx.tmpDir}/out.jpg`;
    spawnSync(ctx.ffmpeg, ["-y", "-i", ctx.file, "-vf", "scale=1920:-2", out]);
    return { file: out, note: "限宽 1920" };    // 也可以直接 { buffer: ... }
  },
};
```

四件事必须知道：

1. **`ctx.file` 是只读的。** 写它会让宿主失去"原文件永远在"的保证，用户就回不去了。
   产物放 `ctx.tmpDir`（宿主处理完自动清），用 `{ file }` 或 `{ buffer }` 返回。
2. **返回 `null` 表示"看过但不动手"**，不算错误。抛错才会被记成失败。
3. **自动处理只对新上传生效。** 已有素材用 `reprocess_assets`，默认只预览。
   它产出新文件但**不会自动改工程的引用** —— 换不换由你决定。
4. **超时 60 秒，并发 1。** 在等上传的请求里跑，不能拖死服务。
   注意 `Promise.race` 只能救 async 卡住；插件里写 `while(true){}` 会把整个进程卡死，
   宿主没有任何办法中断它。

`ctx.ffmpeg` 指向 Remotion 自带的那个（装了 Remotion 就一定在），所以不需要为了处理图片
给宿主装 sharp。示例：`plugins/_example-media/`。

## 场景组件：需要重新打包的一类

``` 
plugins/我的场景/
  scenes/
    rating-card.json     字段声明（编辑器据此生成属性面板）
    rating-card.tsx      React 组件（默认导出）
```

**为什么要重新打包**：渲染端是 webpack 打包 `src/index.ts`，插件的 `.tsx` 靠生成文件
（`src/_plugins.generated.ts`）变成静态 import 才能进去。所以放进来之后要重新打包一次
——服务端渲染前会自动做，编辑器里用「插件」面板的「重建」也行。

> 2026-11-06 起"必须放项目内"这条限制已经不存在了：插件目录只有一个，且就在工程根内，
> "装在哪"和"能不能被打包"永远是同一个答案。

json 的格式（字段支持 text / number / boolean / enum / stringArray / objectArray）：

```json
{
  "type": "my-rating",
  "name": "评分卡",
  "category": "数据",
  "summary": "一句话说明它适合什么内容",
  "duration": { "default": 120, "min": 45, "max": 600 },
  "fields": [
    { "key": "title", "type": "text", "label": "标题", "default": "综合评分" },
    { "key": "score", "type": "number", "label": "分数", "default": 8.6, "min": 0, "max": 10 },
    { "key": "tone", "type": "enum", "label": "语气", "options": ["克制", "热烈"], "default": "克制" }
  ]
}
```

组件里只能 import `@studio/sdk` 和 `remotion`，不要写 `../../shared/...`
（相对路径会随目录深度失效）：

```tsx
import { useSceneLayout, SceneFrame, useEnter, type Theme } from "@studio/sdk";

type Props = { theme: Theme; title: string; score: number; tone: string };

export default function MyRating({ theme, score }: Props) {
  const { u, h } = useSceneLayout();
  const enter = useEnter(0);
  return <SceneFrame theme={theme}><div style={{ opacity: enter.opacity }}>{score}</div></SceneFrame>;
}
```

三条硬规矩（违反了换画幅就崩、换主题就脏）：
1. **禁止写 px**：尺寸用 `u(n)`（短边百分比）、字号用 `h(n)`；
2. 颜色从 `theme.palette` 取，不要写死；
3. 入场动画用 `useEnter(delay)`，它处理了「动效强度=0」的降级。

改完场景组件要等一次**重新打包**（几十秒，自动触发，日志会打「检测到场景源码变更」）。
技能/风格/问诊改完是立刻生效，不用等。

**编辑器重启比渲染更严格**：编辑器是另一个 bundle（`web/` → Vite），只吃 `dist/web`。
新装/改过的场景组件，要等 `npm run build`（或重启 `npm start`，它会自己重建）之后
才能在编辑器里看到——否则会出现"服务端能选、渲染能出、编辑器画布全黑"，
因为编辑器那份 `SCENE_COMPONENTS` 里根本没有这个组件。
生成文件 `src/_plugins.generated.ts` 是构建产物（已 gitignore）：
它写死了 `plugins/<某人的插件>/scenes/x` 这种路径，跟着仓库走会让别人 clone 后 build 失败。

**每个字段都要给 default**（或标 `optional: true`）——新建这种场景时 props 是空的，
没有默认值 zod 会当场拒。

## 流程钩子：不改数据，只给意见

`plugin.ts` 默认导出一个对象，键是钩子名：

```ts
export default {
  "audit:rules": (ctx) => ({ warnings: ["开场太短了"] }),
};
```

| 钩子 | 什么时候被调用 | ctx 里有什么 |
|---|---|---|
| `audit:rules` | 调 `audit_project` 体检时 | `{ brief, project, lock }` |
| `ops:before` | **写入之前**（还没落库，可以拦） | `{ before, ops }` |
| `ops:review` | 每次写入工程之后（已落库） | `{ before, after, ops }` |
| `brief:derive` | 推导设计锁时 | `{ brief, lock }` |

返回 `{ blocking?, warnings?, passed?, lockRules? }`，都是字符串数组，全部可省。
宿主管家会自动加 `[你的插件id]` 前缀——用户必须看得出这条不是宿主的判断。

**`ops:before` 的 `blocking` 是"否决"，不是"提醒"**：非空就让这一批 op 整批失败，
工程一个字都不动（rev 不涨、撤销栈干净、历史里没有这一笔），调用方会收到错误说明。
它在**只有一处**被调用——写库前，`applyOps` 之前。

`ops:review` 里返回 `blocking` **拦不住**（已经写进去了），只会变成"⚠️ 已写入，需手动修"。
要拦就用 `ops:before`，要事后提醒就用 `ops:review`。

三条边界：

1. **同步**。钩子跑在保存工程/自检的同步路径上，不能 `await`、不能发网络请求。
   超过 30ms 会被记一条"太慢"。
2. **只读**。入参是深冻结快照，改它直接抛错。想让数据变，请做成 MCP 工具，别指望钩子。
3. **不需要声明权限**。宿主不把 fs / fetch / 子进程交给钩子插件，它只拿到数据。

⚠️ **但代码就是代码**：`plugin.ts` 会被 `import()` 执行，顶层就能读写文件。
这里的"只读"是 API 约定，**不是沙箱**。装一个代码插件 = 在这台机器上装一个程序，
只装你信得过的。

改完 `plugin.ts` **立刻生效**（不用重启）：宿主会把它重新打包成一个带内容指纹的临时模块再加载。

完整可运行示例：`plugins/_example-audit/`（把 `plugin.ts.example` 改名成 `plugin.ts` 即生效）。

## 工具插件：给 agent 加一个能干活的功能

同一个 `plugin.ts` 里再加一个 `tools` 数组，agent 就能 `tool_search` 到它、`tool_call` 调它：

```ts
export default {
  tools: [{
    name: "my_prefix_reading_speed",          // 带插件前缀，撞内置名会被拒
    description: "逐幕算语速，挑出过快/过慢的幕",  // agent 靠它决定要不要调
    params: {
      projectId: { type: "string", required: true, desc: "工程 id" },
      dryRun:    { type: "boolean", default: true, desc: "true=只预览" },
    },
    async run(args, ctx) {
      const p = ctx.readProject(args.projectId);   // 需要 project:read
      return `共 ${p.scenes.length} 幕`;
    },
  }],
};
```

能力（`ctx` 上只有这些，且每一条都要求权限）：

| 方法 | 需要 |
|---|---|
| `ctx.listProjects()` / `ctx.readProject(id)` | `project:read` |
| `ctx.applyOps(id, ops)` | `project:write` |
| `ctx.log(msg)` | 无 |

权限写在 `manifest.json`：

```json
{ "permissions": ["project:read", "project:write"] }
```

没声明就调用 → 直接抛 `PermissionDenied`，报错里说清缺哪一条。

**必须说清：权限不是沙箱。** `plugin.ts` 是任意代码，`import fs` 就能绕过全部检查。
权限声明的真实作用是**知情同意**——用户 `list_plugins` 能看到"这个插件要改我的工程"，
再决定装不装。它挡住的是"通过宿主 API 的越权"，挡不住恶意代码。

参数**不要 `import { z } from "zod"`**：插件带进来的那份 zod 和宿主那份不是同一个实例，
schema 会静默失效。只声明数据（`string` / `number` / `boolean` / `enum` / `stringArray`），
宿主用自己的 zod 建 schema。

三条硬规矩：**名字带前缀**（撞名会被拒）、**写入类工具必须有 `dryRun` 且默认 `true`**、
**出错就抛**（吞掉返回空字符串会让 agent 以为成功了）。

`render` / `net` / `exec` / `assets:*` 有定义但**没有对应 API**，声明了也用不上
（`list_plugins` 会标出来）。

可运行示例：`plugins/_example-tool/`（语速体检 + 批量编号）。

## 文本处理：在字进工程之前改它

字幕和稿件不是文件，是字段。所以"用我的插件处理字幕"= 在文本**写进工程之前**改写它：

```ts
export default {
  "text:transform": (ctx) => ctx.text.replace(/我们的产品/g, "星河 OS"),
};
```

| ctx.kind | 什么时候 |
|---|---|
| `subtitle` | `set_subtitle` 写字幕时（**拆分之前**，拆完再改会让每屏字数算错） |
| `script` | `save_script` 写稿件时（`sourceText` 用户原话不动） |
| `brief` | 需求契约（多数插件应该像示例那样跳过） |

多个插件按 id 顺序串成一条链：上一个的输出是下一个的输入。

**必须幂等**——处理两次要和处理一次一样，否则 agent 反复保存会让字幕越改越远。
示例里那句「循环删到删不动」就是为这个。

宿主的三道护栏：返回空字符串**拒收**、输出暴涨**拒收**、抛错**跳过并继续**。
超过 20000 字整条跳过（它跑在保存路径上）。被改动时回执里会写「插件处理：「x」22→16 字」。

已有工程想补处理：调 `transform_project_text`（默认只预览）。

可运行示例：`plugins/_example-text/`（术语表 + 口头禅 + 全角数字）。

## 写坏了会怎样

不会拖垮服务。`list_plugins` 会把这个插件单独标成"加载失败"并给原因，
其余插件与内置功能照常。修好之后不用重启，下一次调用就重新扫描。

## 从哪开始

- **加内容**（技能/风格）：`cp plugins/_example-content plugins/我的第一个插件`，改里面的 md
- **改问诊**：看 `plugins/_example-brief/`，把 `steps.json.example` 改名成 `steps.json` 就生效
- **加规则**（画质守门员那类）：看 `plugins/_example-audit/`，把 `plugin.ts.example` 改名成 `plugin.ts`
- **加工具**（给 agent 用）：看 `plugins/_example-tool/`，同样改名；它示范了只读 + 写入两种工具和权限声明
- **改字**（术语表/品牌名）：看 `plugins/_example-text/`，同样改名；它示范了幂等的写法与宿主护栏
- **洗素材**（压缩/剥元数据/统一响度）：看 `plugins/_example-media/`，同样改名；它示范了
  「什么情况下该返回 null」——这比"能处理什么"更容易写错
- **做成工程**（有依赖 / 要发 npm / 多人维护）：看 `plugins/_example-engineering/`，
  它是唯一一个开箱即用的示例——因为产物 `dist/` 已经提交了

七份示例都可以整个删掉，不影响任何东西。
