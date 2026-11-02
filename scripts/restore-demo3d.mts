// 重建 3D 示例工程（demo3d）：工程文档 + 十张行星贴图一起铺回磁盘
//
// 为什么需要脚本：3D 场景离了贴图就是一堆黑球，而素材放在 public/ 下、不进 git 也不随
// project.json 走。只恢复工程文档的话，换机器 / 清了素材目录之后示例就废了。
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, PUBLIC_DIR } from "../server/store";
import { installDemo3D } from "../server/demo3d.service";

const p = installDemo3D();
const scene = p.scenes[0];
const graph = (scene.props as { graph?: { nodes?: unknown[]; camera?: { anim?: unknown[] } } }).graph;

const assetDir = path.join(PUBLIC_DIR, "assets", "projects", "demo3d");
const assets = fs.existsSync(assetDir) ? fs.readdirSync(assetDir).length : 0;

console.log(`demo3d 已重建：1 场景 / ${scene.durationInFrames} 帧 / ${graph?.nodes?.length ?? 0} 个节点`);
console.log(`相机关键帧 ${graph?.camera?.anim?.length ?? 0} 段 · 贴图 ${assets} 张 → public/assets/projects/demo3d`);
console.log(`工程文件：${path.join(DATA_DIR, "demo3d", "project.json")}`);
