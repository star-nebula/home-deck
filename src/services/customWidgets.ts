import * as obsidian from "obsidian";
import { App, TFile, normalizePath, type TAbstractFile } from "obsidian";
import type { WidgetDefinition } from "../core/ports";
import type { WidgetRegistry } from "../core/widgetRegistry";
import type { LayoutStore } from "../core/layoutStore";
import type { HomeDeckSettings } from "../core/types";

/** 自定义组件与内置组件共用同一套注册表 / 渲染 / 刷新服务。 */
export interface CustomWidgetHost {
  app: App;
  registry: WidgetRegistry;
  layout: LayoutStore;
  settings: HomeDeckSettings;
  /** 插件目录；自定义组件脚本固定放在 <pluginDir>/widgets 下。 */
  pluginDir: string;
  saveSettings(): Promise<void>;
  refreshViews(options?: { kind?: string }): void;
}

export interface CustomWidgetInfo {
  kind: string;
  name: string;
  description: string;
  filePath: string;
}

/** 隐藏目录没有可靠的 vault 事件，用低频扫描兜底。 */
export const CUSTOM_WIDGET_SCAN_INTERVAL_MS = 60_000;

interface LoadedCustomWidget {
  definition: WidgetDefinition<Record<string, unknown>>;
  filePath: string;
}

type AsyncFunctionConstructor = new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

