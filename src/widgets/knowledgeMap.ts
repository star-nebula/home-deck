import { App, normalizePath, Setting, TFile, WorkspaceLeaf } from "obsidian";
import { addPathSetting, addTextareaSetting } from "../ui/settingHelpers";
import { normalizeWith, toStringList, type WidgetDefinition } from "./types";

type KnowledgeMapScopeMode = "knowledge" | "knowledge-creation" | "vault" | "custom";

export interface KnowledgeMapConfig extends Record<string, unknown> {
  /** 图谱默认范围。 */
  scopeMode: KnowledgeMapScopeMode;
  /** scopeMode = custom 时使用。 */
  customFolder: string;
  /** 不进入统计与图谱的文件夹（含子文件夹）。 */
  excludeFolders: string[];
  /** 当前点亮的统计分区；空串 = 当前范围的汇总。 */
  area: string;
  /** 是否显示总计与分区芯片。 */
  showStats: boolean;
  /** 是否在统计芯片上显示篇数。 */
  showCounts: boolean;
  /** 是否按分区生成原生图谱颜色分组。 */
  colorize: boolean;
}

const DEFAULTS: KnowledgeMapConfig = {
  scopeMode: "knowledge",
  customFolder: "",
  excludeFolders: [],
  area: "",
  showStats: true,
  showCounts: true,
  colorize: true
};

const KNOWLEDGE_AREAS = [
  { label: "AI", path: "Knowledge/AI" },
  { label: "Engineering", path: "Knowledge/Engineering" },
  { label: "Methods", path: "Knowledge/Methods" },
  { label: "Life", path: "Knowledge/Life" },
  { label: "MOC", path: "Knowledge/_mocs" }
];

const CREATION_AREAS = [
  { label: "作坊", path: "作坊" },
  { label: "档案", path: "档案" }
];

const GRAPH_PALETTE = [0xe05252, 0x52a8e0, 0x7bd86b, 0xd86bd8, 0xe0a852, 0x52d8d0, 0xb0b0b0];
const EMPTY_SCOPE_QUERY = 'path:"__home_pages_knowledge_map_empty_scope__"';

interface KnowledgeArea {
  label: string;
  path: string;
  count: number;
}

interface GraphColorGroup {
  query: string;
  color: { a: number; rgb: number };
}

interface GraphEngine {
  setOptions?: (options: { search: string; colorGroups: GraphColorGroup[] }) => void;
}

interface NativeGraphView {
  containerEl: HTMLElement;
  dataEngine?: GraphEngine;
  getViewType?: () => string;
  onResize?: () => void;
}

interface GraphHandle {
  setFilter(query: string): void;
  dispose(): void;
}

interface ResolvedScope {
  mode: KnowledgeMapScopeMode;
  paths: string[];
  allVault: boolean;
  emptyCustom: boolean;
}

function pathQuery(path: string): string {
  return `path:"${path.replace(/"/g, '\\"')}"`;
}

function isWithinPath(filePath: string, folder: string): boolean {
  return filePath === folder || filePath.startsWith(`${folder}/`);
}

function isExcluded(filePath: string, excludes: string[]): boolean {
  return excludes.some((folder) => folder && isWithinPath(filePath, folder));
}

function normalizeFolders(folders: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of folders) {
    const folder = normalizePath(String(raw ?? "").trim()).replace(/\/+$/g, "");
    if (!folder || seen.has(folder)) continue;
    seen.add(folder);
    result.push(folder);
  }
  return result;
}

function resolveScope(config: KnowledgeMapConfig): ResolvedScope {
  if (config.scopeMode === "vault") {
    return { mode: "vault", paths: [], allVault: true, emptyCustom: false };
  }
  if (config.scopeMode === "custom") {
    const folder = normalizePath(config.customFolder.trim()).replace(/\/+$/g, "");
    return { mode: "custom", paths: folder ? [folder] : [], allVault: false, emptyCustom: !folder };
  }
  const paths = (config.scopeMode === "knowledge-creation"
    ? [...KNOWLEDGE_AREAS, ...CREATION_AREAS]
    : KNOWLEDGE_AREAS
  ).map((area) => area.path);
  return { mode: config.scopeMode, paths, allVault: false, emptyCustom: false };
}

function scopeFiles(files: readonly TFile[], scope: ResolvedScope, excludes: string[]): string[] {
  return files
    .map((file) => file.path)
    .filter((path) => (scope.allVault || scope.paths.some((folder) => isWithinPath(path, folder))) && !isExcluded(path, excludes));
}

function countWithin(files: string[], folder: string): number {
  return files.filter((path) => isWithinPath(path, folder)).length;
}

