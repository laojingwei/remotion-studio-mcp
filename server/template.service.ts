import fs from "node:fs";
import { ROOT as PROJECT_ROOT } from "./root";
import path from "node:path";
import type { Project } from "../shared/schema";
import {
  assetNameOf,
  collectAssetRefs,
  instantiateTemplate,
  isSafeAssetRel,
  snapshotProject,
  summarizeCustomTemplate,
  type CustomTemplate,
  type TemplateCard,
} from "../shared/customTemplate";
import { LIBRARY_REL, projectAssetRel, remapAssetUrlsInProject } from "./assets.service";
import { projects } from "./project.service";
import { PUBLIC_DIR, removeTree } from "./store";

/**
 * 自定义模板的磁盘存储：data/templates/<tpl_id>/{template.json, assets/}
 *
 * 模板与工程是两套目录，互不依赖：
 *  - 删工程不会删模板（素材已经复制进模板目录）
 *  - 删模板不会影响已经套用出来的工程（套用时素材复制回 public/assets）
 */
export const TEMPLATES_DIR = path.join(PROJECT_ROOT, "data", "templates");

const ensureDir = () => fs.mkdirSync(TEMPLATES_DIR, { recursive: true });

const safeId = (id: string): string => {
  if (!/^tpl_[\w-]+$/.test(id)) throw new Error("非法的模板 id");
  return id;
};

const dirOf = (id: string) => path.join(TEMPLATES_DIR, safeId(id));
const fileOf = (id: string) => path.join(dirOf(id), "template.json");

const notFound = () => Object.assign(new Error("模板不存在"), { status: 404 });

class TemplateService {
  list(): CustomTemplate[] {
    ensureDir();
    return fs
      .readdirSync(TEMPLATES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(fileOf(d.name)))
      .map((d) => {
        try {
          return JSON.parse(fs.readFileSync(fileOf(d.name), "utf8")) as CustomTemplate;
        } catch {
          return null;
        }
      })
      .filter((t): t is CustomTemplate => !!t)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** 给 Web / MCP 的精简卡片（与内置模板同形态） */
  cards(): TemplateCard[] {
    return this.list().map(summarizeCustomTemplate);
  }

  get(id: string): CustomTemplate {
    const file = fileOf(id);
    if (!fs.existsSync(file)) throw notFound();
    return JSON.parse(fs.readFileSync(file, "utf8")) as CustomTemplate;
  }

  /** 只改名字，不动模板内容（场景/素材） */
  rename(id: string, name: string): CustomTemplate {
    const tpl = this.get(id);
    const clean = name.trim().slice(0, 60);
    if (!clean) throw new Error("模板名不能为空");
    tpl.name = clean;
    fs.writeFileSync(fileOf(id), JSON.stringify(tpl, null, 2), "utf8");
    return tpl;
  }

  /** 把当前工程存成模板：场景/主题/画幅/音频 + 引用到的素材一起打包 */
  save(projectId: string, name: string, description = "", tags: string[] = []): CustomTemplate {
    const project = projects.get(projectId);
    const cleanName = name.trim().slice(0, 60);
    if (!cleanName) throw new Error("模板名不能为空");

    const id = `tpl_${Math.random().toString(36).slice(2, 8)}`;
    const dir = dirOf(id);
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true });

    // 素材：源文件都在 public/assets 下（可能带子目录，如 projects/<id>/），
    // 按同样的相对路径复制一份进模板目录，模板就不依赖原工程
    const assetDir = path.join(dir, "assets");
    let copied = 0;
    for (const src of collectAssetRefs(project)) {
      const rel = assetNameOf(src);
      if (!rel) continue;
      const from = path.join(PUBLIC_DIR, "assets", ...rel.split("/"));
      if (!fs.existsSync(from)) continue;
      const to = path.join(assetDir, ...rel.split("/"));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      copied++;
    }

    const tpl: CustomTemplate = {
      id,
      name: cleanName,
      description: description.trim().slice(0, 200) || `来自「${project.name}」的整片快照`,
      ...(tags.length ? { tags: tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 6) } : {}),
      createdAt: new Date().toISOString(),
      payload: snapshotProject(project),
    };
    fs.writeFileSync(fileOf(id), JSON.stringify(tpl, null, 2), "utf8");
    console.log(`[template] 保存 ${id}「${cleanName}」：${tpl.payload.scenes.length} 场景 / ${copied} 个素材`);
    return tpl;
  }

  remove(id: string): void {
    const dir = dirOf(id);
    if (!fs.existsSync(dir)) throw notFound();
    removeTree(dir);
    fs.rmdirSync(dir);
  }

  /**
   * 套用模板：素材复制回 public/assets（工程私有素材进**新工程目录**并改写 URL，
   * library/ 的共享素材落回 library），返回新工程（未写盘）。
   */
  instantiate(id: string, name?: string): Project {
    const tpl = this.get(id);
    // 先生成工程（拿到新 id），才知道素材该放进哪个目录
    const project = instantiateTemplate(tpl, { name });
    const srcDir = path.join(dirOf(id), "assets");
    if (!fs.existsSync(srcDir)) return project;

    const urlMap = new Map<string, string>();
    const walk = (dir: string, prefix: string): { rel: string; abs: string }[] => {
      const out: { rel: string; abs: string }[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out.push(...walk(full, rel));
        else if (entry.isFile() && !entry.name.startsWith(".")) out.push({ rel, abs: full });
      }
      return out;
    };

    for (const { rel, abs } of walk(srcDir, "")) {
      if (!isSafeAssetRel(rel)) continue;
      const targetRel = rel.startsWith(`${LIBRARY_REL}/`)
        ? rel
        : projectAssetRel(project.id, rel.split("/").pop() as string);
      const dst = path.join(PUBLIC_DIR, "assets", ...targetRel.split("/"));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      if (!fs.existsSync(dst)) fs.copyFileSync(abs, dst);
      if (targetRel !== rel) urlMap.set(`/assets/${rel}`, `/assets/${targetRel}`);
    }
    return urlMap.size
      ? remapAssetUrlsInProject(project, (url) => urlMap.get(url) ?? url)
      : project;
  }
}

export const templates = new TemplateService();
