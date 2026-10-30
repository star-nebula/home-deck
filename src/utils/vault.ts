import { App, Keymap, Notice, TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";
import { isExcludedPath, isPathUnder } from "./paths";

type InternalPluginsApp = App & {
  internalPlugins?: {
    getPluginById?: (id: string) => { enabled?: boolean; instance?: Record<string, unknown> } | undefined;
  };
  commands?: { executeCommandById?: (id: string) => boolean };
};

type ObsidianMoment = (input?: string | Date, format?: string, strict?: boolean) => {
  isValid(): boolean;
  format(format: string): string;
  toDate(): Date;
};

/** 打开库内文件；ctrl/cmd 点击或 newLeaf=true 时在新标签页打开。可定位到某一行。 */
export async function openPath(
  app: App,
  path: string,
  options: { line?: number; event?: MouseEvent | KeyboardEvent; newLeaf?: boolean } = {}
): Promise<void> {
  const target = app.vault.getAbstractFileByPath(normalizePath(path));
  if (target instanceof TFolder) {
    revealFolder(app, target);
    return;
  }
  if (!(target instanceof TFile)) {
    new Notice(`文件不存在：${path}`);
    return;
  }
  const newLeaf = options.newLeaf ?? (options.event ? Keymap.isModEvent(options.event) : false);
  const leaf = app.workspace.getLeaf(newLeaf ? "tab" : false);
  await leaf.openFile(target, options.line !== undefined ? { eState: { line: options.line } } : undefined);
}

export function revealFolder(app: App, folder: TFolder): void {
  const explorer = (app as InternalPluginsApp).internalPlugins?.getPluginById?.("file-explorer");
  const instance = explorer?.instance as { revealInFolder?: (file: TAbstractFile) => void } | undefined;
  if (instance?.revealInFolder) {
    instance.revealInFolder(folder);
    return;
  }
  new Notice(`文件夹：${folder.path}`);
}

export function isInScope(file: TFile, scope: string): boolean {
  return isPathUnder(file.path, scope);
}

export function isExcluded(file: TFile, excludes: string[]): boolean {
  return isExcludedPath(file.path, excludes);
}

export function stripFrontmatter(source: string): string {
  return source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

export async function ensureFolder(app: App, folder: string): Promise<void> {
  const normalized = normalizePath(folder);
  if (!normalized || normalized === "/") return;
  if (app.vault.getAbstractFileByPath(normalized)) return;
  try {
    await app.vault.createFolder(normalized);
  } catch {
    // 已存在（并发创建）时忽略。
  }
}

export function basenameOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.[^.]+$/, "");
}

// ---- Daily Note ----------------------------------------------------------

export function getDailyNoteSettings(app: App): { folder: string; format: string; template: string } {
  const plugin = (app as InternalPluginsApp).internalPlugins?.getPluginById?.("daily-notes");
  const options = (plugin?.instance as { options?: Record<string, unknown> } | undefined)?.options ?? {};
  const folder = typeof options.folder === "string" ? options.folder.trim().replace(/\/+$/g, "") : "";
  const format = typeof options.format === "string" && options.format.trim() ? options.format.trim() : "YYYY-MM-DD";
  const template = typeof options.template === "string" ? options.template.trim() : "";
  return { folder, format, template };
}

function getMoment(): ObsidianMoment | undefined {
  return (window as unknown as { moment?: ObsidianMoment }).moment;
}

/** 某天日记的“应有”文件名（不含扩展名），跟随核心 Daily Notes 插件的日期格式。 */
export function dailyNoteBasename(app: App, isoDate: string): string {
  const { format } = getDailyNoteSettings(app);
  const moment = getMoment();
  if (!moment) return isoDate;
  const parsed = moment(isoDate, "YYYY-MM-DD", true);
  return parsed.isValid() ? parsed.format(format) : isoDate;
}

export function findDailyNote(
  app: App,
  isoDate: string,
  markdownByBasename?: ReadonlyMap<string, TFile>
): TFile | null {
  const { folder } = getDailyNoteSettings(app);
  const basename = dailyNoteBasename(app, isoDate);
  const expected = normalizePath(folder ? `${folder}/${basename}.md` : `${basename}.md`);
  const direct = app.vault.getAbstractFileByPath(expected);
  if (direct instanceof TFile) return direct;
  // 兜底：全库找同名笔记（用户把日记挪过文件夹的情况）。
  if (markdownByBasename) return markdownByBasename.get(basename) ?? markdownByBasename.get(isoDate) ?? null;
  for (const file of app.vault.getMarkdownFiles()) {
    if (file.basename === basename || file.basename === isoDate) return file;
  }
  return null;
}

export async function getOrCreateDailyNote(app: App, isoDate: string): Promise<TFile> {
  const existing = findDailyNote(app, isoDate);
  if (existing) return existing;
  const { folder, template } = getDailyNoteSettings(app);
  await ensureFolder(app, folder);
  const basename = dailyNoteBasename(app, isoDate);
  const path = normalizePath(folder ? `${folder}/${basename}.md` : `${basename}.md`);
  let content = "";
  if (template) {
    const templateFile = app.vault.getAbstractFileByPath(normalizePath(template.endsWith(".md") ? template : `${template}.md`));
    if (templateFile instanceof TFile) {
      try {
        content = await app.vault.cachedRead(templateFile);
      } catch {
        content = "";
      }
    }
  }
  return app.vault.create(path, content);
}
