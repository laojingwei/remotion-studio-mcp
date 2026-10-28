import React, { useEffect, useState } from "react";
import { colorAlpha, toHex, toHex8, withColorAlpha } from "@shared/color";

/** 浏览器原生色盘是否支持 alpha（Chrome 的 alpha 属性）：写 8 位 hex 再读回来判断 */
function supportsNativeAlpha(): boolean {
  try {
    const input = document.createElement("input");
    input.type = "color";
    input.setAttribute("alpha", "");
    input.value = "#11223344";
    return input.value.length === 9;
  } catch {
    return false;
  }
}

/**
 * 颜色选择：点色块直接弹系统色盘（支持 alpha 的浏览器里连带透明度一起调）。
 * 不支持 alpha 的浏览器兜底显示一条透明度滑杆，保证功能不丢。
 */
export const ColorPicker: React.FC<{
  value: string;
  onChange: (value: string) => void;
  /** 没有颜色时的默认值（新建元素/底色） */
  fallback?: string;
}> = ({ value, onChange, fallback = "#ffffff" }) => {
  const effective = value || fallback;
  const [nativeAlpha] = useState(supportsNativeAlpha);
  const [alpha, setAlpha] = useState(colorAlpha(effective));
  const [hex, setHex] = useState(toHex(effective));

  useEffect(() => {
    setAlpha(colorAlpha(effective));
    setHex(toHex(effective));
  }, [effective]);

  return (
    <div className="color-inline">
      <label className="color-inline-swatch" title="点击选择颜色和透明度">
        <span style={{ background: effective }} />
        <input
          type="color"
          value={nativeAlpha ? toHex8(effective) : hex}
          onChange={(e) => {
            const v = e.target.value;
            if (nativeAlpha) {
              onChange(v);
            } else {
              // toHex 兜底：万一上游给了 8 位/其它格式，state 里只存 6 位，
              // 否则受控 input.value 会带脏值，后续 alpha 滑杆合成出错误颜色
              setHex(toHex(v));
              onChange(withColorAlpha(v, alpha));
            }
          }}
          aria-label="选择颜色和透明度"
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          {...({ alpha: "" } as any)}
        />
      </label>

      {nativeAlpha ? null : (
        <div className="color-inline-controls">
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={alpha}
            onChange={(e) => {
              const a = Number(e.target.value);
              setAlpha(a);
              onChange(withColorAlpha(hex, a));
            }}
            title="透明度"
          />
          <span className="color-inline-val">{Math.round(alpha * 100)}%</span>
        </div>
      )}
    </div>
  );
};
