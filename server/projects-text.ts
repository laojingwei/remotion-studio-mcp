/**
 * `list_projects` 的回执文案。
 *
 * 单独抽成纯函数，是因为这段文字里有三套数字要同时对上：
 *   列表行数、头部的「共 N 个」、末尾的「已归档 M 个」。
 * 早先 includeArchived:true 时头部只算了在用的（「共 6 个在用工程」却列了 22 行），
 * 这类错误只有把文案当数据测才能钉住——所以这里不碰 HTTP，只吃数据吐字符串。
 */

export type ProjectRow = {
  id: string;
  name: string;
  rev: number;
  scenes: number;
  /** 有值 = 已归档（只是从默认列表收起来，文件都还在） */
  archivedAt?: string;
};

export type ListProjectsInput = {
  projects: ProjectRow[];
  /** 当前默认工程 id（标 ★） */
  currentId?: string;
  /** true = 连已归档的一起列 */
  includeArchived?: boolean;
  dataDir?: string;
  serverUrl?: string;
  /** out/ 里有、data/ 里没有的工程 id */
  orphanIds?: string[];
};

export function formatProjectList(input: ListProjectsInput): string {
  const { projects, currentId, includeArchived, dataDir, serverUrl, orphanIds } = input;
  const nl = String.fromCharCode(10);
  const live = projects.filter((p) => !p.archivedAt);
  const archived = projects.filter((p) => p.archivedAt);
  const shown = includeArchived ? projects : live;

  if (!shown.length) {
    // 全归档了：不能说「没有工程」——文件都在，只是都收进抽屉了
    return (
      `在用的工程是 0 个，${archived.length} 个都已归档（文件都还在）：${nl}` +
      archived.map((p) => `  ${p.name}（id=${p.id}，${p.scenes} 场景）`).join(nl) +
      `${nl}恢复某个：archive_project({projectId:"…", archived:false})；要直接干活也可以显式传它的 projectId。`
    );
  }

  const header = includeArchived
    ? `共 ${projects.length} 个工程（${live.length} 个在用 + ${archived.length} 个已归档，★ = 当前默认工程）：`
    : `共 ${live.length} 个在用工程（★ = 当前默认工程）：`;

  const rows = shown
    .map(
      (p) =>
        `${p.id === currentId ? "★" : " "} ${p.name}（id=${p.id}，${p.scenes} 场景，rev=${p.rev}）` +
        (p.archivedAt ? ` · 已归档 ${p.archivedAt.slice(0, 10)}` : ""),
    )
    .join(nl);

  // 已归档的已经在上面列出来了，再说一遍名字既啰嗦又会让「不在上面」变成假话
  const archivedNote = archived.length
    ? includeArchived
      ? `${nl}${nl}上面带「已归档」的 ${archived.length} 个只是从默认列表收起来了，文件都在：` +
        `显式传 projectId 照样能改；放回列表 → archive_project({projectId, archived:false})`
      : `${nl}${nl}已归档 ${archived.length} 个（不在上面，文件都还在）：${archived
          .slice(0, 6)
          .map((p) => p.name)
          .join("、")}${archived.length > 6 ? "…" : ""}` +
        `${nl}  它们只是从默认列表收起来了：显式传 projectId 照样能改；想放回列表 → archive_project({projectId, archived:false})；` +
        `要看全 → list_projects(includeArchived:true)`
    : "";

  // 只在"没列出来"的时候才需要提醒：列出来了它就在眼前，再加一句反而让人以为有两份
  const currentHidden =
    !includeArchived && currentId && live.every((p) => p.id !== currentId)
      ? `${nl}⚠ 当前默认工程 ${currentId} 已归档：不在上面的在用列表里，但照样是默认工程`
      : "";

  const dataNote = dataDir
    ? `${nl}数据目录：${dataDir}` +
      (serverUrl
        ? `${nl}（本次连的是 ${serverUrl}；同一台机器上如果还有别的实例/别的 cwd，工程是按各自数据目录分开存的）`
        : "")
    : "";

  const orphanNote =
    orphanIds && orphanIds.length
      ? `${nl}⚠ 对账提醒：out/ 里有 ${orphanIds.length} 个工程不在当前数据目录（${orphanIds
          .slice(0, 5)
          .join("、")}${orphanIds.length > 5 ? "…" : ""}）。` +
        `${nl}  当前数据目录：${dataDir ?? "（未知）"}。这些工程要么是别的实例/别的数据目录写的，要么已被删只剩渲染产物。` +
        `${nl}  别当成「工程被删了」：先确认 SERVER_URL 指向的是不是同一个实例，再动手。`
      : "";

  return header + nl + rows + currentHidden + archivedNote + dataNote + orphanNote;
}
