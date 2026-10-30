import { promises as fs } from "node:fs";
import path from "node:path";
import { formatValue, selectRecords, type DuoweiDoc } from "../src/widgets/duoweiCore";
import { loadAnnotations } from "../src/widgets/annotations";
import { buildDigest } from "../src/widgets/duoweiDigest";
import { loadWechat } from "../src/widgets/wechat";
import { TFile, TFolder } from "obsidian";
import { WidgetRegistry } from "../src/core/widgetRegistry";
import { BUILTIN_WIDGETS } from "../src/widgets/builtins";
import { sanitizeSettings, sanitizeWidget } from "../src/settings";
import { buildMocIndex } from "../src/widgets/allnotes";
import { habitStreak } from "../src/widgets/habit";
import { advanceSession, bumpHistory, formatClock, pauseSession, pomodoroWidget, remainingMs, resetSession, startSession, type PomodoroConfig } from "../src/widgets/pomodoro";
import { VaultIndex } from "../src/services/vaultIndex";

import { cmaIcon, normalizeHost, parseCoords, qweatherIcon, rankCmaCandidates, splitQuery, stripSuffix } from "../src/utils/weather";
import { parseOpml, exportOpml } from "../src/utils/opml";
import {
  getCachedMediaData,
  htmlToMarkdown,
  loadDiskCache,
  mediaWidget,
  parseQiushiCatalog,
  parseQiushiIssueArticles,
  parseRssArticles,
  parseZjxcArticles,
  saveDiskCacheNow,
  syncMediaData
} from "../src/widgets/media";

const normalizePomodoro = (raw: Record<string, unknown>): PomodoroConfig => pomodoroWidget.normalizeConfig!(raw);
const TEST_REGISTRY = new WidgetRegistry(BUILTIN_WIDGETS);

const VAULT = process.env.HOME_DECK_TEST_VAULT ?? process.env.HOME_PAGES_TEST_VAULT ?? "D:/data/obsidian_pls/duowei-stress-vault";
let failures = 0;
let skippedSuites = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` → ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}

function skip(suite: string, reason: string): void {
  console.log(`SKIP ${suite} — ${reason}`);
  skippedSuites += 1;
}

const vaultReady = await fs.stat(VAULT).then(() => true, () => false);
const vaultMissingReason = `夹具库不存在：${VAULT}（用 HOME_DECK_TEST_VAULT 指定）`;

async function runWithVault(suite: string, fn: () => Promise<void>): Promise<void> {
  if (!vaultReady) {
    skip(suite, vaultMissingReason);
    return;
  }
  await fn();
}

async function testDuowei(): Promise<void> {
  const doc = JSON.parse(await fs.readFile(path.join(VAULT, "项目经理一日日程.duowei"), "utf8")) as DuoweiDoc;
  const base = {
    path: "", mode: "records" as const, view: "", chart: "", chartType: "" as const, fields: [],
    titleField: "", showFields: [], filterField: "", filterValue: "", dateField: "", dateRange: "all" as const,
    sortField: "", sortDir: "asc" as const, limit: 100
  };
  const meetings = selectRecords(doc, { ...base, filterField: "事项类型", filterValue: "团队会议" });
  check("filter by singleSelect option name", meetings.length > 0 && meetings.every((r) => r.values.fld_type === "opt_meeting"), meetings.length);
  const sorted = selectRecords(doc, { ...base, sortField: "开始时间", sortDir: "desc" });
  const starts = sorted.map((r) => String(r.values.fld_start));
  check("sort desc by dateTime", starts.every((v, i) => i === 0 || starts[i - 1] >= v), starts.slice(0, 3));
  const today = selectRecords(doc, { ...base, dateField: "开始时间", dateRange: "today" });
  check("date range today (demo dates are 2026-07-27)", today.length === 0, today.length);
  const overdue = selectRecords(doc, { ...base, dateField: "开始时间", dateRange: "overdue" });
  check("date range overdue includes all demo rows", overdue.length === doc.records.length, overdue.length);
  const typeField = doc.fields.find((f) => f.name === "事项类型");
  const chips = typeField ? formatValue(typeField, "opt_focus") : [];
  check("select chip resolves name + color", chips[0]?.text === "个人专注" && chips[0]?.color === "var(--color-green)", chips);
  check("limit respected", selectRecords(doc, { ...base, limit: 2 }).length === 2);
}

/** 用磁盘目录模拟 vault：getFiles 列出文件，getAbstractFileByPath 返回带 stat 的 TFile。 */
async function fakeApp(root: string = VAULT): Promise<{ app: unknown }> {
  const files: TFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(rel);
      else {
        const file = new TFile();
        file.path = rel;
        file.name = entry.name;
        file.basename = entry.name.replace(/\.[^.]+$/, "");
        file.extension = entry.name.split(".").pop() ?? "";
        const stat = await fs.stat(path.join(root, rel));
        file.stat = { ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size };
        files.push(file);
      }
    }
  };
  await walk("");
  const byPath = new Map(files.map((file) => [file.path, file]));
  const app = {
    vault: {
      configDir: ".obsidian",
      getFiles: () => files,
      getAbstractFileByPath: (p: string) => byPath.get(p) ?? null,
      cachedRead: async (file: TFile) => fs.readFile(path.join(root, file.path), "utf8"),
      getResourcePath: (file: TFile) => `app://local/${file.path}`,
      adapter: {
        exists: async (p: string) => fs.stat(path.join(root, p)).then(() => true, () => false),
        read: async (p: string) => fs.readFile(path.join(root, p), "utf8"),
        stat: async (p: string) => fs.stat(path.join(root, p)).then((stat) => ({ mtime: stat.mtimeMs, ctime: stat.ctimeMs, size: stat.size }), () => null),
        list: async (p: string) => {
          const entries = await fs.readdir(path.join(root, p), { withFileTypes: true });
          return {
            files: entries.filter((e) => e.isFile()).map((e) => `${p}/${e.name}`),
            folders: entries.filter((e) => e.isDirectory()).map((e) => `${p}/${e.name}`)
          };
        },
        getResourcePath: (p: string) => `app://local/${p}`
      }
    }
  };
  return { app };
}