function clampSize(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function toDefinition(raw: unknown, filePath: string): WidgetDefinition<Record<string, unknown>> {
  if (!raw || typeof raw !== "object") throw new Error(`自定义组件 ${filePath} 没有导出组件定义`);
  const value = raw as Record<string, unknown>;
  const kind = typeof value.kind === "string" ? value.kind.trim() : "";
  if (!kind) throw new Error(`自定义组件 ${filePath} 缺少 kind`);
  if (typeof value.render !== "function") throw new Error(`自定义组件 ${filePath} 缺少 render 函数`);
  const defaultConfig = typeof value.defaultConfig === "function" ? (value.defaultConfig as () => Record<string, unknown>) : () => ({});
  const size = (value.defaultSize ?? {}) as Record<string, unknown>;
  return {
    kind,
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : kind,
    description: typeof value.description === "string" ? value.description : "",
    icon: typeof value.icon === "string" && value.icon ? value.icon : "plug",
    accent: typeof value.accent === "string" && value.accent ? value.accent : "#64748b",
    defaultSize: {
      w: clampSize(size.w, 1, 12, 6),
      h: clampSize(size.h, 1, 30, 6)
    },
    defaultConfig: () => defaultConfig(),
    normalizeConfig: typeof value.normalizeConfig === "function"
      ? (value.normalizeConfig as WidgetDefinition<Record<string, unknown>>["normalizeConfig"])
      : undefined,
    render: value.render as WidgetDefinition<Record<string, unknown>>["render"],
    renderSettings: typeof value.renderSettings === "function"
      ? (value.renderSettings as WidgetDefinition<Record<string, unknown>>["renderSettings"])
      : () => undefined,
    liveRefresh: value.liveRefresh !== false,
    refreshOnVaultChange: value.refreshOnVaultChange !== false,
    refreshOnMetadataChange: value.refreshOnMetadataChange !== false
  };
}

/**
 * 执行一个用户组件脚本，返回标准 WidgetDefinition。
 *
 * 这会执行 vault 内的任意 JavaScript，请只加载可信脚本。加载器与内置组件共用
 * WidgetRegistry，因此渲染、刷新、配置面板和 Host API 完全一致。
 */
export async function evaluateWidgetScript(
  source: string,
  app: App,
  filePath = "custom-widget.js"
): Promise<WidgetDefinition<Record<string, unknown>>> {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as AsyncFunctionConstructor;
  const moduleObj = { exports: {} as Record<string, unknown> };
  const exportsObj = moduleObj.exports;
  const windowObj = window as unknown as { obsidian?: unknown; require?: (mod: string) => unknown };
  if (!windowObj.obsidian) {
    try {
      windowObj.obsidian = obsidian;
    } catch {
      // 忽略只读 window 的环境。
    }
  }
  const customRequire = (name: string): unknown => {
    if (name === "obsidian") return obsidian;
    try {
      return windowObj.require?.(name);
    } catch {
      return undefined;
    }
  };

  const runner = new AsyncFunction("module", "exports", "require", "app", "obsidian", source);
  const returned = await runner(moduleObj, exportsObj, customRequire, app, obsidian);
  const isExportsModified =
    moduleObj.exports !== exportsObj ||
    typeof moduleObj.exports === "function" ||
    (moduleObj.exports && Object.keys(moduleObj.exports).length > 0);
  let definition: unknown = isExportsModified
    ? ((moduleObj.exports as { default?: unknown })?.default ?? moduleObj.exports)
    : returned;
  if (typeof definition === "function") {
    definition = await (definition as (ctx: { app: App; obsidian: unknown }) => unknown)({ app, obsidian });
  }
  return toDefinition(definition, filePath);
}

/**
 * 自定义组件加载器。
 *
 * 内置组件在 WidgetRegistry 构造时注册；这里把脚本目录里的定义注册到同一个
 * registry，因此视图层不需要区分来源。
 */
export class CustomWidgetLoader {
  private readonly loaded = new Map<string, LoadedCustomWidget>();
  private readonly fileKinds = new Map<string, string>();
  private readonly mtimes = new Map<string, number>();
  private scanTimer: number | null = null;
  private disposed = false;

  constructor(private readonly host: CustomWidgetHost) {}

  getLoadedWidgets(): CustomWidgetInfo[] {
    return [...this.loaded.entries()]
      .map(([kind, entry]) => ({
        kind,
        name: entry.definition.name,
        description: entry.definition.description,
        filePath: entry.filePath
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  hasKind(kind: string): boolean {
    return this.loaded.has(kind);
  }

  startPolling(): void {
    if (this.scanTimer !== null) return;
    this.scanTimer = window.setInterval(() => {
      void this.scanChanged();
    }, CUSTOM_WIDGET_SCAN_INTERVAL_MS);
  }

  async loadAll(autoAdd = false): Promise<number> {
    if (this.disposed) return 0;
    const folder = this.folder();
    if (!folder) {
      this.unloadAll();
      return 0;
    }
    const files = await this.listScripts(folder);
    const present = new Set(files);
    for (const path of [...this.fileKinds.keys()]) {
      if (!present.has(path)) this.unregisterPath(path);
    }
    for (const path of files) await this.loadFile(path, autoAdd);
    if (autoAdd) await this.host.saveSettings();
    return this.loaded.size;
  }

  /**
   * 把旧的外部自定义组件目录一次性复制到插件内的 widgets/ 目录。
   * 旧目录保持原样，仅作为迁移来源；之后不再依赖它。
   */
  async ensureMigrated(): Promise<void> {
    const target = this.folder();
    const legacy = normalizePath(this.host.settings.customWidgetsFolder?.trim() ?? "");
    if (!target || !legacy || legacy === target) return;

    const targetFiles = await this.listScripts(target);
    if (targetFiles.length > 0) {
      if (this.host.settings.customWidgetsFolder !== target) {
        this.host.settings.customWidgetsFolder = target;
        await this.host.saveSettings();
      }
      return;
    }

    const legacyFiles = await this.listScripts(legacy);
    if (legacyFiles.length === 0) {
      this.host.settings.customWidgetsFolder = target;
      await this.host.saveSettings();
      return;
    }

    const adapter = this.host.app.vault.adapter;
    try {
      await adapter.mkdir(target);
    } catch {
      // 目录已存在时忽略。
    }
    for (const path of legacyFiles) {
      const source = await this.read(path);
      if (source === null) continue;
      const name = path.split("/").pop() ?? path;
      try {
        await adapter.write(normalizePath(`${target}/${name}`), source);
      } catch (error) {
        console.error(`Home Deck: failed to migrate custom widget ${path}`, error);
      }
    }
    this.host.settings.customWidgetsFolder = target;
    await this.host.saveSettings();
  }

  async loadFile(path: string, autoAdd = false): Promise<boolean> {
    if (this.disposed) return false;
    const normalized = normalizePath(path);
    const mtime = await this.stat(normalized);
    if (this.fileKinds.has(normalized) && mtime > 0 && this.mtimes.get(normalized) === mtime) return true;
    const source = await this.read(normalized);
    if (source === null) return false;

    let definition: WidgetDefinition<Record<string, unknown>>;
    try {
      definition = await evaluateWidgetScript(source, this.host.app, normalized);
    } catch (error) {
      console.error(`Home Deck: failed to load custom widget ${normalized}`, error);
      return false;
    }

    const previousKind = this.fileKinds.get(normalized);
    if (previousKind && previousKind !== definition.kind) this.unregisterPath(normalized);

    // 同 kind 的另一个脚本：先加载的生效，避免每轮扫描来回覆盖。
    const existing = this.loaded.get(definition.kind);
    if (existing && existing.filePath !== normalized) {
      console.warn(`Home Deck: custom widget kind ${definition.kind} already loaded from ${existing.filePath}; ignoring ${normalized}`);
      return false;
    }

    try {
      this.host.registry.register(definition, `user-script:${normalized}`);
    } catch (error) {
      console.error(`Home Deck: cannot register custom widget ${definition.kind} from ${normalized}`, error);
      return false;
    }

    this.loaded.set(definition.kind, { definition, filePath: normalized });
    this.fileKinds.set(normalized, definition.kind);
    this.mtimes.set(normalized, mtime);
    this.host.refreshViews({ kind: definition.kind });
    if (autoAdd) await this.maybeAutoAdd(definition.kind);
    return true;
  }

  async scanChanged(): Promise<void> {
    if (this.disposed) return;
    const folder = this.folder();
    if (!folder) return;
    const files = await this.listScripts(folder);
    const present = new Set(files);
    for (const path of [...this.fileKinds.keys()]) {
      if (!present.has(path)) this.unregisterPath(path);
    }
    for (const path of files) {
      const mtime = await this.stat(path);
      if (this.fileKinds.has(path) && mtime > 0 && this.mtimes.get(path) === mtime) continue;
      await this.loadFile(path, this.host.settings.autoAddCustomWidgets);
    }
  }

  handleFileEvent(file: TAbstractFile): void {
    if (this.disposed) return;
    if (!this.isUnderFolder(file.path)) return;
    if (file instanceof TFile) {
      if (file.extension.toLowerCase() !== "js") return;
      void this.loadFile(file.path, this.host.settings.autoAddCustomWidgets);
      return;
    }
    // 文件夹删除/改名：卸载其下所有脚本。
    const prefix = `${file.path}/`;
    for (const path of [...this.fileKinds.keys()]) {
      if (path.startsWith(prefix)) this.unregisterPath(path);
    }
  }

  handleRename(file: TAbstractFile, oldPath: string): void {
    this.unregisterPath(oldPath);
    if (file instanceof TFile && file.extension.toLowerCase() === "js" && this.isUnderFolder(file.path)) {
      void this.loadFile(file.path, this.host.settings.autoAddCustomWidgets);
    }
  }

  unloadAll(): void {
    for (const path of [...this.fileKinds.keys()]) this.unregisterPath(path);
    this.loaded.clear();
    this.fileKinds.clear();
    this.mtimes.clear();
  }

  dispose(): void {
    this.disposed = true;
    if (this.scanTimer !== null) {
      window.clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    this.unloadAll();
  }

  private folder(): string {
    const dir = normalizePath(this.host.pluginDir ?? "").replace(/\/+$/g, "");
    return dir ? normalizePath(`${dir}/widgets`) : "";
  }

  private isUnderFolder(path: string): boolean {
    const folder = this.folder();
    if (!folder) return false;
    return path === folder || path.startsWith(`${folder}/`);
  }

  private async listScripts(folder: string): Promise<string[]> {
    const normalized = normalizePath(folder);
    if (normalized.startsWith(".") || normalized.split("/").some((part) => part.startsWith("."))) {
      return this.listHiddenScripts(normalized);
    }
    return this.host.app.vault
      .getFiles()
      .filter((file) => file.extension.toLowerCase() === "js" && (file.path === normalized || file.path.startsWith(`${normalized}/`)))
      .map((file) => file.path)
      .sort();
  }

  private async listHiddenScripts(folder: string): Promise<string[]> {
    const adapter = this.host.app.vault.adapter;
    const result: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let listing: { files: string[]; folders: string[] };
      try {
        listing = await adapter.list(dir);
      } catch {
        return;
      }
      for (const file of listing.files) {
        if (file.toLowerCase().endsWith(".js")) result.push(normalizePath(file));
      }
      for (const sub of listing.folders) await walk(sub);
    };
    await walk(normalizePath(folder));
    return result.sort();
  }

  private async read(path: string): Promise<string | null> {
    const adapter = this.host.app.vault.adapter;
    try {
      if (await adapter.exists(path)) return await adapter.read(path);
    } catch {
      // 回退到 vault API。
    }
    const file = this.host.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      try {
        return await this.host.app.vault.cachedRead(file);
      } catch (error) {
        console.error(`Home Deck: failed to read custom widget ${path}`, error);
      }
    }
    return null;
  }

  private async stat(path: string): Promise<number> {
    try {
      return (await this.host.app.vault.adapter.stat(path))?.mtime ?? 0;
    } catch {
      return 0;
    }
  }

  private unregisterPath(path: string): void {
    const normalized = normalizePath(path);
    const kind = this.fileKinds.get(normalized);
    if (!kind) return;
    const entry = this.loaded.get(kind);
    if (entry?.filePath === normalized) {
      this.host.registry.unregister(kind, entry.definition);
      this.loaded.delete(kind);
      this.host.refreshViews({ kind });
    }
    this.fileKinds.delete(normalized);
    this.mtimes.delete(normalized);
  }

  private async maybeAutoAdd(kind: string): Promise<void> {
    const settings = this.host.settings;
    if (!settings.autoAddCustomWidgets) return;
    if (settings.seenCustomWidgetKinds.includes(kind)) return;
    const exists = settings.pages.some((page) => page.widgets.some((widget) => widget.kind === kind));
    if (!exists) this.host.layout.addWidget(kind);
    settings.seenCustomWidgetKinds = [...settings.seenCustomWidgetKinds, kind];
    await this.host.saveSettings();
  }
}
