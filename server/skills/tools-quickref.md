# 工具速查（入口页）

完整说明书在 **`get_guide("manual")`**：《Agent 使用全书》——93 个工具全表（4 常驻 + 89 按需）、能力地图、
「我想…」意图速查、落地铁律（为什么没生效）。本页只留最快的域索引：

**两层调用**：常驻核心 4 个（start_guide / get_guide / tool_search / tool_call）；
其余 86 个工具 `tool_search("意图")` 找 → `tool_call(name, args)` 执行（`all=true` 看全量目录）。

- 工程：list / switch / create / get / delete / 模板（含删除）/ 历史 / 导入导出
  （当前工程只在 create / import / switch / 删除当前工程时变；显式 projectId 只影响本次调用）
- 需求与分镜：intake → save_brief → confirm_brief → save_storyboard → build_storyboard
- 场景与元素：add/update_scene、39 版式（scene-recipes）、freeform、元素/特效/转场
- 音频字幕：tts_narration、add_audio_track、set_subtitle、export_subtitles
- 预览渲染：preview_frame(s)、render_video(dryRun/wait)、check_project
- 风格主题：list_styles / apply_style / set_theme / set_formats
- 批量：apply_ops（整批原子）
- 协作记忆：reply_user / remember / recall

**行为契约**：不试探参数、不读源码；不确定先 `get_guide`，工具不确定先 `get_guide("manual")`。
