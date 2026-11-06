# Git 运维手册（本仓库版）

> 用途：日常改代码、提交、回退、发版，全部按这份文档操作。
> 环境：Windows + Git Bash（本机默认 shell）。命令里的 `<>` 是占位符，尖括号本身不要敲。
>
> **三条铁律**
> 1. 动手前先 `git status` 和 `git log --oneline -5`，先看清楚再敲命令。
> 2. 已经 push 的提交不要改历史（`amend` / `reset` / `rebase`），只做 `revert`。
> 3. 任何 `--hard`、`--force`、`clean -fd` 前，先 `git stash -u` 或 `git branch backup-xxx` 留一条退路。

本仓库的关键配置（下面命令都基于它）：

| 项 | 值 |
|---|---|
| 远端 | `origin` → `https://github.com/laojingwei/remotion-studio-mcp.git` |
| 主干分支 | `main`（本地 main 跟踪 `origin/main`） |
| 行尾 | `.gitattributes` 强制 `eol=lf`；Windows 上看到 "CRLF will be replaced by LF" 是**正常提示**，不是错误 |
| 忽略 | `/data` `/out` `/public` `/docs` `/.other_modules/*` `node_modules` `.workbuddy/` |
| 发版 | 推 `v*` 标签触发 `.github/workflows/publish.yml`；CI 在 push main / PR 时跑 |

---

## 目录

