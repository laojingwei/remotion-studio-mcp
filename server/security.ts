/**
 * 本地服务的安全边界。
 *
 * 为什么需要这一层：编辑器是个**能删文件、能起渲染、能改工程**的本地服务，
 * 而它默认只该被本机访问。之前有三处口子是敞开的：
 *
 *  1. `serve({ fetch, port })` 没传 hostname —— Node 在 hostname 为空时监听 `::`/`0.0.0.0`，
 *     同一局域网（公司网、咖啡馆 WiFi）任何设备打开浏览器就能用这个编辑器。
 *  2. `/mcp` 回 `Access-Control-Allow-Origin: *` —— 任意网页都能对它发跨站 JSON-RPC。
 *  3. 其余 REST 写接口虽然没设 CORS 头，但 `c.req.json()` 不校验 Content-Type，
 *     一个 `text/plain` 的简单请求（不触发预检）落地就会被执行。
 *     **"没设 CORS" 不等于 "防住了 CSRF"**，两者是不同的事。
 *
 * 策略（默认最严，需要时显式放开）：
 *  - 默认只监听 127.0.0.1；`HOST=0.0.0.0` 才对外，且启动日志会明确警告。
 *  - 写请求（非 GET/HEAD/OPTIONS）必须过两道：
 *      Host 必须是本机名（防 DNS rebinding，仅本机模式检查）
 *      Origin 若有，host 必须是本机名（挡浏览器跨站；非浏览器客户端不带 Origin，放行）
 *  - 对外模式下跳过 Host/Origin 校验（用户已明确选择开放），但仍不返回通配 CORS。
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/** `localhost:4380` / `[::1]:4380` / `127.0.0.1` → 去掉端口后的主机名 */
export function hostnameOf(hostOrUrl: string): string {
  const raw = hostOrUrl.trim();
  if (!raw) return "";
  // 完整 URL 的情况（Origin 头）
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      return new URL(raw).hostname.toLowerCase();
    } catch {
      return "";
    }
  }
  // host:port —— IPv6 形如 [::1]:4380，不能简单按 ":" 切
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end === -1 ? raw.toLowerCase() : raw.slice(0, end + 1).toLowerCase();
  }
  const colon = raw.lastIndexOf(":");
  return (colon === -1 ? raw : raw.slice(0, colon)).toLowerCase();
}

export const isLoopbackHostname = (h: string): boolean => LOOPBACK.has(h);

/**
 * 连接**来源 IP** 是否本机（IPv4 / IPv6 / IPv4-mapped IPv6）。
 * 与 hostnameOf 的区别：这个看的是 socket 的 remoteAddress，客户端伪造不了；
 * Host 头可以随手 -H 改，所以资源库管理面用它，不用 Host。
 */
export const isLoopbackAddress = (addr: string): boolean =>
  /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+|0:0:0:0:0:0:0:1|localhost)$/i.test(
    (addr ?? "").trim(),
  );

/** 是否为写请求（需要过安全校验） */
const isMutation = (method: string): boolean =>
  method !== "GET" && method !== "HEAD" && method !== "OPTIONS";

export type SecurityDecision =
  | { ok: true }
  | { ok: false; status: 403 | 421; reason: string };

/**
 * 纯函数，方便单测：给 method / host / origin / 是否对外模式，判断放不放行。
 *
 * `allowLan=false`（默认）：Host 与 Origin 都必须是本机名。
 * `allowLan=true`：不再校验（用户已用 HOST 显式开放），但调用方仍不应回通配 CORS。
 */
export function checkRequest(opts: {
  method: string;
  host?: string;
  origin?: string;
  allowLan: boolean;
}): SecurityDecision {
  if (!isMutation(opts.method)) return { ok: true };
  if (opts.allowLan) return { ok: true };

  const host = hostnameOf(opts.host ?? "");
  if (!host) return { ok: false, status: 421, reason: "缺少 Host 头" };
  if (!isLoopbackHostname(host)) {
    return {
      ok: false,
      status: 421,
      reason: `Host 不是本机地址（${host}）——默认只允许本机访问；确实要对外请用 HOST=0.0.0.0 启动`,
    };
  }

  const origin = (opts.origin ?? "").trim();
  // 非浏览器客户端（curl / MCP 代理 / tsx 脚本）不带 Origin：这类是本机进程，放行
  if (!origin) return { ok: true };
  if (origin === "null") {
    return { ok: false, status: 403, reason: "跨站请求被拒绝（Origin: null）" };
  }
  const oh = hostnameOf(origin);
  if (!oh || !isLoopbackHostname(oh)) {
    return {
      ok: false,
      status: 403,
      reason: `跨站写请求被拒绝（Origin: ${origin}）——只接受来自本机编辑器的请求`,
    };
  }
  return { ok: true };
}

/** `/mcp` 的 CORS：只回本机来源，不再用 `*` */
export function corsAllowOrigin(origin: string | undefined): string | null {
  if (!origin || origin === "null") return null;
  const h = hostnameOf(origin);
  return h && isLoopbackHostname(h) ? origin : null;
}
