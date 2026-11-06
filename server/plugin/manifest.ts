/**
 * 插件清单（manifest）的类型与解析。
 *
 * ## 为什么 L0 插件允许**不写** manifest
 *
 * 插件化的第一步不是"加机制"，而是"别挡路"。一个人想加一份画质指南，
 * 最合理的行为是把 `quality.md` 丢进 `plugins/我的一坨/skills/` 就完事——
 * 如果这时候告诉他"请先写一个包含 id / version / apiVersion / provides 的 JSON"，
 * 他大概率会关掉文档去干别的。
 *
 * 所以：**有 manifest 就按 manifest 走，没有就按目录结构推断**。
 * 推断规则见 `discovery.ts` 的 `inferProvides`。
 *
 * ## 为什么 apiVersion 要卡死
 *
 * 插件会 import 宿主的类型与函数（`@studio/sdk`）。宿主升级后签名变了，
 * 老插件不是"功能缺失"而是**静默出错**——渲染出来是错的，没人报错。
 * 声明 apiVersion 至少能在加载时拦住这一类，并且报错要指路到 PLUGIN-GUIDE。
 */

/** 当前插件 API 版本。改动 `@studio/sdk` 的导出签名时**必须**加一。 */
export const PLUGIN_API_VERSION = 1;

/**
 * 插件能贡献的东西。分层见 docs/2026-11-05-插件化架构与实施计划.md。
 *
 * 白名单 = **宿主认得的名字**。认不认是一回事、生不生效是另一回事：
 * 生效的项在下面的 `IMPLEMENTED_PROVIDES` 里，两张表一起决定 `list_plugins` 怎么显示。
 * 别把只有大纲的东西加进来——写了被忽略比没写更让人迷惑。
 */
export const PROVIDE_KINDS = [
  /* ── L0 内容层 ── */
  "skill", //            skills/*.md            → list_guides / get_guide
  "style", //            styles/*.md            → list_styles / apply_style
  "template", //         templates/*.json       → 整片模板（/api/templates）
  "elements", //         elements/*.json        → 元素库（面板 + list_element_library）
  "scene3d.sky", //      scene3d/skies.json     → 3D 天空 + 打光配方
  "scene3d.preset", //   scene3d/presets.json   → 3D 母题配方（graph 配方，套用=换起手图）
  "scene3d.look", //     scene3d/looks.json     → 3D 光线风格（内置 4 套 + 插件）
  "scene3d.pass", //     scene3d/passes.json    → 3D 后期 pass（受控 GLSL，只在 post.passes 显式启用时上镜）
  /* ── L1 注册表层 ── */
  "brief.steps", //      brief/steps.json       → 问诊步骤（替换或追加）
  "scene", //            scenes/<type>.json + <type>.tsx → 新场景类型
  "hooks", //            plugin.ts              → 介入流程（自检 / 写入复盘 / 设计锁）
] as const;

export type ProvideKind = (typeof PROVIDE_KINDS)[number];

/** 贡献项的中文短名（`list_plugins` 与错误提示共用；光给 `scene3d.sky` 没人看得懂） */
export const PROVIDE_LABEL: Record<ProvideKind, string> = {
  skill: "技能指南",
  style: "风格规则",
  template: "整片模板",
  elements: "元素库",
  "scene3d.sky": "3D 天空/打光",
  "scene3d.preset": "3D 母题",
  "scene3d.look": "3D 观感",
  "scene3d.pass": "3D 后期 pass",
  "brief.steps": "问诊步骤",
  scene: "场景组件",
  hooks: "流程钩子",
};

/**
 * **当前版本真正接了消费方**的贡献项。
 *
 * 为什么要有这张表：`PROVIDE_KINDS` 描述的是架构支持的全集，而 `list_plugins` 面对的是用户——
 * 如果它显示"提供：元素库"，用户就会往 `elements/` 里放图标然后发现面板没变。
 * **能声明但没生效**是插件系统里最伤人的一类问题（比直接报错伤人，因为不报错）。
 * 所以没接的项必须在输出里标出来。
 *
 * 2026-11-06：`PROVIDE_KINDS` 全部接通。`scene3d.preset` 走的是**改方案后的语义**——
 * 不是代码插件，而是「图形配方」（一份 graph JSON，套用即换起手图），
 * 理由见计划文档 9.3 与 `shared/scene3dPresets.ts` 的注释。
 */
