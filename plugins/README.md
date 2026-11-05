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
  manifest.json          可选——只有需要声明版本/权限时才写
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

## 写坏了会怎样

不会拖垮服务。`list_plugins` 会把这个插件单独标成"加载失败"并给原因，
其余插件与内置功能照常。修好之后不用重启，下一次调用就重新扫描。

## 从哪开始

- **加内容**（技能/风格）：`cp plugins/_example-content plugins/我的第一个插件`，改里面的 md
- **改问诊**：看 `plugins/_example-brief/`，把 `steps.json.example` 改名成 `steps.json` 就生效

两份示例都可以整个删掉，不影响任何东西。
