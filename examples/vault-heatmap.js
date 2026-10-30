// 全库热力值（vault-heatmap）—— Home Pages 自定义组件社区示例
// GitHub 风格日历热力图：全 vault 的 Markdown 笔记按修改日（stat.mtime）分日计数，
// 同文件同日去重，排除隐藏目录（"." 开头）；默认近 53 周，列 = 周（周日→周六），
// 横轴为月份英文缩写、纵轴标注 Mon / Wed / Fri。
//
// 使用方法：把本文件复制到你的自定义组件目录（如 .scripts/home-pages/），
// 保存后 Home Pages 会自动加载；统计默认按需计算、文件事件合并刷新，不进行短周期全库扫描。
module.exports = {
  kind: "vault-heatmap",
  name: "全库热力值",
  description: "GitHub 风格日历热力图：全库笔记按修改日分日计数（口径同知识工作台）",
  icon: "flame",
  accent: "#22c55e",
  defaultSize: { w: 10, h: 4 },
  liveRefresh: false,

  defaultConfig() {
    return {
      configVersion: 2,
      weeks: 53,             // 显示周数（26–106）
      excludeFolders: "",    // 额外排除的目录，逗号分隔，如 "Archive,模板"
      autoRefreshMinutes: 0  // 可选的兜底刷新（分钟，0 = 只跟随 vault 变化）
    };
  },

  render(body, ctx) {
    const configVersion = Number(ctx.config.configVersion) || 1;
    const configuredRefresh = Math.max(0, Number(ctx.config.autoRefreshMinutes) || 0);
    // v1 默认值会持久化成 5；升级时把这个旧默认迁移到 0，其它显式非默认值保持不变。
    const migratedRefresh = configVersion < 2 && configuredRefresh === 5 ? 0 : configuredRefresh;
    const cfg = {
      weeks: Math.max(26, Math.min(106, Number(ctx.config.weeks) || 53)),
      excludeFolders: String(ctx.config.excludeFolders || "")
        .split(/[\n,，]/)
        .map((s) => s.trim().replace(/^\/+|\/+$/g, ""))
        .filter(Boolean),
      autoRefreshMinutes: migratedRefresh
    };
    if (configVersion < 2) {
      void ctx.saveConfig({ configVersion: 2, autoRefreshMinutes: migratedRefresh });
    }

    // 首次统计放到空闲帧，打开首页时不阻塞首屏；共享快照会与其它组件复用。
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
      const cells = []; // { date, count }
      let activeDays = 0;
      // 按「日期部分」逐日推进（setDate），夏令时时区不会漂移；
      // 毫秒累加（t += 86400000）在 DST 切换后会把整条日历错位一天。
      for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const c = dayCount.get(key) || 0;
        if (c > 0) activeDays += 1;
        cells.push({ date: new Date(d), count: c, key });
      }
      const max = Math.max(1, ...cells.map((c) => c.count));

      // —— 渲染 ——
    const wrap = body.createDiv({ cls: "vh-wrap" });
    wrap.style.display = "flex";
    wrap.style.flexDirection = "column";
    wrap.style.justifyContent = "center"; // 卡片比内容高时垂直居中
    wrap.style.gap = "6px";
    wrap.style.height = "100%";
    wrap.style.minWidth = "0";
    wrap.style.padding = "6px 12px 8px";

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
    inner.style.margin = "0 auto"; // 卡片比日历宽时水平居中；不够宽时自动贴左并滚动

    // 左：星期标签列（七行与格子对齐，只标 Mon / Wed / Fri，GitHub 同款）
    const wdCol = inner.createDiv({ cls: "vh-weekdays" });
    wdCol.style.display = "grid";
    wdCol.style.gridTemplateRows = "16px repeat(7, 12px)"; // 首行留给月份标签，与右侧对齐
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

    // 上：月份标签（英文缩写）。GitHub 的列标签挂在「1 号前一天所在周」的列上：
    // 例如 2026-02-01 是周日，Feb 会挂在 2026-01-25 那一周；最左侧被截断的起始月
    // 则不再补标签，避免默认 53 周时同时出现两个 Oct。
    const monthsRow = gridCol.createDiv({ cls: "vh-months" });
    monthsRow.style.display = "grid";
    monthsRow.style.gridAutoFlow = "column";
    monthsRow.style.gridAutoColumns = "12px";
    monthsRow.style.gap = "3px";
    monthsRow.style.height = "16px";
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const colCount = Math.ceil(cells.length / 7);
    const dayNumber = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000;
    const labelCols = new Map();
    for (
      let first = new Date(start.getFullYear(), start.getMonth(), 1);
      first.getTime() <= today.getTime();
      first.setMonth(first.getMonth() + 1)
    ) {
      // 起始月的 1 号若在窗口之前，它就是被截断的半月；GitHub 不为它补标签。
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
      // 分档：0 / ≤25% / ≤50% / ≤75% / >75%（GitHub 同款思路）
      const ratio = cell.count / max;
      const level = cell.count === 0 ? 0 : ratio <= 0.25 ? 1 : ratio <= 0.5 ? 2 : ratio <= 0.75 ? 3 : 4;
      const el = grid.createDiv({ cls: `vh-cell vh-lv${level}` });
      el.style.width = "12px";
      el.style.height = "12px";
      el.style.borderRadius = "2px";
      el.title = `${cell.key} · ${cell.count} 篇`;
    }

    // 下：图例（少 → 五档 → 多，挂在网格列下方右对齐，与格子右缘严格对齐）
    const legend = gridCol.createDiv({ cls: "vh-legend" });
    legend.style.display = "flex";
    legend.style.alignItems = "center";
    legend.style.justifyContent = "flex-end";
    legend.style.gap = "3px";
    legend.style.fontSize = "10px";
    legend.style.color = "var(--text-faint)";
    legend.createSpan({ text: "少" });
    for (let lv = 0; lv <= 4; lv++) {
      const dot = legend.createDiv({ cls: `vh-cell vh-lv${lv}` });
      dot.style.width = "10px";
      dot.style.height = "10px";
      dot.style.borderRadius = "2px";
    }
    legend.createSpan({ text: "多" });

    // —— 样式（accent 可调，颜色随主题背景混合，深浅色都可用）——
    const style = body.createEl("style");
    style.textContent = `
      .vh-lv0 { background: var(--background-modifier-hover); border: 1px solid var(--background-modifier-border); }
      .vh-lv1 { background: color-mix(in srgb, ${ctx.config.accent || "#22c55e"} 25%, var(--background-secondary)); }
      .vh-lv2 { background: color-mix(in srgb, ${ctx.config.accent || "#22c55e"} 50%, var(--background-secondary)); }
      .vh-lv3 { background: color-mix(in srgb, ${ctx.config.accent || "#22c55e"} 75%, var(--background-secondary)); }
      .vh-lv4 { background: ${ctx.config.accent || "#22c55e"}; }
    `;
    }, 1_000);

    // 文件事件由 Home Pages 合并后再重绘；定时器仅作为用户显式配置的兜底。
    ctx.onVaultChange(() => ctx.rerender(), { includeMetadata: false });
    if (cfg.autoRefreshMinutes > 0) {
      ctx.registerInterval(() => ctx.rerender(), cfg.autoRefreshMinutes * 60 * 1000);
    }
  },

  renderSettings(container, ctx) {
    const { Setting } = obsidian;

    new Setting(container)
      .setName("显示周数")
      .setDesc("热力图横向显示多少周（26–106，默认 53）")
      .addText((text) =>
        text.setValue(String(ctx.config.weeks)).onChange((val) => {
          const n = parseInt(val, 10);
          if (!isNaN(n)) ctx.update({ weeks: n });
        })
      );

    new Setting(container)
      .setName("额外排除目录")
      .setDesc("逗号分隔的 vault 相对路径，如 Archive,模板（隐藏目录始终排除）")
      .addText((text) =>
        text.setValue(ctx.config.excludeFolders).onChange((val) => ctx.update({ excludeFolders: val }))
      );

    new Setting(container)
      .setName("强调色")
      .setDesc("热力格子的主色（默认 GitHub 绿 #22c55e）")
      .addText((text) =>
        text.setValue(ctx.config.accent || "#22c55e").onChange((val) => ctx.update({ accent: val }))
      );

    new Setting(container)
      .setName("自动刷新（分钟）")
      .setDesc("默认 0：只在打开首页、文件变化或点击标题栏刷新时更新；大于 0 时增加兜底刷新。")
      .addText((text) =>
        text.setValue(String(ctx.config.autoRefreshMinutes)).onChange((val) => {
          const n = parseInt(val, 10);
          if (!isNaN(n)) ctx.update({ autoRefreshMinutes: n });
        })
      );
  }
};
