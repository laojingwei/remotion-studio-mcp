import type { OverlayElement } from "./schema";

/**
 * 「我的素材」——用户上传或 agent 生成后沉淀下来的图片素材。
 *
 * 与内置素材（`elementLibrary.ts`）的区别：
 *  - 内置素材是**代码里写死的矢量**，随工程走，挪机器也在
 *  - 我的素材是**磁盘上的文件 + 一份索引**，可增删，跨场景/跨工程复用
 *
 * 两边用同一套 `libraryId` 空间，靠 `asset:` 前缀区分，
 * 这样素材面板、拖放、`add_element` 都不需要两套代码路径。
 */
export type CustomAsset = {
  id: string;
  name: string;
  /** 站内绝对路径，如 /assets/as1b2c3d.png */
  url: string;
  /** 列表缩略图（上传时浏览器生成的 320px webp 或视频首帧）；没有就用原图/占位 */
  thumbUrl?: string;
  /** 默认按图片处理；视频/音频素材显式标 video / audio */
  kind?: "image" | "video" | "audio";
  /** 原图像素宽高，用来算默认摆放尺寸（也可能缺，agent 上传时就没有） */
  w?: number;
  h?: number;
  /** 音频/视频的真实时长（秒）；图片没有。拖入时间轴时按它算块长，避免"4 秒素材显示 8 秒" */
  duration?: number;
  bytes?: number;
  at?: string;
};

export const ASSET_PREFIX = "asset:";

export const isAssetLibraryId = (id: string) => id.startsWith(ASSET_PREFIX);

export const assetIdOf = (libraryId: string) => libraryId.slice(ASSET_PREFIX.length);

export const assetLibraryId = (assetId: string) => `${ASSET_PREFIX}${assetId}`;

/**
 * 默认摆放宽度（**短边百分比**，和自由元素同一套坐标）。
 *
 * 竖图不能按横图的宽度放：同样 30% 宽，16:9 的图只占半屏高，9:16 的图会顶穿画面。
 * 所以按宽高比收敛 —— 目标是不超过约 50% 短边高。
 */
export function assetElementSize(a: CustomAsset): number {
  if (!a.w || !a.h) return 30;
  const aspect = a.w / a.h;
  const byHeight = 50 * aspect;
  return Math.round(Math.min(32, Math.max(12, byHeight)) * 10) / 10;
}

/** 把「我的素材」变成画布上的元素（图片 / 视频 / 音频，和内置素材产出同一种元素） */
export function assetToElement(
  a: CustomAsset,
  at?: { x: number; y: number },
  fps?: number,
): Partial<OverlayElement> & { kind: "image" | "video" | "audio" } {
  // 有真实时长（音频/视频）就按它给块长，避免默认"到场景结尾"看起来比素材长
  const durationFrames =
    a.duration && fps ? Math.max(1, Math.round(a.duration * fps)) : undefined;
  const base = {
    name: a.name,
    src: a.url,
    size: assetElementSize(a),
    libraryId: assetLibraryId(a.id),
    ...(durationFrames ? { durationInFrames: durationFrames } : {}),
    ...(at ? { x: at.x, y: at.y } : {}),
  };
  if (a.kind === "audio") {
    return {
      ...base,
      kind: "audio",
      audioVolume: 1,
      // 音频不可见，占位尺寸给大一点，方便在画布上点中
      size: 10,
    };
  }
  if (a.kind === "video") {
    return {
      ...base,
      kind: "video",
      // 拖进来的视频默认有声、只播一遍；要不要静音/循环由用户在属性面板决定
      muted: false,
      loop: false,
      startFrom: 0,
      // 有宽高就把比例带上，渲染时高度才对
      ...(a.w && a.h ? { aspect: a.w / a.h } : {}),
    };
  }
  return { ...base, kind: "image" };
}
