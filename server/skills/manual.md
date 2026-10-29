# Agent 使用全书（103 个工具 = 4 常驻 + 99 按需 + 能力地图 + 铁律）

给 agent 的完整说明书。**你不需要读源码、不需要试探参数**：这台机器能做什么、怎么组合、
为什么没生效，全部在这页和 12 篇指南里。

**工具分两层（先搞懂这个）**：
- **常驻核心 4 个**：`start_guide`（开工入口）、`get_guide`（读指南/本书）、`tool_search`（找工具）、`tool_call`（执行工具）
- **其余 86 个**：不在常驻列表里。用法：`tool_search("画中画")` 找到工具（返回名字/说明/参数表）→ `tool_call(name="move_scene", args={...})` 执行。
  全量目录：`tool_search(all=true)`；某几个工具的完整文档：`tool_search(names=["add_element"])`
- 本书的工具全表（§3）覆盖**全部** 99 个——先查表再搜索，比盲搜快

**读法**：
- 第一次接活：通读 §1 行为契约 + §2 能力地图，其余用到哪节读哪节
- 干活中想不起工具：直接跳 §5「我想…」意图速查
- 只读某一节：`get_guide("manual", "意图速查")`（按标题关键字匹配）

---

## 0. 调用协议（复制即用）

常驻只有 4 个工具，其余全走 `tool_call(name, args)`——**业务参数一律包在 `args` 里**，扁平传会被拒：

```
读   {"name":"get_project","args":{"projectId":"p_xxx"}}
写   {"name":"update_scene","args":{"sceneId":"s1","props":{"title":"新标题"}}}
批量 {"name":"apply_to_scenes","args":{"tool":"set_subtitle_style","args":{"style":{"bottom":24}},"applyToAll":true}}
```

### 易错对照表

| 容易写错 | 正确 | 说明 |
|---|---|---|
| `{step:3, goal:"..."}` 直接传 | `{"name":"save_brief","args":{...}}` | 参数必须包在 args 里 |
| `set_format` | `set_formats` | 没有单数版本；值是数组 |
| `preview_frame(frames:[...])` | `preview_frames(frames:[...])` | 单个是 `preview_frame(frame)` |
| `format: "landscape"` | `formats: ["landscape"]` | 预览/渲染的字段是复数 |
| `percent: "30%"` | `percent: 30` | 组件自己加 %，传字符串会变 30%% |
| `letterSpacing: 5`（中文标题） | `letterSpacing: 0` | 单位是 px，中文大标题会裂开 |
| 50 幕一次 `save_storyboard` | 分多次 + `append=true` | 一次传太长会被截断 |
| 逐幕 `set_subtitle_style` × 50 | `apply_to_scenes(tool="set_subtitle_style", applyToAll=true)` | 全片统一的东西用批量通道 |

## 1. 行为契约（先读这个）

1. **开工先 `start_guide`**（带 projectId 返回当前进度）。它告诉你走到哪一步、该读哪篇指南、下一步调什么。
2. **两层调用**：隐藏工具一律 `tool_call(name, args)` 执行——别因为「工具面板里没有它」就认为做不到；
   也别绕过 `tool_search` 盲猜工具名（猜错了报错里会给相近名提示）。
3. **不试探、不猜参数**。`tool_search` 返回的 params 就是参数全集；不确定行为就 `get_guide` 读对应指南，或 `list_guides` 看有什么。
4. **不读工程源码**。运行时行为以指南为准；指南确实没写的，用 `create_project` 建临时工程做最小实验，**不要在用户工程上试错**。
5. **不发明字段**。props 里不认识的 key 会被剥掉并写 ⚠ 告警（返回 summary 里能看到）；写完拿 summary 核对，不要整包回读。
6. **报错是答案不是障碍**。报错带字段级原因（第 N 个操作、哪个字段、为什么），按它改一次就过；换写法反复试是浪费。
7. **写操作只看 summary**。每个写工具的返回就是权威结果（含自动吸附、截断、改名等副作用），不用再 get_project 全文确认。
8. **批量优先 `apply_ops`**。多步改动一次提交、整批原子（中途任何一条失败整批不落盘）；需要新对象 id 的分两批。
9. **改完就自检**。自检 → 修复 → 再汇报是铁律，清单在 `get_guide("qa")`。

---

## 2. 能力地图（这台机器能做什么）