function dynamicAreaPath(filePath: string, scope: ResolvedScope): string {
  if (scope.mode === "vault") {
    const parts = filePath.split("/");
    return parts.length > 1 ? parts[0] : "";
  }
  const root = scope.paths[0];
  if (!root || !filePath.startsWith(`${root}/`)) return "";
  const relative = filePath.slice(root.length + 1);
  const parts = relative.split("/");
  return parts.length > 1 ? `${root}/${parts[0]}` : "";
}

function areaLabel(path: string): string {
  return path.split("/").pop() ?? path;
}

function knowledgeAreas(app: App, config: KnowledgeMapConfig, files: readonly TFile[]): KnowledgeArea[] {
  const scope = resolveScope(config);
  const excludes = config.excludeFolders;
  const scopedFiles = scopeFiles(files, scope, excludes);
  const areas: KnowledgeArea[] = [{ label: "总计", path: "", count: scopedFiles.length }];
  const fixed = scope.mode === "knowledge-creation"
    ? [...KNOWLEDGE_AREAS, ...CREATION_AREAS]
    : scope.mode === "knowledge"
      ? KNOWLEDGE_AREAS
      : [];

  if (fixed.length > 0) {
    for (const area of fixed) {
      areas.push({ ...area, count: countWithin(scopedFiles, area.path) });
    }
    return areas;
  }

  const counts = new Map<string, number>();
  for (const path of scopedFiles) {
    const areaPath = dynamicAreaPath(path, scope);
    if (areaPath) counts.set(areaPath, (counts.get(areaPath) ?? 0) + 1);
  }
  for (const [path, count] of [...counts].sort(([a], [b]) => a.localeCompare(b, "zh-Hans-CN"))) {
    areas.push({ label: areaLabel(path), path, count });
  }
  return areas;
}

function graphQuery(scope: ResolvedScope, excludes: string[], areaPath = ""): string {
  if (scope.emptyCustom) return EMPTY_SCOPE_QUERY;
  const clauses: string[] = [];
  if (areaPath) {
    clauses.push(pathQuery(areaPath));
  } else if (!scope.allVault && scope.paths.length > 0) {
    clauses.push(scope.paths.map(pathQuery).join(" OR "));
  }
  for (const folder of excludes) clauses.push(`-${pathQuery(folder)}`);
  return clauses.join(" ").trim();
}

function colorGroupsForAreas(areas: KnowledgeArea[]): GraphColorGroup[] {
  return areas
    .filter((area) => area.path)
    .map((area, index) => ({
      query: pathQuery(area.path),
      color: { a: 1, rgb: GRAPH_PALETTE[index % GRAPH_PALETTE.length] }
    }));
}

function createGraphLeaf(app: App): WorkspaceLeaf {
  const LeafConstructor = WorkspaceLeaf as unknown as new (host: App) => WorkspaceLeaf;
  return new LeafConstructor(app);
}

/**
 * 把一个游离的 Obsidian 原生 graph leaf 挂进组件。
 * 视图自身的 dataEngine.setOptions 是运行时过滤通道，不写 graph.json，也不污染独立图谱页。
 */
async function mountNativeGraph(
  app: App,
  host: HTMLElement,
  initialQuery: string,
  groups: GraphColorGroup[]
): Promise<GraphHandle> {
  const leaf = createGraphLeaf(app);
  let disposed = false;
  let query = initialQuery;
  let view: NativeGraphView | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let resizeFrame = 0;
  let resizeTimer = 0;

  const options = (): { search: string; colorGroups: GraphColorGroup[] } => ({
    search: query,
    colorGroups: groups
  });

  const applyOptions = (): void => {
    if (!view || disposed) return;
    try {
      const engine = view.dataEngine;
      if (engine?.setOptions) {
        engine.setOptions(options());
        return;
      }
      const legacy = view as NativeGraphView & { setOptions?: (value: ReturnType<typeof options>) => void };
      legacy.setOptions?.(options());
    } catch (error) {
      console.error("Home Pages: knowledge map filter update failed", error);
    }
  };

  const resize = (): void => {
    if (!view || disposed) return;
    try {
      view.onResize?.();
    } catch (error) {
      console.error("Home Pages: knowledge map resize failed", error);
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
    if (resizeTimer) window.clearTimeout(resizeTimer);
    resizeObserver?.disconnect();
    resizeObserver = null;
    try {
      leaf.detach();
    } catch {
      // Leaf 可能已被宿主提前分离。
    }
  };

  try {
    await leaf.setViewState({ type: "graph", state: {} });
    view = leaf.view;
    if (!view?.containerEl || view.getViewType?.() !== "graph") {
      throw new Error("graph view was not created");
    }
    applyOptions();
    host.appendChild(view.containerEl);
    view.containerEl.classList.add("hp-km-native-graph");
    applyOptions();
    resizeFrame = window.requestAnimationFrame(resize);
    resizeTimer = window.setTimeout(resize, 120);
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(host);
    }
  } catch (error) {
    dispose();
    throw error;
  }

  return {
    setFilter: (next) => {
      query = next;
      applyOptions();
    },
    dispose
  };
}

