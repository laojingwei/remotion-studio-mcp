# 第三方依赖与许可（THIRD-PARTY NOTICES）

本仓库自身代码以 **MIT** 发布（见 `LICENSE`）。但它依赖的第三方库各有自己的许可，
**其中两个不是宽松许可，商用 / 再分发 / 对外提供服务前必须自己确认**：

| 依赖 | 许可 | 影响 |
|---|---|---|
| `remotion` 及 `@remotion/*`（bundler / cli / renderer / player） | **Remotion License**（不是 MIT） | 个人与小团队免费；**公司规模超过 3 人需要向 Remotion 购买商业授权**。详见 `node_modules/remotion/LICENSE.md` 与 https://remotion.dev/license |
| `essentia.js` | **AGPL-3.0** | 强 copyleft。本项目只在节拍检测（`analyze_audio`）里用，且是**动态 `import()` 懒加载**——不用这个功能就不加载它；但如果你要分发本项目的构建产物或对外提供在线服务，AGPL 的义务（提供对应源码）需要自行评估 |

> **一句话**：MIT 覆盖的是"我们写的代码"，不包括上面这两个。
> 如果你的使用场景是「公司内部用 / 个人用 / ≤3 人的团队」，两边都免费；其余情况请先读原许可。

---

## 直接依赖清单（按 `node_modules` 实际安装版本读取）

| 包 | 版本 | 许可 |
|---|---|---|
| `remotion` | 4.0.538 | SEE LICENSE IN LICENSE.md（Remotion License） |
| `@remotion/bundler` | 4.0.538 | 同上 |
| `@remotion/cli` | 4.0.538 | 同上 |
| `@remotion/renderer` | 4.0.538 | 同上 |
| `@remotion/player` | 4.0.538 | 同上 |
| `@remotion/media-utils` | 4.0.538 | MIT |
| `essentia.js` | 0.1.3 | **AGPL-3.0** |
| `hono` | 4.13.13 | MIT |
| `@hono/node-server` | 1.19.17 | MIT |
| `@modelcontextprotocol/sdk` | 1.32.2 | MIT |
| `react` / `react-dom` | 19.3.1 | MIT |
| `zustand` | 5.0.16 | MIT |
| `zod` | 3.25.76 | MIT |
| `zod-to-json-schema` | 3.25.2 | ISC |
| `mpg123-decoder` | 1.0.3 | MIT |
| `typescript` | 5.9.3 | Apache-2.0 |
| `vite` | 6.4.5 | MIT |
| `@vitejs/plugin-react` | 4.7.0 | MIT |
| `tsx` | 4.23.15 | MIT |
| `concurrently` | 9.2.5 | MIT |
| `@types/node` / `@types/react` / `@types/react-dom` | 22.20.5 / 19.3.0 / 19.3.0 | MIT |

## 离线媒体处理

本项目有一条硬规则：**不 spawn 外部程序**（不调 ffmpeg、不调 imagemagick）。
所以媒体处理全部在 Node 里做完，涉及的"隐藏依赖"也一并列清楚：

| 能力 | 实现 | 许可 |
|---|---|---|
| wav / mp3 / ogg / mp4 时长（读文件头） | 自写（`server/media.service.ts`） | 本项目 MIT |
| mp3 解码（做响度分析用） | `mpg123-decoder`（纯 JS/WASM） | MIT |
| 响度（LUFS / 峰值） | 自写（`server/loudness.service.ts`） | 本项目 MIT |
| BPM / 拍点 | `essentia.js`（RhythmExtractor2013，WASM 懒加载） | **AGPL-3.0** |
| zip 读 / 写（工程包） | 自写，基于 Node 内置 `zlib` | 本项目 MIT |
| 出片 / 抽帧 | Remotion Renderer（内部使用 Chrome Headless Shell） | Remotion License |

## 自己复核一遍

依赖版本会变，以安装后的事实为准：

```bash
# 列出直接依赖的真实许可
node -e "const fs=require('fs');const p=require('./package.json');for(const d of [...Object.keys(p.dependencies),...Object.keys(p.devDependencies)]){try{const j=JSON.parse(fs.readFileSync('node_modules/'+d+'/package.json','utf8'));console.log(d.padEnd(34), (j.version||'').padEnd(10), j.license||'?')}catch(e){console.log(d.padEnd(34),'未安装')}}"

# Remotion 的完整许可原文
cat node_modules/remotion/LICENSE.md
```

## 如果你要换掉这两个"非宽松"依赖

- **去掉 `essentia.js`**：删除 `analyze_audio` 的节拍检测分支即可，其余音频功能（响度、配平、压缩、避让、TTS）都不依赖它。
  代价是「自动卡点」变成只能手填 BPM（`set_beat_grid`）。
- **去掉 Remotion**：等于换掉整个渲染内核，没有低成本方案。要么接受它的许可，要么换渲染器重写 `src/` 的合成层。
