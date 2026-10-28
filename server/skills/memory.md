# 记忆与模板沉淀

## 三类记忆（按类分开，别混在一起）

| 类 | 记什么 | 例子 |
|---|---|---|
| `pitfall`（坑） | 什么问题、怎么解、什么条件下触发 | 「素材时长没量 → 4 秒音频显示到场景结尾；先 get_asset_info」 |
| `preference`（偏好） | 用户的审美、禁忌、常用风格 | 「竖屏口播，主色 #C6F24E，标题不用感叹号」 |
| `recipe`（配方） | 有效的版式组合、文案结构、参数组合 | 「数据页用 stats(3 个) + 口播短句，转场 fade 12 帧」 |

## 什么时候用

- **开工前**：`recall` 三类各查一次（当前工程 + 全局）
- **踩坑后**：立刻 `remember(pitfall, ...)`，写清触发条件和解法
- **用户提出要求/反馈**：`remember(preference, ...)`（全局）
- **发现好组合**：`remember(recipe, ...)`，如果整片结构好，再 `save_template` 存模板并记下模板 key

## 作用域

- `pitfall` / `preference`：默认 **global**（跨工程复用）
- `recipe`：可以 global，也可以 project（只对当前片子有效就存 project）

## 模板沉淀

- 整片结构好 → `save_template(name, description, tags)`
- 单幕版式/元素组合好 → 记进 `recipe`，下次用 `apply_ops` / `add_element` 复刻
- 存模板时 description 写清「适合什么内容」，tags 用 2–4 个关键词（如 `口播,数据,快节奏`）

## 检索技巧

- `recall(kind, query)` 的 query 用关键词，不要整句
- 没有命中就换更短的词（如「转场」「时长」「素材」）
- 检索结果只是参考，最终以当前工程实际为准
