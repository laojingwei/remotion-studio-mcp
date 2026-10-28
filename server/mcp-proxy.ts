/**
 * MCP stdio 入口：只负责把工具注册到 stdio transport。
 * 工具定义在 server/mcp-tools.ts，HTTP 入口（server/index.ts 的 /mcp）复用同一份。
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer } from "./mcp-tools";

const server = buildMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[mcp] stdio 已启动，后端", process.env.SERVER_URL ?? "http://127.0.0.1:4380");
