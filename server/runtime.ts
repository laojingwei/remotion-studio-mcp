/**
 * 进程级兜底与优雅退出。
 *
 * 之前 `grep "process.on(" server/*.ts` 是空的。两处后果：
 *
 *  1. Node 20 对**未处理的 Promise rejection 默认直接退出进程**。渲染链本身有
 *     `.catch` 兜底，但 SSE 写、素材探活、图片探测这些旁路没有全局网——一次
 *     未捕获的拒绝就能把整个服务带走，前端表现为"所有请求超时"。
 *  2. Ctrl+C / 关窗口时没有任何收尾：渲染子进程还挂着，任务状态永远停在
 *     `rendering`，下次打开编辑器进度条卡在 37% 不动。
 *
 * 注意这里**不吞错**：一律打完整堆栈到 stderr，只是不让进程死掉。
 * `uncaughtException` 之后进程状态可能已经不可信，所以只记录、继续服务，
 * 并提示用户"建议重启"——比静默退出对本地工具更友好。
 */

const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);

export type RuntimeHooks = {
  /** 退出前要做的收尾（关服务、取消渲染、flush 日志） */
  onShutdown: (reason: string) => void | Promise<void>;
};

let shuttingDown = false;

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function installRuntimeGuards(hooks: RuntimeHooks): void {
  const log = (kind: string, err: unknown) => {
    const detail = err instanceof Error ? `${err.stack ?? err.message}` : String(err);
    console.error(`\n[${ts()}] [${kind}] 未捕获异常（服务继续运行）：\n${detail}\n`);
  };

  process.on("unhandledRejection", (reason) => {
    log("unhandledRejection", reason);
  });

  process.on("uncaughtException", (err) => {
    log("uncaughtException", err);
    console.error("  提示：进程状态可能已不可信，若后续行为异常请重启服务（npm start）。\n");
  });

  const shutdown = (reason: string, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n  ▸ 正在退出（${reason}），先收尾…`);
    // 给收尾最多 3 秒，避免关渲染时卡住 Ctrl+C
    const done = () => process.exit(code);
    const timer = setTimeout(() => {
      console.warn("  ▸ 收尾超时，强制退出");
      done();
    }, 3000);
    timer.unref();
    Promise.resolve()
      .then(() => hooks.onShutdown(reason))
      .catch((err) => console.error("[shutdown] 收尾失败：", err))
      .finally(() => {
        clearTimeout(timer);
        done();
      });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // Windows 关窗口 / 任务管理器结束任务
  process.on("SIGHUP", () => shutdown("SIGHUP"));
}
