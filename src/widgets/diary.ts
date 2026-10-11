import { Setting, TFile } from "obsidian";
import { addNumberSetting, addPathSetting } from "../ui/settingHelpers";
import { findDailyNote, getDailyNoteSettings, getOrCreateDailyNote, isInScope, isExcluded } from "../utils/vault";
import { toIsoDate } from "../utils/date";
import { WidgetDefinition, clampInt, normalizeWith } from "./types";

export interface DiaryConfig extends Record<string, unknown> {
  folder: string;
  excludeFolders: string[];
  limit: number;
  showStats: boolean;
  showPreview: boolean;
  /** 当前选中的年份芯片；空串 = 全部年份。 */
  year: string;
}

const DEFAULTS: DiaryConfig = {
  folder: "",
  excludeFolders: [],
  limit: 30,
  showStats: true,
  showPreview: true,
  year: ""
};

interface DiaryEntry {
  file: TFile;
  date: string;
  year: string;
  preview: string;
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const FILENAME_DATE = /^(\d{4})[-_](\d{2})[-_](\d{2})$/;

/** 文件名可解析出日期（YYYY-MM-DD / YYYY_MM_DD，年份子目录与根层直放均可）。 */
function dateFromBasename(basename: string): string | null {
  const match = basename.match(FILENAME_DATE);
  if (!match) return null;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  return Number.isNaN(new Date(`${date}T00:00:00`).getTime()) ? null : date;
}

function weekdayLabel(date: string): string {
  return WEEKDAYS[new Date(`${date}T00:00:00`).getDay()] ?? "";
}

/* 首句预览：跳过 frontmatter / 空行 / 标题 / 引用 / 表格 / 代码块，取首条有内容的行截 40 字。 */
function firstSentencePreview(text: string): string {
  const lines = String(text ?? "").split("\n");
  let inFrontmatter = false;
  let fmClosed = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!fmClosed) {
      if (line === "---") {
        inFrontmatter = !inFrontmatter;
        fmClosed = !inFrontmatter;
        continue;
      }
      if (inFrontmatter) continue;
      fmClosed = true;
    }
    if (!line || line.startsWith("#") || line.startsWith(">") || line.startsWith("|") || line.startsWith("```")) continue;
    return line.length > 40 ? `${line.slice(0, 40)}…` : line;
  }
  return "";
}

