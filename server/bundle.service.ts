import fs from "node:fs";
import path from "node:path";
import { projectSchema, totalDuration, type Project } from "../shared/schema";
import { assetFileFromEntry, assetNameOf, collectAssetRefs } from "../shared/customTemplate";
import { LIBRARY_REL, projectAssetRel, remapAssetUrlsInProject } from "./assets.service";
import { projects } from "./project.service";
import { PUBLIC_DIR, writeProject } from "./store";
import { createZip, readZip, type ZipEntry } from "./zip";

/**
 * 工程包（.zip）导入导出：project.json + assets/ + manifest.json
 *
 * 和「我的模板」的区别：
 *  - 模板是**内容快照**，套用出来是新工程（场景 id 全换、rev 1）
 *  - 工程包是**整份工程**（含 id 与 rev），用于备份、换机器、发给别人
 *
 * 导入时故意**不沿用包里的 id/rev**：否则会把本机同 id 的工程覆盖掉。
 * 素材按文件名写回 public/assets（同名视为同一份文件，已存在就复用）。
 */
export const BUNDLE_FORMAT = "remotion-studio-project";
export const PROJECT_FILE = "project.json";
export const MANIFEST_FILE = "manifest.json";

const SAFE_ASSET = /^[\w.-]+$/;
const MAX_ENTRIES = 2000;
const MAX_ASSET_BYTES = 40 * 1024 * 1024;

const rid = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 8)}`;

const safeFilename = (name: string) =>
  (name.trim().replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60) || "project");

export type ExportResult = { filename: string; data: Uint8Array; assetCount: number };
export type ImportResult = { project: Project; assetCount: number; warnings: string[] };

export const bundleService = {
  exportProject(id: string): ExportResult {
    const project = projects.get(id);
    // 导出前按 schema 自检：工程包一旦带着不合法的字段，导入时才会报错——
    // 用户以为备份好了，换机器才发现恢复不了（黑盒验证 N-02）。宁可导出失败也不给坏包。
    const check = projectSchema.safeParse(project);
    if (!check.success) {
      const detail = check.error.issues
        .slice(0, 6)
        .map((i) => `${i.path.join(".") || "(根)"}：${i.message}`)
        .join("；");
      throw new Error(
        `工程数据校验失败，先修这些字段再导出：${detail}` +
          `（这类问题多来自直接写进工程的非法值，用 update_scene / update_element 改回合法值即可）`,
      );
    }
    const entries: ZipEntry[] = [];
    const included: string[] = [];

    for (const src of collectAssetRefs(project)) {
      const rel = assetNameOf(src);
      if (!rel) continue;
      // 分层布局照原样打进包里（assets/projects/<id>/… 或 assets/library/…），导入时再归位
      const abs = path.join(PUBLIC_DIR, "assets", ...rel.split("/"));
      if (!fs.existsSync(abs)) continue;
      entries.push({ name: `assets/${rel}`, data: fs.readFileSync(abs) });
      included.push(rel);
    }

    const manifest = {
      format: BUNDLE_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      projectId: project.id,
      name: project.name,
      scenes: project.scenes.length,
      durationInFrames: totalDuration(project),
      assets: included,
    };

    entries.unshift({
      name: PROJECT_FILE,
      data: Buffer.from(JSON.stringify(project, null, 2), "utf8"),
    });
    entries.push({
      name: MANIFEST_FILE,
      data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
    });

    return {
      filename: `${safeFilename(project.name)}.zip`,
      data: createZip(entries),
      assetCount: included.length,
    };
  },

  importProject(data: Uint8Array, opts: { name?: string } = {}): ImportResult {
    const entries = readZip(data);
    if (entries.length > MAX_ENTRIES) throw new Error(`压缩包条目过多（${entries.length}）`);

    const projectEntry = entries.find(
      (e) => e.name === PROJECT_FILE || e.name.endsWith(`/${PROJECT_FILE}`),
    );
    if (!projectEntry) throw new Error("压缩包里没有 project.json（不是本工具导出的工程包）");

    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.from(projectEntry.data).toString("utf8"));
    } catch {
      throw new Error("project.json 不是合法 JSON");
    }
    const checked = projectSchema.safeParse(raw);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      const where = issue.path.length ? issue.path.join(".") : "(根)";
      throw new Error(`工程文件校验失败：${where} ${issue.message}`);
    }
    const parsed = checked.data;

    // 素材：保留包里的相对路径；**工程私有素材写进新工程目录**并改写 URL，
    // library/ 下的共享素材原样落回 library（它本来就不属于某个工程）
    const newId = rid("p");
    let assetCount = 0;
    const warnings: string[] = [];
    /** 旧 URL → 新 URL */
    const urlMap = new Map<string, string>();
    const written = new Set<string>();
    for (const entry of entries) {
      const rel = assetFileFromEntry(entry.name);
      if (!rel) {
        if (entry.name.startsWith("assets/")) warnings.push(`跳过非法素材名：${entry.name}`);
        continue;
      }
      if (entry.data.length > MAX_ASSET_BYTES) {
        warnings.push(`跳过超大素材：${entry.name}`);
        continue;
      }
      const targetRel = rel.startsWith(`${LIBRARY_REL}/`)
        ? rel
        : projectAssetRel(newId, rel.split("/").pop() as string);
      const dst = path.join(PUBLIC_DIR, "assets", ...targetRel.split("/"));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      if (!fs.existsSync(dst)) fs.writeFileSync(dst, entry.data);
      if (targetRel !== rel) urlMap.set(`/assets/${rel}`, `/assets/${targetRel}`);
      written.add(targetRel);
      assetCount++;
    }

    // 新实例：id / rev / 更新时间全部重生成，避免覆盖本机同 id 工程
    let project: Project = {
      ...structuredClone(parsed),
      id: newId,
      rev: 1,
      name: opts.name?.trim() || parsed.name,
      updatedAt: new Date().toISOString(),
    };
    if (urlMap.size) {
      project = remapAssetUrlsInProject(project, (url) => urlMap.get(url) ?? url);
    }

    for (const src of collectAssetRefs(project)) {
      const rel = assetNameOf(src);
      if (rel && !written.has(rel) && !fs.existsSync(path.join(PUBLIC_DIR, "assets", ...rel.split("/")))) {
        warnings.push(`缺少素材：${rel}`);
      }
    }

    writeProject(project);
    return { project: projects.get(project.id), assetCount, warnings };
  },
};
