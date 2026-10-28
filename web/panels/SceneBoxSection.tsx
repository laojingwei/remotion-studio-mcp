import React from "react";
import { sceneSpans, type Scene } from "@shared/schema";
import { describeSceneBox, type SceneBox } from "@shared/sceneBox";
import { useDoc } from "../store";
import { RangeInput } from "../RangeInput";

/**
 * 属性面板里的「画中画」区：这一幕的画面框（位置 / 尺寸 / 圆角 / 不透明度）。
 *
 * 和画布上的拖拽是同一份数据（`scene.box`），只是这里能填精确值。
 * 「设为画中画」会一次做两件事（挪到轨道 1 + 缩成小窗），合成一个 op 批次 = 一步撤销。
 */
/**
 * 画中画的数字框。
 *
 * 不用受控 + onChange 提交：数字框每敲一个字符都会触发一次全量往返，
 * 而且受控会吃掉「1.」这种中间态（Number("1.") === 1，小数点打不进去）。
 * 改成 **失焦 / 回车才提交**，外部值变了用 key 重挂载刷新。
 */
const PipNum: React.FC<{
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  /** 显示用：值 → 输入框里的数字（比如 0.34 → 34） */
  toText?: (v: number) => number;
  /** 输入框数字 → 值 */
  fromText?: (v: number) => number;
  onChange: (v: number) => void;
}> = ({ label, value, min, max, step, suffix, toText, fromText, onChange }) => {
  const shown = toText ? toText(value) : value;
  return (
    <label className="pip-num">
      <span>{label}</span>
      <input
        type="number"
        key={`${label}-${shown}`}
        defaultValue={shown}
        min={min}
        max={max}
        step={step}
        onBlur={(e) => {
          const raw = Number(e.currentTarget.value);
          if (!Number.isFinite(raw)) return;
          // 一路夹到合法区间（划到负值/超过 100 都不该落库）
          const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, raw));
          const next = fromText ? fromText(clamped) : clamped;
          if (Math.abs(next - value) < 1e-6) return;
          onChange(next);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
      {suffix ? <em>{suffix}</em> : null}
    </label>
  );
};

export const SceneBoxSection: React.FC<{ scene: Scene }> = ({ scene }) => {
  const project = useDoc((s) => s.project);
  const apply = useDoc((s) => s.apply);
  const box = scene.box;
  const span = project ? sceneSpans(project.scenes).find((s) => s.id === scene.id) : null;
  const track = span?.track ?? 0;

  const setBox = (patch: Partial<SceneBox>) =>
    void apply([{ op: "set_scene_box", sceneId: scene.id, box: patch }]);

  const makePip = () =>
    void apply([
      {
        op: "move_scene",
        sceneId: scene.id,
        start: span?.start ?? 0,
        track: track > 0 ? track : 1,
      },
      { op: "set_scene_box", sceneId: scene.id, box: { x: 72, y: 26, scale: 0.34, radius: 3 } },
    ]);

  return (
    <>
      <div className="section-title">画中画</div>
      {!box ? (
        <>
          <p className="ff-hint">
            把这一幕缩成小窗，叠在别的画面上。点下面的按钮会同时把它挪到轨道 1，
            之后可以在时间轴上拖它的时间、在画布上拖它的位置。
          </p>
          <button className="ghost" onClick={makePip} style={{ width: "100%" }}>
            设为画中画（右上小窗）
          </button>
        </>
      ) : (
        <>
          <p className="ff-hint">
            {describeSceneBox(box)}（轨 {track}）· 直接拖画布上的小窗标题条移动、拖四角缩放
          </p>
          <div className="field">
            <label>位置</label>
            <div className="pip-row">
              <PipNum
                label="x"
                value={box.x}
                min={0}
                max={100}
                step={1}
                toText={(v) => Math.round(v)}
                onChange={(x) => setBox({ x })}
              />
              <PipNum
                label="y"
                value={box.y}
                min={0}
                max={100}
                step={1}
                toText={(v) => Math.round(v)}
                onChange={(y) => setBox({ y })}
              />
              <button
                className="ghost"
                title="摆到右上角"
                onClick={() => setBox({ x: 72, y: 26 })}
              >
                右上
              </button>
            </div>
          </div>
          <div className="field">
            <label>
              尺寸
              <span className="num">{Math.round(box.scale * 100)}%</span>
            </label>
            <RangeInput
              min={5}
              max={100}
              step={1}
              value={box.scale * 100}
              delay={140}
              onChange={(pct) => setBox({ scale: pct / 100 })}
            />
          </div>
          <div className="field">
            <label>圆角 / 不透明度</label>
            <div className="pip-row">
              <PipNum
                label="圆角"
                value={box.radius ?? 0}
                min={0}
                max={50}
                step={0.5}
                onChange={(radius) => setBox({ radius })}
              />
              <PipNum
                label="透明"
                value={(box.opacity ?? 1) * 100}
                min={0}
                max={100}
                step={5}
                toText={(v) => Math.round(v)}
                fromText={(v) => v / 100}
                onChange={(opacity) => setBox({ opacity })}
              />
            </div>
          </div>
          <div className="field">
            <label className="pip-check">
              <input
                type="checkbox"
                checked={box.shadow !== false}
                onChange={(e) => setBox({ shadow: e.target.checked })}
              />
              投影（把层次分开）
            </label>
          </div>
          <div className="pip-row">
            {track > 0 ? (
              <button
                className="ghost"
                onClick={() =>
                  void apply([
                    { op: "move_scene", sceneId: scene.id, start: span?.start ?? 0, track: 0 },
                  ])
                }
                title="挪回主轨（画面框保留）"
              >
                挪回主轨
              </button>
            ) : null}
            <button
              className="ghost danger"
              onClick={() => void apply([{ op: "set_scene_box", sceneId: scene.id, box: null }])}
            >
              恢复全屏
            </button>
          </div>
        </>
      )}
    </>
  );
};