export const diaryWidget: WidgetDefinition<DiaryConfig> = {
  kind: "diary",
  name: "日记",
  description: "自动聚合日记文件夹：统计概览 + 年份过滤 + 分组列表，点击打开；可一键写今日日记。",
  icon: "book-open",
  accent: "#0d9488",
  defaultSize: { w: 5, h: 8 },
  defaultConfig: () => ({ ...DEFAULTS, excludeFolders: [] }),
  normalizeConfig: (raw) => {
    const config = normalizeWith(DEFAULTS, raw);
    config.limit = clampInt(config.limit, 5, 500, DEFAULTS.limit);
    config.showStats = config.showStats === true;
    config.showPreview = config.showPreview === true;
    config.year = typeof config.year === "string" ? config.year : "";
    return config;
  },

  render(body, ctx) {
    const { app, config } = ctx;
    const root = body.createDiv({ cls: "hp-diary" });
    body = root;
    const settings = getDailyNoteSettings(app);
    // 未配置时跟随核心「每日笔记」插件的文件夹，让组件开箱即用。
    const folder = config.folder.trim() || settings.folder;
    const entries: DiaryEntry[] = [];
    for (const file of app.vault.getMarkdownFiles()) {
      if (!isInScope(file, folder) || isExcluded(file, config.excludeFolders)) continue;
      const date = dateFromBasename(file.basename);
      if (!date) continue;
      entries.push({ file, date, year: date.slice(0, 4), preview: "" });
    }
    // 名字不含日期的兜底：今天的日记可能叫别的格式（跟随每日笔记插件日期格式）。
    const today = toIsoDate(new Date());
    if (!entries.some((entry) => entry.date === today) && folder) {
      const todayNote = findDailyNote(app, today);
      if (todayNote && isInScope(todayNote, folder) && !isExcluded(todayNote, config.excludeFolders)) {
        entries.push({ file: todayNote, date: today, year: today.slice(0, 4), preview: "" });
      }
    }
    entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    const shown = config.year ? entries.filter((entry) => entry.year === config.year) : entries;
    ctx.setSubtitle(`${folder || "全库"} · ${entries.length} 篇`);
    ctx.addHeaderAction("pencil-line", "写今日日记", () => {
      void getOrCreateDailyNote(ctx.app, today)
        .then((file) => ctx.openPath(file.path))
        .catch(() => undefined);
    });

    // 统计瓦片：总数 / 最近一篇 / 本月 / 年份跨度。
    if (config.showStats && entries.length > 0) {
      const thisMonth = today.slice(0, 7);
      const years = [...new Set(entries.map((entry) => entry.year))].sort();
      const kpis = body.createDiv({ cls: "hp-kpis" });
      const tiles: Array<[string, string]> = [
        [`${entries.length} 篇`, "日记总数"],
        [entries[0]?.date ?? "—", "最近一篇"],
        [`${entries.filter((entry) => entry.date.startsWith(thisMonth)).length} 篇`, "本月"],
        [years.length > 1 ? `${years[0]}–${years[years.length - 1]}` : years[0] ?? "—", "年份"]
      ];
      for (const [value, label] of tiles) {
        const kpi = kpis.createDiv({ cls: "hp-kpi" });
        kpi.createDiv({ cls: "hp-kpi-value", text: value });
        kpi.createDiv({ cls: "hp-kpi-label", text: label });
      }
    }

    // 年份芯片过滤（再点同芯片恢复全部）。
    if (entries.length > 0) {
      const byYear = new Map<string, number>();
      for (const entry of entries) byYear.set(entry.year, (byYear.get(entry.year) ?? 0) + 1);
      const filters = body.createDiv({ cls: "hp-filter-row" });
      const segmented = filters.createDiv({ cls: "hp-segmented" });
      const chip = (label: string, year: string, count?: number) => {
        const button = segmented.createEl("button", {
          cls: `hp-segment${config.year === year ? " is-active" : ""}`,
          attr: { type: "button" }
        });
        button.createSpan({ text: label });
        if (count !== undefined) button.createSpan({ cls: "hp-segment-count", text: String(count) });
        button.addEventListener("click", () => {
          if (config.year === year) {
            void ctx.saveConfig({ year: "" }).then(() => ctx.rerender());
            return;
          }
          void ctx.saveConfig({ year }).then(() => ctx.rerender());
        });
      };
      chip("全部", "");
      for (const year of [...byYear.keys()].sort().reverse()) chip(year, year, byYear.get(year));
    }

    // 年份分组列表：最新在前，点击打开。
    const list = body.createDiv({ cls: "hp-list" });
    if (entries.length === 0) {
      list.createDiv({ cls: "hp-empty", text: folder ? `${folder} 下还没有日记（文件名含 YYYY-MM-DD 即自动进这里）` : "还没有日记" });
      return;
    }
    if (shown.length === 0) {
      list.createDiv({ cls: "hp-empty", text: "该年份暂无日记" });
      return;
    }

    const groups = new Map<string, DiaryEntry[]>();
    for (const entry of shown) {
      const bucket = groups.get(entry.year) ?? [];
      bucket.push(entry);
      groups.set(entry.year, bucket);
    }
    let rendered = 0;
    let truncated = false;
    for (const year of [...groups.keys()].sort().reverse()) {
      const group = groups.get(year)!;
      const head = list.createDiv({ cls: "hp-diary-group-head" });
      head.createSpan({ cls: "hp-diary-group-name", text: `${year} 年` });
      head.createSpan({ cls: "hp-diary-group-count", text: `${group.length} 篇` });
      for (const entry of group) {
        if (rendered >= config.limit) {
          truncated = true;
          break;
        }
        rendered++;
        const row = list.createDiv({ cls: "hp-list-row hp-diary-row is-clickable", attr: { title: entry.file.path } });
        const text = row.createDiv({ cls: "hp-list-text" });
        const title = text.createDiv({ cls: "hp-list-title" });
        title.createSpan({ text: entry.date });
        const weekday = weekdayLabel(entry.date);
        if (weekday) title.createSpan({ cls: "hp-diary-weekday", text: weekday });
        if (entry.date === today) title.createSpan({ cls: "hp-diary-today", text: "今天" });
        if (config.showPreview) {
          void app.vault.cachedRead(entry.file).then((content) => {
            if (!ctx.isAlive()) return;
            const preview = firstSentencePreview(content);
            if (preview) text.createDiv({ cls: "hp-list-sub hp-diary-preview", text: preview });
          });
        }
        row.addEventListener("click", (event) => void ctx.openPath(entry.file.path, { event }));
      }
      if (truncated) break;
    }
    // 列表被条数上限截断时明说，避免「全部」看起来缺年份。
    if (truncated) {
      list.createDiv({
        cls: "hp-empty",
        text: `已按「最多显示条数」（${config.limit}）截断，仅显示最新 ${rendered} 篇；可在组件设置里调大上限。`
      });
    }
  },

  renderSettings(container, ctx) {
    const { config } = ctx;
    const settings = getDailyNoteSettings(ctx.app);
    addPathSetting(container, ctx.app, {
      name: "日记文件夹",
      desc: settings.folder ? `留空跟随核心「每日笔记」插件（当前：${settings.folder}）。` : "留空为全库。",
      value: config.folder,
      suggest: { files: false, folders: true },
      onChange: (value) => ctx.update({ folder: value })
    });
    addNumberSetting(container, { name: "最多显示条数", value: config.limit, min: 5, max: 500, onChange: (value) => ctx.update({ limit: value }) });
    new Setting(container).setName("统计瓦片").setDesc("日记总数 / 最近一篇 / 本月 / 年份跨度。")
      .addToggle((toggle) => toggle.setValue(config.showStats).onChange((value) => ctx.update({ showStats: value })));
    new Setting(container).setName("首句预览").setDesc("日记行下方显示正文第一句话（截 40 字）。")
      .addToggle((toggle) => toggle.setValue(config.showPreview).onChange((value) => ctx.update({ showPreview: value })));
  }
};
