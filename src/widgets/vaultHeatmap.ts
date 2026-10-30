import { Setting } from "obsidian";
import type { WidgetContext, WidgetDefinition } from "./types";
import { clampInt, normalizeWith, toStringList } from "./types";
import { toIsoDate } from "../utils/date";

interface VaultHeatmapConfig extends Record<string, unknown> {
  configVersion: number;
  weeks: number;
  excludeFolders: string;
  autoRefreshMinutes: number;
  /** 热力格子的主色；保留旧自定义组件的配置键。 */
  accent: string;
}

const DEFAULTS: VaultHeatmapConfig = {
  configVersion: 2,
  weeks: 53,
  excludeFolders: "",
  autoRefreshMinutes: 0,
  accent: "#22c55e"
};

interface HeatCell {
  date: Date;
  count: number;
  key: string;
}

/**
 * 全库热力值。
 *
 * 从旧版自定义组件 `vault-heatmap` 迁移为内置组件：kind、默认尺寸与配置键保持
 * 不变，所以旧布局里的卡片不需要重建。统计继续复用 VaultIndex 的 activityByDay。
 */
export const vaultHeatmapWidget: WidgetDefinition<VaultHeatmapConfig> = {
  kind: "vault-heatmap",
  name: "全库热力值",
  description: "GitHub 风格日历热力图：全库笔记按修改日分日计数（口径同知识工作台）",
  icon: "flame",
  accent: "#22c55e",
  defaultSize: { w: 10, h: 4 },
  liveRefresh: false,
  defaultConfig: () => ({ ...DEFAULTS }),
  normalizeConfig: (raw) => {
    const config = normalizeWith(DEFAULTS, raw);
    // 旧自定义组件的配置里没有 configVersion；保留 1，让 render 执行 5→0 的刷新迁移。
    config.configVersion = raw.configVersion === undefined ? 1 : clampInt(config.configVersion, 1, 2, 2);
    config.weeks = clampInt(config.weeks, 26, 106, DEFAULTS.weeks);
    config.autoRefreshMinutes = clampInt(config.autoRefreshMinutes, 0, 24 * 60, DEFAULTS.autoRefreshMinutes);
    config.excludeFolders = toStringList(config.excludeFolders).join(",");
    config.accent = String(config.accent || DEFAULTS.accent).trim() || DEFAULTS.accent;
    return config;
  },

  render(body, ctx) {
    const configVersion = Number(ctx.config.configVersion) || 1;
    const configuredRefresh = Math.max(0, Number(ctx.config.autoRefreshMinutes) || 0);
    // v1 默认值会持久化成 5；升级时把这个旧默认迁移到 0，其它显式非默认值保持不变。
    const migratedRefresh = configVersion < 2 && configuredRefresh === 5 ? 0 : configuredRefresh;
    const cfg = {
      weeks: Math.max(26, Math.min(106, Number(ctx.config.weeks) || 53)),
      excludeFolders: toStringList(ctx.config.excludeFolders),
      autoRefreshMinutes: migratedRefresh
    };
    if (configVersion < 2) {
      void ctx.saveConfig({ configVersion: 2, autoRefreshMinutes: migratedRefresh });
    }

    body.createDiv({ cls: "hp-empty", text: "正在整理知识库热力…" });
    ctx.scheduleIdle(() => {
      if (!ctx.isAlive()) return;
      body.empty();
      const stats = ctx.getVaultStats({ excludeFolders: cfg.excludeFolders, excludeHidden: true });
      const dayCount = new Map(Object.entries(stats.activityByDay));
      const total = Object.values(stats.activityByDay).reduce((sum, count) => sum + count, 0);

      // —— 日历骨架：从本周周六回推 N 周，列 = 周（周日→周六）——
      const HEAT_WEEKS = cfg.weeks;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const end = new Date(today);
      end.setDate(end.getDate() + (6 - end.getDay())); // 本周周六
      const start = new Date(end);
      start.setDate(start.getDate() - (HEAT_WEEKS * 7 - 1));
      const cells: HeatCell[] = [];
      let activeDays = 0;
      // 按「日期部分」逐日推进（setDate），夏令时时区不会漂移。
      for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const key = toIsoDate(d);
        const c = dayCount.get(key) || 0;
        if (c > 0) activeDays += 1;
        cells.push({ date: new Date(d), count: c, key });
      }
      const max = Math.max(1, ...cells.map((cell) => cell.count));

      const wrap = body.createDiv({ cls: "vh-wrap" });
      wrap.style.display = "flex";
      wrap.style.flexDirection = "column";
      wrap.style.justifyContent = "center";
      wrap.style.gap = "6px";
      wrap.style.height = "100%";
      wrap.style.minWidth = "0";
      wrap.style.padding = "6px 12px 8px";
      wrap.style.setProperty("--vh-accent", ctx.config.accent);

      // 摘要文字放到卡片头部、设置按钮旁边（点击即手动刷新统计）
      const infoBtn = ctx.addHeaderAction("activity", "点击刷新统计", () => ctx.rerender());
      infoBtn.empty();
      infoBtn.setText(`近 ${HEAT_WEEKS} 周 · ${total} 篇笔记有修改 · 活跃 ${activeDays} 天`);
      infoBtn.style.cssText =
        "width:auto;height:auto;padding:0 6px;font-size:12px;font-weight:normal;" +
        "color:var(--text-muted);background:transparent;border:none;box-shadow:none;cursor:pointer;";

      const scroll = wrap.createDiv({ cls: "vh-scroll" });
      scroll.style.overflowX = "auto";

      const inner = scroll.createDiv({ cls: "vh-inner" });
      inner.style.display = "flex";
      inner.style.gap = "4px";
      inner.style.width = "max-content";
      inner.style.margin = "0 auto";

      // 左：星期标签列（七行与格子对齐，只标 Mon / Wed / Fri，GitHub 同款）
      const wdCol = inner.createDiv({ cls: "vh-weekdays" });
      wdCol.style.display = "grid";
      wdCol.style.gridTemplateRows = "16px repeat(7, 12px)";
      wdCol.style.gap = "3px";
      const WEEKDAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];
      wdCol.createDiv({ text: "" });
      for (const w of WEEKDAY_LABELS) {
        const el = wdCol.createDiv({ text: w });
        el.style.fontSize = "9px";
        el.style.lineHeight = "12px";
        el.style.color = "var(--text-faint)";
        el.style.whiteSpace = "nowrap";
      }

      const gridCol = inner.createDiv({ cls: "vh-gridcol" });
      gridCol.style.display = "flex";
      gridCol.style.flexDirection = "column";
      gridCol.style.gap = "3px";

      // 上：月份标签（英文缩写）。GitHub 的列标签挂在「1 号前一天所在周」的列上；
      // 最左侧被截断的起始月不补标签，避免默认 53 周时同时出现两个 Oct。
      const monthsRow = gridCol.createDiv({ cls: "vh-months" });
      monthsRow.style.display = "grid";
      monthsRow.style.gridAutoFlow = "column";
      monthsRow.style.gridAutoColumns = "12px";
      monthsRow.style.gap = "3px";
      monthsRow.style.height = "16px";
      const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const colCount = Math.ceil(cells.length / 7);
      const dayNumber = (date: Date): number => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
      const labelCols = new Map<number, string>();
      for (
        const first = new Date(start.getFullYear(), start.getMonth(), 1);
        first.getTime() <= today.getTime();
        first.setMonth(first.getMonth() + 1)
      ) {
        if (first.getTime() < start.getTime()) continue;
        const col = Math.max(0, Math.floor((dayNumber(first) - dayNumber(start) - 1) / 7));
        if (col < colCount) labelCols.set(col, MONTHS[first.getMonth()]);
      }
      for (let col = 0; col < colCount; col++) {
        const el = monthsRow.createDiv({ text: labelCols.get(col) || "" });
        el.style.fontSize = "9px";
        el.style.lineHeight = "16px";
        el.style.color = "var(--text-faint)";
        el.style.whiteSpace = "nowrap";
      }

      const grid = gridCol.createDiv({ cls: "vh-grid" });
      grid.style.display = "grid";
      grid.style.gridAutoFlow = "column";
      grid.style.gridTemplateRows = "repeat(7, 12px)";
      grid.style.gridAutoColumns = "12px";
      grid.style.gap = "3px";
      grid.style.width = "max-content";

      // 逐格铺列（start 是周日，无需 padding）；今天之后的格子不渲染，最后一列自然收尾
      for (const cell of cells) {
        if (cell.date.getTime() > today.getTime()) break;
        const ratio = cell.count / max;
        const level = cell.count === 0 ? 0 : ratio <= 0.25 ? 1 : ratio <= 0.5 ? 2 : ratio <= 0.75 ? 3 : 4;
        const el = grid.createDiv({ cls: `vh-cell vh-lv${level}` });
        el.style.width = "12px";
        el.style.height = "12px";
        el.style.borderRadius = "2px";
        el.title = `${cell.key} · ${cell.count} 篇`;
      }

      // 下：图例（少 → 五档 → 多）
      const legend = gridCol.createDiv({ cls: "vh-legend" });
      legend.style.display = "flex";
      legend.style.alignItems = "center";
      legend.style.justifyContent = "flex-end";
      legend.style.gap = "3px";
      legend.style.fontSize = "10px";
      legend.style.color = "var(--text-faint)";
      legend.createSpan({ text: "少" });
      for (let level = 0; level <= 4; level++) {
        const dot = legend.createDiv({ cls: `vh-cell vh-lv${level}` });
        dot.style.width = "10px";
        dot.style.height = "10px";
        dot.style.borderRadius = "2px";
      }
      legend.createSpan({ text: "多" });
    }, 1_000);

    // 文件事件由宿主合并后再重绘；定时器仅作为用户显式配置的兜底。
    ctx.onVaultChange(() => ctx.rerender(), { includeMetadata: false });
    if (cfg.autoRefreshMinutes > 0) {
      ctx.registerInterval(() => ctx.rerender(), cfg.autoRefreshMinutes * 60 * 1000);
    }
  },

  renderSettings(container, ctx) {
    new Setting(container)
      .setName("显示周数")
      .setDesc("热力图横向显示多少周（26–106，默认 53）")
      .addText((text) =>
        text.setValue(String(ctx.config.weeks)).onChange((value) => {
          const parsed = parseInt(value, 10);
          if (!Number.isNaN(parsed)) ctx.update({ weeks: parsed });
        })
      );

    new Setting(container)
      .setName("额外排除目录")
      .setDesc("逗号分隔的 vault 相对路径，如 Archive,模板（隐藏目录始终排除）")
      .addText((text) =>
        text.setValue(ctx.config.excludeFolders).onChange((value) => ctx.update({ excludeFolders: value }))
      );

    new Setting(container)
      .setName("强调色")
      .setDesc("热力格子的主色（默认 GitHub 绿 #22c55e）")
      .addText((text) =>
        text.setValue(ctx.config.accent).onChange((value) => ctx.update({ accent: value }))
      );

    new Setting(container)
      .setName("自动刷新（分钟）")
      .setDesc("默认 0：只在打开首页、文件变化或点击标题栏刷新时更新；大于 0 时增加兜底刷新。")
      .addText((text) =>
        text.setValue(String(ctx.config.autoRefreshMinutes)).onChange((value) => {
          const parsed = parseInt(value, 10);
          if (!Number.isNaN(parsed)) ctx.update({ autoRefreshMinutes: parsed });
        })
      );
  }
};
