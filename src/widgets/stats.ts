import { Setting } from "obsidian";
import { daysBetweenToday, isIsoDate } from "../utils/date";
import { addDateSetting, addTextareaSetting } from "../ui/settingHelpers";
import { WidgetDefinition, normalizeWith, toStringList } from "./types";

export type StatTile = "notes" | "tags" | "words" | "attachments" | "folders" | "vaultAge" | "todayNotes" | "weekNotes";

export interface StatsConfig extends Record<string, unknown> {
  tiles: StatTile[];
  columns: number;
  excludeFolders: string[];
  since: string;
}

const ALL_TILES: Array<{ id: StatTile; label: string }> = [
  { id: "notes", label: "笔记" },
  { id: "tags", label: "标签" },
  { id: "words", label: "约字数" },
  { id: "attachments", label: "附件" },
  { id: "folders", label: "文件夹" },
  { id: "vaultAge", label: "库龄（天）" },
  { id: "todayNotes", label: "今日新建" },
  { id: "weekNotes", label: "本周修改" }
];

const DEFAULTS: StatsConfig = { tiles: ["notes", "tags", "words", "attachments"], columns: 2, excludeFolders: [], since: "" };

export const statsWidget: WidgetDefinition<StatsConfig> = {
  kind: "stats",
  name: "库统计",
  description: "笔记 / 标签 / 字数 / 附件等知识库概览数字。",
  icon: "pie-chart",
  accent: "#d97706",
  defaultSize: { w: 5, h: 4 },
  liveRefresh: false,
  defaultConfig: () => ({ ...DEFAULTS, tiles: [...DEFAULTS.tiles], excludeFolders: [] }),
  normalizeConfig: (raw) => {
    const config = normalizeWith(DEFAULTS, raw);
    const valid = new Set(ALL_TILES.map((tile) => tile.id));
    config.tiles = toStringList(config.tiles, 8).filter((tile): tile is StatTile => valid.has(tile as StatTile));
    if (config.tiles.length === 0) config.tiles = [...DEFAULTS.tiles];
    config.columns = config.columns === 3 || config.columns === 4 ? config.columns : 2;
    config.excludeFolders = toStringList(config.excludeFolders);
    return config;
  },

  render(body, ctx) {
    const { config } = ctx;
    ctx.setSubtitle("知识库概览");
    const grid = body.createDiv({ cls: "hp-stats" });
    grid.style.setProperty("--hp-cols", String(config.columns));
    const valueEls = new Map<StatTile, HTMLElement>();
    config.tiles.forEach((tile, index) => {
      const item = grid.createDiv({ cls: `hp-stat hp-tone-${index % 4}` });
      valueEls.set(tile, item.createDiv({ cls: "hp-stat-value", text: "…" }));
      item.createDiv({ cls: "hp-stat-label", text: ALL_TILES.find((entry) => entry.id === tile)?.label ?? tile });
    });

    const paint = (): void => {
      const stats = ctx.getVaultStats({ excludeFolders: config.excludeFolders });
      const since = isIsoDate(config.since) ? config.since : stats.earliestDay;
      const values: Record<StatTile, string> = {
        notes: stats.noteCount.toLocaleString(),
        tags: stats.tagCount.toLocaleString(),
        words: stats.wordEstimate >= 10000 ? `${Math.round(stats.wordEstimate / 1000)}k` : stats.wordEstimate.toLocaleString(),
        attachments: stats.attachmentCount.toLocaleString(),
        folders: stats.folderCount.toLocaleString(),
        vaultAge: since ? Math.max(0, -daysBetweenToday(since)).toLocaleString() : "—",
        todayNotes: stats.todayNotes.toLocaleString(),
        weekNotes: stats.weekNotes.toLocaleString()
      };
      for (const [tile, el] of valueEls) el.setText(values[tile]);
    };

    ctx.scheduleIdle(paint, 1_000);
    ctx.onVaultChange(() => ctx.scheduleIdle(paint, 1_000));
  },

  renderSettings(container, ctx) {
    const { config } = ctx;
    new Setting(container).setName("每行列数")
      .addDropdown((dropdown) => dropdown
        .addOptions({ "2": "2", "3": "3", "4": "4" })
        .setValue(String(config.columns))
        .onChange((value) => ctx.update({ columns: Number(value) })));
    container.createEl("h4", { cls: "hp-settings-heading", text: "显示的数字（按勾选顺序排列）" });
    for (const tile of ALL_TILES) {
      new Setting(container).setName(tile.label)
        .addToggle((toggle) => toggle.setValue(config.tiles.includes(tile.id)).onChange((value) => {
          const next = config.tiles.filter((item) => item !== tile.id);
          if (value) next.push(tile.id);
          ctx.update({ tiles: next });
        }));
    }
    addDateSetting(container, { name: "库龄起算日", desc: "留空自动取库内最早文件。", value: config.since, onChange: (value) => ctx.update({ since: value }) });
    addTextareaSetting(container, {
      name: "排除文件夹",
      desc: "一行一个，统计时跳过这些文件夹（例如模板、附件目录）。",
      value: config.excludeFolders.join("\n"),
      rows: 3,
      onChange: (value) => ctx.update({ excludeFolders: toStringList(value) })
    });
  }
};
