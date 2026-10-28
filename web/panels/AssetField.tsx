import React, { useRef, useState } from "react";
import { useDoc } from "../store";
import { uploadAsset } from "../apiClient";

/** 素材字段：上传到工程 assets，或直接贴 URL */
export const AssetField: React.FC<{
  value: string;
  accept: string;
  preview: "image" | "audio";
  onChange: (v: string) => void;
}> = ({ value, accept, preview, onChange }) => {
  const project = useDoc((s) => s.project);
  const notify = useDoc((s) => s.notify);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (file?: File | null) => {
    if (!file || !project) return;
    setBusy(true);
    try {
      const { url } = await uploadAsset(project.id, file);
      onChange(url);
      notify(`已上传 ${file.name}`);
    } catch (err) {
      notify(err instanceof Error ? err.message : "上传失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="field">
      <label>素材</label>
      {value ? (
        preview === "image" ? (
          <div className="asset-preview">
            <img src={value} alt="" />
          </div>
        ) : (
          <audio className="asset-audio" src={value} controls />
        )
      ) : null}
      <div className="asset-row">
        <input
          placeholder={busy ? "上传中…" : "/assets/… 或 https://…"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button className="mini" onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? "上传中" : "上传"}
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept={accept}
        style={{ display: "none" }}
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
};
