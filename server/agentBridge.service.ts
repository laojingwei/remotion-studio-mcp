import fs from "node:fs";
import { ROOT as PROJECT_ROOT } from "./root";
import path from "node:path";

/**
 * 编辑页 ↔ agent 的留言板（桥接接口）。
 *
 * 用户在编辑器里发消息 → 写入 data/agent-chat.json；
 * agent 通过 MCP 工具 get_user_messages 读取、reply_user 回复；
 * 编辑页轮询 /api/agent/messages 显示对话。
 */
export type AgentMessage = {
  id: string;
  role: "user" | "agent";
  text: string;
  at: string;
  read: boolean;
};

const DATA_DIR = path.join(PROJECT_ROOT, "data");
const FILE = path.join(DATA_DIR, "agent-chat.json");
const MAX_MESSAGES = 200;

function readAll(): AgentMessage[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8")) as { messages?: AgentMessage[] };
    return Array.isArray(parsed.messages) ? parsed.messages : [];
  } catch {
    return [];
  }
}

function writeAll(messages: AgentMessage[]) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ messages }, null, 2), "utf8");
}

export function listMessages(limit = 100): AgentMessage[] {
  return readAll().slice(-limit);
}

export function addMessage(role: AgentMessage["role"], text: string): AgentMessage {
  const clean = text.trim().slice(0, 4000);
  if (!clean) throw new Error("消息不能为空");
  const msg: AgentMessage = {
    id: `msg_${Math.random().toString(36).slice(2, 10)}`,
    role,
    text: clean,
    at: new Date().toISOString(),
    // agent 自己的回复默认已读；用户消息等 agent 读取后才算已读
    read: role === "agent",
  };
  const all = readAll();
  all.push(msg);
  writeAll(all.slice(-MAX_MESSAGES));
  return msg;
}

export function unreadUserMessages(): AgentMessage[] {
  return readAll().filter((m) => m.role === "user" && !m.read);
}

export function markUserMessagesRead(): number {
  const all = readAll();
  let changed = 0;
  for (const m of all) {
    if (m.role === "user" && !m.read) {
      m.read = true;
      changed++;
    }
  }
  if (changed) writeAll(all);
  return changed;
}
