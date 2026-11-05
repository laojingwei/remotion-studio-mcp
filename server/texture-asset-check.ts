import fs from "node:fs";
import path from "node:path";
import type { Op } from "../shared/ops";
import { PUBLIC_DIR } from "./store";

/**
 * scene3d 贴图素材的服务端校验（A 路线）。
 *
 * 分层：`dslIssues()`（shared，无 fs）管 src 的**形态**（/assets/、https、data）和
 * 多面体禁贴；这里管只有文件系统才知道的事——**存在性、扩展名、体积、像素尺寸**。
 * 挂在 `Project.apply` 入口，MCP（add_scene / update_scene / 批量 op）和 Web 编辑器
 * 两条写路径都会经过，一处挡住所有来源。
 *
 * 为什么要在写库时报：three 加载不到贴图只会在渲染时静默回退成纯色/黑块，
 * agent 看不到渲染结果，等于没有任何提示。
 *
 * 像素尺寸用**手写头部探针**而不是引 image-size 之类的新依赖——bloom 那次已经验证过
 * "three 自带能力不加依赖"的路线，这里同理；探针解析失败就跳过尺寸检查（体积上限仍生效），
 * 不能因为一个看不懂的头字节把合法素材挡在门外。
 */

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_EDGE = 2048;
const EXT_OK = new Set([".png", ".jpg", ".jpeg", ".webp"]);

/** 从文件头读像素尺寸；解析不了返回 null（跳过检查，不挡合法素材） */
function probeImageSize(buf: Buffer): { w: number; h: number } | null {
  // PNG：8 字节签名 + 4 字节长度 + "IHDR" + 宽高（大端 uint32）
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // WebP：RIFF....WEBP，按 chunk 分 VP8X / VP8L / VP8 三种
  if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const fourcc = buf.toString("ascii", 12, 16);
    if (fourcc === "VP8X") return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (fourcc === "VP8 ") return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (fourcc === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
    }
  }
  // JPEG：扫 SOFn 段，宽高在段内固定偏移
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { w: buf.readUInt16BE(off + 7), h: buf.readUInt16BE(off + 5) };
      }
      off += 2 + buf.readUInt16BE(off + 2);
    }
  }
  return null;
}

/**
 * 深走 ops，收集所有 scene3d 材质贴图引用并校验本地文件。
 * 不按 op 类型分派——add_scene 的 props、update_scene 的 patch、批量 op 的嵌套
 * 结构各不相同，而「map.src 指向本地 assets」这个形状是唯一的。
 */
export function assertTextureAssets(ops: Op[]): void {
  const visit = (v: unknown) => {
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const map = obj["map"];
      if (map && typeof map === "object" && !Array.isArray(map)) {
        const m = map as Record<string, unknown>;
        const src = m["src"];
        if (typeof src === "string" && src.startsWith("/assets/")) {
          if (src.includes("{frame}")) {
            // 序列帧模式：校验首帧那个具体文件（后面的帧大概率同目录同规律）
            const digits = Number(m["frameDigits"] ?? 4);
            const seqFrom = Number(m["seqFrom"] ?? 1);
            checkLocalAsset(src.replace(/\{frame\}/g, String(seqFrom).padStart(Math.max(1, digits), "0")));
          } else {
            checkLocalAsset(src);
          }
        }
      }
      Object.values(obj).forEach(visit);
    }
  };
  ops.forEach(visit);
}

function checkLocalAsset(src: string): void {
  const rel = src.replace(/^\/+/, "");
  const ext = path.extname(rel).toLowerCase();
  if (!EXT_OK.has(ext)) {
    throw new Error(
      `贴图 ${src} 的格式不支持（只收 png / jpg / jpeg / webp）。` +
        `其它格式先用工具转成 PNG 再 upload_asset`,
    );
  }
  const full = path.join(PUBLIC_DIR, rel);
  if (!fs.existsSync(full)) {
    throw new Error(
      `贴图 ${src} 不存在。先 upload_asset 上传（回执里的 /assets/... 地址就是 src），` +
        `或用 list_project_assets / list_assets 查已有素材`,
    );
  }
  const st = fs.statSync(full);
  if (st.size > MAX_BYTES) {
    throw new Error(
      `贴图 ${src} 有 ${(st.size / 1024 / 1024).toFixed(1)}MB，超过 5MB 上限——` +
        `先压缩再上传（jpg 质量 80 通常能从十几 MB 压到 1MB 以内，画面看不出差别）`,
    );
  }
  const dim = probeImageSize(fs.readFileSync(full));
  if (dim && Math.max(dim.w, dim.h) > MAX_EDGE) {
    throw new Error(
      `贴图 ${src} 是 ${dim.w}×${dim.h}，单边超过 2048px——3D 贴图用不到这么大，` +
        `先缩到 2048 以内再上传（这也是渲染器（SwiftShader）吃得动的量级）`,
    );
  }
}
