import React, { useEffect, useRef, useState } from "react";

type Msg = { id: string; role: "user" | "agent"; text: string; at: string; read?: boolean };

/**
 * 编辑页 ↔ agent 的留言板。
 * 用户在这里发消息，agent 通过 MCP 读取并回复，不用切到 agent 页面。
 */
export const AgentChat: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      const res = await fetch("/api/agent/messages");
      const data = (await res.json()) as { messages?: Msg[] };
      setMessages(data.messages ?? []);
    } catch {
      /* 服务重启瞬间忽略 */
    }
  };

  useEffect(() => {
    if (!open) return;
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      await fetch("/api/agent/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: t }),
      });
      setText("");
      await load();
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <button
        className={`agentchat-fab ${open ? "is-open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title="给 agent 留言（不用切到 agent 页面）"
      >
        {open ? "×" : "💬 agent"}
      </button>

      {open ? (
        <div className="agentchat">
          <div className="agentchat-head">
            <span>给 agent 留言</span>
            <span className="agentchat-hint">agent 处理后回复会出现在这里</span>
          </div>
          <div className="agentchat-list" ref={listRef}>
            {messages.length ? (
              messages.map((m) => (
                <div key={m.id} className={`agentchat-msg is-${m.role}`}>
                  <span className="agentchat-role">
                    {m.role === "user" ? "我" : "agent"}
                    {m.role === "user" ? (
                      <span className={`agentchat-status ${m.read ? "is-read" : ""}`}>
                        {m.read ? "已读" : "等待 agent 读取"}
                      </span>
                    ) : null}
                  </span>
                  <span className="agentchat-text">{m.text}</span>
                </div>
              ))
            ) : (
              <div className="agentchat-empty">还没有消息，直接说要改什么就行</div>
            )}
          </div>
          <div className="agentchat-input">
            <textarea
              rows={2}
              value={text}
              placeholder="例如：把标题页的字改成…；或问 agent 当前项目状态（Enter 发送，Shift+Enter 换行）"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button
              className="primary"
              disabled={sending || !text.trim()}
              onClick={() => void send()}
            >
              {sending ? "发送中…" : "发送"}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
};
