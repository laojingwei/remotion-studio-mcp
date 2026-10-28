/**
 * UI 偏好（面板宽度、折叠状态、时间轴高度、选框/安全区开关）的持久化。
 *
 * 问题：这些值原本只存在 localStorage。localStorage 按 origin 隔离，而
 * DSH 每次重启端口会变（56135 → 61124 …），换浏览器或清缓存更是直接清空，
 * 于是「调好的布局」每次都要重调。
 *
 * 做法：把 localStorage 里的 `rms:*` 镜像一份到服务端 `data/ui-prefs.json`。
 *   · 启动时先拉服务端 → 回填 localStorage，组件初始化就能读到正确的值
 *   · 之后任何写入 → 更新内存镜像 + 防抖 PUT
 *
 * 只同步布局/显示类偏好；`rms:clipboard` 是临时内容，不同步。
 */
const PREFIX = "rms:";
const SKIP = new Set(["rms:clipboard"]);

let cache: Record<string, string> = {};
let timer: ReturnType<typeof setTimeout> | null = null;
let saving = false;

function scheduleSave() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void flush();
  }, 400);
}

async function flush() {
  if (saving) return;
  saving = true;
  try {
    await fetch("/api/ui-prefs", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cache),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    /* 服务不可达：保留在内存，下次写入时再试 */
  } finally {
    saving = false;
  }
}

/**
 * 启动时调用一次（必须在 React 渲染之前 await 完成）。
 * 服务端有数据就以服务端为准回填；服务端为空则把本地现状上传作为基线。
 */
export async function loadPrefs(): Promise<void> {
  let server: Record<string, unknown> | null = null;
  try {
    // 有超时兜底：服务端异常时不能让首屏一直白着
    const res = await fetch("/api/ui-prefs", { cache: "no-store", signal: AbortSignal.timeout(2500) });
    if (res.ok) server = (await res.json()) as Record<string, unknown>;
  } catch {
    /* 离线：全用本地 */
  }

  const remote = server && typeof server === "object" ? server : {};
  const keys = Object.keys(remote).filter((k) => k.startsWith(PREFIX) && !SKIP.has(k));

  if (keys.length > 0) {
    for (const key of keys) {
      const value = remote[key];
      if (typeof value !== "string") continue;
      cache[key] = value;
      try {
        localStorage.setItem(key, value);
      } catch {
        /* 隐私模式 */
      }
    }
    return;
  }

  // 服务端还没有：把本地现状全量上传，建立基线
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(PREFIX) || SKIP.has(key)) continue;
      cache[key] = localStorage.getItem(key) ?? "";
    }
  } catch {
    /* ignore */
  }
  scheduleSave();
}

/** 写一个偏好：先落 localStorage（同步、不闪），再镜像到服务端 */
export function setLocalPref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 隐私模式 */
  }
  if (SKIP.has(key)) return;
  cache[key] = value;
  scheduleSave();
}

// 关页面前尽力补一次，避免最后一次拖动/折叠丢在内存里
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    void flush();
  });
}
