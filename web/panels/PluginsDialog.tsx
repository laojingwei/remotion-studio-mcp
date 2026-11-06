import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  cancelPluginJob,
  detectPluginSource,
  fetchPluginJob,
  fetchPluginJobs,
  fetchPlugins,
  fetchPluginSettings,
  installPlugin,
  removeOrphanDir,
  removePlugin,
  repairPlugin,
  savePluginRegistry,
  togglePlugin,
  type OrphanDir,
  type PluginItem,
  type PluginJob,
  type PluginRegistryPreset,
  type PluginSourceInfo,
} from "../apiClient";
import { useDoc } from "../store";
import { askConfirm } from "../ui";

/**
 * 插件面板：装、卸、停用、重建，一个地方全办。
 *
 * 设计前提是「用户不关心 npm install / npm run build」：输入一个 git 地址或包名，
 * 点一下，剩下的（下载 → 装依赖 → 执行构建 → 校验宿主能不能识别）全自动。
 * 所以界面主体是**过程**而不是表单——步骤条 + 实时日志，出问题时能直接看到是哪一步、
 * 哪一条命令失败，而不是一句"安装失败"。
 *
 * 另一个必须显示的是「为什么它没生效」：插件的三种状态（能用 / 未构建 / 清单有错）
 * 在列表里要一眼可辨，否则用户只能靠猜。
 */

const PROVIDE_LABEL: Record<string, string> = {
  skill: "技能",
  style: "风格",
  preset: "预设",
  template: "模板",
  elements: "元素库",
  brief: "问诊",
  scene: "场景组件",
  hooks: "钩子",
  tool: "工具",
  text: "文本处理",
  media: "文件处理",
  "scene3d.sky": "3D 天空",
  "scene3d.preset": "3D 预设",
  "scene3d.look": "3D 观感",
};

const provideText = (p: string[]) => (p.length ? p.map((x) => PROVIDE_LABEL[x] ?? x).join("、") : "无可识别的贡献项");

const STEP_ICON: Record<string, string> = {
  pending: "○",
  running: "◐",
  done: "●",
  skip: "–",
  error: "✕",
};

/**
 * 一行日志该用什么颜色。
 *
 * 关键点：**npm 把所有输出都写 stderr**，包括 `added 362 packages in 28s` 这种成功信息。
 * 按流来染红，用户看到的就是"满屏红色但装成功了"。所以按内容判定：
 * 只有真的像错误的才红，警告黄，其余一律普通色。
 */
const ERROR_RE = /(^|\s)(npm error|npm ERR!|ERR!|error:|Error:|EACCES|ENOENT|ETIMEDOUT|ECONNREFUSED|failed|失败)/;
const WARN_RE = /(npm warn|warning|deprecated|不建议|已弃用)/i;

function lineClass(l: { stream: "out" | "err" | "sys"; text: string }): string {
  if (l.stream === "sys") return "sys";
  if (l.stream === "err") {
    if (ERROR_RE.test(l.text)) return "err";
    if (WARN_RE.test(l.text)) return "warn";
  }
  return "out";
}

const fmtBytes = (n: number): string => {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
};

const statusText = (j: PluginJob): string => {
  if (j.status === "queued") return "排队中";
  if (j.status === "running") {
    const cur = j.steps.find((s) => s.status === "running");
    return cur ? `${cur.label}…` : "进行中…";
  }
  if (j.status === "done") return "装好了";
  if (j.status === "canceled") return "已取消";
  return "失败";
};

