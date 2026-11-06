import React, { useEffect, useRef, useState } from "react";
import {
  fetchTtsConfig,
  fetchTtsProviders,
  fetchTtsSpeakers,
  saveTtsConfig,
  ttsSynthesize,
  ttsTest,
  type TtsConfig,
  type TtsProviderInfo,
} from "../apiClient";
import { useDoc } from "../store";
import { escapeTtsText, TTS_ESCAPE_TOOLS } from "@shared/ttsText";
import { PluginUiWindows, usePluginUiWindows } from "./PluginUiWindow";

const BUILTIN_PROVIDER = "openai";

/**
 * 语音（TTS）弹窗：
 *  - 生成：输入文本 → 调本地服务 → 试听 → 加入音效轨 / 设为背景音乐
 *  - 配置：**语音来源**（内置实现 / 插件 provider）+ 内置实现的地址、鉴权、模型、音色等
 *
 * 为什么配置页要有「语音来源」：provider 是宿主的一项单选配置，装了插件不会自动切——
 * 没有这个入口的话，用户装好插件、在插件界面填完密钥，合成却还在走内置，
 * 而且没有任何地方能看出「当前用的是谁」。
 */
export const TtsDialog: React.FC<{ open: boolean; onClose: () => void }> = ({
  open,
  onClose,
}) => {
  const apply = useDoc((s) => s.apply);
  const project = useDoc((s) => s.project);
  const [tab, setTab] = useState<"gen" | "cfg">("gen");
  const [config, setConfig] = useState<TtsConfig | null>(null);
  const [text, setText] = useState("");
  const [originalText, setOriginalText] = useState("");
  const [voice, setVoice] = useState("");
  const [speed, setSpeed] = useState(1);
  const [instruct, setInstruct] = useState("");
  const [targetScene, setTargetScene] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ url: string; bytes: number } | null>(null);
  const [msg, setMsg] = useState("");
  const [speakers, setSpeakers] = useState<Record<string, string> | null>(null);
  /** 插件提供的语音来源（下拉选项）；null = 还没读到 */
  const [providerList, setProviderList] = useState<TtsProviderInfo[] | null>(null);
  /** 插件界面的浮窗：切到某个插件 provider 时，点一下就能去它自己的界面填密钥 */
  const ui = usePluginUiWindows();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewSeq, setPreviewSeq] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [previewing, setPreviewing] = useState(false);
  const previewCache = useRef<Map<string, string>>(new Map());

  // 只在第一次打开时从配置同步默认值；之后关掉再打开保留上次的文本/音频/角色，
  // 否则刚生成的音频一关弹窗就丢了，没法再放进场景。
  const hydrated = useRef(false);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const startedAt = useRef(0);
  useEffect(() => {
    if (!open) return;
    void fetchTtsConfig()
      .then((c) => {
        setConfig(c);
        if (!hydrated.current) {
          hydrated.current = true;
          setVoice(c.voice);
          setSpeed(c.speed);
          setInstruct(c.instruct ?? "");
        }
        const st = useDoc.getState();
        const scenes = st.project?.scenes ?? [];
        const cur = st.selectedId ?? scenes[0]?.id ?? "";
        /**
         * 原来是 `setTargetScene((t) => t || cur)`：只在第一次填值，之后永远沿用。
         * 而这个弹窗关掉只是 `return null`，组件不卸载、state 不丢 —— 于是
         * 「打开过 → 换工程 / 删场景 → 再打开」时会拿着一个已经不存在的 sceneId，
         * 点「加入该场景」就报「找不到场景: scene_xxx」。
         * 现在每次打开都校验一次：不在当前工程里就重置。
         */
        setTargetScene((t) => (scenes.some((s) => s.id === t) ? t : cur));
      })
      .catch((e) => setMsg(e instanceof Error ? e.message : "读取配置失败"));
    void fetchTtsProviders()
      .then((r) => setProviderList(r.providers))
      .catch(() => setProviderList([]));
  }, [open]);

  // 音色表跟随来源：内置 = 本地服务 /speakers；插件 = 插件声明的 voices。切来源自动重取
  useEffect(() => {
    if (!open) return;
    void fetchTtsSpeakers(config?.provider || undefined)
      .then(setSpeakers)
      .catch(() => setSpeakers(null));
  }, [open, config?.provider]);

  // 只有点了「试听」才播放；弹窗重新打开时 previewUrl 没变，不会再自动播
  useEffect(() => {
    if (previewSeq === 0) return;
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = 0;
    void el.play().catch(() => {});
  }, [previewSeq, previewUrl]);

  if (!open) return null;

  /*
   * 当前来源是不是插件 provider。插件是**黑盒**：面板不为它渲染任何内置链路的
   * 字段（服务地址/密钥/模型/音色列表/格式），也不解读它的 configFields——
   * 各家厂商配置和请求都不一样，宿主一解读就变成替厂商发明约定。
   */
  const isPluginSource = !!config?.provider && config.provider !== BUILTIN_PROVIDER;
  /** 当前插件来源的声明信息（formats/voices/instruct 都从这里映射；内置来源为 null） */
  const curPluginProvider = isPluginSource ? (providerList ?? []).find((p) => p.id === config!.provider) ?? null : null;
  /** 风格指令：内置来源一直有；插件来源只在它声明了 instruct 时才显示——没声明就藏，免得填了没效果 */
  const showInstruct = !isPluginSource || !!curPluginProvider?.hasInstruct;

  /** 预听：用固定短句合成所选音色，带会话内缓存 */
  const preview = async (v: string) => {
    if (!v || previewing) return;
    const cached = previewCache.current.get(v);
    if (cached) {
      setPreviewUrl(cached);
      setPreviewSeq((n) => n + 1);
      return;
    }
    setPreviewing(true);
    setMsg("");
    try {
      const r = await ttsSynthesize(`你好，我是${v}，很高兴认识你。`, {
        voice: v,
        instruct: instruct || undefined,
      });
      previewCache.current.set(v, r.url);
      setPreviewUrl(r.url);
      setPreviewSeq((n) => n + 1);
      setMsg(`试听 ${v}（${Math.round(r.bytes / 1024)} KB）`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "试听失败");
    } finally {
      setPreviewing(false);
    }
  };

  const generate = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setMsg("");
    startedAt.current = Date.now();
    setElapsed(0);
    clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setElapsed((Date.now() - startedAt.current) / 1000);
    }, 100);
    try {
      const r = await ttsSynthesize(text, {
        voice: voice || undefined,
        speed,
        instruct: instruct || undefined,
        // 配音只属于当前工程：落到 assets/projects/<工程id>/，删工程连带清
        projectId: project?.id,
      });
      setResult(r);
      setMsg(`生成成功（${Math.round(r.bytes / 1024)} KB）`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "合成失败");
    } finally {
      clearInterval(timerRef.current);
      setElapsed((Date.now() - startedAt.current) / 1000);
      setBusy(false);
    }
  };

  const addAsTrack = () => {
    if (!result || !project) return;
    void apply([
      {
        op: "add_audio_track",
        clip: { src: result.url, name: "TTS 语音", from: 0, volume: 1, fadeIn: 0 },
      },
    ]);
    setMsg("已加入音效轨");
  };

  const addAsMusic = () => {
    if (!result || !project) return;
    void apply([
      {
        op: "set_audio",
        audio: { src: result.url, volume: 1, fadeIn: 0, fadeOut: 0 },
      },
    ]);
    setMsg("已设为背景音乐");
  };

  const addToScene = () => {
    if (!result) return;
    const scenes = project?.scenes ?? [];
    if (scenes.length === 0) {
      setMsg("当前工程还没有场景，先加一个再放语音");
      return;
    }
    // 兜底：面板可能开很久，期间选中场景被删掉 / 换了工程 —— 回退到第一个，
    // 别把 add_element 发给一个不存在的 sceneId
    const sceneId = scenes.some((s) => s.id === targetScene) ? targetScene : scenes[0].id;
    if (sceneId !== targetScene) setTargetScene(sceneId);
    void apply([
      {
        op: "add_element",
        sceneId,
        element: {
          kind: "audio",
          src: result.url,
          name: "语音",
          x: 50,
          y: 50,
          size: 6,
          audioVolume: 1,
          from: 0,
        },
      },
    ]);
    setMsg("已放入该场景（场景内音频，可拖时间轴调整）");
  };

  const persist = async (patch: Partial<TtsConfig>) => {
    try {
      const c = await saveTtsConfig(patch);
      setConfig(c);
      setMsg("已保存");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "保存失败");
    }
  };

  const test = async () => {
    setBusy(true);
    setMsg("正在测试连接…");
    try {
      const r = await ttsTest();
      setResult(r);
      setMsg(`连接成功（${Math.round(r.bytes / 1024)} KB）`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "连接失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
    <div className="modal-mask" onClick={onClose}>
      <div className="outputs-dialog tts-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="outputs-head">
          <span>语音</span>
          <span className="outputs-sub">
            {isPluginSource && curPluginProvider
              ? `来源：${curPluginProvider.label}（可在「配置」里切换）——生成后可直接放进时间轴`
              : "本地 TTS：生成后可直接放进时间轴（可在「配置」里切换厂商）"}
          </span>
          <div className="tts-tabs">
            <button className={`tts-tab ${tab === "gen" ? "is-on" : ""}`} onClick={() => setTab("gen")}>
              生成
            </button>
            <button className={`tts-tab ${tab === "cfg" ? "is-on" : ""}`} onClick={() => setTab("cfg")}>
              配置
            </button>
          </div>
          <button className="ghost" onClick={onClose}>
            关闭
          </button>
        </div>

        {tab === "gen" ? (
          <div className="render-body">
            <div className="render-section">
              <div className="render-label">文本</div>
              <textarea
                className="tts-text"
                rows={4}
                value={text}
                placeholder="输入要合成的文字，例如：欢迎来到今天的分享。"
                onChange={(e) => {
                  setText(e.target.value);
                  setOriginalText("");
                }}
              />
            </div>
            <div className="tts-tools">
              <span className="tts-tools-label">转义</span>
              {TTS_ESCAPE_TOOLS.map((t) => (
                <button
                  key={t.key}
                  className="tts-tool"
                  title={t.hint}
                  onClick={() => {
                    if (!originalText) setOriginalText(text);
                    setText(escapeTtsText(text, t.key));
                  }}
                >
                  {t.label}
                </button>
              ))}
              {originalText ? (
                <button
                  className="tts-tool tts-undo"
                  title="退回到转义前的文本"
                  onClick={() => {
                    setText(originalText);
                    setOriginalText("");
                  }}
                >
                  还原
                </button>
              ) : null}
            </div>
            <div className="render-section">
              <div className="render-label">音色 / 语速</div>
              <div className="row-inline">
                {/*
                  speakers 的来源跟随「语音来源」：内置 = 本地服务的 /speakers；
                  插件来源 = 插件**声明**的 voices（面板只做映射，和 formats 同一原则）。
                  声明了就出下拉；没声明（或读不到）才退回文本输入——留空 = 插件自己的默认音色。
                */}
                {speakers ? (
                  <select
                    className="tts-input"
                    value={voice}
                    onChange={(e) => setVoice(e.target.value)}
                    title={isPluginSource ? "音色（插件声明）" : "角色（音色）"}
                  >
                    {isPluginSource ? <option value="default">默认（插件界面里设置的）</option> : null}
                    {Object.entries(speakers).map(([name, desc]) => (
                      <option key={name} value={name}>
                        {desc ? `${name} · ${desc}` : name}
                      </option>
                    ))}
                    {/* 当前值不在列表里（换了来源后的残留）：兜底显示，别让下拉丢值 */}
                    {voice && voice !== "default" && !Object.keys(speakers).includes(voice) ? (
                      <option value={voice}>{voice}（不在当前来源的列表里）</option>
                    ) : null}
                  </select>
                ) : (
                  <input
                    className="tts-input"
                    value={voice}
                    placeholder={isPluginSource ? "音色（留空 = 插件界面里设的默认）" : "音色（留空用配置里的默认）"}
                    onChange={(e) => setVoice(e.target.value)}
                  />
                )}
                <button
                  className="ghost"
                  onClick={() => void preview(voice)}
                  disabled={previewing || !voice}
                  title="试听这个角色的声音"
                >
                  {previewing ? "试听中…" : "试听"}
                </button>
                <input
                  className="tts-input"
                  type="number"
                  min={0.25}
                  max={4}
                  step={0.05}
                  value={speed}
                  onChange={(e) => setSpeed(Number(e.target.value) || 1)}
                  title="语速"
                  style={{ maxWidth: 90 }}
                />
              </div>
              {previewUrl ? (
                <audio ref={audioRef} className="tts-audio" controls src={previewUrl ?? undefined} />
              ) : null}
            </div>
            {showInstruct ? (
              <div className="render-section">
                <div className="render-label">风格指令（可选）</div>
                <input
                  className="tts-input"
                  value={instruct}
                  placeholder="例如：用特别愤怒的语气说 / 温柔一点，像讲故事"
                  onChange={(e) => setInstruct(e.target.value)}
                />
              </div>
            ) : null}
            <div className="row-inline">
              <button className="primary" onClick={() => void generate()} disabled={busy || !text.trim()}>
                {busy ? (
                  <>
                    <span className="tts-spinner" />
                    生成中
                  </>
                ) : (
                  "生成语音"
                )}
              </button>
              {busy || elapsed > 0 ? (
                <span className="tts-timer" title="本次生成耗时">
                  ⏱ {elapsed.toFixed(1)}s
                </span>
              ) : null}
              {result ? (
                <>
                  <button className="ghost" onClick={addAsTrack}>
                    加入音效轨
                  </button>
                  <button className="ghost" onClick={addAsMusic}>
                    设为背景音乐
                  </button>
                </>
              ) : null}
            </div>
            {result ? (
              <div className="row-inline">
                <select
                  className="tts-input"
                  value={targetScene}
                  onChange={(e) => setTargetScene(e.target.value)}
                  title="把音频放进这个场景"
                >
                  {project?.scenes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <button className="ghost" onClick={addToScene}>
                  放入该场景
                </button>
              </div>
            ) : null}
            {result ? <audio className="tts-audio" controls src={result.url} /> : null}
          </div>
        ) : (
          <div className="render-body">
            {config ? (
              <>
                {(() => {
                  const cur = config.provider || BUILTIN_PROVIDER;
                  const curProvider = (providerList ?? []).find((p) => p.id === cur) ?? null;
                  return (
                    <div className="render-section">
                      <div className="render-label">语音来源</div>
                      <div className="row-inline">
                        <select
                          className="tts-input"
                          value={cur}
                          onChange={(e) => void persist({ provider: e.target.value })}
                          title="合成走哪一家：装了插件不会自动切过来，这里显式选"
                        >
                          <option value={BUILTIN_PROVIDER}>内置（OpenAI 兼容协议）</option>
                          {(providerList ?? []).map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.label}（插件 {p.pluginId}）
                            </option>
                          ))}
                          {/*
                            provider 指着的插件已经停用/卸载时，select 若没有这个 option
                            会显示成第一项（内置），看起来像"切回去了"其实没有——
                            合成仍然会报「没有这个语音 provider」。把它显式摆出来。
                          */}
                          {cur !== BUILTIN_PROVIDER && !(providerList ?? []).some((p) => p.id === cur) ? (
                            <option value={cur}>{cur}（已不可用：插件停用或已卸载）</option>
                          ) : null}
                        </select>
                        {curProvider ? (
                          <button className="ghost" onClick={() => ui.open(curProvider.pluginId, curProvider.label)}>
                            打开它的界面
                          </button>
                        ) : null}
                      </div>
                      {curProvider ? (
                        <div className="tts-source-note">
                          它的配置、音色、输出格式都由它自己的界面管理（点「打开它的界面」）——本面板只把合成请求原样转给它。
                        </div>
                      ) : null}
                      {/*
                        输出格式：**插件声明能出什么，面板就映射出什么选项**——
                        宿主不代转码，选中的值经 format 原样传回插件的 synthesize。
                        只声明一种（如 glm-tts 只有 wav）就禁用展示，让用户知道这不是宿主限的。
                      */}
                      {curProvider && (curProvider.formats?.length ?? 0) > 0 ? (
                        <div className="row-inline">
                          <div className="render-section" style={{ flex: 1 }}>
                            <div className="render-label">输出格式（插件声明）</div>
                            <select
                              className="tts-input"
                              value={
                                curProvider.formats!.includes(config.format) ? config.format : curProvider.formats![0]
                              }
                              disabled={curProvider.formats!.length === 1}
                              title={
                                curProvider.formats!.length === 1
                                  ? "这个插件只声明了这一种输出格式"
                                  : "选中值会原样传给插件，由插件产出对应格式"
                              }
                              onChange={(e) => void persist({ format: e.target.value as TtsConfig["format"] })}
                            >
                              {curProvider.formats!.map((f) => (
                                <option key={f} value={f}>
                                  {f}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })()}
                {/* 内置链路的字段只在内置来源下出现；插件来源下整个区块不渲染（黑盒） */}
                {!isPluginSource ? (
                <div className="tts-builtin">
                <div className="render-section">
                  <div className="render-label">服务地址（完整 URL）</div>
                  <input
                    className="tts-input"
                    value={config.endpoint}
                    onChange={(e) => setConfig({ ...config, endpoint: e.target.value })}
                    placeholder="http://127.0.0.1:8091/v1/audio/speech"
                  />
                </div>
                <div className="row-inline">
                  <div className="render-section" style={{ flex: 1 }}>
                    <div className="render-label">API Key（没有就留空）</div>
                    <input
                      className="tts-input"
                      value={config.apiKey}
                      onChange={(e) => setConfig({ ...config, apiKey: e.target.value })}
                    />
                  </div>
                  <div className="render-section" style={{ flex: 1 }}>
                    <div className="render-label">模型名</div>
                    <input
                      className="tts-input"
                      value={config.model}
                      onChange={(e) => setConfig({ ...config, model: e.target.value })}
                    />
                  </div>
                </div>
                <div className="row-inline">
                  <div className="render-section" style={{ flex: 1 }}>
                    <div className="render-label">语言</div>
                    <select
                      className="tts-input"
                      value={config.language ?? "Chinese"}
                      onChange={(e) => setConfig({ ...config, language: e.target.value })}
                    >
                      <option value="Chinese">中文</option>
                      <option value="English">English</option>
                      <option value="Japanese">日本語</option>
                      <option value="Korean">한국어</option>
                    </select>
                  </div>
                  <div className="render-section" style={{ flex: 1 }}>
                    <div className="render-label">默认音色</div>
                    <div className="row-inline">
                      <input
                        className="tts-input"
                        value={config.voice}
                        onChange={(e) => setConfig({ ...config, voice: e.target.value })}
                      />
                      <button
                        className="ghost"
                        onClick={() => void preview(config.voice)}
                        disabled={previewing || !config.voice}
                      >
                        {previewing ? "试听中…" : "试听"}
                      </button>
                    </div>
                    {speakers ? (
                      <div className="tts-speakers">
                        {Object.entries(speakers).map(([name, desc]) => (
                          <button
                            key={name}
                            className={`tts-speaker ${config.voice === name ? "is-on" : ""}`}
                            title={desc}
                            onClick={() => {
                              setConfig({ ...config, voice: name });
                              setVoice(name);
                            }}
                          >
                            {name}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div className="render-section" style={{ flex: 1 }}>
                    <div className="render-label">格式</div>
                    <select
                      className="tts-input"
                      value={config.format}
                      onChange={(e) =>
                        setConfig({ ...config, format: e.target.value as TtsConfig["format"] })
                      }
                    >
                      <option value="wav">wav</option>
                      <option value="mp3">mp3</option>
                      <option value="ogg">ogg</option>
                    </select>
                  </div>
                </div>
                <div className="render-section">
                  <div className="render-label">默认风格指令（instruct）</div>
                  <input
                    className="tts-input"
                    value={config.instruct}
                    placeholder="例如：用特别愤怒的语气说"
                    onChange={(e) => setConfig({ ...config, instruct: e.target.value })}
                  />
                </div>
                <div className="render-section">
                  <div className="render-label">
                    自定义请求体（可选，非 OpenAI 接口用；支持 {'{{text}}'} {'{{voice}}'} {'{{speed}}'} 占位）
                  </div>
                  <textarea
                    className="tts-text"
                    rows={4}
                    value={config.customBody}
                    onChange={(e) => setConfig({ ...config, customBody: e.target.value })}
                    placeholder='{"text": "{{text}}", "speaker": "{{voice}}"}'
                  />
                </div>
                </div>
                ) : null}
                <div className="row-inline">
                  <button className="primary" onClick={() => void persist(config)}>
                    保存
                  </button>
                  <button className="ghost" onClick={() => void test()} disabled={busy}>
                    测试连接
                  </button>
                </div>
              </>
            ) : (
              <div className="outputs-empty">读取配置中…</div>
            )}
          </div>
        )}

        {msg ? <div className="tts-msg">{msg}</div> : null}
      </div>
    </div>

    {/* 插件界面浮窗（切到插件来源后「打开它的界面」用的就是它），同样要压在遮罩之上 */}
    <PluginUiWindows wins={ui.wins} onPatch={ui.patch} onClose={ui.close} onFocus={ui.focus} />
    </>
  );
};
