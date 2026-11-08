/**
 * prompt-motion.com/customize 镜像 → 结构化提示词数据。
 *
 * 用法：`npx tsx scripts/extract-prompt-motion.mts`
 * 产物：`data/prompt-motion/source.json`（`/data` 已 gitignore，随时可重建）
 *
 * 为什么要解析 RSC 载荷而不是页面文本：源站是 Next.js App Router，正文由
 * `self.__next_f.push([1,"..."])` 的序列化流渲染。页面可见文本里没有提示词全文，
 * 用 DOM 解析只会拿到摘要。真正的字段（模板、槽位默认值、作者、原贴）全在这条流里。
 *
 * 三条解析上的硬约定，都是踩过的：
 * 1. **模板要按 id 引用取，不能取"第一个 T 字符串"**。每页都带一个全站通用的
 *    customize 模板（把"改版"这件事本身写成提示词），它往往排在页面前面；按顺序取
 *    会把 207 条全解析成同一段话。正确做法是读 CustomPrompt 的 `{"template":"$<id>"}`
 *    再回查 `<id>:T<hexlen>,<正文>`。
 * 2. **长度前缀是精确的**：`T<hex>,` 后面的十六进制是正文字符数，按它切片不会把后面的
 *    组件树卷进来。仍以 `</start>` 收尾做二次校正，防止非 ASCII 时字节/字符不等。
 * 3. **404 空壳要先剔**：镜像里有一部分页面正文是 "This page doesn't exist"（源站已删条目，
 *    HTTrack 照样存了壳）。它们有标题、有 slug，唯独没有模板——不显式判掉就会悄悄少几十条。
 */
import fs from "node:fs";
import path from "node:path";

const SOURCE_DIR =
  process.env.PM_SOURCE ?? "D:/prompt-motion.com/prompt-motion.com/customize";
const MEDIA_DIR =
  process.env.PM_MEDIA ?? "D:/prompt-motion.com/media.prompt-motion.com";
const OUT_FILE = path.join(process.cwd(), "data", "prompt-motion", "source.json");

/** 模板里的六个块。`inputs`/`gotchas` 不是每条都有，缺就留 undefined */
const SECTIONS = ["direction", "structure", "build", "inputs", "gotchas", "start"] as const;
type SectionName = (typeof SECTIONS)[number];

type Slot = { key: string; label: string; hint: string; default: string };

type Item = {
  slug: string;
  title: string;
  creator: string;
  tweetUrl: string;
  originalPrompt: string;
  template: string;
  sections: Partial<Record<SectionName, string>>;
  slots: Slot[];
  media: { dir: string; video: string | null; preview: string | null; poster: string | null };
  chars: { template: number; direction: number };
};

/** 把 `self.__next_f.push([1,"…"])` 的若干段拼回一条序列化流 */
function payloadOf(html: string): string {
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)<\/script>/g;
  let out = "";
  for (const m of html.matchAll(re)) out += JSON.parse(m[1]) as string;
  return out;
}

/** JSON 字符串字面量（含转义）→ 原文 */
function unquote(s: string): string {
  return JSON.parse(`"${s}"`) as string;
}

/** 从 `"fields":` 之后取一层平衡的 JSON 数组，失败返回 [] */
function fieldsOf(raw: string): Slot[] {
  const at = raw.indexOf('"fields":');
  if (at < 0) return [];
  const start = raw.indexOf("[", at);
  if (start < 0) return [];
  let depth = 0;
  let inStr = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) {
        try {
          const arr = JSON.parse(raw.slice(start, i + 1)) as Slot[];
          return arr.filter((s) => s && typeof s.key === "string");
        } catch {
          return [];
        }
      }
    }
  }
  return [];
}

/** `<direction>…</direction>` 这类块，缺则 undefined */
function sectionOf(template: string, name: SectionName): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(template);
  return m ? m[1].trim() : undefined;
}

/** 媒体目录里的实际文件（镜像只存了 mp4，poster 只有远程地址） */
function mediaOf(dirName: string, poster: string | null) {
  const abs = path.join(MEDIA_DIR, dirName);
  let files: string[] = [];
  try {
    files = fs.readdirSync(abs);
  } catch {
    /* 媒体没抓到就是没有，不阻断抽取 */
  }
  const pick = (prefix: string) => {
    const f = files.find((x) => x.startsWith(prefix) && x.endsWith(".mp4"));
    return f ? path.join(abs, f).replace(/\\/g, "/") : null;
  };
  return { dir: abs.replace(/\\/g, "/"), video: pick("video"), preview: pick("preview"), poster };
}

