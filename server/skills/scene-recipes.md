# 版式配方（39 种场景速查）

## 封面 / 开场
| 类型 | 适用 | 要点 |
|---|---|---|
| title | 开场、章节标题 | 主标题 ≤ 9 字，副标题一句 |
| hero | 发布会/开场冲击力 | 超大标题 + 渐变光斑 |
| aurora | 氛围感最强开场 | 多层霓虹光斑 |
| neon | 科技/赛博 | 网格 + 发光描边 |
| life / game / tech / edu / live / shop | 垂类封面 | 各带主标题 + 副标题 |

## 文字 / 金句
| 类型 | 适用 | 要点 |
|---|---|---|
| bigtext | 态度/情绪/金句 | 一句超大字 |
| quote | 金句 + 出处 | 版心窄，超过 7 字就折行，长句用 bigtext |
| caption | 口播字幕 | 大字幕 + 说话人 |
| stars | 结尾/品牌 | 星点 + 光晕 |

## 列表 / 数据
| 类型 | 适用 | 要点 |
|---|---|---|
| bullets | 2–5 条要点 | 竖屏单列；5 条会显得密 |
| list | 带序号榜单/清单 | 序号自带，别在 title 写 01/02 |
| stats | 2–4 个关键数字 | 3 个已改单列，不再 2+1 |
| chart | 动态柱状图 | 适合趋势；`data[].color` 可单独指定每根柱子颜色（含数值颜色） |
| bars | 2–4 条进度 | 技能/完成度 |
| ring | 百分比圆环 | 成果/进度 |
| table | 3 列 2–3 行 | 表头写死（项目/基础版/进阶版） |

## 对比 / 流程 / 对话
| 类型 | 适用 | 要点 |
|---|---|---|
| compare | 前后对比 | 左右两栏；`
` 不生效，写短句流 |
| versus | 两强 VS | 中间 VS 徽标 |
| steps | 2–4 步流程 | 竖屏纵向 |
| timeline | 时间节点 | 窄栏，适合节奏条 |
| chat | 对话气泡 | 答疑/案例 |
| countdown | 倒计时 | 直播/促销 |

## 图片 / 视频 / 商品
| 类型 | 适用 | 要点 |
|---|---|---|
| image | 全屏图 + 压角标题 | 实拍/截图 |
| split | 左文右图（竖屏上图下文） | 产品/教程 |
| gallery | 2–4 张图网格 | 产品/旅行 |
| team | 2–4 位成员 | 头像 + 角色 |
| shop | 商品展示 | 价格/卖点 |
| pricing | 2–3 档价格 | 中间档高亮 |
| rating | 星级 + 用户原话 | 口碑 |

## 收尾
| 类型 | 适用 | 要点 |
|---|---|---|
| outro | 行动号召 | 一句话 |
| qr | 二维码占位 + 引导 | 引流 |
| empty | 只有背景，自己放元素 | 完全自定义 |
| tags | 标签云 | 关键词/话题 |

## 元素外观（agent 可自由调）

`add_element` / `update_element` 里所有元素都支持这些参数（按短边百分比）：

- 版式：`radius` 圆角、`border`+`borderColor`、`shadow`（box-shadow）、`clipPath`（异形裁切）
- 效果：`filter`（blur/brightness/saturate…）、`blendMode`（mix-blend-mode）
- 文字：`fontFamily`、`lineHeight`、`letterSpacing`、`textAlign`、`fontStyle`、`underline`、`maxWidth`（自动换行）
- 图片/视频：`fit`（cover/contain/fill）
- SVG：`strokeLinecap` / `strokeLinejoin`
- 背景 `bg` 支持任意 CSS（含 `linear-gradient(...)`）
- `style` 参数可传任意内联 CSS（camelCase 键），最后应用、可覆盖上面所有预设（如 `{ textShadow: '0 0 20px #0ff', transform: 'skew(-8deg)' }`）

## 通用坑

- **`durationInFrames` 是"元素出现多久"，不是出场动画时长**：不传或传 -1 = 撑到场景结尾；写了正数就固定那么长，忘了改会导致中途消失
- props 里**类型不认识的字段会被静默丢弃**（现在会回 ⚠️ 提示）；改完 `get_scene` 回读确认
- 换 SVG 造型直接用 `update_element(svg=...)`，不用删了重加

- items 必须是对象，key 见 `list_scene_types`；未知 key 静默丢弃，写完 `get_scene` 回读
- `timeline` 的 title 会被丢弃，只存 time + text
- 3 个 items 的 stats/cards/bullets 会排成单列/整行，按内容需要选 2 或 4 更平衡
- 长文案优先换 `list` / `bullets`，不要在 `quote` / `compare` 里硬塞
