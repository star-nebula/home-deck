import type { App, Component, PluginManifest, TAbstractFile, TFile } from "obsidian";
import type { HomeDeckSettings, HomePage, VaultChange, VaultMarkdownSort, VaultStatsOptions, VaultStatsSnapshot, WidgetInstance } from "./types";
import type { PathScope } from "./changeScope";
import type { WidgetRegistry } from "./widgetRegistry";
import type { LayoutStore } from "./layoutStore";
import type { SettingsRepository } from "./settingsRepository";

/** 组件可用的共享数据服务。 */
export interface VaultDataService {
  getStats(options?: VaultStatsOptions): VaultStatsSnapshot;
  getMarkdownFiles(): readonly TFile[];
  getMarkdownByBasename(): ReadonlyMap<string, TFile>;
  getMarkdownSorted(sortBy: VaultMarkdownSort): readonly TFile[];
  getFiles(): readonly TFile[];
  getAllLoadedFiles(): readonly TAbstractFile[];
  getFilesUnder(folder: string): readonly TFile[];
  readonly generation: number;
  subscribe(listener: (change: VaultChange) => void): () => void;
}

export interface MtimeService {
  readJson<T>(path: string): Promise<T | null>;
  readText(path: string): Promise<string | null>;
  invalidate(path?: string): void;
}

export interface WidgetServices {
  vault: VaultDataService;
  mtime: MtimeService;
}

/** 组件渲染时拿到的数据侧上下文。 */
export interface WidgetDataPort<C> {
  app: App;
  host: HomeDeckHost;
  widget: WidgetInstance;
  /** 已与默认值合并过的配置。 */
  config: C;
  services: WidgetServices;
  /** 更新配置并持久化（不会自动重绘，需要时调用 rerender）。 */
  saveConfig(patch: Partial<C>): Promise<void>;
  /** 重新渲染本组件。 */
  rerender(): void;
  /** 订阅合并后的 vault 变化；返回注销函数。 */
  onVaultChange(listener: (change: VaultChange) => void, options?: { includeMetadata?: boolean }): () => void;
  /** 共享的 vault 统计快照，组件之间不会重复遍历同一批文件。 */
  getVaultStats(options?: VaultStatsOptions): VaultStatsSnapshot;
  getMarkdownFiles(): readonly TFile[];
  getMarkdownByBasename(): ReadonlyMap<string, TFile>;
  getMarkdownSorted(sortBy: VaultMarkdownSort): readonly TFile[];
  getFiles(): readonly TFile[];
  getAllLoadedFiles(): readonly TAbstractFile[];
  /** 渲染是否仍然有效（异步加载完成后用来判断是否已被重绘）。 */
  isAlive(): boolean;
  /** 卡片当前是否在视口内。 */
  isVisible(): boolean;
}

/** 组件渲染时拿到的 UI/生命周期上下文。 */
export interface WidgetUiPort {
  /** 宿主 Component（MarkdownRenderer 等需要）。 */
  component: Component;
  /** 打开库内文件/文件夹；带 event 时支持 ctrl/cmd 点击新标签页打开。 */
  openPath(path: string, options?: { line?: number; event?: MouseEvent | KeyboardEvent; newLeaf?: boolean }): Promise<void>;
  /** 设置卡片标题栏右侧的副标题。 */
  setSubtitle(text: string): void;
  /** 在卡片标题与右侧副标题/操作之间加入自定义标题栏内容；重绘时自动清除。 */
  addHeaderContent(className?: string): HTMLElement;
  /** 在卡片标题栏（齿轮左侧）加一个图标按钮；重绘时自动清除。 */
  addHeaderAction(icon: string, label: string, onClick: (event: MouseEvent) => void): HTMLElement;
  /** 注册定时器；组件重绘或卸载时自动清除。 */
  registerInterval(callback: () => void, ms: number): void;
  /** 在浏览器空闲帧执行；首次渲染大库统计时避免阻塞首页打开。 */
  scheduleIdle(callback: () => void, timeoutMs?: number): void;
  /** 注册清理函数；组件重绘或卸载时调用。 */
  registerCleanup(callback: () => void): void;
  /** 是否处于布局编辑模式。 */
  isEditing(): boolean;
}

/** 组件渲染上下文。保持扁平，内置与第三方组件无需区分数据/UI。 */
export type WidgetContext<C> = WidgetDataPort<C> & WidgetUiPort;

/** 组件配置面板的上下文：操作的是草稿，点“保存”后才写回。 */
export interface WidgetSettingsContext<C> {
  app: App;
  plugin: HomeDeckHost;
  config: C;
  /** 修改草稿。 */
  update(patch: Partial<C>): void;
  /** 重新绘制配置面板（列表增删后用）。 */
  refresh(): void;
}

export interface WidgetDefinition<C = Record<string, unknown>> {
  kind: string;
  name: string;
  description: string;
  /** lucide 图标名。 */
  icon: string;
  /** 主题色（十六进制）。 */
  accent: string;
  defaultSize: { w: number; h: number };
  defaultConfig(): C;
  /** 把持久化的 config 合并成完整配置（缺省值补齐、类型纠正）。 */
  normalizeConfig?(raw: Record<string, unknown>): C;
  render(body: HTMLElement, ctx: WidgetContext<C>): Promise<void> | void;
  renderSettings(container: HTMLElement, ctx: WidgetSettingsContext<C>): void;
  /** 库文件变化时是否需要重绘（默认 true）。 */
  liveRefresh?: boolean;
  /** 普通文件事件是否触发重绘（默认 true；统计类组件可改为自行订阅）。 */
  refreshOnVaultChange?: boolean;
  /** metadataCache 解析完成时是否触发重绘（默认 true）。 */
  refreshOnMetadataChange?: boolean;
  /** 只在这些路径变化时自动重绘；省略表示任何变更。 */
  refreshScope?(config: C, widget: WidgetInstance): PathScope | null | undefined;
}

/** 插件对外暴露给视图、设置页、API 与组件的宿主接口。 */
export interface HomeDeckHost {
  app: App;
  manifest: PluginManifest;
  readonly settings: HomeDeckSettings;
  readonly registry: WidgetRegistry;
  readonly layout: LayoutStore;
  readonly repo: SettingsRepository;
  readonly services: WidgetServices;
  register(cleanup: () => void): void;
  saveSettings(): Promise<void>;
  refreshViews(options?: { layoutOnly?: boolean; kind?: string }): void;
  openHome(): Promise<void>;
  openSettings(): void;
  getActivePage(): HomePage;
  getActiveHomeView(): unknown;
}
