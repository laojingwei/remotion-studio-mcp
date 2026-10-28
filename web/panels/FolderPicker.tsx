import React, { useEffect, useState } from "react";
import { fetchDirs, type DirListing } from "../apiClient";

const GB = 1024 ** 3;
const fmtFree = (n: number) => (n < 0 ? "" : `${(n / GB).toFixed(1)} GB 可用`);

/**
 * 目录浏览器：一层层点着选，避免让用户手打路径（也避免服务端弹原生对话框）。
 *
 * 进来先列盘符，点进去列子目录，顶部面包屑可以往回跳；底部「用这个目录」把路径交回调用方。
 */
export const FolderPicker: React.FC<{
  /** 初始位置（空 = 从盘符列表开始） */
  start?: string;
  onPick: (dir: string) => void;
  onClose: () => void;
}> = ({ start, onPick, onClose }) => {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const open = async (dir?: string) => {
    setLoading(true);
    setError("");
    try {
      setListing(await fetchDirs(dir));
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取目录失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void open(start?.trim() || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const crumbs = (listing?.path ?? "")
    .split(/[\\/]/)
    .filter(Boolean)
    .reduce<{ label: string; path: string }[]>((acc, seg, i, all) => {
      // Windows 第一段是盘符（D:），拼回去要带反斜杠
      const prev = acc[acc.length - 1]?.path;
      const next = i === 0 ? `${seg}\\` : `${prev}${prev?.endsWith("\\") ? "" : "\\"}${seg}`;
      acc.push({ label: seg, path: next });
      return acc;
    }, []);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="fp-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="fp-head">
          <span>选择目录</span>
          <span className="fp-free">{listing ? fmtFree(listing.free) : ""}</span>
          <button className="ghost" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="fp-crumbs">
          <button className="mini" onClick={() => void open(undefined)} title="回到盘符列表">
            此电脑
          </button>
          {crumbs.map((c) => (
            <button
              key={c.path}
              className="mini"
              onClick={() => void open(c.path)}
              title={c.path}
            >
              {c.label}
            </button>
          ))}
          {listing?.parent ? (
            <button className="mini" onClick={() => void open(listing.parent!)} title={listing.parent}>
              上一级
            </button>
          ) : null}
        </div>

        <div className="fp-list">
          {loading ? <div className="empty">读取中…</div> : null}
          {!loading && listing?.entries.length === 0 ? (
            <div className="empty">这个目录下没有子目录，可以直接选它</div>
          ) : null}
          {!loading &&
            listing?.entries.map((e) => (
              <button key={e.path} className="fp-item" onClick={() => void open(e.path)} title={e.path}>
                <span className="fp-icon">▸</span>
                <span className="fp-name">{e.name}</span>
              </button>
            ))}
          {error ? <div className="fp-error">{error}</div> : null}
        </div>

        <div className="fp-foot">
          <span className="fp-current" title={listing?.path ?? ""}>
            {listing?.path ?? ""}
          </span>
          <div className="fp-actions">
            <button className="ghost" onClick={onClose}>
              取消
            </button>
            <button
              className="primary"
              disabled={!listing?.path}
              onClick={() => listing?.path && onPick(listing.path)}
              title={listing?.path ? `选定 ${listing.path}` : "先点进一个目录（不能选「此电脑」）"}
            >
              用这个目录
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
