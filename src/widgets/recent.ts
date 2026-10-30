import { Setting, setIcon, TFile, TFolder } from "obsidian";
import { formatRelativeTime } from "../utils/date";
import { isExcluded, isInScope } from "../utils/vault";
import { addNumberSetting, addPathSetting, addTextareaSetting } from "../ui/settingHelpers";
import { WidgetDefinition, clampInt, normalizeWith, toStringList } from "./types";

export interface RecentConfig extends Record<string, unknown> {
  limit: number;
  folder: string;
  excludeFolders: string[];
  sortBy: "mtime" | "ctime";
  /** hidden: 不显示；inline: 文件名右侧浅色路径；sub: 文件名下方单独一行 */
  folderDisplay: "hidden" | "inline" | "sub";
  showFolder: boolean;
}

const DEFAULTS: RecentConfig = {
  limit: 8,
  folder: "",
  excludeFolders: [],
  sortBy: "mtime",
  folderDisplay: "hidden",
  showFolder: false
};

export const recentWidget: WidgetDefinition<RecentConfig> = {
  kind: "recent",
  name: "最近笔记",
  description: "最近修改（或创建）的笔记列表，点击打开。",
  icon: "history",
  accent: "#2563eb",
  defaultSize: { w: 4, h: 6 },
  liveRefresh: false,
  refreshOnMetadataChange: false,
  defaultConfig: () => ({ ...DEFAULTS, excludeFolders: [] }),
  normalizeConfig: (raw) => {
    const config = normalizeWith(DEFAULTS, raw);
    config.limit = clampInt(config.limit, 1, 50, DEFAULTS.limit);
    config.excludeFolders = toStringList(config.excludeFolders);
    config.sortBy = config.sortBy === "ctime" ? "ctime" : "mtime";
    // 迁移旧布尔开关：showFolder: true 视为 inline（文件名右侧路径）
    if (config.showFolder === true && config.folderDisplay === "hidden") config.folderDisplay = "inline";
    return config;
  },

  render(body, ctx) {
    const { config } = ctx;
    ctx.onVaultChange((change) => {
      if (change.reason === "metadata") return;
      const relevant = change.paths.some((path) => {
        if (!path.toLowerCase().endsWith(".md")) return false;
        if (!config.folder.trim()) return true;
        const folder = config.folder.trim().replace(/\/+$/g, "");
        return path === folder || path.startsWith(`${folder}/`);
      });
      if (relevant) ctx.scheduleIdle(() => ctx.rerender(), 500);
    });
    const all = ctx.getMarkdownFiles();
    const files: TFile[] = [];
    for (const file of ctx.getMarkdownSorted(config.sortBy)) {
      if (!isInScope(file, config.folder) || isExcluded(file, config.excludeFolders)) continue;
      files.push(file);
      if (files.length >= config.limit) break;
    }
    ctx.setSubtitle(config.folder.trim() ? `${config.folder.trim()} · ${files.length} 篇` : `全库 · ${all.length} 篇`);

    const list = body.createDiv({ cls: "hp-list" });
    if (files.length === 0) {
      list.createDiv({ cls: "hp-empty", text: "还没有笔记" });
      return;
    }
    const folderLabel = (file: { parent: TFolder | null }): string | null => {
      if (config.folderDisplay === "hidden") return null;
      if (!file.parent || file.parent.path === "/") return null;
      return file.parent.path;
    };

    for (const file of files) {
      const row = list.createDiv({ cls: "hp-list-row is-clickable", attr: { title: file.path } });
      setIcon(row.createSpan({ cls: "hp-list-icon" }), "file-text");
      const text = row.createDiv({ cls: "hp-list-text" });
      const folderPath = folderLabel(file);
      text.createSpan({ cls: "hp-list-title", text: file.basename });
      if (folderPath && config.folderDisplay === "sub") {
        text.createDiv({ cls: "hp-list-sub", text: folderPath });
      }
      if (folderPath && config.folderDisplay === "inline") {
        row.createSpan({ cls: "hp-list-folder", text: folderPath });
      }
      row.createSpan({ cls: "hp-list-meta", text: formatRelativeTime(config.sortBy === "ctime" ? file.stat.ctime : file.stat.mtime) });
      row.addEventListener("click", (event) => void ctx.openPath(file.path, { event }));
    }
  },

  renderSettings(container, ctx) {
    const { config } = ctx;
    addNumberSetting(container, { name: "显示条数", value: config.limit, min: 1, max: 50, onChange: (value) => ctx.update({ limit: value }) });
    addPathSetting(container, ctx.app, {
      name: "限定文件夹",
      desc: "只显示该文件夹内的笔记，留空为全库。",
      value: config.folder,
      suggest: { files: false, folders: true },
      onChange: (value) => ctx.update({ folder: value })
    });
    addTextareaSetting(container, {
      name: "排除文件夹",
      desc: "一行一个文件夹路径。",
      value: config.excludeFolders.join("\n"),
      rows: 3,
      onChange: (value) => ctx.update({ excludeFolders: toStringList(value) })
    });
    new Setting(container).setName("排序依据")
      .addDropdown((dropdown) => dropdown
        .addOptions({ mtime: "最近修改", ctime: "最近创建" })
        .setValue(config.sortBy)
        .onChange((value) => ctx.update({ sortBy: value === "ctime" ? "ctime" : "mtime" })));
    new Setting(container).setName("显示所在文件夹")
      .addDropdown((dropdown) => dropdown
        .addOptions({ hidden: "不显示", inline: "文件名右侧", sub: "文件名下方" })
        .setValue(config.folderDisplay)
        .onChange((value) => ctx.update({ folderDisplay: value === "inline" || value === "sub" ? value : "hidden" })));
  }
};
