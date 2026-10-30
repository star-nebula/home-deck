/** 内置组件类型；第三方插件通过 api.registerWidget 注册的 kind 是任意字符串。 */
export type BuiltinWidgetKind =
  | "hero"
  | "recent"
  | "quicklinks"
  | "countdown"
  | "pomodoro"
  | "quote"
  | "habit"
  | "diary"
  | "allnotes"
  | "kanban"
  | "stats"
  | "onthisday"
  | "note"
  | "duowei"
  | "annotations"
  | "insights"
  | "wechat"
  | "media"
  | "knowledgemap";

export type WidgetKind = BuiltinWidgetKind | (string & {});

/** 网格上限；UI 与持久化清洗共用。 */
export const MAX_COLUMNS = 12;
export const MAX_ROWS = 30;

/** 一个放在首页网格里的组件实例。config 的具体结构由 kind 决定。 */
export interface WidgetInstance {
  id: string;
  kind: WidgetKind;
  /** 自定义标题；留空用组件默认标题。 */
  title?: string;
  /** 列跨度 1..12。 */
  w: number;
  /** 行跨度（行高由全局设置决定）。 */
  h: number;
  config: Record<string, unknown>;
  /** 第三方组件：提供该 kind 的插件 id（用于插件未加载时的占位提示）。 */
  provider?: string;
}

export interface HomePage {
  id: string;
  name: string;
  widgets: WidgetInstance[];
}

export interface HomeDeckSettings {
  /** 持久化 schema 版本。 */
  version: number;
  /** 从哪个旧插件迁移而来（仅迁移时写入）。 */
  migratedFrom?: string;
  pages: HomePage[];
  activePageId: string;
  /** Obsidian 启动完成后自动打开首页。 */
  openOnStartup: boolean;
  /** 打开首页时使用新标签页（否则复用当前标签页）。 */
  openInNewTab: boolean;
  /** 网格行高（px）。 */
  rowHeight: number;
  /** 网格间距（px）。 */
  gap: number;
  /** 页面内容最大宽度（px），0 表示不限制。 */
  maxWidth: number;
  /** 只有一个页面时也显示页面标签栏。 */
  alwaysShowPageTabs: boolean;
}

/** 兼容旧命名；新代码优先使用 HomeDeckSettings。 */
export type HomePagesSettings = HomeDeckSettings;

// ---- Vault 变更与统计 -------------------------------------------------------

export type VaultChangeReason = "files" | "metadata";
export type VaultChangeOperation = "create" | "modify" | "delete" | "rename" | "metadata" | "resolve";
export type VaultMarkdownSort = "mtime" | "ctime";

export interface VaultChangeDetail {
  operation: VaultChangeOperation;
  path?: string;
  oldPath?: string;
}

export interface VaultChange {
  reason: VaultChangeReason | "mixed";
  changedAt: number;
  paths: readonly string[];
  operations: readonly VaultChangeOperation[];
}

export interface VaultStatsOptions {
  excludeFolders?: string[];
  excludeHidden?: boolean;
}

export interface VaultStatsSnapshot {
  noteCount: number;
  fileCount: number;
  attachmentCount: number;
  folderCount: number;
  wordEstimate: number;
  tagCount: number;
  earliestDay?: string;
  todayNotes: number;
  weekNotes: number;
  activityByDay: Readonly<Record<string, number>>;
  generatedAt: number;
  generation: number;
}
