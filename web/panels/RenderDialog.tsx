import React, { useEffect, useState } from "react";
import type { Project } from "@shared/schema";

export type RenderQuality = "low" | "standard" | "high";
export type RenderFormat = "mp4" | "gif" | "webm";

const FORMAT_OPTIONS: { key: RenderFormat; label: string; note: string }[] = [
  { key: "mp4", label: "MP4", note: "H.264 · 通用" },
  { key: "webm", label: "WebM", note: "VP8 · 网页/透明" },
  { key: "gif", label: "GIF", note: "无音频 · 动图" },
];

const QUALITY_OPTIONS: { key: RenderQuality; label: string; note: string }[] = [
  { key: "low", label: "省流", note: "2.5 Mbps · 文件最小" },
  { key: "standard", label: "标准", note: "6 Mbps · 平衡" },
  { key: "high", label: "高清", note: "12 Mbps · 画质优先" },
];

/**
 * 导出配置弹窗：选画幅 + 画质，再开始渲染。
 */
export const RenderDialog: React.FC<{
  open: boolean;
  project: Project | null;
  busy: boolean;
  onClose: () => void;
  onStart: (formats: string[], quality: RenderQuality, format: RenderFormat) => void;
}> = ({ open, project, busy, onClose, onStart }) => {
  const [formats, setFormats] = useState<string[]>([]);
  const [quality, setQuality] = useState<RenderQuality>("standard");
  const [format, setFormat] = useState<RenderFormat>("mp4");

  // 每次打开都重置为"全部画幅 + 标准"
  useEffect(() => {
    if (open && project) {
      setFormats(project.formats.map((f) => f.key));
      setQuality("standard");
      setFormat("mp4");
    }
  }, [open, project]);

  if (!open || !project) return null;

  const toggle = (key: string) =>
    setFormats((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="outputs-dialog render-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="outputs-head">
          <span>导出视频</span>
          <span className="outputs-sub">选好画幅和画质，开始渲染</span>
          <button className="ghost" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="render-body">
          <div className="render-section">
            <div className="render-label">画幅（可多选）</div>
            <div className="render-formats">
              {project.formats.map((f) => {
                const on = formats.includes(f.key);
                return (
                  <button
                    key={f.key}
                    className={`render-format ${on ? "is-on" : ""}`}
                    onClick={() => toggle(f.key)}
                  >
                    <span className="rf-label">{f.label || f.key}</span>
                    <span className="rf-size">
                      {f.width}×{f.height}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="render-section">
            <div className="render-label">画质</div>
            <div className="render-quality">
              {QUALITY_OPTIONS.map((q) => (
                <button
                  key={q.key}
                  className={`render-q ${quality === q.key ? "is-on" : ""}`}
                  onClick={() => setQuality(q.key)}
                >
                  <span className="rq-label">{q.label}</span>
                  <span className="rq-note">{q.note}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="render-section">
            <div className="render-label">格式</div>
            <div className="render-quality">
              {FORMAT_OPTIONS.map((f) => (
                <button
                  key={f.key}
                  className={`render-q ${format === f.key ? "is-on" : ""}`}
                  onClick={() => setFormat(f.key)}
                >
                  <span className="rq-label">{f.label}</span>
                  <span className="rq-note">{f.note}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="outputs-foot">
          <span className="hint">
            {formats.length ? `将导出 ${formats.length} 个文件` : "至少选一个画幅"}
          </span>
          <button
            className="primary"
            disabled={!formats.length || busy}
            onClick={() => onStart(formats, quality, format)}
          >
            {busy ? "渲染中…" : "开始渲染"}
          </button>
        </div>
      </div>
    </div>
  );
};
