/**
 * MCP 工具总表（聚合层）。
 *
 * 历史：这个文件曾经是 8900 行（工具定义 + 服务探活 + 参数校验 + 文档生成全在里面），
 * 改任何一个工具都要在近万行里跳转，diff 噪音大、review 难、多人并行必冲突。
 *
 * 现在分三层：
 *   server/tools/_shared.ts   共享底座（api / resolveProject / 校验 / 文档）
 *   server/tools/*.ts         按能力分组的工具定义
 *   本文件                    把分组拼成 TOOLS，并暴露 MCP Server 与门面
 *
 * 顺序有意义：TOOLS 的顺序会体现在 tools/list 与 tool_search 的结果里，
 * 所以分组是按原文件中的位置用 spread 拼回去的，不要随意调整。
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listSkills, readSkill } from "./skills.service";
import { loadUploadFile } from "./upload-path";
import { recallAll, remember, type MemoryKind } from "./memory.service";
import { ROOT as PROJECT_ROOT } from "./root";
import { BACKDROP_TYPES } from "../shared/sceneKinds";
import { BRIEF_STEPS, CONFIRM_GROUPS, CORE_STEPS, briefCoverage, briefProgress, briefToText, confirmBrief, legacyFieldNotice, readBrief, recomputeDesignLock, saveBrief, sceneCountHint, stepMissingFields, type Brief } from "./brief.service";
import { listAnnotations, resolveAnnotations } from "./annotation.service";
import { FORM_SPECS, designLockSummary, lockViolations, normalizeForm } from "../shared/designLock";
import { auditBriefAgainstProject, auditToText } from "./brief-audit.service";
import { listNarrationClips, markVoiceHeard, narrationFingerprint, voiceHeardState } from "./narration-voice.service";
import { pickPreviewRange } from "../shared/previewWindow";
import { densitySummary, projectDensity, rhythmIssues } from "../shared/density";
import { readScript, saveScript, confirmScript, scriptToText, estimateSeconds, scriptChars, SCRIPT_TYPES, type Script } from "./script.service";
import { readReview, markReviewRequested, markReviewConfirmed, markNeedsWork, markSelfRender, markProbe, markChosenStyle, reviewToText } from "./review.service";
import { listStyles, presetOf, readStyle, styleSummary } from "./styles.service";
import { readStoryboard, saveStoryboard, storyboardToText, type Storyboard } from "./storyboard.service";
import { readTiming, saveTiming } from "./narration-timing.service";
import {
  analyzeReflow,
  findSceneOf,
  mergeTiming,
  patchStoryboard,
  resolveChanges,
  type LooseScene,
} from "./revise.service";
import { ELEMENT_LIBRARY, elementFromLibrary } from "../shared/elementLibrary";
import { getMeta, normalizeProps, describeTypeDeep } from "../shared/sceneMetas";
import {
  assetIdOf,
  assetToElement,
  isAssetLibraryId,
  toAssetId,
  type CustomAsset,
} from "../shared/assetLibrary";
import { TRANSITION_TYPES } from "../shared/transitions";
import {
  CUSTOM_EASES,
  EFFECT_CURVES,
  EFFECT_CURVE_LABEL,
  EFFECT_OPTIONS,
  EFFECT_TYPES,
  effectParamsOf,
} from "../shared/effects";
import { customEffectSchema, MAX_VOLUME, sceneSpans, totalDuration } from "../shared/schema";
import { animLandingIssues, freeElSchema, normalizeFreeElement, staggerAnim } from "../shared/freeform";
import { SUBTITLE_LIMITS, normalizeSubtitle, subtitleToField } from "../shared/subtitleText";
import { sceneSubtitleLines, subtitleMaxChars } from "../shared/subtitle";
import { detectFlavor } from "../shared/aiFlavor";
import { lintCopyLines, lintScriptLines } from "../shared/copyLint";
import { beatFrames, beatTimes, buildCompressCurve, DEFAULT_DUCKING, gainForTarget, nearestBeat, summarizeCurve } from "../shared/audio";
import { analyzeBeats, BEAT_CONFIDENCE_MIN } from "./audio-analysis.service";
import { VERSION } from "./version";
import { logToolCall, toolStats, toolStatsToText } from "./tool-log.service";
import {
  EFFECT_DESC,
  BASE,
  BRK,
  TRANSITION_DEFAULT_FRAMES,
  processGateBypass,
  SKIPPED_NOTE,
  FORCE_QUOTE_MIN,
  pickReviewFormat,
  platformSafeArea,
  auditSubtitles,
  ROOT,
  ensureServer,
  dirtySincePreview,
  DIRTY_HINT,
  fmtSummary,
  liftWarnings,
  needsDirtyHint,
  api,
  ProjectLite,
  lastProjectId,
  setCurrentProject,
  refreshPointer,
  assertNarrationHeard,
  resolveProject,
  composeElement,
  normalizeOps,
  brief,
  alignScenesToStoryboard,
  probeAssets,
  probeOne,
  ToolDef,
  text,
  FORMAT_PRESETS,
  briefImpactLog,
  describeBriefImpact,
  rememberDeliveryPreferences,
  firstLine,
  Role,
  collectAudioEntries,
  ProjectAssetLite,
  OrganizeResultLite,
  formatBytes,
  LoudnessLite,
  loudnessOf,
  clipWarning,
  validateToolArgs,
  fullDoc,
  clearDirty,
  probedDurationFrames,
} from "./tools/_shared";
import { SCENE3D_TOOLS } from "./tools/scene3d";
import { PROJECT_TOOLS } from "./tools/project";
import { BRIEF_TOOLS } from "./tools/brief";
import { SCRIPT_TOOLS } from "./tools/script";
import { STORYBOARD_TOOLS } from "./tools/storyboard";
import { CLEANUP_TOOLS } from "./tools/cleanup";

// 老调用方（server/index.ts）从这里引，保持导出面不变
export { validateToolArgs } from "./tools/_shared";

/** 工具门面：常驻暴露的核心工具；其余工具经 tool_search 发现、tool_call 执行 */
export const CORE_TOOL_NAMES = new Set(["start_guide", "get_guide", "tool_search", "tool_call"]);

/** MCP_EXPOSE=all 时恢复全量暴露（调试用） */
export const exposeAllTools = () => (process.env.MCP_EXPOSE ?? "").trim().toLowerCase() === "all";

