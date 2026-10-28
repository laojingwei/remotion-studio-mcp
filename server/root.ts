import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 工程根目录：基于**文件位置**算，不依赖 process.cwd()。
 *
 * 为什么：MCP 除了 HTTP 模式，还有 stdio 代理（mcp-proxy）——
 * 它由客户端进程启动，cwd 经常不是工程目录。用 cwd 去拼
 * data/、server/styles、public/ 这些路径会全部落空。
 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
