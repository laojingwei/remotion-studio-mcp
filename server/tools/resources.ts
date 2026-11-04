import { z } from "zod";
import { api, type ToolDef } from "./_shared";

/**
 * 本地资源库的工具：在用户配置的本地素材文件夹里搜索文件，直接给出**可引用的地址**。
 *
 * 设计要点（为什么没有 import/上传这一步）：文件留在用户自己的目录里，一个字节都不复制。
 * 引用走本机 server 的流出路由（/resources/<类>/<路径>），预览同源可看、渲染按 URL 拉取。
 * 机制与安全边界详见 server/resources.service.ts 顶部。
 */

type SearchRes = {
  root: string;
  total: number;
  truncated: boolean;
  hits: {
    name: string;
    rel: string;
    abs: string;
    size: number;
    mtime: number;
    url: string;
    kind?: "sequence";
    frames?: number;
    firstFrame?: string;
    lastFrame?: string;
  }[];
};

const fmtSize = (n: number) =>
  n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/** 每类的引用去处：回执里直接告诉 agent「拿到 URL 之后写进哪个字段」 */
const USAGE_HINT: Record<string, string> = {
  image: "scene3d 贴图 → material.map:{src:<url>}；全景图 → set_graph_world world:{mode:\"image\", image:<url>}；2D 图片元素可直接用",
  bgm: "add_audio_track（或 set_audio）的 src",
  sfx: "add_audio_track 的 src（音效轨）",
  video: "视频元素的 src",
  fx: "特效元素。lottie json 直接引用；**序列帧文件夹**是一个结果——逐帧 URL = 文件夹 url + / + 帧名（首末帧已给出）， Remotion 里用 for 循环 + staticFile/getStaticFiles 逐帧取",
  other: "仅作登记引用",
};

export const RESOURCE_TOOLS: ToolDef[] = [
  {
    name: "search_local_assets",
    description:
      "在用户配置的**本地素材文件夹**里按文件名搜索，直接返回**可直接引用的地址**（本机 server 的 /resources/ 链接）。\n" +
      "类别（用户在各分类下配置了自己的文件夹）：image 图片 / bgm 配乐 / sfx 音效 / video 视频 / fx 特效（lottie、序列帧）/ other 其它。\n" +
      "**文件不复制、不搬运**：拿到 url 直接写进对应字段（图片 → material.map / world.image；音频 → add_audio_track 的 src），\n" +
      "渲染时由本机 server 按地址流出 —— 所以这些引用只在「server 正在运行的那台机器」上有效。\n" +
      "分类路径是用户在编辑器「资源库」面板里配置的；没配置的类别会报错提示先去配置。\n" +
      "模型（glb 等）暂不支持——scene3d 还没有加载外部模型的节点，搜了也用不上。",
    shape: {
      category: z
        .enum(["image", "bgm", "sfx", "video", "fx", "other"])
        .describe("在哪一类里搜（对应用户配置的那个文件夹）"),
      keyword: z.string().optional().describe("文件名关键词（不区分大小写的包含匹配；不传 = 列出该类下全部文件）"),
      ext: z
        .array(z.string())
        .optional()
        .describe('按扩展名过滤，如 ["png","webp"]（带不带点都行）'),
      limit: z.number().int().optional().describe("最多返回几条（默认 60，上限 300）"),
    },
    run: async (a) => {
      const res = await api<SearchRes>("/api/resources/search", {
        method: "POST",
        body: JSON.stringify({
          category: a.category,
          keyword: a.keyword,
          ext: a.ext,
          limit: a.limit,
        }),
      });
      if (!res.hits.length) {
        return (
          `「${a.category}」里没有匹配「${a.keyword ?? "*"}」的文件（根目录：${res.root}）。\n` +
          "可以：换关键词 / 去掉 keyword 列全部 / 让用户确认文件夹里确实有东西。"
        );
      }
      const lines = res.hits.map((h) => {
        const when = new Date(h.mtime).toISOString().slice(0, 10);
        if (h.kind === "sequence") {
          return (
            `· [序列帧] ${h.name}（${h.frames} 帧：${h.firstFrame} … ${h.lastFrame}，${when}）\n` +
            `  逐帧引用：${h.url}<帧名>，帧名从 ${h.firstFrame} 连续编号到 ${h.lastFrame}\n` +
            `  位置：${h.abs}`
          );
        }
        return `· ${h.name}（${fmtSize(h.size)}，${when}）\n  引用：${h.url}\n  位置：${h.abs}`;
      });
      const head =
        `在「${a.category}」找到 ${res.hits.length} 个${res.truncated ? `（结果截断到 ${res.hits.length} 条，可加 limit 或换更具体的关键词）` : ""}：\n` +
        `根目录：${res.root}\n` +
        `用法：${USAGE_HINT[a.category] ?? "直接引用 url"}\n`;
      const tail =
        "\n注意：url 指向本机 server 的流出接口，**文件不复制**。引用只在 server 正在运行的那台机器上有效；" +
        "源文件被移动或删除后，引用它的镜头会渲染失败。";
      return head + lines.join("\n") + tail;
    },
  },
];
