/**
 * 插件子系统的统一入口。
 *
 * 外部（消费点、MCP 工具、测试）只从这里 import，不直接引具体文件——
 * 这样以后拆文件、换实现不用改调用方。
 */

export {
  PLUGIN_API_VERSION,
  PROVIDE_KINDS,
  PROVIDE_LABEL,
  IMPLEMENTED_PROVIDES,
  PERMISSIONS,
  parseManifest,
  toPluginId,
  type PluginManifest,
  type ProvideKind,
  type Permission,
} from "./manifest";

export {
  PROJECT_PLUGIN_DIR,
  PROJECT_PLUGIN_DIR_NAME,
  pluginRoots,
  scanPlugins,
  activePlugins,
  pluginFiles,
  inferProvides,
  isPluginEnabled,
  setPluginEnabled,
  seedExamplePluginsDisabled,
  type DiscoveredPlugin,
  type PluginFile,
  type PluginScope,
} from "./discovery";

export {
  describePermission,
  describePermissions,
  invalidPermissions,
  PermissionDenied,
} from "./permissions";

export {
  HOOK_KINDS,
  HOOK_LABEL,
  ensurePluginHooks,
  hasExampleEntry,
  hasHook,
  hookKindsOf,
  hookStatus,
  runHook,
  runTextPipeline,
  textStepsToNote,
  frozenSnapshot,
  resetHookCache,
  type HookKind,
  type HookContext,
  type HookVerdict,
  type HookStatus,
  type HookError,
  type TextKind,
  type TextStep,
  type TextPipelineResult,
} from "./hooks";

export {
  ensurePluginTools,
  pluginToolStatus,
  resetPluginToolCache,
  type PluginToolCtx,
  type PluginToolStatus,
  type PluginToolError,
} from "./plugin-tools";

export { pluginTools, pluginToolEntries, pluginToolNamesOf, type PluginToolEntry } from "./tool-registry";

export { buildParamShape, PARAM_TYPES, type ParamSpec, type ParamType } from "./tool-params";

export { pluginsToText } from "./summary";

/* 入口解析与工程化诊断：编辑器要显示"这个插件为什么没生效"，直接复用同一套判断 */
export {
  SCRIPT_ENTRIES,
  resolvePluginEntry,
  readPackageJson,
  declaresCodeEntry,
  lintPackage,
  type ResolvedEntry,
  type EntryKind,
  type PackageJson,
} from "./entry";

/* 安装器：clone / npm / 本地目录 → 装依赖 → 构建 → 校验，全在一个 job 里 */
export {
  startInstall,
  startRepair,
  getJob,
  listJobs,
  cancelJob,
  removePlugin,
  scanOrphanDirs,
  removeOrphanDir,
  detectSourceKind,
  guessTargetName,
  normalizeGitUrl,
  splitNpmSpec,
  cleanupPluginStaging,
  getRegistry,
  setRegistry,
  normalizeRegistry,
  DEFAULT_REGISTRY,
  REGISTRY_PRESETS,
  INSTALL_LOG_DIR,
  PLUGIN_TRASH_DIR,
  type InstallJob,
  type InstallInput,
  type OrphanDir,
  type InstallSourceKind,
  type InstallStep,
  type LogLine,
} from "./installer.service";