| 能力域 | 能做到 | 入口 |
|---|---|---|
| 工程 | 多工程并存（**可列/可切换**，当前工程标 ★ 并落盘，重启接上次）、模板沉淀/套用、历史快照（50 份，可回滚任意版本）、zip 导入导出 | `list_projects` `switch_project` `create_project` `save_template` `delete_template` `get_history` `restore_rev` `export/import_project` |
| 场景 | **39 种内置版式**（封面/文字/列表/数据/对比/流程/对话/收尾）+ **freeform 自由画布**（自排 svg/div，上限 40 个元素） | `list_scene_types` `add_scene` `update_freeform_element` |
| 元素 | 场景内图片/文本/形状/视频/音频元素，rich 外观全套（圆角/边框/阴影/滤镜/混合/裁切/字体/行高/字距/对齐/斜体/下划线） | `list_element_library` `add_element` `update_element` |
| 动效 | 元素级关键帧动画（`anim[].from/to` 绝对值）、全片动效强度三档（0 关 / 1 标准 / 2 更强） | `update_element(anim)` `set_theme(motion)` |
| 特效 | **11 种全屏区间特效**（闪白/扫光/震动/冲击/旋转/故障/模糊/暗角/去色/呼吸/频闪）+ custom，**支持循环**（单次时长 + 到几秒停） | `list_effect_types` `add_effect` `update_effect(loop)` |
| 转场 | 幕间转场（fade/slide 等 8 种，时长可调；**所有版式通用，自由画布也是场景**）；带字幕的幕转场 ≤ 6 帧 | `set_transition` |
| 多轨 | 任意条轨道、画中画小窗（缩放/位置/圆角）、同轨自动防重叠 | `move_scene` `set_scene_box` |
| 音频 | TTS 配音（单段/多段**自动对齐幕长并写字幕**）、BGM 全局轨、场景内音频裁时间窗、音量调节 | `tts_narration` `add_audio_track` `set_audio` |
| 字幕 | 硬字幕烧录（**一屏 8–16 字、不带标点**，写入自动拆段）+ SRT/VTT 导出，两者同一套时间 | `set_subtitle` `fix_subtitles` `set_subtitle_style` `export_subtitles` |
| 风格 | **44 种风格规则库**（12 种可一键套用：改主题色+转场+推荐版式）、风格文件可改造/混搭/自定义 | `list_styles` `get_style` `apply_style` |
| 画幅 | 多画幅并存（9:16 / 16:9 / 1:1 / 自定义 16–7680） | `set_formats` |
| 预览 | 单帧/多帧抽帧（按场景偏移）、真实浏览器渲染前 dryRun 预检 | `preview_frame(s)` `render_video(dryRun)` |
| 渲染 | 正式出片（可等完成）、进度查询、取消、历史产物清理 | `render_video` `get_render_status` `cancel_render` `cleanup_renders` |
| 素材 | **分两层目录**：`assets/library/`（我的素材，跨工程复用）+ `assets/projects/<工程id>/`（工程私有，删工程连带清）；素材库上传/列表/改名、探测真实时长、图标装饰元素库 | `upload_asset` `list_assets` `list_project_assets` `delete_project_asset` `organize_assets` `get_asset_info` |
| 自检 | 只读诊断：空场景/素材缺失/音频超长/freeform 异常/字幕问题，一条条给修法 | `check_project` |
| 需求管线 | 9 步问诊落需求 → 用户确认 → 定稿件类型 → 稿子确认 → 分镜表确认 → 一次建好全部幕+字幕 | `intake` `save_brief` `confirm_brief` `save_script` `confirm_script` `save_storyboard` `build_storyboard` |
| 交付闸口 | 渲染前请用户到编辑器看片（抽帧查不出节奏/转场/音画错位）；用户也可自己导出；封面单独出图 | `request_review` `confirm_review` `render_cover` |
| 协作与记忆 | 给用户发话/收用户消息；跨会话记坑/偏好/配方 | `reply_user` `get_user_messages` `remember` `recall` |
| 布局辅助 | 网格坐标计算、多元素对齐/等距分布 | `layout_grid` `align_elements` |

---

## 3. 工具全表（99 个，按域）

> 除 4 个核心工具（start_guide / get_guide / tool_search / tool_call）外，
> 下面的工具都用 `tool_call(name, args)` 执行；参数表用 `tool_search(names=["工具名"])` 取。

