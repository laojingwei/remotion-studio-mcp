import React, { useEffect, useState } from "react";
import type { LibraryItem } from "@shared/elementLibrary";
import type { CustomAsset } from "@shared/assetLibrary";
import type { ProjectAsset } from "../apiClient";

export type PreviewTarget =
  | { kind: "builtin"; item: LibraryItem }
  | { kind: "mine"; item: CustomAsset }
  | { kind: "project"; item: ProjectAsset };

const fmtBytes = (n?: number) =>
  !n ? "" : n >= 1024 * 1024 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/**
 * 素材预览浮窗。
 *
 * 为什么点一下要弹窗而不是直接放进场景：素材库里很多图标/贴纸长得像但含义不同
 * （「箭头」有 5 种、emoji 全是近似图形），直接落进画面后才发现拿错，就得"删了重放"。
 * 这里先给一个**大号预览 + 出处/尺寸/时长**，看清了再点「放入画面」；想快就一直拖。
 */
export const ElementPreview: React.FC<{
  target: PreviewTarget;
  onClose: () => void;
  onAdd: () => void;
  /** 有删除能力时才显示（内置素材没有） */
  onRemove?: () => void;
}> = ({ target, onClose, onAdd, onRemove }) => {
  // 浏览器解不了的编码（或有问题的容器）不该只留一个按不动的播放器，
  // 直接说清楚并给"在新窗口打开"，用户至少能确认内容是什么
  const [mediaError, setMediaError] = useState(false);
  const mediaUrl = target.kind === "builtin" ? "" : target.item.url;
  useEffect(() => setMediaError(false), [mediaUrl]);

  const title =
    target.kind === "builtin"
      ? target.item.name
      : target.kind === "mine"
        ? target.item.name
        : target.item.name;

  const meta: string[] = [];
  if (target.kind === "builtin") {
    meta.push("内置矢量素材", `分类：${target.item.cat}`);
    if (target.item.kind === "text") meta.push("文字模板");
  } else if (target.kind === "mine") {
    meta.push(`我的素材 · ${target.item.kind ?? "image"}`);
    if (target.item.bytes) meta.push(fmtBytes(target.item.bytes));
    if (target.item.duration) meta.push(`时长 ${target.item.duration.toFixed(1)}s`);
  } else {
    meta.push(`本工程文件 · ${target.item.kind}`);
    meta.push(fmtBytes(target.item.bytes));
    if (target.item.referenced) meta.push("工程正在用");
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="el-preview" onClick={(e) => e.stopPropagation()}>
        <div className="el-preview-head">
          <span className="el-preview-title" title={title}>
            {title}
          </span>
          <button className="ghost" onClick={onClose} title="关闭">
            关闭
          </button>
        </div>

        <div className="el-preview-stage">
          {target.kind === "builtin" ? (
            target.item.kind === "text" ? (
              <span
                className="lib-text"
                style={{
                  background: target.item.bg,
                  color: target.item.fill ?? "var(--text)",
                  fontWeight: target.item.weight ?? 700,
                  fontSize: 22,
                  padding: "8px 16px",
                }}
              >
                {target.item.text}
              </span>
            ) : (
              <svg
                viewBox={target.item.viewBox ?? "0 0 24 24"}
                width="150"
                height="150"
                fill={target.item.stroke ? "none" : "currentColor"}
                stroke={target.item.stroke ? "currentColor" : "none"}
                strokeWidth={target.item.strokeWidth ?? 2}
                strokeLinecap="round"
                strokeLinejoin="round"
                dangerouslySetInnerHTML={{ __html: target.item.svg ?? "" }}
              />
            )
          ) : mediaError ? (
            <div className="el-preview-mediafail">
              <p>浏览器解不了这个文件（编码不支持或文件已损坏）</p>
              <a href={target.item.url} target="_blank" rel="noreferrer" className="mini">
                在新窗口打开
              </a>
            </div>
          ) : target.item.kind === "video" ? (
            /* 视频/音频要看得到内容才有意义：直接给播放器，别只画一个 ▶ */
            <video
              className="el-preview-video"
              src={target.item.url}
              poster={"thumbUrl" in target.item ? target.item.thumbUrl : undefined}
              controls
              autoPlay
              loop
              playsInline
              preload="metadata"
              onError={() => setMediaError(true)}
            />
          ) : target.item.kind === "audio" ? (
            <div className="el-preview-audio">
              <span className="el-preview-audio-icon">♪</span>
              <audio
                className="el-preview-audio-player"
                src={target.item.url}
                controls
                autoPlay
                preload="metadata"
                onError={() => setMediaError(true)}
              />
            </div>
          ) : target.item.kind === "image" || !target.item.kind ? (
            <img src={target.item.url} alt={title} draggable={false} />
          ) : (
            <div className="el-preview-fileicon">
              ?
              <span>{target.item.kind}</span>
            </div>
          )}
        </div>

        <div className="el-preview-meta">{meta.join(" · ")}</div>
        {target.kind !== "builtin" && target.item.url ? (
          <div className="el-preview-path" title={target.item.url}>
            {target.item.url}
          </div>
        ) : null}

        <div className="el-preview-foot">
          <span className="hint">也可以直接把它拖到画面上（落点就是位置）</span>
          <div className="el-preview-actions">
            {onRemove ? (
              <button className="ghost danger" onClick={onRemove}>
                删除
              </button>
            ) : null}
            <button className="primary" onClick={onAdd}>
              放入画面
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