const TOOLS: ToolDef[] = [
  {
    name: "start_guide",
    description:
      "开工入口：返回完整创作流程（接单→brief→风格→分镜→搭建→配音→自检→渲染→沉淀，含 3D/iso 场景的环境前置），以及你现在处在哪一步、该读哪篇技能、下一步动作。每次新任务先调它一次。",
    shape: {
      projectId: z.string().optional().describe("传了会判断当前工程进度"),
    },
    run: async (a) => {
      const nl = String.fromCharCode(10);
      const lines: string[] = [
        "# 创作流程（接单 → 成片）",
        "铁律：标【闸口】的 9 个节点一个都不能跳（跳过必返工）；没标的步骤可合并提速，但省之前先跟用户说一句。",
        "【闸口】① 工程归属　② 9 步真的问了用户　③ brief 用户点头　④ 稿件用户点头　⑤ **风格样张用户挑**　⑥ 分镜提案用户选　⑦ 风格帧用户过目　⑧ 观感规格齐 + 用户到编辑器看片　⑨ 交付前自检",
        "⑤⑥ 在用户明确说「直接做 / 别问了」时可跳（跳过要在最后说明「这版没做风格帧确认」）；①②③④⑦⑧ 永不跳。",
        "",
        "项目根（技能和文档里写的 <项目根> 都指这里，相关相对路径从这里出发）：" + PROJECT_ROOT,
        "环境前置【用到 3D（scene3d）或 iso 图解幕时，开工前先过一遍，这两个功能环境如不能用，明确告知用户】：",
        "  • scene3d（3D 幕）唯一前置：**用户的浏览器要支持 WebGL**。three.js 已在依赖里，不用装任何东西；",
        "    但 3D 幕的实时预览（编辑器）和渲染（Chrome）都吃 WebGL，浏览器不支持或被禁用时表现为 3D 幕黑屏。",
        "    用户说「我看不到 3D」先查这个：换 Chrome/Edge 验证、或开 chrome://gpu 看 WebGL 是否可用，别先怀疑代码。",
        "  • iso（图解拆解）唯一前置：**外部工具 anatomy 是否已下载**。如有需要用到该功能，先查：`ls .other_modules/anatomy/kit/iso-kit.mjs`。",
        "    在 → 按 get_guide(\"external-tools\") 画图并落盘；",
        "    不在 → 询问用户是让你来处理下载还是让用户自己下载，下载好后放进 .other_modules（主路径）。",
        "    工具没下载时 iso 幕仍可引用已有 SVG（素材在 public/assets/projects/<id>/iso/），只是画不了新图。",
        "0. 定位《导演》 → get_guide(\"director\")；连续做同类片子可只读一节：get_guide(\"director\",\"流程\")",
        "1. 查记忆 → recall()：先看以前踩过什么坑、这个用户有什么偏好（一次调用，别省）",
        "2. 定工程归属【闸口①】 → list_projects() → **问用户：这次是新增一支，还是改已有工程？**",
        "   ↳ 改已有：先 get_project + get_history 复述现状（几幕 / 现在什么风格 / 上次改到哪），再问「这次只动什么」→ 写进 brief 的 editMode + changeScope；别顺手改他没让改的地方",
        "   ↳ 新增：create_project（形态没定就留空 = 空白工程，别为了建工程先定版式）",
        "3. 接单【闸口②】 → intake() 先看 4 组 → intake(group=1..4) 逐组问 → save_brief 一次传齐该组；4 组齐了把总结发用户",
        "   ① 内容骨架（一句话=谁/相信什么/什么动作 + 形态 + 段落表 + 开头3秒/结尾 + 必现禁用）",
        "   ② 画面清单（镜头：谁出镜、在哪拍、产品状态、要哪些镜、每镜一句话）③ 声音字幕（配音规格/字幕/BGM/参考指到时间点）④ 素材交付（责任人+截止/交付版本/验收）",
        "   ⚠ 顺序不能倒：段落表没定别写镜头，镜头没定别配声音——倒着做必然返工。",
        "   ⚠ **动画/背景/转场/特效不问实现类型，只收档位**（克制-标准-活泼 / 利落-柔和-动感 / 关-点缀-允许），类型由设计锁推导。说得出「flip 还是 circle」的用户不存在。",
        "   ⚠ 能用眼睛判断的就别让他用嘴描述：密度、动感、转场性格各出三档图让他选。",
        "   ⚠ save_brief 不传 step 的批量通道只有一种合法用法：用户已一次性把信息给全、且你已逐字段复述请他确认。替你拍板的字段写进 assumed（>3 条会提醒）。",
        "   ⚠ 画幅必须问死：横屏（课程/B站/视频号）还是竖屏（抖音原生）。画幅是不可逆的架构决策——版式、字号基准、安全区、能放几列全跟着它变。",
        "4. 确认【闸口③】 → confirm_brief（不确认，build_storyboard 直接拒绝）",
        "   ↳ 闸口判的是**内容**不是必填：段落表每段有时长+内容、镜头能直接排拍摄（动画片换元素清单）、参考指到时间点、素材有责任人+截止、交付有版本列表。缺了会逐条告诉你缺什么。",
        "5. 稿件【闸口④】 → intake(10) 定稿件类型 → get_guide(\"script\") 定写法 → save_script 写稿 → **把整段稿发给用户过目** → confirm_script",
        "   ↳ 文案三条：标题写结论不写主题、数字配参照系、删掉形容词（get_guide(\"content\")）；save_script 会做机械体检",
        "   ↳ 去 AI 味：翻案腔（不是…而是…）、三项排比（不仅…也…更…）、结尾升华（让我们一起）、模糊归因（专家指出）四条最致命，见 get_guide(\"content\",\"AI 味\")",
        "   ↳ 稿子决定幕数、幕长、配音、字幕。口播稿念得出来吗？屏幕文案字够少吗？双轨有没有两套话打架？——没确认别写分镜。",
        "5b. 配音【闸口④】→ 两条路都行：① tts_narration(mode=\"timing\") 合成 ② **register_narration** 登记外部音频（真人录音/别的 TTS，支持一幕多条、留空、整轨切片，flac/aac 会被拒并给出转码命令）",
        "   ↳ 把回执里的「试听：http://…」链接原样发给用户，**然后停住**。只问三件事：语速 / 错字 / 停顿。",
        "   ↳ 用户听过说「可以」→ confirm_narration(userSaid=\"他的原话\")；**没听过不许建幕**（构建工具会直接拒绝）。",
        "   ↳ 为什么要停：没听过就排版 = 把画面锁在没确认的语音上。改一句台词 → 重新合成 → 幕长变 → 每幕坐标和动画帧位全重排。",
        "   ↳ 重跑过 TTS 要重新确认（旧版本听过不算）——这是防「改了稿还按旧时长排」。",
        "   ↳ 骨架确认后 → save_storyboard(useNarrationTiming=true) 自动回填每幕 durationInFrames；段数必须和幕数一致（对不上直接拒）。",
        "6. 观感规格 → intake(11)：mood 三个形容词 / 安全区 / 封面 / 字幕规格 / 音效层 → save_brief(step=11)",
        "   ↳ 这五项决定\"好不好看、专不专业\"。写分镜时可以先不齐（会软提醒），但**请用户看片前必须齐**——标准没定，他只能说「感觉不对」。",
        "7. 风格样张【闸口⑤】 → probe_style(slugs=[候选1,候选2,候选3])：同一幕出 2–3 张不同风格的图 → **发给用户挑** → confirm_style_probe(slug)",
        "   ↳ 这是\"别一股脑开干\"最硬的一道防线。用户没看过图就往下做，等于让他在成片里做第一次审美判断——那时候改一张图要动 50 幕。",
        "   ↳ 没 probe 过，build_storyboard 会直接拒绝。",
        "8. 风格落地 → 定好 slug 后按需微调：get_style 读规则 → set_theme / apply_style；用 mood 反查一遍（要「高级」就别上弹跳动效）",
        "9. 分镜【闸口⑥】 → get_guide(\"formats\") 定结构 → 2–3 个拉开差距的提案给用户选 → save_storyboard（每幕 text 直接取自稿件分段）",
        "   ↳ 只写计划，不建场景。长片分多次提交用 append=true（50 幕一次传会超长被截断）。",
        "10. 风格帧【闸口⑦】 → build_storyboard(shot=1) 只建第 1 幕 → preview_frames 抽 1–3 帧 + **render_preview_clip 出一段 6 秒带声片段**给用户过目",
        "   ↳ 静帧只能看配色；转场、节奏、字幕可读性、BGM 大小必须看动/听声——用 render_preview_clip，几十秒出片，别等整片。",
        "   ⚠ **判断动画好不好看必须看动**：连出 6 张静帧等于没验——静帧里看不出动画问题，用户一句「动画太少」就是整轮返工。",
        "   ↳ 调性不对就回第 9 步改分镜（改文案/版式很便宜，改完重建 1 幕），别硬着头皮往下铺。",
        "11. 铺开 → **build_film 一次建成整片**（幕/字幕/转场/入场动画一起给，只涨 1 个 rev）；要按已存的分镜表建就用 build_storyboard(replace=true)。全片统一的东西用 apply_to_scenes 批量套（字幕样式/贴纸/画中画），别逐幕调",
        "   ↳ 铺完立刻 render_preview_clip（不传参＝自动挑第一个转场交界）：转场叠字、BGM 压人声、字幕来不及读，这一段全能看出来。",
        "12. 精修 → update_scene / set_transform / add_element（自由画布 get_guide(\"freeform\")；**3D 场景（行星/分子/装置/空间感）用 add_scene(type=\"scene3d\") + get_guide(\"scene3d\")**；质感与签名时刻 get_guide(\"craft\")）；按 subtitleSpec 调字幕",
        "   ↳ 画面要氛围（光圈/光斑/颗粒/漏光/火花）就 set_scene_backdrop 垫在这一幕底下——**不要为氛围单独插一幕**，那会多出一段没有内容的时长",
        "   ↳ 字幕铁律：**一屏 8–16 字（最多 18）、不带标点、一屏念得完**。set_subtitle / build_storyboard / tts_narration 写入时自动拆段并回显拆分预览；老工程长字幕用 fix_subtitles(dryRun) 重拆。规则见 get_guide(\"subtitle\")",
        "   ⚠ 每改一批，**preview_frames 抽 1–2 幕看**（改完不看就往下做，是返工的最大来源）；脏着不抽帧，render / request_review 会被拒。",
        "   ↳ 参数拿不准（maxWidth / bottom / stroke / anchor）先 probe_param 出 1 张图摸清楚，别拿整片当实验场；字幕距底直接写 bottomPct（按画面高度，抖音竖屏 18–22）",
        "13. 声音 → get_guide(\"sound\") 定 BGM/避让 → get_guide(\"narration\") → tts_narration（applyToScenes=true 对齐）；要音效按 brief.sfx 加 add_audio_track",
        "14. 自检【闸口⑨】 → get_guide(\"qa\") → check_project（⚠️要修/ℹ️确认一下，含字幕超标、安全区、竖屏构图、契约体检）→ brief_audit 对一遍「说了有没有做到」→ preview_frames(around=\"transitions\") 看转场",
        "   ↳ mustInfo 漏项 / 禁词命中会**挡住 render_video**（这是契约唯一的硬保证）；确实要强行出片才传 forceContract=true，**并且必须附 forceUserQuote（用户原话）**。",
        "   ↳ 字幕超 26 字 render_video 会直接拒：先 fix_subtitles(dryRun=true) 看预演 → fix_subtitles 落盘",
        "15. 验收【闸口⑧】 → request_review：**请用户去编辑器把整片播一遍**（节奏 / 转场 / 字幕 / 音画同步只有整片看得出）",
        "   ↳ 让他把问题**标在帧上**（编辑器画面右上「批注」）：他会拿到精确到幕内帧的定位 → 你读 get_annotations 逐条改、改完 resolve_annotation，比一句\"这里怪怪的\"少返工好几轮",
        "   ↳ 通过 → confirm_review(approved=true)　要改 → confirm_review(approved=false, feedback=[...]) 改完再请他看　他自己导出 → selfRender=true",
        "16. 渲染 → render_video(dryRun) → render_video（没验收过 / 刚改过没抽帧都会被拒；用户明确说「不用看了直接渲」才 force=true + forceUserQuote=他的原话）",
        "   ↳ 长片别用 wait 硬等（上限 240s，超过也等不到）：拿 taskId 用 **get_render_status(taskId, waitSec=25)**，状态一变立刻返回，12 分钟的片子约 30 次就够——别几秒一查，纯浪费轮次。",
        "   ↳ 渲染期间不要抽帧 / 出封面（共用同一个浏览器实例，会 delayRender 超时）：等它结束，或先 cancel_render。",
        "17. 交付 → render_cover 出封面候选给用户挑（要单独设计封面就另建一幕再抽）；再 remember / save_template",
        "",
        "所有指南：list_guides；只读某一节：get_guide(name, section)",
        `工具分两层：常驻 4 个（start_guide / get_guide / tool_search / tool_call），其余 ${TOOLS.filter((d) => !CORE_TOOL_NAMES.has(d.name) && !d.retiredTo).length} 个按需调用——`,
        "  找工具：tool_search(\"画中画\")；执行：tool_call(name=\"move_scene\", args={...})；全表与铁律：get_guide(\"manual\")",
      ];

      if (a.projectId) {
        const p = await resolveProject(a.projectId);
        const brief = readBrief(p.id);
        const sb = readStoryboard(p.id);
        const shotTotal = sb?.shots?.length ?? 0;
        const shotBuilt = sb?.shots?.filter((x) => x.sceneId).length ?? 0;
        const hasAudio = (p.scenes ?? []).some((sc: any) =>
          (sc.elements ?? []).some((e: any) => e.kind === "audio"),
        );
        const sceneCount = (p.scenes ?? []).length;
        const script = readScript(p.id);
        const review = readReview(p.id);
        const needsScript = !!brief?.scriptType && !/无稿/.test(brief.scriptType);
        const stage =
          (review?.confirmedAt || review?.selfRender)
            ? review?.selfRender
              ? "交付（用户自己导出，你不用渲染）"
              : "渲染（用户已验收）"
            : hasAudio
              ? "验收（声音就位 → request_review 请用户到编辑器看片）"
              : shotTotal > 0 && shotBuilt >= shotTotal
                ? "精修 / 配音（场景已按分镜铺开，还没有旁白）"
                : shotBuilt > 0
                  ? "铺开（风格帧已建，确认方向后 build_storyboard(replace=true) 建其余幕）"
                  : shotTotal > 0
                    ? "风格帧（分镜有了但一幕没建：先 build_storyboard(shot=1) 验证调性）"
                    : needsScript && !script?.confirmedAt
                      ? `稿件（类型「${brief?.scriptType}」，稿子还没定稿：save_script → 发用户 → confirm_script）`
                      : sceneCount > 2
                        ? "分镜（已有场景，但还没有分镜表）"
                        : !brief
                          ? "接单（还没 brief）"
                          : !brief.confirmedAt
                            ? "确认（brief 还没被用户点头，别往下建）"
                            : "稿件（brief 已确认：先 intake(10) 定稿件类型，再写分镜）";
        lines.push("", `你现在在：${stage}`, `工程：${p.name}（${sceneCount} 场景）`);
      } else {
        lines.push(
          "",
          "还没指定工程【闸口①】：先 list_projects 看有哪些，然后**直接问用户**：「这次是新增一支，还是改已经有的一条？」",
          "  改已有 → switch_project + get_project + get_history 复述现状，并问清「这次只动什么」（写进 brief 的 changeScope）",
          "  新增 → create_project；形态没定就留空建空白工程（别为了建工程提前把版式定死），brief 确认后再决定模板 / 风格",
        );
      }

      // 记忆摘要顺手带出来：第 1 步写着「先 recall()」，但这一步最容易被跳过 ——
      // 那次就是因为没读，前两版视觉被同一位用户否掉，而偏好早就记在库里了。
      const mem = recallAll({ limit: 6, projectId: a.projectId ? (await resolveProject(a.projectId)).id : undefined });
      if (mem.length) {
        lines.push(
          "",
          `记忆里已有的（${mem.length} 条，开工前先看一遍，别重复踩坑）：`,
          ...mem.slice(0, 6).map((m) => `  · [${m.kind}] ${m.text}`),
        );
      }

      return lines.join(nl);
    },
  },
  {
    name: "get_guide",
    description:
      "读项目里的技能指南（按需加载，省上下文）。**name 只能取下表这 18 个之一**（传别的会报「没有技能」并列出可用名）：" +
      "manual（能力地图/工具全表/意图速查/铁律）、director（整片流程：问诊→分镜→搭建→验收）、" +
      "craft（画面质感：惊艳公式/节奏/签名时刻/禁止清单）、formats（用途→幕结构）、" +
      "script（稿件写法）、content（文案打磨：标题写结论/删形容词/去 AI 味）、subtitle（字幕：一屏一句、无标点）、" +
      "sound（声音设计）、narration（旁白配音与对齐）、long-form（超 12 幕长片）、" +
      "scene-recipes（75 个版式逐个速查）、freeform（自由画布全部写法与坑）、" +
      "**scene3d（3D 场景：6 个预设怎么选 + graph 场景图全字段 + 公转/卫星 + 太阳系示例 + 13 个坑）**、" +
      "external-tools（iso 等轴测图解：anatomy 出图→落盘→套主题）、" +
      "qa（分阶段自检）、delivery（画幅/字幕样式/渲染/交付）、memory（记忆与模板）、tools-quickref（薄入口）。\n" +
      "section 按标题关键字只取一节（如 get_guide(\"scene3d\",\"坑\")），对不上会列出该篇可用小节。\n" +
      "要看全量清单（名字+标题+字符数）：tool_call(name:\"list_guides\")。\n" +
      "**判断该读哪篇**：要做 3D/太空/行星/立体装置 → scene3d；要零件级技术插图 → external-tools；" +
      "要非常规排版 → freeform；不知道从哪下手 → manual 或 start_guide。",
    shape: {
      name: z
        .string()
        .describe("技能名，取上表 18 个之一，如 manual / director / scene3d / freeform / external-tools"),
      section: z
        .string()
        .optional()
        .describe("只读某个小节（按标题关键字匹配，如「接单确认」「坑」）"),
    },
    run: async (a) => {
      const name = a.name.replace(/\.md$/, "");
      return readSkill(name, a.section);
    },
  },
  {
    name: "probe_style",
    description:
      "开工前的视觉锚点：按 1–3 个候选风格，各出**两张同款样张**——密度页（看内容会不会空）+ 封面页（看调性）——让用户挑。\n" +
      "这是「别一股脑开干」的防线——50 幕做完才发现方向不对，返工量是现在的几十倍。\n" +
      "抽完把图发给用户，选中的用 confirm_style_probe 记下来；没 probe 过，build_storyboard 会拒绝。\n" +
      "⚠️ 冷启动第一次调用可能报浏览器连接超时——服务起来后浏览器要拉起，**重试一次通常就过**；连续两次超时才是真故障。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      slugs: z.array(z.string()).optional().describe("1–3 个候选风格 slug（list_styles 里挑）；不传用 brief.style"),
      sceneId: z.string().optional().describe("指定用哪一幕当样张；不传自动建／复用「样张」场景"),
      title: z.string().optional().describe("样张标题（不传用 brief.takeaway / goal）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const brief = readBrief(p.id);
      if (!brief?.confirmedAt) {
        throw new Error("brief 还没请用户确认：先走完 9 步问诊 + confirm_brief，再做风格样张");
      }
      const slugs: string[] = a.slugs?.length ? a.slugs : brief.style ? [String(brief.style)] : [];
      if (!slugs.length) {
        throw new Error("给 1–3 个候选风格 slug（先 list_styles 挑），或在 brief 里定好 style");
      }
      if (slugs.length > 3) throw new Error("一次最多 3 个候选：太多了用户挑不动");

      // 先把「根本没有这个风格」和「有但没预设」分开报：
      // brief.style 里常写中文名（「白板手绘」），一律回"没有预设"会让人以为库里真有这一项
      {
        const all = listStyles();
        const known = new Set(all.map((x) => x.slug));
        const unknown = slugs.filter((s) => !known.has(s));
        if (unknown.length) {
          const guess = all
            .filter((x) => unknown.some((u) => x.name.includes(u) || u.includes(x.name.replace(/（.*$/, ""))))
            .map((x) => `${x.slug}（${x.name}）`);
          throw new Error(
            `没有这些风格：${unknown.join("、")}${String.fromCharCode(10)}` +
              (guess.length
                ? `看着像想找：${guess.join("、")}——风格参数要传 slug，不是中文名`
                : `参数是 slug，不是中文名；用 list_styles 看全部 ${all.length} 个`),
          );
        }
      }

      // 「仅规则」的风格套不上，抽出来的其实是上一个风格的画面 —— 假样张比没样张更误导：
      // 用户会以为自己选的这个风格就长这样。所以宁可直接拒，也不给一张不属于它的图。
      const noPreset = slugs.filter((s) => !presetOf(s));
      if (noPreset.length) {
        const ready = listStyles()
          .filter((x) => x.hasPreset)
          .map((x) => x.slug);
        throw new Error(
          `这些风格没有结构化预设，出不了真样张：${noPreset.join("、")}${String.fromCharCode(10)}` +
            `样张必须是「这个风格真实的样子」。没有预设时抽出来的其实是当前主题，` +
            `用户会当成这个风格就是长这样——比不出样张更误导。${String.fromCharCode(10)}` +
            `两条路：① 换一个已带预设的风格（list_styles 里没标「仅规则」的都是，共 ${ready.length} 个）；` +
            `② 先用 get_style 读规则 → set_theme 手动改到位 → preview_frames 抽这一帧自己看（不走样张对比）`,
        );
      }
      const nl = String.fromCharCode(10);

      // 样张出**两张**：密度最高的一页（清单/数据）+ 封面（标题）页。
      // 只出标题页 = 让用户在信息最少的一页上做最重要的决定 —— 上次"太空旷"就是这么来的。
      // 指定 sceneId 时只出那一张（用户明确要看某幕）。
      const rows = (brief.mustInfo ?? [])
        .map((m) => String((m as { text?: string }).text ?? "").trim())
        .filter(Boolean)
        .slice(0, 5);
      const notes = (brief.segments ?? [])
        .map((x) => String((x as { content?: string }).content ?? "").trim())
        .filter(Boolean);
      const listTitles = rows.length
        ? rows
        : ["第一条信息", "第二条信息", "第三条信息", "第四条信息", "第五条信息"];
      const densityProps = {
        heading:
          a.title ??
          brief.core?.believe ??
          brief.takeaway ??
          brief.goal ??
          "信息密度样张",
        items: listTitles.slice(0, 5).map((t, i) => ({
          title: t.slice(0, 14),
          note: (notes[i] ?? "").slice(0, 12),
        })),
      };

      // 记住进样张前的 rev：抽完帧立刻还原 —— 风格对比是「看图」，绝不该在工程里留下副作用
      const revBefore = p.rev;

      const findOrCreate = async (
        name: string,
        type: string,
        props: Record<string, unknown>,
      ): Promise<string | undefined> => {
        const ex = (p.scenes ?? []).find((x: { name?: string }) => String(x.name ?? "") === name);
        if (ex) return String((ex as { id?: string }).id ?? "") || undefined;
        const created = await api<{ createdSceneIds: string[] }>(`/api/projects/${p.id}/ops`, {
          method: "POST",
          body: JSON.stringify({
            actor: "agent",
            ops: [{ op: "add_scene", type, name, props }],
          }),
        });
        return created.createdSceneIds?.[0];
      };

      let shots: { slug: string; urls: { kind: string; url: string }[] }[] = [];
      let restoreNote = "";
      try {
      const targets: { id: string; kind: "density" | "title" }[] = [];
      if (a.sceneId) {
        targets.push({ id: a.sceneId, kind: "density" });
      } else {
        const densityId = await findOrCreate("样张·密度", "list", densityProps);
        const titleId = await findOrCreate("样张·封面", "title", {
          eyebrow: "STYLE PROBE",
          title: a.title ?? brief.core?.action ?? brief.takeaway ?? brief.goal ?? "标题样张",
          subtitle: `${brief.durationSec ?? 30}s · ${brief.platform ?? "竖屏"}`,
        });
        if (densityId) targets.push({ id: densityId, kind: "density" });
        if (titleId) targets.push({ id: titleId, kind: "title" });
      }
      if (!targets.length) {
        throw new Error("样张场景创建失败，检查场景类型 list / title 是否可用（list_scene_types）");
      }

      const applyTool = TOOLS.find((d) => d.name === "apply_style");
      for (const slug of slugs) {
        try {
          await applyTool?.run({ slug, projectId: p.id });
        } catch (err) {
          throw new Error(
            `套用「${slug}」失败：${err instanceof Error ? err.message : String(err)}。` +
              `样张必须是对的图，套不上就别抽——先修风格预设或换一个候选`,
          );
        }
        // 重新取工程，按最新时间轴算每一幕的中间帧
        const fresh = await api<{ project: any }>(`/api/projects/${p.id}`);
        const freshSpans = sceneSpans((fresh.project.scenes ?? []) as never[]);
        const urls: { kind: string; url: string }[] = [];
        for (const t of targets) {
          const idx = (fresh.project.scenes ?? []).findIndex((x: { id?: string }) => x.id === t.id);
          if (idx < 0) continue;
          const span = freshSpans[idx];
          const frame = (span?.start ?? 0) + Math.max(0, Math.floor((span?.dur ?? 30) * 0.6));
          const stills = await api<{ stills: { format: string; url: string }[] }>(
            `/api/projects/${p.id}/stills`,
            // tag 必须能把「风格 × 页型」区分开，否则后一张覆盖前一张，用户点开是同一张图
            { method: "POST", body: JSON.stringify({ frame, tag: `${slug}-${t.kind}` }) },
          );
          for (const st of stills.stills) urls.push({ kind: t.kind, url: `${BASE}${encodeURI(st.url)}` });
        }
        shots.push({ slug, urls });
      }

      } finally {
        // 无论成功还是中途报错，都把工程还原到样张前：风格对比绝不该留下副作用
        //（此前会把每个候选风格套到整个工程、结束后停在最后一个候选上，用户不挑就一直被改着）
        try {
          await api(`/api/projects/${p.id}/restore/${revBefore}`, { method: "POST" });
          restoreNote =
            `工程已自动还原到样张前状态（rev ${revBefore}）：主题与转场没有残留改动，样张幕也一并清掉（样张图以上面链接为准）。` +
            `用户选定后 confirm_style_probe 会正式套用该风格。`;
        } catch (e) {
          restoreNote =
            `⚠️ 自动还原失败（${e instanceof Error ? e.message : String(e)}）：工程还停在最后一个候选风格上，` +
            `请立即 restore_rev(rev=${revBefore}) 回滚。`;
        }
      }

      markProbe(p.id, slugs);
      const kindLabel = (k: string) => (k === "density" ? "密度页（看内容会不会空）" : "封面页（看调性）");
      const body = shots
        .map((x, i) => {
          const byKind = new Map<string, string[]>();
          for (const u of x.urls) byKind.set(u.kind, [...(byKind.get(u.kind) ?? []), u.url]);
          return (
            `${i + 1}. ${x.slug}${nl}` +
            [...byKind.entries()].map(([k, list]) => `   ${kindLabel(k)}${nl}${list.map((u) => `     ${u}`).join(nl)}`).join(nl)
          );
        })
        .join(nl);
      return (
        `已出 ${shots.length} 张风格样张（同一幕、不同风格）：${nl}${body}${nl}` +
        `${nl}${restoreNote}${nl}` +
        `${nl}下一步：**把这几张图发给用户挑**，问他「哪张的感觉最接近你要的」。` +
        `${nl}选定后 confirm_style_probe(slug="...") 记下来，再 save_storyboard。` +
        `${nl}注意：每张都是套完该风格后单独抽的（各自一个文件，不会互相覆盖）；` +
        `铺开时 build_storyboard(replace=true) 会把这幕清掉。`
      );
    },
  },
  {
    name: "confirm_style_probe",
    description:
      "记下用户挑定的风格（视觉锚点）：会重新套用该风格 + 写 brief.style，并记录 probeAt（build_storyboard 认这个）。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      slug: z.string().describe("用户挑定的风格 slug"),
      note: z.string().optional().describe("用户当时怎么说的（留档，比如「更接近第 2 张，但别这么亮」）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const applyTool = TOOLS.find((d) => d.name === "apply_style");
      let warn = "";
      try {
        await applyTool?.run({ slug: a.slug, projectId: p.id });
      } catch (err) {
        // 没有结构化预设的风格套不上，但用户已经挑过样张了，锚点照记
        warn =
          String.fromCharCode(10) +
          `⚠️ 这个风格没有一键预设（${err instanceof Error ? err.message : String(err)}）：` +
          `先 get_style 读规则，再 set_theme / 手动改颜色字体，别放着不管。`;
      }
      saveBrief(p.id, { style: a.slug } as Brief);
      markChosenStyle(p.id, a.slug);
      const nl = String.fromCharCode(10);
      return (
        `已定风格：${a.slug}${a.note ? `（用户原话：${a.note}）` : ""}${warn}${nl}` +
        `视觉锚点已记录。下一步：save_storyboard 写分镜 → build_storyboard(shot=1) 再确认一次细节 → 全量铺开。`
      );
    },
  },
  {
    name: "apply_to_scenes",
    description:
      "把同一个操作批量套到多幕：指定 tool（如 set_subtitle_style / add_element / set_scene_box / update_scene / set_scene_type）+ args（不含 sceneId）+ sceneIds 或 applyToAll=true。\n" +
      "用来替代「50 幕 × 5 轮 = 250 次调用」：字幕样式、贴纸、画中画、转场这类全片统一的改动，先在一幕上试好，再用它一次性推全片。\n" +
      "注意：全片统一转场**直接用 set_transitions**（它自己就能批量，不经过本工具）；失败语义是**逐幕执行、部分成功**（失败的场景在回执里列出，其余已生效），要「一错全不落库」的原子批量用 apply_ops。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      tool: z.string().describe("要批量执行的工具名（必须接受 sceneId 参数）"),
      args: z.record(z.any()).optional().describe("该工具的参数（不要带 sceneId / projectId，会自动补）"),
      sceneIds: z.array(z.string()).optional().describe("目标场景 id 列表；不传 + applyToAll=true 才有意义"),
      applyToAll: z.boolean().optional().describe("true = 套到工程里所有场景"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const FORBIDDEN = new Set([
        "apply_to_scenes",
        "tool_call",
        "apply_ops",
        "build_storyboard",
        "save_storyboard",
        "save_brief",
        "save_script",
        "revise_script",
        "remove_scene",
        "reorder_scenes",
        "delete_project",
        "render_video",
        "export_project",
        "import_project",
        "switch_project",
        "create_project",
      ]);
      if (FORBIDDEN.has(a.tool)) throw new Error(`「${a.tool}」不能批量套：它要么是批量通道本身，要么会破坏工程结构`);
      const def = TOOLS.find((d) => d.name === a.tool);
      if (!def) throw new Error(`没有工具「${a.tool}」（先 tool_search 找一下）`);
      if (!("sceneId" in def.shape)) {
        throw new Error(`「${a.tool}」不接受 sceneId 参数，不能按幕批量套`);
      }
      const all = (p.scenes ?? []).map((x: any) => x.id);
      const targets = a.applyToAll ? all : (a.sceneIds ?? []);
      if (!targets.length) throw new Error("给 sceneIds，或 applyToAll=true 套到全片");
      const unknown = (targets as string[]).filter((id: string) => !all.includes(id));
      if (unknown.length) throw new Error(`这些场景不存在：${unknown.join("、")}`);

      const failed: string[] = [];
      let done = 0;
      for (const sceneId of targets) {
        try {
          await def.run({ ...(a.args ?? {}), sceneId, projectId: p.id });
          done++;
        } catch (err) {
          failed.push(`${sceneId}：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const nl = String.fromCharCode(10);
      return (
        `已批量执行 ${a.tool}：成功 ${done}/${targets.length} 幕` +
        (failed.length ? `${nl}失败 ${failed.length} 幕：${nl}${failed.join(nl)}` : "") +
        `${nl}下一步：preview_frames 抽 2–3 幕看效果（别假设全片都对了）`
      );
    },
  },
  {
    name: "list_styles",
    description:
      "列出风格库：slug + 名称，标明哪些能 apply_style 一键套 / probe_style 出真样张（标「仅规则」的只能 get_style 读规则手动改）。共 40+ 种（暗色发布会/瑞士编辑/粗野排版/电影片头/像素/国潮/水墨/白板手绘…）。",
    shape: {},
    run: async () => {
      const list = listStyles();
      const nl = String.fromCharCode(10);
      const ready = list.filter((x) => x.hasPreset).length;
      return (
        `共 ${list.length} 种风格（${ready} 种可一键套用）：` +
        nl +
        list
          // 全都有预设时不再逐行打「可一键套用」——43 个一样的标记只是噪音，只标例外
          .map((x) => `- ${x.slug}：${x.name}${x.hasPreset ? "" : "（仅规则，套不上）"}`)
          .join(nl)
      );
    },
  },
  {
    name: "get_style",
    description:
      "读某个风格的完整规则（本质 / 辨识信号 / 最俗的版本 / 配色 / 字体 / 运动 / 坑）。先 list_styles 挑，再只读选中的 1–2 个。",
    shape: {
      slug: z.string().describe("风格 slug，如 dark-keynote / swiss-editorial"),
      section: z.string().optional().describe("只读某一节（按标题关键字匹配）"),
    },
    run: async (a) => readStyle(a.slug, a.section),
  },
  {
    name: "apply_style",
    description:
      "一键套用风格：改主题（配色/字体/圆角）+ 场景入场转场，返回推荐版式与禁止项。**只能套带预设的风格**（list_styles 里没标「仅规则」的），仅规则风格会报错。只覆盖「系统的值」，版式与文案仍按风格规则重做。\n" +
      "转场只改**还是版本默认（fade 12 帧 / 未设）**的场景：已经用 set_transitions 显式设过的不动，要全覆盖传 overwriteTransitions=true。",
    shape: {
      slug: z.string().describe("风格 slug"),
      transitions: z.boolean().optional().describe("是否同时应用转场，默认 true"),
      overwriteTransitions: z
        .boolean()
        .optional()
        .describe("true = 覆盖所有场景的入场转场（含已显式设过的）；默认 false 只改还是默认转场的场景"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const preset = presetOf(a.slug);
      if (!preset) {
        const all = listStyles();
        const known = all.some((x) => x.slug === a.slug);
        if (!known) {
          const guess = all
            .filter((x) => x.name.includes(a.slug) || a.slug.includes(x.name.replace(/（.*$/, "")))
            .map((x) => `${x.slug}（${x.name}）`);
          throw new Error(
            `没有这个风格：「${a.slug}」。参数是 slug 不是中文名；` +
              (guess.length ? `看着像想找 ${guess.join("、")}` : `用 list_styles 看全部 ${all.length} 个`),
          );
        }
        throw new Error(
          `「${a.slug}」还没有结构化预设（server/styles/presets.json 里缺这一条）：用 get_style 读规则后手动 set_theme + set_transitions。`,
        );
      }
      const p = await resolveProject(a.projectId);
      const ops: Record<string, unknown>[] = [
        {
          op: "set_theme",
          palette: preset.palette,
          font: preset.font,
          radius: preset.radius,
        },
      ];
      let keptCustom = 0;
      if (a.transitions !== false && preset.transition) {
        const t =
          preset.transition.type === "none"
            ? null
            : {
                type: preset.transition.type,
                durationInFrames: preset.transition.durationInFrames,
              };
        for (const sc of p.scenes ?? []) {
          // 「显式设过」的判定：入场转场不是版本默认（fade 12 帧 / 未设）就当作是人为设的。
          // 以前无条件全覆盖——先 set_transitions(zoom,8) 再套风格，入场就被换掉，
          // 而出场 transitionOut 不受影响，于是全片「入场是风格值、出场是我设的值」。
          const cur = (sc as { transitionIn?: { type?: string; durationInFrames?: number } | null })
            .transitionIn;
          const isDefault =
            !cur || (cur.type === "fade" && (cur.durationInFrames ?? TRANSITION_DEFAULT_FRAMES) === TRANSITION_DEFAULT_FRAMES);
          if (!isDefault && !a.overwriteTransitions) {
            keptCustom++;
            continue;
          }
          ops.push({ op: "update_scene", sceneId: sc.id, patch: { transitionIn: t } });
        }
      }
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops }),
      });
      return `已套用风格（${res.summary.length} 处改动）${String.fromCharCode(10)}${styleSummary(a.slug)}${String.fromCharCode(10)}${keptCustom ? `转场：保留了 ${keptCustom} 个你显式设过的入场转场（要统一成风格值传 overwriteTransitions=true）。${String.fromCharCode(10)}` : ""}注意：转场只应用到**现有**场景，之后新建的场景默认转场是 fade 12 帧——要一致就给新场景补 set_transitions 或重跑 apply_style。${String.fromCharCode(10)}下一步：save_storyboard 写分镜（见 get_guide("director","分镜")）`;
    },
  },
  {
    name: "list_guides",
    description:
      "列出所有可用的技能指南（名称、标题、字符数），配合 get_guide 使用。" +
      "常驻只暴露 4 个核心工具，所以本工具要用 tool_call(name:\"list_guides\") 调，直接按 mcp__ 前缀调会 not found。",
    shape: {},
    run: async () => {
      const skills = listSkills();
      if (!skills.length) return "还没有技能文件（server/skills/*.md）";
      return skills
        .map((x) => `- ${x.name}：${x.title}（${x.chars} 字符）`)
        .join("\n");
    },
  },
  {
    name: "remember",
    description:
      "记一条经验，按类存：pitfall（坑与解法）、preference（用户偏好/禁忌）、recipe（有效配方）。踩坑后、用户提出要求、发现好组合时用；相同内容不会重复记。",
    shape: {
      kind: z
        .enum(["pitfall", "preference", "recipe"])
        .describe("pitfall=坑与解法；preference=用户审美/禁忌；recipe=有效版式/参数配方"),
      text: z.string().describe("内容：写清触发条件 + 结论/解法，便于以后检索"),
      tags: z.array(z.string()).optional().describe("2-4 个关键词，便于 recall"),
      scope: z.enum(["global", "project"]).optional().describe("默认 global（跨工程）；只对本片有效的用 project"),
      projectId: z.string().optional().describe("scope=project 时必传"),
    },
    run: async (a) => {
      const it = remember({
        kind: a.kind as MemoryKind,
        text: a.text,
        tags: a.tags,
        scope: a.scope,
        projectId: a.projectId,
      });
      return `已记入 ${it.kind}（${it.id}，${a.scope ?? "global"}）`;
    },
  },
  {
    name: "recall",
    description:
      "检索记忆（坑/偏好/配方）：不传 kind 查全部类别，传 projectId 同时查工程级记忆。开工前先查一遍，避免重复踩坑。",
    shape: {
      kind: z.enum(["pitfall", "preference", "recipe"]).optional().describe("只查某一类，不传查全部"),
      query: z.string().optional().describe("关键词，短词更容易命中"),
      tags: z.array(z.string()).optional().describe("按标签过滤（全部命中）"),
      projectId: z.string().optional().describe("传了就同时查该工程的记忆"),
      limit: z.number().int().min(1).max(50).optional().describe("最多返回条数，默认 20"),
    },
    run: async (a) => {
      const items = recallAll({
        kind: a.kind as MemoryKind | undefined,
        query: a.query,
        tags: a.tags,
        projectId: a.projectId,
        limit: a.limit,
      });
      if (!items.length) return "没有匹配的记忆。";
      return items
        .map((x) => `- [${x.kind}] ${x.text}${x.tags.length ? `（${x.tags.join("、")}）` : ""}`)
        .join("\n");
    },
  },
  {
    name: "list_templates",
    description:
      "列出整片模板：内置模板（口播带货 / 数据复盘 / 产品发布 / 空白）+ 用户存的「我的模板」。用户说\"做个口播视频\"这类需求时，先从这里挑模板建工程，再按需改文案，比自己从零拼场景快得多。",
    shape: {
      tag: z.string().optional().describe("只列带这个标签的模板（内置/自定义都过滤）"),
    },
    run: async (a: { tag?: string }) => {
      const { templates } = await api<{ templates: any[] }>("/api/templates");
      const tag = a.tag?.trim().toLowerCase();
      const list = tag
        ? templates.filter((t: any) => {
            // 内置模板本身没有业务标签：按「内置 / builtin」筛 kind，别让标签过滤把它们筛没
            const isBuiltin = t.kind !== "custom";
            if (["内置", "builtin", "系统"].includes(tag)) return isBuiltin;
            if (["我的", "自定义", "custom", "我的模板"].includes(tag)) return !isBuiltin;
            return (t.tags ?? []).some((x: string) => String(x).toLowerCase().includes(tag));
          })
        : templates;
      if (!list.length) return `没有带「${a.tag}」标签的模板（内置模板可用 tag="内置" 筛，我的模板用 tag="我的"）。`;
      return list
        .map((t: any) => {
          const kind = t.kind === "custom" ? "「我的模板」" : "内置";
          return `${t.key} · ${t.name}（${kind}）：${t.description}\n  ${t.sceneCount} 个场景 / 约 ${(t.durationInFrames / 30).toFixed(0)}s（按 30fps 折算）· 场景构成 ${t.sceneTypes.join(" → ")}`;
        })
        .join("\n");
    },
  },
  {
    name: "create_project",
    description:
      "从模板新建一个工程并切换过去（Web 端会自动跟随）。templateKey 取内置模板 key，templateId 取「我的模板」的 key（见 list_templates），二选一；两个都不传 = 建空白工程（形态还没想清楚时用这个，别为了建工程提前把版式定死）。用户要新片子的第一步就是它；建完用 update_scene 改文案、add_scene 补场景。",
    shape: {
      templateKey: z.string().optional().describe("内置模板 key，见 list_templates；留空 = blank 空白工程"),
      templateId: z.string().optional().describe("「我的模板」的 key（tpl_ 开头），与 templateKey 二选一"),
      name: z.string().optional().describe("工程名，不传用模板名"),
    },
    run: async (a) => {
      // 两个都不传就建空白：问诊之前不该先定版式骨架
      const templateKey = a.templateKey ?? (a.templateId ? undefined : "blank");
      const { project } = await api<{ project: ProjectLite }>("/api/projects/from-template", {
        method: "POST",
        body: JSON.stringify({ templateKey, templateId: a.templateId, name: a.name }),
      });
      setCurrentProject(project.id); // 新建的工程就是当前工程：后续无 projectId 的调用都落在它上面
      const blankNote = templateKey === "blank" ? "（空白工程：形态没定就先这样，brief 确认后再决定模板 / 风格）" : "";
      return `已创建工程「${project.name}」${blankNote}（id=${project.id}，${project.scenes.length} 个场景），并已切换为当前工程。\n场景清单：\n${project.scenes
        .map((s, i) => `  ${i + 1}. ${s.name}（${s.type}）${s.durationInFrames}帧 id=${s.id}`)
        .join("\n")}` + `\n下一步：recall() 查旧坑 → intake() 逐步接单——必填项要问用户，不能自己定；结构见 get_guide("director")`;
    },
  },
  {
    name: "list_projects",
    description:
      "列出所有工程（id / 名称 / 场景数 / 版本号），并标出当前默认工程。用户说「继续做上次的片子」或不确定在哪个工程上干活时先调它，再用 switch_project 切换。",
    shape: {},
    run: async () => {
      refreshPointer(); // 另一个通道可能刚切过工程
      const { projects } = await api<{ projects: { id: string; name: string; rev: number; scenes: number }[] }>(
        "/api/projects",
      );
      if (!projects.length) return "还没有任何工程。用 create_project 新建。";
      // 指针为空 **或指向已删工程** 都要自愈并写回，否则这里永远标不出 ★、
      // get_project 每次读都静默换一个工程（N-04 残留：旧写法只判断了「指针为空」）
      if (!projects.some((p) => p.id === lastProjectId)) {
        setCurrentProject(projects[0].id);
      }
      const nl = String.fromCharCode(10);
      // 对账：out/ 里有、data/ 里没有的工程 = 多半是另一个实例/另一份数据目录。
      // 不说的话，agent 会以为工程被删了，或者对着错误的工程继续改
      let orphanNote = "";
      let dataNote = "";
      try {
        const { ids, dataDir } = await api<{ ids: string[]; dataDir: string }>("/api/orphans");
        // 总是显示数据目录：同一台机器上可能有两套 data/ 目录（不同 cwd 启动的实例各一份），
        // 不显示绝对路径的话，「工程怎么不见了」根本无从判断——只能猜。
        dataNote = `${nl}数据目录：${dataDir}${nl}（本次连的是 ${BASE}；同一台机器上如果还有别的实例/别的 cwd，工程是按各自数据目录分开存的）`;
        if (ids.length) {
          orphanNote =
            `${nl}⚠ 对账提醒：out/ 里有 ${ids.length} 个工程不在当前数据目录（${ids.slice(0, 5).join("、")}${ids.length > 5 ? "…" : ""}）。` +
            `${nl}  当前数据目录：${dataDir}。这些工程要么是别的实例/别的数据目录写的，要么已被删只剩渲染产物。` +
            `${nl}  别当成「工程被删了」：先确认 SERVER_URL 指向的是不是同一个实例，再动手。`;
        }
      } catch {
        /* 对账拿不到不影响列表本身 */
      }
      return (
        `共 ${projects.length} 个工程（★ = 当前默认工程）：` +
        nl +
        projects
          .map(
            (p) =>
              `${p.id === lastProjectId ? "★" : " "} ${p.name}（id=${p.id}，${p.scenes} 场景，rev=${p.rev}）`,
          )
          .join(nl) +
        dataNote +
        orphanNote
      );
    },
  },
  {
    name: "switch_project",
    description:
      "切换当前默认工程：之后不带 projectId 的调用都作用于它。传 list_projects 里的工程 id。带 projectId 参数的调用不受影响（显式指定总是优先）。",
    shape: {
      projectId: z.string().describe("要切换到的工程 id（list_projects 里查）"),
    },
    run: async (a) => {
      const { project } = await api<{ project: ProjectLite }>(`/api/projects/${a.projectId}`);
      setCurrentProject(project.id);
      const nl = String.fromCharCode(10);
      return (
        `当前工程已切换为「${project.name}」（id=${project.id}，${project.scenes.length} 场景，rev=${project.rev}）。` +
        nl +
        `之后不带 projectId 的读写都落在它上面；带 projectId 的调用以显式指定为准。`
      );
    },
  },
  {
    name: "save_template",
    description:
      "把当前工程存成「我的模板」（整片快照：场景、画幅、主题、素材位置都保留），之后可用 create_project 的 templateId 复用。用户说\"把这条存成模板\"时用。",
    shape: {
      name: z.string().describe("模板名"),
      description: z.string().optional().describe("模板说明（适合什么内容），不传自动生成"),
      tags: z
        .array(z.string())
        .optional()
        .describe("2-4 个关键词，如 口播/数据/快节奏，方便之后 list_templates 过滤"),
      projectId: z.string().optional().describe("要存成模板的工程 id，不传用列表第一个"),
    },
    run: async (a) => {
      const project = await resolveProject(a.projectId);
      const { template } = await api<{ template: any }>("/api/templates", {
        method: "POST",
        body: JSON.stringify({
          projectId: project.id,
          name: a.name,
          description: a.description,
          tags: a.tags,
        }),
      });
      return `已把工程「${project.name}」存成模板「${template?.name ?? a.name}」（templateId=${template?.key ?? "?"}，${template?.sceneCount ?? project.scenes.length} 个场景）。之后 create_project 传这个 templateId 即可。`;
    },
  },
  {
    name: "list_scene_types",
    description:
      "列出场景类型及其字段、取值、默认时长。**要判断某类能不能做某事，就传 type 只查它**——返回展开到嵌套的完整字段表：数组元素的形状、几何体每个变体的字段、DSL 内层键。" +
      "不传 type 时默认给全表（很长），summary=true 只给一句话 + 字段名。" +
      "3D 场景与图解有专属写法指南：get_guide(\"scene3d\") / get_guide(\"external-tools\")。",
    shape: {
      type: z
        .string()
        .optional()
        .describe("只查这一个类型（如 scene3d / freeform / iso），返回完整嵌套字段表"),
      summary: z.boolean().optional().describe("不传 type 时生效：只列类型 + 一句话 + 字段名（省 token）"),
    },
    run: async (a: { type?: string; summary?: boolean }) => {
      /** 有专属写法指南的类型：查完字段顺手把人送到那篇，别让 agent 自己去翻源码 */
      const TYPE_GUIDE: Record<string, string> = {
        scene3d: "scene3d",
        iso: "external-tools",
        freeform: "freeform",
      };
      const NL = String.fromCharCode(10);
      if (a.type) {
        const text = describeTypeDeep(a.type);
        if (!text) {
          const { types } = await api<{ types: any[] }>("/api/scene-types");
          throw new Error(
            `没有场景类型「${a.type}」。可用：${types.map((t: any) => t.type).join("、")}`,
          );
        }
        const guide = TYPE_GUIDE[a.type];
        return text + (guide ? `${NL}${NL}写法、示例与坑（建议先读）：get_guide("${guide}")` : "");
      }
      const { types } = await api<{ types: any[] }>("/api/scene-types");
      const guideHint =
        `${NL}${NL}有专属写法指南的：freeform→get_guide("freeform")、scene3d→get_guide("scene3d")、iso→get_guide("external-tools")。` +
        `${NL}只查某一个类型的完整字段（含嵌套）：list_scene_types(type:"scene3d")。`;
      if (a.summary) {
        return (
          types
            .map(
              (t: any) =>
                `- ${t.type}（${t.name}）：${t.summary ?? ""} · ${t.fields
                  .map((f: any) => {
                    if (f.kind === "array" && Array.isArray(f.itemShape) && f.itemShape.length) {
                      return `${f.key}[{${f.itemShape.map((x: any) => x.key).join(", ")}}]`;
                    }
                    return f.key;
                  })
                  .join("/")}`,
            )
            .join(NL) + guideHint
        );
      }
      return (
        types
          .map((t) => {
            const shapeOf = (f: any): string => {
              // 数组字段把元素形状打出来，省得 agent 两次 zod 报错才摸到 key
              if (f.kind !== "array" || !Array.isArray(f.itemShape) || !f.itemShape.length) return "";
              const keys = f.itemShape
                .map((x: any) => `${x.key}${x.kind === "enum" ? `(${x.options.join("|")})` : ""}`)
                .join(", ");
              return ` 形状=[{${keys}}]`;
            };
            const fields = t.fields
              .map((f: any) => {
                const kind = f.kind === "enum" ? `(${f.options.join("|")})` : `(${f.kind})`;
                const dv = f.default !== undefined ? ` 默认=${JSON.stringify(f.default)}` : "";
                // 容量与范围必须写出来：复盘里「六档塞不进 items 上限 5」「value 传超范围被拒」都是建完才发现
                const cap =
                  f.kind === "array" && (f.minItems != null || f.maxItems != null)
                    ? ` minItems=${f.minItems ?? 0} maxItems=${f.maxItems ?? "∞"}`
                    : f.kind === "number" && (f.numMin != null || f.numMax != null)
                      ? ` min=${f.numMin ?? "-∞"} max=${f.numMax ?? "∞"}${f.numInt ? " int" : ""}`
                      : "";
                return `    - ${f.key} ${kind}${dv}${cap}${shapeOf(f)}：${f.label}`;
              })
              .join("\n");
            const els = (t.elements ?? []).length
              ? "\n  可拖动元素：" +
                t.elements.map((e: any) => `${e.id}（${e.label}）`).join("、")
              : "";
            return `${t.type} · ${t.name}：${t.summary}\n  时长 ${t.duration.min}-${t.duration.max} 帧，默认 ${t.duration.default}${els}\n${fields}`;
          })
          .join("\n\n") + guideHint
      );
    },
  },
  {
    name: "get_project",
    description:
      "获取工程摘要：画幅、总时长、场景列表（含 id/类型/时长/文案摘要）。不含完整 props。要看某个场景的 props 用 get_scene；只有特殊需要才 detail=full。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      detail: z
        .enum(["summary", "full"])
        .optional()
        .describe("summary=摘要（默认，省 token）；full=完整 JSON（含全部 props，很费 token）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      return a.detail === "full" ? JSON.stringify(p) : brief(p);
    },
  },
  {
    name: "get_scene",
    description:
      "获取单个场景的完整 props（含 id、时长、转场、backdrop、字幕样式）。sceneId 见 get_project / add_scene 回执；" +
      "只想看全片结构用 get_project，想逐字段查某类场景可填什么用 list_scene_types。",
    shape: { sceneId: z.string(), projectId: z.string().optional() },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const s = p.scenes.find((x) => x.id === a.sceneId);
      if (!s) throw new Error(`找不到场景 ${a.sceneId}`);
      return JSON.stringify(s, null, 2);
    },
  },
  {
    name: "add_scene",
    description:
      "新增一个场景。type 必须是 list_scene_types 返回的类型；props 只需给出想覆盖的字段，其余用默认值。元素 durationInFrames 是「出现多久」，不传或 -1 = 撑到场景结尾；想要独特排版用 type=\"freeform\"（写法见 get_guide(\"freeform\")）。返回新场景 id。",
    shape: {
      type: z.string(),
      props: z.record(z.any()).optional(),
      afterSceneId: z.string().optional().describe("插到该场景之后；省略则加到末尾。锚点不存在时自动追加到末尾（回执会提示），空画布或同批新建的场景请勿引用尚不存在的 id 当锚点"),
      name: z.string().optional(),
      durationInFrames: z.number().optional(),
      start: z.number().optional().describe("绝对起始帧；省略=接在同轨上一块之后"),
      track: z.number().optional().describe("轨道号，0=主轨；画中画用 1"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [
            {
              op: "add_scene",
              type: a.type,
              props: a.props,
              afterSceneId: a.afterSceneId,
              name: a.name,
              durationInFrames: a.durationInFrames,
              start: a.start,
              track: a.track,
            },
          ],
        }),
      });
      return `已创建场景 id=${res.createdSceneIds[0]}\n${fmtSummary(res.summary)}\n\n${brief(res.project)}`;
    },
  },
  {
    name: "update_scene",
    description:
      "局部更新某一幕：props 只传要改的字段，与现有值**合并**（不是整份替换）。\n" +
      "写法二选一：props:{title:\"新标题\"} 或扁平 {name:\"新名字\", props:{…}} 都认。\n" +
      "**传 null = 清空该字段**：如 props:{graph:null} 把自定义场景图清掉、回到预设场景（预设/速度/数量重新生效）。\n" +
      "字段名以 list_scene_types 的字段表为准——不认识的字段会被忽略并在回执点名。\n" +
      "scene3d 场景给了 graph 后 preset/spin/count/hue 不参与渲染（想调那些先清 graph）。\n" +
      "⚠️ update_scene **不会同步分镜表**：按分镜重建（build_storyboard replace=true）会把精修改回旧版——" +
      "改完场景记得 save_storyboard 同步，或只用 build_storyboard 做初次搭建。\n" +
      "name/durationInFrames 是场景级字段（改幕长用它们，元素时长不会跟着变）。误改可 restore_rev 回滚。",
    shape: {
      sceneId: z.string().describe("要改哪一幕（get_project / add_scene 回执里的场景 id）"),
      props: z
        .record(z.any())
        .optional()
        .describe("要改的 props 字段（合并语义，见上方说明）；字段名查 list_scene_types"),
      name: z.string().optional().describe("改这一幕的名字（时间轴上显示的）"),
      durationInFrames: z.number().optional().describe("改这一幕的时长（帧）"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [
            {
              op: "update_scene",
              sceneId: a.sceneId,
              patch: { props: a.props, name: a.name, durationInFrames: a.durationInFrames },
            },
          ],
        }),
      });
      /*
       * 分镜表是 build_storyboard(replace=true) 的**唯一依据**，而 update_scene 只改场景。
       * 两者不同步时，重建会把这一轮的精修改回旧版 —— 而且悄无声息。
       * 2026-11-02 真踩过：第 3 幕重做成「真公转 + 太阳点光」之后，分镜表里还写着
       * 「两颗静态地球」，一旦按分镜重建就全白做。
       */
      let stale = "";
      try {
        const sb = readStoryboard(p.id);
        const scene = (res.project.scenes as Array<{ id: string; props: Record<string, unknown> }>).find(
          (s) => s.id === a.sceneId,
        );
        const shot = sb?.shots.find((h) => h.sceneId === a.sceneId);
        if (scene && shot) {
          const shotProps = normalizeProps(shot.type, (shot.props ?? {}) as Record<string, unknown>);
          if (JSON.stringify(shotProps) !== JSON.stringify(scene.props)) {
            stale =
              `\n⚠️ 分镜表里这一幕还是旧版本（update_scene 不会改动分镜表）。` +
              `将来 build_storyboard(replace=true) 会把它退回旧版；` +
              `要保留这次修改，就把新 props 写回分镜表（save_storyboard 或编辑器里保存）。`;
          }
        }
      } catch {
        // 分镜表读不到就当没有，不要因为一句提醒把更新本身搞失败
      }
      return `${fmtSummary(res.summary)}\nrev=${res.project.rev}${stale}`;
    },
  },
  {
    name: "set_scene_type",
    description:
      "换场景版式（不改场景 id、不删场景，旁白元素也不会丢）。props 按同名 key 迁移：新版式认识的字段保留，不认识的丢弃，新版式缺少的必填字段用默认值补上——丢弃和补上的字段都会在返回里列明。换版式后建议 preview_frames 抽一帧看排版。",
    shape: {
      sceneId: z.string(),
      type: z.string().describe("目标版式，见 list_scene_types"),
      props: z.record(z.any()).optional().describe("迁移后额外覆盖的字段"),
      durationInFrames: z
        .number()
        .int()
        .optional()
        .describe("换版式同时改时长（帧），省一次 update_scene"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [
            {
              op: "set_scene_type",
              sceneId: a.sceneId,
              type: a.type,
              ...(a.props ? { props: a.props } : {}),
              ...(a.durationInFrames !== undefined
                ? { durationInFrames: a.durationInFrames }
                : {}),
            },
          ],
        }),
      });
      return `${res.summary.join("\n")}\nrev=${res.project.rev}`;
    },
  },
  {
    name: "set_scene_timing",
    description:
      "（已并入 update_scene：改时长就是 update_scene 的 durationInFrames 字段）单独调整某个场景的停留时长（帧）。秒数 = 帧 / 工程 fps（默认 30fps，即 30 帧 ≈ 1 秒）。",
    retiredTo: "update_scene",
    shape: { sceneId: z.string(), durationInFrames: z.number(), projectId: z.string().optional() },
    run: async (a) => {
      const target = TOOLS.find((t) => t.name === "update_scene")!;
      const out = await target.run({ sceneId: a.sceneId, durationInFrames: a.durationInFrames, projectId: a.projectId });
      return `（提示：「set_scene_timing」已并入 update_scene——改时长用它的 durationInFrames 字段，本次已按新工具执行，以后请直接用 update_scene）\n${out}`;
    },
  },
  {
    name: "move_scene",
    description:
      "把一幕放到时间轴的绝对帧 / 某条轨道上（多轨剪辑台：轨道 0 = 主轨，1 以上叠在上面，可缩成小窗做画中画）。" +
      "同轨不允许重叠，撞到别的块会自动往后吸附，实际落点写在返回值里。只改时间不改内容。",
    shape: {
      sceneId: z.string(),
      start: z.number().describe("绝对起始帧（整条时间轴，不是场景内偏移）"),
      track: z.number().optional().describe("轨道号，0=主轨；省略=保持原轨道"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [{ op: "move_scene", sceneId: a.sceneId, start: a.start, track: a.track }],
        }),
      });
      return fmtSummary(res.summary);
    },
  },
  {
    name: "set_scene_box",
    description:
      "把一幕缩成小窗（画中画）。x/y 是画面百分比、按**中心点**定位（50/50 = 正中），scale=1 是全屏、0.34 约等于三分之一大小。" +
      "配合 move_scene 把它放到别的轨道同一时间段，就得到画中画。传 reset=true 恢复全屏。",
    shape: {
      sceneId: z.string(),
      x: z.number().optional().describe("中心 x（画面百分比 0-100，默认 50）"),
      y: z.number().optional().describe("中心 y（画面百分比 0-100，默认 50）"),
      scale: z.number().optional().describe("缩放 0.05-1，1 = 全屏"),
      rotate: z.number().optional().describe("旋转角度"),
      radius: z.number().optional().describe("圆角（画面短边百分比，画中画常用 2-4）"),
      opacity: z.number().optional().describe("不透明度 0-1"),
      shadow: z.boolean().optional().describe("投影，默认开"),
      reset: z.boolean().optional().describe("true = 恢复全屏"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const box = a.reset
        ? null
        : {
            ...(a.x === undefined ? {} : { x: a.x }),
            ...(a.y === undefined ? {} : { y: a.y }),
            ...(a.scale === undefined ? {} : { scale: a.scale }),
            ...(a.rotate === undefined ? {} : { rotate: a.rotate }),
            ...(a.radius === undefined ? {} : { radius: a.radius }),
            ...(a.opacity === undefined ? {} : { opacity: a.opacity }),
            ...(a.shadow === undefined ? {} : { shadow: a.shadow }),
          };
      if (box !== null && !Object.keys(box).length) {
        throw new Error(
          "没有给出任何画面框参数（x/y/scale/radius/rotate/opacity/shadow）。要恢复全屏请传 reset:true",
        );
      }
      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops: [{ op: "set_scene_box", sceneId: a.sceneId, box }] }),
      });
      return fmtSummary(res.summary);
    },
  },
  {
    name: "set_scene_backdrop",
    description:
      "给某一幕垫一层「氛围层」：光晕 / 颗粒 / 漏光 / 散景 / 火花 / 磁带，画在**内容底下**（不是盖在上面，不会压字）。\n" +
      "和『插一幕氛围版式』的区别：插幕是单独占一段时长、播完就切；backdrop 是挂在现有这一幕下面，文字照样在、时长不变。\n" +
      "典型用法：标题页想要夜景氛围 → set_scene_backdrop(sceneId, type:'bokeh', opacity:0.8)；纪录片段落要脏一点 → type:'grain', props:{vignette:0.3}。\n" +
      "层次 place：下（默认，垫在版式下，字不受影响）/ 上（浮在画面上，但在贴纸标签之下）/ 顶（盖住所有内容，字幕除外，适合颗粒·扫描线·故障）。\n" +
      "要精确插到某个元素上下就传 z（与叠加元素 scene.elements 的 z 混排，100+z）：一张光斑压住某行字、但被某个标签盖住时用它。\n" +
      "出现区间 from / duration（帧）：不填 = 铺满整幕（默认）。填了就只在幕内某一段出现，**动画从出现那一刻从 0 开始**——第 2 秒才浮出光斑，不会看到漂到一半的中间态。\n" +
      "柔化 fadeIn / fadeOut：**不填就自动跟随这一幕的出入场转场**（区间贴幕首交给入场转场、贴幕尾交给出场转场，落在幕中间取 max(转场时长,8)），所以区间边界不会硬切。写 0 才是强制硬切；写具体帧数则覆盖自动值。\n" +
      "快慢与次数：speed 是整层时间倍率（1=原速，2=快一倍，0.5=慢一半，只改速度不改亮度数量）；mode:'once' 只走一轮后定格 —— **只有漏光说得通**（扫一次就停、光带移出画面），光晕/散景是永续漂移、颗粒/磁带逐帧随机，对它们写 once 没有可见效果。\n" +
      "限制：只有这 6 个纯氛围类型能用（打字机/数字/渐变字/乱码带正文，垫在下面会出现两套字）。一幕只能一层；传 clear:true 去掉。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      sceneId: z.string().describe("给哪一幕加（get_project 里的场景 id）"),
      type: z
        .enum(BACKDROP_TYPES)
        .optional()
        .describe("氛围类型：glow 光晕 / grain 颗粒 / lightleak 漏光 / bokeh 散景 / sparks 火花 / vhs 磁带"),
      props: z
        .record(z.any())
        .optional()
        .describe("覆盖该氛围的参数（同 insert_scene 的 props，如 {count:20, glow:0.8}）；不传用默认值"),
      opacity: z.number().min(0).max(1).optional().describe("不透明度 0–1，默认 0.8；超过 1 就抢字了"),
      place: z
        .enum(["下", "上", "顶"])
        .optional()
        .describe("层次：下=垫在版式下（默认）/ 上=浮在画面上但在贴纸下 / 顶=盖住所有内容（字幕除外）"),
      z: z
        .number()
        .int()
        .min(-50)
        .max(500)
        .optional()
        .describe("精细层级（与贴纸/文字的 z 混排，100+z）；给了就不再按 place 落位"),
      from: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("幕内第几帧开始出现，默认 0（幕首）。要「文字先出现、光斑后浮出」就填这个"),
      duration: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("持续多少帧，默认到幕尾；from+duration 不能超出幕长（超了报错，不静默截断）"),
      fadeIn: z
        .number()
        .int()
        .min(0)
        .max(120)
        .optional()
        .describe("淡入帧数。不填 = 自动跟随入场转场（区间落在幕中间时取 max(转场,8)）；写 0 = 硬切"),
      fadeOut: z
        .number()
        .int()
        .min(0)
        .max(120)
        .optional()
        .describe("淡出帧数。不填 = 自动跟随出场转场；写 0 = 硬切"),
      speed: z
        .number()
        .min(0.2)
        .max(4)
        .optional()
        .describe("整层时间倍率：1=原速 / 2=快一倍 / 0.5=慢一半；不改亮度与数量"),
      mode: z
        .enum(["loop", "once"])
        .optional()
        .describe("loop=循环（默认）/ once=只走一轮后定格（只有漏光看得出差别：扫一次就停）"),
      clear: z.boolean().optional().describe("true = 去掉这一幕的氛围层"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      if (!a.clear && !a.type) {
        throw new Error("要么给 type（加哪种氛围），要么传 clear:true（去掉现有的）");
      }
      const backdrop = a.clear
        ? null
        : {
            type: a.type,
            ...(a.props ? { props: a.props } : {}),
            ...(a.opacity === undefined ? {} : { opacity: a.opacity }),
            ...(a.place ? { place: a.place } : {}),
            ...(a.z === undefined ? {} : { z: a.z }),
            ...(a.from === undefined ? {} : { from: a.from }),
            ...(a.duration === undefined ? {} : { duration: a.duration }),
            ...(a.fadeIn === undefined ? {} : { fadeIn: a.fadeIn }),
            ...(a.fadeOut === undefined ? {} : { fadeOut: a.fadeOut }),
            ...(a.speed === undefined ? {} : { speed: a.speed }),
            ...(a.mode === undefined ? {} : { mode: a.mode }),
          };
      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops: [{ op: "set_scene_backdrop", sceneId: a.sceneId, backdrop }] }),
      });
      return fmtSummary(res.summary);
    },
  },
  {
    name: "apply_ops",
    description:
      "批量执行多个操作（一次调用完成整幕或整章的搭建，省掉几十次往返）。ops 是数组，每项 {op: 操作名, ...参数}。\n" +
      "**两种写法都认，不用记两套形状**：\n" +
      "  ① 单工具形状（扁平，直接照抄 add_element 的字段）：{op:'add_element', sceneId, text:'光晕', x:50, y:50, opacity:0.6}\n" +
      "  ② op 形状（包裹）：{op:'add_element', sceneId, element:{kind:'text', text:'光晕', x:50, y:50}}\n" +
      "  update_element 同理：{op:'update_element', sceneId, elementId, opacity:0.5} 或 {..., patch:{opacity:0.5}}。\n" +
      "可用操作：add_scene / update_scene / set_scene_timing / set_scene_type / set_scene_backdrop / set_transform / add_element / update_element / " +
      "remove_element / add_freeform_element / update_freeform_element / remove_freeform_element / reorder_freeform_elements / remove_scene / duplicate_scene / reorder_scenes / compact_main_track / move_scene / set_scene_box / set_theme / set_audio / add_audio_track / " +
      "update_audio_track / remove_audio_track / add_effect / update_effect / remove_effect / set_formats / update_project / restore。\n" +
      "freeform 场景的元素（svg 图形 / fx 氛围层 / 带 anim 关键帧的）走 add_freeform_element：" +
      "{op:'add_freeform_element', sceneId, element:{type:'svg', svg:'…', viewBox:'0 0 920 420', x:50, y:47}}，扁平字段也会自动包裹；" +
      "注意叠加层（add_element）不支持 anim 和 fx，塞了会被丢弃并在 summary 里警告。\n" +
      "批量转场用 set_transitions（复数，给全部或指定场景套同一套）：{op:'set_transitions', type:'fade', durationInFrames:12, direction:'in'}，" +
      "direction 可选 in/out/both，sceneIds 不传=全部场景。\n" +
      "重要：整批是**原子**的——任何一个操作失败，整批都不生效（不会出现改了一半的工程）。要「逐幕容错、失败的跳过其余照常」用 apply_to_scenes。" +
      "失败会明确报「第 N 个操作（op 名）失败：缺哪个字段 / 哪个值越界」。\n" +
      "**批内可以直接引用刚建出来的东西**：创建类 op 带 as:「s1」，后面的 op 用「@s1」指它 —— " +
      "一批就能「建幕 → 往里加元素 → 给元素加动画」，不用先加、再 get_project 读 id、再改。" +
      "（之前 220 次写入里至少 100 次是这么来的）\n" +
      "  例：{op:'add_scene', type:'list', as:'s1'} → {op:'add_element', sceneId:'@s1', as:'e1', element:{...}} → " +
      "{op:'update_freeform_element', sceneId:'@s1', elementId:'@e1', patch:{anim:[...]}}\n" +
      "  别名只认整串 @名字（正文里的 @ 不受影响）；回执会列出 {别名: 真实 id}。整批仍是 1 次 rev，undo 会整批回滚。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      ops: z
        .array(z.record(z.any()))
        .min(1)
        .describe("操作数组，每项形如 {op:'add_scene', type:'title', props:{...}}"),
      quiet: z.boolean().optional().describe("只回一行摘要，不列每一项（省 token）"),
    },
    run: async (a) => {
      const before = await resolveProject(a.projectId);
      const p = before;
      // 归一化：单工具形状（扁平字段）和 op 形状（element/patch 包裹）**两种写法都认**，
      // 缺字段时在这里就报出「第 N 个操作缺什么」，不用等 zod 吐一堆 JSON
      const normalized = await normalizeOps(a.ops as Record<string, unknown>[], before);
      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops: normalized }),
      });
      // 批量 add_scene / add_element 生成的 id 是随机的，这里把新增的 id 回给 agent，
      // 省掉"先加再 get_project 找 id"的往返
      const prevScenes = new Set((before.scenes ?? []).map((x: any) => x.id));
      const prevEls = new Set(
        (before.scenes ?? []).flatMap((x: any) => (x.elements ?? []).map((e: any) => e.id)),
      );
      const added: string[] = [];
      for (const sc of res.project.scenes ?? []) {
        if (!prevScenes.has(sc.id)) added.push(`场景 ${sc.id}「${sc.name ?? sc.type}」`);
        for (const el of sc.elements ?? []) {
          if (!prevEls.has(el.id)) added.push(`元素 ${el.id}「${el.name ?? ""}」`);
        }
      }
      const aliasMap = (res.createdIds ?? {}) as Record<string, string>;
      const aliasEntries = Object.entries(aliasMap);
      const aliasText = aliasEntries.length
        ? `${String.fromCharCode(10)}批内别名：${aliasEntries.map(([k, v]) => `${k} → ${v}`).join("、")}`
        : "";
      const addedText =
        (added.length ? `${String.fromCharCode(10)}新增：${added.join("、")}` : "") + aliasText;
      if (a.quiet) {
        // quiet 只压掉成功项的逐条摘要，⚠️ 警告必须保留
        const warns = (res.summary as string[]).filter((line) => line.includes("⚠"));
        const nl2 = String.fromCharCode(10);
        return (
          `已执行 ${a.ops.length} 个操作，rev=${res.project.rev}${addedText}` +
          (warns.length ? `${nl2}${warns.join(nl2)}` : "")
        );
      }
      const nl = String.fromCharCode(10);
      // 逐条列每一项，但 ⚠️ 排在最前（批量里某一项被夹取/丢弃最容易扫漏）
      const all = res.summary as string[];
      const ordered = [...all.filter((s) => s.includes("⚠")), ...all.filter((s) => !s.includes("⚠"))];
      return `已执行 ${a.ops.length} 个操作${nl}${ordered.join(nl)}${nl}rev=${res.project.rev}${addedText}`;
    },
  },
  {
    name: "reorder_scenes",
    description:
      "重排场景顺序。sceneIds 必须是全部场景 id 的完整顺序。\n" +
      "⚠️ 如果某几幕之前用 move_scene 拖过（起点被钉死），光重排**时间轴不会动**——必须带 reflow:true（清掉主轨起点、按新顺序首尾相接）。不带 reflow 而工程里有钉死幕时，回执第一行会警告「幕序其实没生效」。",
    shape: {
      sceneIds: z.array(z.string()).describe("全部场景 id 的完整顺序"),
      reflow: z
        .boolean()
        .optional()
        .describe("true = 顺手清掉主轨被 move_scene 钉死的起点（画中画所在的轨道 1+ 不受影响）；不传 = 保持老行为"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [{ op: "reorder_scenes", sceneIds: a.sceneIds, reflow: a.reflow }],
        }),
      });
      return fmtSummary(res.summary as string[]);
    },
  },
  {
    name: "reorder_freeform_elements",
    description:
      "调自由画布元素的层级（数组顺序 = 层级，靠后的盖住靠前的；没有 z-index）。\n" +
      "典型用法：红色横线要当「删除线」穿过文字 → 先把它移到文字之后（front）。\n" +
      "给 elementId（该幕 elements[].id）或 index（从 0 开始），mode=front/back/forward/backward；一批一起动传 indices。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      sceneId: z.string(),
      elementId: z.string().optional().describe("元素的 id（get_scene 的 props.elements[].id）"),
      index: z.number().int().min(0).optional().describe("没有 id 时按下标（从 0 开始）"),
      indices: z.array(z.number().int().min(0)).optional().describe("一批元素下标（一起移层）"),
      mode: z
        .enum(["front", "back", "forward", "backward"])
        .describe("front=最上层（盖住别人）/ back=最底层 / forward=上移一层 / backward=下移一层"),
    },
    run: async (a) => {
      if (!a.elementId && a.index === undefined && !a.indices?.length) {
        throw new Error("elementId / index / indices 至少给一个（哪个元素要动层级）");
      }
      const p = await resolveProject(a.projectId);
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [
            {
              op: "reorder_freeform_elements",
              sceneId: a.sceneId,
              ...(a.elementId ? { elementId: a.elementId } : {}),
              ...(a.index !== undefined ? { index: a.index } : {}),
              ...(a.indices?.length ? { indices: a.indices } : {}),
              mode: a.mode,
            },
          ],
        }),
      });
      return fmtSummary(res.summary);
    },
  },
  {
    name: "remove_scene",
    description:
      "删除一幕（连同它的元素、音频引用一起没）。sceneId 见 get_project；删错可 restore_rev 回到删除前的版本（get_history 查版本号）。",
    shape: { sceneId: z.string(), projectId: z.string().optional() },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops: [{ op: "remove_scene", sceneId: a.sceneId }] }),
      });
      return fmtSummary(res.summary);
    },
  },
  {
    name: "duplicate_scene",
    description:
      "复制一个场景（含 props），副本插在原场景之后。传 props 可只改副本的文案字段（A/B 版本：同一版式两套文案），传 name 改副本名。",
    shape: {
      sceneId: z.string(),
      props: z
        .record(z.any())
        .optional()
        .describe("覆盖副本的 props 字段（只改传的字段），如 {title:'另一个标题'}"),
      name: z.string().optional().describe("副本名"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops: [{ op: "duplicate_scene", sceneId: a.sceneId }] }),
      });
      const newId = res.createdSceneIds?.[0];
      if (!newId) throw new Error("复制失败：没有拿到副本 id");
      if (a.props || a.name) {
        await api(`/api/projects/${p.id}/ops`, {
          method: "POST",
          body: JSON.stringify({
            actor: "agent",
            ops: [
              {
                op: "update_scene",
                sceneId: newId,
                patch: {
                  ...(a.name ? { name: a.name } : {}),
                  ...(a.props ? { props: a.props } : {}),
                },
              },
            ],
          }),
        });
      }
      const changed = a.props ? "（已覆盖文案字段）" : "";
      return `副本 id=${newId}${a.name ? `「${a.name}」` : ""}${changed}`;
    },
  },
  {
    name: "set_transform",
    description:
      "拖动 / 旋转 / 缩放场景里的某个元素，也可调图层顺序。x、y 是相对画面宽高的百分比偏移（不是像素），rotate 是角度，scale 是倍数，layer 是层级（>=0，越大越靠前）；元素 id 见 list_scene_types 的「可拖动元素」。传 reset:true 恢复模板排版。",
    shape: {
      sceneId: z.string(),
      target: z.string().optional().describe("元素 id，如 title / subtitle / item1（与 elementId 二选一，都传以 target 为准）"),
      elementId: z.string().optional().describe("同 target（别名，兼容不同叫法）"),
      x: z.number().optional().describe("水平偏移（画面宽度百分比，正数向右）"),
      y: z.number().optional().describe("垂直偏移（画面高度百分比，正数向下）"),
      rotate: z.number().optional().describe("旋转角度"),
      scale: z.number().optional().describe("缩放倍数，1 为原始大小"),
      layer: z.number().int().min(0).optional().describe("图层顺序，0 为模板默认层，越大越靠前；不能为负（负值会掉到背景下面）"),
      reset: z.boolean().optional().describe("true 则清除该元素的偏移，回到模板位置"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const target = a.target ?? a.elementId;
      if (!target) {
        throw new Error(
          `缺少 target（元素 id）。注意参数名是 target 不是 elementId——不过 elementId 也认；` +
            `叠加层自由元素请改用 update_element 设 x/y/scale/rotate`,
        );
      }
      const p = await resolveProject(a.projectId);
      const patch = a.reset
        ? null
        : Object.fromEntries(
            (
              [
                ["x", a.x],
                ["y", a.y],
                ["rotate", a.rotate],
                ["scale", a.scale],
                ["z", a.layer],
              ] as const
            ).filter(([, v]) => v !== undefined),
          );
      if (patch !== null && !Object.keys(patch).length) {
        return "没有给出任何偏移量。要复位请传 reset:true。";
      }
      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [{ op: "set_transform", sceneId: a.sceneId, target, transform: patch }],
        }),
      });
      return res.summary?.join("；") ?? "已更新元素位置";
    },
  },
  {
    name: "set_transition",
    description:
      "（已并入 set_transitions：单幕/批量/逐幕统一用它）设置场景的入场或出场转场。direction 默认 in；type 可选 none / fade / slide / wipe / zoom / blur / flip / circle / blinds / flash / glitch / diagonal；duration 不传默认 12 帧，建议 8–20 帧。",
    retiredTo: "set_transitions",
    shape: {
      sceneId: z.string().describe("给哪一幕设转场（get_project 里的场景 id）"),
      type: z.enum(TRANSITION_TYPES).describe("转场类型（可选值见描述）"),
      durationInFrames: z.number().optional().describe("转场时长（帧），不传默认 12，建议 8–20"),
      direction: z.enum(["in", "out"]).optional().describe("in=入场（默认），out=出场"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const target = TOOLS.find((t) => t.name === "set_transitions")!;
      const out = await target.run({ ...a, sceneIds: [a.sceneId] });
      return `（提示：「set_transition」已并入 set_transitions——单幕/批量/逐幕都是它，本次已按新工具执行，以后请直接用 set_transitions）\n${out}`;
    },
  },
  {
    name: "set_transitions",
    description:
      "批量设置转场：① 套同一套（给全部或指定场景）② **逐幕指定，每幕不同类型**（items:[{sceneId,in,out}]）。" +
      "direction=both 时入出场都设；type=none 清除该方向的转场。\n" +
      "文字密集的幕建议只用 硬切 / blur / 短 fade：circle/wipe/flip 在文字页容易显脏（不是不能，是不划算）。",
    shape: {
      type: z.enum(TRANSITION_TYPES).optional().describe("转场类型；none=清除（给了 items 时可省略）"),
      durationInFrames: z.number().int().min(0).max(120).optional().describe("转场时长（帧），默认 12"),
      direction: z.enum(["in", "out", "both"]).optional().describe("in=入场（默认），out=出场，both=两者都设"),
      sceneIds: z.array(z.string()).optional().describe("只设这些场景；不传=全部场景"),
      items: z
        .array(
          z.object({
            sceneId: z.string(),
            in: z
              .object({ type: z.enum(TRANSITION_TYPES), durationInFrames: z.number().int().min(0).max(120) })
              .nullable()
              .optional()
              .describe("这一幕的入场（null = 清除）"),
            out: z
              .object({ type: z.enum(TRANSITION_TYPES), durationInFrames: z.number().int().min(0).max(120) })
              .nullable()
              .optional()
              .describe("这一幕的出场（null = 清除）"),
          }),
        )
        .optional()
        .describe("逐幕指定（每幕可以不同类型）：传了这个就忽略 type/direction/sceneIds"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      if (!p.scenes.length) throw new Error("工程里还没有场景");

      // 逐幕指定：每幕转场都不一样时，以前要按幕数逐次调用
      type TransitionItem = {
        sceneId: string;
        in?: { type: string; durationInFrames: number } | null;
        out?: { type: string; durationInFrames: number } | null;
      };
      const items = (a.items ?? []) as TransitionItem[];
      if (items.length) {
        const known = new Set(p.scenes.map((s) => s.id));
        const unknown = items.map((x) => x.sceneId).filter((id) => !known.has(id));
        if (unknown.length) throw new Error(`找不到场景：${unknown.join("、")}`);
        const ops = items.map((x) => {
          const patch: Record<string, unknown> = {};
          if (x.in !== undefined) patch.transitionIn = x.in;
          if (x.out !== undefined) patch.transitionOut = x.out;
          if (!Object.keys(patch).length) {
            throw new Error(`场景 ${x.sceneId} 既没给 in 也没给 out`);
          }
          return { op: "update_scene", sceneId: x.sceneId, patch };
        });
        const res = await api<any>(`/api/projects/${p.id}/ops`, {
          method: "POST",
          body: JSON.stringify({ actor: "agent", ops }),
        });
        const desc = items
          .map((x) => {
            const i = x.in ? `${x.in.type} ${x.in.durationInFrames}f` : x.in === null ? "清除" : "—";
            const o = x.out ? `${x.out.type} ${x.out.durationInFrames}f` : x.out === null ? "清除" : "—";
            return `${x.sceneId} 入 ${i} / 出 ${o}`;
          })
          .join("；");
        return `已逐幕设置 ${items.length} 个场景的转场（${desc}），rev=${res.project.rev}`;
      }

      if (!a.type) throw new Error("要么给 type（统一套），要么给 items（逐幕指定）");
      const t = a.type === "none" ? null : { type: a.type, durationInFrames: a.durationInFrames ?? TRANSITION_DEFAULT_FRAMES };
      const dir = a.direction ?? "in";
      const patch =
        dir === "out"
          ? { transitionOut: t }
          : dir === "both"
            ? { transitionIn: t, transitionOut: t }
            : { transitionIn: t };
      const ids: string[] = a.sceneIds?.length ? a.sceneIds : p.scenes.map((s) => s.id);
      const known = new Set(p.scenes.map((s) => s.id));
      const unknown = ids.filter((id) => !known.has(id));
      if (unknown.length) throw new Error(`找不到场景：${unknown.join("、")}`);
      const ops = ids.map((sceneId) => ({ op: "update_scene", sceneId, patch }));
      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops }),
      });
      const dirLabel = dir === "out" ? "出场" : dir === "both" ? "入/出场" : "入场";
      const what = a.type === "none" ? "清除" : `${a.type} ${a.durationInFrames ?? TRANSITION_DEFAULT_FRAMES} 帧`;
      return `已给 ${ids.length} 个场景设置${dirLabel}转场（${what}），rev=${res.project.rev}`;
    },
  },
  {
    name: "set_audio",
    description:
      `设置或调整背景音乐。src 用 /assets/xxx.mp3 或公网 URL；**volume 0-${MAX_VOLUME}（1 = 原音，>1 是放大，上限约 +14 dB）**；` +
      "fadeIn/fadeOut 单位秒；from 为起始帧、durationInFrames 为播放长度（帧）、loop 循环。" +
      "**只传要改的字段即可**（其余沿用现有值）；首次设置默认原音直出（volume=1，不淡入淡出）。ducking 做人声避让：有人说话时自动把 BGM 压下去。清除背景音乐用 clear=true。\n" +
      "放大到会削波时会在回执里警告（读了文件峰值算的），别忽略。",
    shape: {
      src: z
        .string()
        .optional()
        .describe("音频地址：/assets/xxx.mp3（先 upload_asset 上传）或公网 URL；清除背景音乐用 clear=true，不用传 src"),
      volume: z.number().min(0).max(MAX_VOLUME).optional().describe("音量：1 = 原音，可到 5（+14 dB）"),
      fadeIn: z.number().optional().describe("淡入时长（秒）"),
      fadeOut: z.number().optional().describe("淡出时长（秒）"),
      from: z.number().int().min(0).optional().describe("从第几帧开始播"),
      durationInFrames: z.number().int().min(1).optional().describe("播放长度（帧），不传=到片尾"),
      loop: z.boolean().optional().describe("是否循环"),
      ducking: z
        .union([
          z.boolean(),
          z.object({
            enabled: z.boolean().optional(),
            depth: z.number().min(0).max(1).optional().describe("人声期间 BGM 降到原音量的倍数，0.3 = 30%"),
            attackMs: z.number().min(0).optional().describe("压下去用多久（毫秒，默认 120）"),
            releaseMs: z.number().min(0).optional().describe("升回来用多久（毫秒，默认 260）"),
            padMs: z.number().min(0).optional().describe("人声区间前后余量（毫秒，默认 60）"),
          }),
        ])
        .optional()
        .describe("人声避让：true=开启（30%）、false=关闭、对象=细化参数。不传则保持现状"),
      clear: z.boolean().optional().describe("true = 移除背景音乐（用了它就不需要 src）"),
      clearGainCurve: z.boolean().optional().describe("true = 清掉压缩曲线（恢复原始动态）"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      if (a.clear) {
        const res = await api<any>(`/api/projects/${p.id}/ops`, {
          method: "POST",
          body: JSON.stringify({ actor: "agent", ops: [{ op: "set_audio", audio: null }] }),
        });
        return fmtSummary(res.summary);
      }

      // 只改一部分字段时，其余沿用现有音频 —— 否则"只调音量"会把 fadeIn/loop/避让全部打回默认
      const prev = p.audio;
      const src = a.src ?? prev?.src;
      if (!src) throw new Error("还没有背景音乐：第一次设置需要传 src（/assets/xxx.mp3）");

      const prevDuck = prev?.ducking;
      let ducking: typeof prevDuck;
      if (a.ducking === false) ducking = { ...(prevDuck ?? DEFAULT_DUCKING), enabled: false };
      else if (a.ducking === true) ducking = { ...(prevDuck ?? DEFAULT_DUCKING), enabled: true };
      else if (a.ducking && typeof a.ducking === "object")
        // 传了细化参数 = 明确要用避让。以前只合并、不置 enabled，
        // 上次若关着就会「传了深度却回执说已关闭」（复盘问题 17）
        ducking = { ...(prevDuck ?? DEFAULT_DUCKING), ...a.ducking, enabled: (a.ducking as { enabled?: boolean }).enabled ?? true };
      else ducking = prevDuck; // 没提避让就保持现状（set_audio 是全量替换，漏带会丢配置）

      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [
            {
              op: "set_audio",
              audio: {
                src,
              // 首次设置默认原音直出（1/0/0）：描述承诺「1 = 原音」，静默落 0.8 会让用户
              // 觉得「音质变闷了」却查不到原因。已有 BGM 时沿用现有值不动。
              volume: a.volume ?? prev?.volume ?? 1,
              fadeIn: a.fadeIn ?? prev?.fadeIn ?? 0,
              fadeOut: a.fadeOut ?? prev?.fadeOut ?? 0,
                from: a.from ?? prev?.from ?? 0,
                ...(a.durationInFrames !== undefined || prev?.durationInFrames
                  ? { durationInFrames: a.durationInFrames ?? prev?.durationInFrames }
                  : {}),
                loop: a.loop ?? prev?.loop ?? false,
                ...(ducking ? { ducking } : {}),
                // 压缩曲线默认保留：只调音量不该把 compress_audio 的成果抹掉
                ...(!a.clearGainCurve && prev?.gainCurve ? { gainCurve: prev.gainCurve } : {}),
              },
            },
          ],
        }),
      });
      const lines = [fmtSummary(res.summary)];
      const vol = a.volume ?? prev?.volume ?? 0.8;
      const warn = await clipWarning(src, vol);
      if (warn) lines.push(warn);

      // 有效响度自检：volume × ducking.depth 是连乘，两个都压低就等于没声
      // （复盘里用户说「完全听不到 bgm」：0.43 × 0.3 × 压缩 0.51 ≈ 6.6%）
      {
        const depth = ducking?.enabled === false ? 1 : Number(ducking?.depth ?? DEFAULT_DUCKING.depth ?? 0.6);
        const effective = vol * depth;
        if (effective < 0.25) {
          lines.push(
            `⚠️ 口播期间 BGM 只剩约 ${Math.round(effective * 100)}%（音量 ${vol} × 避让 ${depth}）——` +
              `人声一旦开口就会像"没音乐"。要么把 volume 抬到 ${Math.min(2, Math.round((0.3 / Math.max(0.05, depth)) * 100) / 100)}，` +
              `要么把 ducking.depth 调到 0.6–0.7`,
          );
        }
      }
      return lines.join(String.fromCharCode(10));
    },
  },
  {
    name: "balance_audio",
    description:
      "**响度配平**：把工程里的音频按角色拉到统一响度，解决「这段声音大、那段声音小」。\n" +
      "角色目标默认：人声（场景内音频元素）-16 LUFS、BGM -23、音效轨 -18；可覆盖。\n" +
      "会读每个源文件的真实响度（LUFS）与峰值，算出增益写回 volume（1 = 原音，可到 5×）。\n" +
      "峰值被限制在 -1dBFS 以下 —— **宁可小声也不爆音**，被峰值卡住时回执会写原因。\n" +
      "dryRun=true 只给方案不落库。配平只看整段平均响度；段内忽大忽小用 compress_audio。",
    shape: {
      scope: z
        .enum(["all", "bgm", "tracks", "elements"])
        .optional()
        .describe("范围：all（默认）/ bgm / tracks（音效轨）/ elements（场景内音频，通常是人声）"),
      voiceLufs: z.number().min(-40).max(-5).optional().describe("人声目标响度（默认 -16）"),
      bgmLufs: z.number().min(-40).max(-5).optional().describe("BGM 目标响度（默认 -23）"),
      sfxLufs: z.number().min(-40).max(-5).optional().describe("音效目标响度（默认 -18）"),
      maxGain: z.number().min(1).max(MAX_VOLUME).optional().describe(`最大放大倍数（默认 ${MAX_VOLUME}）`),
      peakCeilingDb: z.number().max(0).optional().describe("峰值上限 dBFS（默认 -1）"),
      dryRun: z.boolean().optional().describe("true = 只输出方案，不写工程"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const scope = a.scope ?? "all";
      const targets: Record<Role, number> = {
        voice: a.voiceLufs ?? -16,
        bgm: a.bgmLufs ?? -23,
        sfx: a.sfxLufs ?? -18,
      };
      const entries = collectAudioEntries(p, scope);
      if (!entries.length) return `这个工程没有可配平的音频（scope=${scope}）。`;

      // 逐个测：mp3 解码器是有状态单例，并发会串音
      const measured = new Map<string, LoudnessLite | null>();
      for (const e of entries) {
        if (!measured.has(e.src)) measured.set(e.src, await loudnessOf(e.src));
      }

      const rows: string[] = [];
      const ops: Record<string, unknown>[] = [];
      let peakLimited = 0;
      for (const e of entries) {
        const info = measured.get(e.src) ?? null;
        if (!info || !Number.isFinite(info.lufs)) {
          rows.push(`· ${e.label}：读不出响度（公网 URL / 格式不支持），保持原样`);
          continue;
        }
        const d = gainForTarget({
          lufs: info.lufs,
          peakDb: info.peakDb,
          targetLufs: targets[e.role],
          peakCeilingDb: a.peakCeilingDb,
          maxGain: a.maxGain,
        });
        if (d.limitedBy !== "target") peakLimited++;
        const note =
          d.limitedBy === "peak"
            ? `（**峰值限制**：到目标要 ${d.rawGain.toFixed(2)}×，但会超过峰值上限）`
            : d.limitedBy === "max"
              ? `（已到上限 ${MAX_VOLUME}×）`
              : "";
        rows.push(
          `· ${e.label}：${info.lufs} LUFS（峰值 ${info.peakDb}dBFS）→ 目标 ${targets[e.role]}` +
            `，音量 ${Math.round(e.current * 100)}% → ${Math.round(d.gain * 100)}%${note}`,
        );
        if (a.dryRun) continue;
        if (e.kind === "bgm") {
          const cur = p.audio!;
          ops.push({
            op: "set_audio",
            audio: {
              src: cur.src,
              volume: d.gain,
              fadeIn: cur.fadeIn ?? 0,
              fadeOut: cur.fadeOut ?? 0,
              from: cur.from ?? 0,
              ...(cur.durationInFrames ? { durationInFrames: cur.durationInFrames } : {}),
              loop: !!cur.loop,
              ...(cur.ducking ? { ducking: cur.ducking } : {}),
              ...(cur.gainCurve ? { gainCurve: cur.gainCurve } : {}),
            },
          });
        } else if (e.kind === "track") {
          ops.push({ op: "update_audio_track", trackId: e.id, patch: { volume: d.gain } });
        } else {
          ops.push({ op: "update_element", sceneId: e.sceneId, elementId: e.id, patch: { audioVolume: d.gain } });
        }
      }

      const head = a.dryRun ? "配平方案（dryRun，未落库）：" : `已配平 ${ops.length} 处音频：`;
      const tail = peakLimited
        ? `\n有 ${peakLimited} 处被峰值卡住（没到目标响度）。要更响只能换更高质量的源文件，或接受削波（不推荐）。`
        : "";
      if (a.dryRun || !ops.length) return [head, ...rows].join(String.fromCharCode(10)) + tail;

      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops }),
      });
      return [head, ...rows, "", fmtSummary(res.summary)].join(String.fromCharCode(10)) + tail;
    },
  },
  {
    name: "compress_audio",
    description:
      "**段内动态压缩**：解决「同一段音频里前面轻、后面响」，把音量起伏压平（BGM 副歌炸、口播忽大忽小）。\n" +
      "做法：按 200ms 测短时响度 → 生成增益曲线存进工程（`gainCurve`）→ 渲染时按帧相乘。\n" +
      "ratio 越大压得越狠（1 = 只做整体增益不压动态，默认 3）。注意补与压是耦合的：ratio 变大时整体增益也会跟着抬。" +
      "曲线会按每个采样点的峰值限幅（输出 ≤ -1dBFS），被夹住多少会写进回执。\n" +
      "只作用于 BGM 与音效轨（元素级用 balance_audio 配平）。clear=true 清掉曲线恢复原始动态。",
    shape: {
      scope: z.enum(["bgm", "tracks", "all"]).optional().describe("作用范围（默认 bgm）"),
      trackId: z.string().optional().describe("scope=tracks 时只处理这一条（不传 = 全部音效轨）"),
      targetLufs: z.number().min(-40).max(-5).optional().describe("目标响度（默认 BGM -23 / 音效 -18）"),
      ratio: z.number().min(1).max(10).optional().describe("压缩比，默认 3；1 = 不压动态"),
      maxGainDb: z.number().min(0).max(24).optional().describe("最多向上补多少 dB（默认 12）"),
      maxCutDb: z.number().min(0).max(24).optional().describe("最多向下压多少 dB（默认 12）"),
      clear: z.boolean().optional().describe("true = 清除增益曲线"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const scope = a.scope ?? "bgm";
      const rows: string[] = [];
      const ops: Record<string, unknown>[] = [];

      const targets: { kind: "bgm" | "track"; id?: string; label: string; src: string; target: number }[] = [];
      if ((scope === "bgm" || scope === "all") && p.audio?.src) {
        targets.push({ kind: "bgm", label: "背景音乐", src: p.audio.src, target: a.targetLufs ?? -23 });
      }
      if (scope === "tracks" || scope === "all") {
        for (const t of p.audioTracks ?? []) {
          if (a.trackId && t.id !== a.trackId) continue;
          targets.push({ kind: "track", id: t.id, label: `音效「${t.name}」`, src: t.src, target: a.targetLufs ?? -18 });
        }
      }
      if (!targets.length) return `没有可压缩的音频（scope=${scope}${a.trackId ? `, trackId=${a.trackId}` : ""}）。`;

      for (const t of targets) {
        if (a.clear) {
          if (t.kind === "bgm") {
            const cur = p.audio!;
            // set_audio 现在是**合并**语义：只传 src + gainCurve:null 就够，其余配置原样留着
            ops.push({ op: "set_audio", audio: { src: cur.src, gainCurve: null } });
          } else {
            ops.push({ op: "update_audio_track", trackId: t.id, patch: { gainCurve: null } });
          }
          rows.push(`· ${t.label}：已清除增益曲线`);
          continue;
        }

        const info = await loudnessOf(t.src);
        if (!info || !info.curve?.length) {
          rows.push(`· ${t.label}：读不出响度曲线，跳过`);
          continue;
        }
        const built = buildCompressCurve(info.curve, {
          targetLufs: t.target,
          ratio: a.ratio,
          maxGainDb: a.maxGainDb,
          maxCutDb: a.maxCutDb,
          maxGain: MAX_VOLUME,
          peakDbCurve: info.peakCurve,
        });
        const values = built.values;
        const st = summarizeCurve(values);
        const curve = {
          stepMs: info.stepMs,
          values,
          targetLufs: t.target,
          ratio: a.ratio ?? 3,
        };
        if (t.kind === "bgm") {
          const cur = p.audio!;
          ops.push({ op: "set_audio", audio: { src: cur.src, gainCurve: curve } });
        } else {
          ops.push({ op: "update_audio_track", trackId: t.id, patch: { gainCurve: curve } });
        }
        rows.push(
          `· ${t.label}：原始 ${info.lufs} LUFS → 目标 ${t.target}，` +
            `增益 ${Math.round(st.min * 100)}%–${Math.round(st.max * 100)}%（均值 ${Math.round(st.avg * 100)}%），` +
            `${values.length} 个采样点 @${info.stepMs}ms`,
        );
        // 夹取必须写进回执（N-13 的原则）：否则用户只会觉得「调了 ratio 没反应」
        if (built.peakLimited) {
          rows.push(
            `  ⚠ ${built.peakLimited} 个采样点被峰值卡住（输出不超过 -1dBFS，素材峰值 ${info.peakDb}dBFS）：` +
              `这些点没补到目标，再抬就削波了`,
          );
        }
        if (built.cutLimited) {
          rows.push(
            `  ⚠ ${built.cutLimited} 个采样点已压到 maxCutDb（${a.maxCutDb ?? 12}dB）下限，` +
              `ratio 再大也不会更平；想更平请调大 maxCutDb`,
          );
        }
        if (built.gainLimited) {
          rows.push(
            `  ⚠ ${built.gainLimited} 个采样点已补到 maxGainDb（${a.maxGainDb ?? 12}dB）上限，再补要调大 maxGainDb`,
          );
        }
      }

      if (!ops.length) return rows.join(String.fromCharCode(10));
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops }),
      });
      const advice = a.clear
        ? ""
        : "\n提示：压缩只改**起伏**，不改整段平均响度；但补与压是耦合的——ratio 越大，整体增益也会跟着抬（实测同一条素材 1→3→10 时均值 69%→119%→167%）。" +
          "整体偏小请先用 balance_audio 定基调，再用这个压动态。";
      return [rows.join(String.fromCharCode(10)), "", fmtSummary(res.summary)].join(String.fromCharCode(10)) + advice;
    },
  },
  {
    name: "analyze_audio",
    description:
      "分析音频的 BPM 与拍点（卡点用）。src 给 /assets/xxx.mp3 或 wav；返回 BPM、置信度、拍点帧号。\n" +
      "**置信度 < 2.5 表示检测不可信**（纯人声/无鼓/氛围音乐），这时别自动卡点，直接问用户 BPM 再用 set_beat_grid。\n" +
      "save=true 会把结果写进工程的节拍网格（之后 get_project 能看到）。只解析 wav/mp3。",
    shape: {
      src: z.string().optional().describe("音频地址，如 /assets/bgm.mp3（list_assets 里查）"),
      assetId: z.string().optional().describe("素材库条目 id，与 src 二选一"),
      maxSeconds: z.number().optional().describe("只分析前 N 秒（默认 90）——BPM 全曲一致，长音频没必要全扫"),
      save: z.boolean().optional().describe("true = 结果写入工程节拍网格"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      let src = a.src;
      if (!src && a.assetId) {
        const { items } = await api<{ items: { id: string; url: string; name: string }[] }>("/api/library");
        // 带不带 asset: 前缀都认（upload_asset 回执写的是带前缀的形式）
        const want = toAssetId(a.assetId);
        const hit = items.find((x) => toAssetId(x.id) === want);
        if (!hit) throw new Error(`素材库里没有 ${a.assetId}（用 list_assets 查）`);
        src = hit.url;
      }
      if (!src) throw new Error("需要传 src 或 assetId（音频要在 public/assets 里）");

      const nl = String.fromCharCode(10);
      // 响度先测：它对人声/纯音乐都有意义，而 BPM 对无鼓素材本来就测不出来
      const loud = await loudnessOf(src);
      const loudLine = loud
        ? `响度：${loud.lufs} LUFS（峰值 ${loud.peakDb}dBFS，RMS ${loud.rmsDb}dBFS，${loud.durationSec.toFixed(1)}s）` +
          `　配平参考：人声 -16 / BGM -23 / 音效 -18 LUFS`
        : null;

      // 走服务端算：essentia 的 WASM 只在服务进程加载一次，代理进程保持轻量
      let r: Awaited<ReturnType<typeof analyzeBeats>>;
      try {
        r = (
          await api<{ result: Awaited<ReturnType<typeof analyzeBeats>> }>("/api/audio/analyze", {
            method: "POST",
            body: JSON.stringify({ src, maxSeconds: a.maxSeconds, fps: p.fps }),
          })
        ).result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return [loudLine, `BPM/拍点检测失败：${msg}`, "（响度仍然可用：配平用 balance_audio，手动 BPM 用 set_beat_grid）"]
          .filter(Boolean)
          .join(nl);
      }
      const reliable = r.confidence >= BEAT_CONFIDENCE_MIN;
      const beatsPreview = r.beatsFrames.slice(0, 16);
      const lines = [
        `「${src}」 ${r.durationSec.toFixed(2)}s（分析了前 ${r.analyzedSec.toFixed(1)}s）${r.cached ? " · 命中缓存" : ""}`,
        `BPM：${r.bpm}　置信度：${r.confidence}（${reliable ? "可信" : `低于 ${BEAT_CONFIDENCE_MIN}，不可信`}）`,
        `拍点 ${r.beats.length} 个（帧）：${beatsPreview.join(", ")}${r.beats.length > beatsPreview.length ? " …" : ""}`,
      ];
      if (loudLine) lines.splice(1, 0, loudLine);
      if (!reliable) {
        lines.push(
          "⚠️ 这段音频没有清晰的鼓点，BPM 不可信。**不要拿它自动卡点** —— 问用户这首歌的 BPM，" +
            `再用 set_beat_grid(bpm=...) 手动建网格。`,
        );
      } else {
        lines.push(
          "下一步：把转场/特效对齐到拍点，例如 set_transitions(durationInFrames 落在拍点附近)、" +
            "或 add_effect(from=拍点帧)。要固定这套网格就再调一次 save=true。",
        );
      }
      if (a.save && reliable) {
        const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
          method: "POST",
          body: JSON.stringify({
            actor: "agent",
            ops: [
              {
                op: "set_beat_grid",
                grid: {
                  bpm: r.bpm,
                  offsetSec: Math.round((r.beats[0] ?? 0) * 1000) / 1000,
                  source: "auto",
                  src,
                  confidence: r.confidence,
                },
              },
            ],
          }),
        });
        lines.push(fmtSummary(res.summary));
      } else if (a.save && !reliable) {
        lines.push(
          "⚠️ 你传了 save=true 但置信度不足：**节拍网格没有写入**（防止把不可信的 BPM 固化进工程）。" +
            "确需落库：问用户要 BPM 后用 set_beat_grid(bpm=..., source=\"manual\") 手动建网格。",
        );
      }
      return lines.join(nl);
    },
  },
  {
    name: "set_beat_grid",
    description:
      "手动设置节拍网格（用户告诉你 BPM 时用这个，比自动检测可靠）。存 BPM + 首拍偏移，拍点由它们现算。\n" +
      "之后用 get_project 能看到 beatGrid；对齐转场/特效时按这个 BPM 算帧号。clear=true 清除。",
    shape: {
      bpm: z.number().min(20).max(300).optional().describe("每分钟拍数"),
      offsetSec: z.number().optional().describe("第一拍在片头的第几秒（默认 0；第一拍在片头之前可给负数）"),
      clear: z.boolean().optional().describe("true = 清除节拍网格"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const total = totalDuration(p as never);
      if (a.clear) {
        const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
          method: "POST",
          body: JSON.stringify({ actor: "agent", ops: [{ op: "set_beat_grid", grid: null }] }),
        });
        return fmtSummary(res.summary);
      }
      if (a.bpm === undefined) throw new Error("需要传 bpm（或用 clear=true 清除）");
      const grid = { bpm: a.bpm, offsetSec: a.offsetSec ?? 0, source: "manual" as const };
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops: [{ op: "set_beat_grid", grid }] }),
      });
      const frames = beatFrames(grid, total / p.fps, p.fps);
      const nl = String.fromCharCode(10);
      return (
        fmtSummary(res.summary) +
        `${nl}全片 ${frames.length} 拍，前 12 拍帧号：${frames.slice(0, 12).join(", ")}` +
        `${nl}用法：转场/特效的 from 对着这些帧号放，就是卡点。`
      );
    },
  },
  {
    name: "tts_check",
    description:
      "语音服务预检。默认只探连通性（快）；deep=true 会真合成一句极短语音，验证 key/model/voice/format 全对（约 1–3 秒，产物不留）。\n" +
      "**开工做配音之前先调它**，比跑到第 6 步才发现服务没启动便宜得多。",
    shape: {
      deep: z.boolean().optional().describe("true = 连真合成一起验"),
    },
    run: async (a) => {
      // 失败时也要拿到 stage（api() 只抛 error 文本），所以这里自己发请求
      await ensureServer();
      const res = await fetch(`${BASE}/api/tts/check`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deep: !!a.deep }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, any>;
      const nl = String.fromCharCode(10);
      if (!data.ok) {
        const stageTip: Record<string, string> = {
          config: "配置问题：用 get_tts_config 看当前地址，set_tts_config 改",
          reach: "服务没起来：先把本地 TTS 服务拉起来再重试",
          synth: "服务在跑但合成失败：多半是 model / voice / format 名字不对，或用 set_tts_config 检查 apiKey",
        };
        return (
          `❌ 预检失败（阶段：${data.stage}）${nl}${data.error}` +
          (stageTip[data.stage] ? `${nl}建议：${stageTip[data.stage]}` : "")
        );
      }
      if (data.stage === "reach") {
        return (
          `✅ 服务可达：${data.origin}（HEAD ${data.status}，${data.reachMs}ms）${nl}` +
          `${data.detail}${nl}要确认配置真的对，再调一次 deep=true。`
        );
      }
      return (
        `✅ 语音服务可用（完整链路）${nl}` +
        `地址：${data.origin}　连通 ${data.reachMs}ms　合成 ${data.synthMs}ms${nl}` +
        `音色：${data.voice ?? "默认"}　模型：${data.model ?? "默认"}　产出 ${data.bytes} 字节 ${data.format}（预检文件已清理）`
      );
    },
  },
  {
    name: "add_audio_track",
    description:
      "叠加一条音效轨（背景音乐之外）：转场音、提示音、口播点缀。src 用 /assets/xxx（先 upload_asset 传音频），from 是从第几帧开始。",
    shape: {
      src: z.string().describe("/assets/xxx 音频地址"),
      name: z.string().optional().describe("音效名，默认「音效」"),
      from: z.number().int().min(0).optional().describe("从第几帧开始，默认 0"),
      volume: z.number().min(0).max(MAX_VOLUME).optional().describe("音量：1 = 原音，可到 5（+14 dB）"),
      fadeIn: z.number().min(0).optional().describe("淡入秒数"),
      durationInFrames: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("音效轨长度（帧），不传按素材真实时长"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const clip: Record<string, unknown> = { src: a.src };
      if (a.name !== undefined) clip.name = a.name;
      if (a.from !== undefined) clip.from = a.from;
      if (a.volume !== undefined) clip.volume = a.volume;
      if (a.fadeIn !== undefined) clip.fadeIn = a.fadeIn;
      const trackFrames =
        a.durationInFrames ?? (await probedDurationFrames(a.src, p.fps ?? 30));
      if (trackFrames) clip.durationInFrames = trackFrames;
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops: [{ op: "add_audio_track", clip }] }),
      });
      return fmtSummary(res.summary);
    },
  },
  {
    name: "update_audio_track",
    description: "修改某条音效轨的起点 / 音量 / 淡入 / 名称。trackId 见 get_project 里的音效轨列表。",
    shape: {
      trackId: z.string().describe("要改哪条音效轨（get_project 的音效轨列表 / add_audio_track 回执）"),
      from: z.number().int().min(0).optional().describe("从全片第几帧开始播"),
      volume: z.number().min(0).max(MAX_VOLUME).optional().describe("音量：1 = 原音，可到 5（+14 dB）"),
      fadeIn: z.number().min(0).optional().describe("淡入时长（秒）"),
      name: z.string().optional().describe("改名（方便后续指认）"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const patch: Record<string, unknown> = {};
      for (const k of ["from", "volume", "fadeIn", "name"] as const) {
        if (a[k] !== undefined) patch[k] = a[k];
      }
      if (!Object.keys(patch).length) throw new Error("没有任何要改的字段");
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops: [{ op: "update_audio_track", trackId: a.trackId, patch }] }),
      });
      return fmtSummary(res.summary);
    },
  },
  {
    name: "remove_audio_track",
    description:
      "删除一条音效轨（背景音乐不受影响）。trackId 见 get_project 里的音效轨列表 / add_audio_track 回执；删错可 restore_rev 回滚。",
    shape: { trackId: z.string(), projectId: z.string().optional() },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops: [{ op: "remove_audio_track", trackId: a.trackId }] }),
      });
      return fmtSummary(res.summary);
    },
  },
  {
    name: "list_effect_types",
    description:
      "列出所有特效类型 + 每种类型**可调参数**（键名 / 范围 / 默认值），以及自定义特效的关键帧 DSL。" +
      "调 add_effect / update_effect 之前先看一遍，比猜参数名快得多。" +
      "想做出内置特效做不出的效果（多段节奏、先拉远再急推、边闪边推…）就用 kind=custom 传 custom.keys。",
    shape: {
      kind: z.string().optional().describe("只看某一种类型（如 shake）；不传则全部"),
    },
    run: async (a) => {
      await ensureServer();
      const lines: string[] = [];
      for (const o of EFFECT_OPTIONS) {
        if (a.kind && o.key !== a.kind) continue;
        lines.push(`【${o.key}】${o.label} — ${o.hint}（默认 ${o.defaultDuration} 帧）`);
        const ps = effectParamsOf(o.key);
        if (!ps.length) {
          lines.push("  参数：无（用 custom.keys 自定义关键帧）");
        } else {
          lines.push(
            "  参数：" +
              ps
                .map(
                  (p) =>
                    `${p.key}（${p.label} ${p.min}~${p.max}${p.unit ?? ""}，默认 ${p.def}${p.hint ? `，${p.hint}` : ""}）`,
                )
                .join("；"),
          );
        }
      }
      if (!a.kind || a.kind === "custom") {
        lines.push(
          "【custom 关键帧 DSL】custom.keys = 关键帧数组（1~32 个，不必排序）：",
          "  每个关键帧：{ p: 0~1（区间内进度，不是帧号）, ease?: " +
            CUSTOM_EASES.join("|") +
            ", x?, y?（画面百分比）, scale?（1=原样）, rotate?, skewX?, opacity?," +
            " blur?（px）, brightness?, contrast?, saturate?（1=原样）, grayscale?（0~1）, hueRotate?," +
            " overlay?（颜色 hex）, overlayOpacity?, overlayBlend?（screen/overlay/multiply…） }",
          "  可省略的通道 = 中性值（位移 0 / 缩放 1 / 不透明 1）。intensity 会让所有通道朝中性值收拢，0 = 画面原样。",
          "  例：闪白 + 同时放大 → keys:[{p:0,overlayOpacity:0,scale:1},{p:0.35,overlay:'#FFFFFF',overlayOpacity:0.85,scale:1.12,ease:'out'},{p:1,overlayOpacity:0,scale:1.04}]",
          `  进度曲线 curve 可选：${EFFECT_CURVES.map((c) => `${c}（${EFFECT_CURVE_LABEL[c]}）`).join("、")}`,
        );
      }
      return lines.join("\n");
    },
  },
  {
    name: "add_effect",
    description:
      "加一条**特效轨**：叠加在整幅画面上的区间特效，可以横跨多幕 —— 适合卡点、强调、气氛。" +
      `可选类型：${EFFECT_OPTIONS.map((o) => `${o.key}（${o.label}：${o.hint}）`).join("、")}。` +
      "内置类型可以通过 params 微调手感（键名见 list_effect_types）；" +
      "内置做不出来的效果就用 kind=custom + custom.keys 自己写关键帧。" +
      "from 是画面帧号，intensity 0-1（闪白建议 0.6）。" +
      "长片上想要周期性效果（暗角/呼吸/频闪）就开循环：loop=true + loopDurationInFrames（单次循环帧数）+" +
      "loopStopAfterSeconds（循环多少秒后自动完全退出，不传=循环到区间结束）。" +
      "要精确对准某一幕的中间，先 get_project 看场景的 start/时长。",
    shape: {
      kind: z.enum(EFFECT_TYPES).describe("特效类型"),
      from: z.number().int().min(0).describe("从第几帧开始"),
      durationInFrames: z.number().int().min(1).optional().describe("长度（帧），默认按类型给（16~54）"),
      intensity: z.number().min(0).max(1).optional().describe("强度 0-1"),
      color: z.string().optional().describe("覆盖层颜色 hex（闪白/扫光/暗角这类才有意义）"),
      params: z
        .record(z.number())
        .optional()
        .describe("内置特效参数，如 {amp:3, freqX:24, decay:0.6}；键名与范围见 list_effect_types"),
      curve: z.enum(EFFECT_CURVES).optional().describe("进度曲线：linear/out/in/inOut"),
      loop: z.boolean().optional().describe("循环播放：在区间内按单次循环反复播放"),
      loopDurationInFrames: z.number().int().min(4).max(3000).optional().describe("单次循环多少帧（不传=按类型默认）"),
      loopStopAfterSeconds: z.number().min(0.1).max(3600).optional().describe("循环到多少秒自动停止并完全退出"),
      custom: customEffectSchema
        .optional()
        .describe("仅 kind=custom 时必填：关键帧数组，格式见 list_effect_types"),
      name: z.string().optional(),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const clip: Record<string, unknown> = { kind: a.kind, from: a.from };
      if (a.durationInFrames !== undefined) clip.durationInFrames = a.durationInFrames;
      if (a.intensity !== undefined) clip.intensity = a.intensity;
      if (a.color !== undefined) clip.color = a.color;
      if (a.params !== undefined) clip.params = a.params;
      if (a.curve !== undefined) clip.curve = a.curve;
      if (a.loop !== undefined) clip.loop = a.loop;
      if (a.loopDurationInFrames !== undefined) clip.loopDurationInFrames = a.loopDurationInFrames;
      if (a.loopStopAfterSeconds !== undefined) clip.loopStopAfterSeconds = a.loopStopAfterSeconds;
      if (a.custom !== undefined) clip.custom = a.custom;
      if (a.name !== undefined) clip.name = a.name;
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops: [{ op: "add_effect", clip }] }),
      });
      return fmtSummary(res.summary);
    },
  },
  {
    name: "update_effect",
    description:
      "改一条特效轨的起点 / 长度 / 强度 / 类型 / 颜色，或**微调参数**（params 按 key 合并，只传要改的那个）、" +
      "或**整份替换自定义关键帧**（custom）。effectId 见 get_project 里的特效轨列表。",
    shape: {
      effectId: z.string().describe("要改哪条特效轨（get_project 里的特效轨列表）"),
      kind: z.enum(EFFECT_TYPES).optional().describe("换特效类型（list_effect_types 查可选值）"),
      from: z.number().int().min(0).optional().describe("从全片第几帧开始"),
      durationInFrames: z.number().int().min(1).optional().describe("持续多少帧"),
      intensity: z.number().min(0).max(1).optional().describe("强度 0–1，1 = 该特效的满档"),
      color: z.string().optional().describe("覆盖层颜色 hex"),
      params: z.record(z.number()).optional().describe("要改的参数（按 key 合并，不会清掉其它参数）"),
      curve: z.enum(EFFECT_CURVES).optional(),
      loop: z.boolean().optional().describe("循环播放开关"),
      loopDurationInFrames: z.number().int().min(4).max(3000).optional().describe("单次循环多少帧"),
      loopStopAfterSeconds: z.number().min(0.1).max(3600).optional().describe("循环到多少秒自动停止"),
      custom: customEffectSchema.optional().describe("整份替换自定义关键帧（仅 custom 类型）"),
      name: z.string().optional(),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const patch: Record<string, unknown> = {};
      for (const k of [
        "kind",
        "from",
        "durationInFrames",
        "intensity",
        "color",
        "params",
        "curve",
        "loop",
        "loopDurationInFrames",
        "loopStopAfterSeconds",
        "custom",
        "name",
      ] as const) {
        if (a[k] !== undefined) patch[k] = a[k];
      }
      if (!Object.keys(patch).length) throw new Error("没有任何要改的字段");
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops: [{ op: "update_effect", effectId: a.effectId, patch }] }),
      });
      return fmtSummary(res.summary);
    },
  },
  {
    name: "remove_effect",
    description:
      "删除一条特效轨（画面本身不受影响）。effectId 见 get_project 里的特效轨列表；删错可 restore_rev 回滚。",
    shape: { effectId: z.string(), projectId: z.string().optional() },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops: [{ op: "remove_effect", effectId: a.effectId }] }),
      });
      return fmtSummary(res.summary);
    },
  },
  {
    name: "get_history",
    description:
      "查看最近的编辑历史（每条含版本号 rev、谁改的、干了什么），用来了解用户刚做了什么、或找 restore_rev 回滚的目标版本。",
    shape: { projectId: z.string().optional() },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const { entries } = await api<{ entries: any[] }>(`/api/projects/${p.id}/history`);
      if (!entries.length) return "本次会话还没有历史记录";
      return entries
        .map((e) => `rev${e.rev} [${e.actor}] ${e.summary.join("；") || e.ops.join(",")}`)
        .join("\n");
    },
  },
  {
    name: "get_user_messages",
    description:
      "读取用户在编辑页「给 agent」面板里发的消息（未读的，读完自动标记已读）。用户不用切到 agent 页面，直接在编辑器里留言。",
    shape: { projectId: z.string().optional() },
    run: async () => {
      await ensureServer();
      const res = await fetch(`${BASE}/api/agent/messages`);
      const data = (await res.json()) as {
        messages?: { role: string; text: string; at: string; read: boolean }[];
      };
      const unread = (data.messages ?? []).filter((m) => m.role === "user" && !m.read);
      if (!unread.length) return "没有新的用户消息";
      await fetch(`${BASE}/api/agent/read`, { method: "POST" });
      return unread.map((m) => `[${m.at}] 用户：${m.text}`).join("\n");
    },
  },
  {
    name: "reply_user",
    description:
      "回复编辑页里的用户消息，会显示在「给 agent」面板里，用户不用切到 agent 页面看。",
    shape: { text: z.string().describe("回复内容"), projectId: z.string().optional() },
    run: async (a) => {
      await ensureServer();
      const res = await fetch(`${BASE}/api/agent/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: a.text }),
      });
      if (!res.ok) throw new Error("回复失败");
      return "已回复到编辑页";
    },
  },
  {
    name: "get_tts_config",
    description:
      "读取文本转语音（TTS）配置：本地服务地址、模型、音色、格式，以及服务端可用的完整音色列表。",
    shape: { projectId: z.string().optional() },
    run: async () => {
      await ensureServer();
      const res = await fetch(`${BASE}/api/tts/config`);
      const data = (await res.json()) as { config: any };
      let speakers: string[] = [];
      try {
        const sp = await fetch(`${BASE}/api/tts/speakers`, { signal: AbortSignal.timeout(5000) });
        const spData = (await sp.json()) as { speakers?: Record<string, string> };
        speakers = Object.keys(spData.speakers ?? {});
      } catch {
        /* 服务端没开音色接口就不列 */
      }
      const nl = String.fromCharCode(10);
      const VOICE_META: Record<string, string> = {
        vivian: "女声，温柔，适合讲解/科普",
        serena: "女声，知性，适合教学/口播",
        sohee: "女声，年轻，适合轻快内容",
        ono_anna: "女声，日系，适合轻松/二次元",
        aiden: "男声，沉稳，适合严肃讲解",
        ryan: "男声，磁性，适合商业/解说",
        eric: "男声，浑厚，适合权威感",
        dylan: "男声，年轻，适合活泼内容",
        uncle_fu: "男声，低沉，适合故事/沉稳",
        default: "默认音色（兜底）",
      };
      const head = JSON.stringify(data.config ?? {}, null, 2);
      const list = speakers.length
        ? speakers.map((v) => `- ${v}：${VOICE_META[v] ?? "（无描述）"}`).join(nl)
        : "";
      return speakers.length
        ? `${head}${nl}${nl}可用音色（${speakers.length}）：${nl}${list}`
        : head;
    },
  },
  {
    name: "set_tts_config",
    description:
      "修改 TTS 配置（endpoint/apiKey/model/voice/format/speed/customBody），只传要改的字段。",
    shape: {
      endpoint: z.string().optional().describe("语音服务完整 URL"),
      apiKey: z.string().optional().describe("Bearer token，没有就留空"),
      model: z.string().optional(),
      voice: z.string().optional().describe("默认音色"),
      format: z.enum(["mp3", "wav", "ogg"]).optional(),
      speed: z.number().min(0.25).max(4).optional(),
      customBody: z.string().optional().describe("非 OpenAI 接口的 JSON 模板，支持 {{text}}/{{voice}}/{{speed}}"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      await ensureServer();
      const { projectId: _p, ...patch } = a;
      const res = await fetch(`${BASE}/api/tts/config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = (await res.json()) as { config: { endpoint: string } };
      return `已保存 TTS 配置：${data.config.endpoint}`;
    },
  },
  {
    name: "tts_synthesize",
    description: `把文本合成语音（走配置好的本地 TTS 服务），音频存进 assets；addAs=track 直接加音效轨，music 替换背景音乐，sceneId 放进指定场景。

【传入文本的格式很重要，直接决定读音】
- 默认自动转义（escape=true）：90% → 百分之九十、2026-10-25 → 2026年10月25日、1234565 → 一百二十三万四千五百六十五；已经写成中文读法的文本不会被转坏。
- 不要传 Markdown、代码、表情和特殊符号（* _ ~ ^ | # @ 等），需要表达时写中文：→ 写"到"、& 写"和"、+ 写"加"、% 写"百分之"。
- 英文缩写按读音写（API → "A P I" 或直接写"接口"），避免模型按字母乱读。
- 长文本按句子分段，每段不超过 200 字，分别合成后放进不同场景/音效轨。
- 不想自动转义（比如文本里已经有自己的读法标记）时传 escape=false。`,
    shape: {
      text: z.string().describe("要合成的文本"),
      voice: z.string().optional().describe("音色 id，不传用 get_tts_config 里的当前默认"),
      speed: z.number().min(0.25).max(4).optional().describe("语速倍率：1=正常，0.8 稍慢，1.2 稍快"),
      format: z.enum(["mp3", "wav", "ogg"]).optional().describe("音频格式，默认 mp3"),
      instruct: z.string().optional().describe("风格指令，如「用特别愤怒的语气说」"),
      escape: z
        .boolean()
        .optional()
        .describe("默认 true：自动把数字/百分比/日期/常见符号转成中文读法；传 false 保持原文"),
      addAs: z.enum(["none", "track", "music"]).optional().describe("合成后怎么用，默认 none"),
      sceneId: z.string().optional().describe("把音频放进指定场景（场景内音频元素）"),
      from: z.number().int().min(0).optional().describe("音效起点（帧）"),
      subtitle: z
        .string()
        .optional()
        .describe("同时写入场景字幕（一行一句）；不传则用 text 原文，传空字符串则不写字幕"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      breathSec: z
        .number()
        .min(0)
        .max(5)
        .optional()
        .describe("建议场景时长里留的呼吸位（秒），默认 0.7；长片嫌拖可传 0.3"),
    },
    run: async (a) => {
      await ensureServer();
      // 配音是谁的：先定工程，音频才能落进 assets/projects/<工程id>/（删工程连带清）
      const owner = await resolveProject(a.projectId);
      const res = await fetch(`${BASE}/api/tts/synthesize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: a.text,
          voice: a.voice,
          speed: a.speed,
          format: a.format,
          instruct: a.instruct,
          escape: a.escape,
          projectId: owner.id,
        }),
      });
      const data = (await res.json()) as any;
      if (!res.ok) throw new Error(data.error ?? "合成失败");
      // 绝对落盘路径：agent 想自己处理文件（剪一段/挪位置）时不用再拼路径
      const absPath = path.join(ROOT, "public", String(data.url).replace(/^\/+/, ""));
      const fileNote = `${String.fromCharCode(10)}本地文件：${absPath}`;
      // 顺势把时长量出来：合成接口本身不返回时长，而幕长必须按配音长度倒推
      const probe = await probeOne(data.url, owner.fps || 30, a.breathSec);
      const tip = probe
        ? `\n时长 ${probe.durationInSeconds}s ≈ ${probe.frames} 帧；建议场景时长 ${probe.suggestedSceneFrames} 帧（含 ${probe.breathSec ?? 0.7}s 呼吸位）`
        : "";
      if (a.sceneId) {
        const p = await resolveProject(a.projectId);
        const scene = p.scenes.find((x) => x.id === a.sceneId);
        if (!scene) throw new Error("场景不存在");
        await api(`/api/projects/${p.id}/ops`, {
          method: "POST",
          body: JSON.stringify({
            actor: "agent",
            ops: [
              {
                op: "add_element",
                sceneId: a.sceneId,
                element: {
                  kind: "audio",
                  src: data.url,
                  // 场景内单条语音基本都是旁白：标上之后「配音听过没有」的闸口才看得见它
                  narration: true,
                  name: "语音",
                  x: 50,
                  y: 50,
                  size: 6,
                  audioVolume: 1,
                  from: a.from ?? 0,
                },
              },
              // 顺手把旁白文字写成字幕：配音和字幕一次搞定，导出 SRT 就有内容。
              // 传空字符串表示明确不要字幕
              ...(a.subtitle === ""
                ? []
                : [{ op: "set_subtitle", sceneId: a.sceneId, text: a.subtitle ?? a.text }]),
            ],
          }),
        });
        const subNote =
          a.subtitle === ""
            ? ""
            : `\n已同时写入字幕：${(a.subtitle ?? a.text)
                .split("\n")
                .filter((x: string) => x.trim()).length} 句（导出用 export_subtitles）`;
        return `已合成并放入场景「${scene.name}」：${data.url}${tip}${subNote}${fileNote}`;
      }
      if (a.addAs === "track" || a.addAs === "music") {
        const p = await resolveProject(a.projectId);
        const op =
          a.addAs === "track"
            ? {
                op: "add_audio_track",
                clip: { src: data.url, name: "TTS 语音", from: a.from ?? 0 },
              }
            : { op: "set_audio", audio: { src: data.url, volume: 1, fadeIn: 0, fadeOut: 0 } };
        await api(`/api/projects/${p.id}/ops`, {
          method: "POST",
          body: JSON.stringify({ actor: "agent", ops: [op] }),
        });
        return `已合成并${a.addAs === "track" ? "加入音效轨" : "设为背景音乐"}：${data.url}${tip}${fileNote}`;
      }
      return `已合成：${data.url}（${Math.round((data.bytes ?? 0) / 1024)} KB）${tip}${fileNote}`;
    },
  },
  {
    name: "set_subtitle_style",
    description:
      "只改字幕样式（不动字幕文本）：fontSize（短边百分比）/ color / bg / bgOpacity / bottom / bold / stroke / strokeColor / shadow / lineHeight / letterSpacing / align / maxWidth / css。样式按场景生效。",
    shape: {
      sceneId: z.string(),
      style: z.record(z.any()).describe("样式对象，只传要改的字段"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const scene = p.scenes.find((x) => x.id === a.sceneId);
      if (!scene) throw new Error(`没有场景 ${a.sceneId}`);
      // 只发 style、不带 text：op 层收到 text 会连带重写字幕并回报"写了 N 句字幕"（黑盒验证 N-06）
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [{ op: "set_subtitle", sceneId: a.sceneId, style: a.style }],
        }),
      });
      return fmtSummary(res.summary);
    },
  },
  {
    name: "tts_narration",
    description:
      "多段旁白一次合成（每段对应一幕）：返回每段音频 URL/本地路径/真实时长/建议场景帧数；applyToScenes=true 时直接把音频写进各场景、按配音长度对齐场景时长、并写字幕（keepSubtitles=true 则不碰已有字幕）。" +
      "\n**口播片先跑 mode=\"timing\"**：只拿真实时长、不写场景，然后用 save_storyboard(useNarrationTiming=true) 回填幕长——按字数估时长必然偏。" +
      "\n**顺序很重要**：改幕长**不会**自动调整已经放进去的元素/贴纸（它们的 durationInFrames 在落库时就固化成当时的幕长）。" +
      "所以正确顺序是「先 tts_narration 定幕长 → 再 add_element 放定时元素」；" +
      "顺序反了（先放元素后配音）元素会在幕中间消失，必须回头 update_element 改时长。" +
      "\n**幕尾呼吸位**默认 0.7s/幕（18 幕就是 12.6s）：总长超 brief.durationSec 时会当场警告并给出三个旋钮，breathSec 可调到 0.3。",
    shape: {
      segments: z
        .array(
          z.object({
            text: z.string().describe("这一段的文案（口语、短句）"),
            sceneId: z.string().optional().describe("对应场景；applyToScenes 必填"),
            voice: z.string().optional(),
            instruct: z.string().optional().describe("这一段单独的语气指令"),
          }),
        )
        .min(1)
        .optional()
        .describe("按幕顺序给，一段一幕；fromStoryboard=true 时可以不传"),
      applyToScenes: z
        .boolean()
        .optional()
        .describe("把每段写进 sceneId 对应场景（音频 + 场景时长 + 字幕），默认 false"),
      keepSceneDuration: z
        .boolean()
        .optional()
        .describe(
          "true = 只换音频，不改幕长（默认 false 会按新配音长度重排这一幕）。" +
            "改一句台词想只重配那一段时用它：segments 只给要改的段 + applyToScenes + keepSceneDuration=true，其余幕和元素坐标都不动",
        ),
      fromStoryboard: z
        .boolean()
        .optional()
        .describe("直接从分镜表的 text/sceneId 取素材（不用再重贴一遍文案）"),
      voice: z.string().optional().describe("默认音色（段内可覆盖），不传用 get_tts_config 里的当前默认"),
      speed: z.number().min(0.25).max(4).optional().describe("语速倍率：1=正常，0.9 朗读稍慢适合科普"),
      format: z.enum(["mp3", "wav", "ogg"]).optional(),
      breathSec: z
        .number()
        .min(0)
        .max(5)
        .optional()
        .describe(
          "每幕尾巴留的呼吸位（秒），默认 0.7。18 幕 × 0.7 = 12.6 秒（占成片 14%），长片嫌拖就传 0.3–0.4",
        ),
      keepSubtitles: z
        .boolean()
        .optional()
        .describe(
          "true = 只写音频和幕长，**不动已有字幕**（保留手工拆的断句/钩子三拍）。默认 false 会用旁白文本重写字幕",
        ),
      mode: z
        .enum(["full", "timing"])
        .optional()
        .describe(
          "timing = 只合成并落盘「时间骨架」，不写场景、不写字幕（口播片应在写分镜前先跑这个，再 save_storyboard(useNarrationTiming)）",
        ),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      await ensureServer();
      // 从分镜表取（每幕 text + sceneId），省得把 22 段文案重贴一遍
      if (a.fromStoryboard) {
        const p = await resolveProject(a.projectId);
        const sb = readStoryboard(p.id);
        if (!sb?.shots?.length) throw new Error("还没有分镜表，先 save_storyboard");
        a = {
          ...a,
          segments: sb.shots
            .filter((x) => x.text && x.sceneId)
            .map((x) => ({ text: x.text as string, sceneId: x.sceneId as string })),
        } as typeof a;
        if (!a.segments?.length) throw new Error("分镜表里没有带 text + sceneId 的幕");
      }
      if (!a.segments?.length) {
        throw new Error("要给 segments，或传 fromStoryboard=true 从分镜表取");
      }
      // 批量配音同样落在工程目录里，和单段一致
      const owner = await resolveProject(a.projectId);
      const results: {
        text: string;
        sceneId?: string;
        url: string;
        absPath: string;
        duration: number;
        frames: number;
        suggested: number;
      }[] = [];

      for (const seg of a.segments) {
        const res = await fetch(`${BASE}/api/tts/synthesize`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: seg.text,
            voice: seg.voice ?? a.voice,
            speed: a.speed,
            format: a.format,
            instruct: seg.instruct,
            projectId: owner.id,
          }),
        });
        const data = (await res.json()) as any;
        if (!res.ok) throw new Error(data.error ?? "合成失败");
        const probe = await probeOne(data.url, owner.fps || 30, a.breathSec);
        results.push({
          text: seg.text,
          sceneId: seg.sceneId,
          url: data.url,
          absPath: path.join(ROOT, "public", String(data.url).replace(/^\/+/, "")),
          duration: probe?.durationInSeconds ?? 0,
          frames: probe?.frames ?? 0,
          suggested: probe?.suggestedSceneFrames ?? 0,
        });
      }

      const nl = String.fromCharCode(10);
      // 试听链接必须是**完整 http URL**：以前只给 `/assets/...`（相对路径）和
      // `D://...//public//assets//...`（服务端本地路径），用户在 GUI 里两个都打不开。
      // 事故里 5 段配音合成完、用户一句没听到，agent 只能去调宿主的 present（音频静默失败）——
      // 而这条链接一直是 HTTP 200 可播的，缺的只是把 BASE 拼上。
      const lines = results.map(
        (r, i) =>
          `${i + 1}. ${r.text.replace(/\n/g, " ").slice(0, 24)}… · ${r.duration}s ≈ ${r.frames} 帧 · 建议 ${r.suggested} 帧${
            r.sceneId ? ` → ${r.sceneId}` : ""
          }${nl}   试听：${BASE}${r.url}`,
      );

      // 不管 full 还是 timing 都落盘：save_storyboard(useNarrationTiming) 要读它。
      // 口播片的时间骨架是配音，不是"字数 ÷ 4.5"。
      const timingRes = await api<{
        timing: { totalSec: number; at?: string; heardAt?: string; heardOf?: string; heardUserSaid?: string };
      }>(
        `/api/projects/${owner.id}/narration-timing`,
        {
          method: "PUT",
          body: JSON.stringify({
            fps: owner.fps || 30,
            segments: results.map((r) => ({
              text: r.text,
              frames: r.frames,
              suggested: r.suggested,
              durationSec: r.duration,
              sceneId: r.sceneId,
            })),
          }),
        },
      );

      if (a.mode === "timing") {
        const totalSec = timingRes.timing?.totalSec ?? results.reduce((n, r) => n + r.suggested, 0) / (owner.fps || 30);
        const briefNow = readBrief(owner.id);
        const planned = Number(briefNow?.durationSec ?? 0);
        const dev =
          planned > 0
            ? `${nl}与 brief 计划 ${planned}s 相差 ${(((totalSec - planned) / planned) * 100).toFixed(0)}%（正数=实际更长）`
            : "";
        return [
          `旁白时间骨架：${results.length} 段 / ${totalSec.toFixed(1)}s（只算时长，没写场景也没写字幕）${dev}`,
          ...lines,
          "",
          `⛔ **停在这里。现在唯一该做的事是让用户听到它。**`,
          `   ① 把上面每条「试听」链接原样发给用户（那是完整 http 地址，点开就能播）`,
          `   ② 只问三件事：语速对不对 / 有没有读错的字 / 停顿别扭吗（问多了他答不清）`,
          `   ③ 用户听完说「可以」→ confirm_narration(userSaid="他的原话")`,
          `   ④ 然后才 save_storyboard(useNarrationTiming=true) → build_film`,
          "",
          `**为什么必须停**：用户没听过就排版 = 把画面锁在没确认的语音上。`,
          `改一句台词 → 重新合成 → 幕长变 → 每一幕的元素坐标和动画帧位全部重排。`,
        ].join(nl);
      }

      if (a.applyToScenes) {
        const p = await resolveProject(a.projectId);
        const ops: Record<string, unknown>[] = [];
        let applied = 0;
        for (const r of results) {
          if (!r.sceneId) continue;
          const scene = p.scenes.find((x: any) => x.id === r.sceneId);
          if (!scene || !r.suggested) continue;
          // 先清掉这个场景里**本工具加过的旧旁白**（narration 标记），避免重复叠加；
          // 用户手动添加的音效/BGM 没有 narration 标记，不能动 —— 以前无差别全删过
          for (const el of ((scene as any).elements ?? [])) {
            if (el.kind === "audio" && (el as any).narration === true) {
              ops.push({ op: "remove_element", sceneId: r.sceneId, elementId: el.id });
            }
          }
          // keepSceneDuration=true：只换音频，不重排这一幕（改一句台词时其余内容不该被牵动）
          const targetDur = a.keepSceneDuration
            ? Math.max(1, Number((scene as { durationInFrames?: number }).durationInFrames ?? r.suggested))
            : r.suggested;
          if (!a.keepSceneDuration) {
            ops.push({
              op: "update_scene",
              sceneId: r.sceneId,
              patch: { durationInFrames: targetDur },
            });
          } else if (r.suggested > targetDur) {
            lines.push(
              `⚠️ 场景 ${r.sceneId} 的配音 ${r.suggested} 帧比幕长 ${targetDur} 帧长：keepSceneDuration 下音频会被幕尾截断，要完整播放请关掉它重跑`,
            );
          }
          // 旁白文本往往是一整句，直接当字幕上屏就是一屏几十字：先拆再存。
          // keepSubtitles=true 时跳过——钩子幕手工拆的三拍断点会被整句覆盖掉（复盘坑 #8）
          if (!a.keepSubtitles) {
            ops.push({
              op: "set_subtitle",
              sceneId: r.sceneId,
              text: subtitleToField(normalizeSubtitle(r.text, { maxChars: SUBTITLE_LIMITS.max }).lines),
            });
          }
          ops.push({
            op: "add_element",
            sceneId: r.sceneId,
            element: {
              kind: "audio",
              src: r.url,
              narration: true,
              name: "旁白",
              x: 50,
              y: 50,
              size: 6,
              audioVolume: 1,
              from: 0,
              durationInFrames: a.keepSceneDuration ? Math.min(r.suggested, targetDur) : targetDur,
            },
          });
          applied++;
        }
        if (ops.length) {
          await api(`/api/projects/${p.id}/ops`, {
            method: "POST",
            body: JSON.stringify({ actor: "agent", ops }),
          });
        }
        lines.push(
          a.keepSubtitles
            ? `已应用到 ${applied} 个场景：场景时长按配音对齐、音频放入（字幕按 keepSubtitles 保持原样，请自己复查断句）`
            : `已应用到 ${applied} 个场景：场景时长按配音对齐、字幕写入、音频放入（重复应用会先清旧旁白；手工加的音效不受影响。手工拆过的字幕已被覆盖，要复查）`,
        );
      }

      // 用户如果已经在「骨架确认」那一步听过这一版，音频一旦进场景，指纹会变成"没听过" ——
      // 那就等于让他听两遍。这里把那次确认继承过来。
      // 反过来：骨架没确认过 → 不继承 → 建幕时照常被拦（这正是要的效果）。
      if (a.applyToScenes && timingRes.timing?.heardAt && timingRes.timing.heardOf === timingRes.timing.at) {
        try {
          const freshNow = await api<{ project: never }>(`/api/projects/${owner.id}`);
          const vs = voiceHeardState(freshNow.project, owner.id);
          if (vs.state === "unheard" && vs.fingerprint) {
            markVoiceHeard(
              owner.id,
              vs.fingerprint,
              timingRes.timing.heardUserSaid ?? "（确认骨架时已听过这一版）",
            );
            lines.push("ℹ️ 这批音频就是用户听过的那一版（确认记录已自动继承，不需要重听）");
          }
        } catch {
          /* 继承失败不影响主流程，闸口会照常要求确认 */
        }
      }

      // 总长预警：呼吸位 × 幕数是隐形加长项（18 幕 × 0.7s = 12.6s，占 14%）。
      // 等渲出来才发现超目标，前面每一幕的坐标都要跟着重排（复盘坑 #9）
      {
        const totalFrames = results.reduce((s, r) => s + (r.suggested || 0), 0);
        const totalSec = totalFrames / (owner.fps || 30);
        const briefNow = readBrief(owner.id);
        const target = Number(briefNow?.durationSec ?? 0);
        const breath = a.breathSec ?? 0.7;
        const tail =
          `合计 ${totalSec.toFixed(1)}s（含每幕 ${breath}s 呼吸位，共 ${(results.length * breath).toFixed(1)}s）`;
        if (target > 0 && totalSec > target + 2) {
          lines.push(
            `⚠️ 比 brief 里的目标时长（${target}s）长了 ${(totalSec - target).toFixed(1)}s：${tail}。` +
              `三个旋钮：breathSec 降到 0.3（省 ${(results.length * 0.3).toFixed(1)}s）、语速提到 1.1–1.15、删一两幕。` +
              `现在就定，别等渲完再回头改幕长（改幕长后面每幕元素都要重排）`,
          );
        } else if (target > 0) {
          lines.push(`ℹ️ ${tail}，目标 ${target}s，在容差内`);
        }
      }

      return (
        `已合成 ${results.length} 段旁白${nl}${lines.join(nl)}${nl}` +
        `⛔ **先把试听链接发给用户，等他听过再往下走。**${nl}` +
        `   用户说「可以」→ confirm_narration(userSaid="他的原话")，之后 build_storyboard / build_film 才放行${nl}` +
        `${nl}下一步：confirm_narration → preview_frames 抽帧自检 → render_video(dryRun=true) 预检 → render_video`
      );
    },
  },
  {
    name: "revise_script",
    description:
      "**改稿即改片**：用户改了一句台词时用它，别用 save_script 重写——那会把整片配音、幕长、字幕全部作废。\n" +
      "它只重配改动的那几段，然后同步：幕长（按新配音实测帧数）、旁白音频、字幕、分镜表、配音时间骨架；" +
      "并列出幕长变化会牵动的幕内定时元素、特效轨、音效轨（这几类**不会**自动改，硬拉伸会毁动画节奏）。\n" +
      "textOnly=true = 只改错别字/标点（读音不变，不重配、不改幕长）；dryRun=true = 只回估算，不动任何文件。\n" +
      "改完仍要两道确认：新的一段发用户试听 → confirm_narration；稿件已变、上次确认失效 → confirm_script。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      changes: z
        .array(
          z.object({
            segment: z
              .number()
              .int()
              .min(1)
              .optional()
              .describe("改第几段（1 起，get_script 的编号）；与 sceneId 二选一"),
            sceneId: z.string().optional().describe("也可以按幕 id 定位（忘了段号时用，先 get_scene / get_project）"),
            text: z.string().describe("这一段的新文案（整段替换，不是只给改动的几个字）"),
            note: z.string().optional().describe("新的画面备注；不传保留原备注"),
          }),
        )
        .min(1)
        .describe("要改的段（可以一次改多段）"),
      fit: z
        .enum(["duration", "keep"])
        .optional()
        .describe(
          "duration（默认）= 按新配音实测改幕长；keep = 保留幕长只换音频（新配音更长会被幕尾截断，只在改短句时安全）",
        ),
      breathSec: z.number().min(0).max(5).optional().describe("幕尾呼吸位（秒），默认 0.7，与 tts_narration 一致"),
      voice: z.string().optional().describe("重配用的音色；**不传 = 当前默认音色**，原片如果用了别的音色要显式传，否则这一段和其余段不一样"),
      speed: z.number().min(0.25).max(4).optional().describe("重配语速；原片调过语速的话要一起传，不然这一段快慢不一致"),
      textOnly: z.boolean().optional().describe("true = 只改稿件文字与字幕，不重配、不改幕长（错别字/标点修正）"),
      dryRun: z.boolean().optional().describe("true = 只按字数估算影响，不合成、不写任何文件"),
    },
    run: async (a) => {
      await ensureServer();
      const p = await resolveProject(a.projectId);
      const script = readScript(p.id);
      if (!script?.segments?.length) {
        throw new Error("还没有稿件分段：先 save_script 写一版（一段一幕）再来改稿");
      }
      const nl = String.fromCharCode(10);
      const sb = readStoryboard(p.id);
      const changes = resolveChanges(script, sb, (a.changes ?? []) as never);
      const todo = changes.filter((c) => c.changed);
      if (!todo.length) {
        return (
          `这 ${changes.length} 段的文案和现有稿件完全一致，没有改动。${nl}` +
          `只是读音/语速不对 → tts_narration(segments=[{text, sceneId}], applyToScenes=true, keepSceneDuration=true)；` +
          `整篇重写 → save_script`
        );
      }

      const fps = Number(p.fps) > 0 ? Number(p.fps) : 30;
      const breath = a.breathSec === undefined ? 0.7 : Math.max(0, Number(a.breathSec));
      const fit = a.fit === "keep" ? "keep" : "duration";
      const textOnly = a.textOnly === true;
      const scenes = (p.scenes ?? []) as LooseScene[];
      const oldTotal = totalDuration(p as never);
      const briefSec = Number(readBrief(p.id)?.durationSec ?? 0);

      // 每条改动落到「幕 + 旧幕长 + 估算新幕长」。幕可能还没建（只改稿与分镜）
      const plan = todo.map((c) => {
        const hit = findSceneOf(c.sceneId, scenes);
        const oldDur = hit ? Math.max(1, Number(hit.scene.durationInFrames ?? 1)) : 0;
        const estFrames = Math.max(1, Math.ceil((estimateSeconds(c.text) + breath) * fps));
        return { c, hit, oldDur, estFrames };
      });

      if (a.dryRun) {
        const items = plan.map((x, i) => {
          const dur = x.hit
            ? ` · 幕「${x.hit.scene.name}」${x.oldDur}f（${(x.oldDur / fps).toFixed(1)}s）→ 约 ${x.estFrames}f（${(x.estFrames / fps).toFixed(1)}s）`
            : " · 还没建幕（只改稿与分镜，铺开时按新稿）";
          return `${i + 1}. 第 ${x.c.index + 1} 段 ${scriptChars(x.c.oldText)}字 → ${scriptChars(x.c.text)}字${dur}`;
        });
        const delta = plan.reduce((n, x) => n + (x.hit ? x.estFrames - x.oldDur : 0), 0);
        const after = (oldTotal + delta) / fps;
        return [
          `dryRun（什么都没改）：要改 ${plan.length} 段，按字数估算幕长合计 ${delta >= 0 ? "+" : ""}${delta}f（${delta >= 0 ? "+" : ""}${(delta / fps).toFixed(1)}s）`,
          ...items,
          `成片 ${(oldTotal / fps).toFixed(1)}s → 约 ${after.toFixed(1)}s${briefSec > 0 ? `（brief 目标 ${briefSec}s）` : ""}`,
          `估算误差不小（4.5 字/秒 vs 实际念法）；要真数就去掉 dryRun 跑一遍`,
        ].join(nl);
      }

      // ── 合成：全部成功才动稿件与工程。中途失败时稿件/工程都还是旧的 ──
      type Synth = { url: string; frames: number; suggested: number; duration: number };
      const synth = new Map<number, Synth>();
      if (!textOnly) {
        for (const x of plan) {
          const res = await fetch(`${BASE}/api/tts/synthesize`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: x.c.text, voice: a.voice, speed: a.speed, projectId: p.id }),
          });
          const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
          if (!res.ok || !data.url) {
            throw new Error(
              `第 ${x.c.index + 1} 段合成失败：${data.error ?? `HTTP ${res.status}`}（稿件与工程都还没动，可改完重试）`,
            );
          }
          const probe = await probeOne(data.url, fps, breath);
          if (!probe) {
            throw new Error(
              `第 ${x.c.index + 1} 段合成成功但读不出时长（${data.url}）——稿件与工程都还没动。检查语音服务返回的格式（wav/mp3/ogg）`,
            );
          }
          synth.set(x.c.index, {
            url: data.url,
            frames: Number(probe.frames ?? 0),
            suggested: Math.max(1, Number(probe.suggestedSceneFrames ?? 0)),
            duration: Number(probe.durationInSeconds ?? 0),
          });
        }
      }

      // ── 只动命中的幕：旧旁白换新、幕长跟随、字幕重写 ──
      const ops: Record<string, unknown>[] = [];
      const touched: { index: number; sceneId: string; sceneName: string; oldDur: number; wantDur: number }[] = [];
      for (const x of plan) {
        const hit = x.hit;
        if (!hit) continue;
        const els = (hit.scene.elements ?? []) as Record<string, unknown>[];
        const prevNar = els.find((el) => el.kind === "audio" && el.narration === true);
        // 有人手工挪过旁白位置（from>0），重加不能归零
        const keepFrom = prevNar ? Math.max(0, Number(prevNar.from ?? 0)) : 0;
        const s = synth.get(x.c.index);
        if (!textOnly) {
          for (const el of els) {
            if (el.kind === "audio" && el.narration === true) {
              ops.push({ op: "remove_element", sceneId: hit.scene.id, elementId: el.id });
            }
          }
        }
        if (s && fit === "duration") {
          ops.push({ op: "update_scene", sceneId: hit.scene.id, patch: { durationInFrames: s.suggested } });
        }
        ops.push({
          op: "set_subtitle",
          sceneId: hit.scene.id,
          text: subtitleToField(normalizeSubtitle(x.c.text, { maxChars: SUBTITLE_LIMITS.max }).lines),
        });
        if (s) {
          // keep：音频比幕长短就按幕长截，比幕长长会被幕尾截（下面会告警）
          const dur = fit === "duration" ? s.suggested : Math.max(1, Math.min(s.suggested, x.oldDur));
          ops.push({
            op: "add_element",
            sceneId: hit.scene.id,
            element: {
              kind: "audio",
              src: s.url,
              narration: true,
              name: "旁白",
              x: 50,
              y: 50,
              size: 6,
              audioVolume: 1,
              from: keepFrom,
              durationInFrames: dur,
            },
          });
        }
        touched.push({
          index: x.c.index,
          sceneId: hit.scene.id,
          sceneName: hit.scene.name,
          oldDur: x.oldDur,
          wantDur: s && fit === "duration" ? s.suggested : x.oldDur,
        });
      }

      if (ops.length) {
        await api(`/api/projects/${p.id}/ops`, {
          method: "POST",
          body: JSON.stringify({ actor: "agent", ops }),
        });
      }

      // 场景类型有单幕时长上下限，超了会被 clamp —— 那就是"配音比幕长，尾字被吃掉"
      let clampNote = "";
      if (touched.some((t) => t.wantDur !== t.oldDur)) {
        try {
          const fresh = await api<{ project: { scenes: { id: string; durationInFrames: number }[] } }>(
            `/api/projects/${p.id}`,
          );
          const hitClamp = touched.filter((t) => {
            const f = fresh.project.scenes.find((s) => s.id === t.sceneId);
            return f && Math.abs(Number(f.durationInFrames) - t.wantDur) > 1;
          });
          if (hitClamp.length) {
            clampNote =
              `⚠️ ${hitClamp.length} 幕被场景类型的时长上下限夹住了，配音会被幕尾截断：` +
              hitClamp
                .map((t) => {
                  const f = fresh.project.scenes.find((s) => s.id === t.sceneId);
                  return `「${t.sceneName}」要 ${t.wantDur}f 实际 ${f?.durationInFrames}f`;
                })
                .join("；") +
              ` —— 拆成两幕，或换时长上限更高的类型`;
          }
        } catch {
          /* 检查失败不影响主流程 */
        }
      }

      // ── 稿件（saveScript 会清掉旧确认，这正是要的） ──
      const nextSegments = (script.segments ?? []).map((seg, i) => {
        const c = plan.find((x) => x.c.index === i);
        if (!c) return seg;
        return { ...seg, text: c.c.text, note: c.c.note, sceneId: seg.sceneId ?? c.c.sceneId };
      });
      saveScript(p.id, { ...script, segments: nextSegments });

      // ── 配音时间骨架：只换命中段，其余读数还准 ──
      let timingNote = "";
      const timing = readTiming(p.id);
      if (timing && synth.size) {
        const merged = mergeTiming(
          timing,
          plan
            .filter((x) => synth.has(x.c.index))
            .map((x) => {
              const s = synth.get(x.c.index) as Synth;
              return {
                sceneId: x.c.sceneId,
                index: x.c.index,
                text: x.c.text,
                frames: s.frames,
                suggested: s.suggested,
                durationSec: s.duration,
              };
            }),
          { allowIndexFallback: (timing.segments ?? []).length === script.segments.length },
        );
        if (merged.matched) {
          saveTiming(p.id, merged.timing);
          timingNote =
            `配音时间骨架已同步（${merged.matched} 段，${timing.totalSec.toFixed(1)}s → ${merged.timing.totalSec.toFixed(1)}s）` +
            `，「用户听过」按新版本自动失效`;
        } else {
          timingNote = `⚠️ 时间骨架里没对上这几段（骨架可能是别的稿子），没动它——还要用 useNarrationTiming 就重跑 tts_narration(mode="timing")`;
        }
      }

      // ── 分镜表：不跟着改，下次 build 就按旧文案重建 ──
      const sbPatch = patchStoryboard(
        sb,
        plan.map((x) => {
          const s = synth.get(x.c.index);
          return {
            index: x.c.index,
            sceneId: x.c.sceneId,
            text: x.c.text,
            durationInFrames: s && fit === "duration" ? s.suggested : undefined,
          };
        }),
      );
      if (sbPatch?.matched.length) saveStoryboard(p.id, sbPatch.storyboard);

      // ── 影响面：幕内定时元素 / 全局轨 ──
      const impacts = plan
        .filter((x) => x.hit && synth.has(x.c.index) && fit === "duration")
        .map((x) => {
          const hit = x.hit as NonNullable<typeof x.hit>;
          const s = synth.get(x.c.index) as Synth;
          const r = analyzeReflow(hit.scene, s.suggested);
          r.sceneIndex = hit.sceneIndex;
          return r;
        });
      const elNotes: string[] = [];
      for (const r of impacts) {
        const head = `「${r.sceneName}」${r.oldDur}f → ${r.newDur}f`;
        for (const el of r.unreachable) {
          elNotes.push(`${head}：「${el.name}」起点 ${el.from}f 已越过幕尾，整段看不见（要挪回幕内：update_element）`);
        }
        for (const el of r.clipped) {
          elNotes.push(
            `${head}：「${el.name}」到 ${el.endsAt}f，超幕尾 ${el.endsAt - r.newDur}f，会被截断（想撑满就 durationInFrames=-1）`,
          );
        }
        for (const el of r.earlyEnd) {
          elNotes.push(`${head}：「${el.name}」在 ${el.endsAt}f 结束，幕尾空 ${r.newDur - el.endsAt}f（要它撑满就 durationInFrames=-1）`);
        }
      }
      const deltaTotal = impacts.reduce((n, r) => n + r.deltaFrames, 0);
      const newTotal = oldTotal + deltaTotal;

      const spans = sceneSpans(scenes as never[]);
      const shiftStarts = impacts
        .filter((r) => r.deltaFrames !== 0 && r.sceneIndex >= 0)
        .map((r) => Number(spans[r.sceneIndex]?.start ?? 0));
      const firstShift = shiftStarts.length ? Math.min(...shiftStarts) : -1;
      const lateTracks = firstShift >= 0 ? ((p.audioTracks ?? []) as { name: string; from: number }[]).filter((t) => t.from >= firstShift) : [];
      const lateEffects = firstShift >= 0
        ? ((p.effects ?? []) as { name: string; from: number }[]).filter((e) => e.from >= firstShift)
        : [];
      const trackNote =
        lateTracks.length || lateEffects.length
          ? `⚠️ 时间轴整体变了 ${(deltaTotal / fps).toFixed(1)}s：${[lateTracks.length ? `${lateTracks.length} 条音效/音乐` : "", lateEffects.length ? `${lateEffects.length} 个特效` : ""]
              .filter(Boolean)
              .join("、")}是**按绝对帧**摆的（第一个在 ${firstShift}f 之后），现在相对画面已经错位——要逐个 update_audio_track / update_effect 重摆，或接受错位`
          : "";
      const beatNote =
        p.beatGrid && Math.abs(deltaTotal) > 2
          ? `⚠️ 有节拍网格（${p.beatGrid.bpm} BPM）：卡点基于旧时间轴，改长/改短后要重新 align 卡点`
          : "";
      // keep 模式不改幕长，新配音比幕长就必然被幕尾截断 —— 这是这个模式唯一的坑
      const keepOver =
        fit === "keep"
          ? touched
              .map((t) => ({ t, s: synth.get(t.index) }))
              .filter((x) => x.s && (x.s as Synth).suggested > x.t.oldDur)
          : [];
      const keepNote = keepOver.length
        ? `⚠️ fit=keep 但新配音比幕长：` +
          keepOver
            .map((x) => `「${x.t.sceneName}」配音 ${(x.s as Synth).suggested}f > 幕长 ${x.t.oldDur}f`)
            .join("；") +
          ` —— 尾字会被幕尾切掉。要完整就重跑一次不传 fit（按配音改幕长）`
        : "";
      // BGM 若写死了长度，片变长会提前结束（loop 的没这个问题）
      const bgmFixed = Number((p.audio as { durationInFrames?: number } | undefined)?.durationInFrames ?? 0);
      const bgmNote =
        bgmFixed > 0 && newTotal > bgmFixed + 2
          ? `⚠️ 背景音乐写死了 ${bgmFixed}f，成片现在 ${newTotal}f：后面 ${newTotal - bgmFixed}f 会没声音（要么 set_audio(durationInFrames=null) 让它跟素材，要么开 loop）`
          : "";

      // ── 回执 ──
      const items = plan.map((x, i) => {
        const s = synth.get(x.c.index);
        const chars = `${scriptChars(x.c.oldText)}字 → ${scriptChars(x.c.text)}字`;
        const where = x.hit ? ` · 幕「${x.hit.scene.name}」［${x.hit.scene.id}］` : " · 还没建幕（只改稿与分镜）";
        const dur =
          s && fit === "duration" && x.hit
            ? ` ${x.oldDur}f（${(x.oldDur / fps).toFixed(1)}s）→ ${s.suggested}f（${(s.suggested / fps).toFixed(1)}s）`
            : s
              ? ` 幕长保持 ${x.oldDur}f`
              : "";
        const link = s ? `${nl}   试听：${BASE}${s.url}` : "";
        return `${i + 1}. 第 ${x.c.index + 1} 段 ${chars}${where}${dur}${link}`;
      });

      const next = textOnly
        ? `${nl}下一步：把改后的这一段发给用户过目 → confirm_script（读音没变，不用重配）`
        : `${nl}⛔ 下一步（顺序别省）：` +
          `${nl}   ① 把上面的试听链接发给用户，只问三件事：语速对不对 / 有没有读错 / 停顿别扭吗` +
          `${nl}   ② 他说「可以」→ confirm_narration(userSaid="他的原话")` +
          `${nl}   ③ 稿件也变了 → confirm_script（旧确认已失效；他没点头之前 build_storyboard 会拒绝）` +
          `${nl}   ④ 元素被挤到的，用 update_element 挪位置/改时长；要复看画面就 preview_frames`;

      return [
        `改稿已落地：${plan.length} 段${textOnly ? "（只改字，没重配）" : `，重配 ${synth.size} 段`}`,
        ...items,
        textOnly
          ? ""
          : `${nl}成片 ${(oldTotal / fps).toFixed(1)}s → ${(newTotal / fps).toFixed(1)}s${briefSec > 0 ? `（brief 目标 ${briefSec}s，差 ${(newTotal / fps - briefSec).toFixed(1)}s）` : ""}`,
        textOnly ? "" : (sbPatch?.matched.length ? `分镜表已同步（第 ${sbPatch.matched.join("、")} 幕）` : ""),
        timingNote,
        clampNote,
        keepNote,
        trackNote,
        bgmNote,
        beatNote,
        elNotes.length
          ? `${nl}幕内元素要跟手（${elNotes.length} 处）：${nl}- ${elNotes.slice(0, 6).join(`${nl}- `)}${elNotes.length > 6 ? `${nl}- …共 ${elNotes.length} 处` : ""}`
          : "",
        next,
      ]
        .filter(Boolean)
        .join(nl);
    },
  },
  {
    name: "register_narration",
    description:
      "**登记已有配音**：配音不是 tts_narration 生成的（真人录音 / 外部 TTS / 客户给的文件）时用这个。\n" +
      "支持真实情况：**一幕可以有多条**、**首尾不必相连**（给 from 指定场景内起始帧）、**从整轨里取一段**（startFrom + durationInFrames）。\n" +
      "会做三件事：① 本机文件自动上传 ② 探测真实时长 ③ 标记为旁白（配音闸口只统计这些）并给出可播链接。\n" +
      "格式支持 wav / mp3 / m4a(mp4) / ogg；**flac / 裸 aac / webm 读不出时长，会直接拒绝**（请先转码）。\n" +
      "登记完仍然是：把链接发给用户听 → 他说过之后 confirm_narration(userSaid) → 才能建幕。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程"),
      segments: z
        .array(
          z.object({
            path: z.string().describe("本机绝对路径（D:/配音/01.mp3）或站内地址（/assets/...）"),
            sceneId: z.string().optional().describe("放到哪一幕；不传 = 按顺序依次分配（超出的都放最后一幕）"),
            from: z
              .number()
              .int()
              .min(0)
              .optional()
              .describe("场景内起始帧；不传 = 紧接着同场景上一条的结尾（首尾自动相连）"),
            startFrom: z
              .number()
              .int()
              .min(0)
              .optional()
              .describe("从文件第几帧开始取（整轨切分用：一条长音频切成几段挂在不同位置）"),
            durationInFrames: z
              .number()
              .int()
              .min(1)
              .optional()
              .describe("播多长（帧）；不传 = 用文件真实时长。整轨切分时必须给"),
            text: z.string().optional().describe("这段旁白的文案（便于对字幕、也便于回执里指认）"),
            name: z.string().optional().describe("图层名，默认「旁白 N」"),
            volume: z.number().min(0).optional().describe("音量，1 = 原音"),
          }),
        )
        .min(1)
        .describe("配音片段，按出场顺序给"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const nl = String.fromCharCode(10);
      const fps = p.fps || 30;
      const scenes = (p.scenes ?? []) as { id?: string; durationInFrames?: number; name?: string }[];
      if (!scenes.length) throw new Error("工程里还没有场景：配音要挂在场景上，先建幕");

      type Seg = {
        path: string;
        sceneId?: string;
        from?: number;
        startFrom?: number;
        durationInFrames?: number;
        text?: string;
        name?: string;
        volume?: number;
      };
      const segs = (a.segments ?? []) as Seg[];

      /* ① 本机文件先上传，拿到站内地址 */
      const fsMod = await import("node:fs/promises");
      const pathMod = await import("node:path");
      const staged: { src: string; local: string; seg: Seg }[] = [];
      /** 同一个本机文件只传一次：整轨切成 3 段时，不该把同一份音频传 3 遍 */
      const uploaded = new Map<string, string>();
      for (const seg of segs) {
        const raw = String(seg.path ?? "").trim();
        if (!raw) throw new Error("有片段的 path 是空的");
        if (raw.startsWith("/assets/") || /^https?:/i.test(raw)) {
          staged.push({ src: raw, local: raw, seg });
          continue;
        }
        if (uploaded.has(raw)) {
          staged.push({ src: uploaded.get(raw)!, local: raw, seg });
          continue;
        }
        // 本机路径：先看文件在不在，再上传
        try {
          await fsMod.access(raw);
        } catch {
          throw new Error(`找不到文件：${raw}`);
        }
        const buf = await fsMod.readFile(raw);
        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(buf)]), pathMod.basename(raw));
        const res = await fetch(`${BASE}/api/projects/${p.id}/assets`, { method: "POST", body: form });
        const data = (await res.json()) as { url?: string; error?: string };
        if (!res.ok || !data.url) throw new Error(`上传失败（${pathMod.basename(raw)}）：${data.error ?? `HTTP ${res.status}`}`);
        uploaded.set(raw, data.url);
        staged.push({ src: data.url, local: raw, seg });
      }

      /* ② 一次探测所有时长（失败要明确拒绝，不能猜） */
      const q = staged
        .map((x) => `src=${encodeURIComponent(x.src)}`)
        .join("&");
      const probe = await api<{
        probes: { src: string; durationInSeconds?: number; frames?: number; format?: string; error?: string }[];
      }>(`/api/assets/probe?${q}&fps=${fps}`);
      const probes = probe.probes ?? [];

      const bad: string[] = [];
      staged.forEach((x, i) => {
        const pr = probes[i];
        if (!pr || pr.error || !(Number(pr.frames) > 0)) {
          const ext = String(x.src).split(".").pop() ?? "?";
          bad.push(
            `  · ${pathMod.basename(String(x.seg.path))}${pr?.error ? `：${pr.error}` : "：读不出时长"}` +
              `${/^(flac|aac|webm)$/i.test(ext) ? `（.${ext} 不支持）` : ""}`,
          );
        }
      });
      if (bad.length) {
        throw new Error(
          `这 ${bad.length} 个文件读不出时长，不能登记：${nl}${bad.join(nl)}${nl}` +
            `**为什么不能凑**：时长决定幕长，猜一个数会让整片节奏错位，而你很难看出是哪里错的。${nl}` +
            `**怎么办**：先转成 wav 或 mp3（mp3 体积小、兼容最好）：${nl}` +
            `  ffmpeg -i 输入.flac 输出.wav${nl}` +
            `  ffmpeg -i 输入.aac  输出.m4a${nl}` +
            `或者让用户从剪映 / 达芬奇 / 格式工厂 导出 wav/mp3 再给你。转完重新调这个工具。`,
        );
      }

      /* ③ 算位置：没给 from 就接在同场景上一条后面 */
      type Placed = { src: string; sceneId: string; from: number; startFrom: number; dur: number; seg: Seg; idx: number };
      const cursor = new Map<string, number>(); // sceneId -> 下一条可用的起始帧
      const placed: Placed[] = [];
      let autoScene = 0;
      staged.forEach((x, i) => {
        const pr = probes[i];
        const fileFrames = Math.max(1, Number(pr.frames) || 1);
        const startFrom = Math.max(0, Number(x.seg.startFrom ?? 0));
        // 没显式给长度：整轨切分时用「文件剩余」，否则用整个文件
        const dur =
          Number(x.seg.durationInFrames) > 0
            ? Math.round(Number(x.seg.durationInFrames))
            : Math.max(1, fileFrames - startFrom);

        let sceneId = x.seg.sceneId;
        if (!sceneId) {
          sceneId = String(scenes[Math.min(autoScene, scenes.length - 1)].id ?? "");
          autoScene++;
        }
        if (!scenes.some((s) => String(s.id ?? "") === sceneId)) {
          throw new Error(`找不到场景 ${sceneId}（现有：${scenes.map((s) => s.id).join("、")}）`);
        }
        const from =
          x.seg.from !== undefined ? Math.max(0, Math.round(Number(x.seg.from))) : (cursor.get(sceneId) ?? 0);
        cursor.set(sceneId, from + dur);
        placed.push({ src: x.src, sceneId, from, startFrom, dur, seg: x.seg, idx: i });
      });

      /* ④ 音频放不下就把这一幕延长 —— 配音是事实，画面该适配它。
       *
       * 以前不延长的话，add_element 会把 from 夹到「场景末尾-1」、把时长截断，
       * 回执却只说"已放好"，你要回读才发现音频被切短了（极难查）。 */
      const needLen = new Map<string, number>();
      for (const x of placed) {
        const end = x.from + x.dur;
        needLen.set(x.sceneId, Math.max(needLen.get(x.sceneId) ?? 0, end));
      }
      const extended: string[] = [];
      // 元素备注上限 200 字：以前是静默截断，长台词被偷偷砍掉、编辑器里对不上稿——
      // 超长就明确报出来，让 agent 精简或拆段，别硬塞
      const tooLong = placed.filter((x) => String(x.seg.text ?? "").length > 200);
      if (tooLong.length) {
        throw new Error(
          `这些旁白文案超过 200 字（音频元素备注上限）：第 ${tooLong.map((x) => x.idx + 1).join("、")} 段，` +
            `最长 ${Math.max(...tooLong.map((x) => String(x.seg.text ?? "").length))} 字。` +
            `请精简该段文字或拆成两段，再重新 register_narration`,
        );
      }
      const ops: Record<string, unknown>[] = [];
      for (const [sceneId, want] of needLen) {
        const sc = scenes.find((s) => String(s.id ?? "") === sceneId);
        const cur = Number(sc?.durationInFrames ?? 0);
        if (want > cur) {
          ops.push({ op: "update_scene", sceneId, patch: { durationInFrames: want } });
          extended.push(`第 ${scenes.findIndex((s) => String(s.id ?? "") === sceneId) + 1} 幕 ${cur} → ${want} 帧`);
        }
      }
      ops.push(...placed.map((x) => ({
        op: "add_element",
        sceneId: x.sceneId,
        element: {
          kind: "audio",
          src: x.src,
          narration: true,
          from: x.from,
          startFrom: x.startFrom,
          durationInFrames: x.dur,
          audioVolume: x.seg.volume ?? 1,
          name: x.seg.name ?? `旁白 ${x.idx + 1}`,
          ...(x.seg.text ? { text: String(x.seg.text) } : {}),
        },
      })));
      const res = await api<{ project: { rev: number } }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops }),
      });

      /* ⑤ 回执：可播链接 + 位置 + 越界提醒 */
      const lines = placed.map((x, i) => {
        const scene = scenes.find((s) => String(s.id ?? "") === x.sceneId);
        const sceneDur = Number(scene?.durationInFrames ?? 0);
        const over = x.from + x.dur > sceneDur ? `⚠️ 超出这一幕末尾 ${(x.from + x.dur - sceneDur)} 帧` : "";
        return (
          `${i + 1}. ${x.seg.text ? String(x.seg.text).slice(0, 20) + "… " : ""}${(x.dur / fps).toFixed(1)}s` +
          ` · 第 ${scenes.findIndex((s) => String(s.id ?? "") === x.sceneId) + 1} 幕 @${x.from} 帧` +
          `${x.startFrom ? `（取文件 ${x.startFrom} 帧起）` : ""} ${over}${nl}` +
          `   试听：${BASE}${x.src}`
        );
      });

      // 指纹让用户/agent 知道"听过的是哪一版"
      const fresh = await api<{ project: never }>(`/api/projects/${p.id}`);
      const { listNarrationClips, narrationFingerprint } = await import("./narration-voice.service");
      const fp = narrationFingerprint(listNarrationClips(fresh.project));

      return (
        `已登记 ${placed.length} 条旁白（rev=${res.project.rev}，整批原子）${nl}${lines.join(nl)}` +
        (extended.length ? `${nl}ℹ️ 这一幕装不下，已按音频延长：${extended.join("；")}（配音多长，幕就多长）` : "") +
        `${nl}` +
        `这一版指纹：${fp}（音频换文件 / 挪位置 / 改长度都会变，变了要重听）${nl}` +
        `${nl}⛔ **现在该做的：把上面的试听链接发给用户，等他听完。**` +
        `${nl}   他听过 → confirm_narration(userSaid="他的原话") → 才能 build_storyboard / build_film。`
      );
    },
  },
  {
    name: "confirm_narration",
    description:
      "记录「用户听过这一版配音」。**参数是用户原话，不是布尔值。\\n" +
      "两种配音来源都走这里：tts_narration 合成的，或 register_narration 登记的外部音频（真人录音 / 别的 TTS）。\\n" +
      "判定依据是**工程里那批旁白音频的指纹**：换文件 / 挪位置 / 改长度 / 整片重排导致绝对位置变化，指纹就变，必须重听。\\n" +
      "为什么不要布尔：布尔记不下「用户到底说了什么」——原话才是可对证的记录，含糊的转述会在下游被当成完全确认。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程"),
      userSaid: z
        .string()
        .min(FORCE_QUOTE_MIN)
        .describe(`用户听完之后的原话片段（至少 ${FORCE_QUOTE_MIN} 字）。不是「用户同意了」，是他实际说的那句`),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const nl = String.fromCharCode(10);

      // ① 工程里已有旁白音频（TTS 应用进场景的，或 register_narration 登记的外部音频）
      const fresh = await api<{ project: never }>(`/api/projects/${p.id}`);
      const vs = voiceHeardState(fresh.project, p.id);
      if (vs.state !== "none") {
        if (!vs.fingerprint) throw new Error("算不出这一版配音的指纹，先检查旁白音频是否完整");
        const saved = markVoiceHeard(p.id, vs.fingerprint, a.userSaid);
        await api(`/api/projects/${p.id}/decisions`, {
          method: "POST",
          body: JSON.stringify({
            kind: "narration-heard",
            userQuote: a.userSaid,
            note: `配音指纹 ${vs.fingerprint}（${vs.clips.length} 条 / 第 ${vs.clips[0].sceneIndex + 1} 幕起）`,
            meta: { fingerprint: vs.fingerprint, clips: vs.clips.length },
          }),
        });
        return (
          `已记录「用户听过这一版配音」${nl}` +
          `  原话：「${a.userSaid}」${nl}` +
          `  这一版指纹：${vs.fingerprint}（${vs.clips.length} 条旁白）${nl}` +
          `  ⚠️ 这是**你提供的记录**，工具无法验证真伪——已写进 decisions.jsonl，事后可查。${nl}` +
          `${nl}下一步：build_storyboard / build_film —— 现在可以建幕了。` +
          `${nl}（之后改音频、挪位置、改长度都会让指纹变，那时候要重新让他听）`
        );
      }

      // ② 还没有旁白音频 → 退回 TTS 骨架那条路
      const res = await api<{
        timing: { at: string; segments: unknown[]; totalSec: number; heardAt?: string; heardUserSaid?: string };
      }>(`/api/projects/${p.id}/narration-heard`, {
        method: "POST",
        body: JSON.stringify({ userSaid: a.userSaid }),
      });
      const t = res.timing;
      await api(`/api/projects/${p.id}/decisions`, {
        method: "POST",
        body: JSON.stringify({
          kind: "narration-heard",
          userQuote: a.userSaid,
          note: `配音版本 ${t.at}（${(t.segments ?? []).length} 段 / ${t.totalSec?.toFixed?.(1) ?? "?"}s）`,
          meta: { timingAt: t.at },
        }),
      });
      return (
        `已记录「用户听过这一版配音」${nl}` +
        `  原话：「${a.userSaid}」${nl}` +
        `  对应版本：${t.at}${nl}` +
        `  ⚠️ 这是**你提供的记录**，工具无法验证真伪——它会被写进 decisions.jsonl，事后可查。${nl}` +
        `${nl}下一步：save_storyboard(useNarrationTiming=true) 或 build_film —— 现在幕长可以按这版配音回填了。`
      );
    },
  },
  {
    name: "export_subtitles",
    description:
      "导出字幕（SRT / WebVTT）。字幕来源：场景的 subtitle 字段（一行一句，按字数比例分配幕内时长）；" +
      "没写 subtitle 的 caption 版式场景则用它的正文。其它版式不产生字幕。\n" +
      "用法：先 set_subtitle 给每幕写字幕，再调本工具导出。返回字幕文件路径与条目数。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      format: z.enum(["srt", "vtt"]).optional().describe("默认 srt"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const format = a.format === "vtt" ? "vtt" : "srt";
      const res = await api<any>(`/api/projects/${p.id}/subtitles`, {
        method: "POST",
        body: JSON.stringify({ format }),
      });
      const first = res.cues;
      return (
        `已导出 ${res.cues} 条字幕（${format.toUpperCase()}）：${res.filename}\n` +
        `路径：${res.file}\n` +
        `字幕条数：${first}`
      );
    },
  },
  {
    name: "set_subtitle",
    description:
      "给场景写字幕。**不用自己按行拆**：传整句/整段都行，这里会自动清标点、按语义拆成一屏一句（每屏 ≤18 字，字号大时更少），" +
      "并按字数比例分配幕内时长；返回里会列出拆成了哪几屏，够长就直接把结果发给用户核对。传空字符串清空字幕。\n" +
      "字幕上屏规则（为什么不能长）：一屏超过 18 字就读不完；标点只用来断句，不上屏。",
    shape: {
      sceneId: z.string(),
      text: z.string().describe("字幕文本：整句/整段都行（会自动拆成一屏一句并去标点）；不用自己加换行"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const scene = (p.scenes ?? []).find((x: any) => x.id === a.sceneId);
      if (!scene) throw new Error(`没有场景「${a.sceneId}」：get_project 查一下场景 id`);
      const nl = String.fromCharCode(10);

      if (!a.text.trim()) {
        const res = await api<any>(`/api/projects/${p.id}/ops`, {
          method: "POST",
          body: JSON.stringify({ actor: "agent", ops: [{ op: "set_subtitle", sceneId: a.sceneId, text: "" }] }),
        });
        return `已清空「${scene.name}」的字幕${nl}${res.summary.join(nl)}`;
      }

      const max = subtitleMaxChars(scene as any);
      const norm = normalizeSubtitle(a.text, { maxChars: max });
      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [{ op: "set_subtitle", sceneId: a.sceneId, text: subtitleToField(norm.lines) }],
        }),
      });
      const preview = norm.lines
        .map((l, i) => `  ${i + 1}. ${l}（${[...l].length} 字）`)
        .join(nl);
      return (
        `「${scene.name}」字幕已写入：${norm.lines.length} 屏（每屏 ≤ ${max} 字，${norm.before} 字→${norm.after} 字）${nl}${preview}` +
        (norm.warnings.length ? `${nl}⚠️ ${norm.warnings.join(`${nl}⚠️ `)}` : "") +
        `${nl}${res.summary.join(nl)}${nl}下一步：preview_frames 抽这一帧看一眼字幕有没有压主体/出安全区`
      );
    },
  },
  {
    name: "fix_subtitles",
    description:
      "把工程里**已存的长字幕**批量重拆成短屏：清标点、一屏 ≤18 字、过短的并句、按时长兜底。\n" +
      "用在哪：老工程 / 用户给的稿子直接塞进 subtitle / 你自己之前写长了。set_subtitle 写新的会自动拆，这个是修旧的。\n" +
      "先 dryRun=true 看会改成什么样（返回逐场景拆分预览），确认后再 apply。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      sceneIds: z.array(z.string()).optional().describe("只修这些场景；不传 = 全片所有有字幕的场景"),
      maxChars: z.number().int().min(6).max(24).optional().describe("每屏字数上限，默认 18；竖屏大字建议 12–14"),
      dryRun: z.boolean().optional().describe("只预览不写（默认 false）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const nl = String.fromCharCode(10);
      const targets = (p.scenes ?? []).filter(
        (sc: any) => (!a.sceneIds?.length || a.sceneIds.includes(sc.id)) && String(sc.subtitle ?? "").trim(),
      );
      if (!targets.length) return "没有需要处理的字幕（这些场景的 subtitle 是空的）";

      const ops: Record<string, unknown>[] = [];
      const lines: string[] = [];
      let fixed = 0;
      for (const sc of targets as any[]) {
        const max = a.maxChars ?? subtitleMaxChars(sc);
        const norm = normalizeSubtitle(String(sc.subtitle ?? ""), { maxChars: max });
        if (!norm.changed) continue;
        fixed++;
        if (lines.length < 12) {
          lines.push(
            `「${sc.name}」${norm.before} 字 → ${norm.lines.length} 屏（${norm.after} 字）：${norm.lines
              .slice(0, 4)
              .map((x) => `「${x}」`)
              .join("")}${norm.lines.length > 4 ? "…" : ""}`,
          );
        }
        ops.push({ op: "set_subtitle", sceneId: sc.id, text: subtitleToField(norm.lines) });
      }
      if (!fixed) return `检查了 ${targets.length} 个场景，字幕都已经是一屏一句，不用改 ✅`;
      if (a.dryRun) {
        return (
          `预演：${fixed}/${targets.length} 个场景的字幕要重拆（没写盘）${nl}${lines.join(nl)}` +
          `${nl}确认没问题就 fix_subtitles(dryRun=false) 落盘`
        );
      }
      await api(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops }),
      });
      return (
        `已重拆 ${fixed}/${targets.length} 个场景的字幕${nl}${lines.join(nl)}` +
        (fixed > lines.length ? `${nl}…共 ${fixed} 个场景` : "") +
        `${nl}下一步：preview_frames 抽 2–3 幕看字幕板式 → export_subtitles 核对 SRT`
      );
    },
  },
  {
    name: "get_asset_info",
    description:
      "量音频/视频素材的真实时长（秒 / 帧），并给出建议的场景时长。配音定稿后用它量每一段，再 set_scene_timing：帧数 = ceil((秒数 + 0.7) × 30)，0.7 秒是呼吸位。改过旁白必须重新量——同一段文字两次合成的时长可能不一样。支持 wav / mp3 / ogg / mp4 / m4a（读文件头算，不调外部程序）。",
    shape: {
      src: z
        .union([z.string(), z.array(z.string())])
        .describe("站内地址，如 /assets/tts-xxx.wav；可传数组一次量多段"),
      fps: z.number().optional().describe("帧率，默认 30"),
    },
    run: async (a) => {
      const srcs = Array.isArray(a.src) ? a.src : [a.src];
      if (!srcs.length) throw new Error("至少要传一个 src");
      const probes = await probeAssets(srcs, a.fps);
      const lines = probes.map((p) => {
        if (p.error) return `${p.file}：量不出来 —— ${p.error}`;
        const extra = p.sampleRate ? ` ${p.sampleRate}Hz/${p.channels}ch` : "";
        return (
          `${p.file}：${p.durationInSeconds}s ≈ ${p.frames} 帧${extra}` +
          `\n    建议场景时长 ${p.suggestedSceneFrames} 帧（含 0.7s 呼吸位）`
        );
      });
      const total = probes.reduce((s, p) => s + (p.error ? 0 : p.durationInSeconds), 0);
      return [...lines, `合计 ${Math.round(total * 100) / 100}s`].join("\n");
    },
  },
  {
    name: "set_theme",
    description:
      "整体改主题（配色/字体/圆角/动效强度）。palette 可用键：background / surface / text / textMuted / primary / secondary / accent；font 可改 heading/body 字体族。" +
      "\nmotion 是整体动效强度：0=静态（画面完全静止）、1=标准（默认）、2=更强（位移加大+轻微回弹+数字滚动更快）。" +
      "只影响入场位移/数字滚动/氛围光斑，不改版式与排版。用户嫌「太死板」就先试 2，嫌「晃」就调 0。",
    shape: {
      palette: z
        .record(z.string())
        .optional()
        .describe("只传要改的色键：background / surface / text / textMuted / primary / secondary / accent，值是 #RRGGBB"),
      font: z
        .object({ heading: z.string().optional(), body: z.string().optional() })
        .optional()
        .describe("字体族，如 { heading: 'Georgia, serif', body: 'Inter, sans-serif' }"),
      radius: z.number().optional().describe("全局圆角（短边百分比，如 2 = 2%）"),
      motion: z
        .number()
        .min(0)
        .max(2)
        .optional()
        .describe("动效强度 0=静态 / 1=标准 / 2=更强；不传保持不变"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const res = await api<any>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [{ op: "set_theme", palette: a.palette, font: a.font, radius: a.radius, motion: a.motion }],
        }),
      });
      return fmtSummary(res.summary);
    },
  },
  {
    name: "set_formats",
    description:
      "设定工程的画幅（竖屏/横屏/方形/竖版，宽高 16–7680）。**语义是「工程的画幅就是这些」**：列表里没写的画幅会被删掉——\n" +
      "用户说「只要竖屏」就只传 portrait，否则编辑器顶栏还留着横屏按钮，用户会以为你没按要求做。\n" +
      "只想改尺寸、保留其它画幅时传 merge:true。至少保留一种；删掉了哪些会写进回执。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      formats: z
        .union([
          z.string(),
          z
            .array(
              z.union([
                // 只要 write 一个 key 也行（"portrait" / "landscape" / "square" / "tall45"），
                // 宽高按预设补 —— 以前必须自己拼对象，写字符串就报 Expected object
                z.string().describe("画幅 key（同 key 预设尺寸）"),
                z.object({
                  key: z.string().describe("画幅 key：portrait / landscape / square / tall45 或自定义"),
                  label: z.string().optional().describe("显示名（如「方形 1:1」），不传沿用旧名或 key"),
                  width: z.number().int().min(16).max(7680),
                  height: z.number().int().min(16).max(7680),
                }),
              ]),
            )
            .min(1),
        ])
        .describe(
          `画幅：可传字符串数组 ["portrait"]、单个 "portrait"，或完整对象 [{key,width,height}]。已知预设：${Object.keys(FORMAT_PRESETS).join(" / ")}`,
        ),
      merge: z
        .boolean()
        .optional()
        .describe("true = 只改/加，保留没写进来的画幅（老的合并行为）；不传 = 覆盖，没写的一律删掉"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const rawList = (typeof a.formats === "string" ? [a.formats] : a.formats) as (
        | string
        | { key: string; label?: string; width: number; height: number }
      )[];
      const incoming = rawList.map((x) => {
        if (typeof x !== "string") return x;
        const preset = FORMAT_PRESETS[x];
        if (!preset) {
          throw new Error(
            `不认识的画幅简写「${x}」，可用：${Object.keys(FORMAT_PRESETS).join(" / ")}；` +
              `自定义尺寸请传 {key,width,height}`,
          );
        }
        return { key: x, ...preset };
      });
      const prev = p.formats;
      const withLabel = (u: { key: string; label?: string; width: number; height: number }) => ({
        key: u.key,
        label: u.label ?? prev.find((f) => f.key === u.key)?.label ?? u.key,
        width: u.width,
        height: u.height,
      });
      const keepOthers = a.merge === true;
      const next = keepOthers
        ? [
            ...prev.map((f) => {
              const u = incoming.find((x) => x.key === f.key);
              return u ? { ...f, width: u.width, height: u.height, label: u.label ?? f.label } : f;
            }),
            ...incoming.filter((u) => !prev.some((f) => f.key === u.key)).map(withLabel),
          ]
        : incoming.map(withLabel);

      const wanted = new Set(incoming.map((u) => u.key));
      const dropped = prev.filter((f) => !wanted.has(f.key));
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({ actor: "agent", ops: [{ op: "set_formats", formats: next }] }),
      });

      const nl = String.fromCharCode(10);
      const notes: string[] = [];
      if (!keepOthers && dropped.length) {
        notes.push(
          `已删掉画幅：${dropped.map((f) => `${f.label}（${f.key} ${f.width}×${f.height}）`).join("、")} —— 没写进 formats 的一律删掉`,
        );
      }
      if (keepOthers && dropped.length) {
        notes.push(
          `⚠️ 这几个画幅还在工程里：${dropped.map((f) => `${f.label}（${f.key}）`).join("、")}。` +
            `用户如果只要 formats 里那几版，重发一次并去掉 merge（默认就是覆盖）——不然编辑器顶栏会多出画幅，用户以为你没按要求做`,
        );
      }
      if (next.length > 1) {
        notes.push(`工程有 ${next.length} 个画幅：预览/渲染默认会一起出，验收时用户也会看到多版`);
      }
      return [fmtSummary(res.summary), ...notes].join(nl);
    },
  },
  {
    name: "preview_frame",
    description:
      "（已并入 preview_frames：单帧给 frames:[帧号]，多帧给 frames 列表）渲染指定帧为图片（默认同时出竖屏+横屏），返回图片 URL。改完务必调用它自检：检查文字溢出、重叠、被裁。",
    retiredTo: "preview_frames",
    shape: {
      frame: z.number().optional().describe("全局帧号，默认 0（给了 sceneId 时忽略）"),
      sceneId: z.string().optional().describe("按场景预览：给场景 id + offset 就不用自己算全局帧"),
      offset: z.number().optional().describe("场景内偏移（帧），配合 sceneId，默认 0"),
      formats: z.union([z.string(), z.array(z.string())]).optional().describe("画幅 key 或数组，如 \"portrait\" / [\"portrait\",\"landscape\"]；不传全部"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const target = TOOLS.find((t) => t.name === "preview_frames")!;
      const { frame, ...rest } = a;
      const out = await target.run(frame === undefined ? rest : { ...rest, frames: [frame] });
      return `（提示：「preview_frame」已并入 preview_frames——单帧写 frames:[帧号]，本次已按新工具执行，以后请直接用 preview_frames）\n${out}`;
    },
  },
  {
    name: "request_review",
    description:
      "渲染前必做：请用户到编辑器里把整片看一遍。抽帧只能查版式，查不出节奏、转场突兀、音画错位、字幕停留太短——这些只能靠整片播放。\n返回编辑器地址和「让他重点看什么」。用户看完回话后：通过 → confirm_review；要改 → confirm_review(approved=false, feedback=[...])；他自己导出 → selfRender=true。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      focus: z
        .array(z.string())
        .optional()
        .describe("这次想让他重点看什么（不传用默认四项：节奏 / 转场 / 字幕 / 音画同步）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      if (dirtySincePreview) {
        throw new Error(
          "刚改过画面还没抽帧确认：先 preview_frames 看一眼，确认改对了再请用户看整片——否则他看到的可能是改坏的那一版。",
        );
      }
      // 验收标准没定，看片就是白看：观感五项必须先齐 —— 但用户是最终裁判，
      // 他明确要直接看时不必死挡，改成显著提醒（标准的意义是让反馈可执行，不是拦人）
      const briefNow = readBrief(p.id);
      const visionMissing = stepMissingFields(11, briefNow);
      const visionNote = visionMissing.length
        ? `⚠ 观感标准没定齐（缺：${visionMissing.join("、")}）：用户看完只能说「感觉不对」，你还是不知道改哪儿。建议先 intake(11) 补齐再请他看片。`
        : "";
      markReviewRequested(p.id);
      const nl = String.fromCharCode(10);
      const sec = Math.round(totalDuration(p as never) / (p.fps || 30));
      const focus =
        a.focus?.length
          ? a.focus.join("、")
          : "节奏顺不顺（有没有拖沓或赶）/ 转场突不突兀 / 字幕有没有溢出或被裁 / 声音和画面对不对得上";
      return [
        ...(visionNote ? [visionNote] : []),
        `已记录：请用户去编辑器看工程「${p.name}」（${(p.scenes ?? []).length} 幕，约 ${sec} 秒）`,
        `编辑器：${BASE}  →  左侧工程列表选「${p.name}」（id=${p.id}），点播放整片看一遍`,
        `重点让他看：${focus}`,
        `看完三种回法：`,
        `  · 可以 → confirm_review(approved=true)`,
        `  · 要改 → confirm_review(approved=false, feedback=["第 3 幕字幕压住了二维码", "结尾太急"])——反馈逐条记，改完再请他看一次`,
        `  · 他自己在编辑器里导出 → confirm_review(approved=true, selfRender=true)，你不用再渲染`,
        `没验收过，render_video 会拒绝（用户明确让你直接渲染时传 force=true + forceUserQuote=他的原话）。`,
      ].join(nl);
    },
  },
  {
    name: "confirm_review",
    description:
      "记录用户在编辑器看片后的结论。approved=true 才允许 render_video；approved=false 时必须给 feedback（逐条记，改完要再 request_review 一次）。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      approved: z.boolean().describe("用户觉得可以吗"),
      feedback: z.array(z.string()).optional().describe("不通过时：用户提的问题，逐条记原话"),
      selfRender: z.boolean().optional().describe("用户决定自己在编辑器里导出（agent 不再渲染）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const nl = String.fromCharCode(10);
      // 用户明确 approved 后不再硬挡：用户看的就是编辑器里的最新状态，
      //「改过没抽帧」只值得提醒。真正的闸在 render_video（那边还有 force 机制兜底）。
      const dirtyNote =
        a.approved && dirtySincePreview
          ? `${nl}⚠ 提醒：验收通过后工程又改过画面且没再抽帧——若用户看的就是最新版就没问题，否则建议 preview_frames 复核一次再渲染。`
          : "";
      if (a.approved) {
        if (a.selfRender) {
          markSelfRender(p.id);
          return (
            `已记：用户自己导出（工程「${p.name}」）。${dirtyNote}` +
            `${nl}你不用渲染了；收尾可以 get_guide("memory") 做沉淀，需要时再帮他改。`
          );
        }
        const r = markReviewConfirmed(p.id, a.feedback);
        const memo = rememberDeliveryPreferences(p as never, readBrief(p.id));
        return (
          `已记：用户验收通过（${r.confirmedAt}）✅${dirtyNote}${nl}下一步：render_video（先 dryRun 预检，再正式渲染）` +
          (memo.length ? `${nl}已沉淀 ${memo.length} 条偏好（下次开工 recall 就能命中，不用再问）：${memo.join("；")}` : "")
        );
      }
      if (!a.feedback?.length) {
        throw new Error("不通过要记原因：把用户在编辑器里提的问题逐条放进 feedback（原话最好），否则改什么全靠猜");
      }
      const r = markNeedsWork(p.id, a.feedback);
      return (
        `已记 ${a.feedback.length} 条反馈（验收状态已重置）：${nl}` +
        `${(a.feedback as string[]).map((x: string, i: number) => `${i + 1}. ${x}`).join(nl)}${nl}` +
        `改完再 request_review 请他看一次——别改完直接渲染。`
      );
    },
  },
  {
    name: "get_annotations",
    description:
      "读用户在编辑器里对**某一帧**留的批注。用户看片时暂停在出问题的那一帧写原话，所以每条都带 sceneId + 幕内帧 + 时间码——比「第 3 幕有点怪」精确得多，能直接抽那一帧看。\n" +
      "用法：先读这个，再逐条 preview_frames(sceneId, frames=[幕内帧]) 看现场；改完一条就 resolve_annotation 标掉，别攒着。",
    shape: {
      projectId: z.string().optional().describe("工程 id，不传 = 当前默认工程"),
      includeResolved: z.boolean().optional().describe("连已标已修的也列出来（默认只看未解决的）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const nl = String.fromCharCode(10);
      const all = listAnnotations(p.id);
      if (!all.length) {
        return (
          `工程「${p.name}」还没有批注。` +
          `${nl}用户可以在编辑器里暂停到出问题的那一帧，点画面右上「批注」写下意见——` +
          `这样你会拿到精确到帧的定位，而不是一句"这里怪怪的"。` +
          `${nl}要请他看片就用 request_review（回执里会带上这条建议）。`
        );
      }
      const list = a.includeResolved ? all : all.filter((x) => !x.resolved);
      if (!list.length) {
        return `工程「${p.name}」的 ${all.length} 条批注都已标为已修。要复查全部传 includeResolved=true。`;
      }

      // ProjectLite 的 scenes 元素类型比 Scene 松（元素字段可选），这里只读 start/dur
      const spans = sceneSpans(p.scenes as never[]);
      const order = new Map(spans.map((sp, i) => [sp.id, i]));
      const sorted = list
        .slice()
        .sort(
          (x, y) =>
            (order.get(x.sceneId) ?? 999) - (order.get(y.sceneId) ?? 999) ||
            x.frameInScene - y.frameInScene,
        );
      const fps = p.fps || 30;
      const tc = (frame: number) => {
        const sec = frame / fps;
        return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${(sec % 60).toFixed(1).padStart(4, "0")}`;
      };
      const lines = sorted.map((x, i) => {
        const idx = order.get(x.sceneId);
        const where =
          idx === undefined
            ? `幕 ${x.sceneId}（这一幕已不存在，可能被删了）· 幕内第 ${x.frameInScene} 帧`
            : `第 ${idx + 1} 幕「${p.scenes[idx].name}」 · 全片 ${tc(spans[idx].start + x.frameInScene)}（幕内第 ${x.frameInScene} 帧）`;
        // sceneId 必须出现在回执里：preview_frames 要的就是它，别再让 agent 回头查一次
        return `${i + 1}. ${x.resolved ? "[已修] " : ""}${where}${nl}   “${x.text}”${nl}   id=${x.id} · sceneId=${x.sceneId}`;
      });
      const openCount = all.filter((x) => !x.resolved).length;
      return (
        `工程「${p.name}」有 ${openCount} 条未解决批注（共 ${all.length} 条）：${nl}${nl}` +
        lines.join(nl + nl) +
        `${nl}${nl}怎么用这些批注：` +
        `${nl}  · 每条都是"用户看着画面说的"，别自己重新理解一遍——原话里的措辞就是他要的效果` +
        `${nl}  · 看现场：preview_frames(sceneId="上面那条的 sceneId", frames=[幕内帧])，一帧就够，别抽整段` +
        `${nl}  · 改完一条就 resolve_annotation(ids=["id"]) 标掉；攒着不标，下一轮你还得重新判断改没改`
      );
    },
  },
  {
    name: "resolve_annotation",
    description:
      "把用户批注标记为已修（或恢复未解决）。改完一条就标一条——批注列表是给下一轮看的，留着没标的分不清是真没改还是改了没记账。",
    shape: {
      projectId: z.string().optional().describe("工程 id，不传 = 当前默认工程"),
      ids: z.array(z.string()).describe("批注 id 数组（get_annotations 每条末尾给）"),
      resolved: z.boolean().optional().describe("默认 true = 标记已修；传 false = 恢复未解决"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      if (!a.ids?.length) throw new Error("缺少 ids（get_annotations 回执里每条末尾那个 id=an_xxx）");
      const r = resolveAnnotations(p.id, a.ids, a.resolved !== false);
      const verb = a.resolved === false ? "恢复为未解决" : "标为已修";
      if (!r.changed) {
        return `没有改动：这 ${a.ids.length} 条 id 要么不存在，要么本来就是这个状态（剩 ${r.remaining} 条未解决）。`;
      }
      return (
        `已把 ${r.changed} 条批注${verb}，还剩 ${r.remaining} 条未解决。` +
        (r.remaining ? `${String.fromCharCode(10)}继续处理剩下的，全部标完再 request_review 请用户复查。` : "")
      );
    },
  },
  {
    name: "render_video",
    description:
      "提交渲染任务（默认把工程里所有画幅都出一版）。默认异步返回，用 get_render_status 查询；传 wait=true 会等到完成再返回（省轮询）。\n" +
      "quality 不传默认 standard；先快速看效果传 low（明显更快），正式交付用 high。\n" +
      "**渲染进度编辑器看得见**：agent 起的任务也会在编辑器顶部显示「正在渲染哪个工程 + 画幅进度」，用户不用问你。\n" +
      "formats 里写工程没有的画幅会直接报错。\n" +
      "**渲染前用户必须在编辑器里看过片**（request_review → confirm_review）；没验收会拒绝，用户明确让你直接渲染才传 force=true，**且必须带 forceUserQuote=他的原话**（否则拒绝）。",
    shape: {
      formats: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("画幅 key 或 key 数组，如 \"portrait\" 或 [\"portrait\",\"landscape\"]；不传默认全部"),
      wait: z.boolean().optional().describe("阻塞等待渲染完成（默认 false）"),
      timeoutSec: z
        .number()
        .int()
        .min(10)
        .max(240)
        .optional()
        .describe(
          "等待上限秒数，默认/最大 240。**不要指望一次等到长片渲完**：宿主请求撑不到 900s，" +
            "超时后回执会给当前进度 + 实测速率 + 建议的再查间隔，接着用 get_render_status(waitSec=25) 轮询",
        ),
      dryRun: z
        .boolean()
        .optional()
        .describe("只做预检：场景是否为空、素材文件是否存在，不提交渲染（几秒返回）"),
      force: z
        .boolean()
        .optional()
        .describe("跳过「用户已在编辑器验收」的闸口。**必须同时给 forceUserQuote**，否则拒绝"),
      forceContract: z
        .boolean()
        .optional()
        .describe("跳过「契约体检」闸口（brief 里必须出现的信息漏项 / 禁词命中）。同样要配 forceUserQuote"),
      forceUserQuote: z
        .string()
        .optional()
        .describe(
          "用户让你跳过闸口时的**原话**（至少 2 字）。不给原话，force / forceContract 一律拒绝——" +
            "留下用户原话，跳过验收才有据可查——agent 自己转述的「用户同意了」不算数",
        ),
      fileName: z
        .string()
        .optional()
        .describe(
          "自定义文件名前缀（不含画幅/时间戳/扩展名，会自动补上）。不传就用工程名。" +
            "工程名里的旧标签会误导交付（如叫「60s精华版」但实际 116 秒），这种情况建议显式给一个",
        ),
      quality: z
        .enum(["low", "standard", "high"])
        .optional()
        .describe("渲染质量，默认 standard。先快速看效果用 low（快好几倍），正式交付用 high"),
      format: z
        .enum(["mp4", "gif", "webm"])
        .optional()
        .describe("输出格式，默认 mp4。gif/webm 是特例需求才传"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const formats = typeof a.formats === "string" ? [a.formats] : a.formats;
      const nl0 = String.fromCharCode(10);

      // force 闸口：跳过验收/契约，必须有用户原话撑着（事后可对证）。
      if ((a.force || a.forceContract) && !a.dryRun) {
        const q = String(a.forceUserQuote ?? "").trim();
        if ([...q].length < FORCE_QUOTE_MIN) {
          throw new Error(
            `force / forceContract 必须带用户原话（forceUserQuote，至少 ${FORCE_QUOTE_MIN} 字）——` +
              `收到的是「${q || "(空)"}」。${nl0}` +
              `  要跳过的闸口：${[a.force ? "验收（force）" : "", a.forceContract ? "契约（forceContract）" : ""].filter(Boolean).join(" + ")}${nl0}` +
              `  该做的：把「还差什么」告诉用户，问他要不要先出片；他说了之后原样贴进来，例如 ${nl0}` +
              `    render_video(force:true, forceUserQuote:"不用看了，先渲一版给我")${nl0}` +
              `  这不是形式主义：出事之后，这一行决定了能不能查清"是不是用户让渲的"。`,
          );
        }
        await api(`/api/projects/${p.id}/decisions`, {
          method: "POST",
          body: JSON.stringify({
            kind: a.force ? "force-render" : "force-contract",
            userQuote: q,
            note: `force=${!!a.force} forceContract=${!!a.forceContract} rev=${p.rev}`,
          }),
        });
      }

      // 契约闸口：brief 里"必须出现的信息"漏了、或命中禁用词 → 拒绝渲染。
      // 这是契约能成立的唯一硬保证：没有它，mustInfo 填了也只是摆设。
      const contract = (() => {
        const b = readBrief(p.id);
        if (!b?.confirmedAt) return null;
        // 闸口只看"说了有没有做到"（mustInfo / 禁词），设计锁违约只提醒不阻断
        return auditBriefAgainstProject(b, p as never, undefined);
      })();
      if (contract?.blocking.length && !a.forceContract && !a.dryRun) {
        const nl = String.fromCharCode(10);
        throw new Error(
          `契约不通过，拒绝渲染（${contract.blocking.length} 项违约）：${nl}` +
            contract.blocking.map((x) => `  ✗ ${x}`).join(nl) +
            `${nl}这些是用户在 brief 里明确要求过的，不是风格偏好。` +
            `${nl}补齐后跑 brief_audit 复核；用户明确说「先出片再说」才传 forceContract=true，并且要附 forceUserQuote。`,
        );
      }

      if (a.dryRun) {
        const issues: string[] = [];
        if (!(p.scenes ?? []).length) issues.push("工程没有场景");
        if (contract?.blocking.length) {
          issues.push(...contract.blocking.map((x) => `⚠️ 契约：${x}（正式渲染会被拒绝）`));
        }
        // 字幕超标：渲完才发现要重拆，等于白渲一版
        const subAudit = auditSubtitles(p);
        issues.push(...subAudit.hard.map((x) => `⚠️ ${x}`), ...subAudit.issues);
        const refs = new Set<string>();
        for (const sc of p.scenes ?? []) {
          for (const el of (sc as any).elements ?? []) if (el.src) refs.add(String(el.src));
        }
        const proj = p as any;
        if (proj.audio?.src) refs.add(String(proj.audio.src));
        for (const t of proj.audioTracks ?? []) if (t?.src) refs.add(String(t.src));
        for (const src of refs) {
          if (!src.startsWith("/assets/")) continue;
          const file = path.join(ROOT, "public", src.replace(/^\/+/, ""));
          if (!fs.existsSync(file)) issues.push(`素材缺失：${src}`);
        }
        // 音频时长 > 可用空间：后面会被截断/静音，提前告警
        const audioChecks: { src: string; label: string; room: number }[] = [];
        for (const sc of p.scenes ?? []) {
          for (const el of (sc as any).elements ?? []) {
            if (el.kind === "audio" && typeof el.src === "string" && el.src.startsWith("/assets/")) {
              audioChecks.push({
                src: el.src,
                label: `场景「${sc.name}」的音频`,
                room: Math.max(1, sc.durationInFrames - (el.from ?? 0)),
              });
            }
          }
        }
        for (const t of proj.audioTracks ?? []) {
          if (typeof t?.src === "string" && t.src.startsWith("/assets/")) {
            const total = totalDuration(p as never);
            audioChecks.push({
              src: t.src,
              label: `音效轨「${t.name ?? ""}」`,
              room: Math.max(1, total - (t.from ?? 0)),
            });
          }
        }
        for (const c of audioChecks) {
          const pr = await probeOne(c.src);
          if (pr && pr.frames > c.room + 2) {
            issues.push(
              `${c.label} 只有 ${c.room} 帧可用，素材有 ${pr.frames} 帧，后面会被截断/静音`,
            );
          }
        }
        const nl = String.fromCharCode(10);
        return issues.length
          ? `预检发现 ${issues.length} 个问题：${nl}${issues.join(nl)}`
          : "预检通过：场景非空、引用的素材文件都在。可以正式渲染（去掉 dryRun）。" +
              `${nl}验收状态：${reviewToText(readReview(p.id))}`;
      }

      // 字幕超标就别渲：一屏读不完的字幕，渲出来也是废片
      if (!a.force) {
        const subHard = auditSubtitles(p).hard;
        if (subHard.length) {
          throw new Error(
            `字幕超标 ${subHard.length} 处，先修再渲：\n- ${subHard.slice(0, 4).join("\n- ")}` +
              `\n修法：fix_subtitles(dryRun=true) 看预演 → fix_subtitles 落盘 → preview_frames 复核。` +
              `\n（用户明确说「就这样渲」，才传 force=true + forceUserQuote 跳过）`,
          );
        }
      }

      // 改完没看过画面就渲染 = 把没验过的东西直接交付
      if (dirtySincePreview) {
        throw new Error(
          "刚改过画面但还没抽帧确认：先 preview_frame / preview_frames 看一眼（最好把图发给用户），再渲染。",
        );
      }

      // 渲染闸口：用户必须先在编辑器里看过整片。抽帧只能查版式，
      // 查不出节奏拖沓、转场突兀、音画错位——渲完才发现，返工比一次验收贵得多。
      const review = readReview(p.id);
      if (!a.force) {
        if (review?.selfRender) {
          throw new Error(
            "用户决定自己在编辑器里导出，agent 不该再渲染。真要你渲就 force=true + forceUserQuote（把他那句原话贴进来）。",
          );
        }
        if (!review?.confirmedAt) {
          throw new Error(
            !review?.requestedAt
              ? "还没让用户看过片：先 request_review（返回编辑器地址 + 该看什么），用户说「可以」后 confirm_review(approved=true)，再渲染。"
              : "已经请用户看过但还没回话：等他确认（confirm_review(approved=true)）再渲染；他要自己导出就 confirm_review(approved=true, selfRender=true)。",
          );
        }
      }
      const { task } = await api<any>(`/api/projects/${p.id}/render`, {
        method: "POST",
        body: JSON.stringify({ formats, quality: a.quality, format: a.format, fileName: a.fileName }),
      });
      const totalFrames = totalDuration(p as never);
      // 估算用保守速率：本机实测渲染速率波动很大（1.5–12 帧/秒，取决于素材/特效/画幅），
      // 以前写死 8.8 估「3.7 分钟」实测 12 分钟。宁长勿短，且回执里明说是粗估，
      // 第一次 get_render_status 就有实测速率，以那个为准。
      const RENDER_EST_FPS = 3;
      const estSec = Math.round((totalFrames / RENDER_EST_FPS) * (task.formats?.length ?? 1));
      const estMin = Math.max(0.3, estSec / 60);
      const multiNote =
        (task.formats?.length ?? 0) > 1
          ? " 多个画幅是逐个渲染的，每个画幅的进度百分比独立从 0 开始（进度回到小数字 = 进入下一个画幅，不是重启）。"
          : "";
      const head = `已提交渲染任务 taskId=${task.id}（${task.formats.join(" + ")}，共 ${totalFrames} 帧）。粗估约 ${estMin.toFixed(1)} 分钟（保守值，实际常快于此；以 get_render_status 的实测速率为准）。${multiNote}`;
      if (!a.wait) return `${head} 用 get_render_status(taskId=..., waitSec=25) 等它。`;

      const deadline = Date.now() + (a.timeoutSec ?? 240) * 1000;
      const nl = String.fromCharCode(10);
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        const cur = await api<any>(`/api/tasks/${task.id}`);
        const t = cur.task;
        if (t.status === "error") throw new Error(`渲染失败：${t.error ?? "未知错误"}`);
        if (t.status === "cancelled") return `${head}${nl}任务已被取消（taskId=${task.id}）。`;
        if (t.status === "done") {
          const files = (t.outputs ?? []).map(
            (o: any) =>
              `${o.format}: ${BASE}${encodeURI(o.url)}${nl}  文件：${path.join(ROOT, String(o.url).replace(/^\/+/, ""))}`,
          );
          return `${head}${nl}渲染完成：${nl}${files.join(nl)}`;
        }
      }
      // 超时不是失败：把「现在到哪了、还得多久、下次怎么问」一次说清
      const cur = await api<any>(`/api/tasks/${task.id}`).catch(() => null);
      const t = cur?.task;
      const pct = Number(t?.progress ?? 0);
      const started = Number(t?.startedAt ?? t?.createdAt ?? Date.now());
      const elapsedSec = Math.max(1, Math.round((Date.now() - started) / 1000));
      const perPercent = pct > 0 ? elapsedSec / pct : 0;
      const etaText = perPercent
        ? `实测约 ${perPercent.toFixed(1)}s/1%，剩余约 ${Math.round(perPercent * (100 - pct) / 60 * 10) / 10} 分钟`
        : "还没到 1%，暂时算不出速率";
      return (
        `${head}${nl}等待超时（${a.timeoutSec ?? 240}s），但任务还在跑：` +
        `${t?.status ?? "rendering"} ${pct}%，已跑 ${elapsedSec}s，${etaText}。` +
        `${nl}下一步：get_render_status(taskId="${task.id}", waitSec=25) —— 一次最多占 25 秒，状态一变立刻返回，` +
        `约每 25 秒问一次就够（12 分钟的片子约 30 次，别再几秒一查）。`
      );
    },
  },
  {
    name: "render_preview_clip",
    description:
      "渲一小段**带声音的动态预览**（默认 6 秒 / 半分辨率 / 含转场与 BGM），用来判断「动起来对不对」。\n" +
      "为什么需要它：静帧看不出转场叠不叠字、动画够不够、字幕来不来得及读；整片要渲十几分钟，预览片段几十秒就够。\n" +
      "所有动态问题都只能在最贵的阶段才发现（复盘里转场返工 4 轮、BGM 5 次全是这个原因）。\n" +
      "默认自动挑「第一个转场交界」（转场问题最常暴露的地方）；也可以指定 sceneIds 或帧区间。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程"),
      sceneIds: z
        .array(z.string())
        .optional()
        .describe("只看这几幕（前后各多带 1 秒）。**参数名是复数、值是数组**——只看一幕也传 [sceneId]，传 sceneId 会报错"),
      range: z
        .tuple([z.number().int(), z.number().int()])
        .optional()
        .describe("直接给帧区间 [起, 止]，给了就忽略 sceneIds"),
      seconds: z.number().optional().describe("片段时长，默认 6 秒（2–20）"),
      scale: z.number().optional().describe("分辨率比例，默认 0.5（1080×1920 → 540×960）；0.3–0.6"),
      audio: z.boolean().optional().describe("是否带音轨，默认 true —— BGM 只能听出来"),
      format: z.string().optional().describe("画幅 key，不传用工程第一个"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const scenes = p.scenes ?? [];
      if (!scenes.length) throw new Error("工程没有场景，无从预览");
      const nl = String.fromCharCode(10);
      const fps = p.fps || 30;
      const seconds = Math.min(20, Math.max(2, a.seconds ?? 6));
      const win = Math.round(seconds * fps);
      const spans = sceneSpans(scenes as never[]);
      const total = totalDuration(p as never);

      // 选段逻辑抽在 shared/previewWindow.ts（纯函数、可单测）：选错了会给人假安心
      const pick = pickPreviewRange({
        scenes: scenes as never[],
        spans: spans as never[],
        totalFrames: total,
        fps,
        seconds,
        range: a.range as [number, number] | undefined,
        sceneIds: a.sceneIds,
      });
      const start = pick.start;
      const end = pick.end;
      const reason = pick.reason;

      /**
       * 时长预算（2026-10-31 实测，见文档附录 B-1）：
       * 半分辨率预览本机稳定 11–12 帧/秒，**且与 scale 几乎无关**（0.5→0.3 只快 6%），
       * 因为瓶颈在 React 排版与音频，不在像素。所以唯一有效的杠杆是帧数。
       * 这个调用是同步的：整段渲完才回话，宿主请求等不了太久 —— 超过 ~45 秒宁可先说清楚。
       */
      const PREVIEW_FPS = 11;
      const estSec = Math.round((end - start + 1) / PREVIEW_FPS + 2);
      if (estSec > 45) {
        throw new Error(
          `这段 ${((end - start + 1) / fps).toFixed(1)} 秒要渲约 ${estSec} 秒才出得来，同步请求等不及（宿主会先断）。\n` +
            `调小分辨率没用：实测 0.5→0.3 只快 6%，瓶颈在排版与音频。\n` +
            `改用：① 缩短片段（seconds ≤ 15，约 40 秒出片）② 分两段看：range=[a,b] / range=[b,c]。`,
        );
      }

      const res = await api<{
        clip: {
          url: string;
          localPath: string;
          startFrame: number;
          endFrame: number;
          sections: number;
          scale: number;
          withAudio: boolean;
          bundleMs: number;
          renderMs: number;
        };
      }>(`/api/projects/${p.id}/preview-clip`, {
        method: "POST",
        body: JSON.stringify({
          startFrame: start,
          endFrame: end,
          format: a.format,
          scale: a.scale,
          audio: a.audio,
          tag: "preview",
        }),
      });
      const c = res.clip;

      // 这段里能看到什么：转场数 / 字幕句数 / 有没有音轨
      const inRange = scenes
        .map((sc, i) => ({ sc, sp: spans[i] }))
        .filter((x) => x.sp && x.sp.start < c.endFrame && x.sp.end > c.startFrame);
      const seams = inRange.filter((x) => {
        const t = (x.sc as { transitionIn?: { type?: string } | null }).transitionIn;
        return t && t.type && t.type !== "none";
      }).length;
      const subLines = inRange.reduce((n, x) => {
        const sub = String((x.sc as { subtitle?: string }).subtitle ?? "").trim();
        return n + (sub ? sub.split(/\r?\n/).filter((l: string) => l.trim()).length : 0);
      }, 0);
      const hasAudio =
        !!p.audio?.src ||
        scenes.some((sc) =>
          ((sc as { elements?: { kind?: string }[] }).elements ?? []).some((e) => e.kind === "audio"),
        );

      const dur = ((c.endFrame - c.startFrame + 1) / fps).toFixed(1);
      /**
       * 头部这行必须和下面「这段里有」一致。
       * c.withAudio 是**请求**（用户没关音轨），不是事实：工程里一个音频都没有时，
       * 渲出来是条空轨，还写「带音轨」会让人以为有声，等听到才发现白等一轮。
       */
      const audioHead = c.withAudio
        ? hasAudio
          ? "带音轨"
          : "静音（工程里还没有音频）"
        : "静音";
      /** 问哪几条要看这段里真有什么：没字幕还问「字幕来得及读吗」是空问题 */
      const askList = [
        "① 转场刺不刺眼 / 有没有两幕文字叠在一起",
        subLines > 0
          ? "② 字幕来得及读完吗（尤其念得快的那几句）"
          : "② 该有字的地方有没有空着（这版一幕字幕都没写）",
        hasAudio ? "③ BGM 压过人声没有" : null,
      ]
        .filter(Boolean)
        .join(`${nl}  `);
      return (
        `预览片段：${dur}s · ${Math.round((c.scale * 100))}% 分辨率 · ${audioHead} · ${c.sections} 帧` +
        `${nl}地址：${BASE}${c.url}` +
        `${nl}本地：${c.localPath}` +
        `${nl}渲染 ${(c.renderMs / 1000).toFixed(1)}s（预估 ${estSec}s）${c.bundleMs > 800 ? `（含打包 ${(c.bundleMs / 1000).toFixed(1)}s）` : ""}` +
        `${nl}选取理由：${reason}` +
        `${nl}这段里有：${seams} 个转场、${subLines} 句字幕${hasAudio ? "、有音轨" : "、没有音轨"}` +
        `${nl}${nl}**把链接发给用户，按这几条问**（问多了他答不清）：` +
        `${nl}  ${askList}` +
        `${nl}这些在这一段里全能判断，别等到整片。`
      );
    },
  },
  {
    name: "preview_frames",
    description:
      "渲染帧为图片（1–8 帧），返回各帧 URL。改完排版抽 2–3 帧一起看。三种用法：\n" +
      "① 全局帧：frames:[90,210]（不带 sceneId）；\n" +
      "② 某一幕内部：sceneId + frames:[90,210]（**此时 frames 是该幕内的帧号**，不用换算全局）或 sceneId+offset（单帧快捷）；\n" +
      '③ 转场交界：around="transitions" 自动取每幕交界前后几帧。\n' +
      "⚠️ 别只抽第 0 帧——文字入场动画从 0 开始，第 0 帧经常是空背景；要等动画落定的帧（如幕内 60% 处）。",
    shape: {
      frames: z
        .array(z.number())
        .min(1)
        .max(8)
        .optional()
        .describe("帧号列表（1–8 个）。给了 sceneId 就是**该幕内的帧号**，不给是全片全局帧号"),
      sceneId: z
        .string()
        .optional()
        .describe("按哪一幕预览。给了它，frames 按「该幕内帧号」换算；配合 offset 是单帧快捷方式"),
      offset: z.number().optional().describe("场景内偏移（帧），配合 sceneId，默认 0"),
      around: z
        .enum(["transitions"])
        .optional()
        .describe("转场预览：自动取每幕交界前后几帧（最多 8 张）——转场只发生在交界那几帧，单帧抽不到"),
      formats: z.union([z.string(), z.array(z.string())]).optional().describe("画幅 key 或数组，如 \"portrait\" / [\"portrait\",\"landscape\"]；不传全部"),
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const nl = String.fromCharCode(10);
      const lines: string[] = [];
      let frames = a.frames ?? [];
      if (a.sceneId) {
        const idx = (p.scenes ?? []).findIndex((x: any) => x.id === a.sceneId);
        if (idx < 0) throw new Error(`没有场景 ${a.sceneId}`);
        // 多轨之后起点不再等于"前序时长之和"，必须走 sceneSpans（否则画中画会预览到别处）
        const span = sceneSpans(p.scenes as any[])[idx];
        const dur = span?.dur ?? (p.scenes as any[])[idx].durationInFrames;
        const clamp = (f: number) => Math.max(0, Math.min(dur - 1, f));
        if (a.frames?.length) {
          // sceneId + frames = 该幕内的帧号（agent 的自然直觉，实测就是这么传的——
          // 以前这里直接用 frames 覆盖成 [起点+offset]，传的帧被静默丢掉只回第 0 帧）
          frames = a.frames.map((f: number) => (span?.start ?? 0) + clamp(f));
        } else {
          const off = Math.max(0, Math.min(dur - 1, a.offset ?? 0));
          frames = [(span?.start ?? 0) + off];
        }
      }
      if (a.around === "transitions") {
        // 每幕交界前后各取几帧：转场只在交界那 8–22 帧里，静态单帧永远看不到
        const spans = sceneSpans(p.scenes as any[]);
        const bounds = spans.slice(1).map((sp) => sp.start);
        if (!bounds.length) throw new Error("只有一幕，没有转场可看");
        const picks: number[] = [];
        for (const b of bounds) {
          for (const d of [-6, -1, 8]) {
            const f = b + d;
            if (f >= 0 && !picks.includes(f)) picks.push(f);
          }
        }
        frames = picks.slice(0, 8);
        if (picks.length > 8) {
          lines.push(`（全片 ${bounds.length} 处交界共 ${picks.length} 帧，先看前 8 帧；要具体哪处就用 frames 指定）`);
        }
      }
      if (!frames.length) throw new Error('给 frames 列表（单帧 frames:[帧号]）、sceneId+offset，或 around="transitions" 自动取交界帧');
      for (const f of frames) {
        const res = await api<{ stills: { format: string; url: string }[] }>(
          `/api/projects/${p.id}/stills`,
          {
            method: "POST",
            body: JSON.stringify({ frame: f, formats: a.formats }),
          },
        );
        lines.push(
          `第 ${f} 帧：` +
            res.stills
              .map(
                (s: { format: string; url: string }) =>
                  `${s.format} ${BASE}${encodeURI(s.url)}（本地：${path.join(ROOT, String(s.url).split("?")[0].replace(/^\/+/, ""))}）`,
              )
              .join(" | "),
        );
      }
      clearDirty();
      return lines.join(nl);
    },
  },
  {
    name: "render_cover",
    description:
      "导出封面候选图：把某一帧渲染成 PNG，作为信息流封面或给用户挑。\n" +
      "**不传 frame 时取指定幕（默认首幕）的 80% 处**（文字入场动画到这时已落定）——抽第 0 帧经常是纯背景，封面是空的。\n" +
      "最佳封面常常不在片头：数据页/结论页往往更抓人，用 fromScene 指定某一幕（id / 序号 / 名字）。\n" +
      "封面经常不该等于片头第一帧：要单独设计就先改那幕文案、或另建一幕当封面再抽（brief.cover 写要求）。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      frame: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("用第几帧当封面；不传 = 指定幕（默认首幕）的 80% 处（动画落定后，避免空白封面）"),
      fromScene: z
        .union([z.string(), z.number()])
        .optional()
        .describe(
          "从哪一幕取封面：场景 id、1-based 序号、或场景名（包含即可）。不传 = 首幕。" +
            "封面的最佳帧常常在数据页/结论页而不是片头，别默认只用第一幕",
        ),
      formats: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("画幅 key 或数组；不传全部"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const spans = sceneSpans(p.scenes as any[]);
      const scenes = (p.scenes ?? []) as { id: string; name?: string }[];
      let idx = 0;
      if (a.fromScene !== undefined) {
        const key = String(a.fromScene).trim();
        const byId = scenes.findIndex((s) => s.id === key);
        const byNum = /^\d+$/.test(key) ? Number(key) - 1 : -1;
        idx =
          byId >= 0
            ? byId
            : byNum >= 0 && byNum < scenes.length
              ? byNum
              : scenes.findIndex((s) => String(s.name ?? "").includes(key));
        if (idx < 0) {
          throw new Error(
            `没有匹配 fromScene="${a.fromScene}" 的场景。可用：` +
              scenes.map((s, i) => `${i + 1}. ${s.name ?? ""}（${s.id}）`).join("；"),
          );
        }
      }
      const span = spans[idx];
      const autoFrame = span ? span.start + Math.max(0, Math.round(span.dur * 0.8)) : 0;
      const frame = a.frame ?? autoFrame;
      const autoNote =
        a.frame !== undefined
          ? ""
          : `（未指定帧号，自动取第 ${idx + 1} 幕「${scenes[idx]?.name ?? ""}」80% 处第 ${frame} 帧：文字入场动画到这时已落定；要别的帧就传 frame，要别幕就传 fromScene）`;
      const brief = readBrief(p.id);
      const res = await api<{ stills: { format: string; url: string }[] }>(
        `/api/projects/${p.id}/stills`,
        // purpose=cover：落到 covers/，产物面板里能认出来这是封面而不是关键帧
        { method: "POST", body: JSON.stringify({ frame, formats: a.formats, purpose: "cover" }) },
      );
      const nl = String.fromCharCode(10);
      const files = res.stills.map(
        (x) => `${x.format}: ${BASE}${encodeURI(x.url)}${nl}  文件：${path.join(ROOT, String(x.url).split("?")[0].replace(/^\/+/, ""))}`,
      );
      clearDirty();
      return (
        `封面候选（第 ${frame} 帧）：${nl}${files.join(nl)}${autoNote ? `${nl}${autoNote}` : ""}` +
        (brief?.cover
          ? `${nl}封面要求（brief.cover）：${brief.cover}`
          : `${nl}⚠️ brief 里还没写封面要求：intake(11) 问一句「用片头第一帧还是单独做一张，封面文案是什么」`) +
        `${nl}下一步：把图发给用户挑；要单独设计封面，就改首幕文案或另建一幕专门做封面，再 render_cover 抽一次`
      );
    },
  },
  {
    name: "get_render_status",
    description:
      "查询渲染任务状态。**传 waitSec 会占住最多这么多秒等状态变化**（长轮询）：状态一变立刻返回，" +
      "所以 12 分钟的片子用 waitSec=25 约 30 次就够，而不是每几秒盲查一次（白耗轮次）。\n" +
      "不传 taskId 时：给 projectId 看该工程最近一条任务；都不给则列出全部任务。",
    shape: {
      taskId: z.string().optional().describe("任务 id（render_video 回执里给的）"),
      projectId: z.string().optional().describe("不知道 taskId 时按工程查（取该工程最近一条任务）"),
      waitSec: z
        .number()
        .int()
        .min(0)
        .max(60)
        .optional()
        .describe("长轮询秒数：0 = 立刻返回快照（默认）；建议 25 —— 别超过宿主的请求时限"),
    },
    run: async (a) => {
      const nl = String.fromCharCode(10);
      let taskId = a.taskId;

      if (!taskId && a.projectId) {
        const p = await resolveProject(a.projectId);
        const { tasks } = await api<{ tasks: any[] }>("/api/tasks");
        const latest = tasks.find((t) => t.projectId === p.id);
        if (!latest) return `工程「${p.name}」还没有渲染任务（render_video 提交后才有）`;
        taskId = latest.id;
      }

      if (!taskId) {
        const { tasks } = await api<{ tasks: any[] }>("/api/tasks");
        if (!tasks.length) return "没有渲染任务";
        return tasks
          .map(
            (t) =>
              `${t.id} ${t.status} ${t.progress}% (${t.formats.join("+")})` +
              (t.projectName ? ` — ${t.projectName}` : "") +
              (t.error ? ` 【${t.error}】` : ""),
          )
          .join("\n");
      }

      // 长轮询：状态一变立即返回，最长占 waitSec 秒
      const deadline = Date.now() + (a.waitSec ?? 0) * 1000;
      let task: any = null;
      for (;;) {
        const cur = await api<any>(`/api/tasks/${taskId}`);
        task = cur.task;
        const terminal = task.status === "done" || task.status === "error" || task.status === "cancelled";
        if (terminal || Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, 600));
      }

      const files = (task.outputs ?? []).map(
        (o: any) =>
          `${o.format}: ${BASE}${encodeURI(o.url)}${nl}  文件：${path.join(ROOT, String(o.url).replace(/^\/+/, ""))}`,
      );
      const started = Number(task.startedAt ?? task.createdAt ?? Date.now());
      const elapsedSec = Math.max(0, Math.round((Date.now() - started) / 1000));
      const pct = Number(task.progress ?? 0);
      const perPercent = pct > 0 && elapsedSec > 0 ? elapsedSec / pct : 0;
      const etaLine =
        task.status === "rendering" && perPercent
          ? `${nl}已跑 ${elapsedSec}s，实测约 ${perPercent.toFixed(1)}s/1%，剩余约 ${(perPercent * (100 - pct) / 60).toFixed(1)} 分钟`
          : elapsedSec
            ? `${nl}耗时 ${elapsedSec}s`
            : "";
      const hint =
        task.status === "done" || task.status === "error" || task.status === "cancelled"
          ? ""
          : `${nl}还没结束：再调 get_render_status(taskId="${task.id}", waitSec=25)（状态一变会立刻返回，不用几秒一查）`;
      return (
        `${task.status} ${pct}%${task.currentFormat ? `（当前画幅 ${task.currentFormat}）` : ""}` +
        `${elapsedSec ? ` · ${elapsedSec}s` : ""}${etaLine}` +
        `${files.length ? `${nl}${files.join(nl)}` : ""}` +
        `${task.error ? `${nl}错误：${task.error}` : ""}${hint}`
      );
    },
  },
  {
    name: "cancel_render",
    description:
      "取消正在排队或渲染中的任务。taskId 来自 render_video / render_preview_clip 的回执或 get_render_status 的任务列表。已结束的任务会返回提示，不报错。",
    shape: { taskId: z.string() },
    run: async (a) => {
      try {
        await api(`/api/tasks/${a.taskId}/cancel`, { method: "POST" });
        return `已取消任务 ${a.taskId}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `未取消：${msg}`;
      }
    },
  },

  {
    name: "cleanup_renders",
    description:
      "清理渲染产物（out/projects/<工程id>/ 下按工程分目录）：每个工程保留最近 N 个成片（默认 5），关键帧与字幕按天数清（默认 7 天）；工程已删除的产物目录会整块收掉。dryRun=true 只统计不删除。用户说\"磁盘满了 / 清理一下旧视频\"时用。",
    shape: {
      projectId: z.string().optional().describe("只清这个工程，不传 = 所有工程"),
      keepVideos: z.number().int().min(1).max(50).optional().describe("每个工程保留几个成片，默认 5"),
      stillsDays: z.number().int().min(0).max(365).optional().describe("关键帧/字幕保留天数，默认 7"),
      dryRun: z.boolean().optional().describe("只统计不删"),
    },
    run: async (a) => {
      const r = await api<{
        scanned: number;
        removedFiles: number;
        removedVideos: number;
        removedStills: number;
        removedSubtitles: number;
        removedCovers: number;
        skippedLocked: number;
        removedOrphanDirs: number;
        removedLegacy: number;
        freedBytes: number;
        keptVideos: number;
        dryRun: boolean;
      }>("/api/outputs/cleanup", { method: "POST", body: JSON.stringify(a) });
      const nl = String.fromCharCode(10);
      const mb = (r.freedBytes / 1024 / 1024).toFixed(1);
      const parts = [
        `${r.removedVideos} 个成片`,
        `${r.removedStills} 张关键帧`,
        ...(r.removedCovers ? [`${r.removedCovers} 张封面`] : []),
        ...(r.removedSubtitles ? [`${r.removedSubtitles} 个字幕`] : []),
      ].join(" + ");
      const notes = [
        r.removedOrphanDirs ? `工程已删的产物目录 ${r.removedOrphanDirs} 个（整块收掉）` : "",
        r.removedLegacy ? `旧版扁平目录残留 ${r.removedLegacy} 个文件` : "",
        // 锁定的不删是有意的：用户标了"这条别删"，就该一直留着
        r.skippedLocked ? `${r.skippedLocked} 个已锁定的产物跳过没删` : "",
      ].filter(Boolean);
      return (
        (r.dryRun
          ? `扫描 ${r.scanned} 个产物：可清理 ${parts}，约 ${mb} MB（dryRun，未删除）`
          : `已清理 ${r.removedFiles} 个旧产物（${parts}），释放 ${mb} MB；每个工程保留 ${r.keptVideos} 个成片`) +
        (notes.length ? `${nl}另外：${notes.join("；")}` : "")
      );
    },
  },

  {
    name: "refresh_bundle",
    description:
      "重建渲染用的打包快照。平时**不需要**——每次渲染前都会把 public/ 里新增的素材（TTS 音频、上传的图）自动同步进快照，所以不需要为了素材重启服务。只在改了打包配置、或怀疑快照坏了的时候用；会阻塞十几秒。",
    shape: {},
    run: async () => {
      const r = await api<{ serveUrl: string; bundle: { done: boolean; progress: number } }>(
        "/api/bundle/refresh",
        { method: "POST" },
      );
      return `已重建渲染快照（打包 ${r.bundle.done ? "完成" : "进行中"}）。之后出片用的是最新快照。`;
    },
  },

  /* ────────────────────────── 自由元素（贴纸 / 图标 / 标签 / 图片） ────────────────────────── */

  {
    name: "upload_asset",
    description:
      "把本机文件（图片 / 音频 / 视频）上传，返回站内地址。\n" +
      "**两种归宿**：registerToLibrary:true（默认）→ 进「我的素材」库（assets/library/，跨工程复用、删工程不动它）；\n" +
      "false → 进**本工程素材目录**（assets/projects/<工程id>/，删工程时一起清掉）。\n" +
      "只是这一支片子用一次的素材（生成的图 / 配音）建议 false；想反复用就入库存。\n" +
      "path 给本机绝对路径即可（反斜杠要写成 \\\\ 或用正斜杠）；文件不存在/是目录/空文件/超 40MB 会直接说清原因并给出同目录里名字相近的候选。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      path: z.string().describe("本机绝对路径，如 D:/tmp/icon.png"),
      name: z.string().optional().describe("素材名，不传就用文件名"),
      registerToLibrary: z
        .boolean()
        .optional()
        .describe("true（默认）= 进「我的素材」库；false = 只进本工程素材目录（随工程删除）"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      // 路径解析统一走 server/upload-path.ts：不存在 / 是目录 / 空文件 / 超大 / 没权限
      // 各自给不同的下一步（以前直接 readFile，抛一句裸 ENOENT，agent 只能反复换写法重试）
      const file = loadUploadFile(a.path);
      const buf = file.buf;
      const base = file.name;
      const toLibrary = a.registerToLibrary ?? true;

      await ensureServer();
      if (toLibrary) {
        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(buf)]), base);
        if (a.name) form.append("name", a.name);
        const res = await fetch(`${BASE}/api/library`, { method: "POST", body: form });
        const data = (await res.json()) as { item?: CustomAsset; error?: string };
        if (!res.ok || !data.item) throw new Error(data.error ?? `HTTP ${res.status}`);
        return (
          `已入库：${data.item.name}（${data.item.kind ?? "文件"}）\n素材 id：asset:${data.item.id}\n` +
          `地址：${data.item.url}（在 assets/library/，删工程不会带走它）\n` +
          `用 add_element 放上画面：libraryId = "asset:${data.item.id}"`
        );
      }
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(buf)]), base);
      const res = await fetch(`${BASE}/api/projects/${p.id}/assets`, { method: "POST", body: form });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) throw new Error(data.error ?? `HTTP ${res.status}`);
      return (
        `已放进工程「${p.name}」的素材目录：${data.url}（${(buf.length / 1024).toFixed(0)}KB）\n` +
        `位于 assets/projects/${p.id}/，删这个工程会一起清掉；` +
        `想跨工程复用就传 registerToLibrary:true（默认就是）`
      );
    },
  },

  {
    name: "list_assets",
    description:
      "列素材。scope=\"library\"（默认）：跨工程复用的「我的素材」库（assets/library/）；scope=\"project\"：**本工程自己的素材目录**（assets/projects/<工程id>/，删工程时会被清掉）。\n" +
      "带 id、类型、大小/时长、是否被引用。最新的在前。",
    shape: {
      scope: z.enum(["library", "project"]).optional().describe("library=共用库（默认），project=本工程素材目录"),
      query: z.string().optional().describe("按名字过滤（包含即可）"),
      kind: z.enum(["image", "video", "audio", "file"]).optional().describe("只列某一类"),
      limit: z.number().int().min(1).max(500).optional().describe("最多返回条数，默认 100"),
      projectId: z.string().optional().describe("scope=project 时要看的工程 id，不传 = 当前默认工程"),
    },
    run: async (a) => {
      if (a.scope === "project") {
        const p = await resolveProject(a.projectId);
        const { items } = await api<{ items: ProjectAssetLite[] }>(`/api/projects/${p.id}/assets`);
        const q = (a.query ?? "").trim().toLowerCase();
        const list = (items ?? [])
          .filter((x) => !a.kind || x.kind === a.kind)
          .filter((x) => !q || x.name.toLowerCase().includes(q));
        if (!list.length) {
          return (
            `「${p.name}」的素材目录是空的（assets/projects/${p.id}/）。\n` +
            `上传：upload_asset(path, registerToLibrary:false)；共用素材放库：upload_asset(path)`
          );
        }
        const lines = list.map(
          (x) =>
            `- ${x.name}（${x.kind}，${formatBytes(x.bytes)}）→ ${x.url}` +
            (x.referenced ? "  · 工程正在用" : "  · 未被引用"),
        );
        return (
          `「${p.name}」的素材目录：${list.length} 个文件\n` +
          lines.join("\n") +
          `\n（删工程时这个目录会被清掉；要跨工程复用请入「我的素材」库）`
        );
      }
      const { items } = await api<{ items: any[] }>("/api/library");
      const q = (a.query ?? "").trim().toLowerCase();
      // 先过滤再截断：以前先 slice 后过滤，「按名字找」会把更早的匹配项一起藏掉
      const matched = items
        .filter((x) => !a.kind || x.kind === a.kind)
        .filter((x) => !q || String(x.name ?? "").toLowerCase().includes(q));
      const limit = a.limit ?? 100;
      const list = matched.slice(0, limit);
      if (!list.length) {
        return q
          ? `没有匹配「${q}」的素材（库里共 ${items.length} 条；用 list_assets 不带 query 看全部）`
          : "没有匹配的素材。";
      }
      const lines = list
        .map(
          (x) =>
            `- ${x.id}（${x.kind ?? "image"}）${x.name}${x.duration ? ` · ${x.duration.toFixed(1)}s` : ""} → ${x.url}`,
        )
        .join("\n");
      const more =
        matched.length > list.length
          ? `\n（匹配 ${matched.length} 条，只显示最新的 ${list.length} 条；用 query 缩小范围或调大 limit，上限 500）`
          : "";
      return lines + more;
    },
  },

  /* ─────────────────── 本工程素材目录（assets/projects/<id>/） ─────────────────── */

  {
    name: "list_project_assets",
    description:
      "（已并入 list_assets：scope=\"project\" 看本工程目录，默认 scope=\"library\" 看共用库）列出**本工程自己的素材目录**（assets/projects/<工程id>/）。这里的文件只属于这个工程，删工程时会被一起清掉。",
    retiredTo: "list_assets",
    shape: {
      projectId: z.string().optional().describe("工程 id，不传 = 当前默认工程"),
      query: z.string().optional().describe("按文件名过滤（包含即可）"),
      kind: z.enum(["image", "video", "audio", "file"]).optional().describe("只列某一类"),
    },
    run: async (a) => {
      const target = TOOLS.find((t) => t.name === "list_assets")!;
      const out = await target.run({ ...a, scope: "project" });
      return `（提示：「list_project_assets」已并入 list_assets——本工程目录传 scope:"project"，本次已按新工具执行，以后请直接用 list_assets）\n${out}`;
    },
  },
  {
    name: "delete_project_asset",
    description:
      "删**本工程素材目录**里的一个文件（assets/projects/<工程id>/）。\n" +
      "只能删本工程的，别的工程/共用库里的碰不到。文件仍被工程引用时会在回执里提示——" +
      "删之前先用 list_project_assets 看「工程正在用」。",
    shape: {
      projectId: z.string().optional().describe("工程 id，不传 = 当前默认工程"),
      url: z.string().optional().describe("文件地址 /assets/projects/<id>/x.png（与 name 二选一）"),
      name: z.string().optional().describe("文件名，如 1712abcd-xy1z.png"),
    },
    run: async (a) => {
      if (!a.url && !a.name) throw new Error("给 url=/assets/projects/<id>/x.png 或 name=<文件名>");
      const p = await resolveProject(a.projectId);
      const q = a.url ? `url=${encodeURIComponent(a.url)}` : `name=${encodeURIComponent(a.name as string)}`;
      const res = await api<{ ok?: boolean; rel?: string; wasReferenced?: boolean }>(
        `/api/projects/${p.id}/assets?${q}`,
        { method: "DELETE" },
      );
      return (
        `已删除 ${res.rel}` +
        (res.wasReferenced
          ? `\n⚠ 这个文件**之前仍被工程引用**，画面里用到它的元素现在会裂图——记得改掉引用或重传`
          : "")
      );
    },
  },
  {
    name: "organize_assets",
    description:
      "一次性整理旧版散在 `public/assets/` 根目录里的文件：按「谁在引用」搬进对应工程目录或 library/，\n" +
      "并同步改写 project.json 与素材库索引里的 URL（不搬就裂图）。\n" +
      "**默认 dryRun=true 只出方案**，你看过再传 dryRun:false 真正执行。被多个工程共用的文件进 library/。",
    shape: {
      dryRun: z.boolean().optional().describe("默认 true：只出方案不动文件；false 才真的搬 + 改写"),
    },
    run: async (a) => {
      await ensureServer();
      const dryRun = a.dryRun !== false;
      const { result } = await api<{ result: OrganizeResultLite }>("/api/assets/organize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun }),
      });
      const nl = String.fromCharCode(10);
      const head = dryRun
        ? `整理方案（dryRun，未改动任何文件）`
        : `整理完成（已搬 ${result.moves.length} 个文件）`;
      const moveLines = result.moves
        .slice(0, 30)
        .map((m) => `- ${m.from} → ${m.to}（${formatBytes(m.bytes)}，${m.reason}）`)
        .join(nl);
      const moreMoves =
        result.moves.length > 30 ? `${nl}…另有 ${result.moves.length - 30} 个` : "";
      const rewriteLines = result.rewrites.length
        ? `${nl}改写了 ${result.rewrites.length} 个工程的引用：` +
          result.rewrites.map((r) => `${r.name}（${r.changed} 处）`).join("、")
        : "";
      const libLines = result.libraryUpdated.length
        ? `${nl}改写素材库 ${result.libraryUpdated.length} 条（${result.libraryUpdated.map((r) => r.name).join("、")}）`
        : "";
      const skipLines = result.skipped.length
        ? `${nl}跳过 ${result.skipped.length} 个：` +
          result.skipped
            .slice(0, 10)
            .map((s) => `${s.rel}（${s.reason}）`)
            .join("、")
        : "";
      return (
        `${head}：可搬 ${result.moves.length} 个，跳过 ${result.skipped.length} 个` +
        (result.moves.length ? `${nl}${moveLines}${moreMoves}` : "") +
        rewriteLines +
        libLines +
        skipLines +
        (result.libraryMissing
          ? `${nl}⚠ 素材库里有 ${result.libraryMissing} 条指向的文件已经不存在（点开会是空图）；` +
            `确认不要了就 delete_asset 逐条删掉`
          : "") +
        (dryRun ? `${nl}确认没问题后调 organize_assets(dryRun:false)` : "")
      );
    },
  },
  {
    name: "rename_asset",
    description: "给「我的素材」改名（只改显示名，不影响文件与已引用它的工程）。",
    shape: {
      id: z.string().optional().describe("素材 id（list_assets 里能看到；带不带 asset: 前缀都认）"),
      assetId: z.string().optional().describe("同 id（别名，delete_asset 用的是这个名字）"),
      name: z.string().describe("新名字"),
    },
    run: async (a) => {
      const raw = a.id ?? a.assetId;
      if (!raw) throw new Error("缺少 id（素材 id，list_assets 里查；也认 assetId）");
      // 带不带 asset: 前缀都认（upload_asset 回执给的是带前缀的）
      const id = toAssetId(raw);
      const { item } = await api<{ item: any }>(`/api/library/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: a.name }),
      });
      return `已改名：${item.name}`;
    },
  },
  {
    name: "list_element_library",
    description:
      "列出可用的元素素材：内置素材库（图标 / 形状 / 标签）+「我的素材」里已入库的图片。拿到 id 后用 add_element 的 libraryId 放进场景。两边都没有合适的，可以直接用 add_element 的 svg / text / imageSrc 自己造。",
    shape: { category: z.string().optional().describe("按分类筛选：标记 / 箭头 / 形状 / 符号 / 标签") },
    run: async (a) => {
      await ensureServer();
      const lines: string[] = [];
      const items = ELEMENT_LIBRARY.filter((i) => !a.category || i.cat === a.category);
      if (items.length) {
        const cats = [...new Set(items.map((i) => i.cat))];
        lines.push(
          cats
            .map(
              (c) =>
                `【${c}】\n` +
                items
                  .filter((i) => i.cat === c)
                  .map((i) => `  ${i.id} · ${i.name}（默认尺寸 ${i.size}%）`)
                  .join("\n"),
            )
            .join("\n"),
        );
      } else if (a.category) {
        lines.push(`内置库里没有分类「${a.category}」`);
      }

      const res = await fetch(`${BASE}/api/library`);
      const data = (await res.json()) as { items?: CustomAsset[] };
      const mine = data.items ?? [];
      if (mine.length) {
        lines.push(
          `【我的素材】\n` +
            mine.map((x) => `  asset:${x.id} · ${x.name}${x.w ? `（${x.w}×${x.h}）` : ""}`).join("\n"),
        );
      } else {
        lines.push("【我的素材】空 —— upload_asset 传图片即可入库");
      }
      return lines.join("\n\n");
    },
  },
  {
    name: "add_element",
    description:
      "往场景里放一个自由元素（贴纸 / 图标 / 标签 / 图片 / 视频 / 音频）。可以用 libraryId 取素材库现成的，也可以自己给 svg（矢量）、text（文字）、imageSrc（图片）、videoSrc（视频）、audioSrc（音频）——素材库没有合适的就自己造。放进去之后用户可以正常拖动/旋转/缩放/删除。视频默认有声、不循环；音频/视频没给 durationInFrames 会按素材真实时长。支持背景色 bg、入场 enter / 出场 exit 特效、场景内时间 from / durationInFrames。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      sceneId: z.string().optional().describe("放到哪个场景；不传就用第一个场景"),
      libraryId: z
        .string()
        .optional()
        .describe("素材 id：内置素材见 list_element_library；我的图片素材形如 asset:<id>"),
      svg: z
        .string()
        .optional()
        .describe('自定义矢量：SVG 内部标记，如 <path d="M2 12h20" stroke="none"/>'),
      viewBox: z.string().optional().describe("配合 svg 使用，默认 0 0 24 24"),
      stroke: z.boolean().optional().describe("true 表示线稿（描边），false 表示填充"),
      strokeWidth: z.number().optional(),
      text: z.string().optional().describe("文字元素的内容"),
      imageSrc: z.string().optional().describe("图片元素：/assets/xxx（先 upload_asset）或 https 地址"),
      videoSrc: z
        .string()
        .optional()
        .describe("视频元素：/assets/xxx.mp4（先 upload_asset）；默认有声、不循环"),
      name: z.string().optional().describe("图层名，方便后续指认"),
      x: z.number().optional().describe("中心 X，画面宽度百分比，默认 50"),
      y: z.number().optional().describe("中心 Y，画面高度百分比，默认 52"),
      size: z.number().optional().describe("短边百分比：图形是宽度，文字是字号"),
      rotate: z.number().optional(),
      scale: z.number().optional(),
      opacity: z.number().optional(),
      z: z.number().optional().describe("层级，越大越靠前"),
      fill: z.string().optional().describe("颜色，如 #C6F24E"),
      bg: z.string().optional().describe("背景色（所有元素，传 rgba/hex；空字符串=无背景）"),
      weight: z.number().optional().describe("文字字重 400-900"),
      radius: z.number().optional().describe("圆角（短边百分比，如 2）"),
      border: z.number().optional().describe("边框宽度（短边百分比）"),
      borderColor: z.string().optional().describe("边框颜色，默认用 fill"),
      shadow: z.string().optional().describe("CSS box-shadow"),
      filter: z.string().optional().describe("CSS filter，如 blur(2px) brightness(1.1)"),
      blendMode: z.string().optional().describe("mix-blend-mode"),
      clipPath: z.string().optional().describe("CSS clip-path，如 circle(50%)"),
      fit: z.enum(["cover", "contain", "fill"]).optional().describe("图片/视频填充方式"),
      fontFamily: z.string().optional().describe("字体族"),
      lineHeight: z.number().optional().describe("行高倍数"),
      letterSpacing: z.number().optional().describe("字间距（em）"),
      textAlign: z.enum(["left", "center", "right"]).optional().describe("文字对齐"),
      fontStyle: z.enum(["normal", "italic"]).optional().describe("斜体"),
      underline: z.boolean().optional().describe("下划线"),
      maxWidth: z.number().optional().describe("文字最大宽度（短边百分比），自动换行"),
      strokeLinecap: z.enum(["butt", "round", "square"]).optional(),
      strokeLinejoin: z.enum(["miter", "round", "bevel"]).optional(),
      style: z
        .record(z.any())
        .optional()
        .describe("自定义内联样式（camelCase 键，最后应用可覆盖预设），如 { textShadow: '0 0 20px #0ff', transform: 'skew(-8deg)' }"),
      enter: EFFECT_DESC.optional().describe("入场特效：{type,durationInFrames}，type 同转场"),
      exit: EFFECT_DESC.optional().describe("出场特效：{type,durationInFrames}"),
      from: z.number().int().min(0).optional().describe("场景内起点（帧），默认 0"),
      durationInFrames: z
        .number()
        .int()
        .optional()
        .describe(
          "场景内时长（帧）：**这是元素出现多久，不是出场动画时长**。不传或传 -1 = 按当时幕长落库（看起来是撑到场景结尾）。" +
            "⚠ 幕长以后被拉长（重新配音等）时，元素**不会**自动跟着变长，会停在旧幕长那一刻——要么先定幕长再放元素，要么回来改这个值",
        ),
      muted: z.boolean().optional().describe("是否静音：视频/音频默认 false（不传就出声）"),
      loop: z.boolean().optional().describe("视频是否循环，默认 false（循环视频在时间轴上可以无限拉长）"),
      audioSrc: z.string().optional().describe("音频元素：/assets/xxx.wav（先 upload_asset）或 https 地址"),
      startFrom: z.number().int().min(0).optional().describe("从素材第几帧开始播（视频/音频通用，跳过文件开头，如旁白前的空白）"),
      overlay: z
        .boolean()
        .optional()
        .describe("目标幕是自由画布时才会用到：true = 明知是叠加层也要放（水印/贴纸）。默认拒绝并提示用 add_freeform_element"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      // 组装逻辑与批量 apply_ops 共用 composeElement：libraryId 解析、kind 推导、
      // 音视频按素材真实时长 —— 只有一份实现，不会两条路径越改越不一样
      const { element, sceneId } = await composeElement(a as Record<string, unknown>, p);
      const target = (p.scenes ?? []).find((s: any) => s.id === sceneId) as any;
      // 自由画布场景上 add_element 放的是**叠加层**，不进画布 elements 数组：
      // 画布里已有同名 kicker 时就渲染成重复两行（复盘坑 #6）。音频除外（旁白要能挂）。
      if (target?.type === "freeform" && element.kind !== "audio" && !a.overlay) {
        throw new Error(
          `「${target.name ?? sceneId}」是自由画布场景：add_element 放的是叠加层，不会成为画布里的元素——` +
            `画布里已有同名文字时会渲染成重复两行，而且不支持 anim / fx。\n` +
            `两条路：① 画布内元素用 add_freeform_element(sceneId, element:{type,text/svg,x,y,…})；` +
            `② 确实要压在画布上的叠加层（水印/贴纸），显式传 overlay:true。`,
        );
      }
      await api(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [{ op: "add_element", sceneId, element }],
        }),
      });
      return `已放入元素 ${element.id}「${element.name}」到场景 ${sceneId}（${element.kind}，位置 ${element.x}% / ${element.y}%）`;
    },
  },
  {
    name: "update_element",
    description:
      "修改场景里的自由元素：位置、尺寸、旋转、透明度、颜色/背景色、文字、图层、场景内时间、入出场特效；音频元素还能换音源、调音量。用户刚放进去的元素也能改，改完用户界面会实时更新。参数是平铺字段（直接给 opacity:0.5）。\n" +
      "分清：内置版式场景里的元素用本工具；freeform 自由画布场景的元素用 update_freeform_element（patch 包裹式）。\n" +
      "字段含义与 add_element 的 shape 一一对应（那里有每个字段的说明），这里只列名字；只传要改的，其余不动。误改可 restore_rev 回滚。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      sceneId: z.string().describe("元素所在场景"),
      elementId: z.string().describe("元素 id（get_project 里能看到）"),
      name: z.string().optional().describe("图层名（改名字方便后续指认）"),
      x: z.number().optional().describe("中心 X（画面宽度百分比，同 add_element）"),
      y: z.number().optional().describe("中心 Y（画面高度百分比，同 add_element）"),
      size: z.number().optional().describe("短边百分比：图形是宽度，文字是字号"),
      rotate: z.number().optional().describe("旋转角度（度）"),
      scale: z.number().optional().describe("整体缩放倍数"),
      opacity: z.number().optional().describe("不透明度 0–1"),
      z: z.number().optional().describe("层级，越大越靠前"),
      fill: z.string().optional().describe("颜色，如 #C6F24E"),
      text: z.string().optional().describe("文字内容（文字元素）"),
      svg: z.string().optional().describe("换矢量图形的内部标记（不同造型不用删了重加）"),
      viewBox: z.string().optional().describe("配合 svg，默认 0 0 24 24"),
      stroke: z.boolean().optional().describe("svg 用描边还是填充"),
      strokeWidth: z.number().optional(),
      bg: z.string().optional(),
      weight: z.number().optional(),
      radius: z.number().optional().describe("圆角（短边百分比）"),
      border: z.number().optional().describe("边框宽度（短边百分比）"),
      borderColor: z.string().optional(),
      shadow: z.string().optional(),
      filter: z.string().optional(),
      blendMode: z.string().optional(),
      clipPath: z.string().optional(),
      fit: z.enum(["cover", "contain", "fill"]).optional(),
      fontFamily: z.string().optional(),
      lineHeight: z.number().optional(),
      letterSpacing: z.number().optional(),
      textAlign: z.enum(["left", "center", "right"]).optional(),
      fontStyle: z.enum(["normal", "italic"]).optional(),
      underline: z.boolean().optional(),
      maxWidth: z.number().optional(),
      strokeLinecap: z.enum(["butt", "round", "square"]).optional(),
      strokeLinejoin: z.enum(["miter", "round", "bevel"]).optional(),
      style: z.record(z.any()).optional().describe("自定义内联样式（camelCase 键，最后应用）"),
      imageSrc: z.string().optional(),
      videoSrc: z.string().optional().describe("替换视频元素的视频地址"),
      audioSrc: z.string().optional().describe("替换音频元素的音源（如换一段 TTS 配音）"),
      audioVolume: z.number().min(0).max(MAX_VOLUME).optional().describe("音频元素音量：1 = 原音，可到 5（+14 dB）"),
      muted: z.boolean().optional().describe("是否静音（音频/视频通用，时间轴的声音开关就是它）"),
      loop: z.boolean().optional().describe("视频是否循环"),
      startFrom: z.number().int().min(0).optional().describe("从素材第几帧开始播（跳过文件开头，如旁白前的空白）"),
      enter: EFFECT_DESC.optional().describe("入场特效：{type,durationInFrames}；type=none 关闭"),
      exit: EFFECT_DESC.optional().describe("出场特效：{type,durationInFrames}；type=none 关闭"),
      from: z.number().int().min(0).optional().describe("场景内起点（帧）"),
      durationInFrames: z
        .number()
        .int()
        .optional()
        .describe("场景内时长（帧）：这是元素出现多久。不传或传 -1 = 撑到场景结尾"),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const patch: Record<string, unknown> = {};
      const entries: [string, unknown][] = [
        ["name", a.name],
        ["x", a.x],
        ["y", a.y],
        ["size", a.size],
        ["rotate", a.rotate],
        ["scale", a.scale],
        ["opacity", a.opacity],
        ["z", a.z],
        ["fill", a.fill],
        ["text", a.text],
        ["bg", a.bg],
        ["weight", a.weight],
        ["src", a.audioSrc ?? a.videoSrc ?? a.imageSrc],
        ["svg", a.svg],
        ["viewBox", a.viewBox],
        ["stroke", a.stroke],
        ["strokeWidth", a.strokeWidth],
        ["audioVolume", a.audioVolume],
        ["muted", a.muted],
        ["loop", a.loop],
        ["startFrom", a.startFrom],
        ["enter", a.enter],
        ["exit", a.exit],
        ["from", a.from],
        ["durationInFrames", a.durationInFrames === -1 ? -1 : a.durationInFrames],
      ];
      for (const [k, v] of entries) if (v !== undefined) patch[k] = v;
      // 换了音源/视频源又没显式给时长 → 按新素材真实时长更新块长
      if ((a.audioSrc || a.videoSrc) && a.durationInFrames === undefined) {
        const frames = await probedDurationFrames(
          (a.audioSrc ?? a.videoSrc) as string,
          p.fps ?? 30,
        );
        if (frames) patch.durationInFrames = frames;
      }
      if (!Object.keys(patch).length) throw new Error("没有任何要改的字段");

      const res = await api<{ project: ProjectLite; summary: string[] }>(
        `/api/projects/${p.id}/ops`,
        {
          method: "POST",
          body: JSON.stringify({
            actor: "agent",
            ops: [{ op: "update_element", sceneId: a.sceneId, elementId: a.elementId, patch }],
          }),
        },
      );
      return fmtSummary(res.summary) || "已更新";
    },
  },
  {
    name: "update_freeform_element",
    description:
      "局部更新 freeform 场景里的一个元素（按 elementId 或 index），不用重发整个 elements 数组。patch 只写要改的字段（text/x/y/size/fill/bg/border/style/anim…）。\n" +
      "分清：freeform 自由画布场景用本工具（patch 包裹式）；内置版式场景的元素用 update_element（平铺字段式）。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      sceneId: z.string(),
      elementId: z.string().optional().describe("元素的 id（freeform elements[].id）"),
      index: z.number().int().min(0).optional().describe("没有 id 时按下标（从 0 开始）"),
      patch: z.record(z.any()).describe("只写要改的字段"),
    },
    run: async (a) => {
      if (!a.elementId && a.index === undefined) {
        throw new Error("elementId 或 index 至少给一个");
      }
      const p = await resolveProject(a.projectId);
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [
            {
              op: "update_freeform_element",
              sceneId: a.sceneId,
              ...(a.elementId ? { elementId: a.elementId } : {}),
              ...(a.index !== undefined ? { index: a.index } : {}),
              patch: a.patch,
            },
          ],
        }),
      });
      return fmtSummary(res.summary);
    },
  },
  {
    name: "add_freeform_element",
    description:
      "往 freeform 场景追加一个元素（上限 40 个）。svg 图形、fx 氛围层（glow/noise/dust/beam…）、带 anim 关键帧动画的元素**只能走这里**——add_element 的叠加层通道不支持这些。返回分配的元素 id。常用字段：type(svg/text/shape/image/fx)、x/y(百分比)、size(短边百分比)、width/height(短边百分比，矩形单独定宽高；不传=size，所以 size:76 画横条会变成 76%×76% 的方块)、from(出现帧)、anim(关键帧，from/to 是绝对值)、viewBox(改 svg 必须一起传，否则内容被压成一个点)。\n" +
      "半透明有两条路且等价：元素级 opacity:0.22（会乘进 fill/stroke 的 alpha）或 fill:\"rgba(90,200,250,0.22)\"。\n" +
      "⚠️ svg 元素：内容里自带的 fill 会盖掉外层 fill（改外层没反应就是这原因）——要能改色，svg 内容里别写 fill。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      sceneId: z.string(),
      element: z.record(z.any()).describe('完整元素对象，如 {type:"svg", svg:"<svg…>", viewBox:"0 0 920 420", x:50, y:47}'),
    },
    run: async (a) => {
      const p = await resolveProject(a.projectId);
      const sceneId = a.sceneId ?? p.scenes[0]?.id;
      if (!sceneId) throw new Error("工程里还没有场景");
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [{ op: "add_freeform_element", sceneId, element: a.element }],
        }),
      });
      const doc = await (await fetch(`${BASE}/api/projects/${p.id}`)).json();
      const scene = (doc.project?.scenes ?? []).find((s: { id: string }) => s.id === sceneId);
      const els = (scene?.props?.elements ?? []) as { id?: string }[];
      const added = els[els.length - 1]?.id;
      return `${fmtSummary(res.summary)}（id=${added ?? "?"}，该幕现有 ${els.length} 个元素）`;
    },
  },
  {
    name: "remove_freeform_element",
    description:
      "删除 freeform 场景里的一个元素（按 elementId 或 index）。freeform 至少要保留一个元素；要清空画面请用 set_scene_type 换版式。",
    shape: {
      projectId: z.string().optional().describe("要操作的工程 id，不传 = 当前默认工程（list_projects 查）"),
      sceneId: z.string(),
      elementId: z.string().optional().describe("元素的 id（freeform elements[].id）"),
      index: z.number().int().min(0).optional().describe("没有 id 时按下标（从 0 开始）"),
    },
    run: async (a) => {
      if (!a.elementId && a.index === undefined) {
        throw new Error("elementId 或 index 至少给一个");
      }
      const p = await resolveProject(a.projectId);
      const res = await api<{ summary: string[] }>(`/api/projects/${p.id}/ops`, {
        method: "POST",
        body: JSON.stringify({
          actor: "agent",
          ops: [
            {
              op: "remove_freeform_element",
              sceneId: a.sceneId,
              ...(a.elementId ? { elementId: a.elementId } : {}),
              ...(a.index !== undefined ? { index: a.index } : {}),
            },
          ],
        }),
      });
      return fmtSummary(res.summary);
    },
  },
  /* ── scene3d 场景图：逐节点读写（人和编辑器面板改的就是这批 op） ── */
  ...SCENE3D_TOOLS,

  /*
   * 下面五组原来是塞在 scene3d.ts 里的（那个文件一度混着工程/稿件/分镜类工具）。
   * 现在按主题分文件，但仍**按原位、按原顺序**依次展开：TOOLS 的顺序是 tool_search
   * 同分时的排序依据，也是 `tool_search(all:true)` 的目录顺序，别随意调换。
   */
  ...PROJECT_TOOLS,
  ...BRIEF_TOOLS,
  ...SCRIPT_TOOLS,
  ...STORYBOARD_TOOLS,
  ...CLEANUP_TOOLS,

  /* ───────────── 工具门面：按需发现与执行（其余工具经这两层调用） ───────────── */
  {
    name: "tool_search",
    description:
      "按意图搜索可用工具（常驻只暴露 4 个核心工具，其余工具全部从这里找）：返回工具名、完整说明、参数表。找到后用 tool_call(name, args) 执行。" +
      "传 all=true 看全部工具目录（名字 + 一句话 + 参数个数，不含参数表——看中哪个再用 names 取它的完整参数表，一次可传多个）。",
    shape: {
      query: z.string().optional().describe("意图关键词，如：画中画 / 字幕 / 配音 / 3D / 历史 / 横屏 / 卡点"),
      all: z.boolean().optional().describe("true = 返回全部工具目录（名字 + 参数个数）"),
      names: z
        .array(z.string())
        .optional()
        .describe("按名字精确取某几个工具的完整文档（含参数表）——all=true 之后第二步就用它"),
    },
    run: async (a) => {
      const others = TOOLS.filter((d) => !CORE_TOOL_NAMES.has(d.name) && !d.retiredTo);
      if (a.names?.length) {
        const wanted: string[] = a.names;
        const picked = wanted
          .map((n: string) => others.find((d) => d.name === n))
          .filter((d): d is ToolDef => !!d);
        if (!picked.length) throw new Error(`一个都没匹配上（检查拼写）。传 all=true 看全量目录`);
        return JSON.stringify(picked.map(fullDoc));
      }
      if (a.all) {
        // 目录只给名字 + 一句话 + 参数个数：参数个数是给 agent 的一个成本信号——
        // 看到「12 参数」它就会先去 names 取全表，而不是照着直觉硬写一版再被拒。
        // 保持纯 JSON 数组（脚本侧会 JSON.parse），"怎么看这份目录"写在工具描述里。
        return JSON.stringify(
          others.map((d) => ({
            name: d.name,
            params: Object.keys(d.shape).length,
            desc: firstLine(d.description),
          })),
        );
      }
      const q = (a.query ?? "").trim().toLowerCase();
      if (!q) return `传 query 搜工具（如 tool_search("画中画")），或 all=true 看全量目录。`;
      const terms = q.split(/\s+/);
      // 别名除了整词，还用每个词的 2-gram 查：「怎么加转场」切出「转场」就能命中别名表
      const aliasKeys = new Set<string>();
      for (const t of terms) {
        aliasKeys.add(t);
        const chars = [...t];
        if (chars.length >= 2) {
          for (let i = 0; i + 2 <= chars.length; i++) aliasKeys.add(chars.slice(i, i + 2).join(""));
        }
      }
      const aliasNames = new Set([...aliasKeys].flatMap((t: string) => SEARCH_ALIASES[t] ?? []));
      // 中文整句 query 没有空格分词（「改一下字幕样式」整串传进来）：整词没命中时
      // 按 2-gram 切开再试，命中过半算相关 —— 否则搜不到 = 对 agent 来说工具不存在
      const scoreTerm = (t: string, name: string, desc: string): number => {
        if (name.includes(t)) return 5;
        if (desc.includes(t)) return 3;
        const chars = [...t];
        if (chars.length >= 3) {
          const grams = new Set<string>();
          for (let i = 0; i + 2 <= chars.length; i++) grams.add(chars.slice(i, i + 2).join(""));
          let hit = 0;
          for (const g of grams) if (name.includes(g) || desc.includes(g)) hit++;
          if (hit / grams.size >= 0.5) return 2;
        }
        return 0;
      };
      const scored = others
        .map((d) => {
          const name = d.name.toLowerCase();
          const desc = d.description.toLowerCase();
          let score = 0;
          for (const t of terms) {
            score += scoreTerm(t, name, desc);
          }
          if (aliasNames.has(d.name)) score += 6;
          return { d, score };
        })
        .filter((x) => x.score > 0)
        .sort((x, y) => y.score - x.score)
        .slice(0, 8);
      if (!scored.length) {
        return `没有匹配「${q}」的工具。试试更短的关键词（中文意图词也行，如「字幕」「历史」），或 all=true 看全量目录。意图→能力映射见 get_guide("manual")。`;
      }
      return JSON.stringify(scored.map(({ d }) => fullDoc(d)));
    },
  },
  {
    name: "tool_call",
    description:
      "执行任意已注册工具（配合 tool_search 使用）：tool_call(name=\"preview_frame\", args={...})。参数字段见 tool_search 返回的 params；执行报错带字段级原因，按报错改一次即可。\n" +
      "**参数一律包在 args 里**（扁平传会被拒）。三个可复制示例：\n" +
      "  读：{\"name\":\"get_project\",\"args\":{\"projectId\":\"p_xxx\"}}\n" +
      "  写：{\"name\":\"update_scene\",\"args\":{\"sceneId\":\"s1\",\"props\":{\"title\":\"新标题\"}}}\n" +
      "  批量：{\"name\":\"apply_to_scenes\",\"args\":{\"tool\":\"set_subtitle_style\",\"args\":{\"style\":{\"bottom\":24}},\"applyToAll\":true}}\n" +
      "易错：preview_frames（frames 是数组，单帧写 [帧号]）；没有 set_format，画幅是 set_formats（数组）。",
    shape: {
      name: z.string().describe("要执行的工具名（来自 tool_search 或 manual 全书）"),
      args: z.record(z.any()).optional().describe("参数对象，字段见该工具的 params"),
    },
    run: async (a) => {
      const name = a.name;
      if (!name || name === "tool_call") throw new Error("tool_call 不能调用自身");
      const def = TOOLS.find((t) => t.name === name);
      if (!def) throw new Error(`没有工具「${name}」。先 tool_search 找（传 all=true 看全量目录），注意拼写`);
      let out = await def.run(validateToolArgs(def, (a.args ?? {}) as Record<string, unknown>) as never);
      // 门面模式下所有工具都从这里过：脏提醒必须挂在这儿，注册层的包装覆盖不到
      out = liftWarnings(String(out));
      if (dirtySincePreview && needsDirtyHint(name)) out = String(out) + DIRTY_HINT;
      return out;
    },
  },
  {
    name: "tool_stats",
    description:
      "看本机最近几天的工具调用统计：调用次数、失败率、平均/慢速耗时、高频失败原因。\n" +
      "什么时候用：① 连续几次同一工具报错，先看是不是自己参数总写错（topErrors 里会有原话）；" +
      "② 用户问「为什么这么慢/是不是卡了」时，用 p95 耗时给依据；③ 想确认某个工具是不是根本没人调。\n" +
      "数据来自 data/logs/tool-calls-*.jsonl，只记摘要（参数截断 400 字），保留 7 天。",
    shape: {
      days: z
        .number()
        .int()
        .min(1)
        .max(7)
        .optional()
        .describe("统计最近几天，默认 1（今天）；最多 7（日志保留上限）"),
    },
    run: async (a) => toolStatsToText(toolStats(a.days ?? 1)),
  },
];

/** 中文口语意图 → 工具名别名（搜索加分项；描述里已含的词不用写这里） */
const SEARCH_ALIASES: Record<string, string[]> = {
  画中画: ["move_scene", "set_scene_box"],
  小窗: ["set_scene_box"],
  卡点: ["set_transitions", "add_effect"],
  撤销: ["restore_rev", "get_history"],
  找回: ["restore_rev", "get_history"],
  历史: ["get_history", "restore_rev"],
  横屏: ["set_formats"],
  竖屏: ["set_formats"],
  画幅: ["set_formats"],
  配音: ["tts_narration", "tts_synthesize", "set_tts_config"],
  旁白: ["tts_narration"],
  音乐: ["add_audio_track", "update_audio_track"],
  bgm: ["add_audio_track", "update_audio_track"],
  音效: ["add_audio_track", "set_audio"],
  删: ["remove_scene", "remove_element", "delete_project"],
  删除: ["remove_scene", "remove_element", "delete_project"],
  改: ["update_scene", "update_element"],
  加: ["add_scene", "add_element"],
  复制: ["duplicate_scene"],
  顺序: ["reorder_scenes", "move_scene", "compact_main_track"],
  幕序: ["reorder_scenes", "check_project", "build_storyboard"],
  排序: ["reorder_scenes"],
  层级: ["reorder_freeform_elements", "add_freeform_element"],
  图层: ["reorder_freeform_elements", "add_freeform_element"],
  盖住: ["reorder_freeform_elements"],
  呼吸位: ["tts_narration"],
  断句: ["set_subtitle", "tts_narration"],
  时长: ["update_scene", "set_scene_timing"],
  多版本: ["duplicate_scene"],
  模板: ["list_templates", "save_template"],
  主题: ["set_theme"],
  封面: ["render_cover", "preview_frames"],
  转场: ["set_transitions", "preview_frames"],
  字幕: ["set_subtitle", "set_subtitle_style", "fix_subtitles", "export_subtitles"],
  风格: ["list_styles", "apply_style", "probe_style", "confirm_style_probe"],
  颜色: ["set_theme"],
  配色: ["set_theme"],
  样式: ["set_subtitle_style", "apply_style"],
  渲染: ["render_video", "get_render_status", "cancel_render"],
  预览: ["preview_frames", "render_preview_clip"],
  动态: ["render_preview_clip"],
  分镜: ["save_storyboard", "build_storyboard", "build_film"],
  建片: ["build_film", "build_storyboard"],
  铺开: ["build_film", "build_storyboard"],
  需求: ["intake", "save_brief", "confirm_brief"],
  问诊: ["intake", "save_brief"],
  尺寸: ["set_formats"],
  比例: ["set_formats"],
  试: ["preview_frames"],
  抽帧: ["preview_frames"],
  出片: ["render_video"],
  成片: ["render_video"],
  导出: ["export_project", "export_subtitles"],
  导入: ["import_project", "upload_asset"],
  上传: ["upload_asset"],
  素材: [
    "list_assets",
    "upload_asset",
    "get_asset_info",
    "list_assets",
    "delete_project_asset",
    "organize_assets",
    "delete_asset",
  ],
  整理: ["organize_assets"],
  工程素材: ["list_project_assets", "delete_project_asset", "upload_asset"],
  贴纸: ["list_element_library"],
  图标: ["list_element_library"],
  布局: ["layout_grid", "align_elements"],
  对齐: ["align_elements", "layout_grid"],
  排版: ["layout_grid", "align_elements"],
  // 3D 与图解：agent 常用「立体/三维/太空/行星」这类词，工具名里一个都不含
  "3d": ["get_graph", "add_scene", "list_scene_types", "update_graph_node"],
  三维: ["get_graph", "add_scene", "list_scene_types", "update_graph_node"],
  立体: ["add_scene", "list_scene_types", "get_graph"],
  太空: ["add_scene", "list_scene_types", "get_graph"],
  行星: ["get_graph", "update_graph_node", "add_graph_node"],
  太阳系: ["get_graph", "add_graph_node", "set_graph_scene"],
  轨道: ["add_graph_node", "update_graph_node", "get_graph"],
  公转: ["update_graph_node", "add_graph_node"],
  节点: ["get_graph", "update_graph_node", "add_graph_node", "remove_graph_node"],
  场景图: ["get_graph", "update_graph_node", "add_graph_node"],
  graph: ["get_graph", "update_graph_node", "add_graph_node"],
  打光: ["set_graph_scene", "set_theme"],
  光照: ["set_graph_scene"],
  粒子: ["set_graph_scene"],
  星尘: ["set_graph_scene"],
  分子: ["add_scene"],
  装置: ["add_scene"],
  图解: ["add_scene", "upload_asset"],
  等轴测: ["add_scene"],
  插图: ["add_scene"],
  体检: ["check_project"],
  诊断: ["check_project"],
  自检: ["check_project"],
  记住: ["remember"],
  回忆: ["recall"],
  统计: ["tool_stats"],
  调用日志: ["tool_stats"],
  失败率: ["tool_stats"],
  慢: ["tool_stats"],
  性能: ["tool_stats"],
};


/* 同时给 stdio 入口（mcp-proxy.ts）和 HTTP 入口（server/index.ts 的 /mcp）共用 */
export { TOOLS };
export type { ToolDef };

/** 建一个注册好全部工具的 MCP Server（stdio / HTTP 共用）。
 * 门面模式：全部工具保持注册（tool_call 与兼容直调都能执行），
 * 但非核心工具在注册表里标记 enabled=false —— SDK 的 tools/list 只返回 enabled 的，
 * 于是宿主只看到 4 个核心入口。MCP_EXPOSE=all 恢复全量暴露（调试用）。 */
export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "remotion-studio", version: VERSION });
  const exposeAll = exposeAllTools();
  for (const def of TOOLS) {
    const handler = async (args: Record<string, any>) => {
      /**
       * 日志记真实工具名：门面模式下所有调用都经 tool_call，
       * 只记 "tool_call" 会让统计全是同一个名字，等于没记。
       */
      const inner = def.name === "tool_call" ? String(args?.name ?? "") : "";
      const logAs = inner || def.name;
      const startedAt = performance.now();
      try {
        let out = await def.run(args ?? {});
        out = liftWarnings(String(out));
        if (dirtySincePreview && needsDirtyHint(def.name)) out = String(out) + DIRTY_HINT;
        logToolCall({ tool: logAs, args: inner ? args?.args : args, startedAt, ok: true });
        return { content: [{ type: "text" as const, text: text(out) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logToolCall({ tool: logAs, args, startedAt, ok: false, error: err });
        return {
          content: [{ type: "text" as const, text: `失败：${message}` }],
          isError: true,
        };
      }
    };

    const anyServer = server as any;
    if (typeof anyServer.registerTool === "function") {
      // strict schema：未知 key 在 SDK 层就被拒（不会静默剥掉传进 handler）
      anyServer.registerTool(
        def.name,
        { description: def.description, inputSchema: z.object(def.shape).strict() },
        handler,
      );
    } else {
      anyServer.tool(def.name, def.description, def.shape, handler);
    }
  }
  if (!exposeAll) {
    const registered = (server as any)._registeredTools ?? {};
    for (const [name, tool] of Object.entries(registered)) {
      if (!CORE_TOOL_NAMES.has(name)) (tool as any).enabled = false;
    }
  }
  return server;
}
