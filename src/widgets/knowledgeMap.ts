import { App, Setting, WorkspaceLeaf } from "obsidian";
import { normalizeWith, type WidgetDefinition } from "./types";

export interface KnowledgeMapConfig extends Record<string, unknown> {
  /** 当前点亮的统计分区；空串 = 默认知识库范围。 */
  area: string;
  /** 是否按目录生成原生图谱颜色分组。 */
  colorize: boolean;
}

const DEFAULTS: KnowledgeMapConfig = {
  area: "",
  colorize: true
};

const KNOWLEDGE_SCOPE_PATHS = [
  "Knowledge/AI",
  "Knowledge/Engineering",
  "Knowledge/Methods",
  "Knowledge/Life",
  "Knowledge/_mocs"
];

const GRAPH_PALETTE = [0xe05252, 0x52a8e0, 0x7bd86b, 0xd86bd8, 0xe0a852, 0x52d8d0, 0xb0b0b0];

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

/** 单分区查询词：与工作台原模块使用同一套 path 子串语义。 */
function pathQuery(path: string): string {
  return `path:"${path.replace(/"/g, '\\"')}"`;
}

/** 默认只点亮知识库五个分区；统计中的作坊、档案仅在点芯片时进入图谱。 */
const DEFAULT_GRAPH_QUERY = KNOWLEDGE_SCOPE_PATHS.map(pathQuery).join(" OR ");

function directMarkdownCounts(app: App): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of app.vault.getMarkdownFiles()) {
    const path = file.parent?.path;
    if (path) counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return counts;
}

function knowledgeAreas(app: App): KnowledgeArea[] {
  const counts = directMarkdownCounts(app);
  const count = (path: string): number => counts.get(path) ?? 0;
  const knowledgeTotal =
    count("Knowledge") +
    KNOWLEDGE_SCOPE_PATHS.reduce((total, path) => total + count(path), 0);
  return [
    { label: "总计", path: "", count: knowledgeTotal },
    { label: "AI", path: "Knowledge/AI", count: count("Knowledge/AI") },
    { label: "Engineering", path: "Knowledge/Engineering", count: count("Knowledge/Engineering") },
    { label: "Methods", path: "Knowledge/Methods", count: count("Knowledge/Methods") },
    { label: "Life", path: "Knowledge/Life", count: count("Knowledge/Life") },
    { label: "MOC", path: "Knowledge/_mocs", count: count("Knowledge/_mocs") },
    { label: "作坊", path: "作坊", count: count("作坊") },
    { label: "档案", path: "档案", count: count("档案") }
  ];
}

function colorGroups(app: App): GraphColorGroup[] {
  const dirs = new Set<string>();
  for (const file of app.vault.getMarkdownFiles()) {
    if (file.path.startsWith("Knowledge/")) {
      const parts = file.path.split("/");
      if (parts.length >= 3) dirs.add(`Knowledge/${parts[1]}`);
    } else if (file.path.startsWith("作坊/")) {
      dirs.add("作坊");
    } else if (file.path.startsWith("档案/")) {
      dirs.add("档案");
    }
  }
  return [...dirs].sort().map((path, index) => ({
    query: pathQuery(path),
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
  colorize: boolean
): Promise<GraphHandle> {
  const leaf = createGraphLeaf(app);
  let disposed = false;
  let query = initialQuery;
  let view: NativeGraphView | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let resizeFrame = 0;
  let resizeTimer = 0;
  const groups = colorize ? colorGroups(app) : [];

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

function activeLabel(areas: KnowledgeArea[], path: string): string {
  return areas.find((area) => area.path === path)?.label ?? "知识库";
}

export const knowledgeMapWidget: WidgetDefinition<KnowledgeMapConfig> = {
  kind: "knowledgemap",
  name: "知识地图",
  description: "知识库统计芯片 + Obsidian 原生图谱，点击分区即时过滤；自动按目录配色，保留原生拖拽、缩放与点击打开。",
  icon: "network",
  accent: "#0ea5e9",
  defaultSize: { w: 8, h: 14 },
  liveRefresh: false,
  defaultConfig: () => ({ ...DEFAULTS }),
  normalizeConfig: (raw) => {
    const config = normalizeWith(DEFAULTS, raw);
    config.area = typeof config.area === "string" ? config.area : "";
    config.colorize = config.colorize === true;
    return config;
  },

  render(body, ctx) {
    const { app, config } = ctx;
    const root = body.createDiv({ cls: "hp-knowledge-map" });
    const statsHost = root.createDiv({ cls: "hp-km-stats" });
    const graphHost = root.createDiv({ cls: "hp-km-graph", attr: { "aria-label": "知识地图原生图谱" } });
    let activePath = config.area;
    let graphHandle: GraphHandle | null = null;
    let appliedQuery = activePath ? pathQuery(activePath) : DEFAULT_GRAPH_QUERY;
    let statsTimer = 0;

    const applyFilter = (nextPath: string): void => {
      activePath = nextPath;
      appliedQuery = nextPath ? pathQuery(nextPath) : DEFAULT_GRAPH_QUERY;
      graphHandle?.setFilter(appliedQuery);
    };

    const paintStats = (): void => {
      const areas = knowledgeAreas(app);
      statsHost.empty();
      for (const area of areas) {
        const chip = statsHost.createEl("button", {
          cls: `hp-km-chip${area.path === activePath ? " is-active" : ""}`,
          attr: {
            type: "button",
            title: area.path ? `图谱只看 ${area.label}（再点一次恢复全部）` : "恢复默认知识库范围"
          }
        });
        chip.createSpan({ text: area.label === "总计" ? `共 ${area.count} 篇` : area.label });
        if (area.path) chip.createSpan({ cls: "hp-km-chip-count", text: String(area.count) });
        chip.addEventListener("click", () => {
          const next = area.path && activePath === area.path ? "" : area.path;
          applyFilter(next);
          void ctx.saveConfig({ area: next });
          paintStats();
          ctx.setSubtitle(`${area.label === "总计" ? "知识库" : activeLabel(areas, next)} · 原生图谱`);
        });
      }
    };

    paintStats();
    ctx.setSubtitle(`${activePath ? activeLabel(knowledgeAreas(app), activePath) : "知识库"} · 原生图谱`);
    ctx.addHeaderAction("refresh-cw", "刷新知识地图", () => ctx.rerender());

    const scheduleStats = (): void => {
      if (statsTimer) window.clearTimeout(statsTimer);
      statsTimer = window.setTimeout(() => {
        statsTimer = 0;
        if (ctx.isAlive()) paintStats();
      }, 300);
    };
    const refs = [
      app.vault.on("create", scheduleStats),
      app.vault.on("delete", scheduleStats),
      app.vault.on("rename", scheduleStats)
    ];
    ctx.registerCleanup(() => {
      if (statsTimer) window.clearTimeout(statsTimer);
      for (const ref of refs) app.vault.offref(ref);
    });

    void mountNativeGraph(app, graphHost, appliedQuery, config.colorize)
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
    new Setting(container)
      .setName("自动配色")
      .setDesc("按 knowledge 二级目录、作坊与档案生成原生图谱颜色分组。")
      .addToggle((toggle) => toggle
        .setValue(ctx.config.colorize)
        .onChange((value) => ctx.update({ colorize: value })));
  }
};
