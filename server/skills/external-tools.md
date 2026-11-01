
# 外部工具（.other_modules）

`<项目根>/.other_modules/` 存放**别人的开源项目**。故意不进仓库（.gitignore 已忽略，
只保留 `.gitkeep` 和 `README.md`），clone 下来是空的。

## 规矩

1. 里面的代码是第三方代码：**只跑下文写明的命令**，不要执行它仓库里的其他脚本
   （测试、CI 钩子、发布脚本都不跑）——那等于把任意代码执行权交给它。
2. 产物不留在工具目录里：统一落盘到 `public/assets/projects/<工程id>/` 下，让片子引用。
3. 每接入一个新工具：在 `.other_modules/README.md` 的表格里登记一行，并在本文件的
   「已知工具」下补一节（怎么装、怎么用、产物到哪）。

## 接入流程

```bash
# 1. 看有没有装
ls .other_modules/<工具名>   # 有 SKILL.md / 入口文件 = 已装

# 2a. 没有 → 优先请用户下载（zip 或 git clone 解压后目录名要对上）
# 2b. 用户让你自己下 → 试，失败是常态（本机实测：git ls-remote 通、
#     git clone 和 curl 到 codeload 都会挂）。失败就明确告诉用户"我下不动，需要你手动放"，
#     附上 README.md 表格里的仓库地址，不要反复重试。

# 3. 校验（以 anatomy 为例）
ls .other_modules/anatomy/SKILL.md .other_modules/anatomy/kit/iso-kit.mjs
```

## 已知工具

### anatomy — 等轴测技术插图

- 仓库：https://github.com/wheresryan22/anatomy（MIT）
- 它是什么：一个纯 Node 绘图库（`kit/`，无依赖）+ 方法论。把"一个抽象概念"画成
  "一台真实机器"：底板、立柱、旋钮、刻度、管线，每个零件有真实尺寸。
- 需要：Node 20.10+（跑 build 就行，**没有服务、没有端口、没有 npm install**）。
- 先读它的 `SKILL.md`（33K，工作流和工艺规则都在里面），再动手画。

**第一步永远是打开最接近的范例**（`examples/`，先看 `dial-indicator/`，它最小）：

```bash
cd .other_modules/anatomy && node examples/dial-indicator/build.mjs
```

**画我们自己的图**：在 `.other_modules/anatomy/figs/<名>/build.mjs` 写构建脚本
（import 相对路径 `../../kit/iso-kit.mjs`），最小骨架：

```js
import { mkdirSync, writeFileSync } from "node:fs";
import * as k from "../../kit/iso-kit.mjs";

const W = 600, H = 400;
const P = k.cameraOf({ scale: 1.6 });           // 等轴测相机
const parts = [];

// 底板：圆角平面从 z=0 拉高 14
const BASE = { x: -120, y: -70, w: 250, d: 140, r: 8 };
parts.push(k.slabOf(BASE, 0, 14, P, 8, 2));
// 一根立柱：cx, cy, 半径, 从 z=14 到 104
parts.push(k.cylinder(-60, 0, 7, 14, 90, P, 24, 1));

const svg = k.figureSvg({
  standalone: "dark",                            // 把 CSS 变量内嵌进 svg，脱离页面也能显示
  width: W, height: H,
  label: "一句话说清这台机器是什么、怎么动",
  body: parts,
});
mkdirSync("../../out", { recursive: true });
writeFileSync("../../out/<名>.svg", svg);        // 产物写到 anatomy/out/，不进片
```

- 每个可讲解的部件用 `<g data-part="名字">…</g>` 包起来——`iso` 场景靠它按帧高亮。
- 零件多了以后接几何审计（不穿模、端点必须落在支撑上）：
  抄 `examples/arcade-cabinet/build.mjs` 的 `A.recorder(P)` + `A.auditOrExit(R, P, {})`。
- 工艺要求读它的 SKILL.md：先写"概念 → 零件清单"再动手写几何；40–80 个零件才算一张
  Figure 级的图；细节来自机构本身，不是装饰。

**第一次画就会踩的四个坑**（2026-11-02 实画「倾角仪」全部踩过一遍）：

1. **`lathe()` / `prismOf()` 返回的是 paths 对象**（`{fill, outline, shades, crease, top}`），
   不是字符串 —— 必须再过一遍 `k.solidSvg(paths, { tone })` 才能放进 body。
   范例里的 `S(...)` 就是这个包装，漏了它零件直接变成 `[object Object]` 丢失。
   而 `knurl()` / `topTicks()` / `segment()` 返回的是 **d 字符串**，要用 `k.lineSvg(d, {tone})` 包。
2. **`fitProjection` 的取景点必须穷举每个零件的极值**。漏一个点（比如量角器盘的上缘
   `z = 盘心 + 半径`）不会报错，只是那个零件整个被推出画布顶 —— 画面上它"不存在"，
   而其它零件都在，看起来像渲染 bug，其实是取景框没算上它。
3. **先在纸上定 z 轴占用表再写代码**：底板 0–14 / 球 0–48 / 盘 52–156 / 悬臂 104–114。
   两件东西的 z 区间一重叠就是穿模（盘 R52 下缘 52 撞上球顶 48 这种，靠肉眼在成品里找很费劲）。
   零件多了以后接 `audit`（抄 `examples/arcade-cabinet` 的 `A.recorder`），它专门抓这个。
4. **面的朝向决定能不能看见**：量角器盘的盘面法线沿 +y（正对观众）时，
   在 azimuth 42° 的等轴测下投影成一个窄椭圆，刻度数字几乎不可读。
   盘面要么转 30–40° 让刻度斜对观众，要么接受它只是个"侧影 + 边缘读数"。
   写完先抽一帧看朝向，再补刻度。

**落盘 + 套主题**（一行命令，自动读工程主题、剥脚本、放进素材目录）：

```bash
node scripts/iso-embed.mjs .other_modules/anatomy/out/<名>.svg <工程id> <名>
# ✓ public/assets/projects/<工程id>/iso/<名>.svg
# 引用地址：/assets/projects/<工程id>/iso/<名>.svg
```

不要手写主题映射——`iso-embed` 已经做了（scripts/iso-theme.mjs）。要调明暗对比
改那个文件，别在 SVG 上打补丁。

**进片子**：加一幕 `iso` 场景（见 `shared/sceneMetas.ts` 的 isoMeta）：

- `src`：上面打印的引用地址；
- `focus`: `[{ part, at, dur, label }]`——按幕内帧号高亮零件，讲哪指哪；
- `camera`: `{ from, to, x, y }`——推镜，SVG 是矢量，推近不糊；
- 标题走 `caption`（2D 叠层）。

## 禁忌（都在实跑里撞过）

1. **中文不进 SVG**：标题、标注一律走 iso 场景的 2D 叠层。SVG 里塞中文字体，
   渲染端 fallback 不可控（和 scene3d「中文不进 3D」是同一条规矩）。
2. **不要手写 `--anatomy-*` 的值**：原版四档明暗只差 4%，进视频糊成一片；
   统一走 iso-embed 的映射（拉开到 8% 一档）。
3. **不要跳过 sanitize**：内联 SVG 前必须剥 `<script>` / `on*` / `foreignObject`。
   iso-embed 和 iso 渲染层各做一遍，两层都不能省。
4. **别把 anatomy 的交互脚本（live JS）带进片子**：那是给网页用的；
   视频里的"动"由 iso 场景按帧驱动（推镜 + 高亮），两者机制不同。