export const IMPLEMENTED_PROVIDES: ProvideKind[] = [
  "skill",
  "style",
  "brief.steps",
  "scene",
  "hooks",
  "template",
  "scene3d.sky",
  "elements",
  "scene3d.look",
  "scene3d.preset",
  "scene3d.pass",
];

/**
 * 权限。
 *
 * L0 插件一个权限都不需要（它只提供数据，不读工程也不写文件）；
 * 需要权限的只有 L2 代码插件——批次 4b 的 `plugin-tools.ts` 靠它拦住
 * "没声明却去读/写工程"。
 *
 * ## 为什么只有两条（2026-11-06 从 7 条缩到 2 条）
 *
 * 原来还有 `assets:read` / `assets:write` / `render` / `net` / `exec`，但这一版**没有任何
 * 对应 API**。而「能声明却不生效」比「没这个声明」更伤人：插件作者写了 `render`，
 * 然后花半天查"为什么没效果"。所以按本计划自己的原则，**宁可白名单小**：
 *
 * - `assets:*`：需要读素材的钩子走 `media:process`（拿的是 buffer，比开一个读盘 API 更窄），
 *   需要重跑处理链走 `reprocess_assets` 工具——不需要插件自己摸文件
 * - `render`：真实诉求是"渲染完通知我"，那是钩子（`ops:review` / 媒体处理），不是权限
 * - `net`：**永远不执法**。`plugin.ts` 是 `import()` 执行的任意代码，Node 里 `fetch` 本来就能用，
 *   声明它只是装饰品，反而让人误以为"没声明就联不上网"
 * - `exec`：**永不开放**。起子进程等于拿到这台机器的一切
 *
 * 真要加回来的条件：先有 API、先有执法点、先有调用它的插件——三者缺一就别加进白名单。
 */
export const PERMISSIONS = ["project:read", "project:write"] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type PluginManifest = {
  /** 唯一 id，小写字母/数字/短横线。用作启用状态的键，**不能改**（改了等于换了插件） */
  id: string;
  name: string;
  version: string;
  /** 插件针对的宿主 API 版本；不写按当前版本处理 */
  apiVersion: number;
  /** 显式声明贡献项；不写则按目录结构推断 */
  provides: ProvideKind[];
  permissions: Permission[];
  description?: string;
  author?: string;
  /** 代码插件入口（批次 4） */
  entry?: { server?: string };
  /** 渲染端组件（批次 3） */
  render?: { scenes?: string[] };
};

/**
 * 把 `package.json` 转成 manifest 的原始形状，再走同一套校验。
 *
 * 为什么要这条：工程化插件的"清单"天然就是 `package.json`——它有 name、version、
 * description、author。让作者再抄一份 `manifest.json` 是纯粹的重复，而且两份会漂。
 *
 * 插件专属的字段放进 `remotionStudio` 命名空间（provides / permissions / apiVersion），
 * 这样既不污染 npm 生态的约定，也不让 npm 工具链看不懂这个包。
 *
 * ```json
 * {
 *   "name": "@team/my-plugin",
 *   "version": "1.2.0",
 *   "remotionStudio": { "provides": ["hooks"], "permissions": ["project:read"] }
 * }
 * ```
 *
 * `id` 仍然取**目录名**而不是 `pkg.name`：npm 包名可能是 `@scope/name`，
 * 带斜杠和 @ 的 id 不能当启用状态的键。
 */
export function packageToManifest(pkg: Record<string, unknown>, dirId: string): unknown {
  const rs =
    pkg.remotionStudio && typeof pkg.remotionStudio === "object"
      ? (pkg.remotionStudio as Record<string, unknown>)
      : {};
  const author = typeof pkg.author === "string" ? pkg.author : undefined;
  return {
    id: dirId,
    name: typeof pkg.name === "string" ? pkg.name : dirId,
    version: typeof pkg.version === "string" ? pkg.version : "0.0.0",
    description: typeof pkg.description === "string" ? pkg.description : undefined,
    author,
    apiVersion: typeof rs.apiVersion === "number" ? rs.apiVersion : undefined,
    provides: Array.isArray(rs.provides) ? rs.provides : undefined,
    permissions: Array.isArray(rs.permissions) ? rs.permissions : undefined,
  };
}

