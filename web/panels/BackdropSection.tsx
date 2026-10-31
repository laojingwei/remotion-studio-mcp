import React from "react";
import type { Scene } from "@shared/schema";
import { BACKDROP_TYPES, isPeriodicBackdrop } from "@shared/sceneKinds";
import { getMeta } from "@shared/sceneMetas";
import { useDoc } from "../store";
import { RangeInput } from "../RangeInput";

/**
 * 属性面板里的「氛围层」区：给这一幕垫一层动效（光晕/颗粒/漏光/散景/火花/磁带）。
 *
 * 它画在**版式底下**，所以文字不会被压、可读性不变；有氛围层时会自动
 * 让出背景色（否则这一层永远看不见）。
 *
 * 只列 BACKDROP_TYPES：带正文的动效（打字机/数字/渐变字/乱码/荧光/冲击字/擦除/跑马灯）
 * 垫在内容下面会出现两套字，不是氛围是事故。新增纯氛围版式时只需把它登记进那张表，
 * 这里会自动出现，不用改面板。
 *
 * 「出现区间」默认关闭 = 铺满整幕，与这个功能上线前的画面一致；
 * 打开后才写 from / duration / fadeIn / fadeOut。
 */
export const BackdropSection: React.FC<{ scene: Scene }> = ({ scene }) => {
  const apply = useDoc((s) => s.apply);
  const fps = useDoc((s) => s.project?.fps ?? 30);
  const bd = scene.backdrop;
  const current = bd?.type ?? "";
  const opacity = bd?.opacity ?? 0.8;
  const place = bd?.place ?? "下";

  const span = scene.durationInFrames;
  const from = Math.min(bd?.from ?? 0, Math.max(0, span - 1));
  const dur = Math.min(bd?.duration ?? span - from, span - from);
  /** 两个都没写 = 交给渲染端自动跟随幕的出入场转场 */
  const autoSoften = bd?.fadeIn === undefined && bd?.fadeOut === undefined;
  const speed = bd?.speed ?? 1;
  const mode = bd?.mode ?? "loop";
  /**
   * 只有"有完整周期"的类型才给「播放次数」。其余（光晕/散景/流体/网格）是永续漂移、
   * 颗粒/磁带是逐帧随机，once 看不出差别 —— 给了选择反而让人以为设置没生效，
   * 所以界面上直接不显示。判定放在 shared/sceneKinds，ops 层用的是同一张表。
   */
  const canOnce = isPeriodicBackdrop(current);
  const smooth = Math.max(bd?.fadeIn ?? 0, bd?.fadeOut ?? 0);
  // 只要有一项偏离默认（幕首起、铺到幕尾），就算"设了区间"
  const partial = from > 0 || dur < span - from;
  /** 幕自己的转场，面板上要显示成「跟随入场 12 帧」而不是一个空数字 */
  const sceneIn =
    scene.transitionIn && scene.transitionIn.type !== "none" ? scene.transitionIn.durationInFrames : 0;
  const sceneOut =
    scene.transitionOut && scene.transitionOut.type !== "none" ? scene.transitionOut.durationInFrames : 0;
  const softenLabel = autoSoften
    ? from === 0 && dur >= span - from
      ? "自动（整幕，无额外柔化）"
      : `自动（入场 ${sceneIn || 8} / 出场 ${sceneOut || 8} 帧）`
    : smooth === 0
      ? "硬切"
      : `${smooth} 帧`;

  const sec = (n: number) => `${(n / Math.max(1, fps)).toFixed(1)}s`;

  /**
   * 统一的写入口：换类型 / 透明度 / 层次 / 区间都走它。
   * 每次都重建整个 backdrop 对象 —— 少带一个字段就会把已设的区间清掉。
   */
  const write = (patch: {
    type?: string;
    opacity?: number;
    place?: "下" | "上" | "顶";
    from?: number;
    duration?: number;
    /** "auto" = 不写 fadeIn/fadeOut，让渲染端跟随幕的出入场；数字 = 两端都写这个帧数 */
    soften?: "auto" | number;
    speed?: number;
    mode?: "loop" | "once";
  }) =>
    void apply([
      {
        op: "set_scene_backdrop",
        sceneId: scene.id,
        backdrop: {
          type: patch.type ?? current,
          ...(bd?.props ? { props: bd.props } : {}),
          opacity: patch.opacity ?? opacity,
          place: patch.place ?? place,
          ...(bd?.z === undefined ? {} : { z: bd.z }),
          from: patch.from ?? from,
          // duration 等于剩余长度时省略（= 到幕尾），避免把幕长写死进数据
          ...(() => {
            const d = patch.duration ?? dur;
            return d >= span - (patch.from ?? from) ? {} : { duration: d };
          })(),
          /*
           * 柔化：不带这个字段 = 从数据里删掉 → 渲染端自动跟随幕的出入场。
           * 想保留用户已手调的值，就在没写 soften 时原样带回。
           */
          speed: patch.speed ?? speed,
          mode: patch.mode ?? mode,
          ...(patch.soften === "auto"
            ? {}
            : patch.soften !== undefined
              ? { fadeIn: patch.soften, fadeOut: patch.soften }
              : bd?.fadeIn === undefined
                ? {}
                : { fadeIn: bd.fadeIn, ...(bd.fadeOut === undefined ? {} : { fadeOut: bd.fadeOut }) }),
        },
      },
    ]);

  const pick = (type: string) => {
    if (!type) {
      void apply([{ op: "set_scene_backdrop", sceneId: scene.id, backdrop: null }]);
      return;
    }
    write({ type });
  };

  /** 关掉区间：回到铺满整幕（柔化跟着回到"自动"，整幕时自动值就是 0，与旧工程一致） */
  const clearRange = () => write({ from: 0, duration: span, soften: "auto" });

  return (
    <>
      <div className="section-title">氛围层</div>
      <div className="field">
        <label>
          垫在内容下面
          {current ? <span className="num">{getMeta(current)?.name ?? current}</span> : null}
        </label>
        <select value={current} onChange={(e) => pick(e.target.value)}>
          <option value="">（无）</option>
          {BACKDROP_TYPES.map((t) => (
            <option key={t} value={t}>
              {getMeta(t)?.name ?? t}
            </option>
          ))}
        </select>
      </div>
      {current ? (
        <>
          <div className="field">
            <label>
              层次
              <span className="num">{place === "下" ? "在内容下" : place === "上" ? "在内容上" : "盖在最上"}</span>
            </label>
            <select value={place} onChange={(e) => write({ place: e.target.value as "下" | "上" | "顶" })}>
              <option value="下">下 — 垫在版式下（字不受影响）</option>
              <option value="上">上 — 浮在画面上，贴纸还在最前</option>
              <option value="顶">顶 — 盖住所有内容（字幕除外）</option>
            </select>
          </div>
          <div className="field">
            <label>
              不透明度
              <span className="num">{Math.round(opacity * 100)}%</span>
            </label>
            <RangeInput
              min={20}
              max={100}
              step={5}
              value={opacity * 100}
              delay={160}
              onChange={(pct) => write({ opacity: pct / 100 })}
            />
          </div>

          <div className="field">
            <label>
              快慢
              <span className="num">{speed.toFixed(1)}×</span>
            </label>
            <RangeInput
              min={30}
              max={200}
              step={10}
              value={Math.round(speed * 100)}
              delay={160}
              onChange={(v) => write({ speed: v / 100 })}
            />
          </div>
          {canOnce ? (
            <div className="field">
              <label>
                播放次数
                <span className="num">{mode === "once" ? "只扫一次" : "循环"}</span>
              </label>
              <select value={mode} onChange={(e) => write({ mode: e.target.value as "loop" | "once" })}>
                <option value="loop">循环 — 每隔一个周期扫一次（默认）</option>
                <option value="once">只扫一次 — 扫完就停住，不再出现</option>
              </select>
            </div>
          ) : null}

          <div className="field">
            <label>
              出现区间
              <span className="num">{partial ? `${sec(from)} 起 ${sec(dur)}` : "整幕"}</span>
            </label>
            <select
              value={partial ? "部分" : "整幕"}
              onChange={(e) =>
                e.target.value === "整幕"
                  ? clearRange()
                  : write({ from: 0, duration: Math.max(1, Math.round(span * 0.6)), soften: "auto" })
              }
            >
              <option value="整幕">整幕 — 从头铺到尾（默认）</option>
              <option value="部分">只在幕内一段出现</option>
            </select>
          </div>
          {partial ? (
            <>
              <div className="field">
                <label>
                  开始
                  <span className="num">{sec(from)}</span>
                </label>
                <RangeInput
                  min={0}
                  max={Math.max(1, span - 1)}
                  step={1}
                  value={from}
                  delay={140}
                  onChange={(v) => write({ from: v, duration: Math.min(dur, span - v) })}
                />
              </div>
              <div className="field">
                <label>
                  持续
                  <span className="num">
                    {sec(dur)}（{dur} 帧）
                  </span>
                </label>
                <RangeInput
                  min={1}
                  max={Math.max(1, span - from)}
                  step={1}
                  value={dur}
                  delay={140}
                  onChange={(v) => write({ duration: v })}
                />
              </div>
              <div className="field">
                <label>
                  两端柔化
                  <span className="num">{softenLabel}</span>
                </label>
                <select
                  value={autoSoften ? "auto" : smooth === 0 ? "hard" : "custom"}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "auto") write({ soften: "auto" });
                    else if (v === "hard") write({ soften: 0 });
                    else write({ soften: Math.max(4, Math.floor(dur / 4)) });
                  }}
                >
                  <option value="auto">自动 — 跟随这一幕的出入场转场</option>
                  <option value="hard">硬切 — 一帧进出（快节奏/故障感用）</option>
                  <option value="custom">自定义帧数</option>
                </select>
                {!autoSoften && smooth > 0 ? (
                  <RangeInput
                    min={1}
                    max={Math.max(2, Math.floor(dur / 2))}
                    step={1}
                    value={smooth}
                    delay={140}
                    onChange={(v) => write({ soften: v })}
                  />
                ) : null}
              </div>
            </>
          ) : null}

          <p className="ff-hint">
            {getMeta(current)?.summary ?? ""}
            {partial ? (
              <>
                <br />
                区间内的动画**从出现那一刻重新算起**，不会从半截开始。
              </>
            ) : null}
            <br />
            想调它的细节参数（数量、亮度、冷暖）告诉我，或在左侧对话里说「这幕的氛围层再淡一点」。
          </p>
        </>
      ) : (
        <p className="ff-hint">
          光晕 / 颗粒 / 漏光 / 散景 / 火花 / 磁带 / 聚光 / 网格 / 雨幕 / 流体。
          画在文字**后面**，不会压字；
          和「插一幕氛围版式」不同，它不占时长，这一幕的文字照样在。
        </p>
      )}
    </>
  );
};