function scopeSummary(config: KnowledgeMapConfig): string {
  if (config.scopeMode === "vault") return "全库";
  if (config.scopeMode === "custom") return config.customFolder.trim() || "自定义范围";
  return config.scopeMode === "knowledge-creation" ? "知识库与创作区" : "知识库";
}

function activeLabel(areas: KnowledgeArea[], path: string, config: KnowledgeMapConfig): string {
  return path ? areas.find((area) => area.path === path)?.label ?? scopeSummary(config) : scopeSummary(config);
}

export const knowledgeMapWidget: WidgetDefinition<KnowledgeMapConfig> = {
  kind: "knowledgemap",
  name: "知识地图",
  description: "可配置范围的原生图谱：分区统计、即时过滤、排除目录与自动配色，保留缩放、拖拽和点击打开。",
  icon: "network",
  accent: "#0ea5e9",
  defaultSize: { w: 8, h: 14 },
  liveRefresh: false,
  defaultConfig: () => ({ ...DEFAULTS, excludeFolders: [] }),
  normalizeConfig: (raw) => {
    const config = normalizeWith(DEFAULTS, raw);
    config.scopeMode =
      config.scopeMode === "knowledge-creation" || config.scopeMode === "vault" || config.scopeMode === "custom"
        ? config.scopeMode
        : "knowledge";
    config.customFolder = config.customFolder.trim();
    config.excludeFolders = normalizeFolders(toStringList(raw.excludeFolders));
    config.area = typeof config.area === "string" ? config.area : "";
    config.showStats = config.showStats === true;
    config.showCounts = config.showCounts === true;
    config.colorize = config.colorize === true;
    return config;
  },

  render(body, ctx) {
    const { app, config } = ctx;
    const scope = resolveScope(config);
    const initialAreas = knowledgeAreas(app, config, ctx.getMarkdownFiles());
    let activePath = initialAreas.some((area) => area.path && area.path === config.area) ? config.area : "";
    let graphHandle: GraphHandle | null = null;
    let appliedQuery = graphQuery(scope, config.excludeFolders, activePath);
    let statsTimer = 0;
    const root = body.createDiv({ cls: "hp-knowledge-map" });
    const statsHost = config.showStats ? root.createDiv({ cls: "hp-km-stats" }) : null;
    const graphHost = root.createDiv({ cls: "hp-km-graph", attr: { "aria-label": "知识地图原生图谱" } });

    const setSubtitle = (areas: KnowledgeArea[]): void => {
      ctx.setSubtitle(`${activeLabel(areas, activePath, config)} · 原生图谱`);
    };

    const applyFilter = (nextPath: string): void => {
      activePath = nextPath;
      appliedQuery = graphQuery(scope, config.excludeFolders, nextPath);
      graphHandle?.setFilter(appliedQuery);
    };

    const paintStats = (): void => {
      const areas = knowledgeAreas(app, config, ctx.getMarkdownFiles());
      if (activePath && !areas.some((area) => area.path === activePath)) applyFilter("");
      setSubtitle(areas);
      if (!statsHost) return;
      statsHost.empty();
      for (const area of areas) {
        const chip = statsHost.createEl("button", {
          cls: `hp-km-chip${area.path === activePath ? " is-active" : ""}`,
          attr: {
            type: "button",
            title: area.path ? `图谱只看 ${area.label}（再点一次恢复汇总）` : "恢复范围汇总"
          }
        });
        const totalLabel = config.showCounts ? `共 ${area.count} 篇` : "全部";
        chip.createSpan({ text: area.path ? area.label : totalLabel });
        if (area.path && config.showCounts) {
          chip.createSpan({ cls: "hp-km-chip-count", text: String(area.count) });
        }
        chip.addEventListener("click", () => {
          const next = area.path && activePath === area.path ? "" : area.path;
          applyFilter(next);
          void ctx.saveConfig({ area: next });
          paintStats();
        });
      }
    };

    paintStats();
    ctx.addHeaderAction("refresh-cw", "刷新知识地图", () => ctx.rerender());

    const scheduleStats = (): void => {
      if (statsTimer) window.clearTimeout(statsTimer);
      statsTimer = window.setTimeout(() => {
        statsTimer = 0;
        if (ctx.isAlive()) paintStats();
      }, 300);
    };
    ctx.onVaultChange((change) => {
      const structural = change.operations.some((operation) => operation === "create" || operation === "delete" || operation === "rename");
      if (!structural) return;
      const relevant = change.paths.some((path) =>
        (scope.allVault || scope.paths.some((folder) => isWithinPath(path, folder))) && !isExcluded(path, config.excludeFolders)
      );
      if (relevant) scheduleStats();
    });
    ctx.registerCleanup(() => {
      if (statsTimer) window.clearTimeout(statsTimer);
    });

    const groups = config.colorize ? colorGroupsForAreas(initialAreas) : [];
    void mountNativeGraph(app, graphHost, appliedQuery, groups)
      .then((handle) => {
        if (!ctx.isAlive()) {
          handle.dispose();
          return;
        }
        graphHandle = handle;
        ctx.registerCleanup(() => handle.dispose());
        handle.setFilter(appliedQuery);
      })
      .catch((error) => {
        console.error("Home Pages: knowledge map failed to mount native graph", error);
        if (!ctx.isAlive()) return;
        graphHost.empty();
        graphHost.createDiv({
          cls: "hp-empty hp-km-empty",
          text: "原生图谱不可用，请确认核心插件「图谱」已启用。"
        });
      });
  },

  renderSettings(container, ctx) {
    const { app, config } = ctx;
    new Setting(container)
      .setName("图谱范围")
      .setDesc("控制默认进入图谱的文件夹；自定义范围可指向任意目录。")
      .addDropdown((dropdown) => dropdown
        .addOptions({
          knowledge: "知识库",
          "knowledge-creation": "知识库 + 作坊 / 档案",
          vault: "全库",
          custom: "自定义文件夹"
        })
        .setValue(config.scopeMode)
        .onChange((value) => {
          const scopeMode = value === "knowledge-creation" || value === "vault" || value === "custom" ? value : "knowledge";
          ctx.update({ scopeMode, area: "" });
          ctx.refresh();
        }));

    if (config.scopeMode === "custom") {
      addPathSetting(container, app, {
        name: "自定义文件夹",
        desc: "图谱与统计只扫描这个文件夹（含子文件夹）。",
        value: config.customFolder,
        placeholder: "例如 Knowledge/AI",
        suggest: { files: false, folders: true },
        onChange: (value) => ctx.update({ customFolder: value, area: "" }),
        onCommit: () => ctx.refresh()
      });
    }

    addTextareaSetting(container, {
      name: "排除文件夹",
      desc: "一行一个路径，路径及其子文件夹不会进入统计或图谱。",
      value: config.excludeFolders.join("\n"),
      placeholder: "例如 Knowledge/_mocs\nArchive",
      rows: 3,
      onChange: (value) => ctx.update({ excludeFolders: normalizeFolders(toStringList(value)) })
    });

    const areas = knowledgeAreas(app, config, ctx.plugin.vaultStats.getMarkdownFiles());
    const areaOptions: Record<string, string> = { "": "范围汇总" };
    for (const area of areas) {
      if (!area.path) continue;
      areaOptions[area.path] = `${area.label}（${area.count} 篇）`;
    }
    if (config.area && !(config.area in areaOptions)) areaOptions[config.area] = `${config.area}（当前不存在）`;
    new Setting(container)
      .setName("默认分区")
      .setDesc("打开组件时默认点亮的分区；关闭统计芯片后仍按此分区过滤。")
      .addDropdown((dropdown) => dropdown
        .addOptions(areaOptions)
        .setValue(config.area)
        .onChange((value) => ctx.update({ area: value })));

    new Setting(container)
      .setName("统计芯片")
      .setDesc("显示范围汇总与分区芯片；关闭后图谱仍按默认分区过滤。")
      .addToggle((toggle) => toggle.setValue(config.showStats).onChange((value) => ctx.update({ showStats: value })));

    new Setting(container)
      .setName("芯片计数")
      .setDesc("在统计芯片上显示篇数；关闭后保留分区筛选。")
      .addToggle((toggle) => toggle.setValue(config.showCounts).onChange((value) => ctx.update({ showCounts: value })));

    new Setting(container)
      .setName("自动配色")
      .setDesc("按当前范围的分区生成原生图谱颜色分组。")
      .addToggle((toggle) => toggle.setValue(config.colorize).onChange((value) => ctx.update({ colorize: value })));
  }
};
