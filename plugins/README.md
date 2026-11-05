# plugins/ —— 放插件的地方

把文件夹丢进来就生效，不用重启。删掉就消失。这个目录本身不入库（示例插件除外），
所以你自己做的东西不会被 `git pull` 覆盖。

## 两个位置

| 位置 | 用途 |
|---|---|
| `<项目>/plugins/` | 跟这个项目走，适合团队共享 |
| `~/.remotion-studio/plugins/` | 跨项目通用，适合个人收藏，升级不覆盖 |

两处都生效。同名 id 时**项目内优先**。

## 一个插件长什么样

``` 
plugins/我的插件/
  skills/*.md            技能指南      → list_guides / get_guide
  styles/*.md            风格规则      → list_styles / get_style / apply_style
  styles/presets.json    风格预设      → apply_style 一键落字段
  brief/steps.json       问诊步骤      → intake / save_brief 按你的流程走
  scenes/*.json + *.tsx  场景组件      → 选择器里多一种画面（必须放项目内）
  plugin.ts              钩子 / 工具   → 说意见、改字、或加一个 MCP 工具
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

元素库、整片模板、3D 配方、转场、特效属于后续批次，
现在放进去会被识别但**明确标注不生效**（见 `list_plugins`）。
完整路线见 `docs/2026-11-05-插件化架构与实施计划.md`。

## 场景组件：唯一必须放项目内的一类

``` 
plugins/我的场景/
  scenes/
    rating-card.json     字段声明（编辑器据此生成属性面板）
    rating-card.tsx      React 组件（默认导出）
```

**为什么只能在项目内**：渲染端是 webpack 打包 `src/index.ts`，项目外的路径
（`~/.remotion-studio/plugins/`）进不了 bundle。内容类插件（技能/风格/问诊）没有这个限制。

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
| `ops:review` | 每次写入工程之后（已落库） | `{ before, after, ops }` |
| `brief:derive` | 推导设计锁时 | `{ brief, lock }` |

返回 `{ blocking?, warnings?, passed?, lockRules? }`，都是字符串数组，全部可省。
宿主管家会自动加 `[你的插件id]` 前缀——用户必须看得出这条不是宿主的判断。

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

五份示例都可以整个删掉，不影响任何东西。
