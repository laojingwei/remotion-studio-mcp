/**
 * 运行期数据根目录：`data/` 的唯一解析点。
 *
 * 为什么要收这一处：`data/` 之前被 17 个文件各自用 `path.join(PROJECT_ROOT, "data", …)`
 * 拼出来，等于"数据放哪"这件事散在 17 个地方。后果有两个：
 *
 *  1. 测试/多实例没法隔离。E2E 要建工程、删工程、改 ui 偏好，全落在用户真实数据里，
 *     跑一次测试就把「最近打开的工程」指针改掉。
 *  2. 想换数据盘只能靠 `workspace.json` + 目录链接（workspace.service 那套），
 *     链接坏了就是"工程不见了"。
 *
 * 现在统一走 `STUDIO_DATA_ROOT`：
 *   - 不设 = 老行为（<repo>/data），链接式工作空间照旧可用；
 *   - 设了 = 所有运行期数据（projects / logs / 模板 / 素材库 / 对话 / 偏好）都落那里，
 *     工作空间迁移会被明确拒绝（两套机制同时用只会互相打架）。
 */
import path from "node:path";
import { ROOT } from "./root";

const override = process.env.STUDIO_DATA_ROOT?.trim();

/** 数据根目录（默认 <repo>/data，可用 STUDIO_DATA_ROOT 覆盖） */
export const DATA_ROOT = override ? path.resolve(override) : path.join(ROOT, "data");

/** 工程目录（data/projects）：每个工程一个子目录，内含 project.json + history/ */
export const PROJECTS_ROOT = path.join(DATA_ROOT, "projects");

/** 是否启用了 STUDIO_DATA_ROOT（用于禁用「工作空间迁移」等与之冲突的功能） */
export const isDataRootOverridden = Boolean(override);
