/**
 * 插件自己的配置存储。
 *
 * ## 为什么宿主不定义 schema
 *
 * 每家的配置结构只有插件自己知道（TTS 要 appid+token、别家要 region+secretKey、
 * 还有的要一段 JSON 凭据）。宿主定义 schema 就等于替插件决定"你能配什么"，
 * 而我们真正该做的是**给一个能存东西的地方**。
 *
 * 所以这里就是 `data/plugin-config.json`：
 * ```
 * { "plugins": { "<插件 id>": { ...插件自己写的任意 JSON... } } }
 * ```
 * 宿主只保证：能读、能按 key 合并写、不炸、有大小上限。
 *
 * ## 为什么不放进工程目录
 *
 * 插件配置是**这台机器上这个人**的偏好（密钥、端点），不是作品的属性。
 * 放进 data/projects 会跟着作品被复制/分享，密钥就泄了。
 */

import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "./paths";

const FILE = path.join(DATA_ROOT, "plugin-config.json");

/**
 * 单个插件的配置上限 64KB。
 *
 * 这不是防呆，是防事故：插件把自己的缓存/日志一股脑塞进来，
 * 会让每次读配置都变成几十兆的 JSON.parse（编辑器和合成都会变卡）。
 * 64KB 足够放几十个端点/密钥/开关。
 */
const MAX_BYTES = 64 * 1024;

type Store = { plugins: Record<string, Record<string, unknown>> };

/**
 * 插件 id 允许的形态：`my-plugin`、`@scope/name`、`com.foo.bar` 都见过。
 * 字符集里**包含 `/` 和 `.`**（scoped 包要用），所以必须单独拒掉 `..`——
 * 它会被拼进文件路径的语义里，属于"看起来是 id、实际是穿越"。
 */
const ID_RE = /^[A-Za-z0-9._@/-]{1,80}$/;
const idOk = (id: string) => ID_RE.test(id) && !id.includes("..");

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function read(): Store {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8")) as Partial<Store>;
    return { plugins: isPlainObject(raw?.plugins) ? (raw!.plugins as Store["plugins"]) : {} };
  } catch {
    // 文件不存在 / 被手改坏了：当成空配置，不阻断任何功能
    return { plugins: {} };
  }
}

function write(store: Store): void {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  // 先写临时文件再 rename：合成/保存同时发生时不会读到半个文件
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, FILE);
}

export function getPluginConfig(id: string): Record<string, unknown> {
  const key = String(id ?? "").trim();
  if (!idOk(key)) return {};
  return read().plugins[key] ?? {};
}

/**
 * 一层深合并写入（只合并顶层 key）。
 *
 * 为什么是"一层"：插件的配置基本都是扁平的（`{ endpoint, token, voice }`），
 * 真需要嵌套结构时把整个子对象一次写进来就是 —— 递归合并会让"想删掉嵌套里的某项"
 * 变得没有语法可用（合并语义下没法表达"删除"）。
 * 想整体替换就把整个对象重新 PUT 一遍。
 */
export function savePluginConfig(
  id: string,
  patch: unknown,
): { ok: true; config: Record<string, unknown> } | { ok: false; error: string } {
  const key = String(id ?? "").trim();
  if (!idOk(key)) return { ok: false, error: `插件 id 不合法：${JSON.stringify(id)}` };
  if (!isPlainObject(patch)) return { ok: false, error: "body 必须是一个 JSON 对象" };

  const store = read();
  const merged = { ...(store.plugins[key] ?? {}), ...patch };

  let text: string;
  try {
    text = JSON.stringify(merged);
  } catch {
    return { ok: false, error: "配置里有无法序列化的值（函数 / 循环引用）" };
  }
  if (text.length > MAX_BYTES) {
    return {
      ok: false,
      error: `配置太大（${(text.length / 1024).toFixed(1)}KB > ${MAX_BYTES / 1024}KB）。插件配置适合放端点/密钥/开关，不要放缓存数据`,
    };
  }

  store.plugins[key] = merged;
  write(store);
  return { ok: true, config: merged };
}

/** 诊断用：文件在哪、多大、有哪些插件存过配置 */
export function pluginConfigStats(): { file: string; plugins: string[]; bytes: number } {
  const store = read();
  let bytes = 0;
  try {
    bytes = fs.statSync(FILE).size;
  } catch {
    /* 还没有文件 */
  }
  return { file: FILE, plugins: Object.keys(store.plugins).sort(), bytes };
}
