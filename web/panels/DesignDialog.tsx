import { useCallback, useEffect, useMemo, useState } from "react";

import { fetchDesignCard } from "../apiClient";
import { renderMarkdown } from "../mdLite";

/**
 * 设计稿面板：把 export_design 出的那份 markdown 显示在屏幕上。
 *
 * 为什么需要一个面板而不是只在对话里贴：
 * 50 幕的稿子贴进对话要滚十几屏，用户看不完也找不到"第 23 幕"。这里能整篇读、
 * 表格对齐、勾选项带方框，他指位置时说的是"第三段那个表"，而不是"你往上翻"。
 */
type Props = {
  open: boolean;
  projectId: string;
  projectName?: string;
  onClose: () => void;
};

export const DesignDialog = ({ open, projectId, projectName, onClose }: Props) => {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");

  const load = useCallback(async () => {
    if (!projectId) return;
    setBusy(true);
    setErr("");
    try {
      const d = await fetchDesignCard(projectId);
      setMarkdown(d.markdown);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!open) return;
    setMarkdown(null);
    void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const html = useMemo(() => (markdown ? renderMarkdown(markdown) : ""), [markdown]);

  const copyAll = async () => {
    if (!markdown) return;
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied("已复制全文");
      window.setTimeout(() => setCopied(""), 2000);
    } catch {
      setCopied("复制失败，请手动选中");
    }
  };

  if (!open) return null;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="dd-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dd-head">
          <span className="dd-title">设计稿</span>
          <span className="dd-sub">{projectName ? `${projectName} · ` : ""}给人看的那一版，还没建场景</span>
          <span className="dd-spacer" />
          {copied ? <span className="dd-msg">{copied}</span> : null}
          <button className="ghost" onClick={() => void load()} disabled={busy}>
            {busy ? "读取中…" : "刷新"}
          </button>
          <button className="ghost" onClick={() => void copyAll()} disabled={!markdown}>
            复制全文
          </button>
          <button className="ghost" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="dd-body">
          {err ? <div className="dd-empty">{err}</div> : null}
          {!err && !markdown && !busy ? (
            <div className="dd-empty">
              还没有设计稿。
              <br />
              让 agent 先出一次：<code>export_design</code>（它会按当前分镜生成）。出完点右上「刷新」。
            </div>
          ) : null}
          {html ? (
            // 内容是我们自己生成的 markdown，renderMarkdown 已先转义再拼标签
            <article className="dd-md" dangerouslySetInnerHTML={{ __html: html }} />
          ) : null}
        </div>

        <div className="dd-foot">
          要改就在对话里说位置与改法（「第 3 幕大字换成…」「第 5 幕删掉」），agent 改完会重出一份，这里是新版。
        </div>
      </div>
    </div>
  );
};