function parsePage(file: string, html: string): { item?: Item; shell?: boolean; why?: string } {
  const raw = payloadOf(html);
  if (!raw) return { shell: true, why: "无 RSC 载荷" };

  // 判空壳的唯一可靠信号是「有没有模板引用」。**不能**用页面里出现
  // "This page doesn't exist" 来判：每页的 RSC 载荷都内嵌着 HTTPAccessFallbackBoundary
  // 的 notFound 组件树，正常页里也有这句话——按它判会把 233 页全打成空壳。
  const ref = /\{"template":"\$([0-9a-f]+)"/.exec(raw);
  if (!ref)
    return {
      shell: true,
      why: raw.includes("This page doesn\u2019t exist") ? "源站已删条目（404 壳）" : "无模板引用",
    };

  // 同样有两个 h1（notFound 边界 + 真标题），靠 className 里带 text-balance 区分
  const h1 = /\["\$","h1",null,\{"className":"[^"]*text-balance[^"]*","children":"((?:[^"\\]|\\.)*)"\}\]/.exec(
    raw,
  );
  if (!h1) return { why: "找不到正文 h1 标题" };
  const title = unquote(h1[1]).replace(/^Customize:\s*/, "");

  // 模板引用 → 回查 `<id>:T<hex>,`
  const tid = ref[1];
  const head = new RegExp(`\n${tid}:T([0-9a-f]+),`).exec(raw);
  if (!head) return { why: `引用 $${tid} 找不到 T 字符串` };
  const declared = parseInt(head[1], 16);
  let template = raw.slice(head.index + head[0].length, head.index + head[0].length + declared);
  // 非 ASCII 时长度前缀是字节数，按 `</start>` 收口校正
  const tail = template.lastIndexOf("</start>");
  if (tail >= 0) template = template.slice(0, tail + "</start>".length);
  if (!template.startsWith("<")) return { why: "模板切片异常" };

  // 作者与原贴：**分成两条正则**，不合成一条大正则。
  // 合成版要一口气跨越 `"children":["@","x","’s original prompt"]}],"prompt":…`
  // 这段，中间 `]}]` 的括号序极易写错（写成 `]]` 就永远匹配不上，且静默返回空串）。
  // 拆开后每条只依赖最小上下文，个别字段缺失也不会连坐。
  const handleM = /"children":\["@","([^"]+)","\u2019s original prompt"\]/.exec(raw);
  const creator = handleM ? handleM[1] : "";
  const origM = /"prompt":"((?:[^"\\]|\\.)*)","translation"/.exec(raw);
  const originalPrompt = origM ? unquote(origM[1]) : "";

  // 帖子里第一个 x.com 链接是页脚「Curated by」的策展人，要的是带 /status/ 的那条
  const linkM = /"href":"(https:\/\/x\.com\/[^"]*\/status\/[^"]+)"/.exec(raw);
  const tweetUrl = linkM ? linkM[1] : "";

  const srcM = /"src":"(\.\.\/\.\.\/media\.prompt-motion\.com\/([^/"]+)\/[^"]+)"/.exec(raw);
  const posterM = /"poster":"(https:\/\/media\.prompt-motion\.com\/[^"]+)"/.exec(raw);
  const mediaDir = srcM ? srcM[2] : "";
  const media = mediaOf(mediaDir, posterM ? posterM[1] : null);

  const sections: Partial<Record<SectionName, string>> = {};
  for (const s of SECTIONS) {
    const v = sectionOf(template, s);
    if (v) sections[s] = v;
  }

  const slug = path.basename(file, ".html");
  return {
    item: {
      slug,
      title,
      creator,
      tweetUrl,
      originalPrompt,
      template,
      sections,
      slots: fieldsOf(raw),
      media,
      chars: { template: template.length, direction: (sections.direction ?? "").length },
    },
  };
}

function main() {
  if (!fs.existsSync(SOURCE_DIR)) {
    console.error(`源目录不存在：${SOURCE_DIR}`);
    process.exit(1);
  }
  const files = fs.readdirSync(SOURCE_DIR).filter((f) => f.endsWith(".html"));
  const items: Item[] = [];
  const shells: { file: string; why: string }[] = [];
  const failed: { file: string; why: string }[] = [];

  for (const f of files.sort()) {
    const r = parsePage(f, fs.readFileSync(path.join(SOURCE_DIR, f), "utf8"));
    if (r.item) items.push(r.item);
    else if (r.shell) shells.push({ file: f, why: r.why ?? "" });
    else failed.push({ file: f, why: r.why ?? "" });
  }

  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    sourceRoot: SOURCE_DIR,
    stats: {
      pages: files.length,
      entries: items.length,
      shells: shells.length,
      failed: failed.length,
      noInputs: items.filter((i) => !i.sections.inputs).length,
      noGotchas: items.filter((i) => !i.sections.gotchas).length,
      noSlots: items.filter((i) => !i.slots.length).length,
      noPreview: items.filter((i) => !i.media.preview).length,
    },
    shells,
    failed,
    items,
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2), "utf8");

  const s = payload.stats;
  console.log(`页面 ${s.pages} → 条目 ${s.entries}｜404 壳 ${s.shells}｜解析失败 ${s.failed}`);
  console.log(
    `无 <inputs> ${s.noInputs}｜无 <gotchas> ${s.noGotchas}｜无槽位 ${s.noSlots}｜无预览片 ${s.noPreview}`,
  );
  console.log(`写出 ${path.relative(process.cwd(), OUT_FILE)}`);
  if (s.failed) {
    console.log("\n解析失败清单：");
    for (const f of failed) console.log(`  ${f.file} — ${f.why}`);
  }
}

main();
