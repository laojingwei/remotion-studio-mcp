# 插件是怎么生效的（示例技能）

> 这篇技能的唯一作用是**证明插件能用**。它在 `plugins/_example-content/skills/` 下，
> 只要它出现在 `list_guides` 里，就说明插件系统是通的。看完可以整个文件夹删掉。

## 三条规则

1. **放进去就生效**：`plugins/<任意文件夹名>/skills/*.md` 会被 `list_guides` / `get_guide` 读到，
   不需要重启、不需要重新打包、不需要改任何配置。
2. **同名让位**：插件技能名和内置技能重名时，**内置优先**。内置技能被 `start_guide` 的流程直接引用，
   被顶掉会让整条引导断线。想加东西就起个新名字。
3. **不需要 manifest**：上面那个 `manifest.json` 只是演示。删了它，这个插件照样工作——
   宿主会按目录结构推断出「这里有 skills/ 和 styles/」。

## 一个插件能放什么（L0，目前支持的部分）

| 目录 | 内容 | 生效位置 |
|---|---|---|
| `skills/*.md` | 技能指南 | `list_guides` / `get_guide` |
| `styles/*.md` | 风格规则 | `list_styles` / `get_style` / `apply_style` |
| `styles/presets.json` | 风格预设（可一键套用的色板/字体/转场） | `apply_style` 直接落字段 |

写风格时参考 `server/styles/_template.md`；写技能时看一眼 `server/skills/` 里任意一篇的开头。

## 怎么验证

改完任意一篇 md，**不用重启**，直接让 agent：

```
get_guide("plugin-smoke-test")
```

能读回这一篇，就是通的。读不到就先调 `list_plugins` 看这个插件有没有加载失败。
