import fs from "node:fs";
import path from "node:path";
import type { Op } from "../shared/ops";

/**
 * 大 SVG 的文件引用解引用（`svgSrcFile` → `svg`）。
 *
 * 背景：手绘白板/复杂插画的 SVG 路径动辄 6k–21k 字符，内联进工具调用受 LLM 单轮
 * 输出限制且极易抄错；agent 的 Read 工具对单行 >2000 字符还会截断，想自己读全文
 * 再拼回来根本做不到（2026-11 白板手绘片实跑实锤：agent 拆 1800 字片段拼了四轮）。
 * 给元素写 `svgSrcFile: "D:/…/s1.svg"`，脚本把 SVG 落盘，服务端在这里读文件注入
 * ——大内容走磁盘，不走对话。
 *
 * 挂在 Project.apply 入口、`assertTextureAssets` **之前**：MCP 和 Web 编辑器两条
 * 写路径都经过这一处（见 texture-asset-check.ts 的同款挂点）；先解引用，后面的
 * schema 校验 / 插件钩子 / 落盘看到的都是解析后的最终数据。抛错 = 整批拒绝、
 * 工程未动（与插件否决同语义，status 422）。
 *
 * 安全边界：服务端与 MCP agent 同信任域（agent 本就有整机文件权限），所以不做
 * 目录白名单——挡的是「误指」而不是「越权」：绝对路径、扩展名、体积、内容四道闸。
 * 文件内容会写进工程并被渲染，指南里明说别指向敏感文件。
 */

const MAX_BYTES = 200 * 1024;
const EXT_OK = new Set([".svg", ".txt"]);

/* 用 function 声明：TS 只对函数声明（非 const 箭头）的 never 返回做控制流收窄 */
function reject(msg: string): never {
  throw Object.assign(new Error(msg), { status: 422 });
}

/**
 * 深走 ops，把所有 `svgSrcFile` 解析成 `svg`。返回给回执 summary 的确认行——
 * agent 看得到「注入了哪个文件、多大」，不用再 get_project 反查。
 * 不按 op 类型分派——add_scene 的 props.elements、add_element / add_freeform_element
 * 的 element、update_* 的 patch，形状各不相同，但「对象上有 svgSrcFile」这个形状是唯一的。
 */
export function resolveElementFromFile(ops: Op[]): string[] {
  const notes: string[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const fileRef = obj["svgSrcFile"];
      if (typeof fileRef === "string") {
        if (typeof obj["svg"] === "string" && obj["svg"]) {
          reject(
            "元素同时带了内联 svg 和 svgSrcFile——意图不明（要哪个？），二选一。" +
              "要覆盖旧内容就用 update 工具只传 svgSrcFile，不要把旧的 svg 一起带上",
          );
        }
        const svg = readSvg(fileRef);
        obj["svg"] = svg;
        delete obj["svgSrcFile"];
        notes.push(`已从文件注入 svg：${path.basename(fileRef)}（${svg.length} 字符）`);
      }
      Object.values(obj).forEach(visit);
    }
  };
  ops.forEach(visit);
  return notes;
}

function readSvg(fileRef: string): string {
  if (!path.isAbsolute(fileRef)) {
    reject(
      `svgSrcFile 必须是**绝对路径**，收到「${fileRef}」。` +
        `Windows 下写 D:/… 或 D:\\…——Git Bash 的 /d/… 服务端不认（Python 里同样用 D:/ 写盘）`,
    );
  }
  const ext = path.extname(fileRef).toLowerCase();
  if (!EXT_OK.has(ext)) {
    reject(`svgSrcFile 只收 .svg / .txt，收到「${ext || "(无扩展名)"}」（${fileRef}）`);
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(fileRef);
  } catch {
    reject(`svgSrcFile 指向的文件不存在：${fileRef}。先用脚本把 SVG 写到盘上再引用`);
  }
  if (!st.isFile()) reject(`svgSrcFile 指向的不是文件：${fileRef}`);
  if (st.size > MAX_BYTES) {
    reject(
      `svgSrcFile 有 ${(st.size / 1024).toFixed(0)}KB，超过 200KB 上限——` +
        `降点密度 / 减少路径数量，或拆成多个 svg 元素分摊`,
    );
  }
  const content = fs
    .readFileSync(fileRef, "utf8")
    .replace(/^\s*<\?xml[^>]*\?>\s*/i, "")
    .replace(/^\s*<!DOCTYPE[^>]*>\s*/i, "")
    .trim();
  if (!content.includes("<")) {
    reject(`svgSrcFile 的内容不是 SVG 标记（全文没有 <）：${fileRef}`);
  }
  return content;
}
