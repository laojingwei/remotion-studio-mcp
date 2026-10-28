# Remotion Studio · Agent 协同动画工程

一份 `Project JSON`，三个消费方：**Agent 改它、用户在 Web 上拖它、Remotion 渲染它**。
因为共用同一个数据源，agent 和用户的编辑天然互通 —— 不是后期加的功能，是架构的结果。

> **版本** 1.1.0（开发线 v1.01）· **MCP 工具** 93 个（4 个常驻 + 89 个按需发现）·
> **许可** 本仓库代码 MIT，依赖里有两个非宽松（Remotion License / AGPL），见 [开源协议](#开源协议)

---

## 快速开始

**日常使用（推荐）**：双击 **`启动编辑器.bat`**，浏览器会自动打开。

它做三件事：需要时构建前端 → 起服务 → 打开 http://127.0.0.1:4380 。
一个端口就是完整应用，不需要另开前端进程。关掉那个黑窗口即停服。

或者用命令：

```bash
npm install
npm start            # 同上：构建 + 启动 + 开浏览器
```

**开发模式**（改代码即时生效，前端走 vite HMR）：

```bash
npm run dev          # API(4380) + 编辑器(5173)
```

此时编辑器在 http://127.0.0.1:5173 ，4380 是它的接口后端。

- 想单独跑 Remotion 自带的 Studio（临时编辑器 + props 调试）：
  ```bash
  npm run studio
  ```
- 想直接出片：
  ```bash
  npm run render            # 竖屏
  npm run render:landscape  # 横屏
  ```
- 改完代码自检：
  ```bash
  npm test                  # op reducer 单测（纯函数，不需要服务）
  npm run build && npm run verify   # 端到端冒烟：临时工程 + 无头浏览器真实拖动，跑完自动清理
  ```

> **两种端口别混用**：`npm start` / bat 启动后编辑器在 **4380**；
> `npm run dev` 启动后编辑器在 **5173**（4380 是后端）。打开错了会看到 JSON。

> **端口注意**：默认 4380。如果本机被别的软件占用（例如 QQ 会监听 4310），
> 用 `PORT=4400 npm run dev:server` 换端口，并同步 `SERVER_URL` 环境变量给 MCP 代理。

---

## 它是怎么工作的

```
Agent(MCP) ─┐                    ┌─► data/projects/<id>/project.json
            ├─► Op Service ──────┤
Web 编辑器 ─┘   (rev + 广播)      └─► SSE ──► 另一端界面即时更新
                     │
                     └─► Remotion（Player 预览 / renderStill 自检 / renderMedia 出片）
```

三层约束，改任何一层都不会破坏协同：

| 层 | 位置 | 说明 |
|---|---|---|
| 文档 | `shared/schema.ts` | Project / Scene / Format / Theme，纯数据 |
| 场景 | `shared/sceneMetas.ts` + `src/scenes/*` | 一份 zod schema 同时驱动渲染校验、agent 参数、属性面板 |
| 通道 | `server/` + `web/` | 只有 `ProjectService.apply` 能写文档 |

### 一条 op 的旅程

1. 用户拖动场景时长 → 前端 POST `/api/projects/:id/ops`
2. `ProjectService` 校验 → 应用 reducer → rev+1 → 写盘 → SSE 广播
3. agent 侧读到新文档；反之 agent 调工具，用户界面 300ms 内高亮看到变化

---

## 给 Agent 用（MCP）

把下面这段加进 `~/.workbuddy/mcp.json`（路径换成你的实际位置）：

```json
{
  "mcpServers": {
    "remotion-studio": {
      "command": "node",
      "args": [
        "<工程目录>/node_modules/tsx/dist/cli.mjs",
        "<工程目录>/server/mcp-proxy.ts"
      ],
      "env": { "SERVER_URL": "http://127.0.0.1:4380" }
    }
  }
}
```

把 `<工程目录>` 换成你 clone 下来的绝对路径（Windows 用正斜杠也可以）。

全部用绝对路径 + 工程内的 tsx，**不依赖宿主进程的 cwd**（MCP 客户端的启动目录经常不是项目目录）。

加完在连接器管理页点「信任」。代理会在第一次工具调用时检查/拉起本地服务，不需要你先手动开。

> **改了 `server/mcp-tools.ts` 要重连才生效**：代理是常驻 stdio 进程，代码改动不会热加载。
> 在连接器页把 `remotion-studio` 关掉再打开即可，不必重启整个应用。

### 也可以用 HTTP 接（Streamable HTTP）

服务在跑的时候，DSH / 其他 MCP 客户端可以按 Streamable HTTP 连：

```
http://127.0.0.1:4380/mcp
```

传输方式选 **Streamable HTTP**、鉴权选「无」。工具定义和 stdio 共用同一份
（`server/mcp-tools.ts`），工具数完全一样；HTTP 方式不会额外起进程，
服务重启后连接自动恢复。

> 注意地址要带 `/mcp`：`/` 是编辑器本身的 HTTP API（REST + SSE），不是 MCP 端点。

### 工具清单（93 个 = 4 常驻 + 89 按需）

**门面模式**：宿主只看到 4 个常驻工具，其余 89 个用 `tool_search` 按意图现找、用 `tool_call` 执行。
这样工具描述不占常驻上下文（否则光工具说明就要几万 token）。

```
start_guide()                          → 开工入口：整条流程 + 你现在在第几步
tool_search(query="画中画")             → 找工具，返回名字 + 完整参数表
tool_call(name="move_scene", args={…})  → 执行任何一个已注册工具
get_guide(name="manual", section="…")   → 按需读指南（不常驻）
```

调用被隐藏的工具必须走 `tool_call`，直接调会报 `Tool X disabled` —— 这是预期行为。
调试时可以用 `MCP_EXPOSE=all npm run mcp` 恢复全量暴露。

| 分组 | 工具 |
|---|---|
| 门面（常驻） | `start_guide` / `get_guide` / `tool_search` / `tool_call` |
| 工程 | `create_project` / `list_projects` / `switch_project` / `get_project` / `delete_project` / `export_project` / `import_project` / `restore_rev` / `get_history` / `list_templates` / `save_template` / `delete_template` |
| 场景 | `list_scene_types` / `add_scene` / `update_scene` / `get_scene` / `set_scene_type` / `set_scene_timing` / `remove_scene` / `duplicate_scene` / `reorder_scenes` / `move_scene`（多轨定位）/ `set_scene_box`（画中画） |
| 批量 | `apply_ops`（整批原子，回传新增的 scene/element id） |
| 元素 | `list_element_library` / `add_element` / `update_element` / `remove_element` / `set_transform` / `layout_grid` / `align_elements` |
| 自由画布 | `add_freeform_element` / `update_freeform_element` / `remove_freeform_element` |
| 特效轨 | `list_effect_types` / `add_effect` / `update_effect` / `remove_effect` |
| 转场 | `set_transition`（单幕）/ `set_transitions`（批量，给全部或指定场景套同一套） |
| 音频 | `set_audio`（含 ducking 人声避让）/ `add_audio_track` / `update_audio_track` / `remove_audio_track` / `balance_audio`（响度配平）/ `compress_audio`（动态压缩）/ `analyze_audio`（BPM + 拍点）/ `set_beat_grid`（手填 BPM） |
| 语音 | `get_tts_config` / `set_tts_config` / `tts_check`（预检，`deep=true` 会真合成一句）/ `tts_synthesize` / `tts_narration`（多段旁白一次合成 + 对齐幕长） |
| 字幕 | `set_subtitle` / `set_subtitle_style` / `export_subtitles` |
| 主题 / 画幅 | `set_theme` / `set_formats` |
| 渲染 | `preview_frame` / `preview_frames` / `render_video` / `get_render_status` / `cancel_render` / `refresh_bundle` / `cleanup_renders` |
| 素材 | `upload_asset` / `get_asset_info` / `list_assets`（共用库）/ `list_project_assets`（本工程）/ `delete_project_asset` / `organize_assets`（老文件归位）/ `rename_asset` / `delete_asset` |
| 风格 | `list_styles` / `get_style` / `apply_style`（一键套风格） |
| 需求 / 分镜 | `intake`（9 步问诊）/ `save_brief` / `get_brief` / `confirm_brief` / `save_storyboard` / `get_storyboard` / `build_storyboard` / `check_project`（只读诊断） |
| 技能 / 记忆 | `list_guides` / `remember` / `recall` |
| 协作 | `get_user_messages` / `reply_user` |

几个省 token 的开关：

- `get_project(detail="summary")`：默认摘要；`full` 才回完整 props
- `list_scene_types(summary=true)`：只回类型 + 一句话 + 字段名
- `apply_ops(quiet=true)`：只回一行「已执行 N 个操作」
- `render_video(wait=true)`：阻塞到渲染完成，省掉轮询
- `render_video(dryRun=true)`：只预检（场景为空 / 素材缺失），不提交渲染
- `preview_frames(frames=[...])`：一次抽 1–8 帧

**重要的使用习惯**：改完用 `preview_frames` 抽 2–3 帧看版式（文字溢出/重叠/被裁）；正式渲染前 `render_video(dryRun=true)` 预检；渲染用 `wait=true` 直接等结果。

**素材不够用时怎么办**：先 `list_element_library` 找现成的；没有合适的就自己造——矢量直接写 `svg`，要位图先 `upload_asset` 再把地址给 `imageSrc`/`videoSrc`/`audioSrc`。

### 技能与记忆（给 agent 的经验层）

技能文件在 `server/skills/*.md`，通过 `list_guides` / `get_guide(name, section?)` 按需读取——不常驻、不占工具描述，需要时只读一节。共 13 篇：

| 技能 | 内容 |
|---|---|
| `manual` | **Agent 使用全书**：全工具表、能力地图、「我想…」意图速查、落地铁律（为什么没生效） |
| `director` | 接单确认清单 + 五步流程 + 节奏默认值 + A/B 版本做法 |
| `formats` | 用途结构库：拍什么、按什么结构讲 |
| `scene-recipes` | 39 种版式配方（适用场景 / items 建议 / 坑） |
| `craft` | 画面质感：签名时刻、层次、留白、动效节奏 |
| `freeform` | 自由画布写法（`add_freeform_element` 的元素/关键帧/fx） |
| `sound` | 声音设计：BGM 选择、人声避让、响度配平、卡点 |
| `narration` | 旁白写法 / TTS 分段 / 时长对齐公式 |
| `long-form` | 长片章节（超 12 幕或超 2 分钟怎么撑住） |
| `qa` | 自检与验收清单（交付前跑什么） |
| `delivery` | 渲染 / 交付 / 验收 |
| `memory` | 什么时候 recall / remember，模板怎么沉淀 |
| `tools-quickref` | 域索引薄入口（指向 manual） |

记忆按类分开存（`data/memory/`）：

- `remember(kind="pitfall" | "preference" | "recipe", text, tags, scope)`
- `recall(kind?, query?, tags?, projectId?)` 查全局 + 工程级
- 坑/偏好默认全局，配方可 global 或 project

创作需求用 `save_brief` / `get_brief` 落盘（`data/projects/<id>/brief.json`），创作中随时对照，不用反复问用户。

---

## 作为 DSH 插件（启动器）

启动器是**另一个独立的包** [`dsh-remotion-launcher`](https://github.com/laojingwei/dsh-remotion-launcher)，
本仓库只提供它要构建/启动的工程。两者分开，插件能独立升级，工程也能放在任意目录。

装好插件后在 DSH 里：

- 右下角一个可拖动的悬浮按钮，点开是「构建前端 / 启动服务 / 停止」面板
- 实时日志、健康状态、端口可改（避免和别的软件抢 4380）
- 面板第一行是「工程」，可以指向本机任意一个工程目录，也可以从 npm 下载一份
- 服务起来后，地址可以直接在 DSH 右侧栏的「浏览器」里打开，和 agent 共用同一个界面

安装（要求 DSH `>=0.2.1-rc.2 <0.3.0`）：

```sh
# 从 npm 装插件（国内会自动走 npmmirror）
dsh plugin --profile web add dsh-remotion-launcher

# 或从 GitHub
dsh plugin --profile web add github:laojingwei/dsh-remotion-launcher
```

重启 DSH 后，在面板里把工程指向本目录：

> **工程 → 更换 → 选择本仓库目录 → 使用此目录**

目录里只要有 `package.json` 和 `server/` 就能被识别。

> 也可以在面板里点「下载并安装」，从 npm 拉一份 `remotion-studio-mcp` 到你选的位置，
> 插件会自动解压并跑 `npm install`——适合本机还没有工程的情况。

细节见 [`dsh-remotion-launcher` 的 README](https://github.com/laojingwei/dsh-remotion-launcher)。

## 实战踩坑（MCP 长片）

> 来源：用 MCP 做过一支 17 幕 / 5 分 36 秒的教学片后的实测记录。多数坑已经修掉，这里保留结论，供 agent 和新同学避雷。

### 素材与渲染

- **素材同步**：渲染前会自动把 `public/assets` 增量同步进 webpack bundle（`syncPublicToBundle`，按 size+mtime）。老版本会静默用旧快照导致成片没声音；现在新增 TTS 音频后直接渲染即可。仍可 `refresh_bundle` 强制重建。
- **场景内音频默认循环**：元素时长不够会无缝 loop，听起来像「卡带」，先查时长。
- **音频元素时长在添加时固化**：后来拉长场景，旁白仍按旧时长播完就 loop → 用 `update_element` 的 `durationInFrames` 补改。
- **验收**：拿到成片先 `ffprobe -show_entries stream=codec_type` 确认有音轨，再 `volumedetect` 看 mean 约 -20 dB。

### 时长与配音

- `get_asset_info` 可直接量 wav/mp3/ogg/mp4 时长并给建议场景帧数；公式 `帧数 = ceil((配音秒数 + 0.7) × 30)`（0.7 秒呼吸位）。
- 同一段文字两次合成时长可能不同（实测 18.4s / 19.5s），改旁白必须重新量、重新设时长。

### 场景字段

- items 的元素必须是对象，各类型 key 不同：

| 类型 | key | 数量 |
|---|---|---|
| list | `{title, note}` | 1–5 |
| cards / steps | `{title, desc}` | 2–4 |
| stats | `{value, label}` | 1–4 |
| bars | `{label, percent}` | 2–4 |
| bullets | `{text}` | 1–5 |
| timeline | `{time, text}` | ≥2 |
| table | `rows: [{a,b,c}]` | 2–3 |

- 未知 key **静默丢弃**：每次 `add_scene` / `update_scene` 后 `get_scene` 回读确认。
- `projectId` 尽量显式传（`get_scene` 不带会找不到场景）。
- 3 个 items 的 stats / cards / bullets 已改成单列（竖屏）或整行排列，不再 2+1 孤儿行。
- 长文案：标题 ≤9 个中文字；`quote` 版心窄（7 字就折行），长金句用 `bigtext`；`compare`/`versus` 的 `
` 不生效，写成短句流；`table` 表头写死（项目/基础版/进阶版）。

### 渲染

- 默认双画幅都渲，只要横屏显式传 `formats: ["landscape"]`。
- 成片每个工程只留最近 5 个（`KEEP_VIDEOS`），要留档自己下载。
- 速度约 8.8 帧/秒（concurrency 1）：1 分钟成片 ≈ 3.4 分钟渲染；没有回调，只能轮询 `get_render_status`。
- **渲染前先 `preview_frame` 抽帧**：一帧几秒，一次全片十几分钟。

### 调用习惯

- 每轮改完 `get_project` 核对场景数/顺序，发现重复副本立刻 `remove_scene`。
- `rev` 每次 ops 都涨，冲突时以最新 `get_project` 为准重做那一步，别硬重试。
- 报错信息（zod 路径）很准，照它改一次就过。
- 批量改动可用 `apply_ops` 一次提交多个 op。

## 多规格同源（重要）

一套内容可以出四种预设画幅：竖屏 1080×1920、横屏 1920×1080、方形 1080×1080、竖版 1080×1350，
也可以输入任意宽高（16–7680）加自定义画幅，比如 1200×800 的横版卡片
（画幅在编辑器顶部切换增删，存在 `Project.formats` 里）。写场景组件必须遵守：

1. **不写 px**，全部走 `useSceneLayout()` 给的 `u()` / `h()`
2. `unit = min(width, height) / 100` —— 锁短边，文字物理尺寸各画幅一致
3. 结构差异（横屏左右分栏 / 竖屏上下堆叠）走 `orientation` 分支，不能靠缩放硬扛

⚠️ 用 `width / 1080` 做全局缩放会在横屏把字放大 1.78 倍，标题必溢出。

### 画幅只由数据决定，不靠注册多个 Composition

Remotion 侧只有一个 Composition `Video`，宽高由 `calculateMetadata` 从 `inputProps` 推导：

```ts
const fmt = props.formats.find(f => f.key === props.formatKey) ?? props.formats[0];
return { width: fmt.width, height: fmt.height, durationInFrames: totalDuration(props), fps: props.fps };
```

早期是 `preview.formats.map(f => <Composition id={'Video-' + f.key} …/>)`，列表被**种子工程的默认画幅**写死。
用户在编辑器里加 1:1 之后，`renderStill` 直接报 `Could not find composition with ID Video-square`。
新增画幅不需要改任何代码，改数据即可。

---

## 素材与音频

- 图片 / 音频走右侧面板的「上传」按钮，或直接 `POST /api/projects/:id/assets`（multipart，字段名 `file`）。
  返回 `/assets/xxx`，可直接写进场景 props。
- **文件落哪（v0.98 起分三个桶）**：入库的进 `public/assets/library/`（URL 形如
  `/assets/library/xxx.png`，跨工程复用）；只给本工程用的进 `public/assets/projects/<工程id>/`
  （URL 形如 `/assets/projects/<id>/xxx.png`，删工程时一起清）；试听/预检的进 `_preview/`
  （按需创建，不走试听就没有这个目录）。
  MCP 的 `upload_asset` **默认入库**（回执带 `asset:<id>`），传 `registerToLibrary=false` 才是私有。
- 图片页的 `src`、背景音乐的 `Project.audio.src` 都吃这个 URL；agent 也可以直接用公网 https 地址，不必上传。
- 图片页默认 `contain`：完整显示，留白处用同一张图的模糊版填充；要满屏裁切就切到 `cover`。
- 背景音乐支持 `volume / fadeIn / fadeOut`，渲染时按帧插值，Preview 里同样生效。
- **时间轴底部有音轨**：`AudioTrack` 用 Web Audio 解码出峰值画波形，叠加音量包络折线，
  右侧标 `音频时长 / 画面时长`（音频比画面短时变橙色）。
  解码结果按 `src` 缓存，拖动播放头不会重复解码。

### 场景内音频元素怎么裁（实测过，容易想当然）

一个音频元素有三个时间参数：`from`（场景内起点）、`durationInFrames`（场景内时长）、
`startFrom`（从素材第几帧开始播），渲染行为是：

| 想法 | 实际 |
|---|---|
| 时间轴只显示 1 秒 → 成片是不是把整段文件都灌进去？ | **不会**。只渲染这 1 秒，窗口之外的音频不进成片 |
| 显示 1 秒 = 文件里随便哪 1 秒？ | **可以了**（v0.84）。`startFrom` 决定从素材第几帧开始播——之前只有视频有，音频只能从文件第 0 秒开始 |
| 窗口比文件长 → 会循环补齐？ | **不会**。文件播完就静音到窗口结束（音频元素不吃 `loop`） |
| 音频元素默认有声吗？ | **有声**。`muted` 按类型给默认值：音频 false、视频 true。早先一律默认 true，导致音频不显式传 `muted:false` 就整条静音，连音轨都不生成 |

**时间轴左边缘可以裁头**：拖音频/视频元素块的左边缘，窗口左端右移、时长同步缩短，
素材也同步跳过同样的帧数（`startFrom` +N）。实测：**旁白正文在画面上的位置分毫不动**，
只是把素材开头的空白裁掉了（4 秒 wav，前 1 秒静音：裁 30 帧后成片与不裁逐段响度完全一致）。
左边缘手柄是冷色，右边缘（拉伸时长）是暖色。

属性面板里也能直接拖「起始帧」滑块设 `startFrom`；MCP 用 `update_element(startFrom: N)`。

排这类问题最快的一步：`get_asset_info` 量出素材时长，对照元素的 `durationInFrames`。

> 注意 `/assets/*` 这个路由已经被「上传素材」占用，所以 vite 的前端产物目录改成了 `static`
> （`build.assetsDir`）。改回 `assets` 会让构建出来的 js/css 被素材路由截走，页面直接白屏。

---

## 画布与元素编辑

### 视图操作

| 操作 | 方式 |
|---|---|
| 缩放 | 滚轮（20% – 500%），**以鼠标位置为中心** |
| 平移 | `Alt` + 左键拖动，或中键拖动 |
| 复位视图 | 右下角「重置视图」 |
| 隐藏/显示选框 | 右下角「隐藏选框」（状态记在 localStorage） |
| 安全区辅助线 | 右下角「安全区」（常显 5% 内缩框；拖动元素时也会自动出现） |
| 播放 / 暂停 | `Space`，或右下角 ▶ 按钮 / 播放器控制条 |

缩放只作用在外层容器（CSS transform），画面本身的逻辑尺寸不变，
所以编辑层、指针坐标都不用跟着换算两次。

**以鼠标为锚点**的换算：画布由 grid 居中，其中心恒等于 stage 中心，于是

```
screen = stageCenter + pan + zoom * localPoint
```

要让鼠标下那个点不动，反解出新的 `pan` 即可（实测漂移 < 1px）。

**点击画面不会播放**：`clickToPlay={false}`、`spaceKeyToPlayOrPause={false}` 都关掉了，
只认空格和播放按钮。点空白处 = 取消选中，不会误触播放。

### 选中与多选

| 操作 | 作用 |
|---|---|
| 单击元素 | 单选 |
| `Shift` / `Cmd` 点击 | 加选 / 减选 |
| 在空白处拖拽 | 框选（矩形碰到就选中） |
| 点空白处 | 取消选中 |

多选时顶部出现「排列工具条」；单选时只有图层按钮 + 复位。

`Ctrl/Cmd + A` 全选当前画面上可见的所有可编辑元素（模板元素 + 叠加元素）。

**多选整体编辑**：选中 2 个以上元素后出现紫色整体包围盒：

| 手势 | 作用 |
|---|---|
| 拖动任一选中元素 | 整组移动（吸附、越界提示都按整组外接框算） |
| 顶部紫色圆点 | 整组旋转（按住 `Shift` 吸附 15°），成员角度同步、位置绕整体中心转 |
| 右下角紫色方块 | 整组等比缩放，位置按同一比例映射、`scale` 各自相乘 |

所有成员始终按同一个手势联动，元素之间的相对距离和大小关系不会散。
一次手势 = **一批 op**，撤销一次整批回退。

> 多选状态下单击已选元素不会改选中集（防止想整组拖动时误收敛成单选）。
> 要回到单选：点一下空白处，或直接点一个未选中的元素。

### 对齐 / 分布 / 图层

选中 2 个及以上元素后，工具条出现 6 个对齐 + 2 个分布按钮（分布需 3 个以上）；
图层按钮只作用于选中元素。

| 按钮 | 行为 |
|---|---|
| 置顶 / 上移一层 / 下移一层 / 置底 | 改 `transform.z`，越大越靠前 |
| 左 / 水平居中 / 右 / 顶 / 垂直居中 / 底 | 按选中元素的外接框对齐（旋转后按包围盒算） |
| 水平 / 垂直等距分布 | 首尾不动，中间元素等间距（等的是**间隙**，不是中心距） |

对齐是把像素差换算回百分比再叠加到 `x / y`，所以换画幅后相对关系仍然成立。
一次对齐/分布是**一批 op**，撤销一次就整批回退。

⚠️ **层级值必须非负**。负 `z-index` 会让元素画到场景背景之下，表现为「置底后整块消失」。
「置底」的实现是：先算到最低值以下，再把整组平移回非负区间（顺序不变）。
渲染端也做了兜底钳制，agent 传负数不会把画面搞没。

### 拖动 / 旋转 / 缩放元素

预览里所有可编辑的元素会显示淡色轮廓（鼠标移上去变亮）。点中后：

| 手势 | 作用 |
|---|---|
| 拖动框内 | 移动；靠近其他元素 / 画布中线 / 安全区边缘时**自动吸附**（粉色参考线） |
| 顶部圆点 | 旋转（按住 `Shift` 吸附到 15°） |
| 右下角点 | 缩放（0.2× – 4×） |
| 底部数值条 | 显示 `x / y / 角度 / 倍数 / 层级`，「复位元素」回到模板位置 |

**吸附**：拖动时把元素的三条竖边（左 / 中 / 右）和三条横边（上 / 中 / 下）
与画布边缘、画布中线、5% 安全区边缘、以及其他元素的边线比对，
6 屏幕像素内就拉齐（阈值除以缩放，所以放大画布后手感一致），命中的位置画粉色参考线。

**越界反馈**：拖出画面时元素框变红并显示「超出画面」；压到 5% 安全区之外
（但还在画面内）显示琥珀色「超出安全区」。只提示、不硬拦 ——
短视频里贴边/出血有时是刻意的，拦住了反而难做。

**为什么记偏移量而不是绝对坐标**：模板是自动排版的（flex + 安全区 + 朝向分支）。
如果元素被钉死成 px，竖屏调好的位置到横屏就全错，多画幅同源当场失效。
所以 `x / y` 存的是**画面宽高的百分比**，换画幅时同比例缩放，四个画幅都成立。

⚠️ 旋转 + 位移会把元素推出安全区，尤其接近满宽的标题（旋转 6° 就能让首字出框）。
现在拖到这些位置会有明确的颜色提示，靠底部数值和「复位元素」兜底。

数据落在 `scene.transforms: Record<elementId, { x, y, rotate, scale, z }>`；
拖动过程只做本地预览，**松手才提交**，所以一次拖动 = 一步撤销。

元素 id 在 `shared/sceneMetas.ts` 的 `elements` 里声明，和场景组件里的
`<Editable id="…">` 对齐。新增可拖元素要同时改这两处。

> **实现注意**：编辑层不能铺一层全屏遮罩来接管点击，否则会把 Remotion 自带的播放控件挡死。
> 现在用的是**捕获阶段监听 + `closest('.__remotion-player')` 判定**：
> 播放控件在那个节点之外，天然分得开。

### 自由元素与素材库

模板之外还能往画面上"贴东西"：图标、形状、文字标签、图片、视频。左栏切到**元素**页签就是素材库，
有「**内置**」和「**我的**」两个来源：

- **内置**：57 个矢量素材，分 标记 / 箭头 / 形状 / 符号 / 标签（`list_element_library` 里能看到全表与默认尺寸）
- **我的**：自己上传或 agent 生成的**图片 / 视频 / 音频**，索引在 `data/library.json`、文件在
  `public/assets/library/`，**跨工程复用**。
  点「点这里，或把图片 / 视频拖进来」上传；**也可以把文件直接拖进窗口任意位置**（不用先打开素材面板），
  松开就自动入库；悬停卡片可重命名 / 删除

**缩略图**：上传时浏览器会顺手生成一张长边 320px 的 webp（`<文件名>.thumb.webp`），
素材面板列表用它，画布和成片仍然走原图 —— 这样库里有几张大图也不会拖慢面板。
老的素材没有缩略图就退回原图，不影响使用。

**空间回收**：

- 删素材条目时，如果原图不再被**任何工程**引用、也不再被库里其他条目引用，会顺手删掉文件
  （还有画面在用就保留，避免裂图）
- 「我的」头部有「清理未引用」：扫描 `public/assets/`，删掉既不在素材库、也没被任何工程引用的文件
  （删前有确认框；只删文件，不动工程和索引）

| 操作 | 方式 |
|---|---|
| 放入 | 把素材**拖到画面上**（落点就是元素中心；拖偏到画布外也会吸附到最近的位置），或点一下放到画面中央 |
| 选中 | 画布上直接点；左栏「本场景已放」列表里点名字也行 |
| 移动 / 旋转 / 缩放 | 和模板元素完全相同的手势 |
| 复制 | `Ctrl+D`（副本错开 3%、层级 +1） |
| 微调 | 方向键每次 1%，按住 `Shift` 一次 10% |
| 改属性 | 右栏自动切成元素面板：位置、尺寸、旋转、透明度、颜色/底色（点色盘调颜色和透明度）、文字、图层、入场/出场特效 |
| 视频素材 | 「我的」支持上传 mp4 / webm；放上画布后可设静音 / 循环 / 起始帧 |
| 删除 | 选中后按 `Delete`，或右栏「删除元素」，或左栏列表的 `×` |

> 排列工具条（层级 / 对齐 / 分布 / 复制 / 删除）**常驻**在画布顶部，
> 没选中元素时置灰，选中后亮起 —— 不用先记住"要先选中才有工具"。

自由元素和模板元素的根本差别：**它不跟排版走**。
`x / y / size` 全是画面百分比（`size` 按短边算），所以换任何画幅位置和比例都成立，
不需要为横屏再调一遍。

> **范围**：元素挂在**场景**上（`scene.elements`），但每个元素有自己的**场景内时间**
> （`from` / `durationInFrames`，相对场景开头）。放上去默认落在当前播放位置、长 3 秒，
> 之后可以在下方的**场景小时间轴**里拖动起点、拉伸时长。它跟着场景的转场一起进出。

**agent 也能用**：`list_element_library` 同时列出内置素材和「我的素材」；
`add_element` 用 `libraryId` 放进来——内置素材直接用 id，「我的素材」用 `asset:<id>`。
素材库没有合适的元素时它可以直接写 SVG（一段 `<path>` 就是图标），
或者用 `upload_asset` 上传自己生成的位图（**默认自动入库**，返回 `asset:<id>`，下次直接复用）——
**这些元素和用户手放的完全等价**，用户照样能拖、能改、能删。

实现上，自由元素和模板元素共用同一套选中/手势引擎：
元素在 DOM 里把自己登记进 `editRegistry`（key 是 `ov:<id>`，模板元素是 `sceneId::id`），
编辑层不分类型地测量和拖拽，落库时才按 id 前缀分派到 `update_element` 或 `set_transform`。

---

## 编辑器常用操作

| 操作 | 入口 |
|---|---|
| 播放 / 暂停 | `Space` |
| 撤销 | `Ctrl/Cmd + Z` |
| 重做 | `Ctrl/Cmd + Shift + Z` 或 `Ctrl + Y` |
| 复制选中元素 | `Ctrl/Cmd + D` |
| 全选当前场景元素 | `Ctrl/Cmd + A` |
| 微调选中元素 | 方向键 1%，`Shift` + 方向键 10% |
| 关闭浮层 | `Esc` |
| 增删画幅 / 自定义尺寸 | 顶部画幅条末尾的 `＋`：切预设，或输入任意宽高（16–7680）加一个自定义画幅 |
| **从模板新建** | 工程下拉菜单 → `＋ 新建项目` → 选模板 |
| 复制 / 删除工程 | 工程下拉菜单底部（删除会二次确认） |
| 清理渲染产物 | 工程下拉菜单 → 「清理渲染产物」（保留最近 5 次成片） |
| 取消渲染 | 渲染进度旁出现的「取消」按钮 |

### 场景类型

新增场景时顶部用**标签筛选**，下方是卡片网格；**鼠标悬停卡片会弹出线框预览**。当前 39 种：

| 分类 | 场景 |
|---|---|
| 通用（18） | 标题页 / 要点列表 / 数据图表 / 引用金句 / 图片页 / 步骤流程 / 字幕 / 前后对比 / 数据大字 / 空白场景 / 结尾 CTA / 视觉封面 / 图文分栏 / 卡片网格 / 多图网格 / 关注二维码 / 团队成员 / **极光封面** |
| 数据（3） | 环形数据 / 进度条组 / 数据表格 |
| 生活（3） | 生活 Vlog / 榜单清单 / 标签云 |
| 游戏（3） | 游戏封面 / 游戏战绩 / VS 对战 |
| 科技（2） | 科技发布 / **霓虹标题** |
| 教学（3） | 课程封面 / 时间线 / 对话气泡 |
| 直播（1） | 直播预告 |
| 电商（4） | 商品卡 / 价格表 / 倒计时 / 星级评价 |
| 情感（2） | 大字报 / **星光页** |

元素素材库 **57 个**（含光晕圆 / 霓虹框 / 渐变条 / 发光星 / 光点等光效元素），悬停元素卡片会放大预览。

### 转场

场景属性面板的「入场转场」和「出场转场」都有 8 种
（出场 = 同一套效果在场景结束前反向播放）；元素属性面板有独立的「入场特效」和「出场特效」，分别作用在元素开头和结尾。

| 转场 | 效果 |
|---|---|
| 硬切 / 淡入 | 直接切；叠化 |
| 上滑 / 擦除 | 从下往上推；自下而上揭开 |
| 推进 / 虚化 | 镜头向前；模糊聚焦 |
| 翻页 / 圆形展开 | 绕竖轴翻开；从中心扩散 |

时长 0–30 帧可调。8 个按钮在面板里放不下，那一行是**横向滚动**的（鼠标滚轮直接横移，或拖滚动条），
不会再撑破右栏。

新增一种转场只需要改 `shared/transitions.ts` **一处**（类型、选项、样式纯函数），
`schema.ts` 的 enum、属性面板按钮、MCP 的 `set_transition` 参数会自动跟上。

### 删除确认的边界

只有**不可撤销 / 破坏性大**的删除才弹确认框：

| 会确认 | 不确认（可 `Ctrl+Z` 撤销，高频操作不该被打断） |
|---|---|
| 删除工程、模板 | 删除画布上的元素 |
| 删除场景（整页内容） | 删除属性面板里的数组项（要点、步骤…） |
| 删除「我的素材」条目（文件删了不可恢复） | |
| 清理渲染产物（旧文件删了不可恢复） | |

确认框默认焦点在「取消」上，按 `Esc` 或点遮罩都能取消，回车不会误删。

工程菜单、画幅菜单、「新增场景」面板这类下拉，**点击区域外会自动收回**。

### 模板市场

不想每次都从空白拼场景：工程菜单里点 **`＋ 新建项目`** 会展开模板列表，
点一个就生成一份完整的新工程（文案、时长、转场都配好，改字就能用）。

**内置模板**（手写场景清单，定义在 `shared/templates.ts`）：

| 模板 | 场景构成 | 适合 |
|---|---|---|
| 空白工程 | 标题 → 结尾 | 自由发挥 |
| 口播带货 | 标题 → 卖点 → 步骤 → 口碑 → 下单引导 | 带货、转化 |
| 数据复盘 | 标题 → 图表 → 要点 → 金句 → 结尾 | 周报、复盘 |
| 产品发布 | 标题 → 产品图 → 特性 → 态度 → 预约 | 发布会、品牌 |

**我的模板**：把做好的工程存成模板 —— 工程菜单 → `＋ 新建项目` → 底部
「**＋ 把当前工程存成模板**」，起个名字即可。存的是**整片快照**：

- 场景、时长、转场、主题、画幅、背景音乐全部保留
- 模板元素的偏移（`transforms`）和自由元素（贴纸 / 图片 / 文字）原样带过去，
  套用出来和存的时候长得一样
- 工程里引用的 `/assets/*` 素材会**复制一份进模板目录**，所以删掉原工程、
  甚至把 `data/` 拷到另一台机器，模板里的图片和音频都不会 404
- 模板列表里每项右侧的 `✎` 重命名、`×` 删除；套用时素材再复制回 `public/assets/`

模板存在 `data/templates/<tpl_id>/`（`template.json` + `assets/`），和工程目录完全解耦：
删工程不影响模板，删模板也不影响已经套用出来的工程。

agent 也能用：`list_templates` 看模板（内置 + 我的），`create_project` 传
`templateKey`（内置）或 `templateId`（我的），`save_template` 把工程存成模板。
内置模板的清单在 `shared/templates.ts`，想加就往 `PROJECT_TEMPLATES` 里加一份场景清单。

### 工程包（备份 / 换机器 / 分享）

工程菜单里：

| 操作 | 说明 |
|---|---|
| 导出工程包 | 下载 `<工程名>.zip`，内含 `project.json` + `assets/` + `manifest.json` |
| 导入工程包… | 选一个 `.zip`，生成**新工程**（id 重新生成，不会覆盖本机同名工程） |

- 素材一起打包，换台机器解压即用（导入时素材写回 `public/assets/`）
- agent 也能做同样的事：`export_project` / `import_project`（默认导出到 `out/project-bundles/`）
- 包里的 `manifest.json` 记录导出时间、场景数、素材清单，方便排查
- 导入会对 `project.json` 做 schema 校验，坏包直接拒绝（400 + 具体哪一项不对）
- zip 由服务端用 Node 内置 `zlib` 手写（导出 stored、导入兼容 deflate），不引第三方依赖；
  测试里用 Python 标准 `zipfile` 反向校验过，是合法 zip

### 时间轴（多轨）

时间轴按「轨道」组织，越往下越像剪辑软件：

| 轨道 | 能做什么 |
|---|---|
| **场景** | 拖拽排序、右边缘拉伸改时长、点选 |
| **音乐** | 显示整条背景音乐，轨道头 `×` 清除 |
| **每条音效** | 一条独立轨道；块可拖动改起点、右边缘拉伸改时长、轨道头 `×` 删除 |

- 大时间轴管**整篇**：场景、背景音乐、音效
- 下方还有一条**场景小时间轴**：只处理当前场景里的元素（贴纸 / 文字 / 图片 / 视频）。
  **每个元素独占一行**（像剪辑软件的图层轨道），同一时间点的元素不会互相盖住：
  拖动块改场景内起点、右边缘拉伸改时长，块上直接显示起点帧；轨道头可点选/删除
- **吸附**：拖动/拉伸时自动吸附播放头、其他块边缘、场景首尾（至少 2 帧容差），并显示橙色吸附线
- **层级**：拖动小时间轴左侧轨道头上下排序，就是调整图层层级
- **多选**：`Shift / Ctrl` 点击块加选/减选，空白处拖出框选；多选后拖动任一块整组移动
- **分割**：`S` 或时间轴上的「分割」按钮，在播放头处把场景切成两段；
  小时间轴的「分割元素」把选中的元素切成两段
- 时间轴是**固定长度**：3 像素/帧，长片靠底部**横向滚动条**左右看（不再缩放）
- 横向滚动看长片，轨道多了整体可纵向滚动；左侧轨道头始终固定
- 顶部标尺显示秒数；点轨道区域或拖播放头定位

### 文本转语音（本地 TTS）

顶栏「语音」→ 两个页签：

- **配置**：服务地址（默认 OpenAI 兼容 `/v1/audio/speech`）、API Key、模型名、默认音色、格式（wav/mp3/ogg）；非标准接口可填「自定义请求体」JSON 模板（支持 `{{text}}` `{{voice}}` `{{speed}}` 占位）。配好点「测试连接」。
- **生成**：输入文本 → 生成 → 试听 → 一键「加入音效轨」或「设为背景音乐」。

配置存在 `data/tts-config.json`（本机，已 gitignore）。

**Qwen3-TTS 示例**（WSL2 + vLLM 生产部署，监听 8091，OpenAI 兼容）：

| 配置项 | 值 |
|---|---|
| 服务地址 | `http://127.0.0.1:8091/v1/audio/speech` |
| 格式 | `wav` |
| 语言 | `Chinese`（英文音色可切 English） |
| 自定义请求体 | 留空（用默认 OpenAI 兼容 body：`input` / `voice` / `instructions` / `language` / `response_format` / `speed`） |

音色列表会自动从 `{服务地址去掉 /v1/audio/speech}/v1/audio/voices` 拉取（`vivian` / `serena` / `uncle_fu` / `dylan` / `eric` / `ryan` / `aiden` / `ono_anna` / `sohee` / `default`），点一下即可切换。旧的 Windows 原生服务（`/tts` + `/speakers`）也仍然兼容。
音色列表会自动从 `{服务地址去掉 /tts}/speakers` 拉取（Vivian / Serena / Uncle_Fu / Dylan / Eric / Ryan / Aiden / Ono_Anna / Sohee），点一下即可切换。

生成页的「角色」是下拉框；点旁边的「试听」会用 `你好，我是{音色}，很高兴认识你。` 合成一句并自动播放（同一音色本会话内缓存，二次点击秒播）。

生成后除了「加入音效轨 / 设为背景音乐」，还可以选一个场景点「放入该场景」——这会生成一个场景内**音频元素**（kind=audio），跟着场景时间轴走，可以拖动/改时长/改音量。

场景时间轴的每个图层左边都有「小眼睛」（隐藏/显示）和——音频图层才有的——「声音开关」（静音）。隐藏的图层名称会划线，仍然可以选中/调时长。

语音弹窗关掉再打开会保留上次的文本、角色和刚生成的音频，可以继续「加入音效轨 / 设为背景音乐 / 放入该场景」。

生成时按钮右侧有实时计时器（完成后保留本次耗时），生成中显示旋转图标；文本下方有「转义」工具：日期（2026-10-25 → 2026年10月25日）、符号读法（% → 百分之、→ → 到）、去符号、年份读法（2026 → 二零二六）。

MCP 工具：`tts_synthesize`（可 `addAs=track|music` 直接落轨）、`get_tts_config`、`set_tts_config`。

**给 agent 的文本约定**（写在 `tts_synthesize` 的接口说明里）：

- 默认自动转义：`90%` → `百分之九十`、`2026-10-25` → `2026年10月25日`、`1234565` → `一百二十三万四千五百六十五`
- 不要传 Markdown / 代码 / 表情 / 特殊符号（`* _ ~ ^ | # @`）；需要表达时写中文（`→` 写"到"、`&` 写"和"、`+` 写"加"）
- 英文缩写按读音写（`API` → `A P I` 或写"接口"）
- 长文本按句子分段，每段 ≤ 200 字
- 已有自己的读法标记时可传 `escape=false` 关闭自动转义
- 传 `sceneId` 放进场景时，**旁白文字会同时写成该场景的字幕**（一次调用同时产出配音和字幕）。
  不想写字幕传 `subtitle=""`。

### 字幕

每个场景可以带一段字幕（属性面板的「字幕」框，一行一句）。

- 导出：工程菜单「导出字幕」→ `.srt`；MCP `export_subtitles` 可选 `srt` / `vtt`
- 字幕来源：场景的字幕字段优先；没写的话，`caption` 版式的正文自动当字幕用
- 一幕里有多句时，**按字数比例**分配这一幕的时长（中文语速大致恒定，等分会让长句念不完就被下一句盖掉）
- 时间码从全局帧号累计，所以和成片的时间完全对得上
- 目前只导出文件，**不会烧录进画面**

### 给 agent 留言（桥接）

不用切到 agent 页面：点编辑器右下角的「💬 agent」，直接发消息。
agent 通过 MCP 工具 `get_user_messages` 读取、`reply_user` 回复，回复会出现在同一个面板里（3 秒轮询）。

- 消息存在 `data/agent-chat.json`（本机数据，已 gitignore）
- 接口：`GET /api/agent/messages`、`POST /api/agent/messages`、`POST /api/agent/reply`、`POST /api/agent/read`

### 音频

- **背景音乐**：属性面板里设置，支持淡入淡出，从头铺到尾
- **音效轨**：时间轴底部的「＋ 音效」上传一段音频（wav / mp3 / ogg），会作为独立音轨叠加，
  每条有自己的**起点（帧）**、**音量**和**淡入秒数**，右侧 `×` 删除
- **人声避让（ducking）**：`set_audio(ducking={…})` 或属性面板开关，说话时自动把 BGM 压下去
- 背景音乐和音效轨都会跟着工程包 / 模板一起走

**上传的音频现在是入库的**（v0.98 起和图片一致）：默认进「我的素材」共用库（`assets/library/`），
跨工程可复用、能按名字查到、能 `delete_asset` 删掉；`registerToLibrary=false` 才落在本工程目录
（`assets/projects/<工程id>/`，删工程时一起清）。**TTS 合成的配音固定落工程目录**——
它是某个工程的中间产物，不该污染共用库。

三件和"声音好不好听"有关的工具（都在 MCP 侧，面板上对应的入口分别是「配平」「压缩」「卡点」）：

| 工具 | 解决什么 | 关键参数 |
|---|---|---|
| `balance_audio` | **段与段之间**响度不齐（这段人声大、那段 BGM 小） | `targetLufs` |
| `compress_audio` | **同一段内部**前轻后响（BGM 副歌炸、口播忽大忽小） | `ratio`（1 = 只做整体增益不压动态）、`maxGainDb` / `maxCutDb` |
| `analyze_audio` | 自动卡点：测 BPM + 拍点帧号 | 返回 `confidence`，**< 2.5 不要自动卡点**，问用户 BPM 后用 `set_beat_grid` |

`compress_audio` 的回执会把三件事说出来：多少个采样点被峰值卡住（再抬就削波）、
多少点已压到 `maxCutDb` 下限（ratio 再大也不会更平）、以及整体增益随 ratio 变化的实测均值。
`tts_check(deep=true)` 是真合成一句来验证 key/model/voice/format 全链路，产物不留——**开工先跑它**，
比跑到第 6 步才发现 TTS 没开便宜得多。

### 清理渲染产物

产物按工程分目录（v0.99 起）：

```
out/projects/<工程id>/
├── videos/      <工程名>_<时间>_<画幅>__<工程id>.mp4
├── stills/      <画幅>-<帧>.png
└── subtitles/   <工程名>_<时间>.srt
```

`out/videos`、`out/stills`、`out/subtitles` 三个老目录已退役（如果还有，清理时会一并收掉）。
产物面板按工程分组，**工程已删的产物单独一组显示为孤儿**，可以一次清掉。

工程菜单里的「清理渲染产物」/ MCP 的 `cleanup_renders`：

- **成片**：每个工程保留最近 5 个（`keepVideos` / 环境变量 `KEEP_VIDEOS`），更早的删掉
- **关键帧 / 字幕**：删除 7 天前的（`stillsDays`）
- `dryRun=true` 只报数量和可释放空间，不动手；`projectId` 可以只算某个工程
- 每次出片成功后也会自动清掉本工程更早的成片，不用手动点
- **删工程会连带删它的产物目录**（回执里写「产物目录：清掉 N 个…（x MB）」），
  但 `out/project-bundles/`（导出的 zip）**不跟着删**——那是交付/备份，删了就找不回来

### 历史与回滚

顶栏「历史」按钮列出最近的编辑（谁改的、改了什么、什么时候）。每隔一段时间服务端会把
当前版本存一份**磁盘快照**（`data/projects/<id>/history/<rev>.json`，保留最近 50 个），
带快照的那一行右侧有「回滚」按钮：

- 回滚 = 把工程恢复到那一版（场景、主题、名称、音频），**回滚本身也会记一条新历史**，
  所以回滚错了还能再回滚回来
- 回滚会清空当前撤销栈（它是"跳到另一版"，和逐条撤销不是一回事）
- 快照目录加了 `.gitignore`：它是本机辅助数据，换机器从当前工程继续即可

撤销/重做是**双栈**：撤销过的操作会进重做栈，一旦做了新编辑就清空重做链（和常见编辑器一致）。
上限 40 步。注意：agent 通过 MCP 做的修改**不进你的撤销栈** —— 它走的是同一条写入口但属于另一个 actor，
需要回退请用 `get_history` 找到对应 rev 后让 agent 改回。

---

## 新增一种场景

三步，属性面板和 agent 工具会自动长出来：

1. `shared/sceneMetas.ts` 里加一个 `SceneMeta`（zod schema + 默认值 + 时长范围）
2. `src/scenes/<name>/<Name>.tsx` 写渲染组件（只吃 props，不碰全局状态）
3. `src/scenes/components.tsx` 登记 `type → 组件`

---

## 工作空间（把数据放到别的盘）

三块目录会长大：`data/`（工程 + 历史快照）、`public/`（素材、配音）、`out/`（成片、关键帧）。
嫌它们占满某个盘时，顶栏 **「工作空间」** 可以把三块整体搬到任意目录：

1. 点「浏览…」逐层选目录（也能直接粘绝对路径），点「检查」先看方案：各搬多少、目标盘迁完还剩多少；
2. 确认后执行：**复制 → 核对文件数与字节数 → 删原件 → 在原位置留一个目录链接**。

搬完之后 `data/`、`public/`、`out/` 三个名字照旧可用（只是变成了指向新位置的链接），
编辑器、渲染、agent 都不用改，**服务也不用重启**。想搬回来点「搬回工程目录」即可。

### 三个容易误会的地方

**① 搬完旧路径里"数据还在"，不是没删干净。**
迁移完成后 `data/`、`public/`、`out/` 是 **Windows junction（目录链接）**，
资源管理器会正常走进去给你看文件——那就是新位置的那一份，**磁盘上没有第二份**。
想自己确认：

```bash
# 看链接指向哪（PowerShell）
Get-Item .\data | Select-Object LinkType, Target
# → LinkType=Junction  Target=D:\你的目标目录\data

# 单副本的证据：经旧路径写一个文件，新路径立刻能看到；删掉两边都没了
echo probe > data/_probe.txt && ls "D:/你的目标目录/data/_probe.txt" && rm data/_probe.txt
```

**② 搬到同一个盘 = 一点空间都不省。**
同卷内搬数据只是把文件挪了个位置（还多做一次复制 + 核对）。
如果你的目的是腾空间，目标必须选**另一个分区/另一块盘**；留在同一个盘就只是"数据与代码分离"，
这也是一种合理用法，但别指望可用空间变化。检查页会显示源盘/目标盘的剩余空间，
两边数字一样就说明你选在同卷了。

**③ 别用老工具递归删这个链接。**
junction 在某些同步工具、老式删除命令下会被"穿透"到目标目录里——那删的就是真数据。
要清理请用界面上的「搬回工程目录」，或先确认链接已解除再动手。
反过来，**在新盘上手动删掉目标目录** 也会让 `data/` 变成断链（服务启动时会尝试自愈，但不保证救得回来）。

其他注意点：

- 迁移期间别关服务、别编辑、别渲染——核对阶段有写入会导致文件数不一致而回滚；
- 配置记在根目录 `workspace.json`（本机绝对路径，不入 git）；
- `GET /api/workspace` 可以直接看当前状态：三块的真实路径、`linked` 是否为 true、文件数与占用。

## 目录

```
THIRD-PARTY-NOTICES  第三方依赖许可（含 Remotion / AGPL 的两个注意点）
LICENSE              本仓库代码的 MIT 许可
src/                 Remotion 渲染端
  layout/            useSceneLayout（多画幅唯一入口）
  scenes/            40 种内置场景类型（src/scenes 下 34 个组件目录，含 freeform / empty）
                     + 自由元素层 Overlay.tsx
shared/              数据契约（前后端 + agent 共用）
  schema.ts         Project / Scene / Format / Theme / OverlayElement
  ops.ts            op 定义 + reducer + normalizeOps（扁平写法在这里归一到 op 形状）
  sceneMetas.ts     场景元信息 + zod → 字段描述（属性面板与 agent 参数的同一来源）
  customTemplate.ts 自定义模板：工程快照 / 实例化 / 素材引用收集
  elementLibrary.ts 内置元素素材（图标 / 形状 / 标签）
  templates.ts      4 个内置整片模板
  audio.ts          增益曲线 / 压缩曲线 / 避让参数
  effects.ts        特效轨类型与关键帧 DSL
  freeform.ts       自由画布元素与动画
  transitions.ts    转场类型与时长规则
server/              唯一写入口 + 渲染队列 + MCP 代理
  project.service   工程读写 + rev + 广播（写盘唯一入口）
  store             project.json 读写 + 脏数据自愈（坏字段不让整个列表挂掉）
  assets.service    素材布局：library/ 共用库、projects/<id>/ 工程私有、_preview/ 临时
  library.service   「我的素材」索引（data/library.json）
  outputs.service   渲染产物（out/projects/<工程 id>/{videos,stills,subtitles}）
  workspace.service 工作空间：data/public/out 迁到别的盘（留 junction）、目录浏览
  audio-analysis.service  BPM / 拍点（essentia 懒加载，喂之前重采样到 22050）
  loudness.service  LUFS / 峰值 / 增益曲线
  media.service     素材时长（wav/mp3/ogg/mp4 纯 Node 读文件头，不调外部程序）
  static.service    静态服务（MIME + Range，音视频能播靠它）
  bundle.service    工程包导入导出（project.json + assets + manifest）
  zip.ts            最小 zip 读写（写 stored，读兼容 deflate）
  render.service    bundle 缓存 + 素材同步 + 渲染队列
  mcp-tools.ts      全部工具定义（93 个，含 4 个常驻门面）
  mcp-proxy.ts      stdio 代理（工具调用转发给 HTTP 服务）
  skills/           13 篇技能指南（list_guides / get_guide 读）
web/                 编辑器：预览 / 属性面板 / 时间轴 / 素材面板 / 详情浮窗
scripts/             启动 / 出片 / 恢复 demo / 单测 / 端到端验证
data/projects/<id>/  工程文件（可直接 git、可手改）+ history/ 快照 + brief.json
data/templates/<id>/ 我的模板：template.json + 打包的素材
data/agent-state.json  当前默认工程指针（跨进程共用，重启接上次的工程）
public/assets/
  library/           「我的素材」共用池（跨工程复用，删工程不动它）
  projects/<id>/     工程私有素材（含 TTS 配音，删工程连带清）
  _preview/          试听 / 预检的临时产物（按需创建，可被「清理未引用」收掉）
out/projects/<id>/   渲染产物（videos / stills / subtitles）
out/project-bundles/ 导出的工程包 zip（**不按工程删**，它是交付/备份）
```

**哪些不进 git**（都是运行时产物或本机状态，`clone` 下来服务启动会自动重建）：

| 路径 | 为什么不入库 |
|---|---|
| `public/assets/`（`library/` 与 `projects/<id>/` 都算） | 上传的图与视频、TTS 配音。会越攒越大，且换机器大概率不再需要 |
| `out/` | 成片 / 关键帧 / 字幕 / 导出包，纯产物 |
| `data/library.json` | 「我的素材」索引，条目全指向上面那批文件，入库只会让别人的素材面板全是打不开的图 |
| `data/audio-analysis.json`、`data/audio-loudness.json` | BPM / 响度缓存，删了会重算 |
| `data/projects/*/history/` | rev 快照，只服务本机回滚 |
| `data/agent-state.json` | 当前默认工程指针（本机状态，换机器重新选一次即可） |
| `data/agent-chat.json`、`data/tts-config.json` | 本机留言与语音服务地址 |
| `workspace.json` | 工作空间配置，存的是本机绝对路径 |
| `data/memory/`、`.workbuddy/memory/` | 本地项目笔记与记忆 |

整个 `data/`、`out/`、`public/` 都不入库：它们在本机可能是**指向别处工作空间的符号链接**，
而且里面基本都是运行时数据。首次启动时 `store.ensureDirs()` 会自动建目录并 seed 一个
`demo` 示例工程（**不引用任何素材文件**），所以 clone 下来直接 `npm start` 就能看到东西。

---

## 最近变更（v0.97 → v1.01）

按"用户能感知到什么"记，细节看 `设计方案.md` 与各服务文件头部注释。

| 版本 | 变化 | 你能看到什么 |
|---|---|---|
| v0.97 | **工具门面化**：常驻只留 4 个，其余 89 个走 `tool_search` / `tool_call` | 工具列表不再刷屏；`start_guide` 告诉你现在第几步 |
| v0.97 | 参数校验层：未知参数、类型、枚举全部当场拒绝 | 报错从"原生 JS 异常"变成「参数「X」不合法：原因；不认识的参数：Y（本工具可用：…）」 |
| v0.98 | **素材分目录**：`assets/{library,projects/<id>,_preview}` | 素材面板多了「本工程」页签；删工程真的腾出空间 |
| v0.98 | 素材**批量删除**、音频/视频也入库 | 多选删除；上传音频后能按名字查到、能删掉 |
| v0.99 | **产物分目录**：`out/projects/<id>/{videos,stills,subtitles}` | 产物面板按工程分组，孤立产物单独一组 |
| v1.00 | **工作空间换盘**、元素详情浮窗 | 数据可以搬去别的盘；点素材先看详情，拖动或「放入画面」才落地 |
| v1.01 | 静态服务换成自研（MIME + Range） | **音视频在详情浮窗里能播、能拖进度**（之前播放器在但点不动） |
| v1.01 | 节拍检测修采样率、压缩曲线逐点限幅、音频 op 字段白名单 | BPM 不再系统性偏低；压缩不再把安静段一刀砍掉，也不再在突变处削波 |

### 对调用方有影响的行为变更（如果你写过脚本调这些工具）

1. **未知参数会报错**：`tool_call` 里多传一个键会被拒绝并列出可用参数（以前静默忽略）。
2. **`update_scene` 的文案字段在 `props` 里**：`patch:{title}` 也能用（会自动按 props 处理并提示），
   但 `patch:{subtitle}` 写的是**字幕**，不是标题页的副标题。
3. **`set_audio` 是合并语义**：只传要改的字段，其余沿用；`ducking:null` / `gainCurve:null` 才是显式清除，
   换 `src` 时旧曲线与避让会自动丢弃并告警。
4. **`subtitleStyle.bold` 是数字字重**（`true`/`false` 会被归一成 700/400，但请直接传 100–900）。
5. **`delete_project` 语义**：删非当前工程不影响当前工程；删当前工程会明确告知落到哪个工程。
6. **显式 `projectId` 只影响本次调用**，不再顺带切"当前工程"；要切用 `switch_project`。
7. **被隐藏的工具必须走 `tool_call`**，直接调会报 `Tool X disabled`（门面模式的预期行为）。

---

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 接口返回乱码/超时 | 端口被占用（QQ 常占 4310）。换 `PORT` |
| 首次渲染卡住 | 正在下载 Chrome Headless Shell（~120MB）。本机有 Chrome/Edge 时会自动改用它们（`chromeMode: chrome-for-testing`），无需下载 |
| 报 `Old Headless mode has been removed` | 用 CLI 手动指定 Edge/Chrome 时忘了加 `--chrome-mode=chrome-for-testing`；服务端已内置该判断 |
| 改了场景组件，截图却没变 | 服务端按 src/shared 的 mtime 自动重打包；仍不变则检查是否有第二个服务进程占了端口 |
| **成片没声音 / 音轨报 404** | 渲染用的是打包快照，服务现在会在渲染前自动把 `public/` 的新素材同步进去（v0.82），日志里会打印「新增/更新/移除 N」。先确认素材本身没问题：用 `get_asset_info` 或 `GET /api/assets/probe?src=/assets/xxx.wav` 量一下，量不出来说明文件坏了或被截断；还不行就用 `refresh_bundle` 重建快照 |
| 新增素材后场景里能看到、出片却没有 | 同上，快照问题；另外检查音频元素的 `durationInFrames` 是否短于旁白（短了会循环播放） |
| 出片文字变方块 | 用了不含中文字形的字体。默认走 `Microsoft YaHei`，换字体前先确认字形覆盖 |
| 预览和成片不一致 | 检查 remotion / @remotion/* 版本是否**完全一致** |
| 渲染 OOM | 队列是串行的（并发 1），别手动改成并发多任务 |
| **迁移后旧路径里"数据还在"** | 那是 Windows junction（目录链接），看到的就是新位置那一份，**磁盘上没有第二份**。`Get-Item .\data \| Select LinkType,Target` 可确认；别用老工具递归删它 |
| 迁移完感觉没省空间 | 目标选在**同一个盘**了。同卷内搬数据只是换位置，要省空间必须换分区/换盘（检查页会显示两边剩余空间，一样就说明同卷） |
| 画面里的素材裂图 | 被引用的文件被删了。工程私有的在 `assets/projects/<id>/`，共用库的在 `assets/library/`；用 `check_project` 能提前扫出来 |
| 刚上传的素材在「我的」里找不到 | v0.98 之前音频/视频不入库（只有图片入）。已修：`upload_asset` 默认入库并回 `asset:<id>`；老版本请重新上传或传 `registerToLibrary=true` |
| 详情浮窗里的音视频点不动 | v1.01 之前静态服务给的是 `application/octet-stream`，浏览器拒绝解码。`curl -D - <url>` 看 `content-type` 是否为 `audio/wav` / `video/mp4` |

---

## 开源协议

**本仓库自身的代码**（`src/` `shared/` `server/` `web/` `scripts/` 与文档）以 **MIT** 发布，
全文见根目录 [`LICENSE`](LICENSE)：

```
MIT License · Copyright (c) 2026 Remotion Studio contributors
```

你可以自由使用、修改、商用、再分发，**唯一要求是保留版权声明与许可全文**。
软件按"原样"提供，不附带任何担保。

### 但依赖里有两个不是 MIT —— 请先看一眼

| 依赖 | 许可 | 什么时候需要额外授权 |
|---|---|---|
| `remotion` / `@remotion/*` | **Remotion License**（不是开源许可） | 个人、≤3 人的公司免费；**更大的公司需要向 Remotion 购买商业授权** |
| `essentia.js` | **AGPL-3.0** | 只用不改、且不对外提供服务时基本无感；**分发构建产物或做在线服务**时要履行 AGPL 义务（提供对应源码） |

**结论**：如果这是自用 / 团队内部用 / ≤3 人的小团队，两边都免费，可以放心用。
其余场景（对外 SaaS、公司规模较大、要分发安装包）请先读 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)，
那里有完整的依赖许可清单，以及"怎么把这两个换掉"的说明（`essentia.js` 可以只删节拍检测，代价是自动卡点变成手填 BPM）。

### 引用与署名

- 转载/基于本项目做衍生品，请保留 `LICENSE` 与 `THIRD-PARTY-NOTICES.md` 两个文件；
- 文档里引用截图或成片时，注明来源即可（没有强制的水印或署名要求）；
- 本项目是"个人工程实践"而非商业产品，接口与数据格式仍可能变，**对外承诺前请自己钉住版本**。


### 感谢

- 感谢  [garden-skills](https://github.com/ConardLi/garden-skills/)
本项目里面的模板风格借鉴了[garden-skills](https://github.com/ConardLi/garden-skills/)，