export const PluginsDialog: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const notify = useDoc((s) => s.notify);
  const [plugins, setPlugins] = useState<PluginItem[]>([]);
  const [trashDir, setTrashDir] = useState("");
  const [orphans, setOrphans] = useState<OrphanDir[]>([]);
  const [roots, setRoots] = useState<{ dir: string; scope: "project"; exists: boolean }[]>([]);
  const [source, setSource] = useState("");
  const [registry, setRegistry] = useState("");
  const [presets, setPresets] = useState<PluginRegistryPreset[]>([]);
  const [defaultRegistry, setDefaultRegistry] = useState("");
  const [showRegistry, setShowRegistry] = useState(false);
  const [info, setInfo] = useState<PluginSourceInfo | null>(null);
  const [job, setJob] = useState<PluginJob | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  /**
   * 当前展开的是哪个插件的自制界面。
   *
   * 用"只有一个"而不是多开：插件界面里常有密钥输入，同时开好几个既挤又容易填错栏。
   */
  const [uiOf, setUiOf] = useState<string | null>(null);
  const uiFrame = useRef<HTMLIFrameElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const active = !!job && (job.status === "running" || job.status === "queued");

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetchPlugins();
      setPlugins(r.plugins);
      setTrashDir(r.trashDir);
      setOrphans(r.orphans ?? []);
      setRoots(r.roots ?? []);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "读取插件失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setMsg("");
    void load();
    // npm 源：读一次，之后由用户改；默认是服务端给的国内镜像
    void fetchPluginSettings()
      .then((s) => {
        setRegistry((prev) => prev || s.registry);
        setPresets(s.presets ?? []);
        setDefaultRegistry(s.defaultRegistry);
      })
      .catch(() => {
        /* 设置读不到不影响安装（服务端会用默认源） */
      });
    // 面板重新打开时接上正在跑的任务，否则用户会以为安装丢了
    void fetchPluginJobs()
      .then((js) => {
        const live = js.find((j) => j.status === "running" || j.status === "queued");
        if (live) {
          setJob(live);
          return;
        }
        // 没有进行中的任务，就把最近一次结果显示出来——否则一次失败的安装关掉面板就消失了
        const last = js[0];
        if (last && Date.now() - last.startedAt < 60 * 60_000) setJob(last);
      })
      .catch(() => {
        /* 没有任务列表不影响正常使用 */
      });
  }, [open]);

  // 输入即预检：告诉用户"会装成什么、目录占没占"，不用点了才知道
  useEffect(() => {
    if (!open) return;
    const s = source.trim();
    if (!s) {
      setInfo(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      detectPluginSource(s)
        .then((r) => {
          if (alive) setInfo(r);
        })
        .catch(() => {
          if (alive) setInfo(null);
        });
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [source, open]);

  // 任务轮询：只在跑的时候轮，结束就停
  useEffect(() => {
    if (!active || !job) return;
    const id = job.id;
    const timer = setInterval(() => {
      fetchPluginJob(id)
        .then((j) => {
          setJob(j);
          if (j.status === "done" || j.status === "error" || j.status === "canceled") void load();
        })
        .catch(() => {
          /* 单次失败不打断轮询，下一轮再来 */
        });
    }, 700);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, job?.id]);

  // 日志自动跟到底部（用户往上翻的时候不抢）
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [job?.logs.length]);

  const summary = useMemo(() => {
    const on = plugins.filter((p) => p.enabled).length;
    return `${plugins.length} 个${plugins.length ? `（${on} 个启用）` : ""}`;
  }, [plugins]);

  if (!open) return null;

  const doInstall = async () => {
    if (busy || !source.trim()) return;
    setBusy(true);
    setMsg("");
    try {
      const reg = registry.trim();
      // 记住这个源（下次开面板还是它）；存不进去也不拦着这次安装
      if (reg) void savePluginRegistry(reg).catch(() => {});
      const j = await installPlugin({ source: source.trim(), registry: reg || undefined });
      setJob(j);
      setSource("");
      setInfo(null);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "安装失败");
    } finally {
      setBusy(false);
    }
  };

  /** 预检说"不是插件"，用户确认后强行装 */
  const doForceInstall = async (src: string) => {
    if (busy) return;
    setBusy(true);
    setMsg("");
    try {
      setJob(await installPlugin({ source: src, registry: registry.trim() || undefined, force: true }));
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "安装失败");
    } finally {
      setBusy(false);
    }
  };

  const doRepair = async (p: PluginItem) => {
    if (busy) return;
    setBusy(true);
    setMsg("");
    try {
      setJob(await repairPlugin(p.id));
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "重建失败");
    } finally {
      setBusy(false);
    }
  };

  const doToggle = async (p: PluginItem) => {
    try {
      const en = await togglePlugin(p.id, !p.enabled);
      setPlugins((list) => list.map((x) => (x.id === p.id ? { ...x, enabled: en } : x)));
      notify(en ? `已启用 ${p.name}` : `已停用 ${p.name}`);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "切换失败");
    }
  };

  const doRemove = (p: PluginItem) => {
    askConfirm({
      title: `卸载「${p.name}」？`,
      message: `插件会从 plugins/ 移走，立刻失效。文件不会删除，而是挪到回收目录，需要时可以捡回来。`,
      confirmLabel: "卸载",
      onConfirm: () => {
        void (async () => {
          try {
            const r = await removePlugin(p.id);
            notify(`已卸载 ${p.name}`);
            setMsg(`已移到：${r.trash}`);
            await load();
          } catch (err) {
            setMsg(err instanceof Error ? err.message : "卸载失败");
          }
        })();
      },
    });
  };

  const doRemoveOrphan = (o: OrphanDir) => {
    askConfirm({
      title: `删除「${o.name}」？`,
      message: `${o.reason}\n它会从 plugins/ 挪到回收目录（不真删，能捡回来）。`,
      confirmLabel: "删除",
      onConfirm: () => {
        void (async () => {
          try {
            const r = await removeOrphanDir(o.dir);
            notify(`已删除 ${o.name}`);
            setMsg(`已移到：${r.trash}`);
            await load();
          } catch (err) {
            setMsg(err instanceof Error ? err.message : "删除失败");
          }
        })();
      },
    });
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="plg-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="plg-head">
          <span>插件</span>
          <span className="plg-sub">{summary}</span>
          <button className="ghost" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="plg-body">
          <p className="plg-intro">
            粘贴一个 git 地址、npm 包名，或者选一个本地目录——下载、装依赖、执行构建、检查能不能用，都在这里自动完成。
            装好立刻生效，不用重启。
          </p>

          <div className="plg-form">
            <input
              className="plg-input"
              placeholder="https://github.com/用户/仓库　或　@scope/包名　或　D:/我的插件"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void doInstall();
                e.stopPropagation();
              }}
              disabled={busy || active}
            />
            <button className="ghost" onClick={() => void doInstall()} disabled={busy || active || !source.trim()}>
              {busy ? "提交中…" : "安装"}
            </button>
          </div>

          {/*
            装到哪：**只有一个目录**。
            2026-11-06 删掉了「用户目录」那个选项——它装上下载包、装完不生效
            （场景组件要静态打包，家目录不在打包范围里），留着就是一个会选错的入口。
            但路径必须照样显示出来：不然用户永远不知道东西装到哪了、去哪删。
          */}
          <div className="plg-scopes">
            <label className="plg-scope-opt is-on">
              <span className="plg-scope-text">
                <span className="plg-scope-label">
                  装到 plugins/
                  <i>跟着这个仓库走，可提交、团队共享；升级编辑器不会覆盖</i>
                </span>
                <span className="plg-scope-path" title={roots[0]?.dir ?? ""}>
                  {roots[0]?.dir ?? "读取中…"}
                  {roots[0] && !roots[0].exists ? <em>（还不存在，安装时自动创建）</em> : null}
                </span>
              </span>
            </label>
          </div>

          <div className="plg-row plg-registry">
            <label className="plg-label" title="只在安装 npm 包/安装依赖时生效">
              npm 源
            </label>
            <input
              className="plg-input plg-registry-input"
              value={registry}
              list="plg-registry-presets"
              placeholder={defaultRegistry || "https://registry.npmmirror.com"}
              onChange={(e) => setRegistry(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              disabled={active}
            />
            <datalist id="plg-registry-presets">
              {presets.map((p) => (
                <option value={p.url} key={p.id}>
                  {p.label}
                </option>
              ))}
            </datalist>
            {presets.map((p) => (
              <button
                key={p.id}
                className={`ghost plg-mini ${registry === p.url ? "is-on" : ""}`}
                onClick={() => setRegistry(p.url)}
                disabled={active}
                title={p.label}
              >
                {p.id === "npm" ? "官方" : p.id === "npmmirror" ? "国内" : "腾讯"}
              </button>
            ))}
          </div>

          {source.trim() ? (
            <div className="plg-detect">
              {info?.kind ? (
                <>
                  <span className="plg-tag">{info.kind === "git" ? "git 仓库" : info.kind === "npm" ? "npm 包" : "本地目录"}</span>
                  <span className="plg-detect-name">→ {info.name}</span>
                  {info.exists ? <span className="plg-warn">同名目录已存在，先卸载再装</span> : null}
                  <span className="plg-path" title={info.dir}>
                    {info.dir}
                  </span>
                </>
              ) : (
                <span className="plg-warn">{info?.reason ?? "识别中…"}</span>
              )}
            </div>
          ) : null}

          {job ? (
            <div className={`plg-job ${job.status}`}>
              <div className="plg-job-head">
                <b>{job.mode === "repair" ? "重建" : "安装"}：{job.targetName}</b>
                <span className="plg-job-status">{statusText(job)}</span>
                {active ? (
                  <button className="ghost plg-mini" onClick={() => void cancelPluginJob(job.id)}>
                    取消
                  </button>
                ) : (
                  <button className="ghost plg-mini" onClick={() => setJob(null)}>
                    收起
                  </button>
                )}
              </div>

              <div className="plg-steps">
                {job.steps.map((s) => (
                  <span className={`plg-step ${s.status}`} key={s.key} title={s.detail ?? s.label}>
                    <i>{STEP_ICON[s.status]}</i>
                    {s.label}
                  </span>
                ))}
              </div>

              {job.error ? <div className="plg-error">{job.error}</div> : null}
              {job.status === "error" && job.code === "NOT_A_PLUGIN" ? (
                <div className="plg-force">
                  <span>预检只能看声明，看不到代码。作者没写声明的插件会被误判。</span>
                  <button className="ghost plg-mini" onClick={() => void doForceInstall(job.source)} disabled={busy || active}>
                    仍然安装
                  </button>
                </div>
              ) : null}
              {job.status === "done" && job.dir ? (
                <div className="plg-ok">
                  已装到 {job.dir}
                  {job.steps.find((s) => s.key === "build")?.detail
                    ? ` · ${job.steps.find((s) => s.key === "build")!.detail}`
                    : ""}
                </div>
              ) : null}

              <div className="plg-log" ref={logRef}>
                {job.logs.length ? (
                  job.logs.map((l, i) => (
                    <div className={`plg-log-line ${lineClass(l)}`} key={i}>
                      {l.text}
                    </div>
                  ))
                ) : (
                  <div className="plg-log-line sys">等待输出…</div>
                )}
              </div>
              {job.droppedLogs ? (
                <div className="plg-log-note">只显示最近 {job.logs.length} 行（更早的已折叠）</div>
              ) : null}
            </div>
          ) : null}

          {msg ? <div className="plg-msg">{msg}</div> : null}

          <div className="plg-list">
            {plugins.length === 0 && !loading ? (
              <div className="plg-empty">还没有装插件。上面粘贴一个地址试试，或者把插件文件夹直接放进 plugins/。</div>
            ) : null}
            {plugins.map((p) => {
              const broken = p.needsBuild;
              /*
               * 「声明了钩子，但一个都没注册上」和「生效」在清单层面长得一样，
               * 这是最误导人的一种状态：用户以为它在管画面质量，其实它什么都没做。
               */
              const dormant = p.enabled && p.provides.includes("hooks") && p.hooks.length === 0;
              return (
                <div
                  className={`plg-item ${p.enabled ? "" : "is-off"} ${broken ? "is-broken" : ""} ${dormant ? "is-dormant" : ""}`}
                  key={p.id}
                >
                  <div className="plg-item-main">
                    <div className="plg-item-title">
                      <b>{p.name}</b>
                      <span className="plg-ver">v{p.version}</span>
                      {!p.enabled ? <span className="plg-badge">已停用</span> : null}
                      {broken ? <span className="plg-badge bad">未构建</span> : null}
                      {dormant ? <span className="plg-badge warn">未生效</span> : null}
                      {p.errors.length ? <span className="plg-badge bad">有错误</span> : null}
                    </div>
                    <div className="plg-item-sub">
                      {provideText(p.provides)}
                      {/* 钩子这一项要说实际注册了哪几个，而不是"提供了钩子" */}
                      {p.provides.includes("hooks") ? (
                        <span className="plg-hook-note">
                          {p.hooks.length ? `已注册：${p.hooks.join("、")}` : "没有注册任何钩子"}
                        </span>
                      ) : null}
                    </div>
                    <div className="plg-item-path" title={p.entry.detail}>
                      {p.pathLabel}
                      {p.hasPackage ? ` · ${p.depCount} 个依赖` : " · 无 package.json"}
                      {p.buildScript ? ` · build: ${p.buildScript}` : ""}
                    </div>
                    {broken ? <div className="plg-item-issue">{p.entry.hint ?? p.entry.detail}</div> : null}
                    {dormant ? (
                      <div className="plg-item-issue">
                        {p.templateOnly
                          ? "目录里只有 plugin.ts.example 模板。把文件名里的 .example 去掉（改成 plugin.ts），它才会被加载。"
                          : p.entry.kind === "unbuilt"
                            ? `没有可用的代码入口：${p.entry.detail}`
                            : "入口能加载，但里面没有导出任何钩子（应 export default { \"audit:rules\": fn }）。"}
                      </div>
                    ) : null}
                    {p.errors.map((e, i) => (
                      <div className="plg-item-issue" key={i}>
                        {e}
                      </div>
                    ))}
                    {p.warnings.map((w, i) => (
                      <div className="plg-item-warn" key={i}>
                        {w}
                      </div>
                    ))}
                  </div>
                  <div className="plg-item-actions">
                    {p.hasUi ? (
                      <button
                        className={`ghost plg-mini ${uiOf === p.id ? "is-on" : ""}`}
                        onClick={() => setUiOf(uiOf === p.id ? null : p.id)}
                      >
                        {uiOf === p.id ? "收起界面" : "打开界面"}
                      </button>
                    ) : null}
                    {p.canRepair ? (
                      <button className="ghost plg-mini" onClick={() => void doRepair(p)} disabled={busy || active}>
                        重建
                      </button>
                    ) : null}
                    <button className="ghost plg-mini" onClick={() => void doToggle(p)}>
                      {p.enabled ? "停用" : "启用"}
                    </button>
                    <button className="ghost plg-mini danger" onClick={() => doRemove(p)} disabled={active}>
                      卸载
                    </button>
                  </div>
                  {/*
                    插件自己的界面：**宿主不解析它的内容**，只把 plugins/<id>/ui/ 当静态目录挂上去。
                    为什么用 iframe 而不是渲染它的 React 组件——见 server/index.ts 里
                    /plugin-ui 路由上那段注释（一句话：编辑器是预构建产物，静态 import 会变成
                    "装完看不到，得先跑 vite build"）。
                  */}
                  {p.hasUi && uiOf === p.id ? (
                    <div className="plg-ui-panel">
                      <div className="plg-ui-bar">
                        <span>
                          以下是插件 <b>{p.name}</b> 自带的界面，内容和能力都由插件提供
                        </span>
                        <button className="ghost plg-mini" onClick={() => setUiOf(null)}>
                          收起
                        </button>
                      </div>
                      <iframe
                        ref={uiFrame}
                        className="plg-ui-frame"
                        title={`${p.name} 界面`}
                        src={`/plugin-ui/${encodeURIComponent(p.id)}/index.html`}
                        /*
                         * allow-same-origin 是必须的：插件页面要 fetch('/api/...') 读写自己的配置。
                         * 不给 allow-top-navigation，防止插件把整个编辑器导航走。
                         */
                        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
                        onLoad={() => {
                          /*
                           * 把宿主的主题变量送进去：插件可以照着用（想要统一观感时），
                           * 也可以完全无视。只发一次，之后由插件自己决定要不要再问。
                           */
                          const cs = getComputedStyle(document.documentElement);
                          const keys = ["--bg", "--panel", "--panel-2", "--line", "--text", "--muted", "--accent", "--danger", "--radius"];
                          const tokens: Record<string, string> = {};
                          for (const k of keys) tokens[k] = cs.getPropertyValue(k).trim();
                          uiFrame.current?.contentWindow?.postMessage(
                            { type: "studio:init", pluginId: p.id, theme: "dark", tokens },
                            "*",
                          );
                        }}
                      />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          {/* 装错了、装坏了的残骸：必须可见可删，否则用户只能去翻文件系统 */}
          {orphans.length ? (
            <div className="plg-orphans">
              <div className="plg-section-title">
                未识别的目录 <span className="plg-count">{orphans.length}</span>
              </div>
              <p className="plg-hint">
                这些目录在 plugins/ 里，但没有任何插件标志——宿主不会加载它们，编辑器里也看不到任何效果。
                多半是装错了包，或者装到一半断了。留着只占磁盘。
              </p>
              {orphans.map((o) => (
                <div className="plg-orphan" key={o.dir}>
                  <div className="plg-orphan-main">
                    <div className="plg-orphan-title">
                      <b>{o.name}</b>
                      <span className="plg-orphan-size" title={o.sizeTruncated ? "文件太多，只统计了一部分；实际更大" : "实际体积"}>
                        {o.sizeTruncated ? "≥ " : ""}
                        {fmtBytes(o.bytes)}
                      </span>
                    </div>
                    <div className="plg-item-path" title={o.dir}>
                      {o.pathLabel}
                    </div>
                    <div className="plg-item-issue">{o.reason}</div>
                  </div>
                  <button className="ghost plg-mini danger" onClick={() => doRemoveOrphan(o)}>
                    删除
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="plg-foot">
          <span>卸载不删文件：{trashDir || "data/.plugin-trash"}</span>
          <span>装完即生效，不需要重启</span>
        </div>
      </div>
    </div>
  );
};
