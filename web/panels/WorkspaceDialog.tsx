import React, { useEffect, useState } from "react";
import {
  fetchWorkspace,
  relocateWorkspace,
  resetWorkspace,
  type RelocateResult,
  type WorkspaceStatus,
} from "../apiClient";
import { useDoc } from "../store";
import { askConfirm } from "../ui";
import { FolderPicker } from "./FolderPicker";

const GB = 1024 ** 3;
const fmtBytes = (n: number) =>
  n >= GB ? `${(n / GB).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(0)} MB` : `${Math.max(0, Math.round(n / 1024))} KB`;
const fmtFree = (n: number) => (n < 0 ? "未知" : `${(n / GB).toFixed(1)} GB 可用`);

const DIR_LABEL: Record<string, string> = {
  data: "工程数据（含历史快照）",
  public: "素材（上传 / 配音 / 图片）",
  out: "渲染产物（成片 / 关键帧 / 字幕）",
};

/**
 * 工作空间：把 data / public / out 搬到用户指定的磁盘。
 *
 * 交互刻意做成"先看方案、再确认"：迁移会移动几万个文件，
 * 目标盘不够或目标里已有同名非空目录时，必须在这里就说清楚，而不是点了才报错。
 */
export const WorkspaceDialog: React.FC<{ open: boolean; onClose: () => void }> = ({
  open,
  onClose,
}) => {
  const notify = useDoc((s) => s.notify);
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [dir, setDir] = useState("");
  const [plan, setPlan] = useState<RelocateResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [browsing, setBrowsing] = useState(false);

  const load = async () => {
    try {
      const st = await fetchWorkspace();
      setStatus(st);
      setDir((prev) => prev || st.workspaceDir || "");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "读取失败");
    }
  };

  useEffect(() => {
    if (open) {
      setPlan(null);
      setMsg("");
      void load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const check = async () => {
    if (!dir.trim() || busy) return;
    setBusy(true);
    setMsg("");
    try {
      const r = await relocateWorkspace(dir.trim(), true);
      setPlan(r);
    } catch (err) {
      setPlan(null);
      setMsg(err instanceof Error ? err.message : "检查失败");
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (!dir.trim() || busy) return;
    setBusy(true);
    setMsg("");
    try {
      const r = await relocateWorkspace(dir.trim(), false);
      const total = r.moved.reduce((a, m) => a + m.files, 0);
      setMsg(`已迁移 ${r.moved.length} 个目录 / ${total} 个文件到 ${r.target}，原位置已换成链接`);
      notify("工作空间已迁移");
      setPlan(null);
      await load();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "迁移失败");
    } finally {
      setBusy(false);
    }
  };

  const back = async () => {
    if (busy) return;
    setBusy(true);
    setMsg("");
    try {
      const r = await resetWorkspace(false);
      setMsg(`已把 ${r.moved.length} 个目录搬回工程目录`);
      notify("已搬回工程目录");
      await load();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "搬回失败");
    } finally {
      setBusy(false);
    }
  };

  const moved = !!status?.dirs.some((d) => d.linked);
  const need = plan ? plan.plan.filter((p) => !p.skip).reduce((a, p) => a + p.bytes, 0) : 0;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="ws-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ws-head">
          <span>工作空间</span>
          <span className="ws-sub">
            {status
              ? moved
                ? `已迁出 · 共 ${fmtBytes(status.totalBytes)}`
                : `在工程目录里 · 共 ${fmtBytes(status.totalBytes)}`
              : "读取中…"}
          </span>
          <button className="ghost" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="ws-body">
          <p className="ws-intro">
            data（工程数据）、public（素材）、out（渲染产物）是会长大的三块。换块盘放，
            工程目录就不会被撑爆。迁移后**原位置是一个指向新目录的链接**——编辑器、渲染、
            agent 的路径都不用改，服务也不用重启。
          </p>

          <div className="ws-dirs">
            {status?.dirs.map((d) => (
              <div className={`ws-dir ${d.problem ? "is-bad" : ""}`} key={d.name}>
                <div className="ws-dir-name">
                  <b>{d.name}/</b>
                  <span className="hint">{DIR_LABEL[d.name]}</span>
                </div>
                <div className="ws-dir-path" title={d.real}>
                  {d.linked ? `→ ${d.real}` : d.real}
                </div>
                <div className="ws-dir-meta">
                  {d.files} 个文件 · {fmtBytes(d.bytes)}
                  {d.linked ? " · 已迁出" : ""}
                  {d.problem ? ` · ⚠ ${d.problem}` : ""}
                </div>
              </div>
            ))}
          </div>

          <div className="ws-disks">
            <span>工程目录所在盘：{fmtFree(status?.rootFree ?? -1)}</span>
            <span>
              工作空间所在盘：{fmtFree(status?.workspaceFree ?? -1)}
              {status?.workspaceDir ? `（${status.workspaceDir}）` : "（同工程目录）"}
            </span>
          </div>

          <div className="ws-form">
            <label className="ws-label">把三块目录放到</label>
            <div className="ws-row">
              <input
                className="ws-input"
                placeholder="D:/remotion-workspace（要绝对路径，目录不存在会自动创建）"
                value={dir}
                onChange={(e) => {
                  setDir(e.target.value);
                  setPlan(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void check();
                  e.stopPropagation();
                }}
              />
              <button
                className="ghost"
                onClick={() => setBrowsing(true)}
                title="逐层点着选目录"
                disabled={busy}
              >
                浏览…
              </button>
              <button className="ghost" onClick={() => void check()} disabled={busy || !dir.trim()}>
                {busy ? "检查中…" : "检查"}
              </button>
            </div>
          </div>

          {plan ? (
            <div className="ws-plan">
              {plan.plan.map((p) => (
                <div className="ws-plan-row" key={p.name}>
                  <span className="ws-plan-name">{p.name}/</span>
                  <span className="ws-plan-to" title={p.to}>
                    {p.to}
                  </span>
                  <span className="ws-plan-meta">
                    {p.skip ? p.skipReason ?? "跳过" : `${p.files} 个 · ${fmtBytes(p.bytes)}`}
                  </span>
                </div>
              ))}
              <div className="ws-plan-sum">
                共需搬 {fmtBytes(need)}；目标盘迁移后剩 {fmtFree(plan.targetFreeAfter)}
                {plan.targetFreeBefore < 0 ? "（目标盘剩余未知，请自行确认）" : ""}
              </div>
              {plan.warnings.map((w) => (
                <div className="ws-warn" key={w}>
                  {w}
                </div>
              ))}
            </div>
          ) : null}

          {msg ? <div className="ws-msg">{msg}</div> : null}
        </div>

        {browsing ? (
          <FolderPicker
            start={dir.trim() || status?.workspaceDir || status?.root || undefined}
            onClose={() => setBrowsing(false)}
            onPick={(p) => {
              setDir(p);
              setPlan(null);
              setBrowsing(false);
            }}
          />
        ) : null}

        <div className="ws-foot">
          <span className="hint">迁移过程：复制 → 核对文件数与字节数 → 删原件 → 建链接</span>
          <div className="ws-actions">
            {moved ? (
              <button
                className="ghost"
                disabled={busy}
                onClick={() =>
                  askConfirm({
                    title: "把三块目录搬回工程目录？",
                    message:
                      "会把文件复制回工程目录并去掉链接。目标盘上的旧副本仍在，确认无误后你可以自己删掉。",
                    confirmLabel: "搬回",
                    onConfirm: () => void back(),
                  })
                }
              >
                搬回工程目录
              </button>
            ) : null}
            <button
              className="primary"
              disabled={busy || !dir.trim() || !plan}
              onClick={() =>
                askConfirm({
                  title: `迁移到 ${dir.trim()}？`,
                  message: `会移动 data / public / out（约 ${fmtBytes(need)}），原位置留下链接。迁移期间请不要关闭服务。`,
                  confirmLabel: "开始迁移",
                  onConfirm: () => void run(),
                })
              }
            >
              开始迁移
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
