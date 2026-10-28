/**
 * 命令行出片：node scripts/render.mjs [projectId] [formatKey...]
 * 默认渲染工程的第一个格式；不传 formatKey 就按工程里声明的画幅全出。
 */
const BASE = process.env.SERVER_URL ?? "http://127.0.0.1:4380";

const args = process.argv.slice(2);
const projectId = args[0] ?? "demo";
const formats = args.slice(1);

async function main() {
  const health = await fetch(`${BASE}/api/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`✗ 服务未运行（${BASE}）。先跑 npm start 或双击「启动编辑器.bat」`);
    process.exit(1);
  }

  const res = await fetch(`${BASE}/api/projects/${projectId}/render`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(formats.length ? { formats } : {}),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("✗ 提交失败：", data.error ?? res.status);
    process.exit(1);
  }

  const { id } = data.task;
  console.log(`▸ 已提交 任务 ${id}`);
  let last = "";
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const t = (await (await fetch(`${BASE}/api/tasks/${id}`)).json()).task;
    const line = `${t.status} ${t.progress ?? 0}%`;
    if (line !== last) {
      console.log("  " + line);
      last = line;
    }
    if (t.status === "done") {
      for (const out of t.outputs ?? []) console.log(`✓ ${out.format}  ${out.url}`);
      return;
    }
    if (t.status === "error") {
      console.error("✗ 渲染失败：", t.error);
      process.exit(1);
    }
  }
}

main().catch((e) => {
  console.error("✗", e.message);
  process.exit(1);
});
