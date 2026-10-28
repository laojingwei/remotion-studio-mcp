import React from "react";
import type { PlayerRef } from "@remotion/player";
import type { CustomKey, EffectClip, EffectType } from "@shared/effects";
import {
  EFFECT_CREATABLE,
  EFFECT_CURVES,
  EFFECT_CURVE_LABEL,
  effectColorable,
  effectDefaultColor,
  effectDefaults,
  effectLabel,
  effectParamsOf,
  effectSummaryText,
} from "@shared/effects";
import { useDoc } from "../store";
import { RangeInput } from "../RangeInput";
import { ColorPicker } from "./ColorPicker";

/** 覆盖层类特效的常用色（闪白/闪黑/闪金…一秒切换） */
const SWATCHES = ["#FFFFFF", "#000000", "#FFD166", "#FF5A5F", "#4FD1C5", "#7C5CFF"];

/** 关键帧上"改过哪些通道"——只列真正写了的，避免面板满屏 0/1 */
const KEY_CHANNELS: { key: keyof CustomKey; label: string; unit?: string }[] = [
  { key: "x", label: "x", unit: "%" },
  { key: "y", label: "y", unit: "%" },
  { key: "scale", label: "缩放", unit: "×" },
  { key: "rotate", label: "旋转", unit: "°" },
  { key: "skewX", label: "斜切", unit: "°" },
  { key: "opacity", label: "不透明" },
  { key: "blur", label: "模糊", unit: "px" },
  { key: "brightness", label: "亮度", unit: "×" },
  { key: "contrast", label: "对比", unit: "×" },
  { key: "saturate", label: "饱和", unit: "×" },
  { key: "grayscale", label: "去色" },
  { key: "hueRotate", label: "色相", unit: "°" },
  { key: "overlayOpacity", label: "覆盖层" },
];

const keyText = (k: CustomKey) => {
  const bits = KEY_CHANNELS.filter((c) => typeof k[c.key] === "number").map(
    (c) => `${c.label} ${(k[c.key] as number).toFixed(2).replace(/\.?0+$/, "")}${c.unit ?? ""}`,
  );
  if (k.overlay) bits.push(`色 ${k.overlay}`);
  return bits.length ? bits.join(" · ") : "（无变化）";
};

/**
 * 特效属性面板。
 *
 * 选中时间轴上的特效块后，整个右栏切成它（和元素/场景属性没有交集，
 * 混在一起只会更难找）。所有改动都走 `update_effect`，一次改动 = 一步撤销。
 *
 * 参数区**不是写死的**：按 `EFFECT_PARAMS` 自动生成滑杆 —— 加一个新参数只需要
 * 在 `shared/effects.ts` 的表里加一行，这里不用动。
 */
