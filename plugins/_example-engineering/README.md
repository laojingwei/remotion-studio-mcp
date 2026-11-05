# 示例插件：节奏检查（工程化写法）

这是一个**完整的工程项目**，不是单文件脚本。它演示了插件该有的样子：

```
_example-engineering/
  package.json      ← 清单 + 依赖 + 构建脚本（宿主从这里读 name/version/exports）
  src/index.ts      ← 源码（你想怎么写就怎么写，可以 import 任何 npm 包）
  dist/index.mjs    ← 构建产物（宿主真正加载的东西）
  README.md
```

改名成 `_example-engineering` 以外的名字（或直接就这样）就会生效，**不用重启**。

## 两种插件形态，怎么选

| | 单文件 `plugin.ts` | 工程（本示例） |
|---|---|---|
| 适合 | 几十行的小规则、贴一段正则 | 有依赖、有构建、要发 npm、多人维护 |
| 谁编译 | 宿主用 esbuild 现场编译 | **你自己**（`npm run build`） |
| 能用 npm 依赖 | ❌（会被内联，原生模块直接失败） | ✅ 从插件自己的 `node_modules` 解析 |
| 能用原生模块（sharp 等） | ❌ | ✅ |
| 能用你的 tsconfig 别名 | ❌ | ✅ |
| 改完要做什么 | 什么都不用做 | 重新 `npm run build`（宿主会自动重载） |

**一句话**：只有一个文件就写单文件；一旦要 `npm i` 东西，就做成工程。

## 宿主是怎么找到它的

按顺序：

1. `package.json` 的 `exports["."]`（`import` → `default` → `require`）
2. `package.json` 的 `module`
3. `package.json` 的 `main`
4. 都没有就看 `dist/index.mjs` 这类约定路径

找到的如果是 `.js` / `.mjs` / `.cjs` → **直接 `import()`，不打包**。
如果是 `.ts` → 退回宿主编译（等于单文件模式）。

**所以入口一定要指向构建产物**，不要指向 `src/index.ts`——否则你自己的构建流程就被绕过了。

## 依赖是怎么工作的

插件自己 `npm install` 的东西，从**插件自己的** `node_modules` 解析。这是 Node 的标准行为，宿主不需要做任何事。

但有一条**硬约定**：

> `react` / `react-dom` / `remotion` / `@remotion/*` **不能**写进 `dependencies`。

它们必须由宿主提供（写进 `peerDependencies`）。否则插件会自带一份另一个版本的 React，渲染时就是那句经典的 `Invalid hook call`——报错点在宿主代码里，查半天查不到插件头上。

宿主会在加载时检查，写进 `dependencies` 会直接进 `list_plugins` 的警告里。

## 你要做什么

```bash
cd plugins/我的插件
npm install
npm run build
```

宿主**不会**替你跑这两条命令。`npm install` 会联网、会执行 `postinstall` 脚本（= 在用户机器上跑任意代码），这种事不能藏在"扫一下插件目录"里。

没构建的话，`list_plugins` 会明确告诉你：

```
入口不可用：package.json 把入口指向 dist/index.mjs，但这个文件不存在。
在该插件目录执行：npm install && npm run build
```

## 这个插件做什么

三条节奏检查，跑在 `audit_project` 自检里：

- 幕短于 1.2s（一闪而过，读不完任何东西）
- 超过 6s 又没有字幕（观感像卡死）
- 最长的一幕吃掉全片一半以上（节奏是"一坨"）

## 从哪改成你自己的

1. 改 `package.json` 的 `name` / `version` / `description`
2. 改 `src/index.ts` 里的逻辑
3. `npm run build`
4. 刷新编辑器——不用重启服务

`remotionStudio.provides` 决定宿主认为它提供什么（`hooks` / `tool` / `media.process` 等都走代码入口）。不写也能按入口导出推断，但写了更早暴露"这个包到底是不是插件"。
