import React, { useEffect, useMemo, useRef, useState } from "react";
import type { PlayerRef } from "@remotion/player";
import { describeFields, getMeta, type FieldDesc } from "@shared/sceneMetas";
import { MAX_VOLUME } from "@shared/schema";
import { gainForTarget } from "@shared/audio";
import { fetchCompressCurve, fetchLoudness, type LoudnessResult } from "../apiClient";
import { useDoc } from "../store";
import { AssetField } from "./AssetField";
import { ElementInspector } from "./ElementInspector";
import { EffectInspector } from "./EffectInspector";
import { SceneBoxSection } from "./SceneBoxSection";
import { FreeformInspector } from "./FreeformInspector";
import { TransitionSection } from "./TransitionSection";
import { RangeInput } from "../RangeInput";

/* ────────────────────────── 单字段控件 ────────────────────────── */

const Field: React.FC<{
  field: FieldDesc;
  value: unknown;
  onChange: (v: unknown) => void;
}> = ({ field, value, onChange }) => {
  if (field.kind === "enum") {
    return (
      <div className="field">
        <label>{field.label}</label>
        <div className="seg">
          {(field.options ?? []).map((opt) => (
            <button
              key={opt}
              className={`seg-item ${value === opt ? "is-on" : ""}`}
              onClick={() => onChange(opt)}
            >
              {opt === "left" ? "左对齐" : opt === "center" ? "居中" : opt}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (field.kind === "number") {
    return (
      <div className="field">
        <label>{field.label}</label>
        <input
          type="number"
          step={0.05}
          value={typeof value === "number" ? value : 0}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
    );
  }

  if (field.kind === "boolean") {
    return (
      <div className="field row">
        <label>{field.label}</label>
        <button className={`switch ${value ? "is-on" : ""}`} onClick={() => onChange(!value)}>
          <span />
        </button>
      </div>
    );
  }

  if (field.kind === "array") {
    const list = Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
    return (
      <div className="field">
        <label>{field.label}</label>
        <div className="array">
          {list.map((item, i) => (
            <div className="array-item" key={i}>
              <div className="array-item-head">
                <span>#{i + 1}</span>
                <button
                  className="mini"
                  onClick={() => onChange(list.filter((_, idx) => idx !== i))}
                  title="删除这一项"
                >
                  删除
                </button>
              </div>
              {(field.itemShape ?? []).map((sub) => (
                <Field
                  key={sub.key}
                  field={sub}
                  value={item[sub.key] ?? sub.default ?? ""}
                  onChange={(v) =>
                    onChange(list.map((it, idx) => (idx === i ? { ...it, [sub.key]: v } : it)))
                  }
                />
              ))}
            </div>
          ))}
          <button
            className="mini add"
            onClick={() => {
              const blank: Record<string, unknown> = {};
              for (const sub of field.itemShape ?? []) {
                blank[sub.key] = sub.default ?? (sub.kind === "number" ? 0 : "");
              }
              onChange([...list, blank]);
            }}
          >
            ＋ 添加一项
          </button>
        </div>
      </div>
    );
  }

  // 对象字段（如 freeform.background）：给 JSON 编辑器；解析失败不提交，避免写坏数据
  if (field.kind === "object") {
    const json = JSON.stringify(value ?? field.default ?? {}, null, 2);
    return (
      <div className="field">
        <label>{field.label}（JSON 对象）</label>
        <textarea
          rows={4}
          defaultValue={json}
          key={json}
          onBlur={(e) => {
            try {
              const parsed = JSON.parse(e.target.value || "{}");
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) onChange(parsed);
            } catch {
              e.target.value = json; // 解析失败还原，不落库
            }
          }}
        />
      </div>
    );
  }

  const text = typeof value === "string" ? value : "";
  const multiline = field.key === "text" || field.key === "subtitle" || text.length > 42;
  return (
    <div className="field">
      <label>{field.label}</label>
      {multiline ? (
        <textarea rows={3} value={text} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input value={text} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
};

/* ────────────────────────── 属性面板 ────────────────────────── */

export const Inspector: React.FC<{ playerRef?: React.RefObject<PlayerRef | null> }> = ({
  playerRef,
}) => {
  const project = useDoc((s) => s.project);
  const selectedId = useDoc((s) => s.selectedId);
  const apply = useDoc((s) => s.apply);
  const selection = useDoc((s) => s.selection);
  const selectedEffect = useDoc((s) => s.selectedEffect);
  const scene = project?.scenes.find((s) => s.id === selectedId) ?? null;
  const meta = scene ? getMeta(scene.type) : null;
  const fields = useMemo(() => (meta ? describeFields(meta.schema) : []), [meta]);

  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /**
   * 背景音乐响度：面板上要能看见「这段素材到底多响」，否则配平就是盲调。
   * 只测本地素材（/assets/…）：公网链接要下载文件，编辑器不做这件事。
   */
  const audioSrc = project?.audio?.src ?? "";
  const [audioInfo, setAudioInfo] = useState<LoudnessResult | null>(null);
  const [audioState, setAudioState] = useState<"idle" | "loading" | "failed">("idle");
  const [audioBusy, setAudioBusy] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setAudioInfo(null);
    setAudioError(null);
    if (!audioSrc.startsWith("/assets/")) {
      setAudioState("idle");
      return;
    }
    setAudioState("loading");
    fetchLoudness(audioSrc)
      .then((info) => {
        if (!alive) return;
        setAudioInfo(info);
        setAudioState("idle");
      })
      .catch(() => {
        if (!alive) return;
        setAudioState("failed");
      });
    return () => {
      alive = false;
    };
  }, [audioSrc]);

  useEffect(() => {
    setDraft(scene ? { ...(scene.props as Record<string, unknown>) } : {});
  }, [scene?.id, project?.rev]);

  const commit = (next: Record<string, unknown>) => {
    if (!scene) return;
    setDraft(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void apply([{ op: "update_scene", sceneId: scene.id, patch: { props: next } }]);
    }, 380);
  };

  if (!project) return null;

  // 选中特效时，整个右栏切成特效属性（和场景/元素属性没有交集）
  const effectClip = selectedEffect
    ? (project.effects ?? []).find((e) => e.id === selectedEffect)
    : undefined;
  if (effectClip) {
    return <EffectInspector clip={effectClip} fps={project.fps} playerRef={playerRef} />;
  }

  // 选中自由元素时，整个右栏切成元素属性
  if (selection.length === 1 && selection[0].startsWith("ov:")) {
    const el = scene?.elements?.find((e) => e.id === selection[0].slice(3));
    if (el) return <ElementInspector sceneId={scene!.id} el={el} />;
  }

  // 自由画布：用数据编辑背景与元素（模型生成、人可微调）
  if (scene?.type === "freeform") {
    return <FreeformInspector scene={scene} fps={project.fps} />;
  }

  const assetKey = fields.find((f) => f.key === "src")?.key;

  return (
    <aside className="panel right">
      <div className="panel-head">
        <span>属性</span>
        {meta ? <span className="tag">{meta.name}</span> : null}
      </div>

      <div className="panel-scroll">
        {scene && meta ? (
          <>
            <div className="field">
              <label>场景名称</label>
              <input
                value={scene.name}
                onChange={(e) => {
                  const name = e.target.value;
                  if (name === scene.name) return;
                  clearTimeout(timer.current);
                  timer.current = setTimeout(() => {
                    void apply([{ op: "update_scene", sceneId: scene.id, patch: { name } }]);
                  }, 380);
                }}
              />
            </div>

            <SceneBoxSection scene={scene} />

            <div className="field">
              <label>
                字幕
                <span className="num">
                  {(() => {
                    const raw = scene.subtitle ?? "";
                    if (!raw.trim() && scene.type === "caption") {
                      const t = scene.props?.text;
                      return typeof t === "string" ? `自动取用正文` : "";
                    }
                    const n = raw.split("\n").filter((x) => x.trim()).length;
                    return n ? `${n} 句` : "";
                  })()}
                </span>
              </label>
              <textarea
                className="subtitle-input"
                rows={3}
                placeholder={"一行一句字幕\n导出 SRT 时按字数比例分配这一幕的时长"}
                defaultValue={scene.subtitle ?? ""}
                key={scene.id}
                onChange={(e) => {
                  const text = e.target.value;
                  clearTimeout(timer.current);
                  timer.current = setTimeout(() => {
                    void apply([{ op: "set_subtitle", sceneId: scene.id, text }]);
                  }, 500);
                }}
              />
            </div>

            <div className="field">
              <label>
                时长 <span className="num">{(scene.durationInFrames / project.fps).toFixed(1)}s</span>
                <input
                  key={scene.durationInFrames}
                  type="number"
                  className="dur-input"
                  min={Math.max(0.1, Number((meta.duration.min / project.fps).toFixed(1)))}
                  step={0.1}
                  defaultValue={(scene.durationInFrames / project.fps).toFixed(1)}
                  title="直接输入秒数，回车确认"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                  }}
                  onBlur={(e) => {
                    const sec = Number(e.currentTarget.value);
                    if (!Number.isFinite(sec) || sec <= 0) return;
                    const durationInFrames = Math.max(1, Math.round(sec * project.fps));
                    if (durationInFrames === scene.durationInFrames) return;
                    void apply([{ op: "set_scene_timing", sceneId: scene.id, durationInFrames }]);
                  }}
                />
              </label>
              <RangeInput
                min={meta.duration.min}
                max={meta.duration.max}
                step={5}
                value={scene.durationInFrames}
                delay={200}
                onChange={(durationInFrames) =>
                  void apply([{ op: "set_scene_timing", sceneId: scene.id, durationInFrames }])
                }
              />
            </div>

            <TransitionSection scene={scene} />

            <div className="divider" />

            {fields.map((f) =>
              assetKey && f.key === assetKey ? (
                <AssetField
                  key={f.key}
                  value={typeof draft[f.key] === "string" ? (draft[f.key] as string) : ""}
                  accept="image/*"
                  preview="image"
                  onChange={(v) => commit({ ...draft, [f.key]: v })}
                />
              ) : (
                <Field
                  key={f.key}
                  field={f}
                  value={draft[f.key] ?? f.default ?? ""}
                  onChange={(v) => commit({ ...draft, [f.key]: v })}
                />
              ),
            )}
          </>
        ) : (
          <div className="empty">左侧选一个场景开始编辑</div>
        )}

        <div className="divider" />

        <div className="section-title">主题</div>
        <div className="swatches">
          {Object.entries(project.theme.palette).map(([key, color]) => (
            <label className="swatch" key={key}>
              <input
                type="color"
                value={color}
                onChange={(e) =>
                  void apply([{ op: "set_theme", palette: { [key]: e.target.value } }], {
                    snapshot: false,
                  })
                }
              />
              <span>{key}</span>
            </label>
          ))}
        </div>

        <div className="field">
          <label>圆角基准</label>
          <RangeInput
            min={0}
            max={6}
            step={0.2}
            value={project.theme.radius}
            delay={140}
            onChange={(radius) => void apply([{ op: "set_theme", radius }], { snapshot: false })}
          />
        </div>

        <div className="field">
          <label>动效强度</label>
          <div className="seg">
            {[
              { v: 0, label: "关" },
              { v: 1, label: "标准" },
              { v: 2, label: "更强" },
            ].map(({ v, label }) => (
              <button
                key={v}
                className={`seg-item ${(project.theme.motion ?? 1) === v ? "is-on" : ""}`}
                title={
                  v === 0
                    ? "关掉统一入场位移、数字滚动与氛围光斑（柱图生长这类版式自带动画仍在）"
                    : v === 2
                      ? "入场位移加大、带一点回弹，数字滚动更快"
                      : "默认档：轻微上浮淡入，与之前的画面一致"
                }
                onClick={() => void apply([{ op: "set_theme", motion: v }])}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="divider" />

        <div className="section-title">背景音乐</div>
        <AssetField
          value={project.audio?.src ?? ""}
          accept="audio/*"
          preview="audio"
          onChange={(src) =>
            void apply(
              [
                {
                  op: "set_audio",
                  audio: src
                    ? {
                        src,
                        volume: project.audio?.volume ?? 0.8,
                        fadeIn: project.audio?.fadeIn ?? 0.5,
                        fadeOut: project.audio?.fadeOut ?? 0.8,
                      }
                    : null,
                },
              ],
              { snapshot: false },
            )
          }
        />

        {project.audio ? (
          <>
            <div className="field">
              <label>
                音量{" "}
                <span className="num">
                  {project.audio.volume > 1.001
                    ? `放大 ${Math.round(project.audio.volume * 100)}%`
                    : `${Math.round(project.audio.volume * 100)}%`}
                </span>
              </label>
              <RangeInput
                min={0}
                max={MAX_VOLUME}
                step={0.05}
                value={project.audio.volume}
                delay={140}
                onChange={(volume) =>
                  void apply([{ op: "set_audio", audio: { ...project.audio!, volume } }], {
                    snapshot: false,
                  })
                }
              />
            </div>
            <div className="field">
              <label>
                响度{" "}
                <span className="num">
                  {audioState === "loading"
                    ? "测量中…"
                    : audioInfo
                      ? `${Number.isFinite(audioInfo.lufs) ? `${audioInfo.lufs} LUFS` : "静音素材"} · 峰值 ${audioInfo.peakDb}dBFS`
                      : audioState === "failed"
                        ? "测不出来（格式不支持？）"
                        : audioSrc
                          ? "公网链接测不了"
                          : "未选素材"}
                </span>
              </label>
              <div className="row-inline">
                <button
                  className="mini"
                  disabled={audioBusy || !audioInfo || !Number.isFinite(audioInfo?.lufs ?? NaN)}
                  title="按 BGM 目标 -23 LUFS 算增益；会被峰值上限拦住（宁可小声也不爆音）"
                  onClick={() => {
                    if (!audioInfo || !project.audio) return;
                    const d = gainForTarget({
                      lufs: audioInfo.lufs,
                      peakDb: audioInfo.peakDb,
                      targetLufs: -23,
                      maxGain: MAX_VOLUME,
                    });
                    setAudioError(
                      d.limitedBy === "peak"
                        ? `峰值限制：到 -23 LUFS 需 ${d.rawGain.toFixed(2)}×，会超过 -1dBFS，已按上限给 ${Math.round(d.gain * 100)}%`
                        : null,
                    );
                    void apply([
                      {
                        op: "set_audio",
                        audio: { ...project.audio!, volume: Math.round(d.gain * 100) / 100 },
                      },
                    ]);
                  }}
                >
                  配平到 -23
                </button>
                <button
                  className="mini"
                  disabled={audioBusy || !audioInfo || !audioSrc.startsWith("/assets/")}
                  title="按 200ms 短时响度生成增益曲线，把副歌炸/前轻后响压平（ratio 3:1）"
                  onClick={() => {
                    if (!project.audio) return;
                    setAudioBusy(true);
                    setAudioError(null);
                    fetchCompressCurve(audioSrc, { targetLufs: -23, ratio: 3 })
                      .then((r) =>
                        apply([
                          { op: "set_audio", audio: { ...project.audio!, gainCurve: r.curve } },
                        ]),
                      )
                      .catch((err: unknown) =>
                        setAudioError(err instanceof Error ? err.message : String(err)),
                      )
                      .finally(() => setAudioBusy(false));
                  }}
                >
                  {audioBusy ? "处理中…" : "压平动态"}
                </button>
              </div>
              {project.audio.gainCurve ? (
                <div className="hint" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span>
                    已压缩（{project.audio.gainCurve.values.length} 点 @{project.audio.gainCurve.stepMs}ms）
                  </span>
                  <button
                    className="mini"
                    onClick={() => {
                      // 合并语义下"不传"= 保持原值，清除必须显式传 null
                      void apply([
                        { op: "set_audio", audio: { src: project.audio!.src, gainCurve: null } as never },
                      ]);
                    }}
                  >
                    撤销
                  </button>
                </div>
              ) : null}
              {audioError ? (
                <div className="hint" style={{ color: "var(--warn, #d97706)" }}>
                  {audioError}
                </div>
              ) : null}
            </div>
            <div className="field">
              <label>
                淡入 <span className="num">{project.audio.fadeIn.toFixed(1)}s</span>
              </label>
              <RangeInput
                min={0}
                max={5}
                step={0.1}
                value={project.audio.fadeIn}
                delay={140}
                onChange={(fadeIn) =>
                  void apply([{ op: "set_audio", audio: { ...project.audio!, fadeIn } }], {
                    snapshot: false,
                  })
                }
              />
            </div>
            <div className="field">
              <label>
                淡出 <span className="num">{project.audio.fadeOut.toFixed(1)}s</span>
              </label>
              <RangeInput
                min={0}
                max={5}
                step={0.1}
                value={project.audio.fadeOut}
                delay={140}
                onChange={(fadeOut) =>
                  void apply([{ op: "set_audio", audio: { ...project.audio!, fadeOut } }], {
                    snapshot: false,
                  })
                }
              />
            </div>
            <div className="field">
              <label>起点 / 时长（秒）</label>              <div className="row-inline">
                <input
                  type="number"
                  className="dur-input"
                  min={0}
                  step={0.1}
                  defaultValue={((project.audio.from ?? 0) / project.fps).toFixed(1)}
                  title="从第几秒开始播"
                  onBlur={(e) => {
                    const sec = Math.max(0, Number(e.currentTarget.value) || 0);
                    void apply(
                      [
                        {
                          op: "set_audio",
                          audio: { ...project.audio!, from: Math.round(sec * project.fps) },
                        },
                      ],
                      { snapshot: false },
                    );
                  }}
                />
                <input
                  type="number"
                  className="dur-input"
                  min={0}
                  step={0.1}
                  defaultValue={
                    project.audio.durationInFrames
                      ? (project.audio.durationInFrames / project.fps).toFixed(1)
                      : ""
                  }
                  placeholder="到片尾"
                  title="播放长度，留空 = 一直播到片尾"
                  onBlur={(e) => {
                    const raw = e.currentTarget.value.trim();
                    const durationInFrames =
                      raw === "" ? null : Math.max(1, Math.round(Number(raw) * project.fps));
                    void apply(
                      // set_audio 是合并语义：清空「到片尾」必须显式传 null，不传 = 保持原值
                      [{ op: "set_audio", audio: { ...project.audio!, durationInFrames } as never }],
                      { snapshot: false },
                    );
                  }}
                />
              </div>
            </div>
            <div className="field">
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={!!project.audio.loop}
                  onChange={(e) =>
                    void apply(
                      [{ op: "set_audio", audio: { ...project.audio!, loop: e.target.checked } }],
                      { snapshot: false },
                    )
                  }
                />
                循环播放
              </label>
            </div>
          </>
        ) : null}
      </div>
    </aside>
  );
};
