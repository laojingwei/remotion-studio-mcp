/**
 * 上传素材时的本机路径解析：**把裸 ENOENT 变成能照着改的报错**。
 *
 * 起因：`upload_asset({path:"D:/tmp/图 1.png"})` 以前直接 `fs.readFile`，
 * 文件不存在时抛的是 `ENOENT: no such file or directory, open 'D:\tmp\图 1.png'`。
 * 那句话对 agent 几乎没有信息量：不知道路径是相对谁解析的、不知道是不是被当成目录了、
 * 更不知道"是不是名字差了一个字"。于是它会反复换写法重试（或者干脆放弃说"上传失败"）。
 *
 * 这里做三件事，都在**读文件之前**完成：
 *  1. 归一输入：去引号（Windows「复制为路径」会带引号）、展开 ~、相对路径按 cwd 解析
 *  2. 判定"为什么打不开"：不存在 / 是目录 / 空文件 / 超大 / 没权限，各给不同的下一步
 *  3. 找不到时给**候选**：同目录里名字最接近的文件（编辑距离），"图 1.png" → "图1.png"
 *
 * 单独成文件是为了能单测：这类报错的失败方式都是"文案不对导致 agent 走错路"，
 * 不测就只能等线上踩。
 */
import fs from "node:fs";
import path from "node:path";

/** 服务端 /api/library 与 /assets 的体积上限（40MB），本地先挡，别先读进内存再被拒 */
export const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;

export type UploadFile = { abs: string; name: string; bytes: number; buf: Buffer };

/** 把用户/agent 给的路径归一成绝对路径 */
export function normalizeUploadPath(input: string, cwd = process.cwd()): string {
  let p = String(input ?? "").trim();
  // 「复制为路径」在 Windows 上会给 "D:\a\b.png"（带双引号），直接 open 必然失败
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1).trim();
  }
  if (!p) return "";
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    p = path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", p.slice(1));
  }
  return path.resolve(cwd, p);
}

/** 编辑距离：只为「名字差一两个字符」这种最常见的失误服务，不必更聪明 */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

/** 同目录里名字最接近的几个文件（用于"你是不是想传这个？"） */
export function suggestFiles(target: string, limit = 3): string[] {
  const dir = path.dirname(target);
  const base = path.basename(target).toLowerCase();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const ext = path.extname(base);
  const scored = names
    .filter((n) => {
      try {
        return fs.statSync(path.join(dir, n)).isFile();
      } catch {
        return false;
      }
    })
    .map((n) => {
      const low = n.toLowerCase();
      // 同扩展名更可能是"就这一个"，但名字像才是关键
      const bonus = ext && path.extname(low) === ext ? -1 : 0;
      return { n, d: distance(base, low) + bonus };
    })
    // 距离超过名字长度三分之一就没意义了（"a.png" 跟什么都像）
    .filter((x) => x.d <= Math.max(2, Math.floor(base.length / 3)))
    .sort((x, y) => x.d - y.d)
    .slice(0, limit);
  return scored.map((x) => path.join(dir, x.n));
}

/**
 * 读一个待上传的文件。失败时抛出的错误里带「原因 + 解析后的绝对路径 + 下一步」，
 * 让 agent 一次就能改对，而不是在几种路径写法之间反复试。
 */
export function loadUploadFile(input: string, cwd = process.cwd()): UploadFile {
  const raw = String(input ?? "").trim();
  if (!raw) {
    throw new Error(
      "path 是空的。要给**本机文件的绝对路径**，例如 D:/tmp/icon.png（正斜杠反斜杠都行）。",
    );
  }
  const abs = normalizeUploadPath(raw, cwd);
  const hints = [
    `当前工作目录（相对路径按它解析）：${cwd}`,
    "反斜杠在 JSON 里要写成双份：\"D:\\\\tmp\\\\a.png\"，或者直接用正斜杠 D:/tmp/a.png",
    "路径带空格不用加引号（加了也会被去掉），但别把整段路径写错一个字符",
  ];

  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(`没有权限读这个文件：${abs}\n换个位置（如 D:/tmp/）再上传，或调整文件权限。`);
    }
    const near = suggestFiles(abs);
    const nearNote = near.length
      ? `\n同目录里有名字接近的文件，是不是其中之一？\n${near.map((f) => `- ${f}`).join("\n")}`
      : "";
    throw new Error(
      `文件不存在：${abs}\n` +
        `你给的是：${raw}\n` +
        `目录 ${path.dirname(abs)} ${fs.existsSync(path.dirname(abs)) ? "存在，但没有这个文件名" : "也不存在"}。` +
        nearNote +
        `\n排查：\n- ${hints.join("\n- ")}`,
    );
  }

  if (st.isDirectory()) {
    let inside: string[] = [];
    try {
      inside = fs
        .readdirSync(abs)
        .filter((n) => {
          try {
            return fs.statSync(path.join(abs, n)).isFile();
          } catch {
            return false;
          }
        })
        .slice(0, 5);
    } catch {
      /* 读不了就只报"这是目录" */
    }
    throw new Error(
      `这是个目录，不是文件：${abs}\n` +
        (inside.length
          ? `里面的文件（挑一个传）：\n${inside.map((n) => `- ${path.join(abs, n)}`).join("\n")}`
          : "把路径指到具体的文件上，例如 " + path.join(abs, "icon.png")),
    );
  }

  if (st.size === 0) {
    throw new Error(
      `文件是 0 字节：${abs}\n` +
        `多半是上游生成失败留下的空文件（截图/导出/下载中断）。重新生成一次，或换一个文件。`,
    );
  }
  if (st.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `文件 ${(st.size / 1024 / 1024).toFixed(1)}MB，超过 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB 上限：${abs}\n` +
        `先压缩/裁剪再传（图片改小尺寸、视频压码率），或者只传真正要用的那一段。`,
    );
  }

  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      `读文件失败（${code ?? "未知"}）：${abs}\n` +
        (code === "EBUSY" ? "文件正被别的程序占用（预览/播放器/同步盘），关掉再试。" : "确认文件还在、且当前用户能读它。"),
    );
  }
  return { abs, name: path.basename(abs), bytes: buf.length, buf };
}
