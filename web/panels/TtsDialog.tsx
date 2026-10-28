import React, { useEffect, useRef, useState } from "react";
import {
  fetchTtsConfig,
  fetchTtsSpeakers,
  saveTtsConfig,
  ttsSynthesize,
  ttsTest,
  type TtsConfig,
} from "../apiClient";
import { useDoc } from "../store";
import { escapeTtsText, TTS_ESCAPE_TOOLS } from "@shared/ttsText";

/**
 * 语音（TTS）弹窗：
 *  - 生成：输入文本 → 调本地服务 → 试听 → 加入音效轨 / 设为背景音乐
 *  - 配置：服务地址、鉴权、模型、音色、格式、语速、自定义 body 模板
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
        const cur = useDoc.getState().selectedId ?? useDoc.getState().project?.scenes[0]?.id ?? "";
        setTargetScene((t) => t || cur);
      })
      .catch((e) => setMsg(e instanceof Error ? e.message : "读取配置失败"));
    void fetchTtsSpeakers()
      .then(setSpeakers)
      .catch(() => setSpeakers(null));
  }, [open]);

  // 只有点了「试听」才播放；弹窗重新打开时 previewUrl 没变，不会再自动播
  useEffect(() => {
    if (previewSeq === 0) return;
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = 0;
    void el.play().catch(() => {});
  }, [previewSeq, previewUrl]);

  if (!open) return null;

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
    if (!result || !targetScene) return;
    void apply([
      {
        op: "add_element",
        sceneId: targetScene,
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
    <div className="modal-mask" onClick={onClose}>
      <div className="outputs-dialog tts-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="outputs-head">
          <span>语音</span>
          <span className="outputs-sub">本地 TTS：生成后可直接放进时间轴</span>
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
                {speakers ? (
                  <select
                    className="tts-input"
                    value={voice}
                    onChange={(e) => setVoice(e.target.value)}
                    title="角色（音色）"
                  >
                    {Object.entries(speakers).map(([name, desc]) => (
                      <option key={name} value={name}>
                        {desc ? `${name} · ${desc}` : name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="tts-input"
                    value={voice}
                    placeholder="音色（留空用配置里的默认）"
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
            <div className="render-section">
              <div className="render-label">风格指令（可选）</div>
              <input
                className="tts-input"
                value={instruct}
                placeholder="例如：用特别愤怒的语气说 / 温柔一点，像讲故事"
                onChange={(e) => setInstruct(e.target.value)}
              />
            </div>
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
                <div className="render-section">
                  <div className="render-label">服务地址（完整 URL）</div>
                  <input
                    className="tts-input"
                    value={config.endpoint}
                    onChange={(e) => setConfig({ ...config, endpoint: e.target.value })}
                    placeholder="http://127.0.0.1:9880/v1/audio/speech"
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
  );
};