**入口与指南**：`start_guide`（开工入口，必先调）· `list_guides` · `get_guide(name, section?)`

**工程**：`list_projects`（★ = 当前）· `switch_project` · `create_project` · `get_project` · `delete_project` · `list_templates` · `save_template` · `delete_template` · `export_project` · `import_project` · `get_history` · `restore_rev`

> **当前工程怎么变**：只有 `create_project` / `import_project` / `switch_project` /「删掉的正好是当前工程」这四种情况会改。**其余工具即使显式传了 `projectId`，也只影响这一次调用，不会改当前工程**——所以「先 `get_project(别的工程)` 看一眼，再回来干活」是安全的。

**批量与样张**：`probe_style(slugs[])`（开工前风格样张，同幕出 2–3 张图给用户挑）· `apply_to_scenes(tool, args, applyToAll|sceneIds)`（全片统一改动的批量通道，替代 50 幕 × N 轮）

**字幕**：`set_subtitle`（传整句即可，自动清标点+一屏一句，返回拆分预览）· `fix_subtitles`（旧工程/长字幕批量重拆，`dryRun` 预演）· `export_subtitles`（SRT / VTT）

**需求与分镜**：`intake(step)`（1–9 接单 / 10 稿件 / 11 观感与规格） · `save_brief(step?, 字段…, assumed[])` · `get_brief` · `confirm_brief`（确认前不能开建）· `save_storyboard(shots[])` · `get_storyboard` · `build_storyboard`（`shot=N` 只建一幕做风格帧；`replace=true` 全量建）

**稿件**：`save_script(segments[])`（一段一幕，带每段预估秒数；改稿会让确认失效）· `get_script` · `confirm_script`（稿子没确认不能写分镜，`scriptType=无稿` 除外）

**场景**：`list_scene_types` · `add_scene` · `update_scene` · `set_scene_type`（换版式，同名 key 迁移）· `set_scene_timing` · `duplicate_scene` · `reorder_scenes` · `remove_scene` · `move_scene`（绝对帧/换轨）· `set_scene_box`（画中画）· `set_transition` · `set_transitions`（批量）

**批量**：`apply_ops(ops[])`——**整批原子**，op 形状支持单工具扁平写法，报错带「第 N/M 个操作」

**元素**：`list_element_library` · `add_element` · `update_element` · `remove_element` · `set_transform`（自由元素变换）· `add_freeform_element` · `update_freeform_element` · `remove_freeform_element` · `layout_grid` · `align_elements`

**特效**：`list_effect_types` · `add_effect` · `update_effect` · `remove_effect`

**音频**：`set_audio`（BGM，含 **ducking 人声避让**；volume 1 = 原音、可到 5 = +14dB）· `balance_audio`（**响度配平**：段间大小不一）· `compress_audio`（**段内压缩**：一段里忽大忽小）· `analyze_audio`（测 BPM/拍点 + 响度）· `set_beat_grid`（按 BPM 建卡点网格）· `tts_check`（配音前预检）· `add_audio_track` · `update_audio_track` · `remove_audio_track` · `get_tts_config` · `set_tts_config` · `tts_synthesize` · `tts_narration(segments[], applyToScenes)`

**字幕**：`set_subtitle`（自动拆段：清标点 + 一屏一句，返回拆分预览）· `fix_subtitles`（旧工程/长字幕批量重拆，`dryRun` 预演）· `set_subtitle_style` · `export_subtitles`（SRT / VTT）

**素材**：`upload_asset`（`registerToLibrary` 决定进库还是进本工程目录）· `list_assets`（**只列共用库**）· `list_project_assets`（本工程目录）· `delete_project_asset` · `organize_assets`（把旧版散在 assets 根下的文件归位，默认 dryRun）· `rename_asset` · `delete_asset`（被工程引用的文件只删条目、保留文件）· `get_asset_info`（纯 Node 读文件头，不依赖外部工具）

> **文件落在哪**：`public/assets/library/` 是「我的素材」（跨工程、删工程不动）；
> `public/assets/projects/<工程id>/` 只属于那个工程，**删工程时连带清**（被别的工程/素材库引用的会留下并写进回执）。
> 旧版散在 `public/assets/` 根下的文件用 `organize_assets` 一次性归位（先 dryRun 看方案）。

