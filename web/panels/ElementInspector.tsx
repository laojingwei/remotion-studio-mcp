import React, { useEffect, useRef, useState } from "react";
import type { OverlayElement } from "@shared/schema";
import { MAX_VOLUME } from "@shared/schema";
import { useDoc } from "../store";
import { TRANSITION_OPTIONS } from "@shared/transitions";
import { colorAlpha } from "@shared/color";
import { ColorPicker } from "./ColorPicker";
import { AssetField } from "./AssetField";
import { gainForTarget } from "@shared/audio";
import { fetchLoudness } from "../apiClient";

const KIND_LABEL: Record<OverlayElement["kind"], string> = {
  svg: "图形",
  text: "文字",
  image: "图片",
  video: "视频",
  audio: "音频",
};

const Num: React.FC<{
  label: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  onChange: (v: number) => void;
}> = ({ label, value, step = 1, min, max, suffix, onChange }) => (
  <div className="field">
    <label>
      {label}
      {suffix ? <span className="unit">{suffix}</span> : null}
    </label>
    <input
      type="number"
      value={Number.isFinite(value) ? Number(value.toFixed(2)) : 0}
      step={step}
      min={min}
      max={max}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v)) onChange(v);
      }}
    />
  </div>
);

/**
 * 自由元素的属性面板。
 *
 * 和场景属性面板并存：选中自由元素时整个右栏切成它，
 * 因为两类东西的字段没有交集，混在一起只会更难扫。
 */
