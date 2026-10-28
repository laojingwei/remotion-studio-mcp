# 旁白与配音

## 写旁白

- 口语、短句；一句一个意思
- 每幕 1–2 句，20–50 字（约 4–8 秒）
- 数字、日期直接写阿拉伯数字，`tts_synthesize` 默认会转成中文读法
- 英文缩写写读音（API 写成「接口」或「A P I」），避免逐字母乱读
- 中文标点用「，。？！」；不要 Markdown、emoji、特殊符号

## 合成与对齐

**多段旁白（推荐）**：`tts_narration(segments=[{text, sceneId}], applyToScenes=true)` 一次合成所有幕的旁白：
- 每段返回真实时长 + 建议场景帧数
- `applyToScenes` 会直接把音频放进各场景、按配音长度改场景时长、把文本写成字幕
- 重复应用会先清掉该场景旧的音频元素


1. `tts_synthesize`（可带 instruct 语气、voice 音色）
2. `get_asset_info` 量真实时长（秒 / 帧）
3. `set_scene_timing`：帧数 = `ceil((秒数 + 0.7) × 30)`，0.7 秒是呼吸位
4. 改过文案必须重量——同一段文字两次合成时长可能不同

## 字幕

- `set_subtitle` 一行一句，跟场景时长按字数比例分配
- `export_subtitles` 出 SRT / WebVTT

## 音频坑

- 场景内音频默认到场景结尾；有真实时长会按素材长度
- 拖右边缘不会超过素材长度（除非是循环视频）
- 裁头（左边缘）后 `startFrom` 同步，声音从裁掉的位置开始播

## TTS 产物入库

`tts_synthesize` 的 wav 默认落盘到 `public/assets/`，可以直接 `get_asset_info` 量、给场景用；
但**不进「我的素材」列表**（`list_assets` 查不到）——要入库管理（改名/后续复用）就 `upload_asset` 再传一次，
或对已落盘文件用 upload 指向 `/assets/xxx.wav`。
