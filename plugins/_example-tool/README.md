# 场次小工具（示例：工具插件）

一个能真正被 agent 调起来的插件。演示两件事：**怎么声明参数**、**怎么申请权限**。

## 两个工具

| 工具 | 权限 | 干什么 |
|---|---|---|
| `scene_tools_reading_speed` | `project:read` | 逐幕算语速，挑出过快/过慢的幕 |
| `scene_tools_number_scenes` | `project:read` + `project:write` | 批量给幕名加序号，**默认只预览** |

## 怎么启用

```bash
mv plugins/_example-tool/plugin.ts.example plugins/_example-tool/plugin.ts
```

然后**重启一次服务**（工具列表在进程启动时装载）。之后：

```
tool_search("语速")          → 找到 scene_tools_reading_speed
tool_call(name="scene_tools_reading_speed", args={projectId: "p_xxx"})
```

改插件里的代码后不用再重启，下一次调用会自动重新加载。

## 权限是怎么起作用的

`manifest.json` 里声明：

```json
"permissions": ["project:read", "project:write"]
```

没声明就调用 `ctx.readProject` / `ctx.applyOps` 会直接抛 `PermissionDenied`，
报错里会告诉你缺哪一条、去哪里加。

**但这不是沙箱**：`plugin.ts` 是任意代码，顶层 `import fs` 就能绕过所有检查。
权限声明的真实作用是**知情同意**——用户在 `list_plugins` 里能看到"这个插件要改我的工程"，
再决定装不装。它挡住的是"通过宿主 API 的越权"，不是恶意代码。

## 参数怎么声明

```ts
params: {
  projectId: { type: "string", required: true, desc: "工程 id" },
  dryRun:    { type: "boolean", default: true, desc: "true=只预览" },
  mode:      { type: "enum", values: ["a", "b"], desc: "..." },
}
```

支持 `string` / `number` / `boolean` / `enum` / `stringArray`。
**不要 `import { z } from "zod"`** —— 插件带进来的那份 zod 和宿主那份不是同一个实例，
schema 会静默失效。宿主会用自己的 zod 根据你声明的数据建 schema。

`desc` 一定要写：agent 就是靠它决定要不要调、参数怎么填。缺 `desc` 的工具等于半个废工具。

## 三条硬规矩

1. **工具名带插件前缀**（`scene_tools_xxx`）。撞了内置工具名会被拒绝注册，并在 `list_plugins` 里报出来。
2. **写入类工具必须有 `dryRun` 且默认 `true`**。插件最容易造成的伤害不是"功能不对"，
   而是"agent 试了一下，数据变了"。
3. **`run` 里抛错就抛出来**，别 try/catch 吞掉返回空字符串——agent 会以为操作成功。

## 相关 API

```ts
ctx.listProjects()            // string[]        需要 project:read
ctx.readProject(id)           // 工程完整文档      需要 project:read
ctx.applyOps(id, ops)         // { rev, summary }  需要 project:write
ctx.log(msg)                  // 打到服务端 stdout
```

`ops` 就是 `tools-quickref` 里那些 op（`update_scene` / `add_element` / `set_subtitle`…）。
写入会走完整的宿主管线：冲突检查、幂等缓存、历史记录、`ops:review` 钩子都会跑，
历史里的 actor 会记为 `plugin:scene-tools`——**看得出是插件改的**。

`render` / `net` / `exec` / `assets:*` 在权限表里有定义，但这一版**没有对应 API**，
声明了也用不上（`list_plugins` 会标出来）。
