# 工具速查（入口页）

完整说明书在 **`get_guide("manual")`**：《Agent 使用全书》——136 个工具全表（4 常驻 + 132 按需）、能力地图、
「我想…」意图速查、落地铁律（为什么没生效）。本页只留最快的域索引：

**两层调用**：常驻核心 4 个（start_guide / get_guide / tool_search / tool_call）；
其余 132 个工具 `tool_search("意图")` 找 → `tool_call(name, args)` 执行（`all=true` 看全量目录，`names=[...]` 取完整参数表）。
这 131 个里有 **4 个退役别名**（旧名字，如 `rename_scene`）：搜索里不出现，但直接 `tool_call` 仍能命中原工具——老脚本不必改。

- 工程：list / switch / create / get / **archive（收进抽屉，不删文件）** / delete / 模板（含删除）/ 历史 / 导入导出
  （当前工程只在 create / import / switch / 删除当前工程时变；显式 projectId 只影响本次调用）
  测试工程太多用 `archive_project`（可逆），别用 `delete_project`（不可逆）；`list_projects` 默认不列已归档的
- 需求与分镜：intake → save_brief → confirm_brief → save_storyboard → build_storyboard
- 场景与元素：add/update_scene、`list_scene_types` 返回的默认开放类型（freeform / scene3d / iso / empty / 动效 / 氛围 / 插件）、元素/特效/转场。内置固定版式（scene-recipes 里那批）默认不在这张清单里，别主动用
- **3D 场景**：`add_scene(type="scene3d")`——抽象氛围用 preset（6 个母题），具体物体写 `graph` 场景图；
  写法与坑见 `get_guide("scene3d")`，字段全表 `list_scene_types(type:"scene3d")`
- **转场**：`list_transitions`（内置 12 种 + 插件，含参数表）→ `set_transitions { type, durationInFrames, params }`；插件转场出场自动反向
- **3D 后期效果**：`list_plugin_passes`（插件给的 VHS/故障/水波等受控 GLSL）→ `set_graph_scene { post: { passes: [{ id }] } }` 启用（最多 6 个，编不过会被跳过并告警）
- **3D 图形配方**：`list_graph_presets`（插件给的现成起手图）→ `set_graph_scene { graphPreset: "id" }` 整套替换（**不是合并**，套完抽帧看构图）
- **3D 世界背景**：`list_world_skies`（春夏秋冬/晨午昏/夜景银河/室内的全景图配方，**并标出本机有没有那个文件**）
  → `set_graph_scene { worldPreset:"golden-hour" }` 一键套用。缺图别硬套，会静默退回渐变天空
- **本地资源库**：`search_local_assets`（用户在「资源库」面板按类别登记的本机素材目录里按名搜索，
  直接返回可引用的 /resources/ 地址——文件不复制，渲染时由本机 server 流出）
- **图解插图**：`add_scene(type="iso")`——anatomy 出等轴测图后落盘，见 `get_guide("external-tools")`
- 音频字幕：tts_narration、**revise_script（改一句台词 → 只重配那段）**、add_audio_track、set_subtitle、export_subtitles
- 预览渲染：preview_frames（单帧 frames:[f]）、render_video(dryRun/wait)、check_project
- 风格主题：list_styles / apply_style / set_theme / set_formats
- **风格库（77 个内置风格）**：用户先在编辑器「风格库」面板勾选 → `get_style_pick` 读他选了什么；
  用户没挑就用 `list_styles` 找候选。**回来的都是 slug，直接 `apply_style` 就能套**，不用翻译。
  用户给的是参考图/对标片（没有 slug）时，才走 `get_guide("style-translate")` 翻成 theme/版式
- 批量：apply_ops（整批原子）
- 协作记忆：reply_user / remember / recall

**行为契约**：不试探参数、不读源码；不确定先 `get_guide`（名字猜错会指路），工具不确定先 `get_guide("manual")`。
