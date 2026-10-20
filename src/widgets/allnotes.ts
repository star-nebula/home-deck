import { App, Setting, TFile, TFolder, setIcon } from "obsidian";
import { addNumberSetting } from "../ui/settingHelpers";
import { isExcluded, isInScope } from "../utils/vault";
import { WidgetDefinition, clampInt, normalizeWith, toStringList } from "./types";

export interface AllNotesConfig extends Record<string, unknown> {
  folder: string;
  excludeFolders: string[];
  /** 分类口径：frontmatter 字段 / 所在文件夹 / 标签。 */
  groupBy: "frontmatter" | "folder" | "tag";
  /** groupBy = frontmatter 时读取的字段名。 */
  categoryField: string;
  showAbstract: boolean;
  showMocs: boolean;
  limit: number;
  /** 当前点亮的分类芯片；空串 = 全部分类。 */
  area: string;
}

const DEFAULTS: AllNotesConfig = {
  folder: "",
  excludeFolders: [],
  groupBy: "frontmatter",
  categoryField: "category",
  showAbstract: true,
  showMocs: true,
  limit: 200,
  area: ""
};

interface NoteEntry {
  file: TFile;
  /** 展示名（文件名，不含扩展名）。 */
  name: string;
  path: string;
  /** frontmatter 标题，仅参与过滤；缺省回退文件名。 */
  title: string;
  abstract: string;
  area: string;
  sub: string;
  mocs: string[];
  isMoc: boolean;
}

/** 「所属 MOC」虚拟芯片的名字：点亮后只看 MOC 页（按分类分组，不额外汇总一份副本）。 */
const MOC_AREA = "MOC";
const UNCLASSIFIED = "未分类";
const ROOT_AREA = "（根目录）";
const MOC_HINT = /moc/i;
const EMOJI_LEAD = /^\p{Extended_Pictographic}\uFE0F?\s*/u;

/** 只活在本次会话的视图态（过滤词 + 折叠块），按组件实例 id 存，切页/重绘后能接着用。 */
interface ViewState {
  keyword: string;
  collapsed: Set<string>;
}
const VIEWS = new Map<string, ViewState>();

function viewState(id: string): ViewState {
  const existing = VIEWS.get(id);
  if (existing) return existing;
  const created: ViewState = { keyword: "", collapsed: new Set() };
  VIEWS.set(id, created);
  return created;
}

/** 中文拼音序比较器（与「知识工作台」全部笔记同一口径）。 */
function zh(a: string, b: string): number {
  return a.localeCompare(b, "zh-Hans-CN");
}

/** 真实分类按拼音；MOC 虚拟分类收在真实分类后，未分类 / 根目录殿后。 */
function areaRank(area: string): number {
  if (area === UNCLASSIFIED || area === ROOT_AREA) return 2;
  return area === MOC_AREA ? 1 : 0;
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

/** 数组型 frontmatter（abstract / title 也可能是列表）统一成一行文本。 */
function joinedValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => stringValue(item)).filter(Boolean).join(" · ");
  return stringValue(value);
}

function stripEmoji(value: string): string {
  return value.replace(EMOJI_LEAD, "").trim();
}