export type ManifestParse = {
  manifest: PluginManifest | null;
  /** 非致命问题：能加载但要注意（如版本过旧、未知 provides 被忽略） */
  warnings: string[];
  /** 致命问题：不能加载（如 apiVersion 不兼容、id 非法） */
  errors: string[];
};

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * 目录名 → 合法 id。
 *
 * ## 为什么要有哈希兜底
 *
 * 中文目录名（`plugins/我的风格/`）是整个白名单字符都被吃掉的情况：
 * 归一化之后剩下空字符串。如果此时返回一个固定值（比如 `"plugin"`），
 * 那么**第二个中文插件就会拿到同一个 id**，然后在扫描时被当成"重复"静默跳过——
 * 用户看到的现象是"我明明放了两个，只认出来一个"，而且没有任何报错。
 *
 * 所以非 ASCII 名字走稳定短哈希：不同目录必然不同 id，同一目录每次都是同一个 id
 * （启用状态要按 id 存，必须稳定）。
 */
export function toPluginId(raw: string): string {
  const name = String(raw ?? "");
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s) return s;

  // FNV-1a 32 位：够散、够短、不引依赖
  let h = 0x811c9dc5;
  for (const ch of name) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `p${h.toString(36)}`;
}

/**
 * 解析 manifest。**永不抛错**——坏清单只该让这一个插件失效，
 * 不该让 `list_plugins` 整个工具挂掉（那会让用户看不到任何插件，
 * 也就看不到"到底是哪个插件写坏了"）。
 */
export function parseManifest(raw: unknown, opts: { dirId: string }): ManifestParse {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { manifest: null, warnings, errors: ["manifest.json 不是一个 JSON 对象"] };
  }
  const o = raw as Record<string, unknown>;

  const idRaw = typeof o.id === "string" && o.id.trim() ? o.id.trim() : opts.dirId;
  if (!ID_RE.test(idRaw)) {
    errors.push(`id「${idRaw}」不合法：只能用小写字母、数字、短横线，且不能以短横线开头`);
  }

  const apiVersion = typeof o.apiVersion === "number" ? o.apiVersion : PLUGIN_API_VERSION;
  if (apiVersion > PLUGIN_API_VERSION) {
    errors.push(
      `apiVersion ${apiVersion} 高于宿主支持的 ${PLUGIN_API_VERSION}——这个插件是为更新的版本写的，请升级宿主或换用旧版插件`,
    );
  } else if (apiVersion < PLUGIN_API_VERSION) {
    warnings.push(`apiVersion ${apiVersion} 低于当前 ${PLUGIN_API_VERSION}，部分接口可能已变`);
  }

  const providesRaw = Array.isArray(o.provides) ? o.provides : [];
  const provides: ProvideKind[] = [];
  for (const p of providesRaw) {
    if (typeof p !== "string") continue;
    if ((PROVIDE_KINDS as readonly string[]).includes(p)) provides.push(p as ProvideKind);
    else warnings.push(`未知的 provides 项「${p}」已忽略（可用：${PROVIDE_KINDS.join(" / ")}）`);
  }

  const permissions: Permission[] = [];
  for (const p of Array.isArray(o.permissions) ? o.permissions : []) {
    if (typeof p !== "string") continue;
    if ((PERMISSIONS as readonly string[]).includes(p)) permissions.push(p as Permission);
    else warnings.push(`未知权限「${p}」已忽略（可用：${PERMISSIONS.join(" / ")}）`);
  }

  if (errors.length) return { manifest: null, warnings, errors };

  return {
    manifest: {
      id: idRaw,
      name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : idRaw,
      version: typeof o.version === "string" && o.version.trim() ? o.version.trim() : "0.0.0",
      apiVersion,
      provides,
      permissions,
      description: typeof o.description === "string" ? o.description : undefined,
      author: typeof o.author === "string" ? o.author : undefined,
      entry: o.entry && typeof o.entry === "object" ? (o.entry as PluginManifest["entry"]) : undefined,
      render: o.render && typeof o.render === "object" ? (o.render as PluginManifest["render"]) : undefined,
    },
    warnings,
    errors,
  };
}