export const EffectInspector: React.FC<{
  clip: EffectClip;
  fps: number;
  playerRef?: React.RefObject<PlayerRef | null>;
}> = ({ clip, fps, playerRef }) => {
  const apply = useDoc((s) => s.apply);
  const selectEffect = useDoc((s) => s.selectEffect);

  const update = (patch: Partial<EffectClip>) =>
    void apply([{ op: "update_effect", effectId: clip.id, patch }]);

  /** 改一个参数：只发这一个键，op 层按 key 合并（不会把别的参数打回默认） */
  const setParam = (key: string, value: number) =>
    update({ params: { ...(clip.params ?? {}), [key]: value } });

  const fpsSafe = fps || 30;
  const startSec = (clip.from / fpsSafe).toFixed(2);
  const durSec = (clip.durationInFrames / fpsSafe).toFixed(2);
  const endSec = ((clip.from + clip.durationInFrames) / fpsSafe).toFixed(2);
  // 循环模式下单次循环的帧数：没写就用该类型的默认时长（与渲染端一致）
  const loopDur = Math.max(4, Math.round(clip.loopDurationInFrames ?? effectDefaults(clip.kind).durationInFrames));
  const colorable = effectColorable(clip.kind);
  /** 没设过颜色时按类型给默认色（暗角是黑，闪类/扫光是白） */
  const color = clip.color ?? effectDefaultColor(clip.kind);
  const params = effectParamsOf(clip.kind);
  const isCustom = clip.kind === "custom";
  const customKeys = [...(clip.custom?.keys ?? [])].sort((a, b) => a.p - b.p);

  /** 换类型：名字跟着换（除非用户改过名，那种情况 ops 层会保留） */
  const setKind = (kind: EffectType) => {
    if (kind === clip.kind) return;
    update({ kind, name: effectLabel(kind) });
  };

  const seekTo = (frame: number) => {
    playerRef?.current?.seekTo(Math.max(0, Math.round(frame)));
  };

  return (
    <aside className="panel right">
      <div className="panel-head">
        <span>特效</span>
        <span className="tag" title={effectSummaryText(clip)}>
          {effectLabel(clip.kind)}
        </span>
        <button
          className="ghost fx-close"
          title="回到场景属性"
          onClick={() => selectEffect(null)}
        >
          ×
        </button>
      </div>

      <div className="panel-scroll">
        <div className="field">
          <label>名称</label>
          <input
            value={clip.name ?? effectLabel(clip.kind)}
            onChange={(e) => {
              const name = e.target.value;
              if (name === (clip.name ?? "")) return;
              update({ name });
            }}
          />
        </div>

        <div className="field">
          <label>
            类型
            <span className="unit">
              {isCustom ? "由 agent 用关键帧生成" : "换类型会保留强度/时间，参数按新类型重算"}
            </span>
          </label>
          <div className="fx-types">
            {EFFECT_CREATABLE.map((o) => (
              <button
                key={o.key}
                className={`fx-type ${o.key === clip.kind ? "is-on" : ""}`}
                title={`${o.label}：${o.hint}`}
                onClick={() => setKind(o.key)}
              >
                {o.label}
              </button>
            ))}
          </div>
          {isCustom ? (
            <div className="fx-custom-badge">
              自定义特效（{customKeys.length} 个关键帧）· 换回内置类型会丢弃关键帧（可 Ctrl+Z 撤销）
            </div>
          ) : null}
        </div>

        <div className="field">
          <label>
            强度
            <span className="num">{Math.round((clip.intensity ?? 1) * 100)}%</span>
          </label>
          <RangeInput
            value={Math.round((clip.intensity ?? 1) * 100)}
            min={0}
            max={100}
            step={1}
            onChange={(v) => update({ intensity: Math.max(0, Math.min(1, v / 100)) })}
          />
        </div>

        {/* ── 进度曲线：所有类型通用（决定"先猛后缓"还是"慢慢起"） ── */}
        <div className="field">
          <label>
            进度曲线
            <span className="unit">影响整个区间的起落手感</span>
          </label>
          <div className="fx-types">
            {EFFECT_CURVES.map((c) => (
              <button
                key={c}
                className={`fx-type ${(clip.curve ?? "linear") === c ? "is-on" : ""}`}
                title={EFFECT_CURVE_LABEL[c]}
                onClick={() => update({ curve: c })}
              >
                {EFFECT_CURVE_LABEL[c]}
              </button>
            ))}
          </div>
        </div>

        {/* ── 可调参数：按 shared/effects.ts 的声明自动生成，不写死 ── */}
        {params.length ? (
          <div className="fx-params">
            {params.map((d) => {
              const raw = clip.params?.[d.key];
              const value = typeof raw === "number" && Number.isFinite(raw) ? raw : d.def;
              const tuned = Math.abs(value - d.def) > 1e-9;
              return (
                <div className="field" key={d.key}>
                  <label title={d.hint ?? ""}>
                    {d.label}
                    <span className="num">
                      {value.toFixed(d.step < 0.1 ? 2 : d.step < 1 ? 1 : 0)}
                      {d.unit ?? ""}
                      {tuned ? <em className="fx-tuned"> · 已改</em> : null}
                    </span>
                  </label>
                  <RangeInput
                    value={value}
                    min={d.min}
                    max={d.max}
                    step={d.step}
                    onChange={(v) => setParam(d.key, v)}
                  />
                  {tuned ? (
                    <button
                      className="mini fx-reset"
                      title={`恢复默认 ${d.def}${d.unit ?? ""}`}
                      onClick={() => setParam(d.key, d.def)}
                    >
                      恢复默认
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}

        {colorable ? (
          <div className="field">
            <label>颜色</label>
            <div className="fx-colors">
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  className={`fx-swatch ${color.toUpperCase() === c ? "is-on" : ""}`}
                  style={{ background: c }}
                  title={c}
                  onClick={() => update({ color: c })}
                />
              ))}
              <ColorPicker value={color} onChange={(v) => update({ color: v })} />
            </div>
          </div>
        ) : null}

        {/* ── 自定义特效：只读展示关键帧（改由 agent 重新生成 / 换回内置类型） ── */}
        {isCustom ? (
          <div className="field">
            <label>
              关键帧
              <span className="unit">p = 区间内进度 0→1</span>
            </label>
            <div className="fx-keys">
              {customKeys.length ? (
                customKeys.map((k, i) => (
                  <div className="fx-key" key={`${k.p}-${i}`}>
                    <span className="fx-key-p">{k.p.toFixed(2)}</span>
                    <span className="fx-key-body">
                      {keyText(k)}
                      {k.ease && k.ease !== "linear" ? ` · 缓动 ${k.ease}` : ""}
                    </span>
                  </div>
                ))
              ) : (
                <div className="fx-info">没有关键帧，这条特效不会产生任何效果</div>
              )}
            </div>
            {clip.custom?.note ? <div className="fx-info">{clip.custom.note}</div> : null}
          </div>
        ) : null}

        <div className="field">
          <label>
            起点
            <span className="num">{startSec}s</span>
          </label>
          <div className="fx-row">
            <input
              type="number"
              value={clip.from}
              min={0}
              step={1}
              onChange={(e) => {
                const v = Math.round(Number(e.target.value));
                if (Number.isFinite(v) && v >= 0) update({ from: v });
              }}
            />
            <button
              className="mini"
              title="起点对齐到当前播放头"
              onClick={() => {
                const f = Math.round(playerRef?.current?.getCurrentFrame?.() ?? 0);
                update({ from: Math.max(0, f) });
              }}
            >
              对齐播放头
            </button>
          </div>
        </div>

        <div className="field">
          <label>
            时长
            <span className="num">
              {clip.durationInFrames}f · {durSec}s
            </span>
          </label>
          <div className="fx-row">
            <input
              type="number"
              value={clip.durationInFrames}
              min={2}
              step={1}
              onChange={(e) => {
                const v = Math.round(Number(e.target.value));
                if (Number.isFinite(v) && v >= 2) update({ durationInFrames: v });
              }}
            />
            {[0.2, 0.5, 1].map((s) => (
              <button
                key={s}
                className="mini"
                title={`时长设为 ${s} 秒`}
                onClick={() => update({ durationInFrames: Math.max(2, Math.round(s * fpsSafe)) })}
              >
                {s}s
              </button>
            ))}
          </div>
        </div>

        {/* 循环：在时长区间内按「单次循环」反复播放，可设自动停止秒数 */}
        <div className="field">
          <label>
            循环
            <span className="num">{clip.loop ? "开" : "关"}</span>
          </label>
          <div className="fx-row">
            <button className="mini" onClick={() => update({ loop: !clip.loop })}>
              {clip.loop ? "关闭循环" : "开启循环"}
            </button>
            {clip.loop ? (
              <button className="mini" onClick={() => update({ loop: undefined, loopDurationInFrames: undefined, loopStopAfterSeconds: undefined })}>
                清除
              </button>
            ) : null}
          </div>
        </div>

        {clip.loop ? (
          <>
            <div className="field">
              <label>
                单次循环
                <span className="num">
                  {loopDur}f · {(loopDur / fpsSafe).toFixed(2)}s
                </span>
              </label>
              <div className="fx-row">
                <input
                  type="number"
                  value={loopDur}
                  min={4}
                  step={1}
                  onChange={(e) => {
                    const v = Math.round(Number(e.target.value));
                    if (Number.isFinite(v) && v >= 4) update({ loopDurationInFrames: v });
                  }}
                />
                {[0.5, 1, 2].map((s) => (
                  <button
                    key={s}
                    className="mini"
                    title={`单次循环 ${s} 秒`}
                    onClick={() => update({ loopDurationInFrames: Math.max(4, Math.round(s * fpsSafe)) })}
                  >
                    {s}s
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <label>
                循环停止
                <span className="num">{clip.loopStopAfterSeconds ? `${clip.loopStopAfterSeconds}s` : "区间结束"}</span>
              </label>
              <div className="fx-row">
                <input
                  type="number"
                  value={clip.loopStopAfterSeconds ?? ""}
                  placeholder="不限"
                  min={0.1}
                  step={0.5}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    update({ loopStopAfterSeconds: Number.isFinite(v) && v > 0 ? v : undefined });
                  }}
                />
                {[5, 15, 30].map((s) => (
                  <button
                    key={s}
                    className="mini"
                    title={`循环 ${s} 秒后自动停止`}
                    onClick={() => update({ loopStopAfterSeconds: s })}
                  >
                    {s}s
                  </button>
                ))}
              </div>
              <div className="fx-info">到停止点后效果完全退出（不保留残影）；不填就循环到区间结束</div>
            </div>
          </>
        ) : null}

        <div className="fx-info">
          覆盖 {startSec}s → {endSec}s（第 {clip.from} – {clip.from + clip.durationInFrames} 帧）
          {isCustom ? " · 关键帧按进度拉伸，改时长不会变形" : ""}
        </div>

        <div className="fx-row">
          <button className="mini" onClick={() => seekTo(clip.from)} title="跳到特效开始处看效果">
            跳到开始
          </button>
          <button
            className="mini"
            onClick={() => seekTo(clip.from + Math.round(clip.durationInFrames * 0.5))}
            title="跳到特效最强的一帧（峰值位置可调）"
          >
            跳到最中间
          </button>
        </div>

        <div className="field">
          <button
            className="ghost danger fx-delete"
            onClick={() => {
              selectEffect(null);
              void apply([{ op: "remove_effect", effectId: clip.id }]);
            }}
          >
            删除这条特效（可 Ctrl+Z 撤销）
          </button>
        </div>
      </div>
    </aside>
  );
};
