/**
 * 极小的 markdown 渲染器，只覆盖设计稿用到的那几种语法。
 *
 * 为什么不引第三方库：整个前端只有这一处要渲染 markdown，为它加一个 30KB 依赖
 * 不划算；而设计稿是我们自己生成的固定结构（标题/表格/清单/引用），语法面很窄。
 *
 * 安全前提：**先转义再套标签**。所有文本都过 esc()，标签是我们自己拼的，
 * 所以调用方可以直接 dangerouslySetInnerHTML。
 */

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(s: string): string {
  let t = esc(s);
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  return t;
}

const isTableSep = (s: string): boolean => /^\|[\s:|-]+\|$/.test(s.trim());
const splitRow = (s: string): string[] =>
  s.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((x) => x.trim());

export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;

  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const openList = (kind: "ul" | "ol") => {
    if (list === kind) return;
    closeList();
    out.push(`<${kind}>`);
    list = kind;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();

    // 空行：关掉列表，别的块本来就靠标签闭合，不用管
    if (!line.trim()) {
      closeList();
      continue;
    }

    // 表格：当前行以 | 开头且下一行是分隔行
    if (/^\|/.test(line.trim()) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      closeList();
      const head = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && /^\|/.test(lines[i].trim())) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      i--;
      out.push('<div class="md-table-wrap"><table class="md-table">');
      out.push(
        `<thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead>`,
      );
      out.push(
        `<tbody>${rows
          .map((r) => `<tr>${head.map((_, k) => `<td>${inline(r[k] ?? "")}</td>`).join("")}</tr>`)
          .join("")}</tbody>`,
      );
      out.push("</table></div>");
      continue;
    }

    // 标题
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const lv = h[1].length;
      out.push(`<h${lv} class="md-h${lv}">${inline(h[2])}</h${lv}>`);
      continue;
    }

    // 分隔线
    if (/^---+$/.test(line.trim())) {
      closeList();
      out.push('<hr class="md-hr" />');
      continue;
    }

    // 引用块：连续 > 行合成一块
    if (/^>\s?/.test(line)) {
      closeList();
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      i--;
      const body = buf.filter((x) => x.trim()).map((x) => `<p>${inline(x)}</p>`).join("");
      out.push(`<blockquote class="md-quote">${body || "<p></p>"}</blockquote>`);
      continue;
    }

    // 复选框清单（设计稿「要你拍板的」用这个）
    const check = /^-\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (check) {
      openList("ul");
      const done = check[1].toLowerCase() === "x";
      out.push(
        `<li class="md-check ${done ? "is-done" : ""}"><span class="md-box">${done ? "✓" : ""}</span>` +
          `<span>${inline(check[2])}</span></li>`,
      );
      continue;
    }

    // 有序 / 无序列表
    const ol = /^(\d+)[.)]\s+(.*)$/.exec(line);
    if (ol) {
      openList("ol");
      out.push(`<li value="${ol[1]}">${inline(ol[2])}</li>`);
      continue;
    }
    const ul = /^[-*]\s+(.*)$/.exec(line);
    if (ul) {
      openList("ul");
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }

    // 普通段落
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }

  closeList();
  return out.join("\n");
}
