/**
 * 版本号唯一来源 = package.json。
 *
 * 之前同一个版本号散在三处，且各不相同：
 *   package.json               1.0.8
 *   server/mcp-tools.ts        1.1.0（McpServer 的 serverInfo）
 *   server/index.ts            0.44.0（HTTP /mcp 的 initialize 回执）
 *   README.md                  1.1.0
 * 后果：MCP 宿主里显示的版本、npm 上的包、文档承诺三者对不上；
 * 发版 workflow 只比对 tag 与 package.json，查不出这类漂移。
 *
 * 用 createRequire 而不是 `import ... with { type: "json" }`：后者对 tsx / Node 小版本
 * 有额外要求，而这段代码在服务端、测试脚本、打包流程三处都会被执行，越朴素越稳。
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version?: string };

export const VERSION: string = pkg.version ?? "0.0.0";
export const SERVER_NAME = "remotion-studio";
