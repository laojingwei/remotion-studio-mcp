# 渲染与交付

## 画幅

- 默认竖屏 9:16 + 横屏 16:9 都渲染；只要横屏时显式传 `formats`
- `set_formats` 可自定义尺寸（16–7680）

## 字幕

- `set_subtitle` 的字幕**会烧录进成片**（底部居中、黑底白字，按字数比例分配幕内时长），同时可 `export_subtitles` 导出 SRT/VTT；两者用同一套时间分配
- 这是硬字幕；如果要"可开关的字幕轨"，需要另做（目前没有）
- 字幕样式按场景调：`set_subtitle(text, style)` 或 `set_subtitle_style(sceneId, style)`
  - `fontSize`（短边%）/`color`/`bg`/`bgOpacity`/`bottom`/**`bold` = 数字字重 100–900**（不是布尔；传 true/false 会自动转 700/400）/`stroke`+`strokeColor`/`shadow`/`lineHeight`/`letterSpacing`/`align`/`maxWidth`
  - `css` 传任意 CSS（camelCase 键），可以覆盖一切预设

## 渲染

- 正式渲染前可先 `render_video(dryRun=true)` 预检：场景是否为空、素材文件是否都在（几秒返回）
前检查（模型自己判断）

- `preview_frame` 抽 2–3 帧：文字溢出、重叠、被裁；也可以 `preview_frame(sceneId, offset)` 按场景抽，不用自己算全局帧
- `get_project` 确认场景数/顺序没有重复副本
- 素材是否存在（`get_asset_info` 能验证音频时长，也顺带确认文件在）

## 字幕

- `set_subtitle` 的字幕**会烧录进成片**（底部居中、黑底白字，按字数比例分配幕内时长），同时可 `export_subtitles` 导出 SRT/VTT；两者用同一套时间分配
- 这是硬字幕；如果要"可开关的字幕轨"，需要另做（目前没有）
- 字幕样式按场景调：`set_subtitle(text, style)` 或 `set_subtitle_style(sceneId, style)`
  - `fontSize`（短边%）/`color`/`bg`/`bgOpacity`/`bottom`/**`bold` = 数字字重 100–900**（不是布尔；传 true/false 会自动转 700/400）/`stroke`+`strokeColor`/`shadow`/`lineHeight`/`letterSpacing`/`align`/`maxWidth`
  - `css` 传任意 CSS（camelCase 键），可以覆盖一切预设

## 渲染

- 正式渲染前可先 `render_video(dryRun=true)` 预检：场景是否为空、素材文件是否都在（几秒返回）


- `render_video` 提交 → `get_render_status` 轮询；或 `render_video(wait=true)` 一直等到完成
- 速度约 8.8 帧/秒（concurrency 1）：1 分钟成片 ≈ 3.4 分钟
- 成片在 `out/projects/<工程id>/videos/`（按工程分目录），每个工程只留最近 5 个，要留档自己下载
- 关键帧与字幕分别在同目录的 `stills/`、`subtitles/`；删工程会连产物目录一起删
- 失败先看错误信息：素材 404 → 检查 public/assets；bundle 问题 → `refresh_bundle`

## 交付

- 告诉用户：成片路径、时长、画幅
- 需要字幕就 `export_subtitles`
- 需要备份/换机就 `export_project`（含素材的 .zip）