**风格与主题**：`list_styles` · `get_style` · `apply_style` · `set_theme`（配色/字体/motion）· `set_formats`

**验收与渲染**：`render_cover`（某帧导出封面 PNG）· `request_review`（请用户到编辑器看片，返回地址+重点看什么）· `confirm_review(approved, feedback[], selfRender)`（没通过 → `render_video` 拒绝）· `preview_frame` · `preview_frames` · `render_video`（`wait` / `dryRun` / `force`）· `get_render_status` · `cancel_render` · `cleanup_renders` · `refresh_bundle`（改了 public 素材后渲染前调用）

**自检**：`check_project`（只读，交付前必跑）

**协作与记忆**：`get_user_messages` · `reply_user` · `remember` · `recall`

---

## 4. 数据模型速览

- **工程** = `name + formats（多画幅）+ theme（配色/字体/圆角/motion）+ scenes[]`
- **场景（幕）** = `type + props（业务数据）+ start + durationInFrames + track + box（画中画）+ transition + subtitle + elements[] + effects[]`
- **总时长** = 所有轨最靠后的那一帧（`max(end)`），不是各幕相加
- **元素** = `kind（text/image/shape/video/audio）+ 内容 props + 外观（rich 全套）+ anim[]（from/to 是**绝对值**不是偏移）`
- **字幕**：`scene.subtitle` 是**一句一屏**（写入时自动清标点并按语义拆，每屏上限跟字号走）；烧录主轨，时间按字数比例分配；渲染与 SRT 共用同一套拆段
- **音频轨**：`audioTracks[]` 全局 BGM；场景内音频元素只裁时间窗，窗口内从文件第 0 秒播

---

## 5. 意图速查（我想…→ 工具组合）

> 下表所有非核心工具都经 `tool_call(name, args)` 调用。

| 我想要 | 怎么做 |
|---|---|
| 从零做一支片 | `start_guide` → 9 步问诊 → 确认 → 三提案 → 分镜 → build → 配音 → 自检 → 渲染（`get_guide("director")` 全流程） |
| 只改某幕文案 | `update_scene(props)` 或 `update_element`；**改过口播必须重新 `tts_narration` 重量** |
| 换一种版式 | `set_scene_type` → `get_scene` 回读确认字段迁移 |
| 加背景音乐 | `set_audio(src)` 基础设置 → `set_audio(volume=0.25)` 压到人声 20–40%（`get_guide("sound")`）。**只传要改的字段就够**（合并语义），其余配置不动；清掉避让/压缩曲线要显式传 `ducking=null` / `gainCurve=null` |
| 声音太小，想比原音更响 | `set_audio(volume=2.5)` / `update_element(audioVolume=2.5)`：**1 = 原音，上限 5（+14dB）**。回执会算峰值，会削波就警告 |
| 每段声音大小不一 | `balance_audio()`：按角色拉到统一响度（人声 -16 / BGM -23 / 音效 -18 LUFS）；先 `dryRun=true` 看方案 |（用户也可以在右侧背景音乐面板点「配平到 -23」，同一个算法）
| 一段里忽大忽小（副歌炸） | `compress_audio(ratio=3)`：按 200ms 测短时响度生成增益曲线，压平起伏；`clear=true` 恢复原动态 |
| BGM 压住人声 | `set_audio(ducking=true)`：有人说话自动压到 30%、句间回升；`ducking={depth:0.25}` 细化 |
| 做画中画 | `move_scene(start, track=1)` → `set_scene_box(scale, x, y, radius)` |
| 卡点 | 有 BGM 文件：`analyze_audio(src)` 拿 BPM + 拍点帧号（**置信度 <2.5 别自动用**，问用户 BPM 后 `set_beat_grid`）；再把转场/特效的 from 对着拍点放 |
| 配音前发现 TTS 没开 | `tts_check()` 探连通 → `tts_check(deep=true)` 验配置。**开工时做**，别等第 6 步 |
| 换全套视觉 | `list_styles` → `get_style` → `apply_style`（可套用的 12 种）或 `set_theme` 手调 |
| 数字/图表页 | `stats`/`chart`/`ring` 版式自带滚动；数据只能来自用户或可靠来源 |
| 元素动画 | `update_element(anim=[{frame,from,to}])`；弹簧手感 = 过冲关键帧（craft §4） |
| 完全自定义画面 | `freeform` 场景（`get_guide("freeform")`），上限 40 元素，`layout_grid`/`align_elements` 辅助排版 |
| 长片（>12 幕） | `get_guide("long-form")`：分章规划、分章配音、分章验收 |
| 找回历史版本 | `get_history` → `restore_rev` |
| 在多个工程之间切换 | `list_projects`（看 ★ 在哪）→ `switch_project(projectId)`；只带 id 看一眼不会改当前工程 |
| 清理模板/素材 | `delete_template(templateId)` / `delete_asset(assetId)`（内置模板不可删；被引用的素材文件会保留） |
| 出 SRT | `export_subtitles` |
| 交付前检查 | `check_project` → `render_video(dryRun=true)` → 抽帧复核 → 正式渲染 |