export const ElementInspector: React.FC<{ sceneId: string; el: OverlayElement }> = ({ sceneId, el }) => {
  const apply = useDoc((s) => s.apply);
  const setSelection = useDoc((s) => s.setSelection);
  const rev = useDoc((s) => s.project?.rev ?? 0);

  const [draft, setDraft] = useState<OverlayElement>(el);
  /** 音频元素的响度读数：配平按钮要先知道"现在多响" */
  const [loud, setLoud] = useState<{ lufs: number; peakDb: number } | null>(null);
  const bgMemory = useRef<string>(el.bg && colorAlpha(el.bg) > 0 ? el.bg : "#C6F24E");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<Partial<OverlayElement>>({});

  // agent 或别的窗口改了它，同步过来；正在输入（有未提交的补丁）时不覆盖
  useEffect(() => {
    if (timer.current) return;
    setDraft(el);
  }, [el.id, rev]);

  const commit = (patch: Partial<OverlayElement>) => {
    setDraft((d) => ({ ...d, ...patch }));
    pending.current = { ...pending.current, ...patch };
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      const p = pending.current;
      pending.current = {};
      if (Object.keys(p).length) {
        void apply([{ op: "update_element", sceneId, elementId: el.id, patch: p }]);
      }
    }, 260);
  };

  const remove = () => {
    // 元素删除是可撤销的高频操作，不弹确认（Ctrl+Z 可回）
    setSelection([]);
    void apply([{ op: "remove_element", sceneId, elementId: el.id }]);
  };

  const isText = draft.kind === "text";

  return (
    <aside className="panel right">
      <div className="panel-head">
        <span>元素</span>
        <span className="tag">{KIND_LABEL[draft.kind]}</span>
      </div>

      <div className="panel-scroll">
        <div className="field">
          <label>名称</label>
          <input
            value={draft.name}
            onChange={(e) => commit({ name: e.target.value })}
            placeholder="图层名"
          />
        </div>

        <div className="field-row">
          <Num label="X" suffix="%" value={draft.x} step={0.5} onChange={(v) => commit({ x: v })} />
          <Num label="Y" suffix="%" value={draft.y} step={0.5} onChange={(v) => commit({ y: v })} />
        </div>

        <div className="field">
          <label>
            {isText ? "字号" : "尺寸"}
            <span className="unit">短边 %</span>
          </label>
          <div className="slider-row">
            <input
              type="range"
              min={isText ? 1 : 2}
              max={isText ? 24 : 60}
              step={0.5}
              value={draft.size}
              onChange={(e) => commit({ size: Number(e.target.value) })}
            />
            <span className="slider-val">{draft.size.toFixed(1)}</span>
          </div>
        </div>

        <div className="field">
          <label>
            旋转<span className="unit">度</span>
          </label>
          <div className="slider-row">
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              value={draft.rotate}
              onChange={(e) => commit({ rotate: Number(e.target.value) })}
            />
            <span className="slider-val">{Math.round(draft.rotate)}°</span>
          </div>
        </div>

        <div className="field">
          <label>不透明度</label>
          <div className="slider-row">
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={draft.opacity}
              onChange={(e) => commit({ opacity: Number(e.target.value) })}
            />
            <span className="slider-val">{Math.round(draft.opacity * 100)}%</span>
          </div>
        </div>

        <div className="field">
          <label>{draft.kind === "svg" && draft.stroke ? "线条颜色" : "颜色"}</label>
          <ColorPicker value={draft.fill} onChange={(v) => commit({ fill: v })} />
          <input
            className="color-text"
            value={draft.fill}
            onChange={(e) => commit({ fill: e.target.value })}
          />
        </div>

        <div className="field">
          <label className="check-row">
            <input
              type="checkbox"
              checked={!!draft.bg}
              onChange={(e) => {
                if (e.target.checked) {
                  // 记住的颜色可能是全透明（以前调过），别把"勾上了但看不见"当正常
                  const remembered =
                    colorAlpha(bgMemory.current) > 0 ? bgMemory.current : "#C6F24E";
                  commit({ bg: remembered });
                } else {
                  if (draft.bg) bgMemory.current = draft.bg;
                  commit({ bg: "" });
                }
              }}
            />
            背景色
          </label>
          {draft.bg ? (
            <ColorPicker
              value={draft.bg}
              fallback="#17171F"
              onChange={(v) => {
                bgMemory.current = v;
                commit({ bg: v });
              }}
            />
          ) : null}
        </div>

        <div className="field">
          <label>入场特效</label>
          <div className="seg seg-scroll">
            {TRANSITION_OPTIONS.map((t) => (
              <button
                key={t.key}
                className={`seg-item ${(draft.enter?.type ?? "none") === t.key ? "is-on" : ""}`}
                title={t.hint}
                onClick={() =>
                  commit({
                    enter: {
                      type: t.key,
                      durationInFrames:
                        t.key === "none" ? 0 : draft.enter?.durationInFrames || 12,
                    },
                  })
                }
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {draft.enter && draft.enter.type !== "none" ? (
          <div className="field">
            <label>
              入场时长 <span className="num">{draft.enter.durationInFrames} 帧</span>
            </label>
            <div className="slider-row">
              <input
                type="range"
                min={4}
                max={60}
                step={1}
                value={draft.enter.durationInFrames}
                onChange={(e) =>
                  commit({
                    enter: { ...draft.enter!, durationInFrames: Number(e.target.value) },
                  })
                }
              />
              <span className="slider-val">{draft.enter.durationInFrames}f</span>
            </div>
          </div>
        ) : null}

        <div className="field">
          <label>出场特效</label>
          <div className="seg seg-scroll">
            {TRANSITION_OPTIONS.map((t) => (
              <button
                key={t.key}
                className={`seg-item ${(draft.exit?.type ?? "none") === t.key ? "is-on" : ""}`}
                title={t.hint}
                onClick={() =>
                  commit({
                    exit: {
                      type: t.key,
                      durationInFrames:
                        t.key === "none" ? 0 : draft.exit?.durationInFrames || 12,
                    },
                  })
                }
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {draft.exit && draft.exit.type !== "none" ? (
          <div className="field">
            <label>
              出场时长 <span className="num">{draft.exit.durationInFrames} 帧</span>
            </label>
            <div className="slider-row">
              <input
                type="range"
                min={4}
                max={60}
                step={1}
                value={draft.exit.durationInFrames}
                onChange={(e) =>
                  commit({
                    exit: { ...draft.exit!, durationInFrames: Number(e.target.value) },
                  })
                }
              />
              <span className="slider-val">{draft.exit.durationInFrames}f</span>
            </div>
          </div>
        ) : null}

        {isText ? (
          <>
            <div className="field">
              <label>文字内容</label>
              <textarea
                rows={2}
                value={draft.text ?? ""}
                onChange={(e) => commit({ text: e.target.value })}
                placeholder="输入文字"
              />
            </div>
            <div className="field-row">
              <div className="field">
                <label>字重</label>
                <select
                  value={draft.weight}
                  onChange={(e) => commit({ weight: Number(e.target.value) })}
                >
                  {[400, 500, 600, 700, 800, 900].map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </>
        ) : null}

        {draft.kind === "image" ? (
          <AssetField
            value={draft.src ?? ""}
            accept="image/*"
            preview="image"
            onChange={(v) => commit({ src: v })}
          />
        ) : null}

        {draft.kind === "audio" ? (
          <>
            <AssetField
              value={draft.src ?? ""}
              accept="audio/*"
              preview="audio"
              onChange={(v) => commit({ src: v })}
            />
            <div className="field">
              <label>
                音量<span className="unit">1 = 原音，可到 {MAX_VOLUME}</span>
              </label>
              <div className="slider-row">
                <input
                  type="range"
                  min={0}
                  max={MAX_VOLUME}
                  step={0.05}
                  value={draft.audioVolume ?? 1}
                  onChange={(e) => commit({ audioVolume: Number(e.target.value) })}
                />
                <span className="slider-val">{(draft.audioVolume ?? 1).toFixed(2)}</span>
              </div>
              <div className="hint" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span>{loud ? `${loud.lufs} LUFS · 峰值 ${loud.peakDb}dBFS` : "点右侧测响度"}</span>
                <button
                  className="mini"
                  title="按人声目标 -16 LUFS 算增益（峰值超 -1dBFS 时会被拦住）"
                  onClick={() => {
                    const src = draft.src ?? "";
                    if (!src.startsWith("/assets/")) return;
                    fetchLoudness(src)
                      .then((info) => {
                        setLoud({ lufs: info.lufs, peakDb: info.peakDb });
                        if (!Number.isFinite(info.lufs)) return;
                        const d = gainForTarget({ lufs: info.lufs, peakDb: info.peakDb, targetLufs: -16, maxGain: MAX_VOLUME });
                        commit({ audioVolume: Math.round(d.gain * 100) / 100 });
                      })
                      .catch(() => setLoud(null));
                  }}
                >
                  配平到 -16
                </button>
              </div>
            </div>
            <div className="field">
              <label>
                起始帧<span className="unit">从音频第几帧开始</span>
              </label>
              <div className="slider-row">
                <input
                  type="range"
                  min={0}
                  max={900}
                  step={1}
                  value={draft.startFrom}
                  onChange={(e) => commit({ startFrom: Number(e.target.value) })}
                />
                <span className="slider-val">{draft.startFrom}f</span>
              </div>
            </div>
          </>
        ) : null}

        {draft.kind === "video" ? (
          <>
            <AssetField
              value={draft.src ?? ""}
              accept="video/*"
              preview="image"
              onChange={(v) => commit({ src: v })}
            />
            <div className="field">
              <label>视频选项</label>
              <div className="seg">
                <button
                  className={`seg-item ${draft.muted ? "is-on" : ""}`}
                  onClick={() => commit({ muted: !draft.muted })}
                  title="视频声音默认关掉，避免和背景音乐打架"
                >
                  {draft.muted ? "已静音" : "有声音"}
                </button>
                <button
                  className={`seg-item ${draft.loop ? "is-on" : ""}`}
                  onClick={() => commit({ loop: !draft.loop })}
                >
                  {draft.loop ? "循环播放" : "播一次"}
                </button>
              </div>
            </div>
            <div className="field">
              <label>
                起始帧<span className="unit">从视频第几帧开始</span>
              </label>
              <div className="slider-row">
                <input
                  type="range"
                  min={0}
                  max={300}
                  step={1}
                  value={draft.startFrom}
                  onChange={(e) => commit({ startFrom: Number(e.target.value) })}
                />
                <span className="slider-val">{draft.startFrom}f</span>
              </div>
            </div>
          </>
        ) : null}

        <div className="field">
          <label>
            图层<span className="unit">越大越靠前</span>
          </label>
          <div className="slider-row">
            <input
              type="range"
              min={0}
              max={30}
              step={1}
              value={draft.z}
              onChange={(e) => commit({ z: Number(e.target.value) })}
            />
            <span className="slider-val">{draft.z}</span>
          </div>
        </div>

        <div className="inspector-actions">
          <button className="ghost danger" onClick={remove}>
            删除元素
          </button>
        </div>

        <div className="hint-block">
          自由元素不跟模板排版走，坐标是画面百分比，换任何画幅都成立。
          agent 也能改它（MCP 的 <code>update_element</code> / <code>remove_element</code>）。
        </div>
      </div>
    </aside>
  );
};
