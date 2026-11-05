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
  manifest.json          可选——只有需要声明版本/权限时才写
```

**没有 manifest 也能用**：宿主按目录结构推断。这是刻意的——想加一份指南的人
不该先读三页文档写 JSON。

## 现在支持什么

L0 内容层：技能、风格（含预设）。3D 配方、元素库、转场、特效、场景组件属于后续批次，
见 `docs/2026-11-05-插件化架构与实施计划.md`。

## 写坏了会怎样

不会拖垮服务。`list_plugins` 会把这个插件单独标成"加载失败"并给原因，
其余插件与内置功能照常。修好之后不用重启，下一次调用就重新扫描。

## 从哪开始

最省事的一步：`cp plugins/_example-content plugins/我的第一个插件`，改里面的 md。
那份示例里有一篇技能和一套风格，都可以直接删改。