---

## 6. 铁律：为什么没生效

| 现象 | 真相 |
|---|---|
| props 写了没反应 | 未知 key 被 schema 剥掉，summary 里有 ⚠ 告警（原值→实际值）；按 schema 改 key |
| 元素中途消失 | **元素时长不随幕长变**。先 `tts_narration` 定幕长、再放元素；反了就 `update_element(durationInFrames)` 修 |
| 场景被推走 | 同轨不能重叠：撞上会被自动往后**吸附**，结果写在 summary 里；判重叠按时间先后不按数组顺序 |
| 拖主轨后邻居叠住 | 主轨 = 顺序即时间；`reorder_scenes` 后跟 `compact_main_track` 压实 |
| 元素画不出来 | `z` 必须 ≥ 0，负 z 画到背景下面 |
| 成片没声音 | 视频元素 `muted` 默认 true；音频元素默认 false。不传就按这个来 |
| 缩幕长弹回去 | 场景时长下限由版式决定（30–60 帧起），夹回是设计行为 |
| 音频窗口比文件长 | 不循环、播完静音，不报错；裁头用 `startFrom` |
| 转场看不出叠化 | 只有**下一幕的 transitionIn** + 两幕在主轨**首尾相接**才是真叠化（上一幕定格续画 N 帧）。中间有缝（钉死过起点）、画中画、只设 transitionOut → 各自淡到背景色，看起来是"黑一下再亮" |
| mp3 时长差 30–50ms | 编码器 delay，正常，不必修 |
| 转场时两行字幕重叠 | 带字幕的幕转场 ≤ 6 帧（实测约束） |
| apply_ops 一条失败全没了 | 整批原子是特性；把需要新 id 的操作分到下一批 |
| op 里写了拼错的字段 | 直接拒绝并报「第 N 个操作（op 名）有未知字段：X」+ 该操作的合法字段列表——不会静默丢弃。**嵌套对象同样检查**：`audio:{volume2:2}` / `element:{opacty:0.5}` 也会拒绝并给「是不是想写 volume / opacity」 |
| 改了文案回读没变 | 文案是**版式的 props**，不是 scene 顶层。`update_scene(patch:{props:{title:"…"}, 或 patch:{title:"…"})` 都行；写 `patch:{titel:"…"}` 会直接报错（以前报成功、rev 照涨、文案没变） |
| 回执说成功但什么都没变 | summary 里会有「⚠️操作（X）没有产生任何数据变更」：字段名错、层级错、或值本来就等于目标值（幂等重试）。见到这条就回读核对，别当成成功 |
| 改暗角越挂越暗 | 特效是区间效果（涨到峰再回落）；长片用 `loop=true` + `loopStopAfterSeconds` |
| 换版式后数据怪 | 同名 key 语义可能不同（title 在不同版式含义不同），`get_scene` 回读核对 |
| 音量拖不上去 | 上限是 **5**（不是 1）：1 = 原音、>1 放大。若卡在某个值，是峰值保护/ops 夹取，summary 里有实际值 |
| 预览音量没变、成片才变 | 音量 >1 时预览必须有 `useWebAudioApi`（已内置）；早期版本会 `Math.min(volume,1)`。遇到就报 bug，别怀疑耳朵 |
| 配平后仍不达目标响度 | 被**峰值上限**卡住（回执写"峰值限制"）：源文件本身太小声且峰值已满，只能换源 |
| 压缩后音量整体变小 | 压缩只压起伏不改整段平均响度，但**补与压是耦合的**：ratio 越大整体增益也跟着抬（同一素材 1→3→10 时均值 69%→119%→167%）。整体偏小先用 `balance_audio` 定基调 |
| ratio 调大了却没更平 | 已被 `maxCutDb`（默认 12dB）钉死，回执会写「N 个采样点已压到 maxCutDb 下限」；要更平就调大 `maxCutDb`。同理被 `maxGainDb` / 峰值卡住也会写出来 |
| 压缩后成片削波 | 曲线逐点按窗口峰值限幅（输出 ≤ -1dBFS），被夹多少写进回执。若整条都被峰值卡住，说明源素材已经到顶，换源或先降 `volume` |
| 字幕写不出粗体 | `subtitleStyle.bold` 是**数字字重 100–900**（不是布尔）；传 `true` 会按 700 归一 |
| 批量 op 里画中画没生效 | `set_scene_box` 扁平写法（x/y/scale）与 `box:{...}` 包裹都认；恢复全屏必须显式 `reset:true` |
| 导出报"工程数据校验失败" | 工程里有不合法的字段值（如布尔字重）。按报错路径用 update_scene/update_element 改回合法值——导出前自检是为了不让坏包流出去 |
| BGM 听不清人声 / 人声被盖住 | 先 `set_audio(ducking=true)`（有人声自动压到 30%）；还不够就把基础 `volume` 降到 0.2–0.25 |
| BPM 检测结果明显不对 | 置信度 <2.5 说明这段音乐没有清晰鼓点（纯人声/氛围/古典）。**别硬用**，问用户 BPM 再 `set_beat_grid(bpm=...)` |
| 素材库里搜不到刚上传的文件 | 图片/音频/视频现在都会入库，`upload_asset` 回执带 `asset:<id>`（可直接 `delete_asset`）。`list_assets` 默认 100 条、上限 500，截断时回执写「匹配 N 条，只显示最新 M 条」；要精准找就带 `query`。**注意 `list_assets` 只列共用库**，本工程目录用 `list_project_assets` |
| 素材到底在哪个目录 | `assets/library/<文件>` = 跨工程复用（删工程不动）；`assets/projects/<工程id>/<文件>` = 工程私有（删工程连带清）。`upload_asset(registerToLibrary:false)` 进后者 |
| 删工程后素材没了吗 | 工程私有目录会被清，但**被别的工程或素材库还引用着的文件会保留**（回执写「N 个仍被引用，保留」）；共用库里的东西一个都不动 |
| 根目录还堆着一堆老文件 | 调 `organize_assets`（默认 dryRun）看方案：只被一个工程引用的搬进该工程目录，多工程共用的进 `library/`，谁都不引用的留着给「清理未引用」。搬完会同步改写 project.json 的 URL |
| 素材库里有条目点开是空图 | 文件早已不在（`organize_assets` 回执会报「N 条指向的文件已经不存在」）。确认不要就 `delete_asset` 逐条删掉 |
| 改了半天没反应，回读发现改在别的工程上 | 检查是否用 `switch_project` 切走后又没传 projectId。显式 `projectId` **只影响本次调用**，不改变「当前工程」（这条曾经不成立：任何只读工具带 id 都会偷改指针，2026-10-28 修） |
| `list_projects` 没有 ★ / 每次读都换工程 | 指针指向了已删工程。现在会自愈（落到第一个存活工程并写回），无需处理 |

---

## 7. 指南索引（12 篇）

| 指南 | 解决什么 |
|---|---|
| `director` | 整片流程：9 步问诊、三提案、风格帧、批量搭建 |
| `craft` | 画面质感：惊艳公式、节奏模板、连续叙事三问、签名时刻、禁止清单 |
| `formats` | 用途→幕结构模板（10 种用途） |
| `sound` | 声音设计：BGM 选曲、戏剧曲线、混音、静音自检 |
| `long-form` | 超 12 幕/2 分钟：分章规划与验收 |
| `narration` | 口播写法、TTS 合成对齐、字幕 |
| `scene-recipes` | 39 种版式逐个速查（items 数量、文案长度） |
| `freeform` | 自由画布全部写法与坑 |
| `qa` | 分阶段自检清单、常见问题速查表 |
| `delivery` | 画幅、字幕样式、渲染、交付物清单 |
| `memory` | remember/recall 记什么、模板沉淀 |
| `tools-quickref` | 本书的薄入口（指向这里） |