1. [从零建仓库](#一从零建仓库首次)
2. [日常提交循环](#二日常提交循环)
3. [看清楚：查看与检索](#三看清楚查看与检索)
4. [暂存区操作](#四暂存区操作)
5. [撤销与回退](#五撤销与回退)
6. [合并未推送的多个提交（squash）](#六合并未推送的多个提交squash)
7. [分支](#七分支)
8. [远端操作](#八远端操作)
9. [标签与发版](#九标签与发版)
10. [本仓库的提交门禁](#十本仓库的提交门禁)
11. [事故处理](#十一事故处理)
12. [速查表](#十二速查表)

---

## 一、从零建仓库（首次）

### 1.1 本地初始化

```bash
cd /d/path/to/project          # Git Bash 里 D:\path\to\project 写成 /d/path/to/project
git init                       # 建 .git 目录（默认分支名看 git config init.defaultBranch）
git branch -M main             # 统一成 main（GitHub 默认）
git config user.name  "你的名字"
git config user.email "你的邮箱"     # 去掉 --global 就是只对本仓库生效
```

### 1.2 先写 `.gitignore`，再 `git add`

顺序不能反：先提交了 `node_modules` 再补 ignore，那些文件会一直留在历史里。

本仓库最小 `.gitignore` 骨架（完整版见仓库根目录）：

```gitignore
node_modules/
dist/
out/
*.log
.DS_Store
/data
/out
/public
workspace.json
```

### 1.3 远端建仓并关联

在 GitHub 网页上建**空**仓库（不要勾 README / .gitignore，否则首次 push 会冲突），然后：

```bash
git remote add origin https://github.com/laojingwei/remotion-studio-mcp.git
git remote -v                  # 确认 fetch/push 两条都是对的
```

已经有 remote 但地址写错了：

```bash
git remote set-url origin <新地址>
```

### 1.4 首次提交并推送

```bash
git add -A
git commit -m "init: 项目骨架"
git push -u origin main        # -u 建立跟踪关系，之后直接 git push 就行
```

`-u` 只做一次。之后 `git branch -vv` 里应该看到 `[origin/main]`。

### 1.5 首次配置建议

```bash
git config --global pull.rebase true       # pull 用 rebase，历史更直
git config --global push.default simple    # 只推当前分支
git config --global core.autocrlf true     # 本机已是 true；仓库靠 .gitattributes 落 LF
git config --global alias.lg "log --oneline --graph --decorate -20"
git config --global alias.st "status -sb"
git config --global alias.last "show --stat --oneline HEAD"
```

---

## 二、日常提交循环

```bash
git status -sb                 # 先看：哪些改了、哪些已暂存、领先远端几个提交
git diff                       # 看未暂存的具体改动
git add -p                     # 逐块挑选（推荐；y=要 n=不要 s=拆更细 e=手改 q=退出）
git diff --staged              # 提交前最后确认一遍"我要提交什么"
git commit -m "feat: xxx"      # 一行标题；需要正文见 2.2
git push
```

### 2.1 提交信息格式（本仓库沿用 Conventional Commits）

| 前缀 | 用在哪 |
|---|---|
| `feat:` | 新功能、新能力 |
| `fix:` | 修 bug |
| `refactor:` | 不改行为的重构 |
| `docs:` | 只改文档 |
| `test:` | 只改测试 |
| `chore:` | 构建、依赖、脚本 |
| `release:` | 定版、CHANGELOG 汇总 |

标题不超过 72 字符，一句话说清"改了什么"，不要写"update"、"修改一下"。

### 2.2 多行提交信息（Git Bash）

```bash
git commit -F - << 'EOF'
feat(scene3d): 深空世界与运镜重做

- 新增 world.mode:"space"
- 修 camera curve 的看向点切线

测试：npm run test:core 全绿
EOF
```

注意：
- `-m "第一行" -m "第二行"` 也能分段，但正文里不能有空行分段；
- **不要用不带 `-m`/`-F` 的 `git commit`**，那会打开编辑器（vim），在脚本/自动化里会卡住；
- 真进去了：`:wq` 保存退出，`:q!` 放弃。

### 2.3 只提交部分文件 / 部分行

```bash
git add src/a.ts src/b.ts       # 指定文件
git add -p src/a.ts             # 同一文件里的部分块
git commit -m "fix: 只修这一处"
git add -N scripts/new.mts      # 新文件先"登记"再 -p 挑块
```

---

## 三、看清楚：查看与检索

### 3.1 状态与差异

```bash
git status                      # 完整状态
git status -sb                  # 精简 + 领先/落后远端
git diff                        # 工作区 vs 暂存区
git diff --staged               # 暂存区 vs 上次提交（= git diff --cached）
git diff HEAD                   # 工作区+暂存区 vs 上次提交
git diff main...origin/main     # 本地 main 与远端分叉点之后的差异
git diff --stat                 # 只看改了哪些文件、多少行
git diff <file>                 # 单文件
git diff -w                     # 忽略空白差异（排查"只改了缩进"很有用）
```

### 3.2 历史

```bash
git log --oneline --graph --decorate -20
git log -p -2                   # 最近两次提交带 diff
git log --stat -5               # 最近五次改了哪些文件
git log --author="laojingwei" --oneline
git log --since="2026-11-01" --until="2026-11-05"
git log --oneline origin/main..HEAD       # **还没推送的提交**（最常用）
git log --oneline HEAD..origin/main       # 远端有、本地没有的提交
git log --all --oneline --graph            # 所有分支一张图
git log --follow --oneline -- path/to/file # 跟着重命名看文件历史
git log -S "searchText" --oneline          # 哪次提交引入/删除了这段文本（pickaxe）
git log -L 10,40:src/file.ts               # 看某几行的演变
```

### 3.3 单次提交

```bash
git show HEAD                    # 最新提交的完整 diff
git show <sha> --stat            # 只看文件列表
git show <sha>:path/to/file      # 看那次提交时该文件的内容（不改工作区）
git show HEAD:package.json | head -5
```

### 3.4 谁改的 / 找凶手

```bash
git blame src/scenes/scene3d/Scene3D.tsx            # 每行最后一次改动
git blame -L 100,140 src/file.ts                    # 只看 100-140 行
git log -S "0.35" --oneline -- shared/scene3dDsl.ts # 这个数字什么时候进来的
git bisect start
git bisect bad                  # 当前版本是坏的
git bisect good v1.1.0          # 这个 tag 是好的
# 每次 git 会切到中间版本，跑一遍验证，再 good/bad，直到定位
git bisect reset                # 结束，回到原分支
```

---

## 四、暂存区操作

```bash
git add <file>                  # 暂存单个文件
git add -A                      # 暂存全部（含新增/删除；等价 git add --all）
git add .                       # 暂存当前目录（注意：在某些老版本里不含删除）
git add -u                      # 只暂存"已跟踪文件的改动"，不含新文件
git add -p                      # 逐块挑选

git restore --staged <file>     # 取消暂存，改动留在工作区（Git 2.23+）
git restore --staged .          # 全部取消暂存
git reset HEAD <file>           # 老写法，等价上面
git reset                       # 清空暂存区（不动工作区）
git restore -p <file>           # 逐块取消暂存
```

删除与改名：

```bash
git rm <file>                   # 删文件并暂存删除
git rm --cached <file>          # 只从 git 里移除，文件留在磁盘（比如误提交了大文件）
git mv old.ts new.ts            # 改名（会被识别为重命名，历史能跟上）
```

---

## 五、撤销与回退

> 先判断两件事：**改的东西提交了没有**、**推没推远端**。推了就不要改历史。

### 5.1 只撤销工作区改动（还没 add）

```bash
git restore <file>              # 丢弃单个文件的改动
git restore .                   # 丢弃全部未暂存改动（危险：不可恢复）
git clean -nd                   # **先干跑**：看看哪些未跟踪文件会被删
git clean -fd                   # 真的删掉未跟踪文件（不含 .gitignore 里的）
git clean -fdx                  # 连 .gitignore 的也删（会删 node_modules，慎用）
```

### 5.2 撤销已经 add 的（还没 commit）

```bash
git restore --staged <file>     # 取消暂存，改动还在（最常用）
git restore --staged . && git restore .   # 连改动一起丢
```

### 5.3 撤销最后一次 commit（还没 push）

```bash
# 方案 A：保留改动，且保持"已暂存"状态（最安全，等于"重新提交一次"）
git reset --soft HEAD~1

# 方案 B：保留改动，但放回工作区（未暂存）
git reset HEAD~1                # = --mixed，默认档

# 方案 C：连改动一起丢（危险）
git reset --hard HEAD~1

# 只想改提交信息 / 补几个文件进上一次提交
git add <补的文件>
git commit --amend --no-edit    # 不改信息
git commit --amend -m "新信息"
```

撤销多个：

```bash
git reset --soft HEAD~3         # 撤掉最近 3 个提交，改动全部回到暂存区
git reset --hard origin/main    # 把本地 main 完全对齐远端（丢弃本地所有未推送提交！）
```

### 5.4 撤销已经 push 的提交

**不要 `reset` + `force push`**，用 `revert`（生成一个反向提交，历史不改）：

```bash
git revert <sha>                # 撤销某次提交
git revert HEAD                 # 撤销最新一次
git revert --no-commit <sha>    # 先不提交，攒几个一起提交
git revert --abort              # 撤销过程中止
git push
```

### 5.5 临时存起来（stash）

```bash
git stash push -u -m "改到一半，先拉代码"   # -u 连未跟踪文件一起存
git stash list
git stash show -p stash@{0}                 # 看内容
git stash apply stash@{0}                   # 恢复，但 stash 还留着
git stash pop                               # 恢复并删除这条 stash
git stash drop stash@{0}                    # 删掉某条
git stash clear                             # 全删（慎用）
```

### 5.6 找回"删掉/改坏"的东西

```bash
git reflog                       # HEAD 的移动历史，几乎什么都能找回来
git reset --hard HEAD@{1}        # 回到上一步（配合 reflog 用）
git checkout <sha> -- path/file  # 从某个提交里取回单个文件（会覆盖工作区）
git restore --source=HEAD~1 -- path/file   # 恢复被上一次提交删掉的文件
git switch -c rescue <sha>       # 从某个历史点开新分支救火（不打扰当前分支）
```

---

## 六、合并未推送的多个提交（squash）

场景：本地攒了 5 个 "wip"/"修一下" 的提交，还没 push，想合成一个干净提交。

### 6.1 推荐：`reset --soft` 到远端基点（最简单，不动编辑器）

```bash
git log --oneline origin/main..HEAD      # 先确认要合并哪几个
git reset --soft origin/main             # 所有改动回到暂存区，提交历史清空到远端位置
git commit -F - << 'EOF'
feat: 一句话说清这批改动

- 要点 1
- 要点 2
EOF
```

只要 `origin/main..HEAD` 是一条直线（没有合并提交），这个方法最稳。

### 6.2 合并最近 N 个（不依赖远端）

```bash
git reset --soft HEAD~5
git commit -m "feat: 合并这 5 个提交"
```

### 6.3 交互式 rebase（要挑着合并 / 改信息 / 调顺序时）

```bash
git rebase -i HEAD~5
# 编辑器里：pick 保留，squash 合到上一个，reword 改信息，drop 丢弃，然后 :wq
```

**注意**：`-i` 是交互式的，必须在能开编辑器的终端里跑；在脚本/自动化里会卡住。
只想自动合并、不改信息时用 6.1/6.2 就够了。

### 6.4 只把改动折进上一个提交

```bash
git add <files>
git commit --amend --no-edit
```

### 6.5 判断能不能安全合并

```bash
git log --oneline origin/main..HEAD   # 有输出 = 有未推送提交
git status -sb                        # 第一行 "## main...origin/main [ahead 3]" = 领先 3 个
```

如果这 3 个提交已经 push 过，**不要 squash**（会改写历史，别人拉下来就冲突了）。

---

## 七、分支

```bash
git branch                      # 本地分支
git branch -a                   # 含远端
git branch -vv                  # 含跟踪关系与领先/落后
git switch -c feat/xxx          # 新建并切换（推荐）
git switch main                 # 切换
git switch -                    # 回到上一个分支
git branch -m 新名字             # 重命名当前分支
git branch -d <分支>             # 删除已合并的分支
git branch -D <分支>             # 强删未合并的（确认不要了再用）
git push origin --delete <分支>  # 删远端分支
```

合并：

```bash
git switch main
git merge feat/xxx              # 有分叉时会产生 merge 提交
git merge --no-ff feat/xxx      # 强制保留 merge 提交（想看清分支结构时用）
git merge --squash feat/xxx     # 把整个分支压成一个改动，再 commit 一次
git merge --abort               # 合并冲突时中止，回到合并前
```

冲突处理流程：

```bash
git status                      # 会列出 "both modified" 的文件
# 手动编辑，删掉 <<<<<<< ======= >>>>>>> 三段标记，留下想要的内容
git add <解决后的文件>
git merge --continue            # 或 git rebase --continue / git cherry-pick --continue
git merge --abort               # 不想解了，整体放弃
```

常用救援：

```bash
git cherry-pick <sha>           # 把某个提交搬到当前分支
git rebase main                 # 把当前分支的提交接到 main 后面
git rebase --abort              # rebase 出错时整体回退
```

---

## 八、远端操作

```bash
git remote -v                   # 看地址
git remote add origin <url>
git remote set-url origin <url>
git fetch origin                # 只下载不合并
git fetch --prune               # 顺便清掉远端已删除的分支引用
git pull                        # fetch + merge
git pull --rebase               # fetch + rebase（推荐，历史更干净）
git push                        # 推当前分支（已建立跟踪）
git push -u origin main         # 首次推并建立跟踪
git push origin <分支>
git push origin --tags          # 推所有标签（少用，见第九章）
git push origin v1.1.1          # 只推一个标签（推荐）
```

强推（只在自己独占的分支上用）：

```bash
git push --force-with-lease     # 比 --force 安全：远端有别人新提交时会拒绝
```

### 8.1 标准三步：建分支 → 切过去 → 推送

就这三步。注意第一步的 `switch -c` 里的 `-c` 是 **create** —— 它建完**直接切过去**，
所以"创建"和"切换"本来就是一条命令，不是两条。

```bash
# ① 创建并切换（-c = create，一条命令干两件事）
git switch -c feat/xxx

# ② 确认真的在新分支上（输出 feat/xxx 就对了）
git branch --show-current

# ③ 推上去（远端没有会自动建同名分支；-u 记住跟踪关系，以后直接 git push）
git push -u origin feat/xxx
```

想拆成两条命令理解也可以，效果完全一样：

```bash
git branch feat/xxx      # 只创建，不切（此时还在原分支上）
git switch feat/xxx      # 切过去
```

补充：Git 2.23 之前没有 `switch`，老写法 `git checkout -b feat/xxx` 也是"建 + 切"一步到位。

推送成功后看到这两行，`[new branch]` 就代表**远端新建了分支**：

```
* [new branch]      feat/xxx -> feat/xxx
branch 'feat/xxx' set up to track 'origin/feat/xxx'.
```

仓库还会打印一条创建 PR 的链接：`.../pull/new/feat/xxx`。

#### 其他几种推法（按需）

```bash
git push -u origin HEAD          # 不想手打分支名：HEAD 就是当前分支
git push                         # 已经 -u 过一次，以后一条就够
git push -u origin 本地名:远端名   # 本地与远端名字不一样
```

#### 推之前先看一眼

```bash
git status -sb                       # "## feat/xxx...origin/feat/xxx [ahead 2]" = 有 2 个提交要推
git log --oneline origin/main..HEAD  # 这次具体会推哪些提交
```

**没写进提交的东西不会被推**：未跟踪（`??`）和未暂存的文件只在本机。
`git status` 里还挂着 `??`，就说明它没上去。

### 8.2 撤销一次误推

分三种情况，**先搞清楚远端那个分支是不是自己刚建的**：

```bash
# ① 只删远端分支，本地提交全留着（最常见：推错了分支名/不该推这个分支）
git push origin --delete feat/xxx
# 等价写法：git push origin :feat/xxx

# ② 连本地分支一起清掉（提交还在 main 或 reflog 里）
git switch main
git branch -d feat/xxx

# ③ 推的是 main、但内容不该推：不要删 main，用 revert 生成反向提交
git revert <sha>
git push
```

删完确认：

```bash
git branch -r                  # 远端分支列表里不该再有 feat/xxx
git branch -vv                 # 本地不该再有该分支
git fetch --prune              # 清掉本地的 origin/feat/xxx 引用
```

注意事项：

- **删远端分支 ≠ 删提交**：只要提交还挂在别的分支（如 main）上就一直在；只有"只存在于这个分支"的提交才会在远端变成不可达（本地 reflog 还能找回，见 5.6）。
- **绝不要用删 main 的方式"撤销误推"**：主干被删的破坏面比多推几个提交大得多。
- 删远端分支后，之前开过的 PR 会变成 "closed"，不会自动删掉。

清理：

```bash
git fetch --prune && git branch -vv     # 找出 "[origin/xxx: gone]" 的本地分支
git branch -d <gone 的分支>
```

---

## 九、标签与发版

### 9.1 打标签

```bash
git tag -a v1.1.1 -m "1.1.1：本地资源库 + 序列帧播放"   # 附注标签（推荐，带作者/日期/说明）
git tag v1.1.1                                        # 轻量标签（只是个指针，不留说明）
git tag -l "v1.1.*"                                   # 查
git show v1.1.1                                       # 看标签信息
git describe --tags                                    # 当前提交最近的标签
```

**标签打在"版本号已经改好、测试已通过"的那个提交上**，不要打在后面又改了代码的提交上。

### 9.2 推标签

```bash
git push origin v1.1.1          # 只推这一个（推荐）
git push origin --tags          # 推全部本地标签（容易把试验标签也推上去）
```

### 9.3 删标签

```bash
git tag -d v1.1.1                       # 删本地
git push origin :refs/tags/v1.1.1       # 删远端（简写 git push origin :v1.1.1）
```

标签已经触发过发版就不能"重打同一个号"了 —— npm 上同名版本发不上去，必须升版本号。

### 9.4 本仓库的发版流程（照这个顺序）

```bash
# 1. 改版本号（package.json 是唯一来源；这一步会连 package-lock.json 一起同步）
npm version 1.2.0 --no-git-tag-version   # 只改文件，不自动打 tag

# 2. 更新 CHANGELOG.md，在顶部加一节 [1.2.0]（漏写会红）
#    顺手扫一遍 README 里写死的东西：版本行、工具计数、能力清单

# 3. 全仓版本一致性检查（package.json / README / CHANGELOG / 代码里写死的版本 / lock）
node scripts/check-version.mjs

# 4. 测试（至少核心集）
npm run typecheck
npm run test:core                # 全量是 npm test，比较慢

# 5. 发布包内容守卫（files 白名单漏文件 / 混进本机生成物都会红）
npm run check:package

# 6. 提交
git add -A
git commit -m "release: 1.2.0 —— 一句话说明"
git push

# 7. 打标签并推送（publish.yml 监听 push tags: v*）
git tag -a v1.2.0 -m "1.2.0：一句话说明"
git push origin v1.2.0

# 8. 去 GitHub → Actions 看 publish 是否成功；
#    成功后再去 Releases 页面基于这个 tag 补一份带说明的发布记录（不会重复发布）
```

`publish.yml` 会校验 **tag 与 package.json 版本一致**，不一致直接失败——所以第 3 步不能跳。

---

## 十、本仓库的提交门禁

提交前按需跑（不是每次都跑全量，但改动涉及核心逻辑时别省）：

```bash
npm run typecheck                       # tsc --noEmit，最便宜的一道
npm run test:core                       # 核心集（ops/store/security/scene3d…）
npm test                                # 全量（很慢，发版前跑）
node scripts/check-version.mjs          # 动了版本号必跑
```

改 3D 场景时另跑：

```bash
npx tsx scripts/test-scene3d-dsl.mts
npx tsx scripts/test-scene3d-graph.mts
npx tsx scripts/test-scene3d-edit.mts
```

改完 demo 工程数据（`scripts/seeds/*`）要确认它和运行数据一致——本仓库的 demo 由种子生成，
只改 `data/projects/...` 不改种子，别人 clone 下来重建就回到旧版。

### 不该进仓库的东西（已在 `.gitignore`）

| 路径 | 原因 |
|---|---|
| `/data` `/out` `/public` | 本机工程数据与产物；workspace 迁移后会变成符号链接，提交进去 clone 下来是坏链接 |
| `/docs` | 本机工作笔记（含工程 ID、本机路径、阶段性结论） |
| `/.other_modules/*` | 第三方代码，按需下载，只留 `.gitkeep` |
| `workspace.json` | 本机工作空间路径配置 |
| `.workbuddy/` | agent 的本地记忆 |

提交前用 `git status --short` 扫一眼，**看到 `data/` `out/` 之类出现就要停手**：说明 ignore 规则被破坏或用了 `git add -f`。

---

## 十一、事故处理

| 情况 | 处理 |
|---|---|
| 提交里混进了不该提交的文件 | `git rm --cached <file>` → 加进 `.gitignore` → `git commit --amend --no-edit` |
| 已经 push 了才发现 | 用 `git revert <sha>`（不要 reset + force） |
| 推错了分支 / 不该推的分支 | `git push origin --delete <分支>` → `git branch -d <分支>`，提交本身不会丢（见 8.2） |
| 误删了分支 | `git reflog` 找到 sha → `git switch -c <分支> <sha>` |
| `reset --hard` 之后想找回 | `git reflog` → `git reset --hard HEAD@{n}` |
| 改坏了一个文件 | `git restore --source=HEAD -- <file>` |
| 拉代码冲突太多想重来 | `git merge --abort` 或 `git rebase --abort`；确认本地没东西要了再 `git reset --hard origin/main` |
| 提示 "Your local changes would be overwritten" | 先 `git stash push -u`，操作完再 `git stash pop` |
| 大文件让 push 失败 | 不要提交二进制产物；已经提交的用 `git rm --cached` 移除后 amend（历史里仍占空间，需 `git filter-repo` 才能彻底清） |
| 满屏 "CRLF will be replaced by LF" | 正常提示。`.gitattributes` 规定仓库内用 LF，本机用 CRLF，不影响内容 |
| 误把 `node_modules` 提交了 | `git rm -r --cached node_modules` → 确认 ignore → `git commit --amend` |
| 想临时回到某个历史版本看看 | `git switch -c tmp <sha>`（别在当前分支上 `checkout <sha>`，容易"游离 HEAD"里改丢） |
| 停止当前操作 | `git merge --abort` / `git rebase --abort` / `git cherry-pick --abort` / `git revert --abort` |

### 游离 HEAD（detached HEAD）怎么回去

```bash
git switch -                   # 回到上一个分支
# 或
git switch main
# 如果已经在游离状态改了一堆东西想保住：
git switch -c rescue-work      # 新建分支把这些改动带走
```

---

## 十二、速查表

```bash
# ── 看 ──────────────────────────────────────────────
git status -sb                      # 状态 + 领先/落后
git log --oneline --graph -20       # 历史图
git log --oneline origin/main..HEAD # 未推送的提交
git diff / --staged / --stat        # 未暂存 / 已暂存 / 概览

# ── 提交 ────────────────────────────────────────────
git add -p                          # 逐块暂存（推荐）
git add -A                          # 全部暂存
git restore --staged <file>         # 取消暂存
git commit -F - << 'EOF' … EOF      # 多行提交信息
git push                            # 推当前分支

# ── 撤销 ────────────────────────────────────────────
git restore <file>                  # 丢弃工作区改动（不可恢复）
git reset --soft HEAD~1             # 撤提交、改动留暂存区
git reset --hard HEAD~1             # 撤提交 + 丢改动（危险）
git commit --amend --no-edit        # 补进上一次提交
git revert <sha>                    # 撤销已推送的提交（安全）

# ── 合并未推送的提交 ────────────────────────────────
git reset --soft origin/main && git commit -F - << 'EOF' … EOF

# ── 临时保存 ────────────────────────────────────────
git stash push -u -m "说明"         # 存
git stash pop                       # 取回并删除

# ── 分支 ────────────────────────────────────────────
git switch -c feat/x                # 新建
git switch main                     # 切换
git merge --no-ff feat/x            # 合并
git branch -d feat/x                # 删本地

# ── 远端 ────────────────────────────────────────────
git push -u origin feat/xxx         # 推到远端分支（没有就自动创建）
git push origin --delete feat/xxx   # 删远端分支（提交不会丢）
git fetch --prune                   # 同步远端引用并清垃圾
git pull --rebase                   # 拉代码（rebase 方式）
git push --force-with-lease         # 强推（仅自己的分支）

# ── 标签 / 发版 ─────────────────────────────────────
git tag -a v1.1.2 -m "说明"
git push origin v1.1.2              # 触发 publish.yml
git tag -d v1.1.2                   # 删本地标签
git push origin :refs/tags/v1.1.2   # 删远端标签

# ── 救火 ────────────────────────────────────────────
git reflog                          # 找丢失的提交
git reset --hard HEAD@{1}           # 回到上一步
git switch -c rescue <sha>          # 从历史点开分支
```

---

## 附录：这台机器上的位置

| 用途 | 路径 |
|---|---|
| 仓库根 | `/d/path/to/project/remotion-studio-mcp` |
| 本文档 | `GIT-OPS.md`（根目录） |
| 提交信息模板（可选） | 无；统一用 heredoc 写正文 |
| 发版工作流 | `.github/workflows/publish.yml` |
| CI | `.github/workflows/ci.yml` |