/** 情报摘要用独立的临时夹具，不依赖测试库里会被手工改动的表。 */
async function writeDigestFixture(): Promise<string> {
  const root = path.resolve("tests/.out/fixture");
  await fs.mkdir(root, { recursive: true });
  const day = (offset: number): string => {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const stamp = (daysAgo: number): string => new Date(Date.now() - daysAgo * 86400000).toISOString();
  const options = [
    { id: "o_todo", name: "待办", color: "var(--color-blue)" },
    { id: "o_doing", name: "进行中", color: "var(--color-orange)" },
    { id: "o_done", name: "已完成", color: "var(--color-green)" }
  ];
  const rows: Array<[string, string, string, string, number]> = [
    ["写周报", "o_todo", day(-1), day(0), 1],
    ["发票报销", "o_todo", day(-6), day(-2), 5],
    ["准备评审材料", "o_doing", day(1), day(3), 0],
    ["阅读论文 Qlib", "o_doing", "", "", 0],
    ["已完成的旧任务", "o_done", day(-5), day(-1), 0],
    ["下月规划", "o_todo", day(15), day(20), 0],
    ["昨天改过的备忘", "o_todo", "", "", 1]
  ];
  const doc = {
    schemaVersion: 1, id: "tbl_fixture", name: "测试任务", titleFieldId: "f_title",
    fields: [
      { id: "f_title", name: "任务", type: "text" },
      { id: "f_status", name: "状态", type: "singleSelect", options },
      { id: "f_start", name: "开始日期", type: "date" },
      { id: "f_due", name: "截止日期", type: "date" }
    ],
    records: rows.map(([title, status, start, due, ago], index) => ({
      id: `r${index}`, revision: 0, values: { f_title: title, f_status: status, f_start: start, f_due: due }, createdAt: stamp(ago), updatedAt: stamp(ago)
    })),
    views: [], meta: { createdAt: stamp(0), updatedAt: stamp(0), revision: 1 }
  };
  await fs.writeFile(path.join(root, "测试任务.duowei"), JSON.stringify(doc), "utf8");
  await fs.writeFile(path.join(root, "备份.自动备份.2026-01-01.duowei"), JSON.stringify(doc), "utf8");
  await fs.writeFile(path.join(root, "微信收件箱.duowei"), JSON.stringify({ ...doc, id: "tbl_w2o", meta: { ...doc.meta, wechat2ob: 1 } }), "utf8");
  return root;
}

/** 多维表格内置微信收件箱夹具：管理字段 + 状态选项，写在夹具根的 .obsidian/plugins/duowei-table-pro/data.json 指向的表。 */
async function writeInboxFixture(root: string): Promise<void> {
  const stamp = (hoursAgo: number): string => new Date(Date.now() - hoursAgo * 3600000).toISOString();
  const typeOptions = [["文字", "o_text"], ["图片", "o_image"], ["语音", "o_voice"]].map(([name, id]) => ({ id, name, color: "var(--color-blue)" }));
  const statusOptions = [{ id: "o_pending", name: "待整理", color: "var(--color-orange)" }, { id: "o_done", name: "已整理", color: "var(--color-green)" }];
  const fields = [
    { id: "f_title", name: "标题", type: "text" },
    { id: "f_content", name: "内容", type: "longText" },
    { id: "f_type", name: "类型", type: "singleSelect", options: typeOptions },
    { id: "f_att", name: "附件", type: "attachment" },
    { id: "f_transcript", name: "语音转写", type: "longText" },
    { id: "f_received", name: "接收时间", type: "dateTime" },
    { id: "f_status", name: "状态", type: "singleSelect", options: statusOptions }
  ];
  const records = [
    { id: "m1", values: { f_title: "合同", f_content: "记得明天把合同发给王总", f_type: "o_text", f_received: stamp(1), f_status: "o_pending" } },
    { id: "m2", values: { f_title: "开会", f_content: "", f_transcript: "今天下午三点开会", f_type: "o_voice", f_received: stamp(3), f_status: "o_pending" } },
    { id: "m3", values: { f_title: "图", f_content: "", f_type: "o_image", f_att: ["[[收件箱/微信收件箱附件/2026-09/abc-demo.png]]"], f_received: stamp(30), f_status: "o_done" } }
  ].map((record) => ({ ...record, revision: 0, createdAt: stamp(0), updatedAt: stamp(0) }));
  const doc = { schemaVersion: 1, id: "tbl_inbox", name: "微信收件箱", titleFieldId: "f_title", fields, records, views: [{ id: "v_k", name: "看板", type: "kanban", groupFieldId: "f_status", fieldOrder: [], hiddenFields: [], sorts: [], filters: [], filterConjunction: "and", colorRules: [], collapsedDetailGroups: [] }], meta: { createdAt: stamp(0), updatedAt: stamp(0), revision: 1 } };
  await fs.mkdir(path.join(root, "收件箱"), { recursive: true });
  await fs.writeFile(path.join(root, "收件箱/微信收件箱.duowei"), JSON.stringify(doc), "utf8");
  await fs.mkdir(path.join(root, ".obsidian/plugins/duowei-table-pro"), { recursive: true });
  await fs.writeFile(path.join(root, ".obsidian/plugins/duowei-table-pro/data.json"), JSON.stringify({
    weixinInbox: { endpoint: "http://127.0.0.1:7341", tablePath: "收件箱/微信收件箱.duowei", clientId: "obsidian-test", autoSyncSeconds: 3, fieldMap: { titleFieldId: "f_title", contentFieldId: "f_content", typeFieldId: "f_type", attachmentFieldId: "f_att", transcriptFieldId: "f_transcript", receivedAtFieldId: "f_received", senderFieldId: "x", sessionFieldId: "x", messageIdFieldId: "x", statusFieldId: "f_status", pendingStatusOptionId: "o_pending", typeOptionIds: {} } }
  }), "utf8");
}

async function testDuoweiInbox(): Promise<void> {
  const root = await writeDigestFixture();
  await writeInboxFixture(root);
  const { app } = await fakeApp(root);
  const config = { source: "auto" as const, duoweiPluginId: "duowei-table-pro", duoweiTablePath: "", pluginId: "wechat2ob", stateFolder: "", showStats: true, showThumbs: true, days: 0, limit: 10, kinds: [], pendingOnly: false };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await loadWechat(app as any, config);
  check("auto picks the table-plugin inbox", data.ready && data.source === "duowei" && data.tablePath === "收件箱/微信收件箱.duowei", [data.ready, data.source, data.tablePath]);
  check("inbox counts", data.items.length === 3 && data.pending === 2 && data.today >= 2 && data.attachments === 1, [data.items.length, data.pending, data.today, data.attachments]);
  check("kind from 类型 option label", data.items.find((item) => item.recordId === "m2")?.kind === "voice");
  check("text prefers 内容 then 语音转写", data.items.find((item) => item.recordId === "m2")?.text === "今天下午三点开会");
  check("attachment link parsed to image thumbnail", data.items.find((item) => item.recordId === "m3")?.image === "收件箱/微信收件箱附件/2026-09/abc-demo.png", data.items.find((item) => item.recordId === "m3"));
  check("status + mark-done metadata exposed", data.duowei?.doneOptionId === "o_done" && data.duowei.pendingOptionId === "o_pending" && data.duowei.kanbanViewId === "v_k");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pendingOnly = await loadWechat(app as any, { ...config, pendingOnly: true });
  check("pendingOnly filter", pendingOnly.items.length === 2 && pendingOnly.items.every((item) => item.pending));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const forced = await loadWechat(app as any, { ...config, source: "wechat2ob" });
  check("forcing wechat2ob without journals → not ready", !forced.ready && forced.source === "wechat2ob");
}

async function testDigest(): Promise<void> {
  const root = await writeDigestFixture();
  await writeInboxFixture(root);
  const { app } = await fakeApp(root);
  const options = { folder: "", excludeTables: [], dateFieldNames: [], upcomingDays: 7, overdueDays: 30, recentDays: 3, sectionLimit: 6, sections: ["overdue", "today", "upcoming", "active", "recent"] as const };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const digest = await buildDigest(app as any, { ...options, sections: [...options.sections] });
  const bySection = (section: string): string[] => digest.items.filter((item) => item.section === section).map((item) => item.title);
  check("digest scans only the real task table", digest.tables === 1, digest.tables);
  check("today by due date (not start date)", bySection("today").includes("写周报"), bySection("today"));
  check("overdue section", bySection("overdue").includes("发票报销"), bySection("overdue"));
  check("upcoming section (3 days)", bySection("upcoming").includes("准备评审材料"), bySection("upcoming"));
  check("active by status", bySection("active").includes("阅读论文 Qlib"), bySection("active"));
  check("recent updates", bySection("recent").includes("昨天改过的备忘"), bySection("recent"));
  check("done records skipped", !digest.items.some((item) => item.title === "已完成的旧任务"));
  check("far-future record only appears as recent update", digest.items.find((item) => item.title === "下月规划")?.section === "recent");
  check("status chip carried", digest.items.find((item) => item.title === "写周报")?.status?.text === "待办");
  check("wechat inbox tables skipped (both flavours)", !digest.items.some((item) => item.tablePath.includes("微信收件箱")) && digest.tables === 1, digest.items.map((item) => item.tablePath));
  check("backup tables skipped", !digest.items.some((item) => item.tablePath.includes("自动备份")));
}

async function testWechat(): Promise<void> {
  const { app } = await fakeApp();
  const config = { source: "wechat2ob" as const, duoweiPluginId: "duowei-table-pro", duoweiTablePath: "", pluginId: "wechat2ob", stateFolder: "", showStats: true, showThumbs: true, days: 14, limit: 10, kinds: [], pendingOnly: false };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await loadWechat(app as any, config);
  check("wechat journals loaded", data.ready && data.items.length === 4, [data.ready, data.items.length]);
  check("today / week counts", data.today >= 0 && data.week >= 0, [data.today, data.week]);
  check("pending from managed table", data.pending === 2, data.pending);
  check("voice message uses transcript", data.items.some((item) => item.kind === "voice" && item.text.includes("开会")));
  check("image message has thumbnail + attachment", data.items.some((item) => item.kind === "image" && item.image?.endsWith("demo-image.png")));
  check("note path from receipts", data.items[0]?.notePath?.startsWith("日记/") === true, data.items[0]);
  check("sorted newest first", data.items[0].receivedAt >= data.items[1].receivedAt);
  check("today note path resolved", data.todayNotePath.startsWith("日记/"), data.todayNotePath);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filtered = await loadWechat(app as any, { ...config, kinds: ["text"] });
  check("kind filter", filtered.items.every((item) => item.kind === "text") && filtered.items.length === 2, filtered.items.length);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const missing = await loadWechat(app as any, { ...config, pluginId: "nope-plugin" });
  check("missing plugin → not ready", !missing.ready);
}

async function testAnnotations(): Promise<void> {
  const adapterPath = (p: string): string => path.join(VAULT, p);
  const app = {
    vault: {
      configDir: ".obsidian",
      getAbstractFileByPath: () => null,
      adapter: {
        exists: async (p: string) => fs.stat(adapterPath(p)).then(() => true, () => false),
        read: async (p: string) => fs.readFile(adapterPath(p), "utf8"),
        list: async (p: string) => {
          const entries = await fs.readdir(adapterPath(p), { withFileTypes: true });
          return {
            files: entries.filter((e) => e.isFile()).map((e) => `${p}/${e.name}`),
            folders: entries.filter((e) => e.isDirectory()).map((e) => `${p}/${e.name}`)
          };
        },
        getResourcePath: (p: string) => `app://local/${p}`
      }
    }
  };
  const config = {
    pluginId: "mobile-ink-annotation-pro",
    centerFolder: "Annotations/annotation-center",
    mdSourceFolder: "Annotations/md-source-annotations",
    cardsFolder: "Annotations/card-favorites",
    showStats: true, showList: true, showPreview: true,
    status: "all" as const, collection: "", sortBy: "updatedAt" as const, limit: 10, panel: "annotations" as const
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await loadAnnotations(app as any, config);
  check("index loaded", data.ready);
  check("counts inbox/archived", data.inbox === 5 && data.archived === 1, [data.inbox, data.archived]);
  check("question bank due today", data.questions === 7 && data.due >= 0, [data.questions, data.due]);
  check("cards count", data.cards === 2, data.cards);
  check("collections with counts", data.collections.find((c) => c.id === "mistakes")?.count === 1, data.collections);
  const md = data.items.find((i) => i.type === "md-source");
  check("md-source item resolves text + open target", md?.text === "这一句被原文批注选中了。" && !!md.openTarget && "path" in md.openTarget && md.openTarget.line === 4, md);
  const collected = data.items.find((i) => i.type === "collected");
  check("collected item uses backlink", !!collected?.openTarget && "link" in collected.openTarget && collected.openTarget.link === "示例笔记.md", collected?.openTarget);
  const hw = data.items.find((i) => i.key === "handwriting:aaa2");
  check("card path picked from cardPaths", hw?.cardPath === "Annotations/Cards/学习卡片-示例.md", hw?.cardPath);
  check("sorted by updatedAt desc", data.items[0]?.key === "handwriting:aaa1", data.items.map((i) => i.key));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const missing = await loadAnnotations(app as any, { ...config, centerFolder: "Annotations/nope" });
  check("missing folder → not ready", !missing.ready);
}

function testRegistry(): void {
  const registry = new WidgetRegistry(BUILTIN_WIDGETS);
  const before = registry.list().length;
  const knowledgeMap = registry.get("knowledgemap");
  check("knowledge map widget registered", knowledgeMap?.name === "知识地图", knowledgeMap);
  const knowledgeMapDefaults = knowledgeMap?.defaultConfig();
  check(
    "knowledge map uses native graph defaults",
    knowledgeMapDefaults?.colorize === true && knowledgeMapDefaults.scopeMode === "knowledge" && knowledgeMapDefaults.showStats === true && knowledgeMap!.defaultSize.h >= 10
  );
  const normalizedMap = knowledgeMap?.normalizeConfig?.({
    scopeMode: "unknown",
    excludeFolders: "Archive\n\nKnowledge/_mocs",
    showStats: false,
    showCounts: false
  });
  check(
    "knowledge map normalizes range and toggles",
    normalizedMap?.scopeMode === "knowledge" && normalizedMap.excludeFolders.length === 2 && normalizedMap.showStats === false && normalizedMap.showCounts === false,
    normalizedMap
  );
  const events: string[] = [];
  const off = registry.onChange((kind, registered) => events.push(`${kind}:${registered}`));
  const unregister = registry.register({
    kind: "third-party-demo", name: "演示", description: "", icon: "plug", accent: "#000",
    defaultSize: { w: 4, h: 4 }, defaultConfig: () => ({ ref: "" }),
    render: () => undefined, renderSettings: () => undefined
  }, "demo-plugin");
  check("third-party widget registered", registry.list().length === before + 1 && registry.get("third-party-demo")?.name === "演示");
  const kept = sanitizeWidget({ id: "x", kind: "not-loaded-kind", w: 5, h: 3, config: { ref: "a#b" }, provider: "some-plugin" });
  check("unknown kind survives sanitize with config + provider", kept?.kind === "not-loaded-kind" && kept.config.ref === "a#b" && kept.provider === "some-plugin" && kept.w === 5, kept);
  check("createInstance for unknown kind uses fallback size", registry.createInstance("nope", { config: { a: 1 } }).w === 6);
  let threw = false;
  try {
    registry.register({ kind: "hero", name: "x", description: "", icon: "", accent: "", defaultSize: { w: 1, h: 1 }, defaultConfig: () => ({}), render: () => undefined, renderSettings: () => undefined });
  } catch {
    threw = true;
  }
  check("built-in kinds cannot be overridden", threw);
  unregister();
  check("unregister removes definition and notifies", registry.get("third-party-demo") === undefined && events.join(",") === "third-party-demo:true,third-party-demo:false", events);
  off();

  const other = new WidgetRegistry(BUILTIN_WIDGETS);
  other.register({ kind: "isolated", name: "隔离", description: "", icon: "", accent: "", defaultSize: { w: 1, h: 1 }, defaultConfig: () => ({}), render: () => undefined, renderSettings: () => undefined });
  check("registries are instance-isolated", registry.get("isolated") === undefined && other.get("isolated") !== undefined);
}

async function testSharedVaultStats(): Promise<void> {
  const today = new Date(2026, 9, 30, 12, 0, 0);
  const todayTimestamp = today.getTime();
  const recent = new TFile();
  recent.path = "Daily/today.md";
  recent.extension = "md";
  recent.basename = "2026-10-30";
  recent.stat = { ctime: todayTimestamp, mtime: todayTimestamp, size: 3_000 };
  const archived = new TFile();
  archived.path = "Archive/old.md";
  archived.extension = "md";
  archived.basename = "old";
  archived.stat = { ctime: new Date(2020, 0, 1).getTime(), mtime: new Date(2020, 0, 1).getTime(), size: 600 };
  const attachment = new TFile();
  attachment.path = "Daily/image.png";
  attachment.extension = "png";
  attachment.stat = { ctime: todayTimestamp, mtime: todayTimestamp, size: 20_000 };
  const folders = [new TFolder(), new TFolder()];
  folders[0].path = "Daily";
  folders[1].path = "Archive";

  let getFilesCalls = 0;
  let getLoadedCalls = 0;
  const app = {
    vault: {
      getFiles: () => {
        getFilesCalls += 1;
        return [recent, archived, attachment];
      },
      getAllLoadedFiles: () => {
        getLoadedCalls += 1;
        return [...folders];
      }
    },
    metadataCache: {
      getTags: () => ({ "#daily": 2, "#archive": 1 })
    }
  };
  const index = new VaultIndex(() => app as never, {
    now: () => todayTimestamp,
    notifyDebounceMs: 5,
    notifyMaxWaitMs: 20
  });
  const first = index.getStats();
  const second = index.getStats();
  check("vault stats reuse one filesystem snapshot across consumers", first === second && getFilesCalls === 1 && getLoadedCalls === 1, [
    first === second,
    getFilesCalls,
    getLoadedCalls
  ]);
  check(
    "vault stats count notes, folders, age and activity",
    first.noteCount === 2 &&
      first.folderCount === 2 &&
      first.tagCount === 2 &&
      first.earliestDay === "2020-01-01" &&
      first.activityByDay["2026-10-30"] === 1,
    first
  );
  const filtered = index.getStats({ excludeFolders: ["Archive"] });
  check(
    "filtered stats share the same base snapshot",
    filtered.noteCount === 1 &&
      filtered.attachmentCount === 1 &&
      filtered.todayNotes === 1 &&
      getFilesCalls === 1,
    filtered
  );
  check(
    "cached markdown arrays and basename index are reused",
    index.getMarkdownFiles() === index.getMarkdownFiles() && index.getMarkdownByBasename().get("2026-10-30") === recent
  );

  let notifications = 0;
  let lastReason = "";
  let lastPaths: readonly string[] = [];
  let lastOperations: readonly string[] = [];
  const unsubscribe = index.subscribe((change) => {
    notifications += 1;
    lastReason = change.reason;
    lastPaths = change.paths;
    lastOperations = change.operations;
  });
  const created = new TFile();
  created.path = "Knowledge/new.md";
  created.extension = "md";
  created.basename = "new";
  created.stat = { ctime: todayTimestamp, mtime: todayTimestamp, size: 10 };
  const deleted = new TFile();
  deleted.path = "Knowledge/old.md";
  deleted.extension = "md";
  deleted.basename = "old";
  deleted.stat = { ctime: todayTimestamp, mtime: todayTimestamp, size: 10 };
  index.applyCreate(created);
  index.applyDelete(deleted);
  index.applyMetadata("Knowledge/_mocs/MOC.md");
  await new Promise((resolve) => setTimeout(resolve, 35));
  check(
    "vault change bursts merge one notification with scoped paths",
    notifications === 1 &&
      lastReason === "mixed" &&
      lastPaths.join(",") === "Knowledge/new.md,Knowledge/old.md,Knowledge/_mocs/MOC.md" &&
      lastOperations.join(",") === "create,delete,metadata",
    [notifications, lastReason, lastPaths, lastOperations]
  );
  index.getStats();
  check(
    "incremental invalidation keeps the file snapshot and only refreshes folders",
    getFilesCalls === 1 && getLoadedCalls === 2,
    [getFilesCalls, getLoadedCalls]
  );
  unsubscribe();
  index.dispose();
}

async function testPerformanceGuards(): Promise<void> {
  const registry = new WidgetRegistry(BUILTIN_WIDGETS);
  check("stats and hero defer their own vault refresh", registry.get("stats")?.liveRefresh === false && registry.get("hero")?.liveRefresh === false);
  check(
    "vault-wide list widgets own scoped refresh",
    registry.get("allnotes")?.liveRefresh === false &&
      registry.get("recent")?.liveRefresh === false &&
      registry.get("diary")?.liveRefresh === false &&
      registry.get("kanban")?.liveRefresh === false
  );

  const moc = new TFile();
  moc.path = "Knowledge/_mocs/项目 MOC.md";
  moc.basename = "项目 MOC";
  const note = new TFile();
  note.path = "Knowledge/项目/计划.md";
  note.basename = "计划";
  let backlinkCalls = 0;
  const mocApp = {
    metadataCache: {
      resolvedLinks: { [moc.path]: { [note.path]: 1 } },
      getBacklinksForFile: () => {
        backlinkCalls += 1;
        return null;
      }
    }
  };
  const mocIndex = buildMocIndex(mocApp as never, [moc, note]);
  check(
    "MOC index avoids one backlink lookup per note",
    backlinkCalls === 0 && mocIndex.get(note.path)?.[0] === "项目 MOC",
    { backlinkCalls, mocs: mocIndex.get(note.path) }
  );
}

function legacyDashboardScan(files: TFile[], loadedFiles: TFolder[], now: number): number {
  const markdown = files.filter((file) => file.extension === "md");
  const filteredMarkdown = markdown.filter((file) => !file.path.startsWith("Archive/"));
  const filteredFiles = files.filter((file) => !file.path.startsWith("Archive/"));
  const words = Math.round(filteredMarkdown.reduce((sum, file) => sum + file.stat.size, 0) / 3);
  const attachments = filteredFiles.length - filteredMarkdown.length;
  const folders = loadedFiles.filter((file) => file.path !== "/").length;
  const heroNotes = files.filter((file) => file.extension === "md").length;
  let earliest = Infinity;
  for (const file of markdown) if (file.stat.ctime > 0 && file.stat.ctime < earliest) earliest = file.stat.ctime;
  const daySet = new Map<string, Set<string>>();
  for (const file of markdown) {
    const date = new Date(file.stat.mtime);
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    let set = daySet.get(key);
    if (!set) daySet.set(key, (set = new Set()));
    set.add(file.path);
  }
  let total = 0;
  for (const set of daySet.values()) total += set.size;
  return filteredMarkdown.length + filteredFiles.length + words + attachments + folders + heroNotes + (earliest < now ? 1 : 0) + total;
}

function testVaultStatsScaleBudget(): void {
  const now = new Date(2026, 9, 30, 12).getTime();
  const files: TFile[] = [];
  for (let index = 0; index < 33_806; index += 1) {
    const file = new TFile();
    file.path = index % 3 === 0 ? `Daily/${index}.md` : index % 7 === 0 ? `Archive/${index}.md` : `Assets/${index}.png`;
    file.extension = file.path.endsWith(".md") ? "md" : "png";
    const stamp = now - (index % 3_650) * 86_400_000;
    file.stat = { ctime: stamp, mtime: stamp, size: index % 3 === 0 ? 3_000 : 20_000 };
    files.push(file);
  }
  const folders = Array.from({ length: 500 }, (_, index) => {
    const folder = new TFolder();
    folder.path = `Folder-${index}`;
    return folder;
  });
  const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const legacySamples = Array.from({ length: 7 }, () => {
    const started = performance.now();
    legacyDashboardScan(files, folders, now);
    return performance.now() - started;
  });
  const legacyMs = median(legacySamples);

  let getFilesCalls = 0;
  const app = {
    vault: {
      getFiles: () => {
        getFilesCalls += 1;
        return files;
      },
      getAllLoadedFiles: () => folders
    },
    metadataCache: { getTags: () => ({ "#tag": 1 }) }
  };
  const coldSamples = Array.from({ length: 7 }, () => {
    const coldStats = new VaultIndex(() => app as never, { now: () => now });
    const started = performance.now();
    coldStats.getStats();
    const elapsed = performance.now() - started;
    coldStats.dispose();
    return elapsed;
  });
  const coldMs = median(coldSamples);
  const stats = new VaultIndex(() => app as never, { now: () => now });
  getFilesCalls = 0;
  stats.getStats();
  const warmStart = performance.now();
  for (let index = 0; index < 10_000; index += 1) stats.getStats();
  const warmAverageMs = (performance.now() - warmStart) / 10_000;
  stats.dispose();

  console.log(`PERF synthetic 33806 files: legacy dashboard scan ${legacyMs.toFixed(2)}ms; shared cold ${coldMs.toFixed(2)}ms; cached read ${warmAverageMs.toFixed(4)}ms`);
  check(
    "33,806-file stats stay inside the regression budget",
    coldMs < 2_000 && warmAverageMs < 0.05 && getFilesCalls === 1,
    { legacyMs, coldMs, warmAverageMs, getFilesCalls }
  );
}


function testHabitStreak(): void {
  const done = new Set(["2026-09-28", "2026-09-29", "2026-09-30", "2026-09-26"]);
  const isDone = (iso: string): boolean => done.has(iso);
  check("streak counts back from today", habitStreak(isDone, "2026-09-30") === 3);
  check("today not yet checked in keeps yesterday's streak", habitStreak(isDone, "2026-10-01") === 3);
  check("gap of two days breaks the streak", habitStreak(isDone, "2026-10-02") === 0);
  check("streak respects the loaded range limit", habitStreak(isDone, "2026-09-30", 2) === 2);
  check("streak crosses month boundaries", habitStreak((iso) => iso >= "2026-08-30" && iso <= "2026-09-02", "2026-09-02") === 4);
}

function testPomodoro(): void {
  const definition = TEST_REGISTRY.get("pomodoro");
  check("pomodoro widget registered", definition?.name === "番茄时钟");
  const config = normalizePomodoro({});
  check("fresh session idle at focus with full duration", config.session.state === "idle" && remainingMs(config, config.session, 0) === 25 * 60_000, config.session);
  const now = 1_000_000;
  const running = startSession(config, config.session, now);
  check("start schedules endsAt", running.state === "running" && running.endsAt === now + 25 * 60_000, running);
  const paused = pauseSession(config, running, now + 60_000);
  check("pause keeps remaining", paused.state === "paused" && paused.remainingMs === 24 * 60_000, paused);
  check("resume continues from remaining", startSession(config, paused, now + 90_000).endsAt === now + 90_000 + 24 * 60_000);
  const first = advanceSession(config, running, { count: true, now, allowAutoStart: true });
  check("focus complete → short break auto-started, round 1", first.completedFocus && first.session.phase === "short" && first.session.state === "running" && first.session.round === 1, first.session);
  const afterBreak = advanceSession(config, first.session, { count: true, now, allowAutoStart: true });
  check("break complete → focus idle (autoStartFocus off)", !afterBreak.completedFocus && afterBreak.session.phase === "focus" && afterBreak.session.state === "idle" && afterBreak.session.round === 1, afterBreak.session);
  const fourth = advanceSession(config, { ...running, round: 3 }, { count: true, now, allowAutoStart: false });
  check("4th focus → long break, not auto-started when stale", fourth.session.phase === "long" && fourth.session.round === 4 && fourth.session.state === "idle", fourth.session);
  const cycle = advanceSession(config, fourth.session, { count: true, now, allowAutoStart: true });
  check("long break → focus resets round", cycle.session.phase === "focus" && cycle.session.round === 0, cycle.session);
  const skipped = advanceSession(config, running, { count: false, now, allowAutoStart: true });
  check("skip focus does not count", !skipped.completedFocus && skipped.session.phase === "short" && skipped.session.round === 0, skipped.session);
  check("manual phase switch resets", resetSession(config, running, "long").state === "idle" && resetSession(config, running, "long").phase === "long");
  const history = bumpHistory({ "2026-01-01": 2 }, "2026-01-01");
  check("history increments", history["2026-01-01"] === 3);
  const junk = normalizePomodoro({ focusMinutes: "abc", roundsBeforeLongBreak: 2, session: { phase: "nope", state: "running", endsAt: "x", round: 9 }, history: { bad: 1, "2026-02-02": "3" } });
  check("junk config normalized", junk.focusMinutes === 25 && junk.session.phase === "focus" && junk.session.state === "idle" && junk.session.round === 1 && junk.history["2026-02-02"] === 3 && !("bad" in junk.history), junk);
  check("clock format", formatClock(25 * 60_000) === "25:00" && formatClock(59_400) === "01:00" && formatClock(0) === "00:00");
}

function testWeatherHelpers(): void {
  check("stripSuffix drops 县/区/市 but keeps 杭州", stripSuffix("安吉县") === "安吉" && stripSuffix("海淀区") === "海淀" && stripSuffix("昆山市") === "昆山" && stripSuffix("杭州") === "杭州" && stripSuffix("市中区") === "市中");
  check("splitQuery 浙江 安吉", JSON.stringify(splitQuery("浙江 安吉")) === JSON.stringify({ name: "安吉", hint: "浙江" }) && splitQuery("安吉").hint === "");
  check("parseCoords", parseCoords("30.63,119.71")?.lon === 119.71 && parseCoords("安吉") === null && parseCoords("95,10") === null);
  const ranked = rankCmaCandidates([
    { id: "57799", name: "吉安县", pinyin: "Jianxian", country: "中国" },
    { id: "G05025", name: "罗安达", pinyin: "罗安达", country: "安哥拉" },
    { id: "58446", name: "安吉", pinyin: "Anji", country: "中国" },
    { id: "53859", name: "吉县", pinyin: "Jixian", country: "中国" }
  ], "安吉县");
  check("CMA candidates: exact (suffix-insensitive) first, foreign last", ranked.map((item) => item.id).join(",") === "58446,57799,53859,G05025", ranked.map((item) => item.name));
  check("CMA pinyin match", rankCmaCandidates([{ id: "1", name: "集安", pinyin: "Jian", country: "中国" }, { id: "2", name: "安吉", pinyin: "Anji", country: "中国" }], "anji")[0].id === "2");
  check("CMA icon codes", cmaIcon(0, "晴", true) === "sun" && cmaIcon(0, "晴", false) === "moon" && cmaIcon(4, "雷阵雨", true) === "cloud-lightning" && cmaIcon(14, "小雪", true) === "cloud-snow" && cmaIcon(99, "中雨", true) === "cloud-rain");
  check("QWeather icon codes", qweatherIcon(150, "晴") === "moon" && qweatherIcon(305, "小雨") === "cloud-drizzle" && qweatherIcon(404, "雨夹雪") === "cloud-hail" && qweatherIcon(502, "霾") === "haze");
  check("normalizeHost strips scheme/slash", normalizeHost("https://abc.xy.qweatherapi.com/") === "abc.xy.qweatherapi.com");
}

function testMedia(): void {
  const definition = TEST_REGISTRY.get("media");
  check("media widget registered", definition?.name === "主流媒体");
  const defaults = definition?.defaultConfig();
  check("media widget defaults contain Qiushi and ZJXC", defaults?.showQiushi === true && defaults?.showZjxc === true);
  
  // Test Qiushi catalog parsing
  const mockCatalog = `
    <p>&emsp;&emsp;<a href="https://www.qstheory.cn/20260115/707f35de942d400f95f07b839a9625b0/c.html"><strong>《求是》2026年第2期</strong></a></p>
    <p><strong>&emsp;&emsp;<a href="https://www.qstheory.cn/20260915/3ffd335483ab41a3a67f182fcfdb5c72/c.html">《求是》2026年第18期</a></strong></p>
  `;
  const issues = parseQiushiCatalog(mockCatalog);
  check("qiushi catalog parsed issues descending", issues.length === 2 && issues[0].issueNumber === 18 && issues[0].title === "《求是》2026年第18期");

  // Test Qiushi issue articles parsing
  const mockIssue = `
    <p>&emsp;&emsp;<a href="https://www.qstheory.cn/20260915/0196377275f74e5e8a523a6d481dd793/c.html"><strong>本期导读</strong></a></p>
    <p>&emsp;&emsp;<span style="font-size: 20px;"><a href="https://www.qstheory.cn/20260915/a65819cc95eb486daf0cea84706c58dc/c.html"><strong>在加强基础研究座谈会上的讲话</strong></a> <span style="font-family: 楷体;">/习近平</span></span></p>
    <p>&emsp;&emsp;<a href="https://www.qstheory.cn/20260915/443b96d34b5f452c8d7adac323716858/c.html"><span style="font-family: 楷体;">深度调研 / </span><strong>新型能源体系调查</strong></a> <span style="font-family: 楷体;">/联合课题组</span></p>
    <p>&emsp;&emsp;<a href="https://www.qstheory.cn/20260915/3e3ca20fb6fb43edaa8a8ba9f668814f/c.html"><strong>“等安排”难有“真作为”</strong></a><span style="font-family: 楷体;">（党员来信） /陈吉平</span></p>
  `;
  const articles = parseQiushiIssueArticles(mockIssue, "《求是》2026年第18期");
  check("qiushi issue parsed articles", articles.length === 4);
  const speech = articles.find((a) => a.title.includes("基础研究"));
  check("speech article author and title", speech?.author === "习近平" && speech?.title === "在加强基础研究座谈会上的讲话");
  const survey = articles.find((a) => a.title.includes("新型能源"));
  check("survey article column and author", survey?.column === "深度调研" && survey?.author === "联合课题组");
  const letter = articles.find((a) => a.title.includes("真作为"));
  check("letter article column and author", letter?.column === "党员来信" && letter?.author === "陈吉平");

  // Test Zhejiang Propaganda parsing
  const mockZjxc = `
    <li class="listLi">
      <span class="listSpan">2026年09月14日11时</span>
      <a href="//zjnews.zjol.com.cn/zjxc/202609/t20260914_31908230.shtml">浙江宣传 | 情绪泛滥时不妨抄抄书</a>
    </li>
    <li class="listLi">
      <span class="listSpan">2026年09月13日12时</span>
      <a href="//zjnews.zjol.com.cn/zjxc/202609/t20260913_31907223.shtml">浙江宣传 | 《交锋》足够尊重观众</a>
    </li>
  `;
  const zjArticles = parseZjxcArticles(mockZjxc);
  check("zjxc articles parsed and title stripped", zjArticles.length === 2 && zjArticles[0].title === "情绪泛滥时不妨抄抄书" && zjArticles[0].url.startsWith("https:"));

  // Test htmlToMarkdown
  const mockHtml = `
    <div id="detailContent">
      <p>第一段测试内容，带有<strong>重点文字</strong>。</p>
      <p>第二段内容包含<img src="https://example.com/pic.jpg">图片。</p>
    </div>
  `;
  const md = htmlToMarkdown(mockHtml);
  check("html to markdown cleans formatting", md.includes("**重点文字**") && md.includes("![](https://example.com/pic.jpg)"));

  // Test WeChat Official Account RSS and HTML
  const mockWechatRss = `
    <rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
      <channel>
        <title>人民日报</title>
        <item>
          <title><![CDATA[重磅速递：全面深化改革新举措]]></title>
          <link>https://mp.weixin.qq.com/s/sample_wechat_article_123</link>
          <pubDate>Mon, 15 Sep 2026 12:00:00 GMT</pubDate>
          <dc:creator>人民日报评论员</dc:creator>
          <description><![CDATA[本文是概要文字]]></description>
          <content:encoded><![CDATA[<div id="js_content" class="rich_media_content"><p>这是微信公众号<strong>正文段落</strong>。</p><p><img data-src="https://mmbiz.qpic.cn/mmbiz_jpg/test123/0?wx_fmt=jpeg"></p></div>]]></content:encoded>
        </item>
      </channel>
    </rss>
  `;
  const wechatArticles = parseRssArticles(mockWechatRss, "人民日报");
  check("wechat rss parsed author, title, and link", wechatArticles.length === 1 && wechatArticles[0].title === "重磅速递：全面深化改革新举措" && wechatArticles[0].author === "人民日报评论员");
  check("wechat rss extracted fullHtml", Boolean(wechatArticles[0].fullHtml && wechatArticles[0].fullHtml.includes("js_content")));

  // Test htmlToMarkdown with WeChat js_content and data-src
  if (wechatArticles[0].fullHtml) {
    const wechatMd = htmlToMarkdown(wechatArticles[0].fullHtml);
    check("wechat html to markdown parsed bold and data-src image", wechatMd.includes("**正文段落**") && wechatMd.includes("![](https://mmbiz.qpic.cn/mmbiz_jpg/test123/0?wx_fmt=jpeg)"));
  }
}

async function testOpmlAndFollow(): Promise<void> {
  const followOpmlPath = process.env.HOME_DECK_TEST_OPML ?? process.env.HOME_PAGES_TEST_OPML;
  let opmlContent = "";
  if (followOpmlPath) {
    try {
      opmlContent = await fs.readFile(followOpmlPath, "utf8");
    } catch (err) {
      console.warn("Could not read follow.opml:", err);
    }
  }
  if (!opmlContent) {
    skip("follow.opml 60-feed fixture checks", "未设置 HOME_DECK_TEST_OPML 或文件读不到");
  }

  if (opmlContent) {
    const feeds = parseOpml(opmlContent);
    check("follow.opml parsed exactly 60 feeds", feeds.length === 60, feeds.length);

    // Verify categories
    const categories = new Set(feeds.map((f) => f.category));
    check("follow.opml contains expected categories",
      categories.has("科技") &&
      categories.has("时政") &&
      categories.has("财经") &&
      categories.has("新闻") &&
      categories.has("视频 / 时政") &&
      categories.has("播客音频") &&
      categories.has("精选文章"),
      Array.from(categories)
    );

    // Verify specific feeds
    const sspai = feeds.find((f) => f.name === "少数派");
    check("sspai parsed with url and category", Boolean(sspai && sspai.url.includes("sspai") && sspai.category === "科技"));

    const halfLatte = feeds.find((f) => f.name.includes("半拿铁"));
    check("halfLatte podcast parsed with category", Boolean(halfLatte && halfLatte.category === "播客音频"));

    const bilibili = feeds.find((f) => f.name.includes("技术爬爬虾"));
    check("bilibili video feed parsed", Boolean(bilibili && bilibili.category === "视频 / 技术"));

    // Test round-trip exportOpml -> parseOpml
    const exportedXml = exportOpml(feeds, "Follow 订阅导出");
    check("exported OPML contains opml tags and categories", exportedXml.includes('<opml version="2.0">') && exportedXml.includes('text="科技"'));
    const reimported = parseOpml(exportedXml);
    check("round-trip OPML preserves all 60 feeds", reimported.length === 60, reimported.length);
  }

  // Test mediaType detection (audio / video) in parseRssArticles
  const mockAudioRss = `
    <rss version="2.0">
      <channel>
        <title>忽左忽右</title>
        <item>
          <title>测试播客单集</title>
          <link>https://example.com/ep1</link>
          <enclosure url="https://example.com/audio.mp3" length="12345" type="audio/mpeg" />
        </item>
      </channel>
    </rss>
  `;
  const audioItems = parseRssArticles(mockAudioRss, "忽左忽右", { category: "播客音频" });
  check("rss parser detected audio podcast", audioItems.length === 1 && audioItems[0].mediaType === "audio" && audioItems[0].category === "播客音频");

  const mockVideoRss = `
    <rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
      <channel>
        <title>Bilibili</title>
        <item>
          <title>测试视频</title>
          <link>https://www.bilibili.com/video/BV123456</link>
          <media:thumbnail url="https://i0.hdslb.com/cover.jpg" />
        </item>
      </channel>
    </rss>
  `;
  const videoItems = parseRssArticles(mockVideoRss, "技术UP主", { category: "视频 / 技术" });
  check("rss parser detected video and thumbnail", videoItems.length === 1 && videoItems[0].mediaType === "video" && videoItems[0].thumbnail === "https://i0.hdslb.com/cover.jpg");

  // Test mediaWidget normalizeConfig with CustomFeed
  const normalized = mediaWidget.normalizeConfig!({
    customFeeds: [
      { name: "测试源", url: "https://example.com/rss", category: "科技", enabled: true }
    ]
  });
  check("normalizeConfig preserves category and enabled",
    normalized.customFeeds.length === 1 &&
    normalized.customFeeds[0].category === "科技" &&
    normalized.customFeeds[0].enabled === true
  );
}

async function testMediaCachingAndProgress(): Promise<void> {
  const mediaConfig = mediaWidget.defaultConfig();
  // 1. Initial cached data check when no network/empty
  const initialData = getCachedMediaData(mediaConfig);
  check("getCachedMediaData is function and returns object or null", initialData === null || typeof initialData === "object");

  // 2. Test disk cache save and restore via mock app
  const storage = new Map<string, string>();
  const mockApp = {
    vault: {
      configDir: ".obsidian",
      adapter: {
        exists: async (p: string) => storage.has(p),
        read: async (p: string) => storage.get(p) ?? "",
        write: async (p: string, data: string) => { storage.set(p, data); },
        mkdir: async (_p: string) => {}
      }
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await saveDiskCacheNow(mockApp as any);
  const cacheFilePath = ".obsidian/plugins/home-deck/media-cache.json";
  check("saveDiskCacheNow writes to adapter", storage.has(cacheFilePath));
  const writtenJson = JSON.parse(storage.get(cacheFilePath) || "{}") as { feedCache?: unknown[] };
  check("saved disk cache contains feedCache array", Array.isArray(writtenJson.feedCache));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await loadDiskCache(mockApp as any);
  check("loadDiskCache loads without throwing", true);

  // 3. Test syncMediaData progress callback
  let progressCount = 0;
  let finalComplete = false;
  const syncResult = await syncMediaData(
    {
      ...mediaConfig,
      showQiushi: false,
      showZjxc: false,
      customFeeds: [
        { name: "测试源1", url: "https://example.com/rss1", enabled: true },
        { name: "测试源2", url: "https://example.com/rss2", enabled: true }
      ]
    },
    {
      forceRefresh: true,
      onProgress: (_completed, _total, _items, isComplete) => {
        progressCount++;
        if (isComplete) finalComplete = true;
      }
    }
  );
  check("syncMediaData triggers onProgress callback", progressCount > 0);
  check("syncMediaData reports isComplete true at end", finalComplete);
  check("syncMediaData returns valid MediaData", typeof syncResult.ready === "boolean" && Array.isArray(syncResult.items));
}

testRegistry();
await testSharedVaultStats();
await testPerformanceGuards();
testVaultStatsScaleBudget();
testHabitStreak();
testPomodoro();
testWeatherHelpers();
testMedia();
await testOpmlAndFollow();
await testMediaCachingAndProgress();
await runWithVault("testDuowei", testDuowei);
await testDigest();
await runWithVault("testWechat", testWechat);
await testDuoweiInbox();
await runWithVault("testAnnotations", testAnnotations);
const summary = failures === 0 ? "ALL PASSED" : `${failures} FAILED`;
console.log(skippedSuites > 0 ? `${summary}（${skippedSuites} 个套件因缺夹具被跳过）` : summary);
process.exit(failures === 0 ? 0 : 1);
