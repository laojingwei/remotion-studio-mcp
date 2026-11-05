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
  USER_PLUGIN_DIR,
  pluginRoots,
  scanPlugins,
  activePlugins,
  pluginFiles,
  inferProvides,
  isPluginEnabled,
  setPluginEnabled,
  type DiscoveredPlugin,
  type PluginFile,
  type PluginScope,
} from "./discovery";

export {
  assertPermission,
  describePermission,
  describePermissions,
  invalidPermissions,
  PermissionDenied,
} from "./permissions";

export {
  HOOK_KINDS,
  HOOK_LABEL,
  ensurePluginHooks,
  hasHook,
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
  WIRED_PERMISSIONS,
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
