# 工具速查（入口页）

完整说明书在 **`get_guide("manual")`**：《Agent 使用全书》——126 个工具全表（4 常驻 + 122 按需）、能力地图、
「我想…」意图速查、落地铁律（为什么没生效）。本页只留最快的域索引：

**两层调用**：常驻核心 4 个（start_guide / get_guide / tool_search / tool_call）；
其余 122 个工具 `tool_search("意图")` 找 → `tool_call(name, args)` 执行（`all=true` 看全量目录，`names=[...]` 取完整参数表）。

- 工程：list / switch / create / get / **archive（收进抽屉，不删文件）** / delete / 模板（含删除）/ 历史 / 导入导出
  （当前工程只在 create / import / switch / 删除当前工程时变；显式 projectId 只影响本次调用）
  测试工程太多用 `archive_project`（可逆），别用 `delete_project`（不可逆）；`list_projects` 默认不列已归档的
- 需求与分镜：intake → save_brief → confirm_brief → save_storyboard → build_storyboard
- 场景与元素：add/update_scene、76 个 2D 版式（scene-recipes）、freeform、元素/特效/转场
- **3D 场景**：`add_scene(type="scene3d")`——抽象氛围用 preset（6 个母题），具体物体写 `graph` 场景图；
  写法与坑见 `get_guide("scene3d")`，字段全表 `list_scene_types(type:"scene3d")`
- **3D 世界背景**：`list_world_skies`（春夏秋冬/晨午昏/夜景银河/室内的全景图配方，**并标出本机有没有那个文件**）
  → `set_graph_scene { worldPreset:"golden-hour" }` 一键套用。缺图别硬套，会静默退回渐变天空
- **本地资源库**：`search_local_assets`（用户在「资源库」面板按类别登记的本机素材目录里按名搜索，
  直接返回可引用的 /resources/ 地址——文件不复制，渲染时由本机 server 流出）
- **图解插图**：`add_scene(type="iso")`——anatomy 出等轴测图后落盘，见 `get_guide("external-tools")`
- 音频字幕：tts_narration、**revise_script（改一句台词 → 只重配那段）**、add_audio_track、set_subtitle、export_subtitles
- 预览渲染：preview_frames（单帧 frames:[f]）、render_video(dryRun/wait)、check_project
- 风格主题：list_styles / apply_style / set_theme / set_formats
- 批量：apply_ops（整批原子）
- 协作记忆：reply_user / remember / recall

**行为契约**：不试探参数、不读源码；不确定先 `get_guide`（名字猜错会指路），工具不确定先 `get_guide("manual")`。