/** frontmatter 分类值 → 分类路径数组：数组、`[a, b]`、引号包裹、单值均可。 */
function toCategoryPath(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value.map((item) => stringValue(item)) : [stringValue(value)];
  const out: string[] = [];
  for (const item of items) {
    const inner = item.replace(/^\[/, "").replace(/\]$/, "");
    for (const piece of inner.split(",")) {
      const clean = stripEmoji(piece.trim().replace(/^["']|["']$/g, ""));
      if (clean && !out.includes(clean)) out.push(clean);
    }
  }
  return out;
}

/** MOC 页：文件名或所在文件夹含 moc（对应源模块的 `_mocs/` 目录 + 文件名 MOC）。 */
function isMocFile(file: TFile): boolean {
  const dir = file.parent?.path ?? "";
  return MOC_HINT.test(file.basename) || dir.split("/").some((segment: string) => MOC_HINT.test(segment));
}

type BacklinkSource = { getBacklinksForFile?: (file: TFile) => unknown };
type BacklinkMap = { forEach: (callback: (value: unknown, key: string) => void) => void };

/** 所属 MOC：从指向本篇的反链里挑出文件名像 MOC 页的那些。 */
function collectMocs(app: App, file: TFile): string[] {
  const cache = app.metadataCache as unknown as BacklinkSource;
  if (typeof cache.getBacklinksForFile !== "function") return [];
  const out: string[] = [];
  try {
    const backlinks = cache.getBacklinksForFile(file);
    if (!backlinks || typeof (backlinks as BacklinkMap).forEach !== "function") return [];
    (backlinks as BacklinkMap).forEach((_links, source) => {
      if (source === file.path) return;
      const name = (source.split("/").pop() ?? "").replace(/\.md$/, "");
      if (!MOC_HINT.test(name) || name === file.basename) return;
      if (!out.includes(name)) out.push(name);
    });
  } catch {
    // metadataCache 尚未就绪：本次先缺着，下次扫描补全。
    return [];
  }
  out.sort(zh);
  return out;
}

/** 按配置口径算出主类与末级（末级取分类路径最后一级，与主类同级时留空）。 */
function classify(app: App, file: TFile, config: AllNotesConfig, scope: string, frontmatter: Record<string, unknown>): { area: string; sub: string } {
  if (config.groupBy === "folder") {
    let dir = file.parent?.path ?? "";
    if (scope && (dir === scope || dir.startsWith(`${scope}/`))) dir = dir.slice(scope.length);
    const segments = dir.replace(/^\/+/, "").split("/").filter(Boolean);
    return { area: segments[0] ?? ROOT_AREA, sub: segments.length >= 2 ? segments[segments.length - 1] : "" };
  }
  if (config.groupBy === "tag") {
    const tags = (app.metadataCache.getFileCache(file)?.tags ?? []).map((tag) => tag.tag.replace(/^#/, "")).sort(zh);
    if (!tags.length) return { area: UNCLASSIFIED, sub: "" };
    const segments = tags[0].split("/").filter(Boolean);
    return { area: segments[0] ?? UNCLASSIFIED, sub: segments.length >= 2 ? segments[segments.length - 1] : "" };
  }
  const path = toCategoryPath(frontmatter[config.categoryField.trim() || DEFAULTS.categoryField]);
  if (path.length) return { area: path[0], sub: path.length >= 2 ? path[path.length - 1] : "" };
  return { area: isMocFile(file) ? MOC_AREA : UNCLASSIFIED, sub: "" };
}

function collectNotes(app: App, config: AllNotesConfig): NoteEntry[] {
  const scope = config.folder.trim().replace(/\/+$/g, "");
  const notes: NoteEntry[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    if (!isInScope(file, scope) || isExcluded(file, config.excludeFolders)) continue;
    const frontmatter = (app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
    const { area, sub } = classify(app, file, config, scope, frontmatter);
    notes.push({
      file,
      name: file.basename,
      path: file.path,
      title: joinedValue(frontmatter.title) || file.basename,
      abstract: joinedValue(frontmatter.abstract),
      area,
      sub: area === UNCLASSIFIED || area === ROOT_AREA ? "" : sub,
      mocs: config.showMocs ? collectMocs(app, file) : [],
      isMoc: isMocFile(file)
    });
  }
  notes.sort((a, b) => areaRank(a.area) - areaRank(b.area) || zh(a.area, b.area) || zh(a.sub, b.sub) || zh(a.name, b.name));
  return notes;
}

interface FolderChoice {
  path: string;
  count: number;
  label: string;
}

/** 库内每个文件夹及其（含子文件夹）笔记数，笔记多的排前面；限定/排除两处下拉共用。 */
function listFolders(app: App): FolderChoice[] {
  const files = app.vault.getMarkdownFiles();
  const folders: FolderChoice[] = [];
  for (const item of app.vault.getAllLoadedFiles()) {
    if (!(item instanceof TFolder) || item.path === "/") continue;
    const count = files.reduce((sum, file) => sum + (isInScope(file, item.path) ? 1 : 0), 0);
    folders.push({ path: item.path, count, label: `${item.path} · ${count} 篇` });
  }
  folders.sort((a, b) => b.count - a.count || zh(a.path, b.path));
  return folders;
}

/** 限定文件夹下拉：首项是全库。 */
function folderChoices(app: App): Record<string, string> {
  const choices: Record<string, string> = { "": `（全库）· ${app.vault.getMarkdownFiles().length} 篇` };
  for (const entry of listFolders(app)) choices[entry.path] = entry.label;
  return choices;
}

/** 出现过的分类（沿用排序后的顺序，即拼音序 + 未分类/根目录殿后）。 */
function listAreas(notes: NoteEntry[]): string[] {
  const out: string[] = [];
  for (const note of notes) if (!out.includes(note.area)) out.push(note.area);
  return out;
}

function matchesArea(note: NoteEntry, area: string): boolean {
  if (!area) return true;
  if (area === MOC_AREA) return note.isMoc || note.area === MOC_AREA;
  return note.area === area;
}

function noteHit(note: NoteEntry, keyword: string): boolean {
  if (!keyword) return true;
  const needle = keyword.toLowerCase();
  return [note.title, note.name, note.area, note.sub, ...note.mocs].some((text) => text.toLowerCase().includes(needle));
}

function visibleNotes(notes: NoteEntry[], keyword: string, area: string): NoteEntry[] {
  return notes.filter((note) => matchesArea(note, area) && noteHit(note, keyword));
}

interface Block {
  title: string;
  rows: NoteEntry[];
}

/** 分组：主类 → 末级各成一块（无末级时块头就是主类名）。 */
function buildBlocks(shown: NoteEntry[]): Block[] {
  const blocks: Block[] = [];
  const byKey = new Map<string, Block>();
  for (const note of shown) {
    const title = note.sub ? `${note.area} / ${note.sub}` : note.area;
    const block = byKey.get(title);
    if (block) block.rows.push(note);
    else {
      const created: Block = { title, rows: [note] };
      byKey.set(title, created);
      blocks.push(created);
    }
  }
  return blocks;
}

export const allNotesWidget: WidgetDefinition<AllNotesConfig> = {
  kind: "allnotes",
  name: "全部笔记",
  description: "笔记全量索引：分类芯片 + 即时过滤 + 主类/末级分组折叠列表，行内带简介与所属 MOC，点击打开。",
  icon: "list-tree",
  accent: "#7c3aed",
  defaultSize: { w: 5, h: 8 },
  defaultConfig: () => ({ ...DEFAULTS, excludeFolders: [] }),
  normalizeConfig: (raw) => {
    const config = normalizeWith(DEFAULTS, raw);
    config.groupBy = config.groupBy === "folder" || config.groupBy === "tag" ? config.groupBy : "frontmatter";
    config.categoryField = config.categoryField.trim() || DEFAULTS.categoryField;
    config.excludeFolders = toStringList(config.excludeFolders);
    config.showAbstract = config.showAbstract === true;
    config.showMocs = config.showMocs === true;
    config.limit = clampInt(config.limit, 20, 1000, DEFAULTS.limit);
    config.area = typeof config.area === "string" ? config.area : "";
    return config;
  },

  render(body, ctx) {
    const { app, config } = ctx;
    const view = viewState(ctx.widget.id);
    const scope = config.folder.trim().replace(/\/+$/g, "");
    const root = body.createDiv({ cls: "hp-allnotes" });
    const notes = collectNotes(app, config);
    ctx.setSubtitle(`${scope || "全库"} · ${notes.length} 篇`);

    const search = ctx.addHeaderContent("hp-allnotes-search-wrap");
    const input = search.createEl("input", {
      cls: "hp-allnotes-search",
      attr: { type: "text", placeholder: "搜索笔记…", "aria-label": "搜索笔记" }
    });
    input.value = view.keyword;

    if (notes.length === 0) {
      root.createDiv({ cls: "hp-empty", text: scope ? `${scope} 下还没有笔记` : "库里还没有笔记" });
      return;
    }

    // 分类芯片：全部 / 各主类 / MOC（再点同芯片恢复全部）。
    const chipHost = root.createDiv({ cls: "hp-filter-row" });
    const segmented = chipHost.createDiv({ cls: "hp-segmented" });
    const chips: Array<{ area: string; el: HTMLElement }> = [];
    const chipAreas = listAreas(notes).filter((area) => area !== MOC_AREA);
    const mocCount = notes.filter((note) => matchesArea(note, MOC_AREA)).length;
    if (mocCount) {
      const unclassified = chipAreas.indexOf(UNCLASSIFIED);
      chipAreas.splice(unclassified < 0 ? chipAreas.length : unclassified, 0, MOC_AREA);
    }
    const makeChip = (label: string, area: string, count: number) => {
      const button = segmented.createEl("button", { cls: "hp-segment", attr: { type: "button", title: `只看 ${label}（再点一次恢复全部）` } });
      button.createSpan({ text: label });
      button.createSpan({ cls: "hp-segment-count", text: String(count) });
      button.addEventListener("click", () => {
        const next = config.area === area ? "" : area;
        void ctx.saveConfig({ area: next }).then(() => ctx.rerender());
      });
      chips.push({ area, el: button });
    };
    makeChip("全部", "", notes.length);
    for (const area of chipAreas) {
      const count = area === MOC_AREA ? mocCount : notes.filter((note) => note.area === area).length;
      makeChip(area, area, count);
    }

    const pane = root.createDiv({ cls: "hp-allnotes-groups" });

    // 只重绘分组区，搜索框与芯片不重建 —— 否则逐字输入会丢焦点。
    const paint = () => {
      const keyword = view.keyword.trim();
      for (const chip of chips) chip.el.toggleClass("is-active", chip.area === config.area);
      pane.empty();
      const shown = visibleNotes(notes, keyword, config.area);
      if (shown.length === 0) {
        pane.createDiv({
          cls: "hp-empty",
          text: keyword ? `没有匹配「${keyword}」的笔记` : `「${config.area}」下暂无笔记`
        });
        return;
      }
      let rendered = 0;
      let truncated = false;
      for (const block of buildBlocks(shown)) {
        const head = pane.createDiv({ cls: "hp-allnotes-group-head" });
        const chevron = head.createSpan({ cls: "hp-allnotes-group-toggle" });
        setIcon(chevron, view.collapsed.has(block.title) ? "chevron-right" : "chevron-down");
        head.createSpan({ cls: "hp-allnotes-group-name", text: block.title });
        head.createSpan({ cls: "hp-allnotes-group-count", text: `${block.rows.length} 篇` });
        head.addEventListener("click", () => {
          if (view.collapsed.has(block.title)) view.collapsed.delete(block.title);
          else view.collapsed.add(block.title);
          paint();
        });
        if (view.collapsed.has(block.title)) continue;
        for (const note of block.rows) {
          if (rendered >= config.limit) {
            truncated = true;
            break;
          }
          rendered++;
          const row = pane.createDiv({ cls: "hp-list-row hp-allnotes-row is-clickable", attr: { title: note.path } });
          const text = row.createDiv({ cls: "hp-list-text" });
          const title = text.createDiv({ cls: "hp-list-title" });
          title.createSpan({ text: note.name });
          const meta = note.mocs.join(" · ");
          if (meta) title.createSpan({ cls: "hp-allnotes-mocs", text: meta, attr: { title: "所属 MOC（由反链推断）" } });
          if (note.abstract && config.showAbstract) text.createDiv({ cls: "hp-allnotes-abstract", text: note.abstract });
          row.addEventListener("click", (event) => void ctx.openPath(note.path, { event }));
        }
        if (truncated) break;
      }
      if (truncated) {
        pane.createDiv({
          cls: "hp-empty",
          text: `已按「最多显示条数」（${config.limit}）截断，仅显示 ${rendered} 篇；可在组件设置里调大上限。`
        });
      }
    };

    input.addEventListener("input", () => {
      view.keyword = input.value;
      paint();
    });
    paint();
  },

  renderSettings(container, ctx) {
    const { app, config } = ctx;
    new Setting(container).setName("分类口径").setDesc("主类与末级的来源；换口径后点亮的分类芯片会自动复位。")
      .addDropdown((dropdown) => dropdown
        .addOptions({ frontmatter: "frontmatter 分类字段", folder: "所在文件夹", tag: "标签" })
        .setValue(config.groupBy)
        .onChange((value) => ctx.update({
          groupBy: value === "folder" || value === "tag" ? value : "frontmatter",
          area: ""
        })));
    new Setting(container).setName("分类字段名").setDesc("分类口径为「frontmatter 分类字段」时读取的字段名，值写成 [主类, 末级] 即可分层。")
      .addText((text) => {
        text.setPlaceholder("category").setValue(config.categoryField).onChange((value) => ctx.update({ categoryField: value.trim() }));
        text.inputEl.addClass("hp-setting-input-wide");
      });
    const choices = folderChoices(app);
    if (config.folder && !(config.folder in choices)) choices[config.folder] = `${config.folder} · 0 篇（当前不存在）`;
    new Setting(container).setName("限定文件夹").setDesc("只索引该文件夹（含子文件夹）内的笔记；每一项后面的篇数越多排得越前。")
      .addDropdown((dropdown) => dropdown
        .addOptions(choices)
        .setValue(config.folder)
        .onChange((value) => {
          ctx.update({ folder: value });
          paintExcludes();
        }));
    new Setting(container).setName("排除文件夹").setDesc("被排除的文件夹（含子文件夹）不进索引。");
    const excludeHost = container.createDiv({ cls: "hp-allnotes-excludes" });
    const paintExcludes = (): void => {
      excludeHost.empty();
      const scope = config.folder.trim().replace(/\/+$/g, "");
      const excluded = config.excludeFolders;
      if (!excluded.length) excludeHost.createDiv({ cls: "hp-allnotes-excludes-none", text: "暂未排除任何文件夹。" });
      for (const path of excluded) {
        const row = excludeHost.createDiv({ cls: "hp-allnotes-exclude-row" });
        setIcon(row.createSpan({ cls: "hp-allnotes-exclude-icon" }), "folder");
        row.createSpan({ cls: "hp-allnotes-exclude-path", text: path });
        const remove = row.createEl("button", { cls: "hp-allnotes-exclude-remove", attr: { type: "button", "aria-label": "移出排除列表" } });
        setIcon(remove, "x");
        remove.addEventListener("click", () => {
          ctx.update({ excludeFolders: excluded.filter((item) => item !== path) });
          paintExcludes();
        });
      }
      const candidates: Record<string, string> = {};
      for (const entry of listFolders(app)) {
        if (entry.path === scope || excluded.includes(entry.path)) continue;
        if (excluded.some((prefix) => entry.path.startsWith(`${prefix}/`))) continue;
        candidates[entry.path] = entry.label;
      }
      let picked = "";
      new Setting(excludeHost)
        .addDropdown((dropdown) => dropdown
          .addOptions(Object.keys(candidates).length ? candidates : { "": "（没有可添加的文件夹）" })
          .setValue("")
          .onChange((value) => { picked = value; }))
        .addButton((button) => button.setButtonText("添加").setCta().onClick(() => {
          if (!picked || !(picked in candidates)) return;
          ctx.update({ excludeFolders: [...excluded, picked] });
          paintExcludes();
        }));
    };
    paintExcludes();
    new Setting(container).setName("显示简介").setDesc("笔记行下方显示 frontmatter abstract（两行截断）。")
      .addToggle((toggle) => toggle.setValue(config.showAbstract).onChange((value) => ctx.update({ showAbstract: value })));
    new Setting(container).setName("显示所属 MOC").setDesc("文件名或所在文件夹含 MOC 的页面，通过反链推断每篇笔记挂在哪些 MOC 下。")
      .addToggle((toggle) => toggle.setValue(config.showMocs).onChange((value) => ctx.update({ showMocs: value })));
    addNumberSetting(container, { name: "最多显示条数", value: config.limit, min: 20, max: 1000, onChange: (value) => ctx.update({ limit: value }) });
  }
};
